import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createApp } from '../server/app.mjs';
import { VisionRuntime } from '../server/vision.mjs';
import { FACE_MODEL_ID } from '../server/vision-catalog.mjs';
import { modelStatus, smokingSpec, pythonPath } from '../server/vision-models.mjs';
import { setTimeout as delay } from 'node:timers/promises';

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'smart-vision-test-'));
  const server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { app, store, vision } = createApp({ database: ':memory:', filesDir: join(directory, 'models'), baseUrl, distPath: join(directory, 'no-dist') });
  server.on('request', app);
  t.after(async () => { vision.close(); await delay(100); await new Promise(done => server.close(done)); store.close(); if (dirname(resolve(directory)) !== resolve(tmpdir()) || !directory.startsWith(join(tmpdir(), 'smart-vision-test-'))) throw Error('Unexpected cleanup path'); rmSync(directory, { recursive: true }); });
  let cookie = '';
  const request = async (path, method = 'GET', body, anonymous = false) => {
    const response = await fetch(`${baseUrl}/api${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Workspace-Request': '1', ...(!anonymous && cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, data: response.headers.get('content-type')?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  };
  await request('/setup', 'POST', { organization: '独立视觉验收', username: 'visiontest', name: '视觉验收', password: randomBytes(20).toString('hex') });
  const create = async (type, data) => { const response = await request(`/records/${type}`, 'POST', data); assert.equal(response.status, 201, JSON.stringify(response.data)); return response.data; };
  const camera = await create('devices', { name: '公开素材测试源', code: 'TEST-VISION', kind: 'camera', protocol: 'RTSP' });
  return { directory, store, vision, request, camera, create };
}

test('video source credentials are encrypted, never returned, and anonymous callers cannot control streams', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/video/sources', 'GET', undefined, true)).status, 401);
  const path = `/video/sources/${f.camera.id}`;
  assert.equal((await f.request(path, 'PUT', { kind: 'rtsp', uri: 'http://127.0.0.1/' })).status, 400);
  assert.equal((await f.request(path, 'PUT', { kind: 'rtsp', uri: 'rtsp://account:secret@192.0.2.1/a' })).status, 400);
  const password = randomBytes(16).toString('hex');
  assert.equal((await f.request(path, 'PUT', { kind: 'rtsp', uri: 'rtsp://192.0.2.1/a', username: 'sample', password })).status, 200);
  assert.equal(readFileSync(join(f.vision.directory, 'sources.enc')).includes(Buffer.from(password)), false);
  const listing = JSON.stringify((await f.request('/video/sources')).data);
  assert.equal(listing.includes(password), false); assert.equal(listing.includes('sample'), false);
  assert.equal((await f.request(path+'/start', 'POST', {}, true)).status, 401);
  const unsupported = await f.create('rules', { name: '尚无模型的玩手机规则', algorithm: 'phone', deviceId: f.camera.id, zone: '测试区域' });
  assert.equal((await f.request(`/records/rules/${unsupported.id}/transition`, 'POST', { version: unsupported.version, state: 'active' })).status, 409);
});

test('video settings preserve encrypted credentials and reject stale edits, deletes, and unauthorized changes', async t => {
  const f = await fixture(t), path = `/video/sources/${f.camera.id}`;
  const password = randomBytes(16).toString('hex');
  const original = { kind: 'rtsp', uri: 'rtsp://192.0.2.1/a', username: 'test-only', password, fps: 1, captureFaces: false };
  const created = await f.request(path, 'PUT', original); assert.equal(created.status, 200);
  const firstRevision = created.data.revision;
  const settings = { expectedRevision: firstRevision, fps: 3, captureFaces: true };
  assert.equal((await f.request(path, 'PATCH', settings, true)).status, 401);
  assert.equal((await f.request(path, 'DELETE', { expectedRevision: firstRevision }, true)).status, 401);
  assert.equal((await f.request(path, 'PATCH', { ...settings, uri: 'rtsp://192.0.2.2/new' })).status, 400);
  const updated = await f.request(path, 'PATCH', settings); assert.equal(updated.status, 200);
  assert.notEqual(updated.data.revision, firstRevision);
  assert.equal((await f.request(path, 'PATCH', settings)).status, 409);
  assert.equal((await f.request(path, 'PUT', { ...original, expectedRevision: firstRevision })).status, 409);
  assert.equal((await f.request(path, 'PUT', original)).status, 409);
  assert.equal((await f.request(path, 'DELETE', { expectedRevision: firstRevision })).status, 409);
  const restored = new VisionRuntime(f.store, f.vision.directory);
  t.after(() => restored.close());
  const stored = restored.sources[f.camera.id];
  assert.ok(stored.username === original.username && stored.password === password && stored.uri === original.uri, 'Settings changes must preserve the saved connection after reloading');
  assert.equal(stored.fps, 3); assert.equal(stored.captureFaces, true); assert.equal(stored.revision, updated.data.revision);
  assert.equal(readFileSync(join(f.vision.directory, 'sources.enc')).includes(Buffer.from(password)), false);
  const listing = (await f.request('/video/sources')).data;
  assert.equal(JSON.stringify(listing).includes(password), false); assert.equal(JSON.stringify(listing).includes(original.username), false);
  assert.equal(listing[0].authorized, true);
  assert.equal(listing[0].revision, updated.data.revision);
  const replaced = await f.request(path, 'PUT', { kind: 'rtsp', uri: 'rtsp://192.0.2.2/new', expectedRevision: updated.data.revision });
  assert.equal(replaced.status, 200);
  assert.equal(f.vision.sources[f.camera.id].username, ''); assert.equal(f.vision.sources[f.camera.id].password, '', 'A different connection must not inherit old device credentials');
  assert.equal((await f.request(path, 'DELETE', { expectedRevision: replaced.data.revision })).status, 200);
  assert.equal((await f.request('/video/sources')).data.length, 0); assert.ok(f.store.get(f.camera.id));
  const recreated = await f.request(path, 'PUT', original); assert.equal(recreated.status, 200);
  assert.notEqual(recreated.data.revision, replaced.data.revision);
  assert.equal((await f.request(path, 'DELETE', { expectedRevision: replaced.data.revision })).status, 409);
  const viewerPassword = randomBytes(20).toString('hex');
  assert.equal((await f.request('/users', 'POST', { username: 'readonly', name: '只读测试', role: 'viewer', password: viewerPassword })).status, 201);
  assert.equal((await f.request('/login', 'POST', { username: 'readonly', password: viewerPassword })).status, 200);
  assert.equal((await f.request(path, 'PATCH', { ...settings, expectedRevision: recreated.data.revision })).status, 403);
  assert.equal((await f.request(path, 'DELETE', { expectedRevision: recreated.data.revision })).status, 403);
});

test('live settings take effect without restarting inference and a real video alarm retains evidence through work-order completion', { skip: !existsSync(resolve('.data/vision-test/public-astronaut.avi')) || !modelStatus().installed }, async t => {
  const f = await fixture(t), path = `/video/sources/${f.camera.id}`;
  const source = await f.request(path, 'PUT', { kind: 'file', uri: resolve('.data/vision-test/public-astronaut.avi'), fps: 1, captureFaces: false }); assert.equal(source.status, 200);
  const rule = await f.create('rules', { name: '实际视频告警工单回归', algorithm: 'crowd', deviceId: f.camera.id, zone: '全画面', confidence: .3, minimumCount: 1, dwellSeconds: 0 });
  assert.equal((await f.request('/video/sources')).data[0].rules.draft, 1);
  assert.equal((await f.request(`/records/rules/${rule.id}/transition`, 'POST', { version: rule.version, state: 'active' })).status, 200);
  assert.equal((await f.request('/video/sources')).data[0].rules.active, 1);
  assert.equal((await f.request(path+'/start', 'POST', {})).status, 200);
  const run = f.vision.runs.get(f.camera.id), generation = run.generation, pid = run.child.pid;
  for (let i = 0; i < 60 && !f.store.list('alerts').length && run.desired; i++) await delay(200);
  assert.ok(f.store.list('alerts').length, JSON.stringify(f.vision.list()));
  assert.equal(f.store.list('captures').length, 0, 'Face capture starts disabled');
  const beforeFrames = run.frames;
  const changed = await f.request(path, 'PATCH', { expectedRevision: source.data.revision, fps: 2, captureFaces: true }); assert.equal(changed.status, 200);
  // File sampling controls which media frames are inferred, not wall-clock
  // decoding speed. CPU inference may take longer than the sampling interval.
  const completionDeadline = Date.now() + 45000;
  let observedFrames = run.frames, lastProgressAt = Date.now();
  while (run.desired && Date.now() < completionDeadline) {
    await delay(200);
    if (run.frames > observedFrames) { observedFrames = run.frames; lastProgressAt = Date.now(); }
    assert.notEqual(run.state, 'error', JSON.stringify(f.vision.list()));
    assert.ok(Date.now() - lastProgressAt < 15000, 'Video inference stopped making progress before EOF');
  }
  assert.equal(run.state, 'ended', JSON.stringify(f.vision.list()));
  assert.equal(run.generation, generation); assert.equal(run.child.pid, pid, 'Settings must not replace the decoder process');
  assert.ok(run.frames > beforeFrames); assert.ok(f.store.list('captures').length > 0, 'The worker must apply newly enabled face capture');
  const alerts = f.store.list('alerts');
  assert.ok(alerts.length > 2);
  assert.ok(alerts.some(a => Math.abs((a.data.mediaSeconds % 1) - .5) < .001), 'The file sampling cadence must change from one to two frames per second');
  assert.equal(new Set(alerts.map(a => a.data.eventId)).size, alerts.length, 'Successive recognitions remain independent alarms');
  const alert = alerts[0]; assert.equal(alert.data.ruleSnapshot.name, rule.data.name);
  const orderData = { name: '处理实际模型告警', deviceId: f.camera.id, alertId: alert.id, description: '独立测试：复核视频证据并完成处置', priority: 'medium' };
  const order = await f.create('workorders', orderData);
  assert.equal((await f.request('/records/workorders', 'POST', orderData)).status, 409);
  const inProgress = await f.request(`/records/workorders/${order.id}/transition`, 'POST', { version: order.version, state: 'in_progress' }); assert.equal(inProgress.status, 200);
  assert.equal((await f.request(`/records/workorders/${order.id}/transition`, 'POST', { version: inProgress.data.version, state: 'completed' })).status, 400);
  assert.equal((await f.request(`/records/workorders/${order.id}/transition`, 'POST', { version: inProgress.data.version, state: 'completed', note: '已复核公开测试视频并记录处理结果' })).status, 200);
  assert.equal((await f.request(path, 'DELETE', { expectedRevision: changed.data.revision })).status, 200);
  assert.equal((await f.request('/video/sources')).data.length, 0);
  assert.equal(f.store.get(order.id).state, 'completed'); assert.equal(f.store.get(order.id).data.alertId, alert.id);
  assert.equal(f.store.list('alerts').length, alerts.length); assert.ok(f.store.get(rule.id));
  assert.equal((await f.request(`/security/images/${alert.data.imageId}`, 'GET', undefined, true)).status, 401);
  const image = await f.request(`/security/images/${alert.data.imageId}`); assert.equal(image.status, 200); assert.ok(image.data.length > 100);
  assert.equal(f.store.get(f.camera.id).data.reportedStatus, undefined);
  console.log(JSON.stringify({ liveSettingsWithoutRestart: true, frames: run.frames, independentAlarms: alerts.length, captures: f.store.list('captures').length, completedWorkOrder: true, evidenceRetainedAfterSourceRemoval: true, physicalCamera: false }));
});

test('real cigarette model produces separate candidate alarms, respects ROI, and stops after disabling', { skip: !existsSync(resolve('.data/vision-test/smoking-regression.avi')) || modelStatus().algorithms.find(a => a.id === 'smoking')?.status !== 'installed' }, async t => {
  const f = await fixture(t); const path = `/video/sources/${f.camera.id}`;
  assert.equal((await f.request(path, 'PUT', { kind: 'file', uri: resolve('.data/vision-test/smoking-regression.avi'), fps: 2 })).status, 200);
  const rule = await f.create('rules', { name: '专项回归', algorithm: 'smoking', deviceId: f.camera.id, zone: '全画面', confidence: .4, dwellSeconds: 0 });
  const outside = await f.create('rules', { name: '画面外侧区域', algorithm: 'smoking', deviceId: f.camera.id, zone: '左上角', confidence: .4, dwellSeconds: 0, roi: '[[0,0],[0.1,0],[0.1,0.1],[0,0.1]]' });
  for (const row of [rule, outside]) assert.equal((await f.request(`/records/rules/${row.id}/transition`, 'POST', { version: row.version, state: 'active' })).status, 200);
  assert.equal((await f.request(path+'/start', 'POST', {})).status, 200);
  let status;
  for (let i = 0; i < 80; i++) { await delay(400); status = (await f.request('/video/sources')).data[0]; if (f.store.list('alerts').length >= 2 || status.state === 'error' || status.state === 'ended') break; }
  const alerts = f.store.list('alerts');
  assert.ok(alerts.length >= 2, JSON.stringify(status));
  assert.ok(alerts.every(a => a.data.ruleId === rule.id && a.data.modelId === smokingSpec.id && a.data.confidence >= .4 && a.data.inputKind === 'file' && a.data.name.includes('疑似')));
  assert.equal(new Set(alerts.map(a => a.data.eventId)).size, alerts.length);
  assert.equal(new Set(alerts.map(a => a.data.objectId)).size, 1, 'The same tracked person can create successive independent alarms');
  assert.ok(alerts.every(a => a.data.cigaretteBox.length === 4 && f.store.db.prepare('SELECT length(bytes) AS size FROM security_images WHERE id=?').get(a.data.imageId).size > 100));
  assert.equal(f.store.get(f.camera.id).data.reportedStatus, undefined);
  const active = f.store.get(rule.id);
  assert.equal((await f.request(`/records/rules/${rule.id}/transition`, 'POST', { version: active.version, state: 'inactive' })).status, 200);
  const count = f.store.list('alerts').length; await delay(1800);
  assert.equal(f.store.list('alerts').length, count);
  await f.request(path+'/stop', 'POST', {});
  console.log(JSON.stringify({ realSmokingInference: true, independentAlarms: count, roiExclusion: true, disableStopsAlarms: true, source: 'official annotated research demonstration, repeated-frame regression only', physicalCamera: false }));
});

test('smoking rule uses video time, rejects stale model/version and message replay, resets lost candidates', { skip: !existsSync(resolve('.data/vision-test/public-astronaut.avi')) || modelStatus().algorithms.find(a => a.id === 'smoking')?.status !== 'installed' }, async t => {
  const f = await fixture(t);
  assert.equal((await f.request(`/video/sources/${f.camera.id}`, 'PUT', { kind: 'file', uri: resolve('.data/vision-test/public-astronaut.avi') })).status, 200);
  const rule = await f.create('rules', { name: '时长规则单元验证', algorithm: 'smoking', deviceId: f.camera.id, zone: '全画面', confidence: .5, dwellSeconds: 1 });
  await f.request(`/records/rules/${rule.id}/transition`, 'POST', { version: rule.version, state: 'active' });
  const active = f.store.get(rule.id), image = readFileSync(resolve('.data/vision-test/public-reference.jpg')).toString('base64');
  const run = { frames: 0, alarms: 0, tracks: new Set(), heatmap: Array(64).fill(0), timers: new Map(), generation: 'unit-test-only' };
  const candidate = { algorithm: 'smoking', modelId: smokingSpec.id, confidence: .8, point: [.5,.5], objectId: 'unit-person', box: [1,1,2,2], personBox: [0,0,10,10] };
  const feed = (sequence, mediaSeconds, behaviors = [candidate], version = active.version) => f.vision.frame(f.camera.id, run, { sequence, mediaSeconds, occurredAt: new Date().toISOString(), objects: [], faces: [], behaviors, quality: {}, frame: image, preview: image, width: 512, height: 512, appliedWatches: [], appliedFences: [], appliedRules: [{ ruleId: rule.id, version }] });
  feed(1, 0); feed(2, .5); assert.equal(run.alarms, 0);
  feed(3, 1); feed(3, 1); assert.equal(run.alarms, 1);
  feed(4, 1.5); assert.equal(run.alarms, 2);
  feed(5, 2, [{ ...candidate, modelId: 'wrong-model' }]);
  feed(6, 2.5); assert.equal(run.alarms, 2, 'A missing candidate resets its dwell timer');
  feed(7, 3, [candidate], active.version-1); assert.equal(run.alarms, 2);
  feed(8, 3.5); assert.equal(run.alarms, 3);
  assert.equal(f.store.list('alerts').length, 3);
});

test('analysis worker exits when its platform control pipe closes', { skip: !existsSync(resolve('.data/vision-test/public-astronaut.avi')) || !modelStatus().installed }, async t => {
  const child = spawn(pythonPath, ['-u', 'vision/worker.py'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  t.after(() => child.kill());
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout });
  let frames = 0;
  const completion = new Promise((done, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Worker did not stop when its owning platform disconnected')); }, 12000);
    child.on('error', e => { clearTimeout(timeout); reject(e); });
    child.on('close', code => { clearTimeout(timeout); lines.close(); done(code); });
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.type === 'frame') { frames++; child.stdin.end(); }
    });
  });
  child.stdin.write(JSON.stringify({ source: { kind: 'file', uri: resolve('.data/vision-test/public-astronaut.avi'), fps: 1 }, rules: [], portraits: [], watchRules: [], fenceRules: [] })+'\n');
  assert.equal(await completion, 0);
  assert.equal(frames, 1, 'No second frame should be analyzed after the parent connection closes');
});

test('real models decode a video, compare a face, trigger distinct alarms and protect frame evidence', { skip: !existsSync(resolve('.data/vision-test/public-astronaut.avi')) }, async t => {
  const f = await fixture(t); const path = `/video/sources/${f.camera.id}`;
  const source = await f.request(path, 'PUT', { kind: 'file', uri: resolve('.data/vision-test/public-astronaut.avi'), fps: 2, captureFaces: true });
  assert.equal(source.status, 200, JSON.stringify(source.data));
  const generic = await f.create('rules', { name: '测试区域人数规则', algorithm: 'crowd', deviceId: f.camera.id, zone: '全画面', confidence: 0.3, minimumCount: 1, dwellSeconds: 0 });
  assert.equal((await f.request(`/records/rules/${generic.id}/transition`, 'POST', { version: generic.version, state: 'active' })).status, 200);
  const reference = readFileSync(resolve('.data/vision-test/public-reference.jpg')).toString('base64');
  const image = await f.request('/security/images', 'POST', { mime: 'image/jpeg', base64: reference, purpose: 'portrait' }); assert.equal(image.status, 201);
  const portrait = await f.create('portraits', { name: '公开素材参考图', code: 'PUBLIC-TEST', group: '测试素材', imageId: image.data.id });
  const watch = await f.create('watches', { name: '测试人像比对', deviceId: f.camera.id, integrationId: source.data.integrationId, portraitIds: [portrait.id], modelId: FACE_MODEL_ID, confidence: 0.8 });
  const fence = await f.create('fences', { name: '测试人员区域', deviceId: f.camera.id, integrationId: source.data.integrationId, kind: 'electronic', eventType: 'intrusion', confidence: 0.3, points: [[0,0],[1,0],[1,1],[0,1]] });
  for (const row of [watch, fence]) assert.equal((await f.request(`/records/${row.type}/${row.id}/transition`, 'POST', { version: row.version, state: 'armed' })).status, 200);
  assert.equal((await f.request(path+'/start', 'POST', {})).status, 200);
  let status;
  for (let i = 0; i < 35; i++) { await delay(400); status = (await f.request('/video/sources')).data[0]; if (status.frames >= 3 || status.state === 'error') break; }
  assert.ok(status.frames >= 3, JSON.stringify(status));
  assert.ok(status.people >= 1, JSON.stringify(status));
  assert.ok(f.store.list('captures').length >= 3);
  assert.equal(f.store.get(f.camera.id).data.reportedStatus, undefined, 'File inference must not mark the physical camera online');
  assert.ok(f.store.list('captures').every(r => r.data.inputKind === 'file'));
  assert.ok(f.store.list('alerts').filter(r => r.data.category === 'portrait_watch').length >= 3);
  assert.ok(f.store.list('alerts').filter(r => r.data.category === 'intrusion').length >= 3);
  assert.ok(f.store.list('alerts').filter(r => r.data.category === 'crowd').length >= 3);
  assert.equal(new Set(f.store.list('alerts').map(r => r.data.eventId)).size, f.store.list('alerts').length);
  assert.equal((await f.request(path+'/frame', 'GET', undefined, true)).status, 401);
  const frame = await f.request(path+'/frame'); assert.equal(frame.status, 200); assert.equal(frame.data[0], 255); assert.equal(frame.data[1], 216);
  const activeWatch = f.store.get(watch.id);
  assert.equal((await f.request(`/records/watches/${watch.id}/transition`, 'POST', { version: activeWatch.version, state: 'disarmed' })).status, 200);
  const faceCount = f.store.list('alerts').filter(r => r.data.category === 'portrait_watch').length;
  await delay(1000);
  assert.equal(f.store.list('alerts').filter(r => r.data.category === 'portrait_watch').length, faceCount);
  assert.equal((await f.request(path+'/stop', 'POST', {})).status, 200);
  const count = f.store.list('captures').length; await delay(900); assert.equal(f.store.list('captures').length, count);
  assert.equal((await f.request(path+'/frame')).status, 404);
  console.log(JSON.stringify({ realInference: true, frames: status.frames, faceAlarms: f.store.list('alerts').filter(r => r.data.category === 'portrait_watch').length, fenceAlarms: f.store.list('alerts').filter(r => r.data.category === 'intrusion').length, physicalCamera: false }));
});
