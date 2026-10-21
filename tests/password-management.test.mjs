import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/app.mjs';
async function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'password-qa-'));const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const {app,store}=createApp({database:':memory:',baseUrl:base,filesDir:dir,distPath:join(dir,'none')});server.on('request',app);t.after(async()=>{await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});});
 async function req(path,body,session={},method=body?'POST':'GET'){
  const r=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json','X-Workspace-Request':'1',...(session.cookie?{cookie:session.cookie}:{}),...(session.token?{Authorization:'Bearer '+session.token}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
 }
 const setup=await req('/setup',{organization:'隔离密码验证',username:'admin',name:'测试管理员',password:'111111'});assert.equal(setup.status,201);const admin={cookie:setup.cookie};
 async function login(username,password,mobile=false){const r=await req(mobile?'/mobile/login':'/login',{username,password});assert.equal(r.status,200);return mobile?{token:r.body.token}:{cookie:r.cookie};}
 async function user(username='worker',role='operator'){const r=await req('/users',{username,name:'测试'+username,password:'222222',role},admin);assert.equal(r.status,201);return r.body.id;}
 return {req,store,admin,login,user,adminId:setup.body.user.id};
}
test('all password setters accept six digits and reject fewer than six',async t=>{const f=await fixture(t);const id=await f.user();for(const path of ['/users/'+id+'/password','/password']){
 const r=await f.req(path,path==='/password'?{current:'111111',password:'12345'}:{password:'12345'},f.admin);assert.equal(r.status,400);
 }const r=await f.req('/users',{username:'short',name:'short',password:'12345',role:'operator'},f.admin);assert.equal(r.status,400);assert.equal((await f.req('/users/'+id+'/password',{password:'333333'},f.admin)).status,200);await f.login('worker','333333');});
test('administrator reset revokes web and mobile sessions, preserves identity/role/status and audits no secrets',async t=>{
 const f=await fixture(t);const id=await f.user();const web=await f.login('worker','222222'),mobile=await f.login('worker','222222',true);const before=f.store.db.prepare('SELECT id,username,name,role,active,created_at FROM users WHERE id=?').get(id);
 const r=await f.req('/users/'+id+'/password',{password:'333333'},f.admin);assert.equal(r.status,200);assert.equal((await f.req('/me',null,web)).status,401);assert.equal((await f.req('/mobile/me',null,mobile)).status,401);assert.equal((await f.req('/login',{username:'worker',password:'222222'})).status,401);await f.login('worker','333333');await f.login('worker','333333',true);
 assert.deepEqual(f.store.db.prepare('SELECT id,username,name,role,active,created_at FROM users WHERE id=?').get(id),before);const audit=JSON.stringify(f.store.db.prepare('SELECT * FROM audit').all());assert(!audit.includes('222222')&&!audit.includes('333333'));assert(!JSON.stringify(r.body).includes('333333'));
});
test('reset denies nonadmins, anonymous, self and missing target without changing credentials',async t=>{
 const f=await fixture(t);const id=await f.user();const operator=await f.login('worker','222222');const vid=await f.user('reader','viewer');const viewer=await f.login('reader','222222');for(const s of [operator,viewer,{}])assert.equal((await f.req('/users/'+id+'/password',{password:'333333'},s)).status,s.cookie?403:401);
 assert.equal((await f.req('/users/'+f.adminId+'/password',{password:'333333'},f.admin)).status,400);assert.equal((await f.req('/users/00000000-0000-4000-8000-000000000001/password',{password:'333333'},f.admin)).status,404);assert.equal((await f.req('/users/not-uuid/password',{password:'333333'},f.admin)).status,400);await f.login('worker','222222');await f.login('reader','222222');assert(vid);
});
test('web self-change replaces only initiating cookie and revokes other web/mobile sessions',async t=>{
 const f=await fixture(t);await f.user();const a=await f.login('worker','222222'),b=await f.login('worker','222222'),m=await f.login('worker','222222',true);
 assert.equal((await f.req('/password',{current:'wrong',password:'333333'},a)).status,400);assert.equal((await f.req('/me',null,b)).status,200);
 const r=await f.req('/password',{current:'222222',password:'333333'},a);assert.equal(r.status,200);assert(r.cookie&&r.cookie!==a.cookie);for(const s of [a,b])assert.equal((await f.req('/me',null,s)).status,401);assert.equal((await f.req('/mobile/me',null,m)).status,401);assert.equal((await f.req('/me',null,{cookie:r.cookie})).status,200);
});
test('mobile self-change supports viewer, returns valid replacement bearer and invalidates all old sessions',async t=>{
 const f=await fixture(t);await f.user('reader','viewer');const web=await f.login('reader','222222'),a=await f.login('reader','222222',true),b=await f.login('reader','222222',true);
 assert.equal((await f.req('/mobile/password',{current:'wrong',password:'333333'},a)).status,400);assert.equal((await f.req('/mobile/me',null,b)).status,200);
 const r=await f.req('/mobile/password',{current:'222222',password:'333333'},a);assert.equal(r.status,200);assert(r.body.token&&r.body.expiresAt>Date.now());assert.equal(r.body.user.role,'viewer');for(const s of [a,b])assert.equal((await f.req('/mobile/me',null,s)).status,401);assert.equal((await f.req('/me',null,web)).status,401);assert.equal((await f.req('/mobile/me',null,{token:r.body.token})).status,200);await f.login('reader','333333',true);
});
test('password changes do not cross cookie and bearer authentication or accept unsolicited role fields',async t=>{
 const f=await fixture(t);const id=await f.user();const a=await f.login('worker','222222',true);assert.equal((await f.req('/mobile/password',{current:'222222',password:'333333'},f.admin)).status,401);assert.equal((await f.req('/password',{current:'222222',password:'333333'},a)).status,401);assert.equal((await f.req('/users/'+id+'/password',{password:'333333',role:'admin'},f.admin)).status,400);await f.login('worker','222222');
});
test('admin user directory distinguishes project roles and document岗位 without granting access or exposing credentials',async t=>{
 const f=await fixture(t),worker=await f.user(),reviewer=await f.user('reviewer');
 const p=await f.req('/engineering/projects',{requestId:crypto.randomUUID(),data:{code:'ROLES',name:'合成岗位项目',address:'本地',owner:'经理',startDate:'2026-10-01',dueDate:'2026-12-31',budget:0,note:'测试'}},f.admin);assert.equal(p.status,201);const base='/engineering/projects/'+p.body.id;
 for(const [userId,role] of [[worker,'engineer'],[reviewer,'engineer']])assert.equal((await f.req(base+'/members',{requestId:crypto.randomUUID(),userId,role},f.admin,'PUT')).status,200);
 const grant={template:'supervisor',actions:['read','review','download'],categories:[],wbsIds:[],ownOnly:false,validFrom:'',validUntil:'2020-01-01T00:00:00Z'};assert.equal((await f.req(base+'/site-access/'+reviewer,{requestId:crypto.randomUUID(),version:0,data:grant,reason:'合成失效权限展示'},f.admin,'PUT')).status,200);
 const listing=await f.req('/users',null,f.admin);assert.equal(listing.status,200);const w=listing.body.find(u=>u.id===worker),v=listing.body.find(u=>u.id===reviewer);assert.equal(w.role,'operator');assert.equal(w.projectAssignments[0].projectRole,'engineer');assert.equal(w.projectAssignments[0].siteRole,'施工员');assert.equal(v.projectAssignments[0].siteRole,'监理 / 复核人员');assert.equal(v.projectAssignments[0].expired,true);assert(!JSON.stringify(listing.body).includes('hash'));assert(!JSON.stringify(listing.body).includes('222222'));
 const session=await f.login('worker','222222');assert.equal((await f.req('/users',null,session)).status,403);assert.equal((await f.req('/users')).status,401);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM engineering_site_access_grants').get().n,1);
});

test('account summary uses the same effective ACL after platform viewer downgrade',async t=>{
 const f=await fixture(t),uid=await f.user('manager');const p=await f.req('/engineering/projects',{requestId:crypto.randomUUID(),data:{code:'DOWNGRADE',name:'合成降级项目',address:'本地',owner:'经理',startDate:'2026-10-01',dueDate:'2026-12-31',budget:0,note:'测试'}},f.admin);assert.equal(p.status,201);const base='/engineering/projects/'+p.body.id;
 assert.equal((await f.req(base+'/members',{requestId:crypto.randomUUID(),userId:uid,role:'manager'},f.admin,'PUT')).status,200);
 assert.equal((await f.req(base+'/site-access/'+uid,{requestId:crypto.randomUUID(),version:0,data:{template:'supervisor',actions:['read','review','download'],categories:[],wbsIds:[],ownOnly:false,validFrom:'',validUntil:''},reason:'合成授权'},f.admin,'PUT')).status,200);
 assert.equal((await f.req('/users/'+uid,{role:'viewer',active:true},f.admin,'PATCH')).status,200);const login=await f.login('manager','222222');const effective=await f.req(base+'/site-access',null,login);assert.equal(effective.status,200);assert.equal(effective.body.permission.expired,true);assert.deepEqual(effective.body.permission.actions,[]);
 const summary=(await f.req('/users',null,f.admin)).body.find(u=>u.id===uid).projectAssignments[0];assert.equal(summary.expired,effective.body.permission.expired);assert.equal(summary.projectRole,'viewer');assert.equal(summary.configuredProjectRole,'manager');assert.equal(summary.siteRole,'监理 / 复核人员');
});
