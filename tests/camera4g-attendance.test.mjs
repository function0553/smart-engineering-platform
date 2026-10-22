import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { openStore } from '../server/store.mjs';
import { mountCameraAttendance } from '../server/camera4g-attendance.mjs';

const record = id => ({ attendance_id:`a-${id}`,person_id:'worker-01',name:'测试人员',business_date:'2026-10-22',occurred_at:'2026-10-22T02:00:00+00:00',camera_id:'camera-02',similarity:.9,voice_status:'pending',liveness_status:'passed',attendance_status:'on_time',late_seconds:0 });
const event = n => ({ sequence:n,kind:'checkin',attendance_id:`a-${n}`,record:record(n) });
async function fixture(t, extra={}) {
  const store=openStore(':memory:'), token='synthetic-token-'.repeat(4), seen=[], events=Array.from({length:1001},(_,i)=>event(i+1));
  const state={stream:'stream-1', events, broken:false, offline:false, enrolled:null, delay:0, custom:null};
  const upstream=createServer(async(req,res)=>{
    seen.push({url:req.url,auth:req.headers.authorization,cookie:req.headers.cookie});
    if(req.headers.authorization!==`Bearer ${token}`)return res.writeHead(401).end();
    if(state.delay)await new Promise(done=>setTimeout(done,state.delay));
    if(state.offline)return res.writeHead(503).end('private upstream error');
    res.setHeader('Content-Type','application/json');
    if(state.custom?.(req,res))return;
    if(req.url.startsWith('/api/attendance/changes')) {
      const url=new URL(req.url,'http://fixture'),after=Number(url.searchParams.get('after')),limit=Number(url.searchParams.get('limit'));
      const rows=state.events.filter(e=>e.sequence>after).slice(0,limit),cursor=rows.at(-1)?.sequence??after;
      return res.end(JSON.stringify({stream_id:state.stream,events:state.broken?[event(0)]:rows,next_cursor:cursor,has_more:state.events.some(e=>e.sequence>cursor)}));
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
  const config={sourceId:'gpu-one',baseUrl:`http://127.0.0.1:${upstream.address().port}`,token,pollIntervalMs:60000,pageSize:137,maxPagesPerSync:3};
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
