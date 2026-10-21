import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {createApp} from '../server/app.mjs';

// HTTP integration scenarios use only synthetic users and a disposable local database.
const ok=(response,status=200)=>assert.equal(response.status,status,JSON.stringify(response.body));
async function fixture(t,persistent=false){
  const dir=persistent?mkdtempSync(join(tmpdir(),'engineering-commerce-')):null;
  let server,state,url;
  async function start(){
    server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+server.address().port;
    state=createApp({database:dir?join(dir,'test.sqlite'):':memory:',baseUrl:url,distPath:'__none__'});server.on('request',state.app);
  }
  async function stop(){state.vision.close();server.closeAllConnections();await new Promise(r=>server.close(r));state.store.close();}
  await start();t.after(async()=>{await stop();if(dir){assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));assert.ok(dir.includes('engineering-commerce-'));rmSync(dir,{recursive:true,force:true});}});
  const call=async(path,body,cookie='',method=body===undefined?'GET':'POST',headers={})=>{
    const r=await fetch(url+'/api'+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json','X-Workspace-Request':'1',...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
    const text=await r.text();let parsed;try{parsed=JSON.parse(text);}catch{parsed={raw:text};}
    return {status:r.status,body:parsed,cookie:r.headers.get('set-cookie')?.split(';')[0]};
  };
  const password='isolated-commerce-test-only-123';
  const setup=await call('/setup',{organization:'经营闭环隔离验证',username:'qa-admin',name:'测试管理员',password});ok(setup,201);const admin=setup.cookie;
  const users={};
  for(const name of ['author','reviewer','finance','engineer','outsider']){
    ok(await call('/users',{username:'qa-'+name,name,role:'operator',password},admin),201);
    const list=(await call('/users',undefined,admin)).body;
    users[name]={id:list.find(u=>u.name===name).id,cookie:(await call('/login',{username:'qa-'+name,password})).cookie};
  }
  const post=(path,body,cookie=admin,method='POST')=>call('/engineering'+path,{requestId:randomUUID(),...body},cookie,method);
  const projectData={code:randomUUID().slice(0,8),name:'变更计量合成工程',address:'本机隔离测试',owner:'测试负责人',startDate:'2026-10-01',dueDate:'2026-12-31',budget:1000000,note:'合成数据'};
  const created=await post('/projects',{data:projectData});ok(created,201);const pid=created.body.id,pb='/projects/'+pid;
  ok(await post(pb+'/state',{version:1,state:'active',note:'合成项目开工'}));
  for(const [name,role] of [['author','manager'],['reviewer','manager'],['finance','finance'],['engineer','engineer']])ok(await post(pb+'/members',{userId:users[name].id,role},admin,'PUT'));
  const detail=async(cookie=admin)=>{const r=await call('/engineering'+pb,undefined,cookie);ok(r);return r.body;};
  const row=async iid=>(await detail()).items.find(r=>r.id===(typeof iid==='string'?iid:iid.id));
  const item=async(kind,data,cookie=users.author.cookie)=>{const r=await post(pb+'/items/'+kind,{data},cookie);ok(r,201);return row(r.body.id);};
  const transition=async(item,state,cookie=admin)=>{const r=await row(item);return post(pb+'/items/'+r.id+'/state',{version:r.version,state,note:'合成审批依据'},cookie);};
  const approve=async item=>{ok(await transition(item,'submitted',users.author.cookie));ok(await transition(item,'approved'));return row(item);};
  const edit=async(item,data,cookie=users.author.cookie)=>{const r=await row(item);return post(pb+'/items/'+r.id,{version:r.version,data},cookie,'PUT');};
  const cancel=async item=>{if((await row(item)).state==='submitted')ok(await transition(item,'draft'));ok(await transition(item,'cancelled',users.author.cookie));};
  return {call,post,admin,users,password,pid,pb,projectData,detail,row,item,transition,approve,edit,cancel,get store(){return state.store;},restart:async()=>{await stop();await start();}};
}
const contract=(extra={})=>({title:'合成施工合同',code:randomUUID(),counterparty:'测试相对方',direction:'expense',amount:10000,dueDate:'2026-12-31',note:'仅合成合同依据',...extra});
const variation=(contractId,extra={})=>({title:'新增检查井签证',code:randomUUID(),contractId,changeType:'increase',amount:1000,occurredDate:'2026-10-11',note:'合成现场签证依据',...extra});
const line=(extra={})=>({name:'沟槽土方',location:'测试桩号',unit:'立方米',quantity:1000,unitPrice:1000,note:'合成实测工程量',...extra});
const measurement=(contractId,amount=1000,extra={})=>({title:'第一期工程量计量',code:randomUUID(),contractId,periodStart:'2026-10-01',periodEnd:'2026-10-10',lines:[line({unitPrice:amount})],note:'合成计量验收依据',...extra});
const settlement=(contractId,amount,measurementId='',extra={})=>({title:'本期结算',contractId,measurementId,amount,dueDate:'2026-10-25',note:'合成分期结算依据',...extra});
const cost=(settlementId,amount,direction='expense')=>({title:'合成收支',direction,category:'subcontract',settlementId,amount,occurredDate:'2026-10-11',voucher:randomUUID(),note:'合成凭证'});
const approvedContract=async(f,extra={})=>f.approve(await f.item('contracts',contract(extra)));

test('measurement derives line totals with exact half-up cent rounding and does not double-count settlement',async t=>{
  const f=await fixture(t),c=await approvedContract(f);
  const m=await f.item('measurements',measurement(c.id,1000,{lines:[line({quantity:1500,unitPrice:101}),line({quantity:500,unitPrice:101}),line({quantity:100,unitPrice:5})]}));
  assert.deepEqual(m.data.lines.map(r=>r.amount),[152,51,1]);assert.equal(m.data.amount,204);
  assert.equal((await f.row(c)).commercial.measurementAmount,0);
  await f.approve(m);await f.approve(await f.item('settlements',settlement(c.id,100,m.id)));
  const cv=(await f.row(c)).commercial,mv=(await f.row(m)).commercial;
  assert.equal(cv.measurementAmount,204);assert.equal(cv.settlementAmount,100);assert.equal(cv.unmeasuredSettlementAmount,0);assert.equal(cv.committedAmount,204);assert.equal(cv.remainingMeasurementAmount,9796);
  assert.deepEqual(mv,{measuredAmount:204,settledAmount:100,remainingSettlementAmount:104});
});

test('measurement rejects forged derived totals, invalid dates, empty or excessive lines and out-of-range quantities',async t=>{
  const f=await fixture(t),c=await approvedContract(f),valid=measurement(c.id);
  const invalid=[
    {...valid,amount:1},{...valid,lines:[{...line(),amount:1}]},{...valid,lines:[]},{...valid,lines:Array.from({length:51},()=>line())},
    {...valid,periodStart:'2026-10-12',periodEnd:'2026-10-11'},{...valid,periodStart:'2026-02-30'},
    ...[0,-1,0.5,1000000001].map(quantity=>({...valid,lines:[line({quantity})]})),
    ...[0,-1,0.5,1000000000001].map(unitPrice=>({...valid,lines:[line({unitPrice})]})),
    {...valid,lines:[line({quantity:1,unitPrice:1})]},
    {...valid,lines:[line({quantity:1000000000,unitPrice:1000000000000})]},
    {...valid,lines:[line({quantity:1000,unitPrice:600000000000}),line({quantity:1000,unitPrice:600000000000})]},
    {...valid,lines:[{...line(),unknown:true}]},
    ...[{name:''},{location:' '},{unit:'米'.repeat(31)},{name:'量'.repeat(201)},{location:'段'.repeat(201)},{note:'注'.repeat(501)}].map(extra=>({...valid,lines:[line(extra)]})),
  ];
  for(const data of invalid)ok(await f.post(f.pb+'/items/measurements',{data},f.users.author.cookie),400);
  for(const extra of [{amount:0},{amount:-1},{amount:1.5},{changeType:'replace'},{occurredDate:'2026-02-30'}])ok(await f.post(f.pb+'/items/variations',{data:variation(c.id,extra)},f.users.author.cookie),400);
  assert.equal((await f.detail()).items.filter(r=>['variations','measurements'].includes(r.kind)).length,0);
  const maxLines=await f.item('measurements',measurement(c.id,1000,{lines:Array.from({length:50},()=>line({unitPrice:1}))}));assert.equal(maxLines.data.amount,50);
  const zeroLine=line({quantity:1,unitPrice:1});delete zeroLine.note;
  const partlyRounded=await f.item('measurements',measurement(c.id,1000,{lines:[zeroLine,line({quantity:1000,unitPrice:1})]}));assert.deepEqual(partlyRounded.data.lines.map(r=>r.amount),[0,1]);assert.equal(partlyRounded.data.amount,1);assert.equal(partlyRounded.data.lines[0].note,'');
});

test('commerce references require an approved contract, the same project and the same contract for measurement settlement',async t=>{
  const f=await fixture(t),draft=await f.item('contracts',contract());
  for(const [kind,data] of [['variations',variation(draft.id)],['measurements',measurement(draft.id)]])ok(await f.post(f.pb+'/items/'+kind,{data},f.users.author.cookie),409);
  const c=await approvedContract(f),other=await approvedContract(f),m=await f.item('measurements',measurement(c.id));
  ok(await f.post(f.pb+'/items/settlements',{data:settlement(c.id,100,m.id)},f.users.author.cookie),409);
  await f.approve(m);
  ok(await f.post(f.pb+'/items/settlements',{data:settlement(other.id,100,m.id)},f.users.author.cookie),409);
  const pr=await f.post('/projects',{data:{...f.projectData,code:randomUUID()}});ok(pr,201);const otherBase='/projects/'+pr.body.id;
  ok(await f.post(otherBase+'/state',{version:1,state:'active',note:'合成另一个项目'}));
  for(const [kind,data] of [['variations',variation(c.id)],['measurements',measurement(c.id)],['settlements',settlement(c.id,100,m.id)]])ok(await f.post(otherBase+'/items/'+kind,{data}),400);
  const duplicate=measurement(c.id,100,{code:m.data.code.toUpperCase()});ok(await f.post(f.pb+'/items/measurements',{data:duplicate},f.users.author.cookie),409);
});

test('variations and measurements enforce independent approval including attachment editors and lock approved evidence',async t=>{
  const f=await fixture(t),c=await approvedContract(f);
  for(const [kind,data] of [['variations',variation(c.id)],['measurements',measurement(c.id)]]){
    const r=await f.item(kind,data),path=f.pb+'/items/'+r.id;
    const uploaded=await f.post(path+'/attachments',{version:1,name:'签证依据.pdf',caption:'合成原件',base64:Buffer.from('%PDF-1.7\nsynthetic\n%%EOF').toString('base64')});ok(uploaded,201);
    ok(await f.post(path+'/state',{version:1,state:'submitted',note:'过期版本'},f.users.author.cookie),409);
    ok(await f.transition(r,'submitted',f.users.author.cookie));
    ok(await f.transition(r,'approved',f.users.author.cookie),409);ok(await f.transition(r,'approved'),409);ok(await f.transition(r,'approved',f.users.finance.cookie),403);
    ok(await f.transition(r,'approved',f.users.reviewer.cookie));
    ok(await f.edit(r,data),409);
    const current=await f.row(r);ok(await f.post(path+'/attachments',{version:current.version,name:'变造.pdf',caption:'已批准后不能补改',base64:Buffer.from('%PDF-1.7\nx\n%%EOF').toString('base64')}),409);
    assert.equal((await f.call('/engineering'+path+'/attachments',undefined,f.admin)).body.writable,false);
  }
});

test('approved increases and decreases compute an effective contract without rewriting the signed original',async t=>{
  const f=await fixture(t),c=await approvedContract(f),original={...f.store.db.prepare('SELECT * FROM engineering_items WHERE id=?').get(c.id)};
  const add=await f.item('variations',variation(c.id,{amount:2000}));
  assert.equal((await f.row(c)).commercial.effectiveAmount,10000);await f.approve(add);
  const reduce=await f.item('variations',variation(c.id,{changeType:'decrease',amount:1000}));await f.approve(reduce);
  const ignored=await f.item('variations',variation(c.id,{amount:999}));await f.cancel(ignored);
  const view=await f.row(c);assert.equal(view.data.amount,10000);assert.equal(view.commercial.originalAmount,10000);assert.equal(view.commercial.changeAmount,1000);assert.equal(view.commercial.effectiveAmount,11000);
  assert.deepEqual({...f.store.db.prepare('SELECT * FROM engineering_items WHERE id=?').get(c.id)},original);
  assert.equal((await f.detail()).history.filter(h=>h.kind==='variations'&&h.action==='approved').length,2);
});

test('decrease approval rechecks measurement and legacy settlement commitments created after its draft',async t=>{
  const f=await fixture(t),c=await approvedContract(f),decrease=await f.item('variations',variation(c.id,{changeType:'decrease',amount:2500}));
  ok(await f.transition(decrease,'submitted',f.users.author.cookie));
  await f.approve(await f.item('measurements',measurement(c.id,7000)));
  await f.approve(await f.item('settlements',settlement(c.id,1000)));
  ok(await f.transition(decrease,'approved'),409);assert.equal((await f.row(c)).commercial.effectiveAmount,10000);assert.equal((await f.row(decrease)).state,'submitted');
  ok(await f.transition(decrease,'draft'));ok(await f.edit(decrease,variation(c.id,{code:decrease.data.code,changeType:'decrease',amount:2000})));await f.approve(decrease);
  const cv=(await f.row(c)).commercial;assert.equal(cv.effectiveAmount,8000);assert.equal(cv.committedAmount,8000);assert.equal(cv.remainingMeasurementAmount,0);
  const below=await f.item('variations',variation(c.id,{changeType:'decrease',amount:1}));ok(await f.transition(below,'submitted',f.users.author.cookie));ok(await f.transition(below,'approved'),409);
});

test('variations respect effective contract bounds and concurrent approvals cannot over-reduce it',async t=>{
  const f=await fixture(t),c=await approvedContract(f);
  const negative=await f.item('variations',variation(c.id,{changeType:'decrease',amount:10001}));ok(await f.transition(negative,'submitted',f.users.author.cookie));ok(await f.transition(negative,'approved'),409);await f.cancel(negative);
  const first=await f.item('variations',variation(c.id,{changeType:'decrease',amount:6000})),second=await f.item('variations',variation(c.id,{changeType:'decrease',amount:6000}));
  for(const r of [first,second])ok(await f.transition(r,'submitted',f.users.author.cookie));
  const responses=await Promise.all([first,second].map(r=>f.post(f.pb+'/items/'+r.id+'/state',{version:2,state:'approved',note:'并行调减合成测试'})));
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);assert.equal((await f.row(c)).commercial.effectiveAmount,4000);
  for(const r of [first,second])if((await f.row(r)).state==='submitted')await f.cancel(r);
  const zero=await f.item('variations',variation(c.id,{changeType:'decrease',amount:4000}));await f.approve(zero);assert.equal((await f.row(c)).commercial.effectiveAmount,0);ok(await f.transition(c,'closed'));
  const maximum=await approvedContract(f,{amount:1000000000000}),tooLarge=await f.item('variations',variation(maximum.id,{amount:1}));ok(await f.transition(tooLarge,'submitted',f.users.author.cookie));ok(await f.transition(tooLarge,'approved'),409);assert.equal((await f.row(maximum)).commercial.effectiveAmount,1000000000000);
});

test('procurement uses effective contract limits and its commitment overlaps rather than adds to measured value',async t=>{
  const f=await fixture(t),c=await approvedContract(f);
  const material=await f.item('materials',{title:'合成材料',code:randomUUID(),specification:'测试规格',unit:'吨',warehouse:'测试仓',note:''});
  const purchaseData={title:'合成采购',supplier:'测试供应商',materialId:material.id,quantity:1000,unitPrice:11000,contractId:c.id,dueDate:'2026-10-20',note:'合成采购依据'};
  const p=await f.item('purchases',purchaseData);ok(await f.transition(p,'submitted',f.users.author.cookie));ok(await f.transition(p,'approved'),409);
  await f.approve(await f.item('variations',variation(c.id,{amount:2000})));ok(await f.transition(p,'approved'));
  await f.approve(await f.item('measurements',measurement(c.id,8000)));await f.approve(await f.item('settlements',settlement(c.id,1000)));
  const cv=(await f.row(c)).commercial;assert.equal(cv.purchaseAmount,11000);assert.equal(cv.measurementAmount,8000);assert.equal(cv.unmeasuredSettlementAmount,1000);assert.equal(cv.committedAmount,11000);
  await f.approve(await f.item('variations',variation(c.id,{changeType:'decrease',amount:1000})));
  const tooFar=await f.item('variations',variation(c.id,{changeType:'decrease',amount:1}));ok(await f.transition(tooFar,'submitted',f.users.author.cookie));ok(await f.transition(tooFar,'approved'),409);
});

test('legacy unlinked settlements remain readable and reserve contract capacity in both approval orders',async t=>{
  const f=await fixture(t),c=await approvedContract(f);
  const legacyData=settlement(c.id,2000);delete legacyData.measurementId;const legacy=await f.item('settlements',legacyData);await f.approve(legacy);
  // Simulate the persisted JSON shape from before measurement linking existed.
  const persisted={...legacy.data};delete persisted.measurementId;f.store.db.prepare('UPDATE engineering_items SET data=? WHERE id=?').run(JSON.stringify(persisted),legacy.id);
  const m=await f.item('measurements',measurement(c.id,8000));await f.approve(m);
  const over=await f.item('measurements',measurement(c.id,1));ok(await f.transition(over,'submitted',f.users.author.cookie));ok(await f.transition(over,'approved'),409);
  await f.approve(await f.item('settlements',settlement(c.id,8000,m.id)));
  const cv=(await f.row(c)).commercial;assert.equal(cv.unmeasuredSettlementAmount,2000);assert.equal(cv.measurementAmount,8000);assert.equal(cv.settlementAmount,10000);assert.equal(cv.committedAmount,10000);assert.equal(cv.remainingSettlementAmount,0);
  const second=await approvedContract(f),secondMeasurement=await f.item('measurements',measurement(second.id,9000));await f.approve(secondMeasurement);
  const manual=await f.item('settlements',settlement(second.id,1001));ok(await f.transition(manual,'submitted',f.users.author.cookie));ok(await f.transition(manual,'approved'),409);
  assert.equal((await f.row(second)).commercial.unmeasuredSettlementAmount,0);
});

for(const direction of ['expense','income'])test('multiple measured periods and installments close only at net paid value, including '+direction+' reversal',async t=>{
  const f=await fixture(t),c=await approvedContract(f,{direction});
  const first=await f.item('measurements',measurement(c.id,6000)),second=await f.item('measurements',measurement(c.id,4000,{title:'第二期',periodStart:'2026-10-11',periodEnd:'2026-10-20'}));await f.approve(first);await f.approve(second);
  const a=await f.item('settlements',settlement(c.id,2000,first.id)),b=await f.item('settlements',settlement(c.id,4000,first.id));await f.approve(a);await f.approve(b);
  const excess=await f.item('settlements',settlement(c.id,1,first.id));ok(await f.transition(excess,'submitted',f.users.author.cookie));ok(await f.transition(excess,'approved'),409);await f.cancel(excess);
  assert.equal((await f.row(first)).commercial.remainingSettlementAmount,0);assert.equal((await f.row(second)).commercial.remainingSettlementAmount,4000);
  const d=await f.item('settlements',settlement(c.id,4000,second.id));await f.approve(d);
  ok(await f.transition(c,'closed'),409);
  const payments=[];for(const s of [a,b,d])payments.push(await f.approve(await f.item('costs',cost(s.id,s.data.amount,direction))));ok(await f.transition(c,'closed'));
  const reversed=await f.post(f.pb+'/reversals',{targetType:'cost',targetId:payments[0].id,note:'合成付款凭证纠错'},f.users.finance.cookie);ok(reversed,201);
  ok(await f.post(f.pb+'/reversals/'+reversed.body.id+'/state',{version:1,state:'approved',note:'独立复核冲销'},f.users.reviewer.cookie));
  const after=await f.detail();assert.equal(after.finance[direction],8000);assert.equal((await f.row(c)).state,'approved');assert.equal((await f.row(c)).commercial.settlementAmount,10000);assert.equal((await f.row(first)).commercial.settledAmount,6000);ok(await f.transition(c,'closed'),409);
  await f.approve(await f.item('costs',cost(a.id,2000,direction)));ok(await f.transition(c,'closed'));assert.equal((await f.detail()).finance[direction],10000);
});

test('approval rechecks reduced contract capacity and concurrent measurement or installment approvals serialize limits',async t=>{
  const f=await fixture(t),c=await approvedContract(f),a=await f.item('measurements',measurement(c.id,6000)),b=await f.item('measurements',measurement(c.id,6000));
  for(const r of [a,b])ok(await f.transition(r,'submitted',f.users.author.cookie));
  const outcomes=await Promise.all([a,b].map(r=>f.post(f.pb+'/items/'+r.id+'/state',{version:2,state:'approved',note:'并行计量批准'})));assert.deepEqual(outcomes.map(r=>r.status).sort(),[200,409]);
  const approved=(await f.detail()).items.find(r=>r.kind==='measurements'&&r.state==='approved');assert.equal((await f.row(c)).commercial.measurementAmount,6000);
  const s1=await f.item('settlements',settlement(c.id,4000,approved.id)),s2=await f.item('settlements',settlement(c.id,4000,approved.id));for(const r of [s1,s2])ok(await f.transition(r,'submitted',f.users.author.cookie));
  const settled=await Promise.all([s1,s2].map(r=>f.post(f.pb+'/items/'+r.id+'/state',{version:2,state:'approved',note:'并行分次结算'})));assert.deepEqual(settled.map(r=>r.status).sort(),[200,409]);assert.equal((await f.row(approved)).commercial.settledAmount,4000);
  const other=await approvedContract(f),draft=await f.item('measurements',measurement(other.id,8000));ok(await f.transition(draft,'submitted',f.users.author.cookie));await f.approve(await f.item('variations',variation(other.id,{changeType:'decrease',amount:3000})));ok(await f.transition(draft,'approved'),409);assert.equal((await f.row(other)).commercial.measurementAmount,0);
});

test('pending variations or measurement documents block contract close and approved commerce does not block completed projects',async t=>{
  const f=await fixture(t),c=await approvedContract(f),m=await f.item('measurements',measurement(c.id,10000));await f.approve(m);
  const s=await f.item('settlements',settlement(c.id,10000,m.id));await f.approve(s);await f.approve(await f.item('costs',cost(s.id,10000)));
  const v=await f.item('variations',variation(c.id));ok(await f.transition(c,'closed'),409);ok(await f.post(f.pb+'/state',{version:2,state:'completed',note:'存在未办签证'}),409);await f.cancel(v);
  const pending=await f.item('measurements',measurement(c.id,1));ok(await f.transition(pending,'submitted',f.users.author.cookie));ok(await f.transition(c,'closed'),409);await f.cancel(pending);
  ok(await f.transition(c,'closed'));
  for(const [kind,data] of [['variations',variation(c.id)],['measurements',measurement(c.id)]])ok(await f.post(f.pb+'/items/'+kind,{data},f.users.author.cookie),409);
  ok(await f.post(f.pb+'/state',{version:2,state:'completed',note:'合成闭环验收'}));
  ok(await f.post(f.pb+'/items/variations',{data:variation(c.id)},f.users.author.cookie),409);
});

test('commerce permissions hide values and history from field members and mobile bearer API retains approval boundaries',async t=>{
  const f=await fixture(t),c=await approvedContract(f),v=await f.item('variations',variation(c.id)),m=await f.item('measurements',measurement(c.id));
  const field=await f.detail(f.users.engineer.cookie);assert.equal(field.finance,null);assert.equal('budget' in field.project.data,false);assert.equal(field.items.some(r=>['contracts','variations','measurements','settlements'].includes(r.kind)),false);assert.equal(field.history.some(h=>['variations','measurements'].includes(h.kind)),false);
  for(const [kind,data] of [['variations',variation(c.id)],['measurements',measurement(c.id)]])ok(await f.post(f.pb+'/items/'+kind,{data},f.users.engineer.cookie),403);
  ok(await f.call('/engineering'+f.pb+'/items/'+m.id+'/attachments',undefined,f.users.engineer.cookie),403);ok(await f.call('/engineering'+f.pb,undefined,f.users.outsider.cookie),404);
  const login=await f.call('/mobile/login',{username:'qa-finance',password:f.password});ok(login);const headers={Authorization:'Bearer '+login.body.token};
  const mobile='/mobile/engineering'+f.pb;
  const created=await f.call(mobile+'/items/measurements',{requestId:randomUUID(),data:measurement(c.id,500)},'','POST',headers);ok(created,201);
  ok(await f.call(mobile+'/items/'+created.body.id+'/state',{requestId:randomUUID(),version:1,state:'submitted',note:'移动端提交'},'','POST',headers));
  ok(await f.call(mobile+'/items/'+created.body.id+'/state',{requestId:randomUUID(),version:2,state:'approved',note:'财务不可自审'},'','POST',headers),403);
  const managerLogin=await f.call('/mobile/login',{username:'qa-reviewer',password:f.password});ok(managerLogin);
  ok(await f.call(mobile+'/items/'+created.body.id+'/state',{requestId:randomUUID(),version:2,state:'approved',note:'移动端独立批准'},'','POST',{Authorization:'Bearer '+managerLogin.body.token}));
  const data=(await f.call(mobile,undefined,'','GET',headers)).body;assert.equal(data.items.find(r=>r.id===created.body.id).commercial.measuredAmount,500);
  ok(await f.post(f.pb+'/members',{userId:f.users.finance.id,role:'remove'},f.admin,'PUT'));ok(await f.call(mobile,undefined,'','GET',headers),404);
  assert.equal((await f.row(v)).state,'draft');
});

test('commerce edits protect optimistic versions and retry receipts persist without duplicating approved value',async t=>{
  const f=await fixture(t,true),c=await approvedContract(f),data=measurement(c.id,1234),body={requestId:randomUUID(),data};
  const path='/engineering'+f.pb+'/items/measurements',created=await f.call(path,body,f.users.author.cookie);ok(created,201);const iid=created.body.id;
  const retry=await f.call(path,body,f.users.author.cookie);ok(retry,201);assert.equal(retry.body.replayed,true);assert.equal(retry.body.id,iid);
  ok(await f.call(path,{...body,data:{...data,title:'不同请求内容'}},f.users.author.cookie),409);
  const editPath='/engineering'+f.pb+'/items/'+iid;
  const changes=await Promise.all([2000,3000].map(amount=>f.call(editPath,{requestId:randomUUID(),version:1,data:measurement(c.id,amount,{code:data.code})},f.users.author.cookie,'PUT')));assert.deepEqual(changes.map(r=>r.status).sort(),[200,409]);
  ok(await f.post(f.pb+'/items/'+iid+'/state',{version:1,state:'submitted',note:'过期提交'},f.users.author.cookie),409);ok(await f.transition(iid,'submitted',f.users.author.cookie));
  const approval={requestId:randomUUID(),version:3,state:'approved',note:'批准响应丢失重放'};ok(await f.call(editPath+'/state',approval,f.admin));
  const before=await f.row(iid),contractBefore=(await f.row(c)).commercial;
  await f.restart();assert.deepEqual((await f.row(iid)).data,before.data);assert.deepEqual((await f.row(c)).commercial,contractBefore);
  const approvedRetry=await f.call(editPath+'/state',approval,f.admin);ok(approvedRetry);assert.equal(approvedRetry.body.replayed,true);
  assert.equal((await f.detail()).items.filter(r=>r.kind==='measurements').length,1);assert.equal((await f.detail()).history.filter(h=>h.item_id===iid&&h.action==='approved').length,1);
  const createRetry=await f.call(path,body,f.users.author.cookie);ok(createRetry,201);assert.equal(createRetry.body.replayed,true);
});

test('maximum-length 50-line Chinese measurements pass desktop/mobile HTTP create and edit, including Unicode-escaped JSON',async t=>{
  const f=await fixture(t),c=await approvedContract(f);
  const data=measurement(c.id,1000,{
    title:'量'.repeat(200),code:'号'.repeat(200),note:'据'.repeat(2000),
    lines:Array.from({length:50},()=>line({name:'项'.repeat(200),location:'段'.repeat(200),unit:'米'.repeat(30),quantity:1000,unitPrice:1000,note:'注'.repeat(500)})),
  });
  const body={requestId:randomUUID(),data};
  assert.ok(Buffer.byteLength(JSON.stringify(body))>128*1024);
  const escaped=value=>JSON.stringify(value).replace(/[^\x00-\x7f]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
  assert.ok(Buffer.byteLength(escaped(body))>256*1024);assert.ok(Buffer.byteLength(escaped(body))<512*1024);
  const path='/engineering'+f.pb+'/items/measurements';
  const desktop=await f.call(path,body,f.users.author.cookie);ok(desktop,201);
  ok(await f.call('/engineering'+f.pb+'/items/'+desktop.body.id,escaped({requestId:randomUUID(),version:1,data:{...data,title:'修改后'+data.title.slice(3)}}),f.users.author.cookie,'PUT'));
  const desktopRow=await f.row(desktop.body.id);assert.equal(desktopRow.data.lines.length,50);assert.equal(desktopRow.data.lines[49].note,'注'.repeat(500));assert.equal(desktopRow.data.amount,50000);
  const login=await f.call('/mobile/login',{username:'qa-finance',password:f.password});ok(login);const headers={Authorization:'Bearer '+login.body.token};
  const mobilePath='/mobile/engineering'+f.pb+'/items/measurements',mobileData={...data,code:'移'.repeat(200)};
  const mobile=await f.call(mobilePath,escaped({requestId:randomUUID(),data:mobileData}),'','POST',headers);ok(mobile,201);
  ok(await f.call('/mobile/engineering'+f.pb+'/items/'+mobile.body.id,{requestId:randomUUID(),version:1,data:{...mobileData,note:'审'.repeat(2000)}},'','PUT',headers));
  const mobileRow=await f.row(mobile.body.id);assert.equal(mobileRow.data.lines.length,50);assert.equal(mobileRow.data.note,'审'.repeat(2000));assert.equal(mobileRow.version,2);
  const oversize=' '.repeat(512*1024)+JSON.stringify({requestId:randomUUID(),data:measurement(c.id)});
  ok(await f.call(path,oversize,f.users.author.cookie),413);
  // State changes and unrelated routes retain the existing 128 KiB ceiling.
  const normalOversize=' '.repeat(128*1024)+JSON.stringify({requestId:randomUUID(),version:2,state:'submitted',note:'仍使用普通限制'});
  ok(await f.call('/engineering'+f.pb+'/items/'+desktop.body.id+'/state',normalOversize,f.users.author.cookie),413);
});
