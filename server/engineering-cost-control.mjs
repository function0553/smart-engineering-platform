import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {fail} from './service.mjs';

const id=z.string().uuid(),optionalId=z.union([id,z.literal('')]).default('');
const text=z.string().trim().min(1).max(200),note=z.string().trim().min(1).max(2000);
const qty=z.number().int().min(1).max(1_000_000_000),price=z.number().int().min(0).max(1_000_000_000_000);
const version=z.number().int().positive(),category=z.enum(['material','labor','equipment','subcontract','other']);
const date=z.iso.date(),today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const now=()=>new Date().toISOString(),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const amount=(q,p)=>{const n=(BigInt(q)*BigInt(p)+500n)/1000n;if(n>1_000_000_000_000n)fail(422,'成本金额超过上限');return Number(n);};
const sum=a=>{const n=a.reduce((n,v)=>n+BigInt(v),0n);if(n>BigInt(Number.MAX_SAFE_INTEGER)||n<0n)fail(422,'成本合计超出安全范围');return Number(n);};
const nodeSchema=z.object({parentId:optionalId,code:text.max(40),title:text,type:z.enum(['section','unit','division','item','area']),note:z.string().trim().max(2000).default('')}).strict();
const planLine=z.object({wbsId:id,taskId:optionalId,category,materialId:optionalId,boqRevisionId:optionalId,boqItemId:optionalId,title:text,unit:text.max(30),quantity:qty,unitPrice:price}).strict();
const planSchema=z.object({title:text,note,lines:z.array(planLine).min(1).max(100)}).strict();
const consumptionSchema=z.object({wbsId:id,taskId:id,stockId:id,quantity:qty,unitPrice:price,effectiveDate:date,voucher:text,note}).strict();
const parse=row=>row?{...row,data:JSON.parse(row.data),snapshot:JSON.parse(row.snapshot)}:null;
const key=line=>line.wbsId+'|'+line.category+'|'+(line.materialId||'')+'|task:'+(line.taskId||'')+(line.category==='material'?'':'|'+line.unit);

/** Static approved cost facts, distinct from progress value and cash payments. */
export function buildEngineeringCostView({projectId,nodes=[],links=[],records=[],items=[],stock=[]}){
  const invalid=()=>fail(422,'施工部位或成本原始快照不一致');
  for(const rows of [nodes,links,records])if(!Array.isArray(rows)||rows.some(r=>r.project_id!==projectId)||new Set(rows.map(r=>r.id||r.task_id)).size!==rows.length)invalid();
  const byId=new Map(records.map(r=>[r.id,r])),itemById=new Map(items.map(r=>[r.id,r])),stockById=new Map(stock.map(r=>[r.id,r]));
  const nodeIds=new Set(nodes.map(n=>n.id));
  for(const n of nodes)if(!nodeSchema.safeParse(n.data).success||n.data.parentId&&!nodeIds.has(n.data.parentId))invalid();
  for(const l of links)if(!nodeIds.has(l.node_id)||itemById.get(l.task_id)?.kind!=='tasks')invalid();
  const voided=new Set();
  for(const r of records){
    if(!['plan','consumption','void'].includes(r.kind)||!['draft','submitted','approved','rejected','cancelled'].includes(r.state)||!r.data||!r.snapshot)invalid();
    if(r.kind==='plan'&&!planSchema.safeParse(r.data).success||r.kind==='consumption'&&!consumptionSchema.safeParse(r.data).success)invalid();
    if(r.kind==='void'){
      const source=byId.get(r.data.consumptionId);
      if(source?.kind!=='consumption'||source.state!=='approved'||!same(source.data,r.snapshot.data)||r.snapshot.sourceId!==source.id)invalid();
      if(r.state==='approved'){if(voided.has(source.id))invalid();voided.add(source.id);}
    }else if(r.kind==='plan'){
      if(!Array.isArray(r.snapshot.lines)||!r.snapshot.lines.length||r.snapshot.total!==sum(r.snapshot.lines.map(l=>l.amount)))invalid();
      if(r.data.lines.length!==r.snapshot.lines.length)invalid();
      for(const [i,l] of r.snapshot.lines.entries())if(Object.keys(r.data.lines[i]).some(k=>!same(r.data.lines[i][k],l[k]))||l.amount!==amount(l.quantity,l.unitPrice)||!nodes.some(n=>n.id===l.wbsId)||l.path?.at(-1)?.id!==l.wbsId)invalid();
    }else{
      const s=stockById.get(r.data.stockId),m=itemById.get(s?.material_id),t=itemById.get(r.data.taskId);
      const baseline=byId.get(r.snapshot.planId);
      if(!baseline?.snapshot.lines?.some(l=>key(l)===r.snapshot.budgetKey&&l.wbsId===r.data.wbsId&&l.materialId===m?.id&&(!l.taskId||l.taskId===r.data.taskId)))invalid();
      if(s?.project_id!==projectId||s.kind!=='issue'||m?.kind!=='materials'||t?.kind!=='tasks'||r.snapshot.amount!==amount(r.data.quantity,r.data.unitPrice)||r.snapshot.stockId!==s.id||r.snapshot.stockActorId!==s.actor_id||r.snapshot.materialId!==m.id||r.snapshot.task?.id!==t.id||r.snapshot.task.wbsId!==r.data.wbsId||r.snapshot.path?.at(-1)?.id!==r.data.wbsId||r.snapshot.path.some(n=>!nodeIds.has(n.id))||byId.get(r.snapshot.planId)?.kind!=='plan'||byId.get(r.snapshot.planId)?.state!=='approved'||!nodes.some(n=>n.id===r.data.wbsId))invalid();
    }
  }
  const approved=records.filter(r=>r.kind==='plan'&&r.state==='approved').sort((a,b)=>b.approved_seq-a.approved_seq);
  if(approved.some(r=>!Number.isSafeInteger(r.approved_seq)||r.approved_seq<1)||new Set(approved.map(r=>r.approved_seq)).size!==approved.length)invalid();
  const current=approved[0]||null,actual=new Map(),used=new Map();
  const consumptions=records.filter(r=>r.kind==='consumption').map(r=>({...r,voided:voided.has(r.id),effectiveQuantity:r.state==='approved'&&!voided.has(r.id)?r.data.quantity:0,effectiveAmount:r.state==='approved'&&!voided.has(r.id)?r.snapshot.amount:0}));
  for(const r of consumptions.filter(r=>r.effectiveQuantity)){
    const s=stockById.get(r.data.stockId);if(s.reversed)invalid();
    const k=r.snapshot.budgetKey,a=actual.get(k)||{quantity:0,amount:0};
    a.quantity=sum([a.quantity,r.effectiveQuantity]);a.amount=sum([a.amount,r.effectiveAmount]);actual.set(k,a);used.set(s.id,sum([used.get(s.id)||0,r.effectiveQuantity]));
  }
  for(const [sid,q] of used){const s=stockById.get(sid),returned=sum(stock.filter(x=>x.kind==='return'&&x.reference_id===sid&&!x.reversed).map(x=>x.quantity));if(q+returned>s.quantity)invalid();}
  const groups=new Map();
  for(const l of current?.snapshot.lines||[]){const k=key(l),a=groups.get(k)||{key:k,wbsId:l.wbsId,taskId:l.taskId,path:l.path,title:l.title,category:l.category,materialId:l.materialId,unit:l.unit,targetQuantity:0,targetAmount:0};a.targetQuantity=sum([a.targetQuantity,l.quantity]);a.targetAmount=sum([a.targetAmount,l.amount]);groups.set(k,a);}
  const comparison=Array.from(groups.values()).map(a=>{const v=actual.get(a.key)||{quantity:0,amount:0};return {...a,actualQuantity:a.category==='material'?v.quantity:null,actualAmount:a.category==='material'?v.amount:null,quantityVariance:a.category==='material'?a.targetQuantity-v.quantity:null,amountVariance:a.category==='material'?a.targetAmount-v.amount:null};});
  const receipts=stock.filter(s=>s.kind==='issue'&&!s.reversed).map(s=>{const returned=sum(stock.filter(x=>x.kind==='return'&&x.reference_id===s.id&&!x.reversed).map(x=>x.quantity)),consumed=used.get(s.id)||0,m=itemById.get(s.material_id);return {stockId:s.id,materialId:s.material_id,materialTitle:m?.data.title,unit:m?.data.unit,quantity:s.quantity,returnedQuantity:returned,consumedQuantity:consumed,availableQuantity:s.quantity-returned-consumed,actorId:s.actor_id,createdAt:s.created_at};});
  return {projectId,currentPlanId:current?.id||null,currentPlan:current,plans:records.filter(r=>r.kind==='plan'),consumptions,voids:records.filter(r=>r.kind==='void'),records,comparison,issueSources:receipts,materialActualAmount:sum(consumptions.map(r=>r.effectiveAmount)),coverage:'仅已独立确认的材料耗用；人工、机械、分包及费用实际成本尚未接入。现金付款和采购入库不计入此实际成本。'};
}

export function createEngineeringCostControl({store,access,active,mutate,history,getItems,getItem,financial,manager,reversed,boq}){
  const db=store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS engineering_wbs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES engineering_projects(id),code TEXT NOT NULL COLLATE NOCASE,data TEXT NOT NULL CHECK(json_valid(data)),version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,code));
    CREATE TABLE IF NOT EXISTS engineering_task_wbs(project_id TEXT NOT NULL REFERENCES engineering_projects(id),task_id TEXT NOT NULL REFERENCES engineering_items(id),node_id TEXT NOT NULL REFERENCES engineering_wbs(id),version INTEGER NOT NULL,note TEXT NOT NULL,actor_id TEXT NOT NULL REFERENCES users(id),updated_at TEXT NOT NULL,PRIMARY KEY(project_id,task_id));
    CREATE TABLE IF NOT EXISTS engineering_cost_records(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES engineering_projects(id),kind TEXT NOT NULL CHECK(kind IN ('plan','consumption','void')),state TEXT NOT NULL CHECK(state IN ('draft','submitted','approved','rejected','cancelled')),version INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),created_by TEXT NOT NULL REFERENCES users(id),edited_by TEXT REFERENCES users(id),creator_name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,reviewed_by TEXT REFERENCES users(id),reviewer_name TEXT,review_note TEXT,reviewed_at TEXT,approved_seq INTEGER);
    CREATE UNIQUE INDEX IF NOT EXISTS engineering_cost_plan_seq ON engineering_cost_records(project_id,approved_seq) WHERE kind='plan' AND approved_seq IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS engineering_cost_plan_pending ON engineering_cost_records(project_id) WHERE kind='plan' AND state IN ('draft','submitted');`);
  const nodes=pid=>db.prepare('SELECT * FROM engineering_wbs WHERE project_id=? ORDER BY code,id').all(pid).map(r=>({...r,data:JSON.parse(r.data)}));
  const links=pid=>db.prepare('SELECT * FROM engineering_task_wbs WHERE project_id=? ORDER BY task_id').all(pid);
  const rows=pid=>db.prepare('SELECT * FROM engineering_cost_records WHERE project_id=? ORDER BY created_at DESC,id DESC').all(pid).map(parse);
  const stock=pid=>db.prepare('SELECT * FROM engineering_stock WHERE project_id=? ORDER BY created_at,id').all(pid).map(s=>({...s,reversed:reversed('stock',s.id)}));
  const view=(pid,all)=>buildEngineeringCostView({projectId:pid,nodes:nodes(pid),links:links(pid),records:rows(pid),items:all||getItems(pid),stock:stock(pid)});
  const publicView=pid=>({nodes:nodes(pid),links:links(pid)});
  const getNode=(pid,nid)=>{const n=nodes(pid).find(n=>n.id===nid);if(!n)fail(400,'施工部位不存在或不属于本项目');return n;};
  const record=(pid,rid,kind)=>{const r=rows(pid).find(r=>r.id===rid);if(!r||kind&&r.kind!==kind)fail(404,'成本办理不存在或不属于本项目');return r;};
  const pending=pid=>rows(pid).some(r=>['draft','submitted'].includes(r.state));
  const financialAccess=(req,write=true)=>{const c=access(req,write);if(!financial(c.role))fail(403,'没有目标成本及材料耗用金额权限');return c;};
  function path(pid,nid,all=nodes(pid)){
    const result=[],seen=new Set();let next=nid;
    while(next){const n=all.find(n=>n.id===next);if(!n||seen.has(n.id))fail(400,'施工部位层级缺失或存在循环');seen.add(n.id);result.unshift({id:n.id,...n.data});next=n.data.parentId;if(result.length>5)fail(400,'施工部位最多五层');}return result;
  }
  const frozenNode=(pid,nid)=>rows(pid).some(r=>['draft','submitted','approved'].includes(r.state)&&(r.snapshot.lines||[r.snapshot]).some(l=>(l.path||[]).some(n=>n.id===nid)));
  function taskSource(pid,tid,nid){const t=getItem(pid,tid,'tasks'),l=links(pid).find(l=>l.task_id===tid);if(t.state==='cancelled'||l?.node_id!==nid)fail(409,'任务须有效且明确归属此施工部位');return {id:t.id,title:t.data.title,location:t.data.location,wbsId:nid,linkVersion:l.version};}
  function lineSource(pid,l){
    const p=path(pid,l.wbsId),task=l.taskId?taskSource(pid,l.taskId,l.wbsId):null;
    let material=null,sourceBoq=null;
    if(l.category==='material'){const m=getItem(pid,l.materialId,'materials');if(l.unit!==m.data.unit)fail(400,'材料预算单位须与材料主档一致');material={id:m.id,...m.data};}else if(l.materialId)fail(400,'仅材料预算接受材料关联');
    if(!!l.boqRevisionId!==!!l.boqItemId)fail(400,'工程清单版本与条目须同时提供');
    if(l.boqRevisionId){const b=boq.projectView(pid),r=b.revisions.find(r=>r.id===l.boqRevisionId&&r.state==='approved'&&!r.voided),item=r?.lines.find(x=>x.id===l.boqItemId);if(!r||!item||!b.contracts.some(c=>c.currentRevisionId===r.id))fail(409,'须关联当前有效已批准工程清单条目');sourceBoq={revisionId:r.id,contractId:r.contract_id,item};}
    return {...l,path:p,task,material,sourceBoq,amount:amount(l.quantity,l.unitPrice)};
  }
  function preparePlan(p,data,basePlanId){const current=view(p.id);if(basePlanId!==current.currentPlanId)fail(409,'目标成本基线已更新，请取消旧草稿并重新编制');const lines=data.lines.map(l=>lineSource(p.id,l)),total=sum(lines.map(l=>l.amount));if(total>p.data.budget)fail(409,'目标成本总额超过项目核定预算，请先核定项目预算');return {basePlanId,projectBudget:p.data.budget,lines,total};}
  function currentLimits(pid,snapshot){
    const v=view(pid),groups=new Map();for(const l of snapshot.lines){const k=key(l),a=groups.get(k)||{quantity:0,amount:0};a.quantity=sum([a.quantity,l.quantity]);a.amount=sum([a.amount,l.amount]);groups.set(k,a);}
    for(const r of v.consumptions.filter(r=>r.effectiveQuantity)){const a=groups.get(r.snapshot.budgetKey);if(!a)fail(409,'目标成本新版本不能遗漏仍有效的材料耗用归属');}
    for(const a of v.comparison){const target=groups.get(a.key);if(a.category==='material'&&target&&(target.quantity<a.actualQuantity||target.amount<a.actualAmount))fail(409,'目标成本新版本不能低于已确认材料耗用数量或金额');}
  }
  function consumptionSource(pid,data){
    const v=view(pid),source=v.issueSources.find(s=>s.stockId===data.stockId);if(!source||source.availableQuantity<data.quantity)fail(409,'原领料已冲销、退料或剩余可确认数量不足');
    if(db.prepare("SELECT 1 FROM engineering_reversals WHERE project_id=? AND target_type='stock' AND target_id=? AND state='submitted'").get(pid,data.stockId))fail(409,'原领料正在申请冲销，请先处理');
    const task=taskSource(pid,data.taskId,data.wbsId),p=path(pid,data.wbsId),m=getItem(pid,source.materialId,'materials');
    const candidates=v.comparison.filter(a=>a.wbsId===data.wbsId&&a.category==='material'&&a.materialId===m.id),budget=candidates.find(a=>a.taskId===data.taskId)||candidates.find(a=>!a.taskId);
    if(!v.currentPlanId||!budget)fail(409,'须先批准此施工部位、任务及材料的目标成本，不能借用其他任务预算');
    if(data.effectiveDate>today()||data.effectiveDate<new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(source.createdAt)))fail(400,'确认耗用日期不得早于原领料或晚于今天');
    return {planId:v.currentPlanId,budgetKey:budget.key,path:p,task,stockId:source.stockId,stockActorId:source.actorId,issuedQuantity:source.quantity,materialId:m.id,material:{...m.data},amount:amount(data.quantity,data.unitPrice),valuation:'manual-confirmed',valuationNote:'单价由经办人按凭据确认并独立复核，不从付款或库存数量猜算'};
  }
  const update=(row,state,actor,details,seq=null)=>{db.prepare('UPDATE engineering_cost_records SET state=?,version=version+1,reviewed_by=?,reviewer_name=?,review_note=?,reviewed_at=?,updated_at=?,approved_seq=COALESCE(?,approved_seq) WHERE id=?').run(state,actor.id,actor.name,details,now(),now(),seq,row.id);};
  const checkVersion=(row,v)=>{if(row.version!==v)fail(409,'办理版本已变化，输入保留，请刷新核对');};
  const add=(pid,kind,state,data,snapshot,actor)=>{const rid=randomUUID(),at=now();db.prepare("INSERT INTO engineering_cost_records(id,project_id,kind,state,version,data,snapshot,created_by,creator_name,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?,?,?,?)").run(rid,pid,kind,state,JSON.stringify(data),JSON.stringify(snapshot),actor.id,actor.name,at,at);return {id:rid,state,version:1};};
  function stockCheck(pid,row){if(row.kind==='issue'&&rows(pid).some(r=>r.kind==='consumption'&&r.data.stockId===row.id&&(r.state==='submitted'||r.state==='approved'&&!view(pid).consumptions.find(c=>c.id===r.id).voided)))fail(409,'原领料有待审或有效耗用确认，请先撤回或独立撤销耗用');}
  function returnCheck(pid,sid,q){const v=view(pid),s=v.issueSources.find(s=>s.stockId===sid);if(!s||q>s.availableQuantity)fail(409,'退料不能超过尚未确认耗用的领料余量');}
  function taskCheck(pid,tid){if(rows(pid).some(r=>['draft','submitted'].includes(r.state)&&(r.data.taskId===tid||r.data.lines?.some(l=>l.taskId===tid))))fail(409,'任务有待审目标成本或耗用确认，请先处理');}
  function projectCheck(pid,budget){const current=view(pid).currentPlan;if(current&&current.snapshot.total>budget)fail(409,'项目预算不能低于当前已批准目标成本');}
  function materialCheck(pid,mid,data){if(rows(pid).some(r=>r.kind==='plan'&&['draft','submitted','approved'].includes(r.state)&&r.snapshot.lines.some(l=>l.materialId===mid&&l.unit!==data.unit)))fail(409,'材料单位已进入目标成本原件，不能改写');}
  function mount(app,base,authorize,writer){
    const route=base+'/projects/:pid';
    app.get(route+'/wbs',authorize,(req,res)=>{z.object({}).strict().parse(req.query);const {p}=access(req);res.json(publicView(p.id));});
    app.get(route+'/cost-control',authorize,(req,res)=>{z.object({}).strict().parse(req.query);res.json(store.transaction(()=>{const {p}=financialAccess(req,false);return view(p.id);}));});
    app.post(route+'/wbs/project-scope',authorize,writer,(req,res)=>{
      z.object({requestId:id}).strict().parse(req.body);
      const {p,role}=access(req,true);if(!manager(role))fail(403,'请项目经理设置项目整体归档部位');active(p);
      res.json(mutate(req,p.id+':wbs:project-scope',()=>{
        const current=access(req,true);if(!manager(current.role))fail(403,'当前角色不能维护施工部位');active(current.p);
        const all=nodes(current.p.id),existing=all.find(n=>n.data.code==='PROJECT-ALL'&&n.data.title==='项目整体（未细分部位）'&&!n.data.parentId);
        if(existing)return {id:existing.id,version:existing.version,created:false};
        if(all.length)fail(409,'本项目已建立施工部位，请刷新后选择实际部位');
        const data=nodeSchema.parse({parentId:'',code:'PROJECT-ALL',title:'项目整体（未细分部位）',type:'area',note:'按用户明确选择，以项目整体整理资料，尚未细分实际施工部位。'}),nid=randomUUID(),at=now();
        db.prepare('INSERT INTO engineering_wbs VALUES(?,?,?,?,1,?,?)').run(nid,current.p.id,data.code,JSON.stringify(data),at,at);
        history(req.actor,current.p.id,nid,'tasks','wbs_create','用户选择按项目整体整理施工资料（未细分实际部位）');return {id:nid,version:1,created:true};
      }));
    });
    app.post(route+'/wbs',authorize,writer,(req,res)=>{const b=z.object({requestId:id,data:nodeSchema}).strict().parse(req.body);const c=access(req,true);if(!manager(c.role))fail(403,'施工部位由项目经理维护');res.status(201).json(mutate(req,c.p.id+':wbs:create',()=>{const {p,role}=access(req,true);active(p);if(!manager(role))fail(403,'当前角色不能维护施工部位');if(nodes(p.id).length>=2000)fail(413,'单项目施工部位超过2000项');if(db.prepare('SELECT 1 FROM engineering_wbs WHERE project_id=? AND code=? COLLATE NOCASE').get(p.id,b.data.code))fail(409,'施工部位编号已存在');if(b.data.parentId&&path(p.id,b.data.parentId).length>=5)fail(400,'施工部位最多五层');const nid=randomUUID(),at=now();db.prepare('INSERT INTO engineering_wbs VALUES(?,?,?,?,1,?,?)').run(nid,p.id,b.data.code,JSON.stringify(b.data),at,at);history(req.actor,p.id,nid,'tasks','wbs_create','新建施工部位：'+b.data.title);return {id:nid,version:1};}));});
    app.put(route+'/wbs/:nid',authorize,writer,(req,res)=>{const b=z.object({requestId:id,version,data:nodeSchema}).strict().parse(req.body),nid=id.parse(req.params.nid),c=access(req,true);if(!manager(c.role))fail(403,'施工部位由项目经理维护');res.json(mutate(req,c.p.id+':wbs:update:'+nid,()=>{const {p,role}=access(req,true);active(p);if(!manager(role))fail(403,'当前角色不能维护施工部位');const n=getNode(p.id,nid);checkVersion(n,b.version);if(frozenNode(p.id,nid))fail(409,'施工部位已进入成本原件，不可改写；请建立新的施工部位');if(db.prepare('SELECT 1 FROM engineering_wbs WHERE project_id=? AND code=? COLLATE NOCASE AND id<>?').get(p.id,b.data.code,nid))fail(409,'施工部位编号已存在');const proposed=nodes(p.id).map(r=>r.id===nid?{...r,data:b.data}:r);for(const node of proposed)path(p.id,node.id,proposed);db.prepare('UPDATE engineering_wbs SET code=?,data=?,version=version+1,updated_at=? WHERE id=?').run(b.data.code,JSON.stringify(b.data),now(),nid);history(req.actor,p.id,nid,'tasks','wbs_update','修改施工部位：'+b.data.title);return {id:nid,version:n.version+1};}));});
    app.put(route+'/wbs/tasks/:tid',authorize,writer,(req,res)=>{const b=z.object({requestId:id,version:z.number().int().min(0),nodeId:id,note}).strict().parse(req.body),tid=id.parse(req.params.tid),c=access(req,true);if(!manager(c.role))fail(403,'任务归属由项目经理维护');res.json(mutate(req,c.p.id+':wbs:task:'+tid,()=>{const {p,role}=access(req,true);active(p);if(!manager(role))fail(403,'当前角色不能维护任务归属');const t=getItem(p.id,tid,'tasks');if(t.state==='cancelled')fail(409,'已取消任务不能归属');getNode(p.id,b.nodeId);const old=links(p.id).find(l=>l.task_id===tid);if((old?.version||0)!==b.version)fail(409,'任务归属版本已更新');if(rows(p.id).some(r=>['draft','submitted','approved'].includes(r.state)&&(r.data.taskId===tid||r.data.lines?.some(l=>l.taskId===tid))))fail(409,'任务已进入成本原件，不可移动归属');db.prepare('INSERT INTO engineering_task_wbs VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,task_id) DO UPDATE SET node_id=excluded.node_id,version=excluded.version,note=excluded.note,actor_id=excluded.actor_id,updated_at=excluded.updated_at').run(p.id,tid,b.nodeId,b.version+1,b.note,req.actor.id,now());history(req.actor,p.id,tid,'tasks','wbs_task','明确任务施工部位：'+b.note);return {id:tid,version:b.version+1};}));});
    app.post(route+'/cost-plans',authorize,writer,(req,res)=>{const b=z.object({requestId:id,data:planSchema}).strict().parse(req.body),c=financialAccess(req);res.status(201).json(mutate(req,c.p.id+':cost-plan:create',()=>{const {p}=financialAccess(req);active(p);if(rows(p.id).some(r=>r.kind==='plan'&&['draft','submitted'].includes(r.state)))fail(409,'已有待办目标成本，请先编辑或处理');const snapshot=preparePlan(p,b.data,view(p.id).currentPlanId),result=add(p.id,'plan','draft',b.data,snapshot,req.actor);history(req.actor,p.id,result.id,'costs','cost_plan_create','创建目标成本：'+b.data.title);return result;}));});
    app.put(route+'/cost-plans/:rid',authorize,writer,(req,res)=>{const b=z.object({requestId:id,version,data:planSchema}).strict().parse(req.body),rid=id.parse(req.params.rid),c=financialAccess(req);res.json(mutate(req,c.p.id+':cost-plan:edit:'+rid,()=>{const {p}=financialAccess(req);active(p);const r=record(p.id,rid,'plan');checkVersion(r,b.version);if(r.state!=='draft')fail(409,'仅草稿可编辑');const snapshot=preparePlan(p,b.data,r.snapshot.basePlanId);db.prepare('UPDATE engineering_cost_records SET data=?,snapshot=?,version=version+1,edited_by=?,updated_at=? WHERE id=?').run(JSON.stringify(b.data),JSON.stringify(snapshot),req.actor.id,now(),rid);history(req.actor,p.id,rid,'costs','cost_plan_edit','修改目标成本：'+b.data.title);return {id:rid,version:r.version+1};}));});
    app.post(route+'/consumptions',authorize,writer,(req,res)=>{const b=z.object({requestId:id,data:consumptionSchema}).strict().parse(req.body),c=financialAccess(req);res.status(201).json(mutate(req,c.p.id+':consumption:create',()=>{const {p}=financialAccess(req);active(p);const snapshot=consumptionSource(p.id,b.data),result=add(p.id,'consumption','submitted',b.data,snapshot,req.actor);history(req.actor,p.id,result.id,'costs','consumption_submit','申请材料耗用确认：'+b.data.note);return result;}));});
    app.post(route+'/consumptions/:rid/voids',authorize,writer,(req,res)=>{const b=z.object({requestId:id,note}).strict().parse(req.body),rid=id.parse(req.params.rid),c=financialAccess(req);res.status(201).json(mutate(req,c.p.id+':consumption:void:'+rid,()=>{const {p}=financialAccess(req);active(p);const r=record(p.id,rid,'consumption'),v=view(p.id).consumptions.find(x=>x.id===rid);if(r.state!=='approved'||v.voided||rows(p.id).some(x=>x.kind==='void'&&x.data.consumptionId===rid&&x.state==='submitted'))fail(409,'仅有效耗用可申请一次独立撤销');const result=add(p.id,'void','submitted',{consumptionId:rid,note:b.note},{sourceId:rid,data:r.data,amount:r.snapshot.amount,createdBy:r.created_by,stockActorId:r.snapshot.stockActorId},req.actor);history(req.actor,p.id,result.id,'costs','consumption_void_submit',b.note);return result;}));});
    for(const [collection,kind] of [['cost-plans','plan'],['consumptions','consumption'],['consumption-voids','void']])app.post(route+'/'+collection+'/:rid/state',authorize,writer,(req,res)=>{
      const b=z.object({requestId:id,version,state:z.enum(['submitted','approved','rejected','cancelled']),note,overrunReason:z.string().trim().max(2000).default('')}).strict().parse(req.body),rid=id.parse(req.params.rid),c=financialAccess(req);
      res.json(mutate(req,c.p.id+':cost:'+rid+':state',()=>{
        const {p,role}=financialAccess(req);active(p);const r=record(p.id,rid,kind);checkVersion(r,b.version);
        if(!((r.state==='draft'&&kind==='plan'&&['submitted','cancelled'].includes(b.state))||(r.state==='submitted'&&['approved','rejected','cancelled'].includes(b.state))))fail(409,'不允许此成本办理状态变化');
          if(['approved','rejected'].includes(b.state)){if(!manager(role))fail(403,'独立审批需要项目经理');const excluded=[r.created_by,r.edited_by,r.kind==='plan'?r.reviewed_by:null,r.snapshot.stockActorId,r.snapshot.createdBy];if(excluded.includes(req.actor.id))fail(409,'申请人、末编辑人、提交人及原领料经办人须回避复核');}
        if(b.state==='cancelled'&&!manager(role)&&r.created_by!==req.actor.id)fail(403,'仅申请人或经理可以撤回');
        if(kind==='plan'&&['submitted','approved'].includes(b.state)){const fresh=preparePlan(p,r.data,r.snapshot.basePlanId);if(!same(fresh,r.snapshot))fail(409,'目标成本依据已变化，请先编辑草稿或取消重编');currentLimits(p.id,r.snapshot);}
        if(kind==='consumption'&&b.state==='approved'){
          const fresh=consumptionSource(p.id,r.data);if(!same(fresh,r.snapshot))fail(409,'耗用来源或目标成本基线已变化，请撤回重新登记');const v=view(p.id),a=v.comparison.find(a=>a.key===r.snapshot.budgetKey);
          const priceWeight=v.currentPlan.snapshot.lines.filter(l=>key(l)===a.key).reduce((n,l)=>n+BigInt(l.quantity)*BigInt(l.unitPrice),0n);
          if((a.actualQuantity+r.data.quantity>a.targetQuantity||a.actualAmount+r.snapshot.amount>a.targetAmount||BigInt(r.data.unitPrice)*BigInt(a.targetQuantity)>priceWeight)&&!b.overrunReason)fail(409,'确认耗用将超目标数量、单价或金额，请独立经理填写超预算确认原因');
        }
        if(kind==='void'&&b.state==='approved'){const source=view(p.id).consumptions.find(c=>c.id===r.data.consumptionId);if(!source||source.voided)fail(409,'原耗用已撤销');}
        const seq=kind==='plan'&&b.state==='approved'?Number(db.prepare("SELECT COALESCE(MAX(approved_seq),0)+1 n FROM engineering_cost_records WHERE project_id=? AND kind='plan'").get(p.id).n):null;
        update(r,b.state,req.actor,b.note+(b.overrunReason?'；超预算确认：'+b.overrunReason:''),seq);history(req.actor,p.id,rid,'costs','cost_'+kind+'_'+b.state,b.note);return {id:rid,state:b.state,version:r.version+1};
      }));
    });
  }
  return {mount,view,publicView,pending,stockCheck,returnCheck,taskCheck,projectCheck,materialCheck};
}
