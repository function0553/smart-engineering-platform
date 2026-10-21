import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail } from './service.mjs';

const id = z.string().uuid(), note = z.string().trim().min(1).max(2000);
const day = value => Date.parse(value + 'T00:00:00Z') / 86_400_000;
const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
export const baselineDate = (date = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(date);
const planTask = row => ({ id: row.id, title: row.data.title, location: row.data.location, owner: row.data.owner, startDate: row.data.startDate, dueDate: row.data.dueDate, predecessorId: row.data.predecessorId || '' });
const fingerprint = snapshot => createHash('sha256').update(JSON.stringify({ project: snapshot.project, tasks: snapshot.tasks.map(({ sourceVersion, capturedProgress, capturedState, ...task }) => task) })).digest('hex');

// A baseline is a server-owned plan snapshot. Approval changes only its decision
// metadata; task progress always comes from the current task rows.
export function createEngineeringBaselines({ store, access, active, mutate, history, getItems, manager, actualAt }) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS engineering_baselines(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES engineering_projects(id),
    title TEXT NOT NULL, note TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('submitted','approved','rejected','cancelled')), version INTEGER NOT NULL,
    snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), plan_hash TEXT NOT NULL,
    requested_by TEXT NOT NULL REFERENCES users(id), requester_name TEXT NOT NULL, created_at TEXT NOT NULL,
    reviewed_by TEXT REFERENCES users(id), reviewer_name TEXT, review_note TEXT, reviewed_at TEXT,
    approved_seq INTEGER CHECK(approved_seq IS NULL OR approved_seq>0),
    UNIQUE(project_id,approved_seq));
    CREATE INDEX IF NOT EXISTS engineering_baselines_project ON engineering_baselines(project_id,state,approved_seq);`);
  const pending = pid => !!db.prepare("SELECT 1 FROM engineering_baselines WHERE project_id=? AND state='submitted'").get(pid);

  function authorized(req) {
    const context = access(req, true);
    if (!manager(context.role)) fail(403, '计划基线须由项目经理或管理员办理');
    return context;
  }
  function capture(project) {
    const tasks = getItems(project.id).filter(row => row.kind === 'tasks' && row.state !== 'cancelled').map(row => ({ ...planTask(row), sourceVersion: row.version, capturedProgress: row.data.progress, capturedState: row.state })).sort((a, b) => a.id.localeCompare(b.id));
    if (!tasks.length) fail(409, '至少需要一项未取消的施工任务才能提交基线');
    const byId = new Map(tasks.map(task => [task.id, task]));
    for (const task of tasks) {
      if (!z.iso.date().safeParse(task.startDate).success || !z.iso.date().safeParse(task.dueDate).success || task.startDate > task.dueDate) fail(409, '任务计划日期无效，请先调整施工计划');
      if (task.predecessorId && !byId.has(task.predecessorId)) fail(409, '前置任务未包含在有效计划中，请先调整依赖');
      const visited = new Set([task.id]);
      let next = task.predecessorId;
      while (next) {
        if (visited.has(next)) fail(409, '施工计划的前置任务形成循环');
        visited.add(next);
        const predecessor = byId.get(next);
        if (!predecessor) fail(409, '前置任务未包含在有效计划中，请先调整依赖');
        next = predecessor.predecessorId;
      }
      if (task.predecessorId && byId.get(task.predecessorId).dueDate >= task.startDate) fail(409, '前置任务须在后续任务开始日期之前完成，不能同日或重叠');
    }
    return { project: { startDate: project.data.startDate, dueDate: project.data.dueDate }, tasks };
  }
  function metadata(row) {
    const { snapshot, ...fields } = row;
    const frozen = JSON.parse(snapshot);
    return { ...fields, taskCount: frozen.tasks.length, projectStart: frozen.project.startDate, projectDue: frozen.project.dueDate };
  }
  function compare(pid, snapshot, current, asOf, actualMode) {
    const currentTasks = current.filter(row => row.kind === 'tasks'), byId = new Map(currentTasks.map(row => [row.id, row]));
    let totalDuration = 0, plannedWeighted = 0, actualWeighted = 0, knownDuration = 0, unknownTasks = 0;
    const tasks = snapshot.tasks.map(frozen => {
      const row = byId.get(frozen.id), missing = !row, cancelled = row?.state === 'cancelled';
      const baselineDuration = day(frozen.dueDate) - day(frozen.startDate) + 1;
      const planned = Math.max(0, Math.min(1, (day(asOf) - day(frozen.startDate) + 1) / baselineDuration)) * 100;
      const actualObservation = actualMode === 'dated' ? actualAt(pid, frozen.id, asOf) : null;
      const actual = actualMode === 'dated' ? actualObservation.progress : missing || cancelled ? 0 : Math.max(0, Math.min(100, Number(row.data.progress) || 0));
      const currentPlan = row && planTask(row);
      const changed = missing || cancelled || Object.entries(currentPlan).some(([key, value]) => value !== frozen[key]);
      totalDuration += baselineDuration; plannedWeighted += baselineDuration * planned;
      if (actual === null) unknownTasks++; else { knownDuration += baselineDuration; actualWeighted += baselineDuration * actual; }
      return {
        id: frozen.id, title: frozen.title, location: frozen.location, owner: frozen.owner,
        baselineStart: frozen.startDate, baselineDue: frozen.dueDate,
        currentStart: row?.data.startDate ?? null, currentDue: row?.data.dueDate ?? null,
        baselineDuration, plannedProgress: round(planned), actualProgress: actual === null ? null : round(actual), actualObservation, lastReportedProgress: row?.data.progress ?? null, variance: actual === null ? null : round(actual - planned),
        startShiftDays: row ? day(row.data.startDate) - day(frozen.startDate) : null,
        dueShiftDays: row ? day(row.data.dueDate) - day(frozen.dueDate) : null,
        currentState: row?.state ?? 'missing', changed, cancelled, missing,
        predecessorId: frozen.predecessorId, currentTitle: row?.data.title ?? null,
        currentLocation: row?.data.location ?? null, currentOwner: row?.data.owner ?? null,
        currentPredecessorId: row?.data.predecessorId ?? null,
      };
    });
    const frozenIds = new Set(snapshot.tasks.map(task => task.id));
    const addedTasks = currentTasks.filter(row => row.state !== 'cancelled' && !frozenIds.has(row.id)).map(row => ({ ...planTask(row), progress: row.data.progress, state: row.state }));
    return { tasks, addedTasks, summary: {
      plannedProgress: round(plannedWeighted / totalDuration), actualProgress: unknownTasks ? null : round(actualWeighted / totalDuration), variance: unknownTasks ? null : round((actualWeighted - plannedWeighted) / totalDuration),
      knownTasks: tasks.length - unknownTasks, unknownTasks, knownWeightPercent: round(knownDuration / totalDuration * 100),
      totalTasks: tasks.length, changedTasks: tasks.filter(task => task.changed).length, cancelledTasks: tasks.filter(task => task.cancelled).length,
      missingTasks: tasks.filter(task => task.missing).length, addedTasks: addedTasks.length,
    } };
  }
  function view(pid, { baselineId, asOf = baselineDate(), actualMode = 'latest' } = {}) {
    z.iso.date().parse(asOf); z.enum(['latest', 'dated']).parse(actualMode);
    if (actualMode === 'dated' && asOf > baselineDate()) fail(400, '历史实际进度的比较日期不能晚于今天');
    const rows = db.prepare('SELECT * FROM engineering_baselines WHERE project_id=? ORDER BY created_at DESC,id DESC').all(pid);
    const current = rows.filter(row => row.state === 'approved').sort((a, b) => b.approved_seq - a.approved_seq)[0];
    const selected = baselineId ? rows.find(row => row.id === baselineId) : current;
    if (baselineId && !selected) fail(404, '计划基线不存在或不属于本项目');
    const snapshot = selected ? JSON.parse(selected.snapshot) : null;
    const comparison = selected?.state === 'approved' ? compare(pid, snapshot, getItems(pid), asOf, actualMode) : null;
    return { baselines: rows.map(metadata), currentBaselineId: current?.id ?? null, selectedBaselineId: selected?.id ?? null, asOf, actualMode, actualObservedAt: new Date().toISOString(), selectedBaseline: selected ? { ...metadata(selected), snapshot } : null, comparison };
  }
  function mount(app, base, authorize, writer) {
    app.get(base + '/projects/:pid/baselines', authorize, (req, res) => {
      const query = z.object({ baselineId: z.union([id, z.literal('')]).optional(), asOf: z.iso.date().optional(), actualMode: z.enum(['latest', 'dated']).optional() }).strict().parse(req.query);
      res.json(store.transaction(() => { const { p } = access(req); return view(p.id, query); }));
    });
    app.post(base + '/projects/:pid/baselines', authorize, writer, (req, res) => {
      const { p } = authorized(req), body = z.object({ requestId: id, title: z.string().trim().min(1).max(200), note }).strict().parse(req.body);
      res.status(201).json(mutate(req, p.id + ':baseline:create', () => {
        const current = authorized(req); active(current.p);
        const snapshot = capture(current.p), bid = randomUUID();
        db.prepare('INSERT INTO engineering_baselines(id,project_id,title,note,state,version,snapshot,plan_hash,requested_by,requester_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(bid, p.id, body.title, body.note, 'submitted', 1, JSON.stringify(snapshot), fingerprint(snapshot), req.actor.id, req.actor.name, new Date().toISOString());
        history(req.actor, p.id, bid, 'baseline', 'baseline_submit', '提交计划基线：' + body.title + '；' + body.note);
        return { id: bid, state: 'submitted', version: 1 };
      }));
    });
    app.post(base + '/projects/:pid/baselines/:bid/state', authorize, writer, (req, res) => {
      const { p } = authorized(req), bid = id.parse(req.params.bid);
      const body = z.object({ requestId: id, version: z.number().int().positive(), state: z.enum(['approved', 'rejected', 'cancelled']), note }).strict().parse(req.body);
      if (!db.prepare('SELECT 1 FROM engineering_baselines WHERE id=? AND project_id=?').get(bid, p.id)) fail(404, '计划基线不存在或不属于本项目');
      res.json(mutate(req, p.id + ':baseline:' + bid + ':state', () => {
        const current = authorized(req); active(current.p);
        const row = db.prepare('SELECT * FROM engineering_baselines WHERE id=? AND project_id=?').get(bid, p.id);
        if (!row || row.state !== 'submitted' || row.version !== body.version) fail(409, '基线已更新或已办理，请刷新核对');
        let sequence = null;
        if (body.state === 'approved') {
          if (row.requested_by === req.actor.id) fail(409, '申请人不能审批自己的计划基线，请另一位经理审核');
          if (fingerprint(capture(current.p)) !== row.plan_hash) fail(409, '当前计划已变化，请撤回基线并重新提交');
          sequence = db.prepare('SELECT COALESCE(MAX(approved_seq),0)+1 seq FROM engineering_baselines WHERE project_id=?').get(p.id).seq;
        }
        db.prepare('UPDATE engineering_baselines SET state=?,version=version+1,reviewed_by=?,reviewer_name=?,review_note=?,reviewed_at=?,approved_seq=? WHERE id=?').run(body.state, req.actor.id, req.actor.name, body.note, new Date().toISOString(), sequence, bid);
        history(req.actor, p.id, bid, 'baseline', 'baseline_' + body.state, '计划基线 ' + row.title + '：' + body.note);
        return { id: bid, state: body.state, version: row.version + 1, approved_seq: sequence };
      }));
    });
  }
  // Internal read-only source for financial target plans. The public baseline
  // routes and their snapshots keep their existing non-financial projection.
  function snapshot(pid) {
    const rows = db.prepare('SELECT * FROM engineering_baselines WHERE project_id=? ORDER BY created_at DESC,id DESC').all(pid)
      .map(row => ({ ...row, snapshot: JSON.parse(row.snapshot) }));
    const current = rows.filter(row => row.state === 'approved').sort((a, b) => b.approved_seq - a.approved_seq)[0];
    return { currentBaselineId: current?.id || null, baselines: rows };
  }
  return { mount, pending, view, snapshot };
}
