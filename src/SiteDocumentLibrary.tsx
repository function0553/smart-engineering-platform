import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Archive, Building2, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, ClipboardList, Download, FileArchive, FileImage, FileText, Film, FolderOpen, Images, Layers, RefreshCw, Search, SlidersHorizontal, X } from 'lucide-react';
import { api } from './model';
import { emptyLibraryFilters, libraryBytes, libraryFilterKey, libraryFilterProblem, libraryGroupFilters, libraryGroupKey, libraryPackagePath, libraryPageLabel, libraryQuery, packageFilters, type LibraryFilters } from './site-document-library-model';
import './site-document-library.css';

type Category = 'site_measurement' | 'work_photos' | 'work_videos' | 'material_measurement' | 'hidden_work' | 'construction_daily' | 'supervision_daily';
const categories: { key: Category; title: string; label: string; icon: typeof FileText }[] = [
  { key: 'site_measurement', title: '现场收方单', label: '收方单', icon: FileImage },
  { key: 'work_photos', title: '施工步骤照片', label: '工序照片', icon: Images },
  { key: 'work_videos', title: '施工步骤视频', label: '工序视频', icon: Film },
  { key: 'material_measurement', title: '材料收方单', label: '材料收方', icon: FileImage },
  { key: 'hidden_work', title: '隐蔽工程图片', label: '隐蔽工程', icon: Layers },
  { key: 'construction_daily', title: '施工日报', label: '施工日报', icon: ClipboardList },
  { key: 'supervision_daily', title: '监理日报', label: '监理日报', icon: FileText },
];
const recordStates: Record<string, string> = { draft: '草稿', submitted: '待审核', returned: '退回补充', approved: '待归档', archived: '已归档', withdrawn: '已撤回' };
export type SiteLibraryGroup = { projectId: string; projectName: string; wbsId: string; wbsTitle: string; recordDate: string; recordCount: number; fileCount: number; byteCount: number; originalFileCount?: number; wordCount?: number; categories: Partial<Record<Category, number>>; states: Record<string, number>; reviewStates?: Record<string, number>; missingCategories?: string[] };
type LibraryList = { groups: SiteLibraryGroup[]; total: number; limit: number; offset: number; projects: { id: string; name: string }[]; wbs: { id: string; title: string; projectId: string }[] };
type LibraryRecord = { id: string; state: string; version: number; data: { category: Category; title: string; recordDate: string }; review?: { state: string } | null; creator_name?: string; activeFiles?: number; fileCount?: number };
type LibraryRecords = { records: LibraryRecord[]; total: number; limit: number; offset: number };
type PackageReceipt = { name: string; mime: string; byteCount: number; sha256: string; url: string; expiresAt: number; fileCount: number; recordCount: number };
type PackageOperation = { key: string; label: string; base: string; requestId: string; filters: LibraryFilters; generation: number };
type PackageState = { label: string; phase: 'building' | 'saving' | 'ready' | 'error'; error?: string; receipt?: PackageReceipt; key: string; browserDownload?:boolean };
export type SiteDocumentLibraryProps = { projectId?: string; admin?: boolean; onOpenRecord?: (projectId: string, recordId: string) => void; saveSiteFile?: (url: string, name: string, mime: string, bytes: number, sha256: string, signal?: AbortSignal) => Promise<any> };
const pageSize = 20;
const errorText = (error: unknown) => error instanceof Error ? error.message : '资料读取失败，请重试。';
const recordState = (row: LibraryRecord) => row.state === 'draft' ? recordStates[row.review?.state || 'draft'] || '草稿' : recordStates[row.state] || row.state;

export default function SiteDocumentLibrary({ projectId, admin = false, onOpenRecord, saveSiteFile }: SiteDocumentLibraryProps) {
  const global = admin && !projectId;
  const base = global ? '/engineering/site-library' : projectId ? `/engineering/projects/${projectId}/site-library` : '';
  const scope = base;
  const [filters, setFilters] = useState<LibraryFilters>(emptyLibraryFilters), [applied, setApplied] = useState<LibraryFilters>(emptyLibraryFilters);
  const [offset, setOffset] = useState(0), [revision, setRevision] = useState(0);
  const [listing, setListing] = useState<LibraryList | null>(null), [loading, setLoading] = useState(false), [loadError, setLoadError] = useState(''), [filterError, setFilterError] = useState('');
  const [expanded, setExpanded] = useState<SiteLibraryGroup | null>(null), [detailOffset, setDetailOffset] = useState(0), [records, setRecords] = useState<LibraryRecords | null>(null), [detailLoading, setDetailLoading] = useState(false), [detailError, setDetailError] = useState('');
  const [packageState, setPackageState] = useState<PackageState | null>(null);
  const [moreFilters, setMoreFilters] = useState(false);
  const listGeneration = useRef(0), detailGeneration = useRef(0), scopeGeneration = useRef(0), packageOperation = useRef<PackageOperation | null>(null), saveAbort = useRef<AbortController | null>(null), packageRequest = useRef<AbortController | null>(null), packageBusy = useRef(false);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const currentFilterKey = libraryFilterKey(base, applied), filterKeyRef = useRef(currentFilterKey); filterKeyRef.current = currentFilterKey;
  const filterId = useId(), detailId = useId();

  useEffect(() => {
    scopeGeneration.current++; packageOperation.current = null; packageBusy.current = false; saveAbort.current?.abort(); saveAbort.current = null; packageRequest.current?.abort(); packageRequest.current = null;
    setFilters(emptyLibraryFilters()); setApplied(emptyLibraryFilters()); setOffset(0); setListing(null); setLoadError(''); setFilterError(''); setExpanded(null); setRecords(null); setPackageState(null);
    return () => { scopeGeneration.current++; listGeneration.current++; detailGeneration.current++; saveAbort.current?.abort(); packageRequest.current?.abort(); };
  }, [scope]);

  useEffect(() => {
    const generation = ++listGeneration.current, controller = new AbortController();
    if (!base) { setLoading(false); return; }
    setLoading(true); setLoadError('');
    void api<LibraryList>(base + '?' + libraryQuery(applied, pageSize, offset), 'GET', undefined, controller.signal).then(value => {
      if (generation !== listGeneration.current) return;
      if (!Array.isArray(value.groups) || !Number.isInteger(value.total) || value.total < 0) throw Error('资料册返回内容异常，请重新读取。');
      if (offset >= value.total && offset && value.total) { setOffset(Math.floor((value.total - 1) / pageSize) * pageSize); return; }
      setListing(value);
    }).catch(error => { if (generation === listGeneration.current && !controller.signal.aborted) { setLoadError(errorText(error)); setListing(null); } }).finally(() => { if (generation === listGeneration.current) setLoading(false); });
    return () => controller.abort();
  }, [base, applied, offset, revision]);

  useEffect(() => {
    setExpanded(null); setRecords(null); setDetailOffset(0); setDetailError('');
    packageOperation.current = null; packageBusy.current = false; saveAbort.current?.abort(); saveAbort.current = null; packageRequest.current?.abort(); packageRequest.current = null; setPackageState(null);
  }, [currentFilterKey]);

  useEffect(() => {
    const generation = ++detailGeneration.current, controller = new AbortController();
    setRecords(null); setDetailError('');
    if (!expanded) { setDetailLoading(false); return; }
    setDetailLoading(true);
    const detailFilters = libraryGroupFilters(applied, expanded);
    const query = libraryQuery(detailFilters, pageSize, detailOffset); query.delete('projectId');
    void api<LibraryRecords>(`/engineering/projects/${expanded.projectId}/site-records?${query}`, 'GET', undefined, controller.signal).then(value => {
      if (generation !== detailGeneration.current) return;
      if (!Array.isArray(value.records) || !Number.isInteger(value.total)) throw Error('资料明细返回内容异常，请重试。');
      if (detailOffset >= value.total && detailOffset && value.total) { setDetailOffset(Math.floor((value.total - 1) / pageSize) * pageSize); return; }
      setRecords(value);
    }).catch(error => { if (generation === detailGeneration.current && !controller.signal.aborted) setDetailError(errorText(error)); }).finally(() => { if (generation === detailGeneration.current) setDetailLoading(false); });
    return () => controller.abort();
  }, [expanded, detailOffset, applied, revision]);

  function applyFilters(event: FormEvent) {
    event.preventDefault(); const problem = libraryFilterProblem(filters); setFilterError(problem); if (problem) return;
    setApplied({ ...filters, projectId: global ? filters.projectId : '', q: filters.q.trim() }); setOffset(0);
  }
  function clearFilters() { setFilters(emptyLibraryFilters()); setApplied(emptyLibraryFilters()); setOffset(0); setFilterError(''); }
  function toggleGroup(group: SiteLibraryGroup) { setExpanded(value => value && libraryGroupKey(value) === libraryGroupKey(group) ? null : group); setDetailOffset(0); }
  function alive(operation: PackageOperation) { return operation.generation === scopeGeneration.current && scopeRef.current === operation.base && filterKeyRef.current === operation.key; }
  async function savePackage(receipt: PackageReceipt, operation: PackageOperation) {
    if (!alive(operation)) return;
    const path = libraryPackagePath(receipt.url);
    if (receipt.mime !== 'application/zip' || !Number.isSafeInteger(receipt.byteCount) || receipt.byteCount <= 0 || !/^[a-f0-9]{64}$/.test(receipt.sha256) || !receipt.name || /[/\\\x00-\x1f]/.test(receipt.name)) throw Error('资料包信息异常，请重新打包。');
    if (!Number.isFinite(receipt.expiresAt) || receipt.expiresAt <= 0) { packageOperation.current = null; throw Error('资料包下载已过期，请重新打包。'); }
    setPackageState({ label: operation.label, key: operation.key, phase: 'saving', receipt });
    let browserDownload=!saveSiteFile;
    if (saveSiteFile) {
      const controller = new AbortController(); saveAbort.current = controller;
      const result=await saveSiteFile(path, receipt.name, receipt.mime, receipt.byteCount, receipt.sha256, controller.signal);browserDownload=result?.downloadStarted===true;
      if (saveAbort.current === controller) saveAbort.current = null;
    } else {
      const link = document.createElement('a'); link.href = path; link.download = receipt.name; link.rel = 'noopener'; document.body.appendChild(link); link.click(); link.remove();
    }
    if (alive(operation)) {
      setPackageState({ label: operation.label, key: operation.key, phase: 'ready', receipt, browserDownload });
      // A later click requests a fresh snapshot; only an unconfirmed attempt reuses its ID.
      packageOperation.current = null;
    }
  }
  async function requestPackage(operation: PackageOperation): Promise<PackageReceipt> {
    const controller = new AbortController(); packageRequest.current = controller;
    // Native transport can finish late after cancelling its caller. This race settles the
    // UI immediately while still observing the original request promise and keeping its ID.
    try {
      return await new Promise<PackageReceipt>((resolve, reject) => {
        let settled = false;
        const complete = (value: PackageReceipt | null, error?: unknown) => {
          if (settled) return; settled = true; clearTimeout(timer); controller.signal.removeEventListener('abort', cancelled);
          if (error) reject(error); else resolve(value!);
        };
        const cancelled = () => complete(null, new Error('已停止等待。服务端可能仍在整理，可用“重试打包”核对同一次结果。'));
        const timer = setTimeout(() => { complete(null, new Error('整理时间较长，结果尚未确认。请重试打包核对同一次结果。')); controller.abort(); }, 125000);
        controller.signal.addEventListener('abort', cancelled, { once: true });
        void api<PackageReceipt>(operation.base + '/packages', 'POST', { requestId: operation.requestId, ...packageFilters(operation.filters) }, controller.signal).then(value => complete(value), error => complete(null, error));
      });
    } finally { if (packageRequest.current === controller) packageRequest.current = null; }
  }
  function invalidateAttempt(error: unknown) {
    const status = (error as Error & { status?: number }).status;
    if ([401, 403, 413].includes(status || 0) || status === 409 && /已变化|其他筛选条件/.test(errorText(error))) packageOperation.current = null;
    if (status === 409 && /已变化/.test(errorText(error))) setRevision(value => value + 1);
  }
  async function buildPackage(group?: SiteLibraryGroup) {
    if (!base || packageBusy.current || loading || !listing?.total) return;
    const selected = group ? libraryGroupFilters(applied, group) : applied;
    const packageKey = libraryFilterKey(base, selected), label = group ? `${group.wbsTitle} · ${group.recordDate}` : '当前筛选资料';
    const previous = packageOperation.current;
    const operation: PackageOperation = previous && previous.requestId && previous.key === currentFilterKey && libraryFilterKey(base, previous.filters) === packageKey ? previous : { key: currentFilterKey, label, base, requestId: crypto.randomUUID(), filters: { ...selected }, generation: scopeGeneration.current };
    packageOperation.current = operation; packageBusy.current = true;
    setPackageState({ label: operation.label, phase: 'building', key: currentFilterKey });
    try {
      const receipt = await requestPackage(operation);
      if (alive(operation)) await savePackage(receipt, operation);
    } catch (error) {
      if (alive(operation)) {
        invalidateAttempt(error);
        setPackageState({ label: operation.label, phase: 'error', key: currentFilterKey, error: errorText(error) });
      }
    } finally { if (alive(operation)) packageBusy.current = false; }
  }
  async function retryPackage() {
    const operation = packageOperation.current; if (!operation || !alive(operation) || packageBusy.current) return;
    // Preserve the identical request ID and filter body after timeout or a lost reply.
    packageBusy.current = true; setPackageState({ label: operation.label, key: operation.key, phase: 'building' });
    try { const receipt = await requestPackage(operation); if (alive(operation)) await savePackage(receipt, operation); }
    catch (error) { if (alive(operation)) { invalidateAttempt(error); setPackageState({ label: operation.label, key: operation.key, phase: 'error', error: errorText(error) }); } }
    finally { if (alive(operation)) packageBusy.current = false; }
  }

  if (!base) return <section className="site-library"><div className="site-library-empty"><FolderOpen size={30} aria-hidden="true"/><h3>请先选择项目</h3><p>进入项目后，即可按施工部位和资料日期查看资料册。</p></div></section>;
  const filteredWbs = listing?.wbs?.filter(row => !global || !filters.projectId || row.projectId === filters.projectId) || [];
  const busy = packageState?.phase === 'building' || packageState?.phase === 'saving';
  const filtersDirty = libraryFilterKey(base, filters) !== currentFilterKey;
  return <section className="site-library" aria-label={global ? '全部项目施工资料册' : '项目施工资料册'}>
    <header className="site-library-heading"><div><h3><FolderOpen size={22} aria-hidden="true"/>{global ? '全部施工资料' : '资料册'}</h3><p>项目 / 施工部位 / 资料日期</p></div><div className="site-library-heading-actions"><button type="button" className="button" disabled={loading || busy} onClick={() => setRevision(value => value + 1)} aria-label="刷新资料册"><RefreshCw size={17} aria-hidden="true"/></button><button type="button" className="button primary" disabled={loading || busy || filtersDirty || !listing?.total} onClick={() => void buildPackage()}><FileArchive size={18} aria-hidden="true"/>一键打包</button></div></header>
    <form className="site-library-filters" onSubmit={applyFilters}>
      <div className="site-library-main-filters">
        {global && <label>项目<select aria-label="筛选项目" value={filters.projectId} disabled={busy} onChange={event => setFilters({ ...filters, projectId: event.target.value, wbsId: '' })}><option value="">全部项目</option>{listing?.projects?.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
        <label>施工部位<select aria-label="筛选施工部位" value={filters.wbsId} disabled={busy} onChange={event => setFilters({ ...filters, wbsId: event.target.value })}><option value="">全部部位</option>{filteredWbs.map(row => <option key={row.projectId + row.id} value={row.id}>{global && !filters.projectId ? (listing?.projects?.find(project => project.id === row.projectId)?.name || '') + ' / ' : ''}{row.title}</option>)}</select></label>
        <button type="button" className="button site-library-filter-toggle" aria-expanded={moreFilters} aria-controls={filterId} disabled={busy} onClick={() => setMoreFilters(value => !value)}><SlidersHorizontal size={17} aria-hidden="true"/>筛选</button>
        <button type="submit" className="button" disabled={loading || busy}><Search size={17} aria-hidden="true"/>查询</button>
      </div>
      <div id={filterId} className="site-library-extra-filters" hidden={!moreFilters}>
        <label>开始日期<input type="date" value={filters.from} disabled={busy} onChange={event => setFilters({ ...filters, from: event.target.value })}/></label><label>结束日期<input type="date" value={filters.to} disabled={busy} onChange={event => setFilters({ ...filters, to: event.target.value })}/></label>
        <label>资料状态<select value={filters.state} disabled={busy} onChange={event => setFilters({ ...filters, state: event.target.value })}><option value="">全部状态</option><option value="draft">未归档</option><option value="archived">已归档</option><option value="withdrawn">已撤回</option></select></label>
        <label>资料标题<input type="search" value={filters.q} maxLength={160} placeholder="搜索资料标题" disabled={busy} onChange={event => setFilters({ ...filters, q: event.target.value })}/></label>
        <button type="button" className="text-button" disabled={loading || busy} onClick={clearFilters}>清空筛选</button>
      </div>
      {filtersDirty && <p className="site-library-filter-pending" role="status">筛选已修改，请点击查询后打包。</p>}{filterError && <p className="site-library-error" role="alert">{filterError}</p>}
    </form>
    {packageState && <div className={'site-library-package site-library-package-' + packageState.phase} role={packageState.phase === 'error' ? 'alert' : 'status'}><div><strong>{packageState.phase === 'building' ? '正在整理资料包' : packageState.phase === 'saving' ? '正在保存资料包' : packageState.phase === 'error' ? '打包未完成' : saveSiteFile&&!packageState.browserDownload ? '资料包已保存' : '已发起资料包下载'}</strong><p>{packageState.label}{packageState.receipt ? ` · ${packageState.receipt.recordCount} 份资料 · ${libraryBytes(packageState.receipt.byteCount)}` : ''}</p>{packageState.error && <p>{packageState.error}</p>}{packageState.phase === 'building' && <p>正在整理已保存的原件、已有Word及清单；工序照片Word会自动生成入包。</p>}{packageState.phase === 'ready' && <p>{saveSiteFile&&!packageState.browserDownload ? '可在你选择的位置查看ZIP文件。' : '请查看浏览器下载记录。'}</p>}</div><div className="site-library-package-actions">{packageState.phase === 'building' && <button type="button" className="button" onClick={() => packageRequest.current?.abort()}><X size={16} aria-hidden="true"/>停止等待</button>}{packageState.phase === 'error' && packageOperation.current && <button type="button" className="button" onClick={() => void retryPackage()}><RefreshCw size={16} aria-hidden="true"/>重试打包</button>}{packageState.phase === 'saving' && saveSiteFile && <button type="button" className="button" onClick={() => saveAbort.current?.abort()}><X size={16} aria-hidden="true"/>取消保存</button>}{packageState.phase === 'ready' && <button type="button" className="text-button" onClick={() => setPackageState(null)} aria-label="收起资料包结果"><X size={18} aria-hidden="true"/></button>}</div></div>}
    <div className="site-library-caption"><span>{listing ? `共 ${listing.total} 组资料` : '按日期自动整理'}</span><span>工序照片Word自动入包，七类资料按需整理</span></div>
    {loading ? <div className="site-library-loading" role="status" aria-label="正在读取资料册">{[0, 1, 2].map(value => <div key={value}><i/><i/><i/></div>)}<span>正在读取资料册…</span></div> : loadError ? <div className="site-library-empty"><FolderOpen size={30} aria-hidden="true"/><h4>暂时无法读取资料</h4><p className="site-library-error" role="alert">{loadError}</p><button type="button" className="button" onClick={() => setRevision(value => value + 1)}><RefreshCw size={17} aria-hidden="true"/>重新读取</button></div> : !listing?.groups.length ? <div className="site-library-empty"><FolderOpen size={30} aria-hidden="true"/><h4>暂无符合条件的资料</h4><p>已保存到服务器的资料会自动按施工部位、资料日期出现在这里。本机待上传文件尚未入册。</p><button type="button" className="text-button" onClick={clearFilters}>清空筛选</button></div> : <div className="site-library-groups">{listing.groups.map(group => {
      const groupKey = libraryGroupKey(group), open = !!expanded && libraryGroupKey(expanded) === groupKey, provided = categories.filter(category => (group.categories[category.key] || 0) > 0).length;
      return <article className="site-library-group" key={groupKey}>
        <div className="site-library-group-title"><div className="site-library-group-context">{global && <p><Building2 size={15} aria-hidden="true"/>{group.projectName}</p>}<h4>{group.wbsTitle || '未关联施工部位'}</h4><p><CalendarDays size={15} aria-hidden="true"/>{group.recordDate}<span>{group.recordCount} 份资料 · {group.fileCount} 个文件 · {libraryBytes(group.byteCount)}</span></p></div><button type="button" className="button" disabled={busy || filtersDirty} onClick={() => void buildPackage(group)} aria-label={`下载${group.wbsTitle}${group.recordDate}资料`}><Download size={17} aria-hidden="true"/><span>下载本日资料</span></button></div>
        <ul className="site-library-categories" aria-label="七类资料数量">{categories.map(category => <li key={category.key} className={group.categories[category.key] ? 'is-provided' : ''} title={category.title + '：' + (group.categories[category.key] || 0) + '份资料'}><category.icon size={19} aria-hidden="true"/><span>{category.label}</span><strong>{group.categories[category.key] || 0}</strong></li>)}</ul>
        <footer className="site-library-group-footer"><span>已整理 {provided} / 7 类{group.wordCount ? ` · ${group.wordCount} 份已有Word` : ''}{group.states.archived ? ` · ${group.states.archived} 份已归档` : ''}</span><button type="button" className="text-button" aria-expanded={open} aria-controls={open ? detailId : undefined} onClick={() => toggleGroup(group)}><span>{open ? '收起资料' : '查看资料'}</span><ChevronDown size={17} aria-hidden="true" className={open ? 'is-open' : ''}/></button></footer>
        {open && <div id={detailId} className="site-library-records">{detailLoading ? <p role="status">正在读取资料明细…</p> : detailError ? <div><p className="site-library-error" role="alert">{detailError}</p><button type="button" className="button" onClick={() => setRevision(value => value + 1)}>重试读取</button></div> : <><ul>{records?.records.map(row => <li key={row.id}><FileText size={20} aria-hidden="true"/><div><strong>{row.data.title || categories.find(category => category.key === row.data.category)?.title || '施工资料'}</strong><p>{categories.find(category => category.key === row.data.category)?.label} · {row.creator_name || '经办人'}</p></div><span className={'site-library-state site-library-state-' + row.state}>{recordState(row)}</span>{onOpenRecord && <button type="button" className="text-button" disabled={busy} onClick={() => onOpenRecord(group.projectId, row.id)} aria-label={'打开资料 ' + row.data.title}><ChevronRight size={20} aria-hidden="true"/></button>}</li>)}</ul>{records && <nav className="site-library-pagination" aria-label="本日资料翻页"><span>{libraryPageLabel(detailOffset, records.records.length, records.total)}</span><button type="button" className="button" disabled={!detailOffset} onClick={() => setDetailOffset(value => Math.max(0, value - pageSize))} aria-label="上一页本日资料"><ChevronLeft size={18} aria-hidden="true"/></button><button type="button" className="button" disabled={detailOffset + records.records.length >= records.total} onClick={() => setDetailOffset(value => value + pageSize)} aria-label="下一页本日资料"><ChevronRight size={18} aria-hidden="true"/></button></nav>}</>}</div>}
      </article>;
    })}</div>}
    {!!listing?.total && !loading && <nav className="site-library-pagination" aria-label="资料册翻页"><span>{libraryPageLabel(offset, listing.groups.length, listing.total)}</span><button type="button" className="button" disabled={!offset || busy} onClick={() => { setOffset(value => Math.max(0, value - pageSize)); setExpanded(null); }} aria-label="上一页资料册"><ChevronLeft size={18} aria-hidden="true"/></button><button type="button" className="button" disabled={offset + listing.groups.length >= listing.total || busy} onClick={() => { setOffset(value => value + pageSize); setExpanded(null); }} aria-label="下一页资料册"><ChevronRight size={18} aria-hidden="true"/></button></nav>}
    <p className="site-library-note"><Archive size={15} aria-hidden="true"/>工序照片Word自动入包，无需单独生成；按服务器当前已保存的工序代表照片填表，未上传照片不入表。资料包同时保留有效原件、视频、已有Word及清单，不改变审核或归档状态。</p>
  </section>;
}
