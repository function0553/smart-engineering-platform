import json
from pathlib import Path
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

from attendance_service import Attendance
from attendance_store import Store


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.app = Attendance.__new__(Attendance)
        app = self.app
        app.root = Path(temporary.name)
        (app.root/'private').mkdir()
        app.voice_gate = app.root/'private/voice-playback-verified.json'
        app.camera_id = 'camera-02'
        app.store = Store(app.root/'private/test.sqlite', 'test-model')
        self.feature = [1.] + [0.]*511
        app.store.enroll('test-1', '测试', self.feature, 'test-model', b'\xd5'*8000)
        app.stop = threading.Event()
        app.frame_ready = threading.Event()
        app.voice_ready = threading.Event()
        app.frame_lock = threading.Lock()
        app.cycle_lock = threading.Lock()
        app.pipeline_lock = threading.Lock()
        app.latest = None
        app.seen = {}
        app.model = {'modelId': 'test-model'}
        app.state = {'frames_processed': 0}
        app.performance = []
        app.recent_checkins = {}
        app.liveness = types.SimpleNamespace(model_id='test-pad', evaluate=lambda *_: {
            'state': 'passed', 'model_id': 'test-pad'})
        app.last_liveness = []

    def launch(self, target):
        thread = threading.Thread(target=target, daemon=True)
        thread.start()
        def cleanup():
            self.app.stop.set()
            self.app.frame_ready.set()
            self.app.voice_ready.set()
            thread.join(2)
        self.addCleanup(cleanup)
        return thread

    def test_new_checkin_wakes_voice_without_half_second_poll(self):
        app = self.app
        (app.root/'private/voice-playback-verified.json').write_text('{}')
        called = threading.Event()
        app.speaker = types.SimpleNamespace(send=lambda data: (
            called.set() or {'status': 'submitted_unverified', 'payload_bytes_sent': len(data)}))
        self.launch(app.speak)
        time.sleep(.04)  # Ensure the idle worker is waiting before arrival.
        app.store.checkin('test-1', 'camera-02', 'frame-1', '2026-10-19T08:00:00Z', .9, .01)
        app.voice_ready.set()
        self.assertTrue(called.wait(.25), 'voice worker still waits for polling')

    def test_acceleration_keeps_two_distinct_observations_and_daily_dedup(self):
        app = self.app
        (app.root/'private/voice-playback-verified.json').write_text('{}')
        preparations = []
        app.speaker = types.SimpleNamespace(prepare=lambda: preparations.append(True))
        fake_alignment = types.ModuleType('face_engine.alignment.face_align')
        fake_alignment.align_face = lambda image, landmarks: image
        app.pipeline = types.SimpleNamespace(
            detect=lambda image: [{'bbox': [100,100,220,240], 'landmarks': []}],
            recognizer=types.SimpleNamespace(extract_embeddings=lambda images: [self.feature]))
        image = types.SimpleNamespace(shape=(1440,2560,3))
        with patch.dict('sys.modules', {'face_engine.alignment.face_align': fake_alignment}):
            worker = self.launch(app.recognize)
            def frame(sequence):
                with app.frame_lock:
                    app.latest = ('session-test', sequence, time.monotonic(), '2026-10-19T08:00:00Z', image)
                app.frame_ready.set()
                deadline = time.monotonic()+1
                while app.state['frames_processed'] < sequence and time.monotonic() < deadline:
                    time.sleep(.005)
                self.assertEqual(app.state['frames_processed'], sequence)
            frame(1)
            self.assertEqual(app.store.records(), [])
            self.assertEqual(len(preparations), 1)
            frame(2)
            self.assertEqual(len(app.store.records()), 1)
            self.assertTrue(app.voice_ready.is_set())
            frame(3)
            self.assertEqual(len(app.store.records()), 1)
            app.seen.clear()
            frame(4)
            self.assertEqual(len(preparations), 1, 'already checked-in person must not prepare again')
            app.stop.set(); app.frame_ready.set(); worker.join(2)

    def test_photo_or_unknown_between_live_frames_never_counts_as_confirmation(self):
        app = self.app
        (app.root/'private/voice-playback-verified.json').write_text('{}')
        prepared=[]
        app.speaker=types.SimpleNamespace(prepare=lambda:prepared.append(True))
        verdict={'state':'rejected'}
        app.liveness.evaluate=lambda *_:{'state':verdict['state'],'model_id':'test-pad'}
        fake_alignment=types.ModuleType('face_engine.alignment.face_align')
        fake_alignment.align_face=lambda image, landmarks:image
        app.pipeline=types.SimpleNamespace(
            detect=lambda image:[{'bbox':[100,100,220,240],'landmarks':[]}],
            recognizer=types.SimpleNamespace(extract_embeddings=lambda images:[self.feature]))
        image=types.SimpleNamespace(shape=(1440,2560,3))
        with patch.dict('sys.modules',{'face_engine.alignment.face_align':fake_alignment}):
            worker=self.launch(app.recognize)
            for sequence,state in enumerate(['rejected','rejected','passed','unknown','passed','passed'],1):
                verdict['state']=state
                with app.frame_lock:
                    app.latest=('test-session',sequence,time.monotonic(),'2026-10-19T08:00:00Z',image)
                app.frame_ready.set()
                deadline=time.monotonic()+1
                while app.state['frames_processed']<sequence and time.monotonic()<deadline:time.sleep(.005)
                self.assertEqual(app.state['frames_processed'],sequence)
                self.assertEqual(len(app.store.records()),1 if sequence==6 else 0)
                if sequence<3:self.assertEqual(prepared,[])
            self.assertEqual(app.store.records()[0]['liveness_status'],'passed')
            app.stop.set();app.frame_ready.set();worker.join(2)

    def test_before_eight_does_not_prepare_audio_or_supply_a_confirmation_frame(self):
        app=self.app
        (app.root/'private/voice-playback-verified.json').write_text('{}')
        preparations=[]
        app.speaker=types.SimpleNamespace(prepare=lambda:preparations.append(True))
        fake_alignment=types.ModuleType('face_engine.alignment.face_align')
        fake_alignment.align_face=lambda image,landmarks:image
        app.pipeline=types.SimpleNamespace(
            detect=lambda image:[{'bbox':[100,100,220,240],'landmarks':[]}],
            recognizer=types.SimpleNamespace(extract_embeddings=lambda images:[self.feature]))
        image=types.SimpleNamespace(shape=(1440,2560,3))
        times=['07:59:58','07:59:59','08:00:00','08:00:01']
        with patch.dict('sys.modules',{'face_engine.alignment.face_align':fake_alignment}):
            worker=self.launch(app.recognize)
            for sequence,clock in enumerate(times,1):
                with app.frame_lock:
                    app.latest=('same-session',sequence,time.monotonic(),f'2026-10-21T{clock}+08:00',image)
                app.frame_ready.set()
                deadline=time.monotonic()+1
                while app.state['frames_processed']<sequence and time.monotonic()<deadline:time.sleep(.005)
                self.assertEqual(app.state['frames_processed'],sequence)
                self.assertEqual(len(app.store.records()),1 if sequence==4 else 0)
                if sequence<=2:
                    self.assertEqual(preparations,[])
                    self.assertFalse(app.voice_ready.is_set())
            self.assertEqual(app.store.records()[0]['attendance_status'],'on_time')
            self.assertTrue(app.voice_ready.is_set())
            app.stop.set();app.frame_ready.set();worker.join(2)


if __name__ == '__main__':
    unittest.main()
