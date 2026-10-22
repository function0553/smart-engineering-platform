import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync,rmSync } from 'node:fs';
import { dirname,join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { openStore } from '../server/store.mjs';
import { mountCameraAttendance } from '../server/camera4g-attendance.mjs';

test('actual Python GPU change API and Node 252 mirror agree on cursor digests and legacy backfill',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'camera4g-wire-'));
  const process=spawn(globalThis.process.env.CAMERA4G_TEST_PYTHON||'python',[fileURLToPath(new URL('./camera4g-python-fixture.py',import.meta.url)),directory],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...globalThis.process.env,PYTHONIOENCODING:'utf-8'}});
  const exited=once(process,'exit');
  t.after(async()=>{process.kill();await exited;assert.equal(dirname(resolve(directory)),resolve(tmpdir()));rmSync(directory,{recursive:true,force:true});});
  let diagnostics='';process.stderr.on('data',chunk=>{diagnostics+=chunk;});
  const port=await new Promise((done,fail)=>{
    const timer=setTimeout(()=>fail(Error('Python fixture startup timeout: '+diagnostics)),10000);
    let text='';process.stdout.on('data',chunk=>{text+=chunk;if(text.includes('\n')){clearTimeout(timer);try{done(JSON.parse(text.split('\n')[0]).port);}catch(error){fail(error);}}});
    process.once('error',error=>{clearTimeout(timer);fail(error);});process.once('exit',()=>{clearTimeout(timer);fail(Error(diagnostics));});
  });
  const store=openStore(':memory:'), app=express();
  const module=mountCameraAttendance(app,{store,auth:(_req,_res,next)=>next()},{development:true,config:{sourceId:'actual-python',baseUrl:`http://127.0.0.1:${port}`,token:'synthetic-integration-token-'.repeat(3),pageSize:17,maxPagesPerSync:3}});
  t.after(()=>{module.close();store.close();});
  for(let i=0;i<5;i++)await module.sync();
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM camera4g_attendance_records').get().n,201);
  assert.equal(store.db.prepare('SELECT cursor FROM camera4g_attendance_state').get().cursor,201);
  assert.equal(store.list('employees').length,0);
  await module.sync();
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM camera4g_attendance_events').get().n,201);
});
