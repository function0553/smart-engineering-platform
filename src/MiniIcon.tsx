import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { hasWebGL, markWebGLUnavailable } from './webgl';

/**
 * Icon-sized three.js models for the sidebar header.
 *  - "bars": the brand mark as three extruded, softly lit columns that rise on load,
 *    breathe like live data and sway gently.
 *  - "site": a tiny architectural model (slab, glass floors, clay roof, a tree)
 *    on a slow turntable.
 * Hovering the closest [data-mini-zone] spins the model once. Pauses off-screen,
 * still frame for reduced motion; children stay visible as the fallback until the
 * first frame is rendered (and permanently if WebGL is unavailable).
 */
type Props = { kind: 'bars' | 'site'; className?: string };

const easeOutBack = (x: number) => { const c1 = 1.6, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export default function MiniIcon({ kind, className = '' }: Props) {
  const host = useRef<HTMLSpanElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el || !hasWebGL()) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch { markWebGLUnavailable(); return; }
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    renderer.setPixelRatio(Math.min(3, Math.max(2, window.devicePixelRatio || 1)));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    const site = kind === 'site';
    if (site) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap; }
    el.appendChild(renderer.domElement);

    const disposables: { dispose(): void }[] = [];
    const mat = (color: number, roughness = 0.6, metalness = 0) => { const m = new THREE.MeshStandardMaterial({ color, roughness, metalness }); disposables.push(m); return m; };
    const geo = <T extends THREE.BufferGeometry>(g: T) => { disposables.push(g); return g; };
    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => { const o = new THREE.Mesh(g, m); o.position.set(x, y, z); o.castShadow = site; o.receiveShadow = site; return o; };

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(22, 1, 0.1, 100);
    const model = new THREE.Group();
    scene.add(model);
    const target = new THREE.Vector3();
    let radius = 1, baseAz = 0, elev = 0;

    // Animated parts
    const bars: { g: THREE.Group; h: number; phase: number }[] = [];
    const floors: THREE.Group[] = [];

    if (!site) {
      scene.add(new THREE.HemisphereLight(0xffffff, 0x2a2a2e, 1.5));
      const key = new THREE.DirectionalLight(0xffffff, 2.6); key.position.set(-2.5, 4, 3); scene.add(key);
      const rim = new THREE.DirectionalLight(0xffe2d6, 1.1); rim.position.set(3, 1.5, -2.5); scene.add(rim);
      const white = mat(0xffffff, 0.42), clay = mat(0xe07a5a, 0.4);
      [[-0.5, 0.56, white], [0, 1.08, clay], [0.5, 0.8, white]].forEach(([x, h, m], i) => {
        const g = new THREE.Group(); g.position.x = x as number;
        g.add(mesh(geo(new RoundedBoxGeometry(0.34, h as number, 0.34, 3, 0.07)), m as THREE.Material, 0, (h as number) / 2, 0));
        g.scale.y = 0.001; model.add(g); bars.push({ g, h: h as number, phase: i * 1.9 });
      });
      target.set(0, 0.52, 0); radius = 1.0; baseAz = -0.55; elev = 0.3;
    } else {
      scene.add(new THREE.HemisphereLight(0xffffff, 0xd4d4da, 2));
      const sun = new THREE.DirectionalLight(0xffffff, 2.4); sun.position.set(3, 6, 2.5); sun.castShadow = true;
      sun.shadow.mapSize.set(512, 512); Object.assign(sun.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2, near: 1, far: 14 }); sun.shadow.bias = -0.001;
      scene.add(sun);
      const ground = new THREE.Mesh(geo(new THREE.PlaneGeometry(8, 8)), (() => { const m = new THREE.ShadowMaterial({ opacity: 0.12 }); disposables.push(m); return m; })());
      ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
      const white = mat(0xffffff, 0.7), slab = mat(0xf4f4f6, 0.8), glass = mat(0xa9bccf, 0.22, 0.15), clay = mat(0xd97757, 0.5), leaf = mat(0x8fd19e, 0.85);
      model.add(mesh(geo(new RoundedBoxGeometry(1.7, 0.1, 1.3, 3, 0.04)), slab, 0, 0.05, 0));
      const FH = 0.3, plateG = geo(new RoundedBoxGeometry(0.9, 0.05, 0.74, 2, 0.02)), glassG = geo(new THREE.BoxGeometry(0.82, FH - 0.05, 0.66));
      const N = 4;
      for (let i = 0; i < N; i++) {
        const f = new THREE.Group(); f.position.set(-0.22, 0.1 + i * FH, 0);
        const top = i === N - 1;
        f.add(mesh(plateG, top ? clay : white, 0, 0.025, 0));
        if (!top) f.add(mesh(glassG, glass, 0, 0.05 + (FH - 0.05) / 2, 0));
        f.scale.y = 0.001; f.visible = false; model.add(f); floors.push(f);
      }
      // low annex + tree
      model.add(mesh(geo(new RoundedBoxGeometry(0.5, 0.26, 0.42, 2, 0.03)), white, 0.5, 0.23, -0.28));
      const tree = new THREE.Group(); tree.position.set(0.52, 0.1, 0.36);
      tree.add(mesh(geo(new THREE.CylinderGeometry(0.02, 0.025, 0.14, 8)), white, 0, 0.07, 0), mesh(geo(new THREE.IcosahedronGeometry(0.13, 1)), leaf, 0, 0.22, 0));
      model.add(tree);
      target.set(0.02, 0.5, 0); radius = 1.3; baseAz = 0.75; elev = 0.42;
    }

    let dist = 5;
    const resize = () => {
      const w = Math.max(1, el.clientWidth), h = Math.max(1, el.clientHeight);
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
      const vf = THREE.MathUtils.degToRad(camera.fov), hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
      dist = radius / Math.sin(Math.min(vf, hf) / 2);
    };
    resize();

    const zone = (el.closest('[data-mini-zone]') as HTMLElement | null) || el.parentElement || el;
    let spinAt = -10, lean = 0, leanTarget = 0;
    const onEnter = () => { if (!reduce && performance.now() / 1000 - spinAt > 1.3) spinAt = performance.now() / 1000; kick(); };
    const onMove = (e: PointerEvent) => { const b = zone.getBoundingClientRect(); leanTarget = ((e.clientX - b.left) / b.width - 0.5) * 0.5; };
    const onLeave = () => { leanTarget = 0; };
    zone.addEventListener('pointerenter', onEnter); zone.addEventListener('pointermove', onMove); zone.addEventListener('pointerleave', onLeave);

    const start = performance.now() / 1000;
    let raf = 0, visible = true, last = start, drawn = 0, shown = false;
    const draw = (nowMs: number) => {
      const now = nowMs / 1000, t = reduce ? 99 : now - start, dt = Math.min(0.05, now - last); last = now;
      bars.forEach((b, i) => {
        const p = clamp01((t - 0.15 - i * 0.14) / 0.6);
        const breathe = reduce ? 1 : 1 + Math.sin(t * 1.3 + b.phase) * 0.07 * clamp01(t - 1.2);
        b.g.scale.y = Math.max(0.001, easeOutBack(p) * breathe);
      });
      floors.forEach((f, i) => { const p = clamp01((t - 0.15 - i * 0.16) / 0.5); f.visible = p > 0; f.scale.y = Math.max(0.001, easeOutBack(p)); });
      lean += (leanTarget - lean) * Math.min(1, dt * 5);
      const spin = reduce ? 0 : easeInOut(clamp01((now - spinAt) / 1.1)) * Math.PI * 2;
      const idle = reduce ? 0 : site ? t * 0.22 : Math.sin(t * 0.55) * 0.32;
      const az = baseAz + idle + lean + (spin % (Math.PI * 2));
      camera.position.set(target.x + dist * Math.cos(elev) * Math.sin(az), target.y + dist * Math.sin(elev), target.z + dist * Math.cos(elev) * Math.cos(az));
      camera.lookAt(target);
      renderer.render(scene, camera);
      if (!shown) { shown = true; setReady(true); }
    };
    const loop = (nowMs: number) => {
      const busy = nowMs / 1000 - start < 2 || nowMs / 1000 - spinAt < 1.2;
      if (busy || nowMs - drawn > 40) { drawn = nowMs; draw(nowMs); }
      raf = visible && !document.hidden && !reduce ? requestAnimationFrame(loop) : 0;
    };
    function kick() { if (!raf && visible && !document.hidden && !reduce) { last = performance.now() / 1000; raf = requestAnimationFrame(loop); } }
    const ro = new ResizeObserver(() => { resize(); if (!raf) requestAnimationFrame(draw); }); ro.observe(el);
    const io = new IntersectionObserver(([en]) => { visible = !!en?.isIntersecting; kick(); }); io.observe(el);
    document.addEventListener('visibilitychange', kick);
    if (reduce) requestAnimationFrame(draw); else kick();

    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); io.disconnect();
      document.removeEventListener('visibilitychange', kick);
      zone.removeEventListener('pointerenter', onEnter); zone.removeEventListener('pointermove', onMove); zone.removeEventListener('pointerleave', onLeave);
      disposables.forEach(d => d.dispose()); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
      setReady(false);
    };
  }, [kind]);

  return <span ref={host} className={'mini-icon ' + className} data-ready={ready || undefined} aria-hidden="true" />;
}
