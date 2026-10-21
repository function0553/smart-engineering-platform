import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createApp} from '../server/app.mjs';

// Real HTTP routes, synthetic accounts and disposable SQLite files only. No production service is contacted.
const ok=(response,status=200)=>assert.equal(response.status,status,JSON.stringify(response.body));
async function fixture(t,persistent=false){
  const dir=persistent?mkdtempSync(join(tmpdir(),'engineering-boq-')):null;
  let server,state,url;
  const start=async()=>{server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+server.address().port;state=createApp({database:dir?join(dir,'test.sqlite'):':memory:',baseUrl:url,distPath:'__none__'});server.on('request',state.app);};
  const stop=async()=>{state.vision.close();server.closeAllConnections();await new Promise(r=>server.close(r));state.store.close();};
  await start();t.after(async()=>{await stop();if(dir){assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));assert.ok(dir.includes('engineering-boq-'));rmSync(dir,{recursive:true,force:true});}});
  const call=async(path,body,cookie='',method=body===undefined?'GET':'POST',headers={})=>{
    const response=await fetch(url+'/api'+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json','X-Workspace-Request':'1',...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
    const bytes=Buffer.from(await response.arrayBuffer());let parsed;try{parsed=JSON.parse(bytes.toString());}catch{parsed=bytes;}
    return {status:response.status,body:parsed,bytes,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const password='isolated-boq-test-only-123',setup=await call('/setup',{organization:'BOQ合成隔离验证',username:'qa-admin',name:'测试管理员',password});ok(setup,201);const admin=setup.cookie,users={};
  for(const name of ['author','reviewer','approver','finance','engineer','viewer','outsider']){
    ok(await call('/users',{username:'qa-'+name,name,role:name==='viewer'?'viewer':'operator',password},admin),201);
    const list=(await call('/users',undefined,admin)).body;users[name]={id:list.find(u=>u.name===name).id,cookie:(await call('/login',{username:'qa-'+name,password})).cookie};
  }
  const post=(path,body,cookie=admin,method='POST')=>call('/engineering'+path,{requestId:randomUUID(),...body},cookie,method);
  const projectData={code:randomUUID(),name:'BOQ清单合成项目',address:'本机隔离场所',owner:'测试负责人',startDate:'2026-10-01',dueDate:'2026-12-31',budget:1000000,note:'合成数据'};
  const created=await post('/projects',{data:projectData});ok(created,201);const pid=created.body.id,pb='/projects/'+pid;
  ok(await post(pb+'/state',{version:1,state:'active',note:'合成项目开工'}));
  for(const [name,role] of [['author','manager'],['reviewer','manager'],['approver','manager'],['finance','finance'],['engineer','engineer'],['viewer','manager']])ok(await post(pb+'/members',{userId:users[name].id,role},admin,'PUT'));
  const detail=async(cookie=admin)=>{const result=await call('/engineering'+pb,undefined,cookie);ok(result);return result.body;};
  const row=async item=>(await detail()).items.find(r=>r.id===(typeof item==='string'?item:item.id));
  const item=async(kind,data,cookie=users.author.cookie)=>{const result=await post(pb+'/items/'+kind,{data},cookie);ok(result,201);return row(result.body.id);};
  const transition=async(item,state,cookie=admin)=>{const current=await row(item);return post(pb+'/items/'+current.id+'/state',{version:current.version,state,note:'合成独立审批依据'},cookie);};
  const approve=async(item,cookie=admin)=>{ok(await transition(item,'submitted',users.author.cookie));ok(await transition(item,'approved',cookie));return row(item);};
  const cancel=async item=>{if((await row(item)).state==='submitted')ok(await transition(item,'draft'));ok(await transition(item,'cancelled',users.author.cookie));};
  const edit=async(item,data,cookie=users.author.cookie)=>{const current=await row(item);return post(pb+'/items/'+current.id,{version:current.version,data},cookie,'PUT');};
  const correct=(item,cookie=users.finance.cookie)=>post(pb+'/corrections',{targetId:typeof item==='string'?item:item.id,note:'核对原件后申请撤销'},cookie);
  const reviewCorrection=(cid,cookie=users.reviewer.cookie)=>post(pb+'/corrections/'+cid+'/state',{version:1,state:'approved',note:'独立复核纠错依据'},cookie);
  const voidItem=async item=>{const request=await correct(item);ok(request,201);ok(await reviewCorrection(request.body.id));return row(item);};
  const source=item=>({...state.store.db.prepare('SELECT * FROM engineering_items WHERE id=?').get(typeof item==='string'?item:item.id)});
  return {call,post,admin,users,password,pid,pb,projectData,detail,row,item,transition,approve,cancel,edit,correct,reviewCorrection,voidItem,source,get store(){return state.store;},restart:async()=>{await stop();await start();}};
}
const contract=(extra={})=>({title:'合成清单合同',code:randomUUID(),counterparty:'合成相对方',direction:'expense',amount:10000,dueDate:'2026-12-31',note:'仅合成合同依据',...extra});
const freeMeasurement=(contractId,amount=1000)=>({title:'旧自由计量',code:randomUUID(),contractId,periodStart:'2026-10-01',periodEnd:'2026-10-10',lines:[{name:'土方',location:'测试段',unit:'立方米',quantity:1000,unitPrice:amount,note:''}],note:'合成计量依据'});
const settlement=(contractId,amount=1000,measurementId='')=>({title:'合成结算',contractId,measurementId,amount,dueDate:'2026-10-25',note:'合成结算依据'});
const cost=(settlementId,amount=1000)=>({title:'合成收支',direction:'expense',category:'subcontract',settlementId,amount,occurredDate:'2026-10-12',voucher:randomUUID(),note:'合成凭证'});
const variation=(contractId,extra={})=>({title:'合成自由签证',code:randomUUID(),contractId,changeType:'increase',amount:1000,occurredDate:'2026-10-12',note:'合成变更依据',...extra});
const approvedContract=async(f,extra={})=>f.approve(await f.item('contracts',contract(extra)));
const boqLine=(extra={})=>({code:randomUUID(),name:'沟槽土方',location:'K0+000测试段',unit:'立方米',quantity:10000,unitPrice:1000,...extra});
const requestLines=lines=>lines.map(({id,code,name,location,unit,quantity,unitPrice})=>({...(id?{id}:{}),code,name,location,unit,quantity,unitPrice}));
const getBoq=async(f,cookie=f.admin)=>{const result=await f.call('/engineering'+f.pb+'/boq',undefined,cookie);ok(result);return result.body;};
const getRevision=async(f,rid)=>(await getBoq(f)).revisions.find(r=>r.id===(typeof rid==='string'?rid:rid.id));
const getContractBoq=async(f,c)=>(await getBoq(f)).contracts.find(r=>r.contractId===(typeof c==='string'?c:c.id));
const createBoq=async(f,c,lines=[boqLine()],cookie=f.users.author.cookie)=>{
  const result=await f.post(f.pb+'/boq',{contractId:typeof c==='string'?c:c.id,title:'合成合同清单',note:'合成清单签认依据',lines},cookie);ok(result,201);return getRevision(f,result.body.id);
};
const transitionBoq=async(f,r,state,cookie=f.admin)=>{const current=await getRevision(f,r);return f.post(f.pb+'/boq/'+current.id+'/state',{version:current.version,state,note:'合成清单复核依据'},cookie);};
const approveBoq=async(f,r,cookie=f.admin)=>{ok(await transitionBoq(f,r,'submitted',f.users.author.cookie));ok(await transitionBoq(f,r,'approved',cookie));return getRevision(f,r);};
const editBoq=async(f,r,lines,cookie=f.users.author.cookie)=>{const current=await getRevision(f,r);return f.post(f.pb+'/boq/'+current.id,{version:current.version,title:current.title,note:'合成修订依据',lines},cookie,'PUT');};
const enableBoq=async(f,c,lines=[boqLine()])=>approveBoq(f,await createBoq(f,c,lines));
const boqMeasurement=(c,lines,extra={})=>({title:'清单工程量计量',code:randomUUID(),contractId:typeof c==='string'?c:c.id,periodStart:'2026-10-01',periodEnd:'2026-10-10',lines,note:'合成清单工程量依据',...extra});
const measureLine=(r,quantity,index=0)=>({boqItemId:r.lines[index].id,quantity,note:'本期实测合成数量'});

test('initial BOQ requires an approved unused contract and exact effective contract total',async t=>{
  const f=await fixture(t),draft=await f.item('contracts',contract());
  ok(await f.post(f.pb+'/boq',{contractId:draft.id,title:'合同未批准',note:'合成依据',lines:[boqLine()]},f.users.author.cookie),409);
  const c=await approvedContract(f),bad=await f.post(f.pb+'/boq',{contractId:c.id,title:'总額不符',note:'合成依据',lines:[boqLine({quantity:9999})]},f.users.author.cookie);ok(bad,409);
  assert.equal((await getBoq(f)).revisions.length,0);
  const change=await f.approve(await f.item('variations',variation(c.id,{amount:1000}))),baseline=await createBoq(f,c,[boqLine({quantity:11000})]);
  assert.equal(baseline.total,11000);assert.equal((await getContractBoq(f,c)).mode,'free');
  const original=f.source(c),approved=await approveBoq(f,baseline);assert.equal(approved.state,'approved');assert.equal((await getContractBoq(f,c)).mode,'boq');assert.deepEqual(f.source(c),original);assert.equal((await f.row(change)).voided,false);
  for(const kind of ['measurements','settlements','variations']){
    const other=await approvedContract(f),data=kind==='measurements'?freeMeasurement(other.id):kind==='settlements'?settlement(other.id):variation(other.id),pending=await f.item(kind,data);
    ok(await f.post(f.pb+'/boq',{contractId:other.id,title:'未清待办',note:'合成依据',lines:[boqLine()]},f.users.author.cookie),409);
    await f.cancel(pending);await enableBoq(f,other);
  }
  for(const kind of ['measurements','settlements']){
    const other=await approvedContract(f);await f.approve(await f.item(kind,kind==='measurements'?freeMeasurement(other.id):settlement(other.id)));
    ok(await f.post(f.pb+'/boq',{contractId:other.id,title:'历史有效业务不能重新启用',note:'合成依据',lines:[boqLine()]},f.users.author.cookie),409);
  }
});

test('BOQ validates bounded unique rows and server-owned amounts before saving any revision',async t=>{
  const f=await fixture(t),c=await approvedContract(f),valid=boqLine(),post=lines=>f.post(f.pb+'/boq',{contractId:c.id,title:'输入校验',note:'合成依据',lines},f.users.author.cookie);
  for(const lines of [[],Array.from({length:201},()=>boqLine()),[{...valid,amount:10000}],[{...valid,quantity:-1}],[{...valid,quantity:0.1}],[{...valid,quantity:1000000001}],[{...valid,unitPrice:0}],[{...valid,unitPrice:1000000000001}],[{...valid,code:''}],[{...valid,code:'x'.repeat(81)}],[{...valid,unit:'米'.repeat(31)}],[{...valid,unknown:true}]])ok(await post(lines),400);
  const duplicateId=randomUUID(),duplicate=await post([{...valid,id:duplicateId},{...valid,id:duplicateId}]);ok(duplicate,400);
  assert.equal((await getBoq(f)).revisions.length,0);
});

test('BOQ has financial project ACL and independent approval including its last editor',async t=>{
  const f=await fixture(t),c=await approvedContract(f),body={contractId:c.id,title:'隔离清单',note:'合成依据',lines:[boqLine()]};
  for(const actor of [f.users.engineer.cookie,f.users.viewer.cookie]){ok(await f.call('/engineering'+f.pb+'/boq',undefined,actor),403);ok(await f.post(f.pb+'/boq',body,actor),403);}
  ok(await f.call('/engineering'+f.pb+'/boq',undefined,f.users.outsider.cookie),404);ok(await f.post(f.pb+'/boq',body,f.users.outsider.cookie),404);
  const r=await createBoq(f,c,[boqLine()],f.users.finance.cookie);ok(await editBoq(f,r,requestLines(r.lines),f.admin));ok(await transitionBoq(f,r,'submitted',f.users.finance.cookie));
  ok(await transitionBoq(f,r,'approved',f.users.finance.cookie),403);ok(await transitionBoq(f,r,'approved',f.admin),409);ok(await transitionBoq(f,r,'approved',f.users.reviewer.cookie));
  const frozen=await getRevision(f,r);ok(await editBoq(f,r,requestLines(frozen.lines)),409);ok(await transitionBoq(f,r,'draft'),409);assert.deepEqual(await getRevision(f,r),frozen);
  const second=await approvedContract(f),own=await createBoq(f,second);ok(await transitionBoq(f,own,'submitted',f.users.author.cookie));ok(await transitionBoq(f,own,'approved',f.users.author.cookie),409);ok(await transitionBoq(f,own,'approved'));
});

test('BOQ mode requires referenced rows and measured settlements while legacy free contracts continue working',async t=>{
  const f=await fixture(t),c=await approvedContract(f),revision=await enableBoq(f,c);
  ok(await f.post(f.pb+'/items/measurements',{data:freeMeasurement(c.id)},f.users.author.cookie),400);
  ok(await f.post(f.pb+'/items/settlements',{data:settlement(c.id)},f.users.author.cookie),409);
  ok(await f.post(f.pb+'/items/variations',{data:variation(c.id)},f.users.author.cookie),409);
  for(const forged of [{unitPrice:1},{name:'自行变价'},{amount:1},{boqRevisionId:revision.id}])ok(await f.post(f.pb+'/items/measurements',{data:boqMeasurement(c,[{...measureLine(revision,1000),...forged}])},f.users.author.cookie),400);
  const m=await f.item('measurements',boqMeasurement(c,[measureLine(revision,2500)]));assert.equal(m.data.amount,2500);assert.equal(m.data.lines[0].unitPrice,1000);assert.equal(m.data.lines[0].name,revision.lines[0].name);assert.equal(m.data.lines[0].boqRevisionId,revision.id);
  await f.approve(m);await f.approve(await f.item('settlements',settlement(c.id,2500,m.id)));
  const free=await approvedContract(f),legacy=await f.approve(await f.item('measurements',freeMeasurement(free.id)));await f.approve(await f.item('settlements',settlement(free.id,1000)));assert.equal(legacy.data.amount,1000);assert.equal((await getContractBoq(f,free)).mode,'free');
  ok(await f.post(f.pb+'/items/measurements',{data:boqMeasurement(free,[measureLine(revision,1000)])},f.users.author.cookie),400);
});

test('BOQ enforces per-item quantities independently of contract amount and rejects duplicate or foreign references',async t=>{
  const f=await fixture(t),c=await approvedContract(f),r=await enableBoq(f,c,[boqLine({quantity:5000}),boqLine({quantity:5000})]);
  const duplicate=await f.post(f.pb+'/items/measurements',{data:boqMeasurement(c,[measureLine(r,1000),measureLine(r,1000)])},f.users.author.cookie);assert.ok([400,409].includes(duplicate.status),JSON.stringify(duplicate));
  const foreignContract=await approvedContract(f),other=await enableBoq(f,foreignContract);const foreign=await f.post(f.pb+'/items/measurements',{data:boqMeasurement(c,[measureLine(other,1000)])},f.users.author.cookie);assert.ok([400,409].includes(foreign.status),JSON.stringify(foreign));
  const over=await f.post(f.pb+'/items/measurements',{data:boqMeasurement(c,[measureLine(r,5001)])},f.users.author.cookie);ok(over,409);
  const first=await f.approve(await f.item('measurements',boqMeasurement(c,[measureLine(r,4000)])));assert.equal((await getContractBoq(f,c)).items[0].usedQuantity,4000);
  ok(await f.post(f.pb+'/items/measurements',{data:boqMeasurement(c,[measureLine(r,1001)])},f.users.author.cookie),409);
  const remaining=await f.approve(await f.item('measurements',boqMeasurement(c,[measureLine(r,1000),measureLine(r,5000,1)])));assert.equal((await f.row(c)).commercial.measurementAmount,10000);assert.equal(first.data.amount+remaining.data.amount,10000);
  assert.ok((await getContractBoq(f,c)).items.every(i=>i.remainingQuantity===0&&i.remainingAmount===0));
});

test('BOQ cumulative cent rounding permits zero-cent progress without changing free measurement rules',async t=>{
  const f=await fixture(t),c=await approvedContract(f,{amount:1}),r=await enableBoq(f,c,[boqLine({quantity:1000,unitPrice:1})]);
  const first=await f.approve(await f.item('measurements',boqMeasurement(c,[measureLine(r,500)])));assert.equal(first.data.amount,1);
  const second=await f.approve(await f.item('measurements',boqMeasurement(c,[measureLine(r,500)])));assert.equal(second.data.amount,0);assert.equal(second.data.lines[0].amount,0);
  const view=await getContractBoq(f,c);assert.equal(view.items[0].usedQuantity,1000);assert.equal(view.items[0].usedAmount,1);assert.equal((await f.row(c)).commercial.measurementAmount,1);
  const free=await approvedContract(f);const data=freeMeasurement(free.id,1);data.lines[0].quantity=1;ok(await f.post(f.pb+'/items/measurements',{data},f.users.author.cookie),400);
});

test('a changed BOQ quote rejects approval without rewriting submitted measurement originals',async t=>{
  const f=await fixture(t),c=await approvedContract(f,{amount:1}),r=await enableBoq(f,c,[boqLine({quantity:1000,unitPrice:1})]),data=boqMeasurement(c,[measureLine(r,500)]);
  const first=await f.item('measurements',data),second=await f.item('measurements',{...data,code:randomUUID()});
  ok(await f.transition(first,'submitted',f.users.author.cookie));ok(await f.transition(second,'submitted',f.users.author.cookie));const before=f.source(second);
  ok(await f.transition(first,'approved'));ok(await f.transition(second,'approved'),409);assert.deepEqual(f.source(second),before);assert.equal((await getContractBoq(f,c)).items[0].usedQuantity,500);
  ok(await f.transition(second,'draft'));ok(await f.edit(second,{...data,code:second.data.code}));assert.equal((await f.row(second)).data.amount,0);await f.approve(second);assert.equal((await getContractBoq(f,c)).items[0].usedQuantity,1000);
});

test('concurrent BOQ approvals cannot exceed the same item quantity even when each draft initially fits',async t=>{
  const f=await fixture(t),c=await approvedContract(f),r=await enableBoq(f,c),a=await f.item('measurements',boqMeasurement(c,[measureLine(r,6000)])),b=await f.item('measurements',boqMeasurement(c,[measureLine(r,6000)]));
  for(const m of [a,b])ok(await f.transition(m,'submitted',f.users.author.cookie));
  const replies=await Promise.all([a,b].map(m=>f.post(f.pb+'/items/'+m.id+'/state',{version:2,state:'approved',note:'并行量限复核'})));assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);
  assert.equal((await getContractBoq(f,c)).items[0].usedQuantity,6000);assert.equal((await f.row(c)).commercial.measurementAmount,6000);
});

test('BOQ full revisions preserve old identities and prices, allow zero-quantity retirement, and use new IDs for repricing',async t=>{
  const f=await fixture(t),c=await approvedContract(f),initial=await enableBoq(f,c),base=requestLines(initial.lines),post=lines=>f.post(f.pb+'/boq',{contractId:c.id,title:'全量修订',note:'合成变更依据',lines},f.users.author.cookie);
  for(const lines of [[boqLine()],base.map(i=>({...i,unit:'吨'})),base.map(i=>({...i,unitPrice:1001})),base.map(i=>({...i,id:randomUUID()}))]){const rejected=await post(lines);assert.ok([400,409].includes(rejected.status),JSON.stringify(rejected));}
  const revised=await createBoq(f,c,[{...base[0],quantity:0},boqLine({quantity:5000,unitPrice:2000})]);assert.notEqual(revised.lines[1].id,initial.lines[0].id);await approveBoq(f,revised);
  const current=await getContractBoq(f,c);assert.equal(current.currentRevisionId,revised.id);assert.equal(current.items.find(i=>i.id===initial.lines[0].id).quantity,0);assert.equal((await f.row(c)).commercial.effectiveAmount,10000);
  ok(await f.post(f.pb+'/items/measurements',{data:boqMeasurement(c,[measureLine(initial,1)])},f.users.author.cookie),409);
  const m=await f.approve(await f.item('measurements',boqMeasurement(c,[measureLine(revised,1000,1)])));assert.equal(m.data.amount,2000);assert.deepEqual((await getRevision(f,initial)).lines,initial.lines);
});

test('BOQ revision approval creates its signed delta atomically and locks independently managed variations',async t=>{
  const f=await fixture(t),c=await approvedContract(f),initial=await enableBoq(f,c),contractOriginal=f.source(c),revised=await createBoq(f,c,requestLines(initial.lines).map(i=>({...i,quantity:12000})));
  assert.equal(revised.delta,2000);assert.equal((await f.detail()).items.filter(i=>i.kind==='variations').length,0);await approveBoq(f,revised);
  const linked=(await f.detail()).items.filter(i=>i.kind==='variations'&&i.data.boqRevisionId===revised.id);assert.equal(linked.length,1);assert.equal(linked[0].state,'approved');assert.equal(linked[0].data.changeType,'increase');assert.equal(linked[0].data.amount,2000);assert.equal((await f.row(c)).commercial.effectiveAmount,12000);assert.deepEqual(f.source(c),contractOriginal);
  const pending=await createBoq(f,c,requestLines(revised.lines).map(i=>({...i,quantity:5000})));ok(await transitionBoq(f,pending,'submitted',f.users.author.cookie));
  await f.approve(await f.item('measurements',boqMeasurement(c,[measureLine(revised,6000)])));
  ok(await transitionBoq(f,pending,'approved'),409);assert.equal((await getContractBoq(f,c)).currentRevisionId,revised.id);assert.equal((await f.detail()).items.filter(i=>i.kind==='variations').length,1);assert.equal((await getRevision(f,pending)).state,'submitted');
  ok(await f.post(f.pb+'/items/variations',{data:variation(c.id)},f.users.author.cookie),409);
});

test('withdrawing measured business releases BOQ quantity while approved original data remains immutable',async t=>{
  const f=await fixture(t),c=await approvedContract(f),r=await enableBoq(f,c),m=await f.approve(await f.item('measurements',boqMeasurement(c,[measureLine(r,10000)]))),before=f.source(m);
  assert.equal((await getContractBoq(f,c)).items[0].remainingQuantity,0);await f.voidItem(m);assert.deepEqual(f.source(m),before);assert.equal((await getContractBoq(f,c)).items[0].usedQuantity,0);assert.equal((await getContractBoq(f,c)).items[0].usedAmount,0);
  const replacement=await f.approve(await f.item('measurements',boqMeasurement(c,[measureLine(r,10000)])));assert.equal(replacement.data.amount,10000);assert.equal((await f.row(c)).commercial.measurementAmount,10000);
});

test('linked variation correction follows revision and measurement dependencies then restores the previous BOQ without leaving BOQ mode',async t=>{
  const f=await fixture(t),c=await approvedContract(f),initial=await enableBoq(f,c),second=await enableBoq(f,c,requestLines(initial.lines).map(i=>({...i,quantity:12000}))),third=await enableBoq(f,c,requestLines(second.lines).map(i=>({...i,quantity:14000})));
  const linked=async rid=>(await f.detail()).items.find(i=>i.kind==='variations'&&i.data.boqRevisionId===rid);
  const v2=await linked(second.id),v3=await linked(third.id);ok(await f.correct(v2),409);
  const m=await f.approve(await f.item('measurements',boqMeasurement(c,[measureLine(third,1000)])));ok(await f.correct(v3),409);await f.voidItem(m);await f.voidItem(v3);
  assert.equal((await getContractBoq(f,c)).currentRevisionId,second.id);assert.equal((await getContractBoq(f,c)).mode,'boq');assert.equal((await f.row(c)).commercial.effectiveAmount,12000);
  await f.voidItem(v2);assert.equal((await getContractBoq(f,c)).currentRevisionId,initial.id);assert.equal((await f.row(c)).commercial.effectiveAmount,10000);assert.equal((await getContractBoq(f,c)).mode,'boq');
  ok(await f.post(f.pb+'/items/measurements',{data:freeMeasurement(c.id)},f.users.author.cookie),400);assert.deepEqual((await getRevision(f,third)).lines,third.lines);
});

test('pending BOQ changes block contract close and project completion and cannot mutate completed projects',async t=>{
  const f=await fixture(t),c=await approvedContract(f),r=await enableBoq(f,c),m=await f.approve(await f.item('measurements',boqMeasurement(c,[measureLine(r,10000)]))),s=await f.approve(await f.item('settlements',settlement(c.id,10000,m.id)));await f.approve(await f.item('costs',cost(s.id,10000)));
  const pending=await createBoq(f,c,requestLines(r.lines));ok(await f.transition(c,'closed'),409);ok(await f.post(f.pb+'/state',{version:2,state:'completed',note:'清单待办未完成'}),409);
  ok(await transitionBoq(f,pending,'cancelled',f.users.author.cookie));ok(await f.transition(c,'closed'));ok(await f.post(f.pb+'/state',{version:2,state:'completed',note:'业务闭环完成'}));
  ok(await f.post(f.pb+'/boq',{contractId:c.id,title:'完工后变更',note:'合成依据',lines:requestLines(r.lines)},f.users.author.cookie),409);ok(await f.post(f.pb+'/state',{version:3,state:'archived',note:'合成归档'}));assert.equal((await getContractBoq(f,c)).currentRevisionId,r.id);
});

test('BOQ request idempotency and frozen approvals survive SQLite reopening without duplicate signed deltas',async t=>{
  const f=await fixture(t,true),c=await approvedContract(f),r=await enableBoq(f,c),createPath='/engineering'+f.pb+'/boq',createBody={requestId:randomUUID(),contractId:c.id,title:'持久化修订',note:'重开数据库验证',lines:requestLines(r.lines).map(i=>({...i,quantity:12000}))};
  const first=await f.call(createPath,createBody,f.users.author.cookie);ok(first,201);const replay=await f.call(createPath,createBody,f.users.author.cookie);ok(replay,201);assert.equal(replay.body.id,first.body.id);assert.equal(replay.body.replayed,true);
  ok(await f.call(createPath,{...createBody,title:'同一请求改内容'},f.users.author.cookie),409);ok(await transitionBoq(f,first.body.id,'submitted',f.users.author.cookie));
  const reviewPath=createPath+'/'+first.body.id+'/state',reviewBody={requestId:randomUUID(),version:2,state:'approved',note:'持久化独立审批'};ok(await f.call(reviewPath,reviewBody,f.admin));const before=await getBoq(f);await f.restart();
  ok(await f.call(reviewPath,reviewBody,f.admin));assert.deepEqual(await getBoq(f),before);assert.equal((await f.detail()).items.filter(i=>i.data.boqRevisionId===first.body.id).length,1);
  ok(await f.call(reviewPath,{...reviewBody,requestId:randomUUID()},f.admin),409);
});

test('desktop and mobile BOQ use identical project permissions, CSRF and immediate membership revocation',async t=>{
  const f=await fixture(t),c=await approvedContract(f),path='/engineering'+f.pb+'/boq',body={requestId:randomUUID(),contractId:c.id,title:'移动清单',note:'合成移动依据',lines:[boqLine()]};
  ok(await f.call(path,body,f.admin,'POST',{'X-Workspace-Request':''}),403);
  const login=await f.call('/mobile/login',{username:'qa-author',password:f.password});ok(login);const headers={Authorization:'Bearer '+login.body.token},mobilePath='/mobile/engineering'+f.pb+'/boq';
  const created=await f.call(mobilePath,body,'','POST',headers);ok(created,201);const rid=created.body.id;
  ok(await f.call(mobilePath+'/'+rid+'/state',{requestId:randomUUID(),version:1,state:'submitted',note:'移动送审'},'','POST',headers));ok(await transitionBoq(f,rid,'approved'));
  ok(await f.call(mobilePath,undefined,'','GET',headers));ok(await f.post(f.pb+'/members',{userId:f.users.author.id,role:'remove'},f.admin,'PUT'));
  ok(await f.call(mobilePath,undefined,'','GET',headers),404);ok(await f.call(path,undefined,f.users.author.cookie),404);ok(await f.call(mobilePath,{...body,requestId:randomUUID()},'','POST',headers),404);
});

test('initial BOQ pending state blocks new free business and permits activation after proper historical corrections',async t=>{
  const f=await fixture(t),c=await approvedContract(f),initial=await createBoq(f,c);ok(await transitionBoq(f,initial,'submitted',f.users.author.cookie));
  ok(await f.post(f.pb+'/items/measurements',{data:freeMeasurement(c.id)},f.users.author.cookie),409);assert.equal((await getContractBoq(f,c)).mode,'free');assert.equal((await getRevision(f,initial)).state,'submitted');
  ok(await transitionBoq(f,initial,'approved'));assert.equal((await getContractBoq(f,c)).mode,'boq');
  const other=await approvedContract(f),oldMeasurement=await f.approve(await f.item('measurements',freeMeasurement(other.id))),oldSettlement=await f.approve(await f.item('settlements',settlement(other.id,1000)));
  await f.voidItem(oldSettlement);await f.voidItem(oldMeasurement);const enabled=await enableBoq(f,other);assert.equal((await getContractBoq(f,other)).currentRevisionId,enabled.id);assert.equal((await f.row(other)).commercial.measurementAmount,0);
});

test('BOQ activation checks cancellation and prevents cross-project contracts or reused foreign item identities',async t=>{
  const f=await fixture(t),c=await approvedContract(f),payload={contractId:c.id,title:'关联隔离',note:'合成依据',lines:[boqLine()]};
  const otherProject=await f.post('/projects',{data:{...f.projectData,code:randomUUID()}});ok(otherProject,201);const pb='/projects/'+otherProject.body.id;ok(await f.post(pb+'/state',{version:1,state:'active',note:'合成另一项目开工'}));
  const foreign=await f.post(pb+'/boq',payload);assert.ok([400,404].includes(foreign.status),JSON.stringify(foreign));
  const clientId=randomUUID(),supplied=await f.post(f.pb+'/boq',{...payload,lines:[boqLine({id:clientId})]},f.users.author.cookie);ok(supplied,201);const pending=await getRevision(f,supplied.body.id);assert.equal(pending.lines[0].id,clientId);
  const otherContract=await approvedContract(f);ok(await f.post(f.pb+'/boq',{...payload,contractId:otherContract.id,lines:requestLines(pending.lines)},f.users.author.cookie),400);
  ok(await transitionBoq(f,pending,'cancelled',f.users.author.cookie));assert.equal((await getContractBoq(f,c)).mode,'free');ok(await transitionBoq(f,pending,'submitted',f.users.author.cookie),409);
  await enableBoq(f,c);assert.equal((await getContractBoq(f,c)).mode,'boq');
});

test('a newer BOQ revision requires draft re-pricing before an earlier submitted measurement may be approved',async t=>{
  const f=await fixture(t),c=await approvedContract(f),r=await enableBoq(f,c),data=boqMeasurement(c,[measureLine(r,1000)]),m=await f.item('measurements',data);ok(await f.transition(m,'submitted',f.users.author.cookie));const before=f.source(m);
  const revised=await enableBoq(f,c,requestLines(r.lines).map(i=>({...i,quantity:12000})));ok(await f.transition(m,'approved'),409);assert.deepEqual(f.source(m),before);
  ok(await f.transition(m,'draft'));ok(await f.edit(m,data));assert.equal((await f.row(m)).data.lines[0].boqRevisionId,revised.id);await f.approve(m);assert.equal((await getContractBoq(f,c)).items[0].usedQuantity,1000);
});

test('correction approval rechecks newly created BOQ measurement dependencies before withdrawing its linked variation',async t=>{
  const f=await fixture(t),c=await approvedContract(f),r=await enableBoq(f,c),revised=await enableBoq(f,c,requestLines(r.lines).map(i=>({...i,quantity:12000}))),v=(await f.detail()).items.find(i=>i.kind==='variations'&&i.data.boqRevisionId===revised.id),request=await f.correct(v);ok(request,201);
  const m=await f.approve(await f.item('measurements',boqMeasurement(c,[measureLine(revised,1000)])));ok(await f.reviewCorrection(request.body.id),409);assert.equal((await f.row(v)).voided,false);assert.equal((await getContractBoq(f,c)).currentRevisionId,revised.id);
  await f.voidItem(m);ok(await f.reviewCorrection(request.body.id));assert.equal((await f.row(v)).voided,true);assert.equal((await getContractBoq(f,c)).currentRevisionId,r.id);
});

test('BOQ cumulative amounts remain nonnegative after withdrawing a prior rounded period',async t=>{
  const f=await fixture(t),c=await approvedContract(f,{amount:1}),r=await enableBoq(f,c,[boqLine({quantity:1000,unitPrice:1})]),first=await f.approve(await f.item('measurements',boqMeasurement(c,[measureLine(r,500)]))),zero=await f.approve(await f.item('measurements',boqMeasurement(c,[measureLine(r,500)])));
  assert.equal(zero.data.amount,0);await f.voidItem(first);assert.equal((await getContractBoq(f,c)).items[0].usedQuantity,500);assert.equal((await getContractBoq(f,c)).items[0].usedAmount,0);
  const replacement=await f.approve(await f.item('measurements',boqMeasurement(c,[measureLine(r,500)])));assert.equal(replacement.data.amount,1);assert.equal((await f.row(c)).commercial.measurementAmount,1);assert.equal((await getContractBoq(f,c)).items[0].remainingAmount,0);
});

test('desktop and mobile BOQ accept 200 maximum Chinese rows with escaped JSON on create and edit while retaining a body cap',async t=>{
  const f=await fixture(t),login=await f.call('/mobile/login',{username:'qa-author',password:f.password});ok(login);
  const escaped=body=>JSON.stringify(body).replace(/[\u007f-\uffff]/g,ch=>'\\u'+ch.charCodeAt(0).toString(16).padStart(4,'0'));
  const lines=Array.from({length:200},(_,index)=>({code:'编号'+String(index).padStart(3,'0')+'清'.repeat(75),name:'量'.repeat(200),location:'段'.repeat(200),unit:'米'.repeat(30),quantity:1000,unitPrice:1}));
  for(const mode of ['desktop','mobile']){
    const c=await approvedContract(f,{amount:200}),path=(mode==='mobile'?'/mobile':'')+'/engineering'+f.pb+'/boq',cookie=mode==='mobile'?'':f.users.author.cookie,headers=mode==='mobile'?{Authorization:'Bearer '+login.body.token}:{};
    const data={requestId:randomUUID(),contractId:c.id,title:'清'.repeat(200),note:'据'.repeat(2000),lines},raw=escaped(data);assert.ok(Buffer.byteLength(raw)>600*1024);assert.ok(Buffer.byteLength(raw)<1024*1024);
    const created=await f.call(path,raw,cookie,'POST',headers);ok(created,201);const revision=await getRevision(f,created.body.id);assert.equal(revision.lines.length,200);assert.equal(revision.total,200);assert.equal(revision.lines[199].code,lines[199].code);assert.equal(revision.title,data.title);assert.equal(revision.note,data.note);
    const update={requestId:randomUUID(),version:1,title:'改'.repeat(200),note:'核'.repeat(2000),lines:requestLines(revision.lines)},updateRaw=escaped(update);assert.ok(Buffer.byteLength(updateRaw)>600*1024);assert.ok(Buffer.byteLength(updateRaw)<1024*1024);
    ok(await f.call(path+'/'+revision.id,updateRaw,cookie,'PUT',headers));const after=await getRevision(f,revision.id);assert.equal(after.version,2);assert.equal(after.title,update.title);assert.deepEqual(after.lines,revision.lines);
    const oversized=escaped({...update,requestId:randomUUID(),version:2})+' '.repeat(1024*1024);ok(await f.call(path+'/'+revision.id,oversized,cookie,'PUT',headers),413);assert.equal((await getRevision(f,revision.id)).version,2);
  }
});
