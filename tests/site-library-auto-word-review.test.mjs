import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {unzipSync,strFromU8} from 'fflate';
import sharp from 'sharp';
import {createApp} from '../server/app.mjs';

const root=fileURLToPath(new URL('..',import.meta.url)),sha=value=>createHash('sha256').update(value).digest('hex');
const ok=(r,status=200)=>assert.equal(r.status,status,JSON.stringify(r.body));
async function fixture(t){
 const parent=join(root,'outputs/auto-word-independent-fixtures');mkdirSync(parent,{recursive:true});const dir=mkdtempSync(join(parent,'fixture-')),password=randomBytes(24).toString('hex');
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port,state=createApp({database:join(dir,'fixture.sqlite'),baseUrl:url,distPath:'__none__',filesDir:join(dir,'files'),updateDir:join(dir,'updates')});server.on('request',state.app);
 t.after(async()=>{state.vision.close();server.closeAllConnections();await new Promise(r=>server.close(r));state.store.close();assert.ok(dir.startsWith(parent+'/fixture-'));rmSync(dir,{recursive:true,force:true});});
 async function call(path,body,cookie='',method=body===undefined?'GET':'POST',headers={}){const response=await fetch(url+'/api'+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json','X-Workspace-Request':'1',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});const bytes=Buffer.from(await response.arrayBuffer());let value;try{value=JSON.parse(bytes.toString());}catch{value=null;}return{status:response.status,body:value,bytes,headers:response.headers,cookie:response.headers.get('set-cookie')?.split(';')[0]};}
 const setup=await call('/setup',{organization:'独立自动照片表格验证',username:'auto-admin',name:'管理员',password});ok(setup,201);const admin=setup.cookie,users={};
 for(const name of ['engineer','viewer']){ok(await call('/users',{username:'auto-'+name,name,role:name==='viewer'?'viewer':'operator',password},admin),201);const login=await call('/login',{username:'auto-'+name,password});ok(login);users[name]={cookie:login.cookie};}
 const directory=(await call('/users',undefined,admin)).body;for(const name in users)users[name].id=directory.find(u=>u.username==='auto-'+name).id;
 const project=await call('/engineering/projects',{requestId:randomUUID(),data:{code:randomUUID(),name:'合成工程 & 自动表格',address:'合成地址',owner:'经理',startDate:'2026-10-01',dueDate:'2026-12-31',budget:0,note:'仅本机独立审阅'}},admin);ok(project,201);const pid=project.body.id,pb='/engineering/projects/'+pid,base=pb+'/site-records';
 const post=(path,body={},cookie=admin,method='POST')=>call(pb+path,{requestId:randomUUID(),...body},cookie,method);
 ok(await post('/state',{version:1,state:'active',note:'合成开工'}));for(const [name,role]of [['engineer','engineer'],['viewer','viewer']])ok(await post('/members',{userId:users[name].id,role},admin,'PUT'));
 const node=await post('/wbs',{data:{parentId:'',code:'S01',title:'合成施工部位',type:'area',note:''}});ok(node,201);
 const create=async(title='独立照片组',category='work_photos')=>{const result=await call(base,{requestId:randomUUID(),data:{category,title,recordDate:'2026-10-21',wbsId:node.body.id,taskId:'',note:'仅合成照片',uploadPolicy:'seven_v1'}},users.engineer.cookie);ok(result,201);return result.body;};
 const detail=async record=>{const result=await call(base+'/'+record.id,undefined,users.engineer.cookie);ok(result);return result.body;};
 const action=async(record,path,body)=>call(base+'/'+record.id+path,{requestId:randomUUID(),...body},users.engineer.cookie);
 const photo=async(record,color='#2277bb',stepId='step01')=>{const bytes=await sharp({create:{width:96,height:60,channels:3,background:color}}).png().toBuffer();const start=await action(record,'/uploads',{version:(await detail(record)).version,name:color.replace('#','')+'.png',mime:'image/png',byteCount:bytes.length,sha256:sha(bytes),...(stepId?{stepId}:{})});ok(start,201);ok(await action(record,'/uploads/'+start.body.id+'/chunks',{offset:0,base64:bytes.toString('base64')}));const result=await action(record,'/uploads/'+start.body.id+'/complete',{});ok(result);return{id:result.body.id,bytes};};
 const pack=async(cookie=users.engineer.cookie,body={})=>call(pb+'/site-library/packages',{requestId:randomUUID(),...body},cookie);
 const download=async(receipt,cookie=users.engineer.cookie)=>{const result=await call(receipt.url.slice(4),undefined,cookie);ok(result);assert.equal(sha(result.bytes),receipt.sha256);return unzipSync(result.bytes);};
 const snapshot=()=>Object.fromEntries(state.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'engineering_%' ORDER BY name").all().map(({name})=>[name,state.store.db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]));
 return{call,post,admin,users,pid,pb,base,node:node.body,create,detail,action,photo,pack,download,snapshot,password,get store(){return state.store;},path:id=>join(dir,'files/engineering-site-records/originals',id+'.original')};
}
const wordEntries=entries=>Object.entries(entries).filter(([name])=>name.endsWith('.docx'));

test('independent ZIP auto table uses current representatives while preserving old Word history and original bytes',async t=>{
 const f=await fixture(t),record=await f.create(),red=await f.photo(record,'#ff0000'),blue=await f.photo(record,'#0000ff','step04');
 let detail=await f.detail(record);ok(await f.action(record,'/exports',{version:detail.version}),201);const old=f.store.db.prepare('SELECT * FROM engineering_site_word_exports WHERE record_id=?').get(record.id);const green=await f.photo(record,'#00ff00');detail=await f.detail(record);ok(await f.action(record,'/files/'+green.id+'/step',{version:detail.version,stepId:'step01',representative:true}));
 const before=f.snapshot(),packed=await f.pack();ok(packed);const entries=await f.download(packed.body),words=wordEntries(entries);assert.equal(words.length,2);const history=words.find(([,bytes])=>sha(bytes)===old.sha256),current=words.find(([,bytes])=>sha(bytes)!==old.sha256);assert.ok(history);assert.ok(current);assert.notEqual(history[0],current[0]);assert.deepEqual(Buffer.from(history[1]),Buffer.from(old.document));
 const document=unzipSync(current[1]),xml=strFromU8(document['word/document.xml']);assert.equal(Object.keys(document).filter(name=>name.startsWith('word/media/')).length,2);assert.equal((xml.match(/未提供照片/g)||[]).length,8);assert.match(xml,/合成工程 &amp; 自动表格/);
 const rgb=await sharp(document['word/media/site-step-0.jpeg']).resize(1,1).raw().toBuffer();assert.ok(rgb[1]>rgb[0]+100&&rgb[1]>rgb[2]+100,'current table must use the green replacement, not the historical red representative');
 assert.deepEqual(f.snapshot(),before);for(const original of [red,blue,green])assert.equal(sha(readFileSync(f.path(original.id))),sha(original.bytes));
 const manifest=JSON.parse(strFromU8(entries['清单.json']));assert.equal(manifest.recordCount,1);assert.equal(manifest.fileCount,5);assert.equal(packed.body.fileCount,5);
});

test('zero-photo records get an explicit ten-slot empty table without creating history or pretending photos exist',async t=>{
 const f=await fixture(t),record=await f.create('零照片草稿'),before=f.snapshot(),packed=await f.pack();ok(packed);const entries=await f.download(packed.body),words=wordEntries(entries);assert.equal(words.length,1);const document=unzipSync(words[0][1]),xml=strFromU8(document['word/document.xml']);assert.equal((xml.match(/未提供照片/g)||[]).length,10);assert.equal(Object.keys(document).filter(name=>name.startsWith('word/media/')).length,0);assert.deepEqual(f.snapshot(),before);assert.equal((await f.detail(record)).files.length,0);
});

test('legacy viewer with download access can receive a derived table on ended withdrawn records without changing original APIs',async t=>{
 const f=await fixture(t),record=await f.create(),image=await f.photo(record);f.store.db.prepare("INSERT INTO engineering_site_access_config VALUES(?,0,1,'independent-legacy',?)").run(f.pid,new Date().toISOString());
 const detail=await f.detail(record);ok(await f.call(f.base+'/'+record.id+'/photo-table?version='+detail.version,undefined,f.users.viewer.cookie),403);
 f.store.db.prepare("UPDATE engineering_site_records SET state='withdrawn',withdraw_reason='合成历史撤回' WHERE id=?").run(record.id);f.store.db.prepare("UPDATE engineering_projects SET state='completed' WHERE id=?").run(f.pid);
 const before=f.snapshot(),packed=await f.pack(f.users.viewer.cookie);ok(packed);const entries=await f.download(packed.body,f.users.viewer.cookie);assert.equal(wordEntries(entries).length,1);assert.equal((JSON.parse(strFromU8(entries['清单.json']))).records[0].state,'withdrawn');assert.deepEqual(f.snapshot(),before);assert.equal(sha(readFileSync(f.path(image.id))),sha(image.bytes));
 ok(await f.call(f.base+'/'+record.id+'/photo-table?version='+detail.version,undefined,f.admin),409);
});

test('unassigned photos or a populated step without a representative fail explicitly and create no historical Word',async t=>{
 for(const drift of ['unassigned','no-representative']){const f=await fixture(t),record=await f.create('需要整理-'+drift),image=await f.photo(record);f.store.db.prepare('UPDATE engineering_site_file_steps SET step_id=?,representative=0 WHERE file_id=?').run(drift==='unassigned'?'':'step01',image.id);const before=f.snapshot(),result=await f.pack();ok(result,409);assert.match(result.body.error,/工序|代表/);assert.match(result.body.error,new RegExp(record.id+'|需要整理'));assert.deepEqual(f.snapshot(),before);}
});

async function gateConversion(t,run,change){
 const original=sharp.prototype.toBuffer;let entered,release;const ready=new Promise(r=>{entered=r;}),gate=new Promise(r=>{release=r;}),timeout=setTimeout(()=>release(),10000);let first=true;
 sharp.prototype.toBuffer=function(...args){const conversion=original.apply(this,args);if(!first)return conversion;first=false;entered();return Promise.all([conversion,gate]).then(([value])=>value);};
 t.after(()=>{sharp.prototype.toBuffer=original;clearTimeout(timeout);release();});
 const pending=run();await Promise.race([ready,new Promise((_,reject)=>setTimeout(()=>reject(Error('actual Sharp conversion never started')),3000))]);try{await change();}finally{release();}const result=await pending;sharp.prototype.toBuffer=original;clearTimeout(timeout);return result;
}

for(const drift of ['project-metadata','representative','pending-upload','download-permission','logout'])test('auto table rechecks '+drift+' after actual asynchronous conversion before granting the ZIP',async t=>{
 const f=await fixture(t),record=await f.create('异步依据核验'),image=await f.photo(record),other=await f.photo(record,'#33aa11');let afterChange;
 const result=await gateConversion(t,()=>f.pack(),async()=>{
  if(drift==='project-metadata'){const row=f.store.db.prepare('SELECT data FROM engineering_projects WHERE id=?').get(f.pid);f.store.db.prepare('UPDATE engineering_projects SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.data),name:'并发改变项目名称'}),f.pid);}
  if(drift==='representative'){f.store.db.prepare('UPDATE engineering_site_file_steps SET representative=0 WHERE file_id=?').run(image.id);f.store.db.prepare('UPDATE engineering_site_file_steps SET representative=1 WHERE file_id=?').run(other.id);}
  if(drift==='pending-upload'){const bytes=Buffer.from('ffd8ff01020304','hex');ok(await f.action(record,'/uploads',{version:(await f.detail(record)).version,name:'pending.jpg',mime:'image/jpeg',stepId:'step02',byteCount:bytes.length,sha256:sha(bytes)}),201);}
  if(drift==='download-permission'){const data={template:'engineer',actions:['read'],categories:[],wbsIds:[],ownOnly:false,memberRole:'engineer'};f.store.db.prepare('INSERT INTO engineering_site_access_grants VALUES(?,?,?,?,?,?)').run(f.pid,f.users.engineer.id,1,JSON.stringify(data),f.users.engineer.id,new Date().toISOString());}
  if(drift==='logout')f.store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(f.users.engineer.id);
  afterChange=f.snapshot();
 });
 ok(result,drift==='logout'?401:drift==='download-permission'?403:409);assert.deepEqual(f.snapshot(),afterChange);assert.equal(sha(readFileSync(f.path(image.id))),sha(image.bytes));
});

test('automatic current Word remains independent of a full 50-version historical quota',async t=>{
 const f=await fixture(t),record=await f.create('历史额度已满'),red=await f.photo(record,'#ee2211');let detail=await f.detail(record);ok(await f.action(record,'/exports',{version:detail.version}),201);
 const historical=f.store.db.prepare('SELECT * FROM engineering_site_word_exports WHERE record_id=?').get(record.id),columns=Object.keys(historical),insert=f.store.db.prepare('INSERT INTO engineering_site_word_exports('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')');
 for(let i=2;i<=50;i++)insert.run(...columns.map(k=>k==='id'?randomUUID():k==='sequence'?i:k==='snapshot'?JSON.stringify({independentHistoricalFixture:i}):historical[k]));
 const replacement=await f.photo(record,'#11cc44');detail=await f.detail(record);ok(await f.action(record,'/files/'+replacement.id+'/step',{version:detail.version,stepId:'step01',representative:true}));
 const before=f.snapshot(),packed=await f.pack();ok(packed);const entries=await f.download(packed.body),words=wordEntries(entries);assert.equal(words.length,51);assert.equal(words.filter(([,bytes])=>sha(bytes)===historical.sha256).length,50);assert.equal(words.filter(([,bytes])=>sha(bytes)!==historical.sha256).length,1);assert.deepEqual(f.snapshot(),before);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM engineering_site_word_exports WHERE record_id=?').get(record.id).n,50);assert.equal(sha(readFileSync(f.path(red.id))),sha(red.bytes));
});

test('already-granted ZIP rejects changed project metadata WBS evidence photo assignment and Word history on GET',async t=>{
 for(const drift of ['project-metadata','wbs-context','representative','pending-upload','word-history']){
  const f=await fixture(t),record=await f.create('已生成后的依据变化-'+drift),image=await f.photo(record),alternative=await f.photo(record,'#cc22aa'),packed=await f.pack();ok(packed);
  if(drift==='project-metadata'){const project=f.store.db.prepare('SELECT data FROM engineering_projects WHERE id=?').get(f.pid);f.store.db.prepare('UPDATE engineering_projects SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(project.data),address:'后续改地址'}),f.pid);}
  if(drift==='wbs-context'){const node=f.store.db.prepare('SELECT data FROM engineering_wbs WHERE id=?').get(f.node.id);f.store.db.prepare('UPDATE engineering_wbs SET data=? WHERE id=?').run(JSON.stringify({...JSON.parse(node.data),title:'后续改施工部位'}),f.node.id);}
  if(drift==='representative'){f.store.db.prepare('UPDATE engineering_site_file_steps SET representative=0 WHERE file_id=?').run(image.id);f.store.db.prepare('UPDATE engineering_site_file_steps SET representative=1 WHERE file_id=?').run(alternative.id);}
  if(drift==='pending-upload'){const bytes=Buffer.from('ffd8ff102030','hex');ok(await f.action(record,'/uploads',{version:(await f.detail(record)).version,name:'new-pending.jpg',mime:'image/jpeg',stepId:'step03',byteCount:bytes.length,sha256:sha(bytes)}),201);}
  if(drift==='word-history'){const detail=await f.detail(record);ok(await f.action(record,'/exports',{version:detail.version}),201);}
  const before=f.snapshot(),get=await f.call(packed.body.url.slice(4),undefined,f.users.engineer.cookie);ok(get,409);assert.deepEqual(f.snapshot(),before,drift);assert.equal(sha(readFileSync(f.path(image.id))),sha(image.bytes));
 }
});

test('generation timeout releases the failed attempt so the exact request can be retried without creating history',async t=>{
 const f=await fixture(t),record=await f.create('生成超时恢复');await f.photo(record);const requestId=randomUUID(),before=f.snapshot(),actualNow=Date.now;
 let result;try{result=await gateConversion(t,()=>f.pack(f.users.engineer.cookie,{requestId}),()=>{Date.now=()=>actualNow()+121000;});}finally{Date.now=actualNow;}
 ok(result,408);assert.deepEqual(f.snapshot(),before);const retry=await f.pack(f.users.engineer.cookie,{requestId});ok(retry);const entries=await f.download(retry.body);assert.equal(wordEntries(entries).length,1);assert.deepEqual(f.snapshot(),before);
});
