import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync, strFromU8, zipSync, strToU8 } from 'fflate';
import sharp from 'sharp';
import { siteWorkSteps } from '../server/site-work-steps.mjs';
import { createApp } from '../server/app.mjs';
import { siteRecordCategories, siteRecordLimits, siteRecordsPending } from '../server/engineering-site-records.mjs';
import {createSiteUploadState,reduceSiteUploadState,serializeSiteUploadState,restoreSiteUploadState} from '../shared/site-upload-state.mjs';

const sha = b => createHash('sha256').update(b).digest('hex'), ok = (r, status = 200) => assert.equal(r.status, status, JSON.stringify(r.body));
const pdf = Buffer.from('%PDF-1.7\nSynthetic archived original, no real site evidence.\n%%EOF');
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415408996360606060000000050001a5f645400000000049454e44ae426082', 'hex');
const mp4 = Buffer.concat([Buffer.from('000000186674797069736f6d0000020069736f6d6d703432', 'hex'), Buffer.alloc(1024, 7)]);
const docx = extra => Buffer.from(zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'word/document.xml': strToU8('<document>合成日报</document>'), ...extra }));

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

async function createSeven(f,category,extra={}){const c=await f.call(f.route,{requestId:randomUUID(),data:f.data({category,uploadPolicy:'seven_v1',...extra})},f.users.engineer.cookie);ok(c,201);return c.body;}
async function jpeg(seed=1){return sharp({create:{width:12,height:12,channels:3,background:{r:70+seed,g:90,b:120}}}).jpeg().toBuffer();}
async function step(f,r,id,stepId='step01',representative=true){ok(await f.action(r,'/files/'+id+'/step',{version:(await f.detail(r)).version,stepId,representative}));}
async function submit(f,r){const d=await f.detail(r);return f.action(r,'/submit',{version:d.version,reviewerId:f.users.manager.id});}
async function review(f,r,decision='approve',cookie=f.users.manager.cookie){const d=await f.detail(r,cookie);return f.action(r,'/review',{version:d.version,decision,reason:'合成独立复核意见'},cookie);}
async function renameWbs(f,title){const row=f.store.db.prepare('SELECT data,version FROM engineering_wbs WHERE id=?').get(f.node.id);ok(await f.post('/wbs/'+f.node.id,{version:row.version,data:{...JSON.parse(row.data),title}},f.admin,'PUT'));}
async function grantReview(f,user,validUntil=''){const old=f.store.db.prepare('SELECT version FROM engineering_site_access_grants WHERE project_id=? AND user_id=?').get(f.pid,user.id);ok(await f.post('/site-access/'+user.id,{version:old?.version||0,data:{template:'supervisor',actions:['read','review','download'],categories:[],wbsIds:[],ownOnly:false,validFrom:'',validUntil},reason:'隔离复核授权'},f.admin,'PUT'));}

test('photo submit preflights representative size and leaves oversized originals editable and intact',async t=>{
 const f=await fixture(t,true),r=await createSeven(f,'work_photos'),large=[];
 for(let i=0;i<3;i++){const j=await jpeg(i),b=Buffer.concat([j,Buffer.alloc(12*1048576-j.length,i)]),saved=await f.completeUpload(r,b,'large-'+i+'.jpg','image/jpeg');large.push({id:saved.id,sha:sha(b)});await step(f,r,saved.id,'step0'+(i+1));}
 const response=await submit(f,r);ok(response,413);assert.match(response.body.error,/32 MiB/);let d=await f.detail(r);assert.equal(d.review,null);assert.equal(d.writable,true);
 for(const x of large)assert.equal(sha(readFileSync(f.finalPath(x.id))),x.sha);
 for(let i=0;i<3;i++){const saved=await f.completeUpload(r,await jpeg(10+i),'small-'+i+'.jpg','image/jpeg');await step(f,r,saved.id,'step0'+(i+1));}
 ok(await submit(f,r));ok(await review(f,r));ok(await f.archive(r,f.users.manager.cookie));d=await f.detail(r);assert.equal(d.record.state,'archived');assert.equal(d.files.length,6);assert.equal(d.exports.length,1);
 for(const x of large)assert.equal(sha(readFileSync(f.finalPath(x.id))),x.sha);
});

test('photo decoding failure is caught before submit and does not lock the draft',async t=>{
 const f=await fixture(t,true),r=await createSeven(f,'work_photos'),saved=await f.completeUpload(r,Buffer.from('ffd8ff0001020304','hex'),'invalid.jpg','image/jpeg');await step(f,r,saved.id);
 const before=await f.detail(r),s=await submit(f,r);ok(s,422);assert.match(s.body.error,/无法解码/);const after=await f.detail(r);assert.equal(after.version,before.version);assert.equal(after.review,null);assert.equal(after.writable,true);
});

test('WBS rename before approval and after approval can return, refresh snapshot, resubmit and archive with history retained',async t=>{
 const f=await fixture(t,true),r=await createSeven(f,'work_photos'),bytes=await jpeg(),saved=await f.completeUpload(r,bytes,'original.jpg','image/jpeg');await step(f,r,saved.id);
 let d=await f.detail(r);ok(await f.action(r,'/exports',{version:d.version}),201);d=await f.detail(r);const oldExport=d.exports[0];ok(await submit(f,r));await renameWbs(f,'提交后更名');const approval=await review(f,r);ok(approval,409);assert.match(approval.body.error,/核对草稿/);ok(await review(f,r,'return'));
 d=await f.detail(r);ok(await f.action(r,'',{version:d.version,data:d.record.data},undefined,'PUT'));ok(await submit(f,r));ok(await review(f,r));d=await f.detail(r,f.users.manager.cookie);assert.equal(d.capabilities.review,false);assert.equal(d.capabilities.return,true);assert.equal(d.writable,false);
 const fixedVersion=d.version;ok(await f.action(r,'',{version:d.version,data:d.record.data},undefined,'PUT'),409);ok(await f.action(r,'/files/'+saved.id+'/step',{version:d.version,stepId:'step02',representative:true}),409);
 await renameWbs(f,'通过后更名');ok(await f.archive(r,f.users.manager.cookie),409);
 ok(await f.action(r,'/review',{version:d.version,decision:'return',reason:'越权'},f.users.engineer.cookie),403);ok(await f.action(r,'/review',{version:d.version,decision:'return',reason:'未指定'},f.admin),403);
 ok(await f.action(r,'/review',{version:d.version-1,decision:'return',reason:'过期版本'},f.users.manager.cookie),409);
 const body={requestId:randomUUID(),version:fixedVersion,decision:'return',reason:'归档前更名需核对'};ok(await f.call(f.route+'/'+r.id+'/review',body,f.users.manager.cookie));const replay=await f.call(f.route+'/'+r.id+'/review',body,f.users.manager.cookie);ok(replay);assert.equal(replay.body.replayed,true);
 d=await f.detail(r);assert.equal(d.review.state,'returned');assert.equal(d.exports.find(x=>x.id===oldExport.id).sha256,oldExport.sha256);assert.equal(sha(readFileSync(f.finalPath(saved.id))),sha(bytes));
 ok(await f.action(r,'',{version:d.version,data:d.record.data},undefined,'PUT'));ok(await submit(f,r));ok(await review(f,r));ok(await f.archive(r,f.users.manager.cookie));d=await f.detail(r,f.users.manager.cookie);assert.equal(d.capabilities.return,false);ok(await f.action(r,'/review',{version:d.version,decision:'return',reason:'归档后不得退回'},f.users.manager.cookie),409);assert.equal(d.exports.length,2);assert.ok(d.events.filter(e=>e.action==='site_review_return').length===2);assert.equal(d.exports.find(x=>x.id===oldExport.id).sha256,oldExport.sha256);
});

test('expired approved reviewer can be reassigned by existing handoff authority; old approval is invalidated',async t=>{
 const f=await fixture(t,true),r=await createSeven(f,'site_measurement');await f.completeUpload(r,await jpeg(),'original.jpg','image/jpeg');ok(await submit(f,r));ok(await review(f,r));await grantReview(f,f.users.other);await grantReview(f,f.users.manager,'2026-01-01T00:00:00.000Z');
 let d=await f.detail(r,f.admin);assert.equal(d.review.state,'approved');const denied=await f.action(r,'/review',{version:d.version,decision:'return',reason:'已过期'},f.users.manager.cookie);assert.ok([403,404].includes(denied.status));
 ok(await f.action(r,'/reviewer',{version:d.version,userId:f.users.engineer.id,reason:'不能让作者复核'},f.admin),403);
 ok(await f.action(r,'/reviewer',{version:d.version,userId:f.users.other.id,reason:'原复核授权已过期，重新独立复核'},f.users.engineer.cookie),403);
 ok(await f.action(r,'/reviewer',{version:d.version,userId:f.users.other.id,reason:'原复核授权已过期，重新独立复核'},f.admin));
 d=await f.detail(r,f.admin);assert.equal(d.review.state,'submitted');assert.equal(d.review.reviewed_by,null);assert.equal(d.review.reviewed_at,null);assert.equal(d.capabilities.archive,false);const event=d.events.find(e=>e.action==='site_review_reassign');assert.equal(JSON.parse(event.note).approvalInvalidated,true);assert.ok(d.events.some(e=>e.action==='site_review_approve'));
 ok(await f.archive(r,f.admin),409);ok(await review(f,r,'return',f.users.other.cookie));d=await f.detail(r);assert.equal(d.review.state,'returned');
 ok(await f.action(r,'',{version:d.version,data:d.record.data},undefined,'PUT'));const submitted=await f.action(r,'/submit',{version:(await f.detail(r)).version,reviewerId:f.users.other.id});ok(submitted);ok(await review(f,r,'approve',f.users.other.cookie));ok(await f.archive(r,f.admin));
});

test('photo and video date plus ownership stay aligned on create and edit; retained mismatch is visible and never migrated',async t=>{
 const f=await fixture(t,true),p=await createSeven(f,'work_photos'),mismatch=await f.call(f.route,{requestId:randomUUID(),data:f.data({category:'work_videos',uploadPolicy:'seven_v1',recordDate:'2026-10-13',photoRecordId:p.id})},f.users.engineer.cookie);ok(mismatch,400);assert.match(mismatch.body.error,/日期必须/);
 const v=await createSeven(f,'work_videos',{photoRecordId:p.id});let vd=await f.detail(v),pd=await f.detail(p);
 for(const delta of [{recordDate:'2026-10-13'},{taskId:''},{wbsId:f.rootNode.id},{batchId:randomUUID()}]){const before=JSON.stringify((await f.detail(v)).record);const res=await f.action(v,'',{version:vd.version,data:{...vd.record.data,...delta}},undefined,'PUT');assert.ok([400,404,409].includes(res.status));assert.equal(JSON.stringify((await f.detail(v)).record),before);}
 ok(await f.action(p,'',{version:pd.version,data:{...pd.record.data,recordDate:'2026-10-13'}},undefined,'PUT'),409);assert.equal((await f.detail(p)).record.data.recordDate,'2026-10-12');
 // Simulate a pre-fix historical cross-date link without using the new write path.
 const raw=f.store.db.prepare('SELECT data FROM engineering_site_records WHERE id=?').get(v.id),legacy={...JSON.parse(raw.data),recordDate:'2026-10-13'};f.store.db.prepare('UPDATE engineering_site_records SET data=? WHERE id=?').run(JSON.stringify(legacy),v.id);
 vd=await f.detail(v);pd=await f.detail(p);assert.equal(vd.relatedMismatch,true);assert.equal(pd.relatedMismatch,true);assert.equal(vd.record.data.recordDate,'2026-10-13');assert.equal(f.store.db.prepare('SELECT data FROM engineering_site_records WHERE id=?').get(v.id).data,JSON.stringify(legacy));
 ok(await f.action(v,'',{version:vd.version,data:{...vd.record.data,recordDate:pd.record.data.recordDate}},undefined,'PUT'));assert.equal((await f.detail(v)).relatedMismatch,false);assert.equal((await f.detail(p)).relatedMismatch,false);
});

function queued(r,bytes,uploadId){const scope='synthetic/'+r.id,key='original',attemptId=randomUUID();let q=createSiteUploadState(scope,r.id);const event=(type,extra={})=>{q=reduceSiteUploadState(q,{scopeKey:scope,key,attemptId,type,...extra});};event('select',{files:[{key,name:'original.jpg',size:bytes.length,lastModified:1,stepId:''}]});event('begin');event('progress',{phase:'uploading',bytes:bytes.length,sha256:sha(bytes),uploadId});event('progress',{phase:'verifying',bytes:bytes.length,sha256:sha(bytes),uploadId});event('failure',{resultUnconfirmed:true,error:'complete response lost'});q=restoreSiteUploadState(serializeSiteUploadState(q),scope,r.id);return {get q(){return q},event,scope,key,attemptId};}

test('lost complete response reload confirms saved from upload status without original bytes or duplicate upload',async t=>{
 const f=await fixture(t,true),r=await createSeven(f,'hidden_work'),b=await jpeg(),saved=await f.completeUpload(r,b,'original.jpg','image/jpeg'),state=queued(r,b,saved.uid);assert.equal(state.q.items[0].phase,'verifying');assert.equal(state.q.items[0].fileId,'');assert.equal(state.q.items[0].fileAvailable,false);assert.equal(state.q.items[0].awaitingReadback,true);
 const status=await f.call(f.route+'/'+r.id+'/uploads/'+saved.uid,undefined,f.users.engineer.cookie);ok(status);const detail=await f.detail(r);state.event('saved',{receipt:{id:status.body.fileId,state:status.body.state,sha256:status.body.sha256},readback:{recordId:r.id,file:detail.files.find(x=>x.id===status.body.fileId)}});assert.equal(state.q.items[0].phase,'saved');assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM engineering_site_uploads WHERE record_id=?').get(r.id).n,1);assert.equal(detail.files.length,1);
 // Removed/mismatched readback cannot promote cached metadata to saved.
 const restored=queued(r,b,saved.uid);restored.event('saved',{receipt:{id:saved.id,state:'completed',sha256:sha(b)},readback:{recordId:r.id,file:{...detail.files[0],removed_at:new Date().toISOString()}}});assert.equal(restored.q.items[0].phase,'verifying');assert.equal(restored.q.items[0].uploadId,saved.uid);
 const denied=await f.call(f.route+'/'+r.id+'/uploads/'+saved.uid,undefined,f.users.other.cookie);assert.ok([403,404].includes(denied.status));const unauth=await f.call(f.route+'/'+r.id+'/uploads/'+saved.uid);ok(unauth,401);for(const status of [401,403]){restored.event('failure',{resultUnconfirmed:true,error:'HTTP '+status});assert.equal(restored.q.items[0].phase,'verifying');assert.equal(restored.q.items[0].uploadId,saved.uid);assert.equal(restored.q.items[0].sha256,sha(b));}
});

test('incomplete server upload reload asks for the original only after status proves incomplete',async t=>{
 const f=await fixture(t,true),r=await createSeven(f,'hidden_work'),b=await jpeg(),upload=await f.startUpload(r,b,'original.jpg','image/jpeg');ok(upload,201);const state=queued(r,b,upload.body.id);assert.equal(state.q.items[0].phase,'verifying');const status=await f.call(f.route+'/'+r.id+'/uploads/'+upload.body.id,undefined,f.users.engineer.cookie);ok(status);assert.equal(status.body.state,'uploading');state.event('failure',{error:'服务器尚未完成保存，请重新选择原件继续原上传。'});assert.equal(state.q.items[0].phase,'failed');assert.equal(state.q.items[0].fileAvailable,false);assert.equal(state.q.items[0].uploadId,upload.body.id);assert.equal((await f.detail(r)).files.length,0);
});

test('Word history quota is preflighted without deleting existing versions or locking editable originals',async t=>{
 const f=await fixture(t,true),r=await createSeven(f,'work_photos'),saved=await f.completeUpload(r,await jpeg(),'original.jpg','image/jpeg');await step(f,r,saved.id);let d=await f.detail(r);ok(await f.action(r,'/exports',{version:d.version}),201);
 const original=f.store.db.prepare('SELECT * FROM engineering_site_word_exports WHERE record_id=?').get(r.id);const columns=Object.keys(original),insert=f.store.db.prepare('INSERT INTO engineering_site_word_exports('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')');for(let sequence=2;sequence<=50;sequence++)insert.run(...columns.map(k=>k==='id'?randomUUID():k==='sequence'?sequence:original[k]));
 d=await f.detail(r);ok(await f.action(r,'',{version:d.version,data:{...d.record.data,title:'当前新正文，历史额度已满'}},undefined,'PUT'));const result=await submit(f,r);ok(result,409);assert.match(result.body.error,/50个Word/);d=await f.detail(r);assert.equal(d.review,null);assert.equal(d.writable,true);assert.equal(d.exports.length,50);assert.equal(d.exports.find(x=>x.id===original.id).sha256,original.sha256);assert.equal(sha(readFileSync(f.finalPath(saved.id))),saved.sha256);
});

async function waitForPhotoConversion(pending) {
 let settled=false;pending.then(()=>{settled=true;},()=>{settled=true;});
 const until=Date.now()+4000;
 while(!settled&&sharp.counters().process===0&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,1));
 assert.ok(!settled&&sharp.counters().process>0,'evidence must change during actual asynchronous Sharp conversion');
}

// Direct DB mutations model external storage drift without the version bump enforced by normal API writes.
// They are not claims of an ordinary UI action or a permission bypass.
for(const scenario of [
 {action:'submit',change:'representative'},
 {action:'submit',change:'step'},
 {action:'submit',change:'sha'},
 {action:'submit',change:'removed'},
 {action:'review',change:'representative'},
 {action:'exports',change:'representative'},
 {action:'photo-table',change:'step'},
])test('photo preflight fingerprint rejects external '+scenario.change+' drift during '+scenario.action+' without a version bump',async t=>{
 const f=await fixture(t,true),r=await createSeven(f,'work_photos');
 const bytes=await sharp({create:{width:5000,height:5000,channels:3,background:'#2468ac'}}).jpeg().toBuffer();
 const selected=await f.completeUpload(r,bytes,'selected.jpg','image/jpeg');await step(f,r,selected.id);
 const alternateBytes=Buffer.from('ffd8ff0001020304','hex'),alternate=await f.completeUpload(r,alternateBytes,'unreadable-not-selected.jpg','image/jpeg');await step(f,r,alternate.id,'step01',false);
 if(scenario.action==='review')ok(await submit(f,r));
 const before=await f.detail(r),beforeRequests=f.store.db.prepare('SELECT COUNT(*) n FROM engineering_requests').get().n;
 const pending=scenario.action==='submit'?submit(f,r):scenario.action==='review'?review(f,r):scenario.action==='exports'?f.action(r,'/exports',{version:before.version}):f.call(f.route+'/'+r.id+'/photo-table?version='+before.version,undefined,f.users.engineer.cookie);
 await waitForPhotoConversion(pending);
 f.store.transaction(()=>{
  if(scenario.change==='representative'){
   f.store.db.prepare('UPDATE engineering_site_file_steps SET representative=0 WHERE file_id=?').run(selected.id);
   f.store.db.prepare('UPDATE engineering_site_file_steps SET representative=1 WHERE file_id=?').run(alternate.id);
  }else if(scenario.change==='step')f.store.db.prepare('UPDATE engineering_site_file_steps SET step_id=? WHERE file_id=?').run('step02',selected.id);
  else if(scenario.change==='sha')f.store.db.prepare('UPDATE engineering_site_files SET sha256=? WHERE id=?').run('0'.repeat(64),selected.id);
  else f.store.db.prepare('UPDATE engineering_site_files SET removed_at=? WHERE id=?').run(new Date().toISOString(),selected.id);
 });
 const result=await pending;ok(result,409);assert.match(result.body.error,/照片及工序依据已变化/);
 const after=await f.detail(r);assert.equal(after.version,before.version);assert.equal(after.review?.state||null,before.review?.state||null);assert.equal(after.exports.length,before.exports.length);
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM engineering_requests').get().n,beforeRequests,'rejected preflight must not commit an idempotency receipt');
 assert.equal(sha(readFileSync(f.finalPath(selected.id))),sha(bytes));assert.equal(sha(readFileSync(f.finalPath(alternate.id))),sha(alternateBytes));
});
