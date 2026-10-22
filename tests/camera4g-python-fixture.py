"""Synthetic Python GPU API fixture for Node integration tests; no models/cameras."""
import json
from http.server import ThreadingHTTPServer
from pathlib import Path
import signal
import sys
import threading
import types

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'camera4g/attendance'))
from attendance_service import Handler
from attendance_store import Store

database=Path(sys.argv[1])/'synthetic.sqlite'
store=Store(database,'synthetic-model')
with store.connect() as db:
    for i in range(201):
        db.execute('''INSERT INTO attendance(attendance_id,person_id,name,business_date,occurred_at,
            camera_id,observation_id,similarity,model_id,voice_pcma,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)''',
            (f'fixture-{i:04d}',f'person-{i:04d}','合成人员','2026-10-22','2026-10-22T02:00:00+00:00',
             'camera-02',f'obs-{i}',.9,'synthetic-model',b'\xd5'*2000,'2026-10-22T02:00:00+00:00'))
store=Store(database,'synthetic-model')
server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
server.app=types.SimpleNamespace(token='synthetic-integration-token-'*3,store=store)
signal.signal(signal.SIGTERM,lambda *_:threading.Thread(target=server.shutdown,daemon=True).start())
print(json.dumps({'port':server.server_address[1]}),flush=True)
try:server.serve_forever(poll_interval=.1)
finally:server.server_close()
