import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail } from './service.mjs';

const MAX_AMOUNT = 1_000_000_000_000;
const MAX_QUANTITY = 1_000_000_000;
const id = z.string().uuid();
const title = z.string().trim().min(1).max(200);
const note = z.string().trim().min(1).max(2000);
const version = z.number().int().positive();
const lineSchema = z.object({
  id: id.optional(), code: title.max(80), name: title, location: title,
  unit: title.max(30), quantity: z.number().int().min(0).max(MAX_QUANTITY),
  unitPrice: z.number().int().positive().max(MAX_AMOUNT),
}).strict();
const linesSchema = z.array(lineSchema).min(1).max(200);
const measurementInput = z.array(z.object({
  boqItemId: id, quantity: z.number().int().positive().max(MAX_QUANTITY),
  taskId: z.union([id, z.literal('')]).optional(),
  note: z.string().trim().max(500).optional().default(''),
}).strict()).min(1).max(50);
const identityFields = ['code', 'name', 'location', 'unit', 'unitPrice'];
const sameLines = (left, right, fields) => left.length === right.length && left.every((line, index) => fields.every(field => field === 'taskId' ? (line[field] || '') === (right[index][field] || '') : line[field] === right[index][field]));
const now = () => new Date().toISOString();
const parse = row => row ? { ...row, lines: JSON.parse(row.lines) } : null;
const roundAmount = (quantity, unitPrice) => (BigInt(quantity) * BigInt(unitPrice) + 500n) / 1000n;
const boundedAmount = value => {
  if (value < 0n || value > BigInt(MAX_AMOUNT)) fail(400, '清单金额超出允许范围');
  return Number(value);
};

// Approved snapshots and measurement quotes are immutable. Corrections release
// their effects by excluding the original rows, never by rewriting those rows.
export function createEngineeringBoq({ store, access, active, mutate, history, getItems, getItem, manager, financial, voided, contractSummary, saveItem }) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS engineering_boq_modes(
    project_id TEXT NOT NULL REFERENCES engineering_projects(id),
    contract_id TEXT PRIMARY KEY REFERENCES engineering_items(id), activated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS engineering_boq_revisions(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES engineering_projects(id),
    contract_id TEXT NOT NULL REFERENCES engineering_items(id),
    base_revision_id TEXT REFERENCES engineering_boq_revisions(id),
    title TEXT NOT NULL, note TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('draft','submitted','approved','cancelled')), version INTEGER NOT NULL,
    lines TEXT NOT NULL CHECK(json_valid(lines)), total INTEGER NOT NULL, delta INTEGER NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id), edited_by TEXT REFERENCES users(id),
    creator_name TEXT NOT NULL, editor_name TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    submitted_at TEXT, reviewed_by TEXT REFERENCES users(id), reviewer_name TEXT, review_note TEXT, reviewed_at TEXT,
    variation_id TEXT REFERENCES engineering_items(id), approved_seq INTEGER,
    UNIQUE(contract_id,approved_seq));
    CREATE UNIQUE INDEX IF NOT EXISTS engineering_boq_pending_contract ON engineering_boq_revisions(contract_id) WHERE state IN ('draft','submitted');
    CREATE INDEX IF NOT EXISTS engineering_boq_project ON engineering_boq_revisions(project_id,contract_id,state);`);

  const enabled = (pid, cid) => !!db.prepare('SELECT 1 FROM engineering_boq_modes WHERE project_id=? AND contract_id=?').get(pid, cid);
  const revisions = (pid, cid) => db.prepare('SELECT * FROM engineering_boq_revisions WHERE project_id=? AND contract_id=? ORDER BY created_at DESC,id DESC').all(pid, cid).map(parse);
  const isEffective = row => row.state === 'approved' && (!row.variation_id || !voided(row.variation_id));
  const currentRevision = (pid, cid) => revisions(pid, cid).filter(isEffective).sort((a, b) => b.approved_seq - a.approved_seq)[0] || null;
  const pendingRevision = (pid, cid) => parse(db.prepare("SELECT * FROM engineering_boq_revisions WHERE project_id=? AND contract_id=? AND state IN ('draft','submitted')").get(pid, cid));
  const pending = pid => !!db.prepare("SELECT 1 FROM engineering_boq_revisions WHERE project_id=? AND state IN ('draft','submitted')").get(pid);

  function authorized(req, write = true) {
    const context = access(req, write);
    if (!financial(context.role)) fail(403, '没有项目工程量清单经营权限');
    return context;
  }
  function openContract(pid, cid) {
    const contract = getItem(pid, cid, 'contracts');
    if (contract.state !== 'approved') fail(409, '工程量清单须关联已批准且未关闭的合同');
    return contract;
  }
  function getRevision(pid, rid) {
    const row = parse(db.prepare('SELECT * FROM engineering_boq_revisions WHERE id=? AND project_id=?').get(rid, pid));
    if (!row) fail(404, '工程量清单版本不存在或不属于本项目');
    return row;
  }
  function ensureBase(pid, cid, baseId) {
    const current = currentRevision(pid, cid);
    if ((current?.id || null) !== (baseId || null)) fail(409, '清单基础版本已变化，请作废待办版本并重新建立修订');
    if (enabled(pid, cid) && !current) fail(409, '已启用清单的合同缺少有效清单版本，请核对数据');
    return current;
  }
  function initialEligible(pid, cid) {
    const related = getItems(pid).filter(row => row.data.contractId === cid && !voided(row.id));
    if (related.some(row => row.kind === 'measurements' && row.state === 'approved')) fail(409, '已有有效已批准计量，不能直接启用清单；请保持原计量模式或先完成原单纠错');
    if (related.some(row => row.kind === 'settlements' && row.state === 'approved' && !row.data.measurementId)) fail(409, '已有有效手工结算，不能直接启用清单');
    if (related.some(row => ['measurements', 'settlements', 'variations'].includes(row.kind) && ['draft', 'submitted'].includes(row.state))) fail(409, '启用清单前须清理合同下待办计量、结算和变更签证');
  }
  function usage(pid, cid) {
    const totals = new Map();
    for (const row of getItems(pid).filter(row => row.kind === 'measurements' && row.state === 'approved' && row.data.contractId === cid && !voided(row.id))) {
      for (const line of row.data.lines) {
        if (!line.boqItemId) fail(409, '合同存在未绑定清单的有效计量，请核对数据');
        if (!Number.isSafeInteger(line.quantity) || line.quantity < 1 || !Number.isSafeInteger(line.amount) || line.amount < 0) fail(409, '有效计量的清单数量或金额无效');
        const total = totals.get(line.boqItemId) || { quantity: 0n, amount: 0n };
        total.quantity += BigInt(line.quantity); total.amount += BigInt(line.amount);
        totals.set(line.boqItemId, total);
      }
    }
    return totals;
  }
  function withinCaps(lines, totals) {
    const byId = new Map(lines.map(line => [line.id, line]));
    for (const [itemId, total] of totals) {
      const line = byId.get(itemId);
      if (!line || total.quantity > BigInt(line.quantity) || total.amount > BigInt(line.amount)) fail(409, '清单数量或金额低于当前有效已批准计量，须先处理相关计量纠错');
    }
  }
  function prepareLines(pid, cid, input, base) {
    const lines = linesSchema.parse(input).map(line => ({ ...line, id: line.id || randomUUID(), amount: boundedAmount(roundAmount(line.quantity, line.unitPrice)) }));
    if (new Set(lines.map(line => line.id)).size !== lines.length) fail(400, '同一清单版本不能包含重复条目 ID');
    const incoming = new Map(lines.map(line => [line.id, line]));
    for (const old of base?.lines || []) {
      const line = incoming.get(old.id);
      if (!line) fail(409, '修订必须保留已有清单条目；停止使用请将数量设为 0');
      if (identityFields.some(field => line[field] !== old[field])) fail(409, '已批准清单条目的编码、名称、部位、单位和单价不可改写；变价请新增条目');
    }
    for (const line of lines) {
      const other = db.prepare("SELECT r.contract_id,r.state,j.value FROM engineering_boq_revisions r,json_each(r.lines) j WHERE json_extract(j.value,'$.id')=?").all(line.id);
      if (other.some(row => row.contract_id !== cid)) fail(400, '清单条目属于其他合同，不能跨合同引用');
      if (other.filter(row => row.state === 'approved').some(row => identityFields.some(field => JSON.parse(row.value)[field] !== line[field]))) fail(409, '历史已批准清单条目的身份和单价不可改写');
    }
    if (!base && !lines.some(line => line.quantity > 0)) fail(400, '初始清单至少需要一项正数量条目');
    const total = boundedAmount(lines.reduce((value, line) => value + BigInt(line.amount), 0n));
    withinCaps(lines, usage(pid, cid));
    return { lines, total, delta: base ? total - base.total : 0 };
  }
  function verifyRevision(pid, row) {
    openContract(pid, row.contract_id);
    const base = ensureBase(pid, row.contract_id, row.base_revision_id);
    if (!base) initialEligible(pid, row.contract_id);
    // Re-read both quantity usage and contract commitments at every state change.
    const clean = row.lines.map(({ amount, ...line }) => line);
    const prepared = prepareLines(pid, row.contract_id, clean, base);
    if (!sameLines(prepared.lines, row.lines, ['id', ...identityFields, 'quantity', 'amount']) || prepared.total !== row.total || prepared.delta !== row.delta) fail(409, '清单报价已变化，请返回草稿重新保存核对');
    const commercial = contractSummary(pid, row.contract_id);
    if (!base && row.total !== commercial.effectiveAmount) fail(409, '初始清单合计必须等于当前有效合同额');
    if (base && base.total !== commercial.effectiveAmount) fail(409, '当前清单总额与有效合同额不一致，请先核对签证和纠错');
    if (row.total < commercial.committedAmount) fail(409, '修订后的清单总额不足以覆盖已批准采购、计量或结算承诺');
    return base;
  }
  function projection(pid, cid) {
    getItem(pid, cid, 'contracts');
    const current = currentRevision(pid, cid), isBoq = enabled(pid, cid);
    const totals = isBoq ? usage(pid, cid) : new Map();
    const items = (current?.lines || []).map(line => {
      const used = totals.get(line.id) || { quantity: 0n, amount: 0n };
      return { ...line, usedQuantity: Number(used.quantity), usedAmount: Number(used.amount), remainingQuantity: Number(BigInt(line.quantity) - used.quantity), remainingAmount: Number(BigInt(line.amount) - used.amount) };
    });
    return { contractId: cid, mode: isBoq ? 'boq' : 'free', currentRevisionId: current?.id || null, pendingRevisionId: pendingRevision(pid, cid)?.id || null, items };
  }
  const view = (pid, cid) => projection(pid, cid);
  function projectView(pid) {
    const contracts = getItems(pid).filter(row => row.kind === 'contracts').map(row => projection(pid, row.id));
    const rows = db.prepare('SELECT * FROM engineering_boq_revisions WHERE project_id=? ORDER BY created_at DESC,id DESC').all(pid).map(parse);
    return { contracts, revisions: rows.map(row => ({ ...row, voided: !!row.variation_id && voided(row.variation_id) })) };
  }
  function quote(pid, cid, inputs) {
    const current = currentRevision(pid, cid);
    if (!current) fail(409, '合同尚无有效工程量清单');
    const requested = measurementInput.parse(inputs);
    if (new Set(requested.map(line => line.boqItemId)).size !== requested.length) fail(400, '同一计量单不能重复引用同一清单条目');
    const totals = usage(pid, cid), byId = new Map(current.lines.map(line => [line.id, line]));
    withinCaps(current.lines, totals);
    let totalAmount = 0n;
    const lines = requested.map(input => {
      const item = byId.get(input.boqItemId);
      if (!item) fail(400, '计量清单条目不存在、已失效或不属于本合同');
      const used = totals.get(item.id) || { quantity: 0n, amount: 0n };
      const nextQuantity = used.quantity + BigInt(input.quantity);
      if (nextQuantity > BigInt(item.quantity)) fail(409, '本次计量超过清单条目剩余数量');
      const difference = roundAmount(nextQuantity, item.unitPrice) - used.amount;
      // After cancelling an earlier quote, the surviving approved quotes may
      // contain a rounding cent already. Carry it forward without negative work.
      const amount = difference > 0n ? difference : 0n;
      if (used.amount + amount > BigInt(item.amount)) fail(409, '本次计量超过清单条目剩余金额');
      totalAmount += amount;
      return { name: item.name, location: item.location, unit: item.unit, quantity: input.quantity, unitPrice: item.unitPrice, note: input.note, amount: Number(amount), boqItemId: item.id, boqRevisionId: current.id, ...(input.taskId ? { taskId: input.taskId } : {}) };
    });
    return { lines, amount: boundedAmount(totalAmount) };
  }
  function guard(pid, kind, data) {
    if (!['variations', 'measurements', 'settlements'].includes(kind) || !data.contractId) return false;
    const isBoq = enabled(pid, data.contractId);
    if (!isBoq && pendingRevision(pid, data.contractId)) fail(409, '合同正在启用清单，暂不能新增或审批计量、结算及签证');
    if (isBoq && kind === 'variations') fail(409, '清单合同的签证须由工程量清单修订同步生成，不能独立新增、编辑或审批');
    if (isBoq && kind === 'settlements' && !data.measurementId) fail(409, '清单合同结算必须关联同合同有效已批准计量单');
    return isBoq;
  }
  function validate(pid, kind, data, current) {
    const isBoq = guard(pid, kind, data);
    if (kind !== 'measurements') return false;
    if (!isBoq) {
      if (data.lines.some(line => line.boqItemId || line.boqRevisionId)) fail(400, '未启用清单的合同不能引用清单计量条目');
      return false;
    }
    openContract(pid, data.contractId);
    if (data.periodStart > data.periodEnd) fail(400, '计量结束日期不能早于开始日期');
    Object.assign(data, quote(pid, data.contractId, data.lines));
    return true;
  }
  function approve(pid, row) {
    const isBoq = guard(pid, row.kind, row.data);
    if (!isBoq || row.kind !== 'measurements') return;
    openContract(pid, row.data.contractId);
    const inputs = row.data.lines.map(line => ({ boqItemId: line.boqItemId, quantity: line.quantity, note: line.note || '', ...(line.taskId ? { taskId: line.taskId } : {}) }));
    const current = quote(pid, row.data.contractId, inputs);
    if (row.data.amount !== current.amount || !sameLines(row.data.lines, current.lines, ['name', 'location', 'unit', 'quantity', 'unitPrice', 'note', 'amount', 'boqItemId', 'boqRevisionId', 'taskId'])) fail(409, '清单版本或累计计量报价已变化，请退回草稿并重新保存核价后提交审批');
  }
  function close(pid, cid) {
    if (pendingRevision(pid, cid)) fail(409, '合同仍有待办工程量清单或修订，暂不能结清关闭');
    if (!enabled(pid, cid)) return;
    const current = currentRevision(pid, cid);
    if (!current) fail(409, '合同缺少有效清单');
    const totals = usage(pid, cid);
    withinCaps(current.lines, totals);
    if (current.lines.some(line => {
      const used = totals.get(line.id) || { quantity: 0n, amount: 0n };
      return used.quantity !== BigInt(line.quantity) || used.amount !== BigInt(line.amount);
    })) fail(409, '清单范围尚未按数量和金额全部计量；请完成计量或通过清单修订核减剩余范围');
    if (current.total !== contractSummary(pid, cid).effectiveAmount) fail(409, '清单合计与有效合同额不一致');
  }
  function correctionCheck(pid, target) {
    const blockers = [], cid = target.data.contractId;
    if (target.kind !== 'variations' || !enabled(pid, cid)) return { allowed: true, blockers };
    const revision = parse(db.prepare('SELECT * FROM engineering_boq_revisions WHERE project_id=? AND contract_id=? AND variation_id=?').get(pid, cid, target.id));
    const block = reason => blockers.push({ id: target.id, kind: target.kind, title: target.data.title, reason });
    if (!revision) {
      block('该签证已纳入清单初始合同额；启用清单后请通过配套清单修订调整，不能独立撤销');
      return { allowed: false, blockers };
    }
    if (currentRevision(pid, cid)?.id !== revision.id) block('只能撤销当前有效最新清单修订的配套签证，请先处理后续清单修订');
    if (pendingRevision(pid, cid)) block('合同仍有待办清单修订，请先作废待办修订');
    const consumers = getItems(pid).filter(row => row.kind === 'measurements' && row.state === 'approved' && row.data.contractId === cid && !voided(row.id) && row.data.lines.some(line => line.boqRevisionId === revision.id));
    for (const row of consumers) blockers.push({ id: row.id, kind: row.kind, title: row.data.title, reason: '有效计量引用了本清单修订，请先办理关联结算和计量纠错' });
    const base = revision.base_revision_id && getRevision(pid, revision.base_revision_id);
    if (!base || !isEffective(base)) block('缺少可恢复的有效前版清单，不能撤销');
    else {
      try { withinCaps(base.lines, usage(pid, cid)); }
      catch (error) { if (error.status === 409 || error.statusCode === 409) block('恢复前版清单后无法容纳当前有效已批准计量数量或金额'); else throw error; }
    }
    return { allowed: blockers.length === 0, blockers };
  }
  // The caller approves the correction in its transaction. Active snapshots are
  // selected using voided(variation_id), so no historical revision is mutated.
  function applyCorrection(pid, target, actor) {}

  function mount(app, base, authorize, writer) {
    app.get(base + '/projects/:pid/boq', authorize, (req, res) => {
      z.object({}).strict().parse(req.query);
      res.json(store.transaction(() => { const { p } = authorized(req, false); return projectView(p.id); }));
    });
    app.post(base + '/projects/:pid/boq', authorize, writer, (req, res) => {
      const { p } = authorized(req);
      const body = z.object({ requestId: id, contractId: id, title, note, lines: linesSchema }).strict().parse(req.body);
      res.status(201).json(mutate(req, p.id + ':boq:create', () => {
        const context = authorized(req); active(context.p); openContract(p.id, body.contractId);
        if (pendingRevision(p.id, body.contractId)) fail(409, '合同已有待办清单版本，请先编辑、批准或作废');
        const current = currentRevision(p.id, body.contractId);
        if (!current) initialEligible(p.id, body.contractId);
        const prepared = prepareLines(p.id, body.contractId, body.lines, current);
        const rid = randomUUID(), at = now();
        const row = { ...prepared, contract_id: body.contractId, base_revision_id: current?.id || null };
        verifyRevision(p.id, row);
        db.prepare(`INSERT INTO engineering_boq_revisions(id,project_id,contract_id,base_revision_id,title,note,state,version,lines,total,delta,created_by,creator_name,created_at,updated_at)
          VALUES(?,?,?,?,?,?,'draft',1,?,?,?,?,?,?,?)`).run(rid, p.id, body.contractId, row.base_revision_id, body.title, body.note, JSON.stringify(prepared.lines), prepared.total, prepared.delta, req.actor.id, req.actor.name, at, at);
        history(req.actor, p.id, body.contractId, 'contracts', 'boq_create', '创建清单草稿：' + body.title);
        return { id: rid, state: 'draft', version: 1 };
      }));
    });
    app.put(base + '/projects/:pid/boq/:rid', authorize, writer, (req, res) => {
      const { p } = authorized(req), rid = id.parse(req.params.rid);
      const body = z.object({ requestId: id, version, title, note, lines: linesSchema }).strict().parse(req.body);
      getRevision(p.id, rid);
      res.json(mutate(req, p.id + ':boq:' + rid + ':edit', () => {
        const context = authorized(req); active(context.p);
        const row = getRevision(p.id, rid);
        if (row.state !== 'draft' || row.version !== body.version) fail(409, '清单版本已更新或当前不可编辑，请刷新核对');
        const current = ensureBase(p.id, row.contract_id, row.base_revision_id);
        const prepared = prepareLines(p.id, row.contract_id, body.lines, current);
        verifyRevision(p.id, { ...row, ...prepared });
        db.prepare('UPDATE engineering_boq_revisions SET title=?,note=?,lines=?,total=?,delta=?,edited_by=?,editor_name=?,updated_at=?,version=version+1 WHERE id=?')
          .run(body.title, body.note, JSON.stringify(prepared.lines), prepared.total, prepared.delta, req.actor.id, req.actor.name, now(), rid);
        history(req.actor, p.id, row.contract_id, 'contracts', 'boq_update', '修改清单草稿：' + body.title);
        return { id: rid, state: 'draft', version: row.version + 1 };
      }));
    });
    app.post(base + '/projects/:pid/boq/:rid/state', authorize, writer, (req, res) => {
      const { p } = authorized(req), rid = id.parse(req.params.rid);
      const body = z.object({ requestId: id, version, state: z.enum(['submitted', 'approved', 'draft', 'cancelled']), note }).strict().parse(req.body);
      getRevision(p.id, rid);
      res.json(mutate(req, p.id + ':boq:' + rid + ':state', () => {
        const context = authorized(req); active(context.p);
        const row = getRevision(p.id, rid);
        if (row.version !== body.version || !({ draft: ['submitted', 'cancelled'], submitted: ['approved', 'draft', 'cancelled'] }[row.state] || []).includes(body.state)) fail(409, '清单状态或版本已变化，请刷新核对');
        if (body.state === 'approved' && !manager(context.role)) fail(403, '清单须由项目经理或管理员审批');
        let variationId = null, sequence = null;
        if (body.state === 'submitted' || body.state === 'approved') verifyRevision(p.id, row);
        if (body.state === 'approved') {
          if ([row.created_by, row.edited_by].includes(req.actor.id)) fail(409, '清单创建人或最后修改人不能审批，请另一位经理审核');
          sequence = db.prepare('SELECT COALESCE(MAX(approved_seq),0)+1 seq FROM engineering_boq_revisions WHERE project_id=? AND contract_id=?').get(p.id, row.contract_id).seq;
          if (row.delta !== 0) {
            variationId = randomUUID();
            const at = now(), data = { title: row.title, code: 'BOQ-' + row.id, contractId: row.contract_id, changeType: row.delta > 0 ? 'increase' : 'decrease', amount: Math.abs(row.delta), occurredDate: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date()), note: row.note, boqRevisionId: row.id };
            db.prepare(`INSERT INTO engineering_items(id,project_id,kind,state,data,version,created_by,edited_by,created_at,updated_at) VALUES(?,?,'variations','approved',?,1,?,?,?,?)`)
              .run(variationId, p.id, JSON.stringify(data), row.created_by, row.edited_by || null, at, at);
            history(req.actor, p.id, row.contract_id, 'contracts', 'boq_variation', '清单修订同步批准签证：' + variationId);
          }
          db.prepare('INSERT INTO engineering_boq_modes(project_id,contract_id,activated_at) VALUES(?,?,?) ON CONFLICT(contract_id) DO NOTHING').run(p.id, row.contract_id, now());
        }
        db.prepare(`UPDATE engineering_boq_revisions SET state=?,version=version+1,updated_at=?,submitted_at=CASE WHEN ?='submitted' THEN ? ELSE submitted_at END,
          reviewed_by=?,reviewer_name=?,review_note=?,reviewed_at=?,variation_id=?,approved_seq=? WHERE id=?`)
          .run(body.state, now(), body.state, now(), req.actor.id, req.actor.name, body.note, now(), variationId, sequence, rid);
        history(req.actor, p.id, row.contract_id, 'contracts', 'boq_' + body.state, '清单 ' + row.title + '：' + body.note);
        return { id: rid, state: body.state, version: row.version + 1, variationId };
      }));
    });
  }
  return { mount, view, projectView, validate, approve, close, pending, correctionCheck, applyCorrection };
}
