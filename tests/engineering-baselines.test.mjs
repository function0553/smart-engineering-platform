import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../server/app.mjs';
import { baselineDate } from '../server/engineering-baselines.mjs';

const ok = (response, status = 200) => assert.equal(response.status, status, JSON.stringify(response.body));
const taskData = (extra = {}) => ({ title: '合成施工任务', location: 'A 段', owner: '施工一组', startDate: '2026-10-01', dueDate: '2026-10-03', predecessorId: '', progress: 0, note: '隔离测试', ...extra });
async function fixture(t, persistent = false) {
  const dir = persistent ? mkdtempSync(join(tmpdir(), 'engineering-baselines-')) : null;
  let server, state, url;
  const start = async () => { server = createServer(); await new Promise(done => server.listen(0, '127.0.0.1', done)); url = 'http://127.0.0.1:' + server.address().port; state = createApp({ database: dir ? join(dir, 'test.sqlite') : ':memory:', baseUrl: url, distPath: '__none__' }); server.on('request', state.app); };
  const stop = async () => { state.vision.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); state.store.close(); };
  await start();
  t.after(async () => { await stop(); if (dir) { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); assert.ok(dir.includes('engineering-baselines-')); rmSync(dir, { recursive: true, force: true }); } });
  const call = async (path, body, cookie = '', method = body === undefined ? 'GET' : 'POST', headers = {}) => {
    const response = await fetch(url + '/api' + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', 'X-Workspace-Request': '1', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const password = 'isolated-baselines-test-123', setup = await call('/setup', { organization: '计划基线隔离验证', username: 'qa-admin', name: '管理员', password }); ok(setup, 201);
  const admin = setup.cookie, users = {};
  for (const name of ['author', 'reviewer', 'engineer', 'finance', 'viewer', 'outsider']) {
    ok(await call('/users', { username: 'qa-' + name, name, role: name === 'viewer' ? 'viewer' : 'operator', password }, admin), 201);
    const list = (await call('/users', undefined, admin)).body;
    users[name] = { id: list.find(user => user.name === name).id, cookie: (await call('/login', { username: 'qa-' + name, password })).cookie };
  }
  const post = (path, body, cookie = admin, method = 'POST') => call('/engineering' + path, { requestId: randomUUID(), ...body }, cookie, method);
  const projectData = { code: randomUUID(), name: '计划基线合成项目', address: '本机测试', owner: '合成单位', startDate: '2026-01-01', dueDate: '2026-12-31', budget: 123456789, note: '预算不可进入基线' };
  const project = await post('/projects', { data: projectData }); ok(project, 201);
  const pid = project.body.id, pb = '/projects/' + pid, path = pb + '/baselines';
  ok(await post(pb + '/state', { version: 1, state: 'active', note: '合成开工' }));
  for (const [name, role] of [['author', 'manager'], ['reviewer', 'manager'], ['engineer', 'engineer'], ['finance', 'finance'], ['viewer', 'manager']]) ok(await post(pb + '/members', { userId: users[name].id, role }, admin, 'PUT'));
  const detail = async () => { const result = await call('/engineering' + pb, undefined, admin); ok(result); return result.body; };
  const row = async value => (await detail()).items.find(item => item.id === (typeof value === 'string' ? value : value.id));
  const task = async (extra = {}) => { const response = await post(pb + '/items/tasks', { data: taskData(extra) }, users.author.cookie); ok(response, 201); return row(response.body.id); };
  const edit = async (value, extra) => { const current = await row(value); const response = await post(pb + '/items/' + current.id, { version: current.version, data: { ...current.data, ...extra } }, users.author.cookie, 'PUT'); ok(response); return row(value); };
  const reportProgress = async (value, progress) => { const current = await row(value); const requested = await post(pb + '/progress', { taskId: current.id, taskVersion: current.version, effectiveDate: '2026-10-01', progress, note: '合成日期进度填报' }, users.author.cookie); ok(requested, 201); ok(await post(pb + '/progress/' + requested.body.id + '/state', { version: 1, state: 'approved', note: '独立复核合成进度' }, users.reviewer.cookie)); return row(value); };
  const transition = async (value, target) => { const current = await row(value); const response = await post(pb + '/items/' + current.id + '/state', { version: current.version, state: target, note: '合成任务办理' }, users.author.cookie); ok(response); return row(value); };
  const create = (extra = {}, cookie = users.author.cookie) => post(path, { title: '首版施工计划', note: '核对计划后冻结', ...extra }, cookie);
  const review = (bid, target = 'approved', cookie = users.reviewer.cookie, version = 1, extra = {}) => post(path + '/' + bid + '/state', { version, state: target, note: '独立复核计划', ...extra }, cookie);
  const view = async (query = '', cookie = admin) => { const response = await call('/engineering' + path + query, undefined, cookie); ok(response); return response.body; };
  const approve = async () => { const requested = await create(); ok(requested, 201); ok(await review(requested.body.id)); return requested.body.id; };
  const source = bid => ({ ...state.store.db.prepare('SELECT * FROM engineering_baselines WHERE id=?').get(bid) });
  return { call, post, admin, users, password, pid, pb, path, projectData, detail, row, task, edit, reportProgress, transition, create, review, view, approve, source, get store() { return state.store; }, restart: async () => { await stop(); await start(); } };
}

test('baseline captures only the server plan, uses independent approval and preserves the frozen source', async t => {
  const f = await fixture(t), task = await f.task(), cancelled = await f.task({ title: '取消的任务' }); await f.transition(cancelled, 'cancelled');
  ok(await f.create({ tasks: [] }), 400); ok(await f.create({ snapshot: {} }), 400);
  const request = await f.create(); ok(request, 201); const bid = request.body.id, source = f.source(bid);
  const before = await f.view(); assert.equal(before.currentBaselineId, null); assert.equal(before.comparison, null);
  const preview = await f.view('?baselineId=' + bid); assert.equal(preview.selectedBaseline.state, 'submitted'); assert.equal(preview.comparison, null);
  const frozen = preview.selectedBaseline.snapshot; assert.deepEqual(frozen.project, { startDate: '2026-01-01', dueDate: '2026-12-31' });
  assert.deepEqual(frozen.tasks.map(row => row.id), [task.id]); assert.equal(frozen.tasks[0].sourceVersion, 1);
  assert.equal(JSON.stringify(preview).includes('budget'), false); assert.equal(JSON.stringify(preview).includes('123456789'), false);
  ok(await f.review(bid, 'approved', f.users.author.cookie), 409); ok(await f.review(bid));
  const approved = f.source(bid); assert.equal(approved.snapshot, source.snapshot); assert.equal(approved.plan_hash, source.plan_hash); assert.equal(approved.approved_seq, 1);
  assert.deepEqual(await f.row(task), task); ok(await f.review(bid, 'cancelled', f.admin, 2), 409);
  assert.equal((await f.view()).currentBaselineId, bid);
});

test('progress and normal construction state changes do not stale a baseline but comparisons observe latest actual values', async t => {
  const f = await fixture(t), first = await f.task(), second = await f.task({ title: '随后施工', startDate: '2026-10-04', dueDate: '2026-10-05', predecessorId: first.id });
  const request = await f.create(); ok(request, 201); const frozen = f.source(request.body.id).snapshot;
  await f.transition(first, 'active'); await f.reportProgress(first, 100); await f.transition(first, 'completed'); await f.transition(second, 'active'); await f.reportProgress(second, 50);
  ok(await f.review(request.body.id)); assert.equal(f.source(request.body.id).snapshot, frozen);
  const result = await f.view('?asOf=2026-09-01'); assert.equal(result.comparison.summary.plannedProgress, 0); assert.equal(result.comparison.summary.actualProgress, 80);
  assert.equal(result.comparison.summary.changedTasks, 0); assert.ok(!Number.isNaN(Date.parse(result.actualObservedAt)));
  assert.deepEqual(result.selectedBaseline.snapshot.tasks.map(task => task.capturedProgress), [0, 0]);
});

test('approval rejects each change to membership, task plan fields or project dates while non-plan project edits are harmless', async t => {
  const f = await fixture(t), original = await f.task();
  for (const extra of [{ title: '新名称' }, { location: 'B 段' }, { owner: '施工二组' }, { startDate: '2026-10-02' }, { dueDate: '2026-10-05' }]) {
    const request = await f.create(); ok(request, 201); await f.edit(original, extra); ok(await f.review(request.body.id), 409); ok(await f.review(request.body.id, 'cancelled', f.users.author.cookie));
  }
  const earlier = await f.task({ title: '更早前置', startDate: '2026-09-01', dueDate: '2026-09-03' });
  let request = await f.create(); ok(request, 201); await f.edit(original, { predecessorId: earlier.id }); ok(await f.review(request.body.id), 409); ok(await f.review(request.body.id, 'rejected'));
  request = await f.create(); ok(request, 201); await f.task({ title: '新增任务' }); ok(await f.review(request.body.id), 409); ok(await f.review(request.body.id, 'cancelled'));
  request = await f.create(); ok(request, 201); await f.transition(original, 'cancelled'); ok(await f.review(request.body.id), 409); ok(await f.review(request.body.id, 'rejected'));
  request = await f.create(); ok(request, 201); let project = (await f.detail()).project;
  ok(await f.post(f.pb, { version: project.version, data: { ...project.data, dueDate: '2027-01-01' } }, f.admin, 'PUT')); ok(await f.review(request.body.id), 409); ok(await f.review(request.body.id, 'rejected'));
  request = await f.create(); ok(request, 201); project = (await f.detail()).project;
  ok(await f.post(f.pb, { version: project.version, data: { ...project.data, budget: 1, name: '仅调整项目名称及预算' } }, f.admin, 'PUT')); ok(await f.review(request.body.id));
});

test('empty plans and missing, cyclic, same-day or overlapping predecessor schedules are rejected', async t => {
  const f = await fixture(t); ok(await f.create(), 409);
  const first = await f.task(), next = await f.task({ predecessorId: first.id, startDate: '2026-10-03', dueDate: '2026-10-05' });
  ok(await f.create(), 409); await f.edit(next, { startDate: '2026-10-02' }); ok(await f.create(), 409);
  await f.edit(next, { startDate: '2026-10-04' }); const valid = await f.create(); ok(valid, 201);
  // Simulate legacy/corrupt dependencies that the normal task API already prevents.
  const change = (item, data, state = 'planned') => f.store.db.prepare('UPDATE engineering_items SET data=?,state=? WHERE id=?').run(JSON.stringify(data), state, item.id);
  const currentFirst = await f.row(first), currentNext = await f.row(next);
  change(first, currentFirst.data, 'cancelled'); ok(await f.create(), 409); ok(await f.review(valid.body.id), 409);
  change(first, { ...currentFirst.data, predecessorId: next.id }); ok(await f.create(), 409);
  change(first, currentFirst.data); change(next, { ...currentNext.data, predecessorId: randomUUID() }); ok(await f.create(), 409);
});

test('calendar math includes both boundary days, leap days and frozen-duration weighting without pretending historical actual progress', async t => {
  assert.equal(baselineDate(new Date('2026-10-11T15:59:59.999Z')), '2026-10-11');
  assert.equal(baselineDate(new Date('2026-10-11T16:00:00.000Z')), '2026-10-12');
  const f = await fixture(t), one = await f.task({ startDate: '2024-02-29', dueDate: '2024-02-29' }), three = await f.task({ title: '跨闰日任务', startDate: '2024-02-28', dueDate: '2024-03-01' });
  await f.approve(); assert.equal((await f.view()).asOf, baselineDate()); await f.transition(one, 'active'); await f.reportProgress(one, 100); await f.transition(three, 'active'); await f.reportProgress(three, 40);
  for (const [date, expected] of [['2024-02-27', 0], ['2024-02-28', 25], ['2024-02-29', 75], ['2024-03-01', 100], ['2024-03-10', 100]]) {
    const view = await f.view('?asOf=' + date), summary = view.comparison.summary;
    assert.equal(summary.plannedProgress, expected); assert.equal(summary.actualProgress, 55); assert.equal(summary.variance, 55 - expected);
  }
  const leap = (await f.view('?asOf=2024-02-29')).comparison.tasks;
  assert.equal(leap.find(task => task.id === one.id).baselineDuration, 1); assert.equal(leap.find(task => task.id === one.id).plannedProgress, 100);
  assert.equal(leap.find(task => task.id === three.id).plannedProgress, 66.67);
  ok(await f.call('/engineering' + f.path + '?asOf=2026-02-29', undefined, f.admin), 400);
  ok(await f.call('/engineering' + f.path + '?asOf=2026-10-01T12:00:00Z', undefined, f.admin), 400);
});

test('cancelled and missing original tasks retain denominator and explicit flags while added tasks are separate', async t => {
  const f = await fixture(t), cancelled = await f.task(), missing = await f.task({ title: '遗留缺失任务' }); await f.approve();
  await f.transition(cancelled, 'active'); await f.reportProgress(cancelled, 70); await f.transition(cancelled, 'cancelled');
  // A missing task cannot normally be deleted by API; cover legacy data defensively.
  f.store.db.prepare('DELETE FROM engineering_items WHERE id=?').run(missing.id);
  const added = await f.task({ title: '基线之后新加任务' }); await f.transition(added, 'active'); await f.reportProgress(added, 100);
  const result = (await f.view('?asOf=2026-10-02')).comparison;
  assert.equal(result.summary.totalTasks, 2); assert.equal(result.summary.plannedProgress, 66.67); assert.equal(result.summary.actualProgress, 0);
  assert.equal(result.summary.changedTasks, 2); assert.equal(result.summary.cancelledTasks, 1); assert.equal(result.summary.missingTasks, 1); assert.equal(result.summary.addedTasks, 1);
  assert.equal(result.tasks.find(row => row.id === cancelled.id).cancelled, true);
  assert.equal(result.tasks.find(row => row.id === cancelled.id).lastReportedProgress, 70);
  const absent = result.tasks.find(row => row.id === missing.id); assert.equal(absent.missing, true); assert.equal(absent.currentState, 'missing'); assert.equal(absent.startShiftDays, null);
  assert.deepEqual(result.addedTasks.map(row => row.id), [added.id]); assert.equal(result.addedTasks[0].progress, 100);
});

test('baseline ACL applies to readers and writers across desktop, bearer mobile, project boundaries and current reviewer roles', async t => {
  const f = await fixture(t); await f.task(); const request = await f.create(); ok(request, 201);
  ok(await f.call('/engineering' + f.path), 401);
  ok(await f.call('/engineering' + f.path, undefined, f.users.outsider.cookie), 404);
  for (const name of ['engineer', 'finance', 'viewer']) { await f.view('', f.users[name].cookie); ok(await f.create({}, f.users[name].cookie), 403); ok(await f.review(request.body.id, 'approved', f.users[name].cookie), 403); }
  const other = await f.post('/projects', { data: { ...f.projectData, code: randomUUID() } }); ok(other, 201);
  ok(await f.call('/engineering/projects/' + other.body.id + '/baselines?baselineId=' + request.body.id, undefined, f.admin), 404);
  ok(await f.post('/projects/' + other.body.id + '/baselines/' + request.body.id + '/state', { version: 1, state: 'approved', note: '跨项目应拒绝' }), 404);
  ok(await f.post(f.pb + '/members', { userId: f.users.reviewer.id, role: 'finance' }, f.admin, 'PUT')); ok(await f.review(request.body.id), 403);
  ok(await f.post(f.pb + '/members', { userId: f.users.reviewer.id, role: 'manager' }, f.admin, 'PUT'));
  const login = await f.call('/mobile/login', { username: 'qa-reviewer', password: f.password }); ok(login);
  const headers = { Authorization: 'Bearer ' + login.body.token };
  ok(await f.call('/mobile/engineering' + f.path, undefined, '', 'GET', headers));
  ok(await f.call('/mobile/engineering' + f.path + '/' + request.body.id + '/state', { requestId: randomUUID(), version: 1, state: 'approved', note: '移动端独立批准' }, '', 'POST', headers));
  const mobileRequest = await f.call('/mobile/engineering' + f.path, { requestId: randomUUID(), title: '移动提报', note: '合成依据' }, '', 'POST', headers); ok(mobileRequest, 201);
  ok(await f.call('/mobile/engineering' + f.path + '/' + mobileRequest.body.id + '/state', { requestId: randomUUID(), version: 1, state: 'approved', note: '不能自批' }, '', 'POST', headers), 409);
});

test('pending baselines block completion and archived or completed projects reject mutations while retaining read access', async t => {
  const f = await fixture(t), task = await f.task(); await f.transition(task, 'active'); await f.reportProgress(task, 100); await f.transition(task, 'completed');
  let request = await f.create(); ok(request, 201); const project = (await f.detail()).project;
  ok(await f.post(f.pb + '/state', { version: project.version, state: 'completed', note: '待审基线阻断' }), 409);
  ok(await f.review(request.body.id, 'cancelled')); ok(await f.post(f.pb + '/state', { version: project.version, state: 'completed', note: '撤回后完工' })); ok(await f.create(), 409); await f.view();
  let current = (await f.detail()).project; ok(await f.post(f.pb + '/state', { version: current.version, state: 'active', note: '恢复施工' }));
  request = await f.create(); ok(request, 201);
  // Simulate an old pending request surviving a legacy complete/archive transition.
  for (const locked of ['planned', 'completed', 'archived']) { f.store.db.prepare('UPDATE engineering_projects SET state=? WHERE id=?').run(locked, f.pid); ok(await f.review(request.body.id), 409); ok(await f.create(), 409); await f.view(); }
  f.store.db.prepare("UPDATE engineering_projects SET state='completed' WHERE id=?").run(f.pid); current = (await f.detail()).project;
  ok(await f.post(f.pb + '/state', { version: current.version, state: 'archived', note: '遗留待审不能归档' }), 409);
});

test('approval versions and simultaneous requests have one winner, and request receipts reject changed payloads', async t => {
  const f = await fixture(t); await f.task(); const body = { requestId: randomUUID(), title: '可重试申请', note: '合成依据' };
  const created = await f.call('/engineering' + f.path, body, f.users.author.cookie); ok(created, 201);
  const retry = await f.call('/engineering' + f.path, body, f.users.author.cookie); ok(retry, 201); assert.equal(retry.body.id, created.body.id); assert.equal(retry.body.replayed, true);
  ok(await f.call('/engineering' + f.path, { ...body, title: '同编号改内容' }, f.users.author.cookie), 409);
  ok(await f.review(created.body.id, 'approved', f.users.reviewer.cookie, 2), 409);
  const responses = await Promise.all([f.review(created.body.id), f.review(created.body.id, 'approved', f.admin)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]); assert.equal(f.source(created.body.id).version, 2);
  const events = (await f.detail()).history.filter(row => row.item_id === created.body.id); assert.deepEqual(events.map(row => row.action).sort(), ['baseline_approved', 'baseline_submit']);
});

test('approved sequence determines current across tied times and concurrent versions while old approved comparison remains selectable', async t => {
  const f = await fixture(t), task = await f.task();
  const first = await f.create({ title: 'A 版' }), second = await f.create({ title: 'B 版' }); ok(first, 201); ok(second, 201);
  f.store.db.prepare('UPDATE engineering_baselines SET created_at=? WHERE project_id=?').run('2026-10-01T00:00:00.000Z', f.pid);
  const responses = await Promise.all([f.review(first.body.id), f.review(second.body.id)]); responses.forEach(response => ok(response));
  assert.deepEqual(responses.map(response => response.body.approved_seq).sort(), [1, 2]);
  const latest = responses.find(response => response.body.approved_seq === 2).body.id, old = responses.find(response => response.body.approved_seq === 1).body.id;
  assert.equal((await f.view()).currentBaselineId, latest); assert.equal((await f.view('?baselineId=' + old)).selectedBaselineId, old);
  const source = f.source(old).snapshot; await f.edit(task, { startDate: '2026-10-02', dueDate: '2026-10-06' });
  const comparison = (await f.view('?baselineId=' + old + '&asOf=2026-10-02')).comparison;
  assert.equal(comparison.tasks[0].startShiftDays, 1); assert.equal(comparison.tasks[0].dueShiftDays, 3); assert.equal(comparison.tasks[0].changed, true);
  const third = await f.approve(); assert.equal((await f.view()).currentBaselineId, third); assert.equal(f.source(old).snapshot, source);
});

test('rejected and cancelled plans permit replacement and successful receipts, snapshots and current selection survive restart', async t => {
  const f = await fixture(t, true); await f.task();
  const rejected = await f.create(); ok(rejected, 201); ok(await f.review(rejected.body.id, 'rejected')); ok(await f.review(rejected.body.id), 409);
  const cancelled = await f.create(); ok(cancelled, 201); ok(await f.review(cancelled.body.id, 'cancelled', f.users.author.cookie));
  const createBody = { requestId: randomUUID(), title: '持久化版本', note: '合成依据' }, created = await f.call('/engineering' + f.path, createBody, f.users.author.cookie); ok(created, 201);
  const statePath = '/engineering' + f.path + '/' + created.body.id + '/state', stateBody = { requestId: randomUUID(), version: 1, state: 'approved', note: '独立审批并持久化' };
  ok(await f.call(statePath, stateBody, f.users.reviewer.cookie)); const original = f.source(created.body.id), count = (await f.detail()).history.length;
  await f.restart(); assert.deepEqual(f.source(created.body.id), original); assert.equal((await f.view()).currentBaselineId, created.body.id);
  const createReplay = await f.call('/engineering' + f.path, createBody, f.users.author.cookie); ok(createReplay, 201); assert.equal(createReplay.body.replayed, true);
  const approvalReplay = await f.call(statePath, stateBody, f.users.reviewer.cookie); ok(approvalReplay); assert.equal(approvalReplay.body.replayed, true); assert.equal((await f.detail()).history.length, count);
});
