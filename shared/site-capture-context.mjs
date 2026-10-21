const validDate = value => {if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const d=new Date(value+'T12:00:00Z');return !Number.isNaN(d.valueOf())&&d.toISOString().slice(0,10)===value;};
const text=(v,max=160)=>typeof v==='string'&&v.length>0&&v.length<=max;
export function siteCaptureContextKey(scope){
 const u=new URL(scope.backend);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||!text(scope.userId)||!text(scope.projectId))throw Error('采集信息缺少有效的后台、账号或项目范围');
 u.hash='';u.search='';const backend=u.toString().replace(/\/+$/,'');
 return 'site:capture-context:v1:'+JSON.stringify([backend,scope.userId,scope.projectId]);
}
export function readSiteCaptureContext(storage,scope){
 try{
  const key=siteCaptureContextKey(scope),raw=storage.getItem(key);if(raw===null)return {saved:null,warning:''};
  if(typeof raw!=='string'||raw.length>5000)return {saved:null,warning:'上次采集信息无法读取，请重新确认部位和日期。'};
  const saved=JSON.parse(raw),c=saved.context;
  if(saved.schema!==1||saved.scopeKey!==key||!validDate(saved.confirmedOn)||!c||typeof c.wbsId!=='string'||c.wbsId.length>160||typeof c.taskId!=='string'||c.taskId.length>160||!validDate(c.recordDate))return {saved:null,warning:'上次采集信息已失效，请重新确认。'};
  return {saved:{confirmedOn:saved.confirmedOn,context:{wbsId:c.wbsId,taskId:c.taskId,recordDate:c.recordDate}},warning:''};
 }catch{return {saved:null,warning:'无法读取本机采集信息，本次请确认部位和日期。'};}
}
export function saveSiteCaptureContext(storage,scope,context,today){
 try{
  if(!validDate(today)||!validDate(context.recordDate)||!text(context.wbsId)||typeof context.taskId!=='string'||context.taskId.length>160)throw Error('Invalid context');
  const key=siteCaptureContextKey(scope),raw=JSON.stringify({schema:1,scopeKey:key,confirmedOn:today,context:{wbsId:context.wbsId,taskId:context.taskId,recordDate:context.recordDate}});
  storage.setItem(key,raw);if(storage.getItem(key)!==raw)throw Error('Storage not durable');
  return {saved:true,warning:''};
 }catch{return {saved:false,warning:'本次采集信息可继续使用，但未能记住到本机；关闭页面后请重新确认。'};}
}
export function resolveSiteCaptureContext(saved,{today,wbs,tasks,batch=null}){
 if(!validDate(today))throw Error('今日日期无效');
 const notices=[],fallback={wbsId:'',taskId:'',recordDate:today};
 let context=saved?{...saved.context}:{...fallback};
 if(saved&&saved.confirmedOn!==today){context.recordDate=today;notices.push('已跨日，新建资料日期默认今天；补填历史资料可重新选择日期。');}
 if(!validDate(context.recordDate)){context.recordDate=today;notices.push('原日期无效，已使用今天。');}
 if(context.wbsId&&!wbs.some(n=>n.id===context.wbsId)){context.wbsId='';context.taskId='';notices.push('上次施工部位当前不可用，请重新选择。');}
 const taskAllowed=(id,wbsId)=>!id||tasks.some(t=>t.id===id&&t.wbsIds.includes(wbsId));
 if(!taskAllowed(context.taskId,context.wbsId)){context.taskId='';notices.push('上次关联任务当前不可用，已清除该任务选择。');}
 if(batch){
  if(!validDate(batch.recordDate)||!wbs.some(n=>n.id===batch.wbsId)||!taskAllowed(batch.taskId||'',batch.wbsId))return {context:fallback,notices,locked:true,blockedReason:'当前批次的施工部位、任务或日期不可用，请重新核对批次。'};
  context={wbsId:batch.wbsId,taskId:batch.taskId||'',recordDate:batch.recordDate};notices.push('新建资料沿用已选批次的部位、任务和日期。');
 }
 return {context,notices,locked:!!batch,blockedReason:''};
}
