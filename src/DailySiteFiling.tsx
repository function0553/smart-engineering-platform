import {useEffect,useRef,useState} from 'react';
import {api} from './model';
import type {SubmissionReceipt} from './report-cloud';
import {readSiteCaptureContext} from '../shared/site-capture-context.mjs';
import { filingKey, readDailyFilingJournal, createDailyFilingJournal, confirmDailyFiling, retainDailyFilingJournal, timedDailyFilingRequest, readRetainedDailyFilings, type DailyFilingJournal, type FilingProject } from './daily-filing';
export { filingKey };
export type { FilingProject };
export function retainedFilings(scope:string,userId:string,projectId:string){return readRetainedDailyFilings(scope,userId,projectId,[()=>window.localStorage,()=>window.sessionStorage]);}

export function DailySiteFiling({receipt,project,userId,storageScope,onFiled,onDismiss,onChanged}:{receipt:SubmissionReceipt;project:FilingProject;userId:string;storageScope:string;onFiled:(id:string)=>void;onDismiss?:()=>void;onChanged?:()=>void}){
 const key=filingKey(storageScope,userId,project.id,receipt.id);
 const [wbs,setWbs]=useState(()=>{try{const c=readSiteCaptureContext(localStorage,{backend:storageScope||location.origin,userId,projectId:project.id}).saved?.context;return project.nodes.some(n=>n.id===c?.wbsId)?c!.wbsId:'';}catch{return '';}});
 const [restored]=useState(()=>{try{return {journal:readDailyFilingJournal(localStorage.getItem(key)||sessionStorage.getItem(key),receipt),error:''};}catch(e){return {journal:null,error:(e as Error).message||'原归入凭据无法读取，请保留本机数据并联系管理员。'};}});
 const [journal,setJournal]=useState<DailyFilingJournal|null>(restored.journal),[busy,setBusy]=useState(false),[error,setError]=useState(restored.error);
 const journalRef=useRef(journal),busyRef=useRef(false),live=useRef(true);journalRef.current=journal;
 useEffect(()=>{live.current=true;const guard=(e:Event)=>{if(busyRef.current)e.preventDefault();};window.addEventListener('beforeunload',guard);return()=>{live.current=false;window.removeEventListener('beforeunload',guard);};},[]);
 function retain(v:DailyFilingJournal){retainDailyFilingJournal(localStorage,key,v);journalRef.current=v;setJournal(v);sessionStorage.removeItem(key);onChanged?.();}
 useEffect(()=>{if(journalRef.current)try{retain(journalRef.current);}catch{setError('原归入暂未写入本机，请保持当前页并重试核对。');}},[key]);
 async function file(){
  if(busyRef.current||restored.error)return;
  busyRef.current=true;setBusy(true);setError('');
  try{
   const current=journalRef.current||createDailyFilingJournal(receipt,project,wbs);
   const confirmed=await confirmDailyFiling(project,receipt,current,timedDailyFilingRequest(api),retain);
   busyRef.current=false;
   if(live.current&&confirmed.status==='confirmed'&&confirmed.id)onFiled(confirmed.id);
  }catch(e){if(live.current)setError((e as Error).message||'保存结果待确认，请重试原办理。');}
  finally{busyRef.current=false;if(live.current)setBusy(false);}
 }
 if(journal?.status==='confirmed')return <section className="report-history-summary" aria-label="归入施工资料"><h2>已归入当前施工资料</h2><p>{project.name} · {receipt.reportDate} · 原Word与原图保留</p><button className="button primary" onClick={()=>onFiled(journal.id!)}>查看已归入资料</button></section>;
 return <section className="report-history-summary" aria-label="归入施工资料"><h2>{journal?.status==='confirmed_restricted'?'已确认归入，当前权限受限':'日报已保存在服务器'}</h2><p>{journal?.status==='confirmed_restricted'?'服务器已确认原归入，当前账号无权查看该部位，请联系项目管理员。原Word与原图保留。':'日报文字、照片和 Word 已保存；归入当前施工资料后，可查看并提交审核。'}</p><p>{project.name} · {receipt.reportDate} · {receipt.sectionName||'历史合并日报'}</p>{journal?.status!=='confirmed_restricted'&&<><label className="report-field">归入施工部位<select required disabled={busy||!!journal||!project.canCreate} value={journal?.body.data.wbsId||wbs} onChange={e=>setWbs(e.target.value)}><option value="">请选择施工部位</option>{journal&&!project.nodes.some(n=>n.id===journal.body.data.wbsId)&&<option value={journal.body.data.wbsId}>原施工部位（当前不可选）</option>}{project.nodes.map(n=><option key={n.id} value={n.id}>{n.data.code} · {n.data.title}</option>)}</select></label>{journal&&<p role="status">保存结果待确认。原归入已保留在本机，核对不会重复归入，也不会改投其他部位。</p>}<button className="button primary" disabled={busy||!!restored.error||(!journal&&(!project.canCreate||!project.nodes.length))} onClick={()=>void file()}>{busy?'正在核对归入…':journal?'重试原归入':'归入当前项目施工资料'}</button></>}{error&&<p role="alert" className="report-errors">{error}</p>}{onDismiss&&<button className="text-button" disabled={busy} onClick={onDismiss}>{journal?'保留原归入，稍后核对':'暂不归入'}</button>}{!project.canCreate&&<p>当前账号不能新增资料；已发出的归入仍可核对。</p>}</section>;
}
