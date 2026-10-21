import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail } from './service.mjs';
import { baselineDate } from './engineering-baselines.mjs';
import { buildEngineeringTaskValues } from './engineering-task-value.mjs';

const id = z.string().uuid(), title = z.string().trim().min(1).max(200);
const note = z.string().trim().min(1).max(2000), version = z.number().int().positive();
const MAX_AMOUNT = 1_000_000_000_000, MAX_QUANTITY = 1_000_000_000;
const linesSchema = z.array(z.object({ boqItemId: id, taskId: id, quantity: z.number().int().positive().max(MAX_QUANTITY) }).strict()).min(1).max(500);
const now = () => new Date().toISOString();
const parse = row => row ? { ...row, snapshot: JSON.parse(row.snapshot) } : null;
const day = value => Date.parse(value + 'T00:00:00Z') / 86_400_000;
const round = (a, b) => (BigInt(a) * BigInt(b) + 500n) / 1000n;
const invalid = () => fail(422, '目标产值方案的来源、冻结数量或金额不一致，请核对台账');
const safe = value => { if (!Number.isSafeInteger(value)) invalid(); return value; };
const number = (value, max = MAX_AMOUNT, min = 0) => { if (!Number.isSafeInteger(value) || value < min || value > max) invalid(); return value; };
const copyTask = task => ({ id: task.id, title: task.title, location: task.location, owner: task.owner, startDate: task.startDate, dueDate: task.dueDate, predecessorId: task.predecessorId || '' });
const taskData = row => copyTask({ id: row.id, ...row.data });
const copyBoq = line => Object.fromEntries(['id', 'code', 'name', 'location', 'unit', 'quantity', 'unitPrice', 'amount'].map(key => [key, line[key]]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Allocation is deterministic for a complete or partial draft: each BOQ item's
// task UUID order carries the fractional cent to the next allocation.
function allocate(inputs, boqLines, tasks, status = 400) {
  const problem = message => fail(status, message);
  const boqById = new Map(boqLines.map(line => [line.id, line])), taskById = new Map(tasks.map(task => [task.id, task]));
  const pairs = new Set(), allocated = new Map(), lines = [];
  for (const input of [...inputs].sort((a, b) => a.boqItemId.localeCompare(b.boqItemId) || a.taskId.localeCompare(b.taskId))) {
    const item = boqById.get(input.boqItemId), task = taskById.get(input.taskId);
    if (!item || item.quantity <= 0) problem('目标分配须引用本合同正数量清单条目');
    if (!task) problem('目标分配任务不存在或不在所选日期基线内');
    const key = input.boqItemId + ':' + input.taskId;
    if (pairs.has(key)) problem('同一清单条目不能向同一任务重复分配');
    pairs.add(key);
    const used = allocated.get(item.id) || { quantity: 0, amount: 0 };
    const nextQuantity = safe(used.quantity + input.quantity);
    if (nextQuantity > item.quantity) problem('分配数量超过清单条目总数量');
    const nextAmount = Number(round(nextQuantity, item.unitPrice)), amount = safe(nextAmount - used.amount);
    if (amount < 0 || nextAmount > item.amount) problem('分配金额超过清单条目总金额');
    allocated.set(item.id, { quantity: nextQuantity, amount: nextAmount });
    lines.push({ boqItemId: item.id, taskId: task.id, code: item.code, name: item.name, location: item.location,
      unit: item.unit, unitPrice: item.unitPrice, quantity: input.quantity, amount,
      taskTitle: task.title, taskLocation: task.location, startDate: task.startDate, dueDate: task.dueDate });
  }
  const remaining = boqLines.map(item => ({ boqItemId: item.id, quantity: item.quantity - (allocated.get(item.id)?.quantity || 0), amount: item.amount - (allocated.get(item.id)?.amount || 0) }));
  const totalAmount = boqLines.reduce((total, item) => safe(total + item.amount), 0);
  const allocatedAmount = lines.reduce((total, line) => safe(total + line.amount), 0);
  return { lines, totalAmount, allocatedAmount, remainingAmount: totalAmount - allocatedAmount, remaining };
}

function validateFrozen(plan, context) {
  const { project, items, boq, baselines } = context, snapshot = plan.snapshot;
  if (!id.safeParse(plan.id).success || plan.project_id !== project.id || !snapshot || typeof snapshot !== 'object'
    || !['draft', 'submitted', 'approved', 'rejected', 'cancelled'].includes(plan.state)) invalid();
  const contract = items.find(row => row.id === plan.contract_id && row.kind === 'contracts');
  const revision = boq.revisions.find(row => row.id === plan.boq_revision_id && row.project_id === project.id && row.contract_id === plan.contract_id);
  const baseline = baselines.baselines.find(row => row.id === plan.schedule_baseline_id && row.project_id === project.id);
  if (!contract || !revision || !baseline || revision.state !== 'approved' || baseline.state !== 'approved'
    || snapshot.contractId !== contract.id || !['income', 'expense'].includes(snapshot.contractDirection) || snapshot.contractDirection !== contract.data.direction
    || snapshot.boqRevisionId !== revision.id || snapshot.scheduleBaselineId !== baseline.id
    || snapshot.boqRevisionTitle !== revision.title || snapshot.scheduleBaselineTitle !== baseline.title
    || typeof snapshot.contractTitle !== 'string' || !snapshot.contractTitle.trim()
    || !same(snapshot.boqLines, revision.lines.map(copyBoq))
    || !same(snapshot.tasks, baseline.snapshot.tasks.map(copyTask)) || !same(snapshot.project, baseline.snapshot.project)) invalid();
  number(revision.total); number(snapshot.totalAmount); number(snapshot.allocatedAmount); number(snapshot.remainingAmount);
  if (!Array.isArray(snapshot.boqLines) || snapshot.boqLines.length < 1 || snapshot.boqLines.length > 200
    || new Set(snapshot.boqLines.map(line => line.id)).size !== snapshot.boqLines.length
    || new Set(snapshot.tasks.map(task => task.id)).size !== snapshot.tasks.length) invalid();
  for (const line of snapshot.boqLines) {
    if (!id.safeParse(line.id).success) invalid();
    number(line.quantity, MAX_QUANTITY); number(line.unitPrice, MAX_AMOUNT, 1); number(line.amount);
    if (BigInt(line.amount) !== round(line.quantity, line.unitPrice)) invalid();
  }
  for (const task of snapshot.tasks) {
    if (!id.safeParse(task.id).success || !z.iso.date().safeParse(task.startDate).success || !z.iso.date().safeParse(task.dueDate).success || task.startDate > task.dueDate) invalid();
  }
  if (!Array.isArray(snapshot.lines)) invalid();
  const inputs = snapshot.lines.map(line => ({ boqItemId: line.boqItemId, taskId: line.taskId, quantity: line.quantity }));
  if (!linesSchema.safeParse(inputs).success) invalid();
  const expected = allocate(inputs, snapshot.boqLines, snapshot.tasks, 422);
  for (const key of ['lines', 'totalAmount', 'allocatedAmount', 'remainingAmount', 'remaining']) if (!same(snapshot[key], expected[key])) invalid();
  if (snapshot.totalAmount !== revision.total || ['submitted', 'approved'].includes(plan.state) && expected.remaining.some(line => line.quantity || line.amount)) invalid();
  if (plan.state === 'approved') number(plan.approved_seq, Number.MAX_SAFE_INTEGER, 1);
}

function driftFor(snapshot, { project, items, boq, baselines }) {
  const reasons = [], append = (code, reason, taskId) => reasons.push({ code, reason, ...(taskId ? { taskId } : {}) });
  if (boq.contracts.find(row => row.contractId === snapshot.contractId)?.currentRevisionId !== snapshot.boqRevisionId) append('boq_changed', '当前有效清单版本已变化');
  if (baselines.currentBaselineId !== snapshot.scheduleBaselineId) append('baseline_changed', '当前已批准施工日期基线已变化');
  if (project.data.startDate !== snapshot.project.startDate || project.data.dueDate !== snapshot.project.dueDate) append('project_dates_changed', '项目计划日期已变化');
  const currentTasks = new Map(items.filter(row => row.kind === 'tasks').map(row => [row.id, row]));
  for (const task of snapshot.tasks) {
    const current = currentTasks.get(task.id);
    if (!current) append('task_missing', '基线中的任务已缺失', task.id);
    else if (current.state === 'cancelled') append('task_cancelled', '基线中的任务已取消', task.id);
    else if (!same(taskData(current), task)) append('task_changed', '任务名称、部位、负责人、计划日期或前置关系已变化', task.id);
  }
  const ids = new Set(snapshot.tasks.map(task => task.id));
  for (const current of currentTasks.values()) if (current.state !== 'cancelled' && !ids.has(current.id)) append('task_added', '当前施工计划新增了基线外任务', current.id);
  return { changed: reasons.length > 0, reasons };
}

function planned(value, start, due, asOf) {
  const duration = day(due) - day(start) + 1, elapsed = Math.max(0, Math.min(duration, day(asOf) - day(start) + 1));
  return Number((BigInt(value) * BigInt(elapsed) * 2n + BigInt(duration)) / (BigInt(duration) * 2n));
}

function compare(plan, context, asOf, observedAt) {
  const snapshot = plan.snapshot, sourceReport = buildEngineeringTaskValues(context.items, { projectId: context.project.id, observedAt });
  const lines = snapshot.lines.map(line => ({ ...line, targetQuantity: line.quantity, targetAmount: line.amount,
    plannedQuantity: planned(line.quantity, line.startDate, line.dueDate, asOf), plannedAmount: planned(line.amount, line.startDate, line.dueDate, asOf),
    actualQuantity: 0, actualAmount: 0, sourceCount: 0 }));
  const byPair = new Map(lines.map(line => [line.boqItemId + ':' + line.taskId, line])), targetItems = new Set(snapshot.boqLines.filter(line => line.quantity > 0).map(line => line.id));
  const outside = [], sources = [];
  for (const source of sourceReport.sources.filter(row => row.contractId === plan.contract_id && row.state === 'approved' && !row.voided)) {
    const target = byPair.get(source.boqItemId + ':' + source.taskId);
    if (!target) {
      const outsideReason = !source.boqItemId ? 'free' : !source.taskId ? 'unassigned' : !targetItems.has(source.boqItemId) ? 'item_not_in_plan' : 'task_not_in_plan';
      outside.push({ ...source, outsideReason }); continue;
    }
    // Historical measured cents stay attached to their original task. BOQ and
    // target allocation may have carried a rounding cent to different tasks.
    if (source.unit !== target.unit || source.unitPrice !== target.unitPrice) invalid();
    target.actualQuantity = safe(target.actualQuantity + source.effectiveQuantity);
    target.actualAmount = safe(target.actualAmount + source.effectiveAmount); target.sourceCount += 1;
    sources.push(source);
  }
  const tasks = new Map(), summary = { targetAmount: snapshot.allocatedAmount, plannedAmount: 0, actualAmount: 0, varianceAmount: 0, outsideAmount: 0, totalActualAmount: 0 };
  for (const line of lines) {
    line.quantityVariance = safe(line.actualQuantity - line.targetQuantity); line.amountVariance = safe(line.actualAmount - line.targetAmount);
    line.plannedQuantityVariance = safe(line.actualQuantity - line.plannedQuantity); line.plannedAmountVariance = safe(line.actualAmount - line.plannedAmount);
    const task = tasks.get(line.taskId) || { taskId: line.taskId, taskTitle: line.taskTitle, taskLocation: line.taskLocation, targetAmount: 0, plannedAmount: 0, actualAmount: 0, varianceAmount: 0 };
    for (const key of ['targetAmount', 'plannedAmount', 'actualAmount']) task[key] = safe(task[key] + line[key]);
    task.varianceAmount = safe(task.actualAmount - task.plannedAmount); tasks.set(line.taskId, task);
    summary.plannedAmount = safe(summary.plannedAmount + line.plannedAmount); summary.actualAmount = safe(summary.actualAmount + line.actualAmount);
  }
  summary.outsideAmount = outside.reduce((total, source) => safe(total + source.effectiveAmount), 0);
  summary.totalActualAmount = safe(summary.actualAmount + summary.outsideAmount); summary.varianceAmount = safe(summary.actualAmount - summary.plannedAmount);
  return { summary, lines, tasks: [...tasks.values()], outside, sources, drift: driftFor(snapshot, context) };
}

/** Rebuild from one database snapshot, never from a client comparison cache.
 * asOf affects only frozen planned values; actuals always mean observedAt. */
export function buildEngineeringValuePlansView({ project, plans, items, boq, baselines }, { planId, contractId, asOf = baselineDate(), observedAt = now() } = {}) {
  if (!id.safeParse(project?.id).success || !project.data || !Array.isArray(plans) || !Array.isArray(items) || !Array.isArray(boq?.contracts) || !Array.isArray(boq?.revisions) || !Array.isArray(baselines?.baselines)
    || !z.iso.date().safeParse(asOf).success || items.some(row => !row || !id.safeParse(row.id).success || row.project_id !== project.id || !row.data || typeof row.data !== 'object')
    || new Set(items.map(row => row.id)).size !== items.length || plans.some(row => !row || !id.safeParse(row.id).success)
    || new Set(plans.map(row => row.id)).size !== plans.length) invalid();
  const contractIds = new Set(items.filter(row => row.kind === 'contracts').map(row => row.id));
  if (boq.contracts.some(row => !row || !contractIds.has(row.contractId))
    || boq.revisions.some(row => !row || row.project_id !== project.id || !contractIds.has(row.contract_id) || !Array.isArray(row.lines) || row.lines.some(line => !line || typeof line !== 'object'))
    || baselines.baselines.some(row => !row || row.project_id !== project.id || !row.snapshot || !Array.isArray(row.snapshot.tasks) || row.snapshot.tasks.some(task => !task || typeof task !== 'object') || !row.snapshot.project)) invalid();
  const context = { project, plans, items, boq, baselines };
  if (contractId && !items.some(row => row.id === contractId && row.kind === 'contracts')) fail(404, '合同不存在或不属于本项目');
  const rows = plans.map(row => { validateFrozen(row, context); return { ...row, drift: driftFor(row.snapshot, context) }; });
  const approved = rows.filter(row => row.state === 'approved').sort((a, b) => b.approved_seq - a.approved_seq);
  const contracts = items.filter(row => row.kind === 'contracts').map(row => ({ contractId: row.id, currentPlanId: approved.find(plan => plan.contract_id === row.id)?.id || null, pendingPlanId: rows.find(plan => plan.contract_id === row.id && ['draft', 'submitted'].includes(plan.state))?.id || null }));
  const selected = planId ? rows.find(row => row.id === planId && (!contractId || row.contract_id === contractId)) : approved.find(row => !contractId || row.contract_id === contractId);
  if (planId && !selected) fail(404, '目标产值方案不存在或不属于本合同/项目');
  return { projectId: project.id, contracts, plans: rows, selectedPlanId: selected?.id || null, selectedPlan: selected || null,
    asOf, actualObservedAt: observedAt, comparison: selected?.state === 'approved' ? compare(selected, context, asOf, observedAt) : null,
    baselines, sources: { boq, baselines } };
}

export function createEngineeringValuePlans({ store, access, active, mutate, history, getItems, getItem, financial, manager, voided, boq, baselines }) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS engineering_value_plans(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES engineering_projects(id), contract_id TEXT NOT NULL REFERENCES engineering_items(id),
    boq_revision_id TEXT NOT NULL REFERENCES engineering_boq_revisions(id), schedule_baseline_id TEXT NOT NULL REFERENCES engineering_baselines(id),
    title TEXT NOT NULL, note TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('draft','submitted','approved','rejected','cancelled')), version INTEGER NOT NULL,
    snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), created_by TEXT NOT NULL REFERENCES users(id), edited_by TEXT REFERENCES users(id), submitted_by TEXT REFERENCES users(id),
    creator_name TEXT NOT NULL, editor_name TEXT, submitter_name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, submitted_at TEXT,
    reviewed_by TEXT REFERENCES users(id), reviewer_name TEXT, review_note TEXT, reviewed_at TEXT, approved_seq INTEGER,
    UNIQUE(project_id,approved_seq));
    CREATE UNIQUE INDEX IF NOT EXISTS engineering_value_plans_pending ON engineering_value_plans(contract_id) WHERE state IN ('draft','submitted');
    CREATE INDEX IF NOT EXISTS engineering_value_plans_project ON engineering_value_plans(project_id,state,approved_seq);`);
  const pending = (pid, cid) => !!db.prepare("SELECT 1 FROM engineering_value_plans WHERE project_id=? AND state IN ('draft','submitted')" + (cid ? ' AND contract_id=?' : '')).get(...(cid ? [pid, cid] : [pid]));
  const rows = pid => db.prepare('SELECT * FROM engineering_value_plans WHERE project_id=? ORDER BY created_at DESC,id DESC').all(pid).map(parse);
  const sources = project => ({ project, plans: rows(project.id), items: getItems(project.id).map(row => ({ ...row, voided: voided(row.id) })), boq: boq.projectView(project.id), baselines: baselines.snapshot(project.id) });
  const view = (project, options) => buildEngineeringValuePlansView(sources(project), options);
  const authorized = (req, write = true) => { const context = access(req, write); if (!financial(context.role)) fail(403, '没有项目目标产值经营权限'); return context; };
  const openContract = (pid, cid) => { const contract = getItem(pid, cid, 'contracts'); if (contract.state !== 'approved') fail(409, '目标方案须关联已批准且未关闭的合同'); return contract; };
  const getPlan = (pid, vid) => { const row = parse(db.prepare('SELECT * FROM engineering_value_plans WHERE id=? AND project_id=?').get(vid, pid)); if (!row) fail(404, '目标产值方案不存在或不属于本项目'); return row; };
  function prepare(project, cid, boqRevisionId, scheduleBaselineId, inputs) {
    const context = sources(project), contract = openContract(project.id, cid);
    if (context.boq.contracts.find(row => row.contractId === cid)?.currentRevisionId !== boqRevisionId || context.baselines.currentBaselineId !== scheduleBaselineId) fail(409, '清单或施工日期基线已变化，请取消旧草稿并按当前来源重新建立');
    const revision = context.boq.revisions.find(row => row.id === boqRevisionId && row.contract_id === cid && row.state === 'approved' && !row.voided);
    const baseline = context.baselines.baselines.find(row => row.id === scheduleBaselineId && row.state === 'approved');
    if (!revision || !baseline) fail(409, '目标方案需要本合同当前有效已批准清单和当前已批准施工日期基线');
    const snapshot = { contractId: cid, contractTitle: contract.data.title, contractDirection: contract.data.direction,
      boqRevisionId, boqRevisionTitle: revision.title, scheduleBaselineId, scheduleBaselineTitle: baseline.title,
      project: { ...baseline.snapshot.project }, boqLines: revision.lines.map(copyBoq), tasks: baseline.snapshot.tasks.map(copyTask) };
    const drift = driftFor(snapshot, context);
    if (drift.changed) fail(409, '施工计划已经偏离日期基线，请先调整计划并批准新的日期基线');
    for (const input of inputs) {
      const task = getItem(project.id, input.taskId, 'tasks');
      if (task.state === 'cancelled') fail(409, '目标方案不能向已取消任务分配工程量');
    }
    Object.assign(snapshot, allocate(inputs, snapshot.boqLines, snapshot.tasks));
    return snapshot;
  }
  function verify(project, row) {
    const context = sources(project); openContract(project.id, row.contract_id); validateFrozen(row, context);
    if (driftFor(row.snapshot, context).changed) fail(409, '方案来源或任务计划已变化，请取消旧草稿并重新建立目标方案');
    if (row.snapshot.remaining.some(line => line.quantity !== 0 || line.amount !== 0)) fail(409, '提交或批准前须将全部正数量清单条目完整分配给任务');
  }
  function close(pid, cid) { if (pending(pid, cid)) fail(409, '合同仍有待办目标产值方案，暂不能结清关闭'); }
  function mount(app, base, authorize, writer) {
    app.get(base + '/projects/:pid/value-plans', authorize, (req, res) => {
      const query = z.object({ planId: z.union([id, z.literal('')]).optional(), contractId: z.union([id, z.literal('')]).optional(), asOf: z.iso.date().optional() }).strict().parse(req.query);
      res.json(store.transaction(() => { const { p } = authorized(req, false); return view(p, query); }));
    });
    app.post(base + '/projects/:pid/value-plans', authorize, writer, (req, res) => {
      const { p } = authorized(req), body = z.object({ requestId: id, contractId: id, boqRevisionId: id, scheduleBaselineId: id, title, note, lines: linesSchema }).strict().parse(req.body);
      res.status(201).json(mutate(req, p.id + ':value-plan:create', () => {
        const context = authorized(req); active(context.p);
        if (pending(p.id, body.contractId)) fail(409, '合同已有待办目标产值方案，请先编辑、审批或取消');
        const snapshot = prepare(context.p, body.contractId, body.boqRevisionId, body.scheduleBaselineId, body.lines), vid = randomUUID(), at = now();
        db.prepare(`INSERT INTO engineering_value_plans(id,project_id,contract_id,boq_revision_id,schedule_baseline_id,title,note,state,version,snapshot,created_by,creator_name,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,'draft',1,?,?,?,?,?)`).run(vid, p.id, body.contractId, body.boqRevisionId, body.scheduleBaselineId, body.title, body.note, JSON.stringify(snapshot), req.actor.id, req.actor.name, at, at);
        history(req.actor, p.id, body.contractId, 'contracts', 'value_plan_create', '创建目标产值方案：' + body.title);
        return { id: vid, state: 'draft', version: 1 };
      }));
    });
    app.put(base + '/projects/:pid/value-plans/:vid', authorize, writer, (req, res) => {
      const { p } = authorized(req), vid = id.parse(req.params.vid), body = z.object({ requestId: id, version, title, note, lines: linesSchema }).strict().parse(req.body);
      getPlan(p.id, vid);
      res.json(mutate(req, p.id + ':value-plan:' + vid + ':edit', () => {
        const context = authorized(req); active(context.p); const row = getPlan(p.id, vid);
        if (row.state !== 'draft' || row.version !== body.version) fail(409, '方案已更新或不可编辑，请刷新核对');
        const snapshot = prepare(context.p, row.contract_id, row.boq_revision_id, row.schedule_baseline_id, body.lines);
        db.prepare('UPDATE engineering_value_plans SET title=?,note=?,snapshot=?,edited_by=?,editor_name=?,updated_at=?,version=version+1 WHERE id=?')
          .run(body.title, body.note, JSON.stringify(snapshot), req.actor.id, req.actor.name, now(), vid);
        history(req.actor, p.id, row.contract_id, 'contracts', 'value_plan_update', '修改目标产值方案：' + body.title);
        return { id: vid, state: 'draft', version: row.version + 1 };
      }));
    });
    app.post(base + '/projects/:pid/value-plans/:vid/state', authorize, writer, (req, res) => {
      const { p } = authorized(req), vid = id.parse(req.params.vid);
      const body = z.object({ requestId: id, version, state: z.enum(['submitted', 'approved', 'rejected', 'cancelled']), note }).strict().parse(req.body);
      getPlan(p.id, vid);
      res.json(mutate(req, p.id + ':value-plan:' + vid + ':state', () => {
        const context = authorized(req); active(context.p); const row = getPlan(p.id, vid);
        if (row.version !== body.version || !({ draft: ['submitted', 'cancelled'], submitted: ['approved', 'rejected', 'cancelled'] }[row.state] || []).includes(body.state)) fail(409, '方案状态或版本已变化，请刷新核对');
        if (['approved', 'rejected'].includes(body.state)) {
          if (!manager(context.role)) fail(403, '目标方案须由项目经理或管理员复核');
          if ([row.created_by, row.edited_by, row.submitted_by].includes(req.actor.id)) fail(409, '方案创建人、最后修改人或提交人不能复核，请另一位经理审核');
        }
        if (['submitted', 'approved'].includes(body.state)) verify(context.p, row);
        const sequence = body.state === 'approved' ? db.prepare('SELECT COALESCE(MAX(approved_seq),0)+1 seq FROM engineering_value_plans WHERE project_id=?').get(p.id).seq : null;
        const at = now(), submitted = body.state === 'submitted';
        db.prepare(`UPDATE engineering_value_plans SET state=?,version=version+1,updated_at=?,submitted_by=?,submitter_name=?,submitted_at=?,
          reviewed_by=?,reviewer_name=?,review_note=?,reviewed_at=?,approved_seq=? WHERE id=?`)
          .run(body.state, at, submitted ? req.actor.id : row.submitted_by, submitted ? req.actor.name : row.submitter_name, submitted ? at : row.submitted_at,
            submitted ? null : req.actor.id, submitted ? null : req.actor.name, submitted ? null : body.note, submitted ? null : at, sequence, vid);
        history(req.actor, p.id, row.contract_id, 'contracts', 'value_plan_' + body.state, '目标方案 ' + row.title + '：' + body.note);
        return { id: vid, state: body.state, version: row.version + 1, approved_seq: sequence };
      }));
    });
  }
  return { mount, view, pending, close };
}
