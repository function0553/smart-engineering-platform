import { z } from 'zod';
import { fail } from './service.mjs';

const uuid = z.string().uuid();
const MAX_AMOUNT = 1_000_000_000_000;
const MAX_QUANTITY = 1_000_000_000;
const invalid = () => fail(422, '任务计量产值的来源、关联、数量或金额不一致，请核对台账');
const integer = (value, maximum = MAX_AMOUNT, minimum = 0) => {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid();
  return value;
};
const add = (a, b) => {
  const result = a + b;
  if (!Number.isSafeInteger(result)) fail(422, '任务计量产值汇总超过安全整数范围，不能生成不准确结果');
  return result;
};
const readTask = (pid, taskId, getItem) => {
  const task = getItem(pid, taskId, 'tasks');
  if (task.state === 'cancelled') fail(409, '计量不能关联已取消的施工任务，请重新选择任务');
  return task;
};

// Only an explicit draft save refreshes descriptive snapshots. Submission and
// approval check the current reference but never rewrite the saved task name.
export function freezeMeasurementTasks(pid, data, getItem) {
  for (const line of data.lines) {
    if (line.taskId) {
      const task = readTask(pid, line.taskId, getItem);
      line.taskTitle = task.data.title;
      line.taskLocation = task.data.location;
    } else {
      delete line.taskId; delete line.taskTitle; delete line.taskLocation;
    }
  }
}

export function checkMeasurementTasks(pid, data, getItem) {
  for (const line of data.lines) if (line.taskId) readTask(pid, line.taskId, getItem);
}

export function checkTaskCancellation(pid, taskId, getItems, voided) {
  const dependent = getItems(pid).find(row => row.kind === 'measurements'
    && (['draft', 'submitted'].includes(row.state) || row.state === 'approved' && !voided(row.id))
    && row.data.lines.some(line => line.taskId === taskId));
  if (dependent) fail(409, '任务仍有关联的待办或有效已批准计量，请先由经营人员作废待办计量或完成原单纠错');
}

/** Pure materialization of a single project's existing, authorization-filtered
 * item snapshot. It does not change task progress or infer planned production. */
export function buildEngineeringTaskValues(items, { projectId, observedAt = new Date().toISOString() } = {}) {
  if (!projectId || !Array.isArray(items)) invalid();
  const byId = new Map();
  for (const item of items) {
    if (!item?.id || item.project_id !== projectId || byId.has(item.id) || !item.data || typeof item.data !== 'object' || Array.isArray(item.data)) invalid();
    byId.set(item.id, item);
  }
  const taskMap = new Map(items.filter(row => row.kind === 'tasks').map(row => [row.id, {
    taskId: row.id, title: row.data.title, location: row.data.location, state: row.state,
    progress: row.data.progress, startDate: row.data.startDate, dueDate: row.data.dueDate,
    incomeAmount: 0, expenseAmount: 0, sourceCount: 0, effectiveSourceCount: 0,
    quantityGroups: [],
  }]));
  const summary = { income: { assignedAmount: 0, unassignedAmount: 0, totalAmount: 0 }, expense: { assignedAmount: 0, unassignedAmount: 0, totalAmount: 0 } };
  const sources = [], groups = new Map();
  for (const measurement of items.filter(row => row.kind === 'measurements')) {
    const data = measurement.data, contract = byId.get(data.contractId);
    if (!contract || contract.kind !== 'contracts' || !['income', 'expense'].includes(contract.data.direction)
      || !Array.isArray(data.lines) || data.lines.length < 1 || data.lines.length > 50
      || !['draft', 'submitted', 'approved', 'cancelled'].includes(measurement.state)) invalid();
    if (measurement.voided !== undefined && typeof measurement.voided !== 'boolean') invalid();
    integer(data.amount);
    const effective = measurement.state === 'approved' && !measurement.voided;
    let lineTotal = 0n;
    for (const [index, line] of data.lines.entries()) {
      integer(line.quantity, MAX_QUANTITY, 1); integer(line.unitPrice, MAX_AMOUNT, 1); integer(line.amount);
      if (['name', 'location', 'unit'].some(field => typeof line[field] !== 'string' || !line[field].trim())) invalid();
      if (['taskId', 'boqItemId', 'boqRevisionId'].some(field => line[field] !== undefined && typeof line[field] !== 'string')) invalid();
      const taskId = line.taskId || '', task = taskId ? taskMap.get(taskId) : null;
      if (taskId && (!uuid.safeParse(taskId).success || !task
        || typeof line.taskTitle !== 'string' || !line.taskTitle.trim()
        || typeof line.taskLocation !== 'string' || !line.taskLocation.trim())) invalid();
      if (!taskId && (line.taskTitle || line.taskLocation)) invalid();
      if (!!line.boqItemId !== !!line.boqRevisionId
        || line.boqItemId && (!uuid.safeParse(line.boqItemId).success || !uuid.safeParse(line.boqRevisionId).success)) invalid();
      lineTotal += BigInt(line.amount);
      const source = {
        measurementId: measurement.id, measurementTitle: data.title, measurementCode: data.code,
        state: measurement.state, voided: !!measurement.voided, lineIndex: index + 1,
        contractId: contract.id, contractTitle: contract.data.title, direction: contract.data.direction,
        taskId, taskTitle: taskId ? line.taskTitle : '', taskLocation: taskId ? line.taskLocation : '',
        name: line.name, location: line.location, unit: line.unit, quantity: line.quantity,
        unitPrice: line.unitPrice, amount: line.amount,
        effectiveQuantity: effective ? line.quantity : 0, effectiveAmount: effective ? line.amount : 0,
        boqItemId: line.boqItemId || '', boqRevisionId: line.boqRevisionId || '',
        periodStart: data.periodStart, periodEnd: data.periodEnd, note: line.note || '',
      };
      sources.push(source);
      if (task) task.sourceCount = add(task.sourceCount, 1);
      if (!effective) continue;
      const direction = summary[source.direction], amountField = source.direction + 'Amount';
      direction.totalAmount = add(direction.totalAmount, source.amount);
      const assigned = task ? 'assignedAmount' : 'unassignedAmount';
      direction[assigned] = add(direction[assigned], source.amount);
      if (task) { task[amountField] = add(task[amountField], source.amount); task.effectiveSourceCount = add(task.effectiveSourceCount, 1); }
      const key = JSON.stringify([taskId, source.direction, source.contractId, source.boqItemId,
        source.boqItemId ? '' : source.name, source.boqItemId ? '' : source.location, source.unit]);
      const group = groups.get(key) || { taskId, direction: source.direction, contractId: source.contractId, contractTitle: source.contractTitle,
        boqItemId: source.boqItemId, name: source.name, location: source.location, unit: source.unit,
        quantity: 0, amount: 0, sourceCount: 0 };
      group.quantity = add(group.quantity, source.quantity); group.amount = add(group.amount, source.amount); group.sourceCount = add(group.sourceCount, 1);
      groups.set(key, group);
    }
    if (lineTotal !== BigInt(data.amount)) invalid();
  }
  const unassignedQuantityGroups = [];
  for (const { taskId, ...group } of groups.values()) {
    if (taskId) taskMap.get(taskId).quantityGroups.push(group);
    else unassignedQuantityGroups.push(group);
  }
  return { projectId, observedAt, summary, tasks: [...taskMap.values()], sources,
    unassigned: sources.filter(source => !source.taskId), unassignedQuantityGroups };
}
