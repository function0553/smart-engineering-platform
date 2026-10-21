import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail } from './service.mjs';
import { buildEngineeringPurchaseReturns } from './engineering-purchase-returns.mjs';

const MAX_AMOUNT = 1_000_000_000_000, MAX_QUANTITY = 1_000_000_000;
const id = z.string().uuid(), quantity = z.number().int().min(1).max(MAX_QUANTITY), price = z.number().int().min(1).max(MAX_AMOUNT);
const note = z.string().trim().min(1).max(2000), now = () => new Date().toISOString();
const identityKeys = ['materialId', 'materialTitle', 'code', 'specification', 'unit', 'warehouse'];
const signed = row => ['approved', 'closed'].includes(row.state);
const parse = row => row ? { ...row, snapshot: JSON.parse(row.snapshot) } : null;
export const purchaseLinesSchema = z.array(z.object({ id: id.optional(), materialId: id, quantity, unitPrice: price }).strict()).min(1).max(50);
const movementLines = z.array(z.object({ lineId: id, quantity }).strict()).min(1).max(50);
export function legacyPurchaseLineId(purchaseId) {
  const hash = createHash('sha256').update('engineering-purchase-legacy:' + purchaseId).digest('hex').slice(0, 32).split('');
  hash[12] = '5'; hash[16] = ((parseInt(hash[16], 16) & 3) | 8).toString(16);
  const value = hash.join(''); return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
const rounded = (q, p) => (BigInt(q) * BigInt(p) + 500n) / 1000n;
function money(q, p, status = 400) { const value = rounded(q, p); if (value > BigInt(MAX_AMOUNT)) fail(status, '采购行金额超过允许范围'); return Number(value); }
function total(values, status = 422) { const value = values.reduce((n, v) => n + BigInt(v), 0n); if (value < 0n || value > BigInt(MAX_AMOUNT)) fail(status, '采购金额合计超过允许范围'); return Number(value); }
function integer(value, maximum = MAX_AMOUNT, minimum = 0) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(422, '采购履约数量或金额不是允许范围内的整数'); }
function materialIdentity(row) { return { materialId: row.id, materialTitle: row.data.title, code: row.data.code, specification: row.data.specification, unit: row.data.unit, warehouse: row.data.warehouse }; }
function distinct(lines, key) { if (new Set(lines.map(line => line[key])).size !== lines.length) fail(400, '同一次办理不能重复引用同一采购行'); }

/** Recompute from immutable procurement/stock/decision sources in one caller snapshot. */
export function buildEngineeringPurchaseFulfillment({ projectId, items, stock = [], terminations = [], sources = [], pendingReversals = [], returns = [] }) {
  if (!projectId || !Array.isArray(items) || !Array.isArray(stock) || !Array.isArray(terminations) || !Array.isArray(sources)) fail(422, '采购履约快照不完整');
  const byId = new Map(items.map(row => [row.id, row])), sourceById = new Map();
  for (const source of sources) { if (sourceById.has(source.purchaseId)) fail(422, '采购材料快照重复'); sourceById.set(source.purchaseId, source.snapshot); }
  const seenLines = new Set(), orderById = new Map();
  const orders = items.filter(row => row.kind === 'purchases').map(row => {
    if (row.project_id !== projectId) fail(422, '采购单不属于导出项目');
    const data = row.data, legacy = !Array.isArray(data.lines), source = sourceById.get(row.id);
    if (data.contractId) { const c = byId.get(data.contractId); if (!c || c.project_id !== projectId || c.kind !== 'contracts' || c.data.direction !== 'expense') fail(422, '采购关联合同不一致'); }
    let lines;
    if (legacy) {
      const material = byId.get(data.materialId);
      if (!material || material.kind !== 'materials' || material.project_id !== projectId) fail(422, '采购材料来源不一致');
      const frozen = source || materialIdentity(material);
      if (frozen.materialId !== data.materialId) fail(422, '采购材料快照与原件不一致');
      lines = [{ id: legacyPurchaseLineId(row.id), ...frozen, quantity: data.quantity, unitPrice: data.unitPrice, amount: data.amount }];
    } else lines = data.lines.map(line => ({ ...line }));
    if (!lines.length || lines.length > 50) fail(422, '采购行数无效');
    for (const line of lines) {
      if (!id.safeParse(line.id).success || seenLines.has(line.id)) fail(422, '采购行标识无效或重复'); seenLines.add(line.id);
      const material = byId.get(line.materialId);
      if (!material || material.kind !== 'materials' || material.project_id !== projectId || identityKeys.some(key => typeof line[key] !== 'string' || !line[key])) fail(422, '采购行材料来源或冻结身份无效');
      integer(line.quantity, MAX_QUANTITY, 1); integer(line.unitPrice, MAX_AMOUNT, 1); integer(line.amount);
      if (line.amount !== money(line.quantity, line.unitPrice, 422)) fail(422, '采购原行金额与量价不一致');
      Object.assign(line, { grossReceivedQuantity: 0, supplierReturnedQuantity: 0, receivedQuantity: 0, terminatedQuantity: 0, remainingQuantity: line.quantity, effectiveAmount: 0 });
    }
    integer(data.amount, MAX_AMOUNT, 1); if (total(lines.map(line => line.amount)) !== data.amount) fail(422, '采购总额与原行合计不一致');
    const order = { purchaseId: row.id, title: data.title, state: row.state, version: row.version, contractId: data.contractId || '', supplier: data.supplier, dueDate: data.dueDate,
      legacy, identityFrozen: !legacy || !!source, originalAmount: data.amount, effectiveAmount: 0, releasedAmount: 0, lines,
      pendingTerminationId: null, pendingReversalIds: [], pendingReturnIds: [], canClose: false, closeBlockers: [], createdBy: row.created_by, editedBy: row.edited_by || '' };
    orderById.set(row.id, order); return order;
  });
  for (const source of sources) if (!orderById.get(source.purchaseId)?.legacy) fail(422, '旧单材料快照没有对应旧采购原件');
  for (const movement of stock.filter(row => row.kind === 'receive')) {
    const order = orderById.get(movement.reference_id);
    if (movement.project_id !== projectId || !order) fail(422, '采购入库引用不属于本项目');
    const lineId = movement.purchase_line_id || (order.legacy ? order.lines[0].id : '');
    const line = order.lines.find(value => value.id === lineId);
    if (!line || line.materialId !== movement.material_id) fail(422, '入库采购行或材料与原件不一致');
    integer(movement.quantity, MAX_QUANTITY, 1);
    if (!movement.reversed) { line.grossReceivedQuantity += movement.quantity; integer(line.grossReceivedQuantity, Number.MAX_SAFE_INTEGER); }
  }
  const returnView = buildEngineeringPurchaseReturns({ projectId, orders, stock, returns });
  for (const record of returnView.returns) {
    const order = orderById.get(record.purchase_id);
    if (['submitted', 'approved'].includes(record.state)) order.pendingReturnIds.push(record.id);
    if (record.state === 'dispatched') for (const entry of record.snapshot.lines) {
      const line = order.lines.find(value => value.id === entry.purchaseLineId);
      line.supplierReturnedQuantity += entry.quantity; integer(line.supplierReturnedQuantity, Number.MAX_SAFE_INTEGER);
    }
  }
  for (const order of orders) for (const line of order.lines) line.receivedQuantity = line.grossReceivedQuantity - line.supplierReturnedQuantity;
  const decisions = terminations.map(row => {
    const order = orderById.get(row.purchase_id), snapshot = row.snapshot;
    if (!order || row.project_id !== projectId || snapshot?.purchaseId !== order.purchaseId || snapshot.contractId !== order.contractId || !Array.isArray(snapshot.lines) || !snapshot.lines.length || snapshot.lines.length > 50) fail(422, '采购终止快照来源不一致');
    integer(snapshot.purchaseVersion, Number.MAX_SAFE_INTEGER, 1); integer(snapshot.originalAmount, MAX_AMOUNT, 1); integer(snapshot.effectiveAmount);
    if (snapshot.originalAmount !== order.originalAmount || snapshot.purchaseVersion > order.version || snapshot.purchaseTitle !== order.title || snapshot.createdBy !== order.createdBy || snapshot.editedBy !== order.editedBy || snapshot.effectiveAmount > snapshot.originalAmount) fail(422, '采购终止原件身份或冻结金额不一致');
    if (!['submitted', 'approved', 'rejected', 'cancelled'].includes(row.state)) fail(422, '采购终止状态无效');
    const seen = new Set();
    for (const entry of snapshot.lines) {
      const line = order.lines.find(value => value.id === entry.lineId);
      if (!line || seen.has(entry.lineId) || entry.materialId !== line.materialId || entry.orderedQuantity !== line.quantity || entry.unitPrice !== line.unitPrice || entry.originalAmount !== line.amount) fail(422, '采购终止行与原件不一致');
      seen.add(entry.lineId); integer(entry.quantity, MAX_QUANTITY, 1); integer(entry.receivedQuantity, MAX_QUANTITY); integer(entry.terminatedQuantity, MAX_QUANTITY);
      const remaining = line.quantity - entry.receivedQuantity - entry.terminatedQuantity;
      if (remaining !== entry.remainingQuantity || entry.quantity > remaining || entry.effectiveAmountBefore !== money(line.quantity - entry.terminatedQuantity, line.unitPrice, 422) || entry.effectiveAmountAfter !== money(line.quantity - entry.terminatedQuantity - entry.quantity, line.unitPrice, 422) || entry.releasedAmount !== entry.effectiveAmountBefore - entry.effectiveAmountAfter) fail(422, '采购终止冻结数量或金额不一致');
      if (row.state === 'approved') line.terminatedQuantity += entry.quantity;
    }
    if (row.state === 'submitted') { if (order.pendingTerminationId) fail(422, '同一采购存在重复待审终止'); order.pendingTerminationId = row.id; }
    return { ...row, excludedReviewerIds: [...new Set([row.requested_by, snapshot.createdBy, snapshot.editedBy, order.createdBy, order.editedBy].filter(Boolean))] };
  });
  const movementById = new Map(stock.map(row => [row.id, row]));
  for (const reversal of pendingReversals.filter(row => row.state === 'submitted' && row.target_type === 'stock')) {
    const movement = movementById.get(reversal.target_id), order = movement?.kind === 'receive' && orderById.get(movement.reference_id);
    if (order) order.pendingReversalIds.push(reversal.id);
  }
  for (const order of orders) {
    for (const line of order.lines) {
      integer(line.receivedQuantity, MAX_QUANTITY); integer(line.terminatedQuantity, MAX_QUANTITY);
      line.remainingQuantity = line.quantity - line.receivedQuantity - line.terminatedQuantity;
      if (line.remainingQuantity < 0 || !signed(order) && (line.receivedQuantity || line.terminatedQuantity)) fail(422, '采购行累计收货与终止数量超过原件或状态不一致');
      line.effectiveAmount = signed(order) ? money(line.quantity - line.terminatedQuantity, line.unitPrice, 422) : 0;
    }
    order.effectiveAmount = total(order.lines.map(line => line.effectiveAmount));
    order.releasedAmount = signed(order) ? order.originalAmount - order.effectiveAmount : 0;
    if (order.state !== 'approved') order.closeBlockers.push('仅已批准采购单可办理到货完成');
    if (order.lines.some(line => line.remainingQuantity !== 0)) order.closeBlockers.push('仍有采购行未完成收货或未交余量终止');
    if (order.pendingTerminationId) order.closeBlockers.push('仍有待审未交余量终止申请');
    if (order.pendingReversalIds.length) order.closeBlockers.push('仍有相关待审入库冲销');
    if (order.pendingReturnIds.length) order.closeBlockers.push('仍有未完成供应商退货');
    order.canClose = order.closeBlockers.length === 0;
  }
  return { orders, terminations: decisions, sources, returns: returnView.returns, returnReceipts: returnView.receipts };
}

export function createEngineeringPurchases({ store, access, active, mutate, history, getItems, getItem, manager, financial, reversed, returns = () => [] }) {
  const db = store.db;
  for (const column of ['purchase_line_id', 'receipt_batch_id']) if (!db.prepare('PRAGMA table_info(engineering_stock)').all().some(c => c.name === column)) db.exec(`ALTER TABLE engineering_stock ADD COLUMN ${column} TEXT NOT NULL DEFAULT ''`);
  db.exec(`CREATE INDEX IF NOT EXISTS engineering_stock_purchase_line ON engineering_stock(project_id,reference_id,purchase_line_id,kind);
    CREATE TABLE IF NOT EXISTS engineering_purchase_sources(purchase_id TEXT PRIMARY KEY REFERENCES engineering_items(id),project_id TEXT NOT NULL REFERENCES engineering_projects(id),snapshot TEXT NOT NULL CHECK(json_valid(snapshot)));
    CREATE TABLE IF NOT EXISTS engineering_purchase_terminations(
      id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES engineering_projects(id),purchase_id TEXT NOT NULL REFERENCES engineering_items(id),
      state TEXT NOT NULL CHECK(state IN ('submitted','approved','rejected','cancelled')),version INTEGER NOT NULL,
      note TEXT NOT NULL,snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),requested_by TEXT NOT NULL REFERENCES users(id),requester_name TEXT NOT NULL,created_at TEXT NOT NULL,
      reviewed_by TEXT REFERENCES users(id),reviewer_name TEXT,review_note TEXT,reviewed_at TEXT);
    CREATE INDEX IF NOT EXISTS engineering_purchase_terminations_project ON engineering_purchase_terminations(project_id,purchase_id);
    CREATE UNIQUE INDEX IF NOT EXISTS engineering_purchase_termination_pending ON engineering_purchase_terminations(purchase_id) WHERE state='submitted';`);
  const pending = (pid, purchaseId) => !!db.prepare("SELECT 1 FROM engineering_purchase_terminations WHERE project_id=? AND state='submitted'" + (purchaseId ? ' AND purchase_id=?' : '')).get(...(purchaseId ? [pid, purchaseId] : [pid]));
  const pendingContract = (pid, cid) => !!db.prepare("SELECT 1 FROM engineering_purchase_terminations t JOIN engineering_items i ON i.id=t.purchase_id WHERE t.project_id=? AND t.state='submitted' AND json_extract(i.data,'$.contractId')=?").get(pid, cid);
  function projectView(pid, items = getItems(pid)) {
    return buildEngineeringPurchaseFulfillment({ projectId: pid, items,
      stock: db.prepare('SELECT * FROM engineering_stock WHERE project_id=?').all(pid).map(row => ({ ...row, reversed: reversed('stock', row.id) })),
      terminations: db.prepare('SELECT * FROM engineering_purchase_terminations WHERE project_id=? ORDER BY created_at DESC,id DESC').all(pid).map(parse),
      sources: db.prepare('SELECT purchase_id,snapshot FROM engineering_purchase_sources WHERE project_id=?').all(pid).map(row => ({ purchaseId: row.purchase_id, snapshot: JSON.parse(row.snapshot) })),
      pendingReversals: db.prepare("SELECT * FROM engineering_reversals WHERE project_id=? AND state='submitted' AND target_type='stock'").all(pid), returns: returns(pid) });
  }
  function view(pid, iid) { getItem(pid, iid, 'purchases'); return projectView(pid).orders.find(row => row.purchaseId === iid); }
  function effectiveAmount(row) {
    if (!signed(row)) return 0;
    // Contract consumers need only immutable quantities and approved terminations;
    // do not materialize every project's receipts and material names per order.
    const lines = Array.isArray(row.data.lines) ? row.data.lines : [{ id: legacyPurchaseLineId(row.id), quantity: row.data.quantity, unitPrice: row.data.unitPrice, amount: row.data.amount }];
    const terminated = new Map();
    for (const request of db.prepare("SELECT snapshot FROM engineering_purchase_terminations WHERE purchase_id=? AND project_id=? AND state='approved'").all(row.id, row.project_id)) {
      const snapshot = JSON.parse(request.snapshot); if (snapshot.purchaseId !== row.id) fail(422, '采购终止来源不一致');
      for (const entry of snapshot.lines) {
        const line = lines.find(value => value.id === entry.lineId);
        integer(entry.quantity, MAX_QUANTITY, 1);
        if (!line || entry.orderedQuantity !== line.quantity || entry.unitPrice !== line.unitPrice || entry.originalAmount !== line.amount) fail(422, '采购终止行与原件不一致');
        terminated.set(line.id, (terminated.get(line.id) || 0) + entry.quantity);
      }
    }
    return total(lines.map(line => {
      integer(line.quantity, MAX_QUANTITY, 1); integer(line.unitPrice, MAX_AMOUNT, 1);
      if (line.amount !== money(line.quantity, line.unitPrice, 422)) fail(422, '采购原行金额与量价不一致');
      const used = terminated.get(line.id) || 0; if (used > line.quantity) fail(422, '采购累计终止超过原数量');
      return money(line.quantity - used, line.unitPrice, 422);
    }));
  }
  function validate(pid, data, current, approving = false) {
    if (data.contractId) { const contract = getItem(pid, data.contractId, 'contracts'); if (contract.state !== 'approved' || contract.data.direction !== 'expense') fail(409, '采购需要已批准且未关闭的支出合同'); }
    const legacy = !Array.isArray(data.lines);
    if (current && legacy !== !Array.isArray(current.data.lines)) fail(409, '旧单与多行采购的模式不能通过编辑互换');
    if (legacy) {
      const material = getItem(pid, data.materialId, 'materials'), saved = current && db.prepare('SELECT snapshot FROM engineering_purchase_sources WHERE purchase_id=?').get(current.id);
      if (approving && saved && identityKeys.some(key => JSON.parse(saved.snapshot)[key] !== materialIdentity(material)[key])) fail(409, '采购材料身份已变化，请退回草稿重新保存后提交');
      const calculated = money(data.quantity, data.unitPrice); if (!calculated) fail(400, '采购总额须大于 0 分');
      if (approving && calculated !== data.amount) fail(409, '采购报价已变化，请退回重新保存');
      data.amount = calculated; return;
    }
    const inputs = approving ? data.lines : purchaseLinesSchema.parse(data.lines);
    const lines = inputs.map(input => {
      const material = getItem(pid, input.materialId, 'materials'), line = { id: input.id || randomUUID(), ...materialIdentity(material), quantity: input.quantity, unitPrice: input.unitPrice, amount: money(input.quantity, input.unitPrice) };
      if (approving && ['id', ...identityKeys, 'quantity', 'unitPrice', 'amount'].some(key => line[key] !== input[key])) fail(409, '采购材料身份或报价已变化，请退回草稿重新保存后提交');
      const other = db.prepare("SELECT id FROM engineering_items WHERE kind='purchases' AND id<>? AND (EXISTS(SELECT 1 FROM json_each(data,'$.lines') j WHERE json_extract(j.value,'$.id')=?) OR id=?)").get(current?.id || '', line.id, line.id);
      if (other || db.prepare("SELECT id FROM engineering_items WHERE kind='purchases' AND id<>? AND json_type(data,'$.lines') IS NULL").all(current?.id || '').some(item => legacyPurchaseLineId(item.id) === line.id)) fail(400, '采购行 ID 已属于其他采购单');
      return line;
    });
    distinct(lines, 'id'); const amount = total(lines.map(line => line.amount), 400); if (!amount) fail(400, '采购总额须大于 0 分');
    if (approving) { if (data.amount !== amount) fail(409, '采购总额与冻结报价不一致'); }
    else Object.assign(data, { lines, amount });
  }
  function saved(row) {
    if (row.kind !== 'purchases' || Array.isArray(row.data.lines)) return;
    const snapshot = materialIdentity(getItem(row.project_id, row.data.materialId, 'materials'));
    db.prepare('INSERT INTO engineering_purchase_sources(purchase_id,project_id,snapshot) VALUES(?,?,?) ON CONFLICT(purchase_id) DO UPDATE SET snapshot=excluded.snapshot').run(row.id, row.project_id, JSON.stringify(snapshot));
  }
  function lockMaterial(pid, iid, data, original) {
    const identity = ['title', 'code', 'specification', 'unit', 'warehouse'];
    if (!identity.some(key => data[key] !== original[key])) return;
    if (getItems(pid).some(row => row.kind === 'purchases' && signed(row) && (Array.isArray(row.data.lines) ? row.data.lines.some(line => line.materialId === iid) : row.data.materialId === iid))) fail(409, '材料已被批准采购引用，名称、编码、规格、单位及仓库不能改写');
  }
  function openOrder(pid, iid) {
    const row = getItem(pid, iid, 'purchases'); if (row.state !== 'approved') fail(409, '仅已批准且未完成的采购单可收货或申请终止');
    if (row.data.contractId && getItem(pid, row.data.contractId, 'contracts').state !== 'approved') fail(409, '关联合同已关闭，不能新增收货或终止');
    return row;
  }
  function receiptCheck(pid, iid, lineId, materialId, qty) {
    openOrder(pid, iid); const order = view(pid, iid);
    if (order.pendingTerminationId) fail(409, '采购仍有待审终止申请，暂不能收货');
    if (order.pendingReturnIds.length) fail(409, '采购仍有未完成供应商退货，暂不能收货');
    const selected = lineId || (order.legacy ? order.lines[0].id : '');
    if (!selected) fail(400, '多行采购入库必须指定采购行');
    const line = order.lines.find(value => value.id === selected);
    if (!line || materialId && line.materialId !== materialId) fail(400, '采购行不存在、属于其他采购或材料不一致');
    if (qty > line.remainingQuantity) fail(409, '本次验收超过采购行剩余未交数量');
    const actual = materialIdentity(getItem(pid, line.materialId, 'materials'));
    if (order.identityFrozen && identityKeys.some(key => line[key] !== actual[key])) fail(409, '材料身份与采购冻结依据不一致，暂不能入库');
    return line;
  }
  function insertReceipt(pid, iid, line, qty, batch, actor, entryNote) {
    const sid = randomUUID();
    db.prepare("INSERT INTO engineering_stock(id,project_id,material_id,kind,quantity,reference_id,note,actor_id,created_at,purchase_line_id,receipt_batch_id) VALUES(?,?,?,'receive',?,?,?,?,?,?,?)").run(sid, pid, line.materialId, qty, iid, entryNote, actor.id, now(), line.id, batch);
    history(actor, pid, line.materialId, 'materials', 'receive', entryNote);
    return sid;
  }
  function close(pid, iid) { const order = view(pid, iid); if (!order.canClose) fail(409, order.closeBlockers.join('；')); }
  function closeContract(pid, cid) {
    if (pendingContract(pid, cid)) fail(409, '合同仍有待审采购余量终止，暂不能结清');
    if (projectView(pid).orders.some(order => order.contractId === cid && order.pendingReversalIds.length)) fail(409, '合同仍有待审采购入库冲销，暂不能结清');
    if (projectView(pid).orders.some(order => order.contractId === cid && order.pendingReturnIds.length)) fail(409, '合同仍有未完成供应商退货，暂不能结清');
  }
  function reversalCheck(pid, movement) {
    if (movement.kind !== 'receive') return;
    if (pending(pid, movement.reference_id)) fail(409, '采购仍有待审终止申请，暂不能申请或批准入库冲销');
    const projection = projectView(pid), order = projection.orders.find(value => value.purchaseId === movement.reference_id), lineId = movement.purchase_line_id || (order?.legacy ? order.lines[0].id : '');
    if (!order) fail(409, '原入库采购来源不存在');
    if (order.pendingReturnIds.length) fail(409, '采购仍有未完成供应商退货，暂不能冲销入库');
    if (projection.returns.some(row => row.state === 'dispatched' && row.snapshot.lines.some(line => line.receiptId === movement.id))) fail(409, '原入库已有实际供应商退货，不能再全额冲销');
    const line = order.lines.find(value => value.id === lineId);
    if (!line || line.materialId !== movement.material_id) fail(409, '原入库与采购行来源不一致');
  }
  function captureTermination(pid, iid, inputs) {
    const row = openOrder(pid, iid), order = view(pid, iid); distinct(inputs, 'lineId');
    if (order.pendingReversalIds.length) fail(409, '采购仍有待审入库冲销，请先完成或撤回后申请终止');
    if (order.pendingReturnIds.length) fail(409, '采购仍有未完成供应商退货，请先完成或撤回后申请终止');
    const lines = inputs.map(input => {
      const line = order.lines.find(value => value.id === input.lineId);
      if (!line) fail(400, '终止引用的采购行不属于本单');
      if (input.quantity > line.remainingQuantity) fail(409, '终止数量超过该采购行当前未交余量');
      const after = money(line.quantity - line.terminatedQuantity - input.quantity, line.unitPrice);
      return { lineId: line.id, ...Object.fromEntries(identityKeys.map(key => [key, line[key]])), orderedQuantity: line.quantity, unitPrice: line.unitPrice, originalAmount: line.amount,
        receivedQuantity: line.receivedQuantity, terminatedQuantity: line.terminatedQuantity, remainingQuantity: line.remainingQuantity, quantity: input.quantity,
        effectiveAmountBefore: line.effectiveAmount, effectiveAmountAfter: after, releasedAmount: line.effectiveAmount - after };
    });
    return { purchaseId: iid, purchaseTitle: row.data.title, purchaseVersion: row.version, contractId: row.data.contractId || '', createdBy: row.created_by, editedBy: row.edited_by || '', originalAmount: order.originalAmount, effectiveAmount: order.effectiveAmount, lines };
  }
  function authorized(req, receiving = false) {
    const context = access(req, true);
    if (receiving ? !manager(context.role) : !financial(context.role)) fail(403, receiving ? '采购验收入库需要项目经理或管理员' : '没有采购经营办理权限');
    return context;
  }
  function mount(app, base, authorize, writer) {
    app.post(base + '/projects/:pid/purchases/:iid/receipts', authorize, writer, (req, res) => {
      const { p } = authorized(req, true), iid = id.parse(req.params.iid), body = z.object({ requestId: id, note, lines: movementLines }).strict().parse(req.body);
      res.status(201).json(mutate(req, p.id + ':purchase:' + iid + ':receipts', () => {
        const context = authorized(req, true); active(context.p); distinct(body.lines, 'lineId');
        const lines = body.lines.map(entry => ({ entry, line: receiptCheck(p.id, iid, entry.lineId, null, entry.quantity) }));
        const receiptBatchId = randomUUID(), result = lines.map(({ entry, line }) => ({ lineId: line.id, stockId: insertReceipt(p.id, iid, line, entry.quantity, receiptBatchId, req.actor, body.note), quantity: entry.quantity }));
        return { purchaseId: iid, receiptBatchId, stockIds: result.map(line => line.stockId), lines: result };
      }));
    });
    app.post(base + '/projects/:pid/purchases/:iid/terminations', authorize, writer, (req, res) => {
      const { p } = authorized(req), iid = id.parse(req.params.iid), body = z.object({ requestId: id, version: z.number().int().positive(), note, lines: movementLines }).strict().parse(req.body);
      res.status(201).json(mutate(req, p.id + ':purchase:' + iid + ':termination:create', () => {
        const context = authorized(req); active(context.p); const row = openOrder(p.id, iid);
        if (row.version !== body.version) fail(409, '采购单已更新，请刷新核对');
        if (pending(p.id, iid)) fail(409, '采购单已有待审终止申请');
        const snapshot = captureTermination(p.id, iid, body.lines), tid = randomUUID();
        db.prepare("INSERT INTO engineering_purchase_terminations(id,project_id,purchase_id,state,version,note,snapshot,requested_by,requester_name,created_at) VALUES(?,?,?,'submitted',1,?,?,?,?,?)").run(tid, p.id, iid, body.note, JSON.stringify(snapshot), req.actor.id, req.actor.name, now());
        history(req.actor, p.id, iid, 'purchases', 'termination_submit', '申请终止未交余量：' + body.note);
        return { id: tid, state: 'submitted', version: 1 };
      }));
    });
    app.post(base + '/projects/:pid/purchases/:iid/terminations/:tid/state', authorize, writer, (req, res) => {
      const { p } = authorized(req), iid = id.parse(req.params.iid), tid = id.parse(req.params.tid);
      const body = z.object({ requestId: id, version: z.number().int().positive(), state: z.enum(['approved', 'rejected', 'cancelled']), note }).strict().parse(req.body);
      res.json(mutate(req, p.id + ':purchase:' + iid + ':termination:' + tid + ':state', () => {
        const context = authorized(req); active(context.p);
        const request = parse(db.prepare('SELECT * FROM engineering_purchase_terminations WHERE id=? AND project_id=? AND purchase_id=?').get(tid, p.id, iid));
        if (!request) fail(404, '采购终止申请不存在或不属于本单');
        if (request.state !== 'submitted' || request.version !== body.version) fail(409, '采购终止申请已更新或已办理');
        if (body.state === 'cancelled') { if (request.requested_by !== req.actor.id && !manager(context.role)) fail(403, '仅申请人或项目经理可以撤回终止申请'); }
        else if (!manager(context.role)) fail(403, '终止余量需要项目经理或管理员复核');
        if (body.state === 'approved') {
          const original = getItem(p.id, iid, 'purchases'), snapshot = request.snapshot;
          if ([request.requested_by, original.created_by, original.edited_by, snapshot.createdBy, snapshot.editedBy].includes(req.actor.id)) fail(409, '申请人及采购创建人、最后编辑人不能审批终止，请其他经理复核');
          const current = captureTermination(p.id, iid, snapshot.lines.map(line => ({ lineId: line.lineId, quantity: line.quantity })));
          if (JSON.stringify(current) !== JSON.stringify(snapshot)) fail(409, '采购原件或履约数量已变化，请撤回并重新申请终止');
        }
        db.prepare('UPDATE engineering_purchase_terminations SET state=?,version=version+1,reviewed_by=?,reviewer_name=?,review_note=?,reviewed_at=? WHERE id=?').run(body.state, req.actor.id, req.actor.name, body.note, now(), tid);
        history(req.actor, p.id, iid, 'purchases', 'termination_' + body.state, '采购未交余量终止：' + body.note);
        return { id: tid, state: body.state, version: request.version + 1 };
      }));
    });
  }
  return { mount, projectView, view, effectiveAmount, validate, saved, lockMaterial, pending, pendingContract, receiptCheck, insertReceipt, close, closeContract, reversalCheck };
}
