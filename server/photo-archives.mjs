import {prepareTemplatePhoto} from './template-photo-original.mjs';
import {documentScope,documentProjects} from './project-document-scope.mjs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { fail } from './service.mjs';
import { photoTemplate, validateArchivePhoto, generatePhotoArchive } from './photo-archive-document.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const text = (max, required = false) => z.string().trim().max(max).min(required ? 1 : 0).refine(v => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v), '文字含无效字符');
const date = z.union([z.literal(''), z.iso.date()]); const id = z.string().uuid();
export const archiveSchema = z.object({ title: text(100, true), projectName: text(150, true), roadName: text(80, true), segments: z.array(z.object({
  id, start: text(40), end: text(40), content: text(100), completedAt: date,
  stages: z.array(z.object({ id, name: text(50, true), completedAt: date }).strict()).min(1).max(16),
}).strict().superRefine((s, c) => {
  if (!s.content && (!s.start || !s.end)) c.addIssue({ code:'custom', message:'请填写起止桩号，或填写施工内容（如探坑）', path:['start'] });
  if (!s.content) {
    const parse = value => /^K\d+\+\d{1,3}(?:\.\d{1,3})?$/i.test(value) ? Number(value.slice(1).split('+')[0]) * 1000 + Number(value.split('+')[1]) : NaN;
    if (!Number.isFinite(parse(s.start)) || !Number.isFinite(parse(s.end)) || parse(s.start) >= parse(s.end)) c.addIssue({ code:'custom', message:'桩号格式如 K0+000，结束桩号应大于开始桩号', path:['end'] });
  }
  if (new Set(s.stages.map(x=>x.id)).size !== s.stages.length) c.addIssue({ code:'custom', message:'工序编号重复', path:['stages'] });
})).min(1).max(32) }).strict().superRefine((a,c)=>{ if(new Set(a.segments.map(s=>s.id)).size!==a.segments.length)c.addIssue({code:'custom',message:'路段编号重复',path:['segments']}); });
const summary = row => ({ id:row.id, authorId:row.author_id, authorName:row.author_name, title:row.title, projectName:row.project_name, roadName:row.road_name, version:row.version, createdAt:row.created_at, updatedAt:row.updated_at });
const photoView = p => ({id:p.id,segmentId:p.segment_id,stageId:p.stage_id,name:p.name,caption:p.caption,mime:p.mime,width:p.width,height:p.height,bytes:p.size,sha256:p.sha256,createdAt:p.created_at});
const photoColumns = 'id,segment_id,stage_id,name,caption,mime,width,height,length(bytes) size,sha256,created_at';

export function mountPhotoArchiveRoutes(app, {store, auth, mobileAuth, writer,projectAccess}) {
  const owns = req => { const row=store.db.prepare("SELECT * FROM photo_archives WHERE id=? AND (?='admin' OR author_id=?)").get(id.parse(req.params.id),req.actor.role,req.actor.id); if(!row)fail(404,'资料册不存在或无权查看');if(req.query.projectId){const pid=id.parse(req.query.projectId);projectAccess(req.actor,pid,false);if(!documentProjects(store.db,'photo',row.id).includes(pid))fail(404,'资料册不属于当前项目');}if(req.method!=='GET')for(const pid of documentProjects(store.db,'photo',row.id))projectAccess(req.actor,pid,true);return row; };
  const images = archiveId => store.db.prepare(`SELECT ${photoColumns} FROM photo_archive_images WHERE archive_id=? ORDER BY created_at,id`).all(archiveId);
  const detail = row => ({...summary(row),data:(( {projectId:_projectId,...data})=>data)(JSON.parse(row.data)),photos:images(row.id).map(photoView),exports:store.db.prepare('SELECT id,archive_version version,photo_count photoCount,created_at createdAt,document_sha256 documentSha256 FROM photo_archive_exports WHERE archive_id=? ORDER BY created_at DESC,id DESC').all(row.id)});
  const parse = value => { const result=archiveSchema.safeParse(value); if(!result.success)fail(400,result.error.issues[0].message); return result.data; };
  for(const [base,authorize] of [['/api/photo-archives',auth],['/api/mobile/photo-archives',mobileAuth]]) {
    app.get(base+'/template',authorize,(req,res)=>res.json({sourceSha256:photoTemplate.sourceSha256,projectName:photoTemplate.defaultProject,roadName:photoTemplate.defaultRoad,stages:photoTemplate.stages,maxStagePhotos:6,maxPhotoBytes:5242880,maxArchiveBytes:25165824}));
    app.get(base,authorize,(req,res)=>{
      const {q,offset,limit,projectId}=z.object({projectId:id.optional(),q:z.string().trim().max(100).default(''),offset:z.coerce.number().int().min(0).default(0),limit:z.coerce.number().int().min(1).max(50).default(20)}).strict().parse(req.query);
      const scoped=documentScope('photo','photo_archives',projectId);if(projectId)projectAccess(req.actor,projectId,false);const where="(?='admin' OR author_id=?) AND (?='' OR instr(lower(title||' '||project_name||' '||road_name||' '||author_name),lower(?))>0) AND "+scoped.sql, params=[req.actor.role,req.actor.id,q,q,...scoped.args];
      res.json({items:store.db.prepare(`SELECT * FROM photo_archives WHERE ${where} ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`).all(...params,limit,offset).map(summary),total:store.db.prepare(`SELECT COUNT(*) n FROM photo_archives WHERE ${where}`).get(...params).n,offset,limit});
    });
    app.post(base,authorize,writer,(req,res)=>{
      const {creationId,data,projectId}=z.object({creationId:id,projectId:id.optional(),data:z.unknown()}).strict().parse(req.body); const value={...parse(data),...(projectId?{projectId}:{})};
      const row=store.transaction(()=>{
        if(projectId)projectAccess(req.actor,projectId,true);
        const existing=store.db.prepare('SELECT * FROM photo_archives WHERE id=?').get(creationId);
        if(existing){ if(existing.author_id!==req.actor.id || existing.data!==JSON.stringify(value))fail(409,'资料册编号已使用，请刷新后重试'); return existing; }
        const at=new Date().toISOString(); store.db.prepare('INSERT INTO photo_archives VALUES(?,?,?,?,?,?,?,1,?,?)').run(creationId,req.actor.id,req.actor.name,value.title,value.projectName,value.roadName,JSON.stringify(value),at,at);
        store.audit(req.actor,'create','photo_archives',creationId,'创建施工影像资料册');return store.db.prepare('SELECT * FROM photo_archives WHERE id=?').get(creationId);
      });res.status(201).json(detail(row));
    });
    app.get(base+'/:id',authorize,(req,res)=>res.json(detail(owns(req))));
    app.put(base+'/:id',authorize,writer,(req,res)=>{
      const body=z.object({version:z.number().int().positive(),data:z.unknown()}).strict().parse(req.body),value=parse(body.data);
      const row=store.transaction(()=>{const row=owns(req);const pid=JSON.parse(row.data).projectId;if(pid)value.projectId=pid;if(row.version!==body.version)fail(409,'资料册已被其他设备修改，请先重新加载；本机修改仍保留');
        for(const photo of images(row.id))if(!value.segments.some(s=>s.id===photo.segment_id && s.stages.some(x=>x.id===photo.stage_id)))fail(409,'此路段或工序还有照片，请先移除照片');
        store.db.prepare('UPDATE photo_archives SET title=?,project_name=?,road_name=?,data=?,version=version+1,updated_at=? WHERE id=?').run(value.title,value.projectName,value.roadName,JSON.stringify(value),new Date().toISOString(),row.id);
        store.audit(req.actor,'update','photo_archives',row.id,'保存施工影像填写内容');return store.db.prepare('SELECT * FROM photo_archives WHERE id=?').get(row.id);
      });res.json(detail(row));
    });
    app.post(base+'/:id/photos',authorize,writer,async(req,res)=>{
      owns(req);
      const input=z.object({id,segmentId:id,stageId:id,name:text(180,true),caption:text(500),mime:z.enum(['image/png','image/jpeg']),base64:z.string().max(7_000_000),width:z.number().int().min(1).max(16000),height:z.number().int().min(1).max(16000)}).strict().parse(req.body);
      let p,bytes;try{p=await prepareTemplatePhoto(input);bytes=validateArchivePhoto(p);}catch(e){fail(400,e.message);}
      let stillAuthorized=false;authorize(req,res,()=>writer(req,res,()=>{stillAuthorized=true;}));if(!stillAuthorized)return;
      const digest=hash(bytes);
      const result=store.transaction(()=>{const row=owns(req),data=JSON.parse(row.data);
        if(!data.segments.some(s=>s.id===p.segmentId && s.stages.some(x=>x.id===p.stageId)))fail(409,'工序不存在，请先保存路段');
        const existing=store.db.prepare(`SELECT ${photoColumns} FROM photo_archive_images WHERE archive_id=? AND segment_id=? AND stage_id=? AND sha256=?`).get(row.id,p.segmentId,p.stageId,digest);
        if(existing)return {photo:photoView(existing),replayed:true};
        const total=store.db.prepare('SELECT COUNT(*) n,coalesce(sum(length(bytes)),0) size FROM photo_archive_images WHERE archive_id=?').get(row.id);
        if(total.n>=120 || total.size+bytes.length>24*1024*1024)fail(400,'每册最多120张原图、合计24MB，请另建资料册');
        if(store.db.prepare('SELECT COUNT(*) n FROM photo_archive_images WHERE archive_id=? AND segment_id=? AND stage_id=?').get(row.id,p.segmentId,p.stageId).n>=6)fail(400,'每道工序最多6张照片');
        if(store.db.prepare('SELECT 1 FROM photo_archive_images WHERE id=?').get(p.id))fail(409,'照片编号已使用');
        const at=new Date().toISOString();store.db.prepare('INSERT INTO photo_archive_images VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(p.id,row.id,p.segmentId,p.stageId,p.name,p.caption,p.mime,p.width,p.height,bytes,digest,at,req.actor.id);
        store.db.prepare('UPDATE photo_archives SET updated_at=? WHERE id=?').run(at,row.id);store.audit(req.actor,'upload','photo_archives',row.id,'上传工序原图');
        return {photo:photoView(store.db.prepare(`SELECT ${photoColumns} FROM photo_archive_images WHERE id=?`).get(p.id)),replayed:false};
      });res.status(result.replayed?200:201).json(result);
    });
    app.get(base+'/:id/photos/:photoId',authorize,(req,res)=>{const row=owns(req),p=store.db.prepare('SELECT mime,bytes FROM photo_archive_images WHERE id=? AND archive_id=?').get(id.parse(req.params.photoId),row.id);if(!p)fail(404,'照片不存在');res.type(p.mime).set('Content-Disposition','inline').send(Buffer.from(p.bytes));});
    app.delete(base+'/:id/photos/:photoId',authorize,writer,(req,res)=>{store.transaction(()=>{const row=owns(req);const result=store.db.prepare('DELETE FROM photo_archive_images WHERE id=? AND archive_id=?').run(id.parse(req.params.photoId),row.id);if(!result.changes)fail(404,'照片不存在');store.db.prepare('UPDATE photo_archives SET updated_at=? WHERE id=?').run(new Date().toISOString(),row.id);store.audit(req.actor,'remove','photo_archives',row.id,'移除资料册中的照片，已生成版本保留');});res.json({removed:true});});
    app.post(base+'/:id/exports',authorize,writer,(req,res)=>{
      const {exportId,version,snapshot}=z.object({exportId:id,version:z.number().int().positive(),snapshot:z.string().max(1_000_000).optional()}).strict().parse(req.body);
      const result=store.transaction(()=>{const row=owns(req);
        const existing=store.db.prepare('SELECT * FROM photo_archive_exports WHERE id=?').get(exportId);
        if(existing){if(existing.archive_id!==row.id)fail(409,'生成编号已使用');return {id:existing.id,createdAt:existing.created_at,photoCount:existing.photo_count,replayed:true};}
        if(version!==row.version)fail(409,'填写内容已更新，请重新加载后生成');
        const photos=store.db.prepare('SELECT * FROM photo_archive_images WHERE archive_id=? ORDER BY created_at,id').all(row.id);
        if(!photos.length)fail(400,'请至少上传一张工序照片后生成');
        // Older clients remain compatible. New clients freeze this original
        // request body so a retry cannot silently export another device's edits.
        // The existing-id receipt above always wins, preserving its old bytes.
        if(snapshot!==undefined){
          const current=JSON.stringify({data:(( {projectId:_projectId,...data})=>data)(JSON.parse(row.data)),photos:photos.map(p=>({id:p.id,segmentId:p.segment_id,stageId:p.stage_id,name:p.name,caption:p.caption,mime:p.mime,width:p.width,height:p.height,bytes:p.bytes.length}))});
          if(current!==snapshot)fail(409,'填写内容或原图已更新，本次未生成；请刷新核对后重新生成');
        }
        const data=JSON.parse(row.data),bytes=generatePhotoArchive(data,photos),at=new Date().toISOString();
        store.db.prepare('INSERT INTO photo_archive_exports VALUES(?,?,?,?,?,?,?,?,?)').run(exportId,row.id,row.version,JSON.stringify(data),bytes,hash(bytes),photos.length,at,req.actor.id);
        for(const p of photos)store.db.prepare('INSERT INTO photo_archive_export_images VALUES(?,?,?,?,?,?,?,?,?,?)').run(exportId,p.id,p.segment_id,p.stage_id,p.name,p.caption,p.mime,p.width,p.height,p.bytes);
        store.audit(req.actor,'export','photo_archives',row.id,'按原模板生成施工影像汇总 Word');return {id:exportId,createdAt:at,photoCount:photos.length,replayed:false};
      });res.status(result.replayed?200:201).json(result);
    });
    app.get(base+'/:id/exports/:exportId/word',authorize,(req,res)=>{const row=owns(req),e=store.db.prepare('SELECT document FROM photo_archive_exports WHERE archive_id=? AND id=?').get(row.id,id.parse(req.params.exportId));if(!e)fail(404,'生成版本不存在');res.set({'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','Content-Disposition':`attachment; filename="photo-archive.docx"; filename*=UTF-8''${encodeURIComponent('施工影像_'+row.road_name+'_'+req.params.exportId.slice(0,8)+'.docx')}`}).send(Buffer.from(e.document));});
  }
}
