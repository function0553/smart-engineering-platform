import { createHash } from 'node:crypto';
import { fail } from './service.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
export function dailySource(db,actor,id,bytes=false){
  const row=db.prepare(`SELECT id,author_id,author_name,project_name,region,report_date,number,created_at,photo_count,document_sha256${bytes?',document':''} FROM daily_reports WHERE id=? AND (?='admin' OR author_id=?)`).get(id,actor.role,actor.id);
  if(!row)fail(404,'施工日报不存在或无原作者访问权限');
  const photos=db.prepare(`SELECT photo_index,name,caption,mime,sha256,length(bytes) byte_count${bytes?',bytes':''} FROM daily_report_photos WHERE report_id=? ORDER BY photo_index`).all(id);
  if(photos.length!==row.photo_count)fail(503,'原日报照片索引不完整，请检查原记录');
  const evidence={id:row.id,authorId:row.author_id,authorName:row.author_name,projectName:row.project_name,region:row.region,reportDate:row.report_date,number:row.number,submittedAt:row.created_at,documentSha256:row.document_sha256,photos:photos.map(({bytes:_bytes,...p})=>p)};
  if(!bytes)return {evidence};
  const word=Buffer.from(row.document);
  if(!word.length||word.length>32*1048576||sha(word)!==row.document_sha256)fail(503,'原日报Word大小或摘要异常，请检查原记录');
  const originals=[{name:'施工日报_'+row.report_date+'.docx',mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',ext:'docx',sha256:row.document_sha256,bytes:word}];
  for(const p of photos){
    const body=Buffer.from(p.bytes);
    if(!body.length||body.length>5*1048576||sha(body)!==p.sha256||!['image/png','image/jpeg'].includes(p.mime))fail(503,'原日报照片大小、格式或摘要异常，请检查原记录');
    originals.push({name:'施工日报原图_'+String(p.photo_index+1).padStart(2,'0')+(p.mime==='image/png'?'.png':'.jpg'),mime:p.mime,ext:p.mime==='image/png'?'png':'jpg',sha256:p.sha256,bytes:body});
  }
  const seen=new Set();return {evidence,originals:originals.filter(f=>{if(seen.has(f.sha256))return false;seen.add(f.sha256);return true;})};
}
