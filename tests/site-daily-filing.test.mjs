import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { unzipSync } from 'fflate';
import { createApp } from '../server/app.mjs';
import { referenceReport } from './daily-report-fixture.mjs';

async function fixture(t, options = {}) {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { app, store, vision } = createApp({ database: ':memory:', baseUrl, distPath: '__test_no_dist__', ...options });
  server.on('request', app);
  t.after(async () => { vision.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const call = (path, data, cookie = '', extras = {}) => fetch(baseUrl + '/api' + path, {
    method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Request': '1', Cookie: cookie, ...extras },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const response = await call('/setup', { organization: '隔离日报测试', username: 'admin-test', name: '测试管理员', password: 'only-for-test-1234' });
  const admin = response.headers.get('set-cookie').split(';')[0];
  async function login(username, role = 'operator') {
    await call('/users', { username, name: username, role, password: 'only-for-test-1234' }, admin);
    const response = await call('/login', { username, password: 'only-for-test-1234' });
    return response.headers.get('set-cookie').split(';')[0];
  }
  const report = () => { const r = referenceReport();r.sections=[r.sections[0]]; const bytes = readFileSync(new URL('./assets/daily-report-qa.png', import.meta.url));
    r.photos = [{ name: '明确标注的合成测试.png', caption: '非施工照片', mime: 'image/png', width: 320, height: 180, base64: bytes.toString('base64') }]; return r; };
  return { call, store, admin, login, report };
}

test('project submissions, pending queue, exact recovery and scope boundaries preserve originals',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'filing-'));const {call,store,admin,login,report}=await fixture(t,{filesDir:dir});t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const worker=await login('filing-worker'),outsider=await login('filing-outsider');
 const user=(await(await call('/me',undefined,worker)).json());
 async function json(path,body,cookie=admin,status=200,method){const r=method?await fetch(new URL(path.startsWith('/api')?path:'/api'+path,(await call('/status')).url).href,{method,headers:{Cookie:cookie,'Content-Type':'application/json','X-Workspace-Request':'1'},body:JSON.stringify(body)}):await call(path,body,cookie);const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data;}
 async function project(code){const p=await json('/engineering/projects',{requestId:randomUUID(),data:{code,name:'【合成】'+code,address:'local',owner:'qa',startDate:'2026-10-01',dueDate:'2026-12-31',budget:0,note:''}},admin,201);await json('/engineering/projects/'+p.id+'/state',{requestId:randomUUID(),version:1,state:'active',note:'qa'});await json('/engineering/projects/'+p.id+'/members',{requestId:randomUUID(),userId:user.id,role:'engineer'},admin,200,'PUT');return p;}
 const a=await project('QA-A'),b=await project('QA-B');const root=p=>'/engineering/projects/'+p.id;
 const w=await json(root(a)+'/wbs',{requestId:randomUUID(),data:{code:'A',title:'A',parentId:'',type:'area',note:''}},admin,201);
 await json('/daily-report/submissions',{submissionId:randomUUID(),projectId:a.id,data:report()},outsider,404);
 const first=await json('/daily-report/submissions',{submissionId:randomUUID(),projectId:a.id,data:report()},worker,201);
 const second=await json('/daily-report/submissions',{submissionId:randomUUID(),projectId:b.id,data:report()},worker,201);
 const legacy=await json('/daily-report/submissions',{submissionId:randomUUID(),data:report()},worker,201);
 for(let i=0;i<22;i++)await json('/daily-report/submissions',{submissionId:randomUUID(),projectId:b.id,data:report()},worker,201);
 const pg=await json(root(b)+'/site-daily-filings?offset=20&limit=20',undefined,worker);assert.equal(pg.total,23);assert.equal(pg.items.length,3);assert.equal((await json(root(b)+'/site-daily-filings?offset=0&limit=20',undefined,worker)).items.length,20);
 assert.equal(first.projectId,a.id);assert.equal(second.projectId,b.id);
 assert.equal((await json(root(a)+'/site-daily-filings',undefined,worker)).total,1);
 assert.equal((await json(root(b)+'/site-daily-filings',undefined,worker)).total,23);
 assert.equal((await json(root(a)+'/site-daily-filings?scope=unassigned',undefined,worker)).items[0].id,legacy.id);
 await json(root(a)+'/site-daily-filings',undefined,outsider,404);
 const foreign={requestId:randomUUID(),data:{category:'construction_daily',title:'错项目',wbsId:w.id,recordDate:second.reportDate,dailyReportId:second.id}};
 await json(root(a)+'/site-records',foreign,worker,409);
 const body={requestId:randomUUID(),data:{category:'construction_daily',title:'归入恢复',wbsId:w.id,recordDate:first.reportDate,dailyReportId:first.id}};
 const resolve=()=>root(a)+'/site-daily-filings/requests/'+body.requestId+'?dailyReportId='+first.id;
 assert.equal((await json(resolve(),undefined,worker)).status,'not_found');
 const before=store.db.prepare('SELECT document_sha256,photo_count FROM daily_reports WHERE id=?').get(first.id);
 const filed=await json(root(a)+'/site-records',body,worker,201);assert.equal((await json(resolve(),undefined,worker)).id,filed.id);
 assert.equal((await json(root(a)+'/site-daily-filings',undefined,worker)).total,0);
 const replay=await json(root(a)+'/site-records',body,worker);assert.equal(replay.id,filed.id);assert.equal(replay.replayed,true);
 // Project IDs, not matching display names, control history and source reuse.
 assert.equal((await json('/daily-report/submissions?projectId='+a.id,undefined,worker)).items[0].id,first.id);
 assert.equal((await json('/daily-report/submissions',undefined,worker)).items[0].id,legacy.id);
 assert(!(await json(root(a)+'/document-candidates',undefined,worker)).some(r=>r.id===second.id));
 await json(root(b)+'/documents',{requestId:randomUUID(),kind:'daily',documentId:first.id},worker,409);
 await json(root(a)+'/documents',{requestId:randomUUID(),kind:'daily',documentId:legacy.id},worker);
 assert(!(await json(root(b)+'/document-candidates',undefined,worker)).some(r=>r.id===legacy.id));
 await json(root(b)+'/documents',{requestId:randomUUID(),kind:'daily',documentId:legacy.id},worker,409);
 const bw=await json(root(b)+'/wbs',{requestId:randomUUID(),data:{code:'B',title:'B',parentId:'',type:'area',note:''}},admin,201);
 await json(root(b)+'/site-records',{requestId:randomUUID(),data:{category:'construction_daily',title:'不可跨项目',wbsId:bw.id,recordDate:legacy.reportDate,dailyReportId:legacy.id}},worker,409);
 const archiveData={title:'合成影像',projectName:'相同显示名称',roadName:'合成道路',segments:[{id:randomUUID(),start:'K0+000',end:'K0+100',content:'',completedAt:'',stages:[{id:randomUUID(),name:'沟槽开挖',completedAt:''}]}]};
 const album=await json('/photo-archives',{creationId:randomUUID(),projectId:a.id,data:archiveData},worker,201);
 assert.equal((await json('/photo-archives?projectId='+a.id,undefined,worker)).items[0].id,album.id);
 assert.equal((await json('/photo-archives?projectId='+b.id,undefined,worker)).total,0);
 await json('/photo-archives/'+album.id+'?projectId='+b.id,undefined,worker,404);
 await json(root(b)+'/documents',{requestId:randomUUID(),kind:'photo',documentId:album.id},worker,409);
 assert(!(await json(root(b)+'/document-candidates',undefined,worker)).some(r=>r.id===album.id));
 const changed=await json('/photo-archives/'+album.id,{version:1,data:{...archiveData,title:'修改标题仍属A'}},worker,200,'PUT');
 assert.equal(JSON.parse(store.db.prepare('SELECT data FROM photo_archives WHERE id=?').get(album.id).data).projectId,a.id);
 await json('/photo-archives/'+album.id+'/photos',{id:randomUUID(),segmentId:archiveData.segments[0].id,stageId:archiveData.segments[0].stages[0].id,...report().photos[0]},worker,201);
 await json('/photo-archives/'+album.id+'/exports',{exportId:randomUUID(),version:changed.version},worker,201);
 const oldAlbum=await json('/photo-archives',{creationId:randomUUID(),data:archiveData},worker,201);
 await json(root(a)+'/documents',{requestId:randomUUID(),kind:'photo',documentId:oldAlbum.id},worker);
 await json(root(b)+'/documents',{requestId:randomUUID(),kind:'photo',documentId:oldAlbum.id},worker,409);
 assert.equal((await json('/photo-archives',undefined,worker)).total,0);
 const racing=await json('/photo-archives',{creationId:randomUUID(),data:archiveData},worker,201);const attempts=await Promise.all([a,b].map(p=>call(root(p)+'/documents',{requestId:randomUUID(),kind:'photo',documentId:racing.id},worker)));assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM engineering_documents WHERE document_id=?').get(racing.id).n,1);
 // Remove access to WBS A, keep project membership/read at B. Confirmation must reveal no record ID.
 const wb=await json(root(a)+'/wbs',{requestId:randomUUID(),data:{code:'B',title:'B',parentId:'',type:'area',note:''}},admin,201);
 await json(root(a)+'/site-access/'+user.id,{requestId:randomUUID(),version:0,data:{template:'engineer',actions:['read','create','editOwn','submit','download'],wbsIds:[wb.id],categories:[],ownOnly:false,validFrom:'',validUntil:''},reason:'qa'},admin,200,'PUT');
 const restricted=await json(resolve(),undefined,worker);assert.deepEqual(restricted,{status:'confirmed_restricted'});
 await json(resolve(),undefined,outsider,404);
 assert.equal(store.db.prepare("SELECT COUNT(*) n FROM engineering_site_records WHERE json_extract(data,'$.dailyReportId')=?").get(first.id).n,1);
 assert.deepEqual(store.db.prepare('SELECT document_sha256,photo_count FROM daily_reports WHERE id=?').get(first.id),before);
 store.db.prepare("UPDATE engineering_site_records SET state='withdrawn' WHERE id=?").run(filed.id);assert.equal((await json(root(a)+'/site-daily-filings',undefined,worker)).items[0].id,legacy.id); // Withdrawal retains the filing history; it is not a never-filed source.
 const mobile=await json('/mobile/login',{username:'filing-worker',password:'only-for-test-1234'});const r=await call('/mobile'+root(a)+'/site-daily-filings',undefined,'',{Authorization:'Bearer '+mobile.token});assert.equal(r.status,200);
});
