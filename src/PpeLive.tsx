import { useEffect, useRef, useState } from 'react';
import { Cctv, Play, Pause, Volume2, VolumeX, Maximize, RefreshCw, ShieldCheck, LockKeyhole } from 'lucide-react';
import type Hls from 'hls.js';
import {
  businessPath, containGeometry, displayDetection, equipmentState, historyReceipt, latestResult,
  personKey, resultKey, selectOverlay, sessionKey,
  type HistoryReceipt, type MatchReason, type OverlayConfig, type OverlayMatch, type PpeHistory,
} from './ppe-overlay';
import './ppe-live.css';

type Camera = { id: string; name: string; statusPath: string; resultsPath: string; historyPath: string; overlayConfigPath: string; hlsPath: string };
type CameraList = { configured: boolean; canView: boolean; cameras: Camera[] };
type LoadState = 'loading' | 'ready' | 'unconfigured' | 'forbidden' | 'error';
type CameraStatus = { connected?: boolean; result_available?: boolean; decoded_frame_age_seconds?: number };
const REASONS: Record<MatchReason, string> = {
  ready: '已匹配播放画面', disabled: '中文检测框已关闭', paused: '播放后匹配画面观测',
  waiting: '视频缓冲中，已撤回检测框', frame_stale: '画面未更新，已撤回检测框',
  no_anchor: '缺少播放时间锚，暂不叠框', history_unavailable: '暂无新鲜观测，已撤回检测框',
  history_stale: '观测更新超时，已撤回检测框', input_stale: '分析输入已过期，已撤回检测框',
  no_match: '暂未匹配播放画面，已撤回检测框', orientation: '画面方向不匹配，暂不叠框',
  size: '视频与检测尺寸不一致，暂不叠框', format: '检测数据格式待核对，暂不叠框',
};
class ReadError extends Error { status: number; constructor(status: number) { super('read_failed'); this.status = status; } }
async function readJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal, credentials: 'same-origin', cache: 'no-store',
    headers: { 'X-Workspace-Request': '1', Accept: 'application/json' } });
  if (!response.ok) throw new ReadError(response.status);
  return response.json() as Promise<T>;
}
const clockText = (time: number | string | undefined) => {
  const date = new Date(time || '');
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString('zh-CN', { hour12: false }) : '—';
};

export default function PpeLive({ userId }: { userId: string }) {
  const [state, setState] = useState<LoadState>('loading');
  const [loadedFor, setLoadedFor] = useState('');
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [selected, setSelected] = useState('');
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const reconnect = () => { setLoadedFor(''); setReload(n => n + 1); };
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 8000);
    setState('loading'); setCameras([]); setError('');
    void readJson<CameraList>('/api/ppe/cameras', controller.signal).then(data => {
      if (disposed) return;
      if (!data.canView) { setState('forbidden'); setLoadedFor(userId); return; }
      if (!data.configured) { setState('unconfigured'); setLoadedFor(userId); return; }
      const valid = Array.isArray(data.cameras) ? data.cameras.filter(c => c && typeof c.id === 'string' &&
        typeof c.name === 'string' && businessPath(c.historyPath) && businessPath(c.statusPath) &&
        businessPath(c.overlayConfigPath) && businessPath(c.hlsPath, true)) : [];
      if (!valid.length) { setState('error'); setError('暂无可访问的摄像头，请管理员核对点位授权和连接配置。'); }
      else { setCameras(valid); setSelected(previous => valid.some(c => c.id === previous) ? previous : valid[0].id); setState('ready'); }
      setLoadedFor(userId);
    }).catch(e => {
      if (disposed) return;
      setState(e instanceof ReadError && e.status === 403 ? 'forbidden' : 'error');
      setError(e instanceof ReadError && e.status === 401 ? '登录已过期，请重新登录。' : '无法读取摄像头，请检查平台连接后重试。');
      setLoadedFor(userId);
    }).finally(() => clearTimeout(timeout));
    return () => { disposed = true; clearTimeout(timeout); controller.abort(); };
  }, [userId, reload]);
  const actualState = loadedFor !== userId ? 'loading' : state;
  const camera = cameras.find(c => c.id === selected);
  if (actualState !== 'ready' || !camera) return <section className="ppe-unavailable" aria-label="4G安全防护接入">
    <div className="ppe-empty-stage"><Cctv size={42} strokeWidth={1.2} /><h2>{actualState === 'loading' ? '正在读取现场视频' : actualState === 'forbidden' ? '此账号暂无观看权限' : actualState === 'unconfigured' ? '4G 视频待接入' : '暂时无法连接'}</h2>
      <p>{actualState === 'loading' ? '读取摄像头授权与连接配置…' : actualState === 'forbidden' ? '请管理员为当前账号授权摄像头。' : actualState === 'unconfigured' ? '配置视频服务后，在这里观看连续画面与穿戴观测。' : error}</p></div>
    <div className="ppe-empty-guide"><span className="ppe-guide-symbol">{actualState === 'forbidden' ? <LockKeyhole size={22} /> : <ShieldCheck size={22} />}</span><h2>安全帽与反光背心</h2><p>中文检测框叠在连续视频上，每个人的两项穿戴观测随播放画面同步。</p><p>没有新鲜结果时，自动撤回检测框和穿戴状态。</p>
      {actualState === 'unconfigured' && <p className="ppe-empty-instruction">请管理员在服务端完成视频连接与点位授权，再重新读取。</p>}
      {actualState !== 'loading' && <button className="button secondary" onClick={reconnect}><RefreshCw size={15} />重新读取</button>}</div>
  </section>;
  return <section className="ppe-workspace" aria-label="4G安全防护">
    {cameras.length > 1 && <label className="ppe-camera-select">观看摄像头<select value={selected} onChange={e => setSelected(e.target.value)}>{cameras.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
    <CameraView key={`${userId}:${selected}:${reload}`} camera={camera} onReconnect={reconnect} />
  </section>;
}

function CameraView({ camera, onReconnect }: { camera: Camera; onReconnect: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null), canvasRef = useRef<HTMLCanvasElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null), playerRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false), [muted, setMuted] = useState(true), [overlay, setOverlay] = useState(true);
  const [hasFrame, setHasFrame] = useState(false), [mediaState, setMediaState] = useState('ready');
  const [status, setStatus] = useState<'reading' | 'connected' | 'unavailable'>('reading');
  const [accessError, setAccessError] = useState(''), [controlError, setControlError] = useState('');
  const [latestTime, setLatestTime] = useState<string | undefined>();
  const [match, setMatch] = useState<OverlayMatch>({ reason: 'paused', result: null });
  const overlayRef = useRef(true), blockRef = useRef(false), clearNow = useRef<() => void>(() => {});

  useEffect(() => {
    const video = videoRef.current!, canvas = canvasRef.current!, media = mediaRef.current!;
    const context = canvas.getContext('2d');
    let disposed = false, hls: Hls | null = null, history: HistoryReceipt | null = null, config: OverlayConfig = {};
    let lastFrame = 0, lastMediaTime = -1, waiting = false, statusOkay = false;
    let lastSignature = '', lastDrawn = '', currentSession = '', raf = 0, frameId = 0, retries = 0;
    let historyTimer: ReturnType<typeof setTimeout>, statusTimer: ReturnType<typeof setTimeout>, mediaTimer: ReturnType<typeof setTimeout>;
    let width = 0, height = 0, dpr = 1, backoff = 250;
    const controllers = new Set<AbortController>();
    const request = async <T,>(path: string, timeoutMs: number): Promise<T> => {
      const controller = new AbortController(); controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try { return await readJson<T>(path, controller.signal); }
      finally { clearTimeout(timeout); controllers.delete(controller); }
    };
    const clearCanvas = () => { context?.clearRect(0, 0, width, height); lastDrawn = ''; };
    const publish = (next: OverlayMatch) => {
      const signature = `${next.reason}:${next.result ? resultKey(next.result) : ''}`;
      if (!disposed && signature !== lastSignature) { lastSignature = signature; setMatch(next); }
    };
    const clear = (reason: MatchReason = 'history_unavailable') => {
      history = null; currentSession = ''; clearCanvas(); publish({ reason, result: null });
      if (!disposed) setLatestTime(undefined);
    };
    clearNow.current = () => { clearCanvas(); publish({ reason: 'paused', result: null }); };
    const block = (e: unknown) => {
      if (!(e instanceof ReadError) || (e.status !== 401 && e.status !== 403)) return false;
      blockRef.current = true; clear(); video.pause(); hls?.destroy(); hls = null;
      video.removeAttribute('src'); video.load(); controllers.forEach(c => c.abort());
      clearTimeout(historyTimer); clearTimeout(statusTimer); clearTimeout(mediaTimer);
      if (!disposed) setAccessError(e.status === 401 ? '登录已过期，请重新登录。' : '观看授权已撤销，请联系管理员。');
      return true;
    };
    const resize = () => {
      const bounds = media.getBoundingClientRect(); width = bounds.width; height = bounds.height;
      dpr = window.devicePixelRatio || 1; canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      context?.setTransform(dpr, 0, 0, dpr, 0, 0); lastDrawn = '';
    };
    const observer = new ResizeObserver(resize); observer.observe(media);
    window.addEventListener('resize', resize); document.addEventListener('fullscreenchange', resize); resize();
    const draw = (next: OverlayMatch) => {
      const signature = `${next.result ? resultKey(next.result) : next.reason}:${lastFrame}:${overlayRef.current}`;
      if (signature === lastDrawn) return;
      clearCanvas(); lastDrawn = signature;
      if (!context || !next.result || !overlayRef.current) return;
      const geometry = containGeometry(width, height, video.videoWidth, video.videoHeight);
      if (!geometry) return;
      for (const raw of Array.isArray(next.result.detections) ? next.result.detections : []) {
        const detection = displayDetection(raw, video.videoWidth, video.videoHeight);
        if (!detection) continue;
        const [x1, y1, x2, y2] = detection.box;
        const x = geometry.offsetX + x1 * geometry.scale, y = geometry.offsetY + y1 * geometry.scale;
        const boxWidth = (x2 - x1) * geometry.scale, boxHeight = (y2 - y1) * geometry.scale;
        context.strokeStyle = detection.negative ? '#ff9a8d' : '#6de1b4'; context.lineWidth = 2;
        context.strokeRect(x, y, boxWidth, boxHeight);
        context.font = '600 12px "Microsoft YaHei", "Segoe UI", sans-serif';
        const label = `${detection.label} ${Math.round(detection.confidence * 100)}%`;
        const labelWidth = Math.min(geometry.width, context.measureText(label).width + 12);
        const labelX = Math.max(geometry.offsetX, Math.min(x, geometry.offsetX + geometry.width - labelWidth));
        const labelY = Math.max(geometry.offsetY, y - 23);
        context.fillStyle = detection.negative ? '#982d2d' : '#155d49'; context.fillRect(labelX, labelY, labelWidth, 23);
        context.fillStyle = '#ffffff'; context.fillText(label, labelX + 6, labelY + 16, labelWidth - 12);
      }
    };
    const frameArrived = () => {
      if (disposed) return;
      lastFrame = performance.now(); lastMediaTime = video.currentTime;
      if (!video.paused && video.readyState >= 3) waiting = false;
      setHasFrame(true);
      if (!video.paused) setMediaState('playing');
      if (typeof video.requestVideoFrameCallback === 'function') frameId = video.requestVideoFrameCallback(frameArrived);
    };
    if (typeof video.requestVideoFrameCallback === 'function') frameId = video.requestVideoFrameCallback(frameArrived);
    const tick = () => {
      if (disposed) return;
      if (typeof video.requestVideoFrameCallback !== 'function' && !video.paused && video.currentTime !== lastMediaTime) frameArrived();
      const next = selectOverlay({ cameraId: camera.id, receipt: statusOkay === false || blockRef.current ? null : history,
        config, nowMonoMs: performance.now(), playingDateMs: hls?.playingDate?.getTime() ?? null,
        paused: video.paused, waiting, enabled: true, lastFrameMonoMs: lastFrame,
        videoWidth: video.videoWidth, videoHeight: video.videoHeight });
      draw(next); publish(next); raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const onPlay = () => { if (!disposed) { setPlaying(true); setControlError(''); } };
    const onPause = () => { if (!disposed) { setPlaying(false); clearCanvas(); publish({ reason: 'paused', result: null }); } };
    const onWaiting = () => { waiting = true; clearCanvas(); publish({ reason: 'waiting', result: null }); };
    const onPlaying = () => { waiting = false; if (!disposed) setMediaState('playing'); };
    const onVideoError = () => { clear(); if (!disposed) setMediaState('error'); };
    const onVolume = () => { if (!disposed) setMuted(video.muted); };
    video.addEventListener('play', onPlay); video.addEventListener('pause', onPause);
    video.addEventListener('waiting', onWaiting); video.addEventListener('stalled', onWaiting);
    video.addEventListener('playing', onPlaying); video.addEventListener('error', onVideoError);
    video.addEventListener('volumechange', onVolume);

    const pollHistory = async () => {
      if (disposed || blockRef.current) return;
      const started = Date.now();
      try {
        const data = await request<PpeHistory>(camera.historyPath, 900);
        if (disposed || blockRef.current) return;
        const latest = latestResult(data);
        if (!latest || data.state !== 'fresh' || latest.camera_id !== camera.id) clear();
        else {
          const nextSession = sessionKey(latest);
          if (currentSession && currentSession !== nextSession) { clearCanvas(); publish({ reason: 'history_unavailable', result: null }); }
          currentSession = nextSession; history = historyReceipt(data, started, Date.now(), performance.now());
          setLatestTime(latest.received_at_utc || (Number.isFinite(latest.decoder_received_epoch_ms)
            ? new Date(latest.decoder_received_epoch_ms!).toISOString() : undefined)); backoff = 250;
        }
      } catch (e) {
        if (disposed || blockRef.current) return;
        clear(); if (block(e)) return; backoff = Math.min(5000, Math.max(500, backoff * 2));
      } finally { if (!disposed && !blockRef.current) historyTimer = setTimeout(pollHistory, backoff); }
    };
    const pollStatus = async () => {
      if (disposed || blockRef.current) return;
      try {
        const data = await request<CameraStatus>(camera.statusPath, 1800);
        if (disposed || blockRef.current) return;
        statusOkay = data.connected === true && data.result_available === true &&
          (typeof data.decoded_frame_age_seconds !== 'number' || data.decoded_frame_age_seconds <= 1);
        setStatus(statusOkay ? 'connected' : 'unavailable');
        if (!statusOkay) clear();
      } catch (e) {
        if (disposed || blockRef.current) return;
        statusOkay = false; clear(); setStatus('unavailable'); if (block(e)) return;
      } finally { if (!disposed && !blockRef.current) statusTimer = setTimeout(pollStatus, 2000); }
    };
    void request<OverlayConfig>(camera.overlayConfigPath, 1800).then(data => {
      if (disposed || blockRef.current) return;
      if (data && typeof data === 'object') config = data;
      clearCanvas(); lastDrawn = '';
    }).catch(e => { if (!disposed && !blockRef.current) { clear(); block(e); } });
    void pollStatus(); void pollHistory();
    void import('hls.js').then(({ default: HlsPlayer }) => {
      if (disposed || blockRef.current) return;
      if (HlsPlayer.isSupported()) {
        hls = new HlsPlayer({ enableWorker: true, lowLatencyMode: true, backBufferLength: 10,
          maxBufferLength: 8, maxMaxBufferLength: 12 });
        hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
          if (disposed || blockRef.current) return;
          clear(); waiting = true;
          if (data.type === HlsPlayer.ErrorTypes.NETWORK_ERROR) {
            setMediaState('error');
            if (data.response?.code === 401 || data.response?.code === 403) { block(new ReadError(data.response.code)); return; }
            if (data.fatal && retries < 3) { retries++; clearTimeout(mediaTimer);
              mediaTimer = setTimeout(() => { if (!disposed && !blockRef.current) { setMediaState('loading'); hls?.startLoad(); } }, Math.min(5000, 1000 * 2 ** (retries - 1))); }
          } else if (data.fatal && data.type === HlsPlayer.ErrorTypes.MEDIA_ERROR && retries < 3) {
            retries++; setMediaState('loading'); hls?.recoverMediaError();
          } else if (data.fatal) { setMediaState('error'); hls?.stopLoad(); }
        });
        hls.on(HlsPlayer.Events.MANIFEST_PARSED, () => { if (!disposed && !blockRef.current) setMediaState('ready'); });
        hls.loadSource(camera.hlsPath); hls.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = camera.hlsPath; setMediaState('native'); }
      else setMediaState('unsupported');
    }).catch(() => { if (!disposed) setMediaState('error'); });
    return () => {
      disposed = true; clearNow.current = () => {}; controllers.forEach(c => c.abort());
      clearTimeout(historyTimer); clearTimeout(statusTimer); clearTimeout(mediaTimer); cancelAnimationFrame(raf);
      if (frameId && 'cancelVideoFrameCallback' in video) video.cancelVideoFrameCallback(frameId);
      observer.disconnect(); window.removeEventListener('resize', resize); document.removeEventListener('fullscreenchange', resize);
      video.removeEventListener('play', onPlay); video.removeEventListener('pause', onPause);
      video.removeEventListener('waiting', onWaiting); video.removeEventListener('stalled', onWaiting);
      video.removeEventListener('playing', onPlaying); video.removeEventListener('error', onVideoError); video.removeEventListener('volumechange', onVolume);
      hls?.destroy(); video.pause(); video.removeAttribute('src'); video.load(); clearCanvas();
    };
  }, [camera]);

  const togglePlay = async () => {
    const video = videoRef.current;
    if (!video || blockRef.current) return;
    setControlError('');
    if (!video.paused) { video.pause(); return; }
    try { await video.play(); } catch { setControlError('暂时无法播放，请重新连接或稍后重试。'); }
  };
  const fullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await playerRef.current?.requestFullscreen();
    } catch { setControlError('浏览器暂不支持全屏播放。'); }
  };
  const toggleOverlay = () => { overlayRef.current = !overlayRef.current; setOverlay(overlayRef.current); };
  const persons = match.result && Array.isArray(match.result.persons) ? match.result.persons.filter(p => p && p.track_id !== undefined && p.tracking_epoch !== undefined) : [];
  const unavailable = accessError || mediaState === 'unsupported';
  const currentObservation = !accessError && mediaState !== 'error' && mediaState !== 'unsupported' && status === 'connected' && match.reason === 'ready' && !!match.result;
  const observationStatus = accessError ? '观看权限不可用' : currentObservation ? '画面观测已同步'
    : status === 'reading' ? '读取连接状态' : status === 'connected' && mediaState !== 'error' && mediaState !== 'unsupported'
      ? '服务已连接 · 画面观测待匹配' : '暂无可用画面观测';
  const mainMessage = accessError || (mediaState === 'error' ? '视频暂不可用，请重新连接' : mediaState === 'unsupported' ? '浏览器不支持此视频格式' : mediaState === 'loading' ? '正在重新连接视频…' : '点击播放，查看现场画面');
  return <>
    <div className="ppe-camera-heading"><div><Cctv size={18} /><h2>{camera.name}</h2><span className={`ppe-connection ${currentObservation ? 'is-ready' : ''}`}><i />{observationStatus}</span></div>
      <button className="button secondary small" onClick={onReconnect}><RefreshCw size={14} />重新连接</button></div>
    <div className="ppe-live-grid">
      <div className="ppe-player" ref={playerRef}>
        <div className="ppe-media" ref={mediaRef}>
          <video ref={videoRef} muted={muted} playsInline preload="metadata" aria-label={`${camera.name}连续视频`} />
          <canvas ref={canvasRef} className="ppe-canvas" aria-hidden="true" />
          {(!hasFrame || accessError || mediaState === 'error' || mediaState === 'unsupported') && <div className="ppe-stage-message"><Cctv size={36} strokeWidth={1.3} /><strong>{mainMessage}</strong><span>{accessError ? '旧检测框与穿戴状态已撤回' : '视频与观测分别更新，连接恢复后重新匹配'}</span></div>}
        </div>
        <div className="ppe-controls" aria-label="视频播放控制">
          <button className="ppe-control" disabled={!!unavailable} onClick={() => void togglePlay()} aria-label={playing ? '暂停视频' : '播放视频'}>{playing ? <Pause size={18} /> : <Play size={18} />}<span>{playing ? '暂停' : '播放'}</span></button>
          <button className="ppe-control" disabled={!!unavailable} onClick={() => { const video = videoRef.current; if (video) video.muted = !video.muted; }} aria-label={muted ? '开启声音' : '静音'} aria-pressed={!muted}>{muted ? <VolumeX size={18} /> : <Volume2 size={18} />}<span>{muted ? '静音' : '有声'}</span></button>
          <label className="ppe-overlay-switch"><input type="checkbox" checked={overlay} onChange={toggleOverlay} disabled={!!accessError} />中文检测框</label>
          <button className="ppe-control ppe-fullscreen" onClick={() => void fullscreen()} aria-label="全屏视频"><Maximize size={17} /><span>全屏</span></button>
        </div>
        {controlError && <p className="ppe-player-feedback" role="alert">{controlError}</p>}
      </div>
      <aside className="ppe-observations" aria-label="画面人员穿戴观测">
        <div className="ppe-observation-heading"><h2>画面观测</h2><span>瞬时 · 未确认</span></div>
        <p className="ppe-observation-meta">{match.result ? <>接收时间 <time>{clockText(match.result.received_at_utc || match.result.decoder_received_epoch_ms)}</time></> : '等待与播放画面匹配的结果'}</p>
        {match.result ? persons.length ? <ul className="ppe-person-list">{persons.map((person, index) => {
          const helmet = equipmentState(person, 'helmet'), vest = equipmentState(person, 'vest');
          return <li key={personKey(match.result!, person)}><div className="ppe-person-title"><strong>人员 {index + 1}</strong><span>{person.tracking_status === 'temporarily_lost' ? '短时丢失' : '匿名轨迹'}</span></div>
            <dl><div><dt>安全帽</dt><dd className={`ppe-wear ${helmet}`}>{helmet === 'worn' ? '已戴' : helmet === 'not_worn' ? '未戴' : '无法判断'}</dd></div><div><dt>反光背心</dt><dd className={`ppe-wear ${vest}`}>{vest === 'worn' ? '已穿' : vest === 'not_worn' ? '未穿' : '无法判断'}</dd></div></dl></li>;
        })}</ul> : <div className="ppe-observation-empty"><ShieldCheck size={27} strokeWidth={1.3} /><strong>本次未输出人员轨迹</strong><p>不代表现场无人或全部合规。</p></div> : <div className="ppe-observation-empty"><ShieldCheck size={27} strokeWidth={1.3} /><strong>{accessError ? '观看权限不可用' : '穿戴状态待更新'}</strong><p>画面暂停或观测失效时，<br />不保留旧穿戴结论。</p></div>}
        <p className="ppe-observation-foot">只展示当前观测，匿名轨迹不用于实名识别、考勤或已确认违规。</p>
      </aside>
    </div>
    <div className="ppe-sync-strip" role="status"><span className={match.reason === 'ready' ? 'ppe-sync-ready' : ''}><i />{accessError || REASONS[match.reason]}{match.reason === 'ready' && !overlay && ' · 检测框已关闭'}</span><span>最新输入观测 <time>{clockText(latestTime)}</time></span></div>
    <p className="ppe-timing-note">画面与观测按接收时间近似匹配，尚未完成同帧和现场精度验收。中文框由本平台叠加，原视频中的原厂框可能仍会保留。</p>
  </>;
}
