import { createHash, randomUUID } from 'node:crypto';
import { unzipSync } from 'fflate';
import { z } from 'zod';
import { engineeringCatalog } from './engineering.mjs';
import { fail } from './service.mjs';

const id = z.string().uuid();
const version = z.number().int().positive();
export const attachmentLimits = { maxFileBytes: 8 * 1024 * 1024, maxItemBytes: 64 * 1024 * 1024, maxItemFiles: 32 };
const fileTypes = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', txt: 'text/plain',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const allowedStates = { tasks: ['planned', 'active'], issues: ['open', 'rectifying'], materials: ['active'], crews: ['pending'] };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const now = () => new Date().toISOString();
const metadataColumns = 'id,project_id,item_id,name,mime,byte_count,sha256,caption,created_by,created_name,created_at,removed_by,removed_name,removed_at,remove_reason';

function validateFile(body) {
  const name = body.name.normalize('NFC');
  if (/[/\\:*?"<>|\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(name) || /^[. ]|[. ]$/.test(name) || /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name)) fail(400, '文件名不能包含路径、控制字符、特殊符号或系统保留名称');
  const ext = name.split('.').pop().toLowerCase(), mime = fileTypes[ext];
  if (!mime) fail(400, '仅支持 PDF、Word(docx)、Excel(xlsx)、PNG、JPEG、WebP 和 UTF-8 文本');
  // Avoid a repeated capture group: multi-megabyte input can exhaust the regexp stack.
  if (body.base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.base64)) fail(400, '文件编码无效');
  const bytes = Buffer.from(body.base64, 'base64');
  if (!bytes.length || bytes.length > attachmentLimits.maxFileBytes) fail(400, '单个附件须大于 0 字节且不超过 8 MiB');
  if (bytes.toString('base64') !== body.base64) fail(400, '文件编码无效');
  const starts = hex => bytes.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
  if (ext === 'pdf' && !bytes.subarray(0, 5).equals(Buffer.from('%PDF-')) || ext === 'png' && !starts('89504e470d0a1a0a') || ['jpg', 'jpeg'].includes(ext) && !starts('ffd8ff') || ext === 'webp' && !(bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP')) fail(400, '文件内容与扩展名不一致');
  if (ext === 'txt') {
    let value; try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(400, '文本附件须使用 UTF-8 编码'); }
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(400, '文本附件含二进制控制字符');
  }
  if (ext === 'docx' || ext === 'xlsx') {
    // Inspect the ZIP directory only. Do not extract embedded objects or expand compressed payloads.
    const entries = []; let expandedBytes = 0;
    try { unzipSync(bytes, { filter(entry) { entries.push(entry.name); expandedBytes += entry.originalSize; return false; } }); } catch { fail(400, 'Office 文件容器损坏'); }
    if (entries.length > 4096 || expandedBytes > 128 * 1024 * 1024 || !entries.includes('[Content_Types].xml') || !entries.includes(ext === 'docx' ? 'word/document.xml' : 'xl/workbook.xml') || entries.some(n => /(?:^|\/)\.\.(?:\/|$)|\\|(?:vbaProject\.bin|activeX\/|embeddings\/)/i.test(n))) fail(400, 'Office 附件格式不符，或包含宏、嵌入对象、异常路径及过大内容');
  }
  return { name, mime, bytes, sha256: sha256(bytes) };
}

export function mountEngineeringAttachmentRoutes(app, { store, auth, mobileAuth, writer }) {
  const db = store.db;
  db.exec(`CREATE TABLE IF NOT EXISTS engineering_attachments(
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES engineering_projects(id), item_id TEXT NOT NULL REFERENCES engineering_items(id),
    name TEXT NOT NULL, mime TEXT NOT NULL, byte_count INTEGER NOT NULL CHECK(byte_count>0), sha256 TEXT NOT NULL, caption TEXT NOT NULL,
    bytes BLOB NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), created_name TEXT NOT NULL, created_at TEXT NOT NULL,
    removed_by TEXT REFERENCES users(id), removed_name TEXT, removed_at TEXT, remove_reason TEXT
  ); CREATE INDEX IF NOT EXISTS engineering_attachments_item ON engineering_attachments(project_id,item_id,created_at);`);
  function access(req, write = false) {
    const pid = id.parse(req.params.pid), iid = id.parse(req.params.iid);
    const project = db.prepare('SELECT * FROM engineering_projects WHERE id=?').get(pid);
    let role = req.actor.role === 'admin' ? 'admin' : db.prepare('SELECT role FROM engineering_members WHERE project_id=? AND user_id=?').get(pid, req.actor.id)?.role;
    if (role && req.actor.role === 'viewer') role = 'viewer';
    if (!project || !role) fail(404, '项目不存在或未授权');
    const item = db.prepare('SELECT * FROM engineering_items WHERE project_id=? AND id=?').get(pid, iid);
    if (!item || !engineeringCatalog[item.kind]) fail(404, '业务记录不存在');
    const financial = engineeringCatalog[item.kind].financial;
    if (financial && !['admin', 'manager', 'finance'].includes(role)) fail(403, '没有项目经营数据权限');
    const allowed = role !== 'viewer' && !(role === 'finance' && !financial);
    if (write && !allowed) fail(403, '无权修改此业务附件');
    const stateEditable = project.state === 'active' && (allowedStates[item.kind] || ['draft']).includes(item.state);
    return { project, item, writable: allowed && stateEditable, stateEditable };
  }
  function record(actor, item, action, note) {
    const at = now();
    db.prepare('UPDATE engineering_items SET version=version+1,edited_by=?,updated_at=? WHERE id=?').run(actor.id, at, item.id);
    db.prepare('INSERT INTO engineering_history VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(), item.project_id, item.id, item.kind, actor.id, actor.name, action, note, at);
    store.audit(actor, action, 'engineering_' + item.kind, item.id, note);
  }
  function mutate(req, body, key, action) {
    // Authorization is checked on every replay, so revocation immediately invalidates old receipts.
    return store.transaction(() => {
      const context = access(req, true);
      const fingerprint = sha256(key + '\n' + JSON.stringify(body));
      const old = db.prepare('SELECT * FROM engineering_requests WHERE actor_id=? AND request_id=?').get(req.actor.id, body.requestId);
      if (old) { if (old.fingerprint !== fingerprint) fail(409, '请求编号已使用，请刷新核对'); return { ...JSON.parse(old.result), replayed: true }; }
      if (!context.stateEditable) fail(409, '单据已提交审核、已办结或项目已停止，附件已锁定');
      if (context.item.version !== body.version) fail(409, '单据或附件已更新，请刷新后核对再提交');
      const result = action(context.item);
      db.prepare('INSERT INTO engineering_requests VALUES(?,?,?,?)').run(req.actor.id, body.requestId, fingerprint, JSON.stringify(result));
      return result;
    });
  }
  for (const [base, authorize] of [['/api/engineering', auth], ['/api/mobile/engineering', mobileAuth]]) {
    const route = base + '/projects/:pid/items/:iid/attachments';
    app.get(route, authorize, (req, res) => {
      const { item, writable } = access(req);
      const attachments = db.prepare(`SELECT ${metadataColumns} FROM engineering_attachments WHERE item_id=? ORDER BY created_at DESC,id DESC`).all(item.id);
      res.json({ attachments, version: item.version, writable, limits: attachmentLimits, usedBytes: attachments.reduce((s, a) => s + a.byte_count, 0), usedFiles: attachments.length });
    });
    app.post(route, authorize, writer, (req, res) => {
      access(req, true);
      const body = z.object({ requestId: id, version, name: z.string().min(1).max(160), caption: z.string().trim().max(500).default(''), base64: z.string().min(1).max(Math.ceil(attachmentLimits.maxFileBytes / 3) * 4) }).strict().parse(req.body);
      const result = mutate(req, body, req.params.pid + ':' + req.params.iid + ':attachment:add', item => {
        const file = validateFile(body);
        const usage = db.prepare('SELECT COUNT(*) n,COALESCE(SUM(byte_count),0) bytes FROM engineering_attachments WHERE item_id=?').get(item.id);
        if (usage.n >= attachmentLimits.maxItemFiles || usage.bytes + file.bytes.length > attachmentLimits.maxItemBytes) fail(409, '本单据附件及历史原件合计最多 32 份、64 MiB；不能通过移除释放历史原件额度');
        const aid = randomUUID(), at = now();
        db.prepare('INSERT INTO engineering_attachments(id,project_id,item_id,name,mime,byte_count,sha256,caption,bytes,created_by,created_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(aid, item.project_id, item.id, file.name, file.mime, file.bytes.length, file.sha256, body.caption, file.bytes, req.actor.id, req.actor.name, at);
        record(req.actor, item, 'attachment_add', '上传附件：' + file.name + '；SHA-256 ' + file.sha256);
        return { id: aid, version: item.version + 1, sha256: file.sha256 };
      });
      res.status(result.replayed ? 200 : 201).json(result);
    });
    app.get(route + '/:aid/download', authorize, (req, res) => {
      const { item } = access(req);
      const file = db.prepare('SELECT * FROM engineering_attachments WHERE project_id=? AND item_id=? AND id=?').get(item.project_id, item.id, id.parse(req.params.aid));
      if (!file) fail(404, '附件不存在');
      const encodedName = encodeURIComponent(file.name).replace(/['()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
      res.set({ 'Content-Type': file.mime, 'Content-Disposition': `attachment; filename="attachment.${file.name.split('.').pop().toLowerCase()}"; filename*=UTF-8''${encodedName}`, 'Content-Security-Policy': "sandbox; default-src 'none'", 'X-Content-Type-Options': 'nosniff', 'X-Content-SHA256': file.sha256 }).send(Buffer.from(file.bytes));
    });
    app.post(route + '/:aid/remove', authorize, writer, (req, res) => {
      const body = z.object({ requestId: id, version, reason: z.string().trim().min(1).max(500) }).strict().parse(req.body), aid = id.parse(req.params.aid);
      res.json(mutate(req, body, req.params.pid + ':' + req.params.iid + ':attachment:' + aid + ':remove', item => {
        const file = db.prepare('SELECT id,name,removed_at FROM engineering_attachments WHERE project_id=? AND item_id=? AND id=?').get(item.project_id, item.id, aid);
        if (!file) fail(404, '附件不存在');
        if (file.removed_at) fail(409, '附件已移除，请刷新核对');
        db.prepare('UPDATE engineering_attachments SET removed_by=?,removed_name=?,removed_at=?,remove_reason=? WHERE id=?').run(req.actor.id, req.actor.name, now(), body.reason, aid);
        record(req.actor, item, 'attachment_remove', '移除附件：' + file.name + '；原因：' + body.reason + '；历史原件保留');
        return { id: aid, version: item.version + 1, removed: true };
      }));
    });
  }
}
