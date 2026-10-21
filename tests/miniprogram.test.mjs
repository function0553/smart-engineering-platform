import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { newReport } from '../server/daily-report-weather.mjs';
function apiRuntime(wx) {const module={exports:{}};new Script(readFileSync('miniprogram/utils/api.js','utf8')).runInNewContext({wx,module,require:()=>({defaultBaseUrl:'http://127.0.0.1:5186'}),Uint8Array,Date,decodeURIComponent,Promise,Error});return module.exports;}
test('miniprogram mobile requests preserve binary Word errors, scope sessions to backend and reject release HTTP',async()=>{
  const storage=new Map();let options;
  const wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),removeStorageSync:k=>storage.delete(k),request:o=>{options=o;},getAccountInfoSync:()=>({miniProgram:{envVersion:'develop'}})};
  const api=apiRuntime(wx);api.setSession({token:'test-token',expiresAt:Date.now()+10000});
  const request=api.request('/daily-report/export','POST',{weather:'阴'},true);assert.equal(options.header.Authorization,'Bearer test-token');assert.equal(options.responseType,'arraybuffer');
  const bytes=Buffer.from(JSON.stringify({error:'日期不匹配',fields:[{path:'weather',message:'请刷新天气'}]}));options.success({statusCode:400,data:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)});await assert.rejects(request,e=>e.message==='日期不匹配'&&e.fields[0].path==='weather');
  api.setBaseUrl('https://other.example');assert.equal(api.session(),null);
  wx.getAccountInfoSync=()=>({miniProgram:{envVersion:'release'}});assert.throws(()=>api.setBaseUrl('http://127.0.0.1:5186'),/HTTPS/);
});
function pageRuntime() {
  let page,complete;const api={request:()=>new Promise(r=>{complete=r;})},modelModule={exports:{}};
  new Script(readFileSync('miniprogram/utils/report.js','utf8')).runInNewContext({module:modelModule,Number,JSON});
  new Script(readFileSync('miniprogram/pages/report/index.js','utf8')).runInNewContext({Page:p=>page=p,require:p=>p.includes('/api')?api:modelModule.exports,wx:{setStorageSync(){},pageScrollTo(){}},setTimeout,clearTimeout,Number,Date,JSON});
  page.data=structuredClone(page.data);page.setData=p=>Object.assign(page.data,p);page.template=newReport('2026-10-07');page.report=newReport('2026-10-07');page.user={role:'operator'};page.photoPaths=[];page.weatherVersion=0;return {page,model:modelModule.exports,complete:v=>complete(v)};
}
test('miniprogram manual weather wins over an in-flight result, read-only actions are inert, and invalid imported photos fail early',async()=>{
  const {page,complete,model}=pageRuntime();const pending=page.fetchWeather();assert.equal(page.data.weatherLoading,true);
  page.input({currentTarget:{dataset:{scope:'base',key:'weather'}},detail:{value:'现场小雨'}});complete({condition:'晴'});await pending;assert.equal(page.report.weather,'现场小雨');assert.equal(page.report.weatherAuto,false);assert.equal(page.data.weatherLoading,false);
  clearTimeout(page.saveTimer);page.user.role='viewer';const before=JSON.stringify(page.report);page.addSection();page.removeWork({currentTarget:{dataset:{index:0}}});page.changeDate({detail:{value:'2026-10-08'}});assert.equal(JSON.stringify(page.report),before);
  const invalid=newReport();invalid.photos=[{base64:'bad'}];assert.equal(model.checkReport(invalid),false);
  const wxml=readFileSync('miniprogram/pages/report/index.wxml','utf8');for(const binding of wxml.matchAll(/wx:(?:if|elif|for)="([^"]+)"/g))assert.ok(binding[1].startsWith('{{'));
  const config=JSON.parse(readFileSync('miniprogram/project.config.json','utf8'));assert.equal(config.appid,'touristappid');assert.equal(config.setting.urlCheck,true);
});
