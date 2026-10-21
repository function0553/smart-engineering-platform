import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {createReadStream, closeSync, chmodSync, lstatSync, mkdtempSync, openSync, readSync, readdirSync, rmSync, writeSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Transform} from 'node:stream';
import {Zip, ZipPassThrough, strToU8} from 'fflate';
import {z} from 'zod';
import {BusinessError,fail} from './service.mjs';
import {siteWorkSteps} from './site-work-steps.mjs';

export const siteLibraryLimits=Object.freeze({maxBytes:1073741824,maxFiles:1000,maxRecords:1000,grantTtlMs:300000,maxConcurrent:2,maxCacheBytes:2147483648,maxCachedPackages:20,buildTimeoutMs:120000,maxDownloads:4,maxDownloadsPerActor:2,maxDownloadsPerPackage:2,maxDownloadMs:1800000});
const maxGeneratedWordBytes=16*1048576;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const id=z.string().uuid();
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v,'资料日期无效');
const filterShape={projectId:id.optional(),wbsId:id.optional(),from:day.optional(),to:day.optional(),state:z.enum(['draft','archived','withdrawn']).optional(),q:z.string().trim().max(160).optional()};
const querySchema=z.object({...filterShape,limit:z.coerce.number().int().min(1).max(200).default(100),offset:z.coerce.number().int().min(0).max(1000000).default(0)}).strict();
const packageSchema=z.object({...filterShape,requestId:id}).strict();
const packageCookieName='site_package_download';
const cookieValues=(req,name)=>(req.headers.cookie||'').split(';').map(part=>part.trim()).filter(part=>part.startsWith(name+'=')).map(part=>part.slice(name.length+1));
const categoryKeys=['site_measurement','work_photos','work_videos','material_measurement','hidden_work','construction_daily','supervision_daily'];
const csv=value=>{let text=String(value??'');if(/^[=+@\-\t\r\n]/.test(text))text="'"+text;return '"'+text.replaceAll('"','""')+'"';};
export function safeLibraryPath(value,fallback='未命名'){
 const v=String(value??'').normalize('NFC').replace(/[\/\\:*?"<>|\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,'_').replace(/^[. ]+|[. ]+$/g,'').slice(0,72);
 return !v||/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(v)?fallback:v;
}
function fullHash(path){const h=createHash('sha256'),fd=openSync(path,'r'),block=Buffer.alloc(1048576);try{let n;while((n=readSync(fd,block,0,block.length,null))>0)h.update(block.subarray(0,n));return h.digest('hex');}finally{closeSync(fd);}}

/** The injected selectors and validators use the same ACL and daily-source checks as site-records. */
export function mountSiteDocumentLibrary(app,{db,store,auth,mobileAuth,writer,baseUrl,categories,selectRows,optionsFor,validateRecord,liveActor,session,filesFor,exportsFor,originalPath,wordBytes,photoWordBasisFor,generateCurrentPhotoWord}){
 const jobs=new Map(),tokens=new Map(),allocations=new Set();let reserved=0,active=0,downloads=0;
 // Recover only our own expired 0700 scratch directories after a process crash.
 // Only a dead owning process may be scavenged; a slow active download can outlive its grant.
 for(const entry of readdirSync(tmpdir(),{withFileTypes:true})){const owner=/^smart-engineering-site-package-(\d+)-/.exec(entry.name);if(!entry.isDirectory()||!owner)continue;try{const pid=Number(owner[1]);let dead=false;try{process.kill(pid,0);}catch(error){dead=error.code==='ESRCH';}const p=join(tmpdir(),entry.name),st=lstatSync(p);if(dead&&!st.isSymbolicLink()&&st.uid===process.getuid?.()&&(st.mode&0o777)===0o700&&Date.now()-st.mtimeMs>600000)rmSync(p,{recursive:true,force:true});}catch{/* another worker may have just removed its expired directory */}}

 function release(job){if(job.released||job.readers||job.state==='building')return;try{rmSync(job.dir,{recursive:true,force:true});}catch{clearTimeout(job.timer);job.timer=setTimeout(()=>release(job),30000);job.timer.unref?.();return;}job.released=true;reserved-=job.reserved;allocations.delete(job);clearTimeout(job.timer);}
 function drop(job){if(!job.dropped){job.dropped=true;if(jobs.get(job.key)===job)jobs.delete(job.key);if(job.token)tokens.delete(job.token);clearTimeout(job.timer);}if(!job.readers)release(job);}
 function cleanup(){for(const j of allocations)if(j.dropped||j.expiresAt<=Date.now())drop(j);}
 function filters(value,pid){if(value.from&&value.to&&value.from>value.to)fail(400,'开始日期不能晚于结束日期');if(pid&&value.projectId&&value.projectId!==pid)fail(400,'项目筛选与当前项目不一致');const f={};for(const k of Object.keys(filterShape))if(value[k]!==undefined&&value[k]!=='')f[k]=value[k];if(pid)f.projectId=pid;return f;}
 function requireGlobal(actor,pid){if(!pid&&actor.role!=='admin')fail(403,'仅平台管理员可以统一查看全部项目资料');}
 function setDownloadCookie(res,job){
  res.cookie(packageCookieName,job.downloadCookie,{httpOnly:true,sameSite:'strict',secure:new URL(baseUrl).protocol==='https:',path:'/api/engineering-site-packages/'+job.token,maxAge:Math.max(0,job.expiresAt-Date.now())});
 }
 function downloadSession(req,job){
  // An explicit mobile credential is authoritative, including malformed or wrong
  // credentials. An old browser cookie must never override the current account.
  if(req.headers.authorization!==undefined){const bearer=req.headers.authorization;if(!/^Bearer [A-Za-z0-9_-]{43}$/.test(bearer))fail(401,'资料包登录凭据无效，请重新打开资料');const sess='mobile:'+sha(bearer.slice(7));if(sess!==job.session)fail(401,'资料包仅限创建时的登录会话下载');return sess;}
  const webToken=cookieValues(req,'workspace_session')[0],webSession=webToken?sha(webToken):'';
  if(webSession===job.session)return webSession;
  const bridge=cookieValues(req,packageCookieName).some(value=>/^[A-Za-z0-9_-]{43}$/.test(value)&&job.downloadCookieHash&&timingSafeEqual(Buffer.from(sha(value),'hex'),Buffer.from(job.downloadCookieHash,'hex')));
  if(!bridge)fail(401,'资料包仅限创建时的登录会话下载');
  // The per-package cookie only references the original session. It is neither a
  // raw Bearer nor a replacement session, and may not override another logged-in user.
  if(webSession){const current=db.prepare('SELECT s.user_id FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.hash=? AND s.expires_at>? AND u.active=1').get(webSession,Date.now());if(current&&current.user_id!==job.actorId)fail(401,'浏览器当前登录账号与资料包账号不同，请重新打开资料');}
  return job.session;
 }
 function sameRecords(actor,job){
  for(const before of job.records){const current=validateRecord(actor,before.record.project_id,before.record.id,true);const next=capture(current,actor);if(next.fingerprint!==before.fingerprint)fail(409,'资料或原件已变化，请刷新后重新打包');}
 }
 function photoFailure(record,error){if(error.status)fail(error.status,'照片资料“'+String(record.data.title).slice(0,160)+'”自动生成A4 Word失败：'+error.message);fail(503,'照片资料“'+String(record.data.title).slice(0,160)+'”自动生成A4 Word失败，请检查原件后重试');}
 function capture(record,actor){const files=filesFor(record.id).filter(f=>!f.removed_at),words=exportsFor(record.id);let photoWordBasis=null;if(record.data.category==='work_photos'){try{if(!photoWordBasisFor||!generateCurrentPhotoWord)fail(503,'照片表格服务尚未就绪');photoWordBasis=photoWordBasisFor(actor,record);}catch(error){photoFailure(record,error);}}return {record,files,words,photoWordBasis,fingerprint:sha(JSON.stringify({record,files,words,photoWordBasis}))};}
 function groupRows(rows){const groups=new Map();for(const row of rows){const r=row.record,k=[r.project_id,r.data.wbsId,r.data.recordDate].join(':');let g=groups.get(k);if(!g){g={projectId:r.project_id,projectName:row.projectName,wbsId:r.data.wbsId,wbsTitle:row.wbsTitle,recordDate:r.data.recordDate,recordCount:0,fileCount:0,originalFileCount:0,wordCount:0,byteCount:0,categories:Object.fromEntries(categoryKeys.map(k=>[k,0])),states:{draft:0,archived:0,withdrawn:0},reviewStates:{}};groups.set(k,g);}const count=row.recordCount||1;g.recordCount+=count;g.categories[r.data.category]+=count;g.states[r.state]+=count;g.reviewStates[row.reviewState]=(g.reviewStates[row.reviewState]||0)+count;g.originalFileCount+=row.originalFileCount;g.wordCount+=row.wordCount;g.fileCount+=row.originalFileCount+row.wordCount;g.byteCount+=row.byteCount;}
  return [...groups.values()].map(g=>({...g,missingCategories:categoryKeys.filter(k=>!g.categories[k])})).sort((a,b)=>b.recordDate.localeCompare(a.recordDate)||a.projectName.localeCompare(b.projectName,'zh')||a.projectId.localeCompare(b.projectId)||a.wbsTitle.localeCompare(b.wbsTitle,'zh')||a.wbsId.localeCompare(b.wbsId));
 }
 function list(req,res,pid){requireGlobal(req.actor,pid);const q=querySchema.parse(req.query),f=filters(q,pid),result=store.transaction(()=>{const rows=selectRows(req.actor,f,'summary'),all=groupRows(rows);return {groups:all.slice(q.offset,q.offset+q.limit),total:all.length,limit:q.limit,offset:q.offset,filters:f,...optionsFor(req.actor,pid),categories,limits:siteLibraryLimits};});res.set('Cache-Control','private, no-store').json(result);}
 async function createPackage(req,res,pid){
  cleanup();requireGlobal(req.actor,pid);const b=packageSchema.parse(req.body),f=filters(b,pid),sess=session(req),actor=liveActor(sess,req.actor.id),key=actor.id+':'+b.requestId,fingerprint=sha(JSON.stringify({filters:f,session:sess,global:!pid}));const old=jobs.get(key);
  if(old){if(old.fingerprint!==fingerprint)fail(409,'请求编号已用于其他筛选条件，请刷新后重试');if(old.state==='building')fail(409,'资料包正在生成，请稍后重试');sameRecords(actor,old);setDownloadCookie(res,old);res.set('Cache-Control','private, no-store').json({...old.result,replayed:true});return;}
  if(active>=siteLibraryLimits.maxConcurrent||[...jobs.values()].some(j=>j.actorId===actor.id&&j.state==='building'))fail(429,'已有资料包正在生成，请稍后重试');
  if(allocations.size>=siteLibraryLimits.maxCachedPackages)fail(429,'临时资料包较多，请五分钟后重试或缩小范围');
  const rows=store.transaction(()=>selectRows(actor,f,siteLibraryLimits.maxRecords+1));if(!rows.length)fail(409,'当前筛选下没有可打包的施工资料');if(rows.length>siteLibraryLimits.maxRecords)fail(413,'单包最多1000份资料，请缩小日期或部位范围');
  if(rows.reduce((n,r)=>n+r.originalFileCount+r.wordCount+(r.record.data.category==='work_photos'?1:0),0)>siteLibraryLimits.maxFiles)fail(413,'单包最多1000个原件和Word，请缩小日期或部位范围');
  const records=store.transaction(()=>rows.map(row=>capture(validateRecord(actor,row.record.project_id,row.record.id,true),actor)));
  const items=records.flatMap(r=>[...r.files,...r.words]),autoWordCount=records.filter(r=>r.record.data.category==='work_photos').length;if(items.length+autoWordCount>siteLibraryLimits.maxFiles)fail(413,'单包最多1000个原件和Word，请缩小日期或部位范围');
  const sourceBytes=items.reduce((n,x)=>n+x.byte_count,0),baseEstimate=sourceBytes+records.reduce((n,r)=>n+Buffer.byteLength(JSON.stringify(r),'utf8')*4+8192,0)+(items.length+autoWordCount)*4096+autoWordCount*16384+1048576,estimate=baseEstimate+(autoWordCount?maxGeneratedWordBytes:0);
  if(estimate>siteLibraryLimits.maxBytes)fail(413,'资料包超过1 GiB，请缩小日期或部位范围');if(reserved+estimate>siteLibraryLimits.maxCacheBytes)fail(429,'临时资料包空间已满，请五分钟后重试');
  const dir=mkdtempSync(join(tmpdir(),'smart-engineering-site-package-'+process.pid+'-'));chmodSync(dir,0o700);const path=join(dir,'package.zip'),job={key,dir,path,records,fingerprint,actorId:actor.id,session:sess,global:!pid,state:'building',reserved:estimate,expiresAt:Date.now()+siteLibraryLimits.buildTimeoutMs,readers:0,dropped:false,transfers:new Set()};reserved+=estimate;active++;jobs.set(key,job);allocations.add(job);
  let fd,closed=false;try{
   fd=openSync(path,'wx',0o600);let written=0,generatedBytes=0,generatedCount=0;
   const reserve=target=>{if(target>siteLibraryLimits.maxBytes)fail(413,'资料包超过1 GiB，请缩小范围');if(target>job.reserved){const extra=target-job.reserved;if(reserved+extra>siteLibraryLimits.maxCacheBytes)fail(429,'临时资料包空间已满，请五分钟后重试');reserved+=extra;job.reserved=target;}};const zipHash=createHash('sha256'),zip=new Zip((error,chunk)=>{if(error)throw error;reserve(written+chunk.length);let at=0;while(at<chunk.length)at+=writeSync(fd,chunk,at,chunk.length-at,null);zipHash.update(chunk);written+=chunk.length;});
   const check=()=>{if(job.dropped||Date.now()>job.expiresAt)fail(408,'生成资料包超时，请缩小范围后重试');if(req.aborted||res.destroyed)fail(499,'资料包请求已取消');};
   const entries=[],manifest=[],projectFolders=new Map(),placeFolders=new Map();
   const folder=(map,key,label)=>{if(!map.has(key))map.set(key,String(map.size+1).padStart(3,'0')+'_'+safeLibraryPath(label).slice(0,24));return map.get(key);};
   const filename=(name,index)=>{const raw=String(name??'').normalize('NFC'),match=/\.[A-Za-z0-9]{1,8}$/.exec(raw),ext=match?.[0]||'',stem=safeLibraryPath(ext?raw.slice(0,-ext.length):raw);return String(index).padStart(3,'0')+'_'+stem.slice(0,60-ext.length)+ext;};const addBytes=(name,bytes)=>{check();const entry=new ZipPassThrough(name);zip.add(entry);entry.push(bytes,true);};
   async function addOriginal(name,file){check();const p=originalPath(file.id),st=lstatSync(p);if(st.isSymbolicLink()||!st.isFile()||st.size!==file.byte_count)fail(503,'资料原件缺失或存储异常，资料包未生成，请联系管理员检查');const entry=new ZipPassThrough(name);zip.add(entry);const h=createHash('sha256');let n=0;for await(const chunk of createReadStream(p,{highWaterMark:1048576})){check();n+=chunk.length;if(n>file.byte_count)fail(503,'资料原件大小已变化，请检查存储');h.update(chunk);entry.push(chunk,false);}if(n!==file.byte_count||h.digest('hex')!==file.sha256)fail(503,'资料原件摘要异常，资料包未生成，请检查存储');entry.push(new Uint8Array(0),true);}
   async function currentPhotoWord(record){
    // The request deadline also covers asynchronous image conversion. A timed-out
    // converter keeps its bounded worker/cache slot until it actually settles.
    let timer;const pending=Promise.resolve().then(()=>generateCurrentPhotoWord(req,record));job.pending=pending;
    const completed=pending.then(value=>{if(job.pending===pending)job.pending=null;return value;},error=>{if(job.pending===pending)job.pending=null;throw error;});
    try{return await Promise.race([completed,new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new BusinessError(408,'生成资料包超时，请缩小范围后重试')),Math.max(1,job.expiresAt-Date.now()));timer.unref?.();})]);}finally{clearTimeout(timer);}
   }
   for(const saved of records){
    check();const {record:r,files,words}=saved,row=rows.find(x=>x.record.id===r.id),project=folder(projectFolders,r.project_id,row.projectName),place=folder(placeFolders,r.project_id+':'+r.data.wbsId,row.wbsTitle),base=[project,place,r.data.recordDate,String(categoryKeys.indexOf(r.data.category)+1).padStart(2,'0')+'_'+categories[r.data.category],String(manifest.length+1).padStart(3,'0')+'_'+safeLibraryPath(r.data.title).slice(0,32)].join('/');
    const summary={recordId:r.id,projectId:r.project_id,projectName:row.projectName,wbsId:r.data.wbsId,wbsTitle:row.wbsTitle,recordDate:r.data.recordDate,category:r.data.category,categoryName:categories[r.data.category],title:r.data.title,state:r.state,reviewState:row.reviewState,version:r.version,data:r.data,snapshot:r.snapshot,createdAt:r.created_at,updatedAt:r.updated_at,archivedAt:r.archived_at||null,photoRecordId:r.data.photoRecordId||'',fileCount:files.length,wordCount:words.length,historicalWordCount:words.length,autoGeneratedWordCount:0,files:[],words:[]};
    for(const file of files){const step=siteWorkSteps.find(s=>s.id===file.step_id),folder=step?String(siteWorkSteps.indexOf(step)+1).padStart(2,'0')+'_'+safeLibraryPath(step.name||step.title):'原件',name=base+'/'+folder+'/'+filename(file.name,summary.files.length+1);await addOriginal(name,file);const item={path:name,recordId:r.id,fileId:file.id,name:file.name,mime:file.mime,byteCount:file.byte_count,sha256:file.sha256,stepId:file.step_id||'',representative:!!file.representative};entries.push(item);summary.files.push(item);}
    for(const word of words){check();if(word.byte_count>33554432)fail(503,'Word历史版本大小异常，资料包未生成');const bytes=wordBytes(r.id,word.id);if(bytes.length!==word.byte_count||sha(bytes)!==word.sha256)fail(503,'Word历史版本大小或摘要异常，资料包未生成');const name=base+'/Word/'+filename(word.name,word.sequence);addBytes(name,bytes);const item={path:name,recordId:r.id,fileId:word.id,name:word.name,mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',byteCount:word.byte_count,sha256:word.sha256,sourceVersion:word.source_version,sequence:word.sequence,kind:'historical_word',generated:false};entries.push(item);summary.words.push(item);}
    if(r.data.category==='work_photos'){
     check();let word;try{req.actor=liveActor(sess,actor.id);requireGlobal(req.actor,pid);word=await currentPhotoWord(r);check();const current=liveActor(sess,actor.id);requireGlobal(current,pid);sameRecords(current,job);if(word.version!==r.version)fail(409,'照片资料版本已变化，请刷新后重新打包');if(!Buffer.isBuffer(word.document)||word.document.length>maxGeneratedWordBytes)fail(413,'生成文档超过16 MiB');}catch(error){photoFailure(r,error);}
     generatedBytes+=word.document.length;generatedCount++;reserve(baseEstimate+generatedBytes+(generatedCount<autoWordCount?maxGeneratedWordBytes:0));
     const name=base+'/Word/'+filename(word.name,0),item={path:name,recordId:r.id,name:word.name,mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',byteCount:word.document.length,sha256:sha(word.document),sourceVersion:word.version,kind:'current_photo_word',generated:true,basisFingerprint:saved.photoWordBasis,photoTableBasisFingerprint:word.basisFingerprint,templateSha256:word.templateSha256,layoutSha256:word.layoutSha256,representativeFileIds:word.representativeFileIds,missingSteps:word.missingSteps};
     addBytes(name,word.document);entries.push(item);summary.words.push(item);summary.wordCount++;summary.autoGeneratedWordCount++;
    }
    addBytes(base+'/资料说明.json',strToU8(JSON.stringify(summary,null,2)));manifest.push(summary);
   }
   const groups=groupRows(rows),missing=groups.flatMap(g=>g.missingCategories.map(c=>[g.projectName,g.wbsTitle,g.recordDate,categories[c]].join(' / ')));
   const heading=['项目','施工部位','资料日期','类别','资料标题','状态','记录ID','原件或Word','文件名','工序','字节数','SHA256','包内路径','自动生成','依据资料版本'];const lines=[heading.map(csv).join(',')];for(const r of manifest){for(const item of [...r.files,...r.words])lines.push([r.projectName,r.wbsTitle,r.recordDate,r.categoryName,r.title,r.state,r.recordId,item.generated?'自动生成当前A4 Word':item.kind==='historical_word'?'历史Word':'原件',item.name,item.stepId||'',item.byteCount,item.sha256,item.path,item.generated?'是':'否',item.sourceVersion??''].map(csv).join(','));if(!r.files.length&&!r.words.length)lines.push([r.projectName,r.wbsTitle,r.recordDate,r.categoryName,r.title,r.state,r.recordId,'尚无服务器附件','','',0,'','','否',''].map(csv).join(','));}
   addBytes('清单.csv',strToU8('\uFEFF'+lines.join('\r\n')));addBytes('清单.json',strToU8(JSON.stringify({generatedAt:new Date().toISOString(),filters:f,recordCount:records.length,fileCount:entries.length,autoGeneratedWordCount:generatedCount,records:manifest},null,2)));addBytes('缺项说明.txt',strToU8('本包仅包含当前账号有权查看和下载、已保存到服务器的资料，不含手机本机草稿。\n状态按打包时记录，不代表技术验收。已有Word按历史版本保留；每份工序照片另外自动生成当前A4 Word，不新增业务Word历史、不改变审核状态。\n照片和视频按已登记工序分目录，未标注工序的历史原件放在“原件”目录。\n缺少类别不代表必须补齐，请按实际施工要求判断。\n'+(missing.length?missing.join('\n'):'当前所选各日期部位均包含七类记录。')+'\n'+manifest.flatMap(r=>r.words.filter(w=>w.generated).flatMap(w=>w.missingSteps.map(step=>'A4空缺工序：'+r.projectName+'/'+r.wbsTitle+'/'+r.recordDate+'/'+r.title+'/'+step.id+' '+step.name))).join('\n')+'\n'+manifest.filter(r=>!r.fileCount&&!r.wordCount).map(r=>'尚无附件：'+r.projectName+'/'+r.wbsTitle+'/'+r.recordDate+'/'+r.title).join('\n')));
   check();zip.end();closeSync(fd);closed=true;
   store.transaction(()=>{const current=liveActor(sess,actor.id);requireGlobal(current,pid);sameRecords(current,job);});
   if(job.dropped)fail(408,'资料包生成已超时，请重新生成');job.records=records.map(({record,fingerprint})=>({record:{id:record.id,project_id:record.project_id},fingerprint}));reserved-=job.reserved-written;job.reserved=written;job.state='ready';job.expiresAt=Date.now()+siteLibraryLimits.grantTtlMs;job.token=randomBytes(32).toString('base64url');job.downloadCookie=randomBytes(32).toString('base64url');job.downloadCookieHash=sha(job.downloadCookie);job.sha256=zipHash.digest('hex');job.byteCount=written;const name='施工资料_'+(f.from||f.to||rows[0].record.data.recordDate)+(f.to&&f.to!==f.from?'_'+f.to:'')+'.zip';job.result={url:'/api/engineering-site-packages/'+job.token,expiresAt:job.expiresAt,name,mime:'application/zip',byteCount:written,sha256:job.sha256,fileCount:entries.length,recordCount:records.length,autoGeneratedWordCount:generatedCount};tokens.set(job.token,job);job.timer=setTimeout(()=>drop(job),siteLibraryLimits.grantTtlMs);job.timer.unref?.();store.audit(actor,'site_library_package_create','engineering_site_records',f.projectId||'all',JSON.stringify({filters:f,recordCount:records.length,fileCount:entries.length,byteCount:written,sha256:job.sha256}));setDownloadCookie(res,job);res.set('Cache-Control','private, no-store').json(job.result);
  }catch(error){drop(job);if(error.code==='ENOENT')fail(503,'资料原件缺失，资料包未生成，请联系管理员检查');throw error;}finally{if(fd!==undefined&&!closed)closeSync(fd);const finish=()=>{active--;job.pending=null;if(job.dropped){job.state='failed';release(job);}};if(job.pending)job.pending.then(finish,finish);else finish();}
 }
 for(const [base,authorize]of [['/api/engineering',auth],['/api/mobile/engineering',mobileAuth]]){
  app.get(base+'/site-library',authorize,(req,res)=>list(req,res,null));app.get(base+'/projects/:pid/site-library',authorize,(req,res)=>list(req,res,id.parse(req.params.pid)));
  app.post(base+'/site-library/packages',authorize,(req,res)=>createPackage(req,res,null));app.post(base+'/projects/:pid/site-library/packages',authorize,(req,res)=>createPackage(req,res,id.parse(req.params.pid)));
 }
 app.get('/api/engineering-site-packages/:token',(req,res)=>{
  try{cleanup();if(!/^[A-Za-z0-9_-]{43}$/.test(req.params.token))fail(404,'资料包不存在');const job=tokens.get(req.params.token);if(!job||job.dropped||job.state!=='ready')fail(410,'资料包已过期，请重新生成');const sess=downloadSession(req,job);const actor=liveActor(sess,job.actorId);if(downloads>=siteLibraryLimits.maxDownloads||job.readers>=siteLibraryLimits.maxDownloadsPerPackage||[...allocations].filter(j=>j.actorId===actor.id).reduce((n,j)=>n+j.readers,0)>=siteLibraryLimits.maxDownloadsPerActor)fail(429,'当前下载任务较多，请等待已有下载完成');if(job.global&&actor.role!=='admin')fail(403,'管理员权限已变化，请重新生成资料包');sameRecords(actor,job);const st=lstatSync(job.path);if(st.isSymbolicLink()||!st.isFile()||st.size!==job.byteCount||fullHash(job.path)!==job.sha256)fail(503,'临时资料包校验失败，请重新生成');res.set({'Content-Type':'application/zip','Content-Length':String(job.byteCount),'Content-Disposition':`attachment; filename="site-documents.zip"; filename*=UTF-8''${encodeURIComponent(job.result.name)}`,'X-Content-SHA256':job.sha256,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"sandbox; default-src 'none'",'Referrer-Policy':'no-referrer'});job.readers++;downloads++;const stream=createReadStream(job.path,{highWaterMark:1048576});let lastChecked=Date.now();const guard=new Transform({transform(chunk,encoding,callback){try{if(Date.now()-lastChecked>=1000){const current=liveActor(job.session,job.actorId);if(job.global&&current.role!=='admin')fail(403,'管理员权限已变化');sameRecords(current,job);lastChecked=Date.now();}callback(null,chunk);}catch(error){callback(error);}}});let done=false;let transferTimer;const cancel=()=>res.destroy();const finish=()=>{if(done)return;done=true;clearTimeout(transferTimer);job.transfers.delete(cancel);stream.destroy();guard.destroy();job.readers--;downloads--;if(job.dropped&&!job.readers)release(job);};job.transfers.add(cancel);transferTimer=setTimeout(cancel,siteLibraryLimits.maxDownloadMs);transferTimer.unref?.();res.setTimeout(60000,cancel);stream.on('error',()=>res.destroy());guard.on('error',()=>res.destroy());res.on('close',finish);res.on('finish',finish);store.audit(actor,'site_library_package_download','engineering_site_records','package',JSON.stringify({recordCount:job.records.length,sha256:job.sha256}));stream.pipe(guard).pipe(res);
  }catch(error){if(error.status)throw error;fail(503,'资料包暂不可用，请重新生成');}
 });
 return {close(){for(const j of [...allocations]){for(const cancel of j.transfers)cancel();drop(j);}},stats(){cleanup();return {active,reserved,cached:allocations.size,grants:tokens.size,downloads};}};
}
