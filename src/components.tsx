import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X, ArrowUpRight, Inbox, Check, ChevronRight } from 'lucide-react';
import { modules, stateNames, prettyTime, type Row, type Workspace } from './model';
import { fenceNames } from './security-model';
import MiniIcon from './MiniIcon';

export function Brand({ light = false, model = false }: { light?: boolean; model?: boolean }) {
  return (
    <div className={`brand ${light ? 'light' : ''} ${model ? 'has-model' : ''}`} data-mini-zone={model || undefined}>
      <span className="brand-mark">
        <i />
        <i />
        <i />
        {model && <MiniIcon kind="bars" />}
      </span>
      <span>
        智慧工程
        <small>Smart Workspace</small>
      </span>
    </div>
  );
}

/**
 * Lightweight anchored menu / popover (apple.com-style): portalled to <body>, placed under
 * its anchor, closes on outside press, Escape or Tab-out, and supports arrow-key movement
 * between [role=menuitem] entries.
 */
export function Popover({ anchor, onClose, align = 'start', label, className = '', children }: { anchor: HTMLElement | null; onClose: () => void; align?: 'start' | 'end'; label: string; className?: string; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose); close.current = onClose;
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number; maxHeight: number } | null>(null);
  useLayoutEffect(() => {
    const place = () => {
      if (!anchor) return;
      const r = anchor.getBoundingClientRect(), w = panel.current?.offsetWidth || 280, vw = window.innerWidth;
      const top = Math.round(r.bottom + 8), maxHeight = Math.max(160, window.innerHeight - top - 12);
      setPos(align === 'end' ? { top, right: Math.max(8, Math.round(vw - r.right)), maxHeight } : { top, left: Math.round(Math.max(8, Math.min(r.left, vw - w - 8))), maxHeight });
    };
    place();
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchor, align]);
  useEffect(() => {
    const down = (e: PointerEvent) => { const t = e.target as Node; if (panel.current?.contains(t) || anchor?.contains(t)) return; close.current(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close.current(); anchor?.focus(); } };
    document.addEventListener('pointerdown', down, true); document.addEventListener('keydown', key, true);
    const focusTimer = requestAnimationFrame(() => panel.current?.focus({ preventScroll: true }));
    return () => { cancelAnimationFrame(focusTimer); document.removeEventListener('pointerdown', down, true); document.removeEventListener('keydown', key, true); };
  }, [anchor]);
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(panel.current?.querySelectorAll<HTMLElement>('[role=menuitem]') || [])];
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
  };
  return createPortal(
    <div ref={panel} className={`os-menu ${align === 'end' ? 'is-end' : ''} ${className}`} role="dialog" aria-label={label} tabIndex={-1}
      style={pos ? { top: pos.top, left: pos.left, right: pos.right, maxHeight: pos.maxHeight } : { opacity: 0 }}
      onKeyDown={onKeyDown} onBlur={e => { if (e.relatedTarget && !panel.current?.contains(e.relatedTarget as Node) && !anchor?.contains(e.relatedTarget as Node)) close.current(); }}>
      {children}
    </div>, document.body);
}

export function Badge({ state, children }: { state: string; children?: ReactNode }) {
  return (
    <span className={`badge badge-${state}`}>
      <i />
      {children || stateNames[state] || state}
    </span>
  );
}

export function Empty({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        <Inbox size={26} strokeWidth={1.5} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function Modal({ title, subtitle, children, onClose, wide = false }: { title: string; subtitle?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const requestClose = () => {
    if (closingRef.current) return;
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) { onClose(); return; }
    closingRef.current = true; setClosing(true);
    setTimeout(() => { closingRef.current = false; setClosing(false); close.current(); }, 190);
  };
  const close = useRef(onClose);
  close.current = onClose;
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  useEffect(() => {
    const before = document.activeElement as HTMLElement;
    const focusable = () => Array.from(root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]') || []);
    focusable()[0]?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestCloseRef.current();
      if (e.key === 'Tab') {
        const items = focusable();
        if (e.shiftKey && document.activeElement === items[0]) {
          e.preventDefault();
          items.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === items.at(-1)) {
          e.preventDefault();
          items[0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', key);
      document.body.style.overflow = overflow;
      before?.focus();
    };
  }, []);

  return (
    <div className={`modal-overlay ${closing ? 'is-closing' : ''}`} onMouseDown={e => { if (e.target === e.currentTarget) requestClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} ref={root} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button modal-close-btn" aria-label="关闭弹窗" onClick={requestClose}>
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Panel({ title, meta, action, children, className = '' }: { title: string; meta?: string; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {meta && <span>{meta}</span>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function LinkButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button className="text-button" onClick={onClick}>
      {children}
      <ArrowUpRight size={14} />
    </button>
  );
}

export function Steps({ steps, navigate }: { steps: { title: string; detail: string; done: boolean; page: string }[]; navigate: (page: string) => void }) {
  return (
    <div className="setup-steps">
      {steps.map((step, i) => (
        <button key={step.title} className={step.done ? 'done' : ''} style={{ animation: 'appleCardEnter 0.35s var(--ease-apple) both', animationDelay: `${i * 0.05}s` }} onClick={() => navigate(step.page)}>
          <span className="step-number">{step.done ? <Check size={14} /> : `0${i + 1}`}</span>
          <span>
            <strong>{step.title}</strong>
            <small>{step.detail}</small>
          </span>
          <ChevronRight size={15} />
        </button>
      ))}
    </div>
  );
}

export function cellValue(ws: Workspace, type: string, row: Row, key: string): string {
  const value = row.data[key];
  if (key === 'source') return value === 'manual' ? '人工登记' : value?.startsWith('integration:') ? '外部服务' : '—';
  if (key === 'category') return value === 'portrait_watch' ? '人像布控命中' : fenceNames[value] || ws.algorithms.find(a => a.id === value)?.name || value;
  if (!value && value !== 0) return '—';
  if (['startAt', 'endAt', 'occurredAt', 'dueAt', 'lastSeen'].includes(key)) return prettyTime(value, true);
  const field = modules[type]?.fields.find(f => f.key === key);
  if (key === 'algorithm') return ws.algorithms.find(a => a.id === value)?.name || value;
  if (field?.ref || ['ruleId', 'captureId', 'detectionId', 'portraitId'].includes(key)) return Object.values(ws.records).flat().find(r => r.id === value)?.data.name || '记录已不可用';
  if (field?.options) return field.options.find(o => o[0] === String(value))?.[1] || String(value);
  return String(value);
}

export function Table({ ws, type, rows, onSelect }: { ws: Workspace; type: string; rows: Row[]; onSelect: (row: Row) => void }) {
  const config = modules[type];
  return (
    <div className="table-scroll">
      <table className="apple-table">
        <thead>
          <tr>
            {config.columns.map(key => (
              <th key={key}>
                {config.fields.find(f => f.key === key)?.label || ({ lastSeen: '最近状态', source: '来源' } as Record<string, string>)[key] || key}
              </th>
            ))}
            <th>状态</th>
            <th className="actions-cell">操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr key={row.id} style={{ animation: 'appleCardEnter 0.3s var(--ease-apple) both', animationDelay: `${Math.min(idx, 15) * 0.025}s` }}>
              {config.columns.map((key, i) => (
                <td key={key}>
                  {i === 0 ? (
                    <button className="row-title" onClick={() => onSelect(row)}>
                      {cellValue(ws, type, row, key)}
                    </button>
                  ) : key === 'priority' ? (
                    <Badge state={row.data[key]} />
                  ) : (
                    cellValue(ws, type, row, key)
                  )}
                </td>
              ))}
              <td>
                <Badge state={row.state} />
              </td>
              <td className="actions-cell">
                <button className="table-detail text-button" onClick={() => onSelect(row)} aria-label={`查看${row.data.name || config.singular}`}>
                  查看
                  <ChevronRight size={14} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function exportCsv(ws: Workspace, type: string, rows: Row[]) {
  const config = modules[type];
  const keys = config.fields.map(f => f.key);
  const escape = (value: string) => `"${(/^[=+\-@\t\r]/.test(value) ? `'${value}` : value).replaceAll('"', '""')}"`;
  const content = '\ufeff' + [config.fields.map(f => f.label).concat(['状态', '来源']), ...rows.map(row => [...keys.map(k => cellValue(ws, type, row, k)), stateNames[row.state] || row.state, cellValue(ws, type, row, 'source')])].map(values => values.map(escape).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${config.name}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
