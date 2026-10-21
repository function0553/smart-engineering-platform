import {DailyFilingQueue} from './DailyFilingQueue';
import {DailySiteFiling,type FilingProject} from './DailySiteFiling';
import { createDailyFilingJournal, confirmDailyFiling, filingKey, readDailyFilingJournal, retainDailyFilingJournal, timedDailyFilingRequest } from './daily-filing';
import {readSiteCaptureContext} from '../shared/site-capture-context.mjs';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowLeft, Download, FileText, RefreshCw, Search } from 'lucide-react';
import DailyReport from './DailyReport';
import { cloudRequest, type SubmissionReceipt } from './report-cloud';
import { api, prettyTime, type User } from './model';
import './daily-reports.css';

type StoredReport = { weather: string; nextPlan: string; otherItems: string; sections: { name: string; kind: string; designQuantity: string;
  todayProgress: string; cumulativeProgress: string; works: { name: string; quantity: string; unit: string }[];
  todayNotes: string; machinery: string; workers: string; security: string; tomorrow: string; procedures: string; difficulties: string }[] };
type Detail = SubmissionReceipt & { data: StoredReport; photos: { index: number; name: string; caption: string; mime: string }[] };
type Page = { items: SubmissionReceipt[]; total: number; limit: number; offset: number; scope: string };
const localDownload = (blob: Blob, name: string) => { const url = URL.createObjectURL(blob), link = document.createElement('a'); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };

type DailyReportsProps = { filingProject?:FilingProject;onFiled?:(id:string)=>void;user:User;storageScope?:string;saveFile?:(blob:Blob,name:string)=>Promise<void>;fileSavedMessage?:string };
export default function DailyReports(props:DailyReportsProps){
  // Scope every transient receipt as strictly as the existing persisted drafts.
  return <DailyReportsWorkspace key={JSON.stringify([props.storageScope||'',props.user.id,props.filingProject?.id||''])} {...props}/>;
}
function DailyReportsWorkspace({ user, storageScope = '', saveFile, fileSavedMessage,filingProject,onFiled }:DailyReportsProps) {
  const canFill=user.role!=='viewer'&&(!filingProject||filingProject.canCreate);
  const integrated=!!filingProject&&!!onFiled&&canFill;
  const [view, setView] = useState<'fill' | 'history' | 'filing'>(canFill ? 'fill' : 'history');
  const [revision, setRevision] = useState(0), [last, setLast] = useState<SubmissionReceipt>();
  const [selectedWbs,setSelectedWbs]=useState(()=>{if(!filingProject)return '';try{const saved=readSiteCaptureContext(localStorage,{backend:storageScope||location.origin,userId:user.id,projectId:filingProject.id}).saved?.context;return filingProject.nodes.some(n=>n.id===saved?.wbsId)?saved!.wbsId:'';}catch{return '';}});
  const [editorBusy,setEditorBusy]=useState(false),[filingBusy,setFilingBusy]=useState(false),[filingError,setFilingError]=useState(''),[filingNotice,setFilingNotice]=useState(''),[pendingFiled,setPendingFiled]=useState('');
  const filingRef=useRef<HTMLDivElement>(null),live=useRef(true),filingLock=useRef(false);
  useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
  useEffect(()=>{if(last)filingRef.current?.scrollIntoView({block:'start'});},[last]);
  // Navigation is released only after the editor and filing have both settled.
  useEffect(()=>{if(pendingFiled&&!editorBusy&&!filingBusy){setPendingFiled('');onFiled?.(pendingFiled);}},[pendingFiled,editorBusy,filingBusy,onFiled]);
  useEffect(()=>{const guard=(event:Event)=>{if(filingLock.current)event.preventDefault();};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[]);
  function checkTarget(){if(!filingProject?.canCreate||!filingProject.nodes.some(n=>n.id===selectedWbs))throw Error('请先在日报上方选择当前授权范围内的施工部位，再保存并归入。');}
  async function saved(receipt:SubmissionReceipt,context?:{wbsId?:string;draftChanged?:boolean;targetChanged?:boolean}){
    setLast(receipt);setRevision(n=>n+1);setFilingError('');setFilingNotice('');
    if(!integrated||!filingProject){if(filingProject)setView('filing');return;}
    filingLock.current=true;setFilingBusy(true);
    try{
      const key=filingKey(storageScope,user.id,filingProject.id,receipt.id);
      const journal=readDailyFilingJournal(localStorage.getItem(key)||sessionStorage.getItem(key),receipt)||createDailyFilingJournal(receipt,filingProject,context?.wbsId||selectedWbs);
      const confirmed=await confirmDailyFiling(filingProject,receipt,journal,timedDailyFilingRequest(api),value=>{retainDailyFilingJournal(localStorage,key,value);sessionStorage.removeItem(key);});
      if(!live.current)return;
      setRevision(n=>n+1);
      if(confirmed.status==='confirmed'&&confirmed.id){if(context?.draftChanged){setFilingNotice(context.targetChanged?'原日报已归入原施工部位，尚未改投当前选择。只更换部位不会重复生成日报；请点击“查看已归入资料”，按权限核对或修改原资料的部位。当前填写草稿原样保留。':'上次保存已归入施工资料；当前正文有未提交修改，本机草稿原样保留。可查看原资料，或继续整理后保存新日报。');setView('fill');}else setPendingFiled(confirmed.id);}
      else{setFilingError('日报和归入均已由服务器确认；当前账号无权查看原部位，请联系项目管理员。');setView('filing');}
    }catch(e){if(live.current){setFilingError('日报文字、照片和 Word 已保存在服务器；归入尚未确认。'+((e as Error).message||'请核对下方原归入，原草稿保留。'));setView('filing');}}
    finally{filingLock.current=false;if(live.current)setFilingBusy(false);}
  }
  const blocked=editorBusy||filingBusy;
  return <div className="daily-reports-workspace">
    {filingProject&&<section className="report-history-summary" aria-label="日报归属"><h2>⑥ 施工日报</h2><p><strong>当前项目：{filingProject.name}</strong></p><p>填写后保存并归入当前施工资料，审核仍由您明确提交。本机草稿、服务器原图和 Word 均保留。</p>
      {view==='fill'&&canFill&&<label className="report-field">施工部位<select value={selectedWbs} disabled={blocked} onChange={e=>{setSelectedWbs(e.target.value);setFilingError('');}}><option value="">请选择本次日报的施工部位</option>{filingProject.nodes.map(n=><option key={n.id} value={n.id}>{n.data.code} · {n.data.title}</option>)}</select><small>{filingProject.nodes.length?'选择一次，保存时自动归入该部位。':'当前没有可上传的施工部位，请联系项目管理员设置。'}</small></label>}
    </section>}
    <nav className="reports-tabs" aria-label="施工日报工作区">
      {canFill && <button type="button" disabled={blocked} aria-current={view === 'fill' ? 'page' : undefined} onClick={() => setView('fill')}>填写日报</button>}
      <button type="button" disabled={blocked} aria-current={view === 'history' ? 'page' : undefined} onClick={() => setView('history')}>{filingProject?'已保存日报':user.role === 'admin' ? '全部汇报记录' : '我的汇报记录'}</button>
      {filingProject&&<button type="button" disabled={blocked} aria-current={view==='filing'?'page':undefined} onClick={()=>setView('filing')}>待归入 / 核对结果</button>}
    </nav>
    {filingNotice&&<p className="report-notice neutral" role="status">{filingNotice}</p>}
    {filingError&&<p className="report-errors" role="alert">{filingError}</p>}
    {filingBusy&&<p className="report-submission-status" role="status">日报已保存在服务器，正在核对归入施工资料…</p>}
    {last&&filingProject&&onFiled&&!blocked&&<div ref={filingRef}><DailySiteFiling key={filingProject.id+last.id} receipt={last} project={filingProject} userId={user.id} storageScope={storageScope} onFiled={id=>{setRevision(n=>n+1);onFiled(id);}} onChanged={()=>setRevision(n=>n+1)} onDismiss={()=>setLast(undefined)}/></div>}
    {filingProject&&view==='filing'&&<DailyFilingQueue key={filingProject.id+user.id} project={filingProject} userId={user.id} storageScope={storageScope} revision={revision} onChoose={r=>{setFilingError('');setLast({...r});}}/>}
    {last && view === 'fill' && !filingProject && <p className="report-submission-status" role="status">{last.sectionName||'历史合并'} · {last.reportDate} 日报已保存在服务器。<button className="text-button" type="button" onClick={() => setView('history')}>查看汇报记录</button></p>}
    <div hidden={view !== 'fill'}>{canFill && <DailyReport projectId={filingProject?.id} projectName={filingProject?.name} user={user} storageScope={storageScope} saveFile={saveFile} fileSavedMessage={fileSavedMessage} submissionMode={integrated?'filing':'download'} filingWbsId={integrated?selectedWbs:undefined} beforeSubmit={integrated?checkTarget:undefined} onBusyChange={setEditorBusy} onSubmitted={saved}/>}</div>
    {view === 'history' && <History projectId={filingProject?.id} user={user} revision={revision} saveFile={saveFile} onChoose={filingProject?.canCreate&&!blocked?receipt=>{setFilingError('');setLast(receipt);}:undefined} />}
  </div>;
}

function History({ user, revision, saveFile,onChoose,projectId }: {projectId?:string;onChoose?:(receipt:SubmissionReceipt)=>void;user: User; revision: number; saveFile?: (blob: Blob, name: string) => Promise<void> }) {
  const [page, setPage] = useState<Page>(), [detail, setDetail] = useState<Detail>(), [images, setImages] = useState<Record<number, string>>({});
  const [imageErrors, setImageErrors] = useState<Record<number, boolean>>({});
  const [date, setDate] = useState(''), [q, setQ] = useState(''), [filter, setFilter] = useState({ date: '', q: '' });
  const [offset, setOffset] = useState(0), [refresh, setRefresh] = useState(0), [loading, setLoading] = useState(false), [opening, setOpening] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [saving, setSaving] = useState(false);
  const requestVersion = useRef(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    const query = new URLSearchParams({...(projectId?{projectId}:{}), limit: '20', offset: String(offset), ...(filter.date ? { date: filter.date } : {}), ...(filter.q ? { q: filter.q } : {}) });
    cloudRequest<Page>('?' + query, undefined, controller.signal).then(result => { if (!controller.signal.aborted) setPage(result); })
      .catch(e => { if (!controller.signal.aborted) setError(e.message || '汇报记录读取失败，请重试'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [offset, filter, refresh, revision,projectId]);
  useEffect(() => { if (!detail) return; let active = true; const controller = new AbortController(), urls: string[] = [];
    setImageErrors({});
    void Promise.all(detail.photos.map(async photo => {
      try {
        const response = await fetch(`/api/daily-report/submissions/${detail.id}/photos/${photo.index}`, { credentials: 'same-origin', signal: controller.signal });
        if (!response.ok) throw new Error('照片读取失败');
        const blob = await response.blob(); if (!active) return;
        const url = URL.createObjectURL(blob); urls.push(url); setImages(current => ({ ...current, [photo.index]: url }));
      } catch { if (active) setImageErrors(current => ({ ...current, [photo.index]: true })); }
    }));
    return () => { active = false; controller.abort(); urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [detail]);
  useEffect(() => () => { requestVersion.current++; }, []);
  async function open(id: string) { const version = ++requestVersion.current; setOpening(true); setError(''); setNotice(''); setImages({});
    try { const result = await cloudRequest<Detail>('/' + id); if (version === requestVersion.current) setDetail(result); }
    catch (e) { if (version === requestVersion.current) setError((e as Error).message); } finally { if (version === requestVersion.current) setOpening(false); } }
  async function save(item: SubmissionReceipt, kind: 'word' | 'data') {
    if (saving) return; setSaving(true); setError(''); setNotice('');
    try { const response = await fetch(`/api/daily-report/submissions/${item.id}/${kind}`, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('下载失败，请检查登录状态后重试');
      const filename = `${kind === 'word' ? '施工日报' : '日报填写数据'}_${(item.sectionName||'历史合并').replace(/[\\/:*?"<>|]/g,'_')}_${item.reportDate}_${item.id.slice(0, 8)}.${kind === 'word' ? 'docx' : 'json'}`;
      const blob = await response.blob(); if (saveFile) await saveFile(blob, filename); else localDownload(blob, filename);
      setNotice(saveFile ? '文件已保存到您选择的手机目录；服务器原记录保留。' : '文件已开始下载；服务器原记录保留。');
    } catch (e) { if ((e as { cancelled?: boolean }).cancelled) setNotice('已取消保存到手机；服务器原记录保留，可随时重新下载。'); else setError((e as Error).message); }
    finally { setSaving(false); }
  }
  function search(e: FormEvent) { e.preventDefault(); setOffset(0); setFilter({ date, q: q.trim() }); }
  return <section className="daily-report report-history">
    <header className="report-heading"><div><h1>{detail ? '汇报详情' : user.role === 'admin' ? '全部汇报记录' : '我的汇报记录'}</h1><p>服务器保存文字、原图和 Word。{user.role === 'admin' ? '可查看所有填报人的提交。' : '仅显示您本人在当前资料范围内的提交。'}</p></div>
      {detail ? <button className="text-button" onClick={() => { requestVersion.current++; setDetail(undefined); setImages({}); setError(''); setNotice(''); }}><ArrowLeft size={16} />返回记录</button>
        : <button className="text-button" disabled={loading} onClick={() => setRefresh(n => n + 1)}><RefreshCw size={16} />刷新</button>}</header>
    {error && <p className="report-errors" role="alert">{error}</p>}{notice && <p className="report-notice" role="status">{notice}</p>}
    {!detail && <><form className="report-history-filter" onSubmit={search}><label>施工日期<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label><label>工程 / 片区 / 填报人 / 编号<input type="search" value={q} onChange={e => setQ(e.target.value)} placeholder="输入关键词" maxLength={100} /></label><button className="button" disabled={loading}><Search size={16} />筛选</button><button className="text-button" type="button" onClick={() => { setDate(''); setQ(''); setOffset(0); setFilter({ date: '', q: '' }); }}>清除筛选</button></form>
      {loading ? <p role="status">正在读取汇报记录…</p> : page && <><p className="report-history-count">共 {page.total} 条提交</p>{!page.items.length ? <div className="report-history-empty"><FileText size={28} /><h2>暂无汇报记录</h2><p>{filter.date || filter.q ? '当前筛选没有匹配记录，可清除筛选。' : '填写日报并提交后，文字、照片和 Word 将显示在这里。'}</p></div>
        : <ol className="report-history-list">{page.items.map(item => <li key={item.id}><button className="report-record-open" disabled={opening} onClick={() => void open(item.id)}><strong>{item.projectName}</strong><span>{item.sectionName||`历史合并日报（${item.sectionCount||'多'}片区）`} · {item.reportDate} · {item.region}{item.number ? ' · ' + item.number : ''}</span><small>{item.authorName} · 提交于 {prettyTime(item.createdAt)} · {item.photoCount} 张照片</small></button>{onChoose&&<button className="text-button" onClick={()=>onChoose(item)}>归入当前施工资料</button>}<button className="text-button" disabled={saving} onClick={() => void save(item, 'word')}><Download size={16} />下载 Word</button></li>)}</ol>}
        {page.total > 20 && <div className="report-history-pagination"><button className="button" disabled={offset === 0} onClick={() => setOffset(n => Math.max(0, n - 20))}>上一页</button><span>第 {Math.floor(offset / 20) + 1} 页</span><button className="button" disabled={offset + 20 >= page.total} onClick={() => setOffset(n => n + 20)}>下一页</button></div>}</>}{opening && <p role="status">正在打开汇报…</p>}</>}
    {detail && <><div className="report-history-summary"><h2>{detail.projectName}</h2><p>{detail.sectionName||'历史合并日报'} · {detail.reportDate} · {detail.region} · {detail.data.weather}{detail.number ? ' · ' + detail.number : ''}</p><p>填报人：{detail.authorName} · 提交时间：{prettyTime(detail.createdAt)}</p><div className="report-history-actions"><button className="button primary" disabled={saving} onClick={() => void save(detail, 'word')}><Download size={16} />下载 Word</button><button className="button" disabled={saving} onClick={() => void save(detail, 'data')}>下载原图与填写数据</button></div></div>
      {detail.data.sections.map((section, index) => <section className="report-history-section" key={index}><h2>{section.name}</h2><dl><dt>设计工程量</dt><dd>{section.designQuantity}{section.kind === 'meter' ? '块' : '米'}</dd><dt>今日 / 累计完成</dt><dd>{section.todayProgress} / {section.cumulativeProgress}{section.kind === 'meter' ? '块' : '%'}</dd><dt>完成工序</dt><dd>{section.works.filter(w => w.quantity !== '').map(w => `${w.name}：${w.quantity}${w.unit}`).join('；') || '未填写'}</dd>{[['施工情况', section.todayNotes], ['施工机械', section.machinery], ['作业人员', section.workers === '' ? '' : section.workers + '人'], ['交通安保人员', section.security], ['明日计划', section.tomorrow], ['手续办理', section.procedures], ['难点及推进', section.difficulties]].map(([label, value]) => <div className="report-history-pair" key={label}><dt>{label}</dt><dd>{value || '未填写'}</dd></div>)}</dl></section>)}
      <section className="report-history-section"><h2>汇总与现场原图</h2><h3>明日施工计划汇总</h3><p className="report-preserve-lines">{detail.data.nextPlan}</p><h3>其他事项</h3><p className="report-preserve-lines">{detail.data.otherItems || '未填写'}</p><div className="report-history-photos">{detail.photos.map(photo => <figure key={photo.index}>{images[photo.index] ? <img src={images[photo.index]} alt={photo.caption || photo.name} onError={() => setImageErrors(current => ({ ...current, [photo.index]: true }))} /> : imageErrors[photo.index] ? <p role="alert">照片 {photo.index + 1} 读取失败，请返回记录后重新打开。</p> : <p role="status">正在读取照片 {photo.index + 1}…</p>}<figcaption>图 {photo.index + 1} · {photo.caption || photo.name}</figcaption></figure>)}</div>{!detail.photos.length && <p>本次汇报未提交照片。</p>}</section></>}
  </section>;
}
