import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { privateConfig, upstreamBase } from './camera4g-upstream.mjs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// This adapter only reads the separately operated PPE service. It has no store,
// ingestion, alarm, personnel or attendance dependency.
const MEDIA_ROOT = '/media/hls/raw-main/';
const LABELS = new Set(['hardhat', 'no-hardhat', 'safety vest', 'no-safety vest']);
const STATES = new Set(['worn', 'not_worn', 'unknown']);
const MAX_JSON = 2 * 1024 * 1024;
const MAX_PLAYLIST = 1024 * 1024;
const MAX_MEDIA = 64 * 1024 * 1024;
class PpeError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const unavailable = () => new PpeError(503, 'ppe_unavailable');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const safeWord = value => typeof value === 'string' && value.length <= 180 && /^[a-zA-Z0-9_. :+-]*$/.test(value);
const box = value => Array.isArray(value) && value.length === 4 && value.every(finite) ? [...value] : undefined;
function isoTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return null;
  const time = Date.parse(value), day = Date.parse(value.slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(time) || !Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value.slice(0, 10) || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) return null;
  return time;
}
function validIdentity(source, config) {
  return source.schema_version === 1 && source.camera_id === config.cameraId && source.source_stream === 'MAIN' &&
    typeof source.session_id === 'string' && /^[a-zA-Z0-9_.:-]{1,180}$/.test(source.session_id) &&
    Number.isSafeInteger(source.capture_epoch) && source.capture_epoch >= 0 && Number.isSafeInteger(source.sequence) && source.sequence >= 0 &&
    isoTime(source.received_at_utc) !== null;
}
function latestIsFresh(body) {
  const time = isoTime(body.received_at_utc);
  if (time === null || time - Date.now() > 100) throw new PpeError(502, 'ppe_invalid_response');
  if (Date.now() - time > 4000) throw unavailable();
}

function loadConfig(options) {
  try {
    const raw = privateConfig(options, 'PPE_CONFIG_FILE');
    if (!object(raw)) return null;
    const cameraId = raw.cameraId || 'camera-01';
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(cameraId)) return null;
    const bases = ['apiBaseUrl', 'previewBaseUrl'].map((key, i) => {
      return upstreamBase(raw[key], { development: options.development, loopbackPort: i ? 28880 : 28878 });
    });
    const cameraToken = raw.cameraToken, previewPassword = raw.previewPassword, previewUsername = raw.previewUsername || 'viewer';
    if (![cameraToken, previewPassword, previewUsername].every(s => typeof s === 'string' && s.length > 0 && s.length <= 2048 && !/[\r\n\0]/.test(s))) return null;
    if (!/^[\x21-\x7e]+$/.test(cameraToken) || !/^[a-zA-Z0-9_.-]{1,64}$/.test(previewUsername)) return null;
    const allowedUserIds = new Set((Array.isArray(raw.allowedUserIds) ? raw.allowedUserIds : []).slice(0, 1000).filter(s => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(s)));
    const basic = Buffer.from(`${previewUsername}:${previewPassword}`).toString('base64');
    const privateValues = [cameraToken, previewPassword, basic, `Bearer ${cameraToken}`, ...bases.map(u => u.origin)];
    const forbidden = [...new Set(privateValues.flatMap(value => [value, encodeURIComponent(value)]))];
    const name = typeof raw.cameraName === 'string' && raw.cameraName.length <= 100 && !/[\r\n\0]|https?:|127\.0\.0\.1/i.test(raw.cameraName) ? raw.cameraName : '4G施工安全摄像头';
    return { cameraId, name, api: bases[0], preview: bases[1], bearer: `Bearer ${cameraToken}`, basic: `Basic ${basic}`, forbidden, allowedUserIds };
  } catch { return null; }
}

function cleanResult(source, config) {
  if (!object(source) || !validIdentity(source, config) || isoTime(source.received_at_utc) - Date.now() > 100) throw new PpeError(502, 'ppe_invalid_response');
  const out = {};
  const numeric = ['schema_version', 'capture_epoch', 'sequence', 'rotation_degrees', 'source_pts_seconds', 'inference_ms', 'processed_results_count', 'decoder_received_epoch_ms'];
  for (const key of numeric) if (finite(source[key])) out[key] = source[key];
  for (const key of ['camera_id', 'view_id', 'session_id', 'coordinate_space', 'source_pts_status', 'source_pts_policy']) if (safeWord(source[key])) out[key] = source[key];
  out.source_stream = 'MAIN';
  if (Array.isArray(source.frame_size) && source.frame_size.length === 2 && source.frame_size.every(v => finite(v) && v > 0 && v <= 16384)) out.frame_size = [...source.frame_size];
  for (const key of ['mirror_horizontal', 'sensor_exposure_utc_verified', 'temporal_confirmation_enabled', 'diagnostic_jpeg_enabled', 'inference_worker_publishes_display_video', 'field_accuracy_verified', 'production_accepted']) if (typeof source[key] === 'boolean') out[key] = source[key];
  for (const key of ['received_at_utc', 'processed_at_utc']) if (isoTime(source[key]) !== null) out[key] = source[key];
  if (source.frame_jpeg_path === null) out.frame_jpeg_path = null;
  if (Array.isArray(source.detection_tasks)) out.detection_tasks = source.detection_tasks.filter(v => ['safety_helmet', 'reflective_vest'].includes(v));
  const detection = item => {
    if (!object(item) || !LABELS.has(item.label) || !finite(item.confidence) || item.confidence < 0 || item.confidence > 1 || !box(item.box)) return null;
    return { label: item.label, confidence: item.confidence, box: box(item.box) };
  };
  out.detections = (Array.isArray(source.detections) ? source.detections : []).slice(0, 500).map(detection).filter(Boolean);
  out.persons = (Array.isArray(source.persons) ? source.persons : []).slice(0, 300).filter(object).map(person => {
    const p = {};
    if (box(person.box)) p.box = box(person.box);
    for (const key of ['confidence', 'track_id', 'observation_age_seconds']) if (finite(person[key])) p[key] = person[key];
    for (const key of ['tracking_epoch', 'tracking_status']) if (safeWord(person[key])) p[key] = person[key];
    for (const key of ['observed_states', 'raw_states', 'states']) {
      p[key] = Object.fromEntries(['helmet', 'vest'].map(part => [part, STATES.has(person[key]?.[part]) ? person[key][part] : 'unknown']));
    }
    p.reasons = Object.fromEntries(['helmet', 'vest'].filter(part => safeWord(person.reasons?.[part])).map(part => [part, person.reasons[part]]));
    p.evidence = Object.fromEntries(['helmet', 'vest'].map(part => [part, (Array.isArray(person.evidence?.[part]) ? person.evidence[part] : []).slice(0, 50).map(detection).filter(Boolean)]));
    return p;
  });
  const cleaned = scrub(out, config);
  if (!validIdentity(cleaned, config)) throw new PpeError(502, 'ppe_invalid_response');
  return cleaned;
}

// Whitelisted scalar strings still cannot reflect configured credentials.
function scrub(value, config) {
  if (typeof value === 'string') return config.forbidden.some(s => s && value.includes(s)) ? undefined : value;
  if (Array.isArray(value)) return value.map(v => scrub(v, config)).filter(v => v !== undefined);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, config)]).filter(([, v]) => v !== undefined));
  return value;
}

function cleanJson(kind, source, config) {
  if (!object(source)) throw new PpeError(502, 'ppe_invalid_response');
  if (source.camera_id !== undefined && source.camera_id !== config.cameraId) throw new PpeError(502, 'ppe_invalid_response');
  if (kind === 'results') return cleanResult(source, config);
  if (kind === 'history') {
    const out = {};
    for (const key of ['server_now_epoch_ms', 'latest_result_age_ms']) if (source[key] === null || finite(source[key])) out[key] = source[key];
    for (const key of ['state', 'alignment']) if (safeWord(source[key])) out[key] = source[key];
    out.results = source.state === 'fresh' && Array.isArray(source.results) ? source.results.slice(-100).map(value => cleanResult(value, config)) : [];
    return scrub(out, config);
  }
  if (kind === 'status') {
    const out = {};
    for (const key of ['connected', 'result_available', 'running', 'temporal_confirmation_enabled', 'field_accuracy_verified', 'production_accepted', 'diagnostic_jpeg_enabled', 'inference_worker_publishes_display_video']) if (typeof source[key] === 'boolean') out[key] = source[key];
    for (const key of ['decoded_frame_age_seconds', 'result_age_seconds', 'decoded_frames', 'decoded_frames_count', 'decoded_frame_count', 'processed_results_count', 'inference_errors_count', 'decode_errors_count', 'capture_epoch', 'sequence', 'last_accepted_sequence', 'inference_ms', 'uptime_seconds', 'inference_sampling_fps_cap', 'pending_frames', 'replaced_pending_frames', 'stale_drops']) if (source[key] === null || finite(source[key])) out[key] = source[key];
    for (const key of ['camera_id', 'view_id', 'source_stream', 'session_id', 'state', 'source_pts_status', 'source_pts_policy', 'mode', 'inference_backend']) if (source[key] === null || safeWord(source[key])) out[key] = source[key];
    if (Array.isArray(source.frame_size) && source.frame_size.length === 2 && source.frame_size.every(finite)) out.frame_size = [...source.frame_size];
    return scrub(out, config);
  }
  const out = {};
  for (const key of ['overlay_clock_offset_ms', 'max_alignment_error_ms', 'max_latest_result_age_ms', 'max_history_age_ms', 'max_video_frame_age_ms', 'history_window_seconds', 'history_max_results', 'rotation_degrees', 'overlay_max_age_ms', 'overlay_max_lag_ms', 'overlay_history_timeout_ms', 'video_frame_timeout_ms', 'history_poll_interval_ms', 'overlay_poll_interval_ms', 'source_width', 'source_height', 'expected_video_fps', 'history_limit', 'history_seconds', 'overlay_match_max_error_ms', 'overlay_sample_ttl_ms']) if (finite(source[key])) out[key] = source[key];
  for (const key of ['alignment_mode', 'coordinate_space', 'source_stream', 'camera_id', 'view_id', 'video_protocol']) if (safeWord(source[key])) out[key] = source[key];
  if (typeof source.timing_note === 'string' && source.timing_note.length <= 500 && !/[\r\n\0\\/]|(?:https?|rtsp|file):/i.test(source.timing_note)) out.timing_note = source.timing_note;
  for (const key of ['overlay_timing_verified', 'sensor_exposure_utc_verified', 'mirror_horizontal', 'temporal_confirmation_enabled']) if (typeof source[key] === 'boolean') out[key] = source[key];
  for (const key of ['frame_size', 'expected_frame_size', 'expected_video_size']) if (Array.isArray(source[key]) && source[key].length === 2 && source[key].every(finite)) out[key] = [...source[key]];
  return scrub(out, config);
}

function safeMediaPath(path) {
  if (typeof path !== 'string' || path.length > 1024 || /[\\\0\r\n]/.test(path)) throw new PpeError(400, 'ppe_invalid_media_path');
  let decoded;
  try { decoded = decodeURIComponent(path); } catch { throw new PpeError(400, 'ppe_invalid_media_path'); }
  const parts = decoded.split('/');
  if (parts.some(part => !/^[a-zA-Z0-9_.-]{1,160}$/.test(part) || part === '.' || part === '..') || !/\.(?:m3u8|ts|m4s|mp4|aac|vtt|key|cmfv|cmfa)$/i.test(parts.at(-1))) throw new PpeError(400, 'ppe_invalid_media_path');
  return parts.map(encodeURIComponent).join('/');
}

function rewriteUri(value, upstreamUrl, config, prefix) {
  if (!value.trim() || /[\\\0\r\n]/.test(value) || value.length > 4096) throw new PpeError(502, 'ppe_invalid_media_reference');
  // Reject encoded and literal traversal before URL normalization can hide it.
  const beforeQuery = value.split(/[?#]/)[0];
  let decoded;
  try { decoded = decodeURIComponent(beforeQuery); } catch { throw new PpeError(502, 'ppe_invalid_media_reference'); }
  if (decoded.includes('%') || decoded.split('/').some(p => p === '..' || p === '.')) throw new PpeError(502, 'ppe_invalid_media_reference');
  let url;
  try { url = new URL(value, upstreamUrl); } catch { throw new PpeError(502, 'ppe_invalid_media_reference'); }
  if (url.origin !== config.preview.origin || url.username || url.password || url.hash || !url.pathname.startsWith(MEDIA_ROOT)) throw new PpeError(502, 'ppe_invalid_media_reference');
  let path;
  try { path = safeMediaPath(url.pathname.slice(MEDIA_ROOT.length)); } catch { throw new PpeError(502, 'ppe_invalid_media_reference'); }
  let query = url.search;
  for (let i = 0; i < 3; i++) {
    if (config.forbidden.some(s => s && query.includes(s)) || /(?:https?|rtsp|file):\/\/|[\r\n\0]|\/(?:home|opt|etc|private)\//i.test(query)) throw new PpeError(502, 'ppe_invalid_media_reference');
    try { const decodedQuery = decodeURIComponent(query); if (decodedQuery === query) break; query = decodedQuery; } catch { break; }
  }
  return `${prefix}${path}${url.search}`;
}

function rewritePlaylist(text, url, config, prefix) {
  if (!text.startsWith('#EXTM3U')) throw new PpeError(502, 'ppe_invalid_playlist');
  const out = text.split(/\r?\n/).map(line => {
    if (!line || line.startsWith('#') && !line.includes('URI=')) return line;
    if (line.startsWith('#')) return line.replace(/URI="([^"]*)"/g, (_, uri) => `URI="${rewriteUri(uri, url, config, prefix)}"`);
    return rewriteUri(line.trim(), url, config, prefix);
  }).join('\n');
  if (config.forbidden.some(s => s && out.includes(s)) || /(?:https?:|rtsp:|file:)\/\//i.test(out)) throw new PpeError(502, 'ppe_invalid_playlist');
  return out;
}

export function mountPpeRoutes(app, { auth }, options = {}) {
  const config = loadConfig(options);
  const timeout = Math.min(15000, Math.max(100, options.requestTimeoutMs || 5000));
  const coalesceMs = Math.min(200, Math.max(0, options.coalesceMs ?? 125));
  const maxConcurrent = Math.min(12, Math.max(1, options.maxConcurrent || 6));
  let active = 0, generation = 0, closed = false;
  const shared = new Map();
  const activeRequests = new Set();
  const invalidate = () => { generation++; shared.clear(); };
  const canView = actor => actor?.role === 'admin' || !!(actor?.id && config?.allowedUserIds.has(actor.id));
  const prefix = config ? `/ppe-live/${config.cameraId}${MEDIA_ROOT}` : '';
  const fail = (res, error) => {
    if (res.headersSent) { res.destroy(); return; }
    if (!res.destroyed) res.status(error instanceof PpeError ? error.status : 503).json({ error: error instanceof PpeError ? error.code : 'ppe_unavailable' });
  };
  const guard = (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!canView(req.actor)) return res.status(403).json({ error: 'ppe_forbidden' });
    if (!config) return res.status(503).json({ error: 'ppe_not_configured' });
    if (req.params.id !== config.cameraId) return res.status(404).json({ error: 'ppe_camera_not_found' });
    next();
  };
  function startRequest(url, authorization, { method = 'GET', range, signal, onFailure } = {}) {
    if (closed) return Promise.reject(unavailable());
    if (active >= maxConcurrent) return Promise.reject(new PpeError(503, 'ppe_busy'));
    active++;
    return new Promise((resolve, reject) => {
      let released = false, request, timer;
      const release = () => { if (!released) { released = true; active--; activeRequests.delete(request); clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
      const abort = () => request?.destroy(unavailable());
      try {
        request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method, headers: { authorization, ...(range ? { range } : {}), 'accept-encoding': 'identity' }, lookup: url.hostname === 'localhost' ? (_hostname, _options, done) => done(null, '127.0.0.1', 4) : undefined }, response => {
          response.once('end', release); response.once('close', release);
          response.once('aborted', () => { if (!signal?.aborted) onFailure?.(); });
          response.once('error', () => { if (!signal?.aborted) onFailure?.(); });
          resolve({ response, request });
        });
      } catch { release(); reject(unavailable()); return; }
      activeRequests.add(request);
      timer = setTimeout(() => request.destroy(unavailable()), timeout);
      request.once('error', error => { if (!signal?.aborted) onFailure?.(); release(); reject(error); });
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else request.end();
    });
  }
  async function collect(response, limit) {
    const chunks = []; let size = 0;
    for await (const chunk of response) { size += chunk.length; if (size > limit) { response.destroy(); throw new PpeError(502, 'ppe_response_too_large'); } chunks.push(chunk); }
    return Buffer.concat(chunks);
  }
  function upstreamError(status) {
    if (status === 401 || status === 403) return new PpeError(503, 'ppe_upstream_unauthorized');
    if (status === 404) return new PpeError(502, 'ppe_upstream_not_found');
    return unavailable();
  }
  async function jsonRoute(req, res) {
    const kind = req.params.kind;
    const paths = { status: `/v1/cameras/${config.cameraId}/status`, results: `/v1/cameras/${config.cameraId}/results`, history: '/api/results-history', 'overlay-config': '/config.public.json' };
    if (!paths[kind]) return res.status(404).json({ error: 'ppe_path_not_found' });
    const key = kind;
    let entry = shared.get(key);
    if (entry?.expiresAt && entry.expiresAt <= Date.now()) { shared.delete(key); entry = null; }
    if (!entry) {
      const controller = new AbortController(), epoch = generation;
      entry = { controller, consumers: new Set(), done: false, expiresAt: 0, clientCancelled: false };
      shared.set(key, entry);
      entry.promise = (async () => {
        try {
          const api = kind === 'status' || kind === 'results';
          const { response } = await startRequest(new URL(paths[kind], api ? config.api : config.preview), api ? config.bearer : config.basic, { signal: controller.signal });
          if (response.statusCode !== 200) { response.resume(); throw upstreamError(response.statusCode); }
          const bytes = await collect(response, MAX_JSON);
          let source; try { source = JSON.parse(bytes.toString('utf8')); } catch { throw new PpeError(502, 'ppe_invalid_response'); }
          if (epoch !== generation) throw unavailable();
          const body = cleanJson(kind, source, config);
          if (kind === 'results') latestIsFresh(body);
          if (kind === 'status' && (body.connected === false || body.result_available === false) || kind === 'history' && body.state !== 'fresh') invalidate();
          else entry.expiresAt = Date.now() + coalesceMs;
          return body;
        } catch (error) { if (!entry.clientCancelled) invalidate(); throw error; }
        finally { entry.done = true; if (!entry.expiresAt && shared.get(key) === entry) shared.delete(key); }
      })();
    }
    const consumer = Symbol(); entry.consumers.add(consumer);
    const cancel = () => { entry.consumers.delete(consumer); if (!entry.done && !entry.consumers.size) { entry.clientCancelled = true; entry.controller.abort(); if (shared.get(key) === entry) shared.delete(key); } };
    res.once('close', cancel);
    try {
      const body = await entry.promise;
      if (kind === 'results') { try { latestIsFresh(body); } catch (error) { invalidate(); throw error; } }
      if (!res.destroyed) res.json(body);
    }
    catch (error) { fail(res, error); }
    finally { res.off('close', cancel); entry.consumers.delete(consumer); }
  }
  async function mediaRoute(req, res) {
    const controller = new AbortController();
    let clientCancelled = false, upstreamFailed = false;
    const cancel = () => { if (!res.writableEnded && !upstreamFailed) { clientCancelled = true; controller.abort(); } };
    res.once('close', cancel);
    try {
      const expectedPrefix = `/ppe-live/${config.cameraId}${MEDIA_ROOT}`;
      const raw = req.originalUrl.split('?')[0];
      if (!raw.startsWith(expectedPrefix)) throw new PpeError(400, 'ppe_invalid_media_path');
      const path = safeMediaPath(raw.slice(expectedPrefix.length));
      const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      if (query.length > 4096 || /[\r\n\0]/.test(query)) throw new PpeError(400, 'ppe_invalid_media_path');
      const range = req.headers.range;
      if (range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(range)) throw new PpeError(400, 'ppe_invalid_range');
      const url = new URL(`${MEDIA_ROOT}${path}${query}`, config.preview);
      const { response } = await startRequest(url, config.basic, { method: req.method, range, signal: controller.signal, onFailure: () => { upstreamFailed = true; } });
      const status = response.statusCode || 502;
      if ([301, 302, 303, 307, 308].includes(status)) {
        response.resume();
        const location = rewriteUri(response.headers.location || '', url, config, prefix);
        res.status(status).set('Location', location).end(); return;
      }
      if (![200, 206, 304, 416].includes(status)) { response.resume(); throw upstreamError(status); }
      const isPlaylist = path.toLowerCase().endsWith('.m3u8');
      if (isPlaylist && status === 206) { response.resume(); throw new PpeError(502, 'ppe_partial_playlist'); }
      if (req.method === 'HEAD' || status === 304 || status === 416) {
        response.resume(); res.status(status);
        copyMediaHeaders(response.headers, res, !isPlaylist);
        res.end(); return;
      }
      if (isPlaylist) {
        const body = rewritePlaylist((await collect(response, MAX_PLAYLIST)).toString('utf8'), url, config, prefix);
        res.status(status).type('application/vnd.apple.mpegurl').send(body); return;
      }
      const length = Number(response.headers['content-length']);
      if (Number.isFinite(length) && length > MAX_MEDIA) { response.destroy(); throw new PpeError(502, 'ppe_response_too_large'); }
      res.status(status); copyMediaHeaders(response.headers, res, true);
      let bytes = 0;
      const limit = new Transform({ transform(chunk, _encoding, done) { bytes += chunk.length; if (bytes > MAX_MEDIA) upstreamFailed = true; done(bytes > MAX_MEDIA ? new PpeError(502, 'ppe_response_too_large') : null, chunk); } });
      await pipeline(response, limit, res);
    } catch (error) { if (!clientCancelled || upstreamFailed) invalidate(); fail(res, error); }
    finally { res.off('close', cancel); }
  }
  app.get('/api/ppe/cameras', auth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const allowed = canView(req.actor);
    res.json({ configured: !!config, canView: allowed, cameras: config && allowed ? [{ id: config.cameraId, name: config.name, statusPath: `/api/ppe/cameras/${config.cameraId}/status`, resultsPath: `/api/ppe/cameras/${config.cameraId}/results`, historyPath: `/api/ppe/cameras/${config.cameraId}/history`, overlayConfigPath: `/api/ppe/cameras/${config.cameraId}/overlay-config`, hlsPath: `${prefix}index.m3u8` }] : [] });
  });
  app.get('/api/ppe/cameras/:id/:kind', auth, guard, jsonRoute);
  app.get('/ppe-live/:id/media/hls/raw-main/*files', auth, guard, mediaRoute);
  // Express automatically routes HEAD through GET while preserving req.method.
  return { configured: !!config, close() { closed = true; for (const entry of shared.values()) if (!entry.done) entry.controller.abort(); for (const request of activeRequests) request.destroy(unavailable()); shared.clear(); } };
}

function copyMediaHeaders(headers, res, contentLength) {
  const type = headers['content-type'];
  if (typeof type === 'string' && /^[a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+(?:;\s*charset=[a-zA-Z0-9_-]+)?$/.test(type)) res.set('Content-Type', type);
  else res.type('application/octet-stream');
  if (contentLength && /^\d+$/.test(headers['content-length'] || '') && Number(headers['content-length']) <= MAX_MEDIA) res.set('Content-Length', headers['content-length']);
  if (/^bytes (?:\d+-\d+|\*)\/(?:\d+|\*)$/.test(headers['content-range'] || '')) res.set('Content-Range', headers['content-range']);
  if (headers['accept-ranges'] === 'bytes') res.set('Accept-Ranges', 'bytes');
}
