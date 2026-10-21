import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {unzipSync,strFromU8} from 'fflate';
import {createApp} from '../server/app.mjs';

// Real HTTP routes, synthetic accounts and disposable SQLite files only. No production service is contacted.
const ok=(response,status=200)=>assert.equal(response.status,status,JSON.stringify(response.body));
async function fixture(t,persistent=false){
  const dir=persistent?mkdtempSync(join(tmpdir(),'engineering-value-plans-')):null;
  let server,state,url;
  const start=async()=>{server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+server.address().port;state=createApp({database:dir?join(dir,'test.sqlite'):':memory:',baseUrl:url,distPath:'__none__'});server.on('request',state.app);};
  const stop=async()=>{state.vision.close();server.closeAllConnections();await new Promise(r=>server.close(r));state.store.close();};
  await start();t.after(async()=>{await stop();if(dir){assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));assert.ok(dir.includes('engineering-value-plans-'));rmSync(dir,{recursive:true,force:true});}});
  const call=async(path,body,cookie='',method=body===undefined?'GET':'POST',headers={})=>{
    const response=await fetch(url+'/api'+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json','X-Workspace-Request':'1',...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
    const bytes=Buffer.from(await response.arrayBuffer());let parsed;try{parsed=JSON.parse(bytes.toString());}catch{parsed=bytes;}
    return {status:response.status,body:parsed,bytes,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const password='isolated-value-plans-test-123',setup=await call('/setup',{organization:'任务目标分配隔离验证',username:'qa-admin',name:'测试管理员',password});ok(setup,201);const admin=setup.cookie,users={};
  for(const name of ['author','reviewer','approver','finance','engineer','viewer','outsider']){
    ok(await call('/users',{username:'qa-'+name,name,role:name==='viewer'?'viewer':'operator',password},admin),201);
    const list=(await call('/users',undefined,admin)).body;users[name]={id:list.find(u=>u.name===name).id,cookie:(await call('/login',{username:'qa-'+name,password})).cookie};
  }
  const post=(path,body,cookie=admin,method='POST')=>call('/engineering'+path,{requestId:randomUUID(),...body},cookie,method);
  const projectData={code:randomUUID(),name:'任务目标分配合成项目',address:'本机隔离场所',owner:'测试负责人',startDate:'2026-10-01',dueDate:'2026-12-31',budget:1000000,note:'合成数据'};
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

const path=f=>f.pb+'/value-plans';
const readPlans=async(f,query='',cookie=f.admin)=>{const response=await f.call('/engineering'+path(f)+query,undefined,cookie);ok(response);return response.body;};
const readPlan=async(f,value)=>(await readPlans(f)).plans.find(row=>row.id===(typeof value==='string'?value:value.id));
const createPlan=async(f,body,cookie=f.users.author.cookie)=>{const response=await f.post(path(f),body,cookie);ok(response,201);return readPlan(f,response.body.id);};
const transitionPlan=async(f,value,state,cookie=f.users.author.cookie)=>{const current=await readPlan(f,value);return f.post(path(f)+'/'+current.id+'/state',{version:current.version,state,note:'合成目标分配独立复核'},cookie);};
const approvePlan=async(f,value,cookie=f.admin)=>{ok(await transitionPlan(f,value,'submitted'));ok(await transitionPlan(f,value,'approved',cookie));return readPlan(f,value);};
const editPlan=async(f,value,body,cookie=f.users.author.cookie)=>{const current=await readPlan(f,value);const {title,note,lines}=body;return f.post(path(f)+'/'+current.id,{version:current.version,title,note,lines},cookie,'PUT');};
const schedule=async(f,title='合成日期基线')=>{
  const request=await f.post(f.pb+'/baselines',{title,note:'合成计划日期冻结依据'},f.users.author.cookie);ok(request,201);
  ok(await f.post(f.pb+'/baselines/'+request.body.id+'/state',{version:1,state:'approved',note:'独立批准日期基线'},f.users.reviewer.cookie));return request.body.id;
};
const allocation=(revision,work,quantity,index=0)=>({boqItemId:revision.lines[index].id,taskId:typeof work==='string'?work:work.id,quantity});
const bodyFor=(c,revision,baseline,lines,extra={})=>({contractId:typeof c==='string'?c:c.id,boqRevisionId:revision.id,scheduleBaselineId:baseline,title:'合成任务目标分配',note:'按批准清单与施工日期完整分配',lines,...extra});
async function prepared(f,{works=2,boqLines=[boqLine()],contractExtra={},taskExtra={}}={}){
  const tasks=[];for(let i=0;i<works;i++)tasks.push(await task(f,{title:'合成分配任务 '+(i+1),...taskExtra}));
  const total=boqLines.reduce((sum,line)=>sum+Number((BigInt(line.quantity)*BigInt(line.unitPrice)+500n)/1000n),0);
  const c=await approvedContract(f,{amount:total,...contractExtra}),revision=await enableBoq(f,c,boqLines),baseline=await schedule(f);
  return {tasks,c,revision,baseline,body:bodyFor(c,revision,baseline,revision.lines.filter(line=>line.quantity>0).map(line=>({boqItemId:line.id,taskId:tasks[0].id,quantity:line.quantity})))};
}
const comparison=async(f,plan,asOf='2026-10-10')=>(await readPlans(f,'?planId='+(typeof plan==='string'?plan:plan.id)+'&asOf='+asOf)).comparison;
const sum=(rows,key)=>rows.reduce((value,row)=>value+row[key],0);
const lineMap=rows=>Object.fromEntries(rows.map(row=>[row.boqItemId+':'+row.taskId,row.amount]));

test('value-plan inputs reject client-owned snapshots, duplicate assignments and invalid bounded quantities',async t=>{
  const f=await fixture(t),p=await prepared(f),one=allocation(p.revision,p.tasks[0],1000);
  for(const extra of [{amount:1000},{unitPrice:1000},{taskTitle:'伪造任务'},{startDate:'2026-10-01'},{unit:'伪造单位'}])ok(await f.post(path(f),{...p.body,lines:[{...one,...extra}]}),400);
  for(const extra of [{snapshot:{}},{totalAmount:10000},{allocatedAmount:1000}])ok(await f.post(path(f),{...p.body,...extra}),400);
  for(const quantity of [0,-1,0.5,1000000001,'1000',null])ok(await f.post(path(f),{...p.body,lines:[{...one,quantity}]}),400);
  ok(await f.post(path(f),{...p.body,lines:[]}),400);ok(await f.post(path(f),{...p.body,lines:Array.from({length:501},()=>one)}),400);
  ok(await f.post(path(f),{...p.body,lines:[one,one]}),400);
  const draft=await createPlan(f,{...p.body,lines:[one]});assert.equal(draft.state,'draft');assert.equal(draft.snapshot.totalAmount,10000);assert.equal(draft.snapshot.allocatedAmount,1000);assert.equal(draft.snapshot.remainingAmount,9000);assert.equal(sum(draft.snapshot.lines,'quantity'),1000);
  ok(await transitionPlan(f,draft,'submitted'),409);assert.equal((await readPlan(f,draft)).state,'draft');
});

test('submission requires full allocation of every positive BOQ item and never allocates retired zero-quantity items',async t=>{
  const f=await fixture(t),p=await prepared(f,{boqLines:[boqLine({quantity:3000,unitPrice:1000}),boqLine({quantity:2000,unitPrice:1000}),boqLine({quantity:0,unitPrice:1000})]});
  const partial=bodyFor(p.c,p.revision,p.baseline,[allocation(p.revision,p.tasks[0],3000)]),draft=await createPlan(f,partial);
  ok(await transitionPlan(f,draft,'submitted'),409);
  const complete=bodyFor(p.c,p.revision,p.baseline,[allocation(p.revision,p.tasks[0],1000),allocation(p.revision,p.tasks[1],2000),allocation(p.revision,p.tasks[0],2000,1)]);
  ok(await editPlan(f,draft,complete));const saved=await readPlan(f,draft);assert.equal(saved.snapshot.totalAmount,5000);assert.equal(saved.snapshot.allocatedAmount,5000);assert.equal(saved.snapshot.remainingAmount,0);
  await approvePlan(f,draft);assert.equal((await comparison(f,draft)).summary.targetAmount,5000);
});

test('allocation uses deterministic cumulative cents with zero-cent target quantities and no dependence on submitted order',async t=>{
  const f=await fixture(t),p=await prepared(f,{works:3,boqLines:[boqLine({quantity:1000,unitPrice:1})]});
  const lines=p.tasks.map((work,index)=>allocation(p.revision,work,[333,333,334][index]));
  const draft=await createPlan(f,{...p.body,lines});assert.equal(draft.snapshot.totalAmount,1);assert.equal(sum(draft.snapshot.lines,'amount'),1);assert.equal(sum(draft.snapshot.lines,'quantity'),1000);assert.equal(draft.snapshot.lines.filter(line=>line.amount===0).length,2);
  const before=lineMap(draft.snapshot.lines);ok(await editPlan(f,draft,{...p.body,lines:[...lines].reverse()}));const reordered=await readPlan(f,draft);assert.deepEqual(lineMap(reordered.snapshot.lines),before);
  const approved=await approvePlan(f,draft);assert.deepEqual(approved.snapshot,reordered.snapshot);const report=await comparison(f,draft);assert.equal(report.summary.targetAmount,1);assert.equal(report.summary.plannedAmount,1);
});

test('value-plan approval is independent from creator and last editor while approved source snapshots are immutable',async t=>{
  const f=await fixture(t),p=await prepared(f),draft=await createPlan(f,p.body,f.users.finance.cookie);
  ok(await editPlan(f,draft,p.body,f.users.reviewer.cookie));ok(await transitionPlan(f,draft,'submitted',f.users.finance.cookie));const frozen=(await readPlan(f,draft)).snapshot;
  ok(await transitionPlan(f,draft,'approved',f.users.finance.cookie),403);ok(await transitionPlan(f,draft,'approved',f.users.reviewer.cookie),409);ok(await transitionPlan(f,draft,'approved',f.users.author.cookie));
  const approved=await readPlan(f,draft);assert.deepEqual(approved.snapshot,frozen);
  ok(await editPlan(f,draft,p.body),409);for(const state of ['rejected','submitted','cancelled'])ok(await transitionPlan(f,draft,state),409);assert.deepEqual((await readPlan(f,draft)).snapshot,frozen);
});

test('financial permissions protect both value-plan endpoints and keep the existing public date baseline free of amounts',async t=>{
  const f=await fixture(t),p=await prepared(f),draft=await createPlan(f,{...p.body,title:'保密目标分配_761239'});await approvePlan(f,draft);
  ok(await f.call('/engineering'+path(f)),401);ok(await f.call('/engineering'+path(f),undefined,f.users.outsider.cookie),404);
  for(const who of ['engineer','viewer']){
    ok(await f.call('/engineering'+path(f),undefined,f.users[who].cookie),403);ok(await f.post(path(f),p.body,f.users[who].cookie),403);
    ok(await editPlan(f,draft,p.body,f.users[who].cookie),403);ok(await transitionPlan(f,draft,'draft',f.users[who].cookie),403);
    const publicPlan=await f.call('/engineering'+f.pb+'/baselines',undefined,f.users[who].cookie);ok(publicPlan);assert.equal(JSON.stringify(publicPlan.body).includes('761239'),false);for(const key of ['unitPrice','targetAmount','allocatedAmount','totalAmount'])assert.equal(JSON.stringify(publicPlan.body).includes('"'+key+'"'),false);
    const detail=await f.detail(f.users[who].cookie);assert.equal(JSON.stringify(detail).includes('761239'),false);
  }
  for(const who of ['author','reviewer','finance'])await readPlans(f,'',f.users[who].cookie);
  const login=await f.call('/mobile/login',{username:'qa-finance',password:f.password});ok(login);const headers={Authorization:'Bearer '+login.body.token};
  ok(await f.call('/mobile/engineering'+path(f),undefined,'','GET',headers));ok(await f.post(f.pb+'/members',{userId:f.users.finance.id,role:'remove'},f.admin,'PUT'));
  ok(await f.call('/mobile/engineering'+path(f),undefined,'','GET',headers),404);ok(await f.call('/engineering'+path(f),undefined,f.users.finance.cookie),404);
  const siteLogin=await f.call('/mobile/login',{username:'qa-engineer',password:f.password});ok(siteLogin);ok(await f.call('/mobile/engineering'+path(f),undefined,'','GET',{Authorization:'Bearer '+siteLogin.body.token}),403);
});

test('new plans require current approved BOQ and date baseline and reject foreign project contract task or source identities',async t=>{
  const f=await fixture(t),work=await task(f),c=await approvedContract(f),fake=bodyFor(c,{id:randomUUID()},randomUUID(),[{boqItemId:randomUUID(),taskId:work.id,quantity:1000}]);
  ok(await f.post(path(f),fake),409);const revision=await enableBoq(f,c);ok(await f.post(path(f),{...fake,boqRevisionId:revision.id,lines:[allocation(revision,work,10000)]}),409);
  const baseline=await schedule(f),body=bodyFor(c,revision,baseline,[allocation(revision,work,10000)]);
  const foreign=await f.post('/projects',{data:{...f.projectData,code:randomUUID()}});ok(foreign,201);const foreignBase='/projects/'+foreign.body.id;ok(await f.post(foreignBase+'/state',{version:1,state:'active',note:'独立另一项目'}));
  const foreignTask=await f.post(foreignBase+'/items/tasks',{data:taskData()});ok(foreignTask,201);
  for(const taskId of [foreignTask.body.id,c.id,randomUUID()])ok(await f.post(path(f),{...body,lines:[{...body.lines[0],taskId}]}),400);
  ok(await f.post(path(f),{...body,lines:[{...body.lines[0],boqItemId:randomUUID()}]}),400);
  ok(await f.post(foreignBase+'/value-plans',body),400);
  const pending=await f.post(f.pb+'/baselines',{title:'尚未批准日期',note:'只读来源须已批准'},f.users.author.cookie);ok(pending,201);ok(await f.post(path(f),{...body,scheduleBaselineId:pending.body.id}),409);
  const plan=await createPlan(f,body);ok(await f.call('/engineering'+foreignBase+'/value-plans?planId='+plan.id,undefined,f.admin),404);ok(await f.post(foreignBase+'/value-plans/'+plan.id+'/state',{version:1,state:'submitted',note:'跨项目应拒绝'}),404);
  ok(await f.call('/engineering'+path(f)+'?contractId='+randomUUID(),undefined,f.admin),404);ok(await f.call('/engineering'+path(f)+'?asOf=2026-02-30',undefined,f.admin),400);ok(await f.call('/engineering'+path(f)+'?unexpected=1',undefined,f.admin),400);
});

test('allocation rejects item overbooking and retired lines and supports the complete 500-pair boundary',async t=>{
  const f=await fixture(t),p=await prepared(f,{works:5,boqLines:Array.from({length:100},(_,index)=>boqLine({code:'BOUNDARY-'+index,quantity:5000,unitPrice:1000}))});
  const over=bodyFor(p.c,p.revision,p.baseline,[allocation(p.revision,p.tasks[0],3000),allocation(p.revision,p.tasks[1],2001)]);ok(await f.post(path(f),over),400);
  const lines=p.revision.lines.flatMap(line=>p.tasks.map(work=>({boqItemId:line.id,taskId:work.id,quantity:1000})));assert.equal(lines.length,500);
  const draft=await createPlan(f,{...p.body,title:'最大有效500行分配',lines});assert.equal(draft.snapshot.lines.length,500);assert.equal(draft.snapshot.remainingAmount,0);assert.equal(draft.snapshot.allocatedAmount,500000);await approvePlan(f,draft);
  const report=await comparison(f,draft);assert.equal(report.lines.length,500);assert.equal(report.summary.targetAmount,500000);assert.equal(report.tasks.length,5);
});

test('one pending plan per contract and optimistic versions hold under simultaneous requests and independent contracts',async t=>{
  const f=await fixture(t),p=await prepared(f);const created=await Promise.all([f.post(path(f),p.body,f.users.author.cookie),f.post(path(f),p.body,f.users.finance.cookie)]);
  assert.deepEqual(created.map(r=>r.status).sort(),[201,409]);const draft=await readPlan(f,created.find(r=>r.status===201).body.id);
  const edits=await Promise.all(['甲','乙'].map(title=>f.post(path(f)+'/'+draft.id,{version:1,title,note:p.body.note,lines:p.body.lines},f.users.author.cookie,'PUT')));assert.deepEqual(edits.map(r=>r.status).sort(),[200,409]);
  ok(await f.post(path(f)+'/'+draft.id+'/state',{version:1,state:'submitted',note:'过期版本'},f.users.author.cookie),409);ok(await transitionPlan(f,draft,'submitted'));
  const current=await readPlan(f,draft),approvals=await Promise.all([f.users.reviewer.cookie,f.admin].map(cookie=>f.post(path(f)+'/'+draft.id+'/state',{version:current.version,state:'approved',note:'并发独立批准'},cookie)));
  assert.deepEqual(approvals.map(r=>r.status).sort(),[200,409]);assert.equal((await readPlan(f,draft)).approved_seq,1);
  const replacement=await createPlan(f,p.body);ok(await f.post(path(f),p.body),409);ok(await transitionPlan(f,replacement,'submitted'));ok(await f.post(path(f),p.body),409);
  const c2=await approvedContract(f),r2=await enableBoq(f,c2);const other=await createPlan(f,bodyFor(c2,r2,p.baseline,[allocation(r2,p.tasks[0],10000)]));assert.notEqual(other.id,replacement.id);
  ok(await transitionPlan(f,replacement,'rejected',f.users.reviewer.cookie));const after=await createPlan(f,p.body);assert.equal(after.state,'draft');ok(await transitionPlan(f,after,'cancelled'));assert.equal((await readPlans(f)).contracts.find(c=>c.contractId===p.c.id).currentPlanId,draft.id);
});

test('submission and approval reject BOQ or date-baseline replacement without changing the frozen draft or submitted snapshot',async t=>{
  const f=await fixture(t),p=await prepared(f),first=await createPlan(f,p.body),frozen=first.snapshot;
  const newRevision=await approveBoq(f,await createBoq(f,p.c,requestLines(p.revision.lines).map(line=>({...line,quantity:12000}))));
  ok(await transitionPlan(f,first,'submitted'),409);assert.deepEqual((await readPlan(f,first)).snapshot,frozen);assert.ok((await readPlan(f,first)).drift.reasons.some(r=>r.code==='boq_changed'));ok(await transitionPlan(f,first,'cancelled'));
  ok(await f.post(path(f),p.body),409);const currentBody=bodyFor(p.c,newRevision,p.baseline,[allocation(newRevision,p.tasks[0],12000)]),second=await createPlan(f,currentBody);ok(await transitionPlan(f,second,'submitted'));const submitted=(await readPlan(f,second)).snapshot;
  const newBaseline=await schedule(f,'新版日期基线');ok(await transitionPlan(f,second,'approved',f.users.reviewer.cookie),409);assert.deepEqual((await readPlan(f,second)).snapshot,submitted);assert.ok((await readPlan(f,second)).drift.reasons.some(r=>r.code==='baseline_changed'));
  ok(await transitionPlan(f,second,'cancelled'));ok(await f.post(path(f),currentBody),409);const fresh=await createPlan(f,{...currentBody,scheduleBaselineId:newBaseline});await approvePlan(f,fresh);
});

test('task plan edits cancellation addition and project dates make targets stale while progress and ordinary construction states do not',async t=>{
  const f=await fixture(t),p=await prepared(f),draft=await createPlan(f,p.body);ok(await transitionPlan(f,draft,'submitted'));const frozen=(await readPlan(f,draft)).snapshot;
  for(const change of [{title:'改名'}, {location:'改施工段'}, {owner:'调整责任人'}, {startDate:'2026-10-02'}, {dueDate:'2026-10-11'}]){
    ok(await f.edit(p.tasks[0],{...p.tasks[0].data,...change}));ok(await transitionPlan(f,draft,'approved',f.users.reviewer.cookie),409);assert.deepEqual((await readPlan(f,draft)).snapshot,frozen);ok(await f.edit(p.tasks[0],p.tasks[0].data));
  }
  let project=(await f.detail()).project;ok(await f.post(f.pb,{version:project.version,data:{...project.data,dueDate:'2027-01-01'}},f.admin,'PUT'));ok(await transitionPlan(f,draft,'approved',f.users.reviewer.cookie),409);
  project=(await f.detail()).project;ok(await f.post(f.pb,{version:project.version,data:f.projectData},f.admin,'PUT'));
  const extra=await task(f,{title:'基线之外新增任务'});ok(await transitionPlan(f,draft,'approved',f.users.reviewer.cookie),409);ok(await f.transition(extra,'cancelled',f.users.author.cookie));
  ok(await f.transition(p.tasks[0],'active',f.users.author.cookie));ok(await f.reportProgress(p.tasks[0],100));ok(await f.transition(p.tasks[0],'completed',f.users.author.cookie));ok(await transitionPlan(f,draft,'approved',f.users.reviewer.cookie));assert.deepEqual((await readPlan(f,draft)).snapshot,frozen);assert.equal((await readPlan(f,draft)).drift.changed,false);
  const second=await createPlan(f,p.body);ok(await transitionPlan(f,second,'submitted'));ok(await f.transition(p.tasks[1],'cancelled',f.users.author.cookie));ok(await transitionPlan(f,second,'approved',f.users.reviewer.cookie),409);assert.ok((await readPlan(f,second)).drift.reasons.some(r=>r.code==='task_cancelled'));
});

test('asOf changes only inclusive calendar planned values and always retains latest observed actual measurements',async t=>{
  const f=await fixture(t);let project=(await f.detail()).project;ok(await f.post(f.pb,{version:project.version,data:{...project.data,startDate:'2028-01-01',dueDate:'2028-12-31'}},f.admin,'PUT'));
  const p=await prepared(f,{works:1,boqLines:[boqLine({quantity:1000,unitPrice:1000})],taskExtra:{startDate:'2028-02-28',dueDate:'2028-03-01'}}),plan=await approvePlan(f,await createPlan(f,p.body));
  const actual=await f.approve(await f.item('measurements',measurement(p.c,[{...measureLine(p.revision,750),taskId:p.tasks[0].id}])));
  for(const [asOf,expected] of [['2028-02-27',0],['2028-02-28',333],['2028-02-29',667],['2028-03-01',1000],['2028-03-02',1000]]){
    const result=await readPlans(f,'?planId='+plan.id+'&asOf='+asOf),report=result.comparison;assert.equal(report.lines[0].plannedQuantity,expected);assert.equal(report.summary.plannedAmount,expected);assert.equal(report.summary.actualAmount,750);assert.equal(report.summary.varianceAmount,750-expected);assert.equal(report.lines[0].plannedQuantityVariance,750-expected);assert.equal(report.lines[0].quantityVariance,-250);assert.equal(report.sources[0].measurementId,actual.id);assert.ok(Number.isFinite(Date.parse(result.actualObservedAt)));
  }
  assert.equal((await f.row(p.tasks[0])).data.progress,0);await f.voidItem(actual);assert.equal((await comparison(f,plan,'2028-02-28')).summary.actualAmount,0);assert.equal((await comparison(f,plan,'2028-02-28')).summary.plannedAmount,333);
});

test('latest actuals match contract item and task, expose outside causes, and allow a task target overrun inside BOQ capacity',async t=>{
  const f=await fixture(t),p=await prepared(f,{works:3,boqLines:[boqLine({name:'同名工作',unit:'米',quantity:10000}),boqLine({name:'同名工作',unit:'平方米',quantity:4000})]});
  const body={...p.body,lines:[allocation(p.revision,p.tasks[0],6000),allocation(p.revision,p.tasks[1],4000),allocation(p.revision,p.tasks[0],4000,1)]},plan=await approvePlan(f,await createPlan(f,body));
  const measure=async(qty,work,index=0)=>f.approve(await f.item('measurements',measurement(p.c,[{...measureLine(p.revision,qty,index),...(work?{taskId:work.id}:{})}])));
  const above=await measure(7000,p.tasks[0]),otherUnit=await measure(1000,p.tasks[0],1),outsideTask=await measure(1000,p.tasks[2]),unassigned=await measure(500,null);
  const otherContract=await approvedContract(f,{direction:'income'});await f.approve(await f.item('measurements',measurement(otherContract,[line({quantity:1000,unitPrice:5000,taskId:p.tasks[0].id})])));
  let report=await comparison(f,plan);assert.equal(report.summary.actualAmount,8000);assert.equal(report.summary.outsideAmount,1500);assert.equal(report.summary.totalActualAmount,9500);assert.equal(report.lines.find(l=>l.taskId===p.tasks[0].id&&l.unit==='米').quantityVariance,1000);assert.equal(report.lines.find(l=>l.unit==='平方米').actualQuantity,1000);assert.equal(report.tasks.some(row=>'quantity'in row||'actualQuantity'in row),false);
  assert.deepEqual(report.outside.map(row=>[row.measurementId,row.outsideReason]).sort(),[[outsideTask.id,'task_not_in_plan'],[unassigned.id,'unassigned']].sort());assert.deepEqual(report.sources.map(row=>row.measurementId).sort(),[above.id,otherUnit.id].sort());
  const changed=await approveBoq(f,await createBoq(f,p.c,[...requestLines(p.revision.lines),boqLine({name:'新增清单工程',quantity:1000})]));const added=changed.lines.find(l=>!p.revision.lines.some(original=>original.id===l.id));
  const extra=await f.approve(await f.item('measurements',measurement(p.c,[{boqItemId:added.id,quantity:1000,taskId:p.tasks[0].id}])));report=await comparison(f,plan);assert.equal(report.outside.find(row=>row.measurementId===extra.id).outsideReason,'item_not_in_plan');assert.equal(report.summary.totalActualAmount,10500);assert.equal(report.drift.changed,true);assert.equal(report.summary.targetAmount,14000);
});

test('actual cents stay on their original tasks even when target allocation assigns its rounding cent elsewhere',async t=>{
  const f=await fixture(t),p=await prepared(f,{works:2,boqLines:[boqLine({quantity:1000,unitPrice:1})]});const sorted=[...p.tasks].sort((a,b)=>a.id.localeCompare(b.id));
  const plan=await approvePlan(f,await createPlan(f,{...p.body,lines:sorted.map(work=>allocation(p.revision,work,500))}));
  const first=await f.approve(await f.item('measurements',measurement(p.c,[{...measureLine(p.revision,500),taskId:sorted[1].id}]))),second=await f.approve(await f.item('measurements',measurement(p.c,[{...measureLine(p.revision,500),taskId:sorted[0].id}])));
  assert.equal(first.data.amount,1);assert.equal(second.data.amount,0);let report=await comparison(f,plan);assert.equal(report.summary.targetAmount,1);assert.equal(report.summary.actualAmount,1);assert.equal(sum(report.lines,'actualQuantity'),1000);
  assert.deepEqual(report.lines.map(l=>[l.taskId,l.targetAmount,l.actualAmount,l.actualQuantity]).sort(),[[sorted[0].id,1,0,500],[sorted[1].id,0,1,500]].sort());
  await f.voidItem(first);report=await comparison(f,plan);assert.equal(report.summary.actualAmount,0);assert.equal(report.lines.find(l=>l.taskId===sorted[0].id).actualQuantity,500);assert.equal(report.lines.find(l=>l.taskId===sorted[0].id).sourceCount,1);
  const replacement=await f.approve(await f.item('measurements',measurement(p.c,[{...measureLine(p.revision,500),taskId:sorted[0].id}])));assert.equal(replacement.data.amount,1);report=await comparison(f,plan);assert.equal(report.summary.actualAmount,1);assert.equal(report.lines.find(l=>l.taskId===sorted[0].id).actualQuantity,1000);assert.equal(report.lines.find(l=>l.taskId===sorted[0].id).quantityVariance,500);
});

test('draft pending cancelled and correction-under-review sources do not distort effective actuals or immutable measurement originals',async t=>{
  const f=await fixture(t),p=await prepared(f),plan=await approvePlan(f,await createPlan(f,p.body));const make=()=>f.item('measurements',measurement(p.c,[{...measureLine(p.revision,1000),taskId:p.tasks[0].id}]));
  const draft=await make(),pending=await make(),cancelled=await make(),approved=await f.approve(await make());ok(await f.transition(pending,'submitted',f.users.author.cookie));await f.cancel(cancelled);
  assert.equal((await comparison(f,plan)).summary.actualAmount,1000);const original=f.source(approved),request=await f.correct(approved);ok(request,201);assert.equal((await comparison(f,plan)).summary.actualAmount,1000);ok(await f.reviewCorrection(request.body.id));assert.equal((await comparison(f,plan)).summary.actualAmount,0);assert.deepEqual(f.source(approved),original);
  await f.cancel(draft);await f.cancel(pending);const replacement=await f.approve(await make());const report=await comparison(f,plan);assert.equal(report.summary.actualAmount,1000);assert.equal(report.sources.length,1);assert.equal(report.sources[0].measurementId,replacement.id);
});

test('approved history remains selectable after source drift and newer targets without adding historical versions together',async t=>{
  const f=await fixture(t),p=await prepared(f),first=await approvePlan(f,await createPlan(f,p.body)),frozen=first.snapshot;
  ok(await f.edit(p.tasks[0],{...p.tasks[0].data,title:'新版任务',startDate:'2026-10-03',dueDate:'2026-10-12'}));let old=await readPlans(f,'?planId='+first.id);assert.equal(old.comparison.drift.changed,true);assert.equal(old.selectedPlan.snapshot.lines[0].taskTitle,p.tasks[0].data.title);assert.equal(old.selectedPlan.snapshot.lines[0].startDate,'2026-10-01');
  const baseline=await schedule(f,'调整后的施工日期'),second=await approvePlan(f,await createPlan(f,{...p.body,scheduleBaselineId:baseline,lines:[allocation(p.revision,p.tasks[1],10000)],title:'第二版完整目标'}));
  const report=await readPlans(f,'?contractId='+p.c.id);assert.equal(report.selectedPlanId,second.id);assert.equal(report.contracts.find(c=>c.contractId===p.c.id).currentPlanId,second.id);assert.equal(report.comparison.summary.targetAmount,10000);assert.equal(report.plans.length,2);assert.ok(second.approved_seq>first.approved_seq);
  old=await readPlans(f,'?planId='+first.id);assert.deepEqual(old.selectedPlan.snapshot,frozen);assert.equal(old.comparison.summary.targetAmount,10000);assert.equal(old.comparison.drift.changed,true);assert.equal((await readPlans(f,'?planId='+second.id)).comparison.drift.changed,false);
});

test('pending target plans block settled contract close and legacy project completion until cancelled',async t=>{
  const f=await fixture(t),p=await prepared(f,{works:1}),draft=await createPlan(f,p.body);
  const measured=await f.approve(await f.item('measurements',measurement(p.c,[{...measureLine(p.revision,10000),taskId:p.tasks[0].id}]))),settled=await f.approve(await f.item('settlements',settlement(p.c.id,10000,measured.id)));await f.approve(await f.item('costs',cost(settled.id,10000)));
  ok(await f.transition(p.tasks[0],'active',f.users.author.cookie));ok(await f.reportProgress(p.tasks[0],100));ok(await f.transition(p.tasks[0],'completed',f.users.author.cookie));
  const close=await f.transition(p.c,'closed');ok(close,409);assert.match(JSON.stringify(close.body),/目标/);
  // Simulate a legacy import that already closed its otherwise fully settled contract.
  f.store.db.prepare("UPDATE engineering_items SET state='closed' WHERE id=?").run(p.c.id);const project=(await f.detail()).project;
  ok(await f.post(f.pb+'/state',{version:project.version,state:'completed',note:'只剩目标待办仍不能完成'}),409);ok(await transitionPlan(f,draft,'cancelled'));ok(await f.post(f.pb+'/state',{version:project.version,state:'completed',note:'取消目标待办后完工'}));
  ok(await f.post(path(f),p.body),409);await readPlans(f);const completed=(await f.detail()).project;ok(await f.post(f.pb+'/state',{version:completed.version,state:'archived',note:'合成归档'}));ok(await f.post(path(f),p.body),409);await readPlans(f);
});

test('create submit approval receipts and exact frozen snapshots survive SQLite reopening without duplicate sequences or history',async t=>{
  const f=await fixture(t,true),p=await prepared(f),createBody={requestId:randomUUID(),...p.body},created=await f.call('/engineering'+path(f),createBody,f.users.author.cookie);ok(created,201);const vid=created.body.id;
  const replay=await f.call('/engineering'+path(f),createBody,f.users.author.cookie);ok(replay,201);assert.equal(replay.body.id,vid);assert.equal(replay.body.replayed,true);ok(await f.call('/engineering'+path(f),{...createBody,title:'同号不同内容'},f.users.author.cookie),409);
  const statePath='/engineering'+path(f)+'/'+vid+'/state',submit={requestId:randomUUID(),version:1,state:'submitted',note:'幂等提交'},approve={requestId:randomUUID(),version:2,state:'approved',note:'幂等独立批准'};
  ok(await f.call(statePath,submit,f.users.author.cookie));ok(await f.call(statePath,approve,f.users.reviewer.cookie));const source={...f.store.db.prepare('SELECT * FROM engineering_value_plans WHERE id=?').get(vid)},history=(await f.detail()).history.length;
  await f.restart();assert.deepEqual({...f.store.db.prepare('SELECT * FROM engineering_value_plans WHERE id=?').get(vid)},source);
  for(const [route,body,cookie,status] of [['/engineering'+path(f),createBody,f.users.author.cookie,201],[statePath,submit,f.users.author.cookie,200],[statePath,approve,f.users.reviewer.cookie,200]]){const result=await f.call(route,body,cookie);ok(result,status);assert.equal(result.body.replayed,true);}
  const view=await readPlans(f);assert.equal(view.plans.length,1);assert.equal(view.selectedPlanId,vid);assert.equal(view.selectedPlan.approved_seq,1);assert.equal(view.comparison.summary.targetAmount,10000);assert.equal((await f.detail()).history.length,history);
  ok(await f.call(statePath,{...approve,requestId:randomUUID()},f.users.reviewer.cookie),409);
});

test('mobile create submit and independent review follow the same financial policy and immediate reviewer revocation',async t=>{
  const f=await fixture(t),p=await prepared(f),login=await f.call('/mobile/login',{username:'qa-finance',password:f.password});ok(login);const headers={Authorization:'Bearer '+login.body.token},mobilePath='/mobile/engineering'+path(f);
  const request=await f.call(mobilePath,{requestId:randomUUID(),...p.body},'','POST',headers);ok(request,201);const vid=request.body.id;
  ok(await f.call(mobilePath+'/'+vid+'/state',{requestId:randomUUID(),version:1,state:'submitted',note:'移动端合成提交'},'','POST',headers));
  const reviewerLogin=await f.call('/mobile/login',{username:'qa-reviewer',password:f.password});ok(reviewerLogin);const reviewerHeaders={Authorization:'Bearer '+reviewerLogin.body.token};ok(await f.post(f.pb+'/members',{userId:f.users.reviewer.id,role:'finance'},f.admin,'PUT'));
  ok(await f.call(mobilePath+'/'+vid+'/state',{requestId:randomUUID(),version:2,state:'approved',note:'撤掉经理权限立即生效'},'','POST',reviewerHeaders),403);
  ok(await f.post(f.pb+'/members',{userId:f.users.reviewer.id,role:'manager'},f.admin,'PUT'));ok(await f.call(mobilePath+'/'+vid+'/state',{requestId:randomUUID(),version:2,state:'approved',note:'经理独立批准'},'','POST',reviewerHeaders));
  assert.equal((await readPlans(f)).selectedPlanId,vid);ok(await f.post(f.pb+'/members',{userId:f.users.reviewer.id,role:'remove'},f.admin,'PUT'));ok(await f.call(mobilePath,undefined,'','GET',reviewerHeaders),404);
});

function workbook(bytes){
  const archive=unzipSync(bytes),xml=name=>strFromU8(archive[name]),decode=value=>value.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
  const names=[...xml('xl/workbook.xml').matchAll(/<sheet name="([^"]+)"/g)].map(match=>decode(match[1]));
  const rows=name=>{
    const index=names.indexOf(name);assert.ok(index>=0,'Missing worksheet '+name);
    return [...xml('xl/worksheets/sheet'+(index+1)+'.xml').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(row=>[...row[1].matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>/g)].map(cell=>{const n=cell[1].match(/<v>([^<]*)<\/v>/);return n?Number(n[1]):decode(cell[1].match(/<t\b[^>]*>([\s\S]*?)<\/t>/)?.[1]||'');}));
  };
  const records=name=>{const [keys,...data]=rows(name);return data.map(values=>Object.fromEntries(keys.map((key,index)=>[key,values[index]])));};
  return {archive,names,records};
}

test('desktop and mobile HTTP exports contain 21 sheets with all target history current comparisons and explicit outside actuals',async t=>{
  const f=await fixture(t),p=await prepared(f),first=await approvePlan(f,await createPlan(f,{...p.body,title:'历史目标版本'}));
  await f.approve(await f.item('measurements',measurement(p.c,[{...measureLine(p.revision,1000),taskId:p.tasks[0].id}])));
  const second=await approvePlan(f,await createPlan(f,{...p.body,title:'当前目标版本',lines:[allocation(p.revision,p.tasks[1],10000)]}));
  const inside=await f.approve(await f.item('measurements',measurement(p.c,[{...measureLine(p.revision,1000),taskId:p.tasks[1].id}]))),unassigned=await f.approve(await f.item('measurements',measurement(p.c,[measureLine(p.revision,500)])));
  const login=await f.call('/mobile/login',{username:'qa-finance',password:f.password});ok(login);
  for(const [route,cookie,headers] of [['/engineering'+f.pb+'/export',f.users.finance.cookie,{}],['/mobile/engineering'+f.pb+'/export','',{Authorization:'Bearer '+login.body.token}]]){
    const response=await f.call(route,undefined,cookie,'GET',headers);ok(response);const book=workbook(response.bytes);assert.equal(book.names.length,21);
    const versions=book.records('目标版本'),allocations=book.records('目标分配'),compared=book.records('目标对比'),outside=book.records('目标外计量');
    assert.deepEqual(versions.map(row=>row['目标方案ID']).sort(),[first.id,second.id].sort());assert.equal(versions.filter(row=>row['当前已批目标']==='是').length,1);assert.equal(versions.find(row=>row['当前已批目标']==='是')['目标方案ID'],second.id);
    assert.equal(allocations.length,2);assert.equal(compared.length,1);assert.equal(compared[0]['目标方案ID'],second.id);assert.equal(compared[0]['目标金额（元）'],100);assert.equal(compared[0]['最新有效已批金额（元）'],10);assert.equal(compared[0]['最新有效已批数量'],1);
    assert.equal(outside.length,2);assert.equal(outside.reduce((total,row)=>total+row['有效已批金额（元）'],0),15);assert.ok(outside.some(row=>row['计量ID']===unassigned.id&&row['目标外原因']==='计量未归属任务'));assert.equal(outside.some(row=>row['计量ID']===inside.id),false);assert.ok(outside.every(row=>row['目标方案ID']===second.id));
    const allXml=Object.values(book.archive).map(bytes=>strFromU8(bytes)).join('\n');assert.equal(allXml.includes(f.password),false);assert.equal(/<f(?:\s|>)/.test(allXml),false);assert.equal(Object.keys(book.archive).some(name=>/vbaProject|externalLink/i.test(name)),false);
  }
  ok(await f.call('/engineering'+f.pb+'/export',undefined,f.users.engineer.cookie),403);ok(await f.call('/engineering'+f.pb+'/export',undefined,f.users.viewer.cookie),403);
});
