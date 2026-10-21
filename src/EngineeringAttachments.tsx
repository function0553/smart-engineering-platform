import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Download, FileText, Paperclip, RefreshCw, Trash2, Upload } from 'lucide-react';
import { prettyTime } from './model';
import './engineering-attachments.css';

type Attachment = { id:string; name:string; mime:string; byte_count:number; sha256:string; caption:string; created_name:string; created_at:string; removed_at:string|null; removed_name:string|null; remove_reason:string|null };
type Detail = { attachments:Attachment[]; version:number; writable:boolean; usedBytes:number; usedFiles:number; limits:{maxFileBytes:number;maxItemBytes:number;maxItemFiles:number} };
type Pending = {kind:'upload'|'remove';requestId:string;version:number;name?:string;caption?:string;sha256?:string;attachmentId?:string;reason?:string};
export type EngineeringAttachmentsProps = {
  projectId:string; itemId:string; user:{id:string}; itemVersion?:number; writable?:boolean; storageScope?:string;
  onChanged?:(version:number)=>void|Promise<void>; saveFile?:(blob:Blob,name:string)=>Promise<void>;
};
const supported = '.pdf,.docx,.xlsx,.png,.jpg,.jpeg,.webp,.txt';
const size = (n:number) => n>=1024*1024?`${(n/1024/1024).toFixed(1)} MiB`:n>=1024?`${(n/1024).toFixed(1)} KiB`:`${n} 字节`;
async function json<T>(path:string, body?:unknown):Promise<T> {
  const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Workspace-Request':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  let value;try{value=await r.json();}catch{throw Object.assign(new Error('服务响应异常，请重新核对'),r.ok?{}:{status:r.status});}
  if(!r.ok)throw Object.assign(new Error(value.error||'请求失败'),{status:r.status});return value;
}
const readPending=(key:string):Pending|null=>{try{const value=JSON.parse(sessionStorage.getItem(key)||'null');return value&&['upload','remove'].includes(value.kind)&&typeof value.requestId==='string'?value:null;}catch{return null;}};
function remember(key:string,value:Pending|null){try{if(value)sessionStorage.setItem(key,JSON.stringify(value));else sessionStorage.removeItem(key);}catch{/* The in-memory frozen request remains available when storage is full. */}}
async function fileBody(file:File){const bytes=await file.arrayBuffer();const digest=await crypto.subtle.digest('SHA-256',bytes);const sha256=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');const base64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('读取附件失败，请重新选择文件'));reader.readAsDataURL(file);});return {sha256,base64};}

export function EngineeringAttachments({projectId,itemId,user,itemVersion,writable=true,storageScope=location.origin,onChanged,saveFile}:EngineeringAttachmentsProps){
  const route=`/api/engineering/projects/${projectId}/items/${itemId}/attachments`, storageKey=`eng:attachment:${storageScope}:${user.id}:${projectId}:${itemId}`;
  const [detail,setDetail]=useState<Detail|null>(null),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [file,setFile]=useState<File|null>(null),[caption,setCaption]=useState(''),[removing,setRemoving]=useState(''),[reason,setReason]=useState(''),[pending,setPending]=useState<Pending|null>(()=>readPending(storageKey));
  const frozenBody=useRef<Record<string,unknown>|null>(null), fileInput=useRef<HTMLInputElement>(null), generation=useRef(0);
  const refresh=useCallback(async()=>{const g=++generation.current;try{const value=await json<Detail>(route);if(g===generation.current)setDetail(value);}catch(e){if(g===generation.current&&[401,403,404].includes((e as {status?:number}).status||0))setDetail(null);throw e;}finally{if(g===generation.current)setLoading(false);}},[route]);
  useEffect(()=>{setDetail(null);setLoading(true);setFile(null);setCaption('');setRemoving('');setError('');setMessage('');setPending(readPending(storageKey));frozenBody.current=null;void refresh().catch(e=>setError(e.message));return()=>{generation.current++;};},[route,storageKey,refresh]);
  useEffect(()=>{if(itemVersion!==undefined)void refresh().catch(e=>setError(e.message));},[itemVersion,refresh]);
  useEffect(()=>{if(!pending)return;const warn=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);},[pending]);
  const canWrite=writable&&!!detail?.writable;
  const changePending=(value:Pending|null)=>{setPending(value);remember(storageKey,value);};
  async function commit(operation:Pending,body:Record<string,unknown>){
    setBusy(true);setError('');setMessage('');changePending(operation);frozenBody.current=body;
    let result:{version:number};
    try{result=await json(operation.kind==='upload'?route:`${route}/${operation.attachmentId}/remove`,body);if(!Number.isInteger(result.version))throw new Error('服务响应未包含保存凭据');}
    catch(e){const fault=e as Error&{status?:number};if(fault.status&&fault.status<500){changePending(null);frozenBody.current=null;void refresh().catch(()=>{});setError(fault.message);}else setError(`${fault.message}。结果尚未确认，请重试同一次操作。`);setBusy(false);return;}
    changePending(null);frozenBody.current=null;setFile(null);setCaption('');setRemoving('');setReason('');if(fileInput.current)fileInput.current.value='';
    setMessage(operation.kind==='upload'?'附件原件已保存。':'附件已移除，历史原件及原因已保留。');
    try{await refresh();await onChanged?.(result.version);}catch(e){setError(`已保存，但刷新失败：${(e as Error).message}。请刷新附件列表。`);}finally{setBusy(false);}
  }
  async function upload(event:FormEvent){event.preventDefault();if(!detail)return;setError('');
    if(pending?.kind==='upload'&&frozenBody.current){await commit(pending,frozenBody.current);return;}
    if(!file){setError('请选择要上传的原件');return;}if(!file.size||file.size>detail.limits.maxFileBytes){setError('单个附件须大于 0 字节且不超过 8 MiB');return;}
    setBusy(true);
    try{const content=await fileBody(file);let operation:Pending;
      if(pending){if(pending.kind!=='upload'||pending.name!==file.name||pending.sha256!==content.sha256)throw new Error('请选择上次上传的同一文件，以恢复原请求；请勿改选其他原件');operation=pending;}
      else operation={kind:'upload',requestId:crypto.randomUUID(),version:detail.version,name:file.name,caption,sha256:content.sha256};
      await commit(operation,{requestId:operation.requestId,version:operation.version,name:operation.name,caption:operation.caption||'',base64:content.base64});
    }catch(e){setError((e as Error).message);setBusy(false);}
  }
  async function remove(event:FormEvent,attachmentId:string){event.preventDefault();if(!detail||!reason.trim())return;const operation:Pending={kind:'remove',requestId:crypto.randomUUID(),version:detail.version,attachmentId,reason:reason.trim()};await commit(operation,{requestId:operation.requestId,version:operation.version,reason:operation.reason});}
  async function retryRemoval(){if(!pending||pending.kind!=='remove')return;await commit(pending,{requestId:pending.requestId,version:pending.version,reason:pending.reason});}
  async function download(attachment:Attachment){setBusy(true);setError('');try{const r=await fetch(`${route}/${attachment.id}/download`);if(!r.ok){const value=await r.json().catch(()=>({}));throw new Error(value.error||'附件下载失败');}const blob=await r.blob();if(saveFile)await saveFile(blob,attachment.name);else{const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=attachment.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  function row(attachment:Attachment){return <li key={attachment.id} className="eng-attachment-row"><FileText size={19} aria-hidden="true"/><div className="eng-attachment-content"><strong>{attachment.name}</strong>{attachment.caption&&<p>{attachment.caption}</p>}<p className="eng-attachment-meta">{size(attachment.byte_count)} · {attachment.created_name} · {prettyTime(attachment.created_at)}</p>{attachment.removed_at&&<p className="eng-attachment-meta">{attachment.removed_name} 于 {prettyTime(attachment.removed_at)} 移除：{attachment.remove_reason}</p>}<details className="eng-attachment-digest"><summary>核对原件摘要</summary><code>{attachment.sha256}</code></details></div><div className="eng-attachment-actions"><button type="button" className="button" disabled={busy} onClick={()=>void download(attachment)} aria-label={`下载${attachment.name}`}><Download size={15}/>下载</button>{!attachment.removed_at&&canWrite&&!pending&&<button type="button" className="button" disabled={busy} onClick={()=>{setRemoving(attachment.id);setReason('');}} aria-label={`移除${attachment.name}`}><Trash2 size={15}/>移除</button>}</div>{removing===attachment.id&&!pending&&<form className="eng-attachment-remove" onSubmit={event=>void remove(event,attachment.id)}><label>移除原因<input required maxLength={500} value={reason} disabled={busy} onChange={e=>setReason(e.target.value)} placeholder="请填写原件移除的业务原因"/></label><span>历史原件仍可核查，不会覆盖或删除。</span><div><button type="button" className="button" disabled={busy} onClick={()=>setRemoving('')}>取消</button><button className="button" disabled={busy||!reason.trim()}>确认移除</button></div></form>}</li>;}
  const active=detail?.attachments.filter(a=>!a.removed_at)||[],removed=detail?.attachments.filter(a=>a.removed_at)||[];
  return <section className="eng-attachments" aria-label="单据附件"><header><h3><Paperclip size={18}/>单据附件{detail&&<span>{active.length} 份</span>}</h3><button className="button" type="button" disabled={busy||loading} onClick={()=>{setLoading(true);setError('');void refresh().catch(e=>setError(e.message));}}><RefreshCw size={15}/>刷新附件</button></header>
    {error&&<p className="error-banner" role="alert">{error}</p>}{message&&<p className="eng-attachment-message" role="status">{message}</p>}
    {loading&&!detail?<p>正在读取附件…</p>:detail&&<><p className="eng-attachment-help">每份最多 8 MiB；本单据含历史原件已用 {detail.usedFiles}/{detail.limits.maxItemFiles} 份、{size(detail.usedBytes)}/{size(detail.limits.maxItemBytes)}。</p>{!canWrite&&!pending&&<p className="eng-attachment-help">当前单据状态或权限不允许增删附件，已有原件可下载核查。</p>}
      {pending&&<p className="eng-attachment-pending" role="status">上次{pending.kind==='upload'?`上传「${pending.name}」`:'移除附件'}结果待确认。{pending.kind==='upload'&&!frozenBody.current?'重新选择同一原件，可恢复原请求。':'请重试同一次操作，不会重复保存。'}{pending.kind==='remove'&&<button type="button" className="button" disabled={busy} onClick={()=>void retryRemoval()}>重试同一次移除</button>}</p>}
      {(canWrite&&!pending||pending?.kind==='upload')&&<form className="eng-attachment-upload" onSubmit={event=>void upload(event)}><label>选择附件<input ref={fileInput} type="file" accept={supported} disabled={busy||!!pending&&!!frozenBody.current} onChange={event=>{setFile(event.target.files?.[0]||null);setError('');}}/></label><label>附件说明<input value={pending?.caption??caption} maxLength={500} disabled={busy||!!pending} onChange={event=>setCaption(event.target.value)} placeholder="如合同签署页、整改前后照片"/></label><button className="button primary" disabled={busy||!file&&!frozenBody.current}><Upload size={16}/>{busy?'正在保存…':pending?'重试同一次上传':'上传原件'}</button><p className="eng-attachment-help">支持 PDF、docx、xlsx、PNG、JPEG、WebP、UTF-8 文本。</p></form>}
      {active.length?<ul className="eng-attachment-list">{active.map(row)}</ul>:<p className="eng-attachment-empty">还没有附件。合同原件、付款凭证和现场证据可随单据保存。</p>}
      {removed.length>0&&<details className="eng-attachment-history"><summary>已移除的历史原件（{removed.length} 份）</summary><ul className="eng-attachment-list">{removed.map(row)}</ul></details>}
    </>}
  </section>;
}
