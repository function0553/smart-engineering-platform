import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/app.mjs';
import {buildEngineeringCostView} from '../server/engineering-cost-control.mjs';
import {buildEngineeringWorkbook} from '../server/engineering-export.mjs';
import {unzipSync,strFromU8} from 'fflate';
import {DOMParser} from '@xmldom/xmldom';

const ok=(r,status=200)=>assert.equal(r.status,status,JSON.stringify(r.body));
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'engineering-cost-')),password=randomBytes(24).toString('hex');let app,server,url;
 async function start(){server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+server.address().port;app=createApp({database:join(dir,'fixture.sqlite'),baseUrl:url,distPath:'__none__',filesDir:join(dir,'files'),updateDir:join(dir,'updates')});server.on('request',app.app);}
 async function stop(){app.vision.close();server.closeAllConnections();await new Promise(r=>server.close(r));app.store.close();}
 await start();t.after(async()=>{await stop();assert.ok(dir.startsWith(tmpdir()));rmSync(dir,{recursive:true,force:true});});
 const call=async(path,body,cookie='',method=body===undefined?'GET':'POST',headers={})=>{const r=await fetch(url+'/api'+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json','X-Workspace-Request':'1',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const setup=await call('/setup',{organization:'隔离成本验证',username:'qa-admin',name:'管理员',password});ok(setup,201);const admin=setup.cookie,users={};
 for(const n of ['reviewer','reviewer2','finance','engineer','viewer']){ok(await call('/users',{username:'qa-'+n,name:n,role:n==='viewer'?'viewer':'operator',password},admin),201);const l=await call('/login',{username:'qa-'+n,password});ok(l);users[n]={cookie:l.cookie};}
 const all=(await call('/users',undefined,admin)).body;for(const n in users)users[n].id=all.find(u=>u.username==='qa-'+n).id;
 const projectData={code:randomUUID(),name:'成本隔离项目',address:'合成场所',owner:'经理',startDate:'2026-10-01',dueDate:'2026-12-31',budget:20000,note:'合成项目'},p=await call('/engineering/projects',{requestId:randomUUID(),data:projectData},admin);ok(p,201);const pid=p.body.id,base='/engineering/projects/'+pid;
 const post=(path,body,cookie=admin,method='POST')=>call(base+path,{requestId:randomUUID(),...body},cookie,method);
 ok(await post('/state',{version:1,state:'active',note:'开工'}));for(const [n,role] of [['reviewer','manager'],['reviewer2','manager'],['finance','finance'],['engineer','engineer'],['viewer','manager']])ok(await post('/members',{userId:users[n].id,role},admin,'PUT'));
 const detail=async(cookie=admin)=>{const r=await call(base,undefined,cookie);ok(r);return r.body;};
 const item=async(kind,data,cookie=admin)=>{const r=await post('/items/'+kind,{data},cookie);ok(r,201);return (await detail()).items.find(x=>x.id===r.body.id);};
 const node=async(data={})=>{const r=await post('/wbs',{data:{parentId:'',code:randomUUID().slice(0,8),title:'施工部位',type:'area',note:'',...data}});ok(r,201);return r.body;};
 const row=async rid=>(await detail()).costControl.records.find(r=>r.id===rid);
 const state=async(kind,rid,target,cookie=users.reviewer.cookie,extra={})=>post('/'+kind+'/'+rid+'/state',{version:(await row(rid)).version,state:target,note:'独立办理说明',...extra},cookie);
 const make=async({targetQuantity=10000,targetPrice=1000,issued=10000}={})=>{
  const n=await node(),task=await item('tasks',{title:'管网铺设',location:'K0+100',owner:'现场班组',startDate:'2026-10-01',dueDate:'2026-12-31',predecessorId:'',progress:0,note:''},users.engineer.cookie),material=await item('materials',{title:'钢管',code:randomUUID(),specification:'DN300',unit:'米',warehouse:'现场仓',note:''},users.engineer.cookie);
  ok(await post('/wbs/tasks/'+task.id,{version:0,nodeId:n.id,note:'明确施工归属'},admin,'PUT'));
  ok(await post('/stock',{materialId:material.id,kind:'opening',quantity:issued,note:'合成期初'}),201);const issue=await post('/stock',{materialId:material.id,kind:'issue',quantity:issued,note:'合成领料'},users.engineer.cookie);ok(issue,201);
  const line={wbsId:n.id,taskId:task.id,category:'material',materialId:material.id,boqRevisionId:'',boqItemId:'',title:'钢管目标成本',unit:'米',quantity:targetQuantity,unitPrice:targetPrice},data={title:'人材机目标成本',note:'预算依据',lines:[line]},plan=await post('/cost-plans',{data},users.finance.cookie);ok(plan,201);ok(await state('cost-plans',plan.body.id,'submitted',users.finance.cookie));ok(await state('cost-plans',plan.body.id,'approved'));
  return {node:n,task,material,issue:issue.body,plan:plan.body,line};
 };
 const consume=(b,extra={},cookie=users.finance.cookie)=>post('/consumptions',{data:{wbsId:b.node.id,taskId:b.task.id,stockId:b.issue.id,quantity:4000,unitPrice:1000,effectiveDate:today(),voucher:'VALUE-'+randomUUID(),note:'实际耗用确认凭据',...extra}},cookie);
 const returnStock=(b,quantity)=>post('/stock',{materialId:b.material.id,kind:'return',referenceId:b.issue.id,quantity,note:'未耗用材料退回'},users.engineer.cookie);
 const reverse=(b)=>post('/reversals',{targetType:'stock',targetId:b.issue.id,note:'领料错误冲销'});
 const dbState=()=>Object.fromEntries(app.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'engineering_%' OR name='audit') ORDER BY name").all().map(({name})=>[name,app.store.db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]));
 return {call,post,admin,users,password,pid,base,projectData,detail,item,node,row,state,make,consume,returnStock,reverse,dbState,get store(){return app.store;},restart:async()=>{await stop();await start();}};
}

test('WBS node identity and five-level acyclic hierarchy preserve existing task text and reject foreign parents',async t=>{
 const f=await fixture(t),a=await f.node({code:'SEG-A',title:'一标段',type:'section'});let last=a;
 for(let i=0;i<4;i++)last=await f.node({parentId:last.id});const before=f.dbState();ok(await f.post('/wbs',{data:{parentId:last.id,code:'six',title:'第六层',type:'area',note:''}}),400);assert.deepEqual(f.dbState(),before);
 ok(await f.post('/wbs/'+a.id,{version:1,data:{parentId:last.id,code:'SEG-A',title:'循环',type:'area',note:''}},f.admin,'PUT'),400);assert.deepEqual(f.dbState(),before);
 ok(await f.post('/wbs',{data:{parentId:randomUUID(),code:'foreign',title:'外项目',type:'area',note:''}}),400);ok(await f.post('/wbs',{data:{parentId:'',code:'seg-a',title:'重复',type:'area',note:''}}),409);
});

test('target cost and actual consumption are independent of cash progress and inventory movement',async t=>{
 const f=await fixture(t),b=await f.make(),before=await f.detail(),r=await f.consume(b);ok(r,201);assert.equal((await f.detail()).costControl.materialActualAmount,0);ok(await f.state('consumptions',r.body.id,'approved'));
 const d=await f.detail();assert.equal(d.costControl.materialActualAmount,4000);assert.equal(d.costControl.comparison[0].actualQuantity,4000);assert.equal(d.costControl.comparison[0].amountVariance,6000);assert.equal(d.finance.expense,before.finance.expense);assert.deepEqual(d.balances,before.balances);assert.equal(d.items.find(x=>x.id===b.task.id).data.progress,0);assert.equal(d.costControl.currentPlan.snapshot.total,10000);
});

test('cost plans keep approved version history and cannot omit or undercut current confirmed resource consumption',async t=>{
 const f=await fixture(t),b=await f.make(),r=await f.consume(b);ok(r,201);ok(await f.state('consumptions',r.body.id,'approved'));
 const p=await f.post('/cost-plans',{data:{title:'第二版目标',note:'调整',lines:[{...b.line,quantity:3000}]}},f.users.finance.cookie);ok(p,201);ok(await f.state('cost-plans',p.body.id,'submitted',f.users.finance.cookie),409);ok(await f.state('cost-plans',p.body.id,'cancelled',f.users.finance.cookie));
 const next=await f.post('/cost-plans',{data:{title:'第二版目标',note:'调整',lines:[{...b.line,quantity:6000}]}},f.users.finance.cookie);ok(next,201);ok(await f.state('cost-plans',next.body.id,'submitted',f.users.finance.cookie));ok(await f.state('cost-plans',next.body.id,'approved'));const d=await f.detail();assert.equal(d.costControl.plans.length,3);assert.equal(d.costControl.currentPlanId,next.body.id);assert.equal(d.costControl.plans.find(p=>p.id===b.plan.id).snapshot.total,10000);
});

test('cost plan ceiling unit identity source references and derived amount cannot be forged',async t=>{
 const f=await fixture(t),b=await f.make();const before=f.dbState();
 for(const line of [{...b.line,quantity:30000},{...b.line,unit:'吨'},{...b.line,materialId:randomUUID()},{...b.line,boqRevisionId:randomUUID()},{...b.line,amount:1}]){const r=await f.post('/cost-plans',{data:{title:'错误方案',note:'错误依据',lines:[line]}},f.users.finance.cookie);assert.ok([400,409].includes(r.status));assert.deepEqual(f.dbState(),before);}
 ok(await f.post('',{version:2,data:{...f.projectData,budget:9999}},f.admin,'PUT'),409);assert.deepEqual(f.dbState(),before);
});

test('submitted source drift requires cancellation rather than silently approving a different frozen task',async t=>{
 const f=await fixture(t),b=await f.make(),p=await f.post('/cost-plans',{data:{title:'新方案',note:'调整',lines:[b.line]}},f.users.finance.cookie);ok(p,201);ok(await f.state('cost-plans',p.body.id,'submitted',f.users.finance.cookie));
 const task=(await f.detail()).items.find(t=>t.id===b.task.id);ok(await f.post('/items/'+task.id,{version:task.version,data:{...task.data,title:'任务名称已调整'}},f.users.engineer.cookie,'PUT'));const before=f.dbState();ok(await f.state('cost-plans',p.body.id,'approved'),409);assert.deepEqual(f.dbState(),before);ok(await f.state('cost-plans',p.body.id,'cancelled',f.users.finance.cookie));
});

test('confirmed source quantity cannot be pooled across issues and pending consumption rechecks returns at approval',async t=>{
 const f=await fixture(t),b=await f.make(),r=await f.consume(b,{quantity:6000});ok(r,201);ok(await f.returnStock(b,5000),201);const before=f.dbState();ok(await f.state('consumptions',r.body.id,'approved'),409);assert.deepEqual(f.dbState(),before);ok(await f.state('consumptions',r.body.id,'cancelled',f.users.finance.cookie));
 const valid=await f.consume(b,{quantity:4000});ok(valid,201);ok(await f.state('consumptions',valid.body.id,'approved'));ok(await f.returnStock(b,1001),409);ok(await f.returnStock(b,1000),201);ok(await f.consume(b,{quantity:1}),409);assert.equal((await f.detail()).costControl.issueSources[0].availableQuantity,0);
});

test('over-target actual facts require explicit independent override and remain visible as negative variance',async t=>{
 const f=await fixture(t),b=await f.make({targetQuantity:4000}),r=await f.consume(b,{quantity:5000});ok(r,201);const before=f.dbState();ok(await f.state('consumptions',r.body.id,'approved'),409);assert.deepEqual(f.dbState(),before);ok(await f.state('consumptions',r.body.id,'approved',f.users.reviewer.cookie,{overrunReason:'现场实际耗用超目标，独立核对并确认原因'}));
 const d=await f.detail();assert.equal(d.costControl.comparison[0].quantityVariance,-1000);assert.equal(d.costControl.comparison[0].amountVariance,-1000);assert.equal(d.finance.expense,0);assert.match(d.costControl.consumptions[0].review_note,/超预算确认/);
});

test('zero-cent material costs retain actual quantity and do not appear as unconsumed material',async t=>{
 const f=await fixture(t),b=await f.make({targetPrice:1}),r=await f.consume(b,{quantity:1,unitPrice:1});ok(r,201);ok(await f.state('consumptions',r.body.id,'approved'));const d=await f.detail();assert.equal(d.costControl.materialActualAmount,0);assert.equal(d.costControl.consumptions[0].effectiveQuantity,1);ok(await f.returnStock(b,10000),409);
});

test('creator editor submitter and source issue operator must recuse from approval and rejection after role promotion',async t=>{
 const f=await fixture(t),b=await f.make(),r=await f.consume(b);ok(r,201);ok(await f.post('/members',{userId:f.users.finance.id,role:'manager'},f.admin,'PUT'));ok(await f.post('/members',{userId:f.users.engineer.id,role:'manager'},f.admin,'PUT'));
 const before=f.dbState();for(const u of ['finance','engineer'])for(const s of ['approved','rejected']){ok(await f.state('consumptions',r.body.id,s,f.users[u].cookie),409);assert.deepEqual(f.dbState(),before);}ok(await f.state('consumptions',r.body.id,'approved'));
});

test('independent consumption void preserves original evidence and releases source quantity without moving stock or cash',async t=>{
 const f=await fixture(t),b=await f.make(),r=await f.consume(b);ok(r,201);ok(await f.state('consumptions',r.body.id,'approved'));const original=await f.row(r.body.id),before=await f.detail();ok(await f.reverse(b),409);const v=await f.post('/consumptions/'+r.body.id+'/voids',{note:'原确认数量错误'},f.users.finance.cookie);ok(v,201);assert.equal((await f.detail()).costControl.materialActualAmount,4000);ok(await f.state('consumption-voids',v.body.id,'approved'));const d=await f.detail();assert.equal(d.costControl.materialActualAmount,0);assert.equal(d.costControl.issueSources[0].availableQuantity,10000);assert.deepEqual(await f.row(r.body.id),original);assert.deepEqual(d.balances,before.balances);assert.equal(d.finance.expense,before.finance.expense);ok(await f.returnStock(b,10000),201);ok(await f.post('/consumptions/'+r.body.id+'/voids',{note:'重复撤销'},f.users.finance.cookie),409);
});

test('pending issue reversal and pending consumption are mutually exclusive without partial side effects',async t=>{
 const f=await fixture(t),b=await f.make(),reverse=await f.reverse(b);ok(reverse,201);const before=f.dbState();ok(await f.consume(b),409);assert.deepEqual(f.dbState(),before);ok(await f.post('/reversals/'+reverse.body.id+'/state',{version:1,state:'cancelled',note:'撤回原领料冲销'}));const c=await f.consume(b);ok(c,201);ok(await f.reverse(b),409);ok(await f.state('consumptions',c.body.id,'cancelled',f.users.finance.cookie));ok(await f.reverse(b),201);
});

test('WBS and task links used by frozen cost originals cannot be rewritten and legacy task records remain intact',async t=>{
 const f=await fixture(t),b=await f.make(),task=(await f.detail()).items.find(t=>t.id===b.task.id),other=await f.node(),before=f.dbState();ok(await f.post('/wbs/tasks/'+task.id,{version:1,nodeId:other.id,note:'移动任务'},f.admin,'PUT'),409);ok(await f.post('/wbs/'+b.node.id,{version:1,data:{parentId:'',code:'CHANGED',title:'改写部位',type:'area',note:''}},f.admin,'PUT'),409);assert.deepEqual(f.dbState(),before);assert.equal((await f.detail()).items.find(t=>t.id===task.id).data.location,'K0+100');assert.equal((await f.detail()).items.find(t=>t.id===task.id).version,task.version);
});

test('field and platform read-only roles receive public WBS only and no financial records or audit notes',async t=>{
 const f=await fixture(t),b=await f.make(),r=await f.consume(b);ok(r,201);for(const u of ['engineer','viewer']){const d=await f.detail(f.users[u].cookie);assert.equal(d.costControl,null);assert.equal(d.wbs.nodes.length,1);assert.equal(JSON.stringify(d).includes(r.body.id),false);ok(await f.call(f.base+'/cost-control',undefined,f.users[u].cookie),403);ok(await f.consume(b,{},f.users[u].cookie),403);}
 ok(await f.post('/wbs',{data:{parentId:'',code:'NO',title:'无权',type:'area',note:''}},f.users.finance.cookie),403);
});

test('mobile bearer and exact idempotent retry survive restart and reject altered payload or revoked permissions',async t=>{
 const f=await fixture(t),b=await f.make(),body={requestId:randomUUID(),data:{wbsId:b.node.id,taskId:b.task.id,stockId:b.issue.id,quantity:1000,unitPrice:1000,effectiveDate:today(),voucher:'MOBILE-VALUE',note:'移动耗用'}},login=await f.call('/mobile/login',{username:'qa-finance',password:f.password});ok(login);
 const path=f.base.replace('/engineering','/mobile/engineering')+'/consumptions',headers={Authorization:'Bearer '+login.body.token},r=await f.call(path,body,'','POST',headers);ok(r,201);await f.restart();const replay=await f.call(path,body,'','POST',headers);ok(replay,201);assert.equal(replay.body.id,r.body.id);assert.equal(replay.body.replayed,true);ok(await f.call(path,{...body,data:{...body.data,quantity:1001}},'','POST',headers),409);ok(await f.post('/members',{userId:f.users.finance.id,role:'engineer'},f.admin,'PUT'));ok(await f.call(path,body,'','POST',headers),403);
});

test('cost snapshots reject corrupt project quantity amount and duplicate approved versions',async t=>{
 const f=await fixture(t),b=await f.make(),r=await f.consume(b);ok(r,201);ok(await f.state('consumptions',r.body.id,'approved'));const d=await f.detail(),input={projectId:f.pid,...d.wbs,records:d.costControl.records,items:d.items,stock:d.stock};assert.equal(buildEngineeringCostView(input).materialActualAmount,4000);
 const wrong=structuredClone(input);wrong.records[0].project_id=randomUUID();assert.throws(()=>buildEngineeringCostView(wrong),e=>e.status===422);const amount=structuredClone(input);amount.records.find(r=>r.kind==='consumption').snapshot.amount++;assert.throws(()=>buildEngineeringCostView(amount),e=>e.status===422);
});

test('a plan submitter who did not create or edit the draft cannot approve their own submission',async t=>{
 const f=await fixture(t),b=await f.make(),p=await f.post('/cost-plans',{data:{title:'待审新成本',note:'重新核定',lines:[b.line]}},f.users.finance.cookie);ok(p,201);ok(await f.state('cost-plans',p.body.id,'submitted'));const before=f.dbState();ok(await f.state('cost-plans',p.body.id,'approved'),409);ok(await f.state('cost-plans',p.body.id,'rejected'),409);assert.deepEqual(f.dbState(),before);ok(await f.state('cost-plans',p.body.id,'approved',f.users.reviewer2.cookie));
});

test('two consumption approvals recheck shared issue capacity inside each transaction',async t=>{
 const f=await fixture(t),b=await f.make(),a=await f.consume(b,{quantity:6000}),c=await f.consume(b,{quantity:6000});ok(a,201);ok(c,201);const result=await Promise.all([f.state('consumptions',a.body.id,'approved'),f.state('consumptions',c.body.id,'approved')]);assert.deepEqual(result.map(r=>r.status).sort(),[200,409]);assert.equal((await f.detail()).costControl.materialActualAmount,6000);assert.equal((await f.detail()).costControl.issueSources[0].availableQuantity,4000);
});

test('units used by cost originals are immutable while separate nonmaterial units never pool quantities',async t=>{
 const f=await fixture(t),b=await f.make(),m=(await f.detail()).items.find(x=>x.id===b.material.id);ok(await f.post('/items/'+m.id,{version:m.version,data:{...m.data,unit:'吨'}},f.users.engineer.cookie,'PUT'),409);
 const line={...b.line,category:'labor',materialId:'',taskId:'',title:'人工预算',quantity:1000,unitPrice:1000},p=await f.post('/cost-plans',{data:{title:'分单位预算',note:'人工尚未归集实际',lines:[b.line,{...line,unit:'工日'},{...line,unit:'小时'}]}},f.users.finance.cookie);ok(p,201);ok(await f.state('cost-plans',p.body.id,'submitted',f.users.finance.cookie));ok(await f.state('cost-plans',p.body.id,'approved'));const labor=(await f.detail()).costControl.comparison.filter(a=>a.category==='labor');assert.equal(labor.length,2);assert.deepEqual(labor.map(a=>a.targetQuantity),[1000,1000]);assert.ok(labor.every(a=>a.actualAmount===null&&a.amountVariance===null));
});

test('active-project and pending-cost guards retain original records through terminal project states',async t=>{
 const f=await fixture(t),b=await f.make(),c=await f.consume(b),before=f.dbState();ok(c,201);ok(await f.post('/state',{version:2,state:'completed',note:'尝试关闭'}),409);assert.deepEqual(f.dbState(),before);ok(await f.state('consumptions',c.body.id,'cancelled',f.users.finance.cookie));
 const task=(await f.detail()).items.find(i=>i.id===b.task.id);ok(await f.post('/items/'+task.id+'/state',{version:task.version,state:'cancelled',note:'任务取消'}));ok(await f.post('/state',{version:2,state:'completed',note:'已处理所有待办'}));const snapshot=f.dbState();ok(await f.consume(b),409);assert.deepEqual(f.dbState(),snapshot);ok(await f.post('/state',{version:3,state:'archived',note:'归档'}));assert.equal((await f.detail()).costControl.currentPlanId,b.plan.id);
});

function workbook(detail){
 const files=unzipSync(buildEngineeringWorkbook(detail)),parse=p=>new DOMParser().parseFromString(strFromU8(files[p]),'application/xml'),all=(n,tag)=>Array.from(n.getElementsByTagName(tag));
 return Object.fromEntries(all(parse('xl/workbook.xml'),'sheet').map((s,i)=>{const rows=all(parse('xl/worksheets/sheet'+(i+1)+'.xml'),'row').map(r=>all(r,'c').map(c=>c.getAttribute('t')==='n'?Number(all(c,'v')[0].textContent):all(c,'t').map(t=>t.textContent).join('')));return [s.getAttribute('name'),rows.slice(1).map(r=>Object.fromEntries(rows[0].map((h,j)=>[h,r[j]])))];}));
}

test('cost workbook rebuilds confirmed quantities and amounts without cached totals or mutation and keeps cash separate',async t=>{
 const f=await fixture(t),b=await f.make(),r=await f.consume(b);ok(r,201);ok(await f.state('consumptions',r.body.id,'approved'));const d=await f.detail(),before=f.dbState();d.costControl.materialActualAmount=99999;d.costControl.comparison[0].actualAmount=99999;const input=JSON.stringify(d),s=workbook(d);assert.equal(s['材料耗用确认'][0]['有效确认成本（元）'],40);assert.equal(s['成本耗用对照'][0]['已确认成本（元）'],40);assert.equal(s['成本耗用对照'][0]['目标成本差额（元）'],60);assert.equal(s['材料耗用确认'][0]['有效确认数量'],4);assert.equal(s['目标成本版本'][0]['方案目标成本（元）'],100);assert.equal(s['任务施工归属'][0]['原部位桩号'],'K0+100');assert.equal(s['项目汇总'].find(x=>x['项目 / 指标']==='有效支出')['值'],0);assert.deepEqual(f.dbState(),before);assert.equal(JSON.stringify(d),input);
});

test('cost workbook preserves voided evidence and rejects forged quantities and cross-project originals',async t=>{
 const f=await fixture(t),b=await f.make(),r=await f.consume(b);ok(r,201);ok(await f.state('consumptions',r.body.id,'approved'));const v=await f.post('/consumptions/'+r.body.id+'/voids',{note:'耗用确认错误'},f.users.finance.cookie);ok(v,201);ok(await f.state('consumption-voids',v.body.id,'approved'));const d=await f.detail(),s=workbook(d);assert.equal(s['材料耗用确认'][0]['原确认成本（元）'],40);assert.equal(s['材料耗用确认'][0]['有效确认成本（元）'],0);assert.equal(s['耗用撤销历史'][0]['有效成本调整（元）'],-40);
 const corrupt=structuredClone(d);corrupt.costControl.records.find(x=>x.kind==='consumption').data.quantity=3;assert.throws(()=>workbook(corrupt),e=>e.status===422);const foreign=structuredClone(d);foreign.wbs.nodes[0].project_id=randomUUID();assert.throws(()=>workbook(foreign),e=>e.status===422);
});

test('a higher unit cost requires explicit price override even while quantity and total stay under target',async t=>{
 const f=await fixture(t),b=await f.make(),r=await f.consume(b,{quantity:1000,unitPrice:1200});ok(r,201);const before=f.dbState();ok(await f.state('consumptions',r.body.id,'approved'),409);assert.deepEqual(f.dbState(),before);ok(await f.state('consumptions',r.body.id,'approved',f.users.reviewer.cookie,{overrunReason:'核对实际凭据，确认单价高于目标'}));assert.equal((await f.detail()).costControl.materialActualAmount,1200);
});

test('task-specific resource budget cannot be borrowed by a different task in the same WBS',async t=>{
 const f=await fixture(t),b=await f.make(),task=await f.item('tasks',{title:'另一个任务',location:'K0+300',owner:'班组',startDate:'2026-10-01',dueDate:'2026-12-31',predecessorId:'',progress:0,note:''},f.users.engineer.cookie);ok(await f.post('/wbs/tasks/'+task.id,{version:0,nodeId:b.node.id,note:'同部位另一任务'},f.admin,'PUT'));const before=f.dbState();ok(await f.consume(b,{taskId:task.id}),409);assert.deepEqual(f.dbState(),before);
});
