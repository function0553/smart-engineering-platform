import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {fail} from './service.mjs';

const id=z.string().uuid(),note=z.string().trim().min(1).max(2000),version=z.number().int().positive();
const amount=z.number().int().positive().max(1_000_000_000_000),now=()=>new Date().toISOString();
const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
const retention=(value,bps)=>Number((BigInt(value)*BigInt(bps)+5000n)/10000n);
const parse=r=>({...r,data:JSON.parse(r.data),snapshot:JSON.parse(r.snapshot)});

// Derive the ledger from original signed sources, never from client totals.
export function buildEngineeringSubcontractView({projectId,records=[],holdbacks=[],completions=[],items=[],effectiveSettlement=r=>r.voided?0:r.data.amount,effectiveCost=r=>r.reversed?0:(r.effectiveAmount??r.data.amount)}){
 const invalid=()=>fail(422,'分包保留金原件不完整或口径不一致');
 const map=new Map(items.map(r=>[r.id,r])),recordMap=new Map(),seen=new Set();
 for(const r of [...records,...holdbacks,...completions]){if(r.project_id!==projectId)invalid();}
 for(const r of records){if(recordMap.has(r.id)||!['policy','release','void'].includes(r.kind)||!['submitted','approved','rejected','cancelled'].includes(r.state))invalid();recordMap.set(r.id,r);}
 const policies=records.filter(r=>r.kind==='policy');
 for(const r of policies){const c=map.get(r.data.contractId);if(!c||c.kind!=='contracts'||c.project_id!==projectId||c.data.direction!=='expense'||!Number.isInteger(r.data.retentionBps)||r.data.retentionBps<0||r.data.retentionBps>10000||r.snapshot.contractId!==c.id||r.snapshot.contract.amount!==c.data.amount||r.snapshot.contract.counterparty!==c.data.counterparty)invalid();if(r.state==='approved'){if(seen.has(c.id))invalid();seen.add(c.id);}}
 const approvedPolicies=new Map(policies.filter(r=>r.state==='approved').map(r=>[r.data.contractId,r]));
 const voids=records.filter(r=>r.kind==='void'),voided=new Set();
 for(const r of voids){const source=recordMap.get(r.data.releaseId);if(!source||source.kind!=='release'||source.state!=='approved'||r.snapshot.sourceId!==source.id||r.snapshot.amount!==source.data.amount)invalid();if(r.state==='approved'){if(voided.has(source.id))invalid();voided.add(source.id);}}
 const releases=records.filter(r=>r.kind==='release').map(r=>({...r,voided:voided.has(r.id),effectiveAmount:r.state==='approved'&&!voided.has(r.id)?r.data.amount:0}));
 const holds=new Map();
 for(const h of holdbacks){const s=map.get(h.settlement_id),p=recordMap.get(h.policy_id);if(holds.has(h.settlement_id)||!s||s.kind!=='settlements'||s.state!=='approved'||!p||p.kind!=='policy'||p.state!=='approved'||s.data.contractId!==p.data.contractId||h.snapshot.settlementAmount!==s.data.amount||h.snapshot.measurementId!==s.data.measurementId||h.amount!==retention(s.data.amount,p.data.retentionBps)||h.snapshot.retentionBps!==p.data.retentionBps)invalid();holds.set(s.id,h);}
 for(const r of releases){const h=holds.get(r.data.settlementId);if(!h||!Number.isSafeInteger(r.data.amount)||r.data.amount<1||r.snapshot.holdbackId!==h.settlement_id||r.snapshot.amount!==r.data.amount||r.snapshot.contractId!==map.get(h.settlement_id).data.contractId)invalid();}
 const settlements=items.filter(s=>s.kind==='settlements'&&s.state==='approved'&&approvedPolicies.has(s.data.contractId)).map(s=>{
  const p=approvedPolicies.get(s.data.contractId),h=holds.get(s.id);if(!h)invalid();
  const gross=effectiveSettlement(s),released=releases.filter(r=>r.data.settlementId===s.id).reduce((n,r)=>n+r.effectiveAmount,0),held=gross>0?h.amount:0;
  if(!Number.isSafeInteger(gross)||gross<0||released>held)invalid();
  const payable=gross-held+released,paid=items.filter(r=>r.kind==='costs'&&r.state==='approved'&&r.data.settlementId===s.id).reduce((n,r)=>n+effectiveCost(r),0);
  if(!Number.isSafeInteger(paid)||paid<0||paid>payable)invalid();
  return {settlementId:s.id,contractId:s.data.contractId,measurementId:s.data.measurementId,title:s.data.title,counterparty:map.get(s.data.contractId)?.data.counterparty||'',dueDate:s.data.dueDate,releaseDate:p.data.releaseDate,retentionBps:p.data.retentionBps,gross,originalGross:s.data.amount,originalHeld:h.amount,held,released,retained:held-released,payable,paid,unpaid:payable-paid,voided:gross===0};
 });
 for(const c of completions){const m=map.get(c.measurement_id),p=recordMap.get(c.policy_id);if(!m||m.kind!=='measurements'||m.state!=='approved'||!p||p.kind!=='policy'||p.state!=='approved'||m.data.contractId!==p.data.contractId||c.snapshot.amount!==m.data.amount||!Array.isArray(c.snapshot.lines)||c.snapshot.lines.length!==m.data.lines.length)invalid();for(let i=0;i<c.snapshot.lines.length;i++){const l=c.snapshot.lines[i],source=m.data.lines[i];if(l.taskId!==source.taskId||l.quantity!==source.quantity||l.amount!==source.amount||!l.wbsId||!l.path?.length)invalid();}}
 const totals=Object.fromEntries(['gross','held','released','retained','payable','paid','unpaid'].map(k=>[k,settlements.reduce((n,s)=>n+s[k],0)]));
 return {policies,records,releases,voids,holdbacks,completions:completions.map(c=>({...c,effective:!map.get(c.measurement_id)?.voided})),settlements,totals};
}

export function createEngineeringSubcontracts({store,access,active,mutate,history,getItem,getItems,manager,financial,voided,reversed,effectiveSettlement,effectiveCost,wbs}){
 const db=store.db;
 db.exec(`CREATE TABLE IF NOT EXISTS engineering_subcontract_records(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES engineering_projects(id),kind TEXT NOT NULL CHECK(kind IN ('policy','release','void')),state TEXT NOT NULL CHECK(state IN ('submitted','approved','rejected','cancelled')),version INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),created_by TEXT NOT NULL REFERENCES users(id),creator_name TEXT NOT NULL,created_at TEXT NOT NULL,reviewed_by TEXT REFERENCES users(id),reviewer_name TEXT,review_note TEXT,reviewed_at TEXT);
 CREATE UNIQUE INDEX IF NOT EXISTS engineering_subcontract_policy ON engineering_subcontract_records(project_id,json_extract(data,'$.contractId')) WHERE kind='policy' AND state IN ('submitted','approved');
 CREATE UNIQUE INDEX IF NOT EXISTS engineering_subcontract_void ON engineering_subcontract_records(project_id,json_extract(data,'$.releaseId')) WHERE kind='void' AND state IN ('submitted','approved');
 CREATE TABLE IF NOT EXISTS engineering_subcontract_holdbacks(settlement_id TEXT PRIMARY KEY REFERENCES engineering_items(id),project_id TEXT NOT NULL REFERENCES engineering_projects(id),policy_id TEXT NOT NULL REFERENCES engineering_subcontract_records(id),amount INTEGER NOT NULL,snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS engineering_subcontract_completions(measurement_id TEXT PRIMARY KEY REFERENCES engineering_items(id),project_id TEXT NOT NULL REFERENCES engineering_projects(id),policy_id TEXT NOT NULL REFERENCES engineering_subcontract_records(id),snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),created_at TEXT NOT NULL);`);
 const rows=pid=>db.prepare('SELECT * FROM engineering_subcontract_records WHERE project_id=? ORDER BY created_at,id').all(pid).map(parse);
 const holds=pid=>db.prepare('SELECT * FROM engineering_subcontract_holdbacks WHERE project_id=? ORDER BY created_at,settlement_id').all(pid).map(r=>({...r,snapshot:JSON.parse(r.snapshot)}));
 const completes=pid=>db.prepare('SELECT * FROM engineering_subcontract_completions WHERE project_id=? ORDER BY created_at,measurement_id').all(pid).map(r=>({...r,snapshot:JSON.parse(r.snapshot)}));
 const policy=(pid,cid)=>rows(pid).find(r=>r.kind==='policy'&&r.data.contractId===cid&&['submitted','approved'].includes(r.state));
 const view=(pid,all)=>buildEngineeringSubcontractView({projectId:pid,records:rows(pid),holdbacks:holds(pid),completions:completes(pid),items:(all||getItems(pid)).map(r=>({...r,voided:voided(r.id),reversed:r.kind==='costs'&&reversed('cost',r.id)})),effectiveSettlement:r=>voided(r.id)?0:effectiveSettlement(r),effectiveCost});
 function auth(req,write=true){const c=access(req,write);if(!financial(c.role))fail(403,'没有分包经营数据权限');return c;}
 function record(pid,rid,kind){const r=rows(pid).find(r=>r.id===rid&&r.kind===kind);if(!r)fail(404,'分包申请不存在或不属于本项目');return r;}
 function add(pid,kind,data,snapshot,actor){const rid=randomUUID();db.prepare('INSERT INTO engineering_subcontract_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(rid,pid,kind,'submitted',1,JSON.stringify(data),JSON.stringify(snapshot),actor.id,actor.name,now(),null,null,null,null);return {id:rid,version:1,state:'submitted'};}
 function policySource(pid,data){const c=getItem(pid,data.contractId,'contracts');if(c.state!=='approved'||c.data.direction!=='expense')fail(409,'分包规则须关联已批准且未关闭的支出合同');if(getItems(pid).some(r=>['purchases','measurements','settlements'].includes(r.kind)&&r.data.contractId===c.id&&r.state!=='cancelled'&&!voided(r.id)))fail(409,'已有采购、计量或结算，不能追溯改为分包保留金合同');return {contractId:c.id,contract:{title:c.data.title,counterparty:c.data.counterparty,amount:c.data.amount,version:c.version,createdBy:c.created_by,editedBy:c.edited_by||''}};}
 function completionSource(pid,data){const p=policy(pid,data.contractId);if(!p||p.state!=='approved')fail(409,'分包规则尚未独立批准');const publicWbs=wbs(pid);return {policyId:p.id,amount:data.amount,lines:data.lines.map(l=>{const link=publicWbs.links.find(x=>x.task_id===l.taskId);if(!l.taskId||!link)fail(409,'分包完成量每行须关联明确施工部位的任务');const path=[];let n=publicWbs.nodes.find(n=>n.id===link.node_id);while(n){path.unshift({id:n.id,title:n.data.title,code:n.data.code});n=publicWbs.nodes.find(x=>x.id===n.data.parentId);}return {taskId:l.taskId,wbsId:link.node_id,path,quantity:l.quantity,amount:l.amount,name:l.name,unit:l.unit};})};}
 function validate(pid,kind,data){
  const cid=data.contractId||(data.settlementId?getItem(pid,data.settlementId,'settlements').data.contractId:'');if(!cid)return;const p=policy(pid,cid);if(!p)return;
  if(p.state!=='approved')fail(409,'分包规则待审，请先处理后再办理关联业务');
  if(kind==='purchases')fail(409,'已登记分包的合同不能兼作材料采购合同');
  if(kind==='measurements')completionSource(pid,data);
  if(kind==='settlements'){const m=getItem(pid,data.measurementId,'measurements');if(!data.measurementId||m.state!=='approved'||voided(m.id)||m.data.contractId!==cid||!completes(pid).some(c=>c.measurement_id===m.id))fail(409,'分包结算须关联有效已签认分包完成量');}
  if(kind==='costs'){if(data.direction!=='expense'||data.category!=='subcontract')fail(409,'分包付款须使用支出方向及分包类别');if(rows(pid).some(r=>r.kind==='void'&&r.state==='submitted'&&record(pid,r.data.releaseId,'release').data.settlementId===data.settlementId))fail(409,'保留金释放撤销待审，暂不能新增付款');}
 }
 function approved(pid,row){const p=policy(pid,row.data.contractId);if(!p||p.state!=='approved')return;
  if(row.kind==='measurements'){const snapshot=completionSource(pid,row.data);db.prepare('INSERT INTO engineering_subcontract_completions VALUES(?,?,?,?,?)').run(row.id,pid,p.id,JSON.stringify(snapshot),now());}
  if(row.kind==='settlements'){const held=retention(row.data.amount,p.data.retentionBps),snapshot={settlementAmount:row.data.amount,measurementId:row.data.measurementId,retentionBps:p.data.retentionBps,releaseDate:p.data.releaseDate,contractId:p.data.contractId,createdBy:row.created_by,editedBy:row.edited_by||''};db.prepare('INSERT INTO engineering_subcontract_holdbacks VALUES(?,?,?,?,?,?)').run(row.id,pid,p.id,held,JSON.stringify(snapshot),now());}
 }
 function paymentCheck(pid,row){if(!row.data.settlementId)return;const s=view(pid).settlements.find(s=>s.settlementId===row.data.settlementId);if(s&&s.paid+row.data.amount>s.payable)fail(409,'累计分包付款超过扣除未释放保留金后的可付额度');}
 function releaseSource(pid,data){const s=getItem(pid,data.settlementId,'settlements'),c=getItem(pid,s.data.contractId,'contracts'),h=holds(pid).find(h=>h.settlement_id===s.id);if(s.state!=='approved'||voided(s.id)||!h||c.state!=='approved')fail(409,'保留金须关联未关闭合同的有效已批准分包结算');const p=record(pid,h.policy_id,'policy'),ledger=view(pid).settlements.find(x=>x.settlementId===s.id);if(data.amount>ledger.retained)fail(409,'释放金额超过当前未释放保留金');if(data.effectiveDate<p.data.releaseDate||data.effectiveDate>today())fail(409,'保留金释放须已达到约定日期，且不能登记未来日期');return {holdbackId:s.id,contractId:c.id,policyId:p.id,amount:data.amount,held:h.amount,releaseDate:p.data.releaseDate,settlementAmount:s.data.amount,createdBy:s.created_by,editedBy:s.edited_by||'',policyCreatedBy:p.created_by,policyReviewer:p.reviewed_by};}
 function voidSource(pid,rid){const r=record(pid,rid,'release'),v=view(pid).releases.find(x=>x.id===rid);if(r.state!=='approved'||v.voided)fail(409,'仅有效已批准释放可以申请撤销');const s=view(pid).settlements.find(s=>s.settlementId===r.data.settlementId);if(s.paid>s.payable-r.data.amount)fail(409,'已付款占用了释放额度，请先独立冲销关联付款');return {sourceId:r.id,settlementId:r.data.settlementId,amount:r.data.amount,createdBy:r.created_by,reviewedBy:r.reviewed_by,settlementCreatedBy:r.snapshot.createdBy,settlementEditedBy:r.snapshot.editedBy};}
 function correctionCheck(pid,row){const blockers=[];if(row.kind==='settlements'){const v=view(pid),s=v.settlements.find(s=>s.settlementId===row.id);if(s?.released||rows(pid).some(r=>r.state==='submitted'&&(r.kind==='release'&&r.data.settlementId===row.id||r.kind==='void'&&r.snapshot.settlementId===row.id)))blockers.push({id:row.id,kind:row.kind,reason:'分包结算仍有有效或待审保留金释放，请先撤销释放或撤回申请'});}return {blockers};}
 function close(pid,cid){if(rows(pid).some(r=>r.state==='submitted'&&(r.data.contractId===cid||r.snapshot.contractId===cid||r.kind==='void'&&getItem(pid,r.snapshot.settlementId,'settlements').data.contractId===cid)))fail(409,'合同仍有待审分包或保留金办理');if(view(pid).settlements.some(s=>s.contractId===cid&&s.retained>0))fail(409,'分包合同仍有未释放保留金，不能结清关闭');}
 const pending=pid=>rows(pid).some(r=>r.state==='submitted');
 function mount(app,base,authorize,writer){const route=base+'/projects/:pid';
  app.get(route+'/subcontract-ledger',authorize,(req,res)=>{z.object({}).strict().parse(req.query);res.json(store.transaction(()=>view(auth(req,false).p.id)));});
  app.post(route+'/subcontract-policies',authorize,writer,(req,res)=>{const {p}=auth(req),b=z.object({requestId:id,data:z.object({contractId:id,retentionBps:z.number().int().min(0).max(10000),releaseDate:z.iso.date(),note}).strict()}).strict().parse(req.body);res.status(201).json(mutate(req,p.id+':subcontract:policy',()=>{const {p}=auth(req);active(p);if(policy(p.id,b.data.contractId))fail(409,'合同已有待审或批准分包规则');const source=policySource(p.id,b.data),result=add(p.id,'policy',b.data,source,req.actor);history(req.actor,p.id,result.id,'costs','subcontract_policy_submit',b.data.note);return result;}));});
  app.post(route+'/settlements/:sid/retention-releases',authorize,writer,(req,res)=>{const {p}=auth(req),sid=id.parse(req.params.sid),b=z.object({requestId:id,data:z.object({amount,effectiveDate:z.iso.date(),voucher:z.string().trim().min(1).max(200),note}).strict()}).strict().parse(req.body);res.status(201).json(mutate(req,p.id+':retention:release:'+sid,()=>{const {p}=auth(req);active(p);const data={...b.data,settlementId:sid},source=releaseSource(p.id,data),result=add(p.id,'release',data,source,req.actor);history(req.actor,p.id,result.id,'costs','retention_release_submit',b.data.note);return result;}));});
  app.post(route+'/retention-releases/:rid/voids',authorize,writer,(req,res)=>{const {p}=auth(req),rid=id.parse(req.params.rid),b=z.object({requestId:id,note}).strict().parse(req.body);res.status(201).json(mutate(req,p.id+':retention:void:'+rid,()=>{const {p}=auth(req);active(p);if(rows(p.id).some(r=>r.kind==='void'&&r.data.releaseId===rid&&['submitted','approved'].includes(r.state)))fail(409,'释放已有待审或批准撤销');const result=add(p.id,'void',{releaseId:rid,note:b.note},voidSource(p.id,rid),req.actor);history(req.actor,p.id,result.id,'costs','retention_void_submit',b.note);return result;}));});
  for(const [collection,kind] of [['subcontract-policies','policy'],['retention-releases','release'],['retention-voids','void']])app.post(route+'/'+collection+'/:rid/state',authorize,writer,(req,res)=>{
   const c=auth(req),rid=id.parse(req.params.rid),b=z.object({requestId:id,version,state:z.enum(['approved','rejected','cancelled']),note}).strict().parse(req.body);record(c.p.id,rid,kind);
   if(b.state!=='cancelled'&&!manager(c.role))fail(403,'分包和保留金需独立经理复核');
   res.json(mutate(req,c.p.id+':'+collection+':'+rid+':state',()=>{const {p,role}=auth(req);active(p);const r=record(p.id,rid,kind);if(r.state!=='submitted'||r.version!==b.version)fail(409,'申请已办理或版本变化');if(b.state==='cancelled'){if(r.created_by!==req.actor.id&&!manager(role))fail(403,'仅经办人或经理可撤回');}else {if(!manager(role))fail(403,'当前角色不能复核');const excluded=[r.created_by,r.snapshot.createdBy,r.snapshot.editedBy,r.snapshot.reviewedBy,r.snapshot.policyCreatedBy,r.snapshot.policyReviewer,r.snapshot.settlementCreatedBy,r.snapshot.settlementEditedBy,r.snapshot.contract?.createdBy,r.snapshot.contract?.editedBy];if(excluded.includes(req.actor.id))fail(409,'申请及关联原件经办人不能复核，请独立经理办理');}
    if(b.state==='approved'){const source=kind==='policy'?policySource(p.id,r.data):kind==='release'?releaseSource(p.id,r.data):voidSource(p.id,r.data.releaseId);if(JSON.stringify(source)!==JSON.stringify(r.snapshot))fail(409,'原件依据已变化，请撤回后重新申请');}
    db.prepare('UPDATE engineering_subcontract_records SET state=?,version=version+1,reviewed_by=?,reviewer_name=?,review_note=?,reviewed_at=? WHERE id=?').run(b.state,req.actor.id,req.actor.name,b.note,now(),rid);history(req.actor,p.id,rid,'costs',kind+'_'+b.state,b.note);return {id:rid,state:b.state,version:r.version+1};
   }));
  });
 }
 return {view,mount,validate,approved,paymentCheck,correctionCheck,close,pending};
}
