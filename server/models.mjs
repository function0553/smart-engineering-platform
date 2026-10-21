import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fail } from './service.mjs';

// The first viewer supports self-contained GLB 2.0. External fetches and unsupported
// compression are rejected before the model is stored or sent to a browser.
export function inspectGlb(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 20 || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) fail(400, '请选择有效的 GLB 2.0 模型文件');
  const jsonSize = bytes.readUInt32LE(12);
  if (bytes.readUInt32LE(16) !== 0x4e4f534a || jsonSize % 4 !== 0 || jsonSize > bytes.length - 20) fail(400, '模型文件的结构不完整');
  let json;
  try { json = JSON.parse(bytes.subarray(20, 20 + jsonSize).toString('utf8')); } catch { fail(400, '模型描述格式错误'); }
  if (json.asset?.version !== '2.0' || !Array.isArray(json.scenes) || !json.scenes.length) fail(400, '模型缺少可用场景');
  let offset = 20 + jsonSize;
  while (offset < bytes.length) { if (offset + 8 > bytes.length) fail(400, '模型数据块损坏'); const size = bytes.readUInt32LE(offset); if (size % 4 || offset + 8 + size > bytes.length) fail(400, '模型数据块损坏'); offset += 8 + size; }
  const walk = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'uri' && typeof child === 'string' && !/^data:(application\/octet-stream|application\/gltf-buffer|image\/(png|jpeg|webp));base64,/.test(child)) fail(400, '当前仅支持资源已内嵌的 GLB，请将纹理与缓冲区打包进模型');
      if (typeof child === 'object') walk(child);
    }
  }; walk(json);
  if ((json.extensionsUsed || []).some(x => ['KHR_draco_mesh_compression', 'EXT_meshopt_compression', 'KHR_texture_basisu'].includes(x))) fail(400, '当前版本请导出未使用 Draco、Meshopt 或 KTX2 压缩的 GLB');
  return json;
}

export function mountModelRoutes(app, { store, auth, admin, raw, filesDir }) {
  app.get('/api/models', auth, (req, res) => res.json(store.db.prepare('SELECT id,name,sha256,size,created_at FROM models ORDER BY created_at DESC').all()));
  app.post('/api/models', auth, admin, raw, (req, res) => {
    const name = z.string().trim().min(1).max(120).parse(req.query.name);
    inspectGlb(req.body);
    const id = randomUUID(); const fileKey = `${id}.glb`; const path = resolve(filesDir, fileKey);
    mkdirSync(filesDir, { recursive: true }); writeFileSync(path, req.body, { flag: 'wx' });
    try {
      store.transaction(() => { store.db.prepare('INSERT INTO models VALUES(?,?,?,?,?,?)').run(id, name, fileKey, createHash('sha256').update(req.body).digest('hex'), req.body.length, new Date().toISOString()); store.audit(req.actor, 'upload', 'models', id, `导入三维模型：${name}`); });
    } catch (error) { unlinkSync(path); throw error; }
    res.status(201).json({ id, name });
  });
  app.get('/api/models/:id/file', auth, (req, res) => {
    const model = store.db.prepare('SELECT * FROM models WHERE id=?').get(req.params.id); if (!model) fail(404, '模型不存在');
    // Files live under the intentionally hidden .data directory. The filename is
    // database-generated, never a user path; allow this protected directory only.
    res.type('model/gltf-binary').sendFile(resolve(filesDir, model.file_key), { dotfiles: 'allow' });
  });
  app.get('/api/models/:id/anchors', auth, (req, res) => {
    if (!store.db.prepare('SELECT 1 FROM models WHERE id=?').get(req.params.id)) fail(404, '模型不存在');
    res.json(store.db.prepare('SELECT * FROM anchors WHERE model_id=? ORDER BY updated_at').all(req.params.id).map(row => ({ ...row, position: JSON.parse(row.position) })));
  });
  app.post('/api/models/:id/anchors', auth, admin, (req, res) => {
    const body = z.object({ targetId: z.string().uuid(), position: z.tuple([z.number().min(-1e9).max(1e9), z.number().min(-1e9).max(1e9), z.number().min(-1e9).max(1e9)]), version: z.number().int().positive().optional() }).strict().parse(req.body);
    const result = store.transaction(() => {
      if (!store.db.prepare('SELECT 1 FROM models WHERE id=?').get(req.params.id)) fail(404, '模型不存在');
      const target = store.get(body.targetId); if (!target || !['spaces', 'devices', 'fences'].includes(target.type)) fail(400, '点位必须关联场所、设备或围栏');
      const existing = store.db.prepare('SELECT * FROM anchors WHERE model_id=? AND target_id=?').get(req.params.id, body.targetId);
      if (existing && existing.version !== body.version) fail(409, '点位已存在或已变化，请刷新后重新定位');
      const id = existing?.id || randomUUID();
      if (existing) store.db.prepare('UPDATE anchors SET position=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(body.position), new Date().toISOString(), id);
      else store.db.prepare('INSERT INTO anchors(id,model_id,target_id,position,updated_at) VALUES(?,?,?,?,?)').run(id, req.params.id, body.targetId, JSON.stringify(body.position), new Date().toISOString());
      store.audit(req.actor, 'bind', 'models', req.params.id, `绑定业务点位：${target.data.name}`);
      return { id, modelId: req.params.id, targetId: body.targetId };
    }); res.status(201).json(result);
  });
  app.delete('/api/models/:id/anchors/:anchorId', auth, admin, (req, res) => {
    const version = z.number().int().positive().parse(req.body.version);
    store.transaction(() => { const row = store.db.prepare('SELECT * FROM anchors WHERE model_id=? AND id=?').get(req.params.id, req.params.anchorId); if (!row) fail(404, '点位不存在'); if (row.version !== version) fail(409, '点位已变更，请刷新'); store.db.prepare('DELETE FROM anchors WHERE id=?').run(row.id); store.audit(req.actor, 'unbind', 'models', row.model_id, '解除业务点位绑定'); }); res.json({ ok: true });
  });
}
