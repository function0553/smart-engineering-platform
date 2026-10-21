"""Stage Linux dependencies, test in isolation, then back up and switch this app only."""
from pathlib import Path
from datetime import datetime
import hashlib,io,json,os,shutil,tarfile,time
from portable_252 import ROOT,connect,execute,python_on as remote_python
def python_on(c,source,root=False,timeout=180):
 c.get_transport().set_keepalive(10)
 return remote_python(c,source,root,timeout=timeout)
OUT=ROOT/'outputs/deploy-252-20261021-rc38';NODE='/opt/smart-engineering/runtime/node-v24.19.0-linux-x64/bin/node';BIN=str(Path(NODE).parent)
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
RUNTIME_TOPS=['server','shared','vision','dist','package.json','package-lock.json','THIRD_PARTY_NOTICES.txt']
RUNTIME_VERIFY_SOURCE='''import pathlib,json,hashlib,stat
root=pathlib.Path(DEST);assert root.is_dir() and not root.is_symlink(),'Release directory must not be a link'
manifest_path=root/'release-manifest.json';assert manifest_path.is_file() and not manifest_path.is_symlink(),'Manifest must be a regular file'
assert manifest_path.stat().st_nlink==1,'Manifest must not be a hard link'
raw=manifest_path.read_bytes();assert hashlib.sha256(raw).hexdigest()==MANIFEST_SHA,'Release manifest differs from frozen local archive'
def unique_manifest(pairs):
 result={}
 for name,digest in pairs:
  assert name not in result,('Duplicate manifest entry',name)
  result[name]=digest
 return result
manifest=json.loads(raw,object_pairs_hook=unique_manifest);assert isinstance(manifest,dict)
tops=RUNTIME_TOPS;names=[]
for name,digest in manifest.items():
 p=pathlib.PurePosixPath(name);assert name==p.as_posix() and not p.is_absolute() and '..' not in p.parts,('Invalid manifest path',name)
 assert not any(s in ['private','.data','.models'] for s in p.parts),name
 assert isinstance(digest,str) and len(digest)==64 and all(c in '0123456789abcdef' for c in digest),name
 if p.parts[0] in tops:names.append(name)
assert all(n in names for n in ['server/site-record-register.mjs','server/site-work-batches.mjs','server/site-record-policy.mjs','server/daily-report-submissions.mjs'])
actual=set()
for top in tops:
 base=root/top;assert base.exists() and not base.is_symlink(),('Missing or linked runtime path',top)
 entries=[base,*base.rglob('*')] if base.is_dir() else [base]
 for p in entries:
  assert not p.is_symlink(),('Linked runtime path',str(p.relative_to(root)))
  mode=p.stat().st_mode;assert stat.S_ISREG(mode) or stat.S_ISDIR(mode),('Unexpected runtime path type',str(p.relative_to(root)))
  if p.is_file():
   name=p.relative_to(root).as_posix();assert p.stat().st_nlink==1,('Hard-linked runtime file',name)
   actual.add(name)
assert actual==set(names),('Runtime inventory differs from frozen manifest',sorted(actual-set(names)),sorted(set(names)-actual))
for name in names:
 assert hashlib.sha256((root/name).read_bytes()).hexdigest()==manifest[name],('Runtime file differs from frozen manifest',name)
assert not (root/'tests').exists() and not (root/'src').exists() and not (root/'.data').exists()
print(json.dumps({'passed':True,'runtimeFilesVerified':len(names),'releaseManifestSha256':hashlib.sha256(raw).hexdigest(),'manifestBoundToFrozenLocalArchive':True,'runtimeLinksRejected':True,'privateOrDatabaseIncluded':False,'release':str(root),'newRegisterModuleVerified':True}))
'''

def archive_manifest(r):
 """Read the exact archived bytes, never regenerate the manifest during prepare/activate."""
 assert Path(r['archive']).name==r['archive'],'Archive must be a local release filename'
 archive=OUT/r['archive'];assert archive.is_file() and not archive.is_symlink()
 assert sha(archive)==r['sha256'] and archive.stat().st_size==r['bytes'],'Frozen release archive changed'
 with tarfile.open(archive) as tar:
  entries=tar.getmembers();names=[entry.name for entry in entries]
  assert len(names)==len(set(names)),'Duplicate archive member'
  member=tar.getmember('release-manifest.json');assert member.isfile()
  raw=tar.extractfile(member).read()
 assert hashlib.sha256(raw).hexdigest()==r['releaseManifestSha256'],'Frozen release manifest changed'
 return raw

def runtime_verification_source(dest,manifest_sha):
 assert len(manifest_sha)==64 and all(c in '0123456789abcdef' for c in manifest_sha),'Missing frozen manifest anchor'
 return RUNTIME_VERIFY_SOURCE.replace('DEST',repr(dest)).replace('MANIFEST_SHA',repr(manifest_sha)).replace('RUNTIME_TOPS',repr(RUNTIME_TOPS))
FACTS='''def facts(db,baseline=None):
 result={}
 names=[n for n, in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")]
 for name in names:
  cols=[r[1] for r in db.execute('PRAGMA table_info("'+name+'")')]
  if baseline and name in baseline:cols=baseline[name]['columns']
  quote=lambda s:'"'+s.replace('"','""')+'"'
  primary=sorted((r[5],r[1]) for r in db.execute('PRAGMA table_info('+quote(name)+')') if r[5])
  order=','.join(quote(n) for _,n in primary) if primary else 'rowid';h=hashlib.sha256();count=0
  for row in db.execute('SELECT '+','.join(quote(n) for n in cols)+' FROM '+quote(name)+' ORDER BY '+order):
   count+=1
   for v in row:
    b=v if isinstance(v,bytes) else json.dumps(v,ensure_ascii=False,separators=(',',':')).encode();h.update(len(b).to_bytes(8,'big'));h.update(b)
  result[name]={'columns':cols,'count':count,'sha256':h.hexdigest()}
 return result
'''
def verify_update_preflight(candidate,snapshot):
 proof=json.loads((candidate/'update-manifest-verification.json').read_text());assert proof['passed'] and proof['staticMetadataAndUnchangedHandler']
 assert proof['manifestSha256']==sha(snapshot/'server/mobile-updates/manifest.json') and proof['routeModuleSha256']==sha(snapshot/'server/app-update.mjs'),'Update route proof must bind exact frozen metadata and handler'
 assert json.loads((snapshot/'server/mobile-updates/manifest.json').read_text())['publishedAt'].endswith('Z')

def stage():
 candidate=ROOT/'outputs/site-library-release-20261021';freeze=json.loads((candidate/'source-freeze.json').read_text());snapshot=Path(freeze['sourceRoot']);assert snapshot.resolve().is_relative_to(candidate)
 for entry in freeze['files']:assert sha(snapshot/entry['path'])==entry['sha256'],('Frozen source changed',entry['path'])
 verify_update_preflight(candidate,snapshot)
 local=json.loads((candidate/'local-verification.json').read_text());assert local['passed'] and local['buildPassed'] and local['passwordMergePreservedStability'] and local['immediatePublicationAuthorized'] and local['sourceFreezeSha256']==sha(candidate/'source-freeze.json')
 assert 'disposition: candidate' in (candidate/'finish-review.md').read_text()
 apk=json.loads((candidate/'android/build-receipt.json').read_text());assert apk['version']=='0.3.34' and apk['versionCode']==40 and apk['samePublishedSigningIdentity']
 assert sha(snapshot/'server/mobile-updates/latest.apk')==apk['sha256']
 (OUT/'android').mkdir(exist_ok=True);shutil.copy2(candidate/'android/build-receipt.json',OUT/'android/build-receipt.json')
 pre=json.loads((OUT/'preflight.json').read_text());release=datetime.now().strftime('%Y%m%d-%H%M%S');source=OUT/'release-source';assert not source.exists();source.mkdir()
 for top in ['server','shared','vision','dist','src','android','tests']:
  shutil.copytree(snapshot/top,source/top,ignore=shutil.ignore_patterns('__pycache__','*.pyc','.DS_Store'))
 shutil.copytree(snapshot/'dist-mobile',source/'dist/mobile')
 for name in ['package.json','package-lock.json','THIRD_PARTY_NOTICES.txt']:shutil.copy2(snapshot/name,source/name)
 names=[]
 for top in ['server','shared','vision','dist','tests','src']:names.extend(p for p in (source/top).rglob('*') if p.is_file())
 names.extend(source/n for n in ['package.json','package-lock.json','THIRD_PARTY_NOTICES.txt'])
 manifest={p.relative_to(source).as_posix():sha(p) for p in names};archive=OUT/f'smart-engineering-{release}.tar.gz'
 with tarfile.open(archive,'w:gz') as tar:
  for p in names:
   name=p.relative_to(source).as_posix();assert not any(s in ['private','.data','.models'] for s in Path(name).parts)
   info=tar.gettarinfo(str(p),arcname=name);info.mode=0o644;info.uid=info.gid=0;info.uname=info.gname='root'
   with p.open('rb') as f:tar.addfile(info,f)
  raw=json.dumps(manifest).encode();info=tarfile.TarInfo('release-manifest.json');info.size=len(raw);info.mode=0o644;tar.addfile(info,io.BytesIO(raw))
 r={'release':release,'version':'0.6.0-rc.38','archive':archive.name,'sha256':sha(archive),'releaseManifestSha256':hashlib.sha256(raw).hexdigest(),'bytes':archive.stat().st_size,'files':len(manifest),'includesDatabase':False,'includesCredentials':False,'android':apk,'previous':pre['current'],'sourceFreezeSha256':sha(candidate/'source-freeze.json'),'activationRequiresImmediatePublicationAuthorization':True}
 (OUT/'release-receipt.json').write_text(json.dumps(r,ensure_ascii=False,indent=2));return r

def prepare_remote(c,r):
 archive_manifest(r)
 dest='/opt/smart-engineering/releases/'+r['release'];remote='/home/haha/smart-engineering-upgrade-'+r['release']+'.tar.gz'
 with c.open_sftp() as s:s.put(str(OUT/r['archive']),remote)
 result=python_on(c,"""import pathlib,hashlib,json,tarfile,os,pwd
archive=pathlib.Path(ARCHIVE);dest=pathlib.Path(DEST);assert not dest.exists();assert hashlib.sha256(archive.read_bytes()).hexdigest()==SHA
with tarfile.open(archive) as tar:
 entries=tar.getmembers();names=[m.name for m in entries];assert len(names)==len(set(names)),'Duplicate archive member'
 manifest_raw=tar.extractfile('release-manifest.json').read();assert hashlib.sha256(manifest_raw).hexdigest()==MANIFEST_ANCHOR,'Manifest differs from frozen local archive'
 manifest=json.loads(manifest_raw);assert set(names)==set(manifest)|{'release-manifest.json'}
 dest.mkdir();uid=pwd.getpwnam('haha').pw_uid;gid=pwd.getpwnam('haha').pw_gid
 for m in entries:
  p=pathlib.PurePosixPath(m.name);assert m.isfile() and not p.is_absolute() and '..' not in p.parts
  assert p.parts[0] in ['server','shared','vision','dist','src','tests','package.json','package-lock.json','THIRD_PARTY_NOTICES.txt','release-manifest.json']
  assert not any(x in ['private','.data','.models'] for x in p.parts)
  b=tar.extractfile(m).read();assert m.name=='release-manifest.json' or hashlib.sha256(b).hexdigest()==manifest[m.name]
  target=dest/m.name;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(b);os.chmod(target,0o644)
 for p in [dest,*dest.rglob('*')]:os.chown(p,uid,gid)
print(json.dumps({'verifiedFiles':len(manifest),'destination':str(dest)}))
""".replace('ARCHIVE',repr(remote)).replace('DEST',repr(dest)).replace('MANIFEST_ANCHOR',repr(r['releaseManifestSha256'])).replace('SHA',repr(r['sha256'])),True)
 # Dependencies are unchanged; reuse the already prepared, Linux-verified rc33 tree.
 prior=json.loads((ROOT/'outputs/deploy-252-20261021-rc33/release-receipt.json').read_text())
 priorDest='/opt/smart-engineering/releases/'+prior['release']
 result['dependencies']=python_on(c,"""import pathlib,json,shutil
old=pathlib.Path(PRIOR);new=pathlib.Path(DEST)
def normalized_lock(p):
 x=json.loads(p.read_text());x['version']='VERSION';x['packages']['']['version']='VERSION';return x
assert normalized_lock(old/'package-lock.json')==normalized_lock(new/'package-lock.json'),'Dependency lock changed'
a=json.loads((old/'package.json').read_text());b=json.loads((new/'package.json').read_text());a.pop('version');b.pop('version');assert a==b,'Package dependencies or scripts changed'
assert (old/'node_modules').is_dir() and not (new/'node_modules').exists()
shutil.copytree(old/'node_modules',new/'node_modules',symlinks=True)
print(json.dumps({'dependencyPrepared':True,'sameLockExceptReleaseVersion':True,'reusedVerifiedLinuxRelease':str(old)}))
""".replace('PRIOR',repr(priorDest)).replace('DEST',repr(dest)))
 runtime="import {createApp} from './server/app.mjs';import sharp from 'sharp';import {createRequire} from 'node:module';const r=createRequire(import.meta.url);if(typeof createApp!=='function')throw Error('App unavailable');console.log(JSON.stringify({express:r('express/package.json').version,sharp:sharp.versions.sharp,arch:process.arch,platform:process.platform,appModuleLoaded:true}));"
 result['runtime']=json.loads(execute(c,'cd '+dest+' && '+NODE+" --input-type=module - <<'JS'\n"+runtime+'\nJS',timeout=30))
 functional=execute(c,'cd '+dest+' && '+NODE+' --test tests/site-document-library.test.mjs tests/site-project-scope.test.mjs',timeout=180)
 assert '# fail 0' in functional and '# pass ' in functional,functional[-3000:]
 result['linuxFocusedTests']=functional[-5000:]
 result['release']=r['release'];result['archiveSha256']=r['sha256'];result['dependencyPrepared']=True;result['additionalFunctionalTestsRun']=True;result['serverChanges']='project-scope and site-library tested against disposable Linux fixtures'
 execute(c,'rm -rf '+dest+'/tests '+dest+'/src '+dest+'/.data '+dest+'/outputs',timeout=30)
 (OUT/'linux-candidate.json').write_text(json.dumps(result,ensure_ascii=False,indent=2));return result

def activate(c,r):
 archive_manifest(r)
 linux=json.loads((OUT/'linux-candidate.json').read_text());assert linux['release']==r['release'] and linux['archiveSha256']==r['sha256'] and linux['dependencyPrepared'] and linux['runtime']['appModuleLoaded']
 gate=json.loads((ROOT/'outputs/site-library-release-20261021/delivery-receipt.json').read_text());assert gate['passed'] and gate['releaseReady'] and gate['userRequestedImmediatePublication'] and gate['additionalPhysicalTestingStoppedByHuman'] and gate['passwordFeatureMerged'] and gate['sourcePreservationVerified'] and gate['apkSha256']==r['android']['sha256'] and gate['sourceFreezeSha256']==r['sourceFreezeSha256']
 candidate=ROOT/'outputs/site-library-release-20261021';freeze=json.loads((candidate/'source-freeze.json').read_text());assert sha(candidate/'source-freeze.json')==r['sourceFreezeSha256'];verify_update_preflight(candidate,Path(freeze['sourceRoot']))
 previous=execute(c,'readlink /opt/smart-engineering/current').strip();assert previous==r['previous'];stopped=False;activated=False;recoveryConnection=None
 runtime=python_on(c,runtime_verification_source('/opt/smart-engineering/releases/'+r['release'],r['releaseManifestSha256']))
 assert runtime['passed'] and runtime['releaseManifestSha256']==r['releaseManifestSha256']
 receipt={'release':r['release'],'previous':previous,'version':r['version'],'servicesChanged':['smart-engineering.service','smart-engineering-web.service'],'otherServicesChanged':False,'databaseReplaced':False,'preActivationRuntime':runtime,'passed':False}
 try:
  execute(c,'sudo -n systemctl stop smart-engineering.service');stopped=True
  before=python_on(c,"""import pathlib,sqlite3,json,hashlib,tarfile,os,shlex,subprocess
ROOT=pathlib.Path('/opt/smart-engineering');release=RELEASE;backupTag=BACKUP_TAG
FACTS
env=subprocess.check_output(['systemctl','show','smart-engineering.service','--property=Environment','--value'],text=True);runtime={k:v for item in shlex.split(env) for k,sep,v in [item.partition('=')] if k in ['DATABASE_PATH']};assert pathlib.Path(runtime['DATABASE_PATH']).resolve()==(ROOT/'shared/workspace.sqlite').resolve()
source=sqlite3.connect('file:'+str(ROOT/'shared/workspace.sqlite')+'?mode=ro',uri=True);backup=ROOT/'shared/backups'/('before-upgrade-'+backupTag+'.sqlite');assert not backup.exists();fd=os.open(backup,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd);target=sqlite3.connect(backup);source.backup(target);target.close();os.chmod(backup,0o600)
assert source.execute('PRAGMA integrity_check').fetchone()[0]=='ok';assert not source.execute('PRAGMA foreign_key_check').fetchall();before=facts(source);source.close()
env=subprocess.check_output(['systemctl','show','smart-engineering.service','--property=Environment','--value'],text=True);selected={k:v for item in shlex.split(env) for k,sep,v in [item.partition('=')] if k in ['MODELS_PATH','DATABASE_PATH']};media=pathlib.Path(selected['MODELS_PATH']);assert media.resolve().is_relative_to(ROOT/'shared')
assert not any(p.is_symlink() for p in media.rglob('*'));files=sorted(p for p in media.rglob('*') if p.is_file());inventory={p.relative_to(media).as_posix():{'size':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in files}
mediaBackup=ROOT/'shared/backups'/('before-upgrade-'+backupTag+'-media.tar.gz');assert not mediaBackup.exists();fd=os.open(mediaBackup,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);os.close(fd)
with tarfile.open(mediaBackup,'w:gz') as tar:
 for p in files:tar.add(p,arcname=p.relative_to(media).as_posix(),recursive=False)
os.chmod(mediaBackup,0o600)
print(json.dumps({'tables':before,'backup':str(backup),'backupSha256':hashlib.sha256(backup.read_bytes()).hexdigest(),'mediaBackup':str(mediaBackup),'mediaBackupSha256':hashlib.sha256(mediaBackup.read_bytes()).hexdigest(),'media':inventory,'filesDir':str(media),'configHashes':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [pathlib.Path('/etc/systemd/system')/name for name in ['smart-engineering.service','smart-engineering-web.service']]+[p for name in ['smart-engineering.service.d','smart-engineering-web.service.d'] for p in (pathlib.Path('/etc/systemd/system')/name).glob('*.conf')] if p.is_file()}}))
""".replace('FACTS',FACTS).replace('RELEASE',repr(r['release'])).replace('BACKUP_TAG',repr(r['release']+'-retry-'+datetime.now().strftime('%H%M%S'))),True)
  receipt['before']=before;(OUT/'before-upgrade.json').write_text(json.dumps(before,ensure_ascii=False,indent=2))
  python_on(c,"""import os,pathlib,json
root=pathlib.Path('/opt/smart-engineering');assert os.readlink(root/'current')==OLD
pending=root/('current-'+RELEASE);assert not pending.exists();pending.symlink_to('releases/'+RELEASE);os.replace(pending,root/'current');print(json.dumps({'activated':True}))
""".replace('OLD',repr(previous)).replace('RELEASE',repr(r['release'])),True);activated=True
  execute(c,'sudo -n systemctl start smart-engineering.service');stopped=False
  for _ in range(15):
   try:
    status=json.loads(execute(c,"curl --fail --silent --max-time 3 -H 'Host: 211.139.12.141:21901' http://127.0.0.1:15186/api/status"));
    if status['version']==r['version'] and status['database']=='ready':break
   except RuntimeError:pass
   time.sleep(1)
  else:raise RuntimeError('New service did not become ready')
  execute(c,'sudo -n systemctl start smart-engineering-web.service')
  after=python_on(c,"""import sqlite3,json,pathlib,hashlib
FACTS
baseline=BASELINE;db=sqlite3.connect('file:/opt/smart-engineering/shared/workspace.sqlite?mode=ro',uri=True);values=facts(db,baseline)
media=pathlib.Path(MEDIA);inventory={p.relative_to(media).as_posix():{'size':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in media.rglob('*') if p.is_file()}
print(json.dumps({'tables':values,'integrity':db.execute('PRAGMA integrity_check').fetchone()[0],'foreignKeys':len(db.execute('PRAGMA foreign_key_check').fetchall()),'uploadColumns':[x[1] for x in db.execute('PRAGMA table_info(engineering_site_uploads)')],'media':inventory,'configHashes':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [pathlib.Path('/etc/systemd/system')/name for name in ['smart-engineering.service','smart-engineering-web.service']]+[p for name in ['smart-engineering.service.d','smart-engineering-web.service.d'] for p in (pathlib.Path('/etc/systemd/system')/name).glob('*.conf')] if p.is_file()}}))
""".replace('FACTS',FACTS).replace('BASELINE',repr(before['tables'])).replace('MEDIA',repr(before['filesDir'])))
  assert after['integrity']=='ok' and after['foreignKeys']==0
  assert all(after['tables'].get(name)==value for name,value in before['tables'].items()),'Original table content changed'
  added=set(after['tables'])-set(before['tables']);assert added==set(),'V2.1 must not add tables';receipt['addedTables']=[];receipt['legacyWorkflowPreserved']=True
  assert 'step_id' in after['uploadColumns'];assert before['media']==after['media'] and before['configHashes']==after['configHashes']
  receipt['after']=after;receipt['status']=status;receipt['services']=execute(c,'systemctl is-active smart-engineering.service smart-engineering-web.service').splitlines();assert receipt['services']==['active','active'];receipt['passed']=True
 except Exception:
  # Reconnect before recovery: the original failure may be a broken SSH channel.
  recoveryConnection=connect();c=recoveryConnection
  observed=execute(c,'readlink /opt/smart-engineering/current').strip()
  assert observed in [previous,'releases/'+r['release']],'Another publisher changed current; recovery will not override it'
  activated=observed=='releases/'+r['release']
  # No database restoration. Roll back source only when business data still matches the stopped-service backup.
  if activated:
   execute(c,'sudo -n systemctl stop smart-engineering.service');stopped=True
   try:
    guard=python_on(c,"""import sqlite3,json
FACTS
db=sqlite3.connect('file:/opt/smart-engineering/shared/workspace.sqlite?mode=ro',uri=True);baseline=BASELINE;current=facts(db,baseline)
ignored={'sessions','audit_logs','audit_log','audit'}
safe=all(current.get(n)==v for n,v in baseline.items() if n not in ignored) and set(current)==set(baseline) and db.execute('PRAGMA integrity_check').fetchone()[0]=='ok' and not db.execute('PRAGMA foreign_key_check').fetchall()
print(json.dumps({'safe':safe}))""".replace('FACTS',FACTS).replace('BASELINE',repr(before['tables'])))
   except Exception as guardError:
    guard={'safe':False};receipt['rollbackGuardFailed']=type(guardError).__name__
   if guard['safe']:
    execute(c,'sudo -n systemctl stop smart-engineering.service');python_on(c,"import pathlib,os,json\nr=pathlib.Path('/opt/smart-engineering');p=r/'current-rollback-rc34';p.symlink_to(OLD);os.replace(p,r/'current');print(json.dumps({'rolledBack':True}))".replace('OLD',repr(previous)),True);execute(c,'sudo -n systemctl start smart-engineering.service');receipt['rolledBack']=True
   else:
    receipt['rollbackBlocked']='Business data or migrated permission configuration changed; current release retained without database restore';execute(c,'sudo -n systemctl start smart-engineering.service');stopped=False
  else:
   # A stop command may have completed before its SSH receipt was lost.
   recovery=connect()
   try:execute(recovery,'sudo -n systemctl start smart-engineering.service');execute(recovery,'sudo -n systemctl start smart-engineering-web.service')
   finally:recovery.close()
  execute(c,'sudo -n systemctl start smart-engineering-web.service')
  raise
 finally:
  (OUT/'deployment-receipt.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2))
  if recoveryConnection:recoveryConnection.close()
 return receipt

if __name__=='__main__':
 import sys
 phase=sys.argv[1]
 if phase=='package':print(json.dumps(stage(),ensure_ascii=False))
 else:
  r=json.loads((OUT/'release-receipt.json').read_text());c=connect()
  try:
   if phase=='prepare':result=prepare_remote(c,r);print(json.dumps(result,ensure_ascii=False))
   elif phase=='activate':result=activate(c,r);print(json.dumps({'passed':result['passed'],'version':result['status']['version'],'backup':result['before']['backup'],'tables':len(result['after']['tables']),'services':result['services']},ensure_ascii=False))
   else:raise ValueError('Unknown phase')
  finally:c.close()
