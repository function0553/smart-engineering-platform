export type PpeLabel = 'hardhat' | 'no-hardhat' | 'safety vest' | 'no-safety vest';
export type PpeDetection = { label: string; confidence: number; box: number[] };
export type PpePerson = {
  track_id?: string | number; tracking_epoch?: string | number; tracking_status?: string;
  observation_age_seconds?: number;
  observed_states?: { helmet?: string; vest?: string };
  evidence?: { helmet?: PpeDetection[]; vest?: PpeDetection[] };
};
export type PpeResult = {
  schema_version?: number; camera_id: string; session_id: string; capture_epoch: string | number;
  sequence: number; decoder_received_epoch_ms?: number; received_at_utc?: string;
  processed_at_utc?: string; source_stream?: string; frame_size?: number[];
  coordinate_space?: string; rotation_degrees?: number; mirror_horizontal?: boolean;
  detections?: PpeDetection[]; persons?: PpePerson[];
};
export type PpeHistory = {
  server_now_epoch_ms: number; state: string; latest_result_age_ms?: number;
  alignment?: string; results: PpeResult[];
};
export type OverlayConfig = {
  camera_id?: string; alignment_mode?: string; overlay_timing_verified?: boolean;
  overlay_clock_offset_ms?: number; overlay_match_max_error_ms?: number;
  overlay_sample_ttl_ms?: number; expected_video_size?: number[];
  rotation_degrees?: number; mirror_horizontal?: boolean;
};
export type HistoryReceipt = {
  data: PpeHistory; receivedMonoMs: number; clockDeltaMs: number;
};
export type MatchReason = 'ready' | 'disabled' | 'paused' | 'waiting' | 'frame_stale' | 'no_anchor' |
  'history_unavailable' | 'history_stale' | 'input_stale' | 'no_match' | 'orientation' | 'size' | 'format';
export type OverlayMatch = { reason: MatchReason; result: PpeResult | null; errorMs?: number };
export const PPE_LABELS: Record<PpeLabel, string> = {
  hardhat: '安全帽', 'no-hardhat': '未戴安全帽', 'safety vest': '反光背心', 'no-safety vest': '未穿反光背心',
};

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const limit = (value: unknown, maximum: number) => finite(value) && value > 0 ? Math.min(value, maximum) : maximum;
export const resultTime = (result: PpeResult) => finite(result.decoder_received_epoch_ms)
  ? result.decoder_received_epoch_ms : Date.parse(result.received_at_utc || '');
export const sessionKey = (result: PpeResult) => JSON.stringify([result.camera_id, result.session_id, result.capture_epoch]);
export const resultKey = (result: PpeResult) => JSON.stringify([result.camera_id, result.session_id, result.capture_epoch, result.sequence]);
export const personKey = (result: PpeResult, person: PpePerson) => JSON.stringify([
  result.camera_id, result.session_id, result.capture_epoch, person.tracking_epoch, person.track_id,
]);

export function latestResult(history: PpeHistory | undefined): PpeResult | null {
  if (!history || history.state !== 'fresh' || !Array.isArray(history.results)) return null;
  return history.results.filter(r => r && typeof r.session_id === 'string' && r.session_id &&
    (typeof r.capture_epoch === 'number' || typeof r.capture_epoch === 'string') && finite(resultTime(r)))
    .reduce<PpeResult | null>((last, r) => !last || resultTime(r) > resultTime(last) ||
      (resultTime(r) === resultTime(last) && r.sequence > last.sequence) ? r : last, null);
}

export function historyReceipt(data: PpeHistory, startedEpochMs: number, finishedEpochMs: number, receivedMonoMs: number): HistoryReceipt {
  return { data, receivedMonoMs, clockDeltaMs: data.server_now_epoch_ms - (startedEpochMs + finishedEpochMs) / 2 };
}

export function selectOverlay(input: {
  cameraId: string; receipt: HistoryReceipt | null; config: OverlayConfig; nowMonoMs: number;
  playingDateMs: number | null; paused: boolean; waiting: boolean; enabled: boolean;
  lastFrameMonoMs: number; videoWidth: number; videoHeight: number;
}): OverlayMatch {
  const empty = (reason: MatchReason): OverlayMatch => ({ reason, result: null });
  if (!input.enabled) return empty('disabled');
  if (input.paused) return empty('paused');
  if (input.waiting) return empty('waiting');
  if (!input.lastFrameMonoMs || input.nowMonoMs - input.lastFrameMonoMs > 750) return empty('frame_stale');
  if (!finite(input.playingDateMs)) return empty('no_anchor');
  const receipt = input.receipt;
  if (!receipt || receipt.data.state !== 'fresh' || !finite(receipt.clockDeltaMs) ||
    !finite(receipt.data.server_now_epoch_ms)) return empty('history_unavailable');
  const elapsed = Math.max(0, input.nowMonoMs - receipt.receivedMonoMs);
  if (elapsed > 1000) return empty('history_stale');
  const latest = latestResult(receipt.data);
  if (!latest || latest.camera_id !== input.cameraId) return empty('history_unavailable');
  const latestAge = Math.max(receipt.data.server_now_epoch_ms - resultTime(latest),
    finite(receipt.data.latest_result_age_ms) ? receipt.data.latest_result_age_ms : 0) + elapsed;
  if (latestAge < -100 || latestAge > limit(input.config.overlay_sample_ttl_ms, 1000)) return empty('input_stale');
  if ((input.config.camera_id && input.config.camera_id !== input.cameraId) ||
    (input.config.alignment_mode && input.config.alignment_mode !== 'receive_time_estimate')) return empty('format');
  const playTime = input.playingDateMs + receipt.clockDeltaMs +
    (finite(input.config.overlay_clock_offset_ms) ? input.config.overlay_clock_offset_ms : 0);
  const candidates = receipt.data.results.filter(r => r && sessionKey(r) === sessionKey(latest) &&
    finite(resultTime(r)) && resultTime(r) <= playTime);
  const result = candidates.reduce<PpeResult | null>((last, r) => !last || resultTime(r) > resultTime(last) ||
    (resultTime(r) === resultTime(last) && r.sequence > last.sequence) ? r : last, null);
  if (!result || playTime - resultTime(result) > limit(input.config.overlay_match_max_error_ms, 500)) return empty('no_match');
  if (result.schema_version !== 1 || result.coordinate_space !== 'oriented_source_pixels' || result.source_stream !== 'MAIN') return empty('format');
  if (result.rotation_degrees !== 0 || result.mirror_horizontal !== false ||
    (input.config.rotation_degrees !== undefined && input.config.rotation_degrees !== 0) ||
    (input.config.mirror_horizontal !== undefined && input.config.mirror_horizontal !== false)) return empty('orientation');
  const size = result.frame_size, expected = input.config.expected_video_size;
  if (!size || size.length !== 2 || size[0] !== input.videoWidth || size[1] !== input.videoHeight ||
    input.videoWidth <= 0 || input.videoHeight <= 0 || (expected &&
      (expected[0] !== input.videoWidth || expected[1] !== input.videoHeight))) return empty('size');
  return { reason: 'ready', result, errorMs: playTime - resultTime(result) };
}

export function equipmentState(person: PpePerson, equipment: 'helmet' | 'vest'): 'worn' | 'not_worn' | 'unknown' {
  if (person.tracking_status === 'temporarily_lost' ||
    (finite(person.observation_age_seconds) && person.observation_age_seconds > 1)) return 'unknown';
  const state = person.observed_states?.[equipment];
  if (state !== 'worn' && state !== 'not_worn') return 'unknown';
  const positive = equipment === 'helmet' ? 'hardhat' : 'safety vest';
  const negative = equipment === 'helmet' ? 'no-hardhat' : 'no-safety vest';
  const evidence = Array.isArray(person.evidence?.[equipment]) ? person.evidence![equipment]! : [];
  const valid = evidence.filter(d => d && finite(d.confidence) && d.confidence >= 0 && d.confidence <= 1 &&
    Array.isArray(d.box) && d.box.length === 4 && d.box.every(finite) && d.box[2] > d.box[0] && d.box[3] > d.box[1]);
  const hasPositive = valid.some(d => d.label === positive), hasNegative = valid.some(d => d.label === negative);
  if (hasPositive && hasNegative) return 'unknown';
  return state === 'worn' && hasPositive ? 'worn' : state === 'not_worn' && hasNegative ? 'not_worn' : 'unknown';
}

export function containGeometry(width: number, height: number, sourceWidth: number, sourceHeight: number) {
  if (![width, height, sourceWidth, sourceHeight].every(n => finite(n) && n > 0)) return null;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  return { scale, offsetX: (width - sourceWidth * scale) / 2, offsetY: (height - sourceHeight * scale) / 2,
    width: sourceWidth * scale, height: sourceHeight * scale };
}

export function displayDetection(detection: PpeDetection, sourceWidth: number, sourceHeight: number) {
  if (!detection || !Object.hasOwn(PPE_LABELS, detection.label) || !finite(detection.confidence) ||
    detection.confidence < 0 || detection.confidence > 1 || !Array.isArray(detection.box) ||
    detection.box.length !== 4 || !detection.box.every(finite)) return null;
  const [x1, y1, x2, y2] = detection.box;
  const box = [Math.max(0, x1), Math.max(0, y1), Math.min(sourceWidth, x2), Math.min(sourceHeight, y2)];
  if (box[2] <= box[0] || box[3] <= box[1]) return null;
  return { label: PPE_LABELS[detection.label as PpeLabel], confidence: detection.confidence,
    negative: detection.label === 'no-hardhat' || detection.label === 'no-safety vest', box };
}

export function businessPath(value: unknown, media = false): string | null {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
  try {
    const url = new URL(value, 'https://business.invalid');
    const expectedPrefix = media ? '/ppe-live/' : '/api/ppe/';
    if (url.origin !== 'https://business.invalid' || !url.pathname.startsWith(expectedPrefix) || url.hash) return null;
    return url.pathname + url.search;
  } catch { return null; }
}
