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
  const dir=persistent?mkdtempSync(join(tmpdir(),'engineering-task-value-')):null;
  let server,state,url;
  const start=async()=>{server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+server.address().port;state=createApp({database:dir?join(dir,'test.sqlite'):':memory:',baseUrl:url,distPath:'__none__'});server.on('request',state.app);};
  const stop=async()=>{state.vision.close();server.closeAllConnections();await new Promise(r=>server.close(r));state.store.close();};
  await start();t.after(async()=>{await stop();if(dir){assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));assert.ok(dir.includes('engineering-task-value-'));rmSync(dir,{recursive:true,force:true});}});
  const call=async(path,body,cookie='',method=body===undefined?'GET':'POST',headers={})=>{
    const response=await fetch(url+'/api'+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json','X-Workspace-Request':'1',...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
    const bytes=Buffer.from(await response.arrayBuffer());let parsed;try{parsed=JSON.parse(bytes.toString());}catch{parsed=bytes;}
    return {status:response.status,body:parsed,bytes,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const password='isolated-task-value-test-123',setup=await call('/setup',{organization:'任务计量产值隔离验证',username:'qa-admin',name:'测试管理员',password});ok(setup,201);const admin=setup.cookie,users={};
  for(const name of ['author','reviewer','approver','finance','engineer','viewer','outsider']){
    ok(await call('/users',{username:'qa-'+name,name,role:name==='viewer'?'viewer':'operator',password},admin),201);
    const list=(await call('/users',undefined,admin)).body;users[name]={id:list.find(u=>u.name===name).id,cookie:(await call('/login',{username:'qa-'+name,password})).cookie};
  }
  const post=(path,body,cookie=admin,method='POST')=>call('/engineering'+path,{requestId:randomUUID(),...body},cookie,method);
  const projectData={code:randomUUID(),name:'任务计量产值合成项目',address:'本机隔离场所',owner:'测试负责人',startDate:'2026-10-01',dueDate:'2026-12-31',budget:1000000,note:'合成数据'};
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
  const reportProgress=async(item,progress)=>{const current=await row(item);const request=await post(pb+'/progress',{taskId:current.id,taskVersion:current.version,effectiveDate:'2026-10-01',progress,note:'合成日期进度填报'},users.author.cookie);ok(request,201);return post(pb+'/progress/'+request.body.id+'/state',{version:1,state:'approved',note:'独立复核合成进度'},users.reviewer.cookie);};
  const correct=(item,cookie=users.finance.cookie)=>post(pb+'/corrections',{targetId:typeof item==='string'?item:item.id,note:'核对原件后申请撤销'},cookie);
  const reviewCorrection=(cid,cookie=users.reviewer.cookie)=>post(pb+'/corrections/'+cid+'/state',{version:1,state:'approved',note:'独立复核纠错依据'},cookie);
  const voidItem=async item=>{const request=await correct(item);ok(request,201);ok(await reviewCorrection(request.body.id));return row(item);};
  const source=item=>({...state.store.db.prepare('SELECT * FROM engineering_items WHERE id=?').get(typeof item==='string'?item:item.id)});
  return {call,post,admin,users,password,pid,pb,projectData,detail,row,item,transition,approve,cancel,edit,reportProgress,correct,reviewCorrection,voidItem,source,get store(){return state.store;},restart:async()=>{await stop();await start();}};
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

const taskData=(extra={})=>({title:'合成开挖任务',location:'K0+000任务段',owner:'合成土方班组',startDate:'2026-10-01',dueDate:'2026-10-10',predecessorId:'',progress:0,note:'合成计划说明',...extra});
const task=async(f,extra={})=>f.item('tasks',taskData(extra));
const line=(extra={})=>({name:'沟槽开挖',location:'K0+000计量段',unit:'立方米',quantity:1000,unitPrice:1000,note:'合成实测依据',...extra});
const measurement=(c,lines,extra={})=>boqMeasurement(c,lines,extra);
const values=async(f,cookie=f.admin)=>{const result=await f.call('/engineering'+f.pb+'/task-values',undefined,cookie);ok(result);return result.body;};
const taskValue=(report,work)=>report.tasks.find(r=>r.taskId===(typeof work==='string'?work:work.id));
const stableReport=({observedAt,...report})=>report;

test('measurement lines capture server task identity on save and preserve it when the task changes before approval',async t=>{
  const f=await fixture(t),c=await approvedContract(f),work=await task(f),input=measurement(c,[line({taskId:work.id})]);
  for(const forged of [{taskTitle:'伪造任务名称'},{taskLocation:'伪造任务部位'}])ok(await f.post(f.pb+'/items/measurements',{data:measurement(c,[line({taskId:work.id,...forged})])},f.users.author.cookie),400);
  const m=await f.item('measurements',input);assert.equal(m.data.lines[0].taskId,work.id);assert.equal(m.data.lines[0].taskTitle,work.data.title);assert.equal(m.data.lines[0].taskLocation,work.data.location);
  ok(await f.edit(work,{...work.data,title:'更名后的开挖任务',location:'新施工段'}));ok(await f.transition(m,'submitted',f.users.author.cookie));const before=f.source(m);ok(await f.transition(m,'approved'));
  const approved=await f.row(m);assert.deepEqual(approved.data,JSON.parse(before.data));assert.equal(approved.data.lines[0].taskTitle,work.data.title);assert.equal((await f.row(work)).data.progress,0);
  ok(await f.edit(m,measurement(c,[line({taskId:work.id})])),409);assert.equal((await f.row(m)).data.lines[0].taskLocation,work.data.location);
  const report=await values(f);assert.equal(taskValue(report,work).title,'更名后的开挖任务');assert.equal(taskValue(report,work).location,'新施工段');assert.equal(report.sources.find(s=>s.measurementId===m.id).taskTitle,work.data.title);assert.equal(report.sources.find(s=>s.measurementId===m.id).taskLocation,work.data.location);
});

test('task references require a same-project task and reject cancelled tasks and client-owned snapshot fields',async t=>{
  const f=await fixture(t),c=await approvedContract(f),cancelled=await task(f);ok(await f.transition(cancelled,'cancelled',f.users.author.cookie));
  const otherProject=await f.post('/projects',{data:{...f.projectData,code:randomUUID()}});ok(otherProject,201);const otherBase='/projects/'+otherProject.body.id;ok(await f.post(otherBase+'/state',{version:1,state:'active',note:'合成另项目开工'}));
  const otherTask=await f.post(otherBase+'/items/tasks',{data:taskData()});ok(otherTask,201);
  for(const taskId of [otherTask.body.id,c.id,randomUUID()])ok(await f.post(f.pb+'/items/measurements',{data:measurement(c,[line({taskId})])},f.users.author.cookie),400);
  ok(await f.post(f.pb+'/items/measurements',{data:measurement(c,[line({taskId:cancelled.id})])},f.users.author.cookie),409);
  for(const taskId of ['not-a-uuid',null,2])ok(await f.post(f.pb+'/items/measurements',{data:measurement(c,[line({taskId})])},f.users.author.cookie),400);
  const activeTask=await task(f),r=await enableBoq(f,c);
  for(const taskId of [otherTask.body.id,c.id])ok(await f.post(f.pb+'/items/measurements',{data:measurement(c,[{...measureLine(r,1000),taskId}])},f.users.author.cookie),400);
  ok(await f.post(f.pb+'/items/measurements',{data:measurement(c,[{...measureLine(r,1000),taskId:activeTask.id,taskTitle:'伪造'}])},f.users.author.cookie),400);
});

test('draft submitted and effective approved measurements block task cancellation until cancelled or corrected',async t=>{
  const f=await fixture(t),c=await approvedContract(f),work=await task(f),m=await f.item('measurements',measurement(c,[line({taskId:work.id})]));
  ok(await f.transition(work,'cancelled',f.users.author.cookie),409);ok(await f.transition(m,'submitted',f.users.author.cookie));ok(await f.transition(work,'cancelled',f.users.author.cookie),409);ok(await f.transition(m,'approved'));ok(await f.transition(work,'cancelled',f.users.author.cookie),409);
  await f.voidItem(m);ok(await f.transition(work,'cancelled',f.users.author.cookie));assert.equal((await f.row(m)).voided,true);assert.equal((await f.row(work)).state,'cancelled');
  const spare=await task(f),draft=await f.item('measurements',measurement(c,[line({taskId:spare.id})]));await f.cancel(draft);ok(await f.transition(spare,'cancelled',f.users.author.cookie));
});

test('completed tasks accept supplemental measurements without changing manually reported task progress',async t=>{
  const f=await fixture(t),c=await approvedContract(f),work=await task(f);ok(await f.transition(work,'active',f.users.author.cookie));ok(await f.reportProgress(work,100));ok(await f.transition(work,'completed',f.users.author.cookie));const source=f.source(work);
  const m=await f.approve(await f.item('measurements',measurement(c,[line({taskId:work.id})])));assert.equal(m.data.lines[0].taskId,work.id);assert.deepEqual(f.source(work),source);
});

test('task association changes only while measurement is editable and does not accept frozen fields back from clients',async t=>{
  const f=await fixture(t),c=await approvedContract(f),first=await task(f),second=await task(f,{title:'第二任务'}),m=await f.item('measurements',measurement(c,[line({taskId:first.id})]));
  ok(await f.edit(m,measurement(c,[line({taskId:second.id})],{code:m.data.code})));const changed=await f.row(m);assert.equal(changed.data.lines[0].taskId,second.id);assert.equal(changed.data.lines[0].taskTitle,second.data.title);
  ok(await f.edit(m,changed.data),400);ok(await f.transition(first,'cancelled',f.users.author.cookie));ok(await f.transition(second,'cancelled',f.users.author.cookie),409);
  ok(await f.transition(m,'submitted',f.users.author.cookie));ok(await f.edit(m,measurement(c,[line({taskId:''})],{code:m.data.code})),409);ok(await f.transition(m,'approved'));ok(await f.edit(m,measurement(c,[line({taskId:''})],{code:m.data.code})),409);
});

test('legacy or imported stale task references are rechecked on submit and approval without rewriting source snapshots',async t=>{
  const f=await fixture(t),c=await approvedContract(f),work=await task(f),m=await f.item('measurements',measurement(c,[line({taskId:work.id})]));
  // Imported old data may not have passed the new cancellation guard; live approval must still reject it.
  f.store.db.prepare("UPDATE engineering_items SET state='cancelled' WHERE id=?").run(work.id);const before=f.source(m);ok(await f.transition(m,'submitted',f.users.author.cookie),409);assert.deepEqual(f.source(m),before);
  f.store.db.prepare("UPDATE engineering_items SET state='planned' WHERE id=?").run(work.id);ok(await f.transition(m,'submitted',f.users.author.cookie));f.store.db.prepare("UPDATE engineering_items SET state='cancelled' WHERE id=?").run(work.id);const submitted=f.source(m);ok(await f.transition(m,'approved'),409);assert.deepEqual(f.source(m),submitted);
});

test('task values count only approved effective lines and reconcile assigned and unassigned values by contract direction',async t=>{
  const f=await fixture(t),expense=await approvedContract(f),income=await approvedContract(f,{direction:'income'}),first=await task(f),unused=await task(f,{title:'未计量任务'});
  const draft=await f.item('measurements',measurement(expense,[line({taskId:first.id,unitPrice:777})])),submitted=await f.item('measurements',measurement(expense,[line({taskId:first.id,unitPrice:888})]));ok(await f.transition(submitted,'submitted',f.users.author.cookie));
  const cancelled=await f.item('measurements',measurement(expense,[line({taskId:first.id,unitPrice:999})]));await f.cancel(cancelled);
  const out=await f.approve(await f.item('measurements',measurement(expense,[line({taskId:first.id,unitPrice:1000}),line({unitPrice:300}),line({taskId:'',unitPrice:200})]))),earned=await f.approve(await f.item('measurements',measurement(income,[line({taskId:first.id,unitPrice:2000}),line({unitPrice:700})])));
  const report=await values(f);assert.equal(report.projectId,f.pid);assert.ok(!Number.isNaN(Date.parse(report.observedAt)));
  assert.deepEqual(report.summary.expense,{assignedAmount:1000,unassignedAmount:500,totalAmount:1500});assert.deepEqual(report.summary.income,{assignedAmount:2000,unassignedAmount:700,totalAmount:2700});
  const firstView=taskValue(report,first);assert.equal(firstView.expenseAmount,1000);assert.equal(firstView.incomeAmount,2000);assert.equal(firstView.sourceCount,5);assert.equal(firstView.effectiveSourceCount,2);assert.equal(firstView.progress,0);
  assert.equal(taskValue(report,unused).sourceCount,0);assert.equal(taskValue(report,unused).expenseAmount,0);assert.deepEqual(taskValue(report,unused).quantityGroups,[]);
  for(const row of [draft,submitted,cancelled]){const source=report.sources.find(s=>s.measurementId===row.id);assert.equal(source.effectiveAmount,0);assert.equal(source.effectiveQuantity,0);assert.equal(source.amount,row.data.amount);}
  assert.equal(report.sources.length,8);assert.equal(report.unassigned.length,3);assert.ok(report.unassigned.every(s=>!s.taskId));
  assert.equal(report.sources.filter(s=>[out.id,earned.id].includes(s.measurementId)).reduce((sum,s)=>sum+s.effectiveAmount,0),4200);
  const detailed=(await f.detail()).taskValues;assert.deepEqual(stableReport(detailed),stableReport(report));
});

test('task quantity groups keep different contracts directions items and units separate',async t=>{
  const f=await fixture(t),work=await task(f),first=await approvedContract(f),second=await approvedContract(f),income=await approvedContract(f,{direction:'income'}),r=await enableBoq(f,first,[boqLine({quantity:5000}),boqLine({quantity:5000,unit:'米'})]);
  await f.approve(await f.item('measurements',measurement(first,[{...measureLine(r,1000),taskId:work.id},{...measureLine(r,2000,1),taskId:work.id}])));
  await f.approve(await f.item('measurements',measurement(second,[line({taskId:work.id,quantity:3000})])));await f.approve(await f.item('measurements',measurement(income,[line({taskId:work.id,quantity:4000})])));
  const report=await values(f),groups=taskValue(report,work).quantityGroups;assert.equal(groups.length,4);
  for(const [cid,boqItemId,direction,unit,quantity,amount] of [[first.id,r.lines[0].id,'expense','立方米',1000,1000],[first.id,r.lines[1].id,'expense','米',2000,2000],[second.id,'','expense','立方米',3000,3000],[income.id,'','income','立方米',4000,4000]]){
    const group=groups.find(g=>g.contractId===cid&&g.boqItemId===boqItemId&&g.direction===direction&&g.unit===unit);assert.ok(group,JSON.stringify(groups));assert.equal(group.quantity,quantity);assert.equal(group.amount,amount);assert.equal(group.sourceCount,1);
  }
  assert.equal(taskValue(report,work).expenseAmount,6000);assert.equal(taskValue(report,work).incomeAmount,4000);
});

test('different task assignments cannot duplicate one BOQ item within a measurement or evade concurrent quantity limits',async t=>{
  const f=await fixture(t),c=await approvedContract(f),r=await enableBoq(f,c),first=await task(f),second=await task(f,{title:'第二责任任务'});
  ok(await f.post(f.pb+'/items/measurements',{data:measurement(c,[{...measureLine(r,1000),taskId:first.id},{...measureLine(r,1000),taskId:second.id}])},f.users.author.cookie),400);
  const a=await f.item('measurements',measurement(c,[{...measureLine(r,6000),taskId:first.id}])),b=await f.item('measurements',measurement(c,[{...measureLine(r,6000),taskId:second.id}]));for(const m of [a,b])ok(await f.transition(m,'submitted',f.users.author.cookie));
  const approved=await Promise.all([a,b].map(m=>f.post(f.pb+'/items/'+m.id+'/state',{version:2,state:'approved',note:'并发任务计量复核'})));assert.deepEqual(approved.map(r=>r.status).sort(),[200,409]);
  const report=await values(f);assert.equal(report.summary.expense.assignedAmount,6000);assert.equal(report.tasks.reduce((sum,r)=>sum+r.expenseAmount,0),6000);assert.equal(report.sources.reduce((sum,s)=>sum+s.effectiveQuantity,0),6000);
});

test('concurrent task cancellation and measurement creation cannot leave a live claim linked to a cancelled task',async t=>{
  const f=await fixture(t),c=await approvedContract(f),work=await task(f);
  const responses=await Promise.all([
    f.post(f.pb+'/items/measurements',{data:measurement(c,[line({taskId:work.id})])},f.users.author.cookie),
    f.post(f.pb+'/items/'+work.id+'/state',{version:work.version,state:'cancelled',note:'并发取消任务'},f.users.author.cookie),
  ]);
  assert.equal(responses.filter(r=>r.status>=200&&r.status<300).length,1);assert.equal(responses.filter(r=>r.status===409).length,1);
  const current=await f.row(work),claims=(await f.detail()).items.filter(r=>r.kind==='measurements');if(current.state==='cancelled')assert.equal(claims.length,0);else{assert.equal(current.state,'planned');assert.equal(claims.length,1);assert.equal(claims[0].data.lines[0].taskId,work.id);}
});

test('BOQ task value allocation preserves cumulative rounding across tasks and includes zero-cent approved quantities',async t=>{
  const f=await fixture(t),c=await approvedContract(f,{amount:1}),r=await enableBoq(f,c,[boqLine({quantity:1000,unitPrice:1})]),a=await task(f),b=await task(f,{title:'尾差归属第二任务'});
  const first=await f.approve(await f.item('measurements',measurement(c,[{...measureLine(r,500),taskId:a.id}]))),second=await f.approve(await f.item('measurements',measurement(c,[{...measureLine(r,500),taskId:b.id}])));
  assert.equal(first.data.amount,1);assert.equal(second.data.amount,0);let report=await values(f);assert.equal(report.summary.expense.assignedAmount,1);assert.equal(taskValue(report,a).expenseAmount,1);assert.equal(taskValue(report,b).expenseAmount,0);assert.equal(taskValue(report,b).effectiveSourceCount,1);assert.equal(taskValue(report,b).quantityGroups[0].quantity,500);assert.equal(taskValue(report,b).quantityGroups[0].amount,0);
  const original=f.source(first);await f.voidItem(first);report=await values(f);assert.equal(report.summary.expense.assignedAmount,0);assert.equal(taskValue(report,a).sourceCount,1);assert.equal(taskValue(report,a).effectiveSourceCount,0);assert.deepEqual(f.source(first),original);assert.equal(taskValue(report,b).quantityGroups[0].quantity,500);
  await f.approve(await f.item('measurements',measurement(c,[{...measureLine(r,500),taskId:a.id}])));report=await values(f);assert.equal(report.summary.expense.assignedAmount,1);assert.equal(taskValue(report,a).sourceCount,2);assert.equal(taskValue(report,a).effectiveSourceCount,1);
});

test('correction states affect task values only after approval and leave original attributed history intact',async t=>{
  const f=await fixture(t),c=await approvedContract(f),work=await task(f),m=await f.approve(await f.item('measurements',measurement(c,[line({taskId:work.id})]))),original=f.source(m),request=await f.correct(m);ok(request,201);
  assert.equal(taskValue(await values(f),work).expenseAmount,1000);ok(await f.post(f.pb+'/corrections/'+request.body.id+'/state',{version:1,state:'rejected',note:'原量核对无误'},f.users.reviewer.cookie));assert.equal(taskValue(await values(f),work).expenseAmount,1000);
  const withdrawn=await f.correct(m);ok(withdrawn,201);ok(await f.post(f.pb+'/corrections/'+withdrawn.body.id+'/state',{version:1,state:'cancelled',note:'申请人撤回纠错'},f.users.finance.cookie));assert.equal(taskValue(await values(f),work).expenseAmount,1000);
  await f.voidItem(m);let report=await values(f);assert.equal(taskValue(report,work).expenseAmount,0);assert.equal(report.sources[0].amount,1000);assert.equal(report.sources[0].effectiveAmount,0);assert.equal(report.sources[0].effectiveQuantity,0);assert.equal(report.sources[0].voided,true);assert.deepEqual(f.source(m),original);
  await f.approve(await f.item('measurements',measurement(c,[line({taskId:work.id,quantity:500})])));report=await values(f);assert.equal(taskValue(report,work).expenseAmount,500);assert.equal(taskValue(report,work).sourceCount,2);assert.equal(taskValue(report,work).effectiveSourceCount,1);
});

test('older measurement JSON with no task fields remains readable and contributes only to unassigned values',async t=>{
  const f=await fixture(t),c=await approvedContract(f),unused=await task(f),m=await f.approve(await f.item('measurements',freeMeasurement(c.id)));
  const old={...m.data,lines:m.data.lines.map(({taskId,taskTitle,taskLocation,...rest})=>rest)};f.store.db.prepare('UPDATE engineering_items SET data=? WHERE id=?').run(JSON.stringify(old),m.id);const before=f.source(m);
  const report=await values(f);assert.equal(report.summary.expense.assignedAmount,0);assert.equal(report.summary.expense.unassignedAmount,1000);assert.equal(report.unassigned.length,1);assert.equal(report.unassigned[0].taskId,'');assert.equal(report.unassigned[0].taskTitle,'');assert.equal(taskValue(report,unused).sourceCount,0);assert.deepEqual(f.source(m),before);
  // New explicit empty task IDs are equivalent to missing historical association, and neither is auto-assigned.
  await f.approve(await f.item('measurements',measurement(c,[line({taskId:''})])));assert.equal((await values(f)).summary.expense.unassignedAmount,2000);
});

test('task values never replace manual progress or enter publicly readable frozen baseline plans',async t=>{
  const f=await fixture(t),c=await approvedContract(f),work=await task(f);ok(await f.transition(work,'active',f.users.author.cookie));ok(await f.reportProgress(work,35));const taskBefore=f.source(work);
  const request=await f.post(f.pb+'/baselines',{title:'手工进度与产值分离',note:'冻结日期，保留人工填报'},f.users.author.cookie);ok(request,201);ok(await f.post(f.pb+'/baselines/'+request.body.id+'/state',{version:1,state:'approved',note:'独立冻结计划'},f.users.reviewer.cookie));const baselineBefore={...f.store.db.prepare('SELECT * FROM engineering_baselines WHERE id=?').get(request.body.id)};
  await f.approve(await f.item('measurements',measurement(c,[line({taskId:work.id,unitPrice:4567})])));assert.deepEqual(f.source(work),taskBefore);assert.equal(taskValue(await values(f),work).progress,35);assert.deepEqual({...f.store.db.prepare('SELECT * FROM engineering_baselines WHERE id=?').get(request.body.id)},baselineBefore);
  const baseline=await f.call('/engineering'+f.pb+'/baselines?asOf=2026-09-01',undefined,f.users.engineer.cookie);ok(baseline);assert.equal(baseline.body.comparison.summary.plannedProgress,0);assert.equal(baseline.body.comparison.summary.actualProgress,35);assert.equal(JSON.stringify(baseline.body).includes('4567'),false);assert.equal(JSON.stringify(baseline.body).includes('expenseAmount'),false);assert.equal(JSON.stringify(baseline.body).includes('taskValues'),false);
});

test('task-value financial permissions cover detail direct GET and mobile authorization with immediate revocation',async t=>{
  const f=await fixture(t),c=await approvedContract(f),work=await task(f);await f.approve(await f.item('measurements',measurement(c,[line({taskId:work.id,unitPrice:7654})])));
  for(const actor of [f.admin,f.users.author.cookie,f.users.finance.cookie])assert.equal((await values(f,actor)).summary.expense.assignedAmount,7654);
  for(const actor of [f.users.engineer.cookie,f.users.viewer.cookie]){
    ok(await f.call('/engineering'+f.pb+'/task-values',undefined,actor),403);const detail=await f.detail(actor);assert.equal(detail.taskValues,null);assert.equal(detail.items.some(r=>r.kind==='measurements'),false);assert.equal(JSON.stringify(detail).includes('7654'),false);
  }
  ok(await f.call('/engineering'+f.pb+'/task-values',undefined,f.users.outsider.cookie),404);
  const logged=await f.call('/mobile/login',{username:'qa-finance',password:f.password});ok(logged);const headers={Authorization:'Bearer '+logged.body.token},path='/mobile/engineering'+f.pb+'/task-values';
  const before=await f.call(path,undefined,'','GET',headers);ok(before);assert.equal(before.body.summary.expense.assignedAmount,7654);
  ok(await f.post(f.pb+'/members',{userId:f.users.finance.id,role:'remove'},f.admin,'PUT'));ok(await f.call(path,undefined,'','GET',headers),404);ok(await f.call('/engineering'+f.pb+'/task-values',undefined,f.users.finance.cookie),404);
  const engineer=await f.call('/mobile/login',{username:'qa-engineer',password:f.password});ok(engineer);ok(await f.call(path,undefined,'','GET',{Authorization:'Bearer '+engineer.body.token}),403);
});

test('idempotent measurement approval and SQLite reopening preserve one source per line without duplicate task value',async t=>{
  const f=await fixture(t,true),c=await approvedContract(f),work=await task(f),createPath='/engineering'+f.pb+'/items/measurements',createBody={requestId:randomUUID(),data:measurement(c,[line({taskId:work.id})])};
  const created=await f.call(createPath,createBody,f.users.author.cookie);ok(created,201);const replay=await f.call(createPath,createBody,f.users.author.cookie);ok(replay,201);assert.equal(replay.body.id,created.body.id);assert.equal(replay.body.replayed,true);
  ok(await f.transition(created.body.id,'submitted',f.users.author.cookie));const approvePath='/engineering'+f.pb+'/items/'+created.body.id+'/state',approveBody={requestId:randomUUID(),version:2,state:'approved',note:'独立批准任务计量'};ok(await f.call(approvePath,approveBody,f.admin));ok(await f.call(approvePath,approveBody,f.admin));
  const before=await values(f);assert.equal(before.sources.length,1);assert.equal(taskValue(before,work).sourceCount,1);assert.equal(taskValue(before,work).expenseAmount,1000);await f.restart();ok(await f.call(approvePath,approveBody,f.admin));assert.deepEqual(stableReport(await values(f)),stableReport(before));
  ok(await f.call(approvePath,{...approveBody,requestId:randomUUID()},f.admin),409);assert.equal((await values(f)).sources.length,1);
});


