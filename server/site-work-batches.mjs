import {sameSiteContext} from './site-record-policy.mjs';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {fail} from './service.mjs';
import {siteWorkSteps} from './site-work-steps.mjs';
import {buildEngineeringSheets} from './engineering-export.mjs';
const id=z.string().uuid(),text=n=>z.string().trim().min(1).max(n),date=z.iso.date();
const rule=z.object({mode:z.enum(['required','optional','not_applicable']),reason:z.string().trim().max(400).default('')}).strict().superRefine((r,c)=>{if(r.mode==='not_applicable'&&!r.reason)c.addIssue({code:'custom',message:'不适用必须填写原因',path:['reason']});});
const parsed=r=>r?{...r,data:JSON.parse(r.data),snapshot:JSON.parse(r.snapshot)}:null;
export function createSiteBatchService({db,store,access,mutate,snapshot,categories,files,parseRecord,permissions}){
 const categoryRules=z.object(Object.fromEntries(Object.keys(categories).map(k=>[k,rule]))).strict();
 const stepRules=z.object(Object.fromEntries(siteWorkSteps.map(s=>[s.id,rule]))).strict();
 const schema=z.object({code:text(40),title:text(120),date,crew:text(80),shift:z.string().trim().max(80).default(''),wbsId:id,taskId:id.or(z.literal('')).default(''),note:z.string().trim().max(2000).default(''),requirements:z.object({categories:categoryRules,photos:stepRules,videos:stepRules}).strict()}).strict();
 db.exec(`CREATE TABLE IF NOT EXISTS engineering_site_batches (
 id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES engineering_projects(id),code TEXT NOT NULL COLLATE NOCASE,
 state TEXT NOT NULL CHECK(state IN ('draft','confirmed','withdrawn')),version INTEGER NOT NULL,data TEXT NOT NULL CHECK(json_valid(data)),snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
 created_by TEXT NOT NULL REFERENCES users(id),created_name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,code));
 CREATE TABLE IF NOT EXISTS engineering_site_batch_events (
 id TEXT PRIMARY KEY,batch_id TEXT NOT NULL REFERENCES engineering_site_batches(id),version INTEGER NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL,snapshot TEXT NOT NULL,action TEXT NOT NULL,reason TEXT NOT NULL,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS engineering_site_batch_events_batch ON engineering_site_batch_events(batch_id,at,id);`);
 const now=()=>new Date().toISOString(),get=(pid,bid)=>{const row=parsed(db.prepare('SELECT * FROM engineering_site_batches WHERE project_id=? AND id=?').get(pid,id.parse(bid)));if(!row)fail(404,'作业批次不存在');return row;};
 const active=c=>{if(c.project.state!=='active')fail(409,'项目未在施工中，不能办理作业批次');};
 const manager=c=>{if(!['admin','manager'].includes(c.role))fail(403,'作业批次及资料要求由项目经理确认');};
 function event(req,r,action,reason){
  db.prepare('INSERT INTO engineering_site_batch_events VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),r.id,r.version,r.state,JSON.stringify(r.data),JSON.stringify(r.snapshot),action,reason,req.actor.id,req.actor.name,now());
  db.prepare('INSERT INTO engineering_history VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),r.project_id,r.id,'tasks',req.actor.id,req.actor.name,action,reason,now());
  store.audit(req.actor,action,'engineering_site_batches',r.id,r.data.title);
 }
 function capture(pid,data){
  if(!data.batchId)return null;const r=get(pid,data.batchId);
  if(r.state!=='confirmed')fail(409,'请选择已确认且未撤回的作业批次');
  if(r.data.wbsId!==data.wbsId||r.data.taskId!==data.taskId||r.data.date!==data.recordDate)fail(400,'资料部位、任务和日期必须与作业批次一致');
  const current=snapshot(pid,{wbsId:r.data.wbsId,taskId:r.data.taskId});
  if(!sameSiteContext(current,r.snapshot))fail(409,'批次的施工部位或任务已变化，请先核对批次归属');
  return {id:r.id,code:r.data.code,title:r.data.title,date:r.data.date,crew:r.data.crew,shift:r.data.shift,version:r.version,requirements:r.data.requirements};
 }
 function check(pid,bid,actor){
  const batch=get(pid,bid),project=db.prepare('SELECT id,data FROM engineering_projects WHERE id=?').get(pid),confirmation=db.prepare("SELECT actor_name,at,version FROM engineering_site_batch_events WHERE batch_id=? AND action='site_batch_confirmed' ORDER BY version DESC LIMIT 1").get(bid)||null;
  const scope=permissions.clause(actor,pid),source=permissions.sourceClause(actor,pid);
  const where="project_id=? AND json_extract(data,'$.batchId')=? AND (json_extract(data,'$.dailyReportId') IS NULL OR EXISTS(SELECT 1 FROM daily_reports d WHERE d.id=json_extract(engineering_site_records.data,'$.dailyReportId') AND (?='admin' OR d.author_id=?)) OR ("+source.sql+")) AND ("+scope.sql+")";
  const count=db.prepare('SELECT COUNT(*) n FROM engineering_site_records WHERE '+where).get(pid,bid,actor.role,actor.id,...source.args,...scope.args).n;
  const nfiles=db.prepare('SELECT COUNT(*) n FROM engineering_site_files WHERE record_id IN (SELECT id FROM engineering_site_records WHERE '+where+')').get(pid,bid,actor.role,actor.id,...source.args,...scope.args).n;
  if(count>2000||nfiles>10000)fail(413,'本批次可见资料超过2000份或原件超过10000份，未生成截断检查');
  const records=db.prepare('SELECT * FROM engineering_site_records WHERE '+where).all(pid,bid,actor.role,actor.id,...source.args,...scope.args).map(parseRecord).map(r=>({...r,files:files(r.id).filter(f=>!f.removed_at)}));
  const rows=[],rules=batch.data.requirements,valid=r=>r.state==='archived'&&(r.files.length>0||r.data.category==='supervision_daily'&&r.data.supervision);
  for(const [key,label] of Object.entries(categories)){
   const matches=records.filter(r=>r.data.category===key),archived=matches.filter(valid),drafts=matches.filter(r=>r.state==='draft').length;
   const spec=rules.categories[key];rows.push({key,label,kind:'category',...spec,archived:archived.length,drafts,provided:archived.length>0,required:spec.mode==='required'});
   if(!['work_photos','work_videos'].includes(key))continue;
   for(const step of siteWorkSteps){const spec=rules[key==='work_photos'?'photos':'videos'][step.id];rows.push({key:key+':'+step.id,label:step.name,category:label,kind:'step',...spec,archived:archived.filter(r=>r.files.some(f=>f.step_id===step.id)).length,drafts:matches.filter(r=>r.state==='draft'&&r.files.some(f=>f.step_id===step.id)).length,provided:archived.some(r=>r.files.some(f=>f.step_id===step.id)),required:rules.categories[key].mode==='required'&&spec.mode==='required'});}
  }
  return {batch,project:{id:project.id,name:JSON.parse(project.data).name},confirmation,rows,missing:rows.filter(r=>r.required&&!r.provided).map(r=>r.key),visibleRecords:records.length,observedAt:now(),scope:'仅当前账号可见且已归档的有效原件或完整在线监理日报；草稿不抵归档覆盖。未提供不代表工程未施工或验收未通过。'};
 }
 function workbook(view,actor){
  const status=r=>r.mode==='not_applicable'?'不适用':r.provided?'已提供（归档）':r.drafts?'仅有草稿':'当前可见范围未提供';
  const columns=[{label:'分类 / 工序',key:'label',width:40},{label:'所属资料',key:r=>r.category||r.label,width:28},{label:'要求',key:r=>({required:'必需',optional:'选填',not_applicable:'不适用'})[r.mode],width:18},{label:'不适用原因','key':'reason',width:45},{label:'当前可见覆盖','key':status,width:26},{label:'可见归档份数',key:'archived',kind:'integer',width:20},{label:'可见草稿份数',key:'drafts',kind:'integer',width:20},{label:'本项是否待补',key:r=>r.required&&!r.provided?'是':'否',width:20}];
  return buildEngineeringSheets([{name:'分类要求',columns,records:view.rows.filter(r=>r.kind==='category')},{name:'工序要求',columns,records:view.rows.filter(r=>r.kind==='step')},{name:'批次与口径',columns:[{label:'项目 / 批次信息',key:'key',width:28},{label:'内容',key:'value',width:100}],records:[{key:'项目名称',value:view.project.name},{key:'项目ID',value:view.project.id},{key:'冻结施工部位',value:view.batch.snapshot.path.map(n=>n.code+' '+n.title).join(' / ')},{key:'冻结关联任务',value:view.batch.snapshot.task?view.batch.snapshot.task.id+' '+view.batch.snapshot.task.title:'无关联任务'},{key:'要求确认人',value:view.confirmation?.actor_name||'未确认'},{key:'要求确认时间（UTC）',value:view.confirmation?.at||'未确认'},{key:'批次',value:view.batch.data.code+' '+view.batch.data.title},{key:'批次ID',value:view.batch.id},{key:'批次状态',value:({draft:'草稿',confirmed:'已确认',withdrawn:'已撤回'})[view.batch.state]},{key:'批次版本',value:String(view.batch.version)},{key:'确认要求版本',value:view.confirmation?String(view.confirmation.version):'未确认'},{key:'作业日期',value:view.batch.data.date},{key:'班组 / 时段',value:view.batch.data.crew+' / '+view.batch.data.shift},{key:'检查人',value:actor.name},{key:'检查时间（UTC）',value:view.observedAt},{key:'口径',value:view.scope},{key:'要求冻结',value:'确认后不可改写；旧资料不自动分配批次。工序必需只在父分类必需时参与待补判断，不适用须注明原因。'},{key:'复核与工程验收',value:'这里只检查当前可见归档资料覆盖，不是资料复核、工程验收、进度或计量结论；草稿/撤回批次只供查看，确认批次方可新增关联。'}]}],{title:view.batch.data.title+' 应交资料检查',exportedAt:view.observedAt});
 }
 function batchVisible(actor,pid,r){return Object.keys(categories).some(category=>permissions.can(actor,pid,'read',{wbsId:r.data.wbsId,category},undefined));}
 function mount(app,base,authorize,writer){
  const route=base+'/projects/:pid/site-records/batches';
  app.get(route,authorize,(req,res)=>{const c=access(req);z.object({}).strict().parse(req.query);const rows=db.prepare('SELECT * FROM engineering_site_batches WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 1001').all(c.project.id);if(rows.length>1000)fail(413,'批次超过1000项，暂不返回截断列表');res.setHeader('Cache-Control','private, no-store');res.json({batches:rows.map(parsed).filter(r=>batchVisible(req.actor,c.project.id,r)),canManage:c.project.state==='active'&&['admin','manager'].includes(c.role)&&permissions.can(req.actor,c.project.id,'manage')});});
  app.post(route,authorize,writer,(req,res)=>{const body=z.object({requestId:id,data:schema}).strict().parse(req.body);const result=mutate(req,body,req.params.pid+':batch:create',manager,c=>{active(c);if(db.prepare('SELECT COUNT(*) n FROM engineering_site_batches WHERE project_id=?').get(c.project.id).n>=1000)fail(413,'单项目作业批次最多1000项');if(db.prepare('SELECT 1 FROM engineering_site_batches WHERE project_id=? AND code=?').get(c.project.id,body.data.code))fail(409,'作业批次编号已存在');const bid=randomUUID(),at=now(),snap=snapshot(c.project.id,body.data);db.prepare('INSERT INTO engineering_site_batches VALUES(?,?,?,\'draft\',1,?,?,?,?,?,?)').run(bid,c.project.id,body.data.code,JSON.stringify(body.data),JSON.stringify(snap),req.actor.id,req.actor.name,at,at);const r=get(c.project.id,bid);event(req,r,'site_batch_create','创建批次草稿');return {id:bid,version:1};});res.status(result.replayed?200:201).json(result);});
  app.put(route+'/:bid',authorize,writer,(req,res)=>{const body=z.object({requestId:id,version:z.number().int().positive(),data:schema,reason:text(400)}).strict().parse(req.body);res.json(mutate(req,body,req.params.pid+':batch:'+req.params.bid+':edit',manager,c=>{active(c);const r=get(c.project.id,req.params.bid);if(r.version!==body.version)fail(409,'批次版本已更新，请刷新核对');if(r.state!=='draft')fail(409,'已确认或撤回批次不可改写');if(db.prepare('SELECT 1 FROM engineering_site_batches WHERE project_id=? AND code=? AND id<>?').get(c.project.id,body.data.code,r.id))fail(409,'作业批次编号已存在');db.prepare('UPDATE engineering_site_batches SET code=?,data=?,snapshot=?,version=version+1,updated_at=? WHERE id=?').run(body.data.code,JSON.stringify(body.data),JSON.stringify(snapshot(c.project.id,body.data)),now(),r.id);const saved=get(c.project.id,r.id);event(req,saved,'site_batch_edit',body.reason);return {id:r.id,version:saved.version};}));});
  app.post(route+'/:bid/state',authorize,writer,(req,res)=>{const body=z.object({requestId:id,version:z.number().int().positive(),state:z.enum(['confirmed','withdrawn']),reason:text(400)}).strict().parse(req.body);res.json(mutate(req,body,req.params.pid+':batch:'+req.params.bid+':state',manager,c=>{active(c);const r=get(c.project.id,req.params.bid);if(r.version!==body.version)fail(409,'批次版本已更新，请刷新核对');if(r.state==='withdrawn'||body.state==='confirmed'&&r.state!=='draft')fail(409,'批次状态已变化，请刷新核对');if(body.state==='withdrawn'&&db.prepare("SELECT 1 FROM engineering_site_records WHERE project_id=? AND state<>'withdrawn' AND json_extract(data,'$.batchId')=?").get(c.project.id,r.id))fail(409,'仍有关联的未撤回资料，请先处理资料后再撤回批次');if(body.state==='confirmed'&&!sameSiteContext(snapshot(c.project.id,r.data),r.snapshot))fail(409,'部位或任务归属已变化，请先修改批次草稿再确认');db.prepare('UPDATE engineering_site_batches SET state=?,version=version+1,updated_at=? WHERE id=?').run(body.state,now(),r.id);const saved=get(c.project.id,r.id);event(req,saved,'site_batch_'+body.state,body.reason);return {id:r.id,version:saved.version};}));});
  app.get(route+'/:bid',authorize,(req,res)=>{const c=access(req),r=get(c.project.id,req.params.bid);if(!batchVisible(req.actor,c.project.id,r))fail(404,'作业批次不存在或未授权');res.setHeader('Cache-Control','private, no-store');res.json({batch:r,events:db.prepare('SELECT * FROM engineering_site_batch_events WHERE batch_id=? ORDER BY at,id').all(r.id).map(e=>({...e,data:JSON.parse(e.data),snapshot:JSON.parse(e.snapshot)}))});});
  app.get(route+'/:bid/check',authorize,(req,res)=>{const c=access(req),q=z.object({format:z.literal('xlsx').optional()}).strict().parse(req.query);if(!batchVisible(req.actor,c.project.id,get(c.project.id,req.params.bid)))fail(404,'作业批次不存在或未授权');if(q.format)permissions.requireAction(req.actor,c.project.id,'exportRegister');const view=store.transaction(()=>check(c.project.id,req.params.bid,req.actor));res.setHeader('Cache-Control','private, no-store');if(!q.format){res.json(view);return;}const b=workbook(view,req.actor);res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');res.setHeader('Content-Disposition',`attachment; filename="batch-requirements.xlsx"; filename*=UTF-8''${encodeURIComponent('批次应交资料检查.xlsx')}`);res.setHeader('X-Content-Type-Options','nosniff');res.send(b);});
 }
 return {mount,capture,get,check};
}
