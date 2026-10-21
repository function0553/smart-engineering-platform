import { useEffect, useRef, useState } from 'react';
import { Camera, Undo2, Trash2, Scan } from 'lucide-react';
import './analysis-region.css';

export const FULL_FRAME = '[[0,0],[1,0],[1,1],[0,1]]';

export default function AnalysisRegion({ deviceId, value, onChange, diagnostic }: { deviceId: string; value: string; onChange: (value: string) => void; diagnostic: boolean }) {
  const [preview, setPreview] = useState('');
  const [size, setSize] = useState([16, 9]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [x, setX] = useState(''); const [y, setY] = useState('');
  const current = useRef(''); const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); if (current.current) URL.revokeObjectURL(current.current); }, []);
  let points: number[][] = [];
  try { const parsed = JSON.parse(value); if (Array.isArray(parsed) && parsed.every(p => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1))) points = parsed; } catch { /* Backend validates editable coordinates on save. */ }
  const add = (point: number[]) => {
    if (points.length >= 32) { setError('区域最多 32 个点，请先撤销或清空。'); return; }
    onChange(JSON.stringify([...points, point.map(n => Math.round(Math.max(0, Math.min(1, n))*10000)/10000)])); setError('');
  };
  const snapshot = async () => {
    setBusy(true); setError(''); controller.current?.abort(); const pending = new AbortController(); controller.current = pending;
    try {
      const response = await fetch(`/api/video/sources/${encodeURIComponent(deviceId)}/frame`, { credentials: 'same-origin', cache: 'no-store', signal: pending.signal });
      if (!response.ok) throw new Error(response.status === 404 ? '暂无分析画面，请先到视频监控启动该摄像头的分析。' : '无法读取画面，请检查登录状态和视频服务。');
      const data = await response.blob(); if (pending.signal.aborted) return;
      if (current.current) URL.revokeObjectURL(current.current);
      current.current = URL.createObjectURL(data); setPreview(current.current);
    } catch (e: any) { if (!pending.signal.aborted) setError(e.message); } finally { if (!pending.signal.aborted) setBusy(false); }
  };
  return <section className="analysis-region span-two" aria-label="分析区域设置">
    <div className="analysis-region-heading"><div><strong>检测区域</strong><small>{diagnostic ? '图像诊断始终分析整幅画面，区域设置不参与判定。' : '人员脚点进入多边形时参与分析。相机角度改变后请重新画区。'}</small></div><button type="button" className="button secondary small" disabled={!deviceId || busy || diagnostic} onClick={() => void snapshot()}><Camera size={15} />{busy ? '获取中…' : '获取当前画面'}</button></div>
    {!diagnostic && <>
      <div className={`analysis-region-canvas ${preview ? 'with-image' : ''}`} style={{ aspectRatio: `${size[0]}/${size[1]}` }}>
        {preview ? <img src={preview} alt="用于画区的固定参考画面" onLoad={e => setSize([e.currentTarget.naturalWidth, e.currentTarget.naturalHeight])} /> : <div className="analysis-region-empty"><Camera size={28} /><span>{deviceId ? '获取画面后，清空默认区域并依次点击边界点' : '先选择摄像头，再获取参考画面'}</span><small>当前默认分析全画面，也可在下方手动添加坐标。</small></div>}
        <svg viewBox="0 0 1000 1000" preserveAspectRatio="none" role="img" aria-label={`区域预览，已设置 ${points.length} 个边界点`} onClick={preview ? e => { const rect = e.currentTarget.getBoundingClientRect(); add([(e.clientX-rect.left)/rect.width, (e.clientY-rect.top)/rect.height]); } : undefined}>
          {points.length > 1 && <polygon points={points.map(p => `${p[0]*1000},${p[1]*1000}`).join(' ')} />}
          {points.map((p, i) => <circle key={i} cx={p[0]*1000} cy={p[1]*1000} r="7" />)}
        </svg>
      </div>
      <div className="analysis-region-tools"><button type="button" className="button secondary small" onClick={() => onChange(FULL_FRAME)}><Scan size={14} />全画面</button><button type="button" className="button secondary small" disabled={!points.length} onClick={() => onChange(JSON.stringify(points.slice(0, -1)))}><Undo2 size={14} />撤销点</button><button type="button" className="button secondary small" onClick={() => onChange('[]')}><Trash2 size={14} />清空重画</button><span>{points.length} / 32 个点 · 至少 3 点</span></div>
      <details><summary>手动输入坐标</summary><div className="analysis-region-coordinates"><label>横向位置（%）<input aria-label="横向位置百分比" type="number" min="0" max="100" step="0.1" value={x} onChange={e => setX(e.target.value)} /></label><label>纵向位置（%）<input aria-label="纵向位置百分比" type="number" min="0" max="100" step="0.1" value={y} onChange={e => setY(e.target.value)} /></label><button type="button" className="button secondary small" disabled={x === '' || y === '' || !Number.isFinite(+x) || !Number.isFinite(+y) || +x < 0 || +x > 100 || +y < 0 || +y > 100} onClick={() => { add([+x/100, +y/100]); setX(''); setY(''); }}>添加点</button></div><label>归一化坐标<textarea rows={2} value={value} maxLength={2000} onChange={e => onChange(e.target.value)} /></label></details>
    </>}
    <input type="hidden" name="roi" value={diagnostic ? FULL_FRAME : value} />
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
