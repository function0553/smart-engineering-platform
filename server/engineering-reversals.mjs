import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {fail} from './service.mjs';

const id=z.string().uuid(),note=z.string().trim().min(1).max(2000);
const now=()=>new Date().toISOString();

// Original costs and stock movements remain immutable; approved corrections append signed entries.
export function createEngineeringReversals({store,access,active,mutate,history,getItem,saveItem,manager,financial,isSettlementEffective=()=>true,purchaseReversalCheck=()=>{},stockReversalCheck=()=>{},stockDelta=()=>0,receivedDelta=()=>0,costRefundAmount=()=>0,costReversalCheck=()=>{}}) {
  const db=store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS engineering_reversals(
    id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES engineering_projects(id),
    target_type TEXT NOT NULL CHECK(target_type IN ('cost','stock')),target_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('submitted','approved','rejected','cancelled')),
    version INTEGER NOT NULL,snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),note TEXT NOT NULL,
    requested_by TEXT NOT NULL REFERENCES users(id),requester_name TEXT NOT NULL,created_at TEXT NOT NULL,
    reviewed_by TEXT REFERENCES users(id),reviewer_name TEXT,review_note TEXT,reviewed_at TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS engineering_reversal_active_target ON engineering_reversals(project_id,target_type,target_id) WHERE state IN ('submitted','approved');
    CREATE TABLE IF NOT EXISTS engineering_adjustments(
    id TEXT PRIMARY KEY,reversal_id TEXT NOT NULL UNIQUE REFERENCES engineering_reversals(id),
    project_id TEXT NOT NULL REFERENCES engineering_projects(id),target_type TEXT NOT NULL,target_id TEXT NOT NULL,
    material_id TEXT NOT NULL,reference_id TEXT NOT NULL,amount_delta INTEGER NOT NULL,quantity_delta INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS engineering_adjustments_target ON engineering_adjustments(project_id,target_type,target_id);`);
  const reversed=(type,iid)=>!!db.prepare('SELECT 1 FROM engineering_adjustments WHERE target_type=? AND target_id=?').get(type,iid);
  const costAmount=row=>reversed('cost',row.id)?0:row.data.amount-costRefundAmount(row.id);
  const balance=mid=>db.prepare(`SELECT
    COALESCE((SELECT SUM(CASE WHEN kind='issue' THEN -quantity ELSE quantity END) FROM engineering_stock WHERE material_id=?),0)
    +COALESCE((SELECT SUM(quantity_delta) FROM engineering_adjustments WHERE material_id=? AND target_type='stock'),0) n`).get(mid,mid).n+stockDelta(mid);
  const effectiveStock=(where,...args)=>db.prepare(`SELECT COALESCE(SUM(s.quantity),0) n FROM engineering_stock s WHERE ${where}
    AND NOT EXISTS(SELECT 1 FROM engineering_adjustments a WHERE a.target_type='stock' AND a.target_id=s.id)`).get(...args).n;
  const received=pid=>effectiveStock("s.reference_id=? AND s.kind='receive'",pid)-receivedDelta(pid);
  const returned=iid=>effectiveStock("s.reference_id=? AND s.kind='return'",iid);
  const pending=pid=>!!db.prepare("SELECT 1 FROM engineering_reversals WHERE project_id=? AND state='submitted'").get(pid);
  const list=(pid,role)=>db.prepare('SELECT * FROM engineering_reversals WHERE project_id=? ORDER BY created_at DESC,id DESC').all(pid).filter(r=>r.target_type!=='cost'||financial(role)).map(r=>{const snapshot=JSON.parse(r.snapshot);if(!financial(role)&&r.target_type==='stock'&&snapshot.kind==='receive'){snapshot.referenceId='';if('purchaseLineId'in snapshot)snapshot.purchaseLineId='';if('receiptBatchId'in snapshot)snapshot.receiptBatchId='';}return {...r,snapshot};});
  function target(pid,type,iid) {
    if(type==='cost') {
      const row=getItem(pid,iid,'costs');
      if(row.state!=='approved')fail(409,'仅已批准入账的收支可以冲销');
      costReversalCheck(pid,row);
      if(row.data.settlementId){const s=getItem(pid,row.data.settlementId,'settlements'),c=getItem(pid,s.data.contractId,'contracts');if(s.state!=='approved'||!isSettlementEffective(s.id))fail(409,'关联结算须已批准且未撤销，当前不能办理收支冲销');if(!['approved','closed'].includes(c.state))fail(409,'关联合同状态不支持收支冲销');}
      return {title:row.data.title,amount:costAmount(row),...(costRefundAmount(row.id)?{originalAmount:row.data.amount,refundedAmount:costRefundAmount(row.id)}:{}),direction:row.data.direction,version:row.version,createdBy:row.created_by,editedBy:row.edited_by||'',materialId:'',referenceId:row.data.settlementId||'',quantityDelta:0};
    }
    const row=db.prepare('SELECT * FROM engineering_stock WHERE id=? AND project_id=?').get(iid,pid);
    if(!row)fail(404,'库存原单不存在或不属于本项目');
    stockReversalCheck(pid,row);
    if(row.kind==='receive'){
      purchaseReversalCheck(pid,row);
      const p=getItem(pid,row.reference_id,'purchases');
      if(!['approved','closed'].includes(p.state))fail(409,'采购单当前不能冲销入库');
      if(p.data.contractId&&!['approved','closed'].includes(getItem(pid,p.data.contractId,'contracts').state))fail(409,'关联合同状态不支持入库冲销');
    }
    return {title:getItem(pid,row.material_id,'materials').data.title,kind:row.kind,quantity:row.quantity,materialId:row.material_id,referenceId:row.reference_id,createdBy:row.actor_id,editedBy:'',amount:0,quantityDelta:row.kind==='issue'?row.quantity:-row.quantity,...(row.kind==='receive'&&(row.purchase_line_id||row.receipt_batch_id)?{purchaseLineId:row.purchase_line_id,receiptBatchId:row.receipt_batch_id}:{})};
  }
  function eligible(pid,type,iid,snapshot){
    if(reversed(type,iid))fail(409,'原单已冲销，不能重复办理');
    const current=target(pid,type,iid);
    if(snapshot&&JSON.stringify(current)!==JSON.stringify(snapshot))fail(409,'原单依据已变化，请撤回后重新申请');
    if(type==='stock'){
      if(current.kind==='issue'&&returned(iid)>0)fail(409,'原领料仍有有效退料，请先冲销关联退料');
      if(balance(current.materialId)+current.quantityDelta<0)fail(409,'冲销会造成负库存，请先核对下游领退料');
    }
    return current;
  }
  function mount(app,base,authorize,writer){
    app.post(base+'/projects/:pid/reversals',authorize,writer,(req,res)=>{
      const {p,role}=access(req,true),b=z.object({requestId:id,targetType:z.enum(['cost','stock']),targetId:id,note}).strict().parse(req.body);
      if(b.targetType==='cost'&&!financial(role)||b.targetType==='stock'&&!['admin','manager','engineer'].includes(role))fail(403,'没有该业务的冲销申请权限');
      res.status(201).json(mutate(req,p.id+':reversal:create',()=>{
        active(p);const snapshot=eligible(p.id,b.targetType,b.targetId);
        if(db.prepare("SELECT 1 FROM engineering_reversals WHERE project_id=? AND target_type=? AND target_id=? AND state IN ('submitted','approved')").get(p.id,b.targetType,b.targetId))fail(409,'原单已有待审或已批准的冲销申请');
        const rid=randomUUID();db.prepare('INSERT INTO engineering_reversals VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(rid,p.id,b.targetType,b.targetId,'submitted',1,JSON.stringify(snapshot),b.note,req.actor.id,req.actor.name,now(),null,null,null,null);
        history(req.actor,p.id,b.targetType==='cost'?b.targetId:snapshot.materialId,b.targetType==='cost'?'costs':'materials','reversal_submit','申请全额冲销：'+b.note);return {id:rid};
      }));
    });
    app.post(base+'/projects/:pid/reversals/:rid/state',authorize,writer,(req,res)=>{
      const {p,role}=access(req,true),rid=id.parse(req.params.rid),b=z.object({requestId:id,version:z.number().int().positive(),state:z.enum(['approved','rejected','cancelled']),note}).strict().parse(req.body);
      const check=db.prepare('SELECT * FROM engineering_reversals WHERE id=? AND project_id=?').get(rid,p.id);
      if(!check||check.target_type==='cost'&&!financial(role))fail(404,'冲销申请不存在或无权访问');
      if(check.target_type==='stock'&&role==='finance')fail(403,'财务成员不能办理库存冲销');
      res.json(mutate(req,p.id+':reversal:'+rid+':state',()=>{
        active(p);const row=db.prepare('SELECT * FROM engineering_reversals WHERE id=? AND project_id=?').get(rid,p.id);
        if(row.version!==b.version||row.state!=='submitted')fail(409,'申请已办理，请刷新后核对');
        if(b.state==='cancelled'){if(row.requested_by!==req.actor.id&&!manager(role))fail(403,'仅申请人或经理可撤回');}
        else if(!manager(role))fail(403,'需要项目经理或管理员审批');
        const s=JSON.parse(row.snapshot);
        if(b.state==='approved'){
          if([row.requested_by,s.createdBy,s.editedBy].includes(req.actor.id))fail(409,'申请人及原单经办人不能审批冲销，请其他经理审核');
          eligible(p.id,row.target_type,row.target_id,s);
          db.prepare('INSERT INTO engineering_adjustments VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),row.id,p.id,row.target_type,row.target_id,s.materialId,s.referenceId,row.target_type==='cost'?-s.amount:0,s.quantityDelta,now());
          // A reversed receipt must restore the remaining-to-receive workflow on a closed purchase.
          if(row.target_type==='stock'&&s.kind==='receive'){
            const purchase=getItem(p.id,s.referenceId,'purchases');if(purchase.state==='closed'){db.prepare("UPDATE engineering_items SET state='approved',version=version+1,updated_at=? WHERE id=?").run(now(),purchase.id);history(req.actor,p.id,purchase.id,'purchases','reopen','入库冲销后恢复待收货：'+row.id);}
            if(purchase.data.contractId)reopenContract(p.id,purchase.data.contractId,req.actor,row.id);
          }
          if(row.target_type==='cost'&&s.referenceId)reopenContract(p.id,getItem(p.id,s.referenceId,'settlements').data.contractId,req.actor,row.id);
        }
        db.prepare('UPDATE engineering_reversals SET state=?,version=version+1,reviewed_by=?,reviewer_name=?,review_note=?,reviewed_at=? WHERE id=?').run(b.state,req.actor.id,req.actor.name,b.note,now(),row.id);
        history(req.actor,p.id,row.target_type==='cost'?row.target_id:s.materialId,row.target_type==='cost'?'costs':'materials','reversal_'+b.state,'冲销'+row.id+'：'+b.note);return {id:row.id,state:b.state};
      }));
    });
  }
  function reopenContract(pid,cid,actor,rid){const contract=getItem(pid,cid,'contracts');if(contract.state==='closed'){contract.state='approved';saveItem(contract);history(actor,pid,cid,'contracts','reopen','冲销后恢复合同办理：'+rid);}}
  return {reversed,costAmount,balance,received,returned,pending,list,mount};
}
