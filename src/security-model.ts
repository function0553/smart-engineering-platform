import type { Module } from './model';
export const fenceNames: Record<string, string> = { intrusion: '进入区域', line_crossing: '越界穿越', climbing: '翻越围挡', barrier_moved: '围挡移动', barrier_removed: '围挡拆除', barrier_damaged: '围挡破损' };
const named = { key: 'name', label: '名称' };
const device = { key: 'deviceId', label: '摄像头', ref: 'devices' };
const common = [named, device, { key: 'spaceId', label: '所属场所', ref: 'spaces' }, { key: 'confidence', label: '分值阈值' }, { key: 'dailyStart', label: '每日开始（北京）' }, { key: 'dailyEnd', label: '每日结束（北京）' }, { key: 'startAt', label: '生效时间' }, { key: 'endAt', label: '失效时间' }, { key: 'description', label: '说明' }];
export const securityModules: Record<string, Module> = {
  portraits: { name: '布控名单', singular: '名单对象', description: '登记参考人像，维护名单分组与启停状态。', adminOnly: true, fields: [named, { key: 'code', label: '名单编号' }, { key: 'group', label: '名单分组' }, { key: 'description', label: '说明' }], columns: ['name', 'code', 'group'], empty: '添加明确的名单对象与参考人像后，创建人像布控任务。', create: '添加名单对象' },
  watches: { name: '人像布控', singular: '人像布控任务', description: '按名单、摄像头、识别模型和时段进行布控，每次命中单独报警。', adminOnly: true, fields: [...common, { key: 'modelId', label: '识别模型版本' }], columns: ['name', 'deviceId', 'confidence'], empty: '先准备名单与识别服务，再创建布控任务。', create: '新建人像布控' },
  fences: { name: '围栏与围挡', singular: '围栏布控', description: '在摄像头画面上配置区域或边界，检测进入、翻越及围挡异常。', adminOnly: true, fields: [...common, { key: 'kind', label: '布控类别', options: [['electronic', '电子围栏'], ['barrier', '围挡布控']] }, { key: 'eventType', label: '检测事件', options: Object.entries(fenceNames) }], columns: ['name', 'deviceId', 'eventType'], empty: '选择摄像头并绘制区域，配置所需检测事件。', create: '新建围栏布控' },
  captures: { name: '人像抓拍', singular: '人像抓拍', description: '查看识别服务上传的原始抓拍、候选分值与布控命中记录。', fields: [device, { key: 'occurredAt', label: '抓拍时间' }, { key: 'objectId', label: '目标编号' }, { key: 'modelId', label: '模型版本' }, { key: 'integrationName', label: '识别服务' }], columns: ['deviceId', 'occurredAt', 'modelId'], empty: '等待识别服务上传人像抓拍。' },
  detections: { name: '围栏识别记录', singular: '识别记录', description: '保留围栏识别输入与报警判定结果。', fields: [named, device, { key: 'ruleId', label: '布控规则' }, { key: 'occurredAt', label: '识别时间' }, { key: 'confidence', label: '识别分值' }, { key: 'reason', label: '判定结果' }], columns: ['name', 'deviceId', 'occurredAt', 'reason'], empty: '等待区域识别与围挡识别结果上报。' },
};
