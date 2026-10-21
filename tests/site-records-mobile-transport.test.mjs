import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {randomUUID} from 'node:crypto';
const source=stripTypeScriptTypes(readFileSync(new URL('../src/mobile-transport.ts',import.meta.url),'utf8'),{mode:'strip'});
async function fixture(t,bridge,{origin='https://example.test',fetch=async()=>new Response('{}')}={}){
 const oldWindow=globalThis.window,oldStorage=globalThis.localStorage,calls=[],values=new Map([['daily:backend','https://example.test'],['daily:session',JSON.stringify({baseUrl:'https://example.test',token:'a'.repeat(43),expiresAt:Date.now()+60000})]]);
 const w={fetch,location:{origin},dispatchEvent(){},AndroidDailyReport:bridge?{saveFile(){throw Error('Large original must not use base64 saveFile');},...bridge}:undefined};
 globalThis.window=w;globalThis.localStorage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 t.after(()=>{globalThis.window=oldWindow;globalThis.localStorage=oldStorage;});
 const module=await import('data:text/javascript;base64,'+Buffer.from(source+'\n//'+randomUUID()).toString('base64'));
 return {module,w,values,calls};
}
const grant='https://canonical.test/api/engineering-site-media/'+'b'.repeat(43),sha='c'.repeat(64);
test('native site-original download forwards a bounded grant path and metadata without loading video into base64',async t=>{
 let config;const f=await fixture(t,{downloadSiteFile(id,text){config=JSON.parse(text);queueMicrotask(()=>window.__dailyResult(id,JSON.stringify({saved:true,bytes:200000000,sha256:sha})));}});
 const result=await f.module.saveMobileSiteFile(grant,'步骤.webm','video/webm',200000000,sha);
 assert.equal(result.saved,true);assert.equal(config.baseUrl,'https://example.test');assert.equal(config.path,'/api/engineering-site-media/'+'b'.repeat(43));assert.equal(config.token,'a'.repeat(43));assert.ok(!('base64'in config));assert.equal(config.bytes,200000000);
});
test('malformed original identity or excessive declared size never reaches the native bridge',async t=>{
 let called=0;const f=await fixture(t,{downloadSiteFile(){called++;}});
 for(const args of [[grant+'?external=1','a.webm',1,sha],[grant,'../a.webm',1,sha],[grant,'a.webm',268435457,sha],[grant,'a.webm',1,'bad'],['https://elsewhere.test/private/a','a.webm',1,sha]])await assert.rejects(f.module.saveMobileSiteFile(args[0],args[1],'video/webm',args[2],args[3]));
 assert.equal(called,0);
});
test('cancel signals cancel only the pending original download and ignore a late completion',async t=>{
 let operation,cancelled;const f=await fixture(t,{downloadSiteFile(id){operation=id;},cancelSiteFile(id){cancelled=id;}}),controller=new AbortController();
 const pending=f.module.saveMobileSiteFile(grant,'原件.pdf','application/pdf',100,sha,controller.signal);controller.abort();await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(cancelled,operation);f.w.__dailyResult(operation,JSON.stringify({saved:true,bytes:100,sha256:sha}));
});
test('old native clients and expired sessions report the required recovery without starting a download',async t=>{
 const f=await fixture(t,{});await assert.rejects(f.module.saveMobileSiteFile(grant,'原件.pdf','application/pdf',100,sha),/更新APP/);
 f.w.AndroidDailyReport.downloadSiteFile=()=>{throw Error('No session must not start');};f.values.delete('daily:session');await assert.rejects(f.module.saveMobileSiteFile(grant,'原件.pdf','application/pdf',100,sha),/重新登录/);
});
test('native preview stays on the registered appassets grant path and old clients must update',async t=>{
 const f=await fixture(t,{downloadSiteFile(){}});
 assert.equal(f.module.siteMediaPreviewUrl(grant),'https://appassets.androidplatform.net/api/engineering-site-media/'+'b'.repeat(43));
 for(const invalid of [grant+'?x=1',grant+'#x','https://foreign.test/other'])assert.throws(()=>f.module.siteMediaPreviewUrl(invalid),/依据无效/);
 delete f.w.AndroidDailyReport.downloadSiteFile;assert.throws(()=>f.module.siteMediaPreviewUrl(grant),/更新APP/);
 delete f.w.AndroidDailyReport;assert.equal(f.module.siteMediaPreviewUrl(grant),grant);
});
const packageGrant='https://canonical.test/api/engineering-site-packages/'+'d'.repeat(43);
test('site-library ZIP uses only the registered streaming bridge through the configured backend up to 1GiB',async t=>{
 let config;const f=await fixture(t,{downloadSiteFile(id,text){config=JSON.parse(text);queueMicrotask(()=>window.__dailyResult(id,JSON.stringify({saved:true,bytes:1073741824,sha256:sha})));}});
 const result=await f.module.saveMobileSiteFile(packageGrant,'项目资料.zip','application/zip',1073741824,sha);
 assert.equal(result.saved,true);assert.equal(config.baseUrl,'https://example.test');assert.equal(config.path,'/api/engineering-site-packages/'+'d'.repeat(43));assert.equal(config.bytes,1073741824);assert.equal(config.mime,'application/zip');assert.equal(config.token,'a'.repeat(43));assert.ok(!('base64'in config));
 assert.throws(()=>f.module.siteMediaPreviewUrl(packageGrant),/依据无效/);
});
test('ZIP path MIME size and canonical identities are paired without expanding original limits',async t=>{
 let called=0;const f=await fixture(t,{downloadSiteFile(){called++;}});
 for(const [url,name,mime,bytes] of [
  [packageGrant,'资料.zip','application/zip',1073741825],[packageGrant,'资料.zip','application/zip',0],
  [packageGrant,'资料.zip','video/mp4',100],[grant,'资料.zip','application/zip',100],
  [grant,'原件.pdf','application/pdf',16777217],[grant,'照片.png','image/png',16777217],[grant,'视频.mp4','video/mp4',268435457],
  [packageGrant+'?x=1','资料.zip','application/zip',100],[packageGrant+'#x','资料.zip','application/zip',100],
  [packageGrant.replace('canonical.test','user:pass@canonical.test'),'资料.zip','application/zip',100],
  [packageGrant.replace('https:','file:'),'资料.zip','application/zip',100],
  [packageGrant.replace('/api/','/private/../api/'),'资料.zip','application/zip',100],
  [packageGrant.replace('/api/','/%61pi/'),'资料.zip','application/zip',100],
  [packageGrant.replace('/api/','\\api/'),'资料.zip','application/zip',100],
  [packageGrant,'../资料.zip','application/zip',100],[packageGrant,'','application/zip',100],[packageGrant,'.','application/zip',100],
  [packageGrant,'a'.repeat(161),'application/zip',100],[packageGrant,'资料\u007f.zip','application/zip',100],
 ])await assert.rejects(f.module.saveMobileSiteFile(url,name,mime,bytes,sha));
 assert.equal(called,0);
});
test('ZIP cancellation and native provider failures never report saved and late results are ignored',async t=>{
 let operation,cancelled;const f=await fixture(t,{downloadSiteFile(id){operation=id;},cancelSiteFile(id){cancelled=id;}}),controller=new AbortController();
 const pending=f.module.saveMobileSiteFile(packageGrant,'资料.zip','application/zip',100,sha,controller.signal);controller.abort();await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(cancelled,operation);
 f.w.__dailyResult(operation,JSON.stringify({saved:true,bytes:100,sha256:sha}));
 const failed=f.module.saveMobileSiteFile(packageGrant,'资料.zip','application/zip',100,sha);f.w.__dailyResult(operation,JSON.stringify({error:'手机空间不足，保存失败'}));await assert.rejects(failed,/空间不足/);
 const pickerCancelled=f.module.saveMobileSiteFile(packageGrant,'资料.zip','application/zip',100,sha);f.w.__dailyResult(operation,JSON.stringify({cancelled:true}));await assert.rejects(pickerCancelled,e=>e.cancelled===true);
});
test('package generation maps to exact mobile routes and only those POSTs receive the longer request timeout',async t=>{
 const requests=[],timeouts=[],realTimeout=globalThis.setTimeout;
 globalThis.setTimeout=(callback,ms,...args)=>{timeouts.push(ms);return realTimeout(callback,ms,...args);};t.after(()=>{globalThis.setTimeout=realTimeout;});
 const f=await fixture(t,{request(id,text){requests.push(JSON.parse(text));queueMicrotask(()=>window.__dailyResult(id,JSON.stringify({status:200,base64:btoa('{}'),contentType:'application/json'})));}});
 f.module.installMobileTransport();const id='12345678-1234-1234-1234-123456789abc';
 for(const [path,method] of [[`/api/engineering/projects/${id}/site-library/packages`,'POST'],['/api/engineering/site-library/packages','POST'],['/api/engineering/site-library','GET'],[`/api/engineering/projects/${id}/site-library`,'GET'],[`/api/engineering/projects/${id}/wbs/project-scope`,'POST'],[`/api/engineering/projects/${id}/site-library/packages`,'GET']])await f.w.fetch(path,{method,body:method==='POST'?'{}':undefined});
 assert.deepEqual(timeouts,[140000,140000,120000,120000,120000,120000]);
 assert.equal(requests[0].path,`/api/mobile/engineering/projects/${id}/site-library/packages`);assert.equal(requests[1].path,'/api/mobile/engineering/site-library/packages');assert.ok(requests.every(r=>r.token==='a'.repeat(43)));
});
test('same-origin mobile web retains bearer identity while allowing the server per-package HttpOnly cookie response',async t=>{
 const requests=[],receipt={url:'/api/engineering-site-packages/'+'d'.repeat(43),expiresAt:Date.now()+300000,name:'资料.zip',mime:'application/zip',byteCount:1073741824,sha256:sha};
 const f=await fixture(t,null,{fetch:async(url,init)=>{requests.push({url,init});return new Response(JSON.stringify(receipt),{headers:{'Content-Type':'application/json','Set-Cookie':'package_test=opaque; HttpOnly; SameSite=Strict; Path='+receipt.url+'; Max-Age=300'}});}});
 f.module.installMobileTransport();const response=await f.w.fetch('/api/engineering/site-library/packages',{method:'POST',body:'{}',credentials:'omit',redirect:'follow'});
 assert.deepEqual(await response.json(),receipt);assert.equal(requests[0].url,'https://example.test/api/mobile/engineering/site-library/packages');assert.equal(requests[0].init.credentials,'same-origin');assert.equal(requests[0].init.redirect,'error');assert.equal(requests[0].init.headers.get('Authorization'),'Bearer '+'a'.repeat(43));assert.equal(requests[0].init.headers.get('X-Workspace-Request'),'1');
 assert.equal(requests[0].init.headers.get('Cookie'),null);assert.equal(requests[0].url.includes('Bearer'),false);assert.equal(requests[0].url.includes('a'.repeat(43)),false);
});
test('cross-origin mobile web keeps credentials omitted and redirects rejected without dropping bearer authentication',async t=>{
 const requests=[];const f=await fixture(t,null,{origin:'https://different-page.test',fetch:async(url,init)=>{requests.push({url,init});return new Response('{}');}});
 f.module.installMobileTransport();await f.w.fetch('/api/engineering/site-library/packages',{method:'POST',body:'{}',credentials:'include',redirect:'follow'});
 assert.equal(requests[0].init.credentials,'omit');assert.equal(requests[0].init.redirect,'error');assert.equal(requests[0].init.headers.get('Authorization'),'Bearer '+'a'.repeat(43));assert.equal(requests[0].init.headers.get('Cookie'),null);
});
test('mobile web expiry responses still clear only the matching local session with same-origin credentials',async t=>{
 const f=await fixture(t,null,{fetch:async()=>new Response('{"error":"expired"}',{status:401})});
 f.module.installMobileTransport();assert.equal((await f.w.fetch('/api/engineering/site-library')).status,401);assert.equal(f.values.has('daily:session'),false);
});
