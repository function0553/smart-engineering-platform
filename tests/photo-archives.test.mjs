import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {readFileSync,mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {unzipSync,strFromU8} from 'fflate';
import {createApp} from '../server/app.mjs';
import {archiveSchema} from '../server/photo-archives.mjs';

const photo=readFileSync(new URL('./assets/daily-report-qa.png',import.meta.url));
const digest=b=>createHash('sha256').update(b).digest('hex');
export const archiveFixture=()=>({title:'非正式验收影像资料',projectName:'隔离测试工程（非现场资料）',roadName:'测试道路',segments:[{id:randomUUID(),start:'K0+000',end:'K0+074',content:'',completedAt:'2026-10-09',stages:['路面拆除','沟槽开挖','沟槽验收','垫层施工','管道安装','沟槽中粗砂回填','压实度检测','路面混凝土恢复'].map(name=>({id:randomUUID(),name,completedAt:''}))}]});
async function fixture(t,extra={}){
  const directory=mkdtempSync(join(tmpdir(),'engineering-archive-')),database=join(directory,'test.sqlite');
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const baseUrl='http://127.0.0.1:'+server.address().port;
  const {app,store,vision}=createApp({database,baseUrl,distPath:'__none__',updateDir:join(directory,'updates'),...extra});server.on('request',app);
  t.after(async()=>{vision.close();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();rmSync(directory,{recursive:true,force:true});});
  async function call(path,body,cookie='',method=body===undefined?'GET':'POST',headers={}){return fetch(baseUrl+'/api'+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json','X-Workspace-Request':'1',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  const response=await call('/setup',{organization:'影像隔离测试',username:'test-admin',name:'测试管理员',password:'isolated-test-12345'}),admin=response.headers.get('set-cookie').split(';')[0];
  async function user(name,role='operator'){await call('/users',{username:name,name,role,password:'isolated-test-12345'},admin);const r=await call('/login',{username:name,password:'isolated-test-12345'});return r.headers.get('set-cookie').split(';')[0];}
  async function create(cookie=admin,data=archiveFixture()){const response=await call('/photo-archives',{creationId:randomUUID(),data},cookie);assert.equal(response.status,201);return response.json();}
  const image=(a,stage=0)=>({id:randomUUID(),segmentId:a.data.segments[0].id,stageId:a.data.segments[0].stages[stage].id,name:'合成测试.png',caption:'非施工照片',mime:'image/png',base64:photo.toString('base64'),width:320,height:180});
  return {directory,database,baseUrl,call,store,admin,user,create,image};
}

test('photo archive persists segment/stage originals and immutable template Word across a SQLite reopen',async t=>{
  const f=await fixture(t),a=await f.create(),image=f.image(a);
  assert.equal((await f.call(`/photo-archives/${a.id}/photos`,image,f.admin)).status,201);
  const exportId=randomUUID(),made=await f.call(`/photo-archives/${a.id}/exports`,{exportId,version:1},f.admin);assert.equal(made.status,201);
  const path=`/photo-archives/${a.id}/exports/${exportId}/word`,response=await f.call(path,undefined,f.admin),word=Buffer.from(await response.arrayBuffer());
  assert.equal(response.status,200);const parts=unzipSync(word),xml=strFromU8(parts['word/document.xml']);
  assert.match(xml,/隔离测试工程（非现场资料）-测试道路/);assert.match(xml,/K0\+000～K0\+074段/);assert.match(xml,/2026-10-09/);assert.match(xml,/沟槽中粗砂回填/);assert.doesNotMatch(xml,/\{\{|贵阳市/);
  const media=Object.keys(parts).filter(n=>n.startsWith('word/media/'));assert.equal(media.length,1);assert.deepEqual(Buffer.from(parts[media[0]]),photo);
  const runtime=unzipSync(readFileSync(new URL('../server/templates/photo-archive.docx',import.meta.url)));
  for(const key of ['word/styles.xml','word/footer1.xml','word/fontTable.xml'])assert.deepEqual(parts[key],runtime[key]);
  const db=new DatabaseSync(f.database,{readOnly:true});assert.equal(db.prepare('SELECT COUNT(*) n FROM photo_archive_images').get().n,1);assert.deepEqual(Buffer.from(db.prepare('SELECT document FROM photo_archive_exports').get().document),word);db.close();
  const changed={...a.data,title:'补图后版本',segments:a.data.segments.map(s=>({...s,completedAt:'2026-10-10'}))};
  assert.equal((await f.call(`/photo-archives/${a.id}`,{version:1,data:changed},f.admin,'PUT')).status,200);
  assert.equal((await f.call(`/photo-archives/${a.id}/photos/${image.id}`,{},f.admin,'DELETE')).status,200);
  assert.deepEqual(Buffer.from(await (await f.call(path,undefined,f.admin)).arrayBuffer()),word);
  assert.deepEqual(Buffer.from(f.store.db.prepare('SELECT bytes FROM photo_archive_export_images').get().bytes),photo);
});

test('archive owner/admin boundaries cover list, template, originals, edits, upload, delete and Word',async t=>{
  const f=await fixture(t),owner=await f.user('owner'),other=await f.user('other'),viewer=await f.user('viewer','viewer'),a=await f.create(owner),image=f.image(a);
  await f.call(`/photo-archives/${a.id}/photos`,image,owner);const exportId=randomUUID();await f.call(`/photo-archives/${a.id}/exports`,{exportId,version:1},owner);
  for(const suffix of ['',`/photos/${image.id}`,`/exports/${exportId}/word`]){assert.equal((await f.call('/photo-archives/'+a.id+suffix,undefined,other)).status,404);assert.equal((await f.call('/photo-archives/'+a.id+suffix)).status,401);assert.equal((await f.call('/photo-archives/'+a.id+suffix,undefined,f.admin)).status,200);}
  assert.equal((await (await f.call('/photo-archives',undefined,other)).json()).total,0);assert.equal((await (await f.call('/photo-archives',undefined,f.admin)).json()).total,1);
  assert.equal((await f.call('/photo-archives',{creationId:randomUUID(),data:a.data},viewer)).status,403);
  assert.equal((await f.call('/photo-archives/'+a.id,{version:1,data:a.data},other,'PUT')).status,404);
  assert.equal((await f.call(`/photo-archives/${a.id}/photos/${image.id}`,{},other,'DELETE')).status,404);
  assert.equal((await f.call(`/photo-archives/${a.id}/photos`,image,other)).status,404);
  const login=await (await f.call('/mobile/login',{username:'owner',password:'isolated-test-12345'})).json();
  assert.equal((await f.call('/mobile/photo-archives/'+a.id,undefined,'','GET',{Authorization:'Bearer '+login.token})).status,200);
});

test('upload retry, stale metadata revision and missing stage fail without corrupting the archive',async t=>{
  const f=await fixture(t),a=await f.create(),image=f.image(a);
  assert.equal((await f.call(`/photo-archives/${a.id}/photos`,image,f.admin)).status,201);
  assert.equal((await f.call(`/photo-archives/${a.id}/photos`,image,f.admin)).status,200);
  assert.equal((await f.call(`/photo-archives/${a.id}/photos`,{...image,id:randomUUID(),stageId:randomUUID()},f.admin)).status,409);
  assert.equal((await f.call(`/photo-archives/${a.id}/photos`,{...image,id:randomUUID(),width:999},f.admin)).status,400);
  const updated=await f.call('/photo-archives/'+a.id,{version:1,data:a.data},f.admin,'PUT');assert.equal(updated.status,200);
  assert.equal((await f.call('/photo-archives/'+a.id,{version:1,data:a.data},f.admin,'PUT')).status,409);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM photo_archive_images').get().n,1);
  assert.equal((await f.call('/photo-archives/'+a.id+'/exports',{exportId:randomUUID(),version:1},f.admin)).status,409);
});

test('frozen Word snapshot rejects changed originals and an existing receipt replays its bytes after edits',async t=>{
  const f=await fixture(t),a=await f.create(),image=f.image(a),path=`/photo-archives/${a.id}`;
  await f.call(path+'/photos',image,f.admin);
  const detail=await (await f.call(path,undefined,f.admin)).json();
  const snapshot=JSON.stringify({data:detail.data,photos:detail.photos.map(p=>({id:p.id,segmentId:p.segmentId,stageId:p.stageId,name:p.name,caption:p.caption,mime:p.mime,width:p.width,height:p.height,bytes:p.bytes}))});
  const firstId=randomUUID();assert.equal((await f.call(path+'/exports',{exportId:firstId,version:1,snapshot},f.admin)).status,201);
  const word=Buffer.from(await (await f.call(path+'/exports/'+firstId+'/word',undefined,f.admin)).arrayBuffer());
  await f.call(path+'/photos/'+image.id,{},f.admin,'DELETE');
  await f.call(path+'/photos',{...f.image(a),caption:'变化后的照片说明'},f.admin);
  const refused=await f.call(path+'/exports',{exportId:randomUUID(),version:1,snapshot},f.admin);
  assert.equal(refused.status,409);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM photo_archive_exports').get().n,1);
  await f.call(path,{version:1,data:{...a.data,title:'另一个设备更新的标题'}},f.admin,'PUT');
  const replay=await f.call(path+'/exports',{exportId:firstId,version:1,snapshot},f.admin);assert.equal(replay.status,200);
  assert.equal((await replay.json()).replayed,true);
  assert.deepEqual(Buffer.from(await (await f.call(path+'/exports/'+firstId+'/word',undefined,f.admin)).arrayBuffer()),word);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM photo_archive_exports').get().n,1);
});

test('multiple segments and additional stage photos produce ordered template continuation pages without old source images',async t=>{
  const f=await fixture(t),data=archiveFixture(),second=archiveFixture().segments[0];second.content='探坑';second.start='';second.end='';data.segments.push(second);const a=await f.create(f.admin,data);
  await f.call(`/photo-archives/${a.id}/photos`,f.image(a),f.admin);
  const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
  await f.call(`/photo-archives/${a.id}/photos`,{...f.image(a),name:'第二张合成图.png',width:1,height:1,base64:bytes.toString('base64')},f.admin);
  const exportId=randomUUID();await f.call(`/photo-archives/${a.id}/exports`,{exportId,version:1},f.admin);
  const parts=unzipSync(Buffer.from(await (await f.call(`/photo-archives/${a.id}/exports/${exportId}/word`,undefined,f.admin)).arrayBuffer())),xml=strFromU8(parts['word/document.xml']);
  assert.equal((xml.match(/<w:tbl\b/g)||[]).length,3);assert.match(xml,/（续2）/);assert.match(xml,/探坑/);assert.equal(Object.keys(parts).filter(n=>n.startsWith('word/media/')).length,2);
  for(const table of xml.match(/<w:tbl\b[\s\S]*?<\/w:tbl>/g))for(const row of table.match(/<w:tr\b[\s\S]*?<\/w:tr>/g).slice(2))assert.equal((row.match(/<w:tc\b/g)||[]).length,2,'Blank photo slots retain both table cells');
});

test('archive input validates chainage and explicitly supports probe content and manual work stage names',()=>{
  const data=archiveFixture();assert.equal(archiveSchema.safeParse(data).success,true);data.segments[0].end='K0+000';assert.equal(archiveSchema.safeParse(data).success,false);
  data.segments[0].content='探坑';data.segments[0].stages[0].name='路面人工拆除';assert.equal(archiveSchema.safeParse(data).success,true);
});

test('more than eight stages repeat the original metadata table on every continuation page',async t=>{
  const f=await fixture(t),data=archiveFixture();data.segments[0].stages.push(...data.segments[0].stages.map((s,i)=>({...s,id:randomUUID(),name:'补充工序'+(i+1)})));
  const a=await f.create(f.admin,data);await f.call(`/photo-archives/${a.id}/photos`,f.image(a),f.admin);
  const exportId=randomUUID();await f.call(`/photo-archives/${a.id}/exports`,{exportId,version:1},f.admin);
  const parts=unzipSync(Buffer.from(await (await f.call(`/photo-archives/${a.id}/exports/${exportId}/word`,undefined,f.admin)).arrayBuffer())),xml=strFromU8(parts['word/document.xml']);
  assert.equal((xml.match(/<w:tbl\b/g)||[]).length,2);assert.match(xml,/（续2）/);
  for(const table of xml.match(/<w:tbl\b[\s\S]*?<\/w:tbl>/g)){assert.match(table,/工程名称/);assert.equal((table.match(/<w:tr\b/g)||[]).length,10);}
});

test('public update manifest and APK match exactly; no update for current/newer versions; corrupted publish is rejected',async t=>{
  const f=await fixture(t),directory=join(f.directory,'updates');mkdirSync(directory);const apk=Buffer.from('isolated manifest fixture, not installable'),manifest={package:'cn.smartengineering.dailyreport',versionCode:6,versionName:'0.3.0',minAndroidApi:26,size:apk.length,sha256:digest(apk),notes:['影像资料与自动更新'],publishedAt:new Date().toISOString()};
  writeFileSync(join(directory,'latest.apk'),apk);writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest));
  const older=await (await f.call('/mobile/app-update?versionCode=5')).json();assert.equal(older.available,true);assert.equal(older.downloadPath,'/api/mobile/app-update/apk');
  assert.equal((await (await f.call('/mobile/app-update?versionCode=6')).json()).available,false);
  assert.equal((await (await f.call('/mobile/app-update?versionCode=100')).json()).available,false);
  assert.deepEqual(Buffer.from(await (await f.call('/mobile/app-update/apk')).arrayBuffer()),apk);
  assert.equal((await f.call('/mobile/app-update?versionCode=-1')).status,400);
  writeFileSync(join(directory,'latest.apk'),Buffer.from('corrupt'));assert.equal((await f.call('/mobile/app-update')).status,500);
});
