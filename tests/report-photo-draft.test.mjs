import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Script} from 'node:vm';
import {newReport} from '../server/daily-report-weather.mjs';

// Simulated WeChat file/storage APIs; this is not WeChat device acceptance.
function runtime() {
 const files=new Map(),storage=new Map();let writes=0,failFile=false,failIndex=false;
 const fs={readFileSync:(p,encoding)=>{if(!files.has(p))throw new Error('missing');return files.get(p).toString(encoding);},writeFileSync:(p,data,encoding)=>{if(failFile)throw new Error('disk');files.set(p,Buffer.from(data,encoding));writes++;},unlinkSync:p=>files.delete(p)};
 const wx={env:{USER_DATA_PATH:'/private'},getFileSystemManager:()=>fs,getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>{if(failIndex)throw new Error('quota');storage.set(k,structuredClone(v));}};
 const modelModule={exports:{}};new Script(readFileSync('miniprogram/utils/report.js','utf8')).runInNewContext({module:modelModule});
 const module={exports:{}};new Script(readFileSync('miniprogram/utils/draft.js','utf8')).runInNewContext({module,wx,require:()=>modelModule.exports});
 return {files,storage,create:module.exports.createDraftStorage,model:modelModule.exports,writes:()=>writes,setFileFailure:v=>{failFile=v;},setIndexFailure:v=>{failIndex=v;}};
}
function reportWithPhoto() {const report=newReport('2026-10-08');report.weatherAuto=false;report.weather='现场小雨';report.number='草稿-1';report.photos=[{name:'test.png',caption:'原图说明',mime:'image/png',base64:readFileSync('tests/assets/daily-report-qa.png').toString('base64'),width:320,height:180}];return report;}
test('mini-program draft restores original pixels and captions, and caption edits do not rewrite image files',()=>{
 const io=runtime(),key=io.model.draftKey('https://site.example','user-a'),draft=io.create(key),report=reportWithPhoto();
 const paths=draft.save(report);assert.equal(io.writes(),1);assert.deepEqual(io.files.get(paths[0]),readFileSync('tests/assets/daily-report-qa.png'));
 const reopened=io.create(key).load();assert.deepEqual(JSON.parse(JSON.stringify(reopened.report)),report);assert.equal(reopened.paths[0],paths[0]);
 report.photos[0].caption='修改说明';draft.save(report);assert.equal(io.writes(),1);assert.equal(io.create(key).load().report.photos[0].caption,'修改说明');
});
test('mini-program draft image/file and index failures preserve the prior committed draft without leaking temporary files',()=>{
 const io=runtime(),key='draft-a',draft=io.create(key),report=reportWithPhoto();draft.save(report);const before=structuredClone(io.storage.get(key)),count=io.files.size;
 report.photos.push({...report.photos[0],base64:Buffer.from('different-pixels').toString('base64')});
 io.setFileFailure(true);assert.throws(()=>draft.save(report));assert.deepEqual(io.storage.get(key),before);assert.equal(io.files.size,count);
 io.setFileFailure(false);io.setIndexFailure(true);assert.throws(()=>draft.save(report));assert.deepEqual(io.storage.get(key),before);assert.equal(io.files.size,count);
 assert.equal(io.create(key).load().report.photos.length,1);
});
test('mini-program drafts separate backend/user scopes and reject another scope or unsafe image paths',()=>{
 const io=runtime(),key=io.model.draftKey('https://site.example','user-a');io.create(key).save(reportWithPhoto());
 assert.equal(io.create(io.model.draftKey('https://site.example','user-b')).load(),null);assert.equal(io.create(io.model.draftKey('https://other.example','user-a')).load(),null);
 io.storage.set('foreign',structuredClone(io.storage.get(key)));assert.throws(()=>io.create('foreign').load());
 const unsafe=structuredClone(io.storage.get(key));unsafe._photoDraft.photos[0].file='../other.png';io.storage.set(key,unsafe);assert.throws(()=>io.create(key).load());
});
test('mini-program draft removal commits the new index before removing only its own photo files; legacy text remains readable',()=>{
 const io=runtime(),draft=io.create('draft-a'),report=reportWithPhoto();const [path]=draft.save(report);io.files.set('/private/unrelated.png',Buffer.from('keep'));
 report.photos=[];draft.save(report);assert.ok(!io.files.has(path));assert.ok(io.files.has('/private/unrelated.png'));assert.equal(io.create('draft-a').load().report.photos.length,0);
 io.storage.set('legacy',io.model.textDraft(reportWithPhoto()));assert.equal(io.create('legacy').load().report.weather,'现场小雨');assert.equal(io.create('legacy').load().report.photos.length,0);
});
