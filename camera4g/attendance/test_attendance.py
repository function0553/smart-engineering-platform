import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from attendance_store import Store, voice_ready


MODEL = 'test-arcface-space'
E1 = [1.0] + [0.0] * 511
E2 = [0.0, 1.0] + [0.0] * 510
AUDIO = b'\xd5' * 8000


class AttendanceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'people.sqlite'
        self.store = Store(self.path, MODEL)
        self.store.enroll('employee-1', '测试甲', E1, MODEL, AUDIO)

    def test_templates_persist_and_wrong_model_cannot_match(self):
        reopened = Store(self.path, MODEL)
        self.assertEqual(reopened.match(E1, MODEL)['person_id'], 'employee-1')
        self.assertIsNone(reopened.match(E1, 'other-model'))
        with self.assertRaises(ValueError):
            reopened.enroll('employee-2', '测试乙', E2, 'other-model', AUDIO)

    def test_unknown_and_ambiguous_faces_create_no_attendance(self):
        self.assertIsNone(self.store.match(E2, MODEL))
        self.store.enroll('employee-2', '测试乙', E1, MODEL, AUDIO)
        self.assertIsNone(self.store.match(E1, MODEL))
        self.assertEqual(self.store.records(), [])

    def test_daily_dedup_survives_restart_and_two_camera_observations(self):
        first = self.store.checkin('employee-1', 'camera-02', 'frame-1', '2026-10-19T06:00:00Z', .91, .1)
        second = Store(self.path, MODEL).checkin('employee-1', 'camera-01', 'frame-2', '2026-10-19T06:00:01Z', .92, .1)
        self.assertTrue(first['created'])
        self.assertFalse(second['created'])
        self.assertEqual(first['attendance_id'], second['attendance_id'])
        self.assertEqual(len(self.store.records()), 1)

    def test_business_day_uses_shanghai_midnight(self):
        self.assertFalse(self.store.checked_in_today('employee-1', '2026-10-19T15:59:59Z'))
        self.store.checkin('employee-1', 'camera-02', 'frame-1', '2026-10-19T15:59:59Z', .91, .1)
        self.assertTrue(self.store.checked_in_today('employee-1', '2026-10-19T15:59:59Z'))
        self.assertFalse(self.store.checked_in_today('employee-1', '2026-10-19T16:00:01Z'))
        self.assertFalse(self.store.checkin('employee-1', 'camera-02', 'too-early', '2026-10-19T16:00:01Z', .92, .1)['created'])
        self.store.checkin('employee-1', 'camera-02', 'frame-2', '2026-10-20T00:00:00Z', .92, .1)
        self.assertEqual({x['business_date'] for x in self.store.records()}, {'2026-10-19', '2026-10-20'})

    def test_stale_observation_and_low_similarity_cannot_check_in(self):
        for similarity, age in [(.91, 4), (.40, .1), (float('nan'), .1)]:
            with self.assertRaises(ValueError):
                self.store.checkin('employee-1', 'camera-02', 'frame-1', '2026-10-19T06:00:00Z', similarity, age)
        self.assertEqual(self.store.records(), [])

    def test_liveness_proof_requires_both_observations_and_survives_test_archive(self):
        proof={'state':'passed','model_id':'test-pad'}
        with self.assertRaisesRegex(ValueError,'liveness_not_confirmed'):
            self.store.checkin('employee-1','camera-02','f1','2026-10-19T06:00:00Z',.9,.01,
                liveness={'previous':proof,'current':{'state':'rejected'}})
        item=self.store.checkin('employee-1','camera-02','f2','2026-10-19T06:00:01Z',.9,.01,
            liveness={'previous':proof,'current':proof})
        self.assertEqual(self.store.records()[0]['liveness_status'],'passed')
        self.store.clear_today_test('camera-02',datetime(2026,10,19,7,tzinfo=timezone.utc))
        with self.store.connect() as db:
            self.assertIsNotNone(db.execute('SELECT proof_json FROM attendance_liveness WHERE attendance_id=?',
                (item['attendance_id'],)).fetchone())

    def test_claim_is_once_and_crashed_delivery_is_not_replayed(self):
        self.store.checkin('employee-1', 'camera-02', 'frame-1', '2026-10-19T06:00:00Z', .91, .1)
        first = self.store.claim_voice()
        self.assertEqual(first['name'], '测试甲')
        self.assertIsNone(self.store.claim_voice())
        reopened = Store(self.path, MODEL)
        reopened.recover_inflight()
        self.assertIsNone(reopened.claim_voice())
        self.assertEqual(reopened.records()[0]['voice_status'], 'delivery_unknown')

    def test_voice_bytes_are_bound_to_enrolled_person_and_snapshot_name(self):
        self.store.checkin('employee-1', 'camera-02', 'frame-1', '2026-10-19T06:00:00Z', .91, .1)
        self.store.enroll('employee-1', '新姓名', E1, MODEL, b'\x55' * 16000)
        item = self.store.claim_voice()
        self.assertEqual(item['name'], '测试甲')
        self.assertEqual(item['voice_pcma'], AUDIO)

    def test_test_reset_archives_only_today_for_this_camera_and_allows_new_checkin(self):
        self.store.checkin('employee-1', 'camera-02', 'yesterday', '2026-10-18T06:00:00Z', .91, .1)
        first = self.store.checkin('employee-1', 'camera-02', 'today', '2026-10-19T06:00:00Z', .91, .1)
        self.store.enroll('employee-2', '测试乙', E2, MODEL, AUDIO)
        self.store.checkin('employee-2', 'camera-01', 'other-camera', '2026-10-19T06:00:00Z', .92, .1)
        result = self.store.clear_today_test('camera-02', datetime(2026, 10, 19, 7, tzinfo=timezone.utc))
        self.assertEqual(result['deleted'], 1)
        self.assertEqual(len(self.store.records()), 2)
        self.assertEqual(self.store.match(E1, MODEL)['person_id'], 'employee-1')
        with self.store.connect() as db:
            archived = db.execute('SELECT attendance_id,voice_pcma FROM attendance_test_archive').fetchall()
        self.assertEqual([(x[0], x[1]) for x in archived], [(first['attendance_id'], AUDIO)])
        again = self.store.checkin('employee-1', 'camera-02', 'new-observation', '2026-10-19T07:00:01Z', .93, .1)
        self.assertTrue(again['created'])
        self.assertNotEqual(again['attendance_id'], first['attendance_id'])

    def test_test_reset_refuses_to_clear_an_active_voice_delivery(self):
        self.store.checkin('employee-1', 'camera-02', 'today', '2026-10-19T06:00:00Z', .91, .1)
        self.store.claim_voice()
        with self.assertRaisesRegex(RuntimeError, 'voice_in_progress'):
            self.store.clear_today_test('camera-02', datetime(2026, 10, 19, 7, tzinfo=timezone.utc))
        self.assertEqual(len(self.store.records()), 1)

    def test_test_reset_uses_shanghai_date(self):
        self.store.checkin('employee-1', 'camera-02', 'before-midnight', '2026-10-19T15:59:59Z', .91, .1)
        self.store.checkin('employee-1', 'camera-02', 'after-eight', '2026-10-20T00:00:00Z', .91, .1)
        result = self.store.clear_today_test('camera-02', datetime(2026, 10, 20, 0, 1, tzinfo=timezone.utc))
        self.assertEqual(result['business_date'], '2026-10-20')
        self.assertEqual([x['business_date'] for x in self.store.records()], ['2026-10-19'])


class VoiceReadyTests(unittest.TestCase):
    def test_requires_matching_session_ack_tcp_and_websocket_before_audio(self):
        good = dict(sessionId='session-a', inviteReceived=True, ackReady=True,
                    transport='TCP', tcpConnected=True, wsBound=True, senderStarted=True,
                    senderDone=False, stopped=False, failureReason='')
        self.assertTrue(voice_ready(good, 'session-a'))
        for field, value in [('sessionId', 'old-session'), ('ackReady', False),
                             ('tcpConnected', False), ('wsBound', False),
                             ('stopped', True), ('failureReason', 'ack_wait_failed')]:
            self.assertFalse(voice_ready({**good, field: value}, 'session-a'), field)


if __name__ == '__main__':
    unittest.main()
