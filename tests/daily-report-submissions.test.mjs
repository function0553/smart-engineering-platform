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

test('submission commits text, original image and immutable Word and remains after reopening SQLite', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'daily-report-archive-')); const database = join(directory, 'test.sqlite');
  const { call, store, admin, report } = await fixture(t, { database });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const data = report(), submissionId = randomUUID();
  const response = await call('/daily-report/submissions', { submissionId, data }, admin);
  assert.equal(response.status, 201); const saved = await response.json(); assert.equal(saved.photoCount, 1);
  const detail = await (await call('/daily-report/submissions/' + saved.id, undefined, admin)).json();
  assert.equal(detail.data.projectName, data.projectName); assert.equal(detail.data.photos[0].base64, undefined);
  const image = await call(`/daily-report/submissions/${saved.id}/photos/0`, undefined, admin);
  assert.equal(image.status, 200); assert.equal(image.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), Buffer.from(data.photos[0].base64, 'base64'));
  const word = await call(`/daily-report/submissions/${saved.id}/word`, undefined, admin);
  assert.equal(word.status, 200); const bytes = Buffer.from(await word.arrayBuffer());
  assert.deepEqual(Buffer.from(unzipSync(bytes)['word/media/daily-report-1.png']), Buffer.from(data.photos[0].base64, 'base64'));
  const backup = await (await call(`/daily-report/submissions/${saved.id}/data`, undefined, admin)).json();
  assert.deepEqual(backup, { schemaVersion: 1, data });
  const reopened = new DatabaseSync(database, { readOnly: true });
  assert.deepEqual(Buffer.from(reopened.prepare('SELECT document FROM daily_reports WHERE id=?').get(saved.id).document), bytes);
  assert.equal(reopened.prepare('SELECT COUNT(*) n FROM daily_report_photos').get().n, 1); reopened.close();
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM records').get().n, 0);
});

test('owner isolation covers list, metadata, original photos, JSON and Word; admin sees all; viewer cannot submit', async t => {
  const { call, admin, login, report } = await fixture(t);
  const owner = await login('owner'), other = await login('other'), viewer = await login('viewer', 'viewer');
  const body = { submissionId: randomUUID(), data: report() };
  assert.equal((await call('/daily-report/submissions', body)).status, 401);
  assert.equal((await call('/daily-report/submissions', body, viewer)).status, 403);
  assert.equal((await call('/daily-report/submissions', body, owner, { 'X-Workspace-Request': '' })).status, 403);
  const result = await (await call('/daily-report/submissions', body, owner)).json();
  for (const suffix of ['', '/word', '/data', '/photos/0']) {
    assert.equal((await call('/daily-report/submissions/' + result.id + suffix)).status, 401);
    assert.equal((await call('/daily-report/submissions/' + result.id + suffix, undefined, other)).status, 404);
    assert.equal((await call('/daily-report/submissions/' + result.id + suffix, undefined, admin)).status, 200);
  }
  const ownList = await (await call('/daily-report/submissions', undefined, owner)).json(); assert.equal(ownList.total, 1); assert.equal(ownList.scope, 'own');
  assert.equal((await (await call('/daily-report/submissions', undefined, other)).json()).total, 0);
  const all = await (await call('/daily-report/submissions', undefined, admin)).json(); assert.equal(all.total, 1); assert.equal(all.scope, 'all');
  assert.equal((await call('/daily-report/submissions/' + result.id + '/photos/1', undefined, owner)).status, 404);
});

test('same submission key retries and concurrent weather responses create one snapshot; changed body conflicts', async t => {
  const fixed = { source: 'Open-Meteo', sourceUrl: 'https://open-meteo.com/', date: '2026-10-07', latitude: 26.51, longitude: 106.68, kind: 'forecast', condition: '阴', temperatureMin: 10, temperatureMax: 20, fetchedAt: '2026-10-07T00:00:00Z' };
  let reads = 0;
  const { call, store, admin, report } = await fixture(t, { weatherService: async () => { reads++; await new Promise(r => setTimeout(r, 25)); return fixed; } });
  const data = report(); data.weatherAuto = true; data.weather = fixed.condition; data.weatherInfo = fixed; data.weatherLocation = { name: '隔离测试参考点', latitude: fixed.latitude, longitude: fixed.longitude };
  const body = { submissionId: randomUUID(), data };
  const responses = await Promise.all([call('/daily-report/submissions', body, admin), call('/daily-report/submissions', body, admin)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 201]);
  const results = await Promise.all(responses.map(r => r.json())); assert.equal(results[0].id, results[1].id);
  const before = reads; const retry = await call('/daily-report/submissions', body, admin); assert.equal(retry.status, 200); assert.equal(reads, before);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM daily_reports').get().n, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM daily_report_photos').get().n, 1);
  body.data.number = '已经修改的编号'; assert.equal((await call('/daily-report/submissions', body, admin)).status, 409);
});

test('invalid originals and failed photo insertion never leave a partial report or submission audit', async t => {
  const { call, store, admin, report } = await fixture(t);
  const data = report(); data.photos[0].base64 = Buffer.from('not-an-image').toString('base64');
  assert.equal((await call('/daily-report/submissions', { submissionId: randomUUID(), data }, admin)).status, 400);
  store.db.exec("CREATE TRIGGER fail_test_photo BEFORE INSERT ON daily_report_photos BEGIN SELECT RAISE(ABORT,'isolated test write failure'); END;");
  assert.equal((await call('/daily-report/submissions', { submissionId: randomUUID(), data: report() }, admin)).status, 500);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM daily_reports').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM daily_report_photos').get().n, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='submit'").get().n, 0);
});

test('list validates filters, paginates and supports literal searches without changing visibility', async t => {
  const { call, admin, report } = await fixture(t);
  for (const date of ['2026-10-07', '2026-10-08']) { const data = report(); data.reportDate = date; data.projectName = '100% 管网测试'; await call('/daily-report/submissions', { submissionId: randomUUID(), data }, admin); }
  const filtered = await (await call('/daily-report/submissions?date=2026-10-07&q=100%25', undefined, admin)).json(); assert.equal(filtered.total, 1);
  const first = await (await call('/daily-report/submissions?limit=1', undefined, admin)).json();
  const second = await (await call('/daily-report/submissions?limit=1&offset=1', undefined, admin)).json(); assert.equal(first.total, 2); assert.notEqual(first.items[0].id, second.items[0].id);
  for (const query of ['date=2026-02-30', 'limit=10000', 'offset=-1', 'authorId=someone']) assert.equal((await call('/daily-report/submissions?' + query, undefined, admin)).status, 400);
});

test('new desktop and mobile submissions reject combined sections atomically and identify the single section',async t=>{
 const f=await fixture(t),data=f.report(),multi={...data,sections:[data.sections[0],{...data.sections[0],name:'独立第二片区'}]},before=f.store.db.prepare('SELECT COUNT(*) n FROM daily_reports').get().n;
 for(const [path,extras] of [['/daily-report/submissions',{}],['/mobile/daily-report/submissions',{Authorization:'Bearer '+(await(await f.call('/mobile/login',{username:'admin-test',password:'only-for-test-1234'})).json()).token}]]){
  const r=await f.call(path,{submissionId:randomUUID(),data:multi},f.admin,extras);assert.equal(r.status,400);assert.match((await r.json()).error,/单独/);
 }
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM daily_reports').get().n,before);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM daily_report_photos').get().n,0);
 const r=await f.call('/daily-report/submissions',{submissionId:randomUUID(),data},f.admin);assert.equal(r.status,201);const receipt=await r.json();assert.equal(receipt.sectionName,data.sections[0].name);assert.equal(receipt.sectionCount,1);
 const list=await(await f.call('/daily-report/submissions?q='+encodeURIComponent(data.sections[0].name),undefined,f.admin)).json();assert.equal(list.items.length,1);assert.equal(list.items[0].id,receipt.id);
});

test('two sections on the same date commit separate records, originals and Word without leaking another section',async t=>{
 const f=await fixture(t),base=f.report(),saved=[];
 for(const name of ['【合成】独立片区甲','【合成】独立片区乙']){
  const data={...base,sections:[{...base.sections[0],name,todayNotes:name+'当天情况'}],photos:base.photos.map(p=>({...p,caption:name+'专属照片'})),nextPlan:name+'独立明日计划'};
  const r=await f.call('/daily-report/submissions',{submissionId:randomUUID(),data},f.admin);assert.equal(r.status,201);const item=await r.json();const word=Buffer.from(await(await f.call('/daily-report/submissions/'+item.id+'/word',undefined,f.admin)).arrayBuffer());saved.push({...item,word});
 }
 assert.notEqual(saved[0].id,saved[1].id);assert.notEqual(saved[0].documentSha256,saved[1].documentSha256);
 for(let i=0;i<2;i++){const parts=unzipSync(saved[i].word),xml=Buffer.from(parts['word/document.xml']).toString();assert.ok(xml.includes(saved[i].sectionName));assert.ok(!xml.includes(saved[1-i].sectionName));const detail=await(await f.call('/daily-report/submissions/'+saved[i].id,undefined,f.admin)).json();assert.equal(detail.data.sections.length,1);assert.equal(detail.photos[0].caption,saved[i].sectionName+'专属照片');}
 assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM daily_reports').get().n,2);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM daily_report_photos').get().n,2);
});

test('historical combined report remains searchable downloadable and replayable without being rewritten',async t=>{
 const f=await fixture(t),data=f.report(),submissionId=randomUUID();const first=await(await f.call('/daily-report/submissions',{submissionId,data},f.admin)).json();
 // Simulate an immutable pre-upgrade combined submission; no new route bypass exists.
 const {dailyReportSchema,generateDailyReport}=await import('../server/daily-report.mjs'),combined=dailyReportSchema.parse({...data,sections:[data.sections[0],{...data.sections[0],name:'历史合并第二片区'}]}),document=generateDailyReport(combined),digest=b=>createHash('sha256').update(b).digest('hex'),stored={...combined,photos:combined.photos.map(({base64,...p})=>p)};
 f.store.db.prepare('UPDATE daily_reports SET data=?,document=?,document_sha256=?,request_hash=? WHERE id=?').run(JSON.stringify(stored),document,digest(document),digest(JSON.stringify(combined)),first.id);
 const before=f.store.db.prepare('SELECT * FROM daily_reports WHERE id=?').get(first.id);const replay=await f.call('/daily-report/submissions',{submissionId,data:combined},f.admin);assert.equal(replay.status,200);assert.equal((await replay.json()).replayed,true);
 const detail=await(await f.call('/daily-report/submissions/'+first.id,undefined,f.admin)).json();assert.equal(detail.sectionCount,2);assert.equal(detail.sectionName,'');assert.equal(detail.data.sections.length,2);
 const list=await(await f.call('/daily-report/submissions?q='+encodeURIComponent('历史合并第二片区'),undefined,f.admin)).json();assert.equal(list.items.length,1);
 assert.deepEqual(Buffer.from(await(await f.call('/daily-report/submissions/'+first.id+'/word',undefined,f.admin)).arrayBuffer()),document);
 assert.equal((await f.call('/daily-report/submissions',{submissionId:randomUUID(),data:combined},f.admin)).status,400);assert.deepEqual(f.store.db.prepare('SELECT * FROM daily_reports WHERE id=?').get(first.id),before);
});
