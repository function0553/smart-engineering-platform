"""One latest frame, one inference owner, same-frame JSON/JPEG/media identity."""
from dataclasses import dataclass
from datetime import datetime, timezone
import hmac
import math
import threading
import time
from uuid import uuid4

import cv2
import numpy as np

from configuration import MODEL_SHA256, validate_config
from engine import annotate, associate, orient_frame
from precision import PrecisionDetector
from tracking import SupervisionPPE


# The current application exposes helmet and reflective-vest detections only.
# Person observations remain available internally for PPE association/tracking.
OUTPUT_CLASSES = frozenset(('hardhat', 'no-hardhat', 'safety vest', 'no-safety vest'))


def current_person_snapshot(persons, frame_size):
    """Count fresh observations, keeping tracker candidates internal.

    A low-confidence, extremely narrow crop at a side boundary is unverified,
    rather than a second counted person. It still participates in upstream PPE
    ownership and tracking; this policy only selects the public snapshot.
    """
    width, height = frame_size
    epsilon = max(2.0, width * .001)
    selected, seen = [], set()
    stats = {'tracked_candidates': len(persons), 'lost_candidates': 0,
             'unverified_edge_candidates': 0, 'duplicate_candidates': 0,
             'invalid_candidates': 0,
             'person_count_policy': 'current_observed_unique_with_edge_quality_v1'}
    number = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
    for person in persons:
        if person.get('tracking_status') != 'observed':
            stats['lost_candidates'] += 1
            continue
        confidence, box = person.get('confidence'), person.get('box')
        tid, epoch = person.get('track_id'), person.get('tracking_epoch')
        if (person.get('observation_age_seconds') != 0 or not number(confidence)
                or not 0 <= confidence <= 1 or not isinstance(box, (list, tuple))
                or len(box) != 4 or not all(number(v) for v in box)
                or not isinstance(tid, int) or isinstance(tid, bool) or tid < 0
                or not isinstance(epoch, str) or not epoch):
            stats['invalid_candidates'] += 1
            continue
        x1, y1, x2, y2 = box
        if not (0 <= x1 < x2 <= width and 0 <= y1 < y2 <= height):
            stats['invalid_candidates'] += 1
            continue
        touches_side = x1 <= epsilon or x2 >= width - epsilon
        if touches_side and (x2 - x1) / (y2 - y1) < .10 and confidence < .50:
            stats['unverified_edge_candidates'] += 1
            continue
        key = (epoch, tid)
        if key in seen:
            stats['duplicate_candidates'] += 1
            continue
        seen.add(key)
        selected.append(person)
    stats['current_person_count'] = len(selected)
    return selected, stats


class ApiError(Exception):
    def __init__(self, status, code):
        super().__init__(code)
        self.status, self.code = status, code


def utc(stamp):
    return datetime.fromtimestamp(stamp, timezone.utc).isoformat().replace('+00:00', 'Z')


@dataclass(frozen=True)
class Frame:
    epoch: int
    session_id: str
    sequence: int
    received: float
    received_utc: float
    source_pts: float | None
    source_lag: float | None
    source_pts_status: str
    source_decode_sequence: int
    image: np.ndarray


class VideoRuntime:
    def __init__(self, config, detector, tokens, publisher, monotonic=time.monotonic, wall=time.time):
        self.config = validate_config(config)
        if detector.sha256 != MODEL_SHA256:
            raise ValueError('required_model_sha256_mismatch')
        cid = self.config['camera']['camera_id']
        if set(tokens) != {'admin', cid} or any(not isinstance(t, str) or len(t.encode()) < 32 for t in tokens.values()):
            raise ValueError('distinct_admin_camera_tokens_required')
        if len(set(tokens.values())) != 2:
            raise ValueError('distinct_admin_camera_tokens_required')
        if self.config['media']['enabled'] and publisher is None:
            raise ValueError('enabled_media_requires_publisher')
        self.detector, self.tokens = detector, tokens
        self.publisher = publisher if self.config['media']['enabled'] else None
        self.precision = PrecisionDetector(detector, max_rois=self.config['limits']['max_person_rois'])
        self.tracker = SupervisionPPE(max_gap_seconds=1.5)
        self.monotonic, self.wall = monotonic, wall
        self.condition = threading.Condition()
        self.inference_lock = threading.Lock()
        self.stopped = threading.Event()
        self.worker = None
        self.epoch = 0
        self.session_id = None
        self.connected_flag = False
        self.pending = None
        self.result = self.jpeg = None
        self.result_received = None
        self.last_decoded = None
        self.sequence = self.decoded_count = self.replaced = self.stale_drops = 0
        # Lifetime count of successfully committed fresh JSON results. Unlike
        # sequence, it does not reset on reconnection or count replaced frames.
        self.processed_results_count = 0
        self.tracker_epoch = -1
        self.error = 'source_not_started'
        self.last_pts = None
        self.last_pts_status = None

    def authenticated(self, authorization, camera_id=None, admin_only=False):
        if not isinstance(authorization, str) or not authorization.startswith('Bearer '):
            return False
        supplied = authorization[7:].encode()
        if len(supplied) > 1024:
            return False
        allowed = [self.tokens['admin']]
        if not admin_only and camera_id == self.config['camera']['camera_id']:
            allowed.append(self.tokens[camera_id])
        return any(hmac.compare_digest(supplied, t.encode()) for t in allowed)

    def connected(self):
        with self.condition:
            self.epoch += 1
            self.session_id = uuid4().hex
            self.connected_flag = True
            self.pending = self.result = self.jpeg = self.result_received = None
            self.last_decoded = self.last_pts = self.last_pts_status = None
            self.sequence = 0
            self.error = None
            self.condition.notify_all()
            return self.epoch

    def disconnected(self, epoch, reason):
        with self.condition:
            if epoch is not None and epoch != self.epoch:
                return
            self.connected_flag = False
            self.pending = self.result = self.jpeg = self.result_received = None
            self.error = reason
            self.condition.notify_all()
        # Stop publishing the old connection; no further frozen-frame repetition.
        if self.publisher is not None:
            self.publisher.reset()

    def decoded(self, epoch, now, pts, pts_status='observed_unverified'):
        with self.condition:
            if epoch == self.epoch and self.connected_flag:
                self.last_decoded, self.last_pts = now, pts
                self.last_pts_status = pts_status if pts is not None else 'unstable'
                self.decoded_count += 1

    def accept_frame(self, epoch, image, received, source_pts=None, source_lag=None, source_pts_status='observed_unverified'):
        p = self.config['camera']
        if image.dtype != np.uint8 or image.ndim != 3 or image.shape[2] != 3 or list(image.shape[1::-1]) != p['expected_size']:
            raise ValueError('decoded_frame_contract_mismatch')
        with self.condition:
            if epoch != self.epoch or not self.connected_flag:
                return False
            if self.pending is not None:
                self.replaced += 1
            self.sequence += 1
            if source_pts is None:
                source_pts_status = 'unstable'
            self.pending = Frame(epoch, self.session_id, self.sequence, received, self.wall(), source_pts, source_lag,
                                 source_pts_status, self.decoded_count, image)
            self.condition.notify_all()
            return True

    def frame_fresh(self, f):
        now = self.monotonic()
        return (self.connected_flag and f.epoch == self.epoch and f.session_id == self.session_id and
                0 <= now-f.received <= self.config['limits']['max_pending_age_seconds'] and
                self.last_decoded is not None and 0 <= now-self.last_decoded <= self.config['limits']['result_ttl_seconds'])

    def process_once(self):
        with self.inference_lock:
            with self.condition:
                frame, self.pending = self.pending, None
                if frame is None:
                    return False
                if not self.frame_fresh(frame):
                    self.stale_drops += 1
                    return True
            try:
                p = self.config['camera']
                if self.tracker_epoch != frame.epoch:
                    self.tracker.reset()
                    self.tracker_epoch = frame.epoch
                image = orient_frame(frame.image, p['rotation_degrees'], p['mirror_horizontal'])
                strict_pts = self.config['limits']['source_pts_policy'] == 'strict' and frame.source_pts_status == 'strict_monotonic_relative'
                timeline = frame.source_pts if strict_pts and frame.source_pts is not None else frame.received
                detections, ms, diagnostics = self.precision.predict(image,
                    roi_eligibility=lambda person, all_people: self.tracker.should_refine_person(person, all_people, timeline))
                persons = self.tracker.update(associate(detections, image.shape), timeline)
                temporal = p['temporal_confirmation_enabled'] and strict_pts and frame.source_pts is not None
                if not temporal:
                    persons = [{**person, 'observed_states': dict(person['raw_states']),
                                'raw_states': {'helmet': 'unknown', 'vest': 'unknown'},
                                'states': {'helmet': 'unknown', 'vest': 'unknown'},
                                'reasons': {'helmet': 'stream_timing_not_accepted', 'vest': 'stream_timing_not_accepted'}}
                               for person in persons]
                current_persons, count_metadata = current_person_snapshot(
                    persons, (image.shape[1], image.shape[0]))
                rendered = data = None
                if self.publisher is not None or self.config['diagnostic_jpeg_enabled']:
                    rendered = annotate(image, persons, title='服务器诊断检测快照 · CPU/CUDA候选')
                    # This is the inference frame, not the current continuous
                    # preview frame. The short key identifies diagnostic output.
                    cv2.putText(rendered, f'E{frame.epoch} S{frame.sequence}',
                                (8, max(24, rendered.shape[0]-16)), cv2.FONT_HERSHEY_SIMPLEX,
                                .65, (255,255,255), 2, cv2.LINE_AA)
                if self.config['diagnostic_jpeg_enabled']:
                    success, data = cv2.imencode('.jpg', rendered, [cv2.IMWRITE_JPEG_QUALITY, 85])
                    if not success or len(data) > self.config['limits']['max_jpeg_bytes']:
                        raise ValueError('jpeg_output_limit')
                with self.condition:
                    if not self.frame_fresh(frame):
                        self.stale_drops += 1
                        return True
                media = (self.publisher.write(frame.epoch, np.ascontiguousarray(rendered)) if self.publisher is not None
                         else {'media_delivery_status': 'inference_worker_does_not_publish_display_video'})
                result = {'schema_version': 1, 'mode': 'remote_video_server_candidate',
                          'camera_id': p['camera_id'], 'view_id': p['view_id'], 'source_stream': 'MAIN',
                          'session_id': frame.session_id, 'capture_epoch': frame.epoch, 'sequence': frame.sequence,
                          'frame_size': [image.shape[1], image.shape[0]], 'coordinate_space': 'oriented_source_pixels',
                          'rotation_degrees': p['rotation_degrees'], 'mirror_horizontal': p['mirror_horizontal'],
                          'received_at_utc': utc(frame.received_utc), 'processed_at_utc': utc(self.wall()),
                          'source_pts_seconds': frame.source_pts, 'relative_timeline_backlog_seconds': frame.source_lag,
                          'source_pts_status': frame.source_pts_status,
                          'source_pts_policy': self.config['limits']['source_pts_policy'],
                          'source_decode_sequence_local': frame.source_decode_sequence,
                          'timestamp_semantics': 'source_pts_relative' if strict_pts else 'decoder_receive_monotonic',
                          'sensor_exposure_utc_verified': False, 'temporal_confirmation_enabled': temporal,
                          'stream_timing_contract_verified': p['stream_timing_contract_verified'],
                          'inference_ms': round(ms, 3), 'network_calls': 1+diagnostics['roi_count'],
                          'model_sha256': self.detector.sha256, 'inference_backend': self.detector.contract,
                          'inference_sampling_fps_cap': self.config['limits']['inference_fps'],
                          'diagnostic_jpeg_enabled': self.config['diagnostic_jpeg_enabled'],
                          'inference_worker_publishes_display_video': self.publisher is not None,
                          'detections': [d for d in detections if d['label'] in OUTPUT_CLASSES],
                          'detection_tasks': ['safety_helmet', 'reflective_vest'], 'persons': current_persons,
                          'current_person_count': len(current_persons),
                          'tracking': {**self.tracker.metadata, 'temporal_confirmation_enabled': temporal,
                                       'confirmation_frames': 3 if temporal else None, **count_metadata},
                          'media': media or {'media_delivery_status': 'encoder_unavailable'},
                          'media_read_urls': {k: self.config['media'].get(k) for k in ('read_rtsp_url','read_web_url')},
                          'camera_model_deployed': False, 'production_accepted': False, 'field_accuracy_verified': False}
                with self.condition:
                    if self.frame_fresh(frame):
                        self.processed_results_count += 1
                        result['processed_results_count'] = self.processed_results_count
                        self.result, self.jpeg, self.result_received = result, data.tobytes() if data is not None else None, frame.received
                        self.error = None if media else self.publisher.last_error
                    else:
                        self.stale_drops += 1
                return True
            except Exception:
                self.tracker.reset()
                with self.condition:
                    if frame.epoch == self.epoch and frame.session_id == self.session_id:
                        self.result = self.jpeg = self.result_received = None
                        self.error = 'inference_or_render_failed'
                return True

    def result_fresh(self):
        now = self.monotonic()
        ttl = self.config['limits']['result_ttl_seconds']
        return (self.connected_flag and self.result is not None and self.last_decoded is not None and
                self.result_received is not None and self.result['capture_epoch'] == self.epoch and
                self.result['session_id'] == self.session_id and 0 <= now-self.result_received <= ttl and
                0 <= now-self.last_decoded <= ttl)

    def snapshot(self, jpeg=False):
        with self.condition:
            if jpeg and not self.config['diagnostic_jpeg_enabled']:
                self.jpeg = None
                raise ApiError(503, 'diagnostic_jpeg_disabled')
            if not self.result_fresh():
                self.result = self.jpeg = self.result_received = None
                raise ApiError(503, 'result_unavailable')
            return (dict(self.result), self.jpeg) if jpeg else dict(self.result)

    def status(self):
        with self.condition:
            available = self.result_fresh()
            if not available:
                self.result = self.jpeg = self.result_received = None
            now = self.monotonic()
            return {'mode': 'remote_video_server_candidate', 'camera_id': self.config['camera']['camera_id'],
                    'source_stream': 'MAIN', 'connected': self.connected_flag,
                    'capture_epoch': self.epoch, 'session_id': self.session_id,
                    'decoded_frame_age_seconds': None if self.last_decoded is None else max(0,now-self.last_decoded),
                    'decoded_frames': self.decoded_count, 'last_accepted_sequence': self.sequence,
                    'processed_results_count': self.processed_results_count,
                    'source_pts_status': self.last_pts_status, 'source_pts_policy': self.config['limits']['source_pts_policy'],
                    'pending_frames': int(self.pending is not None), 'replaced_pending_frames': self.replaced,
                    'stale_drops': self.stale_drops, 'result_available': available, 'error': self.error,
                    'model_sha256': self.detector.sha256, 'inference_backend': self.detector.contract,
                    'diagnostic_jpeg_enabled': self.config['diagnostic_jpeg_enabled'],
                    'inference_worker_publishes_display_video': self.publisher is not None,
                    'inference_sampling_fps_cap': self.config['limits']['inference_fps'],
                    'media_read_urls': {k: self.config['media'].get(k) for k in ('read_rtsp_url','read_web_url')},
                    'production_accepted': False, 'field_accuracy_verified': False}

    def _worker_loop(self):
        next_infer = 0.
        period = 1/self.config['limits']['inference_fps']
        while not self.stopped.is_set():
            remaining = next_infer-self.monotonic()
            if remaining > 0:
                self.stopped.wait(remaining)
                continue
            started = self.monotonic()
            if self.process_once():
                # Start-to-start cap. A slow step immediately takes the latest
                # pending frame, then schedules from that actual new start;
                # it never advances a historical deadline to catch up a FIFO.
                next_infer = started+period
            else:
                next_infer = 0.
                with self.condition:
                    self.condition.wait(.1)

    def start(self):
        if self.worker is not None:
            raise RuntimeError('inference_already_started')
        self.worker = threading.Thread(target=self._worker_loop, name='ppe-inference', daemon=True)
        self.worker.start()

    def stop(self):
        self.stopped.set()
        with self.condition:
            self.condition.notify_all()
        if self.publisher is not None:
            self.publisher.close()
        if self.worker:
            self.worker.join(self.config['media']['write_timeout_seconds']+2)
        return self.worker is None or not self.worker.is_alive()
