import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {createApp} from '../server/app.mjs';
import {siteRecordLimits} from '../server/engineering-site-records.mjs';
import {builtinSiteTemplates,applySiteRecordTemplate,defaultsFromSiteRecord,expandSiteTemplate} from '../shared/site-record-templates.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex'),ok=(r,status=200)=>assert.equal(r.status,status,JSON.stringify(r.body));
const pdf=Buffer.from('%PDF-1.7\nsynthetic\n%%EOF');
async function fixture(t,reviewEnabled=false) {
  const dir = mkdtempSync(join(tmpdir(), 'engineering-site-records-')), password = randomBytes(24).toString('hex'); let state, server, url;
  async function start() { server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); url = 'http://127.0.0.1:' + server.address().port; state = createApp({ database: join(dir, 'test.sqlite'), baseUrl: url, distPath: '__none__', filesDir: join(dir, 'files'), updateDir: join(dir, 'updates') }); server.on('request', state.app); }
  async function stop() { state.vision.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); state.store.close(); }
  await start(); t.after(async () => { await stop(); assert.ok(dir.startsWith(tmpdir())); rmSync(dir, { recursive: true, force: true }); });
  async function call(path, body, cookie = '', method = body === undefined ? 'GET' : 'POST', headers = {}) {
    const r = await fetch(url + '/api' + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Workspace-Request': '1', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const bytes = Buffer.from(await r.arrayBuffer()); let value; try { value = JSON.parse(bytes.toString()); } catch { value = null; }
    return { status: r.status, body: value, bytes, headers: r.headers, cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  const setup = await call('/setup', { organization: '隔离施工资料验证', username: 'qa-admin', name: '管理员', password }); ok(setup, 201); const admin = setup.cookie, users = {};
  for (const n of ['manager', 'engineer', 'finance', 'other', 'viewer', 'outsider']) { const u = await call('/users', { username: 'qa-' + n, name: n, role: n === 'viewer' ? 'viewer' : 'operator', password }, admin); ok(u, 201); const l = await call('/login', { username: 'qa-' + n, password }); ok(l); users[n] = { cookie: l.cookie }; }
  const all = (await call('/users', undefined, admin)).body; for (const n in users) users[n].id = all.find(u => u.username === 'qa-' + n).id;
  const projectData = { code: randomUUID(), name: '资料测试项目', address: '合成测试位置', owner: '经理', startDate: '2026-10-01', dueDate: '2026-12-31', budget: 50000, note: '非实际工程' };
  const p = await call('/engineering/projects', { requestId: randomUUID(), data: projectData }, admin); ok(p, 201); const pid = p.body.id; if(!reviewEnabled)state.store.db.prepare("INSERT INTO engineering_site_access_config VALUES(?,0,1,'legacy-fixture',?)").run(pid,new Date().toISOString()); const pb = '/engineering/projects/' + pid, route = pb + '/site-records';
  const post = (path, body, cookie = admin, method = 'POST', headers = {}) => call(pb + path, { requestId: randomUUID(), ...body }, cookie, method, headers);
  ok(await post('/state', { version: 1, state: 'active', note: '合成开工' }));
  for (const [n, role] of [['manager', 'manager'], ['engineer', 'engineer'], ['finance', 'finance'], ['other', 'engineer'], ['viewer', 'manager']]) ok(await post('/members', { userId: users[n].id, role }, admin, 'PUT'));
  const rootNode = await post('/wbs', { data: { parentId: '', code: 'S01', title: '合成标段', type: 'section', note: '' } }); ok(rootNode, 201);
  const node = await post('/wbs', { data: { parentId: rootNode.body.id, code: 'U01', title: '合成管网部位', type: 'area', note: '' } }); ok(node, 201);
  const task = await post('/items/tasks', { data: { title: '合成管网铺设', location: 'K0+100', owner: '测试班组', startDate: '2026-10-01', dueDate: '2026-12-31', predecessorId: '', progress: 0, note: '' } }, users.engineer.cookie); ok(task, 201);
  ok(await post('/wbs/tasks/' + task.body.id, { version: 0, nodeId: node.body.id, note: '绑定合成任务' }, admin, 'PUT'));
  const data = extra => ({ category: 'site_measurement', title: '合成现场收方原件', recordDate: '2026-10-12', wbsId: node.body.id, taskId: task.body.id, note: '只归档资料，不核定工程量', ...extra });
  // Existing regression cases exercise retained pre-upgrade records. New seven-rule cases use call(route,...) directly.
  const create = async (category = 'site_measurement', cookie = users.engineer.cookie, extra = {}) => { const desired=data({category,...extra});const r=await call(route,{requestId:randomUUID(),data:{...desired,category:category==='work_videos'&&!extra.photoRecordId?'hidden_work':category}},cookie);ok(r,201);const row=state.store.db.prepare('SELECT data FROM engineering_site_records WHERE id=?').get(r.body.id);const stored=JSON.parse(row.data);delete stored.uploadPolicy;stored.category=category;state.store.db.prepare('UPDATE engineering_site_records SET data=? WHERE id=?').run(JSON.stringify(stored),r.body.id);return r.body; };
  const detail = async (r, cookie = users.engineer.cookie) => { const d = await call(route + '/' + r.id, undefined, cookie); ok(d); return d.body; };
  const action = (r, suffix, body, cookie = users.engineer.cookie, method = 'POST', headers = {}) => call(route + '/' + r.id + suffix, { requestId: randomUUID(), ...body }, cookie, method, headers);
  const startUpload = async (r, bytes = pdf, name = '原始收方.pdf', mime = 'application/pdf', cookie = users.engineer.cookie, extra = {}) => action(r, '/uploads', { version: (await detail(r, cookie)).version, name, mime, byteCount: bytes.length, sha256: sha(bytes), ...extra }, cookie);
  const completeUpload = async (r, bytes = pdf, name = '原始收方.pdf', mime = 'application/pdf', cookie = users.engineer.cookie) => {
    const u = await startUpload(r, bytes, name, mime, cookie); ok(u, 201);
    for (let offset = 0; offset < bytes.length; offset += siteRecordLimits.chunkBytes) ok(await action(r, '/uploads/' + u.body.id + '/chunks', { offset, base64: bytes.subarray(offset, offset + siteRecordLimits.chunkBytes).toString('base64') }, cookie));
    const c = await action(r, '/uploads/' + u.body.id + '/complete', {}, cookie); ok(c); return { ...c.body, uid: u.body.id };
  };
  const archive = async (r, cookie = users.engineer.cookie) => action(r, '/archive', { version: (await detail(r, cookie)).version, note: '原件存档，不表示技术验收' }, cookie);
  const partPath = uid => join(dir, 'files', 'engineering-site-records', 'staging', uid + '.part'), finalPath = fid => join(dir, 'files', 'engineering-site-records', 'originals', fid + '.original');
  return { call, post, admin, users, pid, pb, route, data, create, detail, action, startUpload, completeUpload, archive, node: node.body, rootNode: rootNode.body, task: task.body, partPath, finalPath, password, get store() { return state.store; }, restart: async () => { await stop(); await start(); } };
}

const templateData=(f,extra={})=>({name:'现场常用模板',category:'hidden_work',scopeWbsId:'',description:'核对原件与施工部位',defaults:{titlePattern:'{工程} {类别} {日期}',note:'{部位} · 合成验证'},...extra});
const saveTemplate=(f,data=templateData(f),cookie=f.admin)=>f.call(f.route+'/templates',{requestId:randomUUID(),data,reason:'合成模板验证'},cookie);

test('seven reusable defaults preserve all record identity dates and media and workflow fields',()=>{
 assert.equal(builtinSiteTemplates.length,7);
 for(const t of builtinSiteTemplates){const current={category:t.category,title:'旧填写',note:'旧备注',recordDate:'2026-10-12',wbsId:randomUUID(),taskId:randomUUID(),batchId:randomUUID(),photoRecordId:randomUUID(),dailyReportId:randomUUID(),uploadPolicy:'seven_v1',workInfo:{road:'旧路',location:'旧段',number:'NO-1',completedAt:'2026-10-11'}};const next=applySiteRecordTemplate(t,current,{projectName:'工程',address:'地址',location:'施工部位'});for(const k of ['recordDate','wbsId','taskId','batchId','photoRecordId','dailyReportId','uploadPolicy'])assert.equal(next[k],current[k]);assert.equal(next.workInfo.number,'NO-1');assert.equal(next.workInfo.completedAt,'2026-10-11');assert.deepEqual(next.templateRef,{id:t.id,version:1});const defaults=defaultsFromSiteRecord(current);assert.equal('recordDate' in defaults,false);assert.equal('number' in (defaults.workInfo||{}),false);}
 assert.throws(()=>applySiteRecordTemplate(builtinSiteTemplates[0],{category:'hidden_work'},{}));assert.equal(expandSiteTemplate('{工程}',{projectName:'abc😀',category:'hidden_work'},4),'abc');
});

test('project template management supports authorized history optimistic concurrency and idempotent replay',async t=>{
 const f=await fixture(t,true),base=f.route+'/templates';let r=await f.call(base,undefined,f.users.engineer.cookie);ok(r);assert.equal(r.body.templates.length,7);assert.equal(r.body.canManage,false);
 ok(await saveTemplate(f,templateData(f),f.users.engineer.cookie),403);ok(await f.call(base,undefined,f.users.outsider.cookie),404);
 const body={requestId:randomUUID(),data:templateData(f),reason:'初版'};r=await f.call(base,body,f.users.manager.cookie);ok(r,201);const id=r.body.id;const replay=await f.call(base,body,f.users.manager.cookie);ok(replay,201);assert.equal(replay.body.id,id);assert.equal(replay.body.replayed,true);
 ok(await f.call(base,{...body,reason:'不同正文'},f.users.manager.cookie),409);
 const update={requestId:randomUUID(),version:1,data:templateData(f,{name:'模板第二版'}),reason:'核对'};ok(await f.call(base+'/'+id,update,f.users.manager.cookie,'PUT'));ok(await f.call(base+'/'+id,{...update,requestId:randomUUID()},f.users.manager.cookie,'PUT'),409);
 const history=await f.call(base+'/'+id+'/history',undefined,f.users.manager.cookie);ok(history);assert.deepEqual(history.body.versions.map(v=>v.version),[2,1]);assert.equal(history.body.versions[1].data.name,'现场常用模板');
 ok(await f.call(base+'/'+id+'/history',undefined,f.users.engineer.cookie),403);
 for(const data of [templateData(f,{category:'site_measurement'}),templateData(f,{scopeWbsId:f.node.id})])ok(await f.call(base+'/'+id,{requestId:randomUUID(),version:2,data,reason:'不迁移旧范围'},f.admin,'PUT'),409);
});

test('record capture freezes canonical template versions and preserves old provenance on edits after disable',async t=>{
 const f=await fixture(t,true),r=await saveTemplate(f);ok(r,201);const ref={id:r.body.id,version:1};
 const create=await f.call(f.route,{requestId:randomUUID(),data:f.data({category:'hidden_work',templateRef:ref})},f.users.engineer.cookie);ok(create,201);
 let d=await f.detail(create.body);assert.equal(d.record.snapshot.template.name,'现场常用模板');assert.deepEqual(d.record.data.templateRef,ref);
 ok(await f.call(f.route+'/templates/'+ref.id+'/state',{requestId:randomUUID(),version:1,state:'disabled',reason:'换新版'},f.admin));
 ok(await f.call(f.route,{requestId:randomUUID(),data:f.data({category:'hidden_work',templateRef:ref})},f.users.engineer.cookie),409);
 const editData={...d.record.data,title:'本次更正'};delete editData.templateRef;
 ok(await f.action(create.body,'',{version:d.version,data:editData},f.users.engineer.cookie,'PUT'));d=await f.detail(create.body);assert.equal(d.record.snapshot.template.version,1);assert.equal(d.record.snapshot.template.name,'现场常用模板');assert.deepEqual(d.record.data.templateRef,ref);assert.equal(d.events.find(e=>e.action==='site_record_create').snapshot.template.version,1);
 const bad={id:'builtin.site_measurement',version:1};ok(await f.call(f.route,{requestId:randomUUID(),data:f.data({category:'hidden_work',templateRef:bad})},f.admin),400);
});

test('template scopes share common metadata while actual record capture and category grants remain enforced',async t=>{
 const f=await fixture(t,true),r=await saveTemplate(f,templateData(f,{scopeWbsId:f.node.id}));ok(r,201);
 const global=await saveTemplate(f);ok(global,201);
 const grant={template:'crew',actions:['read','create','editOwn'],categories:['hidden_work'],wbsIds:[f.node.id],ownOnly:true,validFrom:'',validUntil:''};
 const access=await f.call(f.pb+'/site-access',undefined,f.admin);ok(access);
 // Follow the access endpoint's optimistic version, not fixture database mutation.
 const person=access.body.members.find(m=>m.id===f.users.engineer.id||m.user_id===f.users.engineer.id);assert.ok(person,JSON.stringify(access.body));
 const result=await f.call(f.pb+'/site-access/'+f.users.engineer.id,{requestId:randomUUID(),version:person.permission?.version||person.version||0,data:grant,reason:'合成范围验证'},f.admin,'PUT');
 ok(result);
 const list=await f.call(f.route+'/templates',undefined,f.users.engineer.cookie);ok(list);assert.equal(list.body.templates.every(t=>t.category==='hidden_work'),true);assert.ok(list.body.templates.some(t=>t.id===global.body.id));assert.ok(list.body.templates.some(t=>t.id===r.body.id));
 const record=await f.call(f.route,{requestId:randomUUID(),data:f.data({category:'hidden_work',templateRef:{id:r.body.id,version:1}})},f.users.engineer.cookie);ok(record,201);
 ok(await f.call(f.route,{requestId:randomUUID(),data:f.data({category:'hidden_work',wbsId:f.rootNode.id,taskId:'',templateRef:{id:r.body.id,version:1}})},f.admin),400);
});

test('template payloads reject originals identity invalid scopes and unsupported variable or XML controls',async t=>{
 const f=await fixture(t,true);
 for(const extra of [{files:['bad']},{scopeWbsId:randomUUID()},{defaults:{titlePattern:'{密码}',note:''}},{defaults:{titlePattern:'ok',note:'bad\u0001'}},{defaults:{titlePattern:'ok',note:'',recordDate:'2020-01-01'}},{defaults:{titlePattern:'ok',note:'',workInfo:{road:'a',location:'b'}}}])ok(await saveTemplate(f,{...templateData(f),...extra}),400);
 const source=await saveTemplate(f);ok(source,201);const inaccessible=await f.call('/engineering/projects/'+randomUUID()+'/site-records/templates/'+source.body.id+'/history',undefined,f.admin);ok(inaccessible,404);
});

test('template provenance survives upload return supplement resubmit approve archive and A4 Word snapshot checks',async t=>{
 const f=await fixture(t,true),builtin=builtinSiteTemplates.find(t=>t.category==='work_photos');
 const r=await f.call(f.route,{requestId:randomUUID(),data:f.data({category:'work_photos',templateRef:{id:builtin.id,version:1},workInfo:{road:'合成道路',location:'合成部位',number:'QA',completedAt:''}})},f.users.engineer.cookie);ok(r,201);const rec=r.body;
 const bytes=await sharp({create:{width:240,height:160,channels:3,background:'#356ba0'}}).png().toBuffer();
 const u=await f.startUpload(rec,bytes,'合成照片.png','image/png',f.users.engineer.cookie,{stepId:'step01'});ok(u,201);ok(await f.action(rec,'/uploads/'+u.body.id+'/chunks',{offset:0,base64:bytes.toString('base64')}));ok(await f.action(rec,'/uploads/'+u.body.id+'/complete',{}));
 let d=await f.detail(rec);ok(await f.action(rec,'/submit',{version:d.version,reviewerId:f.users.manager.id,note:'合成提交'}));d=await f.detail(rec);ok(await f.action(rec,'/review',{version:d.version,decision:'return',reason:'补充说明'},f.users.manager.cookie));d=await f.detail(rec);ok(await f.action(rec,'',{version:d.version,data:{...d.record.data,note:'按意见补充'}},f.users.engineer.cookie,'PUT'));
 d=await f.detail(rec);ok(await f.action(rec,'/submit',{version:d.version,reviewerId:f.users.manager.id,note:'重新提交'}));d=await f.detail(rec);ok(await f.action(rec,'/review',{version:d.version,decision:'approve',reason:'合成独立核对'},f.users.manager.cookie));ok(await f.archive(rec,f.admin));d=await f.detail(rec,f.admin);assert.equal(d.record.state,'archived');assert.equal(d.record.snapshot.template.id,builtin.id);assert.equal(d.exports.length,1);assert.equal(d.exports[0].snapshot.location.template.id,builtin.id);assert.equal(d.events.filter(e=>e.action==='site_review_submit').length,2);assert.equal(d.files.length,1);
});
