"""Read-only new-route verification against the actual production schema and ACL."""
from pathlib import Path
import json,ssl,urllib.request,http.cookiejar,urllib.error
from portable_252 import ROOT
O=ROOT/'outputs/deploy-252-20261021-rc39';v=json.loads((ROOT/'private/tested-ui-252-20261021.credentials.json').read_text());url=v['baseUrl'];assert url=='https://211.139.12.141:21901';ctx=ssl.create_default_context(cafile=str(ROOT/'private/deploy252/ca.pem'));jar=http.cookiejar.CookieJar();http=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPSHandler(context=ctx),urllib.request.HTTPCookieProcessor(jar));logged=False

def api(path,body=None):
 req=urllib.request.Request(url+'/api'+path,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json','X-Workspace-Request':'1'})
 with http.open(req,timeout=20) as r:return json.loads(r.read())
try:
 a=v['accounts']['admin'];api('/login',{'username':a['username'],'password':a['password']});logged=True;me=api('/me');assert me['role']=='admin';listing=api('/engineering/site-library');assert isinstance(listing['groups'],list);projects=api('/engineering')['projects'];checks=[]
 for p in projects:
  detail=api('/engineering/projects/'+p['id']);groups=api('/engineering/projects/'+p['id']+'/site-library');checks.append({'projectId':p['id'],'readable':True,'groups':groups['total'],'wbs':len(detail['wbs']['nodes'])})
 receipt={'passed':True,'version':api('/status')['version'],'adminGlobalLibraryReadable':True,'globalGroups':listing['total'],'projects':checks,'businessWrites':False,'projectScopeCreatedAutomatically':False,'usesPinnedTls':True};assert receipt['version']=='0.6.0-rc.39';(O/'site-library-live-readonly.json').write_text(json.dumps(receipt,indent=2));print(json.dumps({'passed':True,'globalGroups':listing['total'],'projectsReadable':len(checks),'businessWrites':False}))
finally:
 if logged:api('/logout',{})
