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

test('seven archive categories retain explicit project WBS task original snapshots and never alter business cash stock or progress', async t => {
  const f = await fixture(t), before = (await f.call(f.pb, undefined, f.admin)).body;
  assert.equal(Object.keys(siteRecordCategories).length, 7);
  for (const category of Object.keys(siteRecordCategories)) { const r = await f.create(category), d = await f.detail(r); assert.equal(d.record.data.category, category); assert.deepEqual(d.record.snapshot.path.map(n => n.title), ['合成标段', '合成管网部位']); assert.equal(d.record.snapshot.task.id, f.task.id); }
  const after = (await f.call(f.pb, undefined, f.admin)).body;
  assert.deepEqual(after.finance, before.finance); assert.deepEqual(after.balances, before.balances); assert.deepEqual(after.items, before.items);
  assert.equal(after.history.filter(h => h.action.startsWith('site_')).every(h => h.kind === 'tasks'), true);
});

test('membership role and draft ownership restrictions apply before idempotent replay and across desktop mobile', async t => {
  const f = await fixture(t), body = { requestId: randomUUID(), data: f.data() }, r = await f.call(f.route, body, f.users.engineer.cookie); ok(r, 201); ok(await f.call(f.route, body, f.users.engineer.cookie));
  for (const n of ['viewer', 'outsider']) ok(await f.call(f.route, body, f.users[n].cookie), n === 'viewer' ? 403 : 404);
  const rec = r.body; assert.equal((await f.detail(rec, f.users.other.cookie)).writable, false);
  ok(await f.action(rec, '', { version: 1, data: f.data({ title: '他人不应修改' }) }, f.users.other.cookie, 'PUT'), 403);
  ok(await f.action(rec, '', { version: 1, data: f.data({ title: '经理可以核对草稿' }) }, f.users.manager.cookie, 'PUT'));
  ok(await f.post('/members', { userId: f.users.engineer.id, role: 'remove' }, f.admin, 'PUT')); ok(await f.call(f.route, body, f.users.engineer.cookie), 404);
});

test('cross project and malformed WBS/task/date/extra source fields are rejected without creating records', async t => {
  const f = await fixture(t);
  for (const extra of [{ wbsId: randomUUID() }, { taskId: randomUUID() }, { wbsId: '' }, { recordDate: '2026-02-30' }, { approvedAmount: 9999 }, { category: 'payments' }]) ok(await f.call(f.route, { requestId: randomUUID(), data: f.data(extra) }, f.users.engineer.cookie), 400);
  assert.equal((await f.call(f.route, undefined, f.admin)).body.total, 0);
  const p2 = randomUUID(); f.store.db.prepare('UPDATE engineering_task_wbs SET node_id=? WHERE project_id=? AND task_id=?').run(f.rootNode.id, f.pid, f.task.id);
  ok(await f.call(f.route, { requestId: randomUUID(), data: f.data() }, f.users.engineer.cookie), 400);
  const r = await f.create('hidden_work', f.users.engineer.cookie, { taskId: '' }); ok(await f.call('/engineering/projects/' + p2 + '/site-records/' + r.id, undefined, f.admin), 404);
});

test('draft edits preserve version history and list filtering pagination is literal and bounded', async t => {
  const f = await fixture(t), a = await f.create('site_measurement', f.users.engineer.cookie, { title: '100%_收方', recordDate: '2026-10-11' }), b = await f.create('construction_daily');
  ok(await f.action(a, '', { version: 1, data: f.data({ title: '更正标题', recordDate: '2026-10-11' }) }, f.users.engineer.cookie, 'PUT'));
  ok(await f.action(a, '', { version: 1, data: f.data() }, f.users.engineer.cookie, 'PUT'), 409);
  const d = await f.detail(a); assert.equal(d.events.find(e => e.action === 'site_record_create').data.title, '100%_收方'); assert.equal(d.events.find(e => e.action === 'site_record_edit').data.title, '更正标题');
  const list = await f.call(f.route + '?category=construction_daily&wbsId=' + f.node.id + '&from=2026-10-12&to=2026-10-12&q=' + encodeURIComponent('收方') + '&limit=1&offset=0', undefined, f.users.viewer.cookie); ok(list); assert.equal(list.body.total, 1); assert.equal(list.body.records[0].id, b.id); assert.equal(list.body.writable, false);
  for (const suffix of ['?limit=201', '?offset=-1', '?from=2026-10-13&to=2026-10-12', '?category=unknown', '?extra=1']) ok(await f.call(f.route + suffix, undefined, f.admin), 400);
});

test('original upload exact retries offset hashes and download bytes survive restart without duplicate rows or persisted payload', async t => {
  const f = await fixture(t), r = await f.create(), meta = { requestId: randomUUID(), version: 1, name: '原件.pdf', mime: 'application/pdf', byteCount: pdf.length, sha256: sha(pdf) };
  const u = await f.action(r, '/uploads', meta); ok(u, 201); const replay = await f.action(r, '/uploads', meta); ok(replay); assert.equal(replay.body.id, u.body.id);
  const chunk = { requestId: randomUUID(), offset: 0, base64: pdf.toString('base64') }; ok(await f.action(r, '/uploads/' + u.body.id + '/chunks', chunk)); ok(await f.action(r, '/uploads/' + u.body.id + '/chunks', chunk));
  assert.equal((await f.action(r, '/uploads/' + u.body.id + '/chunks', { offset: 0, base64: pdf.toString('base64') })).body.duplicate, true);
  ok(await f.action(r, '/uploads/' + u.body.id + '/chunks', { ...chunk, base64: Buffer.alloc(pdf.length, 1).toString('base64') }), 409);
  const finish = { requestId: randomUUID() }, c = await f.action(r, '/uploads/' + u.body.id + '/complete', finish); ok(c); ok(await f.action(r, '/uploads/' + u.body.id + '/complete', finish));
  await f.restart(); const d = await f.detail(r); assert.equal(d.files.length, 1); assert.equal(d.uploads[0].state, 'completed');
  const download = await f.call(f.route + '/' + r.id + '/files/' + c.body.id + '/download', undefined, f.users.viewer.cookie); ok(download); assert.deepEqual(download.bytes, pdf); assert.equal(download.headers.get('x-content-sha256'), sha(pdf));
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM engineering_site_chunks').get().n, 1);
  const receipts = f.store.db.prepare('SELECT fingerprint,result FROM engineering_requests').all(); assert.ok(!JSON.stringify(receipts).includes(pdf.toString('base64')));
  assert.ok(!JSON.stringify(d).includes('session_hash')); assert.ok(!JSON.stringify(d).includes('.part'));
});

test('chunk upload uses bounded one MiB blocks and resumes after confirmed lost response with exact original file', async t => {
  const f = await fixture(t), r = await f.create('work_videos'), bytes = Buffer.concat([mp4, Buffer.alloc(siteRecordLimits.chunkBytes + 17, 3)]), u = await f.startUpload(r, bytes, '步骤.mp4', 'video/mp4'); ok(u, 201);
  ok(await f.action(r, '/uploads/' + u.body.id + '/chunks', { offset: 0, base64: bytes.subarray(0, 32).toString('base64') }), 400);
  ok(await f.action(r, '/uploads/' + u.body.id + '/chunks', { offset: 0, base64: bytes.subarray(0, siteRecordLimits.chunkBytes).toString('base64') })); await f.restart();
  const status = await f.call(f.route + '/' + r.id + '/uploads/' + u.body.id, undefined, f.users.engineer.cookie); ok(status); assert.equal(status.body.offset, siteRecordLimits.chunkBytes);
  ok(await f.action(r, '/uploads/' + u.body.id + '/chunks', { offset: siteRecordLimits.chunkBytes, base64: bytes.subarray(siteRecordLimits.chunkBytes).toString('base64') })); const c = await f.action(r, '/uploads/' + u.body.id + '/complete', {}); ok(c);
  assert.deepEqual(readFileSync(f.finalPath(c.body.id)), bytes); assert.equal((await f.detail(r)).files[0].mime, 'video/mp4');
});

test('upload payload remains bound to original actor and current permission while old authenticated sessions cannot outlive logout', async t => {
  const f = await fixture(t), r = await f.create(), u = await f.startUpload(r); ok(u, 201);
  ok(await f.call(f.route + '/' + r.id + '/uploads/' + u.body.id, undefined, f.users.manager.cookie), 404);
  const mobile = await f.call('/mobile/login', { username: 'qa-engineer', password: f.password }); ok(mobile); const mr = f.route.replace('/engineering/', '/mobile/engineering/');
  ok(await f.call(mr + '/' + r.id + '/uploads/' + u.body.id, undefined, '', 'GET', { Authorization: 'Bearer ' + mobile.body.token }));
  const chunk = { requestId: randomUUID(), offset: 0, base64: pdf.toString('base64') }; ok(await f.action(r, '/uploads/' + u.body.id + '/chunks', chunk));
  f.store.db.prepare("UPDATE users SET role='viewer' WHERE id=?").run(f.users.engineer.id); ok(await f.action(r, '/uploads/' + u.body.id + '/chunks', chunk), 403);
  f.store.db.prepare("UPDATE users SET role='operator' WHERE id=?").run(f.users.engineer.id); ok(await f.call('/logout', {}, f.users.engineer.cookie)); ok(await f.action(r, '/uploads/' + u.body.id + '/complete', {}), 401);
});

test('same original actor fresh login resumes exact confirmed bytes once while other actor cannot resume and revoked current roles cannot replay', async t => {
  const f = await fixture(t), r = await f.create('work_videos'), bytes = Buffer.concat([mp4, Buffer.alloc(siteRecordLimits.chunkBytes + 100, 5)]), u = await f.startUpload(r, bytes, '恢复步骤.mp4', 'video/mp4'); ok(u, 201);
  const chunk = { requestId: randomUUID(), offset: 0, base64: bytes.subarray(0, siteRecordLimits.chunkBytes).toString('base64') }; ok(await f.action(r, '/uploads/' + u.body.id + '/chunks', chunk));
  ok(await f.call('/logout', {}, f.users.engineer.cookie)); ok(await f.action(r, '/uploads/' + u.body.id + '/chunks', chunk), 401);
  const login = await f.call('/login', { username: 'qa-engineer', password: f.password }); ok(login); const cookie = login.cookie, d = await f.detail(r, cookie); assert.equal(d.uploads[0].canResume, true); assert.equal(d.uploads[0].originalSessionActive, false);
  ok(await f.action(r, '/uploads/' + u.body.id + '/chunks', chunk, cookie)); ok(await f.action(r, '/uploads/' + u.body.id + '/complete', {}, f.users.manager.cookie), 404);
  ok(await f.action(r, '/uploads/' + u.body.id + '/chunks', { offset: siteRecordLimits.chunkBytes, base64: bytes.subarray(siteRecordLimits.chunkBytes).toString('base64') }, cookie)); const body = { requestId: randomUUID() }, complete = await f.action(r, '/uploads/' + u.body.id + '/complete', body, cookie); ok(complete);
  ok(await f.action(r, '/uploads/' + u.body.id + '/complete', body, cookie)); assert.equal((await f.detail(r, cookie)).files.length, 1); assert.deepEqual(readFileSync(f.finalPath(complete.body.id)), bytes);
  ok(await f.post('/members', { userId: f.users.engineer.id, role: 'viewer' }, f.admin, 'PUT')); ok(await f.action(r, '/uploads/' + u.body.id + '/complete', body, cookie), 403);
});

test('manager may reason-cancel abandoned other actor upload without resuming bytes and preserves draft history while active session stays protected', async t => {
  const f = await fixture(t), r = await f.create(), u = await f.startUpload(r); ok(u, 201); const before = await f.detail(r, f.users.manager.cookie); assert.equal(before.uploads[0].canResume, false); assert.equal(before.uploads[0].canCancel, false);
  ok(await f.action(r, '/uploads/' + u.body.id + '/cancel', { reason: '不能取消仍在上传的有效会话' }, f.users.manager.cookie), 409); ok(await f.call('/logout', {}, f.users.engineer.cookie));
  const next = await f.detail(r, f.users.manager.cookie); assert.equal(next.uploads[0].canCancel, true); assert.equal(next.uploads[0].requiresCancelReason, true);
  ok(await f.action(r, '/uploads/' + u.body.id + '/cancel', {}, f.users.manager.cookie), 400); ok(await f.action(r, '/uploads/' + u.body.id + '/chunks', { offset: 0, base64: pdf.toString('base64') }, f.users.manager.cookie), 404);
  ok(await f.action(r, '/uploads/' + u.body.id + '/cancel', { reason: '经办人已退出，取消未完成临时上传' }, f.users.manager.cookie)); const d = await f.detail(r, f.users.manager.cookie); assert.equal(d.usedFiles, 0); assert.equal(d.events.some(e => e.action === 'site_file_cancel' && e.note.includes('经办人已退出')), true); assert.equal(existsSync(f.partPath(u.body.id)), false);
  ok(await f.action(r, '/withdraw', { version: d.version, reason: '草稿不再提交，保留记录' }, f.users.manager.cookie)); assert.equal(siteRecordsPending(f.store, f.pid), false);
});

test('revoked uploader project access makes abandoned upload cancellable by manager without restoring uploader rights', async t => {
  const f = await fixture(t), r = await f.create(), u = await f.startUpload(r); ok(u, 201); ok(await f.post('/members', { userId: f.users.engineer.id, role: 'remove' }, f.admin, 'PUT'));
  ok(await f.action(r, '/uploads/' + u.body.id + '/chunks', { offset: 0, base64: pdf.toString('base64') }), 404);
  const d = await f.detail(r, f.users.manager.cookie); assert.equal(d.uploads[0].originalSessionActive, true); assert.equal(d.uploads[0].abandoned, true); assert.equal(d.uploads[0].canCancel, true);
  ok(await f.action(r, '/uploads/' + u.body.id + '/cancel', { reason: '原经办人项目授权已撤销，清理未完成上传' }, f.users.manager.cookie)); assert.equal((await f.detail(r, f.users.manager.cookie)).usedFiles, 0);
});

test('invalid file names formats canonical base64 size caps SHA and magic fail while original raw uploads remain unfinalized', async t => {
  const f = await fixture(t), r = await f.create();
  for (const extra of [{ name: '../bad.pdf' }, { name: 'CON.pdf' }, { name: 'fake.png', mime: 'application/pdf' }, { name: 'bad.exe' }, { byteCount: siteRecordLimits.maxImageBytes + 1 }, { sha256: 'A'.repeat(64) }]) ok(await f.startUpload(r, pdf, '原件.pdf', 'application/pdf', f.users.engineer.cookie, extra), extra.byteCount ? 413 : 400);
  const u = await f.startUpload(r, pdf, '原件.pdf', 'application/pdf', f.users.engineer.cookie, { sha256: '0'.repeat(64) }); ok(u, 201);
  for (const base64 of ['a===', 'aGVsbG8', 'AA=A', 'AB==']) ok(await f.action(r, '/uploads/' + u.body.id + '/chunks', { offset: 0, base64 }), 400);
  ok(await f.action(r, '/uploads/' + u.body.id + '/chunks', { offset: 1, base64: pdf.toString('base64') }), 409); ok(await f.action(r, '/uploads/' + u.body.id + '/chunks', { offset: 0, base64: pdf.toString('base64') })); ok(await f.action(r, '/uploads/' + u.body.id + '/complete', {}), 409);
  ok(await f.action(r, '/uploads/' + u.body.id + '/cancel', {})); assert.equal(existsSync(f.partPath(u.body.id)), false);
  const bad = Buffer.from('<html>Not a PDF original</html>'), v = await f.startUpload(r, bad); ok(v, 201); ok(await f.action(r, '/uploads/' + v.body.id + '/chunks', { offset: 0, base64: bad.toString('base64') })); ok(await f.action(r, '/uploads/' + v.body.id + '/complete', {}), 400); assert.equal((await f.detail(r)).files.length, 0);
});

test('document scan and daily categories accept safe Word PDF image originals and reject unsafe ZIP embedded macros and photo documents', async t => {
  const f = await fixture(t);
  for (const category of ['site_measurement', 'material_measurement', 'construction_daily', 'supervision_daily']) { const r = await f.create(category); await f.completeUpload(r, docx(), '合成日报.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'); }
  const r = await f.create('construction_daily');
  for (const extra of [{ 'word/vbaProject.bin': Buffer.from([1]) }, { 'word/embeddings/object.bin': Buffer.from([1]) }, { '../bad.xml': Buffer.from([1]) }]) { const b = docx(extra), u = await f.startUpload(r, b, '不安全.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'); ok(u, 201); ok(await f.action(r, '/uploads/' + u.body.id + '/chunks', { offset: 0, base64: b.toString('base64') })); ok(await f.action(r, '/uploads/' + u.body.id + '/complete', {}), 400); ok(await f.action(r, '/uploads/' + u.body.id + '/cancel', {})); }
  for (const category of ['work_photos', 'hidden_work']) { const a = await f.create(category); ok(await f.startUpload(a), 400); await f.completeUpload(a, png, '施工原图.png', 'image/png'); }
  const video = await f.create('work_videos'); ok(await f.startUpload(video, mp4, 'fake.png', 'image/png'), 400); const webm = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.from('synthetic webm header')]); await f.completeUpload(video, webm, '标识样本.webm', 'video/webm');
});

test('archive requires active original no pending sessions and frozen current source; withdrawal preserves archive metadata original bytes and history', async t => {
  const f = await fixture(t), r = await f.create(); ok(await f.archive(r), 409); const a = await f.completeUpload(r), pending = await f.startUpload(r, Buffer.concat([pdf, Buffer.from('second')]), '第二原件.pdf'); ok(pending, 201); ok(await f.archive(r), 409); ok(await f.action(r, '/uploads/' + pending.body.id + '/cancel', {}));
  f.store.db.prepare("UPDATE engineering_wbs SET version=version+1,data=json_set(data,'$.title','新的实际部位名称') WHERE id=?").run(f.node.id); ok(await f.archive(r), 409); const d = await f.detail(r); ok(await f.action(r, '', { version: d.version, data: d.record.data }, f.users.engineer.cookie, 'PUT'));
  const archived = await f.archive(r); ok(archived); const original = (await f.detail(r)).record;
  ok(await f.startUpload(r, png, '不能追加.png', 'image/png'), 409); ok(await f.action(r, '/files/' + a.id + '/remove', { version: archived.body.version, reason: '不能移除' }), 409); ok(await f.action(r, '', { version: archived.body.version, data: f.data() }, f.users.engineer.cookie, 'PUT'), 409);
  ok(await f.action(r, '/withdraw', { version: archived.body.version, reason: '扫描缺页，需要重新归档完整资料' })); const withdrawn = await f.detail(r);
  assert.equal(withdrawn.record.state, 'withdrawn'); assert.deepEqual(withdrawn.record.snapshot, original.snapshot); assert.equal(withdrawn.record.archived_at, original.archived_at); assert.equal(withdrawn.record.archive_note, original.archive_note); assert.deepEqual(readFileSync(f.finalPath(a.id)), pdf); assert.equal(withdrawn.events.some(e => e.state === 'archived'), true);
  ok(await f.action(r, '', { version: withdrawn.version, data: f.data() }, f.users.engineer.cookie, 'PUT'), 409); assert.equal(siteRecordsPending(f.store, f.pid), false);
});

test('soft removed originals remain downloadable count against historical record quota and cannot be replaced under a second hash receipt', async t => {
  const f = await fixture(t), r = await f.create(), a = await f.completeUpload(r), d = await f.detail(r);
  ok(await f.action(r, '/files/' + a.id + '/remove', { version: d.version, reason: '原件不完整，保留历史' })); const next = await f.detail(r); assert.equal(next.files[0].remove_reason, '原件不完整，保留历史'); assert.equal(next.usedFiles, 1); assert.equal(next.usedBytes, pdf.length);
  ok(await f.startUpload(r), 409); ok(await f.archive(r), 409); const download = await f.call(f.route + '/' + r.id + '/files/' + a.id + '/download', undefined, f.users.finance.cookie); ok(download); assert.deepEqual(download.bytes, pdf);
  ok(await f.action(r, '', { version: next.version, data: f.data({ category: 'work_videos' }) }, f.users.engineer.cookie, 'PUT'), 409);
});

test('record upload reservations enforce total size and file count and cancellation cannot destroy finalized original bytes', async t => {
  const f = await fixture(t), r = await f.create('work_videos');
  for (let i = 0; i < 4; i++) ok(await f.startUpload(r, mp4, '保留额度' + i + '.mp4', 'video/mp4', f.users.engineer.cookie, { byteCount: siteRecordLimits.maxVideoBytes, sha256: sha('quota' + i) }), 201);
  ok(await f.startUpload(r, mp4, '超过额度.mp4', 'video/mp4', f.users.engineer.cookie, { sha256: sha('over quota') }), 409);
  const a = await f.create(); for (let i = 0; i < 100; i++) ok(await f.startUpload(a, pdf, '份' + i + '.pdf', 'application/pdf', f.users.engineer.cookie, { sha256: sha('count' + i) }), 201);
  ok(await f.startUpload(a, pdf, '份101.pdf', 'application/pdf', f.users.engineer.cookie, { sha256: sha('count101') }), 409);
  const b = await f.create(), original = await f.completeUpload(b); ok(await f.action(b, '/uploads/' + original.uid + '/cancel', {}), 409); assert.deepEqual(readFileSync(f.finalPath(original.id)), pdf);
});

test('authenticated downloads and five minute grants implement full single range suffix HEAD and invalid range without leaking storage or bypassing revoked ACL', async t => {
  const f = await fixture(t), r = await f.create('work_videos'), a = await f.completeUpload(r, mp4, '合成步骤.mp4', 'video/mp4'), path = f.route + '/' + r.id + '/files/' + a.id;
  for (const [range, start, end] of [['bytes=2-9', 2, 10], ['bytes=20-', 20, mp4.length], ['bytes=-9', mp4.length - 9, mp4.length]]) { const d = await f.call(path + '/download', undefined, f.users.viewer.cookie, 'GET', { Range: range }); ok(d, 206); assert.deepEqual(d.bytes, mp4.subarray(start, end)); assert.equal(d.headers.get('accept-ranges'), 'bytes'); }
  for (const range of ['bytes=1-2,4-5', 'bytes=999999-', 'bytes=-0', 'garbage', 'bytes=-']) ok(await f.call(path + '/download', undefined, f.admin, 'GET', { Range: range }), 416);
  const head = await f.call(path + '/download', undefined, f.admin, 'HEAD'); ok(head); assert.equal(head.bytes.length, 0); assert.equal(Number(head.headers.get('content-length')), mp4.length);
  const request = { requestId: randomUUID() }, grant = await f.call(path + '/media-grants', request, f.users.viewer.cookie); ok(grant); assert.ok(grant.body.expiresAt > Date.now() && grant.body.expiresAt <= Date.now() + 300000); assert.equal((await f.call(path + '/media-grants', request, f.users.viewer.cookie)).body.url, grant.body.url);
  assert.deepEqual([grant.body.fileId, grant.body.name, grant.body.mime, grant.body.byteCount, grant.body.sha256], [a.id, '合成步骤.mp4', 'video/mp4', mp4.length, sha(mp4)]);
  const mediaPath = new URL(grant.body.url).pathname.slice(4), media = await f.call(mediaPath, undefined, '', 'GET', { Range: 'bytes=0-23' }); ok(media, 206); assert.deepEqual(media.bytes, mp4.subarray(0, 24)); assert.match(media.headers.get('content-disposition'), /^inline;/);
  ok(await f.post('/members', { userId: f.users.viewer.id, role: 'remove' }, f.admin, 'PUT')); ok(await f.call(mediaPath, undefined, '', 'GET', { Range: 'bytes=24-' }), 404);
  assert.ok(!JSON.stringify((await f.detail(r)).record).includes(new URL(grant.body.url).pathname));
});

test('grant expiry logout disabled user and original session revoke fail even while another user session is valid', async t => {
  const f = await fixture(t), r = await f.create(), a = await f.completeUpload(r), route = f.route + '/' + r.id + '/files/' + a.id + '/media-grants';
  const media = async who => { const g = await f.call(route, { requestId: randomUUID() }, who); ok(g); return new URL(g.body.url).pathname.slice(4); };
  const expired = await media(f.users.engineer.cookie); f.store.db.prepare('UPDATE engineering_site_media_grants SET expires_at=?').run(Date.now() - 1); ok(await f.call(expired), 401);
  const disabled = await media(f.users.finance.cookie); f.store.db.prepare('UPDATE users SET active=0 WHERE id=?').run(f.users.finance.id); ok(await f.call(disabled), 401);
  const logout = await media(f.users.engineer.cookie); ok(await f.call('/logout', {}, f.users.engineer.cookie)); ok(await f.call(logout, undefined, f.admin), 401);
  const fault = await media(f.admin); f.store.db.exec('DROP TABLE engineering_site_media_grants'); const oldLog = console.error; let logs = 0; console.error = () => { logs++; };
  try { ok(await f.call(fault), 503); } finally { console.error = oldLog; } assert.equal(logs, 0, 'temporary bearer path must not enter global unexpected-error logs');
});

test('mobile upload grant download operates without cookie and duplicate replay cannot cross original mobile session', async t => {
  const f = await fixture(t), login = await f.call('/mobile/login', { username: 'qa-engineer', password: f.password }); ok(login); const header = { Authorization: 'Bearer ' + login.body.token }, route = f.route.replace('/engineering/', '/mobile/engineering/'), create = { requestId: randomUUID(), data: f.data({ category: 'supervision_daily' }) };
  const r = await f.call(route, create, '', 'POST', header); ok(r, 201); f.store.db.prepare("UPDATE engineering_site_records SET data=json_remove(data,'$.uploadPolicy') WHERE id=?").run(r.body.id);const u = await f.call(route + '/' + r.body.id + '/uploads', { requestId: randomUUID(), version: 1, name: '监理.pdf', mime: 'application/pdf', byteCount: pdf.length, sha256: sha(pdf) }, '', 'POST', header); ok(u, 201);
  ok(await f.call(route + '/' + r.body.id + '/uploads/' + u.body.id + '/chunks', { requestId: randomUUID(), offset: 0, base64: pdf.toString('base64') }, '', 'POST', header)); const c = await f.call(route + '/' + r.body.id + '/uploads/' + u.body.id + '/complete', { requestId: randomUUID() }, '', 'POST', header); ok(c);
  const g = await f.call(route + '/' + r.body.id + '/files/' + c.body.id + '/media-grants', { requestId: randomUUID() }, '', 'POST', header); ok(g); ok(await f.call(new URL(g.body.url).pathname.slice(4)), 200); await f.restart(); ok(await f.call(route, create, '', 'POST', header));
  ok(await f.call('/mobile/logout', {}, '', 'POST', header)); ok(await f.call(new URL(g.body.url).pathname.slice(4)), 401);
});

test('chunk file tail rollback and database write failure preserve confirmed offset and retry identity', async t => {
  const f = await fixture(t), r = await f.create(), u = await f.startUpload(r); ok(u, 201);
  appendFileSync(f.partPath(u.body.id), Buffer.from('uncommitted crash tail')); const status = await f.call(f.route + '/' + r.id + '/uploads/' + u.body.id, undefined, f.users.engineer.cookie); ok(status); assert.equal(statSync(f.partPath(u.body.id)).size, 0);
  f.store.db.exec("CREATE TRIGGER site_chunk_fault BEFORE INSERT ON engineering_site_chunks BEGIN SELECT RAISE(ABORT,'synthetic chunk write failure'); END");
  const b = { requestId: randomUUID(), offset: 0, base64: pdf.toString('base64') }; ok(await f.action(r, '/uploads/' + u.body.id + '/chunks', b), 500); assert.equal(statSync(f.partPath(u.body.id)).size, 0); assert.equal(f.store.db.prepare('SELECT offset FROM engineering_site_uploads WHERE id=?').get(u.body.id).offset, 0);
  assert.equal(f.store.db.prepare('SELECT 1 FROM engineering_requests WHERE request_id=?').get(b.requestId), undefined); f.store.db.exec('DROP TRIGGER site_chunk_fault'); ok(await f.action(r, '/uploads/' + u.body.id + '/chunks', b)); assert.deepEqual(readFileSync(f.partPath(u.body.id)), pdf);
});

test('completion DB failure rolls renamed file back and interrupted rename after process restart safely recovers preserved original', async t => {
  const f = await fixture(t), r = await f.create(), u = await f.startUpload(r); ok(u, 201); ok(await f.action(r, '/uploads/' + u.body.id + '/chunks', { offset: 0, base64: pdf.toString('base64') }));
  f.store.db.exec("CREATE TRIGGER site_finish_fault BEFORE INSERT ON engineering_site_files BEGIN SELECT RAISE(ABORT,'synthetic final index failure'); END"); const b = { requestId: randomUUID() }; ok(await f.action(r, '/uploads/' + u.body.id + '/complete', b), 500);
  assert.equal(existsSync(f.finalPath(u.body.id)), false); assert.deepEqual(readFileSync(f.partPath(u.body.id)), pdf); assert.equal((await f.detail(r)).files.length, 0); f.store.db.exec('DROP TRIGGER site_finish_fault');
  renameSync(f.partPath(u.body.id), f.finalPath(u.body.id)); await f.restart(); ok(await f.call(f.route + '/' + r.id + '/uploads/' + u.body.id, undefined, f.users.engineer.cookie)); ok(await f.action(r, '/uploads/' + u.body.id + '/complete', b)); assert.deepEqual(readFileSync(f.finalPath(u.body.id)), pdf); assert.equal((await f.detail(r)).files.length, 1);
});

test('missing shortened or conflicting storage fails closed and draft pending records block project close task cancellation without mutating older originals', async t => {
  const f = await fixture(t), r = await f.create(), u = await f.startUpload(r); ok(u, 201); ok(await f.action(r, '/uploads/' + u.body.id + '/chunks', { offset: 0, base64: pdf.toString('base64') })); writeFileSync(f.partPath(u.body.id), Buffer.from('short'));
  ok(await f.call(f.route + '/' + r.id + '/uploads/' + u.body.id, undefined, f.users.engineer.cookie), 503); assert.equal(siteRecordsPending(f.store, f.pid, f.task.id), true);
  const task = (await f.call(f.pb, undefined, f.admin)).body.items.find(i => i.id === f.task.id); const cancel = await f.post('/items/' + f.task.id + '/state', { version: task.version, state: 'cancelled', note: '应阻止未归档资料任务关闭' }); ok(cancel, 409); assert.match(cancel.body.error, /施工资料/);
  f.store.db.prepare("UPDATE engineering_items SET state='completed' WHERE id=?").run(f.task.id); const p = await f.call(f.pb, undefined, f.admin); ok(p); const close = await f.post('/state', { version: p.body.project.version, state: 'completed', note: '资料未归档' }); ok(close, 409); assert.match(close.body.error, /暂不能完成/);
  assert.deepEqual((await f.detail(r)).record.data, f.data());
});

test('withdrawn empty drafts close their pending chain without fabricating an archived document or approval', async t => {
  const f = await fixture(t), r = await f.create(); assert.equal(siteRecordsPending(f.store, f.pid), true); const d = await f.detail(r); assert.equal(d.canWithdraw, true);
  ok(await f.action(r, '/withdraw', { version: d.version, reason: '误建草稿，保留撤回历史' })); const next = await f.detail(r); assert.equal(next.record.state, 'withdrawn'); assert.equal(next.record.archived_at, null); assert.equal(next.files.length, 0); assert.equal(siteRecordsPending(f.store, f.pid), false);
  f.store.db.prepare("UPDATE engineering_items SET state='completed' WHERE id=?").run(f.task.id); const p = (await f.call(f.pb, undefined, f.admin)).body.project; ok(await f.post('/state', { version: p.version, state: 'completed', note: '合成工程无剩余资料待办' }));
});

test('archive rehashes originals and rejects same length storage corruption while preserving historic immutable metadata', async t => {
  const f = await fixture(t), r = await f.create(), a = await f.completeUpload(r), before = (await f.detail(r)).record; writeFileSync(f.finalPath(a.id), Buffer.alloc(pdf.length, 9));
  ok(await f.archive(r), 503); assert.deepEqual((await f.detail(r)).record, before); assert.equal((await f.detail(r)).files[0].sha256, sha(pdf));
});


async function stepPhoto(f,r,stepId,index=0,mime='image/png') {
  const bytes=await sharp({create:{width:index%2?320:640,height:index%2?640:320,channels:3,background:{r:20+index*15,g:90,b:180}}}).png().toBuffer();
  const u=await f.startUpload(r,bytes,'工序'+index+'.png',mime,f.users.engineer.cookie,{stepId});ok(u,201);
  ok(await f.action(r,'/uploads/'+u.body.id+'/chunks',{offset:0,base64:bytes.toString('base64')}));
  const done=await f.action(r,'/uploads/'+u.body.id+'/complete',{});ok(done);return {id:done.body.id,bytes};
}

test('ten shared steps automatically generate immutable one-page Word on archive; repeat requests and unchanged snapshots reuse the version',async t=>{
  const f=await fixture(t),r=await f.create('work_photos',f.users.engineer.cookie,{workInfo:{road:'合成测试道路',location:'K0+000～K0+100',number:'QA-01',completedAt:'2026-10-18'}});
  for(let i=0;i<10;i++)await stepPhoto(f,r,siteWorkSteps[i].id,i);
  const d=await f.detail(r);assert.equal(d.files.filter(x=>x.representative).length,10);
  const request={requestId:randomUUID(),version:d.version,note:'合成资料归档'};
  ok(await f.call(f.route+'/'+r.id+'/archive',request,f.users.engineer.cookie));
  ok(await f.call(f.route+'/'+r.id+'/archive',request,f.users.engineer.cookie));
  const saved=await f.detail(r);assert.equal(saved.exports.length,1);assert.equal(saved.record.state,'archived');assert.equal(saved.exports[0].snapshot.missingSteps.length,0);
  const e=saved.exports[0],download=await f.call(f.route+'/'+r.id+'/exports/'+e.id+'/download',undefined,f.users.viewer.cookie);ok(download);assert.equal(sha(download.bytes),e.sha256);
  const parts=unzipSync(download.bytes),document=strFromU8(parts['word/document.xml']);
  assert.equal(Object.keys(parts).filter(k=>k.startsWith('word/media/')).length,10);
  for(const step of siteWorkSteps)assert.ok(document.includes(step.name));
  assert.match(document,/11906/);assert.match(document,/16838/);assert.doesNotMatch(document,/\{\{/);
  assert.equal((document.match(/<w:drawing>/g)||[]).length,10);
  const regenerate=await f.action(r,'/exports',{version:saved.version});ok(regenerate);assert.equal(regenerate.body.exportId,e.id);
  ok(await f.action(r,'/withdraw',{version:(await f.detail(r)).version,reason:'保留历史'}));
  const historic=await f.call(f.route+'/'+r.id+'/exports/'+e.id+'/download',undefined,f.users.viewer.cookie);ok(historic);assert.deepEqual(historic.bytes,download.bytes);
});

test('legacy unassigned originals remain byte-identical and require explicit step organization before generation or archive',async t=>{
  const f=await fixture(t),r=await f.create('work_photos'),a=await f.completeUpload(r,png,'旧照片.png','image/png');
  const d=await f.detail(r);assert.equal(d.files[0].step_id,'');
  ok(await f.action(r,'/exports',{version:d.version}),409);ok(await f.archive(r),409);
  ok(await f.action(r,'/files/'+a.id+'/step',{version:d.version,stepId:'unknown',representative:true}),400);
  ok(await f.action(r,'/files/'+a.id+'/step',{version:d.version,stepId:'step01',representative:true}));
  assert.deepEqual(readFileSync(f.finalPath(a.id)),png);
  // Remove the compatibility fixture's intentionally minimal PNG, then use a truly decodable representative.
  ok(await f.action(r,'/files/'+a.id+'/remove',{version:(await f.detail(r)).version,reason:'换选有效合成照片'}));
  await stepPhoto(f,r,'step01',1);ok(await f.archive(r));
  assert.equal((await f.detail(r)).exports[0].snapshot.missingSteps.length,9);
});

test('representative selection, removed covers and edits retain old Word versions and require explicit replacement',async t=>{
  const f=await fixture(t),r=await f.create('work_photos'),first=await stepPhoto(f,r,'step01',1),second=await stepPhoto(f,r,'step01',2);
  let d=await f.detail(r);ok(await f.action(r,'/exports',{version:d.version}),201);d=await f.detail(r);const previous=d.exports[0];
  const old=await f.call(f.route+'/'+r.id+'/exports/'+previous.id+'/download',undefined,f.admin);ok(old);
  ok(await f.action(r,'/files/'+first.id+'/remove',{version:d.version,reason:'代表照片需更换'}));
  ok(await f.action(r,'/exports',{version:(await f.detail(r)).version}),409);
  ok(await f.action(r,'/files/'+second.id+'/step',{version:(await f.detail(r)).version,stepId:'step01',representative:true}));
  ok(await f.action(r,'/exports',{version:(await f.detail(r)).version}),201);
  d=await f.detail(r);assert.equal(d.exports.length,2);assert.notEqual(d.exports[0].sha256,previous.sha256);
  assert.deepEqual((await f.call(f.route+'/'+r.id+'/exports/'+previous.id+'/download',undefined,f.admin)).bytes,old.bytes);
  ok(await f.action(r,'/files/'+second.id+'/step',{version:1,stepId:'step02',representative:true}),409);
  assert.deepEqual(readFileSync(f.finalPath(first.id)),first.bytes);
});

test('photo and video records share fixed step IDs and related scope; videos cannot be print representatives',async t=>{
  const f=await fixture(t),p=await f.create('work_photos'),v=await f.create('work_videos');
  const u=await f.startUpload(v,mp4,'步骤.mp4','video/mp4',f.users.engineer.cookie,{stepId:'step02'});ok(u,201);
  assert.equal((await f.call(f.route+'/'+v.id+'/uploads/'+u.body.id,undefined,f.users.engineer.cookie)).body.stepId,'step02');
  ok(await f.action(v,'/uploads/'+u.body.id+'/chunks',{offset:0,base64:mp4.toString('base64')}));const done=await f.action(v,'/uploads/'+u.body.id+'/complete',{});ok(done);
  let d=await f.detail(v);assert.equal(d.files[0].step_id,'step02');assert.ok(d.related.some(x=>x.id===p.id));assert.deepEqual(d.steps,siteWorkSteps);
  ok(await f.action(v,'/files/'+done.body.id+'/step',{version:d.version,stepId:'step03',representative:true}),400);
  ok(await f.action(v,'/exports',{version:d.version}),409);ok(await f.archive(v));
  d=await f.detail(v);ok(await f.action(v,'/files/'+done.body.id+'/step',{version:d.version,stepId:'step04'}),409);
});

test('Word generation and step writes preserve role, owner and revoked grant restrictions on desktop and mobile',async t=>{
  const f=await fixture(t),r=await f.create('work_photos'),a=await stepPhoto(f,r,'step01',1);let d=await f.detail(r);
  ok(await f.action(r,'/exports',{version:d.version},f.users.other.cookie),403);
  ok(await f.action(r,'/exports',{version:d.version},f.users.viewer.cookie),403);
  ok(await f.action(r,'/files/'+a.id+'/step',{version:d.version,stepId:'step02'},f.users.other.cookie),403);
  const login=await f.call('/mobile/login',{username:'qa-engineer',password:f.password});ok(login);const headers={Authorization:'Bearer '+login.body.token},mobile=f.route.replace('/engineering/','/mobile/engineering/');
  const body={requestId:randomUUID(),version:d.version};const generated=await f.call(mobile+'/'+r.id+'/exports',body,'','POST',headers);ok(generated,201);ok(await f.call(mobile+'/'+r.id+'/exports',body,'','POST',headers));
  const e=(await f.detail(r)).exports[0],g=await f.call(mobile+'/'+r.id+'/exports/'+e.id+'/media-grants',{requestId:randomUUID()},'','POST',headers);ok(g);
  const path=new URL(g.body.url).pathname.slice(4);const stream=await f.call(path,undefined,'','GET',{Range:'bytes=0-63'});ok(stream,206);assert.equal(stream.bytes.length,64);
  ok(await f.call('/mobile/logout',{},'','POST',headers));ok(await f.call(path),401);
  ok(await f.call(f.route+'/'+r.id+'/exports/'+e.id+'/download'),401);
  ok(await f.call(f.route+'/'+r.id+'/exports/'+e.id+'/download',undefined,f.users.outsider.cookie),404);
  ok(await f.action(r,'/files/'+a.id+'/step',{version:d.version,stepId:'step02',representative:true}));
  ok(await f.action(r,'/exports',{version:d.version}),409);
});

test('invalid image decoding and corrupted originals never archive or create a misleading generated Word',async t=>{
  const f=await fixture(t),r=await f.create('work_photos'),a=await f.completeUpload(r,png,'损坏合成照片.png','image/png');
  ok(await f.action(r,'/files/'+a.id+'/step',{version:(await f.detail(r)).version,stepId:'step01',representative:true}));
  ok(await f.archive(r),422);let d=await f.detail(r);assert.equal(d.record.state,'draft');assert.equal(d.exports.length,0);
  writeFileSync(f.finalPath(a.id),Buffer.alloc(png.length,9));ok(await f.action(r,'/exports',{version:d.version}),503);
});

test('print metadata rejects XML control characters and never records a broken document',async t=>{
 const f=await fixture(t);
 ok(await f.call(f.route,{requestId:randomUUID(),data:f.data({category:'work_photos',workInfo:{road:'无效\u0000路名',location:'',number:'',completedAt:''}})},f.users.engineer.cookie),400);
 const r=await f.create('work_photos');await stepPhoto(f,r,'step01',1);
 const project=JSON.parse(f.store.db.prepare('SELECT data FROM engineering_projects WHERE id=?').get(f.pid).data);project.name='无效\u0000工程';f.store.db.prepare('UPDATE engineering_projects SET data=? WHERE id=?').run(JSON.stringify(project),f.pid);
 ok(await f.action(r,'/exports',{version:(await f.detail(r)).version}),400);
 assert.equal((await f.detail(r)).exports.length,0);
 const {generateSitePhotoDocument}=await import('../server/site-photo-document.mjs');
 await assert.rejects(generateSitePhotoDocument({PROJECT:'无效\u0000工程',ADDRESS:'',LOCATION:'',NUMBER:'',DATE:''},[]),/无效字符/);
});

test('image conversion rechecks the live session, enabled user and latest role before committing Word or archive',async t=>{
 for(const change of ['logout','disabled','demoted']) {
  const f=await fixture(t),r=await f.create('work_photos');
  const bytes=await sharp({create:{width:5000,height:5000,channels:3,background:'#345678'}}).png().toBuffer();
  const u=await f.startUpload(r,bytes,'异步撤权测试.png','image/png',f.users.engineer.cookie,{stepId:'step01'});ok(u,201);
  for(let offset=0;offset<bytes.length;offset+=siteRecordLimits.chunkBytes)ok(await f.action(r,'/uploads/'+u.body.id+'/chunks',{offset,base64:bytes.subarray(offset,offset+siteRecordLimits.chunkBytes).toString('base64')}));
  ok(await f.action(r,'/uploads/'+u.body.id+'/complete',{}));const d=await f.detail(r);
  let ended=false;const pending=f.action(r,'/archive',{version:d.version}).finally(()=>{ended=true;});
  const until=Date.now()+4000;while(!ended&&sharp.counters().process===0&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,1));
  assert.ok(!ended&&sharp.counters().process>0,'must revoke while the actual image renderer is running');
  if(change==='logout')f.store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(f.users.engineer.id);
  if(change==='disabled')f.store.db.prepare('UPDATE users SET active=0 WHERE id=?').run(f.users.engineer.id);
  if(change==='demoted')f.store.db.prepare("UPDATE users SET role='viewer' WHERE id=?").run(f.users.engineer.id);
  const result=await pending;ok(result,change==='demoted'?403:401);
  const saved=await f.detail(r,f.admin);assert.equal(saved.exports.length,0);assert.equal(saved.record.state,'draft');
 }
});

const supervisionBody = extra => ({number:'JL-20261019',unit:'合成监理单位',contractor:'合成施工单位',weather:'晴，20℃',recorder:'合成记录人',chief:'合成复核人',construction:'管道安装 20 米\n沟槽回填按记录执行。',inspection:'巡视管线接口；旁站记录 JL-PZ-01。',materials:'砂料见证取样，结果待出。',acceptance:'隐蔽验收记录待签认，不代表已验收。',qualitySafety:'发现一处围挡缺口，已通知整改。',rectification:'整改复查安排在下一工作日。',coordination:'协调材料到场时间。',...extra});

test('online supervision drafts allow incomplete input but block generation/archive until explicitly completed; legacy upload-only records remain usable',async t=>{
  const f=await fixture(t),r=await f.create('supervision_daily',f.users.engineer.cookie,{supervision:{}});
  assert.equal((await f.detail(r)).record.data.supervision.unit,'');
  const invalid=await f.action(r,'/exports',{version:1});ok(invalid,400);assert.match(invalid.body.error,/监理单位/);
  ok(await f.archive(r),400);assert.equal((await f.detail(r)).record.state,'draft');assert.equal((await f.detail(r)).exports.length,0);
  const legacy=await f.create('supervision_daily');await f.completeUpload(legacy,pdf,'监理扫描.pdf');ok(await f.archive(legacy));assert.equal((await f.detail(legacy)).exports.length,0);
});

test('online supervision saves and generates immutable Word without uploaded files; archive deduplicates and survives restart and withdrawal',async t=>{
  const f=await fixture(t),body=supervisionBody({construction:'接口 <复核> & $& 保留原文\n第二行 😀'}),r=await f.create('supervision_daily',f.users.engineer.cookie,{title:'监理日报 <合成>',supervision:body});
  const b={requestId:randomUUID(),version:1},a=await f.action(r,'/exports',b);ok(a,201);
  const replay=await f.action(r,'/exports',b);ok(replay);assert.equal(replay.body.exportId,a.body.exportId);
  const repeat=await f.action(r,'/exports',{version:1});ok(repeat);assert.equal(repeat.body.unchanged,true);
  let d=await f.detail(r);assert.equal(d.files.length,0);assert.equal(d.exports.length,1);assert.equal(d.exports[0].snapshot.kind,'supervision_daily');assert.equal(d.exports[0].snapshot.record.supervision.construction,body.construction);
  assert.match(d.exports[0].snapshot.templateSha256,/^[0-9a-f]{64}$/);assert.match(d.exports[0].snapshot.layoutSha256,/^[0-9a-f]{64}$/);
  const path=f.route+'/'+r.id+'/exports/'+a.body.exportId+'/download',download=await f.call(path,undefined,f.users.viewer.cookie);ok(download);
  const xml=strFromU8(unzipSync(download.bytes)['word/document.xml']);assert.match(xml,/&lt;复核&gt; &amp; \$&amp;/);assert.match(xml,/<w:br\/>/);assert.ok(xml.includes('第二行 😀'));assert.ok(!xml.includes('{{'));assert.equal(sha(download.bytes),d.exports[0].sha256);
  ok(await f.archive(r));d=await f.detail(r);assert.equal(d.record.state,'archived');assert.equal(d.exports.length,1);
  ok(await f.action(r,'',{version:d.version,data:f.data({category:'supervision_daily',supervision:supervisionBody({inspection:'不应改写'})})},f.users.engineer.cookie,'PUT'),409);
  await f.restart();assert.equal((await f.detail(r)).exports.length,1);
  ok(await f.action(r,'/withdraw',{version:(await f.detail(r)).version,reason:'合成更正'}));
  const old=await f.call(path,undefined,f.users.engineer.cookie);ok(old);assert.equal(sha(old.bytes),sha(download.bytes));
});

test('supervision archive automatically generates current Word; edits produce new historical snapshot and cannot change category or remove body',async t=>{
  const f=await fixture(t),r=await f.create('supervision_daily',f.users.engineer.cookie,{supervision:supervisionBody()});
  ok(await f.action(r,'/exports',{version:1}),201);const first=(await f.detail(r)).exports[0];
  ok(await f.action(r,'',{version:1,data:f.data({category:'supervision_daily',supervision:supervisionBody({inspection:'更正后的巡视记录'})})},f.users.engineer.cookie,'PUT'));
  ok(await f.action(r,'/exports',{version:1}),409);ok(await f.archive(r));
  const d=await f.detail(r);assert.equal(d.exports.length,2);assert.equal(d.exports[1].id,first.id);assert.equal(d.exports[1].snapshot.record.supervision.inspection,supervisionBody().inspection);assert.equal(d.exports[0].snapshot.record.supervision.inspection,'更正后的巡视记录');
  const other=await f.create('supervision_daily',f.users.engineer.cookie,{supervision:supervisionBody()});ok(await f.action(other,'/exports',{version:1}),201);
  for(const data of [f.data({category:'work_photos'}),f.data({category:'supervision_daily'})])ok(await f.action(other,'',{version:1,data},f.users.engineer.cookie,'PUT'),409);
});

test('supervision generation enforces ownership, membership and read-only roles before replay; mobile bearer uses existing export routes',async t=>{
  const f=await fixture(t),r=await f.create('supervision_daily',f.users.engineer.cookie,{supervision:supervisionBody()}),b={requestId:randomUUID(),version:1};
  for(const [n,status]of [['other',403],['viewer',403],['outsider',404]])ok(await f.action(r,'/exports',b,f.users[n].cookie),status);
  const mobile=(await f.call('/mobile/login',{username:'qa-engineer',password:f.password})).body;const route=f.route.replace('/engineering','/mobile/engineering')+'/'+r.id;
  const g=await f.call(route+'/exports',b,'','POST',{Authorization:'Bearer '+mobile.token});ok(g,201);
  const grant=await f.call(route+'/exports/'+g.body.exportId+'/media-grants',{requestId:randomUUID()},'','POST',{Authorization:'Bearer '+mobile.token});ok(grant);assert.match(grant.body.name,/监理日报_/);
  const media=await fetch(grant.body.url);assert.equal(media.status,200);assert.equal(sha(Buffer.from(await media.arrayBuffer())),grant.body.sha256);
  ok(await f.post('/members',{userId:f.users.engineer.id,role:'remove'},f.admin,'PUT'));ok(await f.action(r,'/exports',b),404);assert.equal((await fetch(grant.body.url)).status,404);
});

test('supervision JSON rejects wrong category, unknown fields, controls and oversize body; no financial stock progress side effects',async t=>{
  const f=await fixture(t),before=(await f.call(f.pb,undefined,f.admin)).body;
  for(const extra of [{category:'hidden_work',supervision:supervisionBody()},{category:'supervision_daily',supervision:supervisionBody({unit:'bad\u0000'})},{category:'supervision_daily',supervision:supervisionBody({construction:'长'.repeat(2001)})},{category:'supervision_daily',supervision:{...supervisionBody(),approval:'假审批'}}])ok(await f.call(f.route,{requestId:randomUUID(),data:f.data(extra)},f.users.engineer.cookie),400);
  const r=await f.create('supervision_daily',f.users.engineer.cookie,{supervision:supervisionBody()});ok(await f.archive(r));const after=(await f.call(f.pb,undefined,f.admin)).body;assert.deepEqual(after.finance,before.finance);assert.deepEqual(after.balances,before.balances);assert.deepEqual(after.items,before.items);
});

test('supervision attached originals are preserved and snapshotted; pending uploads and corrupt storage block generation and archive',async t=>{
  const f=await fixture(t),r=await f.create('supervision_daily',f.users.engineer.cookie,{supervision:supervisionBody()});
  const u=await f.startUpload(r);ok(u,201);ok(await f.archive(r),409);assert.equal((await f.detail(r)).exports.length,0);
  ok(await f.action(r,'/uploads/'+u.body.id+'/cancel',{}));const file=await f.completeUpload(r,pdf,'监理依据.pdf');ok(await f.action(r,'/exports',{version:(await f.detail(r)).version}),201);
  const first=(await f.detail(r)).exports[0];assert.equal(first.snapshot.files[0].sha256,sha(pdf));assert.equal(first.snapshot.files[0].id,file.id);
  writeFileSync(f.finalPath(file.id),Buffer.from('corrupt'));ok(await f.archive(r),503);assert.equal((await f.detail(r)).record.state,'draft');
  writeFileSync(f.finalPath(file.id),pdf);ok(await f.archive(r));assert.equal(sha(readFileSync(f.finalPath(file.id))),sha(pdf));
});

async function submittedDaily(f,cookie=f.users.engineer.cookie,photos=[]){
  const section={name:'合成施工段',kind:'pipeline',designQuantity:'100',todayProgress:'10',cumulativeProgress:'10',works:[],todayNotes:'合成管道安装记录',machinery:'测试机械',workers:'2',security:'1',tomorrow:'继续接口检查',procedures:'待核实',difficulties:'待协调'};
  const data={projectName:'原施工日报合成工程',region:'合成区域',reportDate:'2026-10-12',number:'QA-DAILY',weather:'晴',sections:[section],nextPlan:'合成次日计划',otherItems:'非真实工程',photos:photos.map((bytes,i)=>({name:'原照片'+i+'.png',caption:'合成照片'+i,mime:'image/png',base64:bytes.toString('base64'),width:1,height:1}))};
  const r=await f.call('/daily-report/submissions',{submissionId:randomUUID(),data},cookie);ok(r,201);return r.body;
}

test('daily report import copies exact original Word and unique original photos atomically with source trace and idempotent replay',async t=>{
  const f=await fixture(t),source=await submittedDaily(f,f.users.engineer.cookie,[png,png]);
  const input={requestId:randomUUID(),data:f.data({category:'construction_daily',dailyReportId:source.id})};
  const r=await f.call(f.route,input,f.users.engineer.cookie);ok(r,201);const d=await f.detail(r.body);assert.equal(d.files.length,2);assert.equal(d.record.snapshot.dailyReport.photos.length,2);assert.equal(d.record.snapshot.dailyReport.id,source.id);
  const sourceWord=await f.call('/daily-report/submissions/'+source.id+'/word',undefined,f.users.engineer.cookie),word=d.files.find(x=>x.mime.includes('wordprocessingml'));
  const copied=await f.call(f.route+'/'+r.body.id+'/files/'+word.id+'/download',undefined,f.users.engineer.cookie);ok(copied);assert.equal(sha(copied.bytes),sha(sourceWord.bytes));assert.equal(d.files.find(x=>x.mime==='image/png').sha256,sha(png));assert.equal(d.files.find(x=>x.mime==='image/png').name,'施工日报原图_01.png');
  const replay=await f.call(f.route,input,f.users.engineer.cookie);ok(replay);assert.equal(replay.body.id,r.body.id);
  const duplicate=await f.call(f.route,{...input,requestId:randomUUID()},f.users.engineer.cookie);ok(duplicate,201);assert.equal(duplicate.body.id,r.body.id);assert.equal(duplicate.body.unchanged,true);assert.equal((await f.detail(r.body)).files.length,2);
  ok(await f.archive(r.body));await f.restart();const after=await f.detail(r.body);assert.equal(after.record.state,'archived');assert.equal(after.files.length,2);assert.equal(f.store.db.prepare('select count(*) n from daily_reports').get().n,1);
});

test('daily source privacy intersects project roles for lists details downloads edits and grants even after importer admin demotion',async t=>{
  const f=await fixture(t),source=await submittedDaily(f),r=await f.create('construction_daily',f.admin,{dailyReportId:source.id});
  for(const n of ['manager','other','finance','viewer']){
    const list=await f.call(f.route,undefined,f.users[n].cookie);ok(list);assert.equal(list.body.total,0);
    ok(await f.call(f.route+'/'+r.id,undefined,f.users[n].cookie),404);
  }
  const d=await f.detail(r),file=d.files[0];ok(await f.call(f.route+'/'+r.id+'/files/'+file.id+'/download',undefined,f.users.manager.cookie),404);
  const grant=await f.action(r,'/files/'+file.id+'/media-grants',{},f.admin);ok(grant);assert.equal((await fetch(grant.body.url)).status,200);
  const admin=f.store.db.prepare("select id from users where username='qa-admin'").get();f.store.db.prepare("insert into engineering_members values(?,?,?)").run(f.pid,admin.id,'manager');f.store.db.prepare("update users set role='operator' where id=?").run(admin.id);
  ok(await f.call(f.route+'/'+r.id,undefined,f.admin),404);assert.equal((await fetch(grant.body.url)).status,404);
  ok(await f.call(f.route,{requestId:randomUUID(),data:f.data({category:'construction_daily',dailyReportId:source.id})},f.admin),404);
});

test('daily import rejects forged source dates categories unknown or inaccessible reports; source IDs and imported originals cannot be rewritten',async t=>{
  const f=await fixture(t),source=await submittedDaily(f);
  for(const extra of [{category:'work_photos',dailyReportId:source.id},{category:'construction_daily',dailyReportId:randomUUID()},{category:'construction_daily',dailyReportId:source.id,recordDate:'2026-10-11'}]){
    const r=await f.call(f.route,{requestId:randomUUID(),data:f.data(extra)},f.users.engineer.cookie);ok(r,extra.dailyReportId!==source.id?404:400);
  }
  ok(await f.call(f.route,{requestId:randomUUID(),data:f.data({category:'construction_daily',dailyReportId:source.id})},f.users.manager.cookie),404);
  const r=await f.create('construction_daily',f.users.engineer.cookie,{dailyReportId:source.id});
  ok(await f.action(r,'',{version:1,data:f.data({category:'construction_daily'})},f.users.engineer.cookie,'PUT'),409);
  ok(await f.action(r,'',{version:1,data:f.data({category:'construction_daily',dailyReportId:source.id,recordDate:'2026-10-11'})},f.users.engineer.cookie,'PUT'),400);
  const d=await f.detail(r);ok(await f.action(r,'/files/'+d.files[0].id+'/remove',{version:d.version,reason:'不能移除原日报'}),409);
  ok(await f.action(r,'/withdraw',{version:d.version,reason:'合成更正'}));assert.equal((await f.detail(r)).files.length,1);
});

test('daily import storage and DB faults roll back all rows and new files; corrupt source document or source photo prevents a partial import',async t=>{
  const f=await fixture(t),source=await submittedDaily(f,f.users.engineer.cookie,[png]);
  const body={requestId:randomUUID(),data:f.data({category:'construction_daily',dailyReportId:source.id})};
  f.store.db.exec("CREATE TRIGGER qa_daily_fail BEFORE INSERT ON engineering_site_files BEGIN SELECT RAISE(ABORT,'qa rollback'); END;");ok(await f.call(f.route,body,f.users.engineer.cookie),500);assert.equal(f.store.db.prepare('select count(*) n from engineering_site_records').get().n,0);
  const {readdirSync}=await import('node:fs');assert.equal(readdirSync(join(f.partPath(randomUUID()),'..','..','originals')).length,0);
  f.store.db.exec('DROP TRIGGER qa_daily_fail');const original=f.store.db.prepare('select document from daily_reports where id=?').get(source.id).document;
  f.store.db.prepare('update daily_reports set document=? where id=?').run(Buffer.from('broken'),source.id);ok(await f.call(f.route,body,f.users.engineer.cookie),503);
  f.store.db.prepare('update daily_reports set document=? where id=?').run(original,source.id);f.store.db.prepare('update daily_report_photos set bytes=? where report_id=?').run(Buffer.from('broken'),source.id);ok(await f.call(f.route,body,f.users.engineer.cookie),503);
  assert.equal(f.store.db.prepare('select count(*) n from engineering_site_files').get().n,0);
});

test('mobile daily import uses existing candidate create and original grant routes; project removal revokes copied originals',async t=>{
  const f=await fixture(t),source=await submittedDaily(f),login=(await f.call('/mobile/login',{username:'qa-engineer',password:f.password})).body,headers={Authorization:'Bearer '+login.token};
  const pb=f.pb.replace('/engineering','/mobile/engineering'),candidates=await f.call(pb+'/document-candidates',undefined,'','GET',headers);ok(candidates);assert.equal(candidates.body.find(c=>c.id===source.id).reportDate,'2026-10-12');
  const r=await f.call(pb+'/site-records',{requestId:randomUUID(),data:f.data({category:'construction_daily',dailyReportId:source.id})},'','POST',headers);ok(r,201);
  const d=await f.detail(r.body),grant=await f.call(pb+'/site-records/'+r.body.id+'/files/'+d.files[0].id+'/media-grants',{requestId:randomUUID()},'','POST',headers);ok(grant);assert.equal((await fetch(grant.body.url)).status,200);
  ok(await f.post('/members',{userId:f.users.engineer.id,role:'remove'},f.admin,'PUT'));assert.equal((await fetch(grant.body.url)).status,404);
});

test('register inspection covers all filtered pages and separates uploaded steps representatives removals and incomplete uploads',async t=>{
 const f=await fixture(t),r=await f.create('work_photos');
 await f.completeUpload(r,png,'现场原图.png','image/png');
 const file=(await f.detail(r)).files[0];
 ok(await f.action(r,'/files/'+file.id+'/step',{version:(await f.detail(r)).version,stepId:'step01',representative:true}));
 ok(await f.startUpload(r,Buffer.concat([png,Buffer.from('pending')]),'待传原件.png','image/png'),201);
 await f.create('supervision_daily',f.users.engineer.cookie,{supervision:{}});
 const view=await f.call(f.route+'?inspection=1&limit=1',undefined,f.admin);ok(view);
 assert.equal(view.body.records.length,1);assert.equal(view.body.inspection.total,2);assert.equal(view.body.inspection.pendingUploads,1);assert.equal(view.body.inspection.pendingRecords,1);
 const filtered=await f.call(f.route+'?inspection=1&category=work_photos&wbsId='+f.node.id,undefined,f.admin);ok(filtered);
 const c=filtered.body.inspection.checks[r.id];assert.deepEqual(c.provided,['step01']);assert.deepEqual(c.representatives,['step01']);assert.equal(c.activeFiles,1);assert.equal(c.unassigned,0);
 const x=await f.call(f.route+'?format=xlsx&limit=1',undefined,f.admin);ok(x);assert.match(x.headers.get('content-type'),/spreadsheetml/);assert.equal(x.headers.get('cache-control'),'private, no-store');
 const z=unzipSync(x.bytes),xml=Object.fromEntries(Object.entries(z).filter(([k])=>k.includes('worksheets')).map(([k,v])=>[k,strFromU8(v)]));
 assert.equal(Object.keys(xml).length,4);assert.match(xml['xl/worksheets/sheet4.xml'],/资料测试项目/);assert.doesNotMatch(Object.values(xml).join(''),/undefined/);assert.match(xml['xl/worksheets/sheet1.xml'],/监理单位/);assert.match(xml['xl/worksheets/sheet2.xml'],new RegExp(sha(png)));assert.match(xml['xl/worksheets/sheet3.xml'],/本份未提供/);assert.doesNotMatch(Object.values(xml).join(''),/workspace_session|Bearer /);
 ok(await f.action(r,'/files/'+file.id+'/remove',{version:(await f.detail(r)).version,reason:'合成移除'}));
 const removed=(await f.call(f.route+'?inspection=1&category=work_photos',undefined,f.admin)).body.inspection.checks[r.id];assert.deepEqual(removed.provided,[]);assert.deepEqual(removed.representatives,[]);assert.equal(removed.removedFiles,1);
});

test('register never reveals another authors daily data counts or originals; mobile bearer keeps project and source ACL',async t=>{
 const f=await fixture(t),source=await submittedDaily(f),secret='来源私有日报不能出现在经理台账';
 const r=await f.create('construction_daily',f.admin,{dailyReportId:source.id,title:secret});
 await f.create('hidden_work',f.users.manager.cookie,{title:'经理可见图片'});
 const m=await f.call(f.route+'?inspection=1',undefined,f.users.manager.cookie);ok(m);assert.equal(m.body.total,1);assert.equal(m.body.inspection.total,1);assert.equal(m.body.inspection.totals.construction_daily.draft,0);assert.equal(m.body.inspection.checks[r.id],undefined);
 const x=await f.call(f.route+'?format=xlsx',undefined,f.users.manager.cookie);ok(x);assert.doesNotMatch(Object.values(unzipSync(x.bytes)).map(strFromU8).join(''),new RegExp(secret+'|'+source.id));
 const login=await f.call('/mobile/login',{username:'qa-engineer',password:f.password});ok(login);const headers={Authorization:'Bearer '+login.body.token},mobile=f.route.replace('/engineering/','/mobile/engineering/');
 const mine=await f.call(mobile+'?inspection=1',undefined,'','GET',headers);ok(mine);assert.equal(mine.body.inspection.total,2);
 ok(await f.call(mobile+'?format=xlsx',undefined,'','GET',headers));
 ok(await f.call(f.route+'?inspection=1',undefined,f.users.outsider.cookie),404);
 ok(await f.call(f.route+'?format=xlsx',undefined,f.users.outsider.cookie),404);
 f.store.db.prepare('DELETE FROM engineering_members WHERE project_id=? AND user_id=?').run(f.pid,f.users.engineer.id);
 ok(await f.call(mobile+'?format=xlsx',undefined,'','GET',headers),404);
});

test('register refuses oversized snapshots without truncation while paged list remains usable; query and formula text stay safe',async t=>{
 const f=await fixture(t),r=await f.create('hidden_work',f.users.engineer.cookie,{title:'=HYPERLINK("https://invalid")'});
 const row=f.store.db.prepare('SELECT * FROM engineering_site_records WHERE id=?').get(r.id),keys=Object.keys(row);
 const insert=f.store.db.prepare('INSERT INTO engineering_site_records('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')');
 f.store.transaction(()=>{for(let i=0;i<2000;i++)insert.run(...keys.map(k=>k==='id'?randomUUID():row[k]));});
 const view=await f.call(f.route+'?inspection=1&limit=1',undefined,f.admin);ok(view);assert.equal(view.body.total,2001);assert.match(view.body.inspection.error,/缩小/);assert.equal(view.body.records.length,1);
 const capped=await f.call(f.route+'?format=xlsx',undefined,f.admin);ok(capped,413);assert.doesNotMatch(capped.headers.get('content-type'),/spreadsheetml/);
 f.store.db.prepare('DELETE FROM engineering_site_records WHERE id<>?').run(r.id);
 const x=await f.call(f.route+'?format=xlsx',undefined,f.admin);ok(x);const sheet=strFromU8(unzipSync(x.bytes)['xl/worksheets/sheet1.xml']);assert.match(sheet,/=HYPERLINK/);assert.doesNotMatch(sheet,/<f[ >]/);
 for(const q of ['format=csv','inspection=true','from=2026-10-20&to=2026-10-01','from=2026-02-30'])ok(await f.call(f.route+'?'+q,undefined,f.admin),400);
});

test('register counts removed originals toward the 10000-file bound and preserves zero-result exports',async t=>{
 const f=await fixture(t),r=await f.create('hidden_work');await f.completeUpload(r,png,'界限样本.png','image/png');
 const row=f.store.db.prepare('SELECT * FROM engineering_site_files WHERE record_id=?').get(r.id),keys=Object.keys(row),insert=f.store.db.prepare('INSERT INTO engineering_site_files('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')');
 const upload=f.store.db.prepare('SELECT * FROM engineering_site_uploads WHERE id=?').get(row.upload_id),uk=Object.keys(upload),ui=f.store.db.prepare('INSERT INTO engineering_site_uploads('+uk.join(',')+') VALUES('+uk.map(()=>'?').join(',')+')');
 f.store.transaction(()=>{for(let i=1;i<=10000;i++){const uid=randomUUID(),fid=randomUUID(),hash=i.toString(16).padStart(64,'0');ui.run(...uk.map(k=>k==='id'?uid:k==='file_id'?fid:k==='sha256'?hash:upload[k]));insert.run(...keys.map(k=>k==='id'?fid:k==='upload_id'?uid:k==='sha256'?hash:k==='removed_at'?'2026-10-19T00:00:00Z':row[k]));}});
 const result=await f.call(f.route+'?inspection=1',undefined,f.admin);ok(result);assert.match(result.body.inspection.error,/10000/);
 ok(await f.call(f.route+'?format=xlsx',undefined,f.admin),413);
 const empty=await f.call(f.route+'?format=xlsx&category=work_videos',undefined,f.admin);ok(empty);const sheet=strFromU8(unzipSync(empty.bytes)['xl/worksheets/sheet1.xml']);assert.equal((sheet.match(/<row /g)||[]).length,1);
 const zero=await f.call(f.route+'?inspection=1&category=work_videos',undefined,f.admin);ok(zero);assert.equal(zero.body.inspection.total,0);assert.equal(zero.body.inspection.error,undefined);
});

function batchData(f,extra={}) {
 const rules=keys=>Object.fromEntries(keys.map(k=>[k,{mode:'optional',reason:''}]));
 return {code:'B-'+randomUUID().slice(0,8),title:'合成管网作业批次',date:'2026-10-12',crew:'合成班组',shift:'上午',wbsId:f.node.id,taskId:f.task.id,note:'批次不代表工程验收',requirements:{categories:rules(Object.keys(siteRecordCategories)),photos:rules(siteWorkSteps.map(s=>s.id)),videos:rules(siteWorkSteps.map(s=>s.id))},...extra};
}
async function batchCreate(f,data=batchData(f),confirm=true){const r=await f.post('/site-records/batches',{data});ok(r,201);if(confirm){const c=await f.post('/site-records/batches/'+r.body.id+'/state',{version:1,state:'confirmed',reason:'核对批次与要求'});ok(c);return {...r.body,version:c.body.version,data};}return {...r.body,data};}
const batchCheck=(f,b,cookie=f.admin)=>f.call(f.route+'/batches/'+b.id+'/check',undefined,cookie);

test('batch definitions require current project manager permission, full rules and explicit NA reasons before replay',async t=>{
 const f=await fixture(t),data=batchData(f),body={requestId:randomUUID(),data};
 ok(await f.call(f.route+'/batches',body,f.users.engineer.cookie),403);ok(await f.call(f.route+'/batches',body,f.users.viewer.cookie),403);ok(await f.call(f.route+'/batches',body,f.users.outsider.cookie),404);
 for(const delta of [{wbsId:randomUUID()},{taskId:randomUUID()},{date:'2026-02-30'},{extra:1},{requirements:{...data.requirements,categories:{...data.requirements.categories,hidden_work:{mode:'not_applicable',reason:''}}}}])ok(await f.call(f.route+'/batches',{requestId:randomUUID(),data:{...data,...delta}},f.admin),400);
 const r=await f.call(f.route+'/batches',body,f.users.manager.cookie);ok(r,201);ok(await f.call(f.route+'/batches',body,f.users.manager.cookie));
 ok(await f.call(f.route+'/batches',{requestId:randomUUID(),data:{...data,code:data.code.toLowerCase()}},f.admin),409);
 ok(await f.post('/members',{userId:f.users.manager.id,role:'engineer'},f.admin,'PUT'));ok(await f.call(f.route+'/batches',body,f.users.manager.cookie),403);
 const list=await f.call(f.route+'/batches',undefined,f.users.engineer.cookie);ok(list);assert.equal(list.body.canManage,false);assert.equal(list.body.batches.length,1);
});

test('batch optimistic state history freezes requirements, resumes identical requests and survives restart',async t=>{
 const f=await fixture(t),b=await batchCreate(f,undefined,false),changed={...b.data,title:'已核对的作业批次'};
 ok(await f.post('/site-records/batches/'+b.id,{version:1,data:changed,reason:'更正批次名'},f.admin,'PUT'));
 ok(await f.post('/site-records/batches/'+b.id+'/state',{version:1,state:'confirmed',reason:'旧版本'}),409);
 const confirmation={requestId:randomUUID(),version:2,state:'confirmed',reason:'确认要求'};
 ok(await f.call(f.route+'/batches/'+b.id+'/state',confirmation,f.admin));ok(await f.call(f.route+'/batches/'+b.id+'/state',confirmation,f.admin));
 ok(await f.post('/site-records/batches/'+b.id,{version:3,data:b.data,reason:'不能改冻结要求'},f.admin,'PUT'),409);
 await f.restart();const detail=await f.call(f.route+'/batches/'+b.id,undefined,f.admin);ok(detail);assert.equal(detail.body.batch.state,'confirmed');assert.equal(detail.body.events.length,3);assert.equal(detail.body.events[0].data.title,b.data.title);
 const c=await batchCheck(f,b);ok(c);assert.equal(c.body.project.name,'资料测试项目');assert.equal(c.body.confirmation.version,3);assert.equal(c.body.confirmation.actor_name,'管理员');
 assert.equal(siteRecordsPending(f.store,f.pid,f.task.id),true);ok(await f.post('/site-records/batches/'+b.id+'/state',{version:3,state:'withdrawn',reason:'保留历史撤回'}));assert.equal(siteRecordsPending(f.store,f.pid,f.task.id),false);
 await f.create();assert.equal((await f.detail(await f.create())).record.data.batchId,undefined);
});

test('exact batch link enforces confirmed same date WBS task; photo video companions never cross batches or legacy',async t=>{
 const f=await fixture(t),a=await batchCreate(f),b=await batchCreate(f),draft=await batchCreate(f,undefined,false);
 for(const delta of [{batchId:draft.id},{batchId:randomUUID()},{batchId:a.id,recordDate:'2026-10-11'},{batchId:a.id,wbsId:f.rootNode.id,taskId:''},{batchId:a.id,taskId:''}]){const r=await f.call(f.route,{requestId:randomUUID(),data:f.data(delta)},f.users.engineer.cookie);assert.ok([400,404,409].includes(r.status),JSON.stringify(r.body));}
 const photo=await f.create('work_photos',undefined,{batchId:a.id}),va=await f.create('work_videos',undefined,{batchId:a.id}),vb=await f.create('work_videos',undefined,{batchId:b.id}),legacy=await f.create('work_videos');
 assert.deepEqual((await f.detail(photo)).related.map(r=>r.id),[va.id]);assert.equal((await f.detail(vb)).related.length,0);assert.equal((await f.detail(legacy)).related.length,0);
 const d=await f.detail(photo);assert.equal(d.record.snapshot.batch.id,a.id);assert.equal(d.record.snapshot.batch.version,2);
 ok(await f.action(photo,'',{version:d.version,data:f.data({category:'work_photos',batchId:a.id,recordDate:'2026-10-13'})},undefined,'PUT'),400);
 ok(await f.action(photo,'',{version:d.version,data:f.data({category:'work_photos',batchId:b.id})},undefined,'PUT'));assert.equal((await f.detail(photo)).record.snapshot.batch.id,b.id);
 assert.equal((await f.call(f.route+'?batchId='+a.id,undefined,f.admin)).body.total,1);assert.equal((await f.call(f.route+'?batchId=unassigned',undefined,f.admin)).body.total,1);
 ok(await f.post('/site-records/batches/'+a.id+'/state',{version:2,state:'withdrawn',reason:'关联资料未撤回'}),409);
 f.store.db.prepare("UPDATE engineering_wbs SET data=json_set(data,'$.title','部位已改名') WHERE id=?").run(f.node.id);
 ok(await f.call(f.route,{requestId:randomUUID(),data:f.data({batchId:a.id})},f.admin),409);
});

test('batch matrix uses archived union by exact batch, separates optional parents and NA, preserves export provenance',async t=>{
 const f=await fixture(t),data=batchData(f);data.requirements.categories.work_photos={mode:'required',reason:''};data.requirements.categories.hidden_work={mode:'not_applicable',reason:'无隐蔽施工'};for(const s of siteWorkSteps.slice(0,2))data.requirements.photos[s.id]={mode:'required',reason:''};data.requirements.videos[siteWorkSteps[0].id]={mode:'required',reason:''};
 const batchPng=await sharp({create:{width:64,height:48,channels:3,background:'#4585be'}}).png().toBuffer();
 const a=await batchCreate(f,data),b=await batchCreate(f),r1=await f.create('work_photos',undefined,{batchId:a.id}),r2=await f.create('work_photos',undefined,{batchId:a.id}),other=await f.create('work_photos',undefined,{batchId:b.id});
 for(const [r,step] of [[r1,siteWorkSteps[0].id],[r2,siteWorkSteps[1].id],[other,siteWorkSteps[2].id]]){await f.completeUpload(r,batchPng,r.id+'.png','image/png');const d=await f.detail(r);ok(await f.action(r,'/files/'+d.files[0].id+'/step',{version:d.version,stepId:step,representative:true}));}
 let check=await batchCheck(f,a);ok(check);assert.equal(check.body.missing.length,3);assert.equal(check.body.visibleRecords,2);
 ok(await f.archive(r1));check=await batchCheck(f,a);ok(check);assert.deepEqual(check.body.missing,['work_photos:'+siteWorkSteps[1].id]);ok(await f.archive(r2));ok(await f.archive(other));check=await batchCheck(f,a);assert.deepEqual(check.body.missing,[]);assert.equal(check.body.rows.find(r=>r.key==='work_photos:'+siteWorkSteps[2].id).provided,false);assert.equal(check.body.rows.find(r=>r.key==='work_videos:'+siteWorkSteps[0].id).required,false);
 const x=await f.call(f.route+'/batches/'+a.id+'/check?format=xlsx',undefined,f.admin);ok(x);const z=unzipSync(x.bytes),text=Object.values(z).map(b=>strFromU8(b)).join(' ');for(const v of ['无隐蔽施工','资料测试项目',f.pid,'合成标段','合成管网部位',f.task.id,'管理员','要求确认时间'])assert.ok(text.includes(v),v);
 const d=await f.detail(r1);ok(await f.action(r1,'',{version:d.version,data:f.data({category:'work_photos',batchId:b.id})},undefined,'PUT'),409);ok(await f.action(r1,'/withdraw',{version:d.version,reason:'合成撤回'}));check=await batchCheck(f,a);assert.deepEqual(check.body.missing,['work_photos:'+siteWorkSteps[0].id]);
});

test('batch daily dedup includes batch identity while matrix and XLSX preserve source privacy and generic withdrawal blockers',async t=>{
 const f=await fixture(t),source=await submittedDaily(f),a=await batchCreate(f),b=await batchCreate(f),extra={dailyReportId:source.id,batchId:a.id,title:'私有日报来源标题'};
 const ra=await f.create('construction_daily',undefined,extra),repeat=await f.call(f.route,{requestId:randomUUID(),data:f.data({category:'construction_daily',...extra})},f.users.engineer.cookie);ok(repeat,201);assert.equal(repeat.body.id,ra.id);
 const rb=await f.create('construction_daily',undefined,{...extra,batchId:b.id});assert.notEqual(rb.id,ra.id);ok(await f.archive(ra));
 const m=await batchCheck(f,a,f.users.manager.cookie);ok(m);assert.equal(m.body.visibleRecords,0);assert.equal(m.body.rows.find(r=>r.key==='construction_daily').provided,false);assert.equal((await batchCheck(f,a)).body.visibleRecords,1);
 const ex=await f.call(f.route+'/batches/'+a.id+'/check?format=xlsx',undefined,f.users.manager.cookie);ok(ex);assert.ok(!Object.values(unzipSync(ex.bytes)).map(b=>strFromU8(b)).join(' ').includes(extra.title));
 const blocked=await f.post('/site-records/batches/'+a.id+'/state',{version:2,state:'withdrawn',reason:'经理不能看到来源但不能造成悬空'},f.users.manager.cookie);ok(blocked,409);assert.ok(!JSON.stringify(blocked.body).includes(extra.title));assert.ok(!JSON.stringify(blocked.body).includes(ra.id));
 const login=await f.call('/mobile/login',{username:'qa-engineer',password:f.password});ok(login);const mobile=f.route.replace('/engineering/','/mobile/engineering/')+'/batches/'+a.id+'/check',headers={Authorization:'Bearer '+login.body.token};const mc=await f.call(mobile,undefined,'','GET',headers);ok(mc);assert.equal(mc.body.visibleRecords,1);
 ok(await f.post('/members',{userId:f.users.engineer.id,role:'remove'},f.admin,'PUT'));ok(await f.call(mobile,undefined,'','GET',headers),404);
});

test('batch checks fail rather than truncate oversized visible snapshots; caps include removed originals',async t=>{
 const f=await fixture(t),b=await batchCreate(f),r=await f.create('site_measurement',undefined,{batchId:b.id});
 const original=f.store.db.prepare('SELECT * FROM engineering_site_records WHERE id=?').get(r.id),keys=Object.keys(original),insert=f.store.db.prepare('INSERT INTO engineering_site_records('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')');
 f.store.transaction(()=>{for(let n=0;n<2000;n++)insert.run(...keys.map(k=>k==='id'?randomUUID():original[k]));});
 ok(await batchCheck(f,b),413);ok(await f.call(f.route+'/batches/'+b.id+'/check?format=xlsx',undefined,f.admin),413);
 f.store.db.prepare('DELETE FROM engineering_site_records WHERE id<>?').run(r.id);await f.completeUpload(r);const file=f.store.db.prepare('SELECT * FROM engineering_site_files WHERE record_id=?').get(r.id),fk=Object.keys(file),fi=f.store.db.prepare('INSERT INTO engineering_site_files('+fk.join(',')+') VALUES('+fk.map(()=>'?').join(',')+')');
 const upload=f.store.db.prepare('SELECT * FROM engineering_site_uploads WHERE id=?').get(file.upload_id),uk=Object.keys(upload),ui=f.store.db.prepare('INSERT INTO engineering_site_uploads('+uk.join(',')+') VALUES('+uk.map(()=>'?').join(',')+')');
 f.store.transaction(()=>{for(let n=0;n<10000;n++){const uid=randomUUID(),fid=randomUUID(),hash=sha(Buffer.from(String(n)));ui.run(...uk.map(k=>k==='id'?uid:k==='file_id'?fid:k==='sha256'?hash:upload[k]));fi.run(...fk.map(k=>k==='id'?fid:k==='upload_id'?uid:k==='removed_at'?new Date().toISOString():k==='sha256'?hash:file[k]));}});ok(await batchCheck(f,b),413);
});

const primary=async(f,category='site_measurement',extra={},cookie=f.users.engineer.cookie)=>{const r=await f.call(f.route,{requestId:randomUUID(),data:f.data({category,...extra})},cookie);ok(r,201);return r.body;};
for(const category of ['site_measurement','work_videos','material_measurement','hidden_work','construction_daily','supervision_daily'])test('six additional categories retain independent review and supplemented originals: '+category,async t=>{
 const f=await fixture(t,true),worker=f.users.engineer,reviewer=f.users.other,documenter=f.users.finance;
 for(const [user,template,actions] of [[reviewer,'supervisor',['read','review','download']],[documenter,'documenter',['read','archive','download']]]){
  ok(await f.call(f.pb+'/site-access/'+user.id,{requestId:randomUUID(),version:0,data:{template,actions,categories:[],wbsIds:[f.rootNode.id],ownOnly:false,validFrom:'',validUntil:''},reason:'隔离三角色完整流程'},f.admin,'PUT'));
 }
 const images=await Promise.all(['#335577','#557733','#773355'].map(background=>sharp({create:{width:40,height:30,channels:3,background}}).png().toBuffer()));
 async function upload(r,bytes,name,mime,stepId=''){
  const u=await f.startUpload(r,bytes,name,mime,worker.cookie,stepId?{stepId}:{});ok(u,201);
  ok(await f.action(r,'/uploads/'+u.body.id+'/chunks',{offset:0,base64:bytes.toString('base64')},worker.cookie));
  ok(await f.action(r,'/uploads/'+u.body.id+'/complete',{},worker.cookie));
 }
 let parent,parentBefore;
 if(category==='work_videos'){
  parent=await primary(f,'work_photos',{title:'六类测试对应照片组'});await upload(parent,images[0],'对应照片.png','image/png','step01');parentBefore=await f.detail(parent);
 }
 const r=await primary(f,category,{title:'六类完整流程 '+category,...(parent?{photoRecordId:parent.id}:{})});
 assert.equal((await f.detail(r)).record.data.uploadPolicy,'seven_v1');
 // Header-only video fixtures test storage and approval contracts, not playback.
 const originals=category==='work_videos'?[mp4,Buffer.concat([mp4,Buffer.from('supplemented-test-video')])]:images;
 const filename=i=>category==='work_videos'?'工序视频'+i+'.mp4':'扫描图片'+i+'.png',mime=category==='work_videos'?'video/mp4':'image/png';
 const initial=category==='work_videos'?1:2;
 for(let i=0;i<initial;i++)await upload(r,originals[i],filename(i),mime,category==='work_videos'?'step01':'');
 let d=await f.detail(r);const beforeFiles=d.files;
 ok(await f.action(r,'/submit',{version:d.version,reviewerId:worker.id,note:'禁止自审'},worker.cookie),403);
 ok(await f.action(r,'/submit',{version:d.version,reviewerId:reviewer.id,note:'第一轮'},worker.cookie));
 d=await f.detail(r);assert.equal(d.review.state,'submitted');assert.equal(d.writable,false);const firstHash=d.review.evidence_hash;
 ok(await f.action(r,'',{version:d.version,data:{...d.record.data,note:'不得修改待复核资料'}},worker.cookie,'PUT'),409);
 ok(await f.action(r,'/archive',{version:d.version,note:'未通过不得归档'},documenter.cookie),409);
 ok(await f.action(r,'/review',{version:d.version,decision:'return',reason:'补充原件及现场备注'},reviewer.cookie));
 d=await f.detail(r);assert.equal(d.review.state,'returned');assert.equal(d.writable,true);
 ok(await f.action(r,'',{version:d.version,data:{...d.record.data,note:'已补充说明和新增原件'}},worker.cookie,'PUT'));
 await upload(r,originals[initial],filename(initial),mime,category==='work_videos'?'step01':'');
 d=await f.detail(r);assert.deepEqual(d.files.filter(file=>beforeFiles.some(old=>old.id===file.id)),beforeFiles);
 ok(await f.action(r,'/submit',{version:d.version,reviewerId:reviewer.id,note:'补充后重提'},worker.cookie));
 d=await f.detail(r);assert.notEqual(d.review.evidence_hash,firstHash);const approvedHash=d.review.evidence_hash;
 ok(await f.action(r,'/review',{version:d.version,decision:'approve',reason:'原件复核通过'},reviewer.cookie));
 d=await f.detail(r);assert.equal(d.review.state,'approved');assert.equal(d.writable,false);
 ok(await f.action(r,'/archive',{version:d.version,note:'复核员不能代资料员归档'},reviewer.cookie),403);
 ok(await f.action(r,'/archive',{version:d.version,note:'资料员独立归档'},documenter.cookie));
 d=await f.detail(r);assert.equal(d.record.state,'archived');assert.equal(d.review.evidence_hash,approvedHash);assert.equal(d.record.archived_by,documenter.id);assert.equal(d.review.reviewed_by,reviewer.id);assert.equal(d.record.created_by,worker.id);assert.equal(d.writable,false);assert.equal(d.files.length,initial+1);assert.equal(d.exports.length,0);
 assert.deepEqual(d.events.filter(e=>e.action.startsWith('site_review_')).map(e=>[e.action,e.actor_id]),[['site_review_submit',worker.id],['site_review_return',reviewer.id],['site_review_submit',worker.id],['site_review_approve',reviewer.id]]);
 for(const file of d.files){const download=await f.call(f.route+'/'+r.id+'/files/'+file.id+'/download',undefined,documenter.cookie);ok(download);assert.equal(sha(download.bytes),file.sha256);}
 if(parent){assert.equal(d.record.data.photoRecordId,parent.id);assert(d.files.every(file=>file.step_id==='step01'));const parentAfter=await f.detail(parent);for(const key of ['record','files','events','exports'])assert.deepEqual(parentAfter[key],parentBefore[key]);}
});
test('seven-rule primary image categories accept several real images, reject documents and preserve historical originals',async t=>{
 const f=await fixture(t),images=await Promise.all(['#ff0000','#0000ff'].map(background=>sharp({create:{width:40,height:30,channels:3,background}}).png().toBuffer()));
 for(const category of ['site_measurement','material_measurement','hidden_work','construction_daily','supervision_daily']){const r=await primary(f,category);assert.equal((await f.detail(r)).record.data.uploadPolicy,'seven_v1');for(let i=0;i<2;i++)await f.completeUpload(r,images[i],i+'.png','image/png');ok(await f.startUpload(r,pdf,'不能作为新扫描图.pdf','application/pdf'),400);assert.equal((await f.detail(r)).files.length,2);ok(await f.archive(r));}
 const old=await f.create('construction_daily');await f.completeUpload(old,pdf);ok(await f.archive(old));assert.equal((await f.detail(old)).record.data.uploadPolicy,undefined);
});
test('new primary profile cannot be downgraded or converted into auxiliary body; old clients retain server-owned policy on edit',async t=>{
 const f=await fixture(t),r=await primary(f),d=await f.detail(r),legacy=await f.create();
 ok(await f.action(r,'',{version:d.version,data:f.data({title:'旧客户端保存，不会移除规则'})},undefined,'PUT'));assert.equal((await f.detail(r)).record.data.uploadPolicy,'seven_v1');ok(await f.startUpload(r),400);
 ok(await f.action(legacy,'',{version:1,data:f.data({uploadPolicy:'seven_v1'})},undefined,'PUT'),400);
 const sup=await primary(f,'supervision_daily');ok(await f.action(sup,'',{version:1,data:f.data({category:'supervision_daily',uploadPolicy:'seven_v1',supervision:{}})},undefined,'PUT'),400);
});
test('supplementary video explicitly links one photo group and never inherits another group in the same batch',async t=>{
 const f=await fixture(t),b=await batchCreate(f),a=await primary(f,'work_photos',{batchId:b.id,title:'照片组甲'}),other=await primary(f,'work_photos',{batchId:b.id,title:'照片组乙'});
 ok(await f.call(f.route,{requestId:randomUUID(),data:f.data({category:'work_videos',batchId:b.id})},f.admin),400);
 const v=await primary(f,'work_videos',{batchId:b.id,photoRecordId:a.id}),d=await f.detail(v);assert.deepEqual(d.related.map(r=>r.id),[a.id]);assert.deepEqual((await f.detail(a)).related.map(r=>r.id),[v.id]);assert.deepEqual((await f.detail(other)).related,[]);
 for(const extra of [{photoRecordId:randomUUID()},{photoRecordId:v.id},{photoRecordId:a.id,wbsId:f.rootNode.id,taskId:''},{photoRecordId:a.id,batchId:''}])ok(await f.call(f.route,{requestId:randomUUID(),data:f.data({category:'work_videos',batchId:b.id,...extra})},f.admin),400);
 ok(await f.action(a,'',{version:1,data:f.data({category:'work_photos',uploadPolicy:'seven_v1',batchId:'',title:'不能悄悄改归属'})},undefined,'PUT'),409);
 ok(await f.action(a,'/withdraw',{version:1,reason:'仍有补充视频'}),409);ok(await f.action(v,'/withdraw',{version:1,reason:'先处理视频'}));ok(await f.action(a,'/withdraw',{version:1,reason:'再处理照片'}));
 ok(await f.call(f.route,{requestId:randomUUID(),data:f.data({category:'work_videos',batchId:b.id,photoRecordId:a.id})},f.admin),400);
});
test('new video can use historical photo group after manual confirmation; no automatic migration and mobile preserves exact parent',async t=>{
 const f=await fixture(t),old=await f.create('work_photos'),login=await f.call('/mobile/login',{username:'qa-engineer',password:f.password}),headers={Authorization:'Bearer '+login.body.token},route=f.route.replace('/engineering/','/mobile/engineering/');
 const v=await f.call(route,{requestId:randomUUID(),data:f.data({category:'work_videos',photoRecordId:old.id})},'','POST',headers);ok(v,201);const d=await f.call(route+'/'+v.body.id,undefined,'','GET',headers);ok(d);assert.equal(d.body.record.snapshot.photoGroup.id,old.id);assert.equal(d.body.related.length,1);assert.equal((await f.detail(old)).record.data.uploadPolicy,undefined);assert.deepEqual((await f.detail(old)).related.map(r=>r.id),[v.body.id]);assert.equal((await f.detail(old)).relatedIsCandidate,false);
 ok(await f.post('/members',{userId:f.users.engineer.id,role:'remove'},f.admin,'PUT'));ok(await f.call(route+'/'+v.body.id,undefined,'','GET',headers),404);
});
test('note-only WBS or same-node binding changes do not trap frozen batch drafts, while real identity changes remain protected',async t=>{
 const f=await fixture(t),b=await batchCreate(f),r=await primary(f,'site_measurement',{batchId:b.id}),pic=await sharp({create:{width:30,height:20,channels:3,background:'#234567'}}).png().toBuffer();await f.completeUpload(r,pic,'扫描.png','image/png');const before=await f.detail(r),node=f.store.db.prepare('SELECT * FROM engineering_wbs WHERE id=?').get(f.node.id);
 ok(await f.post('/wbs/'+f.node.id,{version:node.version,data:{...JSON.parse(node.data),note:'仅补备注'}},f.admin,'PUT'));ok(await f.post('/wbs/tasks/'+f.task.id,{version:1,nodeId:f.node.id,note:'同一部位只补说明'},f.admin,'PUT'));ok(await f.archive(r));assert.deepEqual((await f.detail(r)).record.snapshot,before.record.snapshot);
 f.store.db.prepare("UPDATE engineering_wbs SET data=json_set(data,'$.title','真正变更部位名') WHERE id=?").run(f.node.id);ok(await f.call(f.route,{requestId:randomUUID(),data:f.data({batchId:b.id})},f.admin),409);
});
test('clearing a photo step makes it pending, removes its representative and blocks archive until organized again',async t=>{
 const f=await fixture(t),r=await primary(f,'work_photos'),bytes=await sharp({create:{width:50,height:30,channels:3,background:'#abcdef'}}).png().toBuffer(),u=await f.startUpload(r,bytes,'工序照片.png','image/png',undefined,{stepId:'step01'});ok(u,201);ok(await f.action(r,'/uploads/'+u.body.id+'/chunks',{offset:0,base64:bytes.toString('base64')}));ok(await f.action(r,'/uploads/'+u.body.id+'/complete',{}));let d=await f.detail(r);assert.equal(d.files[0].representative,1);
 ok(await f.action(r,'/files/'+d.files[0].id+'/step',{version:d.version,stepId:'',representative:false}));d=await f.detail(r);assert.equal(d.files[0].step_id,'');assert.equal(d.files[0].representative,0);ok(await f.archive(r),409);assert.equal(d.exports.length,0);ok(await f.action(r,'/files/'+d.files[0].id+'/step',{version:d.version,stepId:'step01',representative:true}));ok(await f.archive(r));assert.equal((await f.detail(r)).exports.length,1);
});

async function tablePhoto(f,r,color,step='step01',size=60){const bytes=await sharp({create:{width:size,height:Math.round(size*.6),channels:3,background:color}}).png().toBuffer(),u=await f.startUpload(r,bytes,step+color.slice(1)+'.png','image/png',undefined,{stepId:step});ok(u,201);ok(await f.action(r,'/uploads/'+u.body.id+'/chunks',{offset:0,base64:bytes.toString('base64')}));const c=await f.action(r,'/uploads/'+u.body.id+'/complete',{});ok(c);return c.body.id;}
const currentTable=async(f,r,cookie=f.users.engineer.cookie,version)=>f.call(f.route+'/'+r.id+'/photo-table?version='+(version??(await f.detail(r,cookie)).version),undefined,cookie);
test('current table immediately fills exact step slots from default or selected photos without creating history or mutations',async t=>{
 const f=await fixture(t),r=await primary(f,'work_photos');await tablePhoto(f,r,'#0000ff','step04');const first=await tablePhoto(f,r,'#ff0000'),replacement=await tablePhoto(f,r,'#00ff00');let d=await f.detail(r);assert.equal(d.files.find(p=>p.id===first).representative,1);assert.equal(d.files.find(p=>p.id===replacement).representative,0);
 const requests=f.store.db.prepare('SELECT COUNT(*) n FROM engineering_requests').get().n,initial=JSON.stringify(d);const word=await currentTable(f,r);ok(word);assert.equal(word.headers.get('x-site-record-version'),String(d.version));assert.equal(word.headers.get('x-content-sha256'),sha(word.bytes));assert.match(word.headers.get('cache-control'),/private.*no-store/);let parts=unzipSync(word.bytes);assert.ok(parts['word/media/site-step-0.jpeg']);assert.ok(parts['word/media/site-step-3.jpeg']);assert.equal(Object.keys(parts).filter(k=>k.startsWith('word/media/')).length,2);assert.equal((strFromU8(parts['word/document.xml']).match(/未提供照片/g)||[]).length,8);
 const rgb=await sharp(parts['word/media/site-step-0.jpeg']).resize(1,1).raw().toBuffer();assert.ok(rgb[0]>rgb[1]+100&&rgb[0]>rgb[2]+100);ok(await currentTable(f,r));assert.equal(JSON.stringify(await f.detail(r)),initial);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM engineering_requests').get().n,requests);
 ok(await f.action(r,'/files/'+replacement+'/step',{version:d.version,stepId:'step01',representative:true}));d=await f.detail(r);const next=await currentTable(f,r);ok(next);parts=unzipSync(next.bytes);const green=await sharp(parts['word/media/site-step-0.jpeg']).resize(1,1).raw().toBuffer();assert.ok(green[1]>green[0]+100&&green[1]>green[2]+100);assert.equal(d.exports.length,0);ok(await currentTable(f,r,undefined,d.version-1),409);
});
test('protected thumbnail is bounded genuine image with SHA checks, removed-file and project permissions; mobile matches the table',async t=>{
 const f=await fixture(t),r=await primary(f,'work_photos'),fid=await tablePhoto(f,r,'#334455'),d=await f.detail(r),p=d.files.find(p=>p.id===fid),route=f.route+'/'+r.id+'/files/'+fid+'/thumbnail?sha256='+p.sha256;
 const thumb=await f.call(route,undefined,f.users.viewer.cookie);ok(thumb);assert.equal(thumb.headers.get('content-type'),'image/jpeg');const meta=await sharp(thumb.bytes).metadata();assert.ok(meta.width<=600&&meta.height<=400);assert.match(thumb.headers.get('cache-control'),/private.*no-store/);ok(await f.call(route),401);ok(await f.call(route,undefined,f.users.outsider.cookie),404);ok(await currentTable(f,r,f.users.viewer.cookie,d.version),403);ok(await currentTable(f,r,f.users.other.cookie,d.version),403);
 ok(await f.call(route.replace(p.sha256,'0'.repeat(64)),undefined,f.admin),409);ok(await f.call(route+'&extra=1',undefined,f.admin),400);
 const login=await f.call('/mobile/login',{username:'qa-engineer',password:f.password}),headers={Authorization:'Bearer '+login.body.token},mr=f.route.replace('/engineering/','/mobile/engineering/');ok(await f.call(route.replace(f.route,mr),undefined,'','GET',headers));ok(await f.call(mr+'/'+r.id+'/photo-table?version='+d.version,undefined,'','GET',headers));ok(await f.action(r,'/files/'+fid+'/remove',{version:d.version,reason:'测试移除'}));ok(await f.call(route,undefined,f.admin),404);
});
test('seven category image previews retain scoped access, genuine JPEG, digest and removed-original checks',async t=>{
 const f=await fixture(t),bytes=await sharp({create:{width:900,height:700,channels:3,background:'#466b85'}}).png().toBuffer();
 for(const category of ['site_measurement','material_measurement','hidden_work','construction_daily','supervision_daily']){
  const r=await primary(f,category),saved=await f.completeUpload(r,bytes,'合成扫描图片.png','image/png'),path=f.route+'/'+r.id+'/files/'+saved.id+'/thumbnail?sha256='+sha(bytes);
  const thumb=await f.call(path,undefined,f.users.engineer.cookie);ok(thumb);assert.equal(thumb.headers.get('content-type'),'image/jpeg');const meta=await sharp(thumb.bytes).metadata();assert(meta.width<=600&&meta.height<=400);
  ok(await f.call(path),401);ok(await f.call(path,undefined,f.users.outsider.cookie),404);ok(await f.call(path.replace(sha(bytes),'0'.repeat(64)),undefined,f.admin),409);
  ok(await f.action(r,'/files/'+saved.id+'/remove',{version:(await f.detail(r)).version,reason:'移除合成验证图'}));ok(await f.call(path,undefined,f.admin),404);
 }
 const r=await f.create('work_videos'),video=await f.completeUpload(r,mp4,'合成视频.mp4','video/mp4');
 ok(await f.call(f.route+'/'+r.id+'/files/'+video.id+'/thumbnail?sha256='+sha(mp4),undefined,f.admin),404);
});
test('current table does not spend 50-version history quota and requires organized valid originals and active photo state',async t=>{
 const f=await fixture(t),r=await primary(f,'work_photos'),fid=await tablePhoto(f,r,'#dd5522');let d=await f.detail(r);ok(await f.action(r,'/exports',{version:d.version}),201);d=await f.detail(r);const row=f.store.db.prepare('SELECT * FROM engineering_site_word_exports WHERE record_id=?').get(r.id),keys=Object.keys(row),insert=f.store.db.prepare('INSERT INTO engineering_site_word_exports('+keys.join(',')+') VALUES('+keys.map(()=>'?').join(',')+')');f.store.transaction(()=>{for(let i=2;i<=50;i++)insert.run(...keys.map(k=>k==='id'?randomUUID():k==='sequence'?i:k==='snapshot'?JSON.stringify({fixture:i}):row[k]));});const before=await f.detail(r);ok(await currentTable(f,r));assert.deepEqual((await f.detail(r)).exports,before.exports);
 ok(await f.action(r,'/files/'+fid+'/step',{version:d.version,stepId:'',representative:false}));ok(await currentTable(f,r),409);d=await f.detail(r);ok(await f.action(r,'/files/'+fid+'/step',{version:d.version,stepId:'step03',representative:true}));ok(await currentTable(f,r));d=await f.detail(r);const file=f.finalPath(fid),bytes=readFileSync(file);writeFileSync(file,Buffer.from(bytes.map((b,i)=>i===bytes.length-1?b^1:b)));ok(await currentTable(f,r),503);ok(await f.call(f.route+'/'+r.id+'/files/'+fid+'/thumbnail?sha256='+sha(bytes),undefined,f.admin),503);writeFileSync(file,bytes);
 ok(await f.action(r,'/withdraw',{version:d.version,reason:'照片资料撤回'}));ok(await currentTable(f,r),409);
});
test('async table and thumbnail conversion rechecks revoked identity, version and actual original storage before serving',async t=>{
 for(const target of ['photo-table','thumbnail'])for(const change of ['logout','disabled','demoted','version','storage']){
  const f=await fixture(t),r=await primary(f,'work_photos'),fid=await tablePhoto(f,r,'#2468ac','step01',5000),d=await f.detail(r),file=d.files.find(p=>p.id===fid);let ended=false;
  const route=target==='photo-table'?f.route+'/'+r.id+'/photo-table?version='+d.version:f.route+'/'+r.id+'/files/'+fid+'/thumbnail?sha256='+file.sha256;
  const pending=f.call(route,undefined,f.users.engineer.cookie).finally(()=>{ended=true;});const until=Date.now()+4000;while(!ended&&sharp.counters().process===0&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,1));assert.ok(!ended&&sharp.counters().process>0,'must change state while actual image conversion runs');
  if(change==='logout')f.store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(f.users.engineer.id);
  if(change==='disabled')f.store.db.prepare('UPDATE users SET active=0 WHERE id=?').run(f.users.engineer.id);
  if(change==='demoted')f.store.db.prepare("UPDATE users SET role='viewer' WHERE id=?").run(f.users.engineer.id);
  if(change==='version')f.store.db.prepare('UPDATE engineering_site_records SET version=version+1 WHERE id=?').run(r.id);
  if(change==='storage')writeFileSync(f.finalPath(fid),Buffer.alloc(file.byte_count,1));
  const result=await pending;
  if(change==='version'&&target==='thumbnail')ok(result);else if(change==='demoted'&&target==='thumbnail')ok(result);else ok(result,change==='logout'||change==='disabled'?401:change==='demoted'?403:change==='storage'?503:409);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM engineering_site_word_exports WHERE record_id=?').get(r.id).n,0);
 }
});

test('new project review requires independent assignee, locks submitted evidence, allows return correction approval and authorized archive',async t=>{
 const f=await fixture(t,true),r=await f.create();await f.completeUpload(r);let d=await f.detail(r);
 ok(await f.archive(r),403); // contributor has no archive capability
 ok(await f.action(r,'/submit',{version:d.version,reviewerId:f.users.engineer.id}),403);
 const body={requestId:randomUUID(),version:d.version,reviewerId:f.users.manager.id,note:'请复核资料'};
 ok(await f.call(f.route+'/'+r.id+'/submit',body,f.users.engineer.cookie));ok(await f.call(f.route+'/'+r.id+'/submit',body,f.users.engineer.cookie));
 d=await f.detail(r);assert.equal(d.review.state,'submitted');assert.equal(d.writable,false);
 ok(await f.action(r,'',{version:d.version,data:d.record.data},f.users.engineer.cookie,'PUT'),409);ok(await f.startUpload(r),409);
 ok(await f.action(r,'/review',{version:d.version,decision:'approve',reason:'不能自审'}),403);
 ok(await f.action(r,'/review',{version:d.version,decision:'return',reason:''},f.users.manager.cookie),400);
 ok(await f.action(r,'/review',{version:d.version,decision:'return',reason:'请补充说明'},f.users.manager.cookie));
 d=await f.detail(r);assert.equal(d.review.state,'returned');assert.equal(d.writable,true);
 ok(await f.action(r,'',{version:d.version,data:{...d.record.data,note:'补充已完成'}},f.users.engineer.cookie,'PUT'));
 d=await f.detail(r);ok(await f.action(r,'/submit',{version:d.version,reviewerId:f.users.manager.id}));
 d=await f.detail(r);const approval={requestId:randomUUID(),version:d.version,decision:'approve',reason:'资料复核通过，不代表工程验收'};
 ok(await f.call(f.route+'/'+r.id+'/review',approval,f.users.manager.cookie));ok(await f.call(f.route+'/'+r.id+'/review',approval,f.users.manager.cookie));
 d=await f.detail(r);assert.equal(d.review.state,'approved');assert.equal(d.writable,false);
 ok(await f.action(r,'/archive',{version:d.version,note:'保留原件'},f.users.manager.cookie));
 d=await f.detail(r);assert.equal(d.record.state,'archived');assert.equal(d.files.length,1);assert.deepEqual(d.events.filter(e=>e.action.startsWith('site_review_')).map(e=>e.action),['site_review_submit','site_review_return','site_review_submit','site_review_approve']);
});

test('scoped permissions intersect membership category descendant WBS lists totals register binary and native grants; revocation is immediate',async t=>{
 const f=await fixture(t,true),r=await f.create();await f.completeUpload(r);const rid=f.route+'/'+r.id;
 const grant=async(data,version=0)=>f.call(f.pb+'/site-access/'+f.users.other.id,{requestId:randomUUID(),version,data:{template:'viewer',actions:['read','download','exportRegister'],categories:['site_measurement'],wbsIds:[f.rootNode.id],ownOnly:false,validFrom:'',validUntil:'',...data},reason:'合成权限范围'},f.admin,'PUT');
 ok(await grant({}));ok(await f.call(rid,undefined,f.users.other.cookie));
 const media=await f.call(rid+'/files/'+(await f.detail(r)).files[0].id+'/media-grants',{requestId:randomUUID()},f.users.other.cookie);ok(media);
 ok(await f.call(f.pb+'/site-access/'+f.users.other.id,{requestId:randomUUID(),version:0,data:{},reason:'非法越权'},f.users.engineer.cookie,'PUT'),403);
 ok(await grant({categories:['hidden_work']},1));const list=await f.call(f.route+'?inspection=1',undefined,f.users.other.cookie);ok(list);assert.equal(list.body.total,0);assert.equal(list.body.inspection.total,0);
 ok(await f.call(rid,undefined,f.users.other.cookie),404);ok(await f.call(rid+'/files/'+(await f.detail(r)).files[0].id+'/download',undefined,f.users.other.cookie),404);ok(await f.call(new URL(media.body.url).pathname.replace('/api',''),undefined,''),401);
 const mobile=await f.call('/mobile/login',{username:'qa-other',password:f.password});ok(mobile);
 const ml=await f.call(f.route.replace('/engineering/','/mobile/engineering/')+'?inspection=1',undefined,'','GET',{Authorization:'Bearer '+mobile.body.token});ok(ml);assert.equal(ml.body.total,0);
 ok(await grant({actions:['read'],categories:[]},2));ok(await f.call(rid,undefined,f.users.other.cookie));ok(await f.call(rid+'/files/'+(await f.detail(r)).files[0].id+'/media-grants',{requestId:randomUUID()},f.users.other.cookie),403);ok(await f.call(f.route+'?format=xlsx',undefined,f.users.other.cookie),403);
});

test('authorization expiry own-only and stale versions cannot leak data or escalate; review delegation is revoked with membership',async t=>{
 const f=await fixture(t,true),r=await f.create();await f.completeUpload(r);let d=await f.detail(r);
 const cfg={template:'crew',actions:['read','create','editOwn','submit'],categories:[],wbsIds:[],ownOnly:true,validFrom:'',validUntil:''};
 const b={requestId:randomUUID(),version:0,data:cfg,reason:'限定本班组本人资料'};
 ok(await f.call(f.pb+'/site-access/'+f.users.other.id,b,f.admin,'PUT'));ok(await f.call(f.pb+'/site-access/'+f.users.other.id,b,f.admin,'PUT'));
 ok(await f.call(f.route+'/'+r.id,undefined,f.users.other.cookie),404);assert.equal((await f.call(f.route,undefined,f.users.other.cookie)).body.total,0);
 ok(await f.call(f.pb+'/site-access/'+f.users.other.id,{...b,requestId:randomUUID()},f.admin,'PUT'),409);
 ok(await f.call(f.pb+'/site-access/'+f.users.other.id,{requestId:randomUUID(),version:1,data:{...cfg,ownOnly:false,validUntil:'2020-01-01T00:00:00Z'},reason:'已到期'},f.admin,'PUT'));ok(await f.call(f.route,undefined,f.users.other.cookie),404);
 ok(await f.action(r,'/submit',{version:d.version,reviewerId:f.users.manager.id}));d=await f.detail(r);
 ok(await f.post('/members',{userId:f.users.manager.id,role:'remove'},f.admin,'PUT'));ok(await f.action(r,'/review',{version:d.version,decision:'approve',reason:'已移出项目'},f.users.manager.cookie),404);
});

test('explicit imported-copy consent permits scoped independent review and non-author archive, while revoking review hides list detail and original grants',async t=>{
 const f=await fixture(t,true),source=await submittedDaily(f,f.users.engineer.cookie,[png]);
 const r=await f.call(f.route,{requestId:randomUUID(),data:f.data({category:'construction_daily',dailyReportId:source.id})},f.users.engineer.cookie);ok(r,201);const id=r.body,route=f.route+'/'+id.id;
 const grant=async(actions,version)=>f.call(f.pb+'/site-access/'+f.users.other.id,{requestId:randomUUID(),version,data:{template:'supervisor',actions,categories:['construction_daily'],wbsIds:[f.node.id],ownOnly:false,validFrom:'',validUntil:''},reason:'指定副本独立复核'},f.admin,'PUT');
 ok(await grant(['read','review','download'],0));ok(await f.call(route,undefined,f.users.other.cookie),404);ok(await f.call(route,undefined,f.users.manager.cookie),404);
 let d=await f.detail(id);ok(await f.action(id,'/submit',{version:d.version,reviewerId:f.users.other.id}));
 const shared=await f.call(route,undefined,f.users.other.cookie);ok(shared);assert.equal(shared.body.review.state,'submitted');
 const media=await f.call(route+'/files/'+shared.body.files[0].id+'/media-grants',{requestId:randomUUID()},f.users.other.cookie);ok(media);
 ok(await grant(['read','download'],1));const list=await f.call(f.route,undefined,f.users.other.cookie);ok(list);assert.equal(list.body.total,0);ok(await f.call(route,undefined,f.users.other.cookie),404);ok(await f.call(new URL(media.body.url).pathname.replace('/api','')),401);
 ok(await grant(['read','review','download'],2));d=await f.detail(id);
 ok(await f.action(id,'/review',{version:d.version,decision:'approve',reason:'副本内容核对通过'},f.users.other.cookie));d=await f.detail(id);
 const allowed=await f.call(route,undefined,f.users.manager.cookie);ok(allowed);assert.equal(allowed.body.capabilities.archive,true);
 ok(await f.action(id,'/archive',{version:d.version,note:'独立复核后保存副本'},f.users.manager.cookie));assert.equal((await f.detail(id)).record.state,'archived');
 ok(await f.call('/daily-report/submissions/'+source.id,undefined,f.users.other.cookie),404);
});

test('manager reassigns an unavailable reviewer without changing submitted evidence and hands off returned drafts with truthful history',async t=>{
 const f=await fixture(t,true),r=await f.create();await f.completeUpload(r);let d=await f.detail(r);
 ok(await f.action(r,'/submit',{version:d.version,reviewerId:f.users.manager.id}));d=await f.detail(r);const evidence=d.review.evidence_hash;
 ok(await f.post('/members',{userId:f.users.manager.id,role:'remove'},f.admin,'PUT'));
 const adminId=f.store.db.prepare("SELECT id FROM users WHERE username='qa-admin'").get().id;
 ok(await f.action(r,'/reviewer',{version:d.version,userId:adminId,reason:'原复核人离岗，改派管理员独立复核'},f.admin));d=await f.detail(r);assert.equal(d.review.evidence_hash,evidence);
 ok(await f.action(r,'/review',{version:d.version,decision:'return',reason:'退回经办补充'},f.admin));d=await f.detail(r);
 ok(await f.action(r,'/handoff',{version:d.version,userId:f.users.other.id,reason:'原经办离岗，交接补充资料'},f.admin));
 const newQueue=await f.call(f.route+'?queue=handling&reviewState=returned&state=draft&limit=1',undefined,f.users.other.cookie);ok(newQueue);assert.equal(newQueue.body.total,1);assert.equal(newQueue.body.records[0].id,r.id);
 const oldQueue=await f.call(f.route+'?queue=handling&reviewState=returned&state=draft&limit=1',undefined,f.users.engineer.cookie);ok(oldQueue);assert.equal(oldQueue.body.total,0);
 ok(await f.call(f.route+'?queue=handling',undefined,f.users.outsider.cookie),404);
 const handed=await f.call(f.route+'/'+r.id,undefined,f.users.other.cookie);ok(handed);assert.equal(handed.body.handler.user_id,f.users.other.id);assert.equal(handed.body.record.created_by,f.users.engineer.id);
 const event=handed.body.events.find(e=>e.action==='site_record_handoff'),note=JSON.parse(event.note);assert.equal(note.from,f.users.engineer.id);assert.equal(note.to,f.users.other.id);
 ok(await f.action(r,'',{version:handed.body.version,data:handed.body.record.data},f.users.engineer.cookie,'PUT'),403);
 ok(await f.action(r,'',{version:handed.body.version,data:{...handed.body.record.data,note:'新经办补充'}},f.users.other.cookie,'PUT'));
});

test('review evidence hash prevents archiving an approved record after unauthorized metadata mutation and imported-source assignment cannot broaden project scope',async t=>{
 const f=await fixture(t,true),r=await f.create();await f.completeUpload(r);let d=await f.detail(r);ok(await f.action(r,'/submit',{version:d.version,reviewerId:f.users.manager.id}));d=await f.detail(r);
 ok(await f.action(r,'/review',{version:d.version,decision:'approve',reason:'资料一致'},f.users.manager.cookie));d=await f.detail(r);
 f.store.db.prepare('UPDATE engineering_site_records SET data=? WHERE id=?').run(JSON.stringify({...d.record.data,note:'未经流程修改'}),r.id);
 ok(await f.action(r,'/archive',{version:d.version,note:'不能归档变更依据'},f.users.manager.cookie),409);
});

test('project history and exports never bypass site record scope; role changes invalidate prior custom grants and review requires original-read capability',async t=>{
 const f=await fixture(t,true),r=await f.create();await f.completeUpload(r);const path=f.pb+'/site-access/'+f.users.other.id;
 const b={requestId:randomUUID(),version:0,data:{template:'supervisor',actions:['read','review'],categories:[],wbsIds:[],ownOnly:false,validFrom:'',validUntil:''},reason:'缺少原件读取'};ok(await f.call(path,b,f.admin,'PUT'),400);
 ok(await f.call(path,{...b,requestId:randomUUID(),data:{...b.data,actions:['read','download','review'],categories:['hidden_work']}},f.admin,'PUT'));
 const detail=await f.call(f.pb,undefined,f.users.other.cookie);ok(detail);assert.ok(!detail.body.history.some(h=>h.item_id===r.id));
 ok(await f.post('/members',{userId:f.users.other.id,role:'finance'},f.admin,'PUT'));ok(await f.call(f.route,undefined,f.users.other.cookie),404);
});

test('scope changes during real image conversion prevent thumbnails and current Word escaping after revocation',async t=>{
 for(const target of ['photo-table','thumbnail']){
  const f=await fixture(t,true),r=await primary(f,'work_photos'),fid=await tablePhoto(f,r,'#2468ac','step01',5000),d=await f.detail(r),file=d.files.find(p=>p.id===fid);let ended=false;
  const path=target==='photo-table'?f.route+'/'+r.id+'/photo-table?version='+d.version:f.route+'/'+r.id+'/files/'+fid+'/thumbnail?sha256='+file.sha256;
  const pending=f.call(path,undefined,f.users.engineer.cookie).finally(()=>{ended=true;});const until=Date.now()+4000;while(!ended&&sharp.counters().process===0&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,1));assert.ok(!ended&&sharp.counters().process>0);
  f.store.db.prepare('INSERT INTO engineering_site_access_grants VALUES(?,?,1,?,?,?)').run(f.pid,f.users.engineer.id,JSON.stringify({template:'engineer',memberRole:'engineer',actions:['read','create','editOwn','submit','download'],wbsIds:[],categories:['hidden_work'],ownOnly:false}),f.users.manager.id,new Date().toISOString());
  ok(await pending,404);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM engineering_site_word_exports WHERE record_id=?').get(r.id).n,0);
 }
});

test('video parent changes cannot disclose a photo group outside the current category grant',async t=>{
 const f=await fixture(t,true),a=await primary(f,'work_photos'),b=await primary(f,'work_photos'),video=await primary(f,'work_videos',{photoRecordId:a.id});
 ok(await f.call(f.pb+'/site-access/'+f.users.engineer.id,{requestId:randomUUID(),version:0,data:{template:'engineer',actions:['read','create','editOwn','submit','download'],categories:['work_videos'],wbsIds:[],ownOnly:false,validFrom:'',validUntil:''},reason:'仅办理视频，不可读取新照片组'},f.admin,'PUT'));
 const d=await f.detail(video);ok(await f.action(video,'',{version:d.version,data:{...d.record.data,photoRecordId:b.id}},f.users.engineer.cookie,'PUT'),404);assert.equal((await f.detail(video)).record.data.photoRecordId,a.id);
});

test('first migration preserves historical archive bytes authors and events, requires explicit enabling and never permits disabling review',async t=>{
 const f=await fixture(t),r=await f.create();await f.completeUpload(r);ok(await f.archive(r));const before=await f.detail(r),original=readFileSync(f.finalPath(before.files[0].id));
 f.store.db.exec('DROP TABLE engineering_site_access_migrations; DELETE FROM engineering_site_access_config;');await f.restart();
 const config=await f.call(f.pb+'/site-access',undefined,f.admin);ok(config);assert.equal(config.body.config.enabled,0);const after=await f.detail(r);
 for(const key of ['record','files','events','exports'])assert.deepEqual(after[key],before[key]);assert.deepEqual(readFileSync(f.finalPath(after.files[0].id)),original);
 const enable={requestId:randomUUID(),version:config.body.config.version,enabled:true,reason:'核对历史资料后明确启用'};ok(await f.call(f.pb+'/site-access',enable,f.admin,'PUT'));ok(await f.call(f.pb+'/site-access',enable,f.admin,'PUT'));
 ok(await f.call(f.pb+'/site-access',{requestId:randomUUID(),version:enable.version+1,enabled:false,reason:'不能静默关闭审核'},f.admin,'PUT'),400);assert.equal((await f.detail(r)).record.state,'archived');
 const fresh=await f.create();await f.completeUpload(fresh);ok(await f.archive(fresh),403);
});
