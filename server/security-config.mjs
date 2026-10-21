import { z } from 'zod';
import { localFenceEvents, FACE_MODEL_ID } from './vision-catalog.mjs';

const text = (max = 120) => z.string().trim().min(1).max(max);
const optional = (max = 120) => z.string().trim().max(max).default('');
export const pointSchema = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]);
const common = {
  name: text(), deviceId: text(80), integrationId: optional(80), spaceId: optional(80),
  confidence: z.number().min(0).max(1).default(0.8),
  priority: z.enum(['critical', 'high', 'medium', 'low']).default('high'),
  alarmMode: z.literal('every').default('every'), description: optional(2000),
  startAt: z.union([z.literal(''), z.string().datetime({ offset: true })]).default(''),
  endAt: z.union([z.literal(''), z.string().datetime({ offset: true })]).default(''),
  dailyStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('00:00'),
  dailyEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('00:00'),
};
export const fenceTypes = { intrusion: '进入区域', line_crossing: '越界穿越', climbing: '翻越围挡', barrier_moved: '围挡移动', barrier_removed: '围挡拆除', barrier_damaged: '围挡破损' };
export const securitySchemas = {
  portraits: z.object({ name: text(60), code: text(80), group: text(80), imageId: text(80), description: optional(2000) }),
  watches: z.object({ ...common, portraitIds: z.array(z.string().uuid()).min(1).max(500), modelId: optional(160) }),
  fences: z.object({ ...common, kind: z.enum(['electronic', 'barrier']), eventType: z.enum(Object.keys(fenceTypes)), points: z.array(pointSchema).max(32).default([]), referenceImageId: optional(80) }),
  captures: z.object({}), detections: z.object({}),
};
export class SecurityConfigError extends Error {}
const fail = (message) => { throw new SecurityConfigError(message); };
const orientation = (a, b, p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
const between = (x, a, b) => x >= Math.min(a, b) - 1e-9 && x <= Math.max(a, b) + 1e-9;
const onSegment = (p, a, b) => Math.abs(orientation(a, b, p)) < 1e-9 && between(p[0], a[0], b[0]) && between(p[1], a[1], b[1]);
export function intersects(a, b, c, d) {
  const x = orientation(a, b, c), y = orientation(a, b, d), u = orientation(c, d, a), v = orientation(c, d, b);
  return (x * y < 0 && u * v < 0) || onSegment(c, a, b) || onSegment(d, a, b) || onSegment(a, c, d) || onSegment(b, c, d);
}
export function crossed(a, b, c, d) { return orientation(c, d, a) * orientation(c, d, b) < 0 && intersects(a, b, c, d); }
export function inside(point, polygon) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if (onSegment(point, a, b)) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}
export function validateGeometry(points, line) {
  if (line && points.length !== 2) fail('越界线需要两个端点');
  if (!line && points.length < 3) fail('区域至少需要三个点');
  if (new Set(points.map(p => p.join(','))).size !== points.length) fail('区域点位不能重复');
  if (line) return;
  const area = points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0);
  if (Math.abs(area) < 0.00001) fail('区域面积过小或点位共线');
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
    if (intersects(points[i], points[(i + 1) % points.length], points[j], points[(j + 1) % points.length])) fail('区域边界不能交叉');
  }
}
export function withinSchedule(data, at) {
  const time = Date.parse(at);
  if ((data.startAt && time < Date.parse(data.startAt)) || (data.endAt && time >= Date.parse(data.endAt))) return false;
  const local = new Date(time + 8 * 3600000).toISOString().slice(11, 16);
  if (data.dailyStart === data.dailyEnd) return true;
  return data.dailyStart < data.dailyEnd ? local >= data.dailyStart && local < data.dailyEnd : local >= data.dailyStart || local < data.dailyEnd;
}
export function validateSecurityConfig(store, type, data, armed = false) {
  if (type === 'portraits') {
    if (store.db.prepare('SELECT purpose FROM security_images WHERE id=?').get(data.imageId)?.purpose !== 'portrait') fail('请上传名单参考人像');
    return;
  }
  if (!['fences', 'watches'].includes(type)) return;
  if (store.get(data.deviceId)?.data.kind !== 'camera') fail('布控必须绑定摄像头');
  if (data.startAt && data.endAt && Date.parse(data.startAt) >= Date.parse(data.endAt)) fail('结束时间必须晚于开始时间');
  if (data.integrationId) {
    const integration = store.db.prepare('SELECT * FROM integrations WHERE id=? AND revoked=0').get(data.integrationId);
    if (!integration || integration.kind !== 'ai' || !JSON.parse(integration.device_ids).includes(data.deviceId)) fail('识别服务未授权该摄像头或已撤销');
  } else if (armed) fail('启用前请选择已授权的识别服务');
  if (type === 'watches') {
    if (armed && store.setting(`vision-integration:${data.deviceId}`) === data.integrationId && data.modelId !== FACE_MODEL_ID) fail('本机视觉服务须使用当前 SFace 模型版本');
    if (new Set(data.portraitIds).size !== data.portraitIds.length) fail('名单不能重复');
    for (const id of data.portraitIds) if (store.get(id)?.type !== 'portraits' || store.get(id).state !== 'active') fail('名单对象不存在或已停用');
    if (armed && !data.modelId) fail('启用前填写识别模型版本，防止不同模型分值混用');
  }
  if (type === 'fences') {
    if (armed && store.setting(`vision-integration:${data.deviceId}`) === data.integrationId && !localFenceEvents.includes(data.eventType)) fail('本机引擎当前支持区域进入与越界；翻越、围挡移动/拆除/破损仍需专用模型');
    if (data.kind === 'electronic' && !['intrusion', 'line_crossing'].includes(data.eventType)) fail('电子围栏请选择区域进入或越界穿越');
    if (data.points.length || armed) validateGeometry(data.points, data.eventType === 'line_crossing');
    if (data.referenceImageId) {
      const image = store.db.prepare('SELECT * FROM security_images WHERE id=?').get(data.referenceImageId);
      if (!image || image.purpose === 'portrait' || (image.device_id && image.device_id !== data.deviceId)) fail('参考画面不存在或属于其他摄像头');
    }
  }
}
