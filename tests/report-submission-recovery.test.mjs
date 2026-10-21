import test from 'node:test';import assert from 'node:assert/strict';
import{createSubmissionRecovery,submissionRecoveryKey,submissionRecoveryPayloadKey,frozenSubmissionMatchesDraft}from'../src/report-cloud.ts';
function fixture(){const map=new Map(),bodies=new Map(),storage={getItem:k=>map.get(k)||null,setItem:(k,v)=>map.set(k,v)};const payloads=id=>({load:async()=>structuredClone(bodies.get(id)||null),save:async d=>bodies.set(id,structuredClone(d))});return{map,bodies,storage,payloads,recovery:(scope='project-a/area-a',project='project-a')=>createSubmissionRecovery(scope,project,storage,payloads)};}
const first=()=>({projectName:'项目A',reportDate:'2026-10-21',weatherAuto:true,weather:'晴',weatherInfo:{fetchedAt:'2026-10-21T00:00:00Z',condition:'晴'},photos:[{name:'原图',base64:'original-pixels'}],sections:[{name:'A段',todayNotes:'原施工内容'}]});

test('unknown result survives reload and weather changes by replaying exact original payload ID and WBS',async()=>{
 const f=fixture(),r=f.recovery(),original=first(),attempt=await r.prepare(original,'wbs-a');original.weatherInfo.fetchedAt='changed-in-memory';original.photos[0].base64='changed';
 const next=first();next.weatherInfo={fetchedAt:'2026-10-21T01:00:00Z',condition:'小雨'};next.weather='小雨';next.sections[0].todayNotes='未确认时修改的草稿';
 const recovered=await f.recovery().prepare(next,'wbs-b');assert.equal(recovered.submissionId,attempt.submissionId);assert.deepEqual(recovered.data,first());assert.equal(recovered.wbsId,'wbs-a');assert.equal(recovered.receipt,undefined);
 assert.ok([...f.map.values()].every(raw=>!raw.includes('original-pixels')));assert.equal(next.sections[0].todayNotes,'未确认时修改的草稿');
});

test('saved immutable receipt is reused when only automatic weather changes; authored edits get a new request',async()=>{
 const f=fixture(),r=f.recovery(),attempt=await r.prepare(first(),'wbs-a'),receipt={id:'saved-a',projectId:'project-a'};r.saved(attempt,receipt);
 const weather=first();weather.weather='阴';weather.weatherInfo={fetchedAt:'new',condition:'阴'};const same=await f.recovery().prepare(weather,'wbs-b');assert.equal(same.submissionId,attempt.submissionId);assert.deepEqual(same.data,first());assert.equal(same.receipt.id,'saved-a');assert.equal(same.wbsId,'wbs-a');
 weather.sections[0].todayNotes='明确更改正文';const changed=await f.recovery().prepare(weather,'wbs-b');assert.notEqual(changed.submissionId,attempt.submissionId);assert.equal(changed.wbsId,'wbs-b');assert.equal(changed.receipt,undefined);
});

test('pending indexes isolate project and area, and unreadable original pixels block new requests',async()=>{
 const f=fixture(),a=await f.recovery().prepare(first(),'wbs-a');const b=await f.recovery('project-b/area-a','project-b').prepare(first(),'wbs-b');assert.notEqual(a.submissionId,b.submissionId);assert.notEqual(submissionRecoveryKey('a'),submissionRecoveryKey('b'));assert.notEqual(submissionRecoveryPayloadKey('a',a.submissionId),submissionRecoveryPayloadKey('b',a.submissionId));
 f.bodies.delete(a.submissionId);await assert.rejects(f.recovery().prepare({...first(),weather:'雨'},'wbs-b'),/原件暂不可读/);assert.equal(JSON.parse(f.map.get(submissionRecoveryKey('project-a/area-a'))).submissionId,a.submissionId);
});

test('payload or metadata storage failure prevents a new request from being returned',async()=>{
 const f=fixture();const bad=createSubmissionRecovery('s','p',f.storage,()=>({load:async()=>null,save:async()=>{throw Error('quota pixels');}}));await assert.rejects(bad.prepare(first()),/quota pixels/);assert.equal(f.map.size,0);
 const badIndex=createSubmissionRecovery('s','p',{getItem:()=>null,setItem:()=>{}},f.payloads);await assert.rejects(badIndex.prepare(first()),/凭据未能/);
});

test('failed new metadata write never overwrites a previous frozen payload',async()=>{
 const f=fixture(),r=f.recovery(),old=await r.prepare(first(),'wbs-a');r.saved(old,{id:'saved-a',projectId:'project-a'});const before=structuredClone(f.bodies.get(old.submissionId));const edited=first();edited.sections[0].todayNotes='第二份';
 const fail=createSubmissionRecovery('project-a/area-a','project-a',{...f.storage,setItem(){throw Error('index quota');}},f.payloads);await assert.rejects(fail.prepare(edited,'wbs-b'),/index quota/);assert.deepEqual(f.bodies.get(old.submissionId),before);assert.equal((await f.recovery().load()).receipt.id,'saved-a');
});

test('a definitive first validation rejection permits repair while a replay rejection cannot abandon an uncertain request',async()=>{
 const f=fixture(),r=f.recovery(),bad=await r.prepare(first(),'wbs-a');r.rejected(bad);assert.equal(await r.load(),null);
 const fixed=first();fixed.sections[0].todayNotes='修正正文';const next=await r.prepare(fixed,'wbs-a');const restored=await f.recovery().load();f.recovery().rejected(restored);assert.equal((await f.recovery().load()).submissionId,next.submissionId);
});


test('concurrent taps share one frozen attempt and late edited input cannot replace it',async()=>{
 const f=fixture(),r=f.recovery(),edited=first();edited.sections[0].todayNotes='后一次点击的内容';const[a,b]=await Promise.all([r.prepare(first(),'wbs-a'),r.prepare(edited,'wbs-b')]);assert.equal(a.submissionId,b.submissionId);assert.deepEqual(b.data,first());assert.equal(b.wbsId,'wbs-a');assert.equal(f.bodies.size,1);
});


test('known server receipt remains usable when frozen local pixels are unavailable',async()=>{
 const f=fixture(),r=f.recovery(),attempt=await r.prepare(first(),'wbs-a');r.saved(attempt,{id:'saved-source',projectId:'project-a'});f.bodies.delete(attempt.submissionId);
 const loaded=await f.recovery().load();assert.equal(loaded.receipt.id,'saved-source');assert.equal(loaded.data,undefined);
 const onlyWeather=first();onlyWeather.weather='雨';onlyWeather.weatherInfo.fetchedAt='another time';const replay=await f.recovery().prepare(onlyWeather,'wbs-b');assert.equal(replay.submissionId,attempt.submissionId);assert.equal(replay.receipt.id,'saved-source');assert.equal(replay.wbsId,'wbs-a');assert.equal(await frozenSubmissionMatchesDraft(replay,onlyWeather),true);
 const edited=first();edited.sections[0].todayNotes='本机仍未提交的后改内容';assert.equal(await frozenSubmissionMatchesDraft(replay,edited),false);
});

test('separate editor instances serialize their claim through the browser scope lock',async()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis.navigator,'locks');let tail=Promise.resolve(),locks=0;Object.defineProperty(globalThis.navigator,'locks',{configurable:true,value:{request:(_name,run)=>{locks++;const result=tail.then(run);tail=result.catch(()=>{});return result;}}});
 try{const f=fixture(),edited=first();edited.sections[0].todayNotes='另一个标签页';const[a,b]=await Promise.all([f.recovery().prepare(first(),'wbs-a'),f.recovery().prepare(edited,'wbs-b')]);assert.equal(locks,2);assert.equal(a.submissionId,b.submissionId);assert.equal(f.bodies.size,1);assert.equal(b.wbsId,'wbs-a');}
 finally{if(original)Object.defineProperty(globalThis.navigator,'locks',original);else delete globalThis.navigator.locks;}
});
