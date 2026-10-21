import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { createApp } from '../server/app.mjs';
import { createWeatherService, newReport, shanghaiDate } from '../server/daily-report-weather.mjs';
import { referenceReport } from './daily-report-fixture.mjs';

const now=()=>new Date('2026-10-07T04:00:00Z');
const query={date:'2026-10-07',latitude:26.51,longitude:106.68};
const payload=(date,code=2)=>({daily:{time:[date],weather_code:[code],temperature_2m_min:[null],temperature_2m_max:[23.74]}});
test('weather uses Shanghai date, correct forecast/archive endpoint, deduplication and no fabricated missing temperature', async()=>{
  assert.equal(shanghaiDate(new Date('2026-10-06T17:00:00Z')),'2026-10-07');
  const calls=[];
  const service=createWeatherService({now,fetcher:async url=>{calls.push(url);await new Promise(r=>setTimeout(r,5));return {ok:true,json:async()=>payload(url.searchParams.get('start_date'))};}});
  const [first,second]=await Promise.all([service(query),service(query)]);assert.deepEqual(first,second);assert.equal(calls.length,1);
  assert.equal(first.condition,'多云');assert.equal(first.temperatureMin,null);assert.equal(first.temperatureMax,23.7);assert.equal(first.kind,'forecast');
  await service(query);assert.equal(calls.length,1);
  await service({...query,date:'2026-09-29'});assert.equal(calls[1].hostname,'archive-api.open-meteo.com');
  const recent=await service({...query,date:'2026-10-06'});assert.equal(recent.kind,'recent-history');assert.equal(calls[2].hostname,'api.open-meteo.com');
  assert.equal(calls[2].searchParams.get('timezone'),'Asia/Shanghai');
  await assert.rejects(service({...query,date:'2026-10-23'}),e=>e.status===400);
  const template=newReport('2026-10-07');assert.equal(template.weather,'');assert.equal(template.weatherAuto,true);assert.equal(template.sections[0].todayProgress,'');
});
test('weather errors never become clear weather and paid credentials only go to the fixed provider', async()=>{
  for(const body of [payload(query.date,null),payload('2026-10-08'),payload(query.date,100)]) {
    const service=createWeatherService({now,fetcher:async()=>({ok:true,json:async()=>body})});await assert.rejects(service(query),e=>e.status===503);
  }
  const service=createWeatherService({now,apiKey:'test-only-provider-key',fetcher:async url=>{assert.equal(url.hostname,'customer-archive-api.open-meteo.com');assert.equal(url.searchParams.get('apikey'),'test-only-provider-key');throw new Error('private query must not leak');}});
  await assert.rejects(service({...query,date:'2026-09-29'}),e=>!e.message.includes('private')&&!e.message.includes('provider-key'));
});
test('mobile bearer sessions are scoped, expire, enforce writer role, and export rechecks automatic weather on the server',async t=>{
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const baseUrl=`http://127.0.0.1:${server.address().port}`;
  let weatherCalls=0;
  const weatherService=async q=>{weatherCalls++;return {...q,condition:'阴',source:'Open-Meteo',sourceUrl:'https://open-meteo.com/',kind:'forecast',fetchedAt:now().toISOString(),temperatureMin:11,temperatureMax:23};};
  const {app,store,vision}=createApp({database:':memory:',baseUrl,distPath:'__no_dist__',weatherService});server.on('request',app);
  t.after(async()=>{vision?.close?.();await new Promise(r=>server.close(r));store.close();});
  const post=(path,data={},headers={})=>fetch(baseUrl+'/api'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Workspace-Request':'1',...headers},body:JSON.stringify(data)});
  const get=(path,headers={})=>fetch(baseUrl+'/api'+path,{headers});
  const credentials={username:'weather-admin',password:'test-only-weather-57284'};
  const setup=await post('/setup',{...credentials,name:'天气测试',organization:'隔离测试'});assert.equal(setup.status,201);const cookie=setup.headers.get('set-cookie').split(';')[0];
  assert.equal((await get('/mobile/me',{Cookie:cookie})).status,401);
  const login=await post('/mobile/login',credentials);assert.equal(login.status,200);assert.equal(login.headers.get('set-cookie'),null);const {token,expiresAt}=await login.json();assert.ok(expiresAt>Date.now());
  const bearer={Authorization:'Bearer '+token};
  assert.equal((await get('/mobile/me',bearer)).status,200);assert.equal((await get('/me',bearer)).status,401);
  const hash='mobile:'+createHash('sha256').update(token).digest('hex');assert.ok(store.db.prepare('SELECT hash FROM sessions WHERE hash=?').get(hash));assert.equal(store.db.prepare('SELECT hash FROM sessions WHERE hash=?').get(token),undefined);
  assert.equal((await get('/me',{Cookie:'workspace_session='+token})).status,401);
  assert.equal((await post('/mobile/daily-report/export',referenceReport(),{...bearer,'X-Workspace-Request':''})).status,403);
  assert.equal((await post('/mobile/login',credentials,{Origin:'https://unknown.example'})).status,403);
  const wxLogin=await post('/mobile/login',credentials,{Origin:'https://servicewechat.com'});assert.equal(wxLogin.status,200);
  assert.equal((await get('/mobile/daily-report/weather?date=2026-02-30&latitude=26&longitude=106',bearer)).status,400);
  assert.equal((await get('/mobile/daily-report/weather?date=2026-10-07&latitude=&longitude=106',bearer)).status,400);
  const info=await (await get('/mobile/daily-report/weather?date=2026-10-07&latitude=26.51&longitude=106.68',bearer)).json();assert.equal(info.condition,'阴');
  const report=referenceReport();report.weatherAuto=true;report.weatherLocation={name:'测试地点',latitude:26.51,longitude:106.68};report.weatherInfo={...info,condition:'晴'};report.weather='晴';
  const output=await post('/mobile/daily-report/export',report,bearer);assert.equal(output.status,200);assert.match(strFromU8(unzipSync(new Uint8Array(await output.arrayBuffer()))['word/document.xml']),/>阴</);assert.equal(weatherCalls,2);
  report.reportDate='2026-10-08';assert.equal((await post('/mobile/daily-report/export',report,bearer)).status,400);
  assert.equal((await post('/mobile/daily-report/export',referenceReport(),bearer)).status,200);
  await post('/users',{username:'weather-reader',name:'只读',password:credentials.password,role:'viewer'},{Cookie:cookie});
  const reader=await (await post('/mobile/login',{username:'weather-reader',password:credentials.password})).json();assert.equal((await post('/mobile/daily-report/export',referenceReport(),{Authorization:'Bearer '+reader.token})).status,403);
  store.db.prepare('UPDATE sessions SET expires_at=? WHERE hash=?').run(Date.now()-1,hash);assert.equal((await get('/mobile/me',bearer)).status,401);
  const renewed=await (await post('/mobile/login',credentials)).json();await post('/mobile/logout',{}, {Authorization:'Bearer '+renewed.token});assert.equal((await get('/mobile/me',{Authorization:'Bearer '+renewed.token})).status,401);
  assert.equal((await get('/me',{Cookie:cookie})).status,200);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM records').get().n,0);
});
