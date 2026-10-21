import {normalizePhotoFile} from './photo-input';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Download, FileText, Plus, Save, Upload, X } from 'lucide-react';
import { localDate, type User } from './model';
import './daily-report.css';
import preset from '../shared/daily-report-preset.json';
import { sectionDraftKey, sectionCatalogKey, extractSectionReport, restoreSectionAreas } from './report-sections';
import { createReportDraftStorage } from './report-draft';
import { cloudRequest, createSubmissionRecovery, submissionRecoveryPayloadKey, frozenSubmissionMatchesDraft, type FrozenSubmission, type SubmissionReceipt, type CloudError } from './report-cloud';

type Work = { name: string; quantity: string; unit: string };
type Section = { name: string; kind: 'pipeline' | 'meter'; designQuantity: string; todayProgress: string; cumulativeProgress: string; works: Work[]; todayNotes: string; machinery: string; workers: string; security: string; tomorrow: string; procedures: string; difficulties: string };
type Photo = { name: string; caption: string; mime: 'image/png' | 'image/jpeg'; base64: string; width: number; height: number };
type WeatherLocation = { name: string; latitude: number; longitude: number };
type WeatherInfo = { date: string; latitude: number; longitude: number; source: string; sourceUrl: string; kind: 'forecast'|'recent-history'|'historical'; condition: string; fetchedAt: string; temperatureMin: number|null; temperatureMax: number|null };
type Report = { projectName: string; region: string; reportDate: string; number: string; weather: string; weatherAuto?: boolean; weatherLocation?: WeatherLocation; weatherInfo?: WeatherInfo; sections: Section[]; nextPlan: string; otherItems: string; photos: Photo[] };
const operations = preset.operations;
const newSection = (name = '新增施工片区', kind: Section['kind'] = 'pipeline', designQuantity = ''): Section => ({ name, kind, designQuantity, todayProgress: '', cumulativeProgress: '', works: (kind === 'meter' ? [['水表更换', '块']] : operations).map(([name, unit]) => ({ name, unit, quantity: '' })), todayNotes: '', machinery: '', workers: '', security: '', tomorrow: '', procedures: '', difficulties: '' });
type Area = {id:string;name:string;kind:Section['kind'];designQuantity:string};
type DailyProps={projectId?:string;projectName?:string;user:User;storageScope?:string;saveFile?:(blob:Blob,name:string)=>Promise<void>;fileSavedMessage?:string;submissionMode?:'download'|'filing';filingWbsId?:string;beforeSubmit?:()=>void;onBusyChange?:(busy:boolean)=>void;onSubmitted?:(receipt:SubmissionReceipt,context?:{wbsId?:string;draftChanged?:boolean;targetChanged?:boolean})=>void|Promise<void>};
const emptyReport = (area:Area): Report => ({ projectName: preset.projectName, region: preset.region, reportDate: localDate(), number: '', weather: '', weatherAuto: true, weatherLocation: {...preset.weatherLocation}, sections: [newSection(area.name,area.kind,area.designQuantity)], nextPlan: '', otherItems: '', photos: [] });
function isReport(x: any): x is Report {
  const strings = (v: any, keys: string[]) => v && keys.every(k => typeof v[k] === 'string');
  return strings(x, ['projectName', 'region', 'reportDate', 'number', 'weather', 'nextPlan', 'otherItems'])
    && (x.weatherAuto === undefined || typeof x.weatherAuto === 'boolean')
    && (x.weatherLocation === undefined || strings(x.weatherLocation,['name']) && Number.isFinite(x.weatherLocation.latitude) && Math.abs(x.weatherLocation.latitude)<=90 && Number.isFinite(x.weatherLocation.longitude) && Math.abs(x.weatherLocation.longitude)<=180)
    && Array.isArray(x.sections) && x.sections.length > 0 && x.sections.length <= 12 && x.sections.every((s: any) => strings(s, ['name', 'kind', 'designQuantity', 'todayProgress', 'cumulativeProgress', 'todayNotes', 'machinery', 'workers', 'security', 'tomorrow', 'procedures', 'difficulties']) && ['pipeline', 'meter'].includes(s.kind) && Array.isArray(s.works) && s.works.length <= 40 && s.works.every((w: any) => strings(w, ['name', 'quantity', 'unit'])))
    && Array.isArray(x.photos) && x.photos.length <= 12 && x.photos.every((p: any) => strings(p, ['name', 'caption', 'mime', 'base64']) && ['image/png', 'image/jpeg'].includes(p.mime) && /^[A-Za-z0-9+/]*={0,2}$/.test(p.base64) && p.base64.length <= 6990508 && Number.isInteger(p.width) && Number.isInteger(p.height) && p.width > 0 && p.height > 0 && p.width <= 16000 && p.height <= 16000)
    && x.photos.reduce((sum: number, p: Photo) => sum + p.base64.length * 3 / 4, 0) <= 20 * 1024 * 1024 + 12;
}
const download = (blob: Blob, name: string) => { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };

export default function DailyReport(props:DailyProps){return <SectionWorkspace key={JSON.stringify([props.storageScope||'',props.user.id,props.projectId||''])} {...props}/>;}
function SectionWorkspace(props:DailyProps){
 const scope=props.storageScope||'',catalogKey=sectionCatalogKey(scope,props.user.id,props.projectId);
 const defaults=()=>preset.sections.map((a,i)=>({...a,kind:a.kind as Section['kind'],id:'preset-'+i}));
 const [areas,setAreas]=useState<Area[]>(()=>{try{const saved=JSON.parse(localStorage.getItem(catalogKey)||'null');return restoreSectionAreas(saved,defaults());}catch{return defaults();}});
 const [legacyAreas]=useState<Area[]>(()=>{try{return restoreSectionAreas(JSON.parse(localStorage.getItem(sectionCatalogKey(scope,props.user.id))||'null'),defaults());}catch{return defaults();}}),[legacySource,setLegacySource]=useState(legacyAreas[0].id);
 const [active,setActive]=useState(areas[0].id),[switching,setSwitching]=useState(false),[blocked,setBlocked]=useState(true),[error,setError]=useState(''),[legacyChoice,setLegacyChoice]=useState(false);
 const flush=useRef<()=>Promise<void>>(async()=>{}),lock=useRef(false);
 const area=areas.find(a=>a.id===active)||areas[0];
 useEffect(()=>{try{localStorage.setItem(catalogKey,JSON.stringify(areas));}catch{setError('片区目录保存失败，请下载填写数据备份。');}},[areas,catalogKey]);
 async function select(id:string,add=false){if(lock.current||blocked)return;lock.current=true;setSwitching(true);setError('');try{await flush.current();if(add){const a={id:crypto.randomUUID(),name:'新施工片区',kind:'pipeline' as const,designQuantity:''};setAreas(old=>[...old,a]);setActive(a.id);}else setActive(id);}catch(e){setError((e as Error).message||'当前片区草稿保存失败，内容仍保留，请下载备份后重试。');}finally{lock.current=false;setSwitching(false);}}
 async function copyLegacy(){if(lock.current||blocked||areas.length>=24)return;lock.current=true;setSwitching(true);setError('');try{await flush.current();const original=await createReportDraftStorage<Report>(sectionDraftKey(scope,props.user.id,legacySource)).load();if(!original||!isReport(original))throw Error('没有可复制的旧版片区完整草稿，原数据未改动。');const id=crypto.randomUUID(),target=sectionDraftKey(scope,props.user.id,id,props.projectId);await createReportDraftStorage<Report>(target).save(original);const {photos:_photos,...text}=original;localStorage.setItem(target,JSON.stringify({schemaVersion:1,data:{...text,photos:[]}}));const added={...(legacyAreas.find(a=>a.id===legacySource)||area),id};const next=[...areas,added];localStorage.setItem(catalogKey,JSON.stringify(next));setAreas(next);setActive(id);setLegacyChoice(false);}catch(e){setError((e as Error).message);}finally{lock.current=false;setSwitching(false);}}
 async function legacyBackup(){setError('');try{const key=`smart-office:daily-report:v1:${scope?scope+':':''}${props.user.id}`,saved=await createReportDraftStorage<Report>(key).load().catch(()=>null),textSaved=(()=>{try{return JSON.parse(localStorage.getItem(key)||'null')?.data;}catch{return null;}})(),backup=saved||(isReport(textSaved)?textSaved:null);if(!backup||!isReport(backup))throw Error('没有可恢复的旧版合并草稿。');if(!saved)setError('仅找到旧版文字草稿；原图请从原填写数据备份恢复。');const b=new Blob([JSON.stringify({schemaVersion:1,data:backup},null,2)],{type:'application/json'}),name=(saved?'旧版合并日报草稿_':'旧版文字日报草稿_')+backup.reportDate+'.json';if(props.saveFile)await props.saveFile(b,name);else download(b,name);}catch(e){setError((e as Error).message);}}
 const selector=<section className="section-daily-selector" aria-label="选择独立片区日报"><h2>按施工片区填写日报</h2><p>{props.projectId?`当前项目：${props.projectName}。草稿按项目和片区分别保存在本机。`:'旧版未指定项目草稿；原内容保留。'}切换前保存当前草稿。</p><div className="section-daily-controls"><label>当前施工片区<select value={area.id} disabled={blocked||switching} onChange={e=>void select(e.target.value)}>{areas.map(a=><option key={a.id} value={a.id}>{a.name||'未命名片区'}</option>)}</select></label><button className="button" disabled={blocked||switching||areas.length>=12} onClick={()=>void select('',true)}><Plus size={16}/>新建片区日报</button><button className="text-button" disabled={blocked||switching} onClick={()=>void legacyBackup()}>备份旧版合并草稿</button></div>{props.projectId&&<><button className="text-button" disabled={blocked||switching||areas.length>=24} onClick={()=>setLegacyChoice(v=>!v)}>从旧版片区草稿复制</button>{legacyChoice&&<div><label className="report-field">旧版片区草稿<select value={legacySource} onChange={e=>setLegacySource(e.target.value)}>{legacyAreas.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><p>将选择的旧版完整草稿复制到当前项目；复制为新片区，旧版和当前项目已有草稿均保留。<button className="button" disabled={blocked||switching} onClick={()=>void copyLegacy()}>确认复制到当前项目</button><button className="text-button" onClick={()=>setLegacyChoice(false)}>取消复制</button></p></div>}</>}{error&&<p role="alert" className="report-errors">{error}</p>}</section>;return <div className="section-daily-workspace"><DailyReportEditor selector={selector} key={area.id} {...props} area={area} externalFrozen={switching} storageKey={sectionDraftKey(scope,props.user.id,area.id,props.projectId)} registerFlush={fn=>{flush.current=fn;}} onBlocked={value=>{setBlocked(value);if(value)setError('');}} onArea={a=>setAreas(old=>old.map(row=>row.id===area.id?{...row,...a}:row))}/></div>;
}
function DailyReportEditor({ user,projectId,projectName,storageScope='',saveFile,fileSavedMessage,onSubmitted,submissionMode='download',filingWbsId,beforeSubmit,onBusyChange,area:sectionArea,externalFrozen,selector,storageKey,registerFlush,onBlocked,onArea }:DailyProps&{area:Area;externalFrozen:boolean;selector:ReactNode;storageKey:string;registerFlush:(fn:()=>Promise<void>)=>void;onBlocked:(value:boolean)=>void;onArea:(a:Pick<Area,'name'|'kind'|'designQuantity'>)=>void}) {
  const [report,setReport]=useState<Report>(()=>{try{const saved=JSON.parse(localStorage.getItem(storageKey)||'null');return isReport(saved?.data)&&saved.data.sections.length===1?saved.data:{...emptyReport(sectionArea),...(projectId?{projectName:projectName||preset.projectName}:{})};}catch{return {...emptyReport(sectionArea),...(projectId?{projectName:projectName||preset.projectName}:{})};}});
  const [selected, setSelected] = useState(0);
  const [submittedReport,setSubmittedReport]=useState<Report>();
  const [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false), [importing, setImporting] = useState(false);
  const importingRef = useRef(false);
  const [notice, setNotice] = useState(''), [draftState, setDraftState] = useState('正在恢复本机草稿…');
  const [draftReady, setDraftReady] = useState(false);
  const [draftWarning, setDraftWarning] = useState('');
  const draftStore = useMemo(() => createReportDraftStorage<Report>(storageKey), [storageKey]);
  const submissionRecovery=useMemo(()=>createSubmissionRecovery<Report>(storageKey,projectId,{getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)},id=>createReportDraftStorage<Report>(submissionRecoveryPayloadKey(storageKey,id))),[storageKey,projectId]);
  const [pendingSubmission,setPendingSubmission]=useState<FrozenSubmission<Report>>(),[submissionReady,setSubmissionReady]=useState(false),[recoveryBlocked,setRecoveryBlocked]=useState(false),[submissionWarning,setSubmissionWarning]=useState('');
  const draftRef = useRef({ report, available: false, saved: report, sequence: 0 });
  const persistRef = useRef<() => void>(() => {});
  draftRef.current.report = report;
  const [errors, setErrors] = useState<{ path: string; message: string }[]>([]);
  const [legacyImport,setLegacyImport]=useState<Report>(),[legacyIndex,setLegacyIndex]=useState(0),[legacyPhotos,setLegacyPhotos]=useState<number[]>([]),[legacyShared,setLegacyShared]=useState(false);
  const generationLock=useRef(false);
  const navigationBusy=useRef(false);navigationBusy.current=busy||uploading||!!legacyImport;
  const [weatherLoading, setWeatherLoading] = useState(false), [weatherError, setWeatherError] = useState(''), [weatherRefresh, setWeatherRefresh] = useState(0);
  const weatherLocation = report.weatherLocation || preset.weatherLocation;
  const generationRef = useRef(0), importRef = useRef<HTMLInputElement>(null), errorRef = useRef<HTMLDivElement>(null), noticeRef=useRef<HTMLParagraphElement>(null);
  const writable = user.role !== 'viewer';
  useEffect(() => {
    let active = true;
    draftStore.load().then(saved => {
      if (!active) return;
      if (saved && (!isReport(saved)||saved.sections.length!==1)) throw new Error('本机草稿格式无效');
      if (saved) { setReport(saved); draftRef.current.saved = saved; }
      draftRef.current.available = true;
    }).catch(() => { if (active) {setDraftState('本机照片草稿无法恢复，请导入填写数据或重新选择照片');setDraftWarning('本机照片草稿未能恢复，请导入已备份的填写数据。');} }).finally(() => { if (active) setDraftReady(true); });
    return () => { active = false; };
  }, [draftStore]);
  useEffect(()=>{
    let active=true;submissionRecovery.load().then(attempt=>{if(attempt&&!attempt.receipt&&!isReport(attempt.data))throw Error('原日报保存内容无法读取，请保留本机草稿并核对。');if(active){setPendingSubmission(attempt&&!attempt.receipt?attempt:undefined);if(attempt?.receipt&&!attempt.data)setSubmissionWarning('上次日报已由服务器保存，回执可用；本机原保存快照暂不可读，服务器原件和当前草稿均保留。');}}).catch(e=>{if(active){setRecoveryBlocked(true);setSubmissionWarning((e as Error).message||'原保存凭据暂不可读，已阻止发出新保存。');}}).finally(()=>{if(active)setSubmissionReady(true);});return()=>{active=false;};
  },[submissionRecovery]);
  useEffect(() => {
    if (!draftReady||!submissionReady) return;
    if(busy||pendingSubmission||recoveryBlocked){setWeatherLoading(false);return;}
    if (!report.weatherAuto) { setWeatherLoading(false); setWeatherError(''); return; }
    const controller = new AbortController();
    const date = report.reportDate, {latitude,longitude} = weatherLocation;
    setWeatherLoading(true); setWeatherError('');
    setReport(r => r.weatherInfo?.date===date && r.weatherInfo.latitude===latitude && r.weatherInfo.longitude===longitude ? r : ({...r, weather:'', weatherInfo:undefined, weatherLocation:r.weatherLocation || {...weatherLocation}}));
    const query = new URLSearchParams({date,latitude:String(latitude),longitude:String(longitude)});
    fetch(`/api/daily-report/weather?${query}`, {signal:controller.signal,credentials:'same-origin'}).then(async response => { const info=await response.json(); if (!response.ok) throw new Error(info.error || '天气获取失败'); return info as WeatherInfo; }).then(info => {
      if (!controller.signal.aborted) setReport(r => r.weatherAuto && r.reportDate===date && (r.weatherLocation || preset.weatherLocation).latitude===latitude && (r.weatherLocation || preset.weatherLocation).longitude===longitude ? {...r, weather:info.condition, weatherInfo:info} : r);
    }).catch(e => { if (!controller.signal.aborted) setWeatherError(e.message || '天气获取失败，可重试或按现场记录填写'); }).finally(() => { if (!controller.signal.aborted) setWeatherLoading(false); });
    return () => controller.abort();
  }, [draftReady,submissionReady,busy,pendingSubmission,recoveryBlocked, report.weatherAuto, report.reportDate, weatherLocation.latitude, weatherLocation.longitude, weatherRefresh]);
  useEffect(() => { if (errors.length) { errorRef.current?.focus(); errorRef.current?.scrollIntoView({ block: 'center' }); } }, [errors]);
  useEffect(() => {if(notice.startsWith('已取消保存')){noticeRef.current?.focus();noticeRef.current?.scrollIntoView({block:'center'});}},[notice]);
  useEffect(() => {
    if (!draftReady || !writable) return;
    let active = true;
    const persist = () => {
      const snapshot = draftRef.current.report, sequence = ++draftRef.current.sequence;
      try { const { photos: _photos, ...text } = snapshot; localStorage.setItem(storageKey, JSON.stringify({ schemaVersion: 1, data: { ...text, photos: [] } })); }
      catch { if (active) setDraftState('本机文字草稿保存失败，请下载填写数据留存'); }
      if (!draftRef.current.available) { if (active) {setDraftState('仅保存文字草稿 · 照片草稿不可用，请下载填写数据留存');setDraftWarning('本机照片草稿不可用，请下载填写数据备份本次内容和照片。');} return; }
      if (active) setDraftState('正在保存本机草稿…');
      draftStore.save(snapshot).then(() => {
        draftRef.current.saved = snapshot;
        if (active && sequence === draftRef.current.sequence) {setDraftState('填写内容与照片草稿已保存在本机');setDraftWarning('');}
      }).catch(() => { if (active && sequence === draftRef.current.sequence) {setDraftState('本机照片草稿保存失败，请下载填写数据留存');setDraftWarning('本机照片草稿保存失败，请下载填写数据备份本次内容和照片。');} });
    };
    setDraftState('正在保存本机草稿…');
    const timer = setTimeout(persist, 500);
    persistRef.current = persist;
    const hidden = () => { if (document.visibilityState === 'hidden') { clearTimeout(timer); persist(); } };
    const unload = (event: BeforeUnloadEvent) => { if (importingRef.current || navigationBusy.current || draftRef.current.report !== draftRef.current.saved) { event.preventDefault(); event.returnValue = ''; } };
    document.addEventListener('visibilitychange', hidden); window.addEventListener('pagehide', persist); window.addEventListener('beforeunload', unload);
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', hidden); window.removeEventListener('pagehide', persist); window.removeEventListener('beforeunload', unload); };
  }, [report, storageKey, draftStore, draftReady, writable]);
  useEffect(() => () => { generationRef.current++; persistRef.current(); }, [draftStore]);
  useEffect(()=>{onBlocked(!draftReady||busy||uploading||importing||!!legacyImport);},[draftReady,busy,uploading,importing,legacyImport]);
  useEffect(()=>{onBusyChange?.(busy||uploading||importing||!!legacyImport);},[busy,uploading,importing,legacyImport,onBusyChange]);
  useEffect(()=>{if(draftReady)onArea({name:report.sections[0].name,kind:report.sections[0].kind,designQuantity:report.sections[0].designQuantity});},[draftReady,report.sections[0].name,report.sections[0].kind,report.sections[0].designQuantity]);
  useEffect(()=>{registerFlush(async()=>{if(!draftReady||busy||uploading||importingRef.current||legacyImport)throw Error('当前片区尚在处理，请稍后切换。');if(!draftRef.current.available)throw Error('本机原草稿尚未读取成功，已阻止覆盖原照片。请下载当前填写数据留存，再重新打开页面或导入完整备份恢复。');const snapshot=draftRef.current.report;await draftStore.save(snapshot);const {photos:_photos,...text}=snapshot;localStorage.setItem(storageKey,JSON.stringify({schemaVersion:1,data:{...text,photos:[]}}));draftRef.current.saved=snapshot;});},[draftReady,busy,uploading,legacyImport,draftStore,storageKey]);
  const patch = (key: keyof Report, value: any) => setReport(r => ({ ...r, [key]: value }));
  const patchSection = (key: keyof Section, value: any) => setReport(r => ({ ...r, sections: r.sections.map((s, i) => i === selected ? { ...s, [key]: value } : s) }));
  const current = report.sections[selected] || report.sections[0];
  const setWork = (index: number, key: keyof Work, value: string) => patchSection('works', current.works.map((w, i) => i === index ? { ...w, [key]: value } : w));
  const fieldError = (path: string) => errors.find(e => e.path === path)?.message;
  const input = (label: string, path: string, value: string, change: (v: string) => void, type = 'text', hint?: string) => <label className="report-field">{label}<input name={path} maxLength={path.endsWith('.name')?100:undefined} aria-invalid={!!fieldError(path)} type={type} value={value} onChange={e => change(e.target.value)} step={type === 'number' ? 'any' : undefined} min={type === 'number' ? '0' : undefined} />{hint && <small>{hint}</small>}{fieldError(path) && <small className="report-field-error">{fieldError(path)}</small>}</label>;
  const area = (label: string, path: string, value: string, change: (v: string) => void, hint?: string) => <label className="report-field">{label}<textarea name={path} maxLength={path.endsWith('.name')?100:undefined} aria-invalid={!!fieldError(path)} rows={3} value={value} onChange={e => change(e.target.value)} />{hint && <small>{hint}</small>}{fieldError(path) && <small className="report-field-error">{fieldError(path)}</small>}</label>;
  async function exportData() {
    if (!draftReady || busy || uploading || importingRef.current || externalFrozen) return;
    const blob=new Blob([JSON.stringify({schemaVersion:1,data:report},null,2)],{type:'application/json'}),name=`日报填写数据_${current.name.replace(/[\\/:*?"<>|]/g,"_")}_${report.reportDate}.json`;
    try{if(saveFile)await saveFile(blob,name);else download(blob,name);setNotice(saveFile?'填写数据已保存，下次可导入继续修改。':'填写数据已开始下载，下次可导入继续修改。');}catch(e){if((e as {cancelled?:boolean}).cancelled){setErrors([]);setNotice('已取消保存，填写内容仍保留。');}else setErrors([{path:'',message:(e as Error).message||'保存填写数据失败'}]);}
  }
  async function generate(event: FormEvent) {
    event.preventDefault(); if (generationLock.current || !draftReady || !submissionReady || recoveryBlocked || !writable || busy || uploading || importingRef.current || legacyImport || weatherLoading || externalFrozen) return;
    generationLock.current=true;setBusy(true); setErrors([]); setNotice('');
    let submitted: SubmissionReceipt | undefined,requestStarted=false,attempt:FrozenSubmission<Report>|undefined;
    try {
      if(!pendingSubmission)beforeSubmit?.();
      if(draftRef.current.available){
        await draftStore.save(report);
        const {photos:_photos,...text}=report;localStorage.setItem(storageKey,JSON.stringify({schemaVersion:1,data:{...text,photos:[]}}));
        draftRef.current.saved=report;
      }
      const data=projectId?{...report,projectName:projectName||report.projectName}:report;
      attempt=await submissionRecovery.prepare(data,filingWbsId);
      setPendingSubmission(attempt.receipt?undefined:attempt);
      if(attempt.receipt)submitted=attempt.receipt;
      else{
        requestStarted=true;
        const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),120000);
        try{submitted = await cloudRequest<SubmissionReceipt>('', { submissionId:attempt.submissionId, ...(attempt.projectId?{projectId:attempt.projectId}:{}), data:attempt.data },controller.signal);}
        catch(e){if(controller.signal.aborted)throw Error('日报保存结果暂未确认。原填写内容和提交凭据保留，请重试原保存，系统会核对结果，不会重复创建。');throw e;}
        finally{clearTimeout(timer);}
      }
      try{submissionRecovery.saved(attempt,submitted);setPendingSubmission(undefined);setSubmissionWarning('');}
      catch(e){setSubmissionWarning('服务器已保存；本机回执暂未写入，原请求保留，可核对上次保存。'+(e as Error).message);}
      const sameDraft=await frozenSubmissionMatchesDraft(attempt,data);
      const targetChanged=!!(filingWbsId&&attempt.wbsId&&filingWbsId!==attempt.wbsId);
      const draftChanged=!sameDraft||targetChanged;
      setSubmittedReport(sameDraft?report:undefined);
      if(submissionMode==='filing'){
        setNotice('日报文字、照片及 Word 已保存在服务器，正在归入施工资料…');
        await onSubmitted?.(submitted,{wbsId:attempt.wbsId,draftChanged,targetChanged});
        setNotice(draftChanged?'上次日报已保存在服务器；当前未提交修改仍保留在本机。归入结果见上方。':'日报文字、照片及 Word 已保存在服务器。归入结果见上方，本机草稿保留。');
        return;
      }
      await onSubmitted?.(submitted,{wbsId:attempt.wbsId,draftChanged,targetChanged});
      setNotice('日报文字、照片及 Word 已提交到服务器。正在下载 Word…');
      const response = await fetch(`/api/daily-report/submissions/${submitted.id}/word`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('日报已提交，但 Word 下载失败。请到汇报记录中重新下载。');
      const blob=await response.blob(), name=`施工日报_${(submitted.sectionName||current.name).replace(/[\\/:*?"<>|]/g,"_")}_${submitted.reportDate}.docx`;
      if(saveFile)await saveFile(blob,name);else download(blob,name);
      setNotice((draftChanged?'上次日报已保存在服务器，当前未提交修改仍保留在本机。':'日报已提交到服务器。') + (fileSavedMessage || 'Word 已开始下载，可用 WPS 或 Word 打开检查。'));
    } catch (e) {
      if ((e as {cancelled?:boolean}).cancelled) setNotice('已取消保存到手机；日报已提交到服务器，可在汇报记录中重新下载。');
      else {
        if((e as CloudError).status===400&&attempt?.newlyCreated){try{submissionRecovery.rejected(attempt);setPendingSubmission(undefined);}catch{setRecoveryBlocked(true);setSubmissionWarning('本机凭据不可写，已阻止修改原保存，请保留草稿并核对。');}}
        const responseStatus=(e as CloudError).status;
        const uncertain=requestStarted&&!submitted&&(!responseStatus||responseStatus>=500);
        const problems = (e as CloudError).fields || [{ path: '', message: submitted ? '日报已提交到服务器，但本机文件保存未完成。请到汇报记录中重新下载。' : (uncertain?'服务器保存结果尚未确认，本机草稿和原提交凭据保留。请重试原保存，系统会核对结果。':'')+((e as Error).message || '连接失败，填写内容仍保留，请恢复连接后重试。') }];
        setErrors(problems); const match = problems.find(p => /^sections\.\d+/.test(p.path))?.path.match(/^sections\.(\d+)/); if (match) setSelected(Number(match[1]));
      }
    }
    finally { generationLock.current=false;setBusy(false); }
  }
  async function addPhotos(files: FileList | null) {
    if (!draftReady || !writable || !files?.length || busy || uploading || importingRef.current || legacyImport || externalFrozen) return; setUploading(true); setErrors([]); const version = generationRef.current;
    try {
      const chosen = await Promise.all(Array.from(files).map(f=>normalizePhotoFile(f))); if (report.photos.length + chosen.length > 12) throw new Error('最多添加12张照片');
      let size = report.photos.reduce((n, p) => n + p.base64.length * 3 / 4, 0);
      for (const f of chosen) { if (f.size > 5 * 1024 * 1024) throw new Error(`${f.name} 超过5MB`); size += f.size; }
      if (size > 20 * 1024 * 1024) throw new Error('照片合计不能超过20MB');
      const photos = await Promise.all(chosen.map(f => new Promise<Photo>((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error(`无法读取${f.name}`)); reader.onload = () => { const data = String(reader.result); const img = new Image(); img.onerror = () => reject(new Error(`无法解码${f.name}`)); img.onload = () => img.width > 16000 || img.height > 16000 ? reject(new Error('图片边长不能超过16000像素')) : resolve({ name: f.name, caption: '', mime: f.type as Photo['mime'], base64: data.slice(data.indexOf(',') + 1), width: img.width, height: img.height }); img.src = data; }; reader.readAsDataURL(f); })));
      if (version === generationRef.current) setReport(r => ({ ...r, photos: [...r.photos, ...photos] }));
    } catch (e) { setErrors([{ path: 'photos', message: (e as Error).message }]); } finally { setUploading(false); }
  }
  async function applyImportedReport(data: Report, notice: string) {
    const version = generationRef.current;
    // Only explicit import may replace a draft whose originals could not be read.
    // Commit the complete backup before treating photo storage as usable again.
    if (!draftRef.current.available) {
      await draftStore.save(data);
      if (version !== generationRef.current) return;
      draftRef.current.available = true; draftRef.current.saved = data; setDraftWarning('');
    }
    generationRef.current++; setReport(data); setSelected(0); setLegacyImport(undefined); setNotice(notice);
  }
  async function importLegacySection() {
    if (!legacyImport || busy || uploading || importingRef.current || externalFrozen) return;
    importingRef.current = true; setImporting(true); setErrors([]);
    try {
      await applyImportedReport(extractSectionReport(legacyImport,legacyIndex,legacyPhotos,legacyShared), '已导入所选片区和明确选择的照片。请核对片区、日期和计划后单独提交。');
    } catch (e) { setErrors([{ path: '', message: (e as Error).message || '完整备份恢复失败，原草稿保持不变，请重试。' }]); }
    finally { importingRef.current = false; setImporting(false); }
  }
  async function importData(file?: File) {
    if (!draftReady || !writable || !file || busy || uploading || importingRef.current || legacyImport || externalFrozen) return;
    importingRef.current = true; setImporting(true); setErrors([]); setNotice('正在读取填写数据，请稍候…');
    const version = generationRef.current;
    try {
      if (file.size > 30 * 1024 * 1024) throw new Error('填写数据文件过大');
      const data = JSON.parse(await file.text());
      if (version !== generationRef.current) return;
      if (data.schemaVersion !== 1 || !isReport(data.data)) throw new Error('文件不是此页面导出的填写数据');
      if (data.data.sections.length > 1) {
        setLegacyImport(data.data); setLegacyIndex(0); setLegacyPhotos([]); setLegacyShared(false); setNotice(''); return;
      }
      await applyImportedReport(data.data, '填写数据已载入，请核对日期及当天内容后生成。');
    } catch (e) {
      if (version === generationRef.current) { setNotice(''); setErrors([{ path: '', message: (e as Error).message }]); }
    } finally { importingRef.current = false; setImporting(false); }
  }
  return <section className="daily-report">
    <header className="report-heading"><div><h1>施工日报</h1><p>仅提交当前片区的当天施工情况和原图，单独生成 Word。</p></div><button className="button primary" type="submit" form="daily-report-form" disabled={!draftReady || !submissionReady || recoveryBlocked || !writable || busy || uploading || importing || !!legacyImport || externalFrozen || weatherLoading}><Download size={17} />{busy ? submissionMode==='filing'?'正在保存并归入…':'正在提交…' : pendingSubmission?'核对上次保存':submissionMode==='filing'?'保存并归入施工资料':'提交并生成 Word'}</button></header>
    {selector}
    <div className="report-toolbar"><span><FileText size={17} />管网改造三期施工日报模板</span><div><button className="text-button" type="button" disabled={!draftReady || !writable || busy || uploading || importing || !!legacyImport || externalFrozen} onClick={() => {if(pendingSubmission||recoveryBlocked){setErrors([{path:'',message:'请先核对上次保存；当前草稿和原提交凭据均保留。'}]);return;}importRef.current?.click();}}><Upload size={16} />导入填写数据</button><button className="text-button" type="button" disabled={!draftReady || busy || uploading || importing || externalFrozen} onClick={() => void exportData()}><Save size={16} />下载填写数据</button></div><input ref={importRef} hidden type="file" accept=".json,application/json" onChange={e => { void importData(e.target.files?.[0]); e.target.value = ''; }} /></div>
    {!writable && <p className="error-banner">当前为只读账号，请由业务操作员或管理员填写生成。</p>}
    {errors.length > 0 && <div className="report-errors" role="alert" tabIndex={-1} ref={errorRef}><strong>请检查以下内容</strong><ul>{errors.map((e, i) => <li key={i}><button type="button" onClick={() => { const match = e.path.match(/^sections\.(\d+)/); if (match) setSelected(Number(match[1])); requestAnimationFrame(() => { const el = document.getElementsByName(e.path)[0]; el?.focus(); el?.scrollIntoView({ block: 'center' }); }); }}>{/^sections\.(\d+)/.test(e.path) ? `${report.sections[Number(e.path.split('.')[1])]?.name}：` : ''}{e.message}</button></li>)}</ul></div>}
    {notice && <p className={'report-notice'+(notice.startsWith('已取消保存')?' neutral':'')} role="status" tabIndex={-1} ref={noticeRef}>{notice}</p>}
    {pendingSubmission&&<p className="report-notice neutral" role="status">上次 {pendingSubmission.data?.reportDate} 日报保存结果待确认。请点击“核对上次保存”，系统重放原内容和原凭据，并沿用原施工部位；当前本机草稿原样保留。</p>}
    {submissionWarning&&<p className="report-notice neutral" role="alert">{submissionWarning}</p>}
    {draftWarning && <p className="report-notice neutral" role="status">{draftWarning} <button className="text-button" type="button" disabled={!draftReady || busy || uploading || importing || externalFrozen} onClick={() => void exportData()}>下载填写数据</button></p>}
    {legacyImport&&<section className="report-sheet legacy-section-import" aria-label="拆分旧版合并日报"><h2>选择要导入的施工片区</h2><p>原合并文件保持不变。明确选择本片区及所属照片；未选照片不会带入。</p><label>原日报施工片区<select value={legacyIndex} onChange={e=>{setLegacyIndex(Number(e.target.value));setLegacyPhotos([]);}}>{legacyImport.sections.map((s,i)=><option key={i} value={i}>{s.name}</option>)}</select></label><fieldset><legend>属于本片区的原图</legend>{legacyImport.photos.length?legacyImport.photos.map((p,i)=><label key={i}><input type="checkbox" checked={legacyPhotos.includes(i)} onChange={e=>setLegacyPhotos(old=>e.target.checked?[...old,i]:old.filter(n=>n!==i))}/>{p.name} · {p.caption||'无说明'}</label>):<p>原文件没有照片。</p>}</fieldset><label><input type="checkbox" checked={legacyShared} onChange={e=>setLegacyShared(e.target.checked)}/>带入原汇总计划及其他事项（可能含其他片区，请核对）</label><div className="section-daily-controls"><button className="button primary" disabled={busy||uploading||importing} onClick={()=>void importLegacySection()}>导入此片区日报</button><button className="button" disabled={importing} onClick={()=>setLegacyImport(undefined)}>取消导入</button></div></section>}
    <form id="daily-report-form" noValidate onSubmit={generate}>
      <fieldset disabled={!draftReady || !writable || !!pendingSubmission || recoveryBlocked || busy || importing || !!legacyImport || externalFrozen} className="report-sheet"><legend>日报信息</legend><div className="report-fields report-basics">
        {projectId?<label className="report-field">工程名称<input name="projectName" value={projectName||report.projectName} readOnly aria-readonly="true"/><small>归入当前项目，项目名称无需重复填写。</small></label>:input('工程名称', 'projectName', report.projectName, v => patch('projectName', v))}{input('所属区域', 'region', report.region, v => patch('region', v))}
        {input('施工日期', 'reportDate', report.reportDate, v => patch('reportDate', v), 'date')}{input('天气', 'weather', report.weather, v => setReport(r => ({...r,weather:v,weatherAuto:false,weatherInfo:undefined})), 'text', '自动获取后可按现场情况修正')}{input('日报编号', 'number', report.number, v => patch('number', v), 'text', '可留空')}
      </div><div className="report-weather"><div className="report-weather-controls"><label><input type="checkbox" checked={!!report.weatherAuto} onChange={e => { patch('weatherAuto',e.target.checked); if (e.target.checked) setWeatherRefresh(n => n+1); }} />自动获取天气</label><span>{weatherLocation.name}</span><button type="button" className="text-button" disabled={weatherLoading} onClick={() => { patch('weatherAuto',true); setWeatherRefresh(n=>n+1); }}>刷新天气</button></div>
        {weatherLoading ? <p role="status">正在获取 {report.reportDate} 的天气…</p> : weatherError ? <p className="report-field-error" role="alert">{weatherError}</p> : report.weatherAuto && report.weatherInfo ? <p>来源：<a href={report.weatherInfo.sourceUrl} target="_blank" rel="noreferrer">{report.weatherInfo.source}</a> · {report.weatherInfo.date} · {report.weatherInfo.kind==='forecast'?'预报资料':'历史天气资料'}{report.weatherInfo.temperatureMin!==null && report.weatherInfo.temperatureMax!==null ? ` · ${report.weatherInfo.temperatureMin}～${report.weatherInfo.temperatureMax}℃` : ''}</p> : <p>现场填写 · 已填天气随日报保留</p>}
        <details><summary>调整项目天气位置</summary><div className="report-fields">{input('位置名称','weatherLocation.name',weatherLocation.name,v=>patch('weatherLocation',{...weatherLocation,name:v}))}{input('纬度（-90～90）','weatherLocation.latitude',String(weatherLocation.latitude),v=>patch('weatherLocation',{...weatherLocation,latitude:v===''?NaN:Number(v)}))}{input('经度（-180～180）','weatherLocation.longitude',String(weatherLocation.longitude),v=>patch('weatherLocation',{...weatherLocation,longitude:v===''?NaN:Number(v)}))}</div><small>默认使用经开区参考点；换工程时可调整为施工场地坐标。</small></details>
      </div></fieldset>
      <section className="report-workspace single-section">
        <fieldset disabled={!draftReady || !writable || !!pendingSubmission || recoveryBlocked || busy || importing || !!legacyImport || externalFrozen} className="report-sheet report-current"><legend>{current.name || '施工片区'}</legend><div className="report-fields">
          {input('片区名称', `sections.${selected}.name`, current.name, v => patchSection('name', v))}
          <label className="report-field">施工类型<select value={current.kind} onChange={e => patchSection('kind', e.target.value)}><option value="pipeline">管网施工 · 完成比例</option><option value="meter">水表更换 · 完成数量</option></select></label>
          {input(`设计工程量（${current.kind === 'meter' ? '块' : '米'}）`, `sections.${selected}.designQuantity`, current.designQuantity, v => patchSection('designQuantity', v), 'number')}
          {input(`今日完成${current.kind === 'meter' ? '数量（块）' : '占比（%）'}`, `sections.${selected}.todayProgress`, current.todayProgress, v => patchSection('todayProgress', v), 'number')}
          {input(`累计完成${current.kind === 'meter' ? '数量（块）' : '占比（%）'}`, `sections.${selected}.cumulativeProgress`, current.cumulativeProgress, v => patchSection('cumulativeProgress', v), 'number')}
        </div><p className="report-help">完成占比按项目口径填写，不将不同工序的工程量相加。</p>
        <div className="report-subheading"><h3>今日完成工作</h3><span>空数量不写入日报，0 会保留</span></div>
        <div className="report-work-table"><div className="report-work-head"><span>工序</span><span>完成数量</span><span>单位</span><span className="sr-only">操作</span></div>{current.works.map((w, i) => <div className="report-work-row" key={i}><input aria-label={`工序${i + 1}名称`} name={`sections.${selected}.works.${i}.name`} value={w.name} onChange={e => setWork(i, 'name', e.target.value)} /><input aria-label={`${w.name}完成数量`} name={`sections.${selected}.works.${i}.quantity`} type="number" min="0" step="any" value={w.quantity} onChange={e => setWork(i, 'quantity', e.target.value)} /><input aria-label={`${w.name}计量单位`} name={`sections.${selected}.works.${i}.unit`} value={w.unit} onChange={e => setWork(i, 'unit', e.target.value)} /><button type="button" className="icon-button" aria-label={`删除工序${w.name}`} onClick={() => patchSection('works', current.works.filter((_, index) => index !== i))}><X size={16} /></button></div>)}</div>
        <button className="text-button report-add" type="button" disabled={current.works.length >= 40} onClick={() => patchSection('works', [...current.works, { name: '新增工序', quantity: '', unit: 'm' }])}><Plus size={16} />添加工序</button>
        {area('施工情况补充 / 停工说明', `sections.${selected}.todayNotes`, current.todayNotes, v => patchSection('todayNotes', v), '没有填写工序数量时，请说明当天情况。每行生成一个条目。')}
        <h3>人员与机械</h3><div className="report-fields">{input('施工作业人员（人）', `sections.${selected}.workers`, current.workers, v => patchSection('workers', v), 'number')}{input('交通安保人员', `sections.${selected}.security`, current.security, v => patchSection('security', v), 'text', '填写人数或“无”')}</div>
        {area('施工机械', `sections.${selected}.machinery`, current.machinery, v => patchSection('machinery', v), '例如：挖掘机2台、自卸汽车2台；未使用请填写“无”')}
        {area('本片区明日施工计划', `sections.${selected}.tomorrow`, current.tomorrow, v => patchSection('tomorrow', v))}
        <div className="report-fields">{area('手续办理情况', `sections.${selected}.procedures`, current.procedures, v => patchSection('procedures', v))}{area('工程难点及推进情况', `sections.${selected}.difficulties`, current.difficulties, v => patchSection('difficulties', v))}</div>

        </fieldset>
      </section>
      <fieldset disabled={!draftReady || !writable || !!pendingSubmission || recoveryBlocked || busy || importing || !!legacyImport || externalFrozen} className="report-sheet"><legend>本片区计划与施工照片</legend><div className="report-fields">{area('本片区明日计划汇总', 'nextPlan', report.nextPlan, v => patch('nextPlan', v), '每行一条，自动排列到模板的“明日施工计划”栏')}{area('其他有关事项', 'otherItems', report.otherItems, v => patch('otherItems', v), '确无事项时填写“无”；留空生成“未填写”')}</div><label className="report-photo-picker"><Upload size={18} /><span>{uploading ? '正在读取照片…' : '选择施工照片'}<small>PNG / JPEG，单张5MB以内，最多12张，合计20MB</small></span><input name="photos" type="file" accept="image/png,image/jpeg" multiple disabled={uploading} onChange={e => { void addPhotos(e.target.files); e.target.value = ''; }} /></label>
        {report.photos.length > 0 && <div className="report-photos">{report.photos.map((p, i) => <div className="report-photo" key={i}><img src={`data:${p.mime};base64,${p.base64}`} alt={p.caption || `已选择照片${i + 1}`} /><div><label className="report-field">照片 {i + 1} 说明<input value={p.caption} onChange={e => patch('photos', report.photos.map((photo, index) => i === index ? { ...photo, caption: e.target.value } : photo))} /></label><small>{p.name}</small><button className="text-button" type="button" disabled={uploading} onClick={() => patch('photos', report.photos.filter((_, index) => index !== i))}>移除</button></div></div>)}</div>}
      </fieldset><div className="report-submit"><p role="status" aria-live="polite">{submittedReport===report?'服务器已保存 · 本机草稿保留':'仅本机草稿 · 尚未提交的新内容不在服务器'} · {draftState}</p><button className="button primary" type="submit" disabled={!draftReady || !submissionReady || recoveryBlocked || !writable || busy || uploading || importing || !!legacyImport || externalFrozen || weatherLoading}><Download size={17} />{busy ? submissionMode==='filing'?'正在保存并归入…':'正在提交…' : pendingSubmission?'核对上次保存':submissionMode==='filing'?'保存并归入施工资料':'提交并生成 Word'}</button></div>
    </form>
  </section>;
}
