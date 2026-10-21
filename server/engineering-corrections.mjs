import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail } from './service.mjs';

const id = z.string().uuid(), note = z.string().trim().min(1).max(2000);
const targetKinds = ['variations', 'measurements', 'settlements'];
const now = () => new Date().toISOString();

// Approval voids the business effect through this append-only decision history.
// It never overwrites the signed source row or its attachment bytes.
export function createEngineeringCorrections({ store, access, active, mutate, history, getItems, getItem, saveItem, manager, financial, reversed, effectiveCostAmount = row => reversed('cost',row.id)?0:row.data.amount, contractSummary, effectivePurchaseAmount = row => row.data.amount, additionalEligibility = () => ({ blockers: [] }), onApproved = () => {} }) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS engineering_corrections(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES engineering_projects(id),
    target_id TEXT NOT NULL REFERENCES engineering_items(id), target_kind TEXT NOT NULL CHECK(target_kind IN ('variations','measurements','settlements')),
    state TEXT NOT NULL CHECK(state IN ('submitted','approved','rejected','cancelled')), version INTEGER NOT NULL,
    snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), note TEXT NOT NULL,
    requested_by TEXT NOT NULL REFERENCES users(id), requester_name TEXT NOT NULL, created_at TEXT NOT NULL,
    reviewed_by TEXT REFERENCES users(id), reviewer_name TEXT, review_note TEXT, reviewed_at TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS engineering_correction_active_target ON engineering_corrections(project_id,target_id) WHERE state IN ('submitted','approved');
    CREATE INDEX IF NOT EXISTS engineering_corrections_project ON engineering_corrections(project_id,created_at);`);
  const voided = iid => !!db.prepare("SELECT 1 FROM engineering_corrections WHERE target_id=? AND state='approved'").get(iid);
  const pending = pid => !!db.prepare("SELECT 1 FROM engineering_corrections WHERE project_id=? AND state='submitted'").get(pid);
  const pendingContract = (pid, cid) => !!db.prepare("SELECT 1 FROM engineering_corrections c JOIN engineering_items i ON i.id=c.target_id WHERE c.project_id=? AND c.state='submitted' AND json_extract(i.data,'$.contractId')=?").get(pid, cid);
  const list = (pid, role) => financial(role) ? db.prepare('SELECT * FROM engineering_corrections WHERE project_id=? ORDER BY created_at DESC,id DESC').all(pid).map(row => ({ ...row, snapshot: JSON.parse(row.snapshot) })) : [];
  const snapshot = row => ({ title: row.data.title, amount: row.data.amount, contractId: row.data.contractId, createdBy: row.created_by, editedBy: row.edited_by || '', data: row.data, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at });
  const block = (row, reason) => ({ id: row.id, kind: row.kind, title: row.data.title, reason });

  function eligibility(pid, row, ignoreCorrectionId) {
    const blockers = [];
    const project = db.prepare('SELECT state FROM engineering_projects WHERE id=?').get(pid);
    if (project?.state !== 'active') blockers.push({ reason: '项目须处于施工中；请先恢复施工后办理经营纠错' });
    if (!targetKinds.includes(row.kind) || row.state !== 'approved') blockers.push(block(row, '仅已批准的变更签证、计量单和结算单可申请撤销业务影响'));
    const outstanding = db.prepare("SELECT id,state FROM engineering_corrections WHERE project_id=? AND target_id=? AND state IN ('submitted','approved')").get(pid, row.id);
    if (outstanding && outstanding.id !== ignoreCorrectionId) blockers.push({ id: outstanding.id, kind: 'correction', title: row.data.title, reason: outstanding.state === 'approved' ? '原单的业务影响已撤销，不能重复申请' : '已有待审纠错申请，请先办理或撤回' });
    if (!targetKinds.includes(row.kind)) return { allowed: false, blockers };
    const contract = getItem(pid, row.data.contractId, 'contracts');
    if (!['approved', 'closed'].includes(contract.state)) blockers.push(block(contract, '关联合同当前不允许经营纠错'));
    const all = getItems(pid);
    if (row.kind === 'settlements') {
      for (const cost of all.filter(item => item.kind === 'costs' && item.data.settlementId === row.id && item.state !== 'cancelled')) {
        if (['draft', 'submitted'].includes(cost.state)) blockers.push(block(cost, '关联收支尚在办理，请先作废草稿或退回后作废'));
        else if (cost.state === 'approved' && effectiveCostAmount(cost)>0) blockers.push(block(cost, '关联收支仍有净额，请先核对退款或独立审批冲销剩余净额'));
      }
    }
    if (row.kind === 'measurements') {
      for (const settlement of all.filter(item => item.kind === 'settlements' && item.data.measurementId === row.id && item.state !== 'cancelled' && !voided(item.id))) blockers.push(block(settlement, settlement.state === 'approved' ? '关联结算仍有效，请先办理结算纠错' : '关联结算尚在办理，请先退回并作废该结算'));
    }
    if (row.kind === 'variations' && !voided(row.id)) {
      const summary = contractSummary(pid, contract.id, undefined, all.filter(item => item.id !== row.id));
      if (summary.effectiveAmount < 0 || summary.effectiveAmount > 1_000_000_000_000) blockers.push(block(contract, '撤销后有效合同额超出 0 至允许上限'));
      if (summary.effectiveAmount < summary.committedAmount) {
        blockers.push(block(contract, '撤销后有效合同额不足以覆盖已批准采购、计量或结算承诺'));
        for (const dependency of all.filter(item => item.data.contractId === contract.id && !voided(item.id) && (item.kind === 'purchases' && ['approved', 'closed'].includes(item.state) && effectivePurchaseAmount(item)>0 || ['measurements', 'settlements'].includes(item.kind) && item.state === 'approved'))) blockers.push(block(dependency, '此有效单据占用合同额度，请核对或先办理相应纠错'));
      }
    }
    blockers.push(...additionalEligibility(pid, row).blockers);
    return { allowed: blockers.length === 0, blockers };
  }
  function ensureEligible(pid, row, ignoreCorrectionId) {
    const result = eligibility(pid, row, ignoreCorrectionId);
    if (!result.allowed) fail(409, result.blockers.map(value => value.reason).join('；'));
  }
  function authorized(req) {
    const context = access(req, true);
    if (!financial(context.role)) fail(403, '没有经营纠错权限');
    return context;
  }
  function view(pid, row) {
    const result = { ...row, voided: targetKinds.includes(row.kind) && voided(row.id) };
    if (targetKinds.includes(row.kind)) result.correctionEligibility = eligibility(pid, row);
    return result;
  }
  function mount(app, base, authorize, writer) {
    app.post(base + '/projects/:pid/corrections', authorize, writer, (req, res) => {
      const { p } = authorized(req), body = z.object({ requestId: id, targetId: id, note }).strict().parse(req.body);
      res.status(201).json(mutate(req, p.id + ':correction:create', () => {
        const current = authorized(req); active(current.p);
        const target = getItem(p.id, body.targetId);
        ensureEligible(p.id, target);
        const cid = randomUUID();
        db.prepare('INSERT INTO engineering_corrections VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(cid, p.id, target.id, target.kind, 'submitted', 1, JSON.stringify(snapshot(target)), body.note, req.actor.id, req.actor.name, now(), null, null, null, null);
        history(req.actor, p.id, target.id, target.kind, 'correction_submit', '申请撤销原单业务影响：' + body.note);
        return { id: cid, state: 'submitted', version: 1 };
      }));
    });
    app.post(base + '/projects/:pid/corrections/:cid/state', authorize, writer, (req, res) => {
      const { p, role } = authorized(req), cid = id.parse(req.params.cid);
      const body = z.object({ requestId: id, version: z.number().int().positive(), state: z.enum(['approved', 'rejected', 'cancelled']), note }).strict().parse(req.body);
      const initial = db.prepare('SELECT * FROM engineering_corrections WHERE id=? AND project_id=?').get(cid, p.id);
      if (!initial) fail(404, '纠错申请不存在或不属于本项目');
      if (body.state === 'cancelled') { if (initial.requested_by !== req.actor.id && !manager(role)) fail(403, '仅申请人或项目经理可撤回'); }
      else if (!manager(role)) fail(403, '需要项目经理或管理员审批经营纠错');
      res.json(mutate(req, p.id + ':correction:' + cid + ':state', () => {
        const current = authorized(req); active(current.p);
        const request = db.prepare('SELECT * FROM engineering_corrections WHERE id=? AND project_id=?').get(cid, p.id);
        if (!request || request.version !== body.version || request.state !== 'submitted') fail(409, '纠错申请已更新或办理，请刷新后核对');
        if (body.state === 'cancelled') { if (request.requested_by !== req.actor.id && !manager(current.role)) fail(403, '仅申请人或项目经理可撤回'); }
        else if (!manager(current.role)) fail(403, '需要项目经理或管理员审批经营纠错');
        if (body.state === 'approved') {
          const target = getItem(p.id, request.target_id), frozen = JSON.parse(request.snapshot);
          if ([request.requested_by, target.created_by, target.edited_by, frozen.createdBy, frozen.editedBy].includes(req.actor.id)) fail(409, '申请人及原单创建人、最后修改人不能审批纠错，请另一位经理审核');
          if (JSON.stringify(snapshot(target)) !== request.snapshot) fail(409, '原单依据已变化，请撤回后重新申请');
          ensureEligible(p.id, target, request.id);
          const contract = getItem(p.id, target.data.contractId, 'contracts');
          if (contract.state === 'closed') { contract.state = 'approved'; saveItem(contract); history(req.actor, p.id, contract.id, 'contracts', 'reopen', '经营纠错后恢复合同办理：' + request.id); }
        }
        db.prepare('UPDATE engineering_corrections SET state=?,version=version+1,reviewed_by=?,reviewer_name=?,review_note=?,reviewed_at=? WHERE id=?').run(body.state, req.actor.id, req.actor.name, body.note, now(), request.id);
        if (body.state === 'approved') onApproved(p.id, getItem(p.id, request.target_id), req.actor);
        history(req.actor, p.id, request.target_id, request.target_kind, 'correction_' + body.state, '经营纠错 ' + request.id + '：' + body.note);
        return { id: request.id, state: body.state, version: request.version + 1, voided: body.state === 'approved' };
      }));
    });
  }
  return { voided, pending, pendingContract, list, view, eligibility, mount };
}
