import { resources, references, algorithms, transitions } from './catalog.mjs';
import { validateSecurityConfig, validateGeometry, pointSchema } from './security-config.mjs';
import { visionCapabilities } from './vision-catalog.mjs';
import { modelStatus } from './vision-models.mjs';

export class BusinessError extends Error { constructor(status, message) { super(message); this.status = status; } }
export const fail = (status, message) => { throw new BusinessError(status, message); };

export function validateRecord(store, type, data, current) {
  validateSecurityConfig(store, type, data);
  for (const [key, expected] of Object.entries(references)) {
    if (!data[key]) continue;
    const target = store.get(data[key]);
    if (!target || target.type !== expected) fail(400, `${key} 关联记录不存在`);
    if (expected === 'employees' && target.state !== 'active') fail(409, '不能选择已停用人员');
  }
  if (data.startAt && data.endAt && Date.parse(data.startAt) >= Date.parse(data.endAt)) fail(400, '结束时间必须晚于开始时间');
  if (type === 'spaces' && current) {
    let ancestor = data.parentId;
    const visited = new Set([current.id]);
    while (ancestor) {
      if (visited.has(ancestor)) fail(409, '场所不能形成循环层级');
      visited.add(ancestor); ancestor = store.get(ancestor)?.data.parentId;
    }
  }
  if (type === 'bookings') {
    const room = store.get(data.spaceId);
    if (room?.data.kind !== 'meeting_room') fail(400, '请选择会议室');
    if (room.data.capacity && data.attendees > room.data.capacity) fail(409, `会议室最多容纳 ${room.data.capacity} 人`);
    if ((!current || current.state === 'reserved') && store.list('bookings').some(r => r.id !== current?.id && r.state === 'reserved' && r.data.spaceId === data.spaceId && Date.parse(r.data.startAt) < Date.parse(data.endAt) && Date.parse(r.data.endAt) > Date.parse(data.startAt))) fail(409, '该会议室在此时段已被预约，请调整时间');
  }
  if (type === 'rules') {
    if (store.get(data.deviceId)?.data.kind !== 'camera') fail(400, '算法规则必须绑定摄像头');
    if (!algorithms.some(a => a.id === data.algorithm)) fail(400, '未知算法类型');
    let points; try { points = JSON.parse(data.roi); } catch { fail(400, '检测区域需填写 JSON 坐标数组'); }
    if (!Array.isArray(points) || points.length > 32 || points.some(p => !pointSchema.safeParse(p).success)) fail(400, '检测区域坐标必须在 0 至 1 之间');
    validateGeometry(points, false);
  }
  if (type === 'energy' && store.get(data.deviceId)?.data.kind !== 'meter') fail(400, '能耗读数必须绑定计量设备');
  if (type === 'access' && !['access', 'gate', 'lift'].includes(store.get(data.deviceId)?.data.kind)) fail(400, '通行记录必须关联门禁、道闸或梯控');
  if (type === 'workorders' && data.alertId && store.list('workorders').some(r => r.id !== current?.id && r.data.alertId === data.alertId && !['completed', 'cancelled'].includes(r.state))) fail(409, '该告警已有未完成工单');
  if (['access', 'attendance', 'energy'].includes(type) && Date.parse(data.occurredAt) > Date.now() + 60000) fail(400, '记录时间不能晚于当前时间');
}

export function createRecord(store, actor, type, input, source = 'manual') {
  const config = resources[type]; if (!config) fail(404, '不存在的模块');
  if (['captures', 'detections'].includes(type)) fail(405, '识别记录只能通过已授权的接入服务提交');
  const data = config.schema.parse(input);
  validateRecord(store, type, data);
  if (['alerts', 'access', 'attendance', 'energy'].includes(type)) data.source = source;
  const record = store.insert(type, config.initial, data);
  store.audit(actor, 'create', type, record.id, `新增${config.name}：${data.name || data.description || record.id}`);
  return record;
}

export function updateRecord(store, actor, type, id, version, input) {
  const record = store.get(id);
  if (!record || record.type !== type) fail(404, '记录不存在');
  if (record.version !== version) fail(409, '记录已被修改，请刷新后再操作');
  if (['captures', 'detections'].includes(type) || (type === 'alerts' && record.data.automatic)) fail(409, '识别证据及自动告警不可改写，请通过处置操作记录结论');
  if ((['watches', 'fences'].includes(type) && record.state === 'armed') || (type === 'rules' && record.state === 'active')) fail(409, '请先停用或撤防，再修改规则');
  if (type === 'portraits' && store.list('watches').some(r => r.state === 'armed' && r.data.portraitIds.includes(id))) fail(409, '该名单对象正在布控，请先撤防再修改');
  if (['access', 'attendance', 'energy'].includes(type)) fail(409, '原始记录不可覆盖，请追加更正记录');
  if (type === 'visits' && !['requested', 'approved'].includes(record.state)) fail(409, '已到访或已结束的访客记录不可修改');
  if (type === 'bookings' && record.state !== 'reserved') fail(409, '已取消的预约不可修改');
  const data = resources[type].schema.parse(input);
  validateRecord(store, type, data, record);
  if (record.data.source) data.source = record.data.source;
  // Telemetry is written only through scoped ingestion, never through a user edit.
  for (const key of ['reportedStatus', 'lastSeen', 'reportSource', 'history']) if (record.data[key] !== undefined) data[key] = record.data[key];
  record.data = data;
  const updated = store.save(record);
  store.audit(actor, 'update', type, id, `修改${resources[type].name}：${data.name || id}`);
  return updated;
}

export function changeState(store, actor, type, id, version, state, note) {
  const record = store.get(id);
  if (!record || record.type !== type) fail(404, '记录不存在');
  if (record.version !== version) fail(409, '记录已变更，请刷新后操作');
  if (!transitions[type]?.[record.state]?.includes(state)) fail(409, '不支持此状态变更');
  if (['watches', 'fences'].includes(type) && state === 'armed') validateSecurityConfig(store, type, record.data, true);
  if (type === 'rules' && state === 'active') {
    if (!visionCapabilities[record.data.algorithm]) fail(409, '该项目尚无已验证的本机模型，不能启用');
    if (modelStatus().algorithms.find(a => a.id === record.data.algorithm)?.status !== 'installed') fail(409, '该算法的模型或运行环境未就绪，请先准备视觉环境');
    const integrationId = store.setting(`vision-integration:${record.data.deviceId}`);
    if (!store.setting(`vision-source:${record.data.deviceId}`) || !store.db.prepare('SELECT 1 FROM integrations WHERE id=? AND revoked=0').get(integrationId || '')) fail(409, '请先在视频监控中配置有效的本机视频分析源');
  }
  if (['resolved', 'dismissed', 'completed', 'cancelled'].includes(state) && !note?.trim()) fail(400, '请填写处理说明');
  const from = record.state; record.state = state;
  record.data.history = [...(record.data.history || []), { from, state, note: (note || '').slice(0, 2000), actor: actor.name, at: new Date().toISOString() }];
  const updated = store.save(record);
  store.audit(actor, 'transition', type, id, `${record.data.name || id}：${from} → ${state}${note ? `；${note}` : ''}`);
  return updated;
}

export function deleteRecord(store, actor, type, id, version) {
  const record = store.get(id);
  if (!record || record.type !== type) fail(404, '记录不存在');
  if (record.version !== version) fail(409, '记录已变更，请刷新');
  if (!['spaces', 'employees', 'devices', 'rules', 'announcements', 'portraits', 'watches', 'fences'].includes(type)) fail(409, '业务历史不可删除，请使用取消或处置操作');
  if (record.state === 'armed') fail(409, '请先撤防');
  if (type === 'devices' && store.setting(`vision-source:${id}`)) fail(409, '请先在视频监控中移除视频源配置');
  if (store.db.prepare('SELECT 1 FROM anchors WHERE target_id=?').get(id)) fail(409, '记录仍绑定在三维模型上，请先解除点位绑定');
  const all = store.db.prepare('SELECT id,data FROM records WHERE id<>?').all(id);
  if (all.some(r => { const data = JSON.parse(r.data); return Object.entries(data).some(([key, value]) => (references[key] || ['ruleId', 'captureId', 'detectionId', 'portraitId'].includes(key)) && value === id) || data.portraitIds?.includes(id) || data.matches?.some(m => m.portraitId === id); })) fail(409, '此记录已被业务使用，不能删除');
  if (type === 'devices' && store.db.prepare('SELECT device_ids FROM integrations WHERE revoked=0').all().some(row => JSON.parse(row.device_ids).includes(id))) fail(409, '设备仍被接入凭据授权，请先撤销对应凭据');
  store.db.prepare('DELETE FROM records WHERE id=?').run(id);
  store.audit(actor, 'delete', type, id, `删除${resources[type].name}：${record.data.name || id}`);
}

export function deviceStatus(record) {
  if (!record.data.lastSeen) return 'unverified';
  if (Date.now() - Date.parse(record.data.lastSeen) > 300000) return 'stale';
  return record.data.reportedStatus === 'online' ? 'online' : 'offline';
}

export function attendanceSummary(store, date) {
  const rows = store.list('attendance').filter(r => new Date(Date.parse(r.data.occurredAt) + 8 * 3600000).toISOString().slice(0, 10) === date);
  return store.list('employees').filter(r => r.state === 'active').map(person => {
    const events = rows.filter(r => r.data.personId === person.id).sort((a, b) => Date.parse(a.data.occurredAt) - Date.parse(b.data.occurredAt));
    const firstIn = events.find(r => r.data.direction === 'in')?.data.occurredAt || null;
    const lastOut = events.filter(r => r.data.direction === 'out').at(-1)?.data.occurredAt || null;
    return { id: person.id, name: person.data.name, department: person.data.department, date, firstIn, lastOut, count: events.length, state: !events.length ? 'no_record' : firstIn && lastOut && lastOut >= firstIn ? 'paired' : 'incomplete', source: [...new Set(events.map(r => r.data.source))] };
  });
}
