import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {fail} from './service.mjs';

const MAX=1_000_000_000_000;
const id=z.string().uuid(),amount=z.number().int().min(1).max(MAX),note=z.string().trim().min(1).max(2000);
const now=()=>new Date().toISOString();
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value,'日期无效');
const identity=row=>({id:row.id,kind:row.kind,data:row.data,createdBy:row.created_by,editedBy:row.edited_by||''});
const sum=values=>{const result=values.reduce((n,value)=>n+BigInt(value),0n);if(result>BigInt(Number.MAX_SAFE_INTEGER)||result<0n)fail(422,'供应商往来金额超出安全范围');return Number(result);};
const parsed=row=>row?{...row,snapshot:typeof row.snapshot==='string'?JSON.parse(row.snapshot):row.snapshot}:null;
const states=new Set(['submitted','approved','rejected','cancelled']);
const exclusions=(row,kind)=>[row.requested_by,row.snapshot.purchase.createdBy,row.snapshot.purchase.editedBy,...(kind==='credit'?[row.snapshot.settlement.createdBy,row.snapshot.settlement.editedBy,row.snapshot.return.requestedBy,row.snapshot.return.dispatchedBy]:[row.snapshot.cost.createdBy,row.snapshot.cost.editedBy,row.snapshot.credit.requestedBy])].filter(Boolean);

/** Rebuild money from immutable source records; cached totals never authorize a refund. */
export function buildEngineeringSupplierFinance({projectId,items,returns=[],credits=[],refunds=[]}){
  const invalid=()=>fail(422,'供应商抵减或退款来源快照不一致，请核对原件');
  for(const rows of [items,returns,credits,refunds])if(!Array.isArray(rows)||rows.some(row=>row.project_id!==projectId))invalid();
  const byId=new Map(items.map(row=>[row.id,row])),returnMap=new Map(returns.map(row=>[row.id,row])),creditMap=new Map();
  const creditBySettlement=new Map(),creditByReturn=new Map(),refundByCost=new Map(),refundByCredit=new Map();
  const integer=value=>{if(!Number.isSafeInteger(value)||value<1||value>MAX)invalid();};
  const add=(map,key,value)=>map.set(key,sum([map.get(key)||0,value]));
  for(const row of credits){
    integer(row.amount);if(!states.has(row.state)||creditMap.has(row.id))invalid();creditMap.set(row.id,row);
    const purchase=byId.get(row.purchase_id),settlement=byId.get(row.settlement_id),returned=returnMap.get(row.return_id),s=row.snapshot;
    if(purchase?.kind!=='purchases'||settlement?.kind!=='settlements'||!returned||returned.purchase_id!==purchase.id||returned.state!=='dispatched'||settlement.data.contractId!==purchase.data.contractId||byId.get(purchase.data.contractId)?.data.direction!=='expense'||!s)invalid();
    if(JSON.stringify(s.purchase)!==JSON.stringify(identity(purchase))||JSON.stringify(s.settlement)!==JSON.stringify(identity(settlement))||s.return?.id!==returned.id||s.return.purchaseId!==purchase.id||s.return.amount!==returned.dispatch?.amount||s.amount!==row.amount)invalid();
    if(row.state==='approved'){add(creditBySettlement,settlement.id,row.amount);add(creditByReturn,returned.id,row.amount);}
  }
  for(const [key,value] of creditBySettlement)if(value>byId.get(key).data.amount)invalid();
  for(const [key,value] of creditByReturn)if(value>returnMap.get(key).dispatch.amount)invalid();
  const seenRefunds=new Set();
  for(const row of refunds){
    integer(row.amount);if(!states.has(row.state)||seenRefunds.has(row.id))invalid();seenRefunds.add(row.id);
    const credit=creditMap.get(row.credit_id),cost=byId.get(row.cost_id),purchase=byId.get(row.purchase_id),s=row.snapshot;
    if(!credit||credit.purchase_id!==row.purchase_id||credit.state!=='approved'||cost?.kind!=='costs'||cost.data.direction!=='expense'||cost.data.settlementId!==credit.settlement_id||cost.state!=='approved'||!s)invalid();
    if(JSON.stringify(s.purchase)!==JSON.stringify(identity(purchase))||JSON.stringify(s.cost)!==JSON.stringify(identity(cost))||s.credit?.id!==credit.id||s.credit.purchaseId!==purchase.id||s.credit.settlementId!==credit.settlement_id||s.credit.amount!==credit.amount||s.amount!==row.amount)invalid();
    if(row.state==='approved'){add(refundByCost,cost.id,row.amount);add(refundByCredit,credit.id,row.amount);}
  }
  for(const [key,value] of refundByCost)if(value>byId.get(key).data.amount)invalid();
  for(const [key,value] of refundByCredit)if(value>creditMap.get(key).amount)invalid();
  const payments=items.filter(row=>row.kind==='costs'&&row.data.direction==='expense').map(row=>{
    const refundedAmount=refundByCost.get(row.id)||0,effectiveAmount=row.state==='approved'&&!row.reversed?row.data.amount-refundedAmount:0;
    const settlement=byId.get(row.data.settlementId),canRefund=effectiveAmount>0&&settlement?.state==='approved'&&!settlement.voided;
    return {costId:row.id,title:row.data.title,settlementId:row.data.settlementId||'',originalAmount:row.data.amount,refundedAmount,effectiveAmount,canRefund,blockers:canRefund?[]:['须为有效支出结算下尚有净付款余额的已批准付款']};
  });
  const settlements=items.filter(row=>row.kind==='settlements'&&byId.get(row.data.contractId)?.data.direction==='expense').map(row=>{
    const creditAmount=creditBySettlement.get(row.id)||0,effectiveAmount=row.state==='approved'&&!row.voided?row.data.amount-creditAmount:0;
    const paidAmount=sum(payments.filter(payment=>payment.settlementId===row.id).map(payment=>payment.effectiveAmount));
    const canCredit=row.state==='approved'&&!row.voided&&effectiveAmount>0;
    return {settlementId:row.id,title:row.data.title,contractId:row.data.contractId,originalAmount:row.data.amount,creditAmount,effectiveAmount,paidAmount,unpaidAmount:Math.max(0,effectiveAmount-paidAmount),refundableAmount:Math.max(0,paidAmount-effectiveAmount),canCredit,blockers:canCredit?[]:['须为尚有有效金额的已批准支出结算']};
  });
  const settlementsById=new Map(settlements.map(row=>[row.settlementId,row]));
  return {credits:credits.map(row=>({...row,excludedReviewerIds:exclusions(row,'credit'),refundedAmount:refundByCredit.get(row.id)||0,availableRefundAmount:row.state==='approved'?Math.min(row.amount-(refundByCredit.get(row.id)||0),settlementsById.get(row.settlement_id)?.refundableAmount||0):0})),refunds:refunds.map(row=>({...row,excludedReviewerIds:exclusions(row,'refund')})),settlements,payments};
}

export function createEngineeringSupplierFinance({store,access,active,mutate,history,getItem,getItems,manager,financial,getReturn,returnRows,voided,reversed,pendingCorrection}){
  const db=store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS engineering_supplier_credits(
    id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES engineering_projects(id),purchase_id TEXT NOT NULL REFERENCES engineering_items(id),
    return_id TEXT NOT NULL,settlement_id TEXT NOT NULL REFERENCES engineering_items(id),state TEXT NOT NULL CHECK(state IN ('submitted','approved','rejected','cancelled')),
    version INTEGER NOT NULL,amount INTEGER NOT NULL CHECK(amount>0),note TEXT NOT NULL,snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
    requested_by TEXT NOT NULL REFERENCES users(id),requester_name TEXT NOT NULL,created_at TEXT NOT NULL,
    reviewed_by TEXT REFERENCES users(id),reviewer_name TEXT,review_note TEXT,reviewed_at TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS engineering_supplier_credit_pending ON engineering_supplier_credits(settlement_id) WHERE state='submitted';
    CREATE TABLE IF NOT EXISTS engineering_supplier_refunds(
    id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES engineering_projects(id),purchase_id TEXT NOT NULL REFERENCES engineering_items(id),
    credit_id TEXT NOT NULL REFERENCES engineering_supplier_credits(id),cost_id TEXT NOT NULL REFERENCES engineering_items(id),state TEXT NOT NULL CHECK(state IN ('submitted','approved','rejected','cancelled')),
    version INTEGER NOT NULL,amount INTEGER NOT NULL CHECK(amount>0),occurred_date TEXT NOT NULL,voucher TEXT NOT NULL,note TEXT NOT NULL,snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
    requested_by TEXT NOT NULL REFERENCES users(id),requester_name TEXT NOT NULL,created_at TEXT NOT NULL,
    reviewed_by TEXT REFERENCES users(id),reviewer_name TEXT,review_note TEXT,reviewed_at TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS engineering_supplier_refund_pending ON engineering_supplier_refunds(cost_id) WHERE state='submitted';`);
  const rows=(kind,pid)=>db.prepare(`SELECT * FROM engineering_supplier_${kind} WHERE project_id=? ORDER BY created_at DESC,id DESC`).all(pid).map(parsed);
  const refundedAmount=costId=>sum(db.prepare("SELECT amount FROM engineering_supplier_refunds WHERE cost_id=? AND state='approved'").all(costId).map(row=>row.amount));
  const creditAmount=settlementId=>sum(db.prepare("SELECT amount FROM engineering_supplier_credits WHERE settlement_id=? AND state='approved'").all(settlementId).map(row=>row.amount));
  const effectiveSettlement=row=>row.state==='approved'&&!voided(row.id)?row.data.amount-creditAmount(row.id):0;
  const effectiveCost=row=>row.state==='approved'&&!reversed('cost',row.id)?row.data.amount-refundedAmount(row.id):0;
  const projectView=pid=>buildEngineeringSupplierFinance({projectId:pid,items:getItems(pid).map(row=>({...row,voided:['settlements','measurements','variations'].includes(row.kind)&&voided(row.id),reversed:row.kind==='costs'&&reversed('cost',row.id)})),returns:returnRows(pid),credits:rows('credits',pid),refunds:rows('refunds',pid)});
  function authorized(req){const context=access(req,true);if(!financial(context.role))fail(403,'没有供应商抵减及退款权限');return context;}
  function pending(pid,contractId){
    const matches=row=>row.state==='submitted'&&(!contractId||getItem(pid,row.purchase_id,'purchases').data.contractId===contractId);
    return rows('credits',pid).some(matches)||rows('refunds',pid).some(matches);
  }
  const pendingPurchase=purchaseId=>!!db.prepare("SELECT 1 FROM engineering_supplier_credits WHERE purchase_id=? AND state='submitted' UNION ALL SELECT 1 FROM engineering_supplier_refunds WHERE purchase_id=? AND state='submitted' LIMIT 1").get(purchaseId,purchaseId);
  function common(pid,purchaseId,settlementId){
    const purchase=getItem(pid,purchaseId,'purchases'),settlement=getItem(pid,settlementId,'settlements');
    if(!purchase.data.contractId||settlement.data.contractId!==purchase.data.contractId)fail(400,'抵减及退款必须关联同一采购支出合同的结算');
    const contract=getItem(pid,purchase.data.contractId,'contracts');
    if(contract.data.direction!=='expense')fail(400,'供应商往来仅支持支出合同');
    if(!['approved','closed'].includes(purchase.state)||!['approved','closed'].includes(contract.state)||settlement.state!=='approved'||voided(settlement.id))fail(409,'采购、支出合同及结算须已批准且业务有效');
    if(pendingCorrection(pid,contract.id))fail(409,'关联合同有待审经营纠错，请先处理');
    return {purchase,settlement,contract};
  }
  function creditCheck(pid,purchaseId,body,ignoreId){
    const {purchase,settlement,contract}=common(pid,purchaseId,body.settlementId),returned=getReturn(pid,body.returnId);
    if(!returned||returned.purchase_id!==purchase.id)fail(400,'退货依据不属于此采购');
    if(returned.state!=='dispatched'||!returned.dispatch)fail(409,'完成实际发退后才能申请结算抵减');
    if(rows('credits',pid).some(row=>row.id!==ignoreId&&row.settlement_id===settlement.id&&row.state==='submitted'))fail(409,'此结算已有待审抵减');
    if(db.prepare("SELECT 1 FROM engineering_reversals r JOIN engineering_items i ON r.target_type='cost' AND r.target_id=i.id WHERE r.project_id=? AND r.state='submitted' AND json_extract(i.data,'$.settlementId')=?").get(pid,settlement.id))fail(409,'结算付款有待审冲销，请先处理');
    const used=sum(rows('credits',pid).filter(row=>row.return_id===returned.id&&row.state==='approved').map(row=>row.amount));
    if(body.amount>returned.dispatch.amount-used||body.amount>effectiveSettlement(settlement))fail(409,'抵减金额超过退货原价参考余额或结算有效余额');
    return {purchase,settlement,contract,snapshot:{purchase:identity(purchase),settlement:identity(settlement),return:{id:returned.id,purchaseId:purchase.id,version:returned.version,amount:returned.dispatch.amount,requestedBy:returned.requested_by,dispatchedBy:returned.dispatch.actorId},amount:body.amount}};
  }
  function refundCheck(pid,purchaseId,body,ignoreId){
    const credit=parsed(db.prepare('SELECT * FROM engineering_supplier_credits WHERE id=? AND project_id=?').get(body.creditId,pid));
    if(!credit||credit.purchase_id!==purchaseId)fail(400,'抵减单不属于此采购');
    if(credit.state!=='approved')fail(409,'退款须以已批准的结算抵减为依据');
    const {purchase,settlement,contract}=common(pid,purchaseId,credit.settlement_id),cost=getItem(pid,body.costId,'costs');
    if(cost.data.direction!=='expense'||cost.data.settlementId!==settlement.id)fail(400,'退款必须关联同一结算的原支出付款');
    if(cost.state!=='approved'||reversed('cost',cost.id))fail(409,'原付款须已批准且尚未冲销');
    if(db.prepare("SELECT 1 FROM engineering_reversals WHERE project_id=? AND target_type='cost' AND target_id=? AND state='submitted'").get(pid,cost.id))fail(409,'原付款有待审冲销，请先处理');
    if(rows('refunds',pid).some(row=>row.id!==ignoreId&&row.cost_id===cost.id&&row.state==='submitted'))fail(409,'原付款已有待审退款');
    const creditedRefund=sum(rows('refunds',pid).filter(row=>row.credit_id===credit.id&&row.state==='approved').map(row=>row.amount));
    const netPaid=sum(getItems(pid).filter(row=>row.kind==='costs'&&row.data.settlementId===settlement.id&&row.state==='approved').map(effectiveCost));
    if(body.amount>effectiveCost(cost)||body.amount>credit.amount-creditedRefund||body.amount>Math.max(0,netPaid-effectiveSettlement(settlement)))fail(409,'退款金额超过原付款净额、抵减可退额或该结算实际超付额');
    if(body.occurredDate>today()||body.occurredDate<cost.data.occurredDate)fail(400,'退款日期不能晚于今天或早于原付款日期');
    return {purchase,settlement,contract,snapshot:{purchase:identity(purchase),cost:identity(cost),credit:{id:credit.id,purchaseId:purchase.id,settlementId:settlement.id,amount:credit.amount,requestedBy:credit.requested_by},amount:body.amount}};
  }
  function reopen(pid,contract,actor,reason){if(contract.state==='closed'){db.prepare("UPDATE engineering_items SET state='approved',version=version+1,updated_at=? WHERE id=?").run(now(),contract.id);history(actor,pid,contract.id,'contracts','reopen',reason);}}
  function costReversalCheck(pid,cost){
    if(rows('refunds',pid).some(row=>row.cost_id===cost.id&&row.state==='submitted')||rows('credits',pid).some(row=>row.settlement_id===cost.data.settlementId&&row.state==='submitted'))fail(409,'原付款有关联待审抵减或退款，请先处理');
    if(effectiveCost(cost)<=0)fail(409,'原付款净额已为零，没有可冲销余额');
  }
  function correctionCheck(pid,row){return {blockers:pending(pid,row.data.contractId)?[{kind:'supplier_finance',reason:'关联合同仍有待审供应商抵减或退款'}]:[]};}
  function close(pid,contractId){if(pending(pid,contractId))fail(409,'合同仍有待审供应商抵减或退款');const view=projectView(pid);if(view.settlements.some(row=>row.contractId===contractId&&row.refundableAmount>0))fail(409,'合同存在供应商应退未退金额，请确认真实退款到账后再关闭');}
  function mount(app,base,authorize,writer){
    for(const kind of ['credit','refund']){
      const plural=kind+'s',table='engineering_supplier_'+plural;
      const createSchema=kind==='credit'?z.object({requestId:id,returnId:id,settlementId:id,amount,note}).strict():z.object({requestId:id,creditId:id,costId:id,amount,occurredDate:date,voucher:z.string().trim().min(1).max(200),note}).strict();
      app.post(base+'/projects/:pid/purchases/:iid/'+plural,authorize,writer,(req,res)=>{
        const {p}=authorized(req),purchaseId=id.parse(req.params.iid),body=createSchema.parse(req.body);
        res.status(201).json(mutate(req,p.id+':supplier:'+kind+':create',()=>{
          const current=authorized(req);active(current.p);
          const checked=kind==='credit'?creditCheck(p.id,purchaseId,body):refundCheck(p.id,purchaseId,body),rid=randomUUID();
          const commonValues=[rid,p.id,purchaseId,kind==='credit'?body.returnId:body.creditId,kind==='credit'?body.settlementId:body.costId,'submitted',1,body.amount];
          const values=kind==='credit'?[...commonValues,body.note,JSON.stringify(checked.snapshot),req.actor.id,req.actor.name,now(),null,null,null,null]:[...commonValues,body.occurredDate,body.voucher,body.note,JSON.stringify(checked.snapshot),req.actor.id,req.actor.name,now(),null,null,null,null];
          db.prepare(`INSERT INTO ${table} VALUES(${values.map(()=>'?').join(',')})`).run(...values);
          history(req.actor,p.id,purchaseId,'purchases','supplier_'+kind+'_submit',(kind==='credit'?'申请结算抵减：':'登记供应商退款到账待复核：')+body.note);
          return {id:rid,purchaseId,state:'submitted',version:1};
        }));
      });
      app.post(base+'/projects/:pid/purchases/:iid/'+plural+'/:fid/state',authorize,writer,(req,res)=>{
        const {p,role}=authorized(req),purchaseId=id.parse(req.params.iid),rid=id.parse(req.params.fid);
        const body=z.object({requestId:id,version:z.number().int().positive(),state:z.enum(['approved','rejected','cancelled']),note}).strict().parse(req.body);
        const initial=parsed(db.prepare(`SELECT * FROM ${table} WHERE id=? AND project_id=? AND purchase_id=?`).get(rid,p.id,purchaseId));
        if(!initial)fail(404,'抵减或退款记录不存在');
        if(body.state==='cancelled'?!manager(role)&&initial.requested_by!==req.actor.id:!manager(role))fail(403,'此步骤须由项目经理或管理员办理，撤回亦可由申请人办理');
        res.json(mutate(req,p.id+':supplier:'+kind+':'+rid+':state',()=>{
          const current=authorized(req);active(current.p);
          const row=parsed(db.prepare(`SELECT * FROM ${table} WHERE id=? AND project_id=? AND purchase_id=?`).get(rid,p.id,purchaseId));
          if(!row||row.version!==body.version||row.state!=='submitted')fail(409,'记录已更新或办理，请刷新核对');
          if(body.state==='cancelled'?!manager(current.role)&&row.requested_by!==req.actor.id:!manager(current.role))fail(403,'当前角色不能办理此步骤');
          if(body.state!=='cancelled'&&exclusions(row,kind).includes(req.actor.id))fail(409,'申请人及关联原件经办人不能审批，请另一位经理独立复核');
          if(body.state==='approved'){
            const checked=kind==='credit'?creditCheck(p.id,purchaseId,{returnId:row.return_id,settlementId:row.settlement_id,amount:row.amount},row.id):refundCheck(p.id,purchaseId,{creditId:row.credit_id,costId:row.cost_id,amount:row.amount,occurredDate:row.occurred_date},row.id);
            if(JSON.stringify(checked.snapshot)!==JSON.stringify(row.snapshot))fail(409,'原件依据已变化，请撤回后重新申请');
            reopen(p.id,checked.contract,req.actor,'供应商'+(kind==='credit'?'抵减':'退款')+'后恢复核对结清：'+row.id);
          }
          db.prepare(`UPDATE ${table} SET state=?,version=version+1,reviewed_by=?,reviewer_name=?,review_note=?,reviewed_at=? WHERE id=?`).run(body.state,req.actor.id,req.actor.name,body.note,now(),rid);
          history(req.actor,p.id,purchaseId,'purchases','supplier_'+kind+'_'+body.state,body.note);
          return {id:rid,purchaseId,state:body.state,version:row.version+1};
        }));
      });
    }
  }
  return {rows,refundedAmount,creditAmount,effectiveSettlement,effectiveCost,projectView,pending,pendingPurchase,costReversalCheck,correctionCheck,close,mount};
}
