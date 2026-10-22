import json
from pathlib import Path
import tempfile
import unittest
from datetime import datetime, timezone

from attendance_policy import AttendancePolicy
from attendance_store import Store


class PolicyTests(unittest.TestCase):
    def test_shanghai_time_boundaries(self):
        policy=AttendancePolicy()
        cases=[('2026-10-21T07:59:59.999999+08:00','too_early',0),
               ('2026-10-21T08:00:00+08:00','on_time',0),
               ('2026-10-21T09:04:59+08:00','on_time',0),
               ('2026-10-21T09:05:00+08:00','on_time',0),
               ('2026-10-21T09:05:00.000001+08:00','late',1),
               ('2026-10-21T01:06:01Z','late',61),
               ('2026-10-21T23:59:59+08:00','late',53699),
               ('2026-10-21T16:00:00Z','too_early',0)]
        for timestamp,status,seconds in cases:
            with self.subTest(timestamp=timestamp):
                actual=policy.classify(timestamp)
                self.assertEqual(actual['attendance_status'],status)
                self.assertEqual(actual['late_seconds'],seconds)
                self.assertEqual(actual['allowed'],status!='too_early')

    def test_invalid_policy_cannot_silently_change_timezone_or_disable_rules(self):
        for config in [{'timezone':'UTC'},{'start':'25:00'},{'normal_until':'9.05'},
                       {'start':'10:00','normal_until':'09:05'},{'enabled':False}]:
            with self.subTest(config=config),self.assertRaises(ValueError):AttendancePolicy(config)
        with self.assertRaises(ValueError):AttendancePolicy().classify('2026-10-21T08:30:00')


class ScheduledStoreTests(unittest.TestCase):
    def setUp(self):
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup)
        self.path=Path(directory.name)/'test.sqlite'
        self.store=Store(self.path,'test-model')
        self.store.enroll('test-person','测试',[1.]+[0.]*511,'test-model',b'\xd5'*8000)

    def checkin(self,timestamp,observation='frame'):
        return self.store.checkin('test-person','camera-02',observation,timestamp,.9,.01)

    def test_early_face_creates_no_record_and_no_pending_audio(self):
        result=self.checkin('2026-10-21T07:59:59+08:00')
        self.assertFalse(result['created'])
        self.assertEqual(result['reason'],'before_checkin_window')
        self.assertEqual(self.store.records(),[])
        self.assertIsNone(self.store.claim_voice())
        self.assertTrue(self.checkin('2026-10-21T08:00:00+08:00','new-frame')['created'])

    def test_first_normal_card_is_not_reclassified_when_seen_late_after_restart(self):
        first=self.checkin('2026-10-21T09:05:00+08:00')
        duplicate=Store(self.path,'test-model').checkin('test-person','camera-02','later',
                                                       '2026-10-21T10:00:00+08:00',.9,.01)
        self.assertFalse(duplicate['created'])
        self.assertEqual(first['attendance_id'],duplicate['attendance_id'])
        self.assertEqual(self.store.records()[0]['attendance_status'],'on_time')
        self.assertEqual(self.store.records()[0]['late_seconds'],0)

    def test_late_card_keeps_its_duration_and_policy_after_test_archive(self):
        item=self.checkin('2026-10-21T09:07:03+08:00')
        self.assertEqual(item['attendance_status'],'late')
        self.assertEqual(item['late_seconds'],123)
        self.store.clear_today_test('camera-02',datetime(2026,10,21,2,tzinfo=timezone.utc))
        with self.store.connect() as db:
            row=db.execute('SELECT * FROM attendance_schedule WHERE attendance_id=?',(item['attendance_id'],)).fetchone()
            self.assertEqual(row['late_seconds'],123)
            self.assertEqual(json.loads(row['policy_json'])['normal_until'],'09:05')

    def test_next_day_must_reach_eight_but_does_not_need_reenrollment(self):
        self.checkin('2026-10-21T08:10:00+08:00')
        self.assertFalse(self.checkin('2026-10-22T00:00:00+08:00')['created'])
        self.assertTrue(self.checkin('2026-10-22T08:10:00+08:00')['created'])
        self.assertEqual(len(self.store.records()),2)
        self.assertEqual(len(self.store.people()),1)

    def test_old_records_are_not_retroactively_marked_late(self):
        item=self.checkin('2026-10-21T10:00:00+08:00')
        with self.store.connect() as db:
            db.execute('DELETE FROM attendance_schedule WHERE attendance_id=?',(item['attendance_id'],))
        old=Store(self.path,'test-model').records()[0]
        self.assertEqual(old['attendance_status'],'legacy_unclassified')
        self.assertIsNone(old['late_seconds'])


if __name__=='__main__':unittest.main()
