import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { createApp } from '../server/app.mjs';

async function fixture(t, persistent = false) {
  const dir = persistent ? mkdtempSync(join(tmpdir(), 'engineering-attachments-')) : null;
  let server, state, base;
  const start = async () => {
    server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = 'http://127.0.0.1:' + server.address().port;
    state = createApp({ database: dir ? join(dir, 'test.sqlite') : ':memory:', baseUrl: base, distPath: '__none__' }); server.on('request', state.app);
  };
  const stop = async () => { state.vision.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); state.store.close(); };
  await start(); t.after(async () => { await stop(); if (dir) rmSync(dir, { recursive: true, force: true }); });
  const call = async (path, body, cookie = '', method = body === undefined ? 'GET' : 'POST', headers = {}) => {
    const r = await fetch(base + '/api' + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Workspace-Request': '1', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const bytes = Buffer.from(await r.arrayBuffer()); let value; try { value = JSON.parse(bytes.toString()); } catch { value = bytes; }
    return { status: r.status, body: value, bytes, headers: r.headers, cookie: r.headers.get('set-cookie')?.split(';')[0] };
  };
  const password = 'isolated-attachment-test-123';
  const admin = (await call('/setup', { organization: '附件隔离验证', username: 'test-admin', name: '管理员', password })).cookie;
  const users = {};
  for (const [name, role] of [['manager', 'operator'], ['engineer', 'operator'], ['finance', 'operator'], ['viewer', 'viewer'], ['outsider', 'operator']]) {
    assert.equal((await call('/users', { username: 'test-' + name, name, role, password }, admin)).status, 201);
    const list = (await call('/users', undefined, admin)).body;
    users[name] = { id: list.find(u => u.name === name).id, cookie: (await call('/login', { username: 'test-' + name, password })).cookie };
  }
  const post = (path, body, cookie = admin, method) => call('/engineering' + path, { requestId: randomUUID(), ...body }, cookie, method);
  const project = await post('/projects', { data: { code: 'TEST', name: '附件测试', address: '本机合成项目', owner: '测试', startDate: '2026-10-01', dueDate: '2026-12-31', budget: 1000000, note: '' } });
  const pid = project.body.id, pb = '/projects/' + pid;
  assert.equal((await post(pb + '/state', { version: 1, state: 'active', note: '隔离测试' })).status, 200);
  for (const role of ['manager', 'engineer', 'finance', 'viewer']) await post(pb + '/members', { userId: users[role].id, role: role === 'viewer' ? 'manager' : role }, admin, 'PUT');
  const create = async (kind = 'contracts', data = { title: '测试合同', code: randomUUID(), counterparty: '合成相对方', direction: 'expense', amount: 10000, dueDate: '2026-12-31', note: '本机合成合同依据' }) => {
    const r = await post(pb + '/items/' + kind, { data }, users.manager.cookie); assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body.id;
  };
  const iid = await create(), route = '/engineering' + pb + '/items/' + iid + '/attachments';
  const uploadBody = (extra = {}) => ({ requestId: randomUUID(), version: 1, name: '合同 原件.pdf', caption: '合成附件', base64: Buffer.from('%PDF-1.7\nfixture only\n%%EOF').toString('base64'), ...extra });
  const detail = async () => (await call('/engineering' + pb, undefined, admin)).body;
  return { call, post, admin, users, pid, pb, iid, route, uploadBody, detail, create, get store() { return state.store; }, restart: async () => { await stop(); await start(); }, password };
}

test('engineering attachments enforce project, financial, read-only, CSRF and mobile ACL', async t => {
  const f = await fixture(t);
  assert.equal((await f.call(f.route)).status, 401);
  assert.equal((await f.call(f.route, undefined, f.users.outsider.cookie)).status, 404);
  assert.equal((await f.call(f.route, undefined, f.users.engineer.cookie)).status, 403);
  assert.equal((await f.call(f.route, undefined, f.users.viewer.cookie)).status, 403);
  assert.equal((await f.call(f.route, f.uploadBody(), f.users.viewer.cookie)).status, 403);
  assert.equal((await f.call(f.route, f.uploadBody(), f.admin, 'POST', { 'X-Workspace-Request': '' })).status, 403);
  const task = await f.create('tasks', { title: '测试任务', location: '测试段', owner: '测试', startDate: '2026-10-01', dueDate: '2026-12-01', predecessorId: '', progress: 0, note: '' });
  const fieldRoute = f.route.replace(f.iid, task);
  assert.equal((await f.call(fieldRoute, f.uploadBody(), f.users.finance.cookie)).status, 403);
  assert.equal((await f.call(fieldRoute, f.uploadBody(), f.users.viewer.cookie)).status, 403);
  assert.equal((await f.call(fieldRoute, f.uploadBody(), f.users.engineer.cookie)).status, 201);
  assert.equal((await f.call(fieldRoute, undefined, f.users.viewer.cookie)).body.writable, false);
  const login = await f.call('/mobile/login', { username: 'test-finance', password: f.password });
  const mobileRoute = f.route.replace('/engineering', '/mobile/engineering');
  assert.equal((await f.call(mobileRoute, f.uploadBody(), '', 'POST', { Authorization: 'Bearer ' + login.body.token })).status, 201);
  await f.post(f.pb + '/members', { userId: f.users.finance.id, role: 'remove' }, f.admin, 'PUT');
  assert.equal((await f.call(mobileRoute, undefined, '', 'GET', { Authorization: 'Bearer ' + login.body.token })).status, 404);
});

test('engineering attachments persist immutable bytes, soft removal, audit, concurrency and replay receipts', async t => {
  const f = await fixture(t, true), body = f.uploadBody();
  const r = await f.call(f.route, body, f.users.manager.cookie); assert.equal(r.status, 201); assert.equal(r.body.version, 2);
  const replay = await f.call(f.route, body, f.users.manager.cookie); assert.equal(replay.status, 200); assert.equal(replay.body.replayed, true); assert.equal(replay.body.id, r.body.id);
  assert.equal((await f.call(f.route, { ...body, caption: 'changed' }, f.users.manager.cookie)).status, 409);
  assert.equal((await f.call(f.route, f.uploadBody(), f.users.manager.cookie)).status, 409);
  const download = f.route + '/' + r.body.id + '/download';
  const d = await f.call(download, undefined, f.admin); assert.equal(d.status, 200); assert.deepEqual(d.bytes, Buffer.from(body.base64, 'base64'));
  assert.match(d.headers.get('content-disposition'), /^attachment;/); assert.equal(d.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(d.headers.get('x-content-sha256'), createHash('sha256').update(d.bytes).digest('hex'));
  const remove = { requestId: randomUUID(), version: 2, reason: '换用完整扫描件' };
  const removed = await f.call(f.route + '/' + r.body.id + '/remove', remove, f.admin); assert.equal(removed.status, 200); assert.equal(removed.body.version, 3);
  assert.equal((await f.call(f.route + '/' + r.body.id + '/remove', remove, f.admin)).body.replayed, true);
  let list = (await f.call(f.route, undefined, f.admin)).body; assert.equal(list.attachments.length, 1); assert.equal(list.usedFiles, 1); assert.equal(list.attachments[0].remove_reason, remove.reason);
  assert.deepEqual((await f.call(download, undefined, f.admin)).bytes, d.bytes);
  assert.equal((await f.detail()).history.filter(h => h.action.startsWith('attachment_')).length, 2);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM audit WHERE action LIKE 'attachment_%'").get().n, 2);
  await f.restart();
  list = (await f.call(f.route, undefined, f.admin)).body; assert.equal(list.attachments[0].removed_at !== null, true); assert.equal(list.version, 3);
  assert.deepEqual((await f.call(download, undefined, f.admin)).bytes, d.bytes);
  assert.equal((await f.call(f.route, body, f.users.manager.cookie)).body.replayed, true);
  await f.post(f.pb + '/members', { userId: f.users.manager.id, role: 'remove' }, f.admin, 'PUT');
  assert.equal((await f.call(f.route, body, f.users.manager.cookie)).status, 404);
});

test('engineering attachment changes mark last editor and locked states freeze evidence', async t => {
  const f = await fixture(t), upload = await f.call(f.route, f.uploadBody(), f.admin);
  assert.equal(upload.status, 201);
  assert.equal((await f.post(f.pb + '/items/' + f.iid + '/state', { version: 1, state: 'submitted', note: 'stale' }, f.users.manager.cookie)).status, 409);
  assert.equal((await f.post(f.pb + '/items/' + f.iid + '/state', { version: 2, state: 'submitted', note: '测试提交' }, f.users.manager.cookie)).status, 200);
  assert.equal((await f.call(f.route, undefined, f.admin)).body.writable, false);
  assert.equal((await f.call(f.route, f.uploadBody({ version: 3 }), f.admin)).status, 409);
  assert.equal((await f.call(f.route + '/' + upload.body.id + '/remove', { requestId: randomUUID(), version: 3, reason: '不得删除' }, f.admin)).status, 409);
  assert.equal((await f.post(f.pb + '/items/' + f.iid + '/state', { version: 3, state: 'approved', note: '审批隔离测试' }, f.admin)).status, 409);
  for (const state of ['approved', 'closed', 'cancelled']) {
    f.store.db.prepare('UPDATE engineering_items SET state=? WHERE id=?').run(state, f.iid);
    assert.equal((await f.call(f.route, f.uploadBody({ version: 3 }), f.admin)).status, 409);
  }
  f.store.db.prepare("UPDATE engineering_items SET state='draft' WHERE id=?").run(f.iid);
  for (const state of ['completed', 'archived', 'planned']) {
    f.store.db.prepare('UPDATE engineering_projects SET state=? WHERE id=?').run(state, f.pid);
    assert.equal((await f.call(f.route, f.uploadBody({ version: 3 }), f.admin)).status, 409);
  }
});

test('engineering attachments reject unsafe names, spoofed files, malformed base64 and oversized payloads', async t => {
  const f = await fixture(t);
  for (const name of ['../test.pdf', 'test\\name.pdf', 'test\r\n.pdf', 'test.html', '.hidden.pdf', 'name.pdf ', 'CON.pdf', 'LPT9.txt']) assert.equal((await f.call(f.route, f.uploadBody({ name }), f.admin)).status, 400, name);
  for (const [name, base64] of [['bad.pdf', Buffer.from('<html>bad</html>').toString('base64')], ['bad.txt', Buffer.from([0xff]).toString('base64')], ['bad.png', Buffer.from('fakepng').toString('base64')], ['bad.docx', Buffer.from('notzip').toString('base64')], ['bad.pdf', 'a==='], ['bad.pdf', '']]) assert.equal((await f.call(f.route, f.uploadBody({ name, base64 }), f.admin)).status, 400, name);
  assert.equal((await f.call(f.route, f.uploadBody({ base64: Buffer.alloc(8 * 1024 * 1024 + 1, 65).toString('base64') }), f.admin)).status, 400);
  assert.equal((await f.call(f.route, undefined, f.admin)).body.attachments.length, 0);
  const bytes = Buffer.from('现场复查记录：\n整改完成');
  const good = await f.call(f.route, f.uploadBody({ name: '复查.txt', base64: bytes.toString('base64') }), f.admin); assert.equal(good.status, 201);
  assert.deepEqual((await f.call(f.route + '/' + good.body.id + '/download', undefined, f.admin)).bytes, bytes);
});

test('engineering attachments bound Office containers and preserve uploaded original documents', async t => {
  const f = await fixture(t);
  const office = files => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
  for (const extra of [{ 'word/vbaProject.bin': 'x' }, { 'word/embeddings/ole.bin': 'x' }, { '../escape.xml': 'x' }]) {
    const bytes = office({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>', ...extra });
    assert.equal((await f.call(f.route, f.uploadBody({ name: '不允许.docx', base64: bytes.toString('base64') }), f.admin)).status, 400);
  }
  const bytes = office({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<w:document/>' });
  const r = await f.call(f.route, f.uploadBody({ name: '合同.docx', base64: bytes.toString('base64') }), f.admin); assert.equal(r.status, 201);
  assert.deepEqual((await f.call(f.route + '/' + r.body.id + '/download', undefined, f.admin)).bytes, bytes);
});

test('engineering attachments enforce historical byte/count quotas and prevent cross-project reference access', async t => {
  const f = await fixture(t);
  const upload = await f.call(f.route, f.uploadBody(), f.admin); assert.equal(upload.status, 201);
  const other = await f.create();
  assert.equal((await f.call(f.route.replace(f.iid, other) + '/' + upload.body.id + '/download', undefined, f.admin)).status, 404);
  assert.equal((await f.call(f.route.replace(f.pid, randomUUID()), undefined, f.admin)).status, 404);
  f.store.db.prepare('UPDATE engineering_attachments SET byte_count=64*1024*1024,removed_at=? WHERE id=?').run(new Date().toISOString(), upload.body.id);
  assert.equal((await f.call(f.route, f.uploadBody({ version: 2 }), f.admin)).status, 409);
  f.store.db.prepare('UPDATE engineering_attachments SET byte_count=1 WHERE id=?').run(upload.body.id);
  const copy = f.store.db.prepare('INSERT INTO engineering_attachments SELECT ?,project_id,item_id,name,mime,byte_count,sha256,caption,bytes,created_by,created_name,created_at,removed_by,removed_name,removed_at,remove_reason FROM engineering_attachments WHERE id=?');
  for (let i = 0; i < 31; i++) copy.run(randomUUID(), upload.body.id);
  assert.equal((await f.call(f.route, f.uploadBody({ version: 2 }), f.admin)).status, 409);
  assert.equal((await f.call(f.route, undefined, f.admin)).body.usedFiles, 32);
});

test('engineering attachments accept an exact 8 MiB original with concurrent version protection and receipt replay after submission', async t => {
  const f = await fixture(t), bytes = Buffer.alloc(8 * 1024 * 1024, 65);bytes.write('%PDF-1.7\n');
  const body = f.uploadBody({ name: "contract's copy.pdf", base64: bytes.toString('base64') });
  const original=await f.call(f.route,body,f.users.manager.cookie);assert.equal(original.status,201);
  const download=await f.call(f.route+'/'+original.body.id+'/download',undefined,f.admin);assert.deepEqual(download.bytes,bytes);assert.match(download.headers.get('content-disposition'),/contract%27s%20copy.pdf/);
  const [a, b] = await Promise.all([f.call(f.route, f.uploadBody({version:2}), f.users.manager.cookie),f.call(f.route, f.uploadBody({version:2}), f.users.manager.cookie)]);
  assert.deepEqual([a.status,b.status].sort(),[201,409]);
  assert.equal((await f.post(f.pb + '/items/' + f.iid + '/state', { version: 3, state: 'submitted', note: '提交后重放不会新增证据' }, f.users.manager.cookie)).status,200);
  const retry=await f.call(f.route,body,f.users.manager.cookie);assert.equal(retry.status,200);assert.equal(retry.body.id,original.body.id);
  assert.equal((await f.call(f.route,undefined,f.admin)).body.attachments.length,2);
});
