from pathlib import Path
from datetime import datetime
import json
from portable_252 import connect,execute,python_on,ROOT
OUT=ROOT/'outputs/deploy-252-20261021-rc38';OUT.mkdir(exist_ok=True)
c=connect()
try:
 state={'checkedAt':datetime.now().astimezone().isoformat(),'current':execute(c,'readlink /opt/smart-engineering/current').strip(),'services':execute(c,'systemctl is-active smart-engineering.service smart-engineering-web.service').splitlines(),'status':json.loads(execute(c,"curl --fail --silent --max-time 8 -H 'Host: 211.139.12.141:21901' http://127.0.0.1:15186/api/status"))}
 state['storage']=python_on(c,"""import sqlite3,pathlib,json,hashlib,subprocess,shlex,shutil
root=pathlib.Path('/opt/smart-engineering');db=sqlite3.connect('file:'+str(root/'shared/workspace.sqlite')+'?mode=ro',uri=True)
env=subprocess.check_output(['systemctl','show','smart-engineering.service','--property=Environment','--value'],text=True)
selected={k:v for item in shlex.split(env) for k,sep,v in [item.partition('=')] if k in ['MODELS_PATH','DATABASE_PATH','VISION_PYTHON_PATH','AI_MODELS_PATH']}
media=pathlib.Path(selected.get('MODELS_PATH',str(root/'shared/models')));assert media.resolve().is_relative_to(root/'shared')
print(json.dumps({'tables':{n:db.execute('SELECT COUNT(*) FROM "'+n+'"').fetchone()[0] for n, in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")},'integrity':db.execute('PRAGMA integrity_check').fetchone()[0],'foreignKeys':len(db.execute('PRAGMA foreign_key_check').fetchall()),'filesDir':str(media),'mediaFiles':sum(1 for p in media.rglob('*') if p.is_file()),'mediaBytes':sum(p.stat().st_size for p in media.rglob('*') if p.is_file()),'freeDiskBytes':shutil.disk_usage(root).free,'runtime':selected,'configHashes':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [pathlib.Path('/etc/systemd/system')/name for name in ['smart-engineering.service','smart-engineering-web.service']]+[p for name in ['smart-engineering.service.d','smart-engineering-web.service.d'] for p in (pathlib.Path('/etc/systemd/system')/name).glob('*.conf')] if p.is_file()}}))
""")
 assert state['status']['version'] in ['0.6.0-rc.37','0.6.0-rc.38'] and state['status']['database']=='ready'
 assert state['services']==['active','active'] and state['storage']['integrity']=='ok' and state['storage']['foreignKeys']==0
 (OUT/'preflight.json').write_text(json.dumps(state,ensure_ascii=False,indent=2));print(json.dumps({'version':state['status']['version'],'services':state['services'],'projects':state['storage']['tables']['engineering_projects'],'tables':len(state['storage']['tables']),'mediaFiles':state['storage']['mediaFiles'],'freeDiskGiB':round(state['storage']['freeDiskBytes']/2**30,1)}))
finally:c.close()
