import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail } from './service.mjs';

const MAX_QUANTITY = 1_000_000_000, MAX_AMOUNT = 1_000_000_000_000;
const id = z.string().uuid(), version = z.number().int().positive(), note = z.string().trim().min(1).max(2000);
const inputLines = z.array(z.object({ receiptId: id, quantity: z.number().int().min(1).max(MAX_QUANTITY) }).strict()).min(1).max(50);
const identityKeys = ['materialId', 'materialTitle', 'code', 'specification', 'unit', 'warehouse'];
const now = () => new Date().toISOString();
const chinaDate = value => new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 10);
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
const date = z.string().refine(validDate, '发退日期格式无效');
const parse = row => row ? { ...row, snapshot: JSON.parse(row.snapshot), dispatch: row.dispatch ? JSON.parse(row.dispatch) : null } : null;
function integer(value, max = Number.MAX_SAFE_INTEGER, min = 0) { if (!Number.isSafeInteger(value) || value < min || value > max) fail(422, '退货数量或金额不在允许整数范围'); return value; }
function sum(values, max = Number.MAX_SAFE_INTEGER) { const n = values.reduce((acc, value) => acc + BigInt(integer(value)), 0n); if (n > BigInt(max)) fail(422, '退货数量或金额合计超过允许范围'); return Number(n); }
const money = (quantity, price) => Number((BigInt(quantity) * BigInt(price) + 500n) / 1000n);
const difference = (previous, quantity, price) => money(previous + quantity, price) - money(previous, price);
const distinct = lines => { if (new Set(lines.map(line => line.receiptId)).size !== lines.length) fail(400, '同一次退货不能重复引用同一入库流水'); };
const reviewers = snapshot => [...new Set([snapshot.createdBy, snapshot.editedBy, ...snapshot.lines.map(line => line.receiptActorId)].filter(Boolean))];
function requireDate(value, lines, status = 400) {
  if (!validDate(value) || value > chinaDate(now())) fail(status, '实际发退日期无效或晚于今天');
  if (lines.some(line => value < chinaDate(line.receiptCreatedAt))) fail(status, '实际发退日期不能早于原入库日期');
}

/** Pure, same-snapshot validation. Orders are canonical immutable procurement lines. */
export function buildEngineeringPurchaseReturns({ projectId, orders, stock, returns = [] }) {
  if (!projectId || !Array.isArray(orders) || !Array.isArray(stock) || !Array.isArray(returns)) fail(422, '采购退货快照不完整');
  const orderById = new Map(), receiptById = new Map(), balances = new Map();
  for (const order of orders) { if (orderById.has(order.purchaseId)) fail(422, '退货采购来源重复'); orderById.set(order.purchaseId, order); }
  for (const movement of stock) {
    if (movement.project_id !== projectId || !['opening', 'receive', 'issue', 'return'].includes(movement.kind)) fail(422, '退货库存来源不属于本项目');
    integer(movement.quantity, MAX_QUANTITY, 1);
    if (!movement.reversed) balances.set(movement.material_id, (balances.get(movement.material_id) || 0n) + BigInt(movement.quantity) * (movement.kind === 'issue' ? -1n : 1n));
    if (movement.kind !== 'receive') continue;
    const order = orderById.get(movement.reference_id), lineId = movement.purchase_line_id || (order?.legacy ? order.lines[0]?.id : '');
    const line = order?.lines.find(value => value.id === lineId);
    if (!line || line.materialId !== movement.material_id || receiptById.has(movement.id)) fail(422, '退货原入库的采购行或材料不一致');
    integer(line.unitPrice, MAX_AMOUNT, 1);
    if (!Number.isFinite(Date.parse(movement.created_at))) fail(422, '退货原入库时间无效');
    receiptById.set(movement.id, { id: movement.id, receiptId: movement.id, purchaseId: order.purchaseId, purchaseTitle: order.title,
      contractId: order.contractId, supplier: order.supplier, lineId, purchaseLineId: lineId, receiptBatchId: movement.receipt_batch_id || '',
      ...Object.fromEntries(identityKeys.map(key => [key, line[key]])), unitPrice: line.unitPrice, quantity: movement.quantity,
      returnedQuantity: 0, availableQuantity: movement.reversed ? 0 : movement.quantity, returnedAmount: 0,
      receivedAt: movement.created_at, actorId: movement.actor_id, reversed: !!movement.reversed });
  }
  const seen = new Set(), pendingOrders = new Set(), sequences = new Set();
  const records = returns.map(row => {
    const snapshot = row.snapshot, order = orderById.get(row.purchase_id);
    if (!id.safeParse(row.id).success || seen.has(row.id) || row.project_id !== projectId || !order || snapshot?.purchaseId !== row.purchase_id) fail(422, '退货记录或采购来源无效');
    seen.add(row.id);
    if (!['submitted', 'approved', 'rejected', 'cancelled', 'dispatched'].includes(row.state) || !Array.isArray(snapshot.lines) || !snapshot.lines.length || snapshot.lines.length > 50) fail(422, '退货状态或明细无效');
    if (!id.safeParse(row.requested_by).success || typeof row.requester_name !== 'string' || !row.requester_name || !Number.isFinite(Date.parse(row.created_at))) fail(422, '退货申请经办依据不完整');
    if (['submitted', 'approved', 'dispatched'].includes(row.state) && !['approved', 'closed'].includes(order.state)) fail(422, '有效退货引用的采购状态无效');
    integer(row.version, Number.MAX_SAFE_INTEGER, 1); integer(snapshot.purchaseVersion, Number.MAX_SAFE_INTEGER, 1); integer(snapshot.amount, MAX_AMOUNT);
    if (snapshot.purchaseVersion > order.version || snapshot.purchaseTitle !== order.title || snapshot.contractId !== order.contractId || snapshot.supplier !== order.supplier || snapshot.createdBy !== order.createdBy || snapshot.editedBy !== order.editedBy) fail(422, '退货采购冻结身份与原件不一致');
    const sourceIds = new Set();
    for (const line of snapshot.lines) {
      const receipt = receiptById.get(line.receiptId);
      if (!receipt || receipt.purchaseId !== order.purchaseId || sourceIds.has(line.receiptId)) fail(422, '退货原入库重复或不属于本采购');
      sourceIds.add(line.receiptId);
      if (identityKeys.some(key => line[key] !== receipt[key]) || line.purchaseLineId !== receipt.lineId || line.receiptBatchId !== receipt.receiptBatchId || line.receiptQuantity !== receipt.quantity || line.receiptActorId !== receipt.actorId || line.receiptCreatedAt !== receipt.receivedAt || line.unitPrice !== receipt.unitPrice) fail(422, '退货冻结入库身份与原件不一致');
      integer(line.quantity, MAX_QUANTITY, 1); integer(line.previouslyReturnedQuantity, MAX_QUANTITY); integer(line.availableQuantity, MAX_QUANTITY); integer(line.amount, MAX_AMOUNT);
      if (line.availableQuantity !== receipt.quantity - line.previouslyReturnedQuantity || line.quantity > line.availableQuantity || line.amount !== difference(line.previouslyReturnedQuantity, line.quantity, line.unitPrice)) fail(422, '退货冻结数量或累计差额金额不一致');
      if (['submitted', 'approved', 'dispatched'].includes(row.state) && receipt.reversed) fail(422, '有效退货引用了已冲销入库');
    }
    if (sum(snapshot.lines.map(line => line.amount), MAX_AMOUNT) !== snapshot.amount) fail(422, '退货总额与冻结行金额不一致');
    if (['approved', 'rejected', 'dispatched'].includes(row.state) && (!id.safeParse(row.reviewed_by).success || [row.requested_by, ...reviewers(snapshot)].includes(row.reviewed_by) || !Number.isFinite(Date.parse(row.reviewed_at)) || Date.parse(row.reviewed_at) < Date.parse(row.created_at))) fail(422, '退货独立复核依据无效');
    if (['submitted', 'approved'].includes(row.state)) { if (pendingOrders.has(row.purchase_id)) fail(422, '同一采购存在多份未完成退货'); pendingOrders.add(row.purchase_id); }
    if (row.state === 'dispatched') {
      integer(row.dispatch_seq, Number.MAX_SAFE_INTEGER, 1);
      if (sequences.has(row.dispatch_seq)) fail(422, '实际发退顺序重复'); sequences.add(row.dispatch_seq);
      const dispatch = row.dispatch;
      if (!dispatch || !Array.isArray(dispatch.lines) || dispatch.lines.length !== snapshot.lines.length || dispatch.amount !== snapshot.amount || !id.safeParse(dispatch.actorId).success || typeof dispatch.actorName !== 'string' || !dispatch.actorName || typeof dispatch.documentNo !== 'string' || !dispatch.documentNo.trim() || dispatch.documentNo.length > 200 || typeof dispatch.note !== 'string' || !dispatch.note.trim() || dispatch.note.length > 2000 || !Number.isFinite(Date.parse(dispatch.at))) fail(422, '实际发退凭据不完整');
      requireDate(dispatch.effectiveDate, snapshot.lines, 422);
      if (Date.parse(dispatch.at) < Date.parse(row.reviewed_at)) fail(422, '实际发退登记早于批准时间');
      if (dispatch.effectiveDate > chinaDate(dispatch.at)) fail(422, '实际发退日期晚于记录时间');
      for (let index = 0; index < snapshot.lines.length; index++) {
        const source = snapshot.lines[index], entry = dispatch.lines[index];
        if (entry.receiptId !== source.receiptId || entry.quantity !== source.quantity || entry.amount !== source.amount) fail(422, '实际发退明细与已批准原件不一致');
      }
    } else if (row.dispatch || row.dispatch_seq !== 0) fail(422, '未实际发退记录包含库存影响');
    return { ...row, excludedReviewerIds: [...new Set([row.requested_by, ...reviewers(snapshot)])] };
  });
  for (const row of records.filter(row => row.state === 'dispatched').sort((a, b) => a.dispatch_seq - b.dispatch_seq)) {
    for (const line of row.snapshot.lines) {
      const receipt = receiptById.get(line.receiptId);
      if (line.previouslyReturnedQuantity !== receipt.returnedQuantity) fail(422, '实际发退累计顺序与冻结原件不一致');
      receipt.returnedQuantity = sum([receipt.returnedQuantity, line.quantity], MAX_QUANTITY);
      receipt.returnedAmount = sum([receipt.returnedAmount, line.amount], MAX_AMOUNT);
      receipt.availableQuantity = receipt.quantity - receipt.returnedQuantity;
      if (receipt.availableQuantity < 0 || receipt.returnedAmount !== money(receipt.returnedQuantity, receipt.unitPrice)) fail(422, '累计实际退货超过原入库数量或金额');
      balances.set(receipt.materialId, (balances.get(receipt.materialId) || 0n) - BigInt(line.quantity));
    }
  }
  for (const row of records) {
    const blockers = [], byMaterial = new Map();
    for (const line of row.snapshot.lines) {
      const receipt = receiptById.get(line.receiptId);
      if (receipt.reversed || line.quantity > receipt.availableQuantity || line.previouslyReturnedQuantity !== receipt.returnedQuantity) blockers.push('原入库可退数量已变化，请撤回后重新申请');
      byMaterial.set(line.materialId, sum([byMaterial.get(line.materialId) || 0, line.quantity]));
    }
    for (const [materialId, quantity] of byMaterial) if ((balances.get(materialId) || 0n) < BigInt(quantity)) blockers.push('当前材料库存不足以实际发退全部批准数量');
    const unique = [...new Set(blockers)];
    row.approvalEligibility = { allowed: row.state === 'submitted' && !unique.length, blockers: row.state === 'submitted' ? unique : ['仅待审批退货可复核'] };
    row.dispatchEligibility = { allowed: row.state === 'approved' && !unique.length, blockers: row.state === 'approved' ? unique : ['仅已批准且未发退记录可登记实际发退'] };
    row.cancelEligibility = { allowed: ['submitted', 'approved'].includes(row.state), blockers: ['submitted', 'approved'].includes(row.state) ? [] : ['当前记录已结束，不能撤回'] };
  }
  return { returns: records, receipts: [...receiptById.values()] };
}

export function createEngineeringPurchaseReturns({ store, access, active, mutate, history, getItems, getItem, manager, purchases, reversed, balance }) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS engineering_purchase_returns(
    id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES engineering_projects(id),purchase_id TEXT NOT NULL REFERENCES engineering_items(id),
    state TEXT NOT NULL CHECK(state IN ('submitted','approved','rejected','cancelled','dispatched')),version INTEGER NOT NULL,
    note TEXT NOT NULL,snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),requested_by TEXT NOT NULL REFERENCES users(id),requester_name TEXT NOT NULL,created_at TEXT NOT NULL,
    reviewed_by TEXT REFERENCES users(id),reviewer_name TEXT,review_note TEXT,reviewed_at TEXT,
    dispatch_seq INTEGER NOT NULL DEFAULT 0,dispatch TEXT CHECK(dispatch IS NULL OR json_valid(dispatch)));
    CREATE INDEX IF NOT EXISTS engineering_purchase_returns_project ON engineering_purchase_returns(project_id,purchase_id,state);
    CREATE UNIQUE INDEX IF NOT EXISTS engineering_purchase_return_pending ON engineering_purchase_returns(purchase_id) WHERE state IN ('submitted','approved');
    CREATE UNIQUE INDEX IF NOT EXISTS engineering_purchase_return_dispatch_seq ON engineering_purchase_returns(project_id,dispatch_seq) WHERE dispatch_seq>0;`);
  const rows = pid => db.prepare('SELECT * FROM engineering_purchase_returns WHERE project_id=? ORDER BY created_at DESC,id DESC').all(pid).map(parse);
  function get(pid, rid) { const row = parse(db.prepare('SELECT * FROM engineering_purchase_returns WHERE id=? AND project_id=?').get(rid, pid)); if (!row) fail(404, '采购退货记录不存在或不属于本项目'); return row; }
  const pendingPurchase = iid => !!db.prepare("SELECT 1 FROM engineering_purchase_returns WHERE purchase_id=? AND state IN ('submitted','approved')").get(iid);
  const pending = (pid, contractId) => !!db.prepare("SELECT 1 FROM engineering_purchase_returns r JOIN engineering_items i ON i.id=r.purchase_id WHERE r.project_id=? AND r.state IN ('submitted','approved')" + (contractId ? " AND json_extract(i.data,'$.contractId')=?" : '')).get(...(contractId ? [pid, contractId] : [pid]));
  const receivedDelta = iid => integer(db.prepare("SELECT COALESCE(SUM(json_extract(j.value,'$.quantity')),0) n FROM engineering_purchase_returns r,json_each(r.snapshot,'$.lines') j WHERE r.purchase_id=? AND r.state='dispatched'").get(iid).n);
  const stockDelta = mid => -integer(db.prepare("SELECT COALESCE(SUM(json_extract(j.value,'$.quantity')),0) n FROM engineering_purchase_returns r,json_each(r.snapshot,'$.lines') j WHERE r.state='dispatched' AND json_extract(j.value,'$.materialId')=?").get(mid).n);
  function projectView(pid) {
    const fulfillment = purchases.projectView(pid);
    return { returns: fulfillment.returns, receipts: fulfillment.returnReceipts };
  }
  function eligibleOrder(pid, iid) {
    const row = getItem(pid, iid, 'purchases');
    if (!['approved', 'closed'].includes(row.state)) fail(409, '采购须已批准，才能申请退货');
    if (row.data.contractId && !['approved', 'closed'].includes(getItem(pid, row.data.contractId, 'contracts').state)) fail(409, '关联合同当前不能办理采购退货');
    return row;
  }
  function checkInventory(lines) {
    const grouped = new Map();
    for (const line of lines) grouped.set(line.materialId, sum([grouped.get(line.materialId) || 0, line.quantity]));
    for (const [mid, qty] of grouped) if (qty > balance(mid)) fail(409, '库存不足，实际发退不能造成负库存');
  }
  function capture(pid, iid, inputs, selfId = '') {
    const row = eligibleOrder(pid, iid), fulfillment = purchases.projectView(pid), order = fulfillment.orders.find(value => value.purchaseId === iid);
    if (order.pendingTerminationId) fail(409, '采购仍有待审余量终止，暂不能办理退货');
    if (order.pendingReversalIds.length) fail(409, '采购仍有待审入库冲销，暂不能办理退货');
    if (order.pendingReturnIds.some(value => value !== selfId)) fail(409, '采购已有未完成退货，请先完成或撤回');
    distinct(inputs);
    const receipts = new Map(fulfillment.returnReceipts.map(value => [value.receiptId, value]));
    const lines = inputs.map(input => {
      const receipt = receipts.get(input.receiptId);
      if (!receipt || receipt.purchaseId !== iid) fail(400, '原入库不存在或不属于本采购');
      if (receipt.reversed || reversed('stock', receipt.receiptId)) fail(409, '原入库已冲销，不能退货');
      if (input.quantity > receipt.availableQuantity) fail(409, '退货数量超过原入库当前可退数量');
      return { receiptId: receipt.receiptId, purchaseLineId: receipt.lineId, receiptBatchId: receipt.receiptBatchId,
        ...Object.fromEntries(identityKeys.map(key => [key, receipt[key]])), receiptQuantity: receipt.quantity, receiptActorId: receipt.actorId,
        receiptCreatedAt: receipt.receivedAt, unitPrice: receipt.unitPrice, quantity: input.quantity,
        previouslyReturnedQuantity: receipt.returnedQuantity, availableQuantity: receipt.availableQuantity,
        amount: difference(receipt.returnedQuantity, input.quantity, receipt.unitPrice) };
    });
    checkInventory(lines);
    return { purchaseId: iid, purchaseTitle: row.data.title, purchaseVersion: row.version, contractId: row.data.contractId || '', supplier: row.data.supplier,
      createdBy: row.created_by, editedBy: row.edited_by || '', amount: sum(lines.map(line => line.amount), MAX_AMOUNT), lines };
  }
  function reversalCheck(pid, movement) {
    if (movement.kind !== 'receive') return;
    if (pendingPurchase(movement.reference_id)) fail(409, '采购仍有未完成退货，暂不能冲销入库');
    if (db.prepare("SELECT 1 FROM engineering_purchase_returns r,json_each(r.snapshot,'$.lines') j WHERE r.project_id=? AND r.state='dispatched' AND json_extract(j.value,'$.receiptId')=?").get(pid, movement.id)) fail(409, '原入库已有实际供应商退货，不能再全额冲销');
  }
  function authorized(req) { const context = access(req, true); if (!manager(context.role)) fail(403, '采购退货需要项目经理或管理员'); return context; }
  function reopen(pid, iid, actor, rid) {
    const row = getItem(pid, iid);
    if (row.state !== 'closed') return;
    db.prepare("UPDATE engineering_items SET state='approved',version=version+1,updated_at=? WHERE id=?").run(now(), iid);
    history(actor, pid, iid, row.kind, 'reopen', '实际采购退货后恢复办理：' + rid);
  }
  function mount(app, base, authorize, writer) {
    app.post(base + '/projects/:pid/purchases/:iid/returns', authorize, writer, (req, res) => {
      const { p } = authorized(req), iid = id.parse(req.params.iid), body = z.object({ requestId: id, version, note, lines: inputLines }).strict().parse(req.body);
      res.status(201).json(mutate(req, p.id + ':purchase:' + iid + ':return:create', () => {
        const context = authorized(req); active(context.p); const purchase = eligibleOrder(p.id, iid);
        if (purchase.version !== body.version) fail(409, '采购版本已变化，请刷新核对');
        const snapshot = capture(p.id, iid, body.lines), rid = randomUUID();
        db.prepare("INSERT INTO engineering_purchase_returns(id,project_id,purchase_id,state,version,note,snapshot,requested_by,requester_name,created_at) VALUES(?,?,?,'submitted',1,?,?,?,?,?)").run(rid, p.id, iid, body.note, JSON.stringify(snapshot), req.actor.id, req.actor.name, now());
        history(req.actor, p.id, iid, 'purchases', 'supplier_return_submit', '申请供应商退货：' + body.note);
        return { id: rid, purchaseId: iid, state: 'submitted', version: 1 };
      }));
    });
    app.post(base + '/projects/:pid/purchases/:iid/returns/:rid/state', authorize, writer, (req, res) => {
      const { p } = authorized(req), iid = id.parse(req.params.iid), rid = id.parse(req.params.rid);
      const body = z.object({ requestId: id, version, state: z.enum(['approved', 'rejected', 'cancelled']), note }).strict().parse(req.body);
      res.json(mutate(req, p.id + ':purchase:' + iid + ':return:' + rid + ':state', () => {
        const context = authorized(req); active(context.p); const row = get(p.id, rid);
        if (row.purchase_id !== iid) fail(404, '退货记录不属于本采购');
        if (row.version !== body.version || !(row.state === 'submitted' || row.state === 'approved' && body.state === 'cancelled')) fail(409, '退货申请已更新或已办理');
        if (body.state !== 'cancelled' && [row.requested_by, ...reviewers(row.snapshot)].includes(req.actor.id)) fail(409, '申请人、采购经办人与原入库经办人不能复核退货');
        if (body.state === 'approved') {
          const snapshot = capture(p.id, iid, row.snapshot.lines.map(line => ({ receiptId: line.receiptId, quantity: line.quantity })), rid);
          if (JSON.stringify(snapshot) !== JSON.stringify(row.snapshot)) fail(409, '采购或原入库依据已变化，请撤回后重新申请');
        }
        db.prepare('UPDATE engineering_purchase_returns SET state=?,version=version+1,reviewed_by=?,reviewer_name=?,review_note=?,reviewed_at=? WHERE id=?').run(body.state, req.actor.id, req.actor.name, body.note, now(), rid);
        history(req.actor, p.id, iid, 'purchases', 'supplier_return_' + body.state, '供应商退货复核：' + body.note);
        return { id: rid, purchaseId: iid, state: body.state, version: row.version + 1 };
      }));
    });
    app.post(base + '/projects/:pid/purchases/:iid/returns/:rid/dispatch', authorize, writer, (req, res) => {
      const { p } = authorized(req), iid = id.parse(req.params.iid), rid = id.parse(req.params.rid);
      const body = z.object({ requestId: id, version, effectiveDate: date, documentNo: z.string().trim().min(1).max(200), note }).strict().parse(req.body);
      res.json(mutate(req, p.id + ':purchase:' + iid + ':return:' + rid + ':dispatch', () => {
        const context = authorized(req); active(context.p); const row = get(p.id, rid);
        if (row.purchase_id !== iid) fail(404, '退货记录不属于本采购');
        if (row.version !== body.version || row.state !== 'approved') fail(409, '仅当前已批准且未发退记录可登记实际发退');
        const snapshot = capture(p.id, iid, row.snapshot.lines.map(line => ({ receiptId: line.receiptId, quantity: line.quantity })), rid);
        if (JSON.stringify(snapshot) !== JSON.stringify(row.snapshot)) fail(409, '采购或原入库依据已变化，请撤回后重新申请');
        requireDate(body.effectiveDate, snapshot.lines);
        const at = now(), dispatch = { effectiveDate: body.effectiveDate, documentNo: body.documentNo, note: body.note, actorId: req.actor.id, actorName: req.actor.name, at,
          amount: snapshot.amount, lines: snapshot.lines.map(line => ({ receiptId: line.receiptId, quantity: line.quantity, amount: line.amount })) };
        const sequence = integer(db.prepare('SELECT COALESCE(MAX(dispatch_seq),0)+1 n FROM engineering_purchase_returns WHERE project_id=?').get(p.id).n, Number.MAX_SAFE_INTEGER, 1);
        db.prepare("UPDATE engineering_purchase_returns SET state='dispatched',version=version+1,dispatch_seq=?,dispatch=? WHERE id=?").run(sequence, JSON.stringify(dispatch), rid);
        reopen(p.id, iid, req.actor, rid); if (snapshot.contractId) reopen(p.id, snapshot.contractId, req.actor, rid);
        history(req.actor, p.id, iid, 'purchases', 'supplier_return_dispatch', '实际发退：' + body.documentNo + '；' + body.note);
        return { id: rid, purchaseId: iid, state: 'dispatched', version: row.version + 1, dispatchId: rid };
      }));
    });
  }
  return { mount, rows, get, projectView, stockDelta, receivedDelta, pending, pendingPurchase, reversalCheck };
}
