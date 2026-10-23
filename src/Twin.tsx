import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import MiniScene from './MiniScene';
import { Box, Layers, Upload, Maximize, Minimize, ArrowLeft, Crosshair, MapPin, Cctv, Building2, Bell, CalendarDays, Users, Wrench, Check, X, RotateCcw, ChevronRight, Activity, Cable, Zap, CircleHelp, LocateFixed } from 'lucide-react';
import { api, localDate, prettyTime, type Row, type Workspace } from './model';
import { Badge, Modal, cellValue } from './components';
import './twin.css';

type Model = { id: string; name: string; size: number; sha256: string };
type Anchor = { id: string; model_id: string; target_id: string; position: [number, number, number]; version: number };
type SceneMarker = Anchor & { target: Row; alerts: number };

export default function TwinScreen({ ws, exit, select, connectionError, lastSynced, immersive = false, setImmersive }: { ws: Workspace; exit: () => void; select: (row: Row) => void; connectionError: string; lastSynced: number; immersive?: boolean; setImmersive?: (value: boolean) => void }) {
  const root = useRef<HTMLDivElement>(null);
  const [models, setModels] = useState<Model[]>([]); const [modelId, setModelId] = useState(''); const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [selectedId, setSelectedId] = useState(''); const [bindingId, setBindingId] = useState(''); const [position, setPosition] = useState<[number, number, number] | null>(null);
  const [uploading, setUploading] = useState(false); const [uploadOpen, setUploadOpen] = useState(false); const [error, setError] = useState(''); const [assetSearch, setAssetSearch] = useState('');
  const [clock, setClock] = useState(new Date()); const full = immersive; const [saving, setSaving] = useState(false); const [unlink, setUnlink] = useState(false);
  const admin = ws.user.role === 'admin';
  const assets = [...ws.records.spaces, ...ws.records.devices, ...(ws.records.fences || [])]; const selected = assets.find(r => r.id === selectedId);
  const pending = ws.records.alerts.filter(r => ['new', 'processing'].includes(r.state)); const selectedAnchor = anchors.find(a => a.target_id === selectedId);
  const linkedAlerts = pending.filter(r => r.data.deviceId === selectedId || r.data.spaceId === selectedId || r.data.ruleId === selectedId);
  const linkedMeetings = ws.records.bookings.filter(r => r.data.spaceId === selectedId && r.state === 'reserved');
  const filteredAssets = assets.filter(r => `${r.data.name}${r.data.code}`.toLowerCase().includes(assetSearch.toLowerCase()));
  const markers: SceneMarker[] = anchors.flatMap(a => { const target = assets.find(r => r.id === a.target_id); return target ? [{ ...a, target, alerts: pending.filter(r => r.data.deviceId === target.id || r.data.spaceId === target.id || r.data.ruleId === target.id).length }] : []; });
  const today = localDate(); const visits = ws.records.visits.filter(r => r.state === 'checked_in');
  const meetings = ws.records.bookings.filter(r => r.state === 'reserved' && localDate(Date.parse(r.data.startAt)) === today).sort((a, b) => a.data.startAt.localeCompare(b.data.startAt));
  const jobs = ws.records.workorders.filter(r => ['open', 'in_progress'].includes(r.state)); const online = ws.records.devices.filter(r => r.state === 'online').length;
  const currentModel = models.find(m => m.id === modelId);
  const getModels = useCallback(async () => { const rows = await api<Model[]>('/models'); setModels(rows); setModelId(current => rows.some(r => r.id === current) ? current : rows[0]?.id || ''); }, []);
  const getAnchors = useCallback(async () => { if (!modelId) { setAnchors([]); return; } const rows = await api<Anchor[]>(`/models/${modelId}/anchors`); setAnchors(rows); }, [modelId]);
  useEffect(() => { void getModels().catch(e => setError(e.message)); }, [getModels]);
  useEffect(() => { let cancelled = false; setAnchors([]); setBindingId(''); setPosition(null); setUnlink(false); if (modelId) api<Anchor[]>(`/models/${modelId}/anchors`).then(rows => { if (!cancelled) setAnchors(rows); }).catch(e => { if (!cancelled) setError(e.message); }); return () => { cancelled = true; }; }, [modelId]);
  useEffect(() => { const id = setInterval(() => setClock(new Date()), 1000); return () => clearInterval(id); }, []);
  const toggleFull = () => setImmersive?.(!full);
  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const fd = new FormData(event.currentTarget); const file = fd.get('file') as File; setUploading(true); setError('');
    try { if (!file?.size || !file.name.toLowerCase().endsWith('.glb')) throw new Error('请选择 GLB 模型文件'); if (file.size > 100 * 1024 * 1024) throw new Error('当前单文件上限为 100 MB，请先优化模型'); const result = await fetch(`/api/models?name=${encodeURIComponent(String(fd.get('name')))}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'model/gltf-binary', 'X-Workspace-Request': '1' }, body: file }); const body = await result.json(); if (!result.ok) throw new Error(body.error); await getModels(); setModelId(body.id); setUploadOpen(false); } catch (e: any) { setError(e.message); } finally { setUploading(false); }
  };
  const saveAnchor = async () => { if (!position || !bindingId) return; setSaving(true); setError(''); try { const existing = anchors.find(a => a.target_id === bindingId); await api(`/models/${modelId}/anchors`, 'POST', { targetId: bindingId, position, ...(existing ? { version: existing.version } : {}) }); await getAnchors(); setBindingId(''); setPosition(null); } catch (e: any) { setError(e.message); } finally { setSaving(false); } };
  const removeAnchor = async () => { if (!selectedAnchor) return; setSaving(true); try { await api(`/models/${modelId}/anchors/${selectedAnchor.id}`, 'DELETE', { version: selectedAnchor.version }); await getAnchors(); setUnlink(false); } catch (e: any) { setError(e.message); } finally { setSaving(false); } };
  const pickAsset = (id: string) => { setSelectedId(id); setUnlink(false); setBindingId(''); setPosition(null); };
  return <div className="twin-screen" ref={root}>
    <header className="twin-header">
      <div className="twin-header-left">
        {full ? (
          <button className="twin-back-btn" onClick={toggleFull}>
            <ArrowLeft size={15} />退出全屏
          </button>
        ) : (
          <span className="twin-live-pill">
            <i className="pulse-dot" />孪生空间在线
          </span>
        )}
        <span className="twin-org">{ws.organization}</span>
      </div>
      <div className="twin-title">
        <h1>数字孪生 · 运营指挥中心</h1>
        <span>DIGITAL TWIN OPERATIONS CENTER</span>
      </div>
      <div className="twin-header-right">
        <div className="twin-clock">
          <strong>{clock.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}</strong>
          <span>{clock.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', weekday: 'long' })}</span>
        </div>
        <button className={`twin-full-btn ${full ? 'is-on' : ''}`} aria-pressed={full} aria-label={full ? '退出全屏' : '进入全屏'} title={full ? '退出全屏（Esc）' : '页面全屏显示'} onClick={toggleFull}>
          {full ? <Minimize size={16} /> : <Maximize size={16} />}<span>{full ? '退出全屏' : '全屏'}</span>
        </button>
      </div>
    </header>
    {full && <div className="twin-esc-hint" aria-hidden="true">按 <kbd>Esc</kbd> 退出全屏</div>}
    <div className="twin-body"><aside className="twin-left">
      <TwinPanel title="运行总览" icon={<Activity size={16} />}><div className="twin-kpis"><div><strong>{ws.records.spaces.length}</strong><span>登记场所</span></div><div><strong>{ws.records.devices.length}</strong><span>登记设备</span></div><div className="warning"><strong>{pending.length}</strong><span>待处理告警</span></div><div><strong>{jobs.length}</strong><span>进行中工单</span></div></div></TwinPanel>
      <TwinPanel title="设备接入情况" icon={<Cable size={16} />}><div className="twin-device-status"><div className="twin-ring" style={{ background: `conic-gradient(#34c759 ${ws.records.devices.length ? online / ws.records.devices.length * 360 : 0}deg,#e8e8ed 0deg)` }}><span><strong>{online}</strong><small>已上报在线</small></span></div><div>{[['online', '已上报在线'], ['offline', '已上报离线'], ['stale', '心跳过期'], ['unverified', '待接入']].map(([state, label]) => <span key={state}><i className={state} />{label}<b>{ws.records.devices.filter(d => d.state === state).length}</b></span>)}</div></div></TwinPanel>
      <TwinPanel title="场景业务对象" icon={<Layers size={16} />} className="twin-assets-panel"><input aria-label="搜索场景对象" placeholder="查找场所或设备" value={assetSearch} onChange={e => setAssetSearch(e.target.value)} /><div className="twin-asset-list">{filteredAssets.length ? filteredAssets.map(asset => <button className={selectedId === asset.id ? 'selected' : ''} key={asset.id} onClick={() => pickAsset(asset.id)}>{asset.type === 'spaces' ? <Building2 size={15} /> : <Cctv size={15} />}<span>{asset.data.name}<small>{asset.data.code || '围栏布控'}</small></span>{anchors.some(a => a.target_id === asset.id) ? <MapPin size={13} /> : <small>未定位</small>}</button>) : <div className="twin-compact-empty">先在后台建立场所与设备，<br />再与三维模型绑定。</div>}</div></TwinPanel>
    </aside>
    <section className="twin-center"><div className="twin-scene-toolbar"><div><Box size={17} /><select aria-label="选择三维模型" value={modelId} onChange={e => setModelId(e.target.value)} disabled={!models.length}>{!models.length && <option value="">场景待配置</option>}{models.map(m => <option value={m.id} key={m.id}>{m.name}</option>)}</select></div><span>{anchors.length} 个业务点位</span>{admin && <button onClick={() => { setUploadOpen(true); setError(''); }}><Upload size={14} />导入模型</button>}</div>
      <div className="twin-scene-area">{currentModel ? <ModelScene key={currentModel.id} model={currentModel} markers={markers} selectedId={selectedId} binding={!!bindingId} pendingPosition={position} onSelect={pickAsset} onPick={setPosition} /> : <div className="twin-no-model"><div className="twin-scene-symbol" data-mini-zone><MiniScene className="twin-mini" floors={4} fallback={<Box size={52} strokeWidth={1.1} />} /></div><h2>等待场地模型</h2><p>模型导入后，场所、设备与告警<br />将在同一空间中呈现。</p>{admin && <button className="twin-primary" onClick={() => { setUploadOpen(true); setError(''); }}><Upload size={15} />导入三维场景</button>}<small>目前未配置模型，周边业务数据来自管理后台</small></div>}
        {bindingId && <div className="twin-binding-tip"><Crosshair size={17} /><span>{position ? `已选取位置，确认绑定「${assets.find(a => a.id === bindingId)?.data.name}」` : `请点击模型表面，为「${assets.find(a => a.id === bindingId)?.data.name}」选择位置`}</span>{position && <button onClick={() => void saveAnchor()} disabled={saving}><Check size={16} />确认绑定</button>}<button aria-label="取消绑定" onClick={() => { setBindingId(''); setPosition(null); }}><X size={16} /></button></div>}
      </div>
      <div className="twin-bottom-grid"><TwinPanel title="今日办公" icon={<Users size={15} />}><div className="twin-office-kpis"><div><UserSymbol /><strong>{visits.reduce((sum, v) => sum + v.data.count, 0)}</strong><span>已登记在访人数</span></div><div><CalendarDays size={19} /><strong>{meetings.length}</strong><span>今日有效会议</span></div><div><Cctv size={19} /><strong>{ws.records.access.filter(a => localDate(Date.parse(a.data.occurredAt)) === today).length}</strong><span>今日通行记录</span></div></div></TwinPanel><TwinPanel title="最近能耗读数" icon={<Zap size={15} />}><div className="twin-energy">{ws.records.energy.length ? ws.records.energy.slice(0, 3).map(row => <div key={row.id}><span>{cellValue(ws, 'energy', row, 'deviceId')}<small>{prettyTime(row.data.occurredAt, true)}</small></span><strong>{row.data.value}<small>{row.data.unit}</small></strong></div>) : <div className="twin-compact-empty">尚未登记表计读数<br /><small>等待人工抄表或采集服务接入</small></div>}</div></TwinPanel></div>
    </section>
    <aside className="twin-right">
      {selected ? <TwinPanel title="业务对象详情" icon={<MapPin size={15} />}><div className="twin-selection"><div><h3>{selected.data.name}</h3><button aria-label="清除对象选择" onClick={() => { setSelectedId(''); setBindingId(''); setPosition(null); }}><X size={15} /></button></div><p>{selected.data.code || '区域布控'} · {selected.type === 'spaces' ? '场所空间' : selected.type === 'fences' ? '围栏与围挡' : '设备资源'}</p><Badge state={selected.state} /><div className="twin-object-facts"><span>三维位置<b>{selectedAnchor ? '已绑定当前模型' : '尚未绑定'}</b></span><span>待处理告警<b>{pending.filter(a => a.data.deviceId === selected.id || a.data.spaceId === selected.id || a.data.ruleId === selected.id).length}</b></span>{selected.data.kind === 'meeting_room' && <span>今日会议<b>{meetings.filter(m => m.data.spaceId === selected.id).length} 场</b></span>}</div><div className="twin-linked-records">{[...(ws.records.fences || []), ...(ws.records.watches || [])].filter(r => r.data.deviceId === selectedId).map(r => <button key={r.id} onClick={() => select(r)}><Layers size={12} /><span>{r.data.name}</span><Badge state={r.state} /></button>)}{linkedAlerts.slice(0, 3).map(row => <button key={row.id} onClick={() => select(row)}><Bell size={12} /><span>{row.data.name}</span><ChevronRight size={12} /></button>)}{linkedMeetings.slice(0, 3).map(row => <button key={row.id} onClick={() => select(row)}><CalendarDays size={12} /><span>{row.data.name}</span><ChevronRight size={12} /></button>)}</div><button className="twin-secondary" onClick={() => select(selected)}>查看业务档案<ChevronRight size={14} /></button>{admin && currentModel && <button className="twin-primary" onClick={() => { setBindingId(selected.id); setPosition(null); setUnlink(false); }}><Crosshair size={14} />{selectedAnchor ? '重新定位点位' : '在模型上定位'}</button>}{admin && selectedAnchor && <button className="twin-unlink" onClick={() => unlink ? void removeAnchor() : setUnlink(true)} disabled={saving}>{unlink ? '确认解除此点位绑定' : '解除三维绑定'}</button>}</div></TwinPanel> : <TwinPanel title="空间与业务联动" icon={<MapPin size={15} />}><div className="twin-intro"><LocateFixed size={29} strokeWidth={1.2} /><p>选择模型上的业务点位，<br />查看状态、事件与关联业务。</p><span>模型与点位按场景独立保存</span></div></TwinPanel>}
      <TwinPanel title="待处理告警" icon={<Bell size={15} />} count={pending.length}><div className="twin-alert-list">{pending.length ? pending.slice(0, 5).map(alert => <button key={alert.id} onClick={() => { const targetId = alert.data.deviceId || alert.data.spaceId; if (anchors.some(a => a.target_id === targetId)) pickAsset(targetId); else select(alert); }}><div><i className={alert.data.priority} /><strong>{alert.data.name}</strong><Badge state={alert.data.priority} /></div><p>{alert.data.description}</p><span>{cellValue(ws, 'alerts', alert, 'deviceId')}<small>{prettyTime(alert.data.occurredAt, true)}</small></span></button>) : <div className="twin-compact-empty">暂无待处理告警<br /><small>异常事件接入后自动汇集</small></div>}</div></TwinPanel>
      <TwinPanel title="运维处置" icon={<Wrench size={15} />} count={jobs.length}><div className="twin-job-list">{jobs.length ? jobs.slice(0, 3).map(job => <button key={job.id} onClick={() => select(job)}><span><strong>{job.data.name}</strong><small>{cellValue(ws, 'workorders', job, 'assigneeId')}</small></span><Badge state={job.state} /></button>) : <div className="twin-compact-empty">暂无进行中的工单</div>}</div></TwinPanel>
    </aside></div>
    <div className="twin-foot"><span><i />{connectionError ? '业务连接异常 · 正在显示上次数据' : '业务数据已连接 · 每 30 秒更新'}</span><span>最近更新 {new Date(lastSynced).toLocaleTimeString('zh-CN', { hour12: false })} · 设备状态依据上报</span><span>{ws.user.name} · 智慧工程</span></div>
    {error && <div className="twin-error" role="alert">{error}<button aria-label="关闭错误提示" onClick={() => setError('')}><X size={16} /></button></div>}
    {uploadOpen && <Modal title="导入三维场景" subtitle="支持内嵌纹理的 GLB 2.0，单文件不超过 100 MB" onClose={() => { if (!uploading) setUploadOpen(false); }}><form onSubmit={upload}><div className="form-stack"><label>场景名称<input name="name" required maxLength={120} placeholder="例如：总部园区 / 一号楼" /></label><label>模型文件<input name="file" type="file" accept=".glb" required /></label><p className="model-help">请导出资源内嵌、未启用 Draco / Meshopt / KTX2 压缩的 GLB。BIM、CAD 和 3D Tiles 需后续转换或适配。</p></div>{error && <div className="form-error">{error}</div>}<div className="modal-footer"><button className="button secondary" type="button" onClick={() => setUploadOpen(false)} disabled={uploading}>取消</button><button className="button primary" disabled={uploading}>{uploading ? '正在上传模型…' : '导入场景'}</button></div></form></Modal>}
  </div>;
}

function UserSymbol() { return <Users size={19} />; }
function TwinPanel({ title, icon, children, count, className = '' }: { title: string; icon?: ReactNode; children: ReactNode; count?: number; className?: string }) { return <section className={`twin-panel ${className}`}><div className="twin-panel-heading"><span>{icon}{title}</span>{count !== undefined ? <b>{count}</b> : <i />}</div>{children}</section>; }

function ModelScene({ model, markers, selectedId, binding, pendingPosition, onSelect, onPick }: { model: Model; markers: SceneMarker[]; selectedId: string; binding: boolean; pendingPosition: [number, number, number] | null; onSelect: (id: string) => void; onPick: (point: [number, number, number]) => void }) {
  const host = useRef<HTMLDivElement>(null); const markerElements = useRef(new Map<string, HTMLButtonElement>()); const pendingElement = useRef<HTMLSpanElement>(null);
  const latest = useRef({ markers, selectedId, binding, pendingPosition, onPick }); latest.current = { markers, selectedId, binding, pendingPosition, onPick };
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null); const controlsRef = useRef<OrbitControls | null>(null); const resetRef = useRef<() => void>(() => {});
  const [loading, setLoading] = useState(true); const [error, setError] = useState(''); const [progress, setProgress] = useState(0); const [ready, setReady] = useState(false);
  useEffect(() => {
    const container = host.current!; let disposed = false; let frame = 0; let object: THREE.Object3D | null = null; let renderer: THREE.WebGLRenderer;
    setLoading(true); setError(''); setReady(false);
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' }); } catch { setError('当前浏览器未能建立三维渲染环境。请使用支持 WebGL 的浏览器查看。'); setLoading(false); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
    renderer.domElement.setAttribute('aria-label', '三维场景画布'); renderer.domElement.setAttribute('role', 'img'); container.prepend(renderer.domElement);
    const scene = new THREE.Scene(); scene.add(new THREE.HemisphereLight(0xc4eadb, 0x52616f, 2.5)); const light = new THREE.DirectionalLight(0xffffff, 3.5); light.position.set(2, 4, 3); scene.add(light);
    const camera = new THREE.PerspectiveCamera(45, 1, .01, 100000); const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.dampingFactor = .08; cameraRef.current = camera; controlsRef.current = controls;
    const resize = () => { const { width, height } = container.getBoundingClientRect(); if (!width || !height) return; camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height, false); };
    const observer = new ResizeObserver(resize); observer.observe(container); resize();
    const releaseObject = (root: THREE.Object3D) => { const textures = new Set<THREE.Texture>(); root.traverse(node => { const mesh = node as THREE.Mesh; mesh.geometry?.dispose(); if (mesh.material) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) { for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value); material.dispose(); } }); for (const texture of textures) { texture.dispose(); if (typeof ImageBitmap !== 'undefined' && texture.image instanceof ImageBitmap) texture.image.close(); } };
    new GLTFLoader().load(`/api/models/${model.id}/file`, gltf => {
      if (disposed) { releaseObject(gltf.scene); return; }
      object = gltf.scene; object.updateMatrixWorld(true); const box = new THREE.Box3().setFromObject(object);
      if (box.isEmpty() || !Number.isFinite(box.getSize(new THREE.Vector3()).length())) { setError('模型没有可显示的几何内容，请检查导出范围。'); setLoading(false); releaseObject(object); object = null; return; }
      scene.add(object); const center = box.getCenter(new THREE.Vector3()); const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, .01);
      camera.near = Math.max(radius / 1000, .00001); camera.far = radius * 100; camera.updateProjectionMatrix(); controls.minDistance = radius / 100; controls.maxDistance = radius * 30;
      resetRef.current = () => { const distance = radius / Math.sin(THREE.MathUtils.degToRad(22.5)) / Math.min(camera.aspect, 1); camera.position.copy(center).add(new THREE.Vector3(1, .7, 1).normalize().multiplyScalar(distance)); controls.target.copy(center); controls.update(); };
      resetRef.current(); setLoading(false); setReady(true);
    }, event => { if (!disposed && event.total) setProgress(Math.round(event.loaded / event.total * 100)); }, () => { if (!disposed) { setError('模型加载失败。请检查文件是否完整及当前账号会话。'); setLoading(false); } });
    const raycaster = new THREE.Raycaster(); let down: [number, number] | null = null;
    const pointerDown = (event: PointerEvent) => { down = [event.clientX, event.clientY]; };
    const pointerUp = (event: PointerEvent) => { if (!latest.current.binding || !object || !down || Math.hypot(event.clientX - down[0], event.clientY - down[1]) > 5) return; const rect = renderer.domElement.getBoundingClientRect(); raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera); const hit = raycaster.intersectObject(object, true)[0]; if (hit) latest.current.onPick(hit.point.toArray()); };
    const lost = () => setError('三维图形上下文已丢失，请返回后台后重新进入大屏。');
    renderer.domElement.addEventListener('pointerdown', pointerDown); renderer.domElement.addEventListener('pointerup', pointerUp); renderer.domElement.addEventListener('webglcontextlost', lost);
    const place = (element: HTMLElement | undefined | null, position: [number, number, number]) => { if (!element) return; const p = new THREE.Vector3(...position).project(camera); const visible = p.z >= -1 && p.z <= 1 && Math.abs(p.x) <= 1.1 && Math.abs(p.y) <= 1.1; element.style.display = visible ? 'flex' : 'none'; element.style.left = `${(p.x + 1) / 2 * container.clientWidth}px`; element.style.top = `${(-p.y + 1) / 2 * container.clientHeight}px`; };
    const animate = () => { if (disposed) return; frame = requestAnimationFrame(animate); if (document.hidden) return; controls.update(); renderer.render(scene, camera); for (const marker of latest.current.markers) place(markerElements.current.get(marker.id), marker.position); if (latest.current.pendingPosition) place(pendingElement.current, latest.current.pendingPosition); };
    animate();
    return () => { disposed = true; cancelAnimationFrame(frame); observer.disconnect(); controls.dispose(); cameraRef.current = null; controlsRef.current = null; renderer.domElement.removeEventListener('pointerdown', pointerDown); renderer.domElement.removeEventListener('pointerup', pointerUp); renderer.domElement.removeEventListener('webglcontextlost', lost); if (object) releaseObject(object); renderer.dispose(); renderer.domElement.remove(); };
  }, [model.id]);
  useEffect(() => { const marker = markers.find(m => m.target_id === selectedId); const camera = cameraRef.current; const controls = controlsRef.current; if (!marker || !camera || !controls || !ready) return; const offset = camera.position.clone().sub(controls.target); controls.target.fromArray(marker.position); camera.position.copy(controls.target).add(offset); controls.update(); }, [selectedId, ready]);
  return <div className={`model-scene ${binding ? 'binding' : ''}`} ref={host}>{markers.map(marker => <button ref={el => { if (el) markerElements.current.set(marker.id, el); else markerElements.current.delete(marker.id); }} key={marker.id} className={`scene-marker ${marker.alerts ? 'has-alert' : ''} ${selectedId === marker.target_id ? 'selected' : ''}`} onClick={() => onSelect(marker.target_id)} aria-label={`场景点位：${marker.target.data.name}`}><span>{marker.target.type === 'spaces' ? <Building2 size={13} /> : <Cctv size={13} />}</span><strong>{marker.target.data.name}</strong>{marker.alerts > 0 && <b>{marker.alerts}</b>}</button>)}{pendingPosition && <span className="pending-position" ref={pendingElement}><Crosshair size={24} /></span>}{loading && <div className="scene-message"><span className="spinner" /><strong>正在加载模型</strong><small>{progress}%</small></div>}{error && <div className="scene-message scene-failure"><CircleHelp size={29} /><strong>三维场景暂时不可用</strong><p>{error}</p></div>}{ready && <><button className="scene-reset" onClick={() => resetRef.current()} aria-label="恢复场景全景"><RotateCcw size={15} />全景</button><span className="scene-navigation-help">拖动旋转 · 滚轮缩放 · 右键平移</span></>}</div>;
}
