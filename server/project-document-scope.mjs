import {fail} from './service.mjs';
// A source may be claimed once. Human-readable project names never determine identity.
export function documentProjects(db,kind,id){
 const table=kind==='daily'?'daily_reports':'photo_archives',row=db.prepare(`SELECT data FROM ${table} WHERE id=?`).get(id),projects=new Set();
 if(row){const p=JSON.parse(row.data).projectId;if(p)projects.add(p);}
 for(const r of db.prepare('SELECT project_id FROM engineering_documents WHERE kind=? AND document_id=?').all(kind,id))projects.add(r.project_id);
 if(kind==='daily')for(const r of db.prepare("SELECT project_id FROM engineering_site_records WHERE json_extract(data,'$.dailyReportId')=?").all(id))projects.add(r.project_id);
 return [...projects];
}
export function requireDocumentProject(db,kind,id,pid){if(documentProjects(db,kind,id).some(p=>p!==pid))fail(409,'资料已属于其他项目，不能跨项目关联或归入');}
export function documentScope(kind,alias,pid){
 const doc=`SELECT 1 FROM engineering_documents dp WHERE dp.kind='${kind}' AND dp.document_id=${alias}.id`,site=`SELECT 1 FROM engineering_site_records sp WHERE json_extract(sp.data,'$.dailyReportId')=${alias}.id`,meta=`json_extract(${alias}.data,'$.projectId')`;
 return pid?{sql:`(${meta}=? OR EXISTS(${doc} AND dp.project_id=?)${kind==='daily'?` OR EXISTS(${site} AND sp.project_id=?)`:''})`,args:kind==='daily'?[pid,pid,pid]:[pid,pid]}:{sql:`(COALESCE(${meta},'')='' AND NOT EXISTS(${doc})${kind==='daily'?` AND NOT EXISTS(${site})`:''})`,args:[]};
}
