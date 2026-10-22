import json
from pathlib import Path
import sqlite3
import shutil
import tempfile
import unittest

from attendance_store import Store


class ChangeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)/'test.sqlite'
        self.store = Store(self.path, 'model-test')
        self.store.enroll('p1', '测试', [1.]+[0.]*511, 'model-test', b'\xd5'*8000)

    def seed_legacy(self, count):
        with self.store.connect() as db:
            for index in range(count):
                db.execute('''INSERT INTO attendance(attendance_id,person_id,name,business_date,
                    occurred_at,camera_id,observation_id,similarity,model_id,voice_pcma,created_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?)''', (f'old-{index:04d}', 'p1', '测试', f'2000-{index:04d}',
                    '2026-10-21T02:00:00+00:00', 'camera-02', f'o-{index}', .9, 'model-test', b'\xd5'*8000,
                    '2026-10-21T02:00:00+00:00'))

    def test_all_1000_records_migrate_and_paginate_after_restart(self):
        self.seed_legacy(1000)
        store = Store(self.path, 'model-test')
        first = store.changes(0, 137)
        cursor, ids, stream = 0, [], first['stream_id']
        for _ in range(10):
            page = store.changes(cursor, 137)
            self.assertEqual(page['stream_id'], stream)
            ids += [e['record']['attendance_id'] for e in page['events']]
            cursor = page['next_cursor']
            store = Store(self.path, 'model-test')
            if not page['has_more']:
                break
        self.assertEqual(len(ids), 1000)
        self.assertEqual(len(set(ids)), 1000)
        self.assertEqual(store.changes(cursor)['events'], [])
        self.assertEqual(store.changes(0, 137), first)

    def test_checkin_voice_and_reset_are_transactional_snapshots(self):
        proof = {k: {'state': 'passed', 'model_id': 'live-test'} for k in ('previous', 'current')}
        result = self.store.checkin('p1', 'camera-02', 'obs1', '2026-10-22T02:00:00Z', .9, .1, proof)
        one = self.store.changes()
        self.assertEqual(one['events'][0]['kind'], 'checkin')
        self.assertEqual(one['events'][0]['record']['attendance_id'], result['attendance_id'])
        self.store.claim_voice('camera-02')
        self.store.finish_voice(result['attendance_id'], 'submitted_unverified', {})
        self.store.confirm_voice(result['attendance_id'])
        two = self.store.changes(one['next_cursor'])
        self.assertEqual(two['events'][-1]['record']['voice_status'], 'playback_confirmed')
        from datetime import datetime, timezone
        self.store.clear_today_test('camera-02', datetime(2026,10,22,3,tzinfo=timezone.utc))
        reset = self.store.changes(two['next_cursor'])
        self.assertEqual(reset['events'][-1]['kind'], 'test_reset')
        text = json.dumps(self.store.changes())
        for secret in ['voice_pcma', 'embedding', 'photo_sha256']:
            self.assertNotIn(secret, text)
        self.assertEqual(self.store.records(), [])
        self.assertGreater(len(self.store.changes()['events']), 1)

    def test_invalid_page_cursor_is_rejected(self):
        for after, limit in [(-1,200),(True,200),('1',200),(1,200),(0,0),(0,501),(0,True)]:
            with self.subTest(after=after,limit=limit), self.assertRaises(ValueError):
                self.store.changes(after,limit)

    def test_mutation_rolls_back_if_journal_write_fails(self):
        with self.store.connect() as db:
            db.execute("CREATE TRIGGER fail_event BEFORE INSERT ON attendance_changes BEGIN SELECT RAISE(ABORT,'test'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.store.checkin('p1','camera-02','obs1','2026-10-22T02:00:00Z',.9,.1)
        self.assertEqual(self.store.records(), [])

    def test_restored_backup_exposes_changed_anchor_even_when_sequence_catches_up(self):
        self.store.checkin('p1','camera-02','one','2026-10-22T02:00:00Z',.9,.1)
        backup=self.path.with_name('backup.sqlite');shutil.copyfile(self.path,backup)
        self.store.claim_voice('camera-02')
        self.store.finish_voice(self.store.records()[0]['attendance_id'],'submitted_unverified',{})
        previous=self.store.changes()
        self.assertEqual(previous['next_cursor'],3)
        shutil.copyfile(backup,self.path)
        for date in ['23','24','25']:
            self.store.checkin('p1','camera-02',date,f'2026-10-{date}T02:00:00Z',.9,.1)
        restored=self.store.changes(3)
        self.assertEqual(restored['stream_id'],previous['stream_id'])
        self.assertNotEqual(restored['after_digest'],previous['events'][-1]['digest'])

    def test_cursor_digest_binds_prefix_even_if_last_event_is_identical_after_restore(self):
        self.store.checkin('p1','camera-02','one','2026-10-22T02:00:00Z',.9,.1)
        backup=self.path.with_name('backup.sqlite');shutil.copyfile(self.path,backup)
        self.store.checkin('p1','camera-02','B','2026-10-23T02:00:00Z',.9,.1)
        self.store.claim_voice('camera-02')
        previous=self.store.changes();self.assertEqual(previous['next_cursor'],3)
        shutil.copyfile(backup,self.path)
        self.store.checkin('p1','camera-02','C','2026-10-24T02:00:00Z',.9,.1)
        self.store.claim_voice('camera-02')
        current=self.store.changes()
        self.assertEqual(current['events'][-1]['record'],previous['events'][-1]['record'])
        self.assertNotEqual(current['events'][-1]['digest'],previous['events'][-1]['digest'])


if __name__ == '__main__':
    unittest.main()
