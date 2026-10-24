import {documentScope,requireDocumentProject} from './project-document-scope.mjs';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { fail } from './service.mjs';
import {createEngineeringReversals} from './engineering-reversals.mjs';
import {createEngineeringCommerce,measurementLinesSchema} from './engineering-commerce.mjs';
import {createEngineeringCorrections} from './engineering-corrections.mjs';
import {createEngineeringBaselines} from './engineering-baselines.mjs';
import {mountEngineeringExport} from './engineering-export.mjs';
import {createEngineeringBoq} from './engineering-boq.mjs';
import {buildEngineeringTaskValues,freezeMeasurementTasks,checkMeasurementTasks,checkTaskCancellation} from './engineering-task-value.mjs';
import {createEngineeringValuePlans} from './engineering-value-plans.mjs';
import {createEngineeringReplacements} from './engineering-replacements.mjs';
import {createEngineeringProgress} from './engineering-progress.mjs';
import {mountEngineeringProgressExport} from './engineering-progress-export.mjs';
import {createEngineeringPurchases,purchaseLinesSchema} from './engineering-purchases.mjs';
import {createEngineeringPurchaseReturns} from './engineering-purchase-returns.mjs';
import {createEngineeringSupplierFinance} from './engineering-supplier-finance.mjs';
import {createEngineeringCostControl} from './engineering-cost-control.mjs';
import {createEngineeringSubcontracts} from './engineering-subcontracts.mjs';

export const engineeringCatalog = JSON.parse(readFileSync(new URL('../shared/engineering-catalog.json', import.meta.url), 'utf8'));
const id = z.string().uuid(), text = z.string().trim().max(200), note = z.string().trim().min(1).max(2000);
const date = z.iso.date(), amount = z.number().int().min(1).max(1_000_000_000_000), quantity = z.number().int().min(1).max(1_000_000_000);
const version = z.number().int().positive();
const projectSchema = z.object({ code:text.min(1).max(40), name:text.min(1), address:text.min(1), owner:text.min(1), startDate:date, dueDate:date, budget:z.number().int().min(0).max(1_000_000_000_000), note:z.string().trim().max(2000).default('') }).strict();
const schemas = Object.fromEntries(Object.entries(engineeringCatalog).map(([kind,c]) => [kind,z.object(Object.fromEntries(c.fields.map(([key,,type,required])=>{
  let s = type==='purchaseLines'?purchaseLinesSchema:type==='measurementLines'?measurementLinesSchema:type==='date'?date:type==='money'?amount:type==='quantity'?quantity:type==='percent'?z.number().int().min(0).max(100):type.startsWith('ref:')?id:type.startsWith('enum:')?z.enum(type.slice(5).split(',').map(x=>x.split('=')[0])):z.string().trim().max(type==='textarea'?2000:200).min(required?1:0);
  if(!required)s=z.union([s,z.literal('')]).optional().default('');
  return [key,s];
}))).strict()]));
const legacyPurchaseSchema=z.object({title:text.min(1),supplier:text.min(1),materialId:id,quantity,unitPrice:amount,contractId:z.union([id,z.literal('')]).optional().default(''),dueDate:date,note}).strict();
schemas.purchases=z.union([schemas.purchases,legacyPurchaseSchema]);
const parseRow = row => row ? {...row,data:JSON.parse(row.data)} : null;
const sum = values => values.reduce((a,b)=>a+b,0);
const now = () => new Date().toISOString();

export function mountEngineeringRoutes(app,{store,auth,mobileAuth,writer,siteRecordsPending=()=>false,siteRecordHistoryVisible=()=>true}) {
  const db=store.db;
  db.exec(`
    CREATE TABLE IF NOT EXISTS engineering_projects(id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE COLLATE NOCASE, data TEXT NOT NULL CHECK(json_valid(data)), state TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS engineering_members(project_id TEXT NOT NULL REFERENCES engineering_projects(id), user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('manager','engineer','finance','viewer')), PRIMARY KEY(project_id,user_id));
    CREATE TABLE IF NOT EXISTS engineering_items(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES engineering_projects(id), kind TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), version INTEGER NOT NULL DEFAULT 1, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS engineering_items_project ON engineering_items(project_id,kind);
    CREATE TABLE IF NOT EXISTS engineering_history(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES engineering_projects(id), item_id TEXT NOT NULL, kind TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), actor_name TEXT NOT NULL, action TEXT NOT NULL, note TEXT NOT NULL, at TEXT NOT NULL);
    -- Latest-first project history for the detail view (LIMIT 500) without sorting every history row.
    CREATE INDEX IF NOT EXISTS engineering_history_project_at ON engineering_history(project_id,at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS engineering_stock(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES engineering_projects(id), material_id TEXT NOT NULL REFERENCES engineering_items(id), kind TEXT NOT NULL CHECK(kind IN ('opening','receive','issue','return')), quantity INTEGER NOT NULL CHECK(quantity>0), reference_id TEXT NOT NULL, note TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS engineering_documents(project_id TEXT NOT NULL REFERENCES engineering_projects(id), kind TEXT NOT NULL CHECK(kind IN ('daily','photo')), document_id TEXT NOT NULL, linked_by TEXT NOT NULL REFERENCES users(id), at TEXT NOT NULL, PRIMARY KEY(project_id,kind,document_id));
    CREATE TABLE IF NOT EXISTS engineering_requests(actor_id TEXT NOT NULL REFERENCES users(id), request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)), PRIMARY KEY(actor_id,request_id));
  `);
  // Additive migration also supports databases created by the first engineering candidate.
  if(!db.prepare('PRAGMA table_info(engineering_items)').all().some(c=>c.name==='edited_by'))db.exec('ALTER TABLE engineering_items ADD COLUMN edited_by TEXT REFERENCES users(id)');
  function roleFor(actor,pid){if(actor.role==='admin')return 'admin';const r=db.prepare('SELECT role FROM engineering_members WHERE project_id=? AND user_id=?').get(pid,actor.id)?.role;return actor.role==='viewer'&&r?'viewer':r;}
  const financial = role => ['admin','manager','finance'].includes(role);
  const manager = role => ['admin','manager'].includes(role);
  function access(req,write=false){const p=parseRow(db.prepare('SELECT * FROM engineering_projects WHERE id=?').get(id.parse(req.params.pid)));const role=p&&roleFor(req.actor,p.id);if(!p||!role)fail(404,'项目不存在或未授权');if(write&&(req.actor.role==='viewer'||role==='viewer'))fail(403,'当前项目为只读权限');return {p,role};}
  const active = p => {const current=parseRow(db.prepare('SELECT * FROM engineering_projects WHERE id=?').get(p.id));if(!current||current.state!=='active')fail(409,'请先启动项目；已完成或归档项目不能新增或修改业务');Object.assign(p,current);};
  const getItems = pid => db.prepare('SELECT * FROM engineering_items WHERE project_id=? ORDER BY created_at DESC,id DESC').all(pid).map(parseRow);
  function getItem(pid,iid,kind){const r=parseRow(db.prepare('SELECT * FROM engineering_items WHERE project_id=? AND id=?').get(pid,iid));if(!r||(kind&&r.kind!==kind))fail(400,'关联记录不存在或不属于本项目');return r;}
  function allowKind(role,kind,write=false){const c=engineeringCatalog[kind];if(!c)fail(404,'业务模块不存在');if(c.financial&&!financial(role))fail(403,'没有项目经营数据权限');if(write&&role==='finance'&&!c.financial)fail(403,'财务成员不能修改现场业务');return c;}
  function history(actor,pid,iid,kind,action,details){db.prepare('INSERT INTO engineering_history VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),pid,iid,kind,actor.id,actor.name,action,details,now());store.audit(actor,action,'engineering_'+kind,iid,details);}
  function mutate(req,key,fn){const requestId=id.parse(req.body.requestId);const fingerprint=createHash('sha256').update(key+'\n'+JSON.stringify(req.body)).digest('hex');return store.transaction(()=>{const old=db.prepare('SELECT * FROM engineering_requests WHERE actor_id=? AND request_id=?').get(req.actor.id,requestId);if(old){if(old.fingerprint!==fingerprint)fail(409,'请求编号已使用，请刷新核对后重试');return {...JSON.parse(old.result),replayed:true};}const result=fn();db.prepare('INSERT INTO engineering_requests VALUES(?,?,?,?)').run(req.actor.id,requestId,fingerprint,JSON.stringify(result));return result;});}
  function checkVersion(row,v){const table=row.kind?'engineering_items':'engineering_projects';const current=parseRow(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(row.id));if(!current||current.version!==v)fail(409,'记录已被更新，请刷新核对后再操作');Object.assign(row,current);}
  function saveItem(row){db.prepare('UPDATE engineering_items SET state=?,data=?,version=version+1,updated_at=? WHERE id=?').run(row.state,JSON.stringify(row.data),now(),row.id);return getItem(row.project_id,row.id);}
  let commerce,corrections,boq,purchases,purchaseReturns,supplierFinance,costControl,subcontracts;
  const reversals=createEngineeringReversals({store,access,active,mutate,history,getItem,saveItem,manager,financial,isSettlementEffective:iid=>!corrections.voided(iid),purchaseReversalCheck:(...args)=>purchases.reversalCheck(...args),stockReversalCheck:(...args)=>costControl?.stockCheck(...args),stockDelta:mid=>purchaseReturns?.stockDelta(mid)||0,receivedDelta:iid=>purchaseReturns?.receivedDelta(iid)||0,costRefundAmount:iid=>supplierFinance?.refundedAmount(iid)||0,costReversalCheck:(...args)=>supplierFinance?.costReversalCheck(...args)});
  purchases=createEngineeringPurchases({store,access,active,mutate,history,getItems,getItem,manager,financial,reversed:reversals.reversed,returns:pid=>purchaseReturns?.rows(pid)||[]});
  purchaseReturns=createEngineeringPurchaseReturns({store,access,active,mutate,history,getItems,getItem,manager,purchases,reversed:reversals.reversed,balance:reversals.balance});
  supplierFinance=createEngineeringSupplierFinance({store,access,active,mutate,history,getItem,getItems,manager,financial,getReturn:purchaseReturns.get,returnRows:purchaseReturns.rows,voided:iid=>corrections.voided(iid),reversed:reversals.reversed,pendingCorrection:(...args)=>corrections.pendingContract(...args)});
  corrections=createEngineeringCorrections({store,access,active,mutate,history,getItems,getItem,saveItem,manager,financial,reversed:reversals.reversed,contractSummary:(...args)=>commerce.contractSummary(...args),effectivePurchaseAmount:row=>purchases.effectiveAmount(row),effectiveCostAmount:reversals.costAmount,additionalEligibility:(...args)=>({blockers:[...boq.correctionCheck(...args).blockers,...supplierFinance.correctionCheck(...args).blockers,...(subcontracts?.correctionCheck(...args).blockers||[])]}),onApproved:(...args)=>boq.applyCorrection(...args)});
  commerce=createEngineeringCommerce({getItems,getItem,voided:corrections.voided,pendingCorrection:corrections.pendingContract,effectivePurchaseAmount:row=>purchases.effectiveAmount(row),effectiveSettlementAmount:row=>supplierFinance.effectiveSettlement(row)});
  boq=createEngineeringBoq({store,access,active,mutate,history,getItems,getItem,manager,financial,voided:corrections.voided,contractSummary:commerce.contractSummary,saveItem});
  costControl=createEngineeringCostControl({store,access,active,mutate,history,getItems,getItem,financial,manager,reversed:reversals.reversed,boq});
  subcontracts=createEngineeringSubcontracts({store,access,active,mutate,history,getItems,getItem,financial,manager,voided:corrections.voided,reversed:reversals.reversed,effectiveSettlement:row=>supplierFinance.effectiveSettlement(row),effectiveCost:reversals.costAmount,wbs:costControl.publicView});
  const usedAmount = (pid,kind,key,value,exclude) => sum(getItems(pid).filter(r=>r.id!==exclude&&r.kind===kind&&r.state==='approved'&&!corrections.voided(r.id)&&r.data[key]===value).map(r=>kind==='costs'?reversals.costAmount(r):kind==='settlements'?supplierFinance.effectiveSettlement(r):r.data.amount));
  const {balance,received}=reversals;
  function validate(pid,kind,data,current,approving=false){
    if(kind==='materials'&&current)costControl.materialCheck(pid,current.id,data);
    if(data.startDate&&data.dueDate&&data.startDate>data.dueDate)fail(400,'计划完成日期不能早于开始日期');
    for(const [key,,type] of engineeringCatalog[kind].fields)if(type.startsWith('ref:')&&data[key]){const reference=getItem(pid,data[key],type.slice(4));if(corrections.voided(reference.id))fail(409,'关联原单业务影响已撤销，请选择新的有效单据');}
    if(data.code&&getItems(pid).some(r=>r.id!==current?.id&&r.kind===kind&&r.data.code?.toLowerCase()===data.code.toLowerCase()))fail(409,'本项目内编号已存在');
    if(kind==='tasks'&&data.predecessorId){const visited=new Set(current?[current.id]:[]);let next=data.predecessorId;while(next){if(visited.has(next))fail(409,'前置任务不能形成循环');visited.add(next);next=getItem(pid,next,'tasks').data.predecessorId;}}
    if(kind==='purchases')purchases.validate(pid,data,current,approving);
    if(kind==='settlements'&&getItem(pid,data.contractId,'contracts').state!=='approved')fail(409,'结算需要已批准且未关闭的合同');
    const boqMeasurement=approving ? kind==='measurements'&&data.lines.some(line=>line.boqItemId) : boq.validate(pid,kind,data,current);
    commerce.validate(pid,kind,data,{skipMeasurementCalculation:boqMeasurement});
    subcontracts.validate(pid,kind,data);
    if(kind==='measurements'){
      if(approving)checkMeasurementTasks(pid,data,getItem);
      else freezeMeasurementTasks(pid,data,getItem);
    }
    if(kind==='costs'&&data.settlementId){const s=getItem(pid,data.settlementId,'settlements');const c=getItem(pid,s.data.contractId,'contracts');if(s.state!=='approved'||corrections.voided(s.id)||c.state!=='approved'||data.direction!==c.data.direction)fail(409,'收支须关联已批准且未撤销的结算，并与未关闭合同的收支方向一致');}
  }
  function approvalCheck(p,row){
    boq.approve(p.id,row);
    validate(p.id,row.kind,row.data,row,true);
    commerce.approve(p.id,row);
    subcontracts.approved(p.id,row);
    if(row.kind==='costs'){
      subcontracts.paymentCheck(p.id,row);
      if(row.data.settlementId&&usedAmount(p.id,'costs','settlementId',row.data.settlementId,row.id)+row.data.amount>supplierFinance.effectiveSettlement(getItem(p.id,row.data.settlementId,'settlements')))fail(409,'累计收支超过已批准结算金额');
      const expenses=sum(getItems(p.id).filter(r=>r.id!==row.id&&r.kind==='costs'&&r.state==='approved'&&r.data.direction==='expense').map(r=>reversals.costAmount(r)));
      if(row.data.direction==='expense'&&expenses+row.data.amount>p.data.budget)fail(409,'支出超过项目预算，请先由管理员核定预算');
    }
  }
  function visibleDocs(actor,pid){return db.prepare('SELECT * FROM engineering_documents WHERE project_id=? ORDER BY at DESC').all(pid).flatMap(link=>{const table=link.kind==='daily'?'daily_reports':'photo_archives';const d=db.prepare(`SELECT id,author_id,author_name,project_name,${link.kind==='daily'?'number':'title'} title FROM ${table} WHERE id=? AND (?='admin' OR author_id=?)`).get(link.document_id,actor.role,actor.id);return d?[{...link,title:d.title,projectName:d.project_name,authorName:d.author_name}]:[];});}
  function projectView(p,role){const data={...p.data};if(!financial(role))delete data.budget;return {...p,data,role};}
  const progress=createEngineeringProgress({store,access,active,mutate,history,getItems,getItem,saveItem,manager});
  const baselines=createEngineeringBaselines({store,access,active,mutate,history,getItems,manager,actualAt:progress.actualAt});
  const valuePlans=createEngineeringValuePlans({store,access,active,mutate,history,getItems,getItem,financial,manager,voided:corrections.voided,boq,baselines});
  const replacements=createEngineeringReplacements({store,access,active,mutate,history,getItems,manager,financial,corrections,boq});
  function purchaseFulfillmentView(pid,all){
    const view=purchases.projectView(pid,all);
    view.orders=view.orders.map(order=>{const pending=supplierFinance.pendingPurchase(order.purchaseId);return {...order,pendingSupplierFinance:pending,canClose:order.canClose&&!pending,closeBlockers:[...order.closeBlockers,...(pending?['有待审供应商抵减或退款']:[])]};});
    return view;
  }
  function supplierReturnMovements(pid,role){
    return purchaseReturns.rows(pid).filter(row=>row.state==='dispatched').flatMap(row=>row.snapshot.lines.map(line=>({id:row.id+':'+line.receiptId,project_id:pid,material_id:line.materialId,kind:'supplier_return',quantity:line.quantity,quantityDelta:-line.quantity,effective_date:row.dispatch.effectiveDate,document_no:financial(role)?row.dispatch.documentNo:'',note:financial(role)?row.dispatch.note:'供应商退货出库',actor_name:row.dispatch.actorName,created_at:row.dispatch.at,...(financial(role)?{purchase_id:row.purchase_id,return_id:row.id,receipt_id:line.receiptId,purchase_line_id:line.purchaseLineId}:{})})));
  }
  function readProjectDetail(actor,p,role){
      const all=getItems(p.id);const items=all.filter(r=>!engineeringCatalog[r.kind].financial||financial(role));
      const projectedItems=items.map(r=>({...corrections.view(p.id,commerce.view(p.id,r,all),all),reversed:r.kind==='costs'&&reversals.reversed('cost',r.id),...(r.kind==='costs'?{effectiveAmount:r.state==='approved'?reversals.costAmount(r):0,refundedAmount:supplierFinance.refundedAmount(r.id)}:r.kind==='settlements'?{effectiveAmount:supplierFinance.effectiveSettlement(r),creditAmount:supplierFinance.creditAmount(r.id)}:{})}));
      const finance=financial(role)?{budget:p.data.budget,expense:sum(all.filter(r=>r.kind==='costs'&&r.state==='approved'&&r.data.direction==='expense').map(r=>reversals.costAmount(r))),income:sum(all.filter(r=>r.kind==='costs'&&r.state==='approved'&&r.data.direction==='income').map(r=>reversals.costAmount(r))),payable:sum(all.filter(r=>r.kind==='settlements'&&r.state==='approved'&&!corrections.voided(r.id)&&getItem(p.id,r.data.contractId).data.direction==='expense').map(r=>supplierFinance.effectiveSettlement(r))),supplierRefund:sum(supplierFinance.rows('refunds',p.id).filter(r=>r.state==='approved').map(r=>r.amount)),receivable:sum(all.filter(r=>r.kind==='settlements'&&r.state==='approved'&&!corrections.voided(r.id)&&getItem(p.id,r.data.contractId).data.direction==='income').map(r=>r.data.amount))}:null;
      // The sub-views below only read items, so they share this request's snapshot; purchase returns reuse the fulfillment built from it.
      let fulfillment;
      return {project:projectView(p,role),items:projectedItems,finance,purchaseFulfillment:financial(role)?(fulfillment=purchaseFulfillmentView(p.id,all)):null,purchaseReturns:financial(role)?purchaseReturns.projectView(p.id,fulfillment):null,supplierFinance:financial(role)?supplierFinance.projectView(p.id,all):null,supplierReturnMovements:supplierReturnMovements(p.id,role),subcontracts:financial(role)?subcontracts.view(p.id,all):null,wbs:costControl.publicView(p.id),costControl:financial(role)?costControl.view(p.id,all):null,progressPending:progress.pending(p.id),taskValues:financial(role)?buildEngineeringTaskValues(projectedItems,{projectId:p.id,observedAt:now()}):null,valuePlans:financial(role)?valuePlans.view(p,undefined,all):null,replacements:financial(role)?replacements.view(p,undefined,all):null,boq:financial(role)?boq.projectView(p.id):null,reversals:reversals.list(p.id,role),corrections:corrections.list(p.id,role),stock:db.prepare('SELECT * FROM engineering_stock WHERE project_id=? ORDER BY created_at DESC,id DESC').all(p.id).map(r=>({...r,reversed:reversals.reversed('stock',r.id),reference_id:!financial(role)&&r.kind==='receive'?'':r.reference_id,purchase_line_id:!financial(role)?'':r.purchase_line_id,receipt_batch_id:!financial(role)?'':r.receipt_batch_id})),balances:Object.fromEntries(items.filter(r=>r.kind==='materials').map(r=>[r.id,balance(r.id)])),receipts:financial(role)?Object.fromEntries(items.filter(r=>r.kind==='purchases'&&!Array.isArray(r.data.lines)).map(r=>[r.id,received(r.id)])):{},documents:visibleDocs(actor,p.id),history:db.prepare('SELECT * FROM engineering_history WHERE project_id=? ORDER BY at DESC,id DESC LIMIT 500').all(p.id).filter(h=>(!engineeringCatalog[h.kind]?.financial||financial(role))&&siteRecordHistoryVisible(actor,p.id,h.item_id)),members:db.prepare('SELECT m.user_id,m.role,u.name,u.active FROM engineering_members m JOIN users u ON u.id=m.user_id WHERE project_id=?').all(p.id)};
  }
  for(const [base,authorize] of [['/api/engineering',auth],['/api/mobile/engineering',mobileAuth]]){
    reversals.mount(app,base,authorize,writer);
    corrections.mount(app,base,authorize,writer);
    baselines.mount(app,base,authorize,writer);
    boq.mount(app,base,authorize,writer);
    valuePlans.mount(app,base,authorize,writer);
    replacements.mount(app,base,authorize,writer);
    progress.mount(app,base,authorize,writer);
    purchases.mount(app,base,authorize,writer);
    purchaseReturns.mount(app,base,authorize,writer);
    supplierFinance.mount(app,base,authorize,writer);
    costControl.mount(app,base,authorize,writer);
    subcontracts.mount(app,base,authorize,writer);
    mountEngineeringExport(app,{base,authorize,store,access,financial,readProjectDetail});
    mountEngineeringProgressExport(app,{base,authorize,store,access,progress,baselines});
    app.get(base+'/projects/:pid/task-values',authorize,(req,res)=>{
      z.object({}).strict().parse(req.query);
      res.json(store.transaction(()=>{const {p,role}=access(req);if(!financial(role))fail(403,'没有项目任务计量产值权限');
        const items=getItems(p.id).map(row=>({...row,voided:corrections.voided(row.id)}));
        return buildEngineeringTaskValues(items,{projectId:p.id,observedAt:now()});
      }));
    });
    app.get(base,authorize,(req,res)=>{const projects=db.prepare('SELECT * FROM engineering_projects ORDER BY updated_at DESC,id DESC').all().map(parseRow).filter(p=>roleFor(req.actor,p.id)).map(p=>projectView(p,roleFor(req.actor,p.id)));res.json({projects,catalog:engineeringCatalog});});
    app.post(base+'/projects',authorize,writer,(req,res)=>{
      if(req.actor.role!=='admin')fail(403,'管理员可立项并分配项目权限');const {data}=z.object({requestId:id,data:projectSchema}).strict().parse(req.body);if(data.startDate>data.dueDate)fail(400,'计划结束不能早于开始');
      res.status(201).json(mutate(req,'project:create',()=>{if(db.prepare('SELECT 1 FROM engineering_projects WHERE code=? COLLATE NOCASE').get(data.code))fail(409,'项目编号已存在');const pid=randomUUID(),at=now();db.prepare('INSERT INTO engineering_projects VALUES(?,?,?,?,?,?,?,?)').run(pid,data.code,JSON.stringify(data),'planned',1,req.actor.id,at,at);history(req.actor,pid,pid,'project','create','项目立项：'+data.name);return {id:pid};}));
    });
    app.get(base+'/projects/:pid',authorize,(req,res)=>{const {p,role}=access(req);res.json(readProjectDetail(req.actor,p,role));});
    app.put(base+'/projects/:pid',authorize,writer,(req,res)=>{const {p}=access(req,true);if(req.actor.role!=='admin')fail(403,'项目资料和预算由管理员核定');const b=z.object({requestId:id,version,data:projectSchema}).strict().parse(req.body);res.json(mutate(req,p.id+':edit',()=>{checkVersion(p,b.version);if(p.state==='archived')fail(409,'归档项目不可修改');if(b.data.startDate>b.data.dueDate)fail(400,'计划结束不能早于开始');const spent=sum(getItems(p.id).filter(r=>r.kind==='costs'&&r.state==='approved'&&r.data.direction==='expense').map(r=>reversals.costAmount(r)));if(b.data.budget<spent)fail(409,'预算不能低于已入账支出');costControl.projectCheck(p.id,b.data.budget);if(db.prepare('SELECT 1 FROM engineering_projects WHERE code=? COLLATE NOCASE AND id<>?').get(b.data.code,p.id))fail(409,'项目编号已存在');db.prepare('UPDATE engineering_projects SET code=?,data=?,version=version+1,updated_at=? WHERE id=?').run(b.data.code,JSON.stringify(b.data),now(),p.id);history(req.actor,p.id,p.id,'project','update','更新项目资料与预算');return {ok:true};}));});
    app.post(base+'/projects/:pid/state',authorize,writer,(req,res)=>{const {p,role}=access(req,true);if(!manager(role))fail(403,'需要项目经理权限');const b=z.object({requestId:id,version,state:z.enum(['active','completed','archived']),note}).strict().parse(req.body);res.json(mutate(req,p.id+':state',()=>{checkVersion(p,b.version);if(!({planned:['active'],active:['completed'],completed:['active','archived']}[p.state]||[]).includes(b.state))fail(409,'不允许该项目状态变化');if(['completed','archived'].includes(b.state)){
      const pending=getItems(p.id).filter(r=>!({tasks:['completed','cancelled'],issues:['closed'],contracts:['closed','cancelled'],purchases:['closed','cancelled'],settlements:['approved','cancelled'],costs:['approved','cancelled'],variations:['approved','cancelled'],measurements:['approved','cancelled'],crews:['exited','cancelled'],materials:['active']}[r.kind]||[]).includes(r.state));if(pending.length||purchases.pending(p.id)||purchaseReturns.pending(p.id)||supplierFinance.pending(p.id)||progress.pending(p.id)||reversals.pending(p.id)||corrections.pending(p.id)||baselines.pending(p.id)||boq.pending(p.id)||valuePlans.pending(p.id)||replacements.pending(p.id)||costControl.pending(p.id)||subcontracts.pending(p.id)||siteRecordsPending(p.id))fail(409,'仍有待办采购退货/抵减/退款/终止/日期进度/更正关联/目标方案/清单/基线/纠错/冲销、未完成任务、整改、批次草稿、业务单据或在场人员，暂不能完成/归档');
    }db.prepare('UPDATE engineering_projects SET state=?,version=version+1,updated_at=? WHERE id=?').run(b.state,now(),p.id);history(req.actor,p.id,p.id,'project',b.state,b.note);return {ok:true};}));});
    app.get(base+'/projects/:pid/users',authorize,(req,res)=>{access(req);if(req.actor.role!=='admin')fail(403,'仅管理员分配成员');res.json(db.prepare('SELECT id,name,username,role FROM users WHERE active=1 ORDER BY name').all());});
    app.put(base+'/projects/:pid/members',authorize,writer,(req,res)=>{const {p}=access(req,true);if(req.actor.role!=='admin')fail(403,'仅管理员分配项目权限');const b=z.object({requestId:id,userId:id,role:z.enum(['manager','engineer','finance','viewer','remove'])}).strict().parse(req.body);res.json(mutate(req,p.id+':member',()=>{if(!db.prepare('SELECT 1 FROM users WHERE id=? AND active=1').get(b.userId))fail(400,'账号不存在或已停用');if(b.role==='remove')db.prepare('DELETE FROM engineering_members WHERE project_id=? AND user_id=?').run(p.id,b.userId);else db.prepare('INSERT INTO engineering_members VALUES(?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET role=excluded.role').run(p.id,b.userId,b.role);history(req.actor,p.id,p.id,'project','member','调整项目成员权限');return {ok:true};}));});
    app.post(base+'/projects/:pid/items/:kind',authorize,writer,(req,res)=>{const {p,role}=access(req,true),c=allowKind(role,req.params.kind,true);const b=z.object({requestId:id,data:schemas[req.params.kind]}).strict().parse(req.body);res.status(201).json(mutate(req,p.id+':'+req.params.kind+':create',()=>{active(p);validate(p.id,req.params.kind,b.data);if(req.params.kind==='tasks'&&b.data.progress!==0)fail(400,'新任务完成比例应为0');const iid=randomUUID(),at=now();db.prepare('INSERT INTO engineering_items(id,project_id,kind,state,data,version,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(iid,p.id,req.params.kind,c.initial,JSON.stringify(b.data),1,req.actor.id,at,at);purchases.saved(getItem(p.id,iid));history(req.actor,p.id,iid,req.params.kind,'create','新建'+c.singular+'：'+b.data.title);return {id:iid};}));});
    app.put(base+'/projects/:pid/items/:iid',authorize,writer,(req,res)=>{const {p,role}=access(req,true),row=getItem(p.id,id.parse(req.params.iid));allowKind(role,row.kind,true);const b=z.object({requestId:id,version,data:schemas[row.kind]}).strict().parse(req.body);res.json(mutate(req,p.id+':'+row.id+':edit',()=>{active(p);checkVersion(row,b.version);if(!({tasks:['planned','active'],issues:['open','rectifying'],materials:['active'],crews:['pending']}[row.kind]||['draft']).includes(row.state))fail(409,'当前状态不可修改，已批准单据和已关闭记录不可改写');if(row.kind==='materials'){purchases.lockMaterial(p.id,row.id,b.data,row.data);if(db.prepare('SELECT 1 FROM engineering_stock WHERE material_id=? LIMIT 1').get(row.id)&&['unit','warehouse','code','specification'].some(k=>b.data[k]!==row.data[k]))fail(409,'已有库存流水，单位、编码、规格及仓库不可改写');}validate(p.id,row.kind,b.data,row);if(row.kind==='tasks'&&b.data.progress!==row.data.progress)fail(409,'人工进度须通过日期进度填报并独立复核，不能直接修改任务完成比例');row.data=b.data;db.prepare('UPDATE engineering_items SET edited_by=? WHERE id=?').run(req.actor.id,row.id);const result=saveItem(row);purchases.saved(result);history(req.actor,p.id,row.id,row.kind,'update','修改'+b.data.title);return {id:result.id,version:result.version};}));});
    app.post(base+'/projects/:pid/items/:iid/state',authorize,writer,(req,res)=>{const {p,role}=access(req,true),row=getItem(p.id,id.parse(req.params.iid)),c=allowKind(role,row.kind,true);const b=z.object({requestId:id,version,state:text.min(1),note}).strict().parse(req.body);res.json(mutate(req,p.id+':'+row.id+':state',()=>{active(p);checkVersion(row,b.version);if(!c.transitions[row.state]?.some(([s])=>s===b.state))fail(409,'不允许该业务状态变化');if((c.financial&&['approved','closed'].includes(b.state)||row.kind==='issues'&&['closed','rectifying'].includes(b.state)&&['review','closed'].includes(row.state)||row.kind==='crews'&&b.state==='active')&&!manager(role))fail(403,'此步骤需要项目经理或管理员审核');
      if(c.financial&&b.state==='approved'&&(row.created_by===req.actor.id||row.edited_by===req.actor.id))fail(409,'创建人或最后修改人不能审批本经营单据，请另一位项目经理或管理员审核');
      if(row.kind==='tasks'&&['completed','cancelled'].includes(b.state)&&progress.pending(p.id,row.id))fail(409,'任务仍有待复核进度，请先办理或撤回后再完成或取消');
      if(row.kind==='tasks'&&b.state==='completed'&&progress.actualAt(p.id,row.id,new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date())).progress!==100)fail(409,'完成任务须有当前100%的已批准日期进度，旧填报值不能替代日期依据');
      if(row.kind==='tasks'&&row.state==='completed'&&b.state==='active'){if(!manager(role))fail(403,'恢复施工须由项目经理或管理员办理');if(getItems(p.id).some(r=>r.kind==='tasks'&&r.data.predecessorId===row.id&&['active','completed'].includes(r.state)))fail(409,'直接后续任务已经开始或完成，请先核对后续施工依赖，暂不能恢复本任务');}
      if(row.kind==='tasks'&&['active','completed'].includes(b.state)){if(row.data.predecessorId&&getItem(p.id,row.data.predecessorId,'tasks').state!=='completed')fail(409,'前置任务尚未完成');if(b.state==='completed'&&row.data.progress!==100)fail(409,'完成比例达到100%后才能完成任务');}
      if(row.kind==='tasks'&&b.state==='cancelled'&&getItems(p.id).some(r=>r.kind==='tasks'&&r.data.predecessorId===row.id&&!['completed','cancelled'].includes(r.state)))fail(409,'仍有后续任务依赖，请先调整后续任务');
      if(row.kind==='tasks'&&b.state==='cancelled'){if(siteRecordsPending(p.id,row.id))fail(409,'任务仍有未归档施工资料或未撤回作业批次，请先处理后再取消');costControl.taskCheck(p.id,row.id);checkTaskCancellation(p.id,row.id,getItems,corrections.voided);}
      if(b.state==='submitted'){if(row.kind==='purchases')purchases.validate(p.id,row.data,row,true);if(row.kind==='measurements')checkMeasurementTasks(p.id,row.data,getItem);boq.approve(p.id,row);}
      if(b.state==='approved')approvalCheck(p,row);
      if(row.kind==='purchases'&&b.state==='closed'){if(supplierFinance.pendingPurchase(row.id))fail(409,'采购仍有待审结算抵减或供应商退款');purchases.close(p.id,row.id);}
      if(row.kind==='contracts'&&b.state==='closed'){
        purchases.closeContract(p.id,row.id);
        supplierFinance.close(p.id,row.id);
        subcontracts.close(p.id,row.id);
        replacements.close(p.id,row.id);
        valuePlans.close(p.id,row.id);
        boq.close(p.id,row.id);
        const commercial=commerce.close(p.id,row.id),all=getItems(p.id),ss=all.filter(r=>r.kind==='settlements'&&r.data.contractId===row.id&&r.state!=='cancelled'&&!corrections.voided(r.id));if(ss.some(r=>r.state!=='approved')||sum(ss.map(r=>supplierFinance.effectiveSettlement(r)))!==commercial.effectiveAmount)fail(409,'合同尚未按有效合同额足额结算');
        if(ss.some(s=>usedAmount(p.id,'costs','settlementId',s.id)!==supplierFinance.effectiveSettlement(s))||all.some(r=>r.kind==='purchases'&&r.data.contractId===row.id&&!['closed','cancelled'].includes(r.state))||all.some(r=>r.kind==='costs'&&ss.some(s=>s.id===r.data.settlementId)&&!['approved','cancelled'].includes(r.state)))fail(409,'合同仍有未完成采购或未结清收支');
      }
      row.state=b.state;let result;if(row.kind==='purchases'){db.prepare('UPDATE engineering_items SET state=?,version=version+1,updated_at=? WHERE id=?').run(row.state,now(),row.id);result=getItem(p.id,row.id);}else result=saveItem(row);if(row.kind==='purchases'&&b.state==='approved')purchases.saved(result);history(req.actor,p.id,row.id,row.kind,b.state,b.note);return {id:result.id,version:result.version};}));});
    app.post(base+'/projects/:pid/stock',authorize,writer,(req,res)=>{const {p,role}=access(req,true);if(!['admin','manager','engineer'].includes(role))fail(403,'需要现场业务权限');const b=z.object({requestId:id,materialId:id,kind:z.enum(['opening','receive','issue','return']),quantity,referenceId:z.union([id,z.literal('')]).default(''),purchaseLineId:z.union([id,z.literal('')]).optional().default(''),note}).strict().parse(req.body);res.status(201).json(mutate(req,p.id+':stock',()=>{active(p);getItem(p.id,b.materialId,'materials');if(b.kind!=='receive'&&b.purchaseLineId)fail(400,'仅采购入库接受采购行标识');
      if(b.kind==='opening'){if(!manager(role))fail(403,'期初盘点需要项目经理');if(db.prepare("SELECT 1 FROM engineering_stock s WHERE material_id=? AND NOT EXISTS(SELECT 1 FROM engineering_adjustments a WHERE a.target_type='stock' AND a.target_id=s.id)").get(b.materialId))fail(409,'已有有效流水不能再次登记期初');}
      if(b.kind==='receive'){if(!manager(role))fail(403,'采购验收入库需要项目经理');const line=purchases.receiptCheck(p.id,b.referenceId,b.purchaseLineId,b.materialId,b.quantity),batch=randomUUID(),sid=purchases.insertReceipt(p.id,b.referenceId,line,b.quantity,batch,req.actor,b.note);return {id:sid,balance:balance(b.materialId),purchaseLineId:line.id,receiptBatchId:batch};}
      if(b.kind==='issue'&&b.quantity>balance(b.materialId))fail(409,'库存不足，不能负库存领料');
      if(b.kind==='return'){const issue=db.prepare("SELECT * FROM engineering_stock WHERE id=? AND project_id=? AND material_id=? AND kind='issue'").get(b.referenceId,p.id,b.materialId);if(!issue||reversals.reversed('stock',issue.id))fail(400,'退料需要关联有效原领料记录');const returned=reversals.returned(issue.id);if(returned+b.quantity>issue.quantity)fail(409,'累计退料超过原领料数量');costControl.returnCheck(p.id,issue.id,b.quantity);}
      if(['opening','issue'].includes(b.kind)&&b.referenceId)fail(400,'期初和领料不接受关联采购 / 领料编号');const sid=randomUUID();db.prepare('INSERT INTO engineering_stock(id,project_id,material_id,kind,quantity,reference_id,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(sid,p.id,b.materialId,b.kind,b.quantity,b.referenceId,b.note,req.actor.id,now());history(req.actor,p.id,b.materialId,'materials',b.kind,b.note);return {id:sid,balance:balance(b.materialId)};}));});
    app.get(base+'/projects/:pid/document-candidates',authorize,(req,res)=>{const {p}=access(req),results=[];for(const [kind,table,title] of [['daily','daily_reports','number'],['photo','photo_archives','title']]){const own=documentScope(kind,'src',p.id),unassigned=documentScope(kind,'src');for(const r of db.prepare(`SELECT src.id,project_name,${title} title,author_name,${kind==='daily'?'report_date':'NULL'} reportDate,${kind==='daily'?"json_extract(data,'$.sections[0].name')":'NULL'} sectionName,${kind==='daily'?"json_array_length(json_extract(data,'$.sections'))":'NULL'} sectionCount FROM ${table} src WHERE (?='admin' OR author_id=?) AND (${own.sql} OR ${unassigned.sql}) ORDER BY created_at DESC LIMIT 100`).all(req.actor.role,req.actor.id,...own.args))results.push({kind,id:r.id,title:r.title,projectName:r.project_name,authorName:r.author_name,reportDate:r.reportDate,sectionName:r.sectionCount===1?r.sectionName:'',sectionCount:r.sectionCount});}res.json(results);});
    app.post(base+'/projects/:pid/documents',authorize,writer,(req,res)=>{const {p,role}=access(req,true);if(role==='finance')fail(403,'财务成员不能整理现场资料');const b=z.object({requestId:id,kind:z.enum(['daily','photo']),documentId:id}).strict().parse(req.body);const table=b.kind==='daily'?'daily_reports':'photo_archives';if(!db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND (?='admin' OR author_id=?)`).get(b.documentId,req.actor.role,req.actor.id))fail(404,'资料不存在或无权访问');res.json(mutate(req,p.id+':document',()=>{active(p);requireDocumentProject(db,b.kind,b.documentId,p.id);db.prepare('INSERT OR IGNORE INTO engineering_documents VALUES(?,?,?,?,?)').run(p.id,b.kind,b.documentId,req.actor.id,now());history(req.actor,p.id,p.id,'document','link','关联已有'+(b.kind==='daily'?'施工日报':'施工影像资料'));return {ok:true};}));});
  }
}
