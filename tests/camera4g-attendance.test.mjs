import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import express from 'express';
import { openStore } from '../server/store.mjs';
import { mountCameraAttendance } from '../server/camera4g-attendance.mjs';

const record = id => ({ attendance_id:`a-${id}`,person_id:'worker-01',name:'测试人员',business_date:'2026-10-22',occurred_at:'2026-10-22T02:00:00+00:00',camera_id:'camera-02',similarity:.9,voice_status:'pending',liveness_status:'passed',attendance_status:'on_time',late_seconds:0 });
const event = n => ({ sequence:n,kind:'checkin',attendance_id:`a-${n}`,record:record(n) });
const digest = event => createHash('sha256').update(JSON.stringify(event)).digest('hex');
async function fixture(t, extra={}) {
  const store=openStore(':memory:'), token='synthetic-token-'.repeat(4), seen=[], events=Array.from({length:1001},(_,i)=>event(i+1));
  const state={stream:'stream-1', events, broken:false, offline:false, enrolled:null, delay:0, custom:null};
  const upstream=createServer(async(req,res)=>{
    seen.push({url:req.url,auth:req.headers.authorization,cookie:req.headers.cookie});
    if(req.headers.authorization!==`Bearer ${token}`)return res.writeHead(401).end();
    if(state.delay)await new Promise(done=>setTimeout(done,state.delay));
    if(req.destroyed||res.destroyed)return;
    if(state.offline)return res.writeHead(503).end('private upstream error');
    res.setHeader('Content-Type','application/json');
    if(state.custom?.(req,res))return;
    if(req.url.startsWith('/api/attendance/changes')) {
      const url=new URL(req.url,'http://fixture'),after=Number(url.searchParams.get('after')),limit=Number(url.searchParams.get('limit'));
      const rows=state.events.filter(e=>e.sequence>after).slice(0,limit),cursor=rows.at(-1)?.sequence??after;
      return res.end(JSON.stringify({stream_id:state.stream,after_digest:after?digest(state.events.find(e=>e.sequence===after)):null,events:state.broken?[event(0)]:rows.map(e=>({...e,digest:digest(e)})),next_cursor:cursor,has_more:state.events.some(e=>e.sequence>cursor)}));
    }
    if(req.url==='/api/people')return res.end(JSON.stringify({people:[{person_id:'worker-01',name:'测试人员',active:1,enrolled_at:'2026-10-22T01:00:00Z',embedding:'must-not-leak'}]}));
    if(req.url==='/api/enroll'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      state.enrolled=JSON.parse(Buffer.concat(chunks));
      return res.end(JSON.stringify({person_id:state.enrolled.person_id,name:state.enrolled.name,enrolled_at:'2026-10-22T01:00:00Z'}));
    }
    res.writeHead(404).end();
  });
  await new Promise(done=>upstream.listen(0,'127.0.0.1',done));
  const config={sourceId:'gpu-one',baseUrl:`http://127.0.0.1:${upstream.address().port}`,token,pollIntervalMs:60000,pageSize:137,maxPagesPerSync:3,...extra.configPatch};
  const app=express();app.use(express.json({limit:'8mb'}));
  const auth=(req,res,next)=>{if(!req.headers.cookie)return res.status(401).end();req.actor={id:'admin',name:'测试',role:req.headers.cookie==='admin'?'admin':'viewer'};next();};
  const module=mountCameraAttendance(app,{store,auth},{development:true,config,...extra});
  const server=createServer(app);await new Promise(done=>server.listen(0,'127.0.0.1',done));
  const call=(path,options={})=>fetch(`http://127.0.0.1:${server.address().port}/api/camera4g-attendance${path}`,{...options,headers:{cookie:'admin','content-type':'application/json',...(options.headers||{})}});
  t.after(async()=>{module.close();server.closeAllConnections();upstream.closeAllConnections();await Promise.all([new Promise(done=>server.close(done)),new Promise(done=>upstream.close(done))]);store.close();});
  return {store,module,call,state,seen,config,app,auth};
}

test('252 backfills 1001 GPU results without employee records, resumes after restart and does not replay audio',async t=>{
  const f=await fixture(t);await f.module.sync();
  let result=await(await f.call('/records?limit=500')).json();assert.equal(result.records.length,411);
  assert.equal(f.store.list('employees').length,0);assert.equal(f.store.list('attendance').length,0);
  f.module.close();const app=express(),restarted=mountCameraAttendance(app,{store:f.store,auth:f.auth},{development:true,config:f.config});t.after(()=>restarted.close());
  const server=createServer(app);await new Promise(done=>server.listen(0,'127.0.0.1',done));
  t.after(()=>new Promise(done=>{server.closeAllConnections();server.close(done);}));
  const call=path=>fetch(`http://127.0.0.1:${server.address().port}/api/camera4g-attendance${path}`,{headers:{cookie:'admin'}});
  await restarted.sync();await restarted.sync();await restarted.sync();
  result=await(await call('/records?limit=500')).json();assert.equal(result.records.length,500);assert.equal(result.has_more,true);
  const more=await(await call(`/records?after=${result.next_cursor}&limit=500`)).json();
  const last=await(await call(`/records?after=${more.next_cursor}&limit=500`)).json();
  assert.equal(result.records.length+more.records.length+last.records.length,1001);
  assert.ok(f.seen.every(r=>!r.url.includes('voice')&&!r.url.includes('broadcast')&&r.cookie===undefined));
  assert.equal((await(await call('/people')).json()).people[0].embedding,undefined);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM camera4g_attendance_records').get().n,1001);
});

test('voice updates and source test reset preserve historical mirror and are idempotent',async t=>{
  const f=await fixture(t);f.state.events=[event(1),{...event(1),sequence:2,kind:'voice_update',record:{...record(1),voice_status:'playback_confirmed'}},{...event(1),sequence:3,kind:'test_reset'}];
  await f.module.sync();await f.module.sync();
  const rows=(await(await f.call('/records')).json()).records;assert.equal(rows.length,1);assert.equal(rows[0].source_reset,true);assert.equal(rows[0].voice_status,'pending');
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM camera4g_attendance_events').get().n,3);
});

test('malformed pages roll back atomically; changed stream and cursor regression never skip records',async t=>{
  const f=await fixture(t);f.state.events=[event(1)];await f.module.sync();
  f.state.events=[event(1),event(2),{...event(3),record:{...record(3),person_id:null}}];
  await assert.rejects(f.module.sync());
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM camera4g_attendance_records').get().n,1);
  assert.equal((await(await f.call('/status')).json()).cursor,1);
  f.state.stream='other';await assert.rejects(f.module.sync());assert.equal((await(await f.call('/status')).json()).cursor,1);
});

test('enrollment through 252 needs no employee mapping; only GPU receives photo and owns voice preparation',async t=>{
  const f=await fixture(t);
  const request={person_id:'worker-01',name:'测试人员',photo_base64:Buffer.from('synthetic-photo').toString('base64')};
  const r=await f.call('/people/enroll',{method:'POST',body:JSON.stringify(request)});assert.equal(r.status,200);assert.equal((await r.json()).person_id,'worker-01');assert.deepEqual(f.state.enrolled,request);
  assert.equal(f.store.list('employees').length,0);
  const stored=JSON.stringify((await(await f.call('/people')).json()));assert.ok(!stored.includes(request.photo_base64));
  assert.ok(!stored.includes(f.config.token));
});

test('login/admin checks cover reads and enrollment; unconfigured and unknown endpoints fail safely',async t=>{
  const f=await fixture(t);
  for(const path of ['/status','/people','/records','/people/enroll','/sync']){
    const options=['/people/enroll','/sync'].includes(path)?{method:'POST',body:'{}'}:{};
    assert.equal((await f.call(path,{...options,headers:{cookie:''}})).status,401);
    assert.equal((await f.call(path,{...options,headers:{cookie:'viewer'}})).status,403);
  }
  assert.equal((await f.call('/records?limit=-1')).status,400);
  assert.equal((await f.call('/records?from=2026-02-30')).status,400);
  assert.equal((await f.call('/unknown')).status,404);
  const missing=await fixture(t,{config:{}});assert.equal((await missing.call('/status')).status,503);
});

test('GPU enrollment failure is not retried and cannot leak upstream data',async t=>{
  const f=await fixture(t);f.state.custom=(req,res)=>{if(req.url!=='/api/enroll')return false;res.writeHead(503).end(f.config.token);return true;};
  const r=await f.call('/people/enroll',{method:'POST',body:JSON.stringify({person_id:'worker-01',name:'测试人员',photo_base64:'YWJj'})});
  assert.equal(r.status,503);assert.ok(!(await r.text()).includes(f.config.token));assert.equal(f.seen.filter(r=>r.url==='/api/enroll').length,1);
});

test('explicit GPU photo rejection stays 422 and is not an unknown enrollment',async t=>{
  const f=await fixture(t);f.state.custom=(req,res)=>{if(req.url!=='/api/enroll')return false;res.writeHead(422).end(JSON.stringify({error:'face_count',message:f.config.token}));return true;};
  const r=await f.call('/people/enroll',{method:'POST',body:JSON.stringify({person_id:'worker-01',name:'测试人员',photo_base64:'YWJj'})});
  assert.equal(r.status,422);const body=await r.json();assert.equal(body.outcome,'rejected');assert.equal(body.error,'face_count');assert.ok(!JSON.stringify(body).includes(f.config.token));
});

test('malformed cursor response, oversized body and timeouts leave checkpoint unchanged',async t=>{
  const f=await fixture(t);
  f.state.events=[event(1)];await f.module.sync();
  f.state.custom=(req,res)=>{if(!req.url.startsWith('/api/attendance/changes'))return false;res.end(JSON.stringify({stream_id:'stream-1',events:[],next_cursor:0,has_more:false}));return true;};
  await assert.rejects(f.module.sync());assert.equal((await(await f.call('/status')).json()).cursor,1);
  f.state.custom=null;f.state.events=[event(1),event(3)];
  await assert.rejects(f.module.sync());assert.equal((await(await f.call('/status')).json()).cursor,1);
  f.state.custom=(req,res)=>{res.end('x'.repeat(8*1024*1024+1));return true;};
  await assert.rejects(f.module.sync());assert.equal((await(await f.call('/status')).json()).cursor,1);
  const slow=await fixture(t,{configPatch:{requestTimeoutMs:100,enrollmentTimeoutMs:100}});
  slow.state.events=[event(1)];await slow.module.sync();slow.state.delay=500;
  await assert.rejects(slow.module.sync(),/attendance_timeout/);
  assert.equal((await(await slow.call('/status')).json()).cursor,1);
  const response=await slow.call('/people/enroll',{method:'POST',body:JSON.stringify({person_id:'worker-01',name:'测试人员',photo_base64:'YWJj'})});
  assert.equal(response.status,503);assert.equal((await response.json()).outcome,'unknown');
  assert.equal(slow.seen.filter(request=>request.url==='/api/enroll').length,1);
});

test('overlapping polls share one bounded sync, date filters work and shutdown cancels polling',async t=>{
  const f=await fixture(t);f.state.events=[event(1)];f.state.delay=60;
  await Promise.all([f.module.sync(),f.module.sync(),f.module.sync()]);
  assert.equal(f.seen.filter(r=>r.url.startsWith('/api/attendance/changes')).length,1);
  assert.equal((await(await f.call('/records?from=2026-10-23')).json()).records.length,0);
  assert.equal((await(await f.call('/records?person_id=worker-01&to=2026-10-22')).json()).records.length,1);
  const pending=f.module.sync();f.module.close();await assert.rejects(pending);
});

test('same-stream restored backup cannot reuse a sequence under the saved checkpoint',async t=>{
  const f=await fixture(t);f.state.events=[event(1),event(2),event(3)];await f.module.sync();
  f.state.events=[event(1),{...event(2),record:{...record(2),person_id:'other-after-restore'}},{...event(3),record:{...record(3),person_id:'other-after-restore'}},event(4)];
  await assert.rejects(f.module.sync());
  assert.equal((await(await f.call('/status')).json()).cursor,3);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM camera4g_attendance_records').get().n,3);
});
