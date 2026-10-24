import { z } from 'zod';
import { fail } from './service.mjs';

const MAX_AMOUNT = 1_000_000_000_000;
const amount = z.number().int().positive().max(MAX_AMOUNT);
const quantity = z.number().int().positive().max(1_000_000_000);
const text = z.string().trim().min(1).max(200);
const taskId = z.union([z.string().uuid(), z.literal('')]).optional();

// The request schema deliberately excludes derived amounts, both on each line and on the document.
export const measurementLinesSchema = z.array(z.union([z.object({
  name: text, location: text, unit: text.max(30), quantity, unitPrice: amount, taskId,
  note: z.string().trim().max(500).optional().default(''),
}).strict(), z.object({
  boqItemId: z.string().uuid(), quantity, taskId,
  note: z.string().trim().max(500).optional().default(''),
}).strict()])).min(1).max(50);

export function calculateMeasurement(lines) {
  let total = 0n;
  const calculated = lines.map(line => {
    const result = (BigInt(line.quantity) * BigInt(line.unitPrice) + 500n) / 1000n;
    if (result > BigInt(MAX_AMOUNT)) fail(400, '计量明细金额超出允许范围');
    total += result;
    return { ...line, amount: Number(result) };
  });
  if (total < 1n || total > BigInt(MAX_AMOUNT)) fail(400, '计量总额须大于 0 分且不超过允许范围');
  return { lines: calculated, amount: Number(total) };
}

const sum = rows => rows.reduce((total, row) => total + row.data.amount, 0);
const signed = row => row.data.changeType === 'decrease' ? -row.data.amount : row.data.amount;

export function createEngineeringCommerce({ getItems, getItem, voided = () => false, pendingCorrection = () => false, effectivePurchaseAmount = row => row.data.amount, effectiveSettlementAmount = row => row.data.amount }) {
  function contractSummary(pid, contractId, replacement, snapshot) {
    const contract = getItem(pid, contractId, 'contracts');
    // At approval, replace the current draft/submitted row in the calculation without changing persisted originals.
    // Match the contract before the per-row voided lookup; the summed rows are unchanged.
    const related = (snapshot || getItems(pid)).filter(row => row.id !== replacement?.id && row.data.contractId === contractId && !voided(row.id));
    if (replacement && replacement.data.contractId === contractId) related.push({ ...replacement, state: 'approved' });
    const changes = related.filter(row => row.kind === 'variations' && row.state === 'approved');
    const settlements = related.filter(row => row.kind === 'settlements' && row.state === 'approved');
    const originalAmount = contract.data.amount;
    const changeAmount = changes.reduce((total, row) => total + signed(row), 0);
    const effectiveAmount = originalAmount + changeAmount;
    const purchaseAmount = related.filter(row => row.kind === 'purchases' && ['approved', 'closed'].includes(row.state)).reduce((value,row)=>value+effectivePurchaseAmount(row),0);
    const measurementAmount = sum(related.filter(row => row.kind === 'measurements' && row.state === 'approved'));
    const unmeasuredSettlementAmount = settlements.filter(row => !row.data.measurementId).reduce((value,row)=>value+effectiveSettlementAmount(row),0);
    const settlementAmount = settlements.reduce((value,row)=>value+effectiveSettlementAmount(row),0);
    const committedAmount = Math.max(purchaseAmount, settlementAmount, measurementAmount + unmeasuredSettlementAmount);
    return {
      originalAmount, changeAmount, effectiveAmount, purchaseAmount, measurementAmount,
      unmeasuredSettlementAmount, settlementAmount, committedAmount,
      remainingMeasurementAmount: effectiveAmount - measurementAmount - unmeasuredSettlementAmount,
      remainingSettlementAmount: effectiveAmount - settlementAmount,
    };
  }
  function measurementSummary(pid, measurementId, replacement, snapshot) {
    const measurement = getItem(pid, measurementId, 'measurements');
    if (voided(measurementId)) return { measuredAmount: 0, settledAmount: 0, remainingSettlementAmount: 0, originalMeasuredAmount: measurement.data.amount };
    const settlements = (snapshot || getItems(pid)).filter(row => row.id !== replacement?.id && row.kind === 'settlements' && row.state === 'approved' && row.data.measurementId === measurementId && !voided(row.id));
    if (replacement?.kind === 'settlements' && replacement.data.measurementId === measurementId) settlements.push({...replacement,state:'approved'});
    const settledAmount = settlements.reduce((value,row)=>value+effectiveSettlementAmount(row),0);
    return { measuredAmount: measurement.data.amount, settledAmount, remainingSettlementAmount: measurement.data.amount - settledAmount };
  }
  function validate(pid, kind, data, { skipMeasurementCalculation = false } = {}) {
    if (kind === 'variations' || kind === 'measurements') {
      if (getItem(pid, data.contractId, 'contracts').state !== 'approved') fail(409, '变更签证和工程量计量须关联已批准且未关闭的合同');
    }
    if (kind === 'measurements') {
      if (data.periodStart > data.periodEnd) fail(400, '计量结束日期不能早于开始日期');
      if (!skipMeasurementCalculation) Object.assign(data, calculateMeasurement(data.lines));
    }
    if (kind === 'settlements' && data.measurementId) {
      const measurement = getItem(pid, data.measurementId, 'measurements');
      if (measurement.state !== 'approved' || voided(measurement.id) || measurement.data.contractId !== data.contractId) fail(409, '结算须关联同一合同下已批准且未撤销的计量单');
    }
  }
  function approve(pid, row) {
    if (voided(row.id)) fail(409, '原单业务影响已撤销，不能再次批准');
    if (!['variations', 'measurements', 'settlements', 'purchases'].includes(row.kind) || !row.data.contractId) return;
    const summary = contractSummary(pid, row.data.contractId, row);
    if (summary.effectiveAmount < 0 || summary.effectiveAmount > MAX_AMOUNT) fail(409, '变更后的有效合同额须在 0 至允许上限之间');
    if (row.kind === 'variations' && summary.committedAmount > summary.effectiveAmount) fail(409, '调减后的合同额低于已批准采购、结算或计量承诺，请先核对合同履约情况');
    if (row.kind === 'purchases' && summary.purchaseAmount > summary.effectiveAmount) fail(409, '累计采购金额超过有效合同额');
    if (row.kind === 'measurements' && summary.measurementAmount + summary.unmeasuredSettlementAmount > summary.effectiveAmount) fail(409, '累计计量与未关联计量结算超过有效合同额');
    if (row.kind === 'settlements') {
      if (summary.settlementAmount > summary.effectiveAmount) fail(409, '累计结算超过有效合同额');
      if (row.data.measurementId) {
        if (measurementSummary(pid, row.data.measurementId, row).remainingSettlementAmount < 0) fail(409, '本计量单累计分期结算超过已批准计量金额');
      } else if (summary.measurementAmount + summary.unmeasuredSettlementAmount > summary.effectiveAmount) fail(409, '未关联计量结算与已批准计量合计超过有效合同额');
    }
  }
  function close(pid, contractId) {
    if (pendingCorrection(pid, contractId)) fail(409, '合同仍有待审经营纠错，暂不能结清关闭');
    const unfinished = getItems(pid).some(row => ['variations', 'measurements'].includes(row.kind) && row.data.contractId === contractId && !voided(row.id) && !['approved', 'cancelled'].includes(row.state));
    if (unfinished) fail(409, '合同仍有待处理变更签证或计量单，暂不能结清关闭');
    return contractSummary(pid, contractId);
  }
  function view(pid, row, snapshot) {
    if (row.kind === 'contracts') return { ...row, commercial: contractSummary(pid, row.id, undefined, snapshot) };
    if (row.kind === 'measurements') return { ...row, commercial: measurementSummary(pid, row.id, undefined, snapshot) };
    return row;
  }
  return { validate, approve, close, view, contractSummary, measurementSummary };
}
