import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { createServer as createSecureServer, globalAgent as httpsAgent } from 'node:https';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import express from 'express';
import { mountPpeRoutes } from '../server/ppe.mjs';
import { openStore } from '../server/store.mjs';
import { upstreamBase } from '../server/camera4g-upstream.mjs';

const wait = ms => new Promise(done => setTimeout(done, ms));
const digest = value => createHash('sha256').update(value).digest('hex');
const result = () => ({
  schema_version: 1, camera_id: 'camera-01', view_id: '4g-main-view', source_stream: 'MAIN',
  session_id: 'session-one', capture_epoch: 1, sequence: 7, frame_size: [2560, 1440], coordinate_space: 'oriented_source_pixels',
  rotation_degrees: 0, mirror_horizontal: false, received_at_utc: new Date().toISOString(), processed_at_utc: new Date().toISOString(),
  source_pts_status: 'unstable', source_pts_policy: 'observe', source_pts_seconds: 1.5, inference_ms: 156,
  temporal_confirmation_enabled: false, sensor_exposure_utc_verified: false, field_accuracy_verified: false,
  processed_results_count: 11, detection_tasks: ['safety_helmet', 'reflective_vest'], frame_jpeg_path: null,
  detections: [{ label: 'no-hardhat', confidence: .87, box: [750, 100, 1200, 500] }, { label: 'safety vest', confidence: .91, box: [650, 500, 1300, 1100] }, { label: 'person', confidence: .9, box: [0, 0, 1500, 1440] }],
  persons: [{ box: [500, 100, 1500, 1400], confidence: .9, track_id: 1, tracking_epoch: 'tracking-one', tracking_status: 'observed', observation_age_seconds: 0,
    observed_states: { helmet: 'not_worn', vest: 'worn' }, raw_states: { helmet: 'unknown', vest: 'unknown' }, states: { helmet: 'unknown', vest: 'unknown' },
    reasons: { helmet: 'stream_timing_not_accepted', vest: 'stream_timing_not_accepted' }, evidence: { helmet: [{ label: 'no-hardhat', confidence: .87, box: [750, 100, 1200, 500] }], vest: [] } }],
});

async function fixture(t, extra = {}) {
  const upstream = extra.tls ? createSecureServer(extra.tls) : createServer(), seen = [], state = { code: 200, delay: 0, slow: false, ended: 0, cancelled: 0, custom: null };
  const secret = randomBytes(24).toString('hex'), password = randomBytes(24).toString('hex');
  await new Promise(done => upstream.listen(0, '127.0.0.1', done));
  const upstreamBase = `${extra.tls ? 'https' : 'http'}://127.0.0.1:${upstream.address().port}`;
  const basic = 'Basic ' + Buffer.from('viewer:' + password).toString('base64');
  upstream.on('request', async (req, res) => {
    seen.push({ path: req.url, authorization: req.headers.authorization, cookie: req.headers.cookie, range: req.headers.range, method: req.method });
    const path = req.url.split('?')[0];
    const correct = path.startsWith('/v1/') ? req.headers.authorization === `Bearer ${secret}` : req.headers.authorization === basic;
    if (!correct) { res.writeHead(401).end(secret + password); return; }
    if (state.custom && await state.custom(req, res)) return;
    if (state.delay) await wait(state.delay);
    if (res.destroyed) return;
    if (path.startsWith('/v1/') || path.startsWith('/api/') || path === '/config.public.json') {
      const status = path.endsWith('/status');
      if (state.code !== 200) { res.writeHead(state.code, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'result_unavailable', credentials: secret, path: '/private/env-file' })); return; }
      const r = result(); r.private_token = secret; r.media_read_urls = { url: `${upstreamBase}/secret?token=${password}` };
      r.persons[0].identity = { name: 'not-an-identity', credential: password }; r.persons[0].evidence.helmet[0].upstream_url = upstreamBase;
      let value;
      if (status) value = { camera_id: 'camera-01', source_stream: 'MAIN', connected: !state.offline, result_available: !state.offline, decoded_frame_age_seconds: state.offline ? null : .1, processed_results_count: 11, production_accepted: false, field_accuracy_verified: false, media_read_urls: [upstreamBase], private_token: secret, error: secret };
      else if (path.endsWith('/results')) value = r;
      else if (path.endsWith('/results-history')) value = { server_now_epoch_ms: Date.now(), state: state.offline ? 'unavailable' : 'fresh', latest_result_age_ms: state.offline ? null : 25, alignment: 'decoder_receive_time_estimate_not_sensor_exposure', results: [{ ...r, decoder_received_epoch_ms: Date.now() - 25 }], internal_path: '/private/env-file', private_token: secret };
      else value = { camera_id: 'camera-01', alignment_mode: 'receive_time_estimate', overlay_timing_verified: false, overlay_clock_offset_ms: 0, expected_video_fps: 15, expected_video_size: [2560, 1440], history_limit: 100, history_seconds: 10, overlay_match_max_error_ms: 500, overlay_sample_ttl_ms: 1000, video_protocol: 'hls', stream_path: upstreamBase, timing_note: secret, private_token: secret };
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'private_session=' + password, 'Cache-Control': 'no-store' }).end(JSON.stringify(value)); return;
    }
    const media = path.slice('/media/hls/raw-main/'.length);
    if (media === 'index.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end(`#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/audio.m3u8?session=public"\n#EXT-X-STREAM-INF:BANDWIDTH=1000000\nvariant/main.m3u8?session=public\n`); return;
    }
    if (media === 'variant/main.m3u8' || media === 'audio/audio.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }).end(`#EXTM3U\n#EXT-X-MAP:URI="${upstreamBase}/media/hls/raw-main/init.mp4?session=public"\n#EXT-X-KEY:METHOD=AES-128,URI="${upstreamBase}/media/hls/raw-main/key.key"\n#EXTINF:1.0,\nsegment.m4s?part=2\n`); return;
    }
    if (media === 'redirect.ts') { res.writeHead(302, { Location: `${upstreamBase}/media/hls/raw-main/variant/segment.m4s?part=2`, 'Set-Cookie': 'private=' + password }).end(); return; }
    if (media === 'external.ts') { res.writeHead(302, { Location: 'https://external.invalid/media/hls/raw-main/segment.ts' }).end(); return; }
    if (media === 'external.m3u8') { res.end('#EXTM3U\nhttps://external.invalid/file.ts\n'); return; }
    if (media === 'traversal.m3u8') { res.end('#EXTM3U\n../file.ts\n'); return; }
    if (media === 'encoded.m3u8') { res.end('#EXTM3U\n%252e%252e/file.ts\n'); return; }
    if (media === 'private.m3u8') { res.end(`#EXTM3U\nsegment.ts?token=${encodeURIComponent(secret)}\n`); return; }
    if (media === 'slow.ts') {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      res.write(Buffer.alloc(128));
      const timer = setInterval(() => res.write(Buffer.alloc(128)), 25);
      res.once('close', () => { clearInterval(timer); state.cancelled++; });
      return;
    }
    const bytes = Buffer.from('abcdefghijkl');
    if (req.headers.range === 'bytes=2-5') { res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 2-5/12', 'Content-Length': 4, 'Accept-Ranges': 'bytes' }).end(req.method === 'HEAD' ? undefined : bytes.subarray(2, 6)); return; }
    if (req.headers.range === 'bytes=100-200') { res.writeHead(416, { 'Content-Range': 'bytes */12' }).end(); return; }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length, 'Accept-Ranges': 'bytes' }).end(req.method === 'HEAD' ? undefined : bytes);
  });
  const store = openStore(':memory:');
  for (const [id, role] of [['admin-user', 'admin'], ['operator-user', 'operator'], ['viewer-user', 'viewer'], ['allowed-user', 'operator']]) {
    store.db.prepare('INSERT INTO users(id,username,name,role,hash,created_at) VALUES(?,?,?,?,?,?)').run(id, id, id, role, 'isolated-unused-password', new Date().toISOString());
    store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(id), id, Date.now() + 60000);
  }
  const auth = (req, res, next) => {
    const session = req.headers.cookie?.split('=')[1] || '';
    const actor = store.db.prepare('SELECT u.id,u.role FROM users u JOIN sessions s ON u.id=s.user_id WHERE s.hash=? AND s.expires_at>? AND u.active=1').get(digest(session), Date.now());
    if (!actor) return res.status(401).json({ error: 'session_required' });
    req.actor = actor; next();
  };
  const app = express(), server = createServer(app);
  const config = { cameraId: 'camera-01', cameraName: '4G施工安全摄像头', apiBaseUrl: upstreamBase, previewBaseUrl: upstreamBase, cameraToken: secret, previewUsername: 'viewer', previewPassword: password, allowedUserIds: ['allowed-user'] };
  const adapter = mountPpeRoutes(app, { auth }, { development: true, config, ...extra });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    adapter.close(); server.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(done => server.close(done)), new Promise(done => upstream.close(done))]);
    assert.equal(store.db.prepare("SELECT COUNT(*) n FROM records").get().n, 0, 'Reads must not manufacture alarms, identities or attendance');
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM alarm_notifications').get().n, 0);
    store.close();
  });
  const call = (path, actor = 'admin-user', options = {}) => fetch(base + path, { headers: { ...(actor ? { cookie: `fixture_session=${actor}` } : {}), ...(options.headers || {}) }, ...options });
  const noSecrets = value => { for (const hidden of [secret, password, Buffer.from('viewer:' + password).toString('base64'), upstreamBase, '/private/env-file', 'private_token', 'media_read_urls', 'upstream_url']) assert.ok(!JSON.stringify(value).includes(hidden), `Private upstream data leaked: ${hidden.slice(0, 20)}`); };
  return { base, call, seen, state, secret, password, config, store, adapter, noSecrets };
}

test('PPE login and camera permissions apply to discovery, JSON, playlists, segments and HEAD', async t => {
  const f = await fixture(t);
  const paths = ['/api/ppe/cameras', '/api/ppe/cameras/camera-01/status', '/api/ppe/cameras/camera-01/results', '/api/ppe/cameras/camera-01/history', '/api/ppe/cameras/camera-01/overlay-config', '/ppe-live/camera-01/media/hls/raw-main/index.m3u8', '/ppe-live/camera-01/media/hls/raw-main/init.mp4'];
  for (const path of paths) assert.equal((await f.call(path, '')).status, 401);
  for (const actor of ['operator-user', 'viewer-user']) {
    const list = await (await f.call(paths[0], actor)).json(); assert.equal(list.canView, false); assert.deepEqual(list.cameras, []);
    for (const path of paths.slice(1)) assert.equal((await f.call(path, actor)).status, 403);
    assert.equal((await f.call(paths.at(-1), actor, { method: 'HEAD' })).status, 403);
  }
  assert.equal(f.seen.length, 0);
  for (const actor of ['admin-user', 'allowed-user']) {
    const list = await (await f.call(paths[0], actor)).json(); assert.equal(list.canView, true); assert.equal(list.configured, true);
    assert.equal(list.cameras[0].hlsPath, '/ppe-live/camera-01/media/hls/raw-main/index.m3u8'); f.noSecrets(list);
    assert.equal((await f.call(paths[1], actor)).status, 200);
  }
  assert.equal((await f.call('/api/ppe/cameras/other/status')).status, 404);
  f.store.db.prepare("UPDATE users SET active=0 WHERE id='allowed-user'").run();
  assert.equal((await f.call(paths.at(-1), 'allowed-user')).status, 401);
});

test('PPE reads preserve instant anonymous observations and exact upstream credentials without exposing internal URLs', async t => {
  const f = await fixture(t);
  const r = await f.call('/api/ppe/cameras/camera-01/results'); assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store'); assert.equal(r.headers.get('set-cookie'), null);
  const value = await r.json(); f.noSecrets(value);
  assert.equal(value.source_stream, 'MAIN'); assert.equal(value.temporal_confirmation_enabled, false); assert.equal(value.sensor_exposure_utc_verified, false);
  assert.deepEqual(value.detections.map(v => v.label), ['no-hardhat', 'safety vest']);
  assert.deepEqual(value.persons[0].observed_states, { helmet: 'not_worn', vest: 'worn' });
  assert.deepEqual(value.persons[0].states, { helmet: 'unknown', vest: 'unknown' });
  assert.equal(value.persons[0].reasons.helmet, 'stream_timing_not_accepted'); assert.equal(value.persons[0].identity, undefined);
  const h = await (await f.call('/api/ppe/cameras/camera-01/history')).json(); f.noSecrets(h); assert.equal(h.state, 'fresh'); assert.ok(h.results[0].decoder_received_epoch_ms);
  const c = await (await f.call('/api/ppe/cameras/camera-01/overlay-config')).json(); f.noSecrets(c);
  assert.deepEqual(c.expected_video_size, [2560, 1440]); assert.equal(c.overlay_match_max_error_ms, 500); assert.equal(c.overlay_sample_ttl_ms, 1000); assert.equal(c.overlay_timing_verified, false);
  for (const seen of f.seen) { assert.equal(seen.cookie, undefined); assert.equal(seen.authorization, seen.path.startsWith('/v1/') ? `Bearer ${f.secret}` : 'Basic ' + Buffer.from('viewer:' + f.password).toString('base64')); }
});

test('simultaneous viewers share bounded reads and a 503/401/offline status withdraws earlier successful cache', async t => {
  const f = await fixture(t, { coalesceMs: 150 }); f.state.delay = 30;
  const responses = await Promise.all(Array.from({ length: 12 }, () => f.call('/api/ppe/cameras/camera-01/results')));
  assert.ok(responses.every(r => r.status === 200)); assert.equal(f.seen.length, 1);
  assert.equal((await f.call('/api/ppe/cameras/camera-01/results')).status, 200); assert.equal(f.seen.length, 1);
  f.state.code = 503;
  assert.equal((await f.call('/api/ppe/cameras/camera-01/status')).status, 503);
  const failed = await f.call('/api/ppe/cameras/camera-01/results'); assert.equal(failed.status, 503); f.noSecrets(await failed.json()); assert.equal(f.seen.length, 3);
  f.state.code = 401;
  const authFailure = await f.call('/api/ppe/cameras/camera-01/results'); assert.equal(authFailure.status, 503); assert.deepEqual(await authFailure.json(), { error: 'ppe_upstream_unauthorized' });
  f.state.code = 200; f.state.offline = true;
  const status = await (await f.call('/api/ppe/cameras/camera-01/status')).json(); assert.equal(status.connected, false); assert.equal(status.result_available, false); assert.equal(status.decoded_frame_age_seconds, null);
  assert.equal(status.production_accepted, false); assert.equal(status.field_accuracy_verified, false);
  const history = await (await f.call('/api/ppe/cameras/camera-01/history')).json(); assert.equal(history.state, 'unavailable'); assert.deepEqual(history.results, []);
});

test('HLS master/sublist/map/key/segments use one same-origin authenticated prefix and preserve query, Range and HEAD', async t => {
  const f = await fixture(t), prefix = '/ppe-live/camera-01/media/hls/raw-main/';
  const master = await (await f.call(prefix + 'index.m3u8?window=latest')).text(); f.noSecrets(master);
  assert.match(master, new RegExp(prefix + 'audio/audio.m3u8\\?session=public')); assert.match(master, new RegExp(prefix + 'variant/main.m3u8\\?session=public'));
  const variant = await (await f.call(prefix + 'variant/main.m3u8?session=public')).text(); f.noSecrets(variant);
  assert.match(variant, new RegExp(`URI="${prefix}init.mp4\\?session=public"`)); assert.match(variant, new RegExp(`URI="${prefix}key.key"`)); assert.match(variant, new RegExp(prefix + 'variant/segment.m4s\\?part=2'));
  const init = await f.call(prefix + 'init.mp4?session=public', 'admin-user', { headers: { cookie: 'fixture_session=admin-user', Range: 'bytes=2-5' } });
  assert.equal(init.status, 206); assert.equal(init.headers.get('content-range'), 'bytes 2-5/12'); assert.equal(init.headers.get('content-length'), '4'); assert.equal(await init.text(), 'cdef');
  const head = await f.call(prefix + 'variant/segment.m4s?part=2', 'admin-user', { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.headers.get('content-length'), '12'); assert.equal(await head.text(), '');
  const unsatisfiable = await f.call(prefix + 'init.mp4', 'admin-user', { headers: { cookie: 'fixture_session=admin-user', Range: 'bytes=100-200' } }); assert.equal(unsatisfiable.status, 416); assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */12');
  assert.ok(f.seen.some(v => v.path === '/media/hls/raw-main/index.m3u8?window=latest'));
  assert.ok(f.seen.some(v => v.range === 'bytes=2-5'));
});

test('HLS redirects are rewritten; external, traversal, double-encoded and secret-bearing references are rejected', async t => {
  const f = await fixture(t), prefix = '/ppe-live/camera-01/media/hls/raw-main/';
  const redirect = await f.call(prefix + 'redirect.ts', 'admin-user', { redirect: 'manual' });
  assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), prefix + 'variant/segment.m4s?part=2'); assert.equal(redirect.headers.get('set-cookie'), null);
  const followed = await f.call(prefix + 'redirect.ts'); assert.equal(await followed.text(), 'abcdefghijkl');
  for (const file of ['external.ts', 'external.m3u8', 'traversal.m3u8', 'encoded.m3u8', 'private.m3u8']) {
    const r = await f.call(prefix + file); assert.equal(r.status, 502, file); f.noSecrets(await r.json());
  }
  async function raw(path) {
    return new Promise((resolve, reject) => { const r = request(f.base + prefix + path, { headers: { cookie: 'fixture_session=admin-user' } }, res => { const chunks = []; res.on('data', b => chunks.push(b)); res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString() })); }); r.on('error', reject); r.end(); });
  }
  const before = f.seen.length;
  for (const path of ['%252e%252e/secret.ts', '%2e%2e%2fsecret.ts', 'bad%5csecret.ts', 'bad%00secret.ts', 'secret.env']) assert.equal((await raw(path)).status, 400, path);
  assert.equal(f.seen.length, before);
  assert.equal((await f.call(prefix + 'init.mp4', 'admin-user', { headers: { cookie: 'fixture_session=admin-user', Range: 'bytes=0-1,3-4' } })).status, 400);
});

test('PPE bounded timeout/concurrency/response size errors have no private diagnostics or stale result fallback', async t => {
  const f = await fixture(t, { requestTimeoutMs: 120, maxConcurrent: 1, coalesceMs: 0 });
  f.state.delay = 400;
  const pending = f.call('/api/ppe/cameras/camera-01/results'); await wait(20);
  const busy = await f.call('/api/ppe/cameras/camera-01/history'); assert.equal(busy.status, 503); assert.deepEqual(await busy.json(), { error: 'ppe_busy' });
  const timed = await pending; assert.equal(timed.status, 503); f.noSecrets(await timed.json());
  f.state.delay = 0;
  f.state.custom = (req, res) => { if (req.url.endsWith('/results')) { res.writeHead(200).end('x'.repeat(2 * 1024 * 1024 + 1)); return true; } return false; };
  const huge = await f.call('/api/ppe/cameras/camera-01/results'); assert.equal(huge.status, 502); assert.deepEqual(await huge.json(), { error: 'ppe_response_too_large' });
  f.state.custom = null;
  assert.equal((await f.call('/api/ppe/cameras/camera-01/results')).status, 200);
});

test('last viewer disconnection cancels upstream JSON and streaming media instead of leaving polling work', async t => {
  const f = await fixture(t, { requestTimeoutMs: 4000 });
  f.state.custom = (req, res) => {
    if (!req.url.endsWith('/results')) return false;
    const timer = setTimeout(() => res.end(JSON.stringify(result())), 3000);
    res.once('close', () => { clearTimeout(timer); f.state.cancelled++; });
    return true;
  };
  const upstreamBefore = f.state.cancelled;
  await new Promise((done, reject) => {
    const r = request(f.base + '/api/ppe/cameras/camera-01/results', { headers: { cookie: 'fixture_session=admin-user' } });
    r.on('error', () => done()); r.end(); setTimeout(() => { r.destroy(); done(); }, 75);
    setTimeout(() => reject(Error('cancellation_check_timeout')), 1200).unref();
  });
  await wait(80); assert.ok(f.state.cancelled > upstreamBefore);
  await new Promise((done, reject) => {
    const r = request(f.base + '/ppe-live/camera-01/media/hls/raw-main/slow.ts', { headers: { cookie: 'fixture_session=admin-user' } }, res => res.once('data', () => { r.destroy(); done(); }));
    r.on('error', reject); r.end();
  });
  await wait(80); assert.ok(f.state.cancelled > upstreamBefore + 1);
});

test('a disconnected viewer does not cancel a shared request still needed by another authorized viewer', async t => {
  const f = await fixture(t, { coalesceMs: 0 }); f.state.delay = 150;
  const first = request(f.base + '/api/ppe/cameras/camera-01/results', { headers: { cookie: 'fixture_session=admin-user' } });
  first.on('error', () => {}); first.end();
  await wait(25);
  const second = f.call('/api/ppe/cameras/camera-01/results', 'allowed-user');
  await wait(25); first.destroy();
  const remaining = await second; assert.equal(remaining.status, 200); assert.equal((await remaining.json()).sequence, 7);
  assert.equal(f.seen.filter(v => v.path.endsWith('/results')).length, 1);
});

test('cancelling the last results viewer leaves another viewer history request fresh and aborts only its own upstream request', async t => {
  const f = await fixture(t, { coalesceMs: 0 }); f.state.delay = 250;
  f.state.custom = (req, res) => {
    if (!req.url.endsWith('/results')) return false;
    const timer = setTimeout(() => res.end(JSON.stringify(result())), 250);
    res.once('close', () => { clearTimeout(timer); if (!res.writableEnded) f.state.cancelled++; });
    return true;
  };
  const first = request(f.base + '/api/ppe/cameras/camera-01/results', { headers: { cookie: 'fixture_session=admin-user' } });
  first.on('error', () => {}); first.end();
  await wait(25);
  const history = f.call('/api/ppe/cameras/camera-01/history', 'allowed-user');
  await wait(25); first.destroy();
  const remaining = await history; assert.equal(remaining.status, 200); assert.equal((await remaining.json()).state, 'fresh');
  assert.equal(f.seen.length, 2); assert.equal(f.state.cancelled, 1);
});

test('cancelling media playback does not invalidate another viewer simultaneous healthy JSON request', async t => {
  const f = await fixture(t, { coalesceMs: 0 }); f.state.delay = 150;
  let history;
  await new Promise((done, reject) => {
    const video = request(f.base + '/ppe-live/camera-01/media/hls/raw-main/slow.ts', { headers: { cookie: 'fixture_session=admin-user' } }, res => {
      res.once('data', () => {
        history = f.call('/api/ppe/cameras/camera-01/history', 'allowed-user');
        setTimeout(() => { video.destroy(); done(); }, 25);
      });
    });
    video.on('error', reject); video.end();
  });
  const remaining = await history; assert.equal(remaining.status, 200); assert.equal((await remaining.json()).state, 'fresh');
  assert.equal(f.state.cancelled, 1);
});

test('old inputs and another camera identity are rejected rather than being exposed as this camera live observations', async t => {
  const f = await fixture(t, { coalesceMs: 0 });
  let mode = 'old';
  f.state.custom = (req, res) => {
    if (!req.url.endsWith('/results')) return false;
    const r = result();
    if (mode === 'old') r.received_at_utc = new Date(Date.now() - 6000).toISOString();
    else r.camera_id = 'unauthorized-other-camera';
    res.end(JSON.stringify(r)); return true;
  };
  const old = await f.call('/api/ppe/cameras/camera-01/results'); assert.equal(old.status, 503); assert.deepEqual(await old.json(), { error: 'ppe_unavailable' });
  mode = 'other';
  const other = await f.call('/api/ppe/cameras/camera-01/results'); assert.equal(other.status, 502); assert.deepEqual(await other.json(), { error: 'ppe_invalid_response' });
});

test('latest results require schema/session/epoch/sequence/valid receive time while fresh history retains valid older frames', async t => {
  const f = await fixture(t, { coalesceMs: 0 });
  let mutate = () => {};
  let historyFrames = null;
  f.state.custom = (req, res) => {
    if (req.url.endsWith('/results')) { const r = result(); mutate(r); res.end(JSON.stringify(r)); return true; }
    if (req.url.endsWith('/results-history') && historyFrames) { res.end(JSON.stringify({ state: 'fresh', server_now_epoch_ms: Date.now(), latest_result_age_ms: 0, alignment: 'decoder_receive_time_estimate_not_sensor_exposure', results: historyFrames() })); return true; }
    return false;
  };
  const invalid = [
    ['missing schema', r => { delete r.schema_version; }], ['unsupported schema', r => { r.schema_version = 2; }],
    ['missing session', r => { delete r.session_id; }], ['empty session', r => { r.session_id = ''; }], ['blank session', r => { r.session_id = '   '; }],
    ['missing epoch', r => { delete r.capture_epoch; }], ['negative epoch', r => { r.capture_epoch = -1; }], ['fractional epoch', r => { r.capture_epoch = 1.1; }],
    ['missing sequence', r => { delete r.sequence; }], ['negative sequence', r => { r.sequence = -1; }], ['unsafe sequence', r => { r.sequence = Number.MAX_SAFE_INTEGER + 1; }],
    ['missing receive time', r => { delete r.received_at_utc; }], ['invalid receive time', r => { r.received_at_utc = 'not-a-timestamp'; }],
    ['invalid calendar day', r => { r.received_at_utc = '2026-02-30T08:00:00.000Z'; }],
    ['future input', r => { r.received_at_utc = new Date(Date.now() + 1000).toISOString(); }],
    ['credential reflected as identity', r => { r.session_id = f.secret; }],
  ];
  for (const [name, mutation] of invalid) {
    mutate = mutation;
    const response = await f.call('/api/ppe/cameras/camera-01/results'); assert.equal(response.status, 502, name); assert.deepEqual(await response.json(), { error: 'ppe_invalid_response' }, name);
  }
  mutate = r => { r.received_at_utc = new Date().toISOString().replace('Z', '+00:00'); r.capture_epoch = 0; r.sequence = 0; r.new_diagnostic_field = 'new version tolerated'; };
  const valid = await f.call('/api/ppe/cameras/camera-01/results'); assert.equal(valid.status, 200); const body = await valid.json(); assert.equal(body.capture_epoch, 0); assert.match(body.received_at_utc, /\+00:00$/);
  historyFrames = () => { const older = result(); older.received_at_utc = new Date(Date.now() - 6500).toISOString(); older.decoder_received_epoch_ms = Date.parse(older.received_at_utc); return [older, { ...result(), sequence: 8, decoder_received_epoch_ms: Date.now() }]; };
  const history = await f.call('/api/ppe/cameras/camera-01/history'); assert.equal(history.status, 200); assert.equal((await history.json()).results.length, 2, 'History frames must not incorrectly inherit latest-results four-second TTL');
  historyFrames = () => { const r = result(); delete r.session_id; return [r]; };
  const invalidHistory = await f.call('/api/ppe/cameras/camera-01/history'); assert.equal(invalidHistory.status, 502); assert.deepEqual(await invalidHistory.json(), { error: 'ppe_invalid_response' });
});

test('missing or invalid private config stays unavailable; remote cleartext and nonfixed loopback HTTP are refused', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ppe-config-test-'));
  t.after(() => { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); rmSync(directory, { recursive: true, force: true }); });
  const prior = process.env.PPE_CONFIG_FILE; delete process.env.PPE_CONFIG_FILE;
  t.after(() => { if (prior === undefined) delete process.env.PPE_CONFIG_FILE; else process.env.PPE_CONFIG_FILE = prior; });
  const f = await fixture(t, { config: null });
  assert.equal((await (await f.call('/api/ppe/cameras')).json()).configured, false);
  assert.equal((await f.call('/api/ppe/cameras/camera-01/status')).status, 503);
  const path = join(directory, 'private.json'); writeFileSync(path, JSON.stringify({ ...f.config, apiBaseUrl: 'http://external.invalid:28878' })); process.env.PPE_CONFIG_FILE = path;
  const bad = await fixture(t, { config: null, development: false }); assert.equal(bad.adapter.configured, false); assert.equal(bad.seen.length, 0);
  writeFileSync(path, JSON.stringify(f.config));
  const privateFile = await fixture(t, { config: null }); assert.equal(privateFile.adapter.configured, true, 'Absolute private configuration is supported without embedding credentials in source');
  assert.equal((await (await privateFile.call('/api/ppe/cameras')).json()).configured, true);
  const fixedPort = await fixture(t, { development: false }); assert.equal(fixedPort.adapter.configured, false, 'A test listener port must never become a production target');
});

test('252 accepts explicit GPU HTTPS origins while rejecting cleartext remote addresses, credentials and URL paths', () => {
  assert.equal(upstreamBase('https://gpu.example.com:29478').origin, 'https://gpu.example.com:29478');
  assert.equal(upstreamBase('https://192.168.1.200:29478').hostname, '192.168.1.200');
  assert.equal(upstreamBase('http://127.0.0.1:28878', { loopbackPort: 28878 }).port, '28878');
  for (const value of [undefined, 'http://gpu.example.com:29478', 'http://192.168.1.200:28878', 'https://user:pass@gpu.example.com', 'https://gpu.example.com/api', 'https://gpu.example.com/?url=x', 'https://gpu.example.com/#x', 'https://0.0.0.0:29478']) assert.throws(() => upstreamBase(value));
});

test('GPU TLS upstream verifies certificates and proxies JSON and HLS with server-side credentials', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'ppe-tls-test-'));
  t.after(() => { assert.equal(dirname(resolve(directory)), resolve(tmpdir())); rmSync(directory, { recursive: true, force: true }); });
  const cert = join(directory, 'cert.pem'), key = join(directory, 'key.pem');
  const openssl = process.env.OPENSSL_BINARY || (process.platform === 'win32' ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl');
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', key, '-out', cert], { stdio: 'ignore' });
  const f = await fixture(t, { development: false, tls: { key: readFileSync(key), cert: readFileSync(cert) } });
  assert.equal(f.adapter.configured, true);
  assert.equal((await f.call('/api/ppe/cameras/camera-01/status')).status, 503, 'An untrusted GPU certificate must be rejected');
  assert.equal(f.seen.length, 0);
  const prior = httpsAgent.options.ca;
  httpsAgent.options.ca = readFileSync(cert);
  t.after(() => { if (prior === undefined) delete httpsAgent.options.ca; else httpsAgent.options.ca = prior; });
  const response = await f.call('/api/ppe/cameras/camera-01/status');
  assert.equal(response.status, 200); f.noSecrets(await response.json());
  const playlist = await f.call('/ppe-live/camera-01/media/hls/raw-main/index.m3u8');
  assert.equal(playlist.status, 200);
  const body = await playlist.text(); f.noSecrets(body);
  assert.ok(body.includes('/ppe-live/camera-01/media/hls/raw-main/'));
  assert.equal(f.seen[0].authorization, `Bearer ${f.secret}`);
  assert.equal(f.seen[1].authorization, 'Basic ' + Buffer.from('viewer:' + f.password).toString('base64'));
});
