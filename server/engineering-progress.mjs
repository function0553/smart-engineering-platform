import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail } from './service.mjs';
import { baselineDate } from './engineering-baselines.mjs';

const id = z.string().uuid(), version = z.number().int().positive(), note = z.string().trim().min(1).max(2000);
const now = () => new Date().toISOString();
const unknown = () => ({ progress: null, recordId: null, effectiveDate: null, carriedForward: false, reviewedAt: null });
const parse = row => row ? { ...row, snapshot: JSON.parse(row.snapshot) } : null;
function dateNotFuture(value) {
  const date = z.iso.date().parse(value);
  if (date > baselineDate()) fail(400, '发生日期或历史比较日期不能晚于今天');
  return date;
}

// A correction supersedes the dated observation, never its immutable original.
// Effective dates describe construction; creation/review timestamps describe
// when the platform learned and accepted the observation.
function effectiveRecords(records) {
  const approved = records.filter(row => row.state === 'approved'), byId = new Map(approved.map(row => [row.id, row]));
  const superseded = new Set(), dates = new Set();
  for (const row of approved) if (row.corrects_id) {
    const original = byId.get(row.corrects_id);
    if (!original || original.task_id !== row.task_id || original.effective_date !== row.effective_date || original.approved_seq >= row.approved_seq || superseded.has(original.id)) fail(422, '施工进度更正链不一致，请核对原记录');
    superseded.add(original.id);
  }
  const effective = approved.filter(row => !superseded.has(row.id)).sort((a, b) => a.effective_date.localeCompare(b.effective_date) || a.approved_seq - b.approved_seq);
  for (const row of effective) {
    const key = row.task_id + ':' + row.effective_date;
    if (dates.has(key)) fail(422, '同一任务同一日期存在重复有效进度，请核对记录');
    dates.add(key);
  }
  return { effective, superseded };
}
function observationFromEffective(effective, asOf) {
  const row = effective.filter(row => row.effective_date <= asOf).at(-1);
  return row ? { progress: row.progress, recordId: row.id, effectiveDate: row.effective_date, carriedForward: row.effective_date < asOf, reviewedAt: row.reviewed_at } : unknown();
}
function observation(records, taskId, asOf) { return observationFromEffective(effectiveRecords(records).effective.filter(row => row.task_id === taskId), asOf); }

export function createEngineeringProgress({ store, access, active, mutate, history, getItems, getItem, saveItem, manager }) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS engineering_progress(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES engineering_projects(id),
    task_id TEXT NOT NULL REFERENCES engineering_items(id), effective_date TEXT NOT NULL,
    progress INTEGER NOT NULL CHECK(progress BETWEEN 0 AND 100), note TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('submitted','approved','rejected','cancelled')),
    version INTEGER NOT NULL, task_version INTEGER NOT NULL,
    snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), corrects_id TEXT REFERENCES engineering_progress(id),
    requested_by TEXT NOT NULL REFERENCES users(id), requester_name TEXT NOT NULL, created_at TEXT NOT NULL,
    reviewed_by TEXT REFERENCES users(id), reviewer_name TEXT, review_note TEXT, reviewed_at TEXT,
    approved_seq INTEGER CHECK(approved_seq IS NULL OR approved_seq>0), UNIQUE(project_id,approved_seq));
    CREATE INDEX IF NOT EXISTS engineering_progress_project_task_date ON engineering_progress(project_id,task_id,effective_date);
    CREATE UNIQUE INDEX IF NOT EXISTS engineering_progress_one_pending ON engineering_progress(task_id) WHERE state='submitted';`);
  const rows = (pid, taskId) => db.prepare('SELECT * FROM engineering_progress WHERE project_id=?' + (taskId ? ' AND task_id=?' : '') + ' ORDER BY created_at DESC,id DESC').all(...(taskId ? [pid, taskId] : [pid])).map(parse);
  const pending = (pid, taskId) => db.prepare("SELECT COUNT(*) n FROM engineering_progress WHERE project_id=? AND state='submitted'" + (taskId ? ' AND task_id=?' : '')).get(...(taskId ? [pid, taskId] : [pid])).n;
  function authorized(req, write = true) {
    const context = access(req, write);
    if (write && !['admin', 'manager', 'engineer'].includes(context.role)) fail(403, '施工进度由现场成员、项目经理或管理员填报');
    return context;
  }
  function actualAt(pid, taskId, asOf) { return observation(rows(pid, taskId), taskId, dateNotFuture(asOf)); }
  function view(pid, { asOf = baselineDate(), taskId } = {}) {
    dateNotFuture(asOf);
    if (taskId) getItem(pid, taskId, 'tasks');
    const records = rows(pid, taskId), { effective, superseded } = effectiveRecords(records), today = baselineDate(), byTask = new Map(), pendingByTask = new Map();
    for (const row of effective) { const group = byTask.get(row.task_id) || []; group.push(row); byTask.set(row.task_id, group); }
    for (const row of records) if (row.state === 'submitted') pendingByTask.set(row.task_id, row.id);
    const tasks = getItems(pid).filter(row => row.kind === 'tasks' && (!taskId || row.id === taskId)).map(row => {
      const group = byTask.get(row.id) || [], current = observationFromEffective(group, today), actual = observationFromEffective(group, asOf), hasBasis = current.recordId !== null && current.progress === row.data.progress;
      return { taskId: row.id, title: row.data.title, location: row.data.location, state: row.state, version: row.version,
        currentProgress: row.data.progress, currentProgressHasDateBasis: hasBasis, currentProgressRecordId: hasBasis ? current.recordId : null,
        pendingRecordId: pendingByTask.get(row.id) || null, actual };
    });
    return { projectId: pid, asOf, actualObservedAt: now(), records: records.map(row => ({ ...row, superseded: superseded.has(row.id) })), tasks,
      summary: { knownTasks: tasks.filter(row => row.actual.progress !== null).length, unknownTasks: tasks.filter(row => row.actual.progress === null).length } };
  }
  function checkTask(pid, taskId, taskVersion) {
    const task = getItem(pid, taskId, 'tasks');
    if (task.version !== taskVersion) fail(409, '任务已更新，请撤回旧申请并按当前任务版本重新填报');
    if (task.state !== 'active') fail(409, task.state === 'completed' ? '已完成任务须先由经理恢复施工，再填报或更正进度' : '请先开始施工；仅施工中的任务可填报或更正进度');
    return task;
  }
  function checkObservation(pid, taskId, date, value, correctsId) {
    const records = rows(pid, taskId), { effective } = effectiveRecords(records), original = correctsId ? records.find(row => row.id === correctsId) : null;
    if (correctsId && (!original || !effective.some(row => row.id === original.id))) fail(409, '更正必须针对本任务当前未被替代的已批准进度记录');
    if (original && original.effective_date !== date) fail(409, '更正只能保留原发生日期，不能移动日期');
    const others = effective.filter(row => row.id !== correctsId);
    if (others.some(row => row.effective_date === date)) fail(409, '同一任务同一日期已有有效进度；需要调整请办理原记录更正');
    const before = others.filter(row => row.effective_date < date).at(-1), after = others.find(row => row.effective_date > date);
    if (before && value < before.progress || after && value > after.progress) fail(409, '累计进度必须按发生日期非递减，请核对前后日期记录后再填报或更正');
    return original;
  }
  function mount(app, base, authorize, writer) {
    app.get(base + '/projects/:pid/progress', authorize, (req, res) => {
      const query = z.object({ asOf: z.iso.date().optional(), taskId: z.union([id, z.literal('')]).optional() }).strict().parse(req.query);
      res.json(store.transaction(() => { const { p } = authorized(req, false); return view(p.id, query); }));
    });
    app.post(base + '/projects/:pid/progress', authorize, writer, (req, res) => {
      const { p } = authorized(req), body = z.object({ requestId: id, taskId: id, taskVersion: version, effectiveDate: z.iso.date(), progress: z.number().int().min(0).max(100), note, correctsId: z.union([id, z.literal('')]).optional() }).strict().parse(req.body);
      res.status(201).json(mutate(req, p.id + ':progress:create', () => {
        const context = authorized(req); active(context.p); dateNotFuture(body.effectiveDate);
        const task = checkTask(p.id, body.taskId, body.taskVersion);
        if (pending(p.id, task.id)) fail(409, '该任务已有待复核进度，请先完成或撤回原申请');
        checkObservation(p.id, task.id, body.effectiveDate, body.progress, body.correctsId || null);
        const rid = randomUUID(), snapshot = { taskId: task.id, title: task.data.title, location: task.data.location, state: task.state, sourceVersion: task.version };
        db.prepare(`INSERT INTO engineering_progress(id,project_id,task_id,effective_date,progress,note,state,version,task_version,snapshot,corrects_id,requested_by,requester_name,created_at)
          VALUES(?,?,?,?,?,?,'submitted',1,?,?,?,?,?,?)`).run(rid, p.id, task.id, body.effectiveDate, body.progress, body.note, task.version, JSON.stringify(snapshot), body.correctsId || null, req.actor.id, req.actor.name, now());
        history(req.actor, p.id, task.id, 'tasks', 'progress_submit', (body.correctsId ? '提交进度更正：' : '提交日期进度：') + task.data.title + '；' + body.effectiveDate + '；' + body.progress + '%；' + body.note);
        return { id: rid, state: 'submitted', version: 1 };
      }));
    });
    app.post(base + '/projects/:pid/progress/:rid/state', authorize, writer, (req, res) => {
      const { p } = authorized(req), rid = id.parse(req.params.rid), body = z.object({ requestId: id, version, state: z.enum(['approved', 'rejected', 'cancelled']), note }).strict().parse(req.body);
      res.json(mutate(req, p.id + ':progress:' + rid + ':state', () => {
        const context = authorized(req); active(context.p);
        const row = parse(db.prepare('SELECT * FROM engineering_progress WHERE id=? AND project_id=?').get(rid, p.id));
        if (!row) fail(404, '进度记录不存在或不属于本项目');
        if (row.state !== 'submitted' || row.version !== body.version) fail(409, '进度记录已更新或已办理，请刷新核对');
        if (body.state === 'cancelled') { if (row.requested_by !== req.actor.id && !manager(context.role)) fail(403, '仅申请人或项目经理可以撤回进度申请'); }
        else {
          if (!manager(context.role)) fail(403, '进度须由项目经理或管理员复核');
          if (row.requested_by === req.actor.id) fail(409, '申请人不能复核自己的进度，请另一位经理办理');
        }
        let task = getItem(p.id, row.task_id, 'tasks'), sequence = null;
        if (body.state === 'approved') {
          task = checkTask(p.id, row.task_id, row.task_version); dateNotFuture(row.effective_date);
          checkObservation(p.id, row.task_id, row.effective_date, row.progress, row.corrects_id);
          sequence = db.prepare('SELECT COALESCE(MAX(approved_seq),0)+1 n FROM engineering_progress WHERE project_id=?').get(p.id).n;
        }
        db.prepare('UPDATE engineering_progress SET state=?,version=version+1,reviewed_by=?,reviewer_name=?,review_note=?,reviewed_at=?,approved_seq=? WHERE id=?').run(body.state, req.actor.id, req.actor.name, body.note, now(), sequence, row.id);
        if (body.state === 'approved') {
          task.data.progress = actualAt(p.id, task.id, baselineDate()).progress;
          // Even a backdated observation advances the optimistic task version.
          task = saveItem(task);
        }
        history(req.actor, p.id, row.task_id, 'tasks', 'progress_' + body.state, '日期进度 ' + row.snapshot.title + '；' + row.effective_date + '；' + row.progress + '%；' + body.note);
        return { id: row.id, state: body.state, version: row.version + 1, taskVersion: task.version, progress: task.data.progress };
      }));
    });
  }
  return { mount, pending, view, actualAt };
}
