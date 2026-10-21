import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdirSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../server/app.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const ok=(r,status=200)=>assert.equal(r.status,status,JSON.stringify(r.body));
async function fixture(t){
 const parent=join(root,'outputs/site-project-scope-fixtures');mkdirSync(parent,{recursive:true});
 const dir=mkdtempSync(join(parent,'fixture-')),password=randomBytes(24).toString('hex');let app,server,url;
 async function start(){server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+server.address().port;app=createApp({database:join(dir,'fixture.sqlite'),baseUrl:url,distPath:'__none__',filesDir:join(dir,'files'),updateDir:join(dir,'updates')});server.on('request',app.app);}
 async function stop(){app.vision.close();server.closeAllConnections();await new Promise(r=>server.close(r));app.store.close();}
 await start();t.after(async()=>{await stop();assert.ok(dir.startsWith(parent+'/fixture-'));rmSync(dir,{recursive:true,force:true});});
 const call=async(path,body,cookie='',method=body===undefined?'GET':'POST',headers={})=>{const r=await fetch(url+'/api'+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json','X-Workspace-Request':'1',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};};
 const setup=await call('/setup',{organization:'隔离项目整体部位验证',username:'scope-admin',name:'管理员',password});ok(setup,201);const admin=setup.cookie,users={};
 for(const n of ['manager','engineer','finance','reader','platform-viewer','outsider']){ok(await call('/users',{username:'scope-'+n,name:n,role:n==='platform-viewer'?'viewer':'operator',password},admin),201);const login=await call('/login',{username:'scope-'+n,password});ok(login);users[n]={cookie:login.cookie};}
 const all=(await call('/users',undefined,admin)).body;for(const n in users)users[n].id=all.find(u=>u.username==='scope-'+n).id;
 const projectData={code:randomUUID(),name:'合成项目整体部位验证',address:'合成地址',owner:'经理',startDate:'2026-10-01',dueDate:'2026-12-31',budget:10000,note:'仅本机隔离验证'};
 const newProject=async(active=true)=>{const r=await call('/engineering/projects',{requestId:randomUUID(),data:{...projectData,code:randomUUID()}},admin);ok(r,201);if(active)ok(await call('/engineering/projects/'+r.body.id+'/state',{requestId:randomUUID(),version:1,state:'active',note:'合成开工'},admin));return r.body.id;};
 const pid=await newProject(),base='/engineering/projects/'+pid;
 const post=(suffix,body={},cookie=admin,method='POST')=>call(base+suffix,{requestId:randomUUID(),...body},cookie,method);
 for(const [n,role] of [['manager','manager'],['engineer','engineer'],['finance','finance'],['reader','viewer'],['platform-viewer','manager']])ok(await post('/members',{userId:users[n].id,role},admin,'PUT'));
 const nodes=(id=pid)=>app.store.db.prepare('SELECT * FROM engineering_wbs WHERE project_id=? ORDER BY id').all(id);
 const snapshot=()=>Object.fromEntries(app.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'engineering_%' OR name='audit') ORDER BY name").all().map(({name})=>[name,app.store.db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]));
 const detail=async(cookie=admin)=>{const r=await call(base,undefined,cookie);ok(r);return r.body;};
 return{call,post,admin,users,pid,base,password,newProject,nodes,snapshot,detail,get store(){return app.store;},restart:async()=>{await stop();await start();}};
}

test('reading an empty real project never creates a WBS; explicit whole-project choice enables a scoped upload draft',async t=>{
 const f=await fixture(t),before=f.snapshot();
 for(const path of [f.base,f.base+'/wbs',f.base+'/site-records?limit=1&offset=0'])ok(await f.call(path,undefined,f.admin));
 assert.deepEqual(f.snapshot(),before);assert.equal(f.nodes().length,0);
 const result=await f.post('/wbs/project-scope');ok(result);assert.equal(result.body.created,true);assert.equal(result.body.version,1);assert.equal(f.nodes().length,1);
 const node=f.nodes()[0],data=JSON.parse(node.data);assert.equal(node.id,result.body.id);assert.equal(node.project_id,f.pid);assert.equal(data.code,'PROJECT-ALL');assert.equal(data.title,'项目整体（未细分部位）');assert.equal(data.parentId,'');assert.equal(data.type,'area');assert.match(data.note,/未细分/);
 const after=await f.detail();assert.equal(after.project.version,2);assert.equal(after.project.data.budget,10000);assert.equal(after.items.length,0);assert.equal(after.wbs.links.length,0);
 assert.equal(after.history.filter(h=>h.action==='wbs_create').length,1);assert.match(after.history.find(h=>h.action==='wbs_create').note,/用户选择/);
 const draft=await f.post('/site-records',{data:{category:'site_measurement',title:'合成收方图片',recordDate:'2026-10-21',wbsId:result.body.id,taskId:'',note:'合成原件待上传',uploadPolicy:'seven_v1'}});ok(draft,201);
 const record=await f.call(f.base+'/site-records/'+draft.body.id,undefined,f.admin);ok(record);assert.equal(record.body.record.data.wbsId,result.body.id);assert.equal(record.body.record.project_id,f.pid);
});

test('only effective platform admin or project manager can explicitly create a whole-project scope',async t=>{
 const f=await fixture(t);
 for(const [name,status] of [['engineer',403],['finance',403],['reader',403],['platform-viewer',403],['outsider',404]]){const before=f.snapshot();ok(await f.post('/wbs/project-scope',{},f.users[name].cookie),status);assert.deepEqual(f.snapshot(),before,name);}
 const anonymousBefore=f.snapshot();ok(await f.call(f.base+'/wbs/project-scope',{requestId:randomUUID()}),401);assert.deepEqual(f.snapshot(),anonymousBefore);
 const login=await f.call('/mobile/login',{username:'scope-manager',password:f.password});ok(login);
 const path=f.base.replace('/engineering','/mobile/engineering')+'/wbs/project-scope';const result=await f.call(path,{requestId:randomUUID()},'','POST',{Authorization:'Bearer '+login.body.token});ok(result);assert.equal(result.body.created,true);assert.equal(f.nodes().length,1);
});

test('planned completed and archived projects reject fresh and replayed whole-project creation without writes',async t=>{
 const f=await fixture(t),planned=await f.newProject(false),beforePlanned=f.snapshot();ok(await f.call('/engineering/projects/'+planned+'/wbs/project-scope',{requestId:randomUUID()},f.admin),409);assert.deepEqual(f.snapshot(),beforePlanned);
 const requestId=randomUUID(),first=await f.post('/wbs/project-scope',{requestId});ok(first);
 ok(await f.post('/state',{version:2,state:'completed',note:'合成项目完工'}));let before=f.snapshot();ok(await f.post('/wbs/project-scope',{requestId}),409);ok(await f.post('/wbs/project-scope'),409);assert.deepEqual(f.snapshot(),before);
 ok(await f.post('/state',{version:3,state:'archived',note:'合成项目归档'}));before=f.snapshot();ok(await f.post('/wbs/project-scope',{requestId}),409);ok(await f.post('/wbs/project-scope'),409);assert.deepEqual(f.snapshot(),before);
});

test('real existing WBS and reserved-code collisions are preserved and never replaced by a whole-project node',async t=>{
 const f=await fixture(t),existing=await f.post('/wbs',{data:{parentId:'',code:'REAL-A',title:'实际施工区域',type:'area',note:'保留真实部位'}});ok(existing,201);const before=f.snapshot();ok(await f.post('/wbs/project-scope'),409);assert.deepEqual(f.snapshot(),before);assert.equal(f.nodes()[0].id,existing.body.id);
 const other=await f.newProject(),base='/engineering/projects/'+other;ok(await f.call(base+'/wbs',{requestId:randomUUID(),data:{parentId:'',code:'PROJECT-ALL',title:'人工设置的实际部位',type:'area',note:''}},f.admin),201);const snapshot=f.snapshot();ok(await f.call(base+'/wbs/project-scope',{requestId:randomUUID()},f.admin),409);assert.deepEqual(f.snapshot(),snapshot);
});

test('request identity survives restart and rejects cross-project or cross-operation replay',async t=>{
 const f=await fixture(t),requestId=randomUUID(),first=await f.post('/wbs/project-scope',{requestId});ok(first);const before=f.snapshot();
 await f.restart();const replay=await f.post('/wbs/project-scope',{requestId});ok(replay);assert.equal(replay.body.id,first.body.id);assert.equal(replay.body.replayed,true);assert.deepEqual(f.snapshot(),before);
 const other=await f.newProject(),fresh=f.snapshot();ok(await f.call('/engineering/projects/'+other+'/wbs/project-scope',{requestId},f.admin),409);assert.deepEqual(f.snapshot(),fresh);assert.equal(f.nodes(other).length,0);
 ok(await f.post('/wbs',{requestId,data:{parentId:'',code:'OTHER',title:'不得复用办理ID',type:'area',note:''}}),409);assert.deepEqual(f.snapshot(),fresh);
});

test('semantic retries and simultaneous distinct requests create one scope and one WBS audit only',async t=>{
 const f=await fixture(t),results=await Promise.all(Array.from({length:5},()=>f.post('/wbs/project-scope')));results.forEach(r=>ok(r));assert.equal(new Set(results.map(r=>r.body.id)).size,1);assert.equal(results.filter(r=>r.body.created).length,1);assert.equal(f.nodes().length,1);
 const detail=await f.detail();assert.equal(detail.history.filter(h=>h.action==='wbs_create').length,1);
 const other=await f.newProject(),separate=await f.call('/engineering/projects/'+other+'/wbs/project-scope',{requestId:randomUUID()},f.admin);ok(separate);assert.notEqual(separate.body.id,results[0].body.id);assert.equal(f.nodes(other).length,1);
});

test('changed or removed project roles cannot use a previously successful idempotent receipt',async t=>{
 const f=await fixture(t),requestId=randomUUID();ok(await f.post('/wbs/project-scope',{requestId},f.users.manager.cookie));
 ok(await f.post('/members',{userId:f.users.manager.id,role:'engineer'},f.admin,'PUT'));let before=f.snapshot();ok(await f.post('/wbs/project-scope',{requestId},f.users.manager.cookie),403);assert.deepEqual(f.snapshot(),before);
 ok(await f.post('/members',{userId:f.users.manager.id,role:'remove'},f.admin,'PUT'));before=f.snapshot();ok(await f.post('/wbs/project-scope',{requestId},f.users.manager.cookie),404);assert.deepEqual(f.snapshot(),before);
});

test('only an exact requestId is accepted and malformed requests cannot create any project data',async t=>{
 const f=await fixture(t),before=f.snapshot();
 for(const body of [{},{requestId:'bad'},{requestId:randomUUID(),data:{}},{requestId:randomUUID(),projectId:randomUUID()},{requestId:randomUUID(),title:'伪造部位名称'},{requestId:randomUUID(),role:'admin'}]){ok(await f.call(f.base+'/wbs/project-scope',body,f.admin),400);assert.deepEqual(f.snapshot(),before);}
 ok(await f.call('/engineering/projects/'+randomUUID()+'/wbs/project-scope',{requestId:randomUUID()},f.admin),404);assert.deepEqual(f.snapshot(),before);
});

// Execute the actual typed production functions with boundary stand-ins. This verifies
// their handling of lost replies and refresh failures; it is not browser/device evidence.
function actualFunction(file,name,environment){
 const source=readFileSync(new URL('../src/'+file,import.meta.url),'utf8');
 const match=new RegExp('(?:async\\s+)?function\\s+'+name+'\\s*\\(').exec(source);assert.ok(match,name+' exists');
 const open=source.indexOf('{',match.index);let depth=0,quote='',comment='',end=-1;
 for(let i=open;i<source.length;i++){
  const c=source[i],next=source[i+1];
  if(comment==='line'){if(c==='\n')comment='';continue;}
  if(comment==='block'){if(c==='*'&&next==='/'){comment='';i++;}continue;}
  if(quote){if(c==='\\'){i++;continue;}if(c===quote)quote='';continue;}
  if(c==='/'&&next==='/'){comment='line';i++;continue;}if(c==='/'&&next==='*'){comment='block';i++;continue;}
  if(c==='"'||c==="'"||c==='`'){quote=c;continue;}
  if(c==='{')depth++;else if(c==='}'&&--depth===0){end=i+1;break;}
 }
 assert.ok(end>open,'function boundary');const body=stripTypeScriptTypes(source.slice(match.index,end),{mode:'strip'});
 return new Function('environment','with (environment) { return ('+body+'); }')(environment);
}

test('project preparation keeps its original request and old drafts until the actual refresh verifies its WBS',async()=>{
 for(const initialMode of ['network','missing-node','missing-project','stale-list','stale-detail']){
  let mode=initialMode;const pid=randomUUID(),nodeId=randomUUID(),requestId=randomUUID(),scope='engineering:site-records:'+JSON.stringify(['https://formal.test','user',pid]);
  const storage=new Map([[scope+':project-scope',JSON.stringify({requestId})],[scope+':operation','existing-pending-original'],[scope+':upload','existing-upload-original'],['old-project-draft','original-draft']]),beforeDrafts=[storage.get(scope+':operation'),storage.get(scope+':upload'),storage.get('old-project-draft')];
  const captures=[],messages=[],errors=[],postBodies=[],generation={current:0},current={detail:null,busy:false};
  const refresh=actualFunction('Engineering.tsx','refresh',{
   projectId:{current:pid},generation,embedded:true,setLoading(){},setError(){},setProjects(){},setMessage(){},selectProject(){throw Error('unexpected project switch');},
   setDetail:value=>{current.detail=value;},setSelected(){},api:async path=>{
    if(path==='/engineering'){if(mode==='stale-list')generation.current++;return{projects:mode==='missing-project'?[]:[{id:pid}]};}
    assert.equal(path,'/engineering/projects/'+pid);if(mode==='network')throw Error('模拟刷新断网');if(mode==='stale-detail')generation.current++;
    return{project:{id:pid},items:[],wbs:{nodes:mode==='missing-node'?[]:[{id:nodeId}]}};
   },
  });
  const pending={current:null},prepare=actualFunction('EngineeringSiteRecords.tsx','startProjectScope',{
   busy:false,pending:null,uploadPending:null,role:'admin',writable:true,key:scope,projectId:pid,projectScopeRequest:pending,
   sessionStorage:{getItem:k=>storage.get(k)||null},store:(key,value)=>value===null?storage.delete(key):storage.set(key,JSON.stringify(value)),
   uuid:value=>/^[a-f0-9-]{36}$/i.test(value||''),setBusy:value=>{current.busy=value;},setError:value=>errors.push(value),setMessage:value=>messages.push(value),
   localDate:()=> '2026-10-21',confirmCapture:value=>captures.push(value),onChanged:id=>refresh(pid,true,undefined,id),
   api:async(path,method,body)=>{assert.equal(path,'/engineering/projects/'+pid+'/wbs/project-scope');assert.equal(method,'POST');postBodies.push(body);return{id:nodeId};},
  });
  await prepare();assert.equal(current.busy,false,initialMode);assert.equal(pending.current,requestId,initialMode);assert.equal(JSON.parse(storage.get(scope+':project-scope')).requestId,requestId);assert.equal(captures.length,0,initialMode);assert.equal(messages.length,0,initialMode);assert.ok(errors.at(-1),initialMode);
  mode='success';await prepare();assert.equal(pending.current,null);assert.equal(storage.has(scope+':project-scope'),false);assert.equal(captures.length,1);assert.equal(captures[0].wbsId,nodeId);assert.equal(current.detail.wbs.nodes[0].id,nodeId);assert.equal(messages.length,1);assert.deepEqual(postBodies,[{requestId},{requestId}]);
  assert.deepEqual([storage.get(scope+':operation'),storage.get(scope+':upload'),storage.get('old-project-draft')],beforeDrafts);
 }
});

test('actual project and tab navigation clear library record focus instead of carrying another project record',()=>{
 const state={focus:'old-project-record',pid:'old-project',tab:'library'},environment={projectId:{current:'old-project'},onRoute:undefined};
 for(const name of ['setDetail','setSelected','setDialog','setSearch','setFilter','setMessage','setCorrectionView','setReplacementFocus','setProgressTaskId','setPurchaseAction'])environment[name]=()=>{};
 environment.setLibraryFocus=value=>{state.focus=value;};environment.setPid=value=>{state.pid=value;};environment.setTabValue=value=>{state.tab=value;};
 actualFunction('Engineering.tsx','selectProject',environment)('new-project');assert.equal(state.focus,'');assert.equal(state.pid,'new-project');assert.equal(state.tab,'overview');
 state.focus='old-project-record';actualFunction('Engineering.tsx','setTab',environment)('documents');assert.equal(state.focus,'');assert.equal(state.tab,'documents');
});
