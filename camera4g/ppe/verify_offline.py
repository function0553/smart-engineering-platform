"""Finite synthetic/file checks; no RTSP socket or HTTP listener is opened."""
import argparse
from copy import deepcopy
from email.message import Message
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace

import av
import cv2
import numpy as np

from configuration import MODEL_SHA256, validate_config
from engine import Detector
from http_api import Handler
from media_publisher import FFmpegPublisher, command
from rtsp_reader import RTSPReader
from video_runtime import ApiError, VideoRuntime

ROOT = Path(__file__).resolve().parent


class Clock:
    now = 100.
    def mono(self):
        return self.now
    def wall(self):
        return 1800000000+self.now


class MockDetector:
    sha256 = MODEL_SHA256
    contract = {'test_backend': 'explicit_mock_not_model_inference'}
    hook = None
    def predict(self, image):
        if self.hook:
            fn, self.hook = self.hook, None
            fn()
        w, h = image.shape[1], image.shape[0]
        return [{'label': 'person', 'confidence': .9, 'box': [w*.2,h*.15,w*.7,h*.9]},
                {'label': 'hardhat', 'confidence': .9, 'box': [w*.35,h*.15,w*.5,h*.25]}], 1.


class MockPublisher:
    last_error = None
    def __init__(self):
        self.writes = []
        self.resets = 0
    def write(self, epoch, image):
        self.writes.append((epoch, image.copy()))
        return {'video_frame_index': len(self.writes)-1, 'media_session_id': 'offline_mock',
                'media_delivery_status': 'explicit_mock_not_media_receipt'}
    def reset(self):
        self.resets += 1
    def close(self):
        pass


def fixture():
    config = json.loads((ROOT/'config.example.json').read_text(encoding='utf-8'))
    config['camera']['expected_size'] = [320, 180]
    config['camera']['main_source_verified'] = True  # Synthetic source contract only.
    config['media']['enabled'] = True  # Historical finite rendering checks.
    config['diagnostic_jpeg_enabled'] = True
    config = validate_config(config)
    clock, detector, publisher = Clock(), MockDetector(), MockPublisher()
    runtime = VideoRuntime(config, detector, {'admin': 'a'*32, 'camera-01': 'b'*32},
                           publisher, clock.mono, clock.wall)
    return config, clock, detector, publisher, runtime


def admit(runtime, clock, value=50):
    epoch = runtime.epoch
    runtime.decoded(epoch, clock.mono(), None)
    runtime.accept_frame(epoch, np.full((180,320,3), value, np.uint8), clock.mono())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ffmpeg', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    checks = []
    c, clock, d, pub, r = fixture()
    r.connected()
    admit(r, clock, 30)
    admit(r, clock, 60)
    assert r.replaced == 1 and r.pending.sequence == 2
    assert r.process_once()
    result, jpeg = r.snapshot(True)
    assert result['sequence'] == 2 and result['frame_size'] == [320,180]
    assert result['processed_results_count'] == r.status()['processed_results_count'] == 1
    assert len(pub.writes) == 1 and all(p['states'] == {'helmet':'unknown','vest':'unknown'} for p in result['persons'])
    assert not result['sensor_exposure_utc_verified']
    assert cv2.imdecode(np.frombuffer(jpeg,np.uint8),cv2.IMREAD_COLOR).shape == (180,320,3)
    checks.append({'name': 'latest_same_frame_and_unknown_timing', 'passed': True})
    clock.now += 10
    try:
        r.snapshot()
        raise AssertionError('stale_result_accepted')
    except ApiError as error:
        assert error.status == 503
    assert not r.status()['result_available']
    checks.append({'name': 'ttl_withdraws_results', 'passed': True})
    r.connected()
    admit(r, clock)
    writes = len(pub.writes)
    commits_before = r.processed_results_count
    d.hook = r.connected  # A reconnection occurs during the old inference.
    assert r.process_once() and len(pub.writes) == writes and r.result is None
    assert r.processed_results_count == commits_before
    r.disconnected(r.epoch, 'offline_disconnect')
    assert r.pending is r.result is r.jpeg is None and not r.connected_flag
    checks.append({'name': 'reconnect_inflight_and_disconnect_isolation', 'passed': True})
    r.connected()
    admit(r, clock)
    r.process_once()
    assert r.authenticated('Bearer '+'b'*32, 'camera-01') and not r.authenticated('Bearer '+'b'*32, admin_only=True)
    h = object.__new__(Handler)
    h.server = SimpleNamespace(runtime=r)
    h.headers = Message()
    h.headers['Authorization'] = 'Bearer '+'b'*32
    h.path = '/v1/cameras/camera-01/frame.jpg?epoch=999&sequence=1'
    try:
        h.route()
        raise AssertionError('wrong_pair_accepted')
    except ApiError as error:
        assert error.status == 409
    checks.append({'name': 'bearer_scope_and_snapshot_mismatch', 'passed': True})
    # Exercise the actual worker loop with a finite fake clock/event. The
    # overlong second step cannot create historical-deadline catch-up starts.
    class FakeEvent:
        def __init__(self, clock):
            self.clock, self.done, self.waits = clock, False, []
        def is_set(self):
            return self.done
        def wait(self, duration):
            self.waits.append(duration)
            self.clock.now += duration
    loop_clock = Clock()
    loop_event = FakeEvent(loop_clock)
    loop = object.__new__(VideoRuntime)
    loop.config = {'limits': {'inference_fps': 4}}
    loop.monotonic = loop_clock.mono
    loop.stopped = loop_event
    starts, durations = [], [.10, .45, .02]
    def step():
        starts.append(loop_clock.now)
        loop_clock.now += durations[len(starts)-1]
        if len(starts) == len(durations):
            loop_event.done = True
        return True
    loop.process_once = step
    loop._worker_loop()
    assert np.allclose(starts, [100.,100.25,100.70])
    assert np.allclose(loop_event.waits, [.15])
    checks.append({'name':'start_to_start_cap_and_no_catch_up','passed':True,
                   'fps_cap':4,'step_durations_seconds':durations,'relative_start_times_seconds':[round(x-100,5) for x in starts]})
    legacy_config = deepcopy(c)
    legacy_config.pop('diagnostic_jpeg_enabled')
    legacy_config['media'].pop('enabled')
    legacy_config = validate_config(legacy_config)
    assert legacy_config['diagnostic_jpeg_enabled'] and legacy_config['media']['enabled']
    for key in ('diagnostic_jpeg_enabled', 'enabled'):
        invalid = deepcopy(c)
        if key == 'enabled':
            invalid['media'][key] = 'false'
        else:
            invalid[key] = 'false'
        try:
            validate_config(invalid)
            raise AssertionError('string_flag_accepted')
        except ValueError:
            pass
    checks.append({'name':'optional_flags_legacy_defaults_and_strict_bool','passed':True})
    json_only = deepcopy(c)
    json_only['media']['enabled'] = False
    json_only['media']['ffmpeg_binary'] = '/not-installed/no-ffmpeg-required'
    json_only['diagnostic_jpeg_enabled'] = False
    json_runtime = VideoRuntime(json_only, MockDetector(), {'admin':'a'*32,'camera-01':'b'*32},
                                None, clock.mono, clock.wall)
    import video_runtime as runtime_module
    from unittest.mock import patch
    json_runtime.connected()
    admit(json_runtime, clock)
    with (patch.object(runtime_module, 'annotate', side_effect=AssertionError('unexpected_render')),
          patch.object(cv2, 'imencode', side_effect=AssertionError('unexpected_jpeg'))):
        assert json_runtime.process_once()
    json_result = json_runtime.snapshot(jpeg=False)
    assert json_result['media']['media_delivery_status'] == 'inference_worker_does_not_publish_display_video'
    assert json_runtime.publisher is None and json_runtime.jpeg is None and json_runtime.error is None
    h.server = SimpleNamespace(runtime=json_runtime)
    h.path = '/v1/cameras/camera-01/results'
    json_replies = []
    h.json = lambda status, value: json_replies.append((status,value))
    h.route()
    assert json_replies[-1][0] == 200 and json_replies[-1][1]['frame_jpeg_path'] is None
    json_runtime.jpeg = b'injected-old-jpeg-must-never-be-served'
    h.path = '/v1/cameras/camera-01/frame.jpg'
    try:
        h.route()
        raise AssertionError('disabled_jpeg_served')
    except ApiError as error:
        assert error.status == 503 and error.code == 'diagnostic_jpeg_disabled'
    assert json_runtime.jpeg is None and json_runtime.snapshot()['sequence'] == json_result['sequence']
    json_runtime.disconnected(json_runtime.epoch, 'offline_disconnect')
    assert json_runtime.result is None and json_runtime.jpeg is None and json_runtime.stop()
    checks.append({'name':'json_only_no_publisher_no_render_results_and_disabled_jpeg','passed':True})
    from fractions import Fraction
    import rtsp_reader as reader_module
    class FakeFrame:
        width, height, time_base = 320, 180, Fraction(1,25)
        def __init__(self, pts):
            self.pts = pts
        def to_ndarray(self, format):
            assert format == 'bgr24'
            return np.zeros((180,320,3),np.uint8)
    class FakeContainer:
        streams = SimpleNamespace(video=[SimpleNamespace(codec_context=SimpleNamespace())])
        def decode(self, stream):
            return iter(FakeFrame(p) for p in [0,0,-1,None,3])
        def close(self):
            pass
    class PTSObserver:
        def __init__(self, config):
            self.config, self.rows, self.reasons = config, [], []
        def connected(self):
            return 1
        def decoded(self, epoch, now, pts, status):
            if len(self.rows) == 4:
                self.reader.stop_event.set()
        def accept_frame(self, epoch, image, now, pts, lag, status):
            self.rows.append((pts, lag, status))
        def disconnected(self, epoch, reason):
            self.reasons.append(reason)
            self.reader.stop_event.set()
    observe_config = deepcopy(c)
    observe_config['limits']['source_pts_policy'] = 'observe'
    observe_config['limits']['inference_fps'] = 10
    observer = PTSObserver(observe_config)
    observer.reader = RTSPReader(observer,'rtsp://127.0.0.1:65534/synthetic-not-contacted',opener=lambda *a,**k:FakeContainer())
    with patch.object(reader_module.time,'monotonic',side_effect=[0.,.2,.4,.6,.8]):
        observer.reader.run()
    assert [row[0] for row in observer.rows] == [0.,0.,-.04,None,.12]
    assert [row[2] for row in observer.rows] == ['observed_unverified']+['unstable']*4
    assert all(row[1] is None for row in observer.rows) and observer.reasons == ['source_stopped']
    strict_config = deepcopy(observe_config)
    strict_config['limits']['source_pts_policy'] = 'strict'
    strict_observer = PTSObserver(strict_config)
    strict_observer.reader = RTSPReader(strict_observer,'rtsp://127.0.0.1:65534/synthetic-not-contacted',opener=lambda *a,**k:FakeContainer())
    with patch.object(reader_module.time,'monotonic',side_effect=[0.,.2]):
        strict_observer.reader.run()
    assert 'source_pts_discontinuity' in strict_observer.reasons and len(strict_observer.rows) == 1
    checks.append({'name':'observe_pts_repeat_backwards_missing_without_reconnect_and_strict_guard','passed':True,
                   'observed_raw_pts_seconds':[row[0] for row in observer.rows]})
    # Eight decoded frames arrive in 35ms, below the 250ms inference cap.
    # Reader must retain the last frame, not discard seven after the first.
    burst_clock = Clock()
    burst_detector = MockDetector()
    burst_runtime = VideoRuntime(json_only,burst_detector,{'admin':'a'*32,'camera-01':'b'*32},None,
                                 burst_clock.mono,burst_clock.wall)
    class BurstFrame(FakeFrame):
        def to_ndarray(self, format):
            assert format == 'bgr24'
            return np.full((180,320,3),self.pts,np.uint8)
    class BurstContainer(FakeContainer):
        def decode(self, stream):
            return iter(BurstFrame(p) for p in range(8))
    class BurstBridge:
        config = json_only
        def connected(self):
            return burst_runtime.connected()
        def decoded(self, epoch, now, pts, status):
            burst_runtime.decoded(epoch,now,pts,status)
            if burst_runtime.decoded_count == 8:
                self.reader.stop_event.set()
        def accept_frame(self, *args):
            return burst_runtime.accept_frame(*args)
        def disconnected(self, epoch, reason):
            # Keep the final finite fixture slot for assertions, then explicitly
            # exercise the real disconnect clear below. No live transport exists.
            self.reason = reason
            self.reader.stop_event.set()
    burst_bridge = BurstBridge()
    burst_reader = RTSPReader(burst_bridge,'rtsp://127.0.0.1:65534/finite-burst-not-contacted',
                             opener=lambda *a,**k:BurstContainer())
    burst_bridge.reader = burst_reader
    with patch.object(reader_module.time,'monotonic',side_effect=[100.+n*.005 for n in range(8)]):
        burst_reader.run()
    assert burst_runtime.decoded_count == burst_runtime.sequence == 8
    assert burst_runtime.replaced == 7 and burst_runtime.pending.sequence == 8
    assert int(burst_runtime.pending.image[0,0,0]) == 7
    burst_clock.now += .05
    assert burst_runtime.process_once()
    burst_result = burst_runtime.snapshot()
    assert burst_result['sequence'] == burst_result['source_decode_sequence_local'] == 8
    assert burst_result['processed_results_count'] == 1 and burst_runtime.pending is None
    assert not burst_runtime.process_once() and burst_runtime.processed_results_count == 1
    burst_runtime.connected()
    assert burst_runtime.sequence == 0 and burst_runtime.processed_results_count == 1
    admit(burst_runtime,burst_clock)
    burst_detector.hook = burst_runtime.connected
    assert burst_runtime.process_once() and burst_runtime.processed_results_count == 1 and burst_runtime.result is None
    admit(burst_runtime,burst_clock)
    assert burst_runtime.process_once() and burst_runtime.snapshot()['processed_results_count'] == 2
    burst_runtime.disconnected(burst_runtime.epoch,'offline_burst_end')
    assert burst_runtime.pending is burst_runtime.result is None and burst_runtime.processed_results_count == 2
    checks.append({'name':'burst_keeps_latest_frame_and_lifetime_successful_commit_counter','passed':True,
                   'burst_frame_count':8,'burst_seconds':.035,'latest_sequence':8,'pending_replacements':7,
                   'successful_commits_across_epochs':2,'inflight_reconnect_increments_counter':False})
    pts_runtime = VideoRuntime(json_only,MockDetector(),{'admin':'a'*32,'camera-01':'b'*32},None,clock.mono,clock.wall)
    pts_epoch = pts_runtime.connected()
    pts_runtime.decoded(pts_epoch,clock.mono(),1000.,'unstable')
    pts_runtime.accept_frame(pts_epoch,np.zeros((180,320,3),np.uint8),clock.mono(),1000.,None,'unstable')
    assert pts_runtime.process_once()
    pts_result = pts_runtime.snapshot()
    assert pts_result['source_pts_seconds'] == 1000. and pts_result['source_pts_status'] == 'unstable'
    assert pts_result['timestamp_semantics'] == 'decoder_receive_monotonic' and not pts_result['temporal_confirmation_enabled']
    assert pts_result['source_decode_sequence_local'] == 1
    assert not pts_result['tracking']['temporal_confirmation_enabled']
    checks.append({'name':'unstable_pts_metadata_preserved_arrival_time_and_no_temporal_confirmation','passed':True})
    if args.ffmpeg == 'imageio':
        import imageio_ffmpeg
        c['media']['ffmpeg_binary'] = imageio_ffmpeg.get_ffmpeg_exe()
    else:
        c['media']['ffmpeg_binary'] = str(Path(args.ffmpeg).resolve())
    with tempfile.TemporaryDirectory(prefix='ppe-video-offline-') as tmp:
        output = Path(tmp)/'annotated.mp4'
        publisher = FFmpegPublisher(c, output=output)
        r = VideoRuntime(c, MockDetector(), {'admin':'a'*32,'camera-01':'b'*32}, publisher, clock.mono, clock.wall)
        r.connected()
        originals = []
        results = []
        for n in range(2):
            clock.now += 1
            admit(r, clock, 50+n*20)
            assert r.process_once()
            result, jpeg = r.snapshot(True)
            assert result['media'].get('video_frame_index') == n, str((n, publisher.last_error))
            results.append(result)
            originals.append(cv2.imdecode(np.frombuffer(jpeg,np.uint8),cv2.IMREAD_COLOR))
        publisher.close(graceful=True)
        assert output.is_file() and output.stat().st_size > 0
        with av.open(str(output)) as container:
            frames = [frame.to_ndarray(format='bgr24') for frame in container.decode(video=0)]
        assert len(frames) == 2 and all(frame.shape == (180,320,3) for frame in frames)
        mae = [float(np.abs(f.astype(float)-o.astype(float)).mean()) for f,o in zip(frames, originals)]
        assert max(mae) < 10
        checks.append({'name': 'real_ffmpeg_same_frame_h264_file', 'passed': True, 'decoded_frames':len(frames),
                       'frame_size':[320,180], 'jpeg_video_mean_absolute_errors':mae,
                       'bytes':output.stat().st_size,'sha256':hashlib.sha256(output.read_bytes()).hexdigest()})
        class Observed:
            config = c
            def __init__(self):
                self.decoded_count = self.accepted = 0
                self.shape = None
            def connected(self):
                return 1
            def decoded(self, epoch, now, pts, pts_status='observed_unverified'):
                self.decoded_count += 1
                reader.stop_event.set()
            def accept_frame(self, epoch, image, now, pts, lag, pts_status='observed_unverified'):
                self.accepted += 1
                self.shape = list(image.shape)
            def disconnected(self, epoch, reason):
                pass
        observer = Observed()
        reader = RTSPReader(observer, 'rtsp://127.0.0.1:65534/offline-not-contacted',
                            opener=lambda *a,**k: av.open(str(output)))
        reader.run()
        assert observer.accepted == 1 and observer.decoded_count == 1 and observer.shape == [180,320,3]
        checks.append({'name':'real_pyav_file_reader_no_network','passed':True})
    real = Detector(ROOT/'models/reference-v0.3', device='cpu', intra_threads=1, person_conf=.20)
    detections, ms = real.predict(np.zeros((360,640,3),np.uint8))
    assert real.sha256 == MODEL_SHA256 and real.contract['providers'] == ['CPUExecutionProvider']
    checks.append({'name': 'real_model_cpu_black_frame', 'passed': True, 'network_calls':1,
                   'detections':len(detections),'inference_ms':ms,'backend':real.contract})
    # One actual CPU8 runtime/render/encode/decode pass, separate from fake
    # detector checks. Local Windows evidence, not the remote eight-core quota.
    real8 = Detector(ROOT/'models/reference-v0.3', device='cpu', intra_threads=8, person_conf=.20)
    config8 = deepcopy(c)
    config8['intra_threads'] = 8
    config8['camera']['expected_size'] = [640,360]
    with tempfile.TemporaryDirectory(prefix='ppe-video-cpu8-onepass-') as tmp:
        output8 = Path(tmp)/'one-frame.mp4'
        pub8 = FFmpegPublisher(config8, output=output8)
        rt8 = VideoRuntime(config8, real8, {'admin':'a'*32,'camera-01':'b'*32}, pub8)
        epoch8 = rt8.connected()
        received8 = rt8.monotonic()
        rt8.decoded(epoch8, received8, None)
        rt8.accept_frame(epoch8,np.zeros((360,640,3),np.uint8),received8)
        assert rt8.process_once()
        result8, jpeg8 = rt8.snapshot(True)
        assert result8['media'].get('video_frame_index') == 0 and result8['inference_backend']['intra_threads'] == 8
        pub8.close(graceful=True)
        with av.open(str(output8)) as stream8:
            count8 = sum(1 for frame8 in stream8.decode(video=0) if [frame8.width,frame8.height]==[640,360])
        assert count8 == 1 and len(jpeg8)>0
        checks.append({'name':'real_runtime_cpu8_finite_one_pass','passed':True,
                       'scope':'local_windows_no_remote_quota','frame_size':[640,360],
                       'decoded_frames':count8,'inference_ms':result8['inference_ms'],
                       'provider':result8['inference_backend']})
    report = {'schema_version':1,'scope':'finite_local_offline_synthetic_file_only',
              'camera_contacted':False,'server_contacted':False,'http_listener_started':False,
              'model_sha256':MODEL_SHA256,'pyav_version':av.__version__,
              'checks':checks,'passed':all(x['passed'] for x in checks),
              'linux_cpu_verified':False,'four_g_main_stream_verified':False,'production_accepted':False}
    Path(args.out).write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding='utf-8')
    print(json.dumps({'checks':len(checks),'passed':report['passed'],'camera_contacted':False}))


if __name__ == '__main__':
    main()
