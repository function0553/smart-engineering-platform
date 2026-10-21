import test from 'node:test';
import assert from 'node:assert/strict';
import { filingKey, createDailyFilingJournal, readDailyFilingJournal, confirmDailyFiling, retainDailyFilingJournal, timedDailyFilingRequest, readRetainedDailyFilings } from '../src/daily-filing.ts';
const receipt = { id:'0c93a402-de24-4cc2-aa19-ce9c2b3b8c1c',projectId:'project-a',authorId:'worker',authorName:'worker',projectName:'项目A',reportDate:'2026-10-21',region:'本地',number:'',photoCount:0,createdAt:'',documentSha256:'sha' };
const project = { id:'project-a',name:'项目A',canCreate:true,nodes:[{id:'wbs-a',data:{code:'A',title:'部位A'}}] };

test('filing key preserves old schema and isolates backend account project and receipt',()=>{
 assert.equal(filingKey('origin','worker','project-a',receipt.id),'site:daily-filing:v1:'+JSON.stringify(['origin','worker','project-a',receipt.id]));
 const keys=[filingKey('origin','worker','project-a',receipt.id),filingKey('other','worker','project-a',receipt.id),filingKey('origin','other','project-a',receipt.id),filingKey('origin','worker','project-b',receipt.id),filingKey('origin','worker','project-a','other')];assert.equal(new Set(keys).size,5);
});

test('only an explicitly allowed position in the current project starts a new filing',()=>{
 assert.throws(()=>createDailyFilingJournal({...receipt,projectId:'project-b'},project,'wbs-a'),/其他项目/);
 assert.throws(()=>createDailyFilingJournal(receipt,project,'wbs-b'),/授权范围/);
 assert.throws(()=>createDailyFilingJournal(receipt,{...project,canCreate:false},'wbs-a'),/授权范围/);
 const journal=createDailyFilingJournal(receipt,project,'wbs-a');assert.equal(journal.body.data.category,'construction_daily');assert.equal(journal.body.data.dailyReportId,receipt.id);assert.equal(journal.body.data.wbsId,'wbs-a');
});

test('new filing persists request before GET and POST; no implicit approval follows',async()=>{
 const journal=createDailyFilingJournal(receipt,project,'wbs-a'),events=[];
 const done=await confirmDailyFiling(project,receipt,journal,async(path,method,body)=>{events.push({path,method,body});return method==='POST'?{id:'filed-id'}:{status:'not_found'};},j=>events.push({retained:structuredClone(j)}));
 assert.equal(events[0].retained.body.requestId,journal.body.requestId);assert.equal(events[1].method,undefined);assert.equal(events[2].method,'POST');assert.deepEqual(events[2].body,journal.body);assert.equal(done.id,'filed-id');assert.equal(done.status,'confirmed');assert.equal(events.length,4);assert.ok(events.every(e=>!e.path||!e.path.includes('/submit')));
});

test('lost response recovers original ID after reload without a second write',async()=>{
 const journal=createDailyFilingJournal(receipt,project,'wbs-a');let raw='',writes=0,stored=false;
 const request=async(path,method)=>{if(method==='POST'){writes++;stored=true;throw Error('回复断网');}return stored?{status:'confirmed',id:'original-id'}:{status:'not_found'};};
 await assert.rejects(confirmDailyFiling(project,receipt,journal,request,j=>{raw=JSON.stringify(j);}),/断网/);
 const restored=readDailyFilingJournal(raw,receipt);assert.equal(restored.body.requestId,journal.body.requestId);
 const done=await confirmDailyFiling(project,receipt,restored,request,j=>{raw=JSON.stringify(j);});assert.equal(writes,1);assert.equal(done.id,'original-id');
});

test('unavailable journal storage blocks all network writes and preserves source',async()=>{
 const journal=createDailyFilingJournal(receipt,project,'wbs-a'),before=structuredClone(receipt);let calls=0;
 await assert.rejects(confirmDailyFiling(project,receipt,journal,async()=>{calls++;return {status:'not_found'};},()=>{throw Error('存储不足');}),/存储不足/);assert.equal(calls,0);assert.deepEqual(receipt,before);
});

test('changed permission can confirm the original receipt but never change its target',async()=>{
 const journal=createDailyFilingJournal(receipt,project,'wbs-a'),restricted={...project,canCreate:false,nodes:[]};let writes=0;
 const done=await confirmDailyFiling(restricted,receipt,journal,async()=>({status:'confirmed_restricted'}),()=>{});assert.equal(done.status,'confirmed_restricted');assert.equal(done.id,undefined);
 await assert.rejects(confirmDailyFiling(restricted,receipt,journal,async(_p,m)=>{if(m)writes++;return {status:'not_found'};},()=>{}),/权限已变化/);assert.equal(writes,0);assert.equal(journal.body.data.wbsId,'wbs-a');
});

test('cross-project or malformed retained filing never silently becomes a new write',async()=>{
 const journal=createDailyFilingJournal(receipt,project,'wbs-a');let calls=0;
 await assert.rejects(confirmDailyFiling({...project,id:'project-b'},receipt,journal,async()=>{calls++;return {};},()=>{}),/其他项目/);assert.equal(calls,0);
 assert.throws(()=>readDailyFilingJournal(JSON.stringify({...journal,body:{...journal.body,data:{...journal.body.data,dailyReportId:'foreign'}}}),receipt),/无法读取/);
 assert.equal(readDailyFilingJournal(null,receipt),null);
});


test('durability readback is required; changed permission strips a formerly visible record ID',async()=>{
 const journal=createDailyFilingJournal(receipt,project,'wbs-a');
 assert.throws(()=>retainDailyFilingJournal({setItem(){},getItem(){return null;}},'old-key',journal),/未能保存在本机/);
 const done=await confirmDailyFiling({...project,canCreate:false},receipt,{...journal,status:'confirmed',id:'formerly-visible'},async()=>({status:'confirmed_restricted'}),()=>{});assert.equal(done.id,undefined);
 assert.throws(()=>readDailyFilingJournal(JSON.stringify({...journal,status:'confirmed'}),receipt),/无法读取/);
});


test('timeout releases the operation and late POST response cannot overwrite the pending recovery journal',async()=>{
 const journal=createDailyFilingJournal(receipt,project,'wbs-a');let retained,releasePost,posts=0,exists=false;
 const transport=async(_path,method)=>{if(!method)return exists?{status:'confirmed',id:'after-timeout'}:{status:'not_found'};posts++;exists=true;return new Promise(resolve=>{releasePost=resolve;});};
 await assert.rejects(confirmDailyFiling(project,receipt,journal,timedDailyFilingRequest(transport,10),j=>{retained=j;}),/核对超时/);assert.equal(retained.status,'pending');
 releasePost({id:'late-response'});await new Promise(resolve=>setImmediate(resolve));assert.equal(retained.status,'pending');
 const restored=readDailyFilingJournal(JSON.stringify(retained),receipt),done=await confirmDailyFiling(project,receipt,restored,timedDailyFilingRequest(transport,20),j=>{retained=j;});assert.equal(posts,1);assert.equal(done.id,'after-timeout');assert.equal(done.body.requestId,journal.body.requestId);
});


test('retained queue tolerates storage getter length key and value failures without losing readable entries',()=>{
 const journal=createDailyFilingJournal(receipt,project,'wbs-a'),key=filingKey('origin','worker',project.id,receipt.id);
 const good={length:1,key:()=>key,getItem:()=>JSON.stringify(journal)};
 const errors=[()=>{throw new DOMException('denied','SecurityError');},()=>({get length(){throw Error('length');}}),()=>({length:1,key(){throw Error('key');}}),()=>({length:1,key:()=>key,getItem(){throw Error('getItem');}})];
 for(const source of errors){const r=readRetainedDailyFilings('origin','worker',project.id,[source,()=>good]);assert.equal(r.rows.length,1);assert.equal(r.rows[0].receipt.id,receipt.id);assert.ok(r.warning);}
 const unavailable=readRetainedDailyFilings('origin','worker',project.id,errors);assert.equal(unavailable.rows.length,0);assert.ok(unavailable.warning);
});
