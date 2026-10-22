"""Persistent enrollment and daily attendance using the previous .65 face rule.

PPE tracks never enter this module. Only a fresh ArcFace match can create a
check-in. Names and their already-rendered PCMA are snapshotted atomically.
"""
import json
import math
import re
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from attendance_policy import AttendancePolicy

SHANGHAI = timezone(timedelta(hours=8))
ATTENDANCE_COLUMNS = ('attendance_id,person_id,name,business_date,occurred_at,camera_id,'
                      'observation_id,similarity,model_id,voice_pcma,voice_status,voice_detail,created_at')


class AttendanceResetBusy(RuntimeError):
    pass


def vector(values):
    values = [float(x) for x in values]
    if len(values) != 512 or not all(math.isfinite(x) for x in values):
        raise ValueError('invalid_embedding')
    norm = math.sqrt(sum(x * x for x in values))
    if norm < 1e-8:
        raise ValueError('zero_embedding')
    return [x / norm for x in values]


def voice_ready(status, session_id):
    return bool(
        status.get('sessionId') == session_id and session_id
        and all(status.get(k) is True for k in ('inviteReceived', 'ackReady', 'tcpConnected', 'wsBound', 'senderStarted'))
        and status.get('transport') == 'TCP'
        and not status.get('stopped') and not status.get('senderDone')
        and not status.get('failureReason')
    )


class Store:
    def __init__(self, path, model_id, policy=None):
        self.path, self.model_id = Path(path), model_id
        self.policy = AttendancePolicy(policy)
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS people (
                    person_id TEXT PRIMARY KEY, name TEXT NOT NULL, model_id TEXT NOT NULL,
                    embedding TEXT NOT NULL, voice_pcma BLOB NOT NULL,
                    photo_sha256 TEXT, enrolled_at TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE IF NOT EXISTS attendance (
                    attendance_id TEXT PRIMARY KEY, person_id TEXT NOT NULL,
                    name TEXT NOT NULL, business_date TEXT NOT NULL,
                    occurred_at TEXT NOT NULL, camera_id TEXT NOT NULL,
                    observation_id TEXT NOT NULL, similarity REAL NOT NULL,
                    model_id TEXT NOT NULL, voice_pcma BLOB NOT NULL,
                    voice_status TEXT NOT NULL DEFAULT 'pending', voice_detail TEXT,
                    created_at TEXT NOT NULL,
                    UNIQUE(person_id, business_date)
                );
                CREATE TABLE IF NOT EXISTS attendance_test_archive (
                    reset_id TEXT NOT NULL, cleared_at TEXT NOT NULL,
                    attendance_id TEXT NOT NULL, person_id TEXT NOT NULL,
                    name TEXT NOT NULL, business_date TEXT NOT NULL,
                    occurred_at TEXT NOT NULL, camera_id TEXT NOT NULL,
                    observation_id TEXT NOT NULL, similarity REAL NOT NULL,
                    model_id TEXT NOT NULL, voice_pcma BLOB NOT NULL,
                    voice_status TEXT NOT NULL, voice_detail TEXT, created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS attendance_test_archive_reset
                    ON attendance_test_archive(reset_id);
                CREATE TABLE IF NOT EXISTS attendance_liveness (
                    attendance_id TEXT PRIMARY KEY, proof_json TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS attendance_schedule (
                    attendance_id TEXT PRIMARY KEY, attendance_status TEXT NOT NULL,
                    late_seconds INTEGER NOT NULL, policy_json TEXT NOT NULL
                );
            ''')
            row = db.execute("SELECT value FROM metadata WHERE key='model_id'").fetchone()
            if row is not None and row[0] != model_id:
                raise ValueError('gallery_model_mismatch')
            db.execute("INSERT OR IGNORE INTO metadata VALUES('model_id',?)", (model_id,))
        self.path.chmod(0o600)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA busy_timeout=5000')
        try:
            with db:
                yield db
        finally:
            db.close()

    def enroll(self, person_id, name, embedding, model_id, voice_pcma, photo_sha256=None):
        if model_id != self.model_id:
            raise ValueError('embedding_model_mismatch')
        if not isinstance(person_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', person_id):
            raise ValueError('invalid_person_id')
        if not isinstance(name, str) or not name.strip() or not re.fullmatch(r'[\w\u3400-\u9fff·• .-]{1,40}', name):
            raise ValueError('invalid_name')
        name = name.strip()
        if not isinstance(voice_pcma, bytes) or not 2000 <= len(voice_pcma) <= 120000 or voice_pcma.startswith(b'RIFF'):
            raise ValueError('pcma8_voice_required')
        embedding = json.dumps(vector(embedding), separators=(',', ':'))
        now = datetime.now(timezone.utc).isoformat()
        with self.connect() as db:
            db.execute('''INSERT INTO people(person_id,name,model_id,embedding,voice_pcma,photo_sha256,enrolled_at)
                VALUES(?,?,?,?,?,?,?) ON CONFLICT(person_id) DO UPDATE SET
                name=excluded.name,model_id=excluded.model_id,embedding=excluded.embedding,
                voice_pcma=excluded.voice_pcma,photo_sha256=excluded.photo_sha256,
                enrolled_at=excluded.enrolled_at,active=1''',
                (person_id, name, model_id, embedding, voice_pcma, photo_sha256, now))
        return {'person_id': person_id, 'name': name, 'enrolled_at': now}

    def people(self):
        with self.connect() as db:
            return [dict(x) for x in db.execute('SELECT person_id,name,enrolled_at,active FROM people ORDER BY person_id')]

    def match(self, embedding, model_id, threshold=.65, margin=.08):
        if model_id != self.model_id:
            return None
        query = vector(embedding)
        with self.connect() as db:
            rows = db.execute('SELECT person_id,name,embedding FROM people WHERE active=1 AND model_id=?', (model_id,)).fetchall()
        scores = sorted(({'person_id': r['person_id'], 'name': r['name'],
                          'similarity': sum(a*b for a, b in zip(query, json.loads(r['embedding'])))} for r in rows),
                        key=lambda r: r['similarity'], reverse=True)
        if not scores or scores[0]['similarity'] < threshold:
            return None
        if len(scores) > 1 and scores[0]['similarity'] - scores[1]['similarity'] < margin:
            return None
        return scores[0]

    def checked_in_today(self, person_id, received_at):
        when = datetime.fromisoformat(received_at.replace('Z', '+00:00'))
        if when.tzinfo is None:
            raise ValueError('observation_provenance_required')
        day = when.astimezone(SHANGHAI).date().isoformat()
        with self.connect() as db:
            return db.execute('SELECT 1 FROM attendance WHERE person_id=? AND business_date=?',
                              (person_id, day)).fetchone() is not None

    def checkin(self, person_id, camera_id, observation_id, received_at, similarity, frame_age, liveness=None):
        if liveness is not None and not all(
                liveness.get(key, {}).get('state') == 'passed' and liveness.get(key, {}).get('model_id')
                for key in ('previous','current')):
            raise ValueError('liveness_not_confirmed')
        if not math.isfinite(similarity) or not .65 <= similarity <= 1.000001:
            raise ValueError('unconfirmed_face_match')
        if not math.isfinite(frame_age) or not 0 <= frame_age <= 3:
            raise ValueError('stale_face_observation')
        when = datetime.fromisoformat(received_at.replace('Z', '+00:00'))
        if when.tzinfo is None or not camera_id or not observation_id:
            raise ValueError('observation_provenance_required')
        schedule = self.policy.classify(when)
        day = schedule['business_date']
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            person = db.execute('SELECT * FROM people WHERE person_id=? AND active=1 AND model_id=?', (person_id, self.model_id)).fetchone()
            if person is None:
                raise ValueError('person_not_enrolled')
            if not schedule['allowed']:
                return {'attendance_id': None, 'created': False, 'reason': 'before_checkin_window',
                        'attendance_status': 'too_early'}
            old = db.execute('SELECT attendance_id FROM attendance WHERE person_id=? AND business_date=?', (person_id, day)).fetchone()
            if old:
                return {'attendance_id': old[0], 'created': False}
            attendance_id = uuid.uuid4().hex
            db.execute('''INSERT INTO attendance(attendance_id,person_id,name,business_date,occurred_at,
                camera_id,observation_id,similarity,model_id,voice_pcma,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)''',
                (attendance_id, person_id, person['name'], day, when.astimezone(timezone.utc).isoformat(),
                 camera_id, observation_id, similarity, self.model_id, person['voice_pcma'],
                 datetime.now(timezone.utc).isoformat()))
            if liveness is not None:
                db.execute('INSERT INTO attendance_liveness VALUES(?,?)',
                           (attendance_id, json.dumps(liveness, allow_nan=False)))
            db.execute('INSERT INTO attendance_schedule VALUES(?,?,?,?)',
                       (attendance_id, schedule['attendance_status'], schedule['late_seconds'],
                        json.dumps(self.policy.info(), ensure_ascii=False)))
        return {'attendance_id': attendance_id, 'created': True,
                'attendance_status': schedule['attendance_status'], 'late_seconds': schedule['late_seconds']}

    def records(self):
        with self.connect() as db:
            return [dict(r) for r in db.execute('''SELECT a.attendance_id,person_id,name,business_date,
                occurred_at,camera_id,similarity,voice_status,
                CASE WHEN l.attendance_id IS NULL THEN 'not_checked' ELSE 'passed' END AS liveness_status,
                COALESCE(s.attendance_status,'legacy_unclassified') AS attendance_status, s.late_seconds
                FROM attendance a LEFT JOIN attendance_liveness l ON l.attendance_id=a.attendance_id
                LEFT JOIN attendance_schedule s ON s.attendance_id=a.attendance_id
                ORDER BY occurred_at DESC LIMIT 200''')]

    def clear_today_test(self, camera_id, now=None):
        return self.clear_today_test_for_cameras([camera_id], now)

    def clear_today_test_for_cameras(self, camera_ids, now=None):
        now = now or datetime.now(timezone.utc)
        if (now.tzinfo is None or not isinstance(camera_ids, list) or not camera_ids
                or not all(isinstance(x, str) and x for x in camera_ids)):
            raise ValueError('reset_scope_required')
        camera_ids = list(dict.fromkeys(camera_ids))
        day = now.astimezone(SHANGHAI).date().isoformat()
        reset_id = uuid.uuid4().hex
        scope = (*camera_ids, day)
        where = 'camera_id IN (' + ','.join('?' for _ in camera_ids) + ') AND business_date=?'
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute("SELECT 1 FROM attendance WHERE " + where + " AND voice_status='sending'", scope).fetchone():
                raise AttendanceResetBusy('voice_in_progress')
            db.execute(f'''INSERT INTO attendance_test_archive(reset_id,cleared_at,{ATTENDANCE_COLUMNS})
                SELECT ?,?,{ATTENDANCE_COLUMNS} FROM attendance WHERE {where}''',
                       (reset_id, now.isoformat(), *scope))
            count = db.execute('DELETE FROM attendance WHERE ' + where, scope).rowcount
        return {'deleted': count, 'archived': count, 'reset_id': reset_id,
                'camera_id': camera_ids[0] if len(camera_ids) == 1 else None,
                'camera_ids': camera_ids, 'business_date': day}

    def recover_inflight(self):
        with self.connect() as db:
            db.execute("UPDATE attendance SET voice_status='delivery_unknown' WHERE voice_status='sending'")

    def claim_voice(self, camera_id=None):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute("UPDATE attendance SET voice_status='expired_not_sent' WHERE voice_status='pending' AND julianday('now')-julianday(created_at)>30.0/86400")
            query = "SELECT attendance_id,name,voice_pcma,camera_id FROM attendance WHERE voice_status='pending'"
            row = db.execute(query + (" AND camera_id=?" if camera_id is not None else "")
                             + " ORDER BY created_at LIMIT 1", (camera_id,) if camera_id is not None else ()).fetchone()
            if row is None:
                return None
            db.execute("UPDATE attendance SET voice_status='sending' WHERE attendance_id=? AND voice_status='pending'", (row['attendance_id'],))
            return dict(row)

    def finish_voice(self, attendance_id, status, detail):
        if status not in {'submitted_unverified', 'failed_not_sent', 'delivery_unknown'}:
            raise ValueError('invalid_voice_result')
        with self.connect() as db:
            db.execute("UPDATE attendance SET voice_status=?,voice_detail=? WHERE attendance_id=? AND voice_status='sending'",
                       (status, json.dumps(detail, ensure_ascii=False), attendance_id))

    def confirm_voice(self, attendance_id):
        with self.connect() as db:
            changed = db.execute("UPDATE attendance SET voice_status='playback_confirmed' WHERE attendance_id=? AND voice_status='submitted_unverified'", (attendance_id,)).rowcount
        return changed == 1
