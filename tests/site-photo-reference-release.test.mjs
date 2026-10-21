import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createApp} from '../server/app.mjs';
test('site photo example is authenticated and preserves the exact one-page Word',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'site-reference-')),server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const p=createApp({database:join(dir,'db.sqlite'),filesDir:join(dir,'files'),distPath:join(dir,'dist'),baseUrl:base});server.on('request',p.app);
 const request=async(path,body,headers={})=>fetch(base+path,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','X-Workspace-Request':'1',...headers},...(body?{body:JSON.stringify(body)}:{})});
 try{
 for(const route of ['/api/engineering/site-photo-reference','/api/mobile/engineering/site-photo-reference'])assert.equal((await request(route)).status,401);
 const password=randomBytes(24).toString('hex'),setup=await request('/api/setup',{organization:'isolated reference check',username:'qa-ref',name:'fixture',password});assert.equal(setup.status,201);const cookie=setup.headers.get('set-cookie').split(';')[0];
 const web=await request('/api/engineering/site-photo-reference',null,{Cookie:cookie});assert.equal(web.status,200);assert.deepEqual(Buffer.from(await web.arrayBuffer()),readFileSync(new URL('../server/templates/site-photo-a4-aligned.docx',import.meta.url)));
 const login=await request('/api/mobile/login',{username:'qa-ref',password});const token=(await login.json()).token;
 const mobile=await request('/api/mobile/engineering/site-photo-reference',null,{Authorization:'Bearer '+token});assert.equal(mobile.status,200);assert.deepEqual(Buffer.from(await mobile.arrayBuffer()),readFileSync(new URL('../server/templates/site-photo-a4-aligned.docx',import.meta.url)));
 }finally{p.vision.close();p.ppe.close();server.closeAllConnections();await new Promise(r=>server.close(r));p.store.close();}
});
