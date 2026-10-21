import test from 'node:test';
import assert from 'node:assert/strict';
import { businessPath, containGeometry, displayDetection, equipmentState, historyReceipt,
  personKey, resultKey, selectOverlay } from '../src/ppe-overlay.ts';

const result = (time, extra = {}) => ({ schema_version: 1, camera_id: 'camera-01', session_id: 'current',
  capture_epoch: 2, sequence: time, decoder_received_epoch_ms: time, received_at_utc: new Date(time).toISOString(),
  source_stream: 'MAIN', coordinate_space: 'oriented_source_pixels', frame_size: [2560, 1440],
  rotation_degrees: 0, mirror_horizontal: false, detections: [], persons: [], ...extra });
const input = (results, extra = {}) => ({ cameraId: 'camera-01', receipt: historyReceipt({
  server_now_epoch_ms: 10000, state: 'fresh', latest_result_age_ms: 100, results,
}, 9900, 10100, 1000), config: {}, nowMonoMs: 1050, playingDateMs: 9500,
  paused: false, waiting: false, enabled: true, lastFrameMonoMs: 1030, videoWidth: 2560, videoHeight: 1440, ...extra });

test('playing frames select an older result rather than the newest JSON, never a future result', () => {
  const past = result(9400), latest = result(9900);
  const chosen = selectOverlay(input([past, result(9550), latest]));
  assert.equal(chosen.result, past); assert.equal(chosen.errorMs, 100);
});
test('server clock uses request midpoint and configured offset before matching', () => {
  const past = result(10000);
  const receipt = historyReceipt({ server_now_epoch_ms: 10500, state: 'fresh', latest_result_age_ms: 100,
    results: [past, result(10400)] }, 9950, 10050, 1000);
  assert.equal(receipt.clockDeltaMs, 500);
  const chosen = selectOverlay(input([], { receipt, playingDateMs: 9475, config: { overlay_clock_offset_ms: 25 } }));
  assert.equal(chosen.result, past); assert.equal(chosen.errorMs, 0);
});
test('a new session or capture epoch never reuses the old buffered session', () => {
  const old = result(9400, { session_id: 'old', capture_epoch: 1 });
  const latest = result(9900);
  assert.equal(selectOverlay(input([old, latest])).reason, 'no_match');
  assert.equal(selectOverlay(input([result(9400, { capture_epoch: 1 }), latest])).reason, 'no_match');
});
test('empty, unavailable and expired history withdraws boxes and person states', () => {
  assert.equal(selectOverlay(input([])).reason, 'history_unavailable');
  const base = input([result(9400), result(9900)]);
  base.receipt.data.state = 'unavailable';
  assert.equal(selectOverlay(base).result, null);
  assert.equal(selectOverlay(input([result(9400), result(9900)], { nowMonoMs: 2050, lastFrameMonoMs: 2030 })).reason, 'history_stale');
});
test('timing configuration may tighten but cannot relax the 500 and 1000 ms limits', () => {
  assert.equal(selectOverlay(input([result(8999), result(9900)], { config: { overlay_match_max_error_ms: 5000 } })).reason, 'no_match');
  assert.equal(selectOverlay(input([result(9200), result(9900)], { config: { overlay_match_max_error_ms: 100 } })).reason, 'no_match');
  assert.equal(selectOverlay(input([result(8950)], { config: { overlay_sample_ttl_ms: 4000 } })).reason, 'input_stale');
  assert.equal(selectOverlay(input([result(9400), result(9900)], { config: { overlay_sample_ttl_ms: 100 } })).reason, 'input_stale');
});
test('paused, stalled, missing-anchor and 750 ms frame starvation cannot retain a match', () => {
  for (const [extra, reason] of [[{ paused: true }, 'paused'], [{ waiting: true }, 'waiting'],
    [{ playingDateMs: null }, 'no_anchor'], [{ lastFrameMonoMs: 299 }, 'frame_stale'], [{ enabled: false }, 'disabled']]) {
    const match = selectOverlay(input([result(9400), result(9900)], extra));
    assert.equal(match.reason, reason); assert.equal(match.result, null);
  }
});
test('frame dimensions, source coordinates, rotation and mirror must agree', () => {
  for (const [patch, reason] of [[{ frame_size: [1920, 1080] }, 'size'], [{ rotation_degrees: 90 }, 'orientation'],
    [{ mirror_horizontal: true }, 'orientation'], [{ coordinate_space: 'normalized' }, 'format'],
    [{ source_stream: 'SUB' }, 'format'], [{ schema_version: 2 }, 'format']]) {
    assert.equal(selectOverlay(input([result(9400, patch), result(9900)])).reason, reason);
  }
  assert.equal(selectOverlay(input([result(9400), result(9900)], { config: { expected_video_size: [1920, 1080] } })).reason, 'size');
  assert.equal(selectOverlay(input([result(9400), result(9900)], { config: { camera_id: 'other' } })).reason, 'format');
});
const detection = (label) => ({ label, confidence: .9, box: [10, 10, 40, 50] });
test('negative wear states require the current person\'s explicit associated evidence', () => {
  const person = { tracking_status: 'observed', observed_states: { helmet: 'not_worn', vest: 'not_worn' },
    evidence: { helmet: [detection('no-hardhat')], vest: [] } };
  assert.equal(equipmentState(person, 'helmet'), 'not_worn');
  assert.equal(equipmentState(person, 'vest'), 'unknown');
  assert.equal(equipmentState({ ...person, evidence: { helmet: [detection('hardhat'), detection('no-hardhat')] } }, 'helmet'), 'unknown');
  assert.equal(equipmentState({ ...person, observed_states: { helmet: 'unknown' } }, 'helmet'), 'unknown');
});
test('lost or stale anonymous tracks withdraw previously observed equipment states', () => {
  const person = { observed_states: { helmet: 'worn' }, evidence: { helmet: [detection('hardhat')] } };
  assert.equal(equipmentState(person, 'helmet'), 'worn');
  assert.equal(equipmentState({ ...person, tracking_status: 'temporarily_lost' }, 'helmet'), 'unknown');
  assert.equal(equipmentState({ ...person, observation_age_seconds: 1.01 }, 'helmet'), 'unknown');
});
test('identities include camera, session, capture epoch, sequence and tracking epoch', () => {
  const r = result(9400), p = { track_id: 1, tracking_epoch: 'first' };
  assert.notEqual(resultKey(r), resultKey({ ...r, session_id: 'next' }));
  assert.notEqual(resultKey(r), resultKey({ ...r, capture_epoch: 3 }));
  assert.notEqual(personKey(r, p), personKey(r, { ...p, tracking_epoch: 'next' }));
  assert.notEqual(personKey(r, p), personKey({ ...r, session_id: 'next' }, p));
});
test('contain projection preserves letterbox offsets in either direction', () => {
  assert.deepEqual(containGeometry(800, 600, 2560, 1440), { scale: .3125, offsetX: 0, offsetY: 75, width: 800, height: 450 });
  assert.deepEqual(containGeometry(800, 450, 1000, 1000), { scale: .45, offsetX: 175, offsetY: 0, width: 450, height: 450 });
  assert.equal(containGeometry(0, 600, 2560, 1440), null);
});
test('only four PPE labels render; pixel boxes clip to the source, never show other classes', () => {
  assert.deepEqual(displayDetection({ label: 'no-hardhat', confidence: .87, box: [-10, 3, 100, 2000] }, 2560, 1440),
    { label: '未戴安全帽', confidence: .87, negative: true, box: [0, 3, 100, 1440] });
  assert.equal(displayDetection(detection('person'), 2560, 1440), null);
  assert.equal(displayDetection(detection('__proto__'), 2560, 1440), null);
  assert.equal(displayDetection({ ...detection('hardhat'), box: [100, 100, 20, 20] }, 2560, 1440), null);
});
test('only business same-origin API and media paths are accepted', () => {
  assert.equal(businessPath('/api/ppe/cameras/camera-01/history'), '/api/ppe/cameras/camera-01/history');
  assert.equal(businessPath('/ppe-live/camera-01/media/hls/raw-main/index.m3u8?session=a', true), '/ppe-live/camera-01/media/hls/raw-main/index.m3u8?session=a');
  for (const path of ['http://127.0.0.1:28878/results', '//example.com/ppe-live/', '/api/ppe/../../secret', '/api/other', '/api/ppe/a#b', '/api/ppe/\\secret']) assert.equal(businessPath(path), null);
});
