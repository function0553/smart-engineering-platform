import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { fail, createRecord } from './service.mjs';
import { pointSchema, fenceTypes, inside, crossed, withinSchedule } from './security-config.mjs';

const imageInput = { mime: z.enum(['image/jpeg', 'image/png']), base64: z.string().min(1).max(2800000) };
const occurredAt = z.string().datetime({ offset: true });
const objectId = z.string().trim().min(1).max(120);
export function storeImage(store, data, purpose, deviceId = '') {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data.base64)) fail(400, '图片编码不正确');
  const bytes = Buffer.from(data.base64, 'base64');
  if (bytes.length > 2 * 1024 * 1024) fail(413, '图片不能超过 2 MB');
  const png = bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR';
  const jpeg = bytes.length >= 12 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
  if ((data.mime === 'image/png' && !png) || (data.mime === 'image/jpeg' && !jpeg)) fail(400, '只支持真实 PNG 或 JPEG 图片');
  if (png && (!bytes.readUInt32BE(16) || !bytes.readUInt32BE(20) || bytes.readUInt32BE(16) > 8192 || bytes.readUInt32BE(20) > 8192)) fail(400, '图片尺寸不受支持');
  const id = randomUUID();
  store.db.prepare('INSERT INTO security_images VALUES(?,?,?,?,?,?)').run(id, data.mime, bytes, purpose, deviceId, new Date().toISOString());
  return id;
}
export function addNotification(store, alertId) {
  store.db.prepare('INSERT INTO alarm_notifications(alert_id,created_at) VALUES(?,?)').run(alertId, new Date().toISOString());
}
function autoAlarm(store, actor, rule, event, evidence) {
  const portrait = evidence.portraitId && store.get(evidence.portraitId);
  const category = rule.type === 'watches' ? 'portrait_watch' : rule.data.eventType;
  const label = rule.type === 'watches' ? `人像布控命中：${portrait.data.name}` : fenceTypes[category];
  let record = createRecord(store, actor, 'alerts', {
    name: `${rule.data.name} · ${label}`.slice(0, 120), category, priority: rule.data.priority,
    deviceId: rule.data.deviceId, spaceId: rule.data.spaceId,
    occurredAt: event.occurredAt, description: `${label}；每次识别单独报警。请核对抓拍证据。`,
  }, `integration:${actor.id}`);
  const snapshotKeys = ['name', 'deviceId', 'confidence', 'kind', 'eventType', 'points', 'referenceImageId', 'modelId', 'portraitIds', 'startAt', 'endAt', 'dailyStart', 'dailyEnd'];
  const ruleSnapshot = Object.fromEntries(snapshotKeys.filter(key => rule.data[key] !== undefined).map(key => [key, rule.data[key]]));
  record.data = { ...record.data, automatic: true, ruleId: rule.id, ruleName: rule.data.name, ruleVersion: rule.version, ruleSnapshot, eventId: event.eventId, objectId: event.objectId, confidence: evidence.confidence, ...evidence };
  record = store.save(record);
  addNotification(store, record.id);
  return record.id;
}
function freshness(at, now) {
  if (Date.parse(at) > now + 10000) fail(400, '识别时间超过服务器时间，请校准设备时钟');
  return now - Date.parse(at) <= 60000;
}
function eligible(rule, integration, deviceId, at) {
  return rule.state === 'armed' && rule.data.integrationId === integration.id && rule.data.deviceId === deviceId && withinSchedule(rule.data, at);
}
export function receiveCapture(store, integration, envelope, now = Date.now()) {
  const data = z.object({ occurredAt, objectId, modelId: z.string().trim().min(1).max(160), ...imageInput,
    appliedRules: z.array(z.object({ ruleId: z.string().uuid(), version: z.number().int().positive() }).strict()).max(100),
    matches: z.array(z.object({ portraitId: z.string().uuid(), portraitVersion: z.number().int().positive(), similarity: z.number().min(0).max(1) }).strict()).max(20).default([]),
  }).strict().parse(envelope.data);
  if (store.get(envelope.deviceId)?.data.kind !== 'camera') fail(400, '人像抓拍必须来自摄像头');
  if (new Set(data.matches.map(m => m.portraitId)).size !== data.matches.length || new Set(data.appliedRules.map(r => r.ruleId)).size !== data.appliedRules.length) fail(400, '识别候选或规则不能重复');
  const timely = freshness(data.occurredAt, now);
  const imageId = storeImage(store, data, 'capture', envelope.deviceId);
  const { base64, mime, ...metadata } = data;
  let capture = store.insert('captures', 'recorded', { ...metadata, name: '人像抓拍', deviceId: envelope.deviceId, imageId, eventId: envelope.eventId, source: `integration:${integration.id}`, integrationName: integration.name, alarmIds: [], decisions: [] });
  const alarmIds = [], decisions = [];
  for (const rule of store.list('watches').filter(r => r.data.deviceId === envelope.deviceId && r.data.integrationId === integration.id)) {
    let reason = '';
    if (!eligible(rule, integration, envelope.deviceId, data.occurredAt)) reason = '未布防或不在布控时段';
    else if (!timely) reason = '延迟超过 60 秒，仅归档';
    else if (rule.data.modelId !== data.modelId) reason = '模型版本不符';
    else if (!data.appliedRules.some(r => r.ruleId === rule.id && r.version === rule.version)) reason = '识别服务尚未应用当前规则版本';
    const match = data.matches.filter(m => rule.data.portraitIds.includes(m.portraitId) && store.get(m.portraitId)?.state === 'active' && store.get(m.portraitId)?.version === m.portraitVersion && m.similarity >= rule.data.confidence).sort((a, b) => b.similarity - a.similarity)[0];
    if (!reason && !match) reason = '无满足阈值和名单版本的候选';
    if (!reason) alarmIds.push(autoAlarm(store, { id: integration.id, name: integration.name }, rule, { ...data, eventId: envelope.eventId }, { captureId: capture.id, imageId, portraitId: match.portraitId, portraitImageId: store.get(match.portraitId).data.imageId, modelId: data.modelId, confidence: match.similarity }));
    decisions.push({ ruleId: rule.id, ruleName: rule.data.name, result: reason || '已生成独立告警' });
  }
  capture.data.alarmIds = alarmIds; capture.data.decisions = decisions; capture = store.save(capture);
  store.audit({ id: integration.id, name: integration.name }, 'capture', 'captures', capture.id, `接收人像抓拍；生成 ${alarmIds.length} 条告警`);
  return { id: capture.id, alarmIds };
}
export function receiveDetection(store, integration, envelope, now = Date.now()) {
  const data = z.object({ occurredAt, objectId, ruleId: z.string().uuid(), ruleVersion: z.number().int().positive(), eventType: z.enum(Object.keys(fenceTypes)), point: pointSchema, confidence: z.number().min(0).max(1), image: z.object(imageInput).strict().optional() }).strict().parse(envelope.data);
  const rule = store.get(data.ruleId);
  if (!rule || rule.type !== 'fences' || rule.data.deviceId !== envelope.deviceId || rule.data.integrationId !== integration.id) fail(403, '围栏规则不属于该服务或摄像头');
  const timely = freshness(data.occurredAt, now);
  const previous = data.eventType === 'line_crossing' ? store.db.prepare('SELECT * FROM security_tracks WHERE rule_id=? AND integration_id=? AND object_id=?').get(rule.id, integration.id, data.objectId) : undefined;
  let reason = '';
  if (!eligible(rule, integration, envelope.deviceId, data.occurredAt)) reason = '未布防或不在布控时段';
  else if (!timely) reason = '延迟超过 60 秒，仅归档';
  else if (data.ruleVersion !== rule.version) reason = '规则版本不符';
  else if (data.eventType !== rule.data.eventType) reason = '识别类型不符';
  else if (data.confidence < rule.data.confidence) reason = '未达到置信度阈值';
  else if (previous && Date.parse(data.occurredAt) <= Date.parse(previous.at)) reason = '轨迹时间未递增，仅归档';
  if (!reason) {
    if (data.eventType === 'line_crossing') {
      if (!previous || previous.rule_version !== rule.version || Date.parse(data.occurredAt) - Date.parse(previous.at) > 10000) reason = '等待同一目标的连续轨迹';
      else if (!crossed(JSON.parse(previous.point), data.point, ...rule.data.points)) reason = '未穿越有限边界线';
    } else if (!inside(data.point, rule.data.points)) reason = '目标不在配置区域内';
    if (data.eventType === 'line_crossing') store.db.prepare('INSERT INTO security_tracks VALUES(?,?,?,?,?,?) ON CONFLICT(rule_id,integration_id,object_id) DO UPDATE SET rule_version=excluded.rule_version,at=excluded.at,point=excluded.point').run(rule.id, rule.version, integration.id, data.objectId, data.occurredAt, JSON.stringify(data.point));
  }
  const imageId = data.image ? storeImage(store, data.image, 'evidence', envelope.deviceId) : '';
  const { image, ...metadata } = data;
  let detection = store.insert('detections', 'recorded', { ...metadata, name: fenceTypes[data.eventType], deviceId: envelope.deviceId, imageId, eventId: envelope.eventId, source: `integration:${integration.id}`, integrationName: integration.name, reason: reason || '已生成独立告警', alarmIds: [] });
  const alarmIds = reason ? [] : [autoAlarm(store, { id: integration.id, name: integration.name }, rule, { ...data, eventId: envelope.eventId }, { detectionId: detection.id, imageId, confidence: data.confidence })];
  detection.data.alarmIds = alarmIds; detection = store.save(detection);
  store.audit({ id: integration.id, name: integration.name }, 'detect', 'detections', detection.id, `${rule.data.name}：${detection.data.reason}`);
  return { id: detection.id, alarmIds, decision: detection.data.reason };
}

export function mountSecurityRoutes(app, { store, auth, admin, integrationAuth }) {
  const sendImage = (res, row) => { if (!row) fail(404, '图片不存在'); res.set({ 'Content-Type': row.mime, 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' }).send(Buffer.from(row.bytes)); };
  app.post('/api/security/images', auth, admin, (req, res) => {
    const data = z.object({ ...imageInput, purpose: z.enum(['portrait', 'reference']), deviceId: z.string().max(80).default('') }).strict().parse(req.body);
    if (data.purpose === 'reference' && store.get(data.deviceId)?.data.kind !== 'camera') fail(400, '参考画面必须指定摄像头');
    const id = store.transaction(() => { const id = storeImage(store, data, data.purpose, data.deviceId); store.audit(req.actor, 'upload', 'security_images', id, '上传布控参考图片'); return id; });
    res.status(201).json({ id });
  });
  app.get('/api/security/images/:id', auth, (req, res) => sendImage(res, store.db.prepare('SELECT * FROM security_images WHERE id=?').get(req.params.id)));
  app.get('/api/security/notifications', auth, (req, res) => {
    const after = req.query.after === undefined ? undefined : z.coerce.number().int().min(0).safe().parse(req.query.after);
    const rows = after === undefined ? store.db.prepare('SELECT * FROM alarm_notifications ORDER BY seq DESC LIMIT 20').all().reverse() : store.db.prepare('SELECT * FROM alarm_notifications WHERE seq>? ORDER BY seq LIMIT 100').all(after);
    res.json({ cursor: rows.at(-1)?.seq ?? after ?? 0, items: rows.map(row => ({ ...row, alert: store.get(row.alert_id) })).filter(row => row.alert?.state === 'new') });
  });
  const scopedRules = integration => [...store.list('watches'), ...store.list('fences')].filter(r => r.state === 'armed' && r.data.integrationId === integration.id && JSON.parse(integration.device_ids).includes(r.data.deviceId));
  app.get('/api/ingest/config', (req, res) => {
    const integration = integrationAuth(req); if (integration.kind !== 'ai') fail(403, '仅识别服务可读取布控规则');
    const rules = scopedRules(integration);
    const ids = new Set(rules.filter(r => r.type === 'watches').flatMap(r => r.data.portraitIds));
    res.json({ alarmMode: 'every', timeZone: 'Asia/Shanghai', coordinates: 'normalized_camera_frame', rules, portraits: store.list('portraits').filter(p => ids.has(p.id) && p.state === 'active').map(p => ({ id: p.id, version: p.version, code: p.data.code, imagePath: `/api/ingest/reference/${p.data.imageId}` })) });
  });
  app.get('/api/ingest/reference/:id', (req, res) => {
    const integration = integrationAuth(req); if (integration.kind !== 'ai') fail(403, '仅识别服务可读取名单参考图');
    const allowed = scopedRules(integration).some(r => r.type === 'watches' && r.data.portraitIds.some(id => { const p = store.get(id); return p?.state === 'active' && p.data.imageId === req.params.id; }));
    if (!allowed) fail(403, '参考图片不在已授权布控范围');
    sendImage(res, store.db.prepare('SELECT * FROM security_images WHERE id=?').get(req.params.id));
  });
}
