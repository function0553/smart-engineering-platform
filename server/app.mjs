import { fileURLToPath } from 'node:url';
import express from 'express';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { openStore } from './store.mjs';
import { resources } from './catalog.mjs';
import { BusinessError, fail, createRecord, updateRecord, changeState, deleteRecord, deviceStatus, attendanceSummary } from './service.mjs';
import { mountModelRoutes } from './models.mjs';
import { receiveCapture, receiveDetection, addNotification, mountSecurityRoutes } from './security.mjs';
import { SecurityConfigError } from './security-config.mjs';
import { mountVisionRoutes, modelStatus } from './vision.mjs';
import { mountDailyReportRoutes } from './daily-report.mjs';
import { mountDailyReportSubmissionRoutes } from './daily-report-submissions.mjs';
import { mountPhotoArchiveRoutes } from './photo-archives.mjs';
import { mountAppUpdateRoutes } from './app-update.mjs';
import { mountPpeRoutes } from './ppe.mjs';
import { mountCameraAttendance } from './camera4g-attendance.mjs';
import { mountEngineeringRoutes } from './engineering.mjs';
import { mountEngineeringAttachmentRoutes } from './engineering-attachments.mjs';
import { mountEngineeringSiteRecordRoutes,siteRecordsPending } from './engineering-site-records.mjs';
import {siteTemplates} from './site-record-access.mjs';
import { createWeatherService, mountReportWeather } from './daily-report-weather.mjs';

const platformVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const digest = value => createHash('sha256').update(value).digest('hex');
const passwordHash = password => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; };
const passwordMatches = (password, hash) => { const [salt, expected] = hash.split(':'); return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(expected, 'hex')); };
const username = z.string().trim().regex(/^[a-zA-Z0-9_.-]{3,40}$/, '账号为 3–40 位字母、数字、点、下划线或横线');
const password = z.string().min(6, '密码至少 6 位').max(128);
const displayName = z.string().trim().min(1).max(60);
const emptyHash = passwordHash(randomBytes(32).toString('hex'));

export function createApp({ database = resolve('.data/workspace.sqlite'), baseUrl = 'http://127.0.0.1:5186', development = false, distPath = resolve('dist'), filesDir = resolve('.data/models'), updateDir = resolve('server/mobile-updates'), weatherService = createWeatherService(), ppeOptions = {}, attendanceOptions = {} } = {}) {
  const store = openStore(database);
  const app = express();
  const origin = new URL(baseUrl);
  const allowedOrigins = new Set([origin.origin, ...(development ? ['http://127.0.0.1:5187', 'http://localhost:5187'] : [])]);
  const allowedHosts = new Set([origin.host, ...(development ? ['127.0.0.1:5187', 'localhost:5187'] : [])]);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (!allowedHosts.has(req.headers.host)) return res.status(403).json({ error: '访问地址未配置' });
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'" });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(['/api/security/images', '/api/ingest/captures', '/api/ingest/detections'], express.json({ limit: '4mb' }));
  app.use(['/api/daily-report/export', '/api/mobile/daily-report/export', '/api/daily-report/submissions', '/api/mobile/daily-report/submissions'], express.json({ limit: '30mb' }));
  app.use(['/api/photo-archives', '/api/mobile/photo-archives'], express.json({ limit: '8mb' }));
  app.post(/^\/api\/(?:mobile\/)?engineering\/projects\/[^/]+\/site-records\/[^/]+\/uploads\/[^/]+\/chunks$/, express.json({ limit: '2mb' }));
  app.use(/^\/api\/(?:mobile\/)?engineering\/projects\/[^/]+\/items\/[^/]+\/attachments$/, express.json({ limit: '12mb' }));
  // Fifty fully populated measurement lines can exceed 256 KiB when JSON uses Unicode escapes.
  app.post(/^\/api\/(?:mobile\/)?engineering\/projects\/[0-9a-fA-F-]{36}\/items\/(?:tasks|issues|contracts|variations|measurements|purchases|materials|settlements|costs|crews)$/, express.json({ limit: '512kb' }));
  app.put(/^\/api\/(?:mobile\/)?engineering\/projects\/[0-9a-fA-F-]{36}\/items\/[0-9a-fA-F-]{36}$/, express.json({ limit: '512kb' }));
  app.post(/^\/api\/(?:mobile\/)?engineering\/projects\/[0-9a-fA-F-]{36}\/boq$/, express.json({ limit: '1mb' }));
  app.put(/^\/api\/(?:mobile\/)?engineering\/projects\/[0-9a-fA-F-]{36}\/boq\/[0-9a-fA-F-]{36}$/, express.json({ limit: '1mb' }));
  app.post(/^\/api\/(?:mobile\/)?engineering\/projects\/[0-9a-fA-F-]{36}\/value-plans$/, express.json({ limit: '512kb' }));
  app.put(/^\/api\/(?:mobile\/)?engineering\/projects\/[0-9a-fA-F-]{36}\/value-plans\/[0-9a-fA-F-]{36}$/, express.json({ limit: '512kb' }));
  app.use('/api/camera4g-attendance/people/enroll', express.json({ limit: '8mb' }));
  app.use(express.json({ limit: '128kb' }));
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.path.startsWith('/ingest/')) {
      if (req.headers['x-workspace-request'] !== '1') return res.status(403).json({ error: '缺少请求校验标记' });
      const miniOrigin = req.path.startsWith('/mobile/') && req.headers.origin === 'https://servicewechat.com';
      if (req.headers.origin && !allowedOrigins.has(req.headers.origin) && !miniOrigin) return res.status(403).json({ error: '请求来源不允许' });
      const modelUpload = req.path === '/models' && req.method === 'POST' && req.is('model/gltf-binary');
      if (!modelUpload && !req.is('application/json')) return res.status(415).json({ error: '请使用 JSON 请求' });
    }
    next();
  });
  const issueSession = (user, mobile=false) => {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + 12 * 3600000;
    store.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(Date.now());
    store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run((mobile?'mobile:':'')+digest(token), user.id, expiresAt);
    return { token, expiresAt };
  };
  const safeUser = user => ({ id: user.id, username: user.username, name: user.name, role: user.role });
  const setSession = (res, user) => {
    const { token } = issueSession(user);
    res.cookie('workspace_session', token, { httpOnly: true, secure: origin.protocol === 'https:', sameSite: 'strict', path: '/', maxAge: 12 * 3600000 });
    return safeUser(user);
  };
  const sessionHash = req => { const token = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('workspace_session='))?.slice('workspace_session='.length); return token ? digest(token) : ''; };
  const auth = (req, res, next) => {
    const user = store.db.prepare('SELECT u.id,u.username,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires_at>? AND u.active=1').get(sessionHash(req), Date.now());
    if (!user) return res.status(401).json({ error: '请先登录' });
    req.actor = user; next();
  };
  const mobileHash = req => {
    const value = req.headers.authorization || '';
    return /^Bearer [A-Za-z0-9_-]{43}$/.test(value) ? 'mobile:'+digest(value.slice(7)) : '';
  };
  const mobileAuth = (req, res, next) => {
    const user = store.db.prepare('SELECT u.id,u.username,u.name,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires_at>? AND u.active=1').get(mobileHash(req), Date.now());
    if (!user) return res.status(401).json({ error: '登录已失效，请重新登录' });
    req.actor = user; next();
  };
  const admin = (req, res, next) => req.actor.role === 'admin' ? next() : res.status(403).json({ error: '此操作需要管理员权限' });
  const writer = (req, res, next) => req.actor.role !== 'viewer' ? next() : res.status(403).json({ error: '只读账号不能修改数据' });
  const moduleAuth = req => { if (!resources[req.params.type]) fail(404, '模块不存在'); if (resources[req.params.type].adminOnly && req.actor.role !== 'admin') fail(403, '此模块需要管理员权限'); };
  app.get('/api/status', (req, res) => res.json({ product: 'smart-office-platform', name: store.setting('organization') || '智慧工程', setupRequired: !store.db.prepare('SELECT 1 FROM users LIMIT 1').get(), version: platformVersion, database: 'ready' }));
  app.post('/api/setup', (req, res) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) fail(403, '首次初始化仅允许在服务器本机操作');
    const data = z.object({ organization: z.string().trim().min(1).max(100), username, name: displayName, password }).strict().parse(req.body);
    const hash = passwordHash(data.password);
    const user = store.transaction(() => {
      if (store.db.prepare('SELECT 1 FROM users LIMIT 1').get()) fail(409, '平台已初始化，请登录');
      const user = { id: randomUUID(), username: data.username, name: data.name, role: 'admin' };
      store.db.prepare('INSERT INTO users(id,username,name,role,hash,created_at) VALUES(?,?,?,?,?,?)').run(user.id, user.username, user.name, user.role, hash, new Date().toISOString());
      store.setting('organization', data.organization);
      store.audit(user, 'setup', 'system', user.id, '完成平台初始化');
      return user;
    });
    res.status(201).json({ user: setSession(res, user) });
  });
  const attempts = new Map();
  const authenticate = req => {
    const data = z.object({ username, password: z.string().min(1).max(128) }).strict().parse(req.body);
    const now = Date.now();
    for (const [key, entry] of attempts) if (entry.until < now) attempts.delete(key);
    const key = req.socket.remoteAddress; const entry = attempts.get(key) || { count: 0, until: now + 10 * 60000 };
    if (entry.count >= 10) fail(429, '登录尝试过于频繁，请 10 分钟后重试');
    const user = store.db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(data.username);
    if (!passwordMatches(data.password, user?.hash || emptyHash) || !user?.active) { entry.count++; attempts.set(key, entry); fail(401, '账号或密码不正确'); }
    attempts.delete(key); store.audit(user, 'login', 'system', user.id, req.path.includes('/mobile/') ? '登录移动端' : '登录平台');
    return user;
  };
  app.post('/api/login', (req, res) => { res.json({ user: setSession(res, authenticate(req)) }); });
  app.post('/api/mobile/login', (req, res) => { const user = authenticate(req); res.json({ ...issueSession(user,true), user:safeUser(user) }); });
  app.get('/api/mobile/me', mobileAuth, (req,res) => res.json(req.actor));
  app.post('/api/mobile/logout', mobileAuth, (req,res) => { store.db.prepare('DELETE FROM sessions WHERE hash=?').run(mobileHash(req)); res.json({ok:true}); });
  app.post('/api/logout', auth, (req, res) => { store.db.prepare('DELETE FROM sessions WHERE hash=?').run(sessionHash(req)); res.clearCookie('workspace_session', { path: '/', secure: origin.protocol === 'https:', sameSite: 'strict', httpOnly: true }); res.json({ ok: true }); });
  app.get('/api/me', auth, (req, res) => res.json(req.actor));
  app.get('/api/bootstrap', auth, (req, res) => {
    const data = Object.fromEntries(Object.keys(resources).map(type => [type, store.list(type).map(r => type === 'devices' ? { ...r, state: deviceStatus(r) } : r)]));
    res.json({ user: req.actor, organization: store.setting('organization'), records: data, algorithms: modelStatus().algorithms, version: platformVersion });
  });
  app.get('/api/attendance-summary', auth, (req, res) => { const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(req.query.date); res.json(attendanceSummary(store, date)); });
  app.get('/api/audit', auth, admin, (req, res) => res.json(store.db.prepare('SELECT * FROM audit ORDER BY at DESC,id DESC LIMIT 200').all()));
  app.post('/api/records/:type', auth, writer, (req, res) => { moduleAuth(req); const result = store.transaction(() => createRecord(store, req.actor, req.params.type, req.body)); res.status(201).json(result); });
  app.patch('/api/records/:type/:id', auth, writer, (req, res) => {
    moduleAuth(req); const body = z.object({ version: z.number().int().positive(), data: z.record(z.string(), z.unknown()) }).strict().parse(req.body);
    res.json(store.transaction(() => updateRecord(store, req.actor, req.params.type, req.params.id, body.version, body.data)));
  });
  app.post('/api/records/:type/:id/transition', auth, writer, (req, res) => {
    moduleAuth(req); const body = z.object({ version: z.number().int().positive(), state: z.string().max(40), note: z.string().max(2000).default('') }).strict().parse(req.body);
    res.json(store.transaction(() => changeState(store, req.actor, req.params.type, req.params.id, body.version, body.state, body.note)));
  });
  app.delete('/api/records/:type/:id', auth, admin, (req, res) => { moduleAuth(req); const version = z.number().int().positive().parse(req.body.version); store.transaction(() => deleteRecord(store, req.actor, req.params.type, req.params.id, version)); res.json({ ok: true }); });
  app.get('/api/users', auth, admin, (req, res) => {
    // Group once by user (keeps project order) instead of scanning every assignment for each user.
    const assignments=new Map();
    for(const m of store.db.prepare(`SELECT m.user_id,m.role AS projectRole,p.id AS projectId,p.data,p.state AS projectState,g.data AS grantData,c.enabled
      FROM engineering_members m JOIN engineering_projects p ON p.id=m.project_id
      LEFT JOIN engineering_site_access_grants g ON g.project_id=m.project_id AND g.user_id=m.user_id
      LEFT JOIN engineering_site_access_config c ON c.project_id=m.project_id ORDER BY p.created_at,p.id`).all()){const list=assignments.get(m.user_id);if(list)list.push(m);else assignments.set(m.user_id,[m]);}
    res.set('Cache-Control','private, no-store').json(store.db.prepare('SELECT id,username,name,role,active,created_at FROM users ORDER BY created_at').all().map(u=>({...u,projectAssignments:(assignments.get(u.id)||[]).map(m=>{
      const permission=siteRecordService.accountPermission({id:u.id,role:u.role},m.projectId);
      return {projectId:m.projectId,projectName:JSON.parse(m.data).name,projectRole:permission.projectRole,configuredProjectRole:m.projectRole,projectState:m.projectState,siteRole:siteTemplates[permission.template]?.name||'自定义岗位',reviewEnabled:permission.enabled,expired:!!permission.expired,customized:!!m.grantData};
    })})));
  });
  app.post('/api/users', auth, admin, (req, res) => {
    const data = z.object({ username, name: displayName, password, role: z.enum(['admin', 'operator', 'viewer']) }).strict().parse(req.body);
    const id = randomUUID(); const hash = passwordHash(data.password);
    store.transaction(() => { store.db.prepare('INSERT INTO users(id,username,name,role,hash,created_at) VALUES(?,?,?,?,?,?)').run(id, data.username, data.name, data.role, hash, new Date().toISOString()); store.audit(req.actor, 'create', 'users', id, `创建账号：${data.username}`); });
    res.status(201).json({ id });
  });
  app.patch('/api/users/:id', auth, admin, (req, res) => {
    const data = z.object({ active: z.boolean(), role: z.enum(['admin', 'operator', 'viewer']) }).strict().parse(req.body);
    store.transaction(() => {
      const target = store.db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id); if (!target) fail(404, '账号不存在');
      if (target.id === req.actor.id && (!data.active || data.role !== 'admin')) fail(409, '不能停用或降级当前管理员账号');
      store.db.prepare('UPDATE users SET active=?,role=? WHERE id=?').run(Number(data.active), data.role, target.id);
      store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
      store.audit(req.actor, 'update', 'users', target.id, `修改账号角色或状态：${target.username}`);
    }); res.json({ ok: true });
  });
  app.post('/api/users/:id/password', auth, admin, (req,res) => {
    const uid=z.string().uuid().parse(req.params.id);
    const body=z.object({password}).strict().parse(req.body);
    if(uid===req.actor.id)fail(400,'请通过修改本人密码入口验证当前密码');
    const target=store.db.prepare('SELECT id,name FROM users WHERE id=?').get(uid);
    if(!target)fail(404,'账号不存在');
    const hash=passwordHash(body.password);
    store.transaction(()=>{
      store.db.prepare('UPDATE users SET hash=? WHERE id=?').run(hash,uid);
      store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(uid);
      store.audit(req.actor,'password_reset','users',uid,'管理员重置账号密码并使旧会话失效');
    });
    res.json({ok:true});
  });
  const changeOwnPassword = req => {
    const body=z.object({current:z.string().max(128),password}).strict().parse(req.body);
    const current=store.db.prepare('SELECT * FROM users WHERE id=?').get(req.actor.id);
    if(!passwordMatches(body.current,current.hash))fail(400,'当前密码不正确');
    const hash=passwordHash(body.password);
    store.transaction(()=>{
      store.db.prepare('UPDATE users SET hash=? WHERE id=?').run(hash,current.id);
      store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(current.id);
      store.audit(req.actor,'password','users',current.id,'修改本人密码并使旧会话失效');
    });
    return current;
  };
  app.post('/api/password',auth,(req,res)=>res.json({user:setSession(res,changeOwnPassword(req))}));
  app.post('/api/mobile/password',mobileAuth,(req,res)=>{
    const current=changeOwnPassword(req);
    res.json({...issueSession(current,true),user:safeUser(current)});
  });
  const safeIntegration = row => { const { token_hash, ...safe } = row; return { ...safe, device_ids: JSON.parse(row.device_ids) }; };
  app.get('/api/integrations', auth, admin, (req, res) => res.json(store.db.prepare('SELECT * FROM integrations ORDER BY created_at DESC').all().map(safeIntegration)));
  app.post('/api/integrations', auth, admin, (req, res) => {
    const data = z.object({ name: z.string().trim().min(1).max(120), kind: z.enum(['ai', 'access', 'device', 'energy']), deviceIds: z.array(z.string()).min(1).max(500) }).strict().parse(req.body);
    const token = randomBytes(32).toString('base64url'); const id = randomUUID();
    store.transaction(() => {
      for (const deviceId of data.deviceIds) if (store.get(deviceId)?.type !== 'devices') fail(400, '授权设备不存在');
      store.db.prepare('INSERT INTO integrations(id,name,kind,token_hash,device_ids,created_at) VALUES(?,?,?,?,?,?)').run(id, data.name, data.kind, digest(token), JSON.stringify([...new Set(data.deviceIds)]), new Date().toISOString());
      store.audit(req.actor, 'create', 'integrations', id, `创建接入凭据：${data.name}`);
    }); res.status(201).json({ id, token, message: '密钥仅显示一次，请交给对应接入服务保管' });
  });
  app.post('/api/integrations/:id/revoke', auth, admin, (req, res) => {
    store.transaction(() => { const result = store.db.prepare('UPDATE integrations SET revoked=1 WHERE id=? AND revoked=0').run(req.params.id); if (!result.changes) fail(404, '凭据不存在或已撤销'); store.audit(req.actor, 'revoke', 'integrations', req.params.id, '撤销接入凭据'); }); res.json({ ok: true });
  });
  const integrationAuth = req => {
    const token = (req.headers.authorization || '').match(/^Bearer ([A-Za-z0-9_-]{40,80})$/)?.[1];
    const integration = token && store.db.prepare('SELECT * FROM integrations WHERE token_hash=? AND revoked=0').get(digest(token));
    if (!integration) fail(401, '接入凭据无效');
    return integration;
  };
  app.post('/api/ingest/:kind', (req, res) => {
    if (!req.is('application/json')) fail(415, '请使用 JSON 请求');
    const integration = integrationAuth(req);
    const body = z.object({ eventId: z.string().min(1).max(120), deviceId: z.string().min(1).max(80), data: z.record(z.string(), z.unknown()) }).strict().parse(req.body);
    if (!JSON.parse(integration.device_ids).includes(body.deviceId)) fail(403, '凭据未授权此设备');
    const kind = req.params.kind;
    if (!({ ai: ['alerts', 'captures', 'detections'], access: ['access', 'attendance'], device: ['telemetry'], energy: ['energy'] })[integration.kind]?.includes(kind)) fail(403, '凭据未授权此事件类型');
    const device = store.get(body.deviceId); if (device?.type !== 'devices') fail(400, '设备不存在');
    const fingerprint = digest(JSON.stringify({ kind, deviceId: body.deviceId, data: body.data }));
    const result = store.transaction(() => {
      const prior = store.db.prepare('SELECT * FROM event_keys WHERE integration_id=? AND event_key=?').get(integration.id, body.eventId);
      if (prior) { if (prior.fingerprint !== fingerprint) fail(409, '同一事件编号不能对应不同内容'); return { ...JSON.parse(prior.result), duplicate: true }; }
      const actor = { id: integration.id, name: integration.name }; let record, securityResult;
      if (kind === 'captures') securityResult = receiveCapture(store, integration, body);
      else if (kind === 'detections') securityResult = receiveDetection(store, integration, body);
      else if (kind === 'telemetry') {
        const status = z.object({ status: z.enum(['online', 'offline']) }).strict().parse(body.data);
        device.data.reportedStatus = status.status; device.data.lastSeen = new Date().toISOString(); device.data.reportSource = integration.name; record = store.save(device);
      } else {
        const data = { ...body.data }; if (kind !== 'attendance') data.deviceId = body.deviceId;
        record = createRecord(store, actor, kind, data, `integration:${integration.id}`);
        if (kind === 'alerts') addNotification(store, record.id);
        if (kind === 'attendance') { record.data.deviceId = body.deviceId; record = store.save(record); }
      }
      store.db.prepare('UPDATE integrations SET last_seen=?,received=received+1 WHERE id=?').run(new Date().toISOString(), integration.id);
      const result = { ...(securityResult || { id: record.id }), accepted: true, duplicate: false };
      store.db.prepare('INSERT INTO event_keys VALUES(?,?,?,?)').run(integration.id, body.eventId, fingerprint, JSON.stringify(result));
      return result;
    }); res.status(result.duplicate ? 200 : 201).json(result);
  });
  mountDailyReportRoutes(app, { auth, writer, mobileAuth, weatherService });
  mountDailyReportSubmissionRoutes(app, { store, auth, writer, mobileAuth, weatherService,projectAccess:(actor,pid,write)=>siteRecordService.documentProject(actor,pid,write,'construction_daily') });
  mountPhotoArchiveRoutes(app, { store, auth, mobileAuth, writer,projectAccess:(actor,pid,write)=>siteRecordService.documentProject(actor,pid,write,'work_photos') });
  // The supplied site example contains original photos; authenticated downloads only.
  const sitePhotoReference = (req, res) => res.download(fileURLToPath(new URL('./templates/site-photo-a4-aligned.docx', import.meta.url)), '现场施工步骤照片_A4单页对齐版.docx');
  app.get('/api/engineering/site-photo-reference', auth, sitePhotoReference);
  app.get('/api/mobile/engineering/site-photo-reference', mobileAuth, sitePhotoReference);
  let siteRecordService;
  mountEngineeringRoutes(app, { store, auth, mobileAuth, writer,siteRecordsPending:(pid,taskId)=>siteRecordsPending(store,pid,taskId),siteRecordHistoryVisible:(actor,pid,id)=>siteRecordService?.historyVisible(actor,pid,id)??true });
  mountEngineeringAttachmentRoutes(app, { store, auth, mobileAuth, writer });
  siteRecordService=mountEngineeringSiteRecordRoutes(app, { store, auth, mobileAuth, writer,filesDir,baseUrl });
  mountAppUpdateRoutes(app, updateDir);
  const ppe = mountPpeRoutes(app, { auth }, ppeOptions);
  const cameraAttendance = mountCameraAttendance(app, {store,auth}, {development,...attendanceOptions});
  mountReportWeather(app, { auth, mobileAuth, service:weatherService });
  mountSecurityRoutes(app, { store, auth, admin, integrationAuth });
  const vision = mountVisionRoutes(app, { store, auth, admin, directory: resolve(filesDir, 'vision-private') });
  mountModelRoutes(app, { store, auth, admin, filesDir, raw: express.raw({ type: 'model/gltf-binary', limit: '100mb' }) });
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
  if (existsSync(distPath)) {
    app.use(express.static(distPath, { index: false, dotfiles: 'deny' }));
    app.get('/{*path}', (req, res) => res.sendFile(resolve(distPath, 'index.html')));
  }
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；') });
    if (error instanceof BusinessError) return res.status(error.status).json({ error: error.message });
    if (error instanceof SecurityConfigError) return res.status(400).json({ error: error.message });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: '请求内容过大' });
    if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'JSON 格式错误' });
    // Some libraries (e.g. zip errors) use numeric codes; only SQLite string codes are checked here.
    if (typeof error.code === 'string' && error.code.startsWith('ERR_SQLITE') && /UNIQUE constraint/.test(error.message)) return res.status(409).json({ error: '编号或账号已存在，请使用不同的值' });
    console.error('Request failed', { path: req.path, name: error.name, code: error.code || 'internal_error' });
    res.status(500).json({ error: '服务暂时无法处理该请求，请稍后重试' });
  });
  return { app, store, vision, ppe, cameraAttendance };
}
