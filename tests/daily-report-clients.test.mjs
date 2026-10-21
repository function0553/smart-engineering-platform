import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { newReport } from '../server/daily-report-weather.mjs';
import { submissionKey as webKey } from '../src/report-cloud.ts';

function wxSubmission(storage) {
  const module={exports:{}};
  new Script(readFileSync('miniprogram/utils/submission.js','utf8')).runInNewContext({module,wx:{getStorageSync:key=>storage.get(key),setStorageSync:(key,value)=>storage.set(key,value)}});
  return module.exports;
}

test('mini-program payload digest matches SHA-256 for unicode, block boundaries, and a photo-sized string',()=>{
  const {digest}=wxSubmission(new Map());
  for(const text of ['', 'abc', '日报照片🙂\ud800', 'a'.repeat(55), 'a'.repeat(56), 'b'.repeat(64), 'c'.repeat(1000), '照片'.repeat(500)+'A'.repeat(5*1024*1024)])
    assert.equal(digest(text),createHash('sha256').update(text).digest('hex'));
});

test('web and mini-program retry IDs survive reload, separate accounts/backends, and store no original photos',async()=>{
  const data={weather:'现场阴',photos:[{base64:'PHOTOBYTES',caption:'照片说明'}]},storage=new Map();
  const original=globalThis.localStorage;
  globalThis.localStorage={getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)};
  try {
    const id=await webKey('backend-a:author-a',data);
    assert.equal(await webKey('backend-a:author-a',structuredClone(data)),id);
    const fresh=await import('../src/report-cloud.ts?reload='+Date.now());
    assert.equal(await fresh.submissionKey('backend-a:author-a',data),id);
    assert.notEqual(await webKey('backend-a:author-b',data),id);
    assert.notEqual(await webKey('backend-b:author-a',data),id);
    assert.notEqual(await webKey('backend-a:author-a',{...data,weather:'现场雨'}),id);
    assert.ok([...storage.values()].every(value=>!value.includes('PHOTOBYTES') && !value.includes('照片说明')));
  } finally { if(original===undefined)delete globalThis.localStorage;else globalThis.localStorage=original; }
  const wxStorage=new Map(), first=wxSubmission(wxStorage), id=first.submissionKey('a',data);
  assert.equal(wxSubmission(wxStorage).submissionKey('a',structuredClone(data)),id);
  assert.notEqual(first.submissionKey('b',data),id);
  assert.notEqual(first.submissionKey('a',{...data,weather:'现场雨'}),id);
  assert.ok([...wxStorage.values()].every(value=>!JSON.stringify(value).includes('PHOTOBYTES')));
});

function miniReportRuntime(api) {
  const storage=new Map(),submissions=wxSubmission(storage), model={exports:{}};let page;
  new Script(readFileSync('miniprogram/utils/report.js','utf8')).runInNewContext({module:model});
  new Script(readFileSync('miniprogram/pages/report/index.js','utf8')).runInNewContext({
    Page:value=>page=value,require:path=>path.endsWith('/api')?api:path.endsWith('/submission')?submissions:path.endsWith('/draft')?{}:model.exports,
    wx:{pageScrollTo(){},openDocument(){},navigateTo(){}},setTimeout,clearTimeout
  });
  page.data=structuredClone(page.data);page.setData=patch=>Object.assign(page.data,patch);
  page.report=newReport('2026-10-07');page.report.weatherAuto=false;page.report.weather='阴';page.user={id:'author',role:'operator'};page.key='test:author';page.saveDraft=()=>{};
  return page;
}

test('mini-program submission receipt remains visible when Word download fails, and retry uses the same key',async()=>{
  const requests=[],id='07f2295d-48f9-4ddd-9256-b105d3aa94ce';let failDownload=true;
  const api={request:async(path,method,data)=>{requests.push({path,method,data});if(method==='POST')return {id,reportDate:'2026-10-07'};if(failDownload)throw new Error('模拟下载断网');return new ArrayBuffer(2);},saveWord:async()=>'/private/word.docx'};
  const page=miniReportRuntime(api);await page.generate();
  assert.equal(page.data.submittedId,id);assert.match(page.data.notice,/已提交到服务器/);assert.match(page.data.errors[0].message,/断网/);assert.equal(page.data.busy,false);
  failDownload=false;await page.generate();
  assert.equal(requests[0].data.submissionId,requests[2].data.submissionId);assert.match(page.data.notice,/Word 已保存/);
  const count=requests.length;page.user.role='viewer';await page.generate();assert.equal(requests.length,count);
});

test('mini-program history requests use authenticated endpoints and release temporary originals on exit',async()=>{
  let page;const paths=[],removed=[],requests=[];
  const detail={id:'07f2295d-48f9-4ddd-9256-b105d3aa94ce',data:{sections:newReport().sections},photos:[{index:0,mime:'image/png',caption:'测试照片'}]};
  const api={request:async path=>{requests.push(path);return path.endsWith('/photos/0')?new ArrayBuffer(3):detail;}};
  new Script(readFileSync('miniprogram/pages/history/index.js','utf8')).runInNewContext({Page:value=>page=value,require:()=>api,
    wx:{env:{USER_DATA_PATH:'/private'},pageScrollTo(){},getFileSystemManager:()=>({writeFile:o=>{paths.push(o.filePath);o.success();},unlink:o=>removed.push(o.filePath)})}});
  page.data=structuredClone(page.data);page.setData=patch=>Object.assign(page.data,patch);page.active=true;page.version=0;page.photoPaths=[];
  await page.openId(detail.id);assert.equal(page.data.detail.id,detail.id);assert.equal(paths.length,1);assert.ok(requests[1].startsWith('/daily-report/submissions/'+detail.id+'/photos/0'));
  page.onUnload();assert.deepEqual(removed,paths);
});
