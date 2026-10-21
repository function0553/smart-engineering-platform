"""Read-only publication identity and download checks; no business actions or password changes."""
from pathlib import Path
from datetime import datetime
import hashlib,json,ssl,urllib.request
from portable_252 import ROOT
O=ROOT/'outputs/deploy-252-20261021-rc38';S=O/'release-source';release=json.loads((O/'release-receipt.json').read_text());base='https://211.139.12.141:21901';context=ssl.create_default_context(cafile=str(ROOT/'private/deploy252/ca.pem'));http=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=context));sha=lambda b:hashlib.sha256(b).hexdigest()
def get(path):
 with http.open(base+path,timeout=20) as r:assert r.status==200;return r.read()
p={'release':release['release'],'sourceFreezeSha256':release['sourceFreezeSha256'],'checkedAt':datetime.now().astimezone().isoformat(),'tlsCertificateAndHostnameVerified':True,'businessRecordsWritten':False,'passwordReset':False,'functionalWorkflowTestsRun':False,'assets':[]}
s=json.loads(get('/api/status'));assert s['version']=='0.6.0-rc.38' and s['database']=='ready';p['platformVersion']=s['version']
for f in sorted((S/'dist').rglob('*')):
 if f.is_file():
  n=f.relative_to(S/'dist').as_posix();path='/' if n=='index.html' else '/'+n;b=get(path);assert b==f.read_bytes(),n;p['assets'].append({'path':path,'sha256':sha(b),'bytes':len(b)})
p['updateChecks']=[]
for code in [37,38,39,40]:
 v=json.loads(get('/api/mobile/app-update?versionCode='+str(code)));assert v['versionCode']==40 and v['versionName']=='0.3.34' and v['available']==(code<40) and v['sha256']==release['android']['sha256'];p['updateChecks'].append({'installedVersionCode':code,'latestVersionCode':40,'available':v['available']})
b=get('/api/mobile/app-update/apk');assert sha(b)==release['android']['sha256'] and len(b)==release['android']['bytes'];(O/'android/public-0.3.34.apk').write_bytes(b);p['apkSha256']=sha(b);p['androidVersion']='0.3.34';p['androidVersionCode']=40;p['passwordFeatureFrozenSourceDeployed']=True;p['passed']=True
(O/'online-verification.json').write_text(json.dumps(p,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'passed':True,'backend':p['platformVersion'],'publicAndroid':p['androidVersion'],'assets':len(p['assets']),'apkSha256':p['apkSha256'],'businessWrites':False}))
