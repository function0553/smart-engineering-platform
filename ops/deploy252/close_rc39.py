"""Verify preserved production data after login/logout checks, then write delivery evidence."""
from datetime import datetime
import json,hashlib
from pathlib import Path
from portable_252 import ROOT,connect,execute,python_on
from release_rc39 import FACTS
OUT=ROOT/'outputs/deploy-252-20261021-rc39';before=json.loads((OUT/'before-upgrade.json').read_text());release=json.loads((OUT/'release-receipt.json').read_text());deployment=json.loads((OUT/'deployment-receipt.json').read_text());online=json.loads((OUT/'online-verification.json').read_text());runtime=json.loads((OUT/'runtime-verification.json').read_text())
assert deployment['passed'] and deployment['release']==release['release']
assert online['passed'] and online['release']==release['release'] and online['platformVersion']==release['version'] and online['apkSha256']==release['android']['sha256'] and online['sourceFreezeSha256']==release['sourceFreezeSha256']
assert runtime['passed'] and runtime['release']=='/opt/smart-engineering/releases/'+release['release']
c=connect()
try:
 assert execute(c,'readlink /opt/smart-engineering/current').strip()=='releases/'+release['release']
 assert execute(c,'systemctl is-active smart-engineering.service smart-engineering-web.service').splitlines()==['active','active']
 after=python_on(c,"""import sqlite3,json,pathlib,hashlib
FACTS
base=BASE;db=sqlite3.connect('file:/opt/smart-engineering/shared/workspace.sqlite?mode=ro',uri=True)
root=pathlib.Path(MEDIA)
print(json.dumps({'tables':facts(db,base),'foreignKeys':len(db.execute('PRAGMA foreign_key_check').fetchall()),'integrity':db.execute('PRAGMA integrity_check').fetchone()[0],'media':{p.relative_to(root).as_posix():{'size':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in root.rglob('*') if p.is_file()},'configHashes':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [pathlib.Path('/etc/systemd/system')/name for name in ['smart-engineering.service','smart-engineering-web.service']]+[p for name in ['smart-engineering.service.d','smart-engineering-web.service.d'] for p in (pathlib.Path('/etc/systemd/system')/name).glob('*.conf')] if p.is_file()}}))
""".replace('FACTS',FACTS).replace('BASE',repr(before['tables'])).replace('MEDIA',repr(before['filesDir'])))
 changed=[n for n,v in before['tables'].items() if after['tables'].get(n)!=v]
 assert set(changed).issubset({'sessions','audit_logs','audit_log','audit','engineering_site_media_grants'}),changed
 added=set(after['tables'])-set(before['tables']);assert added==set(deployment['addedTables']);assert all(after['tables'][n]==deployment['after']['tables'][n] for n in added), 'Migrated workflow state changed during read-only verification'
 assert after['integrity']=='ok' and after['foreignKeys']==0 and after['media']==before['media'] and after['configHashes']==before['configHashes']
 result={'checkedAt':datetime.now().astimezone().isoformat(),'passed':True,'businessDataPreserved':True,'ephemeralOnlyChangedTables':changed,'mediaPreserved':True,'configPreserved':True,'projectCount':after['tables']['engineering_projects']['count'],'foreignKeys':after['foreignKeys'],'integrity':after['integrity'],'currentRelease':execute(c,'readlink /opt/smart-engineering/current').strip(),'services':execute(c,'systemctl is-active smart-engineering.service smart-engineering-web.service').splitlines()}
 assert result['currentRelease']=='releases/'+release['release'] and result['services']==['active','active']
 result['schemaPreserved']=True;result['release']=release['release'];result['verifiedOnlineAndRuntime']=True
 (OUT/'post-verification-preservation.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
 print(json.dumps(result,ensure_ascii=False))
finally:c.close()
