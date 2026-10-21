import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createApp } from '../server/app.mjs';
import { createServer } from 'node:http';
import { openStore } from '../server/store.mjs';
import { deviceStatus } from '../server/service.mjs';
import { acceptanceGlb } from './acceptance-glb.mjs';
import { withinSchedule } from '../server/security-config.mjs';

const testImage = { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=' };

async function fixture(t) {
  const server = await new Promise(done => { const server = createServer().listen(0, '127.0.0.1', () => done(server)); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const filesDir = mkdtempSync(join(tmpdir(), 'smart-workspace-model-test-'));
  const { app, store } = createApp({ database: ':memory:', baseUrl, filesDir: join(filesDir, '.data'), distPath: join(tmpdir(), 'does-not-exist-workspace') });
  server.on('request', app);
  t.after(async () => { await new Promise(done => server.close(done)); store.close(); if (dirname(resolve(filesDir)) !== resolve(tmpdir()) || !filesDir.startsWith(join(tmpdir(), 'smart-workspace-model-test-'))) throw new Error('unexpected temporary path'); rmSync(filesDir, { recursive: true }); });
  let cookie = ''; const password = randomBytes(20).toString('hex');
  const request = async (path, method = 'GET', data, options = {}) => {
    const headers = { 'Content-Type': 'application/json', 'X-Workspace-Request': '1', ...(cookie ? { Cookie: cookie } : {}), ...options.headers };
    if (options.anonymous) delete headers.Cookie;
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers, ...(data === undefined ? {} : { body: Buffer.isBuffer(data) ? data : JSON.stringify(data) }) });
    if (response.headers.get('set-cookie') && !options.preserveSession) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, body: options.binary ? Buffer.from(await response.arrayBuffer()) : await response.json(), headers: response.headers };
  };
  const setup = await request('/setup', 'POST', { organization: '独立验收单位', username: 'testadmin', name: '验收管理员', password });
  assert.equal(setup.status, 201, JSON.stringify(setup.body));
  const create = async (type, data) => { const result = await request(`/records/${type}`, 'POST', data); assert.equal(result.status, 201, JSON.stringify(result.body)); return result.body; };
  const employee = await create('employees', { name: '测试人员', code: 'TEST-E01', department: '测试部门' });
  const room = await create('spaces', { name: '测试会议室', code: 'TEST-R01', kind: 'meeting_room', capacity: 6 });
  const camera = await create('devices', { name: '测试摄像头', code: 'TEST-C01', kind: 'camera', protocol: '待确认', spaceId: room.id });
  return { request, store, create, employee, room, camera, password, setup };
}

test('session boundary: authentication, CSRF, setup race and read-only role', async t => {
  const f = await fixture(t);
  const expectedVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal((await f.request('/status', 'GET', undefined, { anonymous: true })).body.version, expectedVersion);
  assert.equal((await f.request('/bootstrap')).body.version, expectedVersion);
  assert.equal((await f.request('/bootstrap', 'GET', undefined, { anonymous: true })).status, 401);
  assert.match(f.setup.headers.get('set-cookie'), /HttpOnly/);
  assert.match(f.setup.headers.get('set-cookie'), /SameSite=Strict/);
  assert.equal((await f.request('/setup', 'POST', { organization: '重复', username: 'secondadmin', name: '重复', password: f.password })).status, 409);
  assert.equal((await f.request('/records/spaces', 'POST', {}, { headers: { Origin: 'https://attacker.invalid' } })).status, 403);
  assert.equal((await f.request('/records/spaces', 'POST', {}, { headers: { 'X-Workspace-Request': '' } })).status, 403);
  assert.equal((await f.request('/users', 'POST', { username: 'readonly', name: '只读', role: 'viewer', password: f.password })).status, 201);
  assert.equal((await f.request('/login', 'POST', { username: 'readonly', password: f.password })).status, 200);
  assert.equal((await f.request('/bootstrap')).status, 200);
  assert.equal((await f.request('/records/visits', 'POST', {})).status, 403);
  assert.equal((await f.request('/audit')).status, 403);
  assert.equal((await f.request('/integrations')).status, 403);
});

test('meeting reservations reject overlap, invalid intervals, excessive capacity and stale edits', async t => {
  const f = await fixture(t);
  const meeting = { name: '测试会议', hostId: f.employee.id, spaceId: f.room.id, startAt: '2026-10-01T01:00:00Z', endAt: '2026-10-01T02:00:00Z', attendees: 4 };
  const first = await f.create('bookings', meeting);
  assert.equal((await f.request('/records/bookings', 'POST', { ...meeting, startAt: '2026-10-01T01:30:00Z', endAt: '2026-10-01T02:30:00Z' })).status, 409);
  const adjacent = await f.create('bookings', { ...meeting, startAt: '2026-10-01T02:00:00Z', endAt: '2026-10-01T03:00:00Z' });
  assert.ok(adjacent.id);
  assert.equal((await f.request('/records/bookings', 'POST', { ...meeting, endAt: meeting.startAt })).status, 400);
  assert.equal((await f.request('/records/bookings', 'POST', { ...meeting, attendees: 7 })).status, 409);
  assert.equal((await f.request(`/records/bookings/${first.id}`, 'PATCH', { version: first.version, data: { ...meeting, name: '更新标题' } })).status, 200);
  assert.equal((await f.request(`/records/bookings/${first.id}`, 'PATCH', { version: first.version, data: meeting })).status, 409);
});

test('visitors and incidents preserve valid workflows and audit history', async t => {
  const f = await fixture(t);
  let visitor = await f.create('visits', { name: '测试访客', hostId: f.employee.id, purpose: '流程验收', startAt: '2026-10-02T01:00:00Z', endAt: '2026-10-02T03:00:00Z' });
  assert.equal((await f.request(`/records/visits/${visitor.id}/transition`, 'POST', { version: visitor.version, state: 'checked_in' })).status, 409);
  for (const state of ['approved', 'checked_in', 'checked_out']) { const result = await f.request(`/records/visits/${visitor.id}/transition`, 'POST', { version: visitor.version, state }); assert.equal(result.status, 200); visitor = result.body; }
  assert.equal(visitor.data.history.length, 3);
  assert.equal((await f.request(`/records/visits/${visitor.id}`, 'DELETE', { version: visitor.version })).status, 409);
  let alert = await f.create('alerts', { name: '测试事件', category: '测试', priority: 'high', deviceId: f.camera.id, description: '独立测试输入', occurredAt: new Date().toISOString() });
  assert.equal(alert.data.source, 'manual');
  let result = await f.request(`/records/alerts/${alert.id}/transition`, 'POST', { version: alert.version, state: 'processing' }); assert.equal(result.status, 200); alert = result.body;
  assert.equal((await f.request(`/records/alerts/${alert.id}/transition`, 'POST', { version: alert.version, state: 'resolved' })).status, 400);
  result = await f.request(`/records/alerts/${alert.id}/transition`, 'POST', { version: alert.version, state: 'resolved', note: '复核处理完成' });
  assert.equal(result.status, 200); assert.equal(result.body.data.history.at(-1).note, '复核处理完成');
  const audits = (await f.request('/audit')).body; assert.ok(audits.some(a => a.entity === 'alerts' && a.action === 'transition'));
});

test('reference integrity: duplicates, space cycles and deleting referenced rows are rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/records/employees', 'POST', { name: '重复人员', code: 'test-e01', department: '测试' })).status, 409);
  assert.equal((await f.request('/records/devices', 'POST', { name: '错误关联', code: 'BAD', kind: 'camera', protocol: '待确认', spaceId: 'missing' })).status, 400);
  assert.equal((await f.request(`/records/spaces/${f.room.id}`, 'DELETE', { version: f.room.version })).status, 409);
  const child = await f.create('spaces', { name: '下级', code: 'CHILD', kind: 'office', parentId: f.room.id });
  assert.equal((await f.request(`/records/spaces/${f.room.id}`, 'PATCH', { version: f.room.version, data: { ...f.room.data, parentId: child.id } })).status, 409);
});

test('ingestion enforces service scope, device scope, replay deduplication and revocation', async t => {
  const f = await fixture(t);
  const integration = (await f.request('/integrations', 'POST', { name: '测试状态服务', kind: 'device', deviceIds: [f.camera.id] })).body;
  const headers = { Authorization: `Bearer ${integration.token}` }; const event = { eventId: 'test-event-1', deviceId: f.camera.id, data: { status: 'online' } };
  assert.equal((await f.request('/ingest/telemetry', 'POST', event, { anonymous: true })).status, 401);
  assert.equal((await f.request('/ingest/telemetry', 'POST', { ...event, deviceId: 'other-camera' }, { headers })).status, 403);
  assert.equal((await f.request('/ingest/alerts', 'POST', event, { headers })).status, 403);
  assert.equal((await f.request('/ingest/telemetry', 'POST', event, { headers })).status, 201);
  const replay = await f.request('/ingest/telemetry', 'POST', event, { headers }); assert.equal(replay.status, 200); assert.equal(replay.body.duplicate, true);
  assert.equal((await f.request('/ingest/telemetry', 'POST', { ...event, data: { status: 'offline' } }, { headers })).status, 409);
  const rows = (await f.request('/integrations')).body; assert.equal(rows[0].received, 1); assert.equal('token_hash' in rows[0], false); assert.equal('token' in rows[0], false);
  const snapshot = (await f.request('/bootstrap')).body; assert.equal(snapshot.records.devices[0].state, 'online');
  assert.equal((await f.request(`/integrations/${integration.id}/revoke`, 'POST', {})).status, 200);
  assert.equal((await f.request('/ingest/telemetry', 'POST', { ...event, eventId: 'new-event' }, { headers })).status, 401);
});

test('AI event intake works without falsely enabling a configured algorithm', async t => {
  const f = await fixture(t);
  const rule = await f.create('rules', { name: '测试越界', algorithm: 'intrusion', deviceId: f.camera.id, zone: '测试区域' }); assert.equal(rule.state, 'draft');
  assert.equal((await f.request(`/records/rules/${rule.id}/transition`, 'POST', { version: rule.version, state: 'active' })).status, 409);
  const integration = (await f.request('/integrations', 'POST', { name: '测试外部引擎', kind: 'ai', deviceIds: [f.camera.id] })).body;
  const event = { eventId: 'ai-event-1', deviceId: f.camera.id, data: { name: '测试越界事件', category: 'intrusion', description: '合成测试事件，不是模型推理', occurredAt: new Date().toISOString() } };
  const result = await f.request('/ingest/alerts', 'POST', event, { headers: { Authorization: `Bearer ${integration.token}` } }); assert.equal(result.status, 201);
  const alert = f.store.get(result.body.id); assert.equal(alert.data.source, `integration:${integration.id}`); assert.equal(alert.data.deviceId, f.camera.id);
  const capabilities = (await f.request('/bootstrap')).body.algorithms;
  assert.equal(capabilities.some(a => a.status === 'running'), false);
  assert.equal(capabilities.find(a => a.id === 'phone').status, 'pending_model');
});

test('attendance pairs records by China local day and preserves raw entries', async t => {
  const f = await fixture(t);
  const first = await f.create('attendance', { personId: f.employee.id, direction: 'in', occurredAt: '2026-01-01T23:30:00Z', description: '上班补录' });
  await f.create('attendance', { personId: f.employee.id, direction: 'out', occurredAt: '2026-01-02T10:00:00Z', description: '下班补录' });
  const result = await f.request('/attendance-summary?date=2026-01-02'); assert.equal(result.status, 200); assert.equal(result.body[0].count, 2); assert.equal(result.body[0].state, 'paired');
  assert.equal((await f.request(`/records/attendance/${first.id}`, 'PATCH', { version: first.version, data: first.data })).status, 409);
});

test('device freshness does not invent availability and data survives database reopen', () => {
  assert.equal(deviceStatus({ data: {} }), 'unverified');
  assert.equal(deviceStatus({ data: { reportedStatus: 'online', lastSeen: new Date(Date.now() - 360000).toISOString() } }), 'stale');
  const root = mkdtempSync(join(tmpdir(), 'smart-workspace-test-')); const path = join(root, 'workspace.sqlite');
  let db = openStore(path); db.insert('spaces', 'active', { name: '持久化验收', code: 'PERSIST', kind: 'site' }); db.close();
  db = openStore(path); assert.equal(db.list('spaces')[0].data.name, '持久化验收'); db.close();
  if (dirname(resolve(root)) !== resolve(tmpdir()) || !root.startsWith(join(tmpdir(), 'smart-workspace-test-'))) throw new Error('unexpected temporary directory');
  rmSync(root, { recursive: true });
});

test('digital twin validates models, protects files, isolates anchors and rejects stale point edits', async t => {
  const f = await fixture(t); const headers = { 'Content-Type': 'model/gltf-binary' };
  const invalid = await f.request('/models?name=invalid', 'POST', Buffer.from('not glb'), { headers }); assert.equal(invalid.status, 400);
  assert.equal((await f.request('/models?name=external', 'POST', acceptanceGlb(true), { headers })).status, 400);
  const first = await f.request('/models?name=acceptance-model-A', 'POST', acceptanceGlb(), { headers }); assert.equal(first.status, 201, JSON.stringify(first.body));
  const second = await f.request('/models?name=acceptance-model-B', 'POST', acceptanceGlb(), { headers }); assert.equal(second.status, 201);
  const file = await f.request(`/models/${first.body.id}/file`, 'GET', undefined, { binary: true }); assert.equal(file.status, 200); assert.equal(file.body.readUInt32LE(0), 0x46546c67);
  assert.equal((await f.request(`/models/${first.body.id}/file`, 'GET', undefined, { anonymous: true })).status, 401);
  const anchor = { targetId: f.camera.id, position: [6, 0, 0] };
  assert.equal((await f.request(`/models/${first.body.id}/anchors`, 'POST', anchor)).status, 201);
  assert.equal((await f.request(`/models/${first.body.id}/anchors`, 'POST', anchor)).status, 409);
  assert.equal((await f.request(`/models/${second.body.id}/anchors`)).body.length, 0);
  let stored = (await f.request(`/models/${first.body.id}/anchors`)).body[0]; assert.deepEqual(stored.position, [6, 0, 0]);
  assert.equal((await f.request(`/records/devices/${f.camera.id}`, 'DELETE', { version: f.camera.version })).status, 409);
  assert.equal((await f.request(`/models/${first.body.id}/anchors`, 'POST', { ...anchor, position: [6, 1, 0], version: stored.version })).status, 201);
  assert.equal((await f.request(`/models/${first.body.id}/anchors/${stored.id}`, 'DELETE', { version: stored.version })).status, 409);
  stored = (await f.request(`/models/${first.body.id}/anchors`)).body[0];
  assert.equal((await f.request(`/models/${first.body.id}/anchors/${stored.id}`, 'DELETE', { version: stored.version })).status, 200);
  assert.equal((await f.request(`/models/${first.body.id}/anchors`)).body.length, 0);
});

async function securityFixture(t) {
  const f = await fixture(t);
  const image = await f.request('/security/images', 'POST', { ...testImage, purpose: 'portrait' });
  assert.equal(image.status, 201, JSON.stringify(image.body));
  const portrait = await f.create('portraits', { name: '合成输入测试对象', code: 'QA-P01', group: '隔离验收', imageId: image.body.id });
  const integration = (await f.request('/integrations', 'POST', { name: '隔离识别输入', kind: 'ai', deviceIds: [f.camera.id] })).body;
  const headers = { Authorization: `Bearer ${integration.token}` };
  const arm = async (type, input) => { const draft = await f.create(type, { deviceId: f.camera.id, integrationId: integration.id, ...input }); const result = await f.request(`/records/${type}/${draft.id}/transition`, 'POST', { version: draft.version, state: 'armed' }); assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body; };
  const watch = await arm('watches', { name: '名单命中测试', portraitIds: [portrait.id], modelId: 'qa-model@1', confidence: 0.8 });
  const capture = (eventId, override = {}) => ({ eventId, deviceId: f.camera.id, data: { occurredAt: new Date().toISOString(), objectId: 'same-test-person', modelId: 'qa-model@1', ...testImage, appliedRules: [{ ruleId: watch.id, version: watch.version }], matches: [{ portraitId: portrait.id, portraitVersion: portrait.version, similarity: 0.92 }], ...override } });
  return { ...f, portrait, image: image.body, integration, headers, arm, watch, capture };
}

test('each new face recognition generates a separate alarm; exact network replay remains idempotent', async t => {
  const f = await securityFixture(t); const firstEvent = f.capture('face-one');
  const first = await f.request('/ingest/captures', 'POST', firstEvent, { headers: f.headers });
  const second = await f.request('/ingest/captures', 'POST', { ...firstEvent, eventId: 'face-two' }, { headers: f.headers });
  assert.equal(first.status, 201, JSON.stringify(first.body)); assert.equal(second.status, 201);
  assert.equal(first.body.alarmIds.length, 1); assert.equal(second.body.alarmIds.length, 1);
  assert.notEqual(first.body.alarmIds[0], second.body.alarmIds[0]);
  const replay = await f.request('/ingest/captures', 'POST', firstEvent, { headers: f.headers });
  assert.equal(replay.status, 200); assert.equal(replay.body.duplicate, true);
  assert.equal(f.store.list('alerts').length, 2); assert.equal(f.store.list('captures').length, 2);
  assert.equal((await f.request('/ingest/captures', 'POST', { ...firstEvent, data: { ...firstEvent.data, objectId: 'changed' } }, { headers: f.headers })).status, 409);
  const alert = f.store.get(first.body.alarmIds[0]);
  assert.equal(alert.data.automatic, true); assert.equal(alert.data.portraitImageId, f.image.id);
  assert.equal((await f.request(`/records/alerts/${alert.id}`, 'PATCH', { version: alert.version, data: alert.data })).status, 409);
  const feed = await f.request('/security/notifications?after=0'); assert.equal(feed.status, 200); assert.equal(feed.body.items.length, 2);
  await f.request(`/records/alerts/${alert.id}/transition`, 'POST', { version: alert.version, state: 'processing' });
  assert.equal((await f.request('/security/notifications?after=0')).body.items.length, 1);
  const third = await f.request('/ingest/captures', 'POST', f.capture('face-three'), { headers: f.headers });
  assert.equal(third.body.alarmIds.length, 1); assert.equal(f.store.list('alerts').length, 3);
});

test('face alarms enforce score, model, applied rule version, portrait version, freshness and disarming', async t => {
  const f = await securityFixture(t);
  const inputs = [
    { modelId: 'other-model' }, { appliedRules: [{ ruleId: f.watch.id, version: 1 }] },
    { matches: [{ portraitId: f.portrait.id, portraitVersion: 99, similarity: 0.99 }] },
    { matches: [{ portraitId: f.portrait.id, portraitVersion: f.portrait.version, similarity: 0.79 }] },
    { occurredAt: new Date(Date.now() - 120000).toISOString() },
  ];
  for (const [i, input] of inputs.entries()) { const result = await f.request('/ingest/captures', 'POST', f.capture(`filtered-${i}`, input), { headers: f.headers }); assert.equal(result.status, 201, JSON.stringify(result.body)); assert.equal(result.body.alarmIds.length, 0); }
  assert.equal((await f.request(`/records/watches/${f.watch.id}`, 'PATCH', { version: f.watch.version, data: f.watch.data })).status, 409);
  assert.equal((await f.request(`/records/portraits/${f.portrait.id}`, 'PATCH', { version: f.portrait.version, data: { ...f.portrait.data, name: 'changed' } })).status, 409);
  await f.request(`/records/watches/${f.watch.id}/transition`, 'POST', { version: f.watch.version, state: 'disarmed' });
  const result = await f.request('/ingest/captures', 'POST', f.capture('disarmed'), { headers: f.headers }); assert.equal(result.body.alarmIds.length, 0);
  assert.equal(f.store.list('alerts').length, 0);
  assert.equal((await f.request('/records/captures', 'POST', {})).status, 405);
});

test('reference images and detection configuration remain authenticated and scoped to the assigned AI service', async t => {
  const f = await securityFixture(t);
  const config = await f.request('/ingest/config', 'GET', undefined, { headers: f.headers, anonymous: true });
  assert.equal(config.status, 200); assert.equal(config.body.rules.length, 1); assert.equal(config.body.portraits.length, 1);
  assert.equal((await f.request(`/security/images/${f.image.id}`, 'GET', undefined, { anonymous: true })).status, 401);
  assert.equal((await f.request(`/ingest/reference/${f.image.id}`, 'GET', undefined, { headers: f.headers, anonymous: true, binary: true })).status, 200);
  const other = (await f.request('/integrations', 'POST', { name: '另一识别服务', kind: 'ai', deviceIds: [f.camera.id] })).body;
  assert.equal((await f.request(`/ingest/reference/${f.image.id}`, 'GET', undefined, { headers: { Authorization: `Bearer ${other.token}` }, anonymous: true })).status, 403);
  assert.equal((await f.request('/ingest/config', 'GET', undefined, { headers: { Authorization: `Bearer ${other.token}` } })).body.rules.length, 0);
  assert.equal((await f.request('/security/images', 'POST', { mime: 'image/png', base64: Buffer.from('<svg onload="alert(1)"/>').toString('base64'), purpose: 'portrait' })).status, 400);
  await f.request('/users', 'POST', { username: 'securityviewer', name: '只读', role: 'viewer', password: f.password });
  await f.request('/login', 'POST', { username: 'securityviewer', password: f.password });
  assert.equal((await f.request('/security/images', 'POST', { ...testImage, purpose: 'portrait' })).status, 403);
  assert.equal((await f.request(`/records/watches/${f.watch.id}/transition`, 'POST', { version: f.watch.version, state: 'disarmed' })).status, 403);
});

test('fences validate geometry and each in-region detection creates an independent alarm', async t => {
  const f = await securityFixture(t); const data = { name: '区域检测', kind: 'electronic', eventType: 'intrusion', points: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]] };
  const fence = await f.arm('fences', data);
  assert.equal((await f.request('/records/fences', 'POST', { ...data, deviceId: f.camera.id, points: [[0, 0], [1, 1], [0, 1], [1, 0]] })).status, 400);
  const event = { deviceId: f.camera.id, data: { ruleId: fence.id, ruleVersion: fence.version, eventType: 'intrusion', point: [0.5, 0.5], confidence: 0.9, objectId: 'same-person', occurredAt: new Date().toISOString(), image: testImage } };
  for (const eventId of ['zone-one', 'zone-two']) { const result = await f.request('/ingest/detections', 'POST', { ...event, eventId }, { headers: f.headers }); assert.equal(result.status, 201, JSON.stringify(result.body)); assert.equal(result.body.alarmIds.length, 1); }
  const outside = await f.request('/ingest/detections', 'POST', { ...event, eventId: 'outside', data: { ...event.data, point: [0.99, 0.5] } }, { headers: f.headers }); assert.equal(outside.body.alarmIds.length, 0);
  const old = await f.request('/ingest/detections', 'POST', { ...event, eventId: 'stale-rule', data: { ...event.data, ruleVersion: 1 } }, { headers: f.headers }); assert.equal(old.body.alarmIds.length, 0);
  const invalid = await f.request('/ingest/detections', 'POST', { ...event, eventId: 'invalid-point', data: { ...event.data, point: [1.2, 0.5] } }, { headers: f.headers }); assert.equal(invalid.status, 400);
  assert.equal(f.store.list('alerts').length, 2);
  await f.request(`/records/fences/${fence.id}/transition`, 'POST', { version: fence.version, state: 'disarmed' });
  assert.equal((await f.request('/ingest/detections', 'POST', { ...event, eventId: 'after-disarm' }, { headers: f.headers })).body.alarmIds.length, 0);
});

test('line crossing needs a continuous same-object track through the finite segment', async t => {
  const f = await securityFixture(t); const fence = await f.arm('fences', { name: '越界线', kind: 'electronic', eventType: 'line_crossing', points: [[0.5, 0.2], [0.5, 0.8]] });
  const start = Date.now() - 15000;
  const submit = (id, point, ms, objectId = 'tracked') => f.request('/ingest/detections', 'POST', { eventId: id, deviceId: f.camera.id, data: { ruleId: fence.id, ruleVersion: fence.version, eventType: 'line_crossing', point, confidence: 0.9, objectId, occurredAt: new Date(start + ms).toISOString() } }, { headers: f.headers });
  assert.equal((await submit('line-a', [0.2, 0.5], 0)).body.alarmIds.length, 0);
  assert.equal((await submit('line-b', [0.8, 0.5], 1000)).body.alarmIds.length, 1);
  assert.equal((await submit('line-c', [0.2, 0.5], 2000)).body.alarmIds.length, 1);
  assert.equal((await submit('line-old', [0.8, 0.5], 1500)).body.alarmIds.length, 0);
  assert.equal((await submit('extension-a', [0.2, 0.95], 3000, 'other')).body.alarmIds.length, 0);
  assert.equal((await submit('extension-b', [0.8, 0.95], 4000, 'other')).body.alarmIds.length, 0);
  assert.equal((await submit('track-expired', [0.8, 0.5], 14000)).body.alarmIds.length, 0);
  assert.equal(f.store.list('alerts').length, 2);
});

test('barrier climbing, movement, removal and damage use separate configured event rules', async t => {
  const f = await securityFixture(t);
  for (const eventType of ['climbing', 'barrier_moved', 'barrier_removed', 'barrier_damaged']) {
    const fence = await f.arm('fences', { name: eventType, kind: 'barrier', eventType, points: [[0, 0], [1, 0], [1, 1], [0, 1]] });
    const result = await f.request('/ingest/detections', 'POST', { eventId: `barrier-${eventType}`, deviceId: f.camera.id, data: { ruleId: fence.id, ruleVersion: fence.version, eventType, point: [0.5, 0.5], confidence: 0.9, objectId: 'barrier', occurredAt: new Date().toISOString(), image: testImage } }, { headers: f.headers });
    assert.equal(result.status, 201, JSON.stringify(result.body)); assert.equal(result.body.alarmIds.length, 1);
  }
  assert.equal(f.store.list('alerts').length, 4);
});

test('arming requires an authorized service and complete geometry; schedules handle China midnight', async t => {
  const f = await securityFixture(t);
  const draft = await f.create('fences', { name: '未完成草稿', kind: 'electronic', eventType: 'intrusion', deviceId: f.camera.id });
  assert.equal((await f.request(`/records/fences/${draft.id}/transition`, 'POST', { version: draft.version, state: 'armed' })).status, 400);
  const overnight = { startAt: '', endAt: '', dailyStart: '22:00', dailyEnd: '06:00' };
  assert.equal(withinSchedule(overnight, '2026-09-16T15:00:00Z'), true);
  assert.equal(withinSchedule(overnight, '2026-09-16T19:00:00Z'), true);
  assert.equal(withinSchedule(overnight, '2026-09-16T23:00:00Z'), false);
  assert.equal(withinSchedule({ ...overnight, endAt: '2026-09-16T15:00:00Z' }, '2026-09-16T15:00:00Z'), false);
  const result = await f.request('/integrations/' + f.integration.id + '/revoke', 'POST', {}); assert.equal(result.status, 200);
  assert.equal((await f.request('/ingest/captures', 'POST', f.capture('revoked'), { headers: f.headers })).status, 401);
});

test('long valid rule names still produce alarms and retain the original rule snapshot after edits', async t => {
  const f = await securityFixture(t);
  const rule = await f.arm('watches', { name: '长标题'.repeat(40), portraitIds: [f.portrait.id], modelId: 'qa-model@1', confidence: 0.95 });
  const result = await f.request('/ingest/captures', 'POST', f.capture('long-rule', { appliedRules: [{ ruleId: rule.id, version: rule.version }], matches: [{ portraitId: f.portrait.id, portraitVersion: f.portrait.version, similarity: 0.97 }] }), { headers: f.headers });
  assert.equal(result.status, 201, JSON.stringify(result.body)); assert.equal(result.body.alarmIds.length, 1);
  const alert = f.store.get(result.body.alarmIds[0]); assert.equal(alert.data.name.length, 120); assert.equal(alert.data.ruleSnapshot.confidence, 0.95);
  const disarmed = (await f.request(`/records/watches/${rule.id}/transition`, 'POST', { version: rule.version, state: 'disarmed' })).body;
  const { history, ...editable } = disarmed.data;
  assert.equal((await f.request(`/records/watches/${rule.id}`, 'PATCH', { version: disarmed.version, data: { ...editable, confidence: 0.5 } })).status, 200);
  assert.equal(f.store.get(alert.id).data.ruleSnapshot.confidence, 0.95);
});
