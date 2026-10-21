export type Row = { id: string; type: string; state: string; version: number; data: Record<string, any>; created_at: string; updated_at: string };
export type User = { id: string; username: string; name: string; role: 'admin' | 'operator' | 'viewer'; active?: number };
export type Algorithm = { id: string; name: string; group: string; status: string; implementation?: string; limitation?: string };
export type Workspace = { user: User; organization: string; records: Record<string, Row[]>; algorithms: Algorithm[]; version: string };
export type Field = { key: string; label: string; kind?: 'text' | 'textarea' | 'select' | 'number' | 'datetime-local' | 'email'; required?: boolean; options?: string[][]; ref?: string; hint?: string; min?: number; max?: number; step?: number; default?: any };
export type Module = { name: string; singular: string; description: string; fields: Field[]; columns: string[]; adminOnly?: boolean; empty: string; create?: string };
const field = (key: string, label: string, extra: Partial<Field> = {}): Field => ({ key, label, ...extra });
const name = field('name', '名称', { required: true });
const code = field('code', '编号', { required: true });
const description = field('description', '说明', { kind: 'textarea' });
const space = field('spaceId', '所属场所', { ref: 'spaces' });
const device = field('deviceId', '关联设备', { ref: 'devices' });
const assignee = field('assigneeId', '负责人', { ref: 'employees' });
const start = field('startAt', '开始时间', { kind: 'datetime-local', required: true });
const end = field('endAt', '结束时间', { kind: 'datetime-local', required: true });
const occurred = field('occurredAt', '记录时间', { kind: 'datetime-local', required: true });
const host = field('hostId', '接待人 / 召集人', { ref: 'employees', required: true });
const priorities = [['critical', '紧急'], ['high', '高'], ['medium', '中'], ['low', '低']];
const priority = field('priority', '优先级', { kind: 'select', options: priorities, default: 'medium' });
export const deviceKinds = [['camera', '摄像头'], ['access', '门禁'], ['gate', '道闸'], ['meeting', '会议设备'], ['display', '信息屏'], ['meter', '计量设备'], ['intercom', '对讲'], ['lift', '梯控'], ['network', '网络设备'], ['server', '服务器']];
export const spaceKinds = [['site', '园区 / 项目'], ['building', '楼宇'], ['floor', '楼层'], ['office', '办公区'], ['meeting_room', '会议室'], ['server_room', '机房'], ['parking', '停车场'], ['outdoor', '室外区域']];
import { securityModules } from './security-model';
export const modules: Record<string, Module> = {
  ...securityModules,
  spaces: { name: '场所空间', singular: '场所', description: '从园区到房间，建立设备和业务共用的空间目录。', fields: [name, code, field('kind', '空间类型', { kind: 'select', options: spaceKinds, default: 'office' }), field('parentId', '上级场所', { ref: 'spaces' }), field('capacity', '容纳人数', { kind: 'number', min: 0, default: 0 }), description], columns: ['name', 'code', 'kind', 'parentId', 'capacity'], adminOnly: true, empty: '添加第一个场所，为设备登记、访客和会议提供位置。' },
  employees: { name: '组织人员', singular: '人员', description: '统一维护人员档案、部门与业务负责人。', fields: [field('name', '姓名', { required: true }), code, field('department', '部门', { required: true }), field('position', '岗位'), field('phone', '联系电话'), field('email', '邮箱', { kind: 'email' })], columns: ['name', 'code', 'department', 'position', 'phone'], adminOnly: true, empty: '添加人员后，可用于接待访客、召集会议和分配工单。' },
  devices: { name: '设备中心', singular: '设备', description: '设备台账、场所归属与接入状态统一管理。', fields: [name, code, field('kind', '设备类型', { kind: 'select', options: deviceKinds, default: 'camera' }), field('brand', '品牌'), field('model', '型号'), field('protocol', '接入方式', { kind: 'select', options: ['待确认', 'GB28181', 'ISAPI', 'ONVIF', 'RTSP', 'GA/T1400', 'MQTT', 'HTTP', 'SDK'].map(x => [x, x]), default: '待确认' }), field('address', '设备地址', { hint: '填写设备 IP 或主机名；请勿包含账号密码。' }), space, field('serial', '序列号'), description], columns: ['name', 'kind', 'brand', 'spaceId', 'protocol', 'lastSeen'], adminOnly: true, empty: '先登记设备，再通过接入中心建立真实状态和事件连接。' },
  visits: { name: '访客管理', singular: '访客预约', description: '预约、审批、到访与离场，每次来访都有记录。', fields: [field('name', '访客姓名', { required: true }), field('company', '来访单位'), field('phone', '联系电话'), host, space, field('purpose', '来访事由', { kind: 'textarea', required: true }), start, end, field('count', '来访人数', { kind: 'number', min: 1, default: 1 })], columns: ['name', 'company', 'hostId', 'startAt', 'endAt'], empty: '创建来访预约，审批后登记到访与离场。' },
  bookings: { name: '会议管理', singular: '会议', description: '会议室资源与时间安排集中管理，预约时自动检查冲突。', fields: [field('name', '会议主题', { required: true }), host, { ...space, label: '会议室', required: true, ref: 'rooms' }, start, end, field('attendees', '参会人数', { kind: 'number', min: 1, default: 1 }), description], columns: ['name', 'spaceId', 'hostId', 'startAt', 'endAt'], empty: '先创建会议室和人员，即可发起真实的会议预约。', create: '预约会议' },
  alerts: { name: '告警中心', singular: '事件', description: '集中接收异常事件，记录确认、处理与关闭过程。', fields: [field('name', '事件标题', { required: true }), field('category', '事件类型', { required: true, default: '现场异常' }), priority, device, space, assignee, { ...description, required: true }, occurred], columns: ['name', 'category', 'priority', 'deviceId', 'occurredAt'], empty: '接入事件服务后，告警将在这里汇集；也可登记现场发现的问题。', create: '登记现场事件' },
  workorders: { name: '运维工单', singular: '工单', description: '将问题落实到负责人，保留处理过程和完成说明。', fields: [field('name', '工单标题', { required: true }), priority, device, field('alertId', '关联告警', { ref: 'alerts' }), assignee, { ...description, required: true }, field('dueAt', '计划完成时间', { kind: 'datetime-local' })], columns: ['name', 'priority', 'deviceId', 'assigneeId', 'dueAt'], empty: '创建维护任务，或从告警事件生成关联工单。' },
  rules: { name: 'AI分析', singular: '分析规则', description: '按监控点位配置场景需求，绑定真实算法服务后联调上线。', fields: [field('name', '规则名称', { required: true }), field('algorithm', '场景算法', { ref: 'algorithms', required: true }), { ...device, label: '摄像头', ref: 'cameras', required: true }, field('zone', '检测区域说明', { required: true, hint: '描述检测区域，下方可直接在摄像头画面上绘制范围。' }), field('confidence', '置信度阈值', { kind: 'number', min: 0.01, max: 1, step: 0.01, default: 0.7 }), field('dwellSeconds', '持续时长（秒）', { kind: 'number', min: 0, default: 10 }), field('roi', '检测区域坐标', { kind: 'textarea', default: '[[0,0],[1,0],[1,1],[0,1]]', hint: '0–1 归一化多边形，默认全画面；图像诊断使用整幅画面。' }), field('minimumCount', '聚集人数阈值', { kind: 'number', min: 1, default: 3 }), field('diagnosticThreshold', '图像诊断阈值', { kind: 'number', min: 0, default: 0, hint: '0 使用默认值：锐度 40、对比度 8、亮度 30。需现场标定。' }), description], columns: ['name', 'algorithm', 'deviceId', 'zone', 'confidence'], adminOnly: true, empty: '从场景需求建立规则草稿，等待对应模型与摄像头联调。', create: '配置规则' },
  access: { name: '通行记录', singular: '通行记录', description: '汇集门禁、道闸与梯控通行事件，人工补录单独标记。', fields: [field('name', '记录名称', { required: true }), field('personId', '人员', { ref: 'employees', required: true }), { ...device, ref: 'doors', required: true }, field('direction', '通行结果', { kind: 'select', options: [['enter', '进入'], ['exit', '离开'], ['denied', '拒绝通行']], default: 'enter' }), occurred, { ...description, label: '补录原因', required: true }], columns: ['personId', 'deviceId', 'direction', 'occurredAt', 'source'], empty: '等待通行设备事件，或按实际情况补录历史记录。', create: '人工补录' },
  attendance: { name: '考勤记录', singular: '考勤记录', description: '保留打卡原始记录与每日配对汇总，人工补录可追溯。', fields: [field('personId', '人员', { ref: 'employees', required: true }), field('direction', '打卡类型', { kind: 'select', options: [['in', '上班打卡'], ['out', '下班打卡']], default: 'in' }), occurred, { ...description, label: '补录原因', required: true }], columns: ['personId', 'direction', 'occurredAt', 'source', 'description'], empty: '接入打卡数据后查看原始记录，也可登记有说明的人工补录。', create: '人工补录' },
  energy: { name: '能耗管理', singular: '表计读数', description: '按计量设备保存累计读数，追踪用能记录及数据来源。', fields: [{ ...device, label: '计量设备', ref: 'meters', required: true }, field('value', '累计读数', { kind: 'number', min: 0, step: 0.001, required: true }), field('unit', '计量单位', { kind: 'select', options: [['kWh', '电量 · kWh'], ['m³', '水量 / 气量 · m³']], default: 'kWh' }), occurred, description], columns: ['deviceId', 'value', 'unit', 'occurredAt', 'source'], empty: '登记表计后，可人工抄表或通过采集服务上传读数。', create: '登记读数' },
  announcements: { name: '信息发布', singular: '发布内容', description: '集中准备公告内容与播放计划，终端接入后再执行下发。', fields: [field('name', '内容标题', { required: true }), space, field('content', '公告正文', { kind: 'textarea', required: true }), start, end], columns: ['name', 'spaceId', 'startAt', 'endAt'], empty: '创建公告草稿与播放计划，等待信息屏适配。', create: '新建内容' },
};
export const stateNames: Record<string, string> = { armed: '已布防', disarmed: '已撤防', recorded: '已归档', active: '启用', inactive: '停用', requested: '待审批', approved: '待到访', checked_in: '在访', checked_out: '已离场', cancelled: '已取消', reserved: '已预约', new: '待确认', processing: '处理中', resolved: '已解决', dismissed: '已忽略', open: '待处理', in_progress: '处理中', completed: '已完成', draft: '草稿', unverified: '待接入', online: '已上报在线', offline: '已上报离线', stale: '心跳过期', critical: '紧急', high: '高', medium: '中', low: '低', no_record: '无记录', paired: '已配对', incomplete: '待核对' };
export const stateActions: Record<string, Record<string, string[][]>> = {
  rules: { draft: [['active', '启用分析规则']], active: [['inactive', '停用规则']], inactive: [['active', '重新启用']] },
  portraits: { active: [['inactive', '停用名单对象']], inactive: [['active', '启用名单对象']] },
  watches: { draft: [['armed', '启用布控']], armed: [['disarmed', '撤防']], disarmed: [['armed', '重新布防']] },
  fences: { draft: [['armed', '启用布控']], armed: [['disarmed', '撤防']], disarmed: [['armed', '重新布防']] },
  visits: { requested: [['approved', '审批通过'], ['cancelled', '取消预约']], approved: [['checked_in', '登记到访'], ['cancelled', '取消预约']], checked_in: [['checked_out', '登记离场']] },
  bookings: { reserved: [['cancelled', '取消会议']] },
  alerts: { new: [['processing', '确认并处理'], ['dismissed', '忽略事件']], processing: [['resolved', '标记解决'], ['dismissed', '忽略事件']] },
  workorders: { open: [['in_progress', '开始处理'], ['cancelled', '取消工单']], in_progress: [['completed', '完成工单'], ['cancelled', '取消工单']] },
  employees: { active: [['inactive', '停用人员']], inactive: [['active', '启用人员']] },
};
export const roleNames = { admin: '管理员', operator: '业务操作员', viewer: '只读成员' };
export const localDate = (time = Date.now()) => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
export const prettyTime = (value: string | null, short = false) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', ...(short ? {} : { year: 'numeric' as const }) }) : '—';
export const localInput = (value?: string) => { const d = value ? new Date(value) : new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
export async function api<T = any>(path: string, method = 'GET', data?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { method, signal, headers: { 'Content-Type': 'application/json', 'X-Workspace-Request': '1' }, credentials: 'same-origin', ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const body = await response.json().catch(() => ({ error: '服务返回内容异常' }));
  if (!response.ok) { const error = new Error(body.error || '请求失败') as Error & { status: number }; error.status = response.status; throw error; }
  return body;
}
