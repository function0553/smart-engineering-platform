import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createApp} from '../server/app.mjs';

// Disposable HTTP fixtures never connect to the deployed service or normal business database.
const ok=(r,status=200)=>assert.equal(r.status,status,JSON.stringify(r.body));
async function fixture(t,persistent=false){
  const dir=persistent?mkdtempSync(join(tmpdir(),'engineering-corrections-')):null;
  let server,state,url;
  const start=async()=>{server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+server.address().port;state=createApp({database:dir?join(dir,'test.sqlite'):':memory:',baseUrl:url,distPath:'__none__'});server.on('request',state.app);};
  const stop=async()=>{state.vision.close();server.closeAllConnections();await new Promise(r=>server.close(r));state.store.close();};
  await start();t.after(async()=>{await stop();if(dir){assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));assert.ok(dir.includes('engineering-corrections-'));rmSync(dir,{recursive:true,force:true});}});
  const call=async(path,body,cookie='',method=body===undefined?'GET':'POST',headers={})=>{
    const response=await fetch(url+'/api'+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json','X-Workspace-Request':'1',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const bytes=Buffer.from(await response.arrayBuffer());let parsed;try{parsed=JSON.parse(bytes.toString());}catch{parsed=bytes;}
    return {status:response.status,body:parsed,bytes,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const password='isolated-corrections-test-123',setup=await call('/setup',{organization:'批准单据纠错隔离验证',username:'qa-admin',name:'管理员',password});ok(setup,201);const admin=setup.cookie,users={};
  for(const name of ['author','reviewer','approver','finance','engineer','viewer','outsider']){
    ok(await call('/users',{username:'qa-'+name,name,role:name==='viewer'?'viewer':'operator',password},admin),201);
    const list=(await call('/users',undefined,admin)).body;users[name]={id:list.find(u=>u.name===name).id,cookie:(await call('/login',{username:'qa-'+name,password})).cookie};
  }
  const post=(path,body,cookie=admin,method='POST')=>call('/engineering'+path,{requestId:randomUUID(),...body},cookie,method);
  const projectData={code:randomUUID(),name:'批准单据纠错合成项目',address:'本机隔离场所',owner:'测试',startDate:'2026-10-01',dueDate:'2026-12-31',budget:1000000,note:'合成业务'};
  const project=await post('/projects',{data:projectData});ok(project,201);const pid=project.body.id,pb='/projects/'+pid;
  ok(await post(pb+'/state',{version:1,state:'active',note:'合成项目开工'}));
  for(const [name,role] of [['author','manager'],['reviewer','manager'],['approver','manager'],['finance','finance'],['engineer','engineer'],['viewer','manager']])ok(await post(pb+'/members',{userId:users[name].id,role},admin,'PUT'));
  const detail=async(cookie=admin)=>{const r=await call('/engineering'+pb,undefined,cookie);ok(r);return r.body;};
  const row=async item=>(await detail()).items.find(r=>r.id===(typeof item==='string'?item:item.id));
  const item=async(kind,data,cookie=users.author.cookie)=>{const r=await post(pb+'/items/'+kind,{data},cookie);ok(r,201);return row(r.body.id);};
  const transition=async(item,state,cookie=admin)=>{const current=await row(item);return post(pb+'/items/'+current.id+'/state',{version:current.version,state,note:'合成办理依据'},cookie);};
  const approve=async(item,cookie=admin)=>{ok(await transition(item,'submitted',users.author.cookie));ok(await transition(item,'approved',cookie));return row(item);};
  const cancel=async item=>{if((await row(item)).state==='submitted')ok(await transition(item,'draft'));ok(await transition(item,'cancelled',users.author.cookie));};
  const correct=(item,cookie=users.finance.cookie)=>post(pb+'/corrections',{targetId:typeof item==='string'?item:item.id,note:'核对原件后申请撤销错误批准单'},cookie);
  const review=(cid,state='approved',cookie=users.reviewer.cookie,version=1)=>post(pb+'/corrections/'+cid+'/state',{version,state,note:'独立复核更正依据'},cookie);
  const voidItem=async item=>{const request=await correct(item);ok(request,201);ok(await review(request.body.id));return row(item);};
  const reverse=async item=>{
    const createPath='/engineering'+pb+'/reversals',createBody={requestId:randomUUID(),targetType:'cost',targetId:item.id,note:'先冲销原错误收支'},request=await call(createPath,createBody,users.finance.cookie);ok(request,201);
    const reviewPath=createPath+'/'+request.body.id+'/state',reviewBody={requestId:randomUUID(),version:1,state:'approved',note:'独立复核收支冲销'};ok(await call(reviewPath,reviewBody,users.reviewer.cookie));
    return {createPath,createBody,reviewPath,reviewBody};
  };
  const source=item=>({...state.store.db.prepare('SELECT * FROM engineering_items WHERE id=?').get(typeof item==='string'?item:item.id)});
  return {call,post,admin,users,password,pid,pb,projectData,detail,row,item,transition,approve,cancel,correct,review,voidItem,reverse,source,get store(){return state.store;},restart:async()=>{await stop();await start();}};
}
const contract=(extra={})=>({title:'合成施工合同',code:randomUUID(),counterparty:'合成相对方',direction:'expense',amount:10000,dueDate:'2026-12-31',note:'合成合同依据',...extra});
const variation=(contractId,extra={})=>({title:'合成签证',code:randomUUID(),contractId,changeType:'increase',amount:1000,occurredDate:'2026-10-11',note:'合成签证依据',...extra});
const measurement=(contractId,amount=1000)=>({title:'合成工程量',code:randomUUID(),contractId,periodStart:'2026-10-01',periodEnd:'2026-10-10',lines:[{name:'土方',location:'测试段',unit:'立方米',quantity:1000,unitPrice:amount,note:''}],note:'合成计量依据'});
const settlement=(contractId,amount=1000,measurementId='')=>({title:'合成结算',contractId,measurementId,amount,dueDate:'2026-10-25',note:'合成结算依据'});
const cost=(settlementId,amount=1000,direction='expense')=>({title:'合成收支',direction,category:'subcontract',settlementId,amount,occurredDate:'2026-10-11',voucher:randomUUID(),note:'合成收支依据'});
const approvedContract=async(f,extra={})=>f.approve(await f.item('contracts',contract(extra)));
const assertBlocked=item=>{assert.equal(item.correctionEligibility.allowed,false);assert.ok(item.correctionEligibility.blockers.length>0);for(const blocker of item.correctionEligibility.blockers)assert.ok(typeof blocker.reason==='string'&&blocker.reason.length>0);};

test('corrections exclude requester and original content or attachment editors, preserving all original rows and files',async t=>{
  const f=await fixture(t),c=await approvedContract(f),bytes=Buffer.from('%PDF-1.7\nsynthetic approved original\n%%EOF');
  for(const [kind,data] of [['variations',variation(c.id)],['measurements',measurement(c.id)],['settlements',settlement(c.id)]]){
    const r=await f.item(kind,data),path=f.pb+'/items/'+r.id+'/attachments';
    const attachment=await f.post(path,{version:1,name:'批准依据.pdf',caption:'合成原件',base64:bytes.toString('base64')});ok(attachment,201);
    await f.approve(r,f.users.reviewer.cookie);const before=f.source(r);assert.equal((await f.row(r)).voided,false);assert.equal((await f.row(r)).correctionEligibility.allowed,true);
    const requested=await f.correct(r,f.users.reviewer.cookie);ok(requested,201);
    for(const actor of [f.users.author.cookie,f.admin,f.users.reviewer.cookie])ok(await f.review(requested.body.id,'approved',actor),409);
    ok(await f.review(requested.body.id,'approved',f.users.approver.cookie));
    assert.deepEqual(f.source(r),before);const result=await f.row(r);assert.equal(result.voided,true);assert.equal(result.state,'approved');assertBlocked(result);
    const downloaded=await f.call('/engineering'+path+'/'+attachment.body.id+'/download',undefined,f.admin);ok(downloaded);assert.deepEqual(downloaded.bytes,bytes);
    const files=await f.call('/engineering'+path,undefined,f.admin);assert.equal(files.body.attachments.length,1);assert.equal(files.body.writable,false);
  }
});

test('rejected and withdrawn correction requests leave values intact and permit new requests',async t=>{
  const f=await fixture(t),c=await approvedContract(f),v=await f.approve(await f.item('variations',variation(c.id)));
  const first=await f.correct(v);ok(first,201);ok(await f.correct(v),409);ok(await f.review(first.body.id,'rejected'));
  assert.equal((await f.row(v)).voided,false);assert.equal((await f.row(c)).commercial.effectiveAmount,11000);
  const second=await f.correct(v);ok(second,201);
  ok(await f.post(f.pb+'/members',{userId:f.users.approver.id,role:'finance'},f.admin,'PUT'));ok(await f.review(second.body.id,'cancelled',f.users.approver.cookie),403);
  const cancelPath='/engineering'+f.pb+'/corrections/'+second.body.id+'/state',cancelBody={requestId:randomUUID(),version:1,state:'cancelled',note:'申请财务撤回更正'};
  ok(await f.call(cancelPath,cancelBody,f.users.finance.cookie));const cancelRetry=await f.call(cancelPath,cancelBody,f.users.finance.cookie);ok(cancelRetry);assert.equal(cancelRetry.body.replayed,true);
  assert.equal((await f.detail()).history.filter(h=>h.item_id===v.id&&h.action==='correction_cancelled').length,1);ok(await f.review(second.body.id),409);
  const third=await f.correct(v);ok(third,201);ok(await f.review(third.body.id));
  assert.equal((await f.row(c)).commercial.effectiveAmount,10000);assert.equal((await f.detail()).corrections.length,3);ok(await f.correct(v),409);
});

test('correction versions and idempotency survive SQLite restart without duplicate voids or history',async t=>{
  const f=await fixture(t,true),c=await approvedContract(f),m=await f.approve(await f.item('measurements',measurement(c.id,6000)));
  const payload={requestId:randomUUID(),targetId:m.id,note:'模拟申请响应丢失'},path='/engineering'+f.pb+'/corrections';
  const original=await f.call(path,payload,f.users.finance.cookie);ok(original,201);const retry=await f.call(path,payload,f.users.finance.cookie);assert.equal(retry.body.replayed,true);assert.equal(retry.body.id,original.body.id);
  ok(await f.call(path,{...payload,note:'不同内容'},f.users.finance.cookie),409);ok(await f.review(original.body.id,'approved',f.users.reviewer.cookie,2),409);
  const approvedBody={requestId:randomUUID(),version:1,state:'approved',note:'模拟批准响应丢失'},approvalPath=path+'/'+original.body.id+'/state';ok(await f.call(approvalPath,approvedBody,f.users.reviewer.cookie));
  const before=f.source(m);await f.restart();const approvedRetry=await f.call(approvalPath,approvedBody,f.users.reviewer.cookie);ok(approvedRetry);assert.equal(approvedRetry.body.replayed,true);
  assert.deepEqual(f.source(m),before);assert.equal((await f.row(m)).voided,true);assert.equal((await f.row(c)).commercial.measurementAmount,0);assert.equal((await f.detail()).corrections.length,1);
  assert.equal((await f.detail()).history.filter(h=>h.item_id===m.id&&h.action==='correction_approved').length,1);ok(await f.review(original.body.id),409);
  const createRetry=await f.call(path,payload,f.users.finance.cookie);assert.equal(createRetry.body.replayed,true);assert.equal(createRetry.body.id,original.body.id);
});

test('settlement correction is blocked by draft, submitted and effective approved costs until each dependency is resolved',async t=>{
  const f=await fixture(t),c=await approvedContract(f),s=await f.approve(await f.item('settlements',settlement(c.id,10000)));
  const draft=await f.item('costs',cost(s.id,1000));assertBlocked(await f.row(s));ok(await f.correct(s),409);await f.cancel(draft);
  const submitted=await f.item('costs',cost(s.id,2000));ok(await f.transition(submitted,'submitted',f.users.author.cookie));assertBlocked(await f.row(s));ok(await f.correct(s),409);await f.cancel(submitted);
  const paid=await f.approve(await f.item('costs',cost(s.id,3000)));assertBlocked(await f.row(s));ok(await f.correct(s),409);
  await f.reverse(paid);assert.equal((await f.row(s)).correctionEligibility.allowed,true);await f.voidItem(s);
  const view=await f.detail();assert.equal(view.finance.expense,0);assert.equal(view.finance.payable,0);assert.equal((await f.row(c)).commercial.settlementAmount,0);
});

test('cost reversal then settlement correction then measurement correction conserves net income and expense',async t=>{
  const f=await fixture(t);
  for(const direction of ['income','expense']){
    const c=await approvedContract(f,{direction}),m=await f.approve(await f.item('measurements',measurement(c.id,10000))),s=await f.approve(await f.item('settlements',settlement(c.id,10000,m.id))),payment=await f.approve(await f.item('costs',cost(s.id,10000,direction)));
    ok(await f.transition(c,'closed'));const mOriginal=f.source(m),sOriginal=f.source(s);
    ok(await f.correct(m),409);ok(await f.correct(s),409);const reversal=await f.reverse(payment);
    assert.equal((await f.row(c)).state,'approved');await f.voidItem(s);assert.equal((await f.row(m)).commercial.settledAmount,0);await f.voidItem(m);
    assert.deepEqual(f.source(m),mOriginal);assert.deepEqual(f.source(s),sOriginal);
    const cv=(await f.row(c)).commercial;assert.equal(cv.measurementAmount,0);assert.equal(cv.settlementAmount,0);assert.equal(cv.remainingMeasurementAmount,10000);
    const view=await f.detail();assert.equal(view.finance[direction],0);assert.equal(view.finance[direction==='income'?'receivable':'payable'],0);
    const createRetry=await f.call(reversal.createPath,reversal.createBody,f.users.finance.cookie),reviewRetry=await f.call(reversal.reviewPath,reversal.reviewBody,f.users.reviewer.cookie);
    assert.equal(createRetry.body.replayed,true);assert.equal(reviewRetry.body.replayed,true);assert.equal((await f.detail()).history.filter(h=>h.item_id===payment.id&&h.action==='reversal_approved').length,1);
  }
});

test('measurement correction lists pending and approved settlement blockers and ignores properly cancelled or voided settlements',async t=>{
  const f=await fixture(t),c=await approvedContract(f),m=await f.approve(await f.item('measurements',measurement(c.id,9000)));
  const draft=await f.item('settlements',settlement(c.id,1000,m.id));assertBlocked(await f.row(m));ok(await f.correct(m),409);await f.cancel(draft);
  const submitted=await f.item('settlements',settlement(c.id,1000,m.id));ok(await f.transition(submitted,'submitted',f.users.author.cookie));assertBlocked(await f.row(m));ok(await f.correct(m),409);await f.cancel(submitted);
  const approved=await f.approve(await f.item('settlements',settlement(c.id,1000,m.id)));assertBlocked(await f.row(m));ok(await f.correct(m),409);await f.voidItem(approved);
  assert.equal((await f.row(m)).correctionEligibility.allowed,true);await f.voidItem(m);assert.equal((await f.row(c)).commercial.measurementAmount,0);
});

test('increased variation cannot be withdrawn below approved purchase, measured or manual settlement commitments',async t=>{
  const f=await fixture(t);
  for(const dependency of ['purchases','measurements','settlements']){
    const c=await approvedContract(f),v=await f.approve(await f.item('variations',variation(c.id,{amount:5000})));
    if(dependency==='purchases'){
      const material=await f.item('materials',{title:'合成材料',code:randomUUID(),specification:'测试',unit:'吨',warehouse:'测试库',note:''});
      await f.approve(await f.item('purchases',{title:'合成采购',supplier:'测试供应商',materialId:material.id,quantity:1000,unitPrice:12000,contractId:c.id,dueDate:'2026-10-20',note:'合成采购依据'}));
    }else if(dependency==='measurements')await f.approve(await f.item('measurements',measurement(c.id,12000)));
    else await f.approve(await f.item('settlements',settlement(c.id,12000)));
    assertBlocked(await f.row(v));ok(await f.correct(v),409);assert.equal((await f.row(c)).commercial.effectiveAmount,15000);
  }
});

test('withdrawing variations enforces zero and maximum effective contract bounds even with opposite later variations',async t=>{
  const f=await fixture(t),negative=await approvedContract(f),increase=await f.approve(await f.item('variations',variation(negative.id,{amount:10000})));
  await f.approve(await f.item('variations',variation(negative.id,{changeType:'decrease',amount:15000})));assert.equal((await f.row(negative)).commercial.effectiveAmount,5000);assertBlocked(await f.row(increase));ok(await f.correct(increase),409);
  const maximum=await approvedContract(f,{amount:1000000000000}),decrease=await f.approve(await f.item('variations',variation(maximum.id,{changeType:'decrease',amount:1000})));
  await f.approve(await f.item('variations',variation(maximum.id,{amount:1000})));assertBlocked(await f.row(decrease));ok(await f.correct(decrease),409);assert.equal((await f.row(maximum)).commercial.effectiveAmount,1000000000000);
});

test('correction approval rechecks dependencies and changing contract commitments after an eligible request',async t=>{
  const f=await fixture(t),c=await approvedContract(f),v=await f.approve(await f.item('variations',variation(c.id,{amount:5000}))),request=await f.correct(v);ok(request,201);
  const m=await f.approve(await f.item('measurements',measurement(c.id,12000)));ok(await f.review(request.body.id),409);assert.equal((await f.row(v)).voided,false);assert.equal((await f.detail()).corrections.find(r=>r.id===request.body.id).state,'submitted');
  await f.voidItem(m);ok(await f.review(request.body.id));assert.equal((await f.row(c)).commercial.effectiveAmount,10000);
  const s=await f.approve(await f.item('settlements',settlement(c.id,1000))),sr=await f.correct(s);ok(sr,201);const newCost=await f.item('costs',cost(s.id));ok(await f.review(sr.body.id),409);await f.cancel(newCost);ok(await f.review(sr.body.id));
  const other=await f.approve(await f.item('measurements',measurement(c.id,1000))),mr=await f.correct(other);ok(mr,201);const pending=await f.item('settlements',settlement(c.id,1000,other.id));ok(await f.review(mr.body.id),409);await f.cancel(pending);ok(await f.review(mr.body.id));
});

test('concurrent correction approvals recompute shared commitments and prevent double approval',async t=>{
  const f=await fixture(t),c=await approvedContract(f),a=await f.approve(await f.item('variations',variation(c.id,{amount:4000}))),b=await f.approve(await f.item('variations',variation(c.id,{amount:4000})));
  await f.approve(await f.item('measurements',measurement(c.id,14000)));const ra=await f.correct(a),rb=await f.correct(b);ok(ra,201);ok(rb,201);
  const replies=await Promise.all([f.review(ra.body.id),f.review(rb.body.id)]);assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);assert.equal((await f.row(c)).commercial.effectiveAmount,14000);
  const free=await approvedContract(f),m=await f.approve(await f.item('measurements',measurement(free.id))),request=await f.correct(m);ok(request,201);
  const duplicate=await Promise.all([f.review(request.body.id),f.review(request.body.id)]);assert.deepEqual(duplicate.map(r=>r.status).sort(),[200,409]);assert.equal((await f.row(m)).voided,true);
});

test('correction approval reopens a closed contract and pending requests block contract and project completion',async t=>{
  const f=await fixture(t),c=await approvedContract(f),decrease=await f.approve(await f.item('variations',variation(c.id,{changeType:'decrease',amount:1000}))),s=await f.approve(await f.item('settlements',settlement(c.id,9000)));await f.approve(await f.item('costs',cost(s.id,9000)));
  ok(await f.transition(c,'closed'));const requested=await f.correct(decrease);ok(requested,201);ok(await f.post(f.pb+'/state',{version:2,state:'completed',note:'仍有待批撤销'}),409);
  ok(await f.review(requested.body.id));assert.equal((await f.row(c)).state,'approved');assert.equal((await f.row(c)).commercial.effectiveAmount,10000);ok(await f.transition(c,'closed'),409);
  const final=await f.approve(await f.item('settlements',settlement(c.id,1000)));await f.approve(await f.item('costs',cost(final.id,1000)));
  const harmless=await f.approve(await f.item('variations',variation(c.id,{amount:1000}))),offset=await f.approve(await f.item('variations',variation(c.id,{changeType:'decrease',amount:1000})));
  const pending=await f.correct(offset);ok(pending,201);ok(await f.transition(c,'closed'),409);ok(await f.review(pending.body.id,'cancelled',f.users.finance.cookie));ok(await f.transition(c,'closed'));
  ok(await f.post(f.pb+'/state',{version:2,state:'completed',note:'合成闭环完成'}));assert.equal((await f.row(harmless)).voided,false);
});

test('corrections honor financial visibility, read-only override, CSRF and mobile authentication with revocation',async t=>{
  const f=await fixture(t),c=await approvedContract(f),m=await f.approve(await f.item('measurements',measurement(c.id))),requested=await f.correct(m);ok(requested,201);
  for(const actor of [f.users.engineer.cookie,f.users.viewer.cookie]){
    const view=await f.detail(actor);assert.equal((view.corrections||[]).length,0);assert.equal(view.items.some(r=>r.id===m.id),false);assert.equal(view.history.some(h=>h.item_id===m.id),false);ok(await f.correct(m,actor),403);
  }
  ok(await f.correct(m,f.users.outsider.cookie),404);ok(await f.call('/engineering'+f.pb+'/corrections',{requestId:randomUUID(),targetId:m.id,note:'无CSRF标识'},f.admin,'POST',{'X-Workspace-Request':''}),403);
  ok(await f.review(requested.body.id,'approved',f.users.finance.cookie),403);
  const login=await f.call('/mobile/login',{username:'qa-reviewer',password:f.password});ok(login);const headers={Authorization:'Bearer '+login.body.token},path='/mobile/engineering'+f.pb+'/corrections/'+requested.body.id+'/state';
  ok(await f.call(path,{requestId:randomUUID(),version:1,state:'approved',note:'移动端独立复核'},'','POST',headers));assert.equal((await f.row(m)).voided,true);
  const second=await f.approve(await f.item('measurements',measurement(c.id))),financeLogin=await f.call('/mobile/login',{username:'qa-finance',password:f.password});ok(financeLogin);
  ok(await f.call('/mobile/engineering'+f.pb+'/corrections',{requestId:randomUUID(),targetId:second.id,note:'移动端申请'},'','POST',{Authorization:'Bearer '+financeLogin.body.token}),201);
  ok(await f.post(f.pb+'/members',{userId:f.users.reviewer.id,role:'remove'},f.admin,'PUT'));ok(await f.call(path,{requestId:randomUUID(),version:1,state:'approved',note:'撤权后不得办理'},'','POST',headers),404);
});

test('completed and archived projects reject correction mutations while original approvals remain readable',async t=>{
  const f=await fixture(t),c=await approvedContract(f),decrease=await f.approve(await f.item('variations',variation(c.id,{changeType:'decrease',amount:10000})));ok(await f.transition(c,'closed'));ok(await f.post(f.pb+'/state',{version:2,state:'completed',note:'合成完工'}));
  ok(await f.correct(decrease),409);ok(await f.post(f.pb+'/state',{version:3,state:'archived',note:'合成归档'}));ok(await f.correct(decrease),409);assert.equal((await f.row(decrease)).voided,false);
  // Simulate an imported unfinished request in a completed/archived project; approval must recheck the live project lock.
  f.store.db.prepare("UPDATE engineering_projects SET state='active' WHERE id=?").run(f.pid);
  const pending=await f.correct(decrease);ok(pending,201);
  for(const projectState of ['completed','archived']){
    f.store.db.prepare('UPDATE engineering_projects SET state=? WHERE id=?').run(projectState,f.pid);ok(await f.review(pending.body.id),409);
  }
  assert.equal((await f.row(decrease)).voided,false);assert.equal((await f.detail()).corrections.find(r=>r.id===pending.body.id).state,'submitted');
});

test('voided measurement and settlement references are rejected on create and when approving stale imported drafts',async t=>{
  const f=await fixture(t),c=await approvedContract(f),m=await f.approve(await f.item('measurements',measurement(c.id))),s=await f.approve(await f.item('settlements',settlement(c.id,1000,m.id)));await f.voidItem(s);await f.voidItem(m);
  ok(await f.post(f.pb+'/items/settlements',{data:settlement(c.id,1000,m.id)},f.users.author.cookie),409);ok(await f.post(f.pb+'/items/costs',{data:cost(s.id)},f.users.author.cookie),409);
  // Simulate pre-upgrade/imported drafts with stale references; normal writes must reject those too.
  const newMeasurement=await f.approve(await f.item('measurements',measurement(c.id))),pendingSettlement=await f.item('settlements',settlement(c.id,1000,newMeasurement.id));ok(await f.transition(pendingSettlement,'submitted',f.users.author.cookie));
  const staleSettlement={...(await f.row(pendingSettlement)).data,measurementId:m.id};f.store.db.prepare('UPDATE engineering_items SET data=? WHERE id=?').run(JSON.stringify(staleSettlement),pendingSettlement.id);ok(await f.transition(pendingSettlement,'approved'),409);
  const newSettlement=await f.approve(await f.item('settlements',settlement(c.id,1000,newMeasurement.id))),pendingCost=await f.item('costs',cost(newSettlement.id));ok(await f.transition(pendingCost,'submitted',f.users.author.cookie));
  const staleCost={...(await f.row(pendingCost)).data,settlementId:s.id};f.store.db.prepare('UPDATE engineering_items SET data=? WHERE id=?').run(JSON.stringify(staleCost),pendingCost.id);ok(await f.transition(pendingCost,'approved'),409);
  const oldPaid=await f.approve(await f.item('costs',cost(newSettlement.id))),stalePaid={...oldPaid.data,settlementId:s.id};
  f.store.db.prepare('UPDATE engineering_items SET data=? WHERE id=?').run(JSON.stringify(stalePaid),oldPaid.id);
  ok(await f.post(f.pb+'/reversals',{targetType:'cost',targetId:oldPaid.id,note:'遗留失效结算不能办理新冲销'},f.users.finance.cookie),409);
  assert.equal((await f.row(c)).commercial.settlementAmount,1000);
});

test('corrected replacement documents restore settlement and payment closure without counting voided originals',async t=>{
  const f=await fixture(t),c=await approvedContract(f),v=await f.approve(await f.item('variations',variation(c.id,{amount:2000}))),m=await f.approve(await f.item('measurements',measurement(c.id,12000))),s=await f.approve(await f.item('settlements',settlement(c.id,12000,m.id))),p=await f.approve(await f.item('costs',cost(s.id,12000)));
  ok(await f.transition(c,'closed'));await f.reverse(p);await f.voidItem(s);await f.voidItem(m);await f.voidItem(v);
  const newVariation=await f.approve(await f.item('variations',variation(c.id,{amount:1000}))),newMeasurement=await f.approve(await f.item('measurements',measurement(c.id,11000))),newSettlement=await f.approve(await f.item('settlements',settlement(c.id,11000,newMeasurement.id)));await f.approve(await f.item('costs',cost(newSettlement.id,11000)));
  ok(await f.transition(c,'closed'));const view=await f.detail(),cv=(await f.row(c)).commercial;assert.equal(cv.originalAmount,10000);assert.equal(cv.effectiveAmount,11000);assert.equal(cv.measurementAmount,11000);assert.equal(cv.settlementAmount,11000);assert.equal(view.finance.expense,11000);assert.equal(view.finance.payable,11000);
  assert.equal((await f.row(newVariation)).voided,false);for(const old of [v,m,s])assert.equal((await f.row(old)).voided,true);assert.equal(view.corrections.filter(r=>r.state==='approved').length,3);ok(await f.post(f.pb+'/state',{version:2,state:'completed',note:'更正后完整闭环'}));
});

test('correction targets require supported approved original documents, same project and explicit nonempty reasons',async t=>{
  const f=await fixture(t),c=await approvedContract(f),draft=await f.item('variations',variation(c.id));
  for(const r of [c,draft]){const result=await f.correct(r);assert.ok([400,409].includes(result.status),JSON.stringify(result.body));}
  ok(await f.post(f.pb+'/corrections',{targetId:draft.id,note:''}),400);ok(await f.post(f.pb+'/corrections',{targetId:'invalid',note:'合成原因'}),400);
  const m=await f.approve(await f.item('measurements',measurement(c.id))),request=await f.correct(m);ok(request,201);
  ok(await f.post(f.pb+'/corrections/'+request.body.id+'/state',{version:1,state:'approved',note:''}),400);ok(await f.post(f.pb+'/corrections/'+request.body.id+'/state',{version:1,state:'delete',note:'错误状态'}),400);
  const other=await f.post('/projects',{data:{...f.projectData,code:randomUUID()}});ok(other,201);ok(await f.post('/projects/'+other.body.id+'/state',{version:1,state:'active',note:'另一个合成项目'}));
  const cross=await f.post('/projects/'+other.body.id+'/corrections',{targetId:m.id,note:'跨项目不得撤销'});assert.ok([400,404].includes(cross.status),JSON.stringify(cross.body));
  assert.equal((await f.row(m)).voided,false);assert.equal((await f.detail()).corrections.length,1);
});
