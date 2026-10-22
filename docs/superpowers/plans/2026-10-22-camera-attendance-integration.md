# GPU Attendance and 252 Integration Implementation Plan

> For agentic workers: use superpowers:executing-plans; user explicitly requested starting implementation after spec review. Continue inline without stage check-ins.

Goal: Restore the original GPU face runtime, enable 252 enrollment and durable result synchronization, and keep all recognition and audio work on GPU.
Architecture: GPU SQLite change journal and HTTPS API; 252 independent SQLite mirror and cursor. GPU authoritative person identifiers do not require platform employee records.
Tech Stack: Python, SQLite, Node 24, Express, ONNX Runtime CUDA.
Spec: docs/superpowers/specs/2026-10-22-camera-attendance-integration-design.md

## Global constraints
- No new frontend; no production restart or real gallery writes.
- Preserve original modelId, model hashes, identity thresholds and audio delivery gates.
- GPU prepares/sends audio; 252 only relays enrollment and pulls results.
- Credentials, photos, vectors and private databases never enter Git.
- Existing Word/model assets missing from full-platform tests are recorded, not fabricated.

## Review focus
- Cursor persistence and stream mismatch across process restarts.
- Reset and voice updates racing a multi-page backfill.
- Enrollment upstream timeout leaves outcome unknown, never auto-retried.
- Malformed GPU pages must roll back atomically without skipped events.
- Source address credentials stay server side and bounded by time/size limits.

## Task 1: GPU durable change API
Files: attendance_store.py, attendance_service.py; new test_attendance_changes.py.
Interface: Store.changes(after=0, limit=200) -> stream_id, events, next_cursor, has_more.
- [ ] Write tests for 1000 rows, repeat pages, migration, reset, voice updates and bad cursors; observe failure.
- [ ] Add transactional change journal, legacy backfill and strict GET query parsing.
- [ ] Run new tests and original attendance tests; commit.

## Task 2: GPU voice and enrollment
Files: attendance_service.py, gb_voice.py; new voice_audio.py and prepare_name_voice.py; deployment tests/config.
Interface: configurable voice_base_url; voice_audio.prepare_voice(config,name), returning validated PCMA bytes.
- [ ] Test HTTPS-to-WSS, source wiring, GPU command timeout/output limits and legacy enrollment; observe failure.
- [ ] Add optional GPU local audio adapter and pass configured voice address into Speaker.
- [ ] Run targeted tests; commit.

## Task 3: 252 service
Files: server/camera4g-attendance.mjs, server/camera4g-attendance-store.mjs; app.mjs/index.mjs; tests/camera4g-attendance.test.mjs.
Interface: mountCameraAttendance(app,{store,auth},options) -> configured,start,close; /api/camera4g-attendance routes.
- [ ] Test independent people/records, 1000-event backfill, duplicate/restart/cursor/malformed page, auth and enrollment relay; observe failure.
- [ ] Add private HTTPS config, bounded client, mirror transactions, scheduler and routes; mount lifecycle.
- [ ] Run module tests, PPE regressions, type/build checks; commit.

## Task 4: Restore original runtime and deliver
Files: camera4g/attendance runtime recovery/verification scripts, original minimum vendor sources if redistribution permits, manifests; deploy configs; README/handoff.
- [ ] Read original source/model/license metadata from GPU; recover only explicit non-personal files into ignored staging.
- [ ] Test original asset verification before implementing recovery validator.
- [ ] Add reproducible dependency/model recovery and modelId compatibility checks; validate on permitted test fixtures.
- [ ] Update configs, startup commands, API docs, source hashes and local results.
- [ ] Run targeted suites and full suite summary; fresh reviewer for entire change; fix important findings.
- [ ] Commit, fast-forward main and push Gitee under existing authorization; verify remote SHA.
