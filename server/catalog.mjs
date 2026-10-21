import { z } from 'zod';
import { securitySchemas } from './security-config.mjs';

const text = (max = 200) => z.string().trim().max(max);
const required = (max = 120) => text(max).min(1, '请填写必填项');
const ref = text(80).default('');
const time = z.string().datetime({ offset: true });
const priority = z.enum(['critical', 'high', 'medium', 'low']).default('medium');
const names = { spaces: '场所空间', employees: '组织人员', devices: '设备台账', visits: '访客预约', bookings: '会议预约', alerts: '告警事件', workorders: '运维工单', rules: '算法规则', access: '通行记录', attendance: '考勤记录', energy: '能耗读数', announcements: '信息发布' };
const schemas = {
  ...securitySchemas,
  spaces: z.object({ name: required(), code: required(40), kind: z.enum(['site', 'building', 'floor', 'office', 'meeting_room', 'server_room', 'parking', 'outdoor']), parentId: ref, capacity: z.number().int().min(0).max(100000).default(0), description: text(2000).default('') }),
  employees: z.object({ name: required(60), code: required(40), department: required(80), position: text(80).default(''), phone: text(32).default(''), email: z.union([z.literal(''), z.string().email()]).default('') }),
  devices: z.object({ name: required(), code: required(80), kind: z.enum(['camera', 'access', 'gate', 'meeting', 'display', 'meter', 'intercom', 'lift', 'network', 'server']), brand: text(80).default(''), model: text(120).default(''), protocol: z.enum(['GB28181', 'ISAPI', 'ONVIF', 'RTSP', 'GA/T1400', 'MQTT', 'HTTP', 'SDK', '待确认']), address: text(240).default(''), spaceId: ref, serial: text(120).default(''), description: text(2000).default('') }),
  visits: z.object({ name: required(60), company: text(120).default(''), phone: text(32).default(''), hostId: required(80), spaceId: ref, purpose: required(500), startAt: time, endAt: time, count: z.number().int().min(1).max(500).default(1) }),
  bookings: z.object({ name: required(), hostId: required(80), spaceId: required(80), startAt: time, endAt: time, attendees: z.number().int().min(1).max(500).default(1), description: text(2000).default('') }),
  alerts: z.object({ name: required(), category: required(80), priority, deviceId: ref, spaceId: ref, assigneeId: ref, description: required(2000), occurredAt: time }),
  workorders: z.object({ name: required(), priority, deviceId: ref, alertId: ref, assigneeId: ref, description: required(2000), dueAt: z.union([z.literal(''), time]).default('') }),
  rules: z.object({ name: required(), algorithm: required(80), deviceId: required(80), zone: required(240), confidence: z.number().min(0.01).max(1).default(0.7), dwellSeconds: z.number().int().min(0).max(86400).default(10), roi: text(2000).default('[[0,0],[1,0],[1,1],[0,1]]'), minimumCount: z.number().int().min(1).max(10000).default(3), diagnosticThreshold: z.number().min(0).max(10000).default(0), description: text(2000).default('') }),
  access: z.object({ name: required(120), personId: required(80), deviceId: required(80), direction: z.enum(['enter', 'exit', 'denied']), occurredAt: time, description: required(1000) }),
  attendance: z.object({ personId: required(80), direction: z.enum(['in', 'out']), occurredAt: time, description: required(1000) }),
  energy: z.object({ deviceId: required(80), value: z.number().min(0).max(1e12), unit: z.enum(['kWh', 'm³']), occurredAt: time, description: text(1000).default('') }),
  announcements: z.object({ name: required(), spaceId: ref, content: required(5000), startAt: time, endAt: time }),
};
export const resources = Object.fromEntries(Object.entries(schemas).map(([key, schema]) => [key, {
  name: names[key] || ({ portraits: '布控名单', watches: '人像布控', fences: '围栏与围挡', captures: '人像抓拍', detections: '围栏识别记录' })[key], schema: schema.strict(),
  initial: ({ visits: 'requested', bookings: 'reserved', alerts: 'new', workorders: 'open', rules: 'draft', devices: 'unverified', announcements: 'draft', watches: 'draft', fences: 'draft' })[key] || 'active',
  adminOnly: ['spaces', 'employees', 'devices', 'rules', 'portraits', 'watches', 'fences'].includes(key),
}]));
export const transitions = {
  rules: { draft: ['active'], active: ['inactive'], inactive: ['active'] },
  portraits: { active: ['inactive'], inactive: ['active'] },
  watches: { draft: ['armed'], armed: ['disarmed'], disarmed: ['armed'] },
  fences: { draft: ['armed'], armed: ['disarmed'], disarmed: ['armed'] },
  visits: { requested: ['approved', 'cancelled'], approved: ['checked_in', 'cancelled'], checked_in: ['checked_out'] },
  bookings: { reserved: ['cancelled'] },
  alerts: { new: ['processing', 'dismissed'], processing: ['resolved', 'dismissed'] },
  workorders: { open: ['in_progress', 'cancelled'], in_progress: ['completed', 'cancelled'] },
  employees: { active: ['inactive'], inactive: ['active'] },
};
export const algorithms = [
  ['face_capture', '人脸抓拍与比对', '人员分析'], ['people_count', '人员去重统计', '人员分析'],
  ['presence', '在岗与离岗检测', '人员分析'], ['crowd', '人员聚集预警', '人员分析'],
  ['intrusion', '越界与区域闯入', '人员分析'], ['loitering', '徘徊与超时滞留', '人员分析'],
  ['trajectory', '访客轨迹', '人员分析'], ['sleeping', '睡岗检测', '行为分析'],
  ['smoking', '抽烟检测', '行为分析'], ['phone', '玩手机检测', '行为分析'],
  ['running', '奔跑追逐', '行为分析'], ['climbing', '违规攀爬', '行为分析'],
  ['traffic', '客流与热区分析', '场景分析'], ['left_object', '物品遗留与丢失', '场景分析'],
  ['garbage', '垃圾堆放', '场景分析'], ['fire_lane', '消防通道占用', '场景分析'],
  ['occlusion', '画面遮挡', '视频诊断'], ['blur', '画面模糊', '视频诊断'], ['night', '夜视异常', '视频诊断'],
].map(([id, name, group]) => ({ id, name, group, status: 'pending_integration' }));

export const references = { parentId: 'spaces', spaceId: 'spaces', hostId: 'employees', personId: 'employees', assigneeId: 'employees', deviceId: 'devices', alertId: 'alerts' };
