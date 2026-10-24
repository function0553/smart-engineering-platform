import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export function openStore(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename, { timeout: 5000 });
  // Routes prepare the same SQL for every row and request; reuse compiled statements (bounded LRU).
  // SQLite transparently re-prepares a cached statement after schema changes, so results are unchanged.
  const compile = db.prepare.bind(db), statements = new Map();
  db.prepare = sql => {
    let statement = statements.get(sql);
    if (statement) { statements.delete(sql); statements.set(sql, statement); return statement; }
    statement = compile(sql); statements.set(sql, statement);
    if (statements.size > 2000) statements.delete(statements.keys().next().value);
    return statement;
  };
  db.exec(`
    PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','operator','viewer')), hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, type TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS record_type ON records(type,created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS record_code ON records(type,lower(json_extract(data,'$.code'))) WHERE type IN ('spaces','employees','devices');
    CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, target_id TEXT NOT NULL, summary TEXT NOT NULL, at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS audit_time ON audit(at);
    CREATE TABLE IF NOT EXISTS integrations (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, device_ids TEXT NOT NULL CHECK(json_valid(device_ids)), revoked INTEGER NOT NULL DEFAULT 0, last_seen TEXT, received INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS event_keys (integration_id TEXT NOT NULL REFERENCES integrations(id), event_key TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(integration_id,event_key));
    CREATE TABLE IF NOT EXISTS models (id TEXT PRIMARY KEY, name TEXT NOT NULL, file_key TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS anchors (id TEXT PRIMARY KEY, model_id TEXT NOT NULL REFERENCES models(id), target_id TEXT NOT NULL REFERENCES records(id), position TEXT NOT NULL CHECK(json_valid(position)), version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, UNIQUE(model_id,target_id));
    CREATE UNIQUE INDEX IF NOT EXISTS portrait_code ON records(lower(json_extract(data,'$.code'))) WHERE type='portraits';
    CREATE TABLE IF NOT EXISTS security_images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, bytes BLOB NOT NULL, purpose TEXT NOT NULL, device_id TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS security_tracks (rule_id TEXT NOT NULL, rule_version INTEGER NOT NULL, integration_id TEXT NOT NULL, object_id TEXT NOT NULL, at TEXT NOT NULL, point TEXT NOT NULL, PRIMARY KEY(rule_id,integration_id,object_id));
    CREATE TABLE IF NOT EXISTS alarm_notifications (seq INTEGER PRIMARY KEY AUTOINCREMENT, alert_id TEXT NOT NULL REFERENCES records(id), created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS alarm_notifications_alert ON alarm_notifications(alert_id);
    CREATE TABLE IF NOT EXISTS photo_archives (
      id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES users(id), author_name TEXT NOT NULL,
      title TEXT NOT NULL, project_name TEXT NOT NULL, road_name TEXT NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)), version INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS photo_archives_author ON photo_archives(author_id,updated_at DESC);
    CREATE TABLE IF NOT EXISTS photo_archive_images (
      id TEXT PRIMARY KEY, archive_id TEXT NOT NULL REFERENCES photo_archives(id), segment_id TEXT NOT NULL, stage_id TEXT NOT NULL,
      name TEXT NOT NULL, caption TEXT NOT NULL, mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
      bytes BLOB NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL, uploader_id TEXT NOT NULL REFERENCES users(id),
      UNIQUE(archive_id,segment_id,stage_id,sha256)
    );
    CREATE TABLE IF NOT EXISTS photo_archive_exports (
      id TEXT PRIMARY KEY, archive_id TEXT NOT NULL REFERENCES photo_archives(id), archive_version INTEGER NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)), document BLOB NOT NULL, document_sha256 TEXT NOT NULL,
      photo_count INTEGER NOT NULL, created_at TEXT NOT NULL, author_id TEXT NOT NULL REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS photo_archive_export_images (
      export_id TEXT NOT NULL REFERENCES photo_archive_exports(id), photo_id TEXT NOT NULL, segment_id TEXT NOT NULL, stage_id TEXT NOT NULL,
      name TEXT NOT NULL, caption TEXT NOT NULL, mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
      bytes BLOB NOT NULL, PRIMARY KEY(export_id,photo_id)
    );
    CREATE TABLE IF NOT EXISTS daily_reports (
      id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES users(id), author_name TEXT NOT NULL,
      submission_key TEXT NOT NULL, request_hash TEXT NOT NULL,
      project_name TEXT NOT NULL, region TEXT NOT NULL, report_date TEXT NOT NULL, number TEXT NOT NULL,
      data TEXT NOT NULL CHECK(json_valid(data)), document BLOB NOT NULL, document_sha256 TEXT NOT NULL,
      photo_count INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(author_id,submission_key)
    );
    CREATE INDEX IF NOT EXISTS daily_reports_author ON daily_reports(author_id,created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS daily_reports_date ON daily_reports(report_date,created_at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS daily_report_photos (
      report_id TEXT NOT NULL REFERENCES daily_reports(id) ON DELETE CASCADE, photo_index INTEGER NOT NULL,
      name TEXT NOT NULL, caption TEXT NOT NULL, mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
      bytes BLOB NOT NULL, sha256 TEXT NOT NULL, PRIMARY KEY(report_id,photo_index)
    );
  `);
  const parse = row => row ? { ...row, data: JSON.parse(row.data) } : null;
  return {
    db,
    transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; } },
    list(type) { return db.prepare('SELECT * FROM records WHERE type=? ORDER BY created_at DESC,id DESC').all(type).map(parse); },
    get(id) { return parse(db.prepare('SELECT * FROM records WHERE id=?').get(id)); },
    insert(type, state, data) { const id = randomUUID(); const at = new Date().toISOString(); db.prepare('INSERT INTO records(id,type,state,data,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id, type, state, JSON.stringify(data), at, at); return this.get(id); },
    save(record) { db.prepare('UPDATE records SET state=?,data=?,version=version+1,updated_at=? WHERE id=?').run(record.state, JSON.stringify(record.data), new Date().toISOString(), record.id); return this.get(record.id); },
    audit(actor, action, entity, targetId, summary) { db.prepare('INSERT INTO audit VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), actor.id, actor.name, action, entity, targetId, summary.slice(0, 300), new Date().toISOString()); },
    setting(key, value) { if (value !== undefined) db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key); return row ? JSON.parse(row.value) : null; },
    close() { db.close(); },
  };
}
