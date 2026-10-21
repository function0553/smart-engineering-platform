import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { algorithms } from './catalog.mjs';
import { FACE_MODEL_ID, visionCapabilities } from './vision-catalog.mjs';

function configuredPath(name, fallback) {
  const value = process.env[name]?.trim();
  if (!value) return fallback;
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return resolve(value);
}
export const pythonPath = configuredPath('VISION_PYTHON_PATH', resolve('.data/ai-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
export const modelsPath = configuredPath('AI_MODELS_PATH', resolve('.data/ai-models'));
export const baseSpec = JSON.parse(readFileSync(new URL('../vision/base-models.json', import.meta.url), 'utf8'));
export const smokingSpec = JSON.parse(readFileSync(new URL('../vision/specialist-models.json', import.meta.url), 'utf8')).smoking;
const probePath = fileURLToPath(new URL('../vision/probe_runtime.py', import.meta.url));
const checks = new Map();
function fileStamp(path) {
  try { const stat = statSync(path); return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; } catch { return 'missing'; }
}
function verified(path, expected, size) {
  try {
    const stat = statSync(path), key = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${expected}`;
    if (checks.get(path)?.key === key) return checks.get(path).valid;
    const valid = stat.isFile() && stat.size === size && createHash('sha256').update(readFileSync(path)).digest('hex') === expected;
    checks.set(path, { key, valid }); return valid;
  } catch { return false; }
}

let probeCache;
function runtimeProbe(models) {
  const key = JSON.stringify([pythonPath, fileStamp(pythonPath), modelsPath, fileStamp(probePath),
    models.map(m => [m.name, m.installed, fileStamp(join(modelsPath, m.name))])]);
  const now = Date.now();
  if (probeCache?.key === key && now - probeCache.at < 5 * 60 * 1000) return probeCache.value;
  const failure = code => ({ base: { ready: false }, smoking: { ready: false }, versions: {}, errors: [code],
    checkedAt: new Date().toISOString(), runtimeError: code });
  let value;
  if (!existsSync(pythonPath)) value = failure('vision_python_missing');
  else if (!existsSync(probePath)) value = failure('vision_runtime_probe_missing');
  else {
    const result = spawnSync(pythonPath, [probePath, '--quick'], { encoding: 'utf8', windowsHide: true,
      timeout: 15000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, AI_MODELS_PATH: modelsPath, PYTHONIOENCODING: 'utf-8' } });
    if (result.error || result.status !== 0) value = failure(result.error?.code === 'ETIMEDOUT' ? 'vision_runtime_probe_timeout' : 'vision_runtime_probe_failed');
    else {
      try {
        const parsed = JSON.parse(result.stdout.trim());
        if (typeof parsed.base?.ready !== 'boolean' || typeof parsed.smoking?.ready !== 'boolean'
          || !Array.isArray(parsed.errors) || !parsed.versions || !Number.isFinite(Date.parse(parsed.checkedAt))) throw new Error('invalid_probe');
        const versions = {};
        for (const name of ['python', 'numpy', 'opencv', 'paddle']) {
          if (typeof parsed.versions[name] === 'string' && /^[A-Za-z0-9.+_-]{1,40}$/.test(parsed.versions[name])) versions[name] = parsed.versions[name];
        }
        const errors = parsed.errors.filter(code => typeof code === 'string' && /^[a-z0-9_:-]{1,100}$/.test(code)).slice(0, 12);
        value = { base: { ready: parsed.base.ready }, smoking: { ready: parsed.smoking.ready }, versions, errors,
          checkedAt: new Date(parsed.checkedAt).toISOString(), runtimeError: parsed.base.ready ? '' : 'vision_runtime_dependencies_unavailable' };
      } catch { value = failure('vision_runtime_probe_invalid'); }
    }
  }
  probeCache = { key, at: now, value };
  return value;
}

export function modelStatus() {
  const models = baseSpec.models.map(m => ({ ...m, installed: verified(join(modelsPath, m.name), m.sha256, m.size) }));
  const extra = smokingSpec.files.map(m => ({ ...m, name: `smoking/${m.name}`, license: smokingSpec.license, installed: verified(join(modelsPath, 'smoking', m.name), m.sha256, m.size) }));
  const probe = runtimeProbe([...models, ...extra]);
  const weightsVerified = models.length === 3 && models.every(m => m.installed);
  const installed = weightsVerified && probe.base.ready;
  let runtime;
  try { runtime = JSON.parse(readFileSync(join(modelsPath, 'smoking/runtime.json'), 'utf8')); } catch {}
  const smokingInstalled = installed && probe.smoking.ready && extra.every(m => m.installed) && runtime?.modelId === smokingSpec.id && runtime?.paddle === '3.2.2' && runtime?.probe === 'blank-frame-inference-passed';
  return { installed, weightsVerified, runtimeProbe: probe, modelId: FACE_MODEL_ID, models: [...models, ...extra], modelCount: (installed ? 3 : 0) + (smokingInstalled ? 1 : 0), backend: `OpenCV DNN${smokingInstalled ? ' + Paddle Inference' : ''} / CPU`, algorithms: algorithms.map(a => ({ ...a,
    status: !visionCapabilities[a.id] ? 'pending_model' : (a.id === 'smoking' ? smokingInstalled : installed) ? 'installed' : 'missing_models',
    implementation: visionCapabilities[a.id]?.[0] || '', limitation: visionCapabilities[a.id]?.[1] || '缺少已验证的专用模型，当前不能启动此项分析。' })) };
}
