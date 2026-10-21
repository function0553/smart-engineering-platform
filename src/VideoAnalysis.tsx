import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Play, Square, Cpu, Cctv, Plus, AlertTriangle, RefreshCw, ScanFace, ArrowRight } from 'lucide-react';
import { api, type Workspace } from './model';
import { Panel, Modal } from './components';
import PpeLive from './PpeLive';
import './video-analysis.css';

type Source = {
  deviceId: string; revision: string; kind: string; address: string; fps: number; captureFaces: boolean; integrationId: string;
  state: string; error: string; frames: number; alarms: number; people: number; uniqueTracks: number; inferenceMs?: number;
  lastFrameAt: string; modelId: string; previewRevision: string; authorized: boolean; heatmap: number[]; galleryErrors: string[]; warnings: string[];
  rules: { active: number; draft: number; watches: number; fences: number };
  ruleMetrics: { id: string; name: string; people: number; objects: number }[];
  quality?: { brightness: number; contrast: number; sharpness: number };
};
type Models = { modelCount: number; installed: boolean; backend: string; modelId: string; models: { name: string; sha256: string; license: string; installed: boolean }[]; algorithms: { id: string; name: string; status: string; implementation: string; limitation: string }[] };
type Props = { ws: Workspace; navigate: (page: string) => void; create: (type: string, initial?: Record<string, any>) => void; changed: () => Promise<void> };
const states: Record<string, string> = { stopped: '未启动', starting: '加载模型与连接视频', running: '正在分析', ended: '文件分析结束', error: '连接或分析失败', reconnecting: '正在重连' };
const activeStates = ['running', 'starting', 'reconnecting'];

export default function VideoAnalysis(props: Props) {
  const [view, setView] = useState<'ppe' | 'local'>('ppe');
  return <>
    <div className="vision-mode-switch" role="group" aria-label="选择视频工作区">
      <button type="button" className={view === 'ppe' ? 'selected' : ''} aria-pressed={view === 'ppe'} onClick={() => setView('ppe')}>4G安全防护</button>
      <button type="button" className={view === 'local' ? 'selected' : ''} aria-pressed={view === 'local'} onClick={() => setView('local')}>本机视觉分析</button>
    </div>
    {view === 'ppe' ? <><div className="page-heading"><div><h1>4G安全防护</h1><p>观看施工现场连续视频，核对安全帽与反光背心的当前穿戴观测。</p></div></div><PpeLive key={props.ws.user.id} userId={props.ws.user.id} /></> : <LocalVideoAnalysis {...props} />}
  </>;
}

function LocalVideoAnalysis({ ws, navigate, create, changed }: Props) {
  const [sources, setSources] = useState<Source[]>([]);
  const [models, setModels] = useState<Models | null>(null);
  const [error, setError] = useState(''); const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(''); const actionPending = useRef(false);
  const [removing, setRemoving] = useState<{ id: string; revision: string } | null>(null);
  const [showModels, setShowModels] = useState(false);
  const [reload, setReload] = useState(0); const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let disposed = false; let timer: ReturnType<typeof setTimeout>; let controller: AbortController;
    const poll = async () => {
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const [nextSources, nextModels] = await Promise.all([api<Source[]>('/video/sources', 'GET', undefined, controller.signal), api<Models>('/video/models', 'GET', undefined, controller.signal)]);
        if (!disposed) { setSources(nextSources); setModels(nextModels); setLoadError(''); setLoaded(true); }
      } catch (e: any) {
        if (!disposed) setLoadError(e.name === 'AbortError' ? '读取状态超时，请检查平台连接后重试。' : e.status === 401 ? '登录已过期，请刷新页面重新登录。' : '无法更新视频状态，请检查平台是否运行。');
      } finally {
        clearTimeout(timeout); controller.abort();
        if (!disposed) timer = setTimeout(poll, 2500);
      }
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); controller?.abort(); };
  }, [reload]);
  const cameras = ws.records.devices.filter(d => d.data.kind === 'camera');
  const unconfigured = cameras.filter(c => !sources.some(s => s.deviceId === c.id));
  const admin = ws.user.role === 'admin';
  const reloadNow = () => setReload(r => r+1);
  const configure = () => !cameras.length || !unconfigured.length ? create('devices', { kind: 'camera', protocol: 'RTSP' }) : setEditing('');
  const act = async (source: Source, action: 'start' | 'stop' | 'remove') => {
    if (actionPending.current) return;
    actionPending.current = true; setBusy(source.deviceId); setError('');
    try {
      await api(`/video/sources/${source.deviceId}${action === 'remove' ? '' : '/'+action}`, action === 'remove' ? 'DELETE' : 'POST', action === 'remove' ? { expectedRevision: removing?.revision || source.revision } : {});
      setRemoving(null); reloadNow(); await changed();
    } catch (e: any) { setError(e.message); reloadNow(); }
    finally { actionPending.current = false; setBusy(''); }
  };
  return <>
    <div className="page-heading"><div><h1>视频监控与分析</h1><p>连接摄像头，配置检测区域，再查看每次识别的报警证据。</p></div><div className="heading-actions">
      <button className="button secondary" aria-expanded={showModels} onClick={() => setShowModels(!showModels)}><Cpu size={16} />模型与能力</button>
      {admin && <button className="button primary" disabled={!!busy || !loaded || !!loadError} onClick={configure}><Plus size={16} />{unconfigured.length ? '配置视频源' : '添加摄像头'}</button>}
    </div></div>
    <div className="vision-status-strip" aria-label="视频接入概况"><div><Cctv size={18} /><span>已配置视频源</span><strong>{loaded ? sources.length : '—'}<small> 路</small></strong></div><div><Play size={17} /><span>正在分析</span><strong>{loaded ? sources.filter(source => source.state === 'running').length : '—'}<small> 路</small></strong></div><div><Cpu size={18} /><span>模型准备</span><strong className={models?.installed ? 'ready' : ''}>{!models ? '读取中' : models.installed ? `${models.modelCount} 类已就绪` : '环境待准备'}</strong></div></div>
    {loadError && <div className="vision-feedback" role="alert"><span>{loadError}{loaded && ' 下方保留上次统计，画面已暂停显示。'}</span><button className="button secondary small" onClick={reloadNow}><RefreshCw size={15} />重新连接</button></div>}
    {error && <div className="form-error" role="alert">{error}</div>}
    {!loaded && !loadError && <p className="vision-loading" role="status">正在读取摄像头与分析状态…</p>}
    {loaded && admin && sources.length > 0 && unconfigured.length > 0 && <div className="vision-next-step"><div><strong>{!cameras.length ? '先登记一个摄像头' : !sources.length ? '下一步：连接视频源' : `还有 ${unconfigured.length} 台摄像头未配置视频源`}</strong><p>{!cameras.length ? '填写设备名称与编号，随后绑定实时视频或测试文件。' : '视频连接信息只保存在本机；保存后启动分析，再为该摄像头配置规则。'}</p></div><button className="button secondary" disabled={!!loadError || !!busy} onClick={configure}>{!cameras.length ? '登记摄像头' : '配置连接'}<ArrowRight size={15} /></button></div>}
    {showModels && <Panel title="模型与实际能力" meta="模型具备实现不等于现场效果已经验收">
      <div className="vision-capabilities">{models?.algorithms.map(a => <article key={a.id}><div><strong>{a.name}</strong><span className={a.status === 'installed' ? 'vision-ok' : 'vision-pending'}>{a.status === 'installed' ? '可配置本机分析' : a.status === 'missing_models' ? '环境待准备' : '待补充模型'}</span></div><p>{a.implementation || '暂无已验证实现'}</p><small>{a.limitation}</small></article>)}</div>
      <details className="vision-model-details"><summary>模型文件与运行环境</summary><p>{models?.backend}</p><div className="vision-model-files">{models?.models.map(m => <div key={m.name}><strong>{m.name}</strong><span>{m.installed ? '文件校验通过' : '缺失或校验失败'} · {m.license}</span><code>SHA256 {m.sha256}</code></div>)}</div></details>
    </Panel>}
    {loaded && (sources.length ? <div className="vision-grid">{sources.map(source => {
      const camera = cameras.find(c => c.id === source.deviceId);
      const rules = source.rules; const ruleCount = rules.active + rules.watches + rules.fences;
      return <Panel key={source.deviceId} title={camera?.data.name || '摄像头'} meta={loadError ? '状态待更新' : states[source.state] || source.state}>
        <div className="vision-preview">{!loadError && source.frames > 0 && ['running', 'ended'].includes(source.state) ? <img src={`/api/video/sources/${source.deviceId}/frame?run=${source.previewRevision}&frame=${source.frames}`} alt={`${camera?.data.name || '摄像头'}的分析采样画面`} /> : <div><Cctv size={38} /><span>{loadError ? '等待连接恢复' : states[source.state]}</span></div>}<span className="vision-source-label">{source.kind === 'file' ? '文件分析' : '实时视频'} · 每秒最多分析 {source.fps} 帧</span></div>
        <div className="vision-stats"><span>已分析帧<strong>{source.frames}</strong></span><span>当前人数<strong>{source.people}</strong></span><span>短时轨迹<strong>{source.uniqueTracks}</strong></span><span>本次运行报警<strong>{source.alarms}</strong></span></div>
        <div className="vision-info"><p>{source.address} · 最近分析 {source.lastFrameAt ? new Date(source.lastFrameAt).toLocaleString('zh-CN', { hour12: false }) : '尚无画面'} · 单帧 {source.inferenceMs ?? '—'} ms</p>
          {!source.authorized ? <p className="form-error">分析服务授权已撤销，请重新配置连接信息。</p> : ruleCount === 0 ? <p className="vision-rule-note">{rules.draft ? `有 ${rules.draft} 条规则尚未启用。` : '尚未启用分析或布控规则。'}当前可查看人数与轨迹，配置规则后才会按条件报警。</p> : <p>已启用 {rules.active} 条分析规则 · {rules.watches} 条人像布控 · {rules.fences} 条围栏/围挡布控</p>}
          {source.error && <p className="form-error">{source.error}</p>}{source.warnings?.map((warning, i) => <p className="form-error" key={i}>{warning}</p>)}
          {source.galleryErrors.length > 0 && <p className="form-error">{source.galleryErrors.length} 张名单图片无法提取单个人脸，请更换清晰的单人照片。</p>}
          <details><summary>画面诊断、热区与布控绑定</summary>{source.quality && <p>锐度 {source.quality.sharpness.toFixed(1)} · 亮度 {source.quality.brightness.toFixed(1)} · 对比度 {source.quality.contrast.toFixed(1)}</p>}<div className="vision-heatmap" aria-label="8 乘 8 人员位置热区">{source.heatmap.map((n, i) => <span key={i} title={`位置 ${i+1}：${n} 次检测`} style={{ background: `rgba(37, 99, 235, ${0.08+0.9*n/Math.max(1,...source.heatmap)})` }} />)}</div><p>热区为本次运行的检测频次；遮挡、断流后轨迹可能重新计数。</p>{source.ruleMetrics?.map(r => <p key={r.id}>{r.name}：区域人数 {r.people}，目标数 {r.objects}</p>)}<p>人像布控选择“本机视觉”服务，模型版本：</p><code className="vision-model-id">{source.modelId}</code></details>
        </div>
        <div className="vision-actions">{admin && <>
          <button className="button primary" disabled={!!busy || !!loadError || !source.authorized || !models?.installed} onClick={() => void act(source, 'start')}><Play size={15} />{busy === source.deviceId ? '处理中…' : activeStates.includes(source.state) ? '重新连接' : '启动分析'}</button>
          <button className="button secondary" disabled={!!busy || !!loadError || !activeStates.includes(source.state)} onClick={() => void act(source, 'stop')}><Square size={15} />停止</button>
          <button className="button secondary" disabled={!!busy || !!loadError} onClick={() => create('rules', { deviceId: source.deviceId, zone: '全画面' })}><ScanFace size={15} />配置分析规则</button>
        </>}<button className="text-button" onClick={() => navigate(`rules?device=${encodeURIComponent(source.deviceId)}`)}>管理规则{rules.draft ? `（${rules.draft} 条待启用）` : ''}</button><button className="text-button" onClick={() => navigate(`alerts?device=${encodeURIComponent(source.deviceId)}`)}>查看此路告警</button></div>
        {admin && <div className="vision-source-settings"><button className="text-button" disabled={!!busy || !!loadError} onClick={() => setEditing(source.deviceId)}>调整视频设置</button><button className="text-button danger-text" disabled={!!busy || !!loadError} onClick={() => setRemoving({ id: source.deviceId, revision: source.revision })}>移除视频源</button></div>}
        {removing?.id === source.deviceId && <div className="vision-remove-confirm" role="group" aria-label="确认移除视频源"><p>移除“{camera?.data.name || '此摄像头'}”的视频连接并停止分析。设备、规则和历史证据会保留；再次使用时需重新填写连接信息。</p><div><button className="button secondary small" disabled={!!busy} onClick={() => setRemoving(null)}>保留连接</button><button className="button danger-ghost small" disabled={!!busy || !!loadError} onClick={() => void act(source, 'remove')}>确认移除</button></div></div>}
      </Panel>;
    })}</div> : <section className="vision-empty-workspace" aria-label="视频源接入"><div className="vision-empty-stage"><div className="vision-stage-top"><span><i />等待视频源接入</span><span>视频预览</span></div><div className="vision-empty-message"><Cctv size={50} strokeWidth={1.1} /><h2>现场画面，从这里接入</h2><p>连接摄像头后查看分析采样画面、<br />目标识别和告警记录。</p></div><div className="vision-stage-foot"><span>RTSP 摄像头 / 本机视频文件</span><span>尚无画面</span></div></div><div className="vision-connect-guide"><h2>接入第一个视频源</h2><p>三个步骤，开始查看现场</p><ol><li><span>01</span><div><strong>登记摄像头</strong><p>填写设备名称、编号和所属空间。</p></div></li><li><span>02</span><div><strong>配置视频连接</strong><p>绑定实时视频地址或本机文件。</p></div></li><li><span>03</span><div><strong>启动分析与规则</strong><p>确认画面，再设置检测区域与报警条件。</p></div></li></ol>{admin ? <button className="button primary full" disabled={!!loadError || !!busy} onClick={configure}>{cameras.length ? '配置视频源' : '添加摄像头'}<ArrowRight size={16} /></button> : <p className="vision-access-note">请管理员配置视频源后开始使用。</p>}<small>每次符合规则的新识别，单独生成告警。</small></div></section>)}
    <div className="notice-line"><AlertTriangle size={16} />每次符合规则的识别单独报警。抽烟专项输出香烟候选，需复核；睡岗、玩手机、翻越和围挡破损等模型仍待补充。</div>
    {editing !== null && <SourceForm ws={ws} deviceId={editing} existing={sources.find(s => s.deviceId === editing)} configuredIds={sources.map(s => s.deviceId)} onClose={() => setEditing(null)} saved={async () => { setEditing(null); reloadNow(); await changed(); }} />}
  </>;
}

function SourceForm({ ws, deviceId, existing, configuredIds, onClose, saved }: { ws: Workspace; deviceId: string; existing?: Source; configuredIds: string[]; onClose: () => void; saved: () => Promise<void> }) {
  // Freeze the opened revision: polling must not turn a stale edit into a valid overwrite.
  const [initial] = useState(existing);
  const [id, setId] = useState(deviceId); const [kind, setKind] = useState(initial?.kind || 'rtsp');
  const [replace, setReplace] = useState(!initial || !initial.authorized);
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const pending = useRef(false);
  const close = () => { if (!pending.current) onClose(); };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); const fd = new FormData(event.currentTarget);
    const settings = { fps: Number(fd.get('fps')), captureFaces: fd.get('captureFaces') === 'on', ...(initial ? { expectedRevision: initial.revision } : {}) };
    try {
      await api(`/video/sources/${id}`, replace ? 'PUT' : 'PATCH', replace ? { ...settings, kind, uri: String(fd.get('uri') || '').trim(), username: String(fd.get('username') || ''), password: String(fd.get('password') || '') } : settings);
      await saved();
    } catch (e: any) { setError(e.message); } finally { pending.current = false; setBusy(false); }
  };
  return <Modal title={initial ? '调整视频设置' : '配置视频分析源'} subtitle={replace ? '保存连接后，再点击启动分析。' : '保留原地址与凭据，运行中的分析将在后续帧应用新设置。'} onClose={close}>
    <form onSubmit={submit}><fieldset className="vision-form-fields" disabled={busy}><div className="form-grid">
      <label>摄像头<select required value={id} disabled={!!deviceId} onChange={e => setId(e.target.value)}><option value="">请选择</option>{ws.records.devices.filter(d => d.data.kind === 'camera' && (d.id === deviceId || !configuredIds.includes(d.id))).map(d => <option key={d.id} value={d.id}>{d.data.name}</option>)}</select></label>
      {initial && <label className="vision-checkbox"><input type="checkbox" checked={replace} disabled={!initial.authorized} onChange={e => setReplace(e.target.checked)} />更换连接信息</label>}
      {!replace && initial && <p className="span-two field-note">当前连接：{initial.kind === 'rtsp' ? `实时视频 · ${initial.address}` : '本机视频文件'}。地址和账号密码继续使用已保存的配置。</p>}
      {replace && <>
        <label>视频来源<select value={kind} onChange={e => setKind(e.target.value)}><option value="rtsp">RTSP 实时摄像头</option><option value="file">本机视频文件</option></select></label>
        <label className="span-two">{kind === 'rtsp' ? 'RTSP 地址（不含账号密码）' : '视频文件绝对路径'}<input required name="uri" maxLength={1600} placeholder={kind === 'rtsp' ? 'rtsp://摄像头地址:554/Streaming/Channels/102' : 'D:\\现场视频\\测试.mp4'} autoComplete="off" /></label>
        {kind === 'rtsp' && <><label>设备账号<input name="username" maxLength={200} autoComplete="off" /></label><label>设备密码<input name="password" type="password" maxLength={300} autoComplete="new-password" /></label></>}
        {initial && <p className="span-two field-note">更换连接会停止当前分析。请填写新连接的完整账号与密码，保存后重新启动。</p>}
      </>}
      <label>每秒分析次数<input name="fps" type="number" min="1" max="5" required defaultValue={initial?.fps || 2} /><small>1–5 次，实际速度取决于画面与本机算力。</small></label>
      <label className="vision-checkbox"><input type="checkbox" name="captureFaces" defaultChecked={initial?.captureFaces} />启用人像抓拍归档</label>
    </div></fieldset>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-footer"><button type="button" className="button secondary" disabled={busy} onClick={close}>取消</button><button className="button primary" disabled={busy || !id}>{busy ? '保存中…' : replace ? '保存连接' : '保存分析设置'}</button></div></form>
  </Modal>;
}
