// UI metadata only. File bytes and HTTP request IDs stay with the existing uploader.
const phases = new Set(['queued','hashing','uploading','verifying','saved','paused','failed','needs-file']);
const uuid = v => typeof v==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const hash = v => typeof v==='string' && /^[0-9a-f]{64}$/i.test(v) ? v.toLowerCase() : '';
const active = p => ['hashing','uploading','verifying'].includes(p);
const checked = (v,max=512) => typeof v==='string' && v.length>0 && v.length<=max;
export function createSiteUploadState(scopeKey,recordId){
 if(!checked(scopeKey,2048)||!uuid(recordId))throw Error('上传队列缺少有效的账号及资料范围');
 return {schema:1,scopeKey,recordId,items:[]};
}
export function canDiscardSiteUpload(item){return !item.serverAttempted&&!item.uploadId&&['queued','paused','failed','needs-file'].includes(item.phase);}
export function hasUnfinishedSiteUploads(state){return state.items.some(i=>i.phase!=='saved');}
export function siteUploadCounts(state){
 const result={total:state.items.length,saved:0,remaining:0,failed:0,needsFile:0,active:0};
 for(const i of state.items){if(i.phase==='saved')result.saved++;else result.remaining++;if(i.phase==='failed')result.failed++;if(!i.fileAvailable&&!['saved','verifying'].includes(i.phase))result.needsFile++;if(active(i.phase))result.active++;}
 return result;
}
function update(state,key,fn){let changed=false;const items=state.items.map(i=>{if(i.key!==key)return i;const next=fn(i);changed ||= next!==i;return next;});return changed?{...state,items}:state;}
export function reduceSiteUploadState(state,event){
 if(event.scopeKey!==state.scopeKey)return state;
 if(event.type==='select'){
  if(state.items.some(i=>active(i.phase)))throw Error('请先暂停当前上传再选择文件');
  const items=[...state.items];const keys=new Set(items.map(i=>i.key));
  for(const f of event.files){
   if(!checked(f.key,160)||!checked(f.name)||!Number.isSafeInteger(f.size)||f.size<0||!Number.isFinite(f.lastModified)||f.lastModified<0||f.stepId&&!/^step(0[1-9]|10)$/.test(f.stepId))throw Error('待上传文件信息无效');
   if(keys.has(f.key))throw Error('文件队列标识重复');keys.add(f.key);
   items.push({key:f.key,name:f.name,size:f.size,lastModified:f.lastModified,stepId:f.stepId||'',phase:'queued',bytes:0,sha256:'',fileId:'',uploadId:'',attemptId:null,serverAttempted:false,fileAvailable:true,error:'',awaitingReadback:false});
  }
  if(items.length>100)throw Error('一次最多保留100份队列记录，请先整理已保存项');
  return {...state,items};
 }
 if(event.type==='discard')return discardSiteUpload(state,event.key);
 if(event.type==='clear-saved')return {...state,items:state.items.filter(i=>i.phase!=='saved')};
 return update(state,event.key,i=>{
  if(event.type==='set-step'){if(i.uploadId||i.stepId||!['queued','hashing'].includes(i.phase)||!/^step(0[1-9]|10)$/.test(event.stepId))return i;return {...i,stepId:event.stepId};}
  if(event.type==='reselect'){
   if(i.phase==='saved'||active(i.phase))return i;
   if(event.name!==i.name||event.size!==i.size)return {...i,error:'请选择同一名称和大小的原件；继续时仍会核对摘要。'};
   return {...i,fileAvailable:true,phase:i.phase==='needs-file'?'paused':i.phase,error:''};
  }
  if(event.type==='begin'){
   if(i.phase==='saved'||active(i.phase)||!i.fileAvailable||!checked(event.attemptId,160))return i;
   return {...i,attemptId:event.attemptId,phase:'hashing',bytes:0,error:'',awaitingReadback:false};
  }
  if(event.type==='validation-error')return canDiscardSiteUpload(i)?{...i,phase:'failed',error:String(event.error).slice(0,1000)}:i;
  if(i.phase==='saved'||!event.attemptId||event.attemptId!==i.attemptId)return i;
  if(event.type==='start-request'){if(!active(i.phase))return i;return {...i,serverAttempted:true};}
  if(event.type==='rejected-before-start'){if(i.uploadId||!Number.isInteger(event.status)||event.status<400||event.status>=500)return i;return {...i,phase:'failed',serverAttempted:false,attemptId:null,error:String(event.error).slice(0,1000)};}
  if(event.type==='progress'){
   if(!['hashing','uploading','verifying'].includes(event.phase)||!active(i.phase))return i;
   const order={hashing:0,uploading:1,verifying:2};if(order[event.phase]<order[i.phase])return i;
   const digest=event.sha256===undefined?i.sha256:hash(event.sha256);
   if(event.sha256!==undefined&&(!digest||i.sha256&&digest!==i.sha256))return {...i,phase:'failed',error:'所选原件摘要不同，请重新选择原文件；原上传凭据仍保留。'};
   if(!Number.isSafeInteger(event.bytes)||event.bytes<0||event.bytes>i.size||event.phase===i.phase&&event.bytes<i.bytes)return i;
   if(event.uploadId!==undefined&&!uuid(event.uploadId))return {...i,phase:'failed',error:'服务器上传凭据无效，请核对后继续。'};
   return {...i,phase:event.phase,bytes:event.bytes,sha256:digest,uploadId:event.uploadId||i.uploadId,serverAttempted:i.serverAttempted||!!event.uploadId,error:''};
  }
  if(event.type==='pause')return i.phase==='verifying'?{...i,awaitingReadback:true,error:'上传结果待核对，请刷新核对后再继续。'}:active(i.phase)?{...i,phase:'paused',error:''}:i;
  if(event.type==='failure')return i.phase==='paused'?i:{...i,phase:event.resultUnconfirmed?'verifying':'failed',awaitingReadback:!!event.resultUnconfirmed,error:String(event.error).slice(0,1000)};
  if(event.type==='saved'){
   const r=event.receipt,f=event.readback?.file;
   const valid=uuid(r?.id)&&r.state==='completed'&&hash(r.sha256)&&hash(r.sha256)===i.sha256&&event.readback?.recordId===state.recordId&&f?.id===r.id&&f.name===i.name&&f.byte_count===i.size&&hash(f.sha256)===i.sha256&&!f.removed_at&&(!i.stepId||f.step_id===i.stepId);
   if(!valid)return {...i,phase:'verifying',awaitingReadback:true,error:'服务器完成凭据与原件尚未核对一致，请刷新核对，勿重复新建上传。'};
   return {...i,phase:'saved',bytes:i.size,fileId:r.id,error:'',awaitingReadback:false,fileAvailable:false};
  }
  return i;
 });
}
// Explicitly discard only a never-started local selection; no API call or server deletion.
export function discardSiteUpload(state,key){const i=state.items.find(i=>i.key===key);return i&&canDiscardSiteUpload(i)?{...state,items:state.items.filter(i=>i.key!==key)}:state;}
export function serializeSiteUploadState(state){
 return JSON.stringify({...state,items:state.items.map(recoveredItem)});
}
// An upload ID plus the original digest is enough to ask the server whether
// completion committed. A lost completion response need not contain a file ID.
function recoveredItem(i){const check=!!(uuid(i.uploadId)&&hash(i.sha256)&&checked(i.attemptId,160));return {...i,fileAvailable:false,phase:check?'verifying':'needs-file',awaitingReadback:check,error:check?'请先核对服务器保存结果；尚未保存的原件才需重新选择。':'请重新选择同一原件继续。'};}
export function restoreSiteUploadState(raw,scopeKey,recordId){
 const empty=createSiteUploadState(scopeKey,recordId);
 try{
  if(typeof raw!=='string'||raw.length>200000)return empty;
  const value=JSON.parse(raw);if(value.schema!==1||value.scopeKey!==scopeKey||value.recordId!==recordId||!Array.isArray(value.items)||value.items.length>100)return empty;
  const keys=new Set();for(const i of value.items){if(!checked(i.key,160)||keys.has(i.key)||!checked(i.name)||!Number.isSafeInteger(i.size)||i.size<0||!Number.isSafeInteger(i.bytes)||i.bytes<0||i.bytes>i.size||!Number.isFinite(i.lastModified)||!phases.has(i.phase)||i.sha256&&!hash(i.sha256)||i.fileId&&!uuid(i.fileId)||i.uploadId&&!uuid(i.uploadId)||i.attemptId!==null&&!checked(i.attemptId,160)||i.stepId&&!/^step(0[1-9]|10)$/.test(i.stepId))return empty;keys.add(i.key);}
  // Cached metadata is not proof that a file remains on the server.
  return {...empty,items:value.items.map(i=>recoveredItem({...i,serverAttempted:typeof i.serverAttempted==='boolean'?i.serverAttempted:!!i.uploadId||!!i.attemptId}))};
 }catch{return empty;}
}
