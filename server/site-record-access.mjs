import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {fail} from './service.mjs';
export const siteActions=['read','create','editOwn','editAny','submit','review','archive','withdraw','download','exportRegister','handoff','manage'];
export const siteTemplates={
 manager:{name:'项目经理',actions:siteActions},
 documenter:{name:'资料员',actions:['read','create','editOwn','editAny','submit','archive','download','exportRegister']},
 engineer:{name:'施工员',actions:['read','create','editOwn','submit','download']},
 supervisor:{name:'监理 / 复核人员',actions:['read','create','editOwn','submit','review','download']},
 material:{name:'材料员',actions:['read','create','editOwn','submit','download'],categories:['material_measurement']},
 finance:{name:'商务 / 财务',actions:['read','download','exportRegister'],categories:['site_measurement','material_measurement','construction_daily']},
 viewer:{name:'只读人员',actions:['read']},
 crew:{name:'班组负责人',actions:['read','create','editOwn','submit','download'],ownOnly:true},
};
const id=z.string().uuid();
export function createSiteAccess({db,store,acl,categories}){
 db.exec(`CREATE TABLE IF NOT EXISTS engineering_site_access_config(project_id TEXT PRIMARY KEY REFERENCES engineering_projects(id),enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),version INTEGER NOT NULL,updated_by TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS engineering_site_access_grants(project_id TEXT NOT NULL REFERENCES engineering_projects(id),user_id TEXT NOT NULL REFERENCES users(id),version INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),updated_by TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,user_id));
 CREATE TABLE IF NOT EXISTS engineering_site_reviews(record_id TEXT PRIMARY KEY REFERENCES engineering_site_records(id),state TEXT NOT NULL CHECK(state IN ('draft','submitted','approved','returned')),reviewer_id TEXT REFERENCES users(id),submitted_by TEXT,submitted_at TEXT,reviewed_by TEXT,reviewed_at TEXT,note TEXT NOT NULL DEFAULT '',evidence_hash TEXT NOT NULL DEFAULT '');
 CREATE TABLE IF NOT EXISTS engineering_site_handlers(record_id TEXT PRIMARY KEY REFERENCES engineering_site_records(id),user_id TEXT NOT NULL REFERENCES users(id),assigned_by TEXT NOT NULL,assigned_at TEXT NOT NULL,reason TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS engineering_site_access_migrations(name TEXT PRIMARY KEY);`);
 // Only the projects present at first migration retain their old workflow. New projects require review.
 if(!db.prepare("SELECT 1 FROM engineering_site_access_migrations WHERE name='initial'").get())store.transaction(()=>{
  db.prepare("INSERT OR IGNORE INTO engineering_site_access_config SELECT id,0,1,'migration',? FROM engineering_projects").run(new Date().toISOString());
  db.prepare("INSERT INTO engineering_site_access_migrations VALUES('initial')").run();
 });
 const enabled=pid=>db.prepare('SELECT enabled FROM engineering_site_access_config WHERE project_id=?').get(pid)?.enabled!==0;
 const config=pid=>db.prepare('SELECT * FROM engineering_site_access_config WHERE project_id=?').get(pid)||{project_id:pid,enabled:1,version:0};
 const review=rid=>db.prepare('SELECT * FROM engineering_site_reviews WHERE record_id=?').get(rid)||null;
 function permission(actor,pid){
  const c=acl(actor,pid),row=db.prepare('SELECT version,data FROM engineering_site_access_grants WHERE project_id=? AND user_id=?').get(pid,actor.id);
  if(c.role==='admin')return {...siteTemplates.manager,template:'manager',actions:siteActions,categories:[],wbsIds:[],ownOnly:false,enabled:enabled(pid),version:row?.version||0};
  const template=c.role==='manager'?'manager':c.role==='finance'?'finance':c.role==='viewer'?'viewer':'engineer';
  const p=row?JSON.parse(row.data):{template,...siteTemplates[template],wbsIds:[],categories:siteTemplates[template].categories||[],ownOnly:false};
  const expired=row&&p.memberRole!==c.role||p.validFrom&&Date.parse(p.validFrom)>Date.now()||p.validUntil&&Date.parse(p.validUntil)<=Date.now();
  return {...p,actions:expired?[]:c.role==='viewer'?p.actions.filter(a=>['read','download','exportRegister'].includes(a)):p.actions,categories:p.categories||[],wbsIds:p.wbsIds||[],enabled:enabled(pid),version:row?.version||0,expired:!!expired};
 }
 function can(actor,pid,action,data,creator){
  const p=permission(actor,pid);if(!p.enabled)return true;
  if(!p.actions.includes(action))return false;
  if(!data)return true;
  if(p.categories.length&&!p.categories.includes(data.category))return false;
  if(p.ownOnly&&creator&&creator!==actor.id)return false;
  if(p.wbsIds.length){let node=data.wbsId,seen=new Set();while(node&&!seen.has(node)){if(p.wbsIds.includes(node))return true;seen.add(node);const r=db.prepare('SELECT data FROM engineering_wbs WHERE project_id=? AND id=?').get(pid,node);node=r?JSON.parse(r.data).parentId:'';}return false;}
  return true;
 }
 function requireAction(actor,pid,action,data,creator){if(!can(actor,pid,action,data,creator))fail(action==='read'?404:403,action==='read'?'施工资料不存在或未授权':'没有此施工资料操作权限，请核对项目岗位、部位、类别或授权有效期');}
 function visible(actor,pid,r){try{return can(actor,pid,'read',r.data,r.created_by);}catch{return false;}}
 function clause(actor,pid){
  const p=permission(actor,pid);if(!p.enabled)return {sql:'1=1',args:[]};if(!p.actions.includes('read'))return {sql:'0=1',args:[]};
  const sql=[],args=[];if(p.categories.length){sql.push("json_extract(data,'$.category') IN ("+p.categories.map(()=>'?').join(',')+')');args.push(...p.categories);}
  if(p.ownOnly){sql.push('created_by=?');args.push(actor.id);}
  if(p.wbsIds.length){sql.push("json_extract(data,'$.wbsId') IN (WITH RECURSIVE scope(id) AS (SELECT id FROM engineering_wbs WHERE project_id=? AND id IN ("+p.wbsIds.map(()=>'?').join(',')+") UNION SELECT w.id FROM engineering_wbs w JOIN scope s ON json_extract(w.data,'$.parentId')=s.id WHERE w.project_id=?) SELECT id FROM scope)");args.push(pid,...p.wbsIds,pid);}
  return {sql:sql.length?sql.join(' AND '):'1=1',args};
 }
 function handler(rid){return db.prepare('SELECT h.*,u.name FROM engineering_site_handlers h JOIN users u ON u.id=h.user_id WHERE record_id=?').get(rid)||null;}
 function sourceClause(actor,pid){return {sql:"EXISTS(SELECT 1 FROM engineering_site_reviews rv WHERE rv.record_id=engineering_site_records.id AND rv.state IN ('submitted','approved','returned') AND (?=1 OR (rv.reviewer_id=? AND ?=1))) OR EXISTS(SELECT 1 FROM engineering_site_handlers h WHERE h.record_id=engineering_site_records.id AND h.user_id=?)",args:[enabled(pid)&&can(actor,pid,'archive')?1:0,actor.id,enabled(pid)&&can(actor,pid,'review')?1:0,actor.id]};}
 function delegated(actor,r){const v=review(r.id),h=handler(r.id);return can(actor,r.project_id,'read',r.data,r.created_by)&&((v&&['submitted','approved','returned'].includes(v.state)&&(v.reviewer_id===actor.id&&can(actor,r.project_id,'review',r.data,r.created_by)||can(actor,r.project_id,'archive',r.data,r.created_by)))||h?.user_id===actor.id);}

 const schema=z.object({template:z.enum(Object.keys(siteTemplates)),actions:z.array(z.enum(siteActions)).max(siteActions.length),categories:z.array(z.enum(Object.keys(categories))).max(7),wbsIds:z.array(id).max(100),ownOnly:z.boolean(),validFrom:z.iso.datetime().or(z.literal('')).default(''),validUntil:z.iso.datetime().or(z.literal('')).default('')}).strict();
 function write(req,b,fn){return store.transaction(()=>{const fingerprint=createHash('sha256').update(req.method+' '+req.path+'\n'+JSON.stringify(b)).digest('hex'),old=db.prepare('SELECT * FROM engineering_requests WHERE actor_id=? AND request_id=?').get(req.actor.id,b.requestId);if(old){if(old.fingerprint!==fingerprint)fail(409,'请求编号已使用');return {...JSON.parse(old.result),replayed:true};}const result=fn();db.prepare('INSERT INTO engineering_requests VALUES(?,?,?,?)').run(req.actor.id,b.requestId,fingerprint,JSON.stringify(result));return result;});}
 function mount(app,base,authorize,writer){
  const route=base+'/projects/:pid/site-access';
  app.get(route,authorize,(req,res)=>{const c=acl(req.actor,req.params.pid),p=permission(req.actor,c.project.id),manage=can(req.actor,c.project.id,'manage')&&['admin','manager'].includes(c.role);const members=manage?db.prepare('SELECT m.user_id,u.name,u.active,m.role FROM engineering_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=?').all(c.project.id):[];
   res.set('Cache-Control','private, no-store').json({actorId:req.actor.id,config:config(c.project.id),permission:p,canManage:manage,templates:siteTemplates,actions:siteActions,members:members.map(m=>({...m,effective:permission({id:m.user_id,role:db.prepare('SELECT role FROM users WHERE id=?').get(m.user_id).role},c.project.id),grant:db.prepare('SELECT version,data FROM engineering_site_access_grants WHERE project_id=? AND user_id=?').get(c.project.id,m.user_id)}))});
  });
  app.put(route,authorize,writer,(req,res)=>{const c=acl(req.actor,req.params.pid,true);if(!['admin','manager'].includes(c.role)||!can(req.actor,c.project.id,'manage'))fail(403,'仅获授权项目经理可管理施工资料权限');
   const b=z.object({requestId:id,version:z.number().int().nonnegative(),enabled:z.literal(true),reason:z.string().trim().min(1).max(500)}).strict().parse(req.body);
   res.json(write(req,b,()=>{const old=config(c.project.id);if(old.version!==b.version)fail(409,'权限配置已变化，请刷新');const at=new Date().toISOString();db.prepare('INSERT INTO engineering_site_access_config VALUES(?,1,?,?,?) ON CONFLICT(project_id) DO UPDATE SET enabled=1,version=excluded.version,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(c.project.id,old.version+1,req.actor.id,at);store.audit(req.actor,'site_access_enable','engineering_projects',c.project.id,b.reason);return {version:old.version+1,enabled:true};}));
  });
  app.put(route+'/:uid',authorize,writer,(req,res)=>{const c=acl(req.actor,req.params.pid,true);if(!['admin','manager'].includes(c.role)||!can(req.actor,c.project.id,'manage'))fail(403,'仅获授权项目经理可分配施工资料权限');
   const uid=id.parse(req.params.uid),b=z.object({requestId:id,version:z.number().int().nonnegative(),data:schema,reason:z.string().trim().min(1).max(500)}).strict().parse(req.body);
   res.json(write(req,b,()=>{const member=db.prepare('SELECT m.role,u.active FROM engineering_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=? AND m.user_id=?').get(c.project.id,uid);if(!member||!member.active)fail(400,'请选择本项目有效成员');if(c.role!=='admin'&&uid===req.actor.id)fail(403,'项目经理不能修改自身授权，请管理员办理');if(b.data.actions.includes('manage')&&member.role!=='manager')fail(400,'只有项目经理可获权限管理能力');
    if(b.data.actions.some(a=>['review','archive'].includes(a))&&!b.data.actions.includes('download'))fail(400,'复核或归档人员须具备原件读取权限');if(!b.data.actions.includes('read')&&b.data.actions.length)fail(400,'办理权限必须同时包含查看');if(b.data.validFrom&&b.data.validUntil&&Date.parse(b.data.validFrom)>=Date.parse(b.data.validUntil))fail(400,'授权结束时间须晚于开始时间');
    for(const nid of b.data.wbsIds)if(!db.prepare('SELECT 1 FROM engineering_wbs WHERE project_id=? AND id=?').get(c.project.id,nid))fail(400,'授权施工部位不属于本项目');
    const old=db.prepare('SELECT version FROM engineering_site_access_grants WHERE project_id=? AND user_id=?').get(c.project.id,uid);if((old?.version||0)!==b.version)fail(409,'成员授权已变化，请刷新');const at=new Date().toISOString();db.prepare('INSERT INTO engineering_site_access_grants VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,user_id) DO UPDATE SET version=excluded.version,data=excluded.data,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(c.project.id,uid,b.version+1,JSON.stringify({...b.data,memberRole:member.role}),req.actor.id,at);
    db.prepare('DELETE FROM engineering_site_media_grants WHERE project_id=? AND user_id=?').run(c.project.id,uid);store.audit(req.actor,'site_access_grant','engineering_projects',c.project.id,JSON.stringify({userId:uid,beforeVersion:b.version,after:b.data,reason:b.reason}));return {version:b.version+1};}));
  });
 }
 return {enabled,config,permission,can,requireAction,visible,clause,review,delegated,sourceClause,handler,mount};
}
