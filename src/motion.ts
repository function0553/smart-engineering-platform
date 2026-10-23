/**
 * Small, framework-agnostic motion layer.
 *  1. Segmented controls get a sliding white "thumb" that springs between options
 *     (like iOS / apple.com segmented controls) instead of the background jumping.
 *  2. Tiles lean toward the mouse with a gentle 3D tilt and a moving highlight,
 *     so icons feel like small physical objects.
 * Everything is skipped for users who prefer reduced motion, and tilt only reacts
 * to a real mouse.
 */
const SEG = '.mw-bottom, .site-simple-tabs, .reports-tabs';
const ACTIVE = ':scope > [aria-current]:not([aria-current=false]), :scope > [aria-pressed=true]';
const TILT = '.mw-module-entry, .mw-project-row, .mw-action-tiles > .mw-row, .mw-todo-tiles > .mw-row, .os-auth-tiles > li, .mw-project-hero';

const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

function placeThumb(seg: HTMLElement) {
  const active = seg.querySelector<HTMLElement>(ACTIVE);
  if (!seg.dataset.seg) seg.dataset.seg = '';
  if (!active || !active.offsetWidth) { seg.style.setProperty('--seg-o', '0'); return; }
  const pr = seg.getBoundingClientRect(), ar = active.getBoundingClientRect();
  const sx = pr.width / (seg.offsetWidth || pr.width) || 1;
  const x = (ar.left - pr.left) / sx - seg.clientLeft, y = (ar.top - pr.top) / sx - seg.clientTop;
  seg.style.setProperty('--seg-x', `${x.toFixed(2)}px`);
  seg.style.setProperty('--seg-y', `${y.toFixed(2)}px`);
  seg.style.setProperty('--seg-w', `${(ar.width / sx).toFixed(2)}px`);
  seg.style.setProperty('--seg-h', `${(ar.height / sx).toFixed(2)}px`);
  seg.style.setProperty('--seg-o', '1');
  if (!seg.classList.contains('seg-ready')) requestAnimationFrame(() => seg.classList.add('seg-ready'));
}

let queued = 0;
const observed = new WeakSet<Element>();
const ro = new ResizeObserver(() => schedule());
function scan() {
  queued = 0;
  document.querySelectorAll<HTMLElement>(SEG).forEach(seg => {
    if (!observed.has(seg)) { observed.add(seg); ro.observe(seg); }
    placeThumb(seg);
  });
}
function schedule() { if (!queued) queued = requestAnimationFrame(scan); }

new MutationObserver(schedule).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-current', 'aria-pressed', 'hidden'] });
window.addEventListener('resize', schedule);
document.fonts?.ready.then(schedule).catch(() => undefined);
schedule();

// Pointer tilt
let current: HTMLElement | null = null;
function release(el: HTMLElement | null) {
  if (!el) return;
  el.classList.remove('is-tilting');
  el.style.removeProperty('--tx'); el.style.removeProperty('--ty');
  el.style.removeProperty('--gx'); el.style.removeProperty('--gy');
}
document.addEventListener('pointermove', e => {
  if (e.pointerType !== 'mouse' || reduce.matches) return;
  const t = (e.target as Element | null)?.closest?.<HTMLElement>(TILT) || null;
  if (t !== current) { release(current); current = t; }
  if (!t) return;
  const b = t.getBoundingClientRect();
  const px = Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)), py = Math.min(1, Math.max(0, (e.clientY - b.top) / b.height));
  t.style.setProperty('--tx', ((px - 0.5) * 2).toFixed(3));
  t.style.setProperty('--ty', ((py - 0.5) * 2).toFixed(3));
  t.style.setProperty('--gx', `${(px * 100).toFixed(1)}%`);
  t.style.setProperty('--gy', `${(py * 100).toFixed(1)}%`);
  t.classList.add('is-tilting');
}, { passive: true });
document.documentElement.addEventListener('pointerleave', () => { release(current); current = null; });
window.addEventListener('blur', () => { release(current); current = null; });
