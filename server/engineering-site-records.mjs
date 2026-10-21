import {documentScope,requireDocumentProject} from './project-document-scope.mjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, createReadStream, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, truncateSync, unlinkSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { z } from 'zod';
import sharp from 'sharp';
import { fail } from './service.mjs';
import { siteWorkSteps, isStepCategory } from './site-work-steps.mjs';
import { generateSitePhotoDocument, sitePhotoTemplateHash, sitePhotoLayoutHash, invalidXmlText } from './site-photo-document.mjs';

import { supervisionSchema, supervisionMissing, generateSupervisionDocument, supervisionTemplateHash, supervisionLayoutHash } from './supervision-daily-document.mjs';

import {scanImageRecord,imageMime,sameSiteContext} from './site-record-policy.mjs';
import {createSiteBatchService} from './site-work-batches.mjs';
import { dailySource } from './site-daily-source.mjs';
import {createSiteAccess} from './site-record-access.mjs';
import {createSiteRecordTemplateService,siteTemplateRefSchema} from './site-record-templates.mjs';
import {inspectSiteRecords, buildSiteRegister, siteRegisterLimits} from './site-record-register.mjs';
import {mountSiteDocumentLibrary} from './site-document-library.mjs';

export const siteRecordCategories = {
  site_measurement: '现场收方单扫描文件图', work_photos: '现场施工步骤照片', work_videos: '现场施工步骤视频',
  material_measurement: '现场材料收方单扫描文件图', hidden_work: '隐蔽图片', construction_daily: '施工日报', supervision_daily: '监理日报',
};
export const siteRecordLimits = Object.freeze({ chunkBytes: 1048576, maxImageBytes: 16777216, maxVideoBytes: 268435456, maxRecordBytes: 1073741824, maxRecordFiles: 100 });
const uuid = z.string().uuid(), version = z.number().int().positive(), optionalId = uuid.or(z.literal('')).default('');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s, '资料日期无效');
const printText = max => z.string().trim().max(max).refine(s=>!invalidXmlText(s),'文字包含无效控制字符');
const stepId = z.enum(siteWorkSteps.map(s => s.id));
const dataSchema = z.object({ templateRef:siteTemplateRefSchema.optional(), category: z.enum(Object.keys(siteRecordCategories)), title: z.string().trim().min(1).max(160), recordDate: date, wbsId: uuid, taskId: optionalId, note: z.string().trim().max(2000).default(''), dailyReportId: uuid.optional(), batchId: uuid.or(z.literal('')).optional(), uploadPolicy:z.literal('seven_v1').optional(), photoRecordId:uuid.or(z.literal('')).optional(), supervision: supervisionSchema.optional(), workInfo: z.object({ road: printText(60), location: printText(60), number: printText(40), completedAt: date.or(z.literal('')) }).strict().optional() }).strict().superRefine((d,ctx)=>{if(d.photoRecordId && d.category!=='work_videos')ctx.addIssue({code:'custom',message:'仅补充视频可以关联照片组',path:['photoRecordId']});if(d.dailyReportId && d.category!=='construction_daily')ctx.addIssue({code:'custom',message:'仅施工日报可以归入已生成日报',path:['dailyReportId']});if(d.supervision && d.category!=='supervision_daily')ctx.addIssue({code:'custom',message:'仅监理日报可以填写监理正文',path:['supervision']});});
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), now = () => new Date().toISOString();
const parseRecord = r => r ? { ...r, data: JSON.parse(r.data), snapshot: JSON.parse(r.snapshot) } : null;
const formats = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', pdf: 'application/pdf', mp4: 'video/mp4', webm: 'video/webm', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
const publicFileColumns = 'id,record_id,project_id,name,mime,byte_count,sha256,created_by,created_name,created_at,removed_by,removed_name,removed_at,remove_reason';
function fileMetadata(category, b, data={}) {
  const name = b.name.normalize('NFC');
  if (/[/\\:*?"<>|\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(name) || /^[. ]|[. ]$/.test(name) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) fail(400, '文件名无效，不能包含路径、控制字符或系统保留名称');
  const ext = name.split('.').pop().toLowerCase(), mime = formats[ext];
  const allowed = scanImageRecord(data)? ['png','jpg','jpeg','webp'] : category === 'work_videos' ? ['mp4', 'webm'] : ['work_photos', 'hidden_work'].includes(category) ? ['png', 'jpg', 'jpeg', 'webp'] : ['png', 'jpg', 'jpeg', 'webp', 'pdf', 'docx'];
  if (!allowed.includes(ext) || b.mime !== mime) fail(400, '文件格式或 MIME 与资料分类不一致');
  const maximum = category === 'work_videos' ? siteRecordLimits.maxVideoBytes : siteRecordLimits.maxImageBytes;
  if (b.byteCount > maximum) fail(413, category === 'work_videos' ? '视频不能超过 256 MiB' : '扫描件或照片不能超过 16 MiB');
  return { name, mime, ext };
}
function signature(file, ext, byteCount) {
  if (ext === 'docx') {
    // Document originals are separately capped at 16 MiB. Inspect ZIP directory only; never decompress embedded content.
    const entries = []; let expanded = 0;
    try { unzipSync(readFileSync(file), { filter(e) { entries.push(e.name); expanded += e.originalSize; return false; } }); } catch { fail(400, 'Word 原件容器损坏'); }
    if (entries.length > 4096 || expanded > 128 * 1024 * 1024 || !entries.includes('[Content_Types].xml') || !entries.includes('word/document.xml') || entries.some(n => /(?:^|\/)\.\.(?:\/|$)|\\|(?:vbaProject\.bin|activeX\/|embeddings\/)/i.test(n))) fail(400, 'Word 原件格式不符或含宏、嵌入对象、异常路径及过大内容');
    return;
  }
  const fd = openSync(file, 'r'), bytes = Buffer.alloc(Math.min(byteCount, 4096));
  try { readSync(fd, bytes, 0, bytes.length, 0); } finally { closeSync(fd); }
  const starts = hex => bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
  const valid = ext === 'png' ? starts('89504e470d0a1a0a') : ['jpg', 'jpeg'].includes(ext) ? starts('ffd8ff') : ext === 'pdf' ? bytes.subarray(0, 5).toString() === '%PDF-' : ext === 'webp' ? bytes.length >= 12 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' : ext === 'mp4' ? bytes.length >= 16 && bytes.readUInt32BE(0) >= 16 && bytes.readUInt32BE(0) <= byteCount && bytes.subarray(4, 8).toString() === 'ftyp' && /^(?:isom|iso[2-9]|mp4[12]|avc1|hvc1|hev1|dash|M4V |MSNV|qt  )$/.test(bytes.subarray(8, 12).toString()) : ext === 'webm' ? starts('1a45dfa3') && bytes.includes(Buffer.from('webm')) : false;
  if (!valid) fail(400, '文件内容与声明格式不一致；已保留上传，可取消后重选原件');
}
function fileHash(file) {
  const fd = openSync(file, 'r'), bytes = Buffer.alloc(siteRecordLimits.chunkBytes), sha = createHash('sha256');
  try { let n; while ((n = readSync(fd, bytes, 0, bytes.length, null)) > 0) sha.update(bytes.subarray(0, n)); return sha.digest('hex'); } finally { closeSync(fd); }
}

export function siteRecordsPending(store, projectId, taskId = '') {
  const sql = "SELECT 1 FROM engineering_site_records r WHERE r.project_id=? AND (r.state='draft' OR EXISTS(SELECT 1 FROM engineering_site_uploads u WHERE u.record_id=r.id AND u.state='uploading'))" + (taskId ? " AND json_extract(r.data,'$.taskId')=?" : '') + ' LIMIT 1';
  const batchSql="SELECT 1 FROM engineering_site_batches WHERE project_id=? AND "+(taskId?"state<>'withdrawn' AND json_extract(data,'$.taskId')=?":"state='draft'")+' LIMIT 1';
  return !!store.db.prepare(sql).get(...(taskId ? [projectId, taskId] : [projectId])) || !!store.db.prepare(batchSql).get(...(taskId?[projectId,taskId]:[projectId]));
}

// Upload payloads live on disk. SQLite holds bounded metadata and chunk hashes only.
export function mountEngineeringSiteRecordRoutes(app, { store, auth, mobileAuth, writer, filesDir, baseUrl }) {
  const db = store.db, root = resolve(filesDir, 'engineering-site-records'), staging = join(root, 'staging'), originals = join(root, 'originals'), grants = new Map();
  mkdirSync(staging, { recursive: true }); mkdirSync(originals, { recursive: true });
  for (const p of [root, staging, originals]) if (lstatSync(p).isSymbolicLink()) throw new Error('施工资料目录不能使用符号链接');
  db.exec(`CREATE TABLE IF NOT EXISTS engineering_site_records (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES engineering_projects(id), state TEXT NOT NULL CHECK(state IN ('draft','archived','withdrawn')), version INTEGER NOT NULL,
    data TEXT NOT NULL CHECK(json_valid(data)), snapshot TEXT NOT NULL CHECK(json_valid(snapshot)), created_by TEXT NOT NULL REFERENCES users(id), creator_name TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_by TEXT, archived_name TEXT, archived_at TEXT, archive_note TEXT, withdrawn_by TEXT, withdrawn_name TEXT, withdrawn_at TEXT, withdraw_reason TEXT
  ); CREATE INDEX IF NOT EXISTS engineering_site_records_project ON engineering_site_records(project_id,created_at DESC,id);
  CREATE TABLE IF NOT EXISTS engineering_site_uploads (
    id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES engineering_site_records(id), project_id TEXT NOT NULL REFERENCES engineering_projects(id), name TEXT NOT NULL, mime TEXT NOT NULL,
    byte_count INTEGER NOT NULL CHECK(byte_count>0), sha256 TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK(state IN ('uploading','completed','cancelled')),
    file_id TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_name TEXT NOT NULL, session_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS engineering_site_uploads_record ON engineering_site_uploads(record_id,state);
  CREATE TABLE IF NOT EXISTS engineering_site_chunks (upload_id TEXT NOT NULL REFERENCES engineering_site_uploads(id), offset INTEGER NOT NULL, byte_count INTEGER NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(upload_id,offset));
  CREATE TABLE IF NOT EXISTS engineering_site_files (
    id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES engineering_site_records(id), project_id TEXT NOT NULL REFERENCES engineering_projects(id), upload_id TEXT NOT NULL UNIQUE REFERENCES engineering_site_uploads(id),
    name TEXT NOT NULL, mime TEXT NOT NULL, byte_count INTEGER NOT NULL, sha256 TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_name TEXT NOT NULL, created_at TEXT NOT NULL,
    removed_by TEXT, removed_name TEXT, removed_at TEXT, remove_reason TEXT, UNIQUE(record_id,sha256)
  ); CREATE INDEX IF NOT EXISTS engineering_site_files_record ON engineering_site_files(record_id,created_at,id);
  CREATE TABLE IF NOT EXISTS engineering_site_events (id TEXT PRIMARY KEY,record_id TEXT NOT NULL REFERENCES engineering_site_records(id),version INTEGER NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL,snapshot TEXT NOT NULL,action TEXT NOT NULL,note TEXT NOT NULL,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS engineering_site_media_grants (token_hash TEXT PRIMARY KEY, project_id TEXT NOT NULL, record_id TEXT NOT NULL, file_id TEXT NOT NULL, user_id TEXT NOT NULL, session_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);`);
  if (!db.prepare('PRAGMA table_info(engineering_site_uploads)').all().some(c => c.name === 'step_id')) db.exec("ALTER TABLE engineering_site_uploads ADD COLUMN step_id TEXT NOT NULL DEFAULT ''");
  db.exec(`CREATE TABLE IF NOT EXISTS engineering_site_file_steps (
    file_id TEXT PRIMARY KEY REFERENCES engineering_site_files(id), record_id TEXT NOT NULL REFERENCES engineering_site_records(id), step_id TEXT NOT NULL, representative INTEGER NOT NULL DEFAULT 0 CHECK(representative IN (0,1))
  ); CREATE UNIQUE INDEX IF NOT EXISTS engineering_site_step_cover ON engineering_site_file_steps(record_id,step_id) WHERE representative=1;
  CREATE TABLE IF NOT EXISTS engineering_site_word_exports (
    id TEXT PRIMARY KEY,record_id TEXT NOT NULL REFERENCES engineering_site_records(id),project_id TEXT NOT NULL REFERENCES engineering_projects(id),sequence INTEGER NOT NULL,source_version INTEGER NOT NULL,
    snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),name TEXT NOT NULL,byte_count INTEGER NOT NULL,sha256 TEXT NOT NULL,document BLOB NOT NULL,created_by TEXT NOT NULL,created_name TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(record_id,sequence)
  );`);
  const partPath = uid => join(staging, uuid.parse(uid) + '.part'), finalPath = fid => join(originals, uuid.parse(fid) + '.original');
  function acl(actor, pid, write = false) {
    const project = db.prepare('SELECT * FROM engineering_projects WHERE id=?').get(uuid.parse(pid));
    let role = actor.role === 'admin' ? 'admin' : db.prepare('SELECT role FROM engineering_members WHERE project_id=? AND user_id=?').get(pid, actor.id)?.role;
    if (role && actor.role === 'viewer') role = 'viewer';
    if (!project || !role) fail(404, '项目不存在或未授权');
    if (write && !['admin', 'manager', 'engineer', 'finance'].includes(role)) fail(403, '当前账号只能查看施工资料');
    return { project, role };
  }
  function access(req, write = false) {
    const c = acl(req.actor, req.params.pid, write), record = req.params.rid ? parseRecord(db.prepare('SELECT * FROM engineering_site_records WHERE project_id=? AND id=?').get(c.project.id, uuid.parse(req.params.rid))) : null;
    if (req.params.rid && !record) fail(404, '施工资料不存在');
    if(write&&req.path.includes('/site-records/batches'))permissions.requireAction(req.actor,c.project.id,'manage');
    if(!record)permissions.requireAction(req.actor,c.project.id,'read');
    if(record){permissions.requireAction(req.actor,c.project.id,'read',record.data,record.created_by);if(record.data.dailyReportId&&!permissions.delegated(req.actor,record))dailySource(db,req.actor,record.data.dailyReportId);}
    if(record&&(/\/(?:download|media-grants|photo-table)$/.test(req.path)))permissions.requireAction(req.actor,c.project.id,'download',record.data,record.created_by);
    return { ...c, record };
  }
  const permissions=createSiteAccess({db,store,acl,categories:siteRecordCategories});
  const templates=createSiteRecordTemplateService({db,store,acl,permissions});
  const manager = c => ['admin', 'manager'].includes(c.role), owner = (c, actor) => permissions.enabled(c.project.id)?permissions.can(actor,c.project.id,'editAny',c.record.data,c.record.created_by)||(permissions.handler(c.record.id)?.user_id||c.record.created_by)===actor.id&&permissions.can(actor,c.project.id,'editOwn',c.record.data,c.record.created_by):c.record.created_by === actor.id || manager(c);
  function editable(c, actor) {
    if (c.project.state !== 'active') fail(409, '项目未在施工中，施工资料已锁定');
    if (!owner(c, actor)) fail(403, '仅资料创建人或项目经理可以修改此草稿');
    if(permissions.enabled(c.project.id)&&['submitted','approved'].includes(permissions.review(c.record.id)?.state))fail(409,'已提交或已通过复核的资料已锁定，请退回补充后修改');
    if (c.record.state !== 'draft') fail(409, '已归档或撤回的施工资料不能改写');
  }
  function session(req) {
    const bearer = req.headers.authorization || '', cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('workspace_session='))?.slice(18);
    const s = req.path.startsWith('/api/mobile/') ? /^Bearer [A-Za-z0-9_-]{43}$/.test(bearer) ? 'mobile:' + hash(bearer.slice(7)) : '' : cookie ? hash(cookie) : '';
    if (!db.prepare('SELECT 1 FROM sessions WHERE hash=? AND user_id=? AND expires_at>?').get(s, req.actor.id, Date.now())) fail(401, '登录已失效，请重新登录');
    return s;
  }
  const originalSessionActive = u => !!db.prepare('SELECT 1 FROM sessions s JOIN users x ON s.user_id=x.id WHERE s.hash=? AND s.user_id=? AND s.expires_at>? AND x.active=1').get(u.session_hash, u.created_by, Date.now());
  function originalPermission(u, c) {
    const actor = db.prepare('SELECT id,role,name,active FROM users WHERE id=?').get(u.created_by); if (!actor?.active) return false;
    try { if(c.record.data.dailyReportId)dailySource(db,actor,c.record.data.dailyReportId); const source = { ...acl(actor, c.project.id, true), record: c.record }; return source.project.state === 'active' && source.record.state === 'draft' && owner(source, actor) && permissions.can(actor,c.project.id,'read',c.record.data,c.record.created_by) && !['submitted','approved'].includes(permissions.review(c.record.id)?.state); } catch { return false; }
  }
  function upload(req, c, cancelOther = false) {
    const u = db.prepare('SELECT * FROM engineering_site_uploads WHERE project_id=? AND record_id=? AND id=?').get(c.project.id, c.record.id, uuid.parse(req.params.uid));
    session(req);
    if (!u || u.created_by !== req.actor.id && !(cancelOther && manager(c))) fail(404, '上传不存在或不属于当前经办人');
    if (u.created_by !== req.actor.id && originalSessionActive(u) && originalPermission(u, c)) fail(409, '原经办会话及权限仍有效，不能取消他人的待上传原件');
    return u;
  }
  const files = rid => db.prepare(`SELECT ${publicFileColumns} FROM engineering_site_files WHERE record_id=? ORDER BY created_at,id`).all(rid).map(f => ({ ...f, ...(db.prepare('SELECT step_id,representative FROM engineering_site_file_steps WHERE file_id=?').get(f.id) || {step_id:'',representative:0}) }));
  const exportColumns = 'id,record_id,sequence,source_version,snapshot,name,byte_count,sha256,created_by,created_name,created_at';
  const wordExports = rid => db.prepare(`SELECT ${exportColumns} FROM engineering_site_word_exports WHERE record_id=? ORDER BY sequence DESC`).all(rid).map(e => ({...e,snapshot:JSON.parse(e.snapshot)}));
  const usage = rid => {
    const a = db.prepare('SELECT COUNT(*) n,COALESCE(SUM(byte_count),0) bytes FROM engineering_site_files WHERE record_id=?').get(rid), b = db.prepare("SELECT COUNT(*) n,COALESCE(SUM(byte_count),0) bytes FROM engineering_site_uploads WHERE record_id=? AND state='uploading'").get(rid);
    return { usedBytes: a.bytes + b.bytes, usedFiles: a.n + b.n };
  };
  const uploadPublic = (u, v, c, actor) => {
    const own = u.created_by === actor.id, activeSession = originalSessionActive(u), abandoned = !activeSession || !originalPermission(u, c), writable = c.project.state === 'active' && c.record.state === 'draft' && owner(c, actor) && ['admin', 'manager', 'engineer', 'finance'].includes(c.role);
    return { id: u.id, name: u.name, mime: u.mime, byteCount: u.byte_count, sha256: u.sha256, stepId:u.step_id || '', offset: u.offset, state: u.state, fileId: u.file_id || '', created_by: u.created_by, created_name: u.created_name, created_at: u.created_at, version: v,
      canResume: writable && own && u.state === 'uploading', canCancel: writable && u.state === 'uploading' && (own || manager(c) && abandoned), requiresCancelReason: !own, originalSessionActive: activeSession, abandoned };
  };
  function photoGroup(pid,data) {
    if(data.category!=='work_videos')return null;
    if(!data.photoRecordId){if(data.uploadPolicy==='seven_v1')fail(400,'补充视频须选择对应照片组');return null;}
    const parent=parseRecord(db.prepare('SELECT * FROM engineering_site_records WHERE project_id=? AND id=?').get(pid,data.photoRecordId));
    if(!parent||parent.data.category!=='work_photos'||parent.state==='withdrawn')fail(400,'对应照片组不存在或已撤回');
    if(parent.data.wbsId!==data.wbsId||(parent.data.taskId||'')!==(data.taskId||'')||(parent.data.batchId||'')!==(data.batchId||''))fail(400,'补充视频须与对应照片组属于同一施工部位、任务及批次');
    if(parent.data.recordDate!==data.recordDate)fail(400,'补充视频资料日期必须与对应照片组一致，请重新选择照片组并核对继承的日期；历史原件保留');
    return {id:parent.id,title:parent.data.title};
  }
  function retainedDaily(pid,data,actor,withOriginals=false){
    try{return dailySource(db,actor,data.dailyReportId,withOriginals);}catch(e){
      if(e.status!==404)throw e;
      const candidates=db.prepare("SELECT * FROM engineering_site_records WHERE project_id=? AND json_extract(data,'$.dailyReportId')=? AND json_extract(data,'$.wbsId')=? AND COALESCE(json_extract(data,'$.taskId'),'')=? AND COALESCE(json_extract(data,'$.batchId'),'')=?").all(pid,data.dailyReportId,data.wbsId,data.taskId||'',data.batchId||'').map(parseRecord);
      const r=candidates.find(r=>permissions.delegated(actor,r));if(!r?.snapshot.dailyReport)throw e;
      const evidence=r.snapshot.dailyReport;return {evidence,originals:[{sha256:evidence.documentSha256},...evidence.photos.map(p=>({sha256:p.sha256}))]};
    }
  }
  function snapshot(pid, data, actor, previous) {
    const path = [], seen = new Set(); let nid = data.wbsId;
    while (nid) {
      const n = db.prepare('SELECT * FROM engineering_wbs WHERE project_id=? AND id=?').get(pid, nid);
      if (!n || seen.has(nid) || path.length >= 5) fail(400, '施工部位不存在、不属于本项目或层级无效');
      seen.add(nid); const d = JSON.parse(n.data); path.unshift({ id: n.id, code: n.code, title: d.title, type: d.type, version: n.version }); nid = d.parentId;
    }
    let task = null;
    if (data.taskId) {
      const t = db.prepare("SELECT * FROM engineering_items WHERE project_id=? AND id=? AND kind='tasks'").get(pid, data.taskId), l = db.prepare('SELECT * FROM engineering_task_wbs WHERE project_id=? AND task_id=?').get(pid, data.taskId);
      if (!t || t.state === 'cancelled' || l?.node_id !== data.wbsId) fail(400, '任务须属于本项目且归属所选施工部位');
      const d = JSON.parse(t.data); task = { id: t.id, title: d.title, location: d.location, wbsId: data.wbsId, linkVersion: l.version };
    }
    const group=photoGroup(pid,data),template=data.templateRef?templates.capture(actor,pid,data.templateRef,data,previous):null;
    return { path, task,...(template?{template}:{}),...(group?{photoGroup:group}:{}), ...(data.dailyReportId?{dailyReport:retainedDaily(pid,data,actor).evidence}:{}),...(data.batchId?{batch:batches.capture(pid,data)}:{}) };
  }
  function event(req, rid, action, note) {
    const r = db.prepare('SELECT * FROM engineering_site_records WHERE id=?').get(rid), at = now();
    db.prepare('INSERT INTO engineering_site_events VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), rid, r.version, r.state, r.data, r.snapshot, action, note, req.actor.id, req.actor.name, at);
    db.prepare('INSERT INTO engineering_history VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), r.project_id, rid, 'tasks', req.actor.id, req.actor.name, action, note, at);
    store.audit(req.actor, action, 'engineering_site_records', rid, siteRecordCategories[JSON.parse(r.data).category]);
  }
  const bump = rid => db.prepare('UPDATE engineering_site_records SET version=version+1,updated_at=? WHERE id=?').run(now(), rid);
  function currentAccess(req,write=false) {
    session(req);
    const actor=db.prepare('SELECT id,name,role,active FROM users WHERE id=?').get(req.actor.id);
    if(!actor?.active)fail(401,'账号已停用，请重新登录');
    req.actor={...req.actor,...actor};
    return access(req,write);
  }
  function mutate(req, body, key, check, action) {
    const undo = [];
    try {
      return store.transaction(() => {
        // Image conversion yields to the event loop. Revalidate identity after that boundary.
        const c = currentAccess(req,true); check(c);
        const fingerprint = hash(key + '\n' + JSON.stringify(body)), old = db.prepare('SELECT * FROM engineering_requests WHERE actor_id=? AND request_id=?').get(req.actor.id, body.requestId);
        if (old) { if (old.fingerprint !== fingerprint) fail(409, '请求编号已使用，请核对后重试'); return { ...JSON.parse(old.result), replayed: true }; }
        const result = action(c, undo);
        db.prepare('INSERT INTO engineering_requests VALUES(?,?,?,?)').run(req.actor.id, body.requestId, fingerprint, JSON.stringify(result));
        return result;
      });
    } catch (e) { for (const reverse of undo.reverse()) { try { reverse(); } catch { /* next request reconciles disk against the committed index */ } } throw e; }
  }
  function checkVersion(r, n) { if (r.version !== n) fail(409, '施工资料版本已更新，请刷新核对'); }
  function reconcile(u) {
    const p = partPath(u.id);
    if (!existsSync(p)) { if (u.offset) fail(503, '上传暂存文件缺失，请联系管理员检查存储'); const fd = openSync(p, 'wx', 0o600); closeSync(fd); }
    if (lstatSync(p).isSymbolicLink()) fail(503, '上传存储异常');
    const size = statSync(p).size;
    if (size < u.offset) fail(503, '上传暂存长度小于已确认进度，请检查存储');
    if (size > u.offset) truncateSync(p, u.offset);
    return p;
  }
  const batches=createSiteBatchService({db,store,access,mutate,permissions,snapshot:(pid,d)=>snapshot(pid,{wbsId:d.wbsId,taskId:d.taskId}),categories:siteRecordCategories,files,parseRecord});
  const schemaVersion = z.object({ requestId: uuid, version }).strict();
  // The library is a read-only projection of the existing record store. It shares
  // both record ACL and imported-daily source constraints with the original routes.
  function photoWordBasis(c){return hash(JSON.stringify({data:c.record.data,snapshot:c.record.snapshot,project:c.project.data,files:files(c.record.id).map(f=>({id:f.id,recordId:f.record_id,projectId:f.project_id,name:f.name,mime:f.mime,sha256:f.sha256,bytes:f.byte_count,step:f.step_id,representative:f.representative,removedAt:f.removed_at})),pending:db.prepare("SELECT id FROM engineering_site_uploads WHERE record_id=? AND state='uploading' ORDER BY id").all(c.record.id)}));}
  const photoWordReaders=new Map();
  const library = mountSiteDocumentLibrary(app, {
    db, store, auth, mobileAuth, writer, baseUrl, categories:siteRecordCategories, session,
    liveActor(sess,actorId){const actor=db.prepare('SELECT u.id,u.role,u.name,u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.user_id=? AND s.expires_at>? AND u.active=1').get(sess,actorId,Date.now());if(!actor)fail(401,'登录已失效，请重新登录');return actor;},
    validateRecord(actor,pid,rid,download=false){
      acl(actor,pid);const r=parseRecord(db.prepare('SELECT * FROM engineering_site_records WHERE project_id=? AND id=?').get(pid,rid));if(!r)fail(404,'施工资料不存在或未授权');
      permissions.requireAction(actor,pid,'read',r.data,r.created_by);if(download)permissions.requireAction(actor,pid,'download',r.data,r.created_by);
      let sourceEvidence=null;if(r.data.dailyReportId&&!permissions.delegated(actor,r))sourceEvidence=dailySource(db,actor,r.data.dailyReportId).evidence;
      // Daily-source changes invalidate already generated packages as well as ACL changes.
      return {...r,librarySourceEvidence:sourceEvidence};
    },
    selectRows(actor,f,maximum){
      const summary=maximum==='summary';if(summary)maximum=undefined;
      const projects=f.projectId?[acl(actor,f.projectId).project]:db.prepare('SELECT * FROM engineering_projects ORDER BY id').all();const rows=[];
      for(const project of projects){
        permissions.requireAction(actor,project.id,'read');const source=permissions.sourceClause(actor,project.id),scope=permissions.clause(actor,project.id),where=['project_id=?',"(json_extract(data,'$.dailyReportId') IS NULL OR EXISTS(SELECT 1 FROM daily_reports d WHERE d.id=json_extract(engineering_site_records.data,'$.dailyReportId') AND (?='admin' OR d.author_id=?)) OR ("+source.sql+'))','('+scope.sql+')'],args=[project.id,actor.role,actor.id,...source.args,...scope.args];
        for(const [field,value]of [['wbsId',f.wbsId],['recordDate',f.from]])if(value){where.push("json_extract(data,'$."+field+"')"+(field==='recordDate'?'>=':'=')+'?');args.push(value);}
        if(f.to){where.push("json_extract(data,'$.recordDate')<=?");args.push(f.to);}if(f.state){where.push('state=?');args.push(f.state);}if(f.q){where.push("instr(lower(json_extract(data,'$.title')),lower(?))>0");args.push(f.q);}
        if(summary){
          // Aggregate inside SQLite, so a paged library does not deserialize all
          // record bodies, supervision text or historical snapshots into memory.
          const sql=`SELECT json_extract(data,'$.wbsId') wbsId,json_extract(data,'$.recordDate') recordDate,json_extract(data,'$.category') category,state,
            COALESCE((SELECT state FROM engineering_site_reviews rv WHERE rv.record_id=engineering_site_records.id),'draft') reviewState,COUNT(*) recordCount,
            SUM((SELECT COUNT(*) FROM engineering_site_files f WHERE f.record_id=engineering_site_records.id AND f.removed_at IS NULL)) originalFileCount,
            SUM((SELECT COUNT(*) FROM engineering_site_word_exports e WHERE e.record_id=engineering_site_records.id)) wordCount,
            SUM(COALESCE((SELECT SUM(byte_count) FROM engineering_site_files f WHERE f.record_id=engineering_site_records.id AND f.removed_at IS NULL),0)+COALESCE((SELECT SUM(byte_count) FROM engineering_site_word_exports e WHERE e.record_id=engineering_site_records.id),0)) byteCount
            FROM engineering_site_records WHERE `+where.join(' AND ')+' GROUP BY 1,2,3,4,5';
          for(const item of db.prepare(sql).all(...args)){const node=db.prepare('SELECT data FROM engineering_wbs WHERE project_id=? AND id=?').get(project.id,item.wbsId);rows.push({...item,record:{project_id:project.id,data:{wbsId:item.wbsId,recordDate:item.recordDate,category:item.category},state:item.state},projectName:JSON.parse(project.data).name,wbsTitle:node?JSON.parse(node.data).title:'历史施工部位'});}continue;
        }
        const sql='SELECT * FROM engineering_site_records WHERE '+where.join(' AND ')+(maximum?' LIMIT ?':'');const selected=maximum?db.prepare(sql).all(...args,Math.max(0,maximum-rows.length)):db.prepare(sql).all(...args);for(const raw of selected){
          const record=parseRecord(raw),wbs=db.prepare('SELECT data FROM engineering_wbs WHERE project_id=? AND id=?').get(project.id,record.data.wbsId),original=db.prepare('SELECT COUNT(*) n,COALESCE(SUM(byte_count),0) bytes FROM engineering_site_files WHERE record_id=? AND removed_at IS NULL').get(record.id),words=db.prepare('SELECT COUNT(*) n,COALESCE(SUM(byte_count),0) bytes FROM engineering_site_word_exports WHERE record_id=?').get(record.id);
          rows.push({record,projectName:JSON.parse(project.data).name,wbsTitle:wbs?JSON.parse(wbs.data).title:record.snapshot.path?.at(-1)?.title||'历史施工部位',reviewState:permissions.review(record.id)?.state||'draft',originalFileCount:original.n,wordCount:words.n,byteCount:original.bytes+words.bytes});
        }
        if(maximum&&rows.length>=maximum)break;
      }return rows;
    },
    optionsFor(actor,pid){const projects=pid?[acl(actor,pid).project]:db.prepare('SELECT * FROM engineering_projects ORDER BY created_at DESC,id').all(),wbs=[];for(const project of projects){permissions.requireAction(actor,project.id,'read');for(const node of db.prepare('SELECT id,data FROM engineering_wbs WHERE project_id=? ORDER BY created_at,id').all(project.id)){if(Object.keys(siteRecordCategories).some(category=>permissions.can(actor,project.id,'read',{category,wbsId:node.id})))wbs.push({id:node.id,title:JSON.parse(node.data).title,projectId:project.id});}}return {projects:projects.map(p=>({id:p.id,name:JSON.parse(p.data).name})),wbs};},
    photoWordBasisFor(actor,record){
      const c={...acl(actor,record.project_id),record},context=snapshot(record.project_id,record.data,actor,record);
      if(!sameSiteContext(context,record.snapshot))fail(409,'施工部位或任务归属已变化，请核对资料后重新打包');
      return hash(JSON.stringify({basis:photoWordBasis(c),context,projectState:c.project.state,templateSha256:sitePhotoTemplateHash,layoutSha256:sitePhotoLayoutHash}));
    },
    generateCurrentPhotoWord(req,record){
      const base=req.path.startsWith('/api/mobile/')?'/api/mobile/engineering':'/api/engineering';
      const reader=photoWordReaders.get(base);if(!reader)fail(503,'照片表格服务尚未就绪');
      const scoped={actor:req.actor,headers:req.headers,path:base+'/projects/'+record.project_id+'/site-records/'+record.id+'/photo-table',params:{pid:record.project_id,rid:record.id}};
      return reader(scoped,{version:record.version},null,true,'',true);
    },
    filesFor:files,exportsFor:wordExports,originalPath:finalPath,
    wordBytes(rid,eid){const row=db.prepare('SELECT document FROM engineering_site_word_exports WHERE record_id=? AND id=?').get(rid,eid);if(!row)fail(503,'Word历史版本缺失，资料包未生成');return Buffer.from(row.document);},
  });
  for (const [base, authorize] of [['/api/engineering', auth], ['/api/mobile/engineering', mobileAuth]]) {
    const route = base + '/projects/:pid/site-records', key = req => req.params.pid + ':site-records:' + (req.params.rid || 'new');
    templates.mount(app,route,authorize,writer);
    permissions.mount(app,base,authorize,writer);
    batches.mount(app,base,authorize,writer);
    // Own submitted sources only. Unassigned legacy reports require an explicit project choice.
    app.get(base+'/projects/:pid/site-daily-filings',authorize,(req,res)=>{
      const c=access(req),q=z.object({scope:z.enum(['project','unassigned']).default('project'),limit:z.coerce.number().int().min(1).max(50).default(20),offset:z.coerce.number().int().min(0).max(1000000).default(0)}).strict().parse(req.query);
      const sourceScope=documentScope('daily','d',q.scope==='project'?c.project.id:undefined);const clause="d.author_id=? AND "+sourceScope.sql+" AND NOT EXISTS(SELECT 1 FROM engineering_site_records r WHERE json_extract(r.data,'$.dailyReportId')=d.id)",args=[req.actor.id,...sourceScope.args];
      const result=store.transaction(()=>({items:db.prepare("SELECT d.id,d.author_id AS authorId,d.author_name AS authorName,d.project_name AS projectName,d.region,d.report_date AS reportDate,d.number,d.photo_count AS photoCount,d.created_at AS createdAt,d.document_sha256 AS documentSha256,json_extract(d.data,'$.projectId') AS projectId,json_extract(d.data,'$.sections[0].name') AS sectionName FROM daily_reports d WHERE "+clause+" ORDER BY d.created_at DESC,d.id DESC LIMIT ? OFFSET ?").all(...args,q.limit,q.offset),total:db.prepare('SELECT COUNT(*) n FROM daily_reports d WHERE '+clause).get(...args).n,limit:q.limit,offset:q.offset,scope:q.scope}));
      res.set('Cache-Control','private, no-store').json(result);
    });
    app.get(base+'/projects/:pid/site-daily-filings/requests/:requestId',authorize,(req,res)=>{
      const c=acl(req.actor,req.params.pid),requestId=uuid.parse(req.params.requestId),q=z.object({dailyReportId:uuid}).strict().parse(req.query);
      // Never expose another actor's request or an out-of-scope record ID.
      const source=db.prepare('SELECT id FROM daily_reports WHERE id=? AND author_id=?').get(q.dailyReportId,req.actor.id);if(!source)fail(404,'原日报不存在或未授权');
      const old=db.prepare('SELECT result FROM engineering_requests WHERE actor_id=? AND request_id=?').get(req.actor.id,requestId),result=old?JSON.parse(old.result):null;
      const row=result?.id?parseRecord(db.prepare('SELECT * FROM engineering_site_records WHERE project_id=? AND id=?').get(c.project.id,result.id)):null;
      if(!row||row.data.dailyReportId!==q.dailyReportId)return res.set('Cache-Control','private, no-store').json({status:'not_found'});
      const visible=permissions.can(req.actor,c.project.id,'read',row.data,row.created_by);
      res.set('Cache-Control','private, no-store').json(visible?{status:'confirmed',id:row.id,state:row.state}:{status:'confirmed_restricted'});
    });
    function independent(c,userId,submitter){return userId!==submitter&&userId!==c.record.created_by&&userId!==permissions.handler(c.record.id)?.user_id&&!db.prepare("SELECT 1 FROM engineering_site_events WHERE record_id=? AND actor_id=? AND action IN ('site_record_edit','site_file_start','site_file_complete','site_file_step','site_file_remove') LIMIT 1").get(c.record.id,userId);}
    function contextCorrection(c){return ['submitted','approved'].includes(permissions.review(c.record.id)?.state)?'施工部位或任务归属已变化，请先退回补充，再核对草稿并重新提交':'施工部位或任务归属已变化，请核对修改草稿后保存';}
    function evidence(c){return hash(JSON.stringify({data:c.record.data,snapshot:c.record.snapshot,files:files(c.record.id).filter(f=>!f.removed_at).map(f=>({id:f.id,sha256:f.sha256,bytes:f.byte_count,step:f.step_id,representative:f.representative}))}));}
    // Keep the generated table bound to the exact evidence read before asynchronous image conversion.
    function checkPhotoWordBasis(c,basis){if(basis&&photoWordBasis(c)!==basis)fail(409,'照片及工序依据已变化，请刷新核对后重新操作');}
    function ready(c,actor){
      if(c.project.state!=='active'||c.record.state!=='draft')fail(409,'仅施工中的资料草稿可以提交复核');
      const fs=files(c.record.id).filter(f=>!f.removed_at);
      if(!fs.length&&!(c.record.data.supervision))fail(409,'至少上传一份有效原件后才能提交复核');
      if(scanImageRecord(c.record.data)&&(!fs.length||fs.some(f=>!imageMime(f.mime))))fail(409,'此类资料提交复核须有有效图片');
      if(isStepCategory(c.record.data.category)&&fs.some(f=>!f.step_id))fail(409,'请先为每份照片或视频选择所属工序');
      if(c.record.data.supervision&&supervisionMissing(c.record.data.supervision).length)fail(400,'监理日报正文尚未完整');
      if(db.prepare("SELECT 1 FROM engineering_site_uploads WHERE record_id=? AND state='uploading'").get(c.record.id))fail(409,'请先完成或取消所有待上传原件');
      if(!sameSiteContext(snapshot(c.project.id,c.record.data,actor,c.record),c.record.snapshot))fail(409,contextCorrection(c));
      for(const f of fs){const p=finalPath(f.id);if(!existsSync(p)||lstatSync(p).isSymbolicLink()||statSync(p).size!==f.byte_count||fileHash(p)!==f.sha256)fail(503,'原件存储或校验异常，不能提交复核');}
    }
    function checkApproval(c,actor){if(!permissions.enabled(c.project.id))return;permissions.requireAction(actor,c.project.id,'archive',c.record.data,c.record.created_by);const v=permissions.review(c.record.id);if(v?.state!=='approved'||v.evidence_hash!==evidence(c))fail(409,'资料须经独立复核通过后才能归档');}
    app.get(route+'/:rid/handlers',authorize,(req,res)=>{const c=access(req);permissions.requireAction(req.actor,c.project.id,'handoff',c.record.data,c.record.created_by);const users=db.prepare("SELECT id,name,role,active FROM users WHERE active=1 AND (role='admin' OR id IN (SELECT user_id FROM engineering_members WHERE project_id=?))").all(c.project.id).filter(u=>permissions.can(u,c.project.id,'read',c.record.data,c.record.created_by)&&permissions.can(u,c.project.id,'editOwn',c.record.data,c.record.created_by)).map(u=>({id:u.id,name:u.name}));res.set('Cache-Control','private, no-store').json(users);});
    for(const operation of ['handoff','reviewer'])app.post(route+'/:rid/'+operation,authorize,writer,(req,res)=>{
      const b=schemaVersion.extend({userId:uuid,reason:z.string().trim().min(1).max(1000)}).strict().parse(req.body);
      res.json(mutate(req,b,key(req)+':'+operation,c=>permissions.requireAction(req.actor,c.project.id,'handoff',c.record.data,c.record.created_by),c=>{
        checkVersion(c.record,b.version);if(c.project.state!=='active'||c.record.state!=='draft')fail(409,'仅施工中的未归档资料可交接或改派');
        const u=db.prepare('SELECT id,name,role,active FROM users WHERE id=? AND active=1').get(b.userId);if(!u)fail(400,'接收人不存在或已停用');permissions.requireAction(u,c.project.id,'read',c.record.data,c.record.created_by);
        const v=permissions.review(c.record.id),oldHandler=permissions.handler(c.record.id)?.user_id||c.record.created_by;
        if(operation==='reviewer'){
          if(!['submitted','approved'].includes(v?.state))fail(409,'仅待复核或未归档已通过资料可以改派');if(!independent(c,u.id,v.submitted_by))fail(403,'复核人与提交人、原创建人必须分离');permissions.requireAction(u,c.project.id,'review',c.record.data,c.record.created_by);if(v.evidence_hash!==evidence(c))fail(409,'资料依据已变化，请核对后重新提交');
          db.prepare("UPDATE engineering_site_reviews SET reviewer_id=?,state='submitted',reviewed_by=NULL,reviewed_at=NULL,note=? WHERE record_id=?").run(u.id,b.reason,c.record.id);
        }else{
          if(['submitted','approved'].includes(v?.state))fail(409,'已提交或通过复核的资料不能改写，请先办理退回');permissions.requireAction(u,c.project.id,'editOwn',c.record.data,c.record.created_by);
          if(db.prepare("SELECT 1 FROM engineering_site_uploads WHERE record_id=? AND state='uploading'").get(c.record.id))fail(409,'请先完成或注明原因取消待上传原件，再交接');
          db.prepare('INSERT INTO engineering_site_handlers VALUES(?,?,?,?,?) ON CONFLICT(record_id) DO UPDATE SET user_id=excluded.user_id,assigned_by=excluded.assigned_by,assigned_at=excluded.assigned_at,reason=excluded.reason').run(c.record.id,u.id,req.actor.id,now(),b.reason);
        }
        bump(c.record.id);event(req,c.record.id,operation==='reviewer'?'site_review_reassign':'site_record_handoff',JSON.stringify({from:operation==='reviewer'?v.reviewer_id:oldHandler,to:u.id,name:u.name,reason:b.reason,...(operation==='reviewer'?{previousReviewState:v.state,approvalInvalidated:v.state==='approved',reviewState:'submitted'}:{}),delegatedImportedCopies:!!c.record.data.dailyReportId}));return{id:c.record.id,version:c.record.version+1};
      }));
    });
    app.post(route+'/:rid/submit',authorize,writer,async(req,res)=>{
      const b=schemaVersion.extend({reviewerId:uuid,note:z.string().trim().max(1000).default('')}).strict().parse(req.body);
      let photoBasis;
      if(!db.prepare('SELECT 1 FROM engineering_requests WHERE actor_id=? AND request_id=?').get(req.actor.id,b.requestId)){
        const initial=currentAccess(req,true);permissions.requireAction(req.actor,initial.project.id,'submit',initial.record.data,initial.record.created_by);editable(initial,req.actor);checkVersion(initial.record,b.version);ready(initial,req.actor);
        if(initial.record.data.category==='work_photos')photoBasis=(await createPhotoWord(req,{requestId:b.requestId,version:b.version},key(req)+':preflight',true,'submit')).basisFingerprint;
      }
      res.json(mutate(req,b,key(req)+':submit',c=>{permissions.requireAction(req.actor,c.project.id,'submit',c.record.data,c.record.created_by);if(!owner(c,req.actor))fail(403,'只能提交本人或获授权代办的资料');},c=>{
        if(!permissions.enabled(c.project.id))fail(409,'请项目经理先启用人员权限与审核');editable(c,req.actor);checkVersion(c.record,b.version);checkPhotoWordBasis(c,photoBasis);ready(c,req.actor);
        if(!independent(c,b.reviewerId,req.actor.id))fail(403,'复核人与提交人、资料创建人必须分离');
        const reviewer=db.prepare('SELECT id,name,role,active FROM users WHERE id=? AND active=1').get(b.reviewerId);if(!reviewer)fail(400,'复核人员已停用或不存在');
        permissions.requireAction(reviewer,c.project.id,'read',c.record.data,c.record.created_by);permissions.requireAction(reviewer,c.project.id,'review',c.record.data,c.record.created_by);
        db.prepare("INSERT INTO engineering_site_reviews(record_id,state,reviewer_id,submitted_by,submitted_at,reviewed_by,reviewed_at,note,evidence_hash) VALUES(?,'submitted',?,?,?,NULL,NULL,?,?) ON CONFLICT(record_id) DO UPDATE SET state='submitted',reviewer_id=excluded.reviewer_id,submitted_by=excluded.submitted_by,submitted_at=excluded.submitted_at,reviewed_by=NULL,reviewed_at=NULL,note=excluded.note,evidence_hash=excluded.evidence_hash").run(c.record.id,reviewer.id,req.actor.id,now(),b.note,evidence(c));
        bump(c.record.id);event(req,c.record.id,'site_review_submit',JSON.stringify({reviewerId:reviewer.id,reviewerName:reviewer.name,note:b.note,delegatedImportedCopies:!!c.record.data.dailyReportId,evidenceHash:evidence(c),sourceVersion:c.record.version}));return{id:c.record.id,version:c.record.version+1};
      }));
    });
    app.post(route+'/:rid/review',authorize,writer,async(req,res)=>{
      const b=schemaVersion.extend({decision:z.enum(['approve','return']),reason:z.string().trim().min(1).max(1000)}).strict().parse(req.body);
      let photoBasis;
      if(b.decision==='approve'&&!db.prepare('SELECT 1 FROM engineering_requests WHERE actor_id=? AND request_id=?').get(req.actor.id,b.requestId)){
        const initial=currentAccess(req,true),v=permissions.review(initial.record.id);permissions.requireAction(req.actor,initial.project.id,'review',initial.record.data,initial.record.created_by);if(v?.reviewer_id!==req.actor.id||!independent(initial,req.actor.id,v.submitted_by))fail(403,'仅指定独立复核人员可以办理');checkVersion(initial.record,b.version);if(v.state!=='submitted')fail(409,'当前资料不在待复核状态');ready(initial,req.actor);
        if(initial.record.data.category==='work_photos')photoBasis=(await createPhotoWord(req,{requestId:b.requestId,version:b.version},key(req)+':preflight',true,'review')).basisFingerprint;
      }
      res.json(mutate(req,b,key(req)+':review',c=>{permissions.requireAction(req.actor,c.project.id,'review',c.record.data,c.record.created_by);const v=permissions.review(c.record.id);if(v?.reviewer_id!==req.actor.id||!independent(c,req.actor.id,v.submitted_by))fail(403,'仅指定独立复核人员可以办理');},c=>{
        const v=permissions.review(c.record.id);checkVersion(c.record,b.version);if(c.project.state!=='active'||c.record.state!=='draft'||!(b.decision==='return'?['submitted','approved'].includes(v?.state):v?.state==='submitted'))fail(409,'仅待复核或未归档已通过资料可以退回补充');if(b.decision==='approve'){checkPhotoWordBasis(c,photoBasis);if(v.evidence_hash!==evidence(c))fail(409,'提交依据已变化，请先退回补充再重新提交');ready(c,req.actor);}
        db.prepare('UPDATE engineering_site_reviews SET state=?,reviewed_by=?,reviewed_at=?,note=? WHERE record_id=?').run(b.decision==='approve'?'approved':'returned',req.actor.id,now(),b.reason,c.record.id);bump(c.record.id);event(req,c.record.id,b.decision==='approve'?'site_review_approve':'site_review_return',JSON.stringify({reason:b.reason,evidenceHash:v.evidence_hash,sourceVersion:c.record.version,...(b.decision==='return'?{previousReviewState:v.state,approvalInvalidated:v.state==='approved'}:{})}));return{id:c.record.id,version:c.record.version+1};
      }));
    });

    app.get(route, authorize, (req, res) => {
      const c = access(req), q = z.object({ category: z.enum(Object.keys(siteRecordCategories)).optional(), batchId:uuid.or(z.literal('unassigned')).optional(), state: z.enum(['draft', 'archived', 'withdrawn']).optional(), wbsId: uuid.optional(), from: date.optional(), to: date.optional(), q: z.string().trim().max(160).optional(), inspection: z.literal('1').optional(), format: z.literal('xlsx').optional(), queue:z.enum(['assigned','created','handling']).optional(),reviewState:z.enum(['draft','submitted','approved','returned']).optional(), limit: z.coerce.number().int().min(1).max(200).default(100), offset: z.coerce.number().int().min(0).max(1000000).default(0) }).strict().parse(req.query);
      if (q.from && q.to && q.from > q.to) fail(400, '开始日期不能晚于结束日期');
      if(q.batchId && q.batchId!=='unassigned')batches.get(c.project.id,q.batchId);
      const sourceScope=permissions.sourceClause(req.actor,c.project.id);
      const where = ['project_id=?',"(json_extract(data,'$.dailyReportId') IS NULL OR EXISTS(SELECT 1 FROM daily_reports d WHERE d.id=json_extract(engineering_site_records.data,'$.dailyReportId') AND (?='admin' OR d.author_id=?)) OR ("+sourceScope.sql+"))"], args = [c.project.id,req.actor.role,req.actor.id,...sourceScope.args];
      const scope=permissions.clause(req.actor,c.project.id);where.push('('+scope.sql+')');args.push(...scope.args);if(q.format)permissions.requireAction(req.actor,c.project.id,'exportRegister');
      for (const [field, value] of [['category', q.category], ['wbsId', q.wbsId]]) if (value) { where.push(`json_extract(data,'$.${field}')=?`); args.push(value); }
      if(q.batchId){where.push("COALESCE(json_extract(data,'$.batchId'),'')=?");args.push(q.batchId==='unassigned'?'':q.batchId);}
      if (q.state) { where.push('state=?'); args.push(q.state); }
      if (q.from) { where.push("json_extract(data,'$.recordDate')>=?"); args.push(q.from); }
      if (q.to) { where.push("json_extract(data,'$.recordDate')<=?"); args.push(q.to); }
      if(q.queue==='created'){where.push('created_by=?');args.push(req.actor.id);}
      if(q.queue==='handling'){where.push("COALESCE((SELECT h.user_id FROM engineering_site_handlers h WHERE h.record_id=engineering_site_records.id),created_by)=?");args.push(req.actor.id);}
      if(q.queue==='assigned'){where.push("EXISTS(SELECT 1 FROM engineering_site_reviews rv WHERE rv.record_id=engineering_site_records.id AND rv.reviewer_id=? AND rv.state='submitted') AND state='draft'");args.push(req.actor.id);}
      if(q.reviewState){where.push("COALESCE((SELECT state FROM engineering_site_reviews rv WHERE rv.record_id=engineering_site_records.id),'draft')=?");args.push(q.reviewState);}
      if (q.q) { where.push("instr(lower(json_extract(data,'$.title')),lower(?))>0"); args.push(q.q); }
      // One synchronous read transaction freezes list, checks and workbook against the
      // same project/source ACL and filters. Binary original/Word bytes are never read.
      const result=store.transaction(()=>{
        const clause=where.join(' AND '), total=db.prepare('SELECT COUNT(*) n FROM engineering_site_records WHERE '+clause).get(...args).n;
        const query='SELECT * FROM engineering_site_records WHERE '+clause+" ORDER BY json_extract(data,'$.recordDate') DESC,created_at DESC,id DESC";
        const records=db.prepare(query+' LIMIT ? OFFSET ?').all(...args,q.limit,q.offset).map(parseRecord);
        const filters=Object.fromEntries(['category','state','wbsId','from','to','q','batchId'].filter(k=>q[k]).map(k=>[k,q[k]]));
        let inspection,register;
        if(q.inspection||q.format){
          const count=db.prepare('SELECT COUNT(*) n FROM engineering_site_files WHERE record_id IN (SELECT id FROM engineering_site_records WHERE '+clause+')').get(...args).n;
          const tooLarge=total>siteRegisterLimits.records||count>siteRegisterLimits.files;
          if(tooLarge){
            const error='检查与导出最多2000份资料、10000份原件，请缩小分类、部位或日期范围；没有生成截断台账。';
            if(q.format)fail(413,error);
            inspection={error};
          }else{
            const rows=db.prepare(query).all(...args).map(parseRecord).map(r=>({...r,review:permissions.review(r.id),files:files(r.id),
              pendingUploads:db.prepare("SELECT COUNT(*) n FROM engineering_site_uploads WHERE record_id=? AND state='uploading'").get(r.id).n,
              wordCount:db.prepare('SELECT COUNT(*) n FROM engineering_site_word_exports WHERE record_id=?').get(r.id).n,
              latestWord:db.prepare('SELECT name,source_version,sha256 FROM engineering_site_word_exports WHERE record_id=? ORDER BY sequence DESC LIMIT 1').get(r.id)}));
            const full=inspectSiteRecords(rows,siteRecordCategories),pageIds=new Set(records.map(r=>r.id));
            inspection={...full,checks:Object.fromEntries(Object.entries(full.checks).filter(([id])=>pageIds.has(id))),exportedAt:now()};
            if(q.format)register={project:{id:c.project.id,data:{name:JSON.parse(c.project.data).name}},records:rows,categories:siteRecordCategories,filters,actorName:req.actor.name,exportedAt:inspection.exportedAt};
          }
        }
        return {records:records.map(r=>({...r,review:permissions.review(r.id)})),total,limit:q.limit,offset:q.offset,inspection,register};
      });
      res.setHeader('Cache-Control','private, no-store');
      if(result.register){
        const bytes=buildSiteRegister(result.register);
        res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition',`attachment; filename="site-record-register.xlsx"; filename*=UTF-8''${encodeURIComponent('施工资料台账.xlsx')}`);
        res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Length',bytes.length);res.send(bytes);return;
      }
      const {register,...view}=result;
      res.json({...view,limits:siteRecordLimits,categories:siteRecordCategories,permission:permissions.permission(req.actor,c.project.id),writable:c.project.state==='active'&&['admin','manager','engineer','finance'].includes(c.role)&&permissions.can(req.actor,c.project.id,'create')});
    });
    app.post(route, authorize, writer, (req, res) => {
      const b = z.object({ requestId: uuid, data: dataSchema }).strict().parse(req.body);
      if(!b.data.dailyReportId&&!b.data.supervision)b.data.uploadPolicy='seven_v1';else if(b.data.uploadPolicy)fail(400,'扫描图入口与辅助在线/原日报入口不能混用');
      const result = mutate(req, b, key(req) + ':create', () => {if(b.data.dailyReportId)dailySource(db,req.actor,b.data.dailyReportId);}, (c,undo) => {
        if (c.project.state !== 'active') fail(409, '项目未在施工中，不能新增施工资料');
        permissions.requireAction(req.actor,c.project.id,'create',b.data,req.actor.id);
        if(b.data.batchId)batches.capture(c.project.id,b.data);
        if(b.data.dailyReportId){
          requireDocumentProject(db,'daily',b.data.dailyReportId,c.project.id);
          const old=db.prepare("SELECT id,version,state FROM engineering_site_records WHERE project_id=? AND state<>'withdrawn' AND json_extract(data,'$.dailyReportId')=? AND json_extract(data,'$.wbsId')=? AND COALESCE(json_extract(data,'$.taskId'),'')=? AND COALESCE(json_extract(data,'$.batchId'),'')=? ORDER BY created_at,id LIMIT 1").get(c.project.id,b.data.dailyReportId,b.data.wbsId,b.data.taskId,b.data.batchId||'');
          if(old)return {...old,unchanged:true};
        }
        const source=b.data.dailyReportId?dailySource(db,req.actor,b.data.dailyReportId,true):null;
        if(source){const linked=JSON.parse(db.prepare('SELECT data FROM daily_reports WHERE id=?').get(b.data.dailyReportId).data).projectId;if(linked&&linked!==c.project.id)fail(409,'原日报属于其他项目，不能归入当前项目');}
        if(source && b.data.recordDate!==source.evidence.reportDate)fail(400,'资料日期必须与原施工日报一致');
        if(b.data.photoRecordId){const parent=parseRecord(db.prepare('SELECT * FROM engineering_site_records WHERE project_id=? AND id=?').get(c.project.id,b.data.photoRecordId));if(parent)permissions.requireAction(req.actor,c.project.id,'read',parent.data,parent.created_by);}
        const s = snapshot(c.project.id, b.data, req.actor), rid = randomUUID(), at = now();
        db.prepare('INSERT INTO engineering_site_records(id,project_id,state,version,data,snapshot,created_by,creator_name,created_at,updated_at) VALUES(?,?,\'draft\',1,?,?,?,?,?,?)').run(rid, c.project.id, JSON.stringify(b.data), JSON.stringify(s), req.actor.id, req.actor.name, at, at);
        if(source){
          for(const f of source.originals){
            const fid=randomUUID(),p=finalPath(fid),fd=openSync(p,'wx',0o600);undo.push(()=>{if(existsSync(p))unlinkSync(p);});
            try{let offset=0;while(offset<f.bytes.length)offset+=writeSync(fd,f.bytes,offset,f.bytes.length-offset,offset);fsyncSync(fd);}finally{closeSync(fd);}
            signature(p,f.ext,f.bytes.length);
            db.prepare("INSERT INTO engineering_site_uploads(id,record_id,project_id,name,mime,byte_count,sha256,offset,state,file_id,created_by,created_name,session_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'completed',?,?,?,?,?,?)").run(fid,rid,c.project.id,f.name,f.mime,f.bytes.length,f.sha256,f.bytes.length,fid,req.actor.id,req.actor.name,session(req),at,at);
            db.prepare('INSERT INTO engineering_site_files(id,record_id,project_id,upload_id,name,mime,byte_count,sha256,created_by,created_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(fid,rid,c.project.id,fid,f.name,f.mime,f.bytes.length,f.sha256,req.actor.id,req.actor.name,at);
          }
          event(req,rid,'site_daily_import','从已提交施工日报保存Word及原图；原作者权限保持');
        }
        event(req, rid, 'site_record_create', '新建施工资料草稿'); return { id: rid, state: 'draft', version: 1 };
      }); res.status(result.replayed ? 200 : 201).json(result);
    });
    app.get(route + '/:rid', authorize, (req, res) => {
      const c = access(req), writable = c.project.state === 'active' && c.record.state === 'draft' && owner(c, req.actor) && ['admin', 'manager', 'engineer', 'finance'].includes(c.role); session(req);
      const uploads = db.prepare("SELECT * FROM engineering_site_uploads WHERE record_id=? AND (created_by=? OR (?=1 AND state='uploading')) ORDER BY created_at,id").all(c.record.id, req.actor.id, manager(c) ? 1 : 0).map(u => uploadPublic(u, c.record.version, c, req.actor));
      const events = db.prepare('SELECT * FROM engineering_site_events WHERE record_id=? ORDER BY created_at,id').all(c.record.id).map(e => ({ ...e, data: JSON.parse(e.data), snapshot: JSON.parse(e.snapshot) }));
      let related=[],relatedIsCandidate=false;
      if(c.record.data.category==='work_videos' && c.record.data.photoRecordId)related=db.prepare("SELECT * FROM engineering_site_records WHERE project_id=? AND id=? AND state<>'withdrawn'").all(c.project.id,c.record.data.photoRecordId).map(parseRecord);
      else if(c.record.data.category==='work_photos')related=db.prepare("SELECT * FROM engineering_site_records WHERE project_id=? AND state<>'withdrawn' AND json_extract(data,'$.photoRecordId')=? ORDER BY created_at DESC LIMIT 101").all(c.project.id,c.record.id).map(parseRecord);
      else if(c.record.data.category==='work_videos'&&!c.record.data.uploadPolicy)related=[];
      if(related.length>100)fail(413,'对应视频超过100份，请通过资料列表筛选查看');
      if(!related.length&&!c.record.data.uploadPolicy&&!c.record.data.photoRecordId&&isStepCategory(c.record.data.category)){relatedIsCandidate=true;related=db.prepare("SELECT * FROM engineering_site_records WHERE project_id=? AND id<>? AND state<>'withdrawn' AND json_extract(data,'$.category')=? AND json_extract(data,'$.wbsId')=? AND COALESCE(json_extract(data,'$.taskId'),'')=? AND COALESCE(json_extract(data,'$.batchId'),'')=? AND json_extract(data,'$.uploadPolicy') IS NULL AND COALESCE(json_extract(data,'$.photoRecordId'),'')='' ORDER BY created_at DESC LIMIT 30").all(c.project.id,c.record.id,c.record.data.category==='work_photos'?'work_videos':'work_photos',c.record.data.wbsId,c.record.data.taskId,c.record.data.batchId||'').map(parseRecord);}

      related=related.filter(r=>permissions.visible(req.actor,c.project.id,r));
      const relatedMismatch=!relatedIsCandidate&&related.some(r=>r.data.recordDate!==c.record.data.recordDate||r.data.wbsId!==c.record.data.wbsId||(r.data.taskId||'')!==(c.record.data.taskId||'')||(r.data.batchId||'')!==(c.record.data.batchId||''));
      const enabled=permissions.enabled(c.project.id),review=permissions.review(c.record.id),locked=enabled&&['submitted','approved'].includes(review?.state);
      const independentReviewer=enabled&&c.project.state==='active'&&c.record.state==='draft'&&review?.reviewer_id===req.actor.id&&independent(c,req.actor.id,review.submitted_by)&&permissions.can(req.actor,c.project.id,'review',c.record.data,c.record.created_by);
      const capabilities={submit:enabled&&!locked&&writable&&permissions.can(req.actor,c.project.id,'submit',c.record.data,c.record.created_by),review:!!independentReviewer&&review?.state==='submitted',return:!!independentReviewer&&['submitted','approved'].includes(review?.state),archive:enabled&&c.project.state==='active'&&c.record.state==='draft'&&review?.state==='approved'&&permissions.can(req.actor,c.project.id,'archive',c.record.data,c.record.created_by),download:permissions.can(req.actor,c.project.id,'download',c.record.data,c.record.created_by)};
      const reviewerCandidates=enabled&&(capabilities.submit||permissions.can(req.actor,c.project.id,'handoff',c.record.data,c.record.created_by))?db.prepare("SELECT id,name,role,active FROM users WHERE active=1 AND (role='admin' OR id IN (SELECT user_id FROM engineering_members WHERE project_id=?))").all(c.project.id).filter(u=>independent(c,u.id,review?.submitted_by||req.actor.id)&&permissions.can(u,c.project.id,'read',c.record.data,c.record.created_by)&&permissions.can(u,c.project.id,'review',c.record.data,c.record.created_by)).map(u=>({id:u.id,name:u.name})):[];
      res.json({ handler:permissions.handler(c.record.id),review,reviewEnabled:enabled,capabilities:{...capabilities,handoff:enabled&&c.project.state==='active'&&c.record.state==='draft'&&permissions.can(req.actor,c.project.id,'handoff',c.record.data,c.record.created_by)},reviewerCandidates,record: c.record, files: files(c.record.id), uploads, events, exports:wordExports(c.record.id), related, relatedIsCandidate, relatedMismatch, steps:siteWorkSteps, version: c.record.version, writable:writable&&!locked, canGenerate: c.project.state==='active' && ['draft','archived'].includes(c.record.state) && (enabled?capabilities.download:owner(c,req.actor)) && c.role!=='viewer' && (c.record.data.category==='work_photos'||c.record.data.category==='supervision_daily'&&!!c.record.data.supervision), canWithdraw: c.project.state === 'active' && ['draft', 'archived'].includes(c.record.state) && (enabled?permissions.can(req.actor,c.project.id,'withdraw',c.record.data,c.record.created_by):owner(c,req.actor)) && c.role !== 'viewer', limits: siteRecordLimits, ...usage(c.record.id) });
    });
    app.put(route + '/:rid', authorize, writer, (req, res) => {
      const b = z.object({ requestId: uuid, version, data: dataSchema }).strict().parse(req.body);
      res.json(mutate(req, b, key(req) + ':edit', c => { if (!owner(c, req.actor)) fail(403, '无权修改此资料'); }, c => {
        editable(c, req.actor); checkVersion(c.record, b.version);permissions.requireAction(req.actor,c.project.id,'create',b.data,c.record.created_by);
        if(b.data.photoRecordId&&b.data.photoRecordId!==c.record.data.photoRecordId){const parent=parseRecord(db.prepare('SELECT * FROM engineering_site_records WHERE project_id=? AND id=?').get(c.project.id,b.data.photoRecordId));if(parent)permissions.requireAction(req.actor,c.project.id,'read',parent.data,parent.created_by);}
        if(b.data.uploadPolicy&&!c.record.data.uploadPolicy)fail(400,'历史资料上传规则不能直接更改');
        if(c.record.data.uploadPolicy)b.data.uploadPolicy=c.record.data.uploadPolicy;
        if(c.record.data.uploadPolicy && b.data.supervision)fail(400,'图片监理入口请上传图片；在线填写须从辅助入口新建');
        if(c.record.data.category==='work_photos' && db.prepare("SELECT 1 FROM engineering_site_records WHERE project_id=? AND state<>'withdrawn' AND json_extract(data,'$.photoRecordId')=?").get(c.project.id,c.record.id) && (b.data.category!=='work_photos'||b.data.wbsId!==c.record.data.wbsId||b.data.taskId!==c.record.data.taskId||(b.data.batchId||'')!==(c.record.data.batchId||'')||b.data.recordDate!==c.record.data.recordDate))fail(409,'已有补充视频关联此照片组，不能单独变更部位、任务、批次或日期；请先纠正或撤回关联视频，原件与历史保留');
        if((b.data.dailyReportId||'')!==(c.record.data.dailyReportId||''))fail(409,'原施工日报来源不能改写，请另建正确资料');
        if(b.data.dailyReportId && b.data.recordDate!==dailySource(db,req.actor,b.data.dailyReportId).evidence.reportDate)fail(400,'资料日期必须与原施工日报一致');
        if (b.data.category !== c.record.data.category && (usage(c.record.id).usedFiles || wordExports(c.record.id).length)) fail(409, '已有原件、待完成上传或Word历史，不能更改资料分类');
        if(c.record.data.supervision && !b.data.supervision && wordExports(c.record.id).length)fail(409,'已有监理Word历史，不能移除在线正文；可撤回并新建正确资料');
        if(!b.data.templateRef&&b.data.category===c.record.data.category&&c.record.data.templateRef)b.data.templateRef=c.record.data.templateRef;
        const s = snapshot(c.project.id, b.data, req.actor,c.record); db.prepare('UPDATE engineering_site_records SET data=?,snapshot=? WHERE id=?').run(JSON.stringify(b.data), JSON.stringify(s), c.record.id); bump(c.record.id); event(req, c.record.id, 'site_record_edit', '修改施工资料草稿'); return { id: c.record.id, version: c.record.version + 1, state: 'draft' };
      }));
    });
    app.post(route + '/:rid/archive', authorize, writer, async (req, res) => {
      const b = schemaVersion.extend({ note: z.string().trim().max(1000).default('') }).strict().parse(req.body);
      const candidate=access(req,true);
      checkApproval(candidate,req.actor);
      if(candidate.record.data.category==='work_photos'||candidate.record.data.category==='supervision_daily'&&candidate.record.data.supervision) {
        const h=hash(b.requestId+':archive-word'),requestId=h.slice(0,8)+'-'+h.slice(8,12)+'-4'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);
        await createWord(req,{requestId,version:b.version},key(req)+':word');
      }
      res.json(mutate(req, b, key(req) + ':archive', c => {checkApproval(c,req.actor);if(!permissions.enabled(c.project.id)&&!owner(c,req.actor))fail(403,'无权归档此资料');}, c => {
        if(c.project.state!=='active'||c.record.state!=='draft')fail(409,'资料或项目已锁定'); checkVersion(c.record, b.version);
        const activeFiles = files(c.record.id).filter(f => !f.removed_at);
        if(c.record.data.dailyReportId){const source=retainedDaily(c.project.id,c.record.data,req.actor,true);if(source.originals.some(f=>!activeFiles.some(a=>a.sha256===f.sha256)))fail(503,'归入的施工日报原件不完整，不能归档');}
        if(scanImageRecord(c.record.data)&&(!activeFiles.length||activeFiles.some(f=>!imageMime(f.mime))))fail(409,'此类资料归档须有当前有效图片');
        if (!activeFiles.length && !(c.record.data.category==='supervision_daily'&&c.record.data.supervision)) fail(409, '至少上传一份有效原件后才能归档');
        if (isStepCategory(c.record.data.category) && activeFiles.some(f => !f.step_id)) fail(409, '请先为每份照片或视频选择所属工序，再归档');
        if (db.prepare("SELECT 1 FROM engineering_site_uploads WHERE record_id=? AND state='uploading'").get(c.record.id)) fail(409, '请先完成或取消所有待上传原件');
        const fresh = snapshot(c.project.id, c.record.data, req.actor,c.record);
        if (!sameSiteContext(fresh,c.record.snapshot)) fail(409, contextCorrection(c));
        for (const f of activeFiles) {
          const p = finalPath(f.id); if (!existsSync(p) || lstatSync(p).isSymbolicLink() || statSync(p).size !== f.byte_count || fileHash(p) !== f.sha256) fail(503, '原件存储或校验异常，不能归档，请检查存储');
        }
        db.prepare("UPDATE engineering_site_records SET state='archived',archived_by=?,archived_name=?,archived_at=?,archive_note=? WHERE id=?").run(req.actor.id, req.actor.name, now(), b.note, c.record.id); bump(c.record.id); event(req, c.record.id, 'site_record_archive', b.note || '归档保存；不代表技术验收'); return { id: c.record.id, version: c.record.version + 1, state: 'archived' };
      }));
    });
    app.post(route + '/:rid/withdraw', authorize, writer, (req, res) => {
      const b = schemaVersion.extend({ reason: z.string().trim().min(1).max(1000) }).strict().parse(req.body);
      res.json(mutate(req, b, key(req) + ':withdraw', c => { if(permissions.enabled(c.project.id))permissions.requireAction(req.actor,c.project.id,'withdraw',c.record.data,c.record.created_by);else if (!owner(c, req.actor)) fail(403, '无权撤回此资料'); }, c => {
        if (c.project.state !== 'active' || !['draft', 'archived'].includes(c.record.state)) fail(409, '仅施工中项目的草稿或已归档资料可注明原因撤回'); checkVersion(c.record, b.version);
        if(c.record.data.category==='work_photos'&&db.prepare("SELECT 1 FROM engineering_site_records WHERE project_id=? AND state<>'withdrawn' AND json_extract(data,'$.photoRecordId')=?").get(c.project.id,c.record.id))fail(409,'仍有未撤回补充视频，请先处理视频再撤回照片组');
        if (db.prepare("SELECT 1 FROM engineering_site_uploads WHERE record_id=? AND state='uploading'").get(c.record.id)) fail(409, '请先完成或取消所有待上传原件，再撤回资料');
        db.prepare("UPDATE engineering_site_records SET state='withdrawn',withdrawn_by=?,withdrawn_name=?,withdrawn_at=?,withdraw_reason=? WHERE id=?").run(req.actor.id, req.actor.name, now(), b.reason, c.record.id); bump(c.record.id); event(req, c.record.id, 'site_record_withdraw', b.reason + '；原资料及原件保留'); return { id: c.record.id, version: c.record.version + 1, state: 'withdrawn' };
      }));
    });
    app.post(route + '/:rid/uploads', authorize, writer, (req, res) => {
      const b = schemaVersion.extend({ name: z.string().min(1).max(160), mime: z.string().max(100), byteCount: z.number().int().positive().max(siteRecordLimits.maxVideoBytes), sha256: z.string().regex(/^[0-9a-f]{64}$/), stepId: stepId.optional() }).strict().parse(req.body);
      const result = mutate(req, b, key(req) + ':upload:start', c => { if (!owner(c, req.actor)) fail(403, '无权上传此资料原件'); session(req); }, (c, undo) => {
        editable(c, req.actor); checkVersion(c.record, b.version); const m = fileMetadata(c.record.data.category, b,c.record.data), used = usage(c.record.id);
        if (b.stepId && !isStepCategory(c.record.data.category)) fail(400, '当前资料分类不使用施工工序');
        if (used.usedFiles >= siteRecordLimits.maxRecordFiles || used.usedBytes + b.byteCount > siteRecordLimits.maxRecordBytes) fail(409, '资料及历史原件合计最多 100 份、1 GiB，移除原件不能释放历史额度');
        if (db.prepare("SELECT 1 FROM engineering_site_files WHERE record_id=? AND sha256=? UNION ALL SELECT 1 FROM engineering_site_uploads WHERE record_id=? AND sha256=? AND state='uploading'").get(c.record.id, b.sha256, c.record.id, b.sha256)) fail(409, '此原件已上传或已有待完成上传，请恢复原上传');
        const uid = randomUUID(), at = now(), p = partPath(uid), fd = openSync(p, 'wx', 0o600); closeSync(fd); undo.push(() => { if (existsSync(p)) unlinkSync(p); });
        db.prepare("INSERT INTO engineering_site_uploads(id,record_id,project_id,name,mime,byte_count,sha256,offset,state,created_by,created_name,session_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,0,'uploading',?,?,?,?,?)").run(uid, c.record.id, c.project.id, m.name, m.mime, b.byteCount, b.sha256, req.actor.id, req.actor.name, session(req), at, at);
        if (b.stepId) db.prepare('UPDATE engineering_site_uploads SET step_id=? WHERE id=?').run(b.stepId,uid);
        bump(c.record.id); event(req, c.record.id, 'site_file_start', '开始上传原件'); return { id: uid, offset: 0, state: 'uploading', version: c.record.version + 1 };
      }); res.status(result.replayed ? 200 : 201).json(result);
    });
    app.get(route + '/:rid/uploads/:uid', authorize, (req, res) => { const c = access(req), u = upload(req, c); if (u.state === 'uploading' && !existsSync(finalPath(u.id))) reconcile(u); res.json(uploadPublic(u, c.record.version, c, req.actor)); });
    app.post(route + '/:rid/uploads/:uid/chunks', authorize, writer, (req, res) => {
      const b = z.object({ requestId: uuid, offset: z.number().int().min(0).max(siteRecordLimits.maxVideoBytes), base64: z.string().min(4).max(Math.ceil(siteRecordLimits.chunkBytes / 3) * 4) }).strict().parse(req.body);
      // Only a hash enters request receipts: never persist or log base64 payloads.
      if (b.base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.base64)) fail(400, '上传分片编码无效');
      const bytes = Buffer.from(b.base64, 'base64'); if (!bytes.length || bytes.length > siteRecordLimits.chunkBytes || bytes.toString('base64') !== b.base64) fail(400, '分片须为有效 Base64 且不超过 1 MiB');
      const chunkHash = hash(bytes), safeBody = { requestId: b.requestId, offset: b.offset, sha256: chunkHash, byteCount: bytes.length };
      res.json(mutate(req, safeBody, key(req) + ':upload:' + req.params.uid + ':chunk', c => { if (!owner(c, req.actor)) fail(403, '无权上传此资料'); upload(req, c); }, (c, undo) => {
        editable(c, req.actor); const u = upload(req, c); if (u.state !== 'uploading') fail(409, '上传已完成或已取消');
        const old = db.prepare('SELECT * FROM engineering_site_chunks WHERE upload_id=? AND offset=?').get(u.id, b.offset);
        if (old) { if (old.sha256 !== chunkHash || old.byte_count !== bytes.length) fail(409, '已确认分片不能改写'); return { id: u.id, offset: u.offset, byteCount: u.byte_count, duplicate: true }; }
        if (b.offset !== u.offset || b.offset + bytes.length > u.byte_count) fail(409, '分片位置或长度与服务器确认进度不一致');
        if (bytes.length !== siteRecordLimits.chunkBytes && b.offset + bytes.length !== u.byte_count) fail(400, '除最后一片外，每个分片须为 1 MiB');
        const p = reconcile(u), fd = openSync(p, 'r+'); undo.push(() => truncateSync(p, u.offset));
        try { let sent = 0; while (sent < bytes.length) sent += writeSync(fd, bytes, sent, bytes.length - sent, u.offset + sent); fsyncSync(fd); } finally { closeSync(fd); }
        db.prepare('INSERT INTO engineering_site_chunks VALUES(?,?,?,?)').run(u.id, u.offset, bytes.length, chunkHash);
        db.prepare('UPDATE engineering_site_uploads SET offset=?,updated_at=? WHERE id=?').run(u.offset + bytes.length, now(), u.id);
        return { id: u.id, offset: u.offset + bytes.length, byteCount: u.byte_count };
      }));
    });
    app.post(route + '/:rid/uploads/:uid/complete', authorize, writer, (req, res) => {
      const b = z.object({ requestId: uuid }).strict().parse(req.body);
      res.json(mutate(req, b, key(req) + ':upload:' + req.params.uid + ':complete', c => { if (!owner(c, req.actor)) fail(403, '无权完成此上传'); upload(req, c); }, (c, undo) => {
        editable(c, req.actor); const u = upload(req, c);
        if (u.state === 'completed') return { id: u.file_id, uploadId: u.id, state: 'completed', version: c.record.version, sha256: u.sha256 };
        if (u.state !== 'uploading' || u.offset !== u.byte_count) fail(409, '原件尚未全部上传或已取消');
        const m = fileMetadata(c.record.data.category, { name: u.name, mime: u.mime, byteCount: u.byte_count },c.record.data);
        // File identity equals upload identity. An interrupted rename is recoverable without guessing opaque paths.
        const fid = u.id, target = finalPath(fid);
        if (existsSync(target)) {
          if (lstatSync(target).isSymbolicLink() || statSync(target).size !== u.byte_count || fileHash(target) !== u.sha256) fail(503, '已保存原件冲突，请检查存储');
          signature(target, m.ext, u.byte_count);
        } else {
          const p = reconcile(u); if (fileHash(p) !== u.sha256) fail(409, '原件 SHA-256 校验不一致；请取消后重新选择原件'); signature(p, m.ext, u.byte_count);
          renameSync(p, target); undo.push(() => { if (existsSync(target) && !existsSync(p)) renameSync(target, p); });
        }
        const at = now(); db.prepare('INSERT INTO engineering_site_files(id,record_id,project_id,upload_id,name,mime,byte_count,sha256,created_by,created_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(fid, c.record.id, c.project.id, u.id, u.name, u.mime, u.byte_count, u.sha256, req.actor.id, req.actor.name, at);
        if (u.step_id) { const representative = c.record.data.category==='work_photos' && !files(c.record.id).some(f=>!f.removed_at && f.step_id===u.step_id && f.representative) ? 1:0;
          if (representative) db.prepare('UPDATE engineering_site_file_steps SET representative=0 WHERE record_id=? AND step_id=?').run(c.record.id,u.step_id);
          db.prepare('INSERT INTO engineering_site_file_steps VALUES(?,?,?,?)').run(fid,c.record.id,u.step_id,representative); }
        db.prepare("UPDATE engineering_site_uploads SET state='completed',file_id=?,updated_at=? WHERE id=?").run(fid, at, u.id); bump(c.record.id); event(req, c.record.id, 'site_file_complete', '保存已核对长度、格式标识和 SHA-256 的原件；未验证视频解码');
        return { id: fid, uploadId: u.id, state: 'completed', version: c.record.version + 1, sha256: u.sha256 };
      }));
    });
    app.post(route + '/:rid/uploads/:uid/cancel', authorize, writer, (req, res) => {
      const b = z.object({ requestId: uuid, reason: z.string().trim().max(1000).default('') }).strict().parse(req.body);
      const result = mutate(req, b, key(req) + ':upload:' + req.params.uid + ':cancel', c => { if (!owner(c, req.actor)) fail(403, '无权取消此上传'); const u = upload(req, c, true); if (u.created_by !== req.actor.id && !b.reason) fail(400, '取消已失效会话的他人上传须填写原因'); }, c => {
        editable(c, req.actor); const u = upload(req, c, true); if (u.state !== 'uploading') fail(409, '仅待完成上传可以取消');
        db.prepare("UPDATE engineering_site_uploads SET state='cancelled',updated_at=? WHERE id=?").run(now(), u.id); bump(c.record.id); event(req, c.record.id, 'site_file_cancel', '取消未完成上传，原件未归档' + (b.reason ? '；' + b.reason : '')); return { id: u.id, state: 'cancelled', version: c.record.version + 1 };
      });
      // Only uncommitted staging bytes are disposable. Final originals, including recoverable rename orphans, remain untouched.
      try { const p = partPath(req.params.uid); if (existsSync(p) && !lstatSync(p).isSymbolicLink()) unlinkSync(p); } catch { /* cancelled metadata remains authoritative; storage cleanup can retry later */ }
      res.json(result);
    });
    app.post(route + '/:rid/files/:fid/remove', authorize, writer, (req, res) => {
      const b = schemaVersion.extend({ reason: z.string().trim().min(1).max(1000) }).strict().parse(req.body), fid = uuid.parse(req.params.fid);
      res.json(mutate(req, b, key(req) + ':file:' + fid + ':remove', c => { if (!owner(c, req.actor)) fail(403, '无权移除此资料原件'); }, c => {
        editable(c, req.actor); checkVersion(c.record, b.version); const f = db.prepare('SELECT * FROM engineering_site_files WHERE record_id=? AND id=?').get(c.record.id, fid); if (!f) fail(404, '原件不存在'); if(c.record.snapshot.dailyReport && [c.record.snapshot.dailyReport.documentSha256,...c.record.snapshot.dailyReport.photos.map(p=>p.sha256)].includes(f.sha256))fail(409,'归入的原日报Word和照片须整份保留；需纠正请撤回资料'); if (f.removed_at) fail(409, '原件已移除');
        db.prepare('UPDATE engineering_site_files SET removed_by=?,removed_name=?,removed_at=?,remove_reason=? WHERE id=?').run(req.actor.id, req.actor.name, now(), b.reason, fid); bump(c.record.id); event(req, c.record.id, 'site_file_remove', b.reason + '；历史原件保留'); return { id: fid, removed: true, version: c.record.version + 1 };
      }));
    });
    app.post(route + '/:rid/files/:fid/step', authorize, writer, (req, res) => {
      const b = schemaVersion.extend({stepId:stepId.or(z.literal('')), representative:z.boolean().default(false)}).strict().parse(req.body), fid=uuid.parse(req.params.fid);
      res.json(mutate(req,b,key(req)+':step:'+fid,c=>{if(!owner(c,req.actor)) fail(403,'无权整理此资料');},c=>{
        editable(c,req.actor);checkVersion(c.record,b.version);
        if(!isStepCategory(c.record.data.category)) fail(400,'当前资料分类不使用施工工序');
        const f=files(c.record.id).find(f=>f.id===fid && !f.removed_at);if(!f) fail(404,'当前原件不存在');
        if(!b.stepId&&b.representative)fail(400,'待整理原件不能设为代表图');
        if(b.representative && c.record.data.category!=='work_photos') fail(400,'仅照片可选为A4代表图');
        if(!b.stepId){db.prepare('DELETE FROM engineering_site_file_steps WHERE file_id=? AND record_id=?').run(fid,c.record.id);bump(c.record.id);event(req,c.record.id,'site_file_step',f.name+' → 待整理');return {id:c.record.id,version:c.record.version+1};}
        if(b.representative) db.prepare('UPDATE engineering_site_file_steps SET representative=0 WHERE record_id=? AND step_id=?').run(c.record.id,b.stepId);
        db.prepare('INSERT INTO engineering_site_file_steps VALUES(?,?,?,?) ON CONFLICT(file_id) DO UPDATE SET step_id=excluded.step_id,representative=excluded.representative').run(fid,c.record.id,b.stepId,b.representative?1:0);
        bump(c.record.id);event(req,c.record.id,'site_file_step',f.name+' → '+siteWorkSteps.find(s=>s.id===b.stepId).name+(b.representative?'；选为A4代表照片':''));
        return {id:c.record.id,version:c.record.version+1};
      }));
    });
    function canGenerate(c,actor){return permissions.enabled(c.project.id)?permissions.can(actor,c.project.id,'download',c.record.data,c.record.created_by):owner(c,actor);}
    const createPhotoWord = async (req,b,operationKey,readOnly=false,preflightAction='',libraryReadOnly=false) => {
      const check=c=>{if(libraryReadOnly)permissions.requireAction(req.actor,c.project.id,'download',c.record.data,c.record.created_by);else if(preflightAction)permissions.requireAction(req.actor,c.project.id,preflightAction,c.record.data,c.record.created_by);else if(!canGenerate(c,req.actor)) fail(403,'没有生成照片Word权限');};
      const initial=access(req, !libraryReadOnly&&(!readOnly||!permissions.enabled(req.params.pid)));check(initial);
      if(!readOnly&&permissions.enabled(initial.project.id)&&permissions.review(initial.record.id)?.state==='submitted')fail(409,'待复核期间不能新增Word历史，可下载当前表格');
      if(!readOnly&&db.prepare('SELECT 1 FROM engineering_requests WHERE actor_id=? AND request_id=?').get(req.actor.id,b.requestId)) {
        return mutate(req,b,operationKey,check,()=>{throw new Error('unreachable replay');});
      }
      if((!libraryReadOnly&&(initial.project.state!=='active' || !['draft','archived'].includes(initial.record.state))) || initial.record.data.category!=='work_photos') fail(409,'仅施工中项目的照片草稿或已归档照片可以生成Word');
      checkVersion(initial.record,b.version);
      if(!sameSiteContext(snapshot(initial.project.id,initial.record.data,req.actor,initial.record),initial.record.snapshot))fail(409,contextCorrection(initial));
      if(db.prepare("SELECT 1 FROM engineering_site_uploads WHERE record_id=? AND state='uploading'").get(initial.record.id)) fail(409,'请先完成或取消所有待上传原件');
      const basisFingerprint=photoWordBasis(initial);
      const active=files(initial.record.id).filter(f=>!f.removed_at);
      if((!libraryReadOnly&&!active.length) || active.some(f=>!f.step_id)) fail(409,'请先上传照片并为每份原件选择所属工序');
      for(const f of active){const p=finalPath(f.id);if(!existsSync(p)||lstatSync(p).isSymbolicLink()||statSync(p).size!==f.byte_count||fileHash(p)!==f.sha256)fail(503,'照片原件存储或摘要异常，请检查原件');}
      const selected=active.filter(f=>f.representative);
      if(siteWorkSteps.some(s=>active.some(f=>f.step_id===s.id) && !selected.some(f=>f.step_id===s.id))) fail(409,'已有照片的每道工序须选择一张A4代表图');
      if(selected.reduce((sum,f)=>sum+f.byte_count,0)>32*1048576) fail(413,'A4代表照片原件合计不能超过32 MiB，请选择较小的代表照片，其余原件继续保留');
      const work=initial.record.data.workInfo||{}, projectData=JSON.parse(initial.project.data);
      const metadata={NUMBER:work.number||'',PROJECT:projectData.name,ADDRESS:work.road||projectData.address,LOCATION:work.location||initial.record.snapshot.task?.location||initial.record.snapshot.path.map(n=>n.title).join(' / '),DATE:work.completedAt||''};
      if(Object.values(metadata).some(invalidXmlText))fail(400,'工程或施工信息包含无效控制字符，请核对后再生成');
      if(String(metadata.PROJECT).length>100 || String(metadata.ADDRESS).length>60 || String(metadata.LOCATION).length>60) fail(400,'A4工程名称最多100字，地址及施工内容最多60字；请填写简明完整的施工信息');
      const evidence={record:initial.record.data,location:initial.record.snapshot,metadata,templateSha256:sitePhotoTemplateHash,layoutSha256:sitePhotoLayoutHash,steps:siteWorkSteps,files:selected.map(f=>({id:f.id,name:f.name,sha256:f.sha256,byteCount:f.byte_count,stepId:f.step_id})),missingSteps:siteWorkSteps.filter(s=>!selected.some(f=>f.step_id===s.id)).map(s=>s.id)};
      const snapshotJson=JSON.stringify(evidence);
      if(preflightAction&&db.prepare('SELECT COUNT(*) n FROM engineering_site_word_exports WHERE record_id=?').get(initial.record.id).n>=50&&!db.prepare('SELECT 1 FROM engineering_site_word_exports WHERE record_id=? AND snapshot=?').get(initial.record.id,snapshotJson))fail(409,'此份资料已有50个Word历史版本，当前表格无法新增归档版本；请另建后续资料，原件及历史继续保留');
      const photos=selected.map(f=>{const p=finalPath(f.id);if(!existsSync(p)||lstatSync(p).isSymbolicLink()||statSync(p).size!==f.byte_count||fileHash(p)!==f.sha256)fail(503,'代表照片存储或摘要异常，请检查原件');return {...f,bytes:readFileSync(p)};});
      let document;
      try { document=await generateSitePhotoDocument(metadata,photos); } catch { fail(422,'代表照片无法解码或尺寸过大，请预览核查后换选有效照片'); }
      if(document.length>16*1048576) fail(413,'生成文档超过16 MiB，请换选较小代表照片');
      const finalCheck=c=>{
        checkVersion(c.record,b.version);
        checkPhotoWordBasis(c,basisFingerprint);
        if((libraryReadOnly?(c.project.state!==initial.project.state||c.record.state!==initial.record.state):(c.project.state!=='active'||!['draft','archived'].includes(c.record.state)))||c.project.data!==initial.project.data)fail(409,'项目或资料已变化，请刷新后生成');
        if(!sameSiteContext(snapshot(c.project.id,c.record.data,req.actor,c.record),c.record.snapshot))fail(409,contextCorrection(c));
        for(const f of selected){const p=finalPath(f.id);if(!existsSync(p)||lstatSync(p).isSymbolicLink()||statSync(p).size!==f.byte_count||fileHash(p)!==f.sha256)fail(503,'代表照片存储或摘要异常，请检查原件');}
      };
      if(readOnly)return store.transaction(()=>{const c=currentAccess(req,!libraryReadOnly&&!permissions.enabled(req.params.pid));check(c);finalCheck(c);return {document,name:'现场施工步骤照片_'+c.record.data.recordDate+'_当前表格.docx',version:c.record.version,basisFingerprint,...(libraryReadOnly?{templateSha256:sitePhotoTemplateHash,layoutSha256:sitePhotoLayoutHash,representativeFileIds:selected.map(f=>f.id),missingSteps:siteWorkSteps.filter(s=>evidence.missingSteps.includes(s.id)).map(s=>({id:s.id,name:s.name}))}:{})};});
      const result=mutate(req,b,operationKey,check,c=>{
        finalCheck(c);
        const same=db.prepare('SELECT id,sequence FROM engineering_site_word_exports WHERE record_id=? AND snapshot=?').get(c.record.id,snapshotJson);
        if(same)return {id:c.record.id,exportId:same.id,sequence:same.sequence,version:c.record.version,unchanged:true};
        const count=db.prepare('SELECT COUNT(*) n FROM engineering_site_word_exports WHERE record_id=?').get(c.record.id).n;
        if(count>=50)fail(409,'每份资料最多保留50个Word版本，请另建后续资料');
        const id=randomUUID(),sequence=count+1,name='现场施工步骤照片_'+c.record.data.recordDate+'_v'+sequence+'.docx';
        db.prepare('INSERT INTO engineering_site_word_exports VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,c.record.id,c.project.id,sequence,c.record.version,snapshotJson,name,document.length,hash(document),document,req.actor.id,req.actor.name,now());
        event(req,c.record.id,'site_photo_word','生成A4照片Word第'+sequence+'版；缺少'+evidence.missingSteps.length+'道工序照片，原件及历史版本保留');
        return {id:c.record.id,exportId:id,sequence,version:c.record.version};
      });return result;
    };
    photoWordReaders.set(base,createPhotoWord);
    function createSupervisionWord(req,b,operationKey) {
      return mutate(req,b,operationKey,c=>{if(!canGenerate(c,req.actor))fail(403,'没有生成监理日报Word权限');},c=>{
        if(c.project.state!=='active'||!['draft','archived'].includes(c.record.state)||c.record.data.category!=='supervision_daily'||!c.record.data.supervision)fail(409,'请先保存监理日报在线正文');
        checkVersion(c.record,b.version);
        if(!sameSiteContext(snapshot(c.project.id,c.record.data,req.actor,c.record),c.record.snapshot))fail(409,contextCorrection(c));
        const missing=supervisionMissing(c.record.data.supervision);if(missing.length)fail(400,'生成监理日报前请填写：'+missing.join('、'));
        if(db.prepare("SELECT 1 FROM engineering_site_uploads WHERE record_id=? AND state='uploading'").get(c.record.id))fail(409,'请先完成或取消所有待上传原件');
        const active=files(c.record.id).filter(f=>!f.removed_at);
        for(const f of active){const p=finalPath(f.id);if(!existsSync(p)||lstatSync(p).isSymbolicLink()||statSync(p).size!==f.byte_count||fileHash(p)!==f.sha256)fail(503,'监理附件原件存储或摘要异常，请检查原件');}
        const projectData=JSON.parse(c.project.data),metadata={project:projectData.name,title:c.record.data.title,date:c.record.data.recordDate,location:c.record.snapshot.path.map(n=>n.title).join(' / ')+(c.record.snapshot.task?' · '+c.record.snapshot.task.title:''),note:c.record.data.note};
        if(Object.values(metadata).some(invalidXmlText))fail(400,'工程或资料文字包含无效控制字符');
        const evidence={kind:'supervision_daily',record:c.record.data,location:c.record.snapshot,metadata,templateSha256:supervisionTemplateHash,layoutSha256:supervisionLayoutHash,files:active.map(f=>({id:f.id,name:f.name,sha256:f.sha256,byteCount:f.byte_count}))};
        const snapshotJson=JSON.stringify(evidence),same=db.prepare('SELECT id,sequence FROM engineering_site_word_exports WHERE record_id=? AND snapshot=?').get(c.record.id,snapshotJson);
        if(same)return {id:c.record.id,exportId:same.id,sequence:same.sequence,version:c.record.version,unchanged:true};
        const count=db.prepare('SELECT COUNT(*) n FROM engineering_site_word_exports WHERE record_id=?').get(c.record.id).n;
        if(count>=50)fail(409,'每份资料最多保留50个Word版本，请另建后续资料');
        const document=generateSupervisionDocument(metadata,c.record.data.supervision);
        if(document.length>16*1048576)fail(413,'监理日报Word超过16 MiB');
        const id=randomUUID(),sequence=count+1,name='监理日报_'+c.record.data.recordDate+'_v'+sequence+'.docx';
        db.prepare('INSERT INTO engineering_site_word_exports VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,c.record.id,c.project.id,sequence,c.record.version,snapshotJson,name,document.length,hash(document),document,req.actor.id,req.actor.name,now());
        event(req,c.record.id,'site_supervision_word','生成监理日报Word第'+sequence+'版；保留在线正文、附件依据及历史版本');
        return {id:c.record.id,exportId:id,sequence,version:c.record.version};
      });
    }
    function createWord(req,b,operationKey) {
      const c=access(req);if(permissions.enabled(c.project.id)&&permissions.review(c.record.id)?.state==='submitted')fail(409,'待复核期间不能新增Word历史');
      return access(req).record.data.category==='supervision_daily'?createSupervisionWord(req,b,operationKey):createPhotoWord(req,b,operationKey);
    }
    app.post(route+'/:rid/exports',authorize,writer,async(req,res)=>{
      const result=await createWord(req,schemaVersion.parse(req.body),key(req)+':word');
      res.status(result.replayed||result.unchanged?200:201).json(result);
    });
    app.get(route+'/:rid/photo-table',authorize,async(req,res)=>{
      const q=z.object({version:z.coerce.number().int().positive()}).strict().parse(req.query);
      const result=await createPhotoWord(req,q,null,true);
      res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
      res.setHeader('X-Site-Record-Version',String(result.version));res.setHeader('X-Content-SHA256',hash(result.document));
      res.setHeader('Content-Type',formats.docx);res.setHeader('Content-Disposition',`attachment; filename="site-photo-table.docx"; filename*=UTF-8''${encodeURIComponent(result.name)}`);res.send(result.document);
    });
    app.get(route+'/:rid/files/:fid/thumbnail',authorize,async(req,res)=>{
      const q=z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(req.query),c=access(req),fid=uuid.parse(req.params.fid);
      const file=()=>db.prepare('SELECT * FROM engineering_site_files WHERE record_id=? AND id=?').get(c.record.id,fid),f=file();
      if(!f||f.removed_at||!f.mime.startsWith('image/'))fail(404,'当前图片不存在');
      if(q.sha256!==f.sha256)fail(409,'照片已变化，请刷新资料');
      const path=finalPath(f.id),valid=()=>existsSync(path)&&!lstatSync(path).isSymbolicLink()&&statSync(path).size===f.byte_count&&fileHash(path)===f.sha256;
      if(!valid())fail(503,'照片原件存储或摘要异常，请检查原件');
      let bytes;try{bytes=await sharp(readFileSync(path),{limitInputPixels:40000000,failOn:'warning'}).rotate().resize({width:600,height:400,fit:'inside',withoutEnlargement:true}).flatten({background:'#ffffff'}).jpeg({quality:78}).toBuffer();}catch{fail(422,'照片无法解码，请预览并核对原件');}
      store.transaction(()=>{currentAccess(req);if(JSON.stringify(file())!==JSON.stringify(f))fail(409,'照片已移除或变化，请刷新资料');if(!valid())fail(503,'照片原件存储或摘要异常，请检查原件');});
      res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Type','image/jpeg');res.send(bytes);
    });
    app.get(route+'/:rid/exports/:eid/download',authorize,(req,res)=>{
      const c=access(req),e=db.prepare('SELECT * FROM engineering_site_word_exports WHERE record_id=? AND id=?').get(c.record.id,uuid.parse(req.params.eid));
      if(!e)fail(404,'Word版本不存在');sendFile(req,res,{...e,mime:formats.docx},false);
    });
    app.post(route+'/:rid/exports/:eid/media-grants',authorize,(req,res)=>{
      const b=z.object({requestId:uuid}).strict().parse(req.body),c=access(req),sess=session(req),e=db.prepare(`SELECT ${exportColumns} FROM engineering_site_word_exports WHERE record_id=? AND id=?`).get(c.record.id,uuid.parse(req.params.eid));if(!e)fail(404,'Word版本不存在');
      const cacheKey=req.actor.id+':'+b.requestId,fingerprint=hash(key(req)+':export:'+e.id+':'+sess),old=grants.get(cacheKey),metadata={fileId:e.id,name:e.name,mime:formats.docx,byteCount:e.byte_count,sha256:e.sha256};
      if(old&&old.fingerprint!==fingerprint)fail(409,'请求编号已使用');
      if(old&&old.expiresAt>Date.now()){res.json({url:old.url,expiresAt:old.expiresAt,...metadata,replayed:true});return;}
      for(const [k,v]of grants)if(v.expiresAt<=Date.now())grants.delete(k);
      if(grants.size>=5000)fail(429,'当前下载授权较多，请稍后重试');
      const token=randomBytes(32).toString('base64url'),expiresAt=Date.now()+300000,url=new URL('/api/engineering-site-media/'+token,baseUrl).href;
      db.prepare('DELETE FROM engineering_site_media_grants WHERE expires_at<=?').run(Date.now());db.prepare('INSERT INTO engineering_site_media_grants VALUES(?,?,?,?,?,?,?)').run(hash(token),c.project.id,c.record.id,e.id,req.actor.id,sess,expiresAt);
      grants.set(cacheKey,{fingerprint,url,expiresAt});res.json({url,expiresAt,...metadata});
    });
    app.get(route + '/:rid/files/:fid/download', authorize, (req, res) => { const c = access(req), f = db.prepare('SELECT * FROM engineering_site_files WHERE project_id=? AND record_id=? AND id=?').get(c.project.id, c.record.id, uuid.parse(req.params.fid)); if (!f) fail(404, '原件不存在'); sendFile(req, res, f, false); });
    app.post(route + '/:rid/files/:fid/media-grants', authorize, (req, res) => {
      const b = z.object({ requestId: uuid }).strict().parse(req.body), c = access(req), sess = session(req), fid = uuid.parse(req.params.fid), f = db.prepare('SELECT * FROM engineering_site_files WHERE project_id=? AND record_id=? AND id=?').get(c.project.id, c.record.id, fid); if (!f) fail(404, '原件不存在');
      for (const [k, value] of grants) if (value.expiresAt <= Date.now()) grants.delete(k);
      const cacheKey = req.actor.id + ':' + b.requestId, fingerprint = hash(key(req) + ':grant:' + fid + ':' + sess), old = grants.get(cacheKey);
      const metadata = { fileId: f.id, name: f.name, mime: f.mime, byteCount: f.byte_count, sha256: f.sha256 };
      if (old) { if (old.fingerprint !== fingerprint) fail(409, '请求编号已使用'); res.json({ url: old.url, expiresAt: old.expiresAt, ...metadata, replayed: true }); return; }
      if (grants.size >= 5000) fail(429, '当前临时原件授权较多，请稍后重试');
      const token = randomBytes(32).toString('base64url'), expiresAt = Date.now() + 300000, url = new URL('/api/engineering-site-media/' + token, baseUrl).href;
      db.prepare('DELETE FROM engineering_site_media_grants WHERE expires_at<=?').run(Date.now()); db.prepare('INSERT INTO engineering_site_media_grants VALUES(?,?,?,?,?,?,?)').run(hash(token), c.project.id, c.record.id, fid, req.actor.id, sess, expiresAt);
      grants.set(cacheKey, { fingerprint, url, expiresAt }); res.json({ url, expiresAt, ...metadata });
    });
  }
  function sendFile(req, res, f, inline) {
    const p = finalPath(f.id), document=f.document?Buffer.from(f.document):null;
    if (document ? document.length!==f.byte_count||hash(document)!==f.sha256 : !existsSync(p) || lstatSync(p).isSymbolicLink() || statSync(p).size !== f.byte_count) fail(503, '原件存储异常，请联系管理员检查');
    const encodedName = encodeURIComponent(f.name).replace(/['()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
    res.set({ 'Content-Type': f.mime, 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="site-file.${f.name.split('.').pop().toLowerCase()}"; filename*=UTF-8''${encodedName}`, 'Accept-Ranges': 'bytes', 'X-Content-SHA256': f.sha256, 'Content-Security-Policy': "sandbox; default-src 'none'", 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    let start = 0, end = f.byte_count - 1;
    if (req.headers.range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range); let invalid = !m || !m[1] && !m[2];
      if (!invalid) { if (m[1]) { start = Number(m[1]); if (m[2]) end = Math.min(end, Number(m[2])); } else { const suffix = Number(m[2]); invalid = !suffix; start = Math.max(0, f.byte_count - suffix); } invalid ||= !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= f.byte_count; }
      if (invalid) { res.status(416).set('Content-Range', 'bytes */' + f.byte_count).end(); return; }
      res.status(206).set('Content-Range', `bytes ${start}-${end}/${f.byte_count}`);
    }
    res.set('Content-Length', String(end - start + 1)); if (req.method === 'HEAD') { res.end(); return; }
    if(document){res.end(document.subarray(start,end+1));return;}
    const stream = createReadStream(p, { start, end }); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); stream.pipe(res);
  }
  app.get('/api/engineering-site-media/:token', (req, res) => {
    try {
      if (!/^[A-Za-z0-9_-]{43}$/.test(req.params.token)) fail(404, '原件预览授权不存在');
      const g = db.prepare('SELECT * FROM engineering_site_media_grants WHERE token_hash=? AND expires_at>?').get(hash(req.params.token), Date.now()); if (!g) fail(401, '原件预览授权已失效');
      const actor = db.prepare('SELECT u.id,u.role,u.name FROM sessions s JOIN users u ON s.user_id=u.id WHERE s.hash=? AND s.user_id=? AND s.expires_at>? AND u.active=1').get(g.session_hash, g.user_id, Date.now()); if (!actor) fail(401, '原登录会话已失效'); acl(actor, g.project_id);
      const record=parseRecord(db.prepare('SELECT * FROM engineering_site_records WHERE project_id=? AND id=?').get(g.project_id,g.record_id));if(!record)fail(404,'施工资料不存在');permissions.requireAction(actor,g.project_id,'read',record.data,record.created_by);permissions.requireAction(actor,g.project_id,'download',record.data,record.created_by);if(record.data.dailyReportId&&!permissions.delegated(actor,record))dailySource(db,actor,record.data.dailyReportId);
      const f = db.prepare('SELECT * FROM engineering_site_files WHERE project_id=? AND record_id=? AND id=?').get(g.project_id, g.record_id, g.file_id) || db.prepare('SELECT *,? mime FROM engineering_site_word_exports WHERE project_id=? AND record_id=? AND id=?').get(formats.docx,g.project_id,g.record_id,g.file_id); if (!f) fail(404, '原件不存在'); sendFile(req, res, f, !f.document);
    } catch (error) {
      if (error.status) throw error;
      // The global unexpected-error logger includes req.path. Convert storage/index faults here so bearer URLs never enter logs.
      fail(503, '原件预览暂不可用，请检查存储后重试');
    }
  });
  return {library,accountPermission(actor,pid){return {projectRole:acl(actor,pid).role,...permissions.permission(actor,pid)};},limits:siteRecordLimits,categories:siteRecordCategories,dailyProject(actor,pid){const c=acl(actor,pid,true);permissions.requireAction(actor,pid,'read');permissions.requireAction(actor,pid,'create');if(c.project.state!=='active')fail(409,'项目未在施工中');return c;},documentProject(actor,pid,write=false,category='construction_daily'){const c=acl(actor,pid,write);permissions.requireAction(actor,pid,'read');if(write){permissions.requireAction(actor,pid,'create');const p=permissions.permission(actor,pid);if(p.enabled&&p.categories.length&&!p.categories.includes(category))fail(403,'没有此资料类别权限');if(c.project.state!=='active')fail(409,'项目未在施工中');}return c;},historyVisible(actor,pid,itemId){if(!permissions.enabled(pid))return true;const r=parseRecord(db.prepare('SELECT * FROM engineering_site_records WHERE project_id=? AND id=?').get(pid,itemId));if(r){if(!permissions.visible(actor,pid,r))return false;if(r.data.dailyReportId&&!permissions.delegated(actor,r)){try{dailySource(db,actor,r.data.dailyReportId);}catch{return false;}}return true;}const batch=db.prepare('SELECT data FROM engineering_site_batches WHERE project_id=? AND id=?').get(pid,itemId);return !batch||Object.keys(siteRecordCategories).some(category=>permissions.can(actor,pid,'read',{wbsId:JSON.parse(batch.data).wbsId,category}));}};
}
