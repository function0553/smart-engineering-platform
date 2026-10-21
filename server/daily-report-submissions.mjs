import {prepareTemplatePhoto} from './template-photo-original.mjs';
import {documentScope,requireDocumentProject} from './project-document-scope.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { dailyReportSchema, generateDailyReport } from './daily-report.mjs';
import { fail } from './service.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const columns = `id,author_id,author_name,project_name,region,report_date,number,photo_count,created_at,document_sha256,json_extract(data,'$.sections[0].name') AS section_name,json_array_length(json_extract(data,'$.sections')) AS section_count,json_extract(data,'$.projectId') AS project_id`;
const receipt = row => ({ id: row.id, authorId: row.author_id, authorName: row.author_name,
  projectId:row.project_id||undefined, projectName: row.project_name, region: row.region, reportDate: row.report_date, number: row.number,
  sectionName: row.section_count===1?row.section_name:'', sectionCount: row.section_count, photoCount: row.photo_count, createdAt: row.created_at, documentSha256: row.document_sha256 });
const photoColumns = 'photo_index,name,caption,mime,width,height,length(bytes) AS size,sha256';

/** Submitted reports are immutable snapshots. Originals and Word commit in the same SQLite transaction. */
export function mountDailyReportSubmissionRoutes(app, { store, auth, mobileAuth, writer, weatherService, projectAccess }) {
  const owns = (req, id) => {
    const row = store.db.prepare(`SELECT ${columns} FROM daily_reports WHERE id=? AND (?='admin' OR author_id=?)`).get(id, req.actor.role, req.actor.id);
    if (!row) fail(404, '汇报不存在或无权查看');
    return row;
  };
  const identify = req => z.string().uuid().parse(req.params.id);
  const replay = (actor, key, fingerprint) => {
    const row = store.db.prepare(`SELECT ${columns},request_hash FROM daily_reports WHERE author_id=? AND submission_key=?`).get(actor.id, key);
    if (row && row.request_hash !== fingerprint) fail(409, '提交标识对应的内容已经改变，请重新提交');
    return row;
  };
  const submit = async (req, res, authorize) => {
    const envelope = z.object({ submissionId: z.string().uuid(), projectId:z.string().uuid().optional(), data: z.unknown() }).strict().parse(req.body);
    const parsed = dailyReportSchema.safeParse(envelope.data);
    if (!parsed.success) return res.status(400).json({ error: '请检查日报内容', fields: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
    if(envelope.projectId)projectAccess(req.actor,envelope.projectId,true);
    try { for(let i=0;i<parsed.data.photos.length;i++)parsed.data.photos[i]=await prepareTemplatePhoto(parsed.data.photos[i]); }
    catch(error){fail(400,error.message);}
    let stillAuthorized=false;authorize(req,res,()=>writer(req,res,()=>{stillAuthorized=true;}));if(!stillAuthorized)return;
    const fingerprint = hash(JSON.stringify(envelope.projectId?{projectId:envelope.projectId,data:parsed.data}:parsed.data));
    const earlier = replay(req.actor, envelope.submissionId, fingerprint);
    if (earlier) return res.json({ ...receipt(earlier), replayed: true });
    if(parsed.data.sections.length!==1)return res.status(400).json({error:'每个施工片区须单独提交日报',fields:[{path:'sections',message:'请一次只提交一个施工片区；旧合并日报可继续查看和下载。'}]});
    const report = parsed.data;
    if (report.weatherAuto && weatherService) {
      const fresh = await weatherService({ date: report.reportDate, latitude: report.weatherLocation.latitude, longitude: report.weatherLocation.longitude });
      report.weather = fresh.condition; report.weatherInfo = fresh;
    }
    // Generation validates original photo content before any row is written.
    let document;
    try { document = generateDailyReport(report); }
    catch (error) { fail(400, error.message || '日报或照片内容无效，请检查后重试'); }
    stillAuthorized=false;authorize(req,res,()=>writer(req,res,()=>{stillAuthorized=true;}));if(!stillAuthorized)return;
    const data = { ...report, ...(envelope.projectId?{projectId:envelope.projectId}:{}), photos: report.photos.map(({ base64: _bytes, ...photo }) => photo) };
    const result = store.transaction(() => {
      if(envelope.projectId)projectAccess(req.actor,envelope.projectId,true);
      const duplicate = replay(req.actor, envelope.submissionId, fingerprint);
      if (duplicate) return { ...receipt(duplicate), replayed: true };
      const id = randomUUID(), at = new Date().toISOString();
      store.db.prepare('INSERT INTO daily_reports VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, req.actor.id, req.actor.name,
        envelope.submissionId, fingerprint, report.projectName, report.region, report.reportDate, report.number,
        JSON.stringify(data), document, hash(document), report.photos.length, at);
      const insert = store.db.prepare('INSERT INTO daily_report_photos VALUES(?,?,?,?,?,?,?,?,?)');
      report.photos.forEach((photo, index) => {
        const bytes = Buffer.from(photo.base64, 'base64');
        insert.run(id, index, photo.name, photo.caption, photo.mime, photo.width, photo.height, bytes, hash(bytes));
      });
      store.audit(req.actor, 'submit', 'daily_reports', id, `提交${report.reportDate} ${report.sections[0].name}独立施工日报，${report.photos.length}张照片`);
      return { ...receipt(store.db.prepare(`SELECT ${columns} FROM daily_reports WHERE id=?`).get(id)), replayed: false };
    });
    res.status(result.replayed ? 200 : 201).json(result);
  };
  const list = (req, res) => {
    const query = z.object({ projectId:z.string().uuid().optional(), date: z.iso.date().optional(), q: z.string().trim().max(100).default(''),
      limit: z.coerce.number().int().min(1).max(50).default(20), offset: z.coerce.number().int().min(0).max(100000).default(0) }).strict().parse(req.query);
    if(query.projectId)projectAccess(req.actor,query.projectId,false);
    const scope=documentScope('daily','daily_reports',query.projectId);const where = ["(?='admin' OR author_id=?)",scope.sql], params = [req.actor.role, req.actor.id,...scope.args];
    if (query.date) { where.push('report_date=?'); params.push(query.date); }
    if (query.q) {
      where.push(`(instr(lower(project_name),lower(?))>0 OR instr(lower(author_name),lower(?))>0 OR instr(lower(number),lower(?))>0 OR EXISTS(SELECT 1 FROM json_each(daily_reports.data,'$.sections') s WHERE instr(lower(json_extract(s.value,'$.name')),lower(?))>0))`);
      params.push(query.q, query.q, query.q,query.q);
    }
    const clause = where.join(' AND ');
    const total = store.db.prepare(`SELECT COUNT(*) n FROM daily_reports WHERE ${clause}`).get(...params).n;
    const rows = store.db.prepare(`SELECT ${columns} FROM daily_reports WHERE ${clause} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...params, query.limit, query.offset);
    res.json({ items: rows.map(receipt), total, limit: query.limit, offset: query.offset, scope: req.actor.role === 'admin' ? 'all' : 'own' });
  };
  const detail = (req, res) => {
    const id = identify(req), row = owns(req, id);
    const data = JSON.parse(store.db.prepare('SELECT data FROM daily_reports WHERE id=?').get(id).data);
    const photos = store.db.prepare(`SELECT ${photoColumns} FROM daily_report_photos WHERE report_id=? ORDER BY photo_index`).all(id);
    res.json({ ...receipt(row), data, photos: photos.map(p => ({ index: p.photo_index, name: p.name, caption: p.caption,
      mime: p.mime, width: p.width, height: p.height, bytes: p.size, sha256: p.sha256 })) });
  };
  const word = (req, res) => {
    const id = identify(req), row = owns(req, id);
    const bytes = store.db.prepare('SELECT document FROM daily_reports WHERE id=?').get(id).document;
    const filename = `施工日报_${(row.section_count===1?row.section_name+'_':'').replace(/[\\/:*?"<>|]/g,'_')}${row.report_date}_${id.slice(0, 8)}.docx`;
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="daily-report-${id}.docx"; filename*=UTF-8''${encodeURIComponent(filename)}`, 'Cache-Control': 'no-store' });
    res.send(Buffer.from(bytes));
  };
  const photo = (req, res) => {
    const id = identify(req); owns(req, id);
    const index = z.coerce.number().int().min(0).max(11).parse(req.params.index);
    const row = store.db.prepare('SELECT mime,bytes FROM daily_report_photos WHERE report_id=? AND photo_index=?').get(id, index);
    if (!row) fail(404, '照片不存在');
    res.set({ 'Content-Type': row.mime, 'Cache-Control': 'no-store', 'Content-Disposition': 'inline' }).send(Buffer.from(row.bytes));
  };
  const backup = (req, res) => {
    const id = identify(req), row = owns(req, id);
    const data = JSON.parse(store.db.prepare('SELECT data FROM daily_reports WHERE id=?').get(id).data);
    const photos = store.db.prepare('SELECT bytes FROM daily_report_photos WHERE report_id=? ORDER BY photo_index').all(id);
    data.photos = data.photos.map((photo, index) => ({ ...photo, base64: Buffer.from(photos[index].bytes).toString('base64') }));
    res.set({ 'Content-Disposition': `attachment; filename="report-data-${row.report_date}-${id.slice(0, 8)}.json"`, 'Cache-Control': 'no-store' });
    res.json({ schemaVersion: 1, data });
  };
  for (const [base, authorize] of [['/api/daily-report/submissions', auth], ['/api/mobile/daily-report/submissions', mobileAuth]]) {
    if (!authorize) continue;
    app.post(base, authorize, writer, (req,res)=>submit(req,res,authorize));
    app.get(base, authorize, list);
    app.get(base + '/:id', authorize, detail);
    app.get(base + '/:id/word', authorize, word);
    app.get(base + '/:id/data', authorize, backup);
    app.get(base + '/:id/photos/:index', authorize, photo);
  }
}
