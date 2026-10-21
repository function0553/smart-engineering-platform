import {normalizePhotoFile} from './photo-input';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ArrowLeft, Camera, Download, FileImage, FileText, Plus, RefreshCw, Save, Trash2, Upload } from 'lucide-react';
import { prettyTime, type User } from './model';
import { archiveDraftScope, archiveDraftStorage, type ArchiveDraft, type ArchiveConflictBackup, type PendingArchiveExport, type PendingArchiveUpload, type StoredArchiveDraft } from './photo-archive-recovery';
import {onEngineeringNavigationBlocked} from './engineering-navigation-guard';
import preset from '../shared/photo-archive.json';
import './photo-archives.css';

type Stage = {id:string;name:string;completedAt:string};
type Segment = {id:string;start:string;end:string;content:string;completedAt:string;stages:Stage[]};
type Data = {title:string;projectName:string;roadName:string;segments:Segment[]};
type Photo = {id:string;segmentId:string;stageId:string;name:string;caption:string;mime:string;width:number;height:number;bytes:number;sha256?:string};
type Archive = {id:string;authorName:string;title:string;projectName:string;roadName:string;version:number;updatedAt:string;data:Data;photos:Photo[];exports:{id:string;createdAt:string;photoCount:number;version:number}[]};
type Page = {items:Archive[];total:number};
const newSegment = ():Segment => ({id:crypto.randomUUID(),start:'',end:'',content:'',completedAt:'',stages:preset.stages.map(name=>({id:crypto.randomUUID(),name,completedAt:''}))});
const download = (blob:Blob,name:string) => {const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
type ExportReceipt = {id:string;createdAt:string;photoCount:number};
type Context = {scope:string;generation:number};
const validData = (value:unknown):value is Data => {
  const v=value as Data | undefined;
  return !!v && typeof v.title==='string' && typeof v.projectName==='string' && typeof v.roadName==='string' && Array.isArray(v.segments) && !!v.segments.length && v.segments.every(s=>!!s && typeof s.id==='string' && ['start','end','content','completedAt'].every(key=>typeof s[key as keyof Segment]==='string') && Array.isArray(s.stages) && !!s.stages.length && s.stages.every(stage=>!!stage && typeof stage.id==='string' && typeof stage.name==='string' && typeof stage.completedAt==='string'));
};
const sameData = (a:Data,b:Data) => JSON.stringify(a)===JSON.stringify(b);
const exportSnapshot = (item:Archive) => JSON.stringify({data:item.data,photos:item.photos.map(p=>({id:p.id,segmentId:p.segmentId,stageId:p.stageId,name:p.name,caption:p.caption,mime:p.mime,width:p.width,height:p.height,bytes:p.bytes}))});
async function boundedRequest<T>(action:(signal:AbortSignal)=>Promise<T>,message:string):Promise<T>{
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
  const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(new Error(message));controller.abort();},90_000);});
  // Some native transports cannot cancel an in-flight write. Bound waiting only;
  // a late receipt has no state side effects here and the next action reads back.
  try{return await Promise.race([action(controller.signal),timeout]);}finally{clearTimeout(timer!);}
}
async function archiveCall<T>(path:string, method='GET',body?:unknown):Promise<T> {
  return boundedRequest(async signal=>{const response=await fetch('/api/photo-archives'+path,{method,signal,credentials:'same-origin',headers:{'Content-Type':'application/json','X-Workspace-Request':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();
    if(!response.ok)throw Object.assign(new Error(data.error || '操作失败，请重试'),{status:response.status});
    return data;
  },'连接超时，服务器可能仍在处理；请重新核对结果后重试');
}
const originalDigest=async(file:Blob)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),value=>value.toString(16).padStart(2,'0')).join('');
async function archiveBlob(path:string){return boundedRequest(async signal=>{const response=await fetch(path,{credentials:'same-origin',signal});if(!response.ok)throw new Error('文件读取失败，可重新下载');return await response.blob();},'文件读取超时，可重新下载');}

export default function PhotoArchives({user,storageScope='',saveFile,projectId='',projectName,canCreate=true}:{projectId?:string;projectName?:string;canCreate?:boolean;user:User;storageScope?:string;saveFile?:(blob:Blob,name:string)=>Promise<void>}) {
  function call<T>(path:string,method='GET',body?:unknown){return archiveCall<T>(method==='GET'&&projectId?path+(path.includes('?')?'&':'?')+'projectId='+encodeURIComponent(projectId):path,method,body);}
  const [page,setPage]=useState<Page>(),[archive,setArchive]=useState<Archive>(),[data,setData]=useState<Data>(),[segmentId,setSegmentId]=useState(''),[stageId,setStageId]=useState('');
  const [busy,setBusy]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[dirty,setDirty]=useState(false),[q,setQ]=useState(''),[offset,setOffset]=useState(0);
  const [removing,setRemoving]=useState<Photo>(),[images,setImages]=useState<Record<string,string>>({}),[imageErrors,setImageErrors]=useState<Record<string,boolean>>({});
  const [caption,setCaption]=useState(''),[uploadStatus,setUploadStatus]=useState<{kind:'busy'|'success'|'error';message:string}>(),[pendingExport,setPendingExport]=useState<PendingArchiveExport>(),[recoveries,setRecoveries]=useState<StoredArchiveDraft<Data>[]>([]);
  const [conflictBackups,setConflictBackups]=useState<ArchiveConflictBackup<Data>[]>([]),[conflictDecision,setConflictDecision]=useState(false),[pendingUploads,setPendingUploads]=useState<PendingArchiveUpload[]>([]);
  const scope=archiveDraftScope(location.origin,storageScope,user.id,projectId),store=archiveDraftStorage<Data>(scope,projectId?scope:`photo-archive:${storageScope}:${user.id}:`,validData);
  const activeScope=useRef(scope),mounted=useRef(false),opening=useRef(0),listing=useRef(0),working=useRef(false),localWarning=useRef('');
  const editor=useRef<{scope:string;archive:Archive;data:Data;dirty:boolean;entry:StoredArchiveDraft<Data>} | undefined>(undefined);
  const conflictSource=useRef<StoredArchiveDraft<Data> | undefined>(undefined);
  activeScope.current=scope;
  const writable=user.role!=='viewer'&&canCreate,segment=data?.segments.find(s=>s.id===segmentId),stage=segment?.stages.find(s=>s.id===stageId);
  const photos=archive?.photos.filter(p=>p.segmentId===segmentId && p.stageId===stageId)||[],locked=busy||!!pendingExport||conflictDecision||!writable;
  const context=():Context=>({scope,generation:opening.current});
  const active=(token:Context)=>mounted.current && activeScope.current===token.scope && opening.current===token.generation;
  const ensure=(token:Context)=>{if(!active(token))throw Object.assign(new Error('操作上下文已改变'),{stale:true});};
  function message(text:string){setNotice(text+(localWarning.current?' '+localWarning.current:''));}
  function start():Context | undefined {if(working.current || activeScope.current!==scope)return;working.current=true;localWarning.current='';setBusy(true);setError('');setNotice('');return context();}
  function finish(token:Context){if(active(token)){working.current=false;setBusy(false);}}
  function install(item:Archive,value:Data,entry:StoredArchiveDraft<Data>,unsaved:boolean){editor.current={scope,archive:item,data:value,dirty:unsaved,entry};setArchive(item);setData(value);setDirty(unsaved);setPendingExport(entry.draft.pendingExport);setPendingUploads(entry.draft.pendingUploads||[]);}
  function enterConflict(item:Archive,entry:StoredArchiveDraft<Data>){
    conflictSource.current=entry;setConflictDecision(true);
    try{store.preserveConflict(entry,item.version);}catch(e){setError((e as Error).message);}
    setConflictBackups(store.conflicts(item.id));install(item,item.data,entry,false);
    if(!item.data.segments.some(s=>s.id===segmentId&&s.stages.some(stage=>stage.id===stageId)))select(item.data.segments[0]);
    message('服务器内容已更新，本机填写已独立保留。请先核对并选择要继续的版本。');
  }
  function updateArchive(item:Archive,keepPrevious=false){const current=editor.current;if(!current||current.scope!==scope||current.archive.id!==item.id)return false;
    if(conflictSource.current){enterConflict(item,current.entry);return false;}
    const keep=keepPrevious||current.dirty||!!current.entry.draft.pendingExport;
    if(keep&&current.entry.draft.version!==item.version&&!sameData(current.data,item.data)){
      enterConflict(item,{...current.entry,draft:{...current.entry.draft,data:current.data,dirty:current.dirty}});return false;
    }
    const accepted=receipt(item,keep?current.data:item.data,current.entry);
    if(!editor.current!.data.segments.some(s=>s.id===segmentId&&s.stages.some(stage=>stage.id===stageId)))select(editor.current!.data.segments[0]);
    return accepted;
  }
  function select(s:Segment){setSegmentId(s.id);setStageId(s.stages[0]?.id||'');setCaption('');setUploadStatus(undefined);setRemoving(undefined);}
  function durable(slot:string,draft:ArchiveDraft<Data>):StoredArchiveDraft<Data>{store.write(slot,draft);return {slot,sourceKey:store.key(slot),draft};}
  function receipt(item:Archive,value:Data,oldEntry:StoredArchiveDraft<Data>){
    // A write acknowledgement may advance its own version. A read of a later
    // unrelated revision must not attach that new revision to older local data.
    if(!sameData(item.data,value)&&((oldEntry.draft.version>0&&oldEntry.draft.version!==item.version)||(oldEntry.draft.version===0&&item.version>1))){enterConflict(item,{...oldEntry,draft:{...oldEntry.draft,data:value}});return false;}
    const unsaved=!sameData(item.data,value),draft:ArchiveDraft<Data>={id:item.id,data:unsaved?value:item.data,version:item.version,dirty:unsaved,...(oldEntry.draft.pendingExport?{pendingExport:oldEntry.draft.pendingExport}:{}),...(oldEntry.draft.pendingUploads?.length?{pendingUploads:oldEntry.draft.pendingUploads}:{})};
    // Apply the server receipt before optional local migration or cleanup.
    install(item,draft.data,{...oldEntry,draft},unsaved);
    try{const next=durable(item.id,draft);install(item,draft.data,next,unsaved);if(!store.retire(oldEntry,item.id))localWarning.current='服务器回执已确认，本机旧备份清理失败；此前备份仍保留。';return true;}
    catch(e){localWarning.current=(e as Error).message;return false;}
  }
  function recoveryList(){try{setRecoveries(store.discover());setConflictBackups(store.conflicts());}catch(e){setError((e as Error).message);}}
  async function list(at=offset,filter=q){const token=context(),request=++listing.current;setLoading(true);setError('');recoveryList();
    try{const result=await call<Page>('?'+new URLSearchParams({limit:'20',offset:String(at),q:filter}));if(active(token)&&request===listing.current)setPage(result);}catch(e){if(active(token)&&request===listing.current)setError((e as Error).message);}finally{if(active(token)&&request===listing.current)setLoading(false);}
  }
  useEffect(()=>{mounted.current=true;opening.current++;working.current=false;conflictSource.current=undefined;editor.current=undefined;setArchive(undefined);setData(undefined);setPendingExport(undefined);setPendingUploads([]);setConflictDecision(false);setConflictBackups([]);setBusy(false);setNotice('');setError('');setPage(undefined);setRecoveries([]);setQ('');setOffset(0);void list(0,'');return()=>{mounted.current=false;opening.current++;listing.current++;};},[scope]);
  useEffect(()=>{const warn=(event:BeforeUnloadEvent)=>{if(working.current){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',warn);const stop=onEngineeringNavigationBlocked(()=>{if(working.current)setNotice('正在处理填写内容、原图或 Word，请稍候；本次完成或失败后即可离开。');});return()=>{window.removeEventListener('beforeunload',warn);stop();};},[scope]);
  useEffect(()=>{let isActive=true;const token=context(),controller=new AbortController(),urls:string[]=[];setImages({});setImageErrors({});
    for(const photo of photos)void fetch(`/api/photo-archives/${archive!.id}/photos/${photo.id}`,{signal:controller.signal,credentials:'same-origin'}).then(async r=>{if(!r.ok)throw new Error();const blob=await r.blob();if(!isActive||!active(token))return;const url=URL.createObjectURL(blob);urls.push(url);setImages(old=>({...old,[photo.id]:url}));}).catch(()=>{if(isActive&&active(token))setImageErrors(old=>({...old,[photo.id]:true}));});
    return()=>{isActive=false;controller.abort();urls.forEach(URL.revokeObjectURL);};
  },[scope,archive?.id,archive?.photos,segmentId,stageId]);
  function entryFor(id:string){const byId=store.read(id);if(byId)return byId;const fresh=store.read('new');return fresh?.draft.id===id?fresh:undefined;}
  function assign(item:Archive){
    conflictSource.current=undefined;setConflictDecision(false);
    const cached=entryFor(item.id),entry:StoredArchiveDraft<Data>=cached||{slot:item.id,sourceKey:store.key(item.id),draft:{id:item.id,data:item.data,version:item.version,dirty:false}};
    const confirmedPending=!!cached?.draft.pendingExport&&item.exports.some(e=>e.id===cached.draft.pendingExport!.id),prepared=confirmedPending?{...entry,draft:{...entry.draft,pendingExport:undefined}}:entry;
    install(item,prepared.draft.data,prepared,prepared.draft.dirty);
    if(prepared.draft.version===0)receipt(item,prepared.draft.data,prepared);
    else updateArchive(item,confirmedPending);
    setConflictBackups(store.conflicts(item.id));select(editor.current!.data.segments[0]);
    if(!conflictSource.current){if(confirmedPending)message('已从服务器生成记录确认上一份 Word，可下载此版本。');else if(editor.current!.dirty)message('已恢复本机未保存修改，请保存到服务器。');}
  }
  async function open(id:string){if(working.current)return;opening.current++;const token=context();setLoading(true);setError('');setNotice('');
    try{const item=await call<Archive>('/'+id);ensure(token);assign(item);}catch(e){if(active(token))setError((e as Error).message);}finally{if(active(token))setLoading(false);}
  }
  function create(){if(working.current||!writable)return;try{
    const saved=store.read('new');
    if(saved&&store.read(saved.draft.id)?.draft.version){
      if(store.retire(saved,saved.draft.id)){create();return;}
      void open(saved.draft.id);return;
    }
    if(saved?.draft.version){void open(saved.draft.id);return;}
    const id=saved?.draft.id||crypto.randomUUID(),value=saved?.draft.data||{title:preset.title,projectName:projectName||preset.projectName,roadName:preset.roadName,segments:[newSegment()]};
    const draft:ArchiveDraft<Data>=saved?.draft||{id,data:value,version:0,dirty:true,creationId:id},entry=durable('new',draft);
    opening.current++;conflictSource.current=undefined;setConflictDecision(false);setConflictBackups([]);install({id,authorName:user.name,title:value.title,projectName:value.projectName,roadName:value.roadName,version:draft.version,updatedAt:'',data:value,photos:[],exports:[]},value,entry,true);select(value.segments[0]);setError('');setNotice(saved?'已恢复本机新资料册；保存会继续确认原请求。':'填写起止桩号后保存，即可分工序上传照片。填写草稿已保存在本机。');
  }catch(e){setError((e as Error).message);}}
  function patch(change:Partial<Data>):boolean{const current=editor.current;if(!current||current.scope!==scope||working.current||conflictSource.current||current.entry.draft.pendingExport||!writable)return false;
    const value={...current.data,...change};try{const entry=durable(current.entry.slot,{...current.entry.draft,id:current.archive.id,data:value,dirty:true});install(current.archive,value,entry,true);return true;}catch(e){setError((e as Error).message);return false;}}
  function changeSegment(change:Partial<Segment>){return patch({segments:editor.current!.data.segments.map(s=>s.id===segmentId?{...s,...change}:s)});}
  function changeStage(change:Partial<Stage>){return changeSegment({stages:segment!.stages.map(s=>s.id===stageId?{...s,...change}:s)});}
  async function persist(token:Context){ensure(token);let current=editor.current;if(!current)throw new Error('请先填写资料册');if(conflictSource.current)throw new Error('请先核对本机冲突备份，选择要继续的版本');if(current.entry.draft.pendingExport)throw new Error('上一份 Word 的生成结果尚未确认，请先重试生成或重新读取生成记录');
    const value=current.data;let item=current.archive,entry=current.entry;
    if(!current.dirty&&item.version)return item;
    if(!item.version){
      const draft={...entry.draft,data:value,creationId:entry.draft.creationId||item.id,creationData:entry.draft.creationData||value};entry=durable(entry.slot,draft);current.entry=entry;ensure(token);
      try{item=await call<Archive>('','POST',{creationId:draft.creationId,data:draft.creationData,...(projectId?{projectId}:{})});}
      catch(e){ensure(token);const status=(e as {status?:number}).status;
        // A validation rejection did not create anything, so the next attempt may fix its body.
        if(status===400){current.entry=durable(entry.slot,{...draft,creationData:undefined});throw e;}
        if(status!==409)throw e;item=await call<Archive>('/'+draft.creationId);}
      ensure(token);const migrated=receipt(item,value,entry);current=editor.current!;entry=current.entry;
      if(conflictSource.current)throw new Error('资料册填写已由其他设备更新，请先核对本机冲突备份并选择版本。');
      if(!current.dirty)return item;
      if(!migrated)throw new Error('资料册已创建；本机修改备份迁移失败，请检查可用空间后再次保存。');
    }
    // This also protects a version change whose PUT reply was lost.
    const remote=await call<Archive>('/'+item.id);ensure(token);
    if(sameData(remote.data,value)){receipt(remote,remote.data,entry);return remote;}
    if(remote.version!==entry.draft.version){enterConflict(remote,{...entry,draft:{...entry.draft,data:value,dirty:true}});throw new Error('资料册已被其他设备修改；本机填写已保留，请先核对并选择版本。');}
    entry=durable(item.id,{...entry.draft,id:item.id,data:value,dirty:true,creationId:undefined,creationData:undefined});current.entry=entry;ensure(token);
    item=await call<Archive>('/'+item.id,'PUT',{version:entry.draft.version,data:value});ensure(token);receipt(item,item.data,entry);return item;
  }
  async function save(){const token=start();if(!token)return;try{await persist(token);ensure(token);message('填写内容已保存到服务器，可以换设备继续补图。');}catch(e){if(active(token))setError((e as Error).message);}finally{finish(token);}}
  async function refresh(){const current=editor.current,token=start();if(!current||!token)return;try{const item=await call<Archive>('/'+current.archive.id);ensure(token);assign(item);if(editor.current?.entry.draft.pendingExport)message('生成结果尚未确认；重试会使用同一个编号，避免重复版本。');else if(!item.exports.length)message('服务器资料已刷新，本机备份仍保留。');}catch(e){if(active(token))setError((e as Error).message);}finally{finish(token);}}
  async function stageDigests(item:Archive,sid:string,tid:string,token:Context){const digests=new Set<string>();
    for(const photo of item.photos.filter(p=>p.segmentId===sid&&p.stageId===tid)){
      if(photo.sha256)digests.add(photo.sha256);
      else{const blob=await archiveBlob(`/api/photo-archives/${item.id}/photos/${photo.id}`);ensure(token);digests.add(await originalDigest(blob));ensure(token);}
    }return digests;
  }
  function uploadJournal(batch:PendingArchiveUpload,item:Archive,confirmed?:Set<string>){const current=editor.current;if(!current)return;
    const previous=current.entry.draft.pendingUploads||[],batches=previous.filter(old=>!(old.segmentId===batch.segmentId&&old.stageId===batch.stageId&&old.files.every(file=>batch.files.some(next=>next.sha256===file.sha256))));
    if(!confirmed||!batch.files.every(file=>confirmed.has(file.sha256)))batches.push(batch);
    const entry=durable(current.entry.slot,{...current.entry.draft,pendingUploads:batches.length?batches:undefined});install(current.archive,current.data,entry,current.dirty);updateArchive(item);
  }
  async function upload(event:ChangeEvent<HTMLInputElement>){const files=Array.from(event.target.files||[]);event.target.value='';if(!files.length||!stage||!segment||pendingExport||conflictSource.current)return;const token=start();if(!token)return;setNotice('');setUploadStatus({kind:'busy',message:'正在准备原图…'});
    const sid=segment.id,tid=stage.id;let completed=0,item:Archive|undefined,failure='',prepared:{file:File;sha256:string}[]=[],batch:PendingArchiveUpload|undefined,skipped=0,journalSaved=false;
    try{
      for(const file of files)if(!file.size||file.size>preset.maxPhotoBytes)throw new Error(`${file.name}为空或超过5MB，请选择5MB以内的照片；这不是JPEG格式错误。`);
      const unique=new Set<string>();
      for(const source of files){const file=await normalizePhotoFile(source);ensure(token);const sha256=await originalDigest(file);ensure(token);if(!unique.has(sha256)){unique.add(sha256);prepared.push({file,sha256});}}
      item=await persist(token);item=await call<Archive>('/'+item.id);ensure(token);updateArchive(item);
      if(conflictSource.current)throw new Error('服务器填写已更新，请先核对并选择版本后继续上传');
      if(!item.data.segments.some(s=>s.id===sid&&s.stages.some(stage=>stage.id===tid)))throw new Error('路段或工序已由其他设备更新，请重新选择工序后上传');
      const saved=await stageDigests(item,sid,tid,token),remaining=prepared.filter(photo=>!saved.has(photo.sha256));skipped=prepared.length-remaining.length;
      if(remaining.length+item.photos.filter(p=>p.segmentId===sid&&p.stageId===tid).length>preset.maxStagePhotos)throw new Error('每道工序最多6张照片；已保存的相同原图已跳过，请减少新增照片');
      if(item.photos.length+remaining.length>120||item.photos.reduce((total,p)=>total+p.bytes,0)+remaining.reduce((total,p)=>total+p.file.size,0)>preset.maxArchiveBytes)throw new Error('每册最多120张原图、合计24MB；已保存的相同原图已跳过，请另建资料册');
      batch={segmentId:sid,stageId:tid,files:prepared.map(({file,sha256})=>({name:file.name,sha256,bytes:file.size}))};uploadJournal(batch,item,saved);journalSaved=true;
      for(const {file} of remaining){ensure(token);setUploadStatus({kind:'busy',message:`正在上传原图 ${completed+1}/${remaining.length}…${skipped?` 已跳过 ${skipped} 张服务器已保存原图。`:''}`});
        const encoded=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('照片读取失败'));reader.readAsDataURL(file);});ensure(token);
        const size=await new Promise<{width:number;height:number}>((resolve,reject)=>{const image=new Image();image.onload=()=>resolve({width:image.naturalWidth,height:image.naturalHeight});image.onerror=()=>reject(new Error('照片无法显示，请重新选择'));image.src=encoded;});ensure(token);
        await call('/'+item.id+'/photos','POST',{id:crypto.randomUUID(),segmentId:sid,stageId:tid,name:file.name,caption,mime:file.type,base64:encoded.split(',')[1],...size});ensure(token);completed++;
      }
    }catch(e){failure=(e as Error).message;}
    finally{if(active(token)){
      let saved:Set<string>|undefined;
      if(item){try{const fresh=await call<Archive>('/'+item.id);ensure(token);item=fresh;updateArchive(fresh);saved=await stageDigests(fresh,sid,tid,token);if(batch)uploadJournal(batch,fresh,saved);}catch(e){failure=failure||`上传结果尚未核对：${(e as Error).message}`;}}
      if(active(token)){
        const confirmed=saved?prepared.filter(photo=>saved!.has(photo.sha256)).length:0,allConfirmed=!!batch&&!!saved&&confirmed===prepared.length;
        if(allConfirmed){setCaption('');setUploadStatus({kind:'success',message:`已上传 ${completed} 张原图到服务器；本批 ${confirmed} 张均已核对保存。${skipped?` 已跳过 ${skipped} 张重复原图。`:''}`});}
        else setUploadStatus({kind:'error',message:failure+(batch?`${saved?`；本批已核对保存 ${confirmed}/${prepared.length} 张。`:journalSaved?'；本批原图清单已保存在本机，服务器结果待核对。':'；原图清单未能写入本机，请检查可用空间。'}重新选择原批照片即可继续，已保存的原图会自动跳过。`:'')});
      }
    }finish(token);}
  }
  async function removePhoto(){if(!removing||!archive||pendingExport)return;const token=start();if(!token)return;try{await call('/'+archive.id+'/photos/'+removing.id,'DELETE',{});ensure(token);const item=await call<Archive>('/'+archive.id);ensure(token);updateArchive(item);setRemoving(undefined);message('照片已从当前资料册移除；已生成的 Word 版本保留。');}catch(e){if(active(token))setError((e as Error).message);}finally{finish(token);}}
  async function saveWord(id:string,item:Archive,token:Context){ensure(token);const blob=await archiveBlob(`/api/photo-archives/${item.id}/exports/${id}/word`);ensure(token);const name=`施工影像_${item.roadName}_${id.slice(0,8)}.docx`;if(saveFile)await saveFile(blob,name);else download(blob,name);ensure(token);}
  function confirmExport(item:Archive,result:ExportReceipt,pending:PendingArchiveExport){
    const current=editor.current!;
    const confirmed={...item,exports:item.exports.some(e=>e.id===result.id)?item.exports:[{...result,version:pending.version},...item.exports]};
    const entry={...current.entry,draft:{...current.entry.draft,pendingExport:undefined}};install(current.archive,current.data,entry,current.dirty);
    updateArchive(confirmed,true);
    return confirmed;
  }
  async function generate(){const token=start();if(!token)return;setNotice('');let confirmed=false;
    try{let current=editor.current;if(!current)throw new Error('请先打开资料册');let item=current.entry.draft.pendingExport?current.archive:await persist(token);ensure(token);current=editor.current!;
      let pending=current.entry.draft.pendingExport;
      if(!pending){pending={id:crypto.randomUUID(),version:item.version,snapshot:exportSnapshot(item),attempted:false};const entry=durable(item.id,{...current.entry.draft,pendingExport:pending});install(item,current.data,entry,current.dirty);}
      else {const entry=durable(current.entry.slot,current.entry.draft);current.entry=entry;}
      const latest=await call<Archive>('/'+item.id);ensure(token);
      updateArchive(latest);
      const existing=latest.exports.find(e=>e.id===pending!.id);
      let result:ExportReceipt;
      if(existing)result=existing;
      else {
        if(pending.attempted===false&&(latest.version!==pending.version||exportSnapshot(latest)!==pending.snapshot))throw new Error('服务器填写内容或原图已改变，本次尚未开始生成；请刷新核对后重新生成。');
        ensure(token);pending={...pending,attempted:true};current=editor.current!;
        const entry=durable(current.entry.slot,{...current.entry.draft,pendingExport:pending});install(current.archive,current.data,entry,current.dirty);
        result=await call<ExportReceipt>('/'+item.id+'/exports','POST',{exportId:pending.id,version:pending.version,snapshot:pending.snapshot});ensure(token);
      }
      confirmed=true;item=confirmExport(latest,result,pending);message('汇总 Word 已生成并保存在服务器，正在下载…');await saveWord(result.id,item,token);message('汇总 Word 已生成并保存在服务器。');
    }catch(e){if(active(token)){
      const current=editor.current,status=(e as {status?:number}).status,pending=current?.entry.draft.pendingExport;
      if(!confirmed&&current&&pending&&(pending.attempted===false||status===400||status===409)){
        try{const entry=durable(current.entry.slot,{...current.entry.draft,pendingExport:undefined});install(current.archive,current.data,entry,current.dirty);message(conflictSource.current?'本次未生成 Word；本机旧填写仍保留，请先核对并选择版本。':'本次未生成 Word，已恢复编辑。请补齐照片或刷新核对后重新生成。');}
        catch(cleanupError){localWarning.current=(cleanupError as Error).message;}
      }
      if((e as {cancelled?:boolean}).cancelled){message('已取消手机保存；Word 已保存在生成记录。');setError('');}
      else{setError((confirmed?'Word 已生成并保存在服务器；':'')+(e as Error).message);if(!confirmed&&editor.current?.entry.draft.pendingExport)message('生成结果尚未确认；重试会使用同一个编号，避免重复版本。');}
    }}finally{finish(token);}
  }
  async function oldWord(id:string){const item=editor.current?.archive,token=start();if(!item||!token)return;try{await saveWord(id,item,token);message('Word 已开始保存。');}catch(e){if(active(token)){if((e as {cancelled?:boolean}).cancelled)message('已取消手机保存；Word 已保存在生成记录。');else setError((e as Error).message);}}finally{finish(token);}}
  async function original(photo:Photo){const item=editor.current?.archive,token=start();if(!item||!token)return;try{const blob=await archiveBlob(`/api/photo-archives/${item.id}/photos/${photo.id}`);ensure(token);const name=`施工原图_${photo.id.slice(0,8)}.${photo.mime==='image/png'?'png':'jpg'}`;if(saveFile)await saveFile(blob,name);else download(blob,name);ensure(token);message('原图已开始保存。');}catch(e){if(active(token)){if((e as {cancelled?:boolean}).cancelled)message('已取消手机保存。');else setError((e as Error).message);}}finally{finish(token);}}
  async function backup(){const current=editor.current;if(!current)return;const token=context();try{const saved=localStorage.getItem(current.entry.sourceKey);if(!saved)throw new Error('本机暂无未保存修改');const blob=new Blob([saved],{type:'application/json'});if(saveFile)await saveFile(blob,'施工影像_未保存修改.json');else download(blob,'施工影像_未保存修改.json');ensure(token);}catch(e){if(active(token)){if((e as {cancelled?:boolean}).cancelled)message('已取消备份保存。');else setError((e as Error).message);}}}
  function resolveConflict(backup?:ArchiveConflictBackup<Data>){const current=editor.current;if(!current||working.current||current.entry.draft.pendingExport||!writable)return;try{
    if(conflictSource.current)store.preserveConflict(conflictSource.current,current.archive.version);
    // Selecting either complete version is explicit; never merge local fields
    // into a newer server version silently. The immutable backup remains.
    const value=backup?backup.draft.data:current.archive.data,unsaved=!sameData(value,current.archive.data),entry=durable(current.archive.id,{...current.entry.draft,id:current.archive.id,data:value,version:current.archive.version,dirty:unsaved,creationId:undefined,creationData:undefined});
    conflictSource.current=undefined;setConflictDecision(false);setConflictBackups(store.conflicts(current.archive.id));install(current.archive,value,entry,unsaved);select(value.segments[0]);setError('');message(backup?'已载入整份本机版本，请核对后保存；服务器填写尚未修改，保存后将使用本机版本。':'已选择继续服务器版本；本机冲突备份仍可下载或载入。');
  }catch(e){setError((e as Error).message);}}
  async function downloadConflict(backup:ArchiveConflictBackup<Data>){const token=context();try{const raw=localStorage.getItem(backup.sourceKey);if(!raw)throw new Error('本机冲突备份读取失败，此前工作草稿仍保留');const blob=new Blob([JSON.stringify(JSON.parse(raw).draft)],{type:'application/json'});if(saveFile)await saveFile(blob,'施工影像_冲突备份_v'+backup.draft.version+'.json');else download(blob,'施工影像_冲突备份_v'+backup.draft.version+'.json');ensure(token);}catch(e){if(active(token))setError((e as Error).message);}}
  function back(){if(working.current)return;opening.current++;conflictSource.current=undefined;setConflictDecision(false);editor.current=undefined;setArchive(undefined);setData(undefined);setPendingExport(undefined);setPendingUploads([]);setNotice('');setError('');void list();}
  return <section className="photo-archives">
    <p className="report-notice neutral">{projectId?`当前资料项目：${projectName}。仅显示本项目影像，草稿按项目分别保存。`:"旧版未指定项目影像与本机草稿保留；关联到项目后不能跨项目使用。"}</p>
    <header className="archive-heading"><div><h1>施工影像资料</h1><p>{archive?(writable?'按桩号和工序补齐照片，生成开挖至回填汇总 Word。':'查看桩号、工序原图和已生成的 Word。'):projectId?'仅查看当前项目的影像资料。':'旧版未指定项目资料独立保留。'}</p></div>{archive?<button className="text-button" disabled={busy} onClick={back}><ArrowLeft size={16}/>返回资料册</button>:writable&&<button className="button primary" disabled={loading} onClick={create}><Plus size={16}/>新建资料册</button>}</header>
    {error&&<p className="report-errors" role="alert">{error}</p>}{notice&&<p className="report-notice" role="status">{notice}</p>}
    {!archive&&writable&&conflictBackups.length>0&&<section className="archive-exports" aria-label="本机冲突备份"><h2>本机冲突备份</h2><p>以下本机填写与服务器版本不同，已独立保留。打开资料册后可下载或载入核对。</p><ol>{conflictBackups.map(backup=><li key={backup.sourceKey}><span>{backup.draft.data.title} · {backup.draft.data.roadName} · 本机版本 {backup.draft.version}</span><button className="text-button" disabled={loading||busy} onClick={()=>void open(backup.draft.id)}>打开核对</button></li>)}</ol></section>}
    {archive&&writable&&(conflictDecision||conflictBackups.length>0)&&<section className="archive-exports" aria-label="本机冲突备份"><h2>本机冲突备份</h2><p>{conflictDecision?'服务器已更新。请先选择继续哪份填写，避免覆盖本机未保存内容；照片和 Word 不会自动合并。':'本机旧填写独立保留，继续修改不会覆盖这些备份。'}</p>{conflictDecision&&<button className="button" disabled={busy||!!pendingExport} onClick={()=>resolveConflict()}>继续服务器版本</button>}<ol>{conflictBackups.map(backup=><li key={backup.sourceKey}><span>本机版本 {backup.draft.version} · {backup.draft.data.roadName} · {prettyTime(backup.savedAt)}</span><div><button className="text-button" disabled={busy} onClick={()=>void downloadConflict(backup)}>下载本机备份</button><button className="button" disabled={busy||!!pendingExport} onClick={()=>resolveConflict(backup)}>载入本机版本核对</button></div></li>)}</ol>{conflictDecision&&!conflictBackups.length&&<p>独立备份尚未写入成功，原本机草稿仍保留。请先“备份本机修改”，检查可用空间后再继续。</p>}</section>}
    {archive&&pendingUploads.length>0&&!busy&&<p className="report-notice" role="status">本机保留 {pendingUploads.length} 批尚未完成核对的原图清单。请回到对应工序重新选择原批照片，系统会跳过已保存的相同原件后继续上传。</p>}
    {!archive&&<>{writable&&recoveries.length>0&&<section className="archive-exports" aria-label="本机草稿恢复"><h2>本机待恢复资料</h2><p>保存中断或尚未确认的生成请求可从这里继续。</p><ol>{recoveries.map(entry=><li key={entry.draft.id}><span>{entry.draft.data.title} · {entry.draft.data.roadName}{entry.draft.pendingExport?' · Word 结果待确认':entry.slot==='new'?' · 新资料册':' · 未保存修改'}</span><button className="text-button" disabled={loading||busy} onClick={()=>entry.slot==='new'?create():void open(entry.draft.id)}><RefreshCw size={16}/>恢复本机草稿</button></li>)}</ol></section>}<form className="archive-search" onSubmit={e=>{e.preventDefault();setOffset(0);void list(0);}}><label>工程 / 道路 / 填报人<input type="search" value={q} onChange={e=>setQ(e.target.value)} placeholder="输入关键词" maxLength={100}/></label><button className="button" disabled={loading}>搜索</button><button className="text-button" type="button" disabled={loading} onClick={()=>void list()}><RefreshCw size={16}/>刷新</button></form>{loading?<p role="status">正在读取资料册…</p>:page&&<><p className="archive-count">共 {page.total} 册</p>{!page.items.length?<div className="archive-empty"><FileImage size={32}/><h2>尚无施工影像资料</h2><p>{writable?'新建资料册、填写桩号段，再按施工工序上传现场照片。':'填报人员提交资料后，会在这里显示；如需查看其他人的资料，请联系管理员。'}</p></div>:<ol className="archive-list">{page.items.map(item=><li key={item.id}><button disabled={loading} onClick={()=>void open(item.id)}><strong>{item.title} · {item.roadName}</strong><span>{item.projectName}</span><small>{item.authorName} · 更新于 {prettyTime(item.updatedAt)}</small></button><FileText size={20}/></li>)}</ol>}{page.total>20&&<div className="archive-pagination"><button disabled={!offset} className="button" onClick={()=>{setOffset(offset-20);void list(offset-20);}}>上一页</button><span>第 {offset/20+1} 页</span><button disabled={offset+20>=page.total} className="button" onClick={()=>{setOffset(offset+20);void list(offset+20);}}>下一页</button></div>}</>}</>}
    {archive&&data&&segment&&stage&&<><fieldset className="archive-fields" disabled={locked}><div className="archive-metadata"><label>资料册名称<input value={data.title} onChange={e=>patch({title:e.target.value})} maxLength={100}/></label><label>工程名称<input value={data.projectName} onChange={e=>patch({projectName:e.target.value})} maxLength={150}/></label><label>道路名称<input value={data.roadName} onChange={e=>patch({roadName:e.target.value})} maxLength={80}/></label></div></fieldset>
      <div className="archive-toolbar"><span>{dirty?'有未保存修改':archive.version?'填写内容已保存到服务器':'新资料册尚未保存'} · {archive.photos.length} 张原图</span><div>{writable&&<button className="button" disabled={locked||!dirty} onClick={()=>void save()}><Save size={16}/>保存填写</button>}<button className="text-button" disabled={busy||!archive.version} onClick={()=>void refresh()}><RefreshCw size={16}/>刷新</button>{writable&&<button className="text-button" disabled={busy} onClick={()=>void backup()}>备份本机修改</button>}{writable&&<button className="button primary" disabled={busy||(!pendingExport&&(conflictDecision||!archive.photos.length))} onClick={()=>void generate()}><FileText size={16}/>{pendingExport?'重试生成 Word':'生成汇总 Word'}</button>}</div></div>
      {pendingExport&&<div className="report-notice" role="status"><p>编号 {pendingExport.id.slice(0,8)} 的 Word 生成结果尚未确认。确认前暂停修改填写内容和原图，重试会继续使用此编号。</p><button className="text-button" disabled={busy} onClick={()=>void refresh()}><RefreshCw size={16}/>重新读取生成记录</button></div>}<div className="archive-editor"><aside className="archive-segments"><h2>桩号段</h2><ol>{data.segments.map(s=><li key={s.id}><button disabled={busy} aria-current={s.id===segmentId?'step':undefined} onClick={()=>select(s)}><strong>{s.content||`${s.start||'起点'}～${s.end||'终点'}`}</strong><span>{archive.photos.filter(p=>p.segmentId===s.id).length} 张照片{ s.completedAt?' · '+s.completedAt:''}</span></button></li>)}</ol>{writable&&<button className="text-button" disabled={locked||data.segments.length>=32} onClick={()=>{const next=newSegment();if(patch({segments:[...data.segments,next]}))select(next);}}><Plus size={16}/>添加桩号段</button>}</aside>
        <div className="archive-stage-work"><fieldset className="archive-fields" disabled={locked}><div className="archive-segment-fields"><label>起点桩号<input value={segment.start} placeholder="K0+000" onChange={e=>changeSegment({start:e.target.value})} maxLength={40}/></label><label>终点桩号<input value={segment.end} placeholder="K0+074" onChange={e=>changeSegment({end:e.target.value})} maxLength={40}/></label><label>完工日期<input type="date" value={segment.completedAt} onChange={e=>changeSegment({completedAt:e.target.value})}/></label><label>施工内容（可替代桩号）<input value={segment.content} placeholder="特殊工序可填探坑等" onChange={e=>changeSegment({content:e.target.value})} maxLength={100}/></label></div></fieldset>
          <nav className="archive-stages" aria-label="施工工序">{segment.stages.map(s=><button key={s.id} disabled={busy} aria-current={s.id===stageId?'step':undefined} onClick={()=>{setStageId(s.id);setCaption('');setUploadStatus(undefined);setRemoving(undefined);}}><strong>{s.name}</strong><span>{archive.photos.filter(p=>p.segmentId===segment.id&&p.stageId===s.id).length} 张</span></button>)}</nav>
          <fieldset className="archive-fields" disabled={locked}><div className="archive-stage-fields"><label>当前工序<input value={stage.name} onChange={e=>changeStage({name:e.target.value})} maxLength={50}/></label><label>工序完成日期（选填）<input type="date" value={stage.completedAt} onChange={e=>changeStage({completedAt:e.target.value})}/></label></div>{writable&&<div className="archive-upload"><label>本批照片说明（选填）<input value={caption} onChange={e=>setCaption(e.target.value)} maxLength={500}/></label><div><label className="button primary"><Upload size={16}/>选择原图<input className="archive-file-input" type="file" multiple accept="image/png,image/jpeg" onChange={e=>void upload(e)}/></label><label className="button"><Camera size={16}/>拍照<input className="archive-file-input" type="file" accept="image/jpeg" capture="environment" onChange={e=>void upload(e)}/></label></div><p>每道工序最多6张，单张5MB，每册原图合计24MB。空缺工序保留空格。</p>{uploadStatus&&<p className={'archive-upload-feedback '+(uploadStatus.kind==='error'?'report-errors':'report-notice')} role={uploadStatus.kind==='error'?'alert':'status'}>{uploadStatus.message}</p>}</div>}</fieldset>
          <div className="archive-photos">{photos.map(photo=><figure key={photo.id}>{images[photo.id]?<img src={images[photo.id]} alt={photo.caption||photo.name} onError={()=>setImageErrors(e=>({...e,[photo.id]:true}))}/>:<p role={imageErrors[photo.id]?'alert':'status'}>{imageErrors[photo.id]?'照片读取失败，请刷新':'正在读取照片…'}</p>}<figcaption><strong>{photo.caption||photo.name}</strong><span>{(photo.bytes/1024/1024).toFixed(2)}MB · {photo.width}×{photo.height}</span><div><button className="text-button" disabled={busy} onClick={()=>void original(photo)}><Download size={16}/>下载原图</button>{writable&&<button className="text-button" disabled={locked} aria-label={'移除照片 '+photo.name} onClick={()=>setRemoving(photo)}><Trash2 size={16}/>移除</button>}</div></figcaption></figure>)}</div>
          {!photos.length&&<div className="archive-stage-empty"><FileImage size={26}/><h3>{stage.name}尚无照片</h3><p>{writable?'上传本工序的现场原图，系统会放入对应的 Word 表格。':'本工序还没有照片，等待填报人员补充。'}</p></div>}
          {removing&&<div className="archive-remove" role="alert"><p>移除“{removing.caption||removing.name}”？已生成的 Word 和其原图副本保留。</p><button className="button" disabled={locked} onClick={()=>void removePhoto()}>确认移除</button><button className="text-button" disabled={busy} onClick={()=>setRemoving(undefined)}>取消</button></div>}
          {writable&&<div className="archive-stage-actions"><button className="text-button" disabled={locked||segment.stages.length>=16} onClick={()=>{const s={id:crypto.randomUUID(),name:'新增工序',completedAt:''};if(changeSegment({stages:[...segment.stages,s]}))setStageId(s.id);}}><Plus size={16}/>添加工序</button><button className="text-button" disabled={locked||segment.stages.length===1||!!photos.length} onClick={()=>{const remaining=segment.stages.filter(s=>s.id!==stage.id);if(changeSegment({stages:remaining}))setStageId(remaining[0].id);}}>移除空工序</button><button className="text-button" disabled={locked||data.segments.length===1||archive.photos.some(p=>p.segmentId===segment.id)} onClick={()=>{const remaining=data.segments.filter(s=>s.id!==segment.id);if(patch({segments:remaining}))select(remaining[0]);}}>移除空路段</button></div>}
        </div></div>
      <section className="archive-exports"><h2>Word 生成记录</h2><p>后续补图或修改填写内容，不会覆盖已生成的版本。</p>{!archive.exports.length?<p>尚未生成汇总 Word。</p>:<ol>{archive.exports.map(e=><li key={e.id}><span>{prettyTime(e.createdAt)} · {e.photoCount} 张照片 · 编号 {e.id.slice(0,8)}</span><button className="text-button" disabled={busy} onClick={()=>void oldWord(e.id)}><Download size={16}/>下载此版本</button></li>)}</ol>}</section>
    </>}
  </section>;
}
