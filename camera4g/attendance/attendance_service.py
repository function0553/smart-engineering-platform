"""Shared GPU SCRFD/ArcFace attendance with camera-specific capture and audio."""
import argparse
import base64
from datetime import datetime, timezone
import hashlib
import hmac
import ipaddress
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import statistics
import threading
import time
import uuid

from attendance_store import Store, AttendanceResetBusy
from gb_voice import Speaker
from face_liveness import Liveness


class Attendance:
    def __init__(self, config, shared=None):
        import av
        from facekit.core import FacePipeline

        self.av, self.config = av, config
        self.camera_id = config.get('camera_id', 'camera-02')
        self.camera_name = config.get('camera_name', self.camera_id)
        if shared is None:
            self.pipeline = FacePipeline(config['model_directory'], provider='cuda', gpu_id=config.get('gpu_id', 1))
            self.model = self.pipeline.info()
            self.pipeline_lock = threading.Lock()
            self.store = Store(config['database'], self.model['modelId'], config.get('attendance_policy'))
            self.store.recover_inflight()
            self.liveness = Liveness(config['liveness_model_directory'])
            self.cycle_lock = threading.Lock()
            self.stop = threading.Event()
        else:
            self.pipeline, self.model = shared.pipeline, shared.model
            self.pipeline_lock, self.cycle_lock = shared.pipeline_lock, shared.cycle_lock
            self.store, self.liveness, self.stop = shared.store, shared.liveness, shared.stop
        self.frame_lock = threading.Lock()
        self.frame_ready = threading.Event()
        self.voice_ready = threading.Event()
        self.sample_fps = float(config.get('recognition_sample_fps', 5))
        if not .5 <= self.sample_fps <= 10:
            raise ValueError('invalid_recognition_sample_fps')
        self.performance = []
        self.recent_checkins = {}
        self.latest = None
        self.sequence = 0
        self.session = uuid.uuid4().hex
        self.seen = {}
        self.speaker = Speaker(device=config.get('device_id', '34020000001320000012'),
                               channel=config.get('channel_id'))
        self.last_liveness = []
        self.state = {'connected': False, 'frames_processed': 0, 'last_error': None,
                      'last_face_count': 0, 'last_frame_received': None}
        self.root = Path(config['root'])
        self.voice_gate = self.root/config.get('voice_verification_file', 'private/voice-playback-verified.json')
        if not self.voice_gate.resolve().is_relative_to(self.root.resolve()):
            raise ValueError('voice_gate_outside_project')
        self.token = os.environ['ATTENDANCE_ADMIN_TOKEN']

    def voice_enabled(self):
        return self.voice_gate.exists()

    def start(self):
        self.voice_ready.set()
        for target in (self.capture, self.recognize, self.speak):
            threading.Thread(target=target, daemon=True).start()

    def capture(self):
        while not self.stop.is_set():
            try:
                with self.av.open(self.config['source_url'], options={'rtsp_transport': 'tcp',
                                  'allowed_media_types': 'video', 'fflags': 'nobuffer', 'flags': 'low_delay'},
                                  timeout=(6, 6)) as container:
                    stream = container.streams.video[0]
                    stream.codec_context.thread_count = 1
                    self.session = uuid.uuid4().hex
                    last_sample = 0
                    for frame in container.decode(stream):
                        if self.stop.is_set():
                            break
                        now = time.monotonic()
                        if now - last_sample < 1/self.sample_fps:
                            continue
                        last_sample = now
                        image = frame.to_ndarray(format='bgr24')
                        if list(image.shape[:2]) != [1440, 2560]:
                            raise ValueError('unexpected_main_size')
                        self.sequence += 1
                        received = datetime.now(timezone.utc).isoformat()
                        with self.frame_lock:
                            self.latest = (self.session, self.sequence, now, received, image)
                        self.frame_ready.set()
                        self.state.update(connected=True, last_frame_received=received)
            except Exception as error:
                self.state.update(connected=False, last_error='source_unavailable')
            finally:
                with self.frame_lock:
                    self.latest = None
                with self.cycle_lock:
                    self.seen.clear()
            self.stop.wait(2)

    def recognize(self):
        from face_engine.alignment.face_align import align_face

        last_key = None
        while not self.stop.is_set():
            self.frame_ready.wait(.5)
            self.frame_ready.clear()
            if self.stop.is_set():
                break
            with self.frame_lock:
                item = self.latest
            if item is None or time.monotonic() - item[2] > 2 or item[:2] == last_key:
                continue
            last_key = item[:2]
            session, sequence, captured, received, image = item
            try:
                started = time.monotonic()
                with self.pipeline_lock:
                    rows = self.pipeline.detect(image)
                    self.state['last_face_count'] = len(rows)
                    observations = []
                    rejected_ids = set()
                    liveness_results = []
                    for index, row in enumerate(rows[:20]):
                        x1, y1, x2, y2 = row['bbox']
                        if min(x2-x1, y2-y1) < 40 or x1 < 0 or y1 < 0 or x2 > image.shape[1] or y2 > image.shape[0]:
                            continue
                        aligned = align_face(image, row['landmarks'])
                        feature = self.pipeline.recognizer.extract_embeddings([aligned])[0]
                        match = self.store.match(feature, self.model['modelId'])
                        if match:
                            proof = self.liveness.evaluate(image, row['bbox'])
                            liveness_results.append({'person_id': match['person_id'], **proof})
                            if proof['state'] == 'passed':
                                observations.append((index, match, proof))
                            else:
                                rejected_ids.add(match['person_id'])
                self.last_liveness = liveness_results
                now = time.monotonic()
                if now - captured > 3:
                    continue
                with self.cycle_lock:
                    current_ids = set()
                    for person_id in rejected_ids:
                        self.seen.pop(person_id, None)
                    for index, match, proof in observations:
                        person_id = match['person_id']
                        if person_id in rejected_ids:
                            continue
                        if person_id in current_ids:
                            continue
                        current_ids.add(person_id)
                        if not self.store.policy.classify(received)['allowed']:
                            self.seen.pop(person_id, None)
                            continue
                        previous = self.seen.get(person_id)
                        self.seen[person_id] = (session, sequence, now, proof)
                        if previous is None or previous[0] != session or now - previous[2] > 3:
                            if (self.voice_enabled()
                                    and not self.store.checked_in_today(person_id, received)):
                                self.speaker.prepare()
                            continue
                        checkin = self.store.checkin(person_id, self.camera_id, f'{session}:{sequence}:{index}', received,
                                                     match['similarity'], now-captured,
                                                     liveness={'previous': previous[3], 'current': proof})
                        if checkin['created']:
                            self.recent_checkins[checkin['attendance_id']] = {
                                'created_monotonic': time.monotonic(),
                                'frame_received_to_match': (now-captured)*1000,
                                'two_observations_confirmation': (now-previous[2])*1000}
                            while len(self.recent_checkins) > 64:
                                self.recent_checkins.pop(next(iter(self.recent_checkins)))
                            self.voice_ready.set()
                    self.seen = {k: v for k, v in self.seen.items() if now-v[2] <= 3}
                self.state.update(frames_processed=self.state['frames_processed']+1, last_error=None)
                self.performance.append({'processing_ms': (now-started)*1000,
                                         'frame_received_to_match_ms': (now-captured)*1000})
                if len(self.performance) > 120:
                    del self.performance[:-120]
            except Exception as error:
                self.state['last_error'] = 'face_processing_failed'

    def speak(self):
        while not self.stop.is_set():
            self.voice_ready.wait(1)
            self.voice_ready.clear()
            if self.stop.is_set():
                break
            if not self.voice_enabled():
                continue
            while not self.stop.is_set():
                item = self.store.claim_voice(self.camera_id)
                if item is None:
                    break
                with self.cycle_lock:
                    timing = dict(self.recent_checkins.pop(item['attendance_id'], {}))
                created = timing.pop('created_monotonic', None)
                claimed = time.monotonic()
                result = self.speaker.send(item['voice_pcma'])
                result.setdefault('timing_ms', {}).update(timing)
                if created is not None:
                    result['timing_ms']['checkin_to_voice_worker'] = (claimed-created)*1000
                    first_audio = result['timing_ms'].get('first_audio_submitted')
                    if first_audio is not None:
                        result['timing_ms']['checkin_to_first_audio_submitted'] = first_audio+(claimed-created)*1000
                self.state['last_voice_timing_ms'] = result['timing_ms']
                self.store.finish_voice(item['attendance_id'], result['status'], result)

    def status(self):
        with self.frame_lock:
            age = None if self.latest is None else time.monotonic() - self.latest[2]
        report = self.root/('reports/voice-test-20261019.json' if self.camera_id == 'camera-02'
                            else f'reports/voice-{self.camera_id}-test.json')
        voice = json.loads(report.read_text()) if report.exists() else {'status': 'not_tested'}
        samples = list(self.performance)
        performance = {'samples': len(samples)}
        for field in ('processing_ms', 'frame_received_to_match_ms'):
            values = sorted(row[field] for row in samples)
            if values:
                performance[field] = {'median': statistics.median(values),
                                      'p95': values[min(len(values)-1, int(.95*len(values)))]}
        return {**self.state, 'camera_id': self.camera_id, 'camera_name': self.camera_name,
                'frame_age_seconds': age,
                'recognition_sample_fps': self.sample_fps, 'performance': performance,
                'enrolled_people': len(self.store.people()), 'model': self.model,
                'voice_enabled': self.voice_enabled(),
                'attendance_policy': self.store.policy.info(),
                'attendance_window': self.store.policy.classify(datetime.now(timezone.utc)),
                'liveness': {'enabled': True, 'model_id': self.liveness.model_id,
                             'method': 'rgb_dual_scale', 'threshold': .9,
                             'field_validation': 'initial_phone_photo_only',
                             'latest_matches': list(self.last_liveness)},
                'voice_test': voice, 'time_basis': 'server_frame_received_time',
                'identity_threshold': .65, 'threshold_field_calibrated': False}

    def enroll(self, request):
        from facekit.core import decode_image

        raw = base64.b64decode(request['photo_base64'], validate=True)
        if len(raw) > 5*1024*1024:
            raise ValueError('photo_too_large')
        image = decode_image(raw)
        if request.get('voice_text') != request['name'].strip() + '打卡成功':
            raise ValueError('name_voice_mismatch')
        audio = base64.b64decode(request['voice_pcma_base64'], validate=True)
        with self.pipeline_lock:
            embedding, _ = self.pipeline.embed(image)
        return self.store.enroll(request['person_id'], request['name'], embedding,
                                 self.model['modelId'], audio, hashlib.sha256(raw).hexdigest())

    def clear_today_test(self):
        with self.cycle_lock:
            result = self.store.clear_today_test(self.camera_id)
            self.seen.clear()
            return result


class AttendanceHub:
    """One database/model set and one HTTP service for all configured cameras."""
    def __init__(self, config):
        cameras = config.get('cameras')
        if cameras is None:
            cameras = [{'camera_id': 'camera-02', 'source_url': config['source_url']}]
        if (not isinstance(cameras, list) or not 1 <= len(cameras) <= 8
                or not all(isinstance(c, dict) and c.get('camera_id') and c.get('source_url') for c in cameras)
                or len({c['camera_id'] for c in cameras}) != len(cameras)):
            raise ValueError('invalid_camera_configuration')
        shared = None
        self.cameras = {}
        common = {k: v for k, v in config.items() if k != 'cameras'}
        for camera in cameras:
            worker = Attendance({**common, **camera}, shared=shared)
            shared = shared or worker
            self.cameras[worker.camera_id] = worker
        self.primary = shared
        self.store, self.model, self.token = shared.store, shared.model, shared.token
        self.stop, self.cycle_lock = shared.stop, shared.cycle_lock

    def start(self):
        for worker in self.cameras.values():
            worker.start()

    def request_stop(self):
        self.stop.set()
        for worker in self.cameras.values():
            worker.frame_ready.set()
            worker.voice_ready.set()

    def enroll(self, request):
        return self.primary.enroll(request)

    def clear_today_test(self):
        with self.cycle_lock:
            result = self.store.clear_today_test_for_cameras(list(self.cameras))
            for worker in self.cameras.values():
                worker.seen.clear()
            return result

    def status(self):
        states = [worker.status() for worker in self.cameras.values()]
        result = dict(states[0])
        online = [s for s in states if s['connected'] and s['frame_age_seconds'] is not None
                  and s['frame_age_seconds'] < 3]
        result.update(camera_id='shared', cameras=states, camera_count=len(states),
                      connected=bool(online), frames_processed=sum(s['frames_processed'] for s in states),
                      last_face_count=sum(s['last_face_count'] for s in states),
                      frame_age_seconds=min((s['frame_age_seconds'] for s in online), default=None),
                      last_error=None if online else 'all_sources_unavailable',
                      voice_enabled=any(s['voice_enabled'] for s in states))
        result['liveness'] = {**result['liveness'], 'latest_matches':[
            {**match, 'camera_id':s['camera_id']} for s in states for match in s['liveness']['latest_matches']]}
        return result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, status, body, mime='application/json; charset=utf-8'):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(body)

    def route(self):
        app = self.server.app
        if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + app.token):
            return self.reply(401, {'error': 'authentication_required'})
        if self.command == 'GET':
            if self.path in ('/', '/index.html'):
                return self.reply(200, Path(__file__).with_name('attendance.html').read_bytes(), 'text/html; charset=utf-8')
            if self.path == '/api/status':
                return self.reply(200, app.status())
            if self.path == '/api/dashboard':
                return self.reply(200, {'status': app.status(), 'people': app.store.people(),
                                        'records': app.store.records()})
            if self.path == '/api/people':
                return self.reply(200, {'people': app.store.people()})
            if self.path == '/api/attendance':
                return self.reply(200, {'records': app.store.records()})
            return self.reply(404, {'error': 'not_found'})
        if self.command != 'POST':
            return self.reply(405, {'error': 'method_not_allowed'})
        size = int(self.headers.get('Content-Length', '0'))
        if not 1 <= size <= 8*1024*1024:
            return self.reply(413, {'error': 'request_size_limit'})
        data = json.loads(self.rfile.read(size))
        if self.path == '/api/enroll':
            return self.reply(200, app.enroll(data))
        if self.path == '/api/attendance/clear':
            if data != {'scope': 'today', 'test_only': True}:
                return self.reply(400, {'error': 'today_test_scope_required',
                                        'message': '仅支持清除已接入球机今日的测试打卡记录。'})
            return self.reply(200, app.clear_today_test())
        if self.path == '/api/voice/confirm':
            return self.reply(200, {'confirmed': app.store.confirm_voice(data['attendance_id'])})
        return self.reply(404, {'error': 'not_found'})

    def safe_route(self):
        try:
            self.route()
        except AttendanceResetBusy:
            self.reply(409, {'error': 'voice_in_progress', 'message': '正在播报，请等播报结束后再清除。'})
        except (ValueError, KeyError, TypeError) as error:
            code = getattr(error, 'code', None)
            self.reply(422, {'error': code or 'invalid_enrollment',
                             'message': '请使用清晰、完整且只有一张人脸的照片，并填写人员编号和姓名。'})
        except Exception:
            self.reply(503, {'error': 'temporarily_unavailable'})

    do_GET = do_POST = do_OPTIONS = do_DELETE = safe_route


def bind_address(config):
    bind = config.get('bind', {'host': '127.0.0.1', 'port': 28982})
    host, port = bind.get('host'), bind.get('port')
    if not isinstance(host, str) or ipaddress.ip_address(host).version != 4:
        raise ValueError('invalid_bind_host')
    if type(port) is not int or not 1024 <= port <= 65535:
        raise ValueError('invalid_bind_port')
    return host, port


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text(encoding='utf-8'))
    address = bind_address(config)
    app = AttendanceHub(config)
    server = ThreadingHTTPServer(address, Handler)
    server.daemon_threads = True
    server.app = app
    def shutdown(*_):
        app.request_stop()
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    app.start()
    print(json.dumps({'attendance_started': True, 'camera_ids': list(app.cameras), 'model': app.model,
                      'people': len(app.store.people()), 'voice_requires_playback_verification': True}), flush=True)
    try:
        server.serve_forever(poll_interval=.2)
    finally:
        app.request_stop()
        server.server_close()


if __name__ == '__main__':
    main()
