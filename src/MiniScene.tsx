import { useEffect, useRef, useState, type ReactNode } from 'react';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

/**
 * A tiny white "architectural model" of a construction site: a glass tower that
 * builds itself floor by floor, a tower crane whose jib swings and whose hook bobs,
 * and a few trees on a rounded slab. Rendered with three.js on a transparent
 * canvas, softly lit, slowly turning and leaning toward the pointer.
 * Pauses off-screen, renders a still frame for reduced-motion users and falls back
 * to the given icon when WebGL is unavailable.
 */
type Props = { className?: string; floors?: number; fallback?: ReactNode };

const easeOutBack = (x: number) => { const c1 = 1.5, c3 = c1 + 1; return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2); };
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export default function MiniScene({ className = '', floors = 5, fallback = null }: Props) {
  const host = useRef<HTMLSpanElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch { setFailed(true); return; }
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0x000000, 0);
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
    const target = new THREE.Vector3(0.1, 1.15, 0);

    scene.add(new THREE.HemisphereLight(0xffffff, 0xd2d2d7, 2.1));
    const sun = new THREE.DirectionalLight(0xffffff, 2.3);
    sun.position.set(4.5, 8, 3.5);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -4, right: 4, top: 4, bottom: -4, near: 1, far: 20 });
    sun.shadow.bias = -0.0008;
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-5, 3, -2);
    scene.add(fill);

    const disposables: { dispose(): void }[] = [];
    const mat = (color: number, roughness = 0.72, metalness = 0) => { const m = new THREE.MeshStandardMaterial({ color, roughness, metalness }); disposables.push(m); return m; };
    const geo = <T extends THREE.BufferGeometry>(g: T) => { disposables.push(g); return g; };
    const mesh = (g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) => { const o = new THREE.Mesh(g, m); o.position.set(x, y, z); o.castShadow = true; o.receiveShadow = true; return o; };

    const white = mat(0xffffff), plate = mat(0xf2f2f4, 0.8), glass = mat(0xb4c3d3, 0.22, 0.15), clay = mat(0xd97757, 0.55), dark = mat(0x3a3a3c, 0.5), leaf = mat(0x9ed3a8, 0.85), trunk = mat(0xd2d2d7);

    const model = new THREE.Group();
    scene.add(model);

    const ground = new THREE.Mesh(geo(new THREE.PlaneGeometry(14, 14)), (() => { const m = new THREE.ShadowMaterial({ opacity: 0.11 }); disposables.push(m); return m; })());
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

    model.add(mesh(geo(new RoundedBoxGeometry(3.3, 0.14, 2.5, 3, 0.06)), plate, 0, 0.07, 0));

    // Tower: floors rise one after another
    const FH = 0.34, base = 0.14, tower = new THREE.Group();
    tower.position.set(-0.45, base, 0.05);
    model.add(tower);
    const plateG = geo(new RoundedBoxGeometry(1.46, 0.06, 1.16, 2, 0.02));
    const glassG = geo(new THREE.BoxGeometry(1.34, FH - 0.06, 1.04));
    const colG = geo(new THREE.BoxGeometry(0.06, FH - 0.06, 0.06));
    const floorGroups: THREE.Group[] = [];
    for (let i = 0; i < floors; i++) {
      const f = new THREE.Group();
      f.position.y = i * FH;
      const last = i === floors - 1;
      f.add(mesh(plateG, last ? clay : white, 0, 0.03, 0));
      if (!last) f.add(mesh(glassG, glass, 0, 0.06 + (FH - 0.06) / 2, 0));
      else for (const [x, z] of [[-0.64, -0.5], [0.64, -0.5], [-0.64, 0.5], [0.64, 0.5]]) f.add(mesh(colG, white, x, 0.06 + (FH - 0.06) / 2, z));
      f.scale.y = 0.001; f.visible = false;
      tower.add(f); floorGroups.push(f);
    }

    // Tower crane
    const crane = new THREE.Group();
    crane.position.set(1.05, base, -0.62);
    model.add(crane);
    const mastH = 2.45;
    crane.add(mesh(geo(new THREE.BoxGeometry(0.08, mastH, 0.08)), clay, 0, mastH / 2, 0));
    const head = new THREE.Group();
    head.position.y = mastH;
    crane.add(head);
    head.add(mesh(geo(new THREE.BoxGeometry(2.1, 0.055, 0.06)), clay, -0.75, 0, 0));
    head.add(mesh(geo(new THREE.BoxGeometry(0.62, 0.055, 0.06)), clay, 0.36, 0, 0));
    head.add(mesh(geo(new RoundedBoxGeometry(0.2, 0.14, 0.14, 2, 0.02)), dark, 0.6, -0.06, 0));
    head.add(mesh(geo(new RoundedBoxGeometry(0.14, 0.12, 0.12, 2, 0.02)), white, 0.02, -0.1, 0.09));
    head.add(mesh(geo(new THREE.BoxGeometry(0.04, 0.36, 0.04)), clay, 0, 0.18, 0));
    const cable = mesh(geo(new THREE.BoxGeometry(0.012, 1, 0.012)), dark, -1.45, 0, 0);
    const load = mesh(geo(new RoundedBoxGeometry(0.26, 0.09, 0.18, 2, 0.02)), white, -1.45, 0, 0);
    head.add(cable, load);

    // Trees
    const crownG = geo(new THREE.IcosahedronGeometry(0.14, 1)), trunkG = geo(new THREE.CylinderGeometry(0.018, 0.022, 0.16, 8));
    for (const [x, z, s] of [[0.95, 0.85, 1], [1.35, 0.55, 0.8], [0.55, 0.98, 0.7]]) {
      const t = new THREE.Group(); t.position.set(x, base, z); t.scale.setScalar(s);
      t.add(mesh(trunkG, trunk, 0, 0.08, 0), mesh(crownG, leaf, 0, 0.24, 0));
      model.add(t);
    }

    // Framing
    let w = 1, h = 1;
    const frame = () => {
      const r = 2.35, vf = THREE.MathUtils.degToRad(camera.fov), hf = 2 * Math.atan(Math.tan(vf / 2) * camera.aspect);
      return r / Math.sin(Math.min(vf, hf) / 2);
    };
    let dist = 9;
    const resize = () => {
      w = Math.max(1, el.clientWidth); h = Math.max(1, el.clientHeight);
      renderer.setSize(w, h, false);
      camera.aspect = w / h; camera.updateProjectionMatrix();
      dist = frame();
    };
    resize();
    const ro = new ResizeObserver(() => { resize(); if (!raf) requestAnimationFrame(now => draw(now)); }); ro.observe(el);

    // Pointer lean
    let lean = 0, leanTarget = 0, tilt = 0, tiltTarget = 0;
    const zone = el.closest('[data-mini-zone]') as HTMLElement | null || el;
    const onMove = (e: PointerEvent) => { const b = zone.getBoundingClientRect(); leanTarget = ((e.clientX - b.left) / b.width - 0.5) * 0.7; tiltTarget = ((e.clientY - b.top) / b.height - 0.5) * 0.18; };
    const onLeave = () => { leanTarget = 0; tiltTarget = 0; };
    zone.addEventListener('pointermove', onMove); zone.addEventListener('pointerleave', onLeave);

    const start = performance.now();
    let raf = 0, visible = true, last = start;
    const draw = (now: number) => {
      const t = reduce ? 99 : (now - start) / 1000;
      const dt = Math.min(0.05, (now - last) / 1000); last = now;
      floorGroups.forEach((f, i) => {
        const p = clamp01((t - 0.2 - i * 0.2) / 0.55);
        f.visible = p > 0; f.scale.y = Math.max(0.001, easeOutBack(p));
      });
      lean += (leanTarget - lean) * Math.min(1, dt * 4); tilt += (tiltTarget - tilt) * Math.min(1, dt * 4);
      const az = THREE.MathUtils.degToRad(38) + (reduce ? 0 : t * 0.16) + lean;
      const el2 = THREE.MathUtils.degToRad(24) + tilt;
      camera.position.set(target.x + dist * Math.cos(el2) * Math.sin(az), target.y + dist * Math.sin(el2), target.z + dist * Math.cos(el2) * Math.cos(az));
      camera.lookAt(target);
      head.rotation.y = reduce ? 0.35 : Math.sin(t * 0.45) * 0.55 + 0.2;
      const len = 0.75 + (reduce ? 0 : Math.sin(t * 0.9) * 0.28);
      cable.scale.y = len; cable.position.y = -len / 2; load.position.y = -len - 0.05;
      renderer.render(scene, camera);
    };
    let drawn = 0;
    // Full frame rate while the floors build up, then ~30 fps for the slow idle motion to save battery.
    const loop = (now: number) => { if (now - start < 2600 || now - drawn > 31) { drawn = now; draw(now); } if (visible && !document.hidden) raf = requestAnimationFrame(loop); else raf = 0; };
    const kick = () => { if (!raf && visible && !document.hidden && !reduce) { last = performance.now(); raf = requestAnimationFrame(loop); } };
    const io = new IntersectionObserver(([en]) => { visible = !!en?.isIntersecting; kick(); });
    io.observe(el);
    document.addEventListener('visibilitychange', kick);
    if (reduce) draw(performance.now()); else kick();

    return () => {
      cancelAnimationFrame(raf); ro.disconnect(); io.disconnect();
      document.removeEventListener('visibilitychange', kick);
      zone.removeEventListener('pointermove', onMove); zone.removeEventListener('pointerleave', onLeave);
      disposables.forEach(d => d.dispose());
      renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
    };
  }, [floors]);

  return <span ref={host} className={'mini-scene ' + className + (failed ? ' is-fallback' : '')} aria-hidden="true">{failed && fallback}</span>;
}
