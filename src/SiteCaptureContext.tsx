import {useEffect,useState,type FormEvent,type ReactNode} from 'react';
import type {SiteCaptureContextValue,SiteCaptureWbsOption,SiteCaptureTaskOption} from '../shared/site-capture-context.mjs';
import './site-capture-context.css';
export type SiteCaptureContextProps={
 scopeKey:string;value:SiteCaptureContextValue;wbs:SiteCaptureWbsOption[];tasks:SiteCaptureTaskOption[];
 disabled?:boolean;locked?:boolean;blockedReason?:string;notices?:string[];storageWarning?:string;action?:ReactNode;
 onConfirm:(value:SiteCaptureContextValue)=>{saved:boolean;warning?:string};
};
export function SiteCaptureContext({scopeKey,value,wbs,tasks,disabled=false,locked=false,blockedReason='',notices=[],storageWarning='',action,onConfirm}:SiteCaptureContextProps){
 const [editing,setEditing]=useState(false),[draft,setDraft]=useState(value),[feedback,setFeedback]=useState('');
 useEffect(()=>{setDraft(value);setEditing(false);setFeedback('');},[scopeKey]);
 useEffect(()=>{setDraft(value);},[value.wbsId,value.taskId,value.recordDate]);
 const taskOptions=tasks.filter(t=>t.wbsIds.includes(draft.wbsId));
 const place=wbs.find(n=>n.id===value.wbsId)?.label||'请确认施工部位';
 function confirm(e:FormEvent){e.preventDefault();if(disabled||locked||blockedReason)return;
  if(!wbs.some(n=>n.id===draft.wbsId)||draft.taskId&&!taskOptions.some(t=>t.id===draft.taskId)){setFeedback('部位或任务已不可用，请重新选择。');return;}
  try{const result=onConfirm(draft);setFeedback(result.saved?'已记住本次采集信息。':result.warning||'未能记住到本机，关闭后请重新确认。');setEditing(false);}catch{setFeedback('采集信息未应用，请重新确认后再试。');}
 }
 return <section className="site-capture-context" aria-label="新建资料采集信息"><header><div className="site-capture-place"><h3>{place}</h3><p className="site-capture-summary"><span>{value.recordDate}</span>{value.taskId&&<span>{tasks.find(t=>t.id===value.taskId)?.label||'原关联任务'}</span>}{locked&&<span>已选批次</span>}</p>{!locked&&!editing&&<button type="button" className="text-button site-context-change" disabled={disabled} aria-expanded={editing} onClick={()=>{setDraft(value);setFeedback('');setEditing(true);}}>更换部位或日期</button>}</div>{action}</header>
 {notices.map((note,index)=><p key={index} className="site-capture-note">{note}</p>)}{storageWarning&&<p className="site-capture-warning" role="status">{storageWarning}</p>}{blockedReason&&<p className="site-capture-warning" role="alert">{blockedReason}</p>}
 {editing&&!locked&&<form onSubmit={confirm}><fieldset disabled={disabled||!!blockedReason}><legend className="site-capture-sr-only">确认新建资料的部位和日期</legend><label>采集施工部位<select required value={draft.wbsId} onChange={e=>setDraft({...draft,wbsId:e.target.value,taskId:''})}><option value="">请选择施工部位</option>{wbs.map(n=><option key={n.id} value={n.id}>{n.label}</option>)}</select></label><details className="site-capture-task-more"><summary>关联任务（选填）</summary><label>采集关联任务<select value={draft.taskId} onChange={e=>setDraft({...draft,taskId:e.target.value})}><option value="">不关联任务</option>{taskOptions.map(t=><option key={t.id} value={t.id}>{t.label}</option>)}</select></label></details><label>采集资料日期<input type="date" required value={draft.recordDate} onChange={e=>setDraft({...draft,recordDate:e.target.value})}/></label><div className="site-capture-actions">{value.wbsId&&<button type="button" className="button" onClick={()=>{setDraft(value);setEditing(false);setFeedback('');}}>取消修改</button>}<button className="button primary" type="submit">使用此部位</button></div></fieldset></form>}
 {feedback&&<p role="status" className="site-capture-note">{feedback}</p>}
 </section>;
}
