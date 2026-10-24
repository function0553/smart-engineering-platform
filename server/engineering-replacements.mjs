import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail } from './service.mjs';

const id = z.string().uuid(), note = z.string().trim().min(1).max(2000);
const targetSchema = z.object({ type: z.enum(['item', 'boq']), id }).strict();
const targetsSchema = z.array(targetSchema).max(50);
const kinds = ['variations', 'measurements', 'settlements'];
const now = () => new Date().toISOString();
const parse = row => row ? { ...row, snapshot: JSON.parse(row.snapshot) } : null;
const invalid = () => fail(422, '更正关联的来源、签认快照或金额不一致，请核对台账');
const instant = value => { const parsed = typeof value === 'string' ? Date.parse(value) : NaN; if (!Number.isFinite(parsed)) invalid(); return parsed; };
const amount = (value, signed = false) => { if (!Number.isSafeInteger(value) || value < (signed ? -1_000_000_000_000 : 0) || value > 1_000_000_000_000) invalid(); return value; };
const positive = value => { if (!Number.isSafeInteger(value) || value < 1) invalid(); return value; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const uniqueTargets = targets => new Set(targets.map(target => target.type + ':' + target.id)).size === targets.length;
const block = reason => ({ reason });
const itemKeys = ['type', 'id', 'kind', 'contractId', 'title', 'code', 'version', 'amount', 'changeType', 'createdBy', 'editedBy', 'createdAt', 'updatedAt'];
const boqKeys = ['type', 'id', 'kind', 'contractId', 'title', 'code', 'version', 'amount', 'delta', 'total', 'approvedSeq', 'variationId', 'createdBy', 'editedBy', 'createdAt', 'updatedAt', 'approvedBy', 'approvedAt'];
const core = target => Object.fromEntries((target.type === 'boq' ? boqKeys : itemKeys).map(key => [key, target[key]]));

function itemSnapshot(row) {
  if (!kinds.includes(row.kind) || typeof row.data.title !== 'string' || !row.data.title.trim()) invalid();
  amount(row.data.amount); positive(row.version); instant(row.created_at); instant(row.updated_at);
  if (row.kind === 'variations' && !['increase', 'decrease'].includes(row.data.changeType)) invalid();
  return { type: 'item', id: row.id, kind: row.kind, contractId: row.data.contractId,
    title: row.data.title, code: row.data.code || '', version: row.version, amount: row.data.amount,
    changeType: row.kind === 'variations' ? row.data.changeType : '',
    createdBy: row.created_by, createdName: row.creator_name || '', editedBy: row.edited_by || '', editedName: row.editor_name || '',
    createdAt: row.created_at, updatedAt: row.updated_at,
    approvedBy: row.approval?.actor_id || '', approvedName: row.approval?.actor_name || '', approvedAt: row.approval?.at || row.updated_at };
}
function boqSnapshot(row) {
  amount(row.total); amount(row.delta, true); positive(row.version); positive(row.approved_seq);
  instant(row.created_at); instant(row.updated_at); instant(row.reviewed_at);
  return { type: 'boq', id: row.id, kind: 'boq', contractId: row.contract_id, title: row.title, code: '', version: row.version,
    amount: null, delta: row.delta, total: row.total, approvedSeq: row.approved_seq, variationId: row.variation_id || '',
    createdBy: row.created_by, createdName: row.creator_name || '', editedBy: row.edited_by || '', editedName: row.editor_name || '',
    createdAt: row.created_at, updatedAt: row.updated_at, approvedBy: row.reviewed_by || '', approvedName: row.reviewer_name || '', approvedAt: row.reviewed_at };
}

function indexSources({ project, items, corrections, boq, versions }) {
  if (!id.safeParse(project?.id).success || !Array.isArray(items) || !Array.isArray(corrections) || !Array.isArray(boq?.revisions) || !Array.isArray(versions)) invalid();
  for (const rows of [items, corrections, boq.revisions, versions]) {
    if (rows.some(row => !row || !id.safeParse(row.id).success || row.project_id !== project.id) || new Set(rows.map(row => row.id)).size !== rows.length) invalid();
  }
  if (items.some(row => !row.data || typeof row.data !== 'object')) invalid();
  const itemById = new Map(items.map(row => [row.id, row])), correctionById = new Map(corrections.map(row => [row.id, row]));
  const revisionById = new Map(boq.revisions.map(row => [row.id, row])), approvedCorrection = new Map(), currentBoq = new Map();
  for (const correction of corrections.filter(row => row.state === 'approved')) {
    const original = itemById.get(correction.target_id);
    if (!original || original.kind !== correction.target_kind || !kinds.includes(original.kind) || !correction.snapshot || approvedCorrection.has(original.id)) invalid();
    positive(correction.version); instant(correction.reviewed_at); approvedCorrection.set(original.id, correction);
  }
  for (const revision of boq.revisions) {
    if (itemById.get(revision.contract_id)?.kind !== 'contracts') invalid();
    if (revision.state !== 'approved') continue;
    positive(revision.approved_seq);
    if (revision.variation_id && !itemById.has(revision.variation_id)) invalid();
    if (revision.variation_id && approvedCorrection.has(revision.variation_id)) continue;
    if (!currentBoq.has(revision.contract_id) || currentBoq.get(revision.contract_id).approved_seq < revision.approved_seq) currentBoq.set(revision.contract_id, revision);
  }
  return { project, items, corrections, boq, versions, itemById, correctionById, revisionById, approvedCorrection, currentBoq };
}

function sourceSnapshot(context, correction) {
  if (correction?.state !== 'approved') fail(409, '更正关联必须以已批准的经营纠错为来源');
  const item = context.itemById.get(correction.target_id), frozen = correction.snapshot;
  if (!item || item.kind !== correction.target_kind || item.state !== 'approved' || !frozen || !same(frozen.data, item.data)
    || frozen.version !== item.version || frozen.createdBy !== item.created_by || frozen.editedBy !== (item.edited_by || '')
    || frozen.updatedAt !== item.updated_at || frozen.createdAt !== item.created_at || frozen.amount !== item.data.amount || frozen.contractId !== item.data.contractId || frozen.title !== item.data.title) invalid();
  const contract = context.itemById.get(item.data.contractId);
  if (!contract || contract.kind !== 'contracts') invalid();
  const revision = context.boq.revisions.find(row => row.variation_id === item.id);
  if (item.data.boqRevisionId && revision?.id !== item.data.boqRevisionId || revision && (item.kind !== 'variations' || revision.contract_id !== contract.id || revision.state !== 'approved')) invalid();
  return { correctionId: correction.id, correctionVersion: correction.version,
    correctedAt: correction.reviewed_at, correctedBy: correction.reviewed_by || '', correctedName: correction.reviewer_name || '', correctionNote: correction.note,
    contractId: contract.id, contractTitle: contract.data.title, item: itemSnapshot(item), boqRevision: revision ? boqSnapshot(revision) : null };
}
function targetStatus(context, target) {
  const row = target.type === 'item' ? context.itemById.get(target.id) : context.revisionById.get(target.id);
  if (!row) return { type: target.type, id: target.id, effective: false, status: 'missing', sourceCorrectionId: null };
  const correction = context.approvedCorrection.get(target.type === 'item' ? row.id : row.variation_id);
  const status = correction ? 'voided' : row.state !== 'approved' ? 'not_approved' : target.type === 'boq' && context.currentBoq.get(row.contract_id)?.id !== row.id ? 'superseded' : 'effective';
  return { type: target.type, id: target.id, effective: status === 'effective', status, sourceCorrectionId: correction?.id || null };
}
function targetEligibility(context, source, target) {
  const blockers = [], targetRow = target.type === 'item' ? context.itemById.get(target.id) : context.revisionById.get(target.id);
  if (!targetRow) return [block('替代依据不存在或不属于本项目')];
  if (source.boqRevision) {
    if (target.type !== 'boq') return [block('清单修订签证的更正只能引用后续已批准清单版本')];
    if (targetRow.contract_id !== source.contractId) blockers.push(block('替代清单必须属于同一合同'));
    if (targetRow.state !== 'approved' || context.currentBoq.get(source.contractId)?.id !== targetRow.id || targetStatus(context, target).status !== 'effective') blockers.push(block('替代清单必须是合同当前有效已批准版本'));
    if (!Number.isSafeInteger(targetRow.approved_seq) || targetRow.approved_seq <= source.boqRevision.approvedSeq) blockers.push(block('替代清单签认序号必须晚于原清单版本'));
    if (!targetRow.reviewed_at || instant(targetRow.reviewed_at) < instant(source.correctedAt)) blockers.push(block('替代清单须在来源纠错批准后签认'));
  } else {
    if (target.type !== 'item') return [block('原业务单据的更正须引用同类型的新正确单据')];
    if (targetRow.id === source.item.id) blockers.push(block('原单本身不能作为替代单'));
    if (targetRow.kind !== source.item.kind || targetRow.data.contractId !== source.contractId) blockers.push(block('替代单据须属于同合同、同业务类型'));
    if (targetRow.kind === 'variations' && (targetRow.data.boqRevisionId || context.boq.revisions.some(row => row.variation_id === targetRow.id))) blockers.push(block('自由签证不能用清单自动生成的签证替代'));
    if (targetRow.state !== 'approved' || context.approvedCorrection.has(targetRow.id)) blockers.push(block('替代单据须已批准且业务影响尚未撤销'));
    if (instant(targetRow.updated_at) < instant(source.correctedAt)) blockers.push(block('替代单据须在来源纠错批准后签认'));
  }
  return blockers;
}
function sourceEligibility(context, source) {
  const blockers = [];
  if (context.project.state !== 'active') blockers.push(block('项目须处于施工中才能办理更正关联'));
  if (!['approved', 'closed'].includes(context.itemById.get(source.contractId)?.state)) blockers.push(block('更正关联须属于已批准或已结清合同'));
  return blockers;
}
function excludedReviewers(row) {
  return [...new Set([row.requested_by, row.snapshot.source.item.createdBy, row.snapshot.source.item.editedBy,
    row.snapshot.source.boqRevision?.createdBy, row.snapshot.source.boqRevision?.editedBy,
    ...row.snapshot.targets.flatMap(target => [target.createdBy, target.editedBy])].filter(Boolean))];
}
function verifyFrozen(context, row) {
  if (!['submitted', 'approved', 'rejected', 'cancelled'].includes(row.state) || !['replaced', 'no_replacement'].includes(row.resolution) || !row.snapshot?.source || !Array.isArray(row.snapshot.targets)) invalid();
  positive(row.version); if (row.state === 'approved') positive(row.approved_seq);
  const correction = context.correctionById.get(row.source_correction_id);
  if (!correction || correction.state !== 'approved') invalid();
  const expected = sourceSnapshot(context, correction), source = row.snapshot.source;
  const sourceKeys = ['correctionId', 'correctionVersion', 'correctedAt', 'correctedBy', 'correctedName', 'correctionNote', 'contractId', 'contractTitle'];
  if (row.contract_id !== expected.contractId || !same(Object.fromEntries(sourceKeys.map(key => [key, source[key]])), Object.fromEntries(sourceKeys.map(key => [key, expected[key]])))
    || !source.item || !same(core(source.item), core(expected.item)) || !!source.boqRevision !== !!expected.boqRevision
    || source.boqRevision && !same(core(source.boqRevision), core(expected.boqRevision))) invalid();
  if (row.snapshot.targets.some(target => !target || typeof target !== 'object' || Array.isArray(target))) invalid();
  const refs = row.snapshot.targets.map(target => ({ type: target.type, id: target.id }));
  if (!targetsSchema.safeParse(refs).success || !uniqueTargets(refs) || (row.resolution === 'replaced' ? refs.length < 1 : refs.length !== 0)) invalid();
  for (const target of row.snapshot.targets) {
    const original = target.type === 'item' ? context.itemById.get(target.id) : context.revisionById.get(target.id);
    if (!original) invalid();
    const expectedTarget = target.type === 'item' ? itemSnapshot(original) : boqSnapshot(original);
    if (!same(core(target), core(expectedTarget)) || target.contractId !== source.contractId || target.id === source.item.id) invalid();
    if (source.boqRevision ? target.type !== 'boq' || target.approvedSeq <= source.boqRevision.approvedSeq || instant(target.approvedAt) < instant(source.correctedAt)
      : target.type !== 'item' || target.kind !== source.item.kind || original.data.boqRevisionId || instant(target.updatedAt) < instant(source.correctedAt)) invalid();
    for (const key of ['createdName', 'editedName', 'approvedBy', 'approvedName', 'approvedAt']) if (typeof target[key] !== 'string') invalid();
    instant(target.approvedAt);
  }
}

/** Recompute relationships and current target effects without adding amounts to
 * the commercial ledger. Reused by HTTP and exports from a single DB snapshot. */
export function buildEngineeringReplacementsView(input, { observedAt = now(), sourceCorrectionId } = {}) {
  const context = indexSources(input);
  const approved = context.versions.filter(row => row.state === 'approved');
  // SQLite protects live rows; independently supplied export snapshots must
  // enforce the same uniqueness before choosing a current relation.
  if (approved.some(row => !Number.isSafeInteger(row.approved_seq) || row.approved_seq < 1)
    || new Set(approved.map(row => row.approved_seq)).size !== approved.length) invalid();
  approved.sort((a, b) => b.approved_seq - a.approved_seq);
  const currentBySource = new Map();
  for (const row of approved) if (!currentBySource.has(row.source_correction_id)) currentBySource.set(row.source_correction_id, row);
  const versions = context.versions.map(row => {
    verifyFrozen(context, row);
    const blockers = [...sourceEligibility(context, row.snapshot.source), ...row.snapshot.targets.flatMap(target => targetEligibility(context, row.snapshot.source, target))];
    return { ...row, isCurrent: currentBySource.get(row.source_correction_id)?.id === row.id,
      targetStatuses: row.snapshot.targets.map(target => targetStatus(context, target)), excludedReviewerIds: excludedReviewers(row),
      approvalEligibility: { allowed: row.state === 'submitted' && blockers.length === 0, blockers: row.state === 'submitted' ? blockers : [block('本版本已办理')] } };
  });
  const eligibleSources = context.corrections.filter(row => row.state === 'approved').map(correction => {
    const source = sourceSnapshot(context, correction), pending = versions.find(row => row.source_correction_id === correction.id && row.state === 'submitted');
    const blockers = sourceEligibility(context, source); if (pending) blockers.push(block('本来源已有待审更正关联，请先办理或撤回'));
    const candidates = (source.boqRevision ? context.boq.revisions.map(row => ({ type: 'boq', id: row.id })) : context.items.filter(row => row.kind === source.item.kind).map(row => ({ type: 'item', id: row.id })))
      .filter(target => targetEligibility(context, source, target).length === 0)
      .map(target => target.type === 'item' ? itemSnapshot(context.itemById.get(target.id)) : boqSnapshot(context.revisionById.get(target.id)));
    return { sourceCorrectionId: correction.id, source, currentVersionId: currentBySource.get(correction.id)?.id || null, pendingVersionId: pending?.id || null,
      allowed: blockers.length === 0, blockers, candidates };
  });
  if (sourceCorrectionId && !eligibleSources.some(row => row.sourceCorrectionId === sourceCorrectionId)) fail(404, '已批准的来源纠错不存在或不属于本项目');
  const chains = eligibleSources.map(entry => {
    const row = versions.find(version => version.id === entry.currentVersionId);
    return { sourceCorrectionId: entry.sourceCorrectionId, source: entry.source, currentVersionId: entry.currentVersionId, pendingVersionId: entry.pendingVersionId,
      resolution: row?.resolution || 'unresolved', targets: row ? row.snapshot.targets.map((snapshot, index) => ({ snapshot, status: row.targetStatuses[index] })) : [] };
  });
  const links = versions.flatMap(row => row.snapshot.targets.map(target => ({ sourceItemId: row.snapshot.source.item.id, sourceCorrectionId: row.source_correction_id,
    versionId: row.id, targetType: target.type, targetId: target.id, isCurrent: row.isCurrent })));
  return { projectId: context.project.id, observedAt, versions, current: [...currentBySource.entries()].map(([sourceCorrectionId, row]) => ({ sourceCorrectionId, versionId: row.id })),
    eligibleSources, chains, links, selectedSourceCorrectionId: sourceCorrectionId || null };
}

export function createEngineeringReplacements({ store, access, active, mutate, history, getItems, manager, financial, corrections, boq }) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS engineering_replacements(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES engineering_projects(id), source_correction_id TEXT NOT NULL REFERENCES engineering_corrections(id),
    contract_id TEXT NOT NULL REFERENCES engineering_items(id), resolution TEXT NOT NULL CHECK(resolution IN ('replaced','no_replacement')),
    note TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('submitted','approved','rejected','cancelled')), version INTEGER NOT NULL,
    snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), requested_by TEXT NOT NULL REFERENCES users(id), requester_name TEXT NOT NULL, created_at TEXT NOT NULL,
    reviewed_by TEXT REFERENCES users(id), reviewer_name TEXT, review_note TEXT, reviewed_at TEXT, approved_seq INTEGER,
    UNIQUE(project_id,approved_seq));
    CREATE UNIQUE INDEX IF NOT EXISTS engineering_replacements_pending ON engineering_replacements(source_correction_id) WHERE state='submitted';
    CREATE INDEX IF NOT EXISTS engineering_replacements_project ON engineering_replacements(project_id,source_correction_id,state);
    CREATE INDEX IF NOT EXISTS engineering_history_project_action_item_at ON engineering_history(project_id,action,item_id,at DESC);`);
  const pending = (pid, cid) => !!db.prepare("SELECT 1 FROM engineering_replacements WHERE project_id=? AND state='submitted'" + (cid ? ' AND contract_id=?' : '')).get(...(cid ? [pid, cid] : [pid]));
  const getVersion = (pid, rid) => { const row = parse(db.prepare('SELECT * FROM engineering_replacements WHERE project_id=? AND id=?').get(pid, rid)); if (!row) fail(404, '更正关联版本不存在或不属于本项目'); return row; };
  // `all` lets the project detail pass its read-only getItems snapshot instead of reloading every item.
  function sources(project, all) {
    const rawItems = all || getItems(project.id), correctionRows = corrections.list(project.id, 'admin');
    const actors = new Map(), approvals = new Map();
    if (correctionRows.some(row => row.state === 'approved') && rawItems.some(row => kinds.includes(row.kind))) {
      const actorRows = db.prepare(`SELECT id,name FROM users WHERE id IN (
        SELECT created_by FROM engineering_items WHERE project_id=? AND kind IN ('variations','measurements','settlements')
        UNION SELECT edited_by FROM engineering_items WHERE project_id=? AND kind IN ('variations','measurements','settlements'))`).all(project.id, project.id);
      for (const row of actorRows) actors.set(row.id, row.name);
      // likelihood() returns its condition unchanged; it only keeps this lookup on the action index.
      const approvalRows = db.prepare(`SELECT h.item_id,h.actor_id,h.actor_name,h.at FROM engineering_history h
        JOIN engineering_items i ON i.id=h.item_id AND i.project_id=h.project_id
        WHERE h.project_id=? AND likelihood(h.action='approved',0.0625) AND i.kind IN ('variations','measurements','settlements')
        ORDER BY h.at DESC,h.id DESC`).all(project.id);
      for (const row of approvalRows) if (!approvals.has(row.item_id)) approvals.set(row.item_id, row);
    }
    const items = rawItems.map(row => kinds.includes(row.kind) ? { ...row, creator_name: actors.get(row.created_by) || '',
      editor_name: actors.get(row.edited_by) || '', approval: approvals.get(row.id) || null } : row);
    return { project, items, corrections: correctionRows, boq: boq.projectView(project.id),
      versions: db.prepare('SELECT * FROM engineering_replacements WHERE project_id=? ORDER BY created_at DESC,id DESC').all(project.id).map(parse) };
  }
  const view = (project, options, all) => buildEngineeringReplacementsView(sources(project, all), options);
  const authorized = (req, write = true) => { const context = access(req, write); if (!financial(context.role)) fail(403, '没有经营更正关联权限'); return context; };
  function checkSource(context, correctionId) {
    const correction = context.correctionById.get(correctionId);
    if (!correction) fail(400, '来源纠错不存在或不属于本项目');
    const source = sourceSnapshot(context, correction), blockers = sourceEligibility(context, source);
    if (blockers.length) fail(409, blockers.map(value => value.reason).join('；'));
    return source;
  }
  function close(pid, cid) { if (pending(pid, cid)) fail(409, '合同仍有待审更正关联版本，请先复核或撤回'); }
  function mount(app, base, authorize, writer) {
    app.get(base + '/projects/:pid/replacements', authorize, (req, res) => {
      const query = z.object({ sourceCorrectionId: z.union([id, z.literal('')]).optional() }).strict().parse(req.query);
      res.json(store.transaction(() => { const { p } = authorized(req, false); return view(p, query); }));
    });
    app.post(base + '/projects/:pid/replacements', authorize, writer, (req, res) => {
      const { p } = authorized(req), body = z.object({ requestId: id, sourceCorrectionId: id, resolution: z.enum(['replaced', 'no_replacement']), targets: targetsSchema, note }).strict().parse(req.body);
      if (!uniqueTargets(body.targets) || (body.resolution === 'replaced' ? body.targets.length < 1 : body.targets.length !== 0)) fail(400, '替代办理须有 1 至 50 个不重复目标；无需补单不得携带目标');
      res.status(201).json(mutate(req, p.id + ':replacement:create', () => {
        const current = authorized(req); active(current.p); const context = indexSources(sources(current.p)), source = checkSource(context, body.sourceCorrectionId);
        if (context.versions.some(row => row.source_correction_id === body.sourceCorrectionId && row.state === 'submitted')) fail(409, '本来源已有待审更正关联，请先办理或撤回');
        const targets = body.targets.map(target => {
          const blockers = targetEligibility(context, source, target); if (blockers.length) fail(409, blockers.map(value => value.reason).join('；'));
          return target.type === 'item' ? itemSnapshot(context.itemById.get(target.id)) : boqSnapshot(context.revisionById.get(target.id));
        });
        const rid = randomUUID();
        db.prepare(`INSERT INTO engineering_replacements(id,project_id,source_correction_id,contract_id,resolution,note,state,version,snapshot,requested_by,requester_name,created_at)
          VALUES(?,?,?,?,?,?,'submitted',1,?,?,?,?)`).run(rid, p.id, body.sourceCorrectionId, source.contractId, body.resolution, body.note, JSON.stringify({ source, targets }), req.actor.id, req.actor.name, now());
        history(req.actor, p.id, source.contractId, 'contracts', 'replacement_submit', '提交更正关联（不重复记账）：' + source.item.title + '；' + body.note);
        return { id: rid, state: 'submitted', version: 1 };
      }));
    });
    app.post(base + '/projects/:pid/replacements/:rid/state', authorize, writer, (req, res) => {
      const { p } = authorized(req), rid = id.parse(req.params.rid), body = z.object({ requestId: id, version: z.number().int().positive(), state: z.enum(['approved', 'rejected', 'cancelled']), note }).strict().parse(req.body);
      getVersion(p.id, rid);
      res.json(mutate(req, p.id + ':replacement:' + rid + ':state', () => {
        const current = authorized(req); active(current.p); const row = getVersion(p.id, rid);
        if (row.state !== 'submitted' || row.version !== body.version) fail(409, '更正关联版本已更新或已办理，请刷新核对');
        const context = indexSources(sources(current.p)); verifyFrozen(context, row);
        if (body.state === 'cancelled') {
          if (row.requested_by !== req.actor.id && !manager(current.role)) fail(403, '仅申请人或项目经理可撤回更正关联');
        } else {
          if (!manager(current.role)) fail(403, '更正关联须由项目经理或管理员独立复核');
          if (excludedReviewers(row).includes(req.actor.id)) fail(409, '申请人及原单、替代依据的创建或最后修改人不能复核，请另一位经理审核');
        }
        if (body.state === 'approved') {
          const source = checkSource(context, row.source_correction_id), blockers = row.snapshot.targets.flatMap(target => targetEligibility(context, source, target));
          if (blockers.length) fail(409, blockers.map(value => value.reason).join('；'));
        }
        const sequence = body.state === 'approved' ? db.prepare('SELECT COALESCE(MAX(approved_seq),0)+1 seq FROM engineering_replacements WHERE project_id=?').get(p.id).seq : null;
        db.prepare('UPDATE engineering_replacements SET state=?,version=version+1,reviewed_by=?,reviewer_name=?,review_note=?,reviewed_at=?,approved_seq=? WHERE id=?')
          .run(body.state, req.actor.id, req.actor.name, body.note, now(), sequence, rid);
        history(req.actor, p.id, row.contract_id, 'contracts', 'replacement_' + body.state, '更正关联复核（不重复记账）：' + row.id + '；' + body.note);
        return { id: rid, state: body.state, version: row.version + 1, approved_seq: sequence };
      }));
    });
  }
  return { mount, view, pending, close };
}
