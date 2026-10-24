import { randomBytes, createHash, createCipheriv, createDecipheriv, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve, isAbsolute, extname } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { fail, createRecord } from './service.mjs';
import { receiveCapture, receiveDetection, addNotification, storeImage } from './security.mjs';
import { inside } from './security-config.mjs';
import { FACE_MODEL_ID, visionCapabilities, localFenceEvents } from './vision-catalog.mjs';
import { modelStatus, pythonPath, smokingSpec } from './vision-models.mjs';
export { modelStatus } from './vision-models.mjs';

const sourceSchema = z.object({ kind: z.enum(['rtsp', 'file']), uri: z.string().trim().min(1).max(1600), username: z.string().max(200).default(''), password: z.string().max(300).default(''), fps: z.number().int().min(1).max(5).default(2), captureFaces: z.boolean().default(false), expectedRevision: z.string().uuid().optional() }).strict();
const settingsSchema = z.object({ expectedRevision: z.string().uuid(), fps: z.number().int().min(1).max(5), captureFaces: z.boolean() }).strict();
const revisionSchema = z.object({ expectedRevision: z.string().uuid() }).strict();

export class VisionRuntime {
  constructor(store, directory) {
    this.store = store; this.directory = directory; this.sources = {}; this.runs = new Map(); this.closed = false;
    const settings = join(directory, 'sources.enc');
    if (existsSync(settings)) {
      const bytes = readFileSync(settings); const key = readFileSync(join(directory, 'secret.key'));
      const decrypt = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decrypt.setAuthTag(bytes.subarray(12, 28));
      this.sources = JSON.parse(Buffer.concat([decrypt.update(bytes.subarray(28)), decrypt.final()]).toString('utf8'));
      for (const source of Object.values(this.sources)) source.revision ||= randomUUID();
    }
  }
  save() {
    if (!existsSync(this.directory)) {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      if (process.platform === 'win32') {
        const account = execFileSync('whoami', [], { encoding: 'utf8', windowsHide: true }).trim();
        execFileSync('icacls', [this.directory, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'ignore' });
      }
    }
    const keyPath = join(this.directory, 'secret.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', readFileSync(keyPath), iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(this.sources)), cipher.final()]);
    const destination = join(this.directory, 'sources.enc');
    writeFileSync(destination + '.tmp', Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { mode: 0o600 });
    renameSync(destination + '.tmp', destination);
  }
  list() {
    const rules = this.store.list('rules'), watches = this.store.list('watches'), fences = this.store.list('fences');
    return Object.entries(this.sources).map(([deviceId, source]) => {
      const run = this.runs.get(deviceId);
      const last = run?.last;
      const integration = this.integration(deviceId);
      const related = rules.filter(r => r.data.deviceId === deviceId);
      const counts = { active: related.filter(r => r.state === 'active').length, draft: related.filter(r => r.state !== 'active').length,
        watches: watches.filter(r => r.data.deviceId === deviceId && r.data.integrationId === integration?.id && r.state === 'armed').length,
        fences: fences.filter(r => r.data.deviceId === deviceId && r.data.integrationId === integration?.id && r.state === 'armed' && localFenceEvents.includes(r.data.eventType)).length };
      return { deviceId, revision: source.revision, kind: source.kind, address: source.kind === 'rtsp' ? new URL(source.uri).hostname : '本机视频文件', fps: source.fps, captureFaces: source.captureFaces, rules: counts, authorized: !!integration, previewRevision: run?.generation || '',
        integrationId: this.store.setting(`vision-integration:${deviceId}`), state: run?.state || 'stopped', error: run?.error || '', frames: run?.frames || 0, alarms: run?.alarms || 0,
        lastFrameAt: last?.occurredAt || '', inferenceMs: last?.inferenceMs, people: last?.people || 0, uniqueTracks: run?.tracks.size || 0, quality: last?.quality, heatmap: run?.heatmap || [], ruleMetrics: run?.ruleMetrics || [], galleryErrors: last?.galleryErrors || [], warnings: last?.warnings || [], modelId: FACE_MODEL_ID };
    });
  }
  configure(deviceId, input, actor) {
    if (this.store.get(deviceId)?.data.kind !== 'camera') fail(400, '请选择已登记的摄像头');
    const source = sourceSchema.parse(input);
    if (this.sources[deviceId] && source.expectedRevision !== this.sources[deviceId].revision) fail(409, '视频源已变更，请关闭表单、刷新后重试');
    if (!this.sources[deviceId] && source.expectedRevision) fail(409, '视频源已被移除，请重新配置');
    delete source.expectedRevision;
    source.revision = randomUUID();
    if (source.kind === 'rtsp') {
      let parsed; try { parsed = new URL(source.uri); } catch { fail(400, '视频地址格式不正确'); }
      if (!['rtsp:', 'rtsps:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) fail(400, '请填写不含密码的 RTSP 地址，账号密码使用独立输入框');
    } else {
      if (!isAbsolute(source.uri) || !['.mp4', '.avi', '.mkv', '.mov'].includes(extname(source.uri).toLowerCase()) || !existsSync(source.uri)) fail(400, '请选择本机已有的 MP4、AVI、MKV 或 MOV 文件绝对路径');
      source.username = ''; source.password = '';
    }
    this.stop(deviceId);
    let iid = this.store.setting(`vision-integration:${deviceId}`);
    if (!iid || !this.store.db.prepare('SELECT 1 FROM integrations WHERE id=? AND revoked=0').get(iid)) {
      iid = randomUUID();
      this.store.db.prepare('INSERT INTO integrations(id,name,kind,token_hash,device_ids,created_at) VALUES(?,?,?,?,?,?)').run(iid, `本机视觉 · ${this.store.get(deviceId).data.name}`, 'ai', createHash('sha256').update(randomBytes(32)).digest('hex'), JSON.stringify([deviceId]), new Date().toISOString());
      this.store.setting(`vision-integration:${deviceId}`, iid);
    }
    this.sources[deviceId] = source; this.save(); this.store.setting(`vision-source:${deviceId}`, true); this.store.audit(actor, 'configure-video', 'devices', deviceId, '配置视觉服务视频源，凭据不写入审计');
    return { integrationId: iid, modelId: FACE_MODEL_ID, revision: source.revision };
  }
  updateSettings(deviceId, input, actor) {
    const settings = settingsSchema.parse(input), previous = this.sources[deviceId];
    if (!previous) fail(404, '视频源已被移除，请重新配置');
    if (settings.expectedRevision !== previous.revision) fail(409, '视频源已变更，请关闭表单、刷新后重试');
    if (!this.integration(deviceId)) fail(409, '分析服务授权已撤销，请重新配置连接信息');
    this.sources[deviceId] = { ...previous, fps: settings.fps, captureFaces: settings.captureFaces, revision: randomUUID() };
    try { this.save(); } catch (error) { this.sources[deviceId] = previous; throw error; }
    this.store.audit(actor, 'update-video-settings', 'devices', deviceId, '调整分析频率与抓拍设置，保留原连接信息');
    return { revision: this.sources[deviceId].revision };
  }
  remove(deviceId, input, actor) {
    const { expectedRevision } = revisionSchema.parse(input), previous = this.sources[deviceId];
    if (!previous) fail(404, '视频源已移除');
    if (expectedRevision !== previous.revision) fail(409, '视频源已变更，请刷新后再移除');
    delete this.sources[deviceId];
    try { this.save(); } catch (error) { this.sources[deviceId] = previous; throw error; }
    this.stop(deviceId); this.store.setting(`vision-source:${deviceId}`, false);
    this.store.audit(actor, 'remove-video', 'devices', deviceId, '移除视频源配置，保留识别历史');
  }
  integration(deviceId) {
    return this.store.db.prepare('SELECT * FROM integrations WHERE id=? AND revoked=0').get(this.store.setting(`vision-integration:${deviceId}`));
  }
  config(deviceId) {
    const integration = this.integration(deviceId); if (!integration) throw new Error('识别服务授权已撤销');
    const watches = this.store.list('watches').filter(r => r.state === 'armed' && r.data.integrationId === integration.id && r.data.deviceId === deviceId && r.data.modelId === FACE_MODEL_ID);
    const ids = new Set(watches.flatMap(r => r.data.portraitIds));
    const portraits = this.store.list('portraits').filter(r => r.state === 'active' && ids.has(r.id)).map(r => {
      const image = this.store.db.prepare('SELECT bytes FROM security_images WHERE id=?').get(r.data.imageId);
      return { id: r.id, version: r.version, base64: Buffer.from(image.bytes).toString('base64') };
    });
    const fences = this.store.list('fences').filter(r => r.state === 'armed' && r.data.deviceId === deviceId && r.data.integrationId === integration.id && localFenceEvents.includes(r.data.eventType));
    const rules = this.store.list('rules').filter(r => r.state === 'active' && r.data.deviceId === deviceId && visionCapabilities[r.data.algorithm]);
    const source = { ...this.sources[deviceId] };
    if (source.kind === 'rtsp') { const address = new URL(source.uri); address.username = source.username; address.password = source.password; source.uri = address.href; }
    delete source.username; delete source.password;
    delete source.revision;
    return { source, watchRules: watches, fenceRules: fences, rules, portraits };
  }
  start(deviceId) {
    if (!this.sources[deviceId]) fail(400, '请先配置视频源');
    if (!modelStatus().installed) fail(409, '本机模型或 Python 环境尚未安装');
    const unavailable = new Set(modelStatus().algorithms.filter(a => a.status !== 'installed').map(a => a.id));
    if (this.config(deviceId).rules.some(r => unavailable.has(r.data.algorithm))) fail(409, '已启用规则的模型未就绪，请重新准备模型或停用对应规则');
    if ([...this.runs.entries()].filter(([id, run]) => id !== deviceId && run.desired).length >= 4) fail(409, '本机当前最多同时分析 4 路，更多路数需先进行容量测试');
    this.stop(deviceId);
    const run = { state: 'starting', frames: 0, alarms: 0, error: '', tracks: new Set(), heatmap: Array(64).fill(0), timers: new Map(), generation: randomUUID(), desired: true };
    this.runs.set(deviceId, run);
    this.launch(deviceId, run);
  }
  launch(deviceId, run) {
    if (this.closed || !run.desired || this.runs.get(deviceId) !== run) return;
    let config; try { config = this.config(deviceId); } catch { run.state = 'error'; run.error = '识别服务授权失效'; return; }
    run.generation = randomUUID();
    run.lastSequence = 0;
    run.timers.clear();
    const child = spawn(pythonPath, ['-u', resolve('vision/worker.py')], { cwd: resolve('.'), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    run.child = child;
    // Never log native decoder stderr: it may contain a credential-bearing RTSP URL.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify(config) + '\n');
    let lastFrame = Date.now();
    const watchdog = setInterval(() => {
      if (run.desired && Date.now()-lastFrame > 60000) { run.error = '超过 60 秒没有分析结果，请检查视频或降低分析负载'; child.kill(); }
    }, 5000);
    const refresh = setInterval(() => { try { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(this.config(deviceId)) + '\n'); } catch { this.stop(deviceId); run.error = '识别服务授权失效'; } }, 2000);
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      if (!run.desired || this.runs.get(deviceId) !== run || line.length > 12 * 1024 * 1024) return;
      try {
        const message = JSON.parse(line);
        if (message.type === 'ready') { run.state = 'starting'; run.error = ''; }
        else if (message.type === 'frame') { lastFrame = Date.now(); this.frame(deviceId, run, message); }
        else if (message.type === 'ended') { run.state = 'ended'; run.desired = false; }
        else if (message.type === 'error') { run.state = 'error'; run.error = message.message || '视频中断，请检查网络和通道'; if (message.code === 'model_load_failed') run.desired = false; }
      } catch { run.state = 'error'; run.error = '分析结果处理失败，请检查规则与模型配置'; run.desired = false; child.kill(); }
    });
    child.on('error', () => { run.state = 'error'; run.error = '无法启动视觉进程'; run.desired = false; });
    child.on('close', () => {
      clearInterval(refresh); clearInterval(watchdog); lines.close();
      if (run.desired && !this.closed && this.runs.get(deviceId) === run) {
        run.state = 'reconnecting'; run.error ||= '视频服务已退出，正在重连';
        if (this.sources[deviceId]?.kind === 'rtsp') run.retry = setTimeout(() => this.launch(deviceId, run), 5000);
        else { run.state = 'error'; run.desired = false; }
      }
    });
  }
  frame(deviceId, run, message) {
    // Exact worker-message replay is not a new recognition. New sampled frames
    // of the same person still produce independent alarms.
    if (!Number.isSafeInteger(message.sequence) || message.sequence <= (run.lastSequence || 0)) return;
    run.lastSequence = message.sequence;
    const integration = this.integration(deviceId); if (!integration) { this.stop(deviceId); return; }
    const persons = message.objects.filter(o => o.classId === 0);
    run.frames++; run.state = 'running'; run.error = '';
    for (const person of persons) { if (run.tracks.size < 100000) run.tracks.add(person.objectId); const x = Math.min(7, Math.floor(person.point[0]*8)), y = Math.min(7, Math.floor(person.point[1]*8)); run.heatmap[y*8+x]++; }
    run.last = { ...message, people: persons.length }; run.preview = Buffer.from(message.preview, 'base64');
    const at = new Date().toISOString();
    this.store.transaction(() => {
      let events = 0;
      const generated = [];
      for (const face of message.faces.slice(0, 50)) {
        const result = receiveCapture(this.store, integration, { deviceId, eventId: `${run.generation}:${message.sequence}:face:${events++}`, data: { occurredAt: message.occurredAt, objectId: `${run.generation}:face:${message.sequence}:${events}`, modelId: message.modelId, mime: 'image/jpeg', base64: face.base64, appliedRules: message.appliedWatches, matches: face.matches } });
        run.alarms += result.alarmIds.length;
        generated.push(...result.alarmIds, result.id);
      }
      const fences = this.store.list('fences').filter(r => r.state === 'armed' && r.data.deviceId === deviceId && r.data.integrationId === integration.id && localFenceEvents.includes(r.data.eventType) && message.appliedFences.some(a => a.ruleId === r.id && a.version === r.version));
      for (const fence of fences) for (const person of persons) {
        const result = receiveDetection(this.store, integration, { deviceId, eventId: `${run.generation}:${message.sequence}:fence:${events++}`, data: { occurredAt: message.occurredAt, objectId: person.objectId, ruleId: fence.id, ruleVersion: fence.version, eventType: fence.data.eventType, point: person.point, confidence: person.confidence, image: { mime: 'image/jpeg', base64: message.frame } } });
        run.alarms += result.alarmIds.length;
        generated.push(...result.alarmIds, result.id);
      }
      const rules = this.store.list('rules').filter(r => r.state === 'active' && r.data.deviceId === deviceId && message.appliedRules.some(a => a.ruleId === r.id && a.version === r.version));
      const observedAt = this.sources[deviceId].kind === 'file' && Number.isFinite(message.mediaSeconds) ? message.mediaSeconds*1000 : Date.parse(message.occurredAt);
      run.ruleMetrics = [];
      for (const rule of rules) {
        const roi = JSON.parse(rule.data.roi || '[[0,0],[1,0],[1,1],[0,1]]');
        const objects = message.objects.filter(o => o.confidence >= rule.data.confidence && inside(o.point, roi));
        const people = objects.filter(o => o.classId === 0);
        run.ruleMetrics.push({ id: rule.id, name: rule.data.name, algorithm: rule.data.algorithm, people: people.length, objects: objects.length, tracks: people.map(o => ({ id: o.objectId, point: o.point })) });
        if (rule.data.algorithm === 'smoking') {
          const candidates = (message.behaviors || []).filter(b => b.algorithm === 'smoking' && b.modelId === smokingSpec.id && b.confidence >= rule.data.confidence && inside(b.point, roi));
          const prefix = `smoking:${rule.id}:${rule.version}:`;
          const visible = new Set(candidates.map(b => prefix+b.objectId));
          for (const key of run.timers.keys()) if (key.startsWith(prefix) && !visible.has(key)) run.timers.delete(key);
          for (const candidate of candidates) {
            const key = prefix+candidate.objectId;
            if (!run.timers.has(key)) run.timers.set(key, observedAt);
            if (observedAt-run.timers.get(key) < rule.data.dwellSeconds*1000) continue;
            const imageId = storeImage(this.store, { mime: 'image/jpeg', base64: message.frame }, 'evidence', deviceId);
            const alert = createRecord(this.store, { id: integration.id, name: integration.name }, 'alerts', { name: `${rule.data.name} · 疑似抽烟`, category: 'smoking', priority: 'medium', deviceId, spaceId: this.store.get(deviceId).data.spaceId || '', occurredAt: message.occurredAt, description: `在${rule.data.zone}的人员近景中识别到香烟候选，分值 ${candidate.confidence.toFixed(3)}。该结果不能确认完整抽烟动作，请复核原始画面。` }, `integration:${integration.id}`);
            alert.data = { ...alert.data, automatic: true, imageId, ruleId: rule.id, ruleVersion: rule.version, ruleSnapshot: rule.data, eventId: `${run.generation}:${message.sequence}:rule:${rule.id}:${candidate.objectId}`, modelId: smokingSpec.id, confidence: candidate.confidence, objectId: candidate.objectId, cigaretteBox: candidate.box, personBox: candidate.personBox, frameWidth: message.width, frameHeight: message.height };
            this.store.save(alert); addNotification(this.store, alert.id); run.alarms++; generated.push(alert.id); events++;
          }
          continue;
        }
        let condition = false;
        switch (rule.data.algorithm) {
          case 'intrusion': condition = people.length > 0; break;
          case 'presence': condition = people.length === 0; break;
          case 'crowd': condition = people.length >= (rule.data.minimumCount || 3); break;
          case 'loitering': {
            const prefix = `stay:${rule.id}:${rule.version}:`;
            const visible = new Set(people.map(o => prefix+o.objectId));
            for (const key of run.timers.keys()) if (key.startsWith(prefix) && !visible.has(key)) run.timers.delete(key);
            for (const key of visible) if (!run.timers.has(key)) run.timers.set(key, observedAt);
            condition = [...visible].some(key => observedAt-run.timers.get(key) >= rule.data.dwellSeconds*1000);
            break;
          }
          case 'fire_lane': condition = objects.some(o => [0, 1, 2, 3, 5, 7, 24, 26, 28].includes(o.classId)); break;
          case 'blur': condition = message.quality.sharpness < (rule.data.diagnosticThreshold || 40); break;
          case 'occlusion': condition = message.quality.contrast < (rule.data.diagnosticThreshold || 8); break;
          case 'night': condition = message.quality.brightness < (rule.data.diagnosticThreshold || 30); break;
        }
        const key = `${rule.id}:${rule.version}`;
        if (!condition) { run.timers.delete(key); continue; }
        if (!run.timers.has(key)) run.timers.set(key, observedAt);
        if (rule.data.algorithm !== 'loitering' && observedAt-run.timers.get(key) < rule.data.dwellSeconds*1000) continue;
        const imageId = storeImage(this.store, { mime: 'image/jpeg', base64: message.frame }, 'evidence', deviceId);
        let alert = createRecord(this.store, { id: integration.id, name: integration.name }, 'alerts', { name: rule.data.name, category: rule.data.algorithm, priority: 'medium', deviceId, spaceId: this.store.get(deviceId).data.spaceId || '', occurredAt: message.occurredAt, description: `本机视觉分析：${rule.data.zone}；区域人数 ${people.length}。请复核证据画面。` }, `integration:${integration.id}`);
        alert.data = { ...alert.data, automatic: true, imageId, ruleId: rule.id, ruleVersion: rule.version, ruleSnapshot: rule.data, eventId: `${run.generation}:${message.sequence}:rule:${rule.id}`, modelId: 'opencv-yolox-2022nov+image-quality-v1' }; this.store.save(alert); addNotification(this.store, alert.id); run.alarms++; generated.push(alert.id); events++;
      }
      for (const id of generated) { const record = this.store.get(id); record.data.inputKind = this.sources[deviceId].kind; record.data.mediaSeconds = message.mediaSeconds; this.store.save(record); }
      this.store.db.prepare('UPDATE integrations SET last_seen=?,received=received+? WHERE id=?').run(at, events, integration.id);
      if (this.sources[deviceId].kind === 'rtsp' && (!run.heartbeat || Date.now()-run.heartbeat > 10000)) { const device = this.store.get(deviceId); device.data.reportedStatus = 'online'; device.data.lastSeen = at; device.data.reportSource = integration.name; this.store.save(device); run.heartbeat = Date.now(); }
    });
  }
  stop(deviceId) { const run = this.runs.get(deviceId); if (run) { run.desired = false; clearTimeout(run.retry); run.child?.kill(); run.state = 'stopped'; } }
  close() { this.closed = true; for (const id of this.runs.keys()) this.stop(id); }
}

export function mountVisionRoutes(app, { store, auth, admin, directory }) {
  const runtime = new VisionRuntime(store, directory);
  app.get('/api/video/models', auth, (req, res) => res.json(modelStatus()));
  app.get('/api/video/sources', auth, (req, res) => res.json(runtime.list()));
  app.put('/api/video/sources/:id', auth, admin, (req, res) => res.json(runtime.configure(req.params.id, req.body, req.actor)));
  app.patch('/api/video/sources/:id', auth, admin, (req, res) => res.json(runtime.updateSettings(req.params.id, req.body, req.actor)));
  app.post('/api/video/sources/:id/start', auth, admin, (req, res) => { runtime.start(req.params.id); store.audit(req.actor, 'start-video', 'devices', req.params.id, '启动本机视觉分析'); res.json({ ok: true }); });
  app.post('/api/video/sources/:id/stop', auth, admin, (req, res) => { runtime.stop(req.params.id); store.audit(req.actor, 'stop-video', 'devices', req.params.id, '停止本机视觉分析'); res.json({ ok: true }); });
  app.delete('/api/video/sources/:id', auth, admin, (req, res) => { runtime.remove(req.params.id, req.body, req.actor); res.json({ ok: true }); });
  app.get('/api/video/sources/:id/frame', auth, (req, res) => {
    const run = runtime.runs.get(req.params.id);
    if (!run?.preview || !['running', 'ended'].includes(run.state)) fail(404, '当前没有可用分析画面');
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'X-Frame-Time': run.last.occurredAt }).send(run.preview);
  });
  return runtime;
}
