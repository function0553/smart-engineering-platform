import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {unzipSync,strFromU8} from 'fflate';
import {createApp} from '../server/app.mjs';
import {baselineDate} from '../server/engineering-baselines.mjs';

const ok=(r,status=200)=>assert.equal(r.status,status,Buffer.isBuffer(r.body)?r.body.subarray(0,100).toString():JSON.stringify(r.body));
const taskData=(extra={})=>({title:'合成施工任务',location:'K0测试段',owner:'测试班组',startDate:'2026-10-01',dueDate:'2026-10-03',predecessorId:'',progress:0,note:'合成任务',...extra});
const unknown={progress:null,recordId:null,effectiveDate:null,carriedForward:false,reviewedAt:null};
async function fixture(t,persistent=false){
  const dir=persistent?mkdtempSync(join(tmpdir(),'engineering-progress-')):null;let server,state,url;
  const start=async()=>{server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+server.address().port;state=createApp({database:dir?join(dir,'test.sqlite'):':memory:',baseUrl:url,distPath:'__none__'});server.on('request',state.app);};
  const stop=async()=>{state.vision.close();server.closeAllConnections();await new Promise(r=>server.close(r));state.store.close();};
  await start();t.after(async()=>{await stop();if(dir){assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep)&&dir.includes('engineering-progress-'));rmSync(dir,{recursive:true,force:true});}});
  const call=async(path,body,cookie='',method=body===undefined?'GET':'POST',headers={})=>{const r=await fetch(url+'/api'+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json','X-Workspace-Request':'1',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),bytes=Buffer.from(await r.arrayBuffer());let parsed;try{parsed=JSON.parse(bytes.toString());}catch{parsed=bytes;}return {status:r.status,body:parsed,bytes,headers:r.headers,cookie:r.headers.get('set-cookie')?.split(';')[0]};};
  const password='isolated-progress-test-123',setup=await call('/setup',{organization:'日期进度隔离验证',username:'qa-admin',name:'管理员',password});ok(setup,201);const admin=setup.cookie,users={};
  for(const name of ['author','reviewer','engineer','engineer2','finance','viewer','outsider']){ok(await call('/users',{username:'qa-'+name,name,role:name==='viewer'?'viewer':'operator',password},admin),201);const list=(await call('/users',undefined,admin)).body;users[name]={id:list.find(u=>u.name===name).id,cookie:(await call('/login',{username:'qa-'+name,password})).cookie};}
  const post=(path,body,cookie=admin,method='POST')=>call('/engineering'+path,{requestId:randomUUID(),...body},cookie,method);
  const projectData={code:randomUUID(),name:'合成日期进度项目',address:'本机隔离场所',owner:'测试负责人',startDate:'2026-10-01',dueDate:'2026-12-31',budget:987654321,note:'PRIVATE_PROJECT_FINANCIAL_NOTE'};
  const project=await post('/projects',{data:projectData});ok(project,201);const pid=project.body.id,pb='/projects/'+pid,path=pb+'/progress';ok(await post(pb+'/state',{version:1,state:'active',note:'合成开工'}));
  for(const [name,role] of [['author','manager'],['reviewer','manager'],['engineer','engineer'],['engineer2','engineer'],['finance','finance'],['viewer','manager']])ok(await post(pb+'/members',{userId:users[name].id,role},admin,'PUT'));
  const detail=async()=>(await call('/engineering'+pb,undefined,admin)).body;
  const row=async value=>(await detail()).items.find(r=>r.id===(typeof value==='string'?value:value.id));
  const task=async(extra={},active=true)=>{const r=await post(pb+'/items/tasks',{data:taskData(extra)},users.author.cookie);ok(r,201);if(active)ok(await transition(r.body.id,'active'));return row(r.body.id);};
  const transition=async(value,target,cookie=users.author.cookie)=>{const current=await row(value);return post(pb+'/items/'+current.id+'/state',{version:current.version,state:target,note:'合成任务办理依据'},cookie);};
  const edit=async(value,extra)=>{const current=await row(value);return post(pb+'/items/'+current.id,{version:current.version,data:{...current.data,...extra}},users.author.cookie,'PUT');};
  const request=async(value,progress=30,effectiveDate='2026-10-02',extra={},cookie=users.engineer.cookie)=>{const current=await row(value);return post(path,{taskId:current.id,taskVersion:current.version,effectiveDate,progress,note:'合成现场进度依据',...extra},cookie);};
  const review=(rid,target='approved',cookie=users.reviewer.cookie,extra={})=>post(path+'/'+(typeof rid==='string'?rid:rid.id)+'/state',{version:1,state:target,note:'独立核验合成进度',...extra},cookie);
  const approved=async(value,progress=30,date='2026-10-02',extra={})=>{const r=await request(value,progress,date,extra);ok(r,201);ok(await review(r.body.id));return r.body.id;};
  const view=async(query='',cookie=admin)=>{const r=await call('/engineering'+path+query,undefined,cookie);ok(r);return r.body;};
  const record=rid=>({...state.store.db.prepare('SELECT * FROM engineering_progress WHERE id=?').get(rid)});
  const dbState=()=>({records:state.store.db.prepare('SELECT * FROM engineering_progress ORDER BY id').all(),items:state.store.db.prepare('SELECT * FROM engineering_items ORDER BY id').all(),history:state.store.db.prepare('SELECT * FROM engineering_history ORDER BY id').all(),requests:state.store.db.prepare('SELECT * FROM engineering_requests ORDER BY actor_id,request_id').all()});
  const baseline=async()=>{const r=await post(pb+'/baselines',{title:'合成日期基线',note:'冻结合成任务日期'},users.author.cookie);ok(r,201);ok(await post(pb+'/baselines/'+r.body.id+'/state',{version:1,state:'approved',note:'独立核验基线'},users.reviewer.cookie));return r.body.id;};
  return {call,post,admin,users,password,pid,pb,path,projectData,detail,row,task,transition,edit,request,review,approved,view,record,dbState,baseline,get store(){return state.store;},restart:async()=>{await stop();await start();}};
}

test('dated progress is unknown before approval and is projected only after independent review',async t=>{
  const f=await fixture(t),task=await f.task(),before=await f.row(task);assert.equal((await f.view()).asOf,baselineDate());assert.deepEqual((await f.view()).tasks[0].actual,unknown);
  const r=await f.request(task,35);ok(r,201);assert.equal((await f.row(task)).data.progress,0);assert.deepEqual((await f.view()).tasks[0].actual,unknown);assert.equal((await f.view()).tasks[0].pendingRecordId,r.body.id);
  ok(await f.review(r.body.id,'approved',f.users.engineer.cookie),403);ok(await f.review(r.body.id));const current=await f.row(task);assert.equal(current.data.progress,35);assert.equal(current.version,before.version+1);
  const v=await f.view('?asOf=2026-10-02');assert.equal(v.tasks[0].actual.progress,35);assert.equal(v.tasks[0].actual.carriedForward,false);assert.equal(v.tasks[0].currentProgressHasDateBasis,true);assert.equal(v.records[0].snapshot.title,task.data.title);
  const author=await f.task();const own=await f.request(author,20,'2026-10-02',{},f.users.author.cookie);ok(own,201);ok(await f.review(own.body.id,'approved',f.users.author.cookie),409);ok(await f.review(own.body.id,'rejected',f.users.author.cookie),409);
});

test('all ordinary task updates reject changed progress and legacy percentages never create history',async t=>{
  const f=await fixture(t),task=await f.task();ok(await f.edit(task,{progress:40}),409);ok(await f.edit(task,{title:'合法任务更名'}));
  const data={...(await f.row(task)).data,progress:100};f.store.db.prepare('UPDATE engineering_items SET data=? WHERE id=?').run(JSON.stringify(data),task.id);
  const v=await f.view();assert.equal(v.records.length,0);assert.equal(v.tasks[0].currentProgress,100);assert.equal(v.tasks[0].currentProgressHasDateBasis,false);assert.equal(v.tasks[0].currentProgressRecordId,null);assert.deepEqual(v.tasks[0].actual,unknown);ok(await f.transition(task,'completed'),409);
  ok(await f.post(f.pb+'/items/tasks',{data:taskData({progress:25})}),400);
});

test('history selects last effective observation without interpolation and historical dates differ from latest projection',async t=>{
  const f=await fixture(t),task=await f.task(),later=await f.approved(task,80,'2026-10-05');const version=(await f.row(task)).version;const early=await f.approved(task,20,'2026-10-02');assert.equal((await f.row(task)).version,version+1);assert.equal((await f.row(task)).data.progress,80);
  assert.deepEqual((await f.view('?asOf=2026-10-01')).tasks[0].actual,unknown);
  const carried=(await f.view('?asOf=2026-10-04')).tasks[0].actual;assert.equal(carried.progress,20);assert.equal(carried.recordId,early);assert.equal(carried.effectiveDate,'2026-10-02');assert.equal(carried.carriedForward,true);
  assert.equal((await f.view('?asOf=2026-10-05')).tasks[0].actual.recordId,later);
});

test('correction chains preserve original records and cannot change dates or correct a superseded source',async t=>{
  const f=await fixture(t),task=await f.task(),first=await f.approved(task,30),original=f.record(first);
  ok(await f.request(task,40),409);ok(await f.request(task,40,'2026-10-03',{correctsId:first}),409);
  const second=await f.approved(task,40,'2026-10-02',{correctsId:first});assert.deepEqual(f.record(first),original);const secondOriginal=f.record(second);
  ok(await f.request(task,50,'2026-10-02',{correctsId:first}),409);const third=await f.approved(task,50,'2026-10-02',{correctsId:second});assert.deepEqual(f.record(second),secondOriginal);
  const v=await f.view('?asOf=2026-10-02');assert.equal(v.records.length,3);assert.equal(v.records.filter(r=>r.superseded).length,2);assert.equal(v.tasks[0].actual.recordId,third);assert.equal(v.tasks[0].actual.progress,50);
});

test('cumulative validation considers both neighbors, supports equal observations, and allows zero',async t=>{
  const f=await fixture(t),task=await f.task();await f.approved(task,20,'2026-10-02');await f.approved(task,80,'2026-10-05');
  ok(await f.request(task,19,'2026-10-03'),409);ok(await f.request(task,81,'2026-10-03'),409);ok(await f.request(task,90,'2026-10-01'),409);ok(await f.request(task,70,'2026-10-06'),409);
  await f.approved(task,20,'2026-10-03');await f.approved(task,0,'2026-10-01');assert.equal((await f.view('?asOf=2026-10-01')).tasks[0].actual.progress,0);
  const before=f.dbState();ok(await f.request(task,101),400);ok(await f.request(task,-1),400);ok(await f.request(task,2.5),400);ok(await f.request(task,30,'2999-01-01'),400);ok(await f.request(task,30,'2026-02-30'),400);assert.deepEqual(f.dbState(),before);
});

test('one pending report is enforced under concurrent requests and review is single-effect under concurrent retries',async t=>{
  const f=await fixture(t),task=await f.task();const requests=await Promise.all([f.request(task,30),f.request(task,40)]);assert.deepEqual(requests.map(r=>r.status).sort(),[201,409]);const r=requests.find(r=>r.status===201),key=randomUUID();
  const results=await Promise.all([f.review(r.body.id,'approved',f.users.reviewer.cookie,{requestId:key}),f.review(r.body.id,'approved',f.users.reviewer.cookie,{requestId:key})]);results.forEach(r=>ok(r));assert.equal(results.filter(r=>r.body.replayed).length,1);assert.equal((await f.row(task)).version,task.version+1);assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM engineering_history WHERE action='progress_approved'").get().n,1);
});

test('create approve and cancellation receipts replay after terminal transitions and SQLite reopen without duplicate history',async t=>{
  const f=await fixture(t,true),task=await f.task(),createId=randomUUID();const body={requestId:createId,taskId:task.id,taskVersion:task.version,effectiveDate:'2026-10-02',progress:30,note:'固定响应丢失重试'};
  const r=await f.post(f.path,body,f.users.engineer.cookie);ok(r,201);const reviewId=randomUUID();ok(await f.review(r.body.id,'approved',f.users.reviewer.cookie,{requestId:reviewId}));const before=f.dbState();await f.restart();
  const replay=await f.post(f.path,body,f.users.engineer.cookie);ok(replay,201);assert.equal(replay.body.replayed,true);assert.equal(replay.body.id,r.body.id);const review=await f.review(r.body.id,'approved',f.users.reviewer.cookie,{requestId:reviewId});ok(review);assert.equal(review.body.replayed,true);assert.deepEqual(f.dbState(),before);
  ok(await f.post(f.path,{...body,progress:31},f.users.engineer.cookie),409);
  const next=await f.request(task,40,'2026-10-03');ok(next,201);const cancelId=randomUUID();ok(await f.review(next.body.id,'cancelled',f.users.engineer.cookie,{requestId:cancelId}));const cancelled=f.dbState();await f.restart();const again=await f.review(next.body.id,'cancelled',f.users.engineer.cookie,{requestId:cancelId});ok(again);assert.equal(again.body.replayed,true);assert.deepEqual(f.dbState(),cancelled);
});

test('approval rechecks task version and a 409 leaves record task history and request receipts unchanged',async t=>{
  const f=await fixture(t),task=await f.task(),r=await f.request(task,40);ok(r,201);ok(await f.edit(task,{location:'修改后部位'}));const before=f.dbState();const requestId=randomUUID();ok(await f.review(r.body.id,'approved',f.users.reviewer.cookie,{requestId}),409);assert.deepEqual(f.dbState(),before);assert.equal(f.record(r.body.id).state,'submitted');
  ok(await f.review(r.body.id,'cancelled',f.users.engineer.cookie));const newReport=await f.request(task,40);ok(newReport,201);ok(await f.review(newReport.body.id));assert.equal(f.record(newReport.body.id).snapshot.includes('修改后部位'),true);
});

test('reject and cancel never affect current progress and only requester or manager may cancel',async t=>{
  const f=await fixture(t),task=await f.task();await f.approved(task,20);const original=await f.row(task);const r=await f.request(task,40,'2026-10-03');ok(r,201);ok(await f.review(r.body.id,'cancelled',f.users.engineer2.cookie),403);ok(await f.review(r.body.id,'rejected'));assert.deepEqual(await f.row(task),original);ok(await f.review(r.body.id),409);
  const next=await f.request(task,40,'2026-10-03');ok(next,201);ok(await f.review(next.body.id,'cancelled',f.users.engineer.cookie));assert.deepEqual(await f.row(task),original);assert.equal((await f.view()).tasks[0].pendingRecordId,null);
});

test('task lifecycle requires approved 100 and no pending, and completed correction requires manager restoration',async t=>{
  const f=await fixture(t),planned=await f.task({},false);ok(await f.request(planned),409);ok(await f.transition(planned,'active'));ok(await f.transition(planned,'completed'),409);
  const complete=await f.approved(planned,100);const pending=await f.request(planned,100,'2026-10-03');ok(pending,201);ok(await f.transition(planned,'completed'),409);ok(await f.transition(planned,'cancelled'),409);ok(await f.review(pending.body.id,'cancelled',f.users.engineer.cookie));ok(await f.transition(planned,'completed'));
  ok(await f.request(planned,90,'2026-10-02',{correctsId:complete}),409);ok(await f.transition(planned,'active',f.users.engineer.cookie),403);ok(await f.transition(planned,'active'));await f.approved(planned,90,'2026-10-02',{correctsId:complete});ok(await f.transition(planned,'completed'),409);
  const cancelled=await f.task();ok(await f.transition(cancelled,'cancelled'));ok(await f.request(cancelled),409);
});

test('started or completed direct successors block restoration and frozen project blocks writes but preserves reads',async t=>{
  const f=await fixture(t),first=await f.task();await f.approved(first,100);ok(await f.transition(first,'completed'));const next=await f.task({title:'后续施工',predecessorId:first.id,startDate:'2026-10-04',dueDate:'2026-10-06'});ok(await f.transition(first,'active'),409);await f.approved(next,100);ok(await f.transition(next,'completed'));ok(await f.transition(first,'active'),409);
  let project=(await f.detail()).project;ok(await f.post(f.pb+'/state',{version:project.version,state:'completed',note:'合成完工'}));ok(await f.request(next,100),409);ok(await f.transition(next,'active'),409);await f.view();project=(await f.detail()).project;ok(await f.post(f.pb+'/state',{version:project.version,state:'archived',note:'合成归档'}));await f.view();ok(await f.request(next,100),409);
});

test('pending progress prevents project completion and approval permissions are checked again after membership changes',async t=>{
  const f=await fixture(t),task=await f.task(),r=await f.request(task,100);ok(r,201);const p=(await f.detail()).project;ok(await f.post(f.pb+'/state',{version:p.version,state:'completed',note:'待审时禁止完工'}),409);
  ok(await f.post(f.pb+'/members',{userId:f.users.reviewer.id,role:'finance'},f.admin,'PUT'));const before=f.dbState();ok(await f.review(r.body.id),403);assert.deepEqual(f.dbState(),before);ok(await f.post(f.pb+'/members',{userId:f.users.reviewer.id,role:'manager'},f.admin,'PUT'));ok(await f.review(r.body.id));ok(await f.transition(task,'completed'));ok(await f.post(f.pb+'/state',{version:p.version,state:'completed',note:'复核完成后完工'}));
});

test('project ACL strict inputs mobile parity session revocation and cross-project references are enforced',async t=>{
  const f=await fixture(t),task=await f.task();ok(await f.call('/engineering'+f.path),401);ok(await f.call('/engineering'+f.path,undefined,f.users.outsider.cookie),404);
  for(const role of ['finance','viewer']){await f.view('',f.users[role].cookie);ok(await f.request(task,30,'2026-10-02',{},f.users[role].cookie),403);}
  for(const query of ['?asOf=2999-01-01','?asOf=not-a-date','?unknown=1','?taskId=invalid'])ok(await f.call('/engineering'+f.path+query,undefined,f.admin),400);
  ok(await f.request(task,30,'2026-10-02',{snapshot:{}}),400);ok(await f.request(task,30,'2026-10-02',{taskVersion:1}),409);
  const other=await f.post('/projects',{data:{...f.projectData,code:randomUUID()}});ok(other,201);const otherPb='/projects/'+other.body.id;ok(await f.post(otherPb+'/state',{version:1,state:'active',note:'其他合成项目'}));const foreign=await f.post(otherPb+'/items/tasks',{data:taskData()});ok(foreign,201);
  ok(await f.request(task,30,'2026-10-02',{taskId:foreign.body.id}),400);ok(await f.call('/engineering'+f.path+'?taskId='+foreign.body.id,undefined,f.admin),400);
  const login=await f.call('/mobile/login',{username:'qa-engineer',password:f.password});ok(login);const headers={Authorization:'Bearer '+login.body.token};
  const mobile=await f.call('/mobile/engineering'+f.path,{requestId:randomUUID(),taskId:task.id,taskVersion:task.version,effectiveDate:'2026-10-02',progress:35,note:'移动端合成填报'},'','POST',headers);ok(mobile,201);ok(await f.post(otherPb+'/progress/'+mobile.body.id+'/state',{version:1,state:'approved',note:'跨项目拒绝'}),404);ok(await f.review(mobile.body.id));
  const mobileView=await f.call('/mobile/engineering'+f.path+'?asOf=2026-10-02',undefined,'','GET',headers);ok(mobileView);assert.equal(mobileView.body.tasks[0].actual.progress,35);
  ok(await f.call('/mobile/logout',{},'','POST',headers));ok(await f.call('/mobile/engineering'+f.path,undefined,'','GET',headers),401);
});

test('dated baseline exposes partial unknown coverage while latest mode remains compatible and corrections are historical',async t=>{
  const f=await fixture(t),a=await f.task(),b=await f.task({title:'无日期依据任务',startDate:'2026-10-04',dueDate:'2026-10-05'}),bid=await f.baseline();const first=await f.approved(a,50,'2026-10-02');
  const get=async mode=>{const r=await f.call('/engineering'+f.pb+'/baselines?baselineId='+bid+'&asOf=2026-10-03'+(mode?'&actualMode='+mode:''),undefined,f.users.engineer.cookie);ok(r);return r.body;};
  const latest=await get();assert.equal(latest.actualMode,'latest');assert.equal(latest.comparison.summary.actualProgress,30);assert.equal(latest.comparison.tasks[0].actualObservation,null);
  const dated=await get('dated');assert.equal(dated.comparison.summary.actualProgress,null);assert.equal(dated.comparison.summary.variance,null);assert.equal(dated.comparison.summary.knownTasks,1);assert.equal(dated.comparison.summary.unknownTasks,1);assert.equal(dated.comparison.summary.knownWeightPercent,60);assert.equal(dated.comparison.tasks.find(r=>r.id===b.id).actualProgress,null);
  await f.approved(b,0,'2026-10-01');await f.approved(a,40,'2026-10-02',{correctsId:first});ok(await f.transition(a,'cancelled'));const corrected=await get('dated');assert.equal(corrected.comparison.summary.actualProgress,24);const cancelled=corrected.comparison.tasks.find(r=>r.id===a.id);assert.equal(cancelled.actualProgress,40);assert.equal(cancelled.actualObservation.carriedForward,true);assert.equal((await get()).comparison.tasks.find(r=>r.id===a.id).actualProgress,0);
  ok(await f.call('/engineering'+f.pb+'/baselines?actualMode=dated&asOf=2999-01-01',undefined,f.admin),400);
});

test('progress export is readable by field and viewer roles and omits financial private data with safe XLSX headers',async t=>{
  const f=await fixture(t),task=await f.task(),other=await f.task({title:'未筛选任务'}),bid=await f.baseline();await f.approved(task,25);
  const contract=await f.post(f.pb+'/items/contracts',{data:{title:'PRIVATE_CONTRACT_TITLE',code:'PRIVATE_CONTRACT_CODE',counterparty:'PRIVATE_COUNTERPARTY',direction:'expense',amount:987654321,dueDate:'2026-12-31',note:'PRIVATE_CONTRACT_NOTE'}},f.users.author.cookie);ok(contract,201);
  const query='?asOf=2026-10-03&taskId='+task.id+'&baselineId='+bid;
  for(const name of ['engineer','finance','viewer']){const r=await f.call('/engineering'+f.path+'/export'+query,undefined,f.users[name].cookie);ok(r);assert.match(r.headers.get('content-type'),/spreadsheetml.sheet/);assert.match(r.headers.get('content-disposition'),/\.xlsx/);assert.match(r.headers.get('cache-control'),/no-store/);assert.equal(r.headers.get('x-content-type-options'),'nosniff');const files=unzipSync(r.bytes),xml=Object.values(files).map(bytes=>strFromU8(bytes)).join('\n');assert.match(xml,/日期进度/);assert.match(xml,/计划基线对照/);assert.match(xml,/填报更正历史/);for(const secret of ['PRIVATE_CONTRACT_TITLE','PRIVATE_CONTRACT_CODE','PRIVATE_COUNTERPARTY','PRIVATE_CONTRACT_NOTE','PRIVATE_PROJECT_FINANCIAL_NOTE','987654321',f.password])assert.equal(xml.includes(secret),false,secret);assert.match(strFromU8(files['xl/worksheets/sheet1.xml']),new RegExp(task.id));assert.equal(strFromU8(files['xl/worksheets/sheet1.xml']).includes(other.id),false);}
});

test('progress export rejects foreign filters unpublished baselines future dates unknown query and revoked mobile access',async t=>{
  const f=await fixture(t),task=await f.task(),path='/engineering'+f.path+'/export';ok(await f.call(path),401);ok(await f.call(path,undefined,f.users.outsider.cookie),404);
  for(const q of ['?asOf=2999-01-01','?unknown=1','?taskId=not-an-id','?baselineId=not-an-id'])ok(await f.call(path+q,undefined,f.admin),400);
  const pending=await f.post(f.pb+'/baselines',{title:'未批基线',note:'待复核'},f.users.author.cookie);ok(pending,201);ok(await f.call(path+'?baselineId='+pending.body.id,undefined,f.admin),409);
  const other=await f.post('/projects',{data:{...f.projectData,code:randomUUID()}});ok(other,201);const pb='/projects/'+other.body.id;ok(await f.post(pb+'/state',{version:1,state:'active',note:'其他项目'}));const foreign=await f.post(pb+'/items/tasks',{data:taskData()});ok(foreign,201);const baseline=await f.post(pb+'/baselines',{title:'其他项目基线',note:'其他项目'});ok(baseline,201);ok(await f.call(path+'?taskId='+foreign.body.id,undefined,f.admin),400);ok(await f.call(path+'?baselineId='+baseline.body.id,undefined,f.admin),404);
  const login=await f.call('/mobile/login',{username:'qa-engineer',password:f.password});ok(login);const headers={Authorization:'Bearer '+login.body.token};ok(await f.call('/mobile'+path+'?taskId='+task.id,undefined,'','GET',headers));ok(await f.post(f.pb+'/members',{userId:f.users.engineer.id,role:'remove'},f.admin,'PUT'));ok(await f.call('/mobile'+path,undefined,'','GET',headers),404);ok(await f.post(f.pb+'/members',{userId:f.users.engineer.id,role:'engineer'},f.admin,'PUT'));ok(await f.call('/mobile/logout',{},'','POST',headers));ok(await f.call('/mobile'+path,undefined,'','GET',headers),401);
});
