import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {createApp} from '../server/app.mjs';

// Every scenario uses synthetic users and an isolated database. No production URL or data.
const fixture=async t=>{
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const baseUrl='http://127.0.0.1:'+server.address().port;
  const {app,store,vision}=createApp({database:':memory:',baseUrl,distPath:'__none__'});server.on('request',app);
  t.after(async()=>{vision.close();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();});
  const call=async(path,body,cookie='',method=body===undefined?'GET':'POST',extra={})=>{
    const r=await fetch(baseUrl+'/api'+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json','X-Workspace-Request':'1',...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const raw=await r.text();let bodyOut;try{bodyOut=JSON.parse(raw);}catch{bodyOut={raw};}
    return {status:r.status,body:bodyOut,cookie:r.headers.get('set-cookie')?.split(';')[0]};
  };
  const admin=(await call('/setup',{organization:'冲销隔离验证',username:'qa-admin',name:'管理员',password:'test-isolated-only-123'})).cookie;
  const addUser=async(name,role='operator')=>{
    ok(await call('/users',{username:name,name,role,password:'test-isolated-only-123'},admin),201);
    const users=(await call('/users',undefined,admin)).body;
    return {id:(Array.isArray(users)?users:users.items).find(u=>u.username===name).id,cookie:(await call('/login',{username:name,password:'test-isolated-only-123'})).cookie};
  };
  const author=await addUser('qa-author'),reviewer=await addUser('qa-reviewer'),finance=await addUser('qa-finance'),engineer=await addUser('qa-engineer'),viewer=await addUser('qa-viewer','viewer'),outsider=await addUser('qa-outsider');
  const post=(path,data,cookie=admin,method='POST')=>call('/engineering'+path,{requestId:randomUUID(),...data},cookie,method);
  const projectData={code:randomUUID().slice(0,8),name:'冲销合成项目',address:'隔离测试场所',owner:'测试负责人',startDate:'2026-10-01',dueDate:'2026-12-31',budget:100000,note:'仅合成业务测试'};
  const pr=await post('/projects',{data:projectData});ok(pr,201);const pid=pr.body.id,base='/projects/'+pid;
  ok(await post(base+'/state',{version:1,state:'active',note:'测试开工'}));
  for(const [u,role] of [[author,'manager'],[reviewer,'manager'],[finance,'finance'],[engineer,'engineer'],[viewer,'manager']])ok(await post(base+'/members',{userId:u.id,role},admin,'PUT'));
  const detail=async(cookie=admin)=>(await call('/engineering'+base,undefined,cookie)).body;
  const item=async(kind,data,cookie=author.cookie)=>{const r=await post(base+'/items/'+kind,{data},cookie);ok(r,201);return (await detail()).items.find(i=>i.id===r.body.id);};
  const transition=async(row,state,cookie=admin)=>{const current=(await detail()).items.find(i=>i.id===row.id);return post(base+'/items/'+row.id+'/state',{version:current.version,state,note:'合成办理依据'},cookie);};
  const approve=async row=>{ok(await transition(row,'submitted',author.cookie));ok(await transition(row,'approved'));};
  const movement=(materialId,kind,quantity,referenceId='',cookie=author.cookie)=>post(base+'/stock',{materialId,kind,quantity,referenceId,note:'合成库存依据'},cookie);
  const reverse=(targetType,targetId,cookie=targetType==='cost'?finance.cookie:engineer.cookie)=>post(base+'/reversals',{targetType,targetId,note:'合成原单录入错误'},cookie);
  const review=(rid,state='approved',cookie=reviewer.cookie,version=1)=>post(base+'/reversals/'+rid+'/state',{version,state,note:'核对原单后办理'},cookie);
  const source=(type,iid)=>({...store.db.prepare('SELECT * FROM '+(type==='cost'?'engineering_items':'engineering_stock')+' WHERE id=?').get(iid)});
  const adjustmentCount=()=>store.db.prepare('SELECT COUNT(*) n FROM engineering_adjustments').get().n;
  return {call,post,admin,author,reviewer,finance,engineer,viewer,outsider,store,base,pid,projectData,detail,item,transition,approve,movement,reverse,review,source,adjustmentCount};
};
const ok=(r,status=200)=>assert.equal(r.status,status,JSON.stringify(r.body));
const material={title:'合成中砂',code:'M-01',specification:'中砂',unit:'吨',warehouse:'测试仓',note:''};
const contract=(extra={})=>({title:'合成合同',code:'HT-01',counterparty:'测试单位',direction:'expense',amount:100000,dueDate:'2026-12-31',note:'合成合同依据',...extra});
const cost=(extra={})=>({title:'合成材料付款',direction:'expense',category:'material',settlementId:'',amount:100000,occurredDate:'2026-10-11',voucher:'TEST-PAY-01',note:'合成付款凭证',...extra});
const paidContract=async(f,direction='expense')=>{
  const c=await f.item('contracts',contract({direction}));await f.approve(c);
  const s=await f.item('settlements',{title:'合成全额结算',contractId:c.id,amount:100000,dueDate:'2026-10-25',note:'合成验收依据'});await f.approve(s);
  const payment=await f.item('costs',cost({direction,settlementId:s.id}));await f.approve(payment);
  return {c,s,payment};
};

test('reversal approval is independent of requester, original creator and last editor; originals remain immutable',async t=>{
  const f=await fixture(t),payment=await f.item('costs',cost());
  ok(await f.post(f.base+'/items/'+payment.id,{version:1,data:cost({note:'财务核对过原付款内容'})},f.finance.cookie,'PUT'));
  await f.approve(payment);const before=f.source('cost',payment.id);
  const requested=await f.reverse('cost',payment.id,f.reviewer.cookie);ok(requested,201);
  assert.equal((await f.detail()).finance.expense,100000);assert.equal(f.adjustmentCount(),0);
  ok(await f.review(requested.body.id,'approved',f.reviewer.cookie),409);
  ok(await f.review(requested.body.id,'approved',f.author.cookie),409);
  ok(await f.post(f.base+'/members',{userId:f.finance.id,role:'manager'},f.admin,'PUT'));
  ok(await f.review(requested.body.id,'approved',f.finance.cookie),409);
  ok(await f.review(requested.body.id,'approved',f.admin));
  assert.deepEqual(f.source('cost',payment.id),before);
  const view=await f.detail();assert.equal(view.finance.expense,0);assert.equal(view.items.find(i=>i.id===payment.id).reversed,true);
  assert.equal(view.reversals[0].state,'approved');assert.equal(view.reversals[0].version,2);assert.equal(f.adjustmentCount(),1);
  assert.equal(f.store.db.prepare('SELECT amount_delta FROM engineering_adjustments').get().amount_delta,-100000);
});

test('rejected and cancelled requests leave balances intact and permit a fresh application',async t=>{
  const f=await fixture(t),payment=await f.item('costs',cost());await f.approve(payment);
  const first=await f.reverse('cost',payment.id);ok(first,201);ok(await f.reverse('cost',payment.id),409);
  ok(await f.review(first.body.id,'rejected'));assert.equal((await f.detail()).finance.expense,100000);assert.equal(f.adjustmentCount(),0);
  const second=await f.reverse('cost',payment.id);ok(second,201);ok(await f.review(second.body.id,'cancelled',f.finance.cookie));
  ok(await f.review(second.body.id),409);assert.equal(f.adjustmentCount(),0);
  const third=await f.reverse('cost',payment.id);ok(third,201);ok(await f.review(third.body.id));
  assert.equal((await f.detail()).reversals.length,3);assert.equal((await f.detail()).finance.expense,0);
});

test('lost successful responses replay the same request without another adjustment or audit entry',async t=>{
  const f=await fixture(t),payment=await f.item('costs',cost());await f.approve(payment);
  const createPayload={requestId:randomUUID(),targetType:'cost',targetId:payment.id,note:'模拟创建响应丢失'};
  const created=await f.call('/engineering'+f.base+'/reversals',createPayload,f.finance.cookie);ok(created,201);
  const createRetry=await f.call('/engineering'+f.base+'/reversals',createPayload,f.finance.cookie);ok(createRetry,201);
  assert.equal(createRetry.body.id,created.body.id);assert.equal(createRetry.body.replayed,true);
  const path='/engineering'+f.base+'/reversals/'+created.body.id+'/state';
  const payload={requestId:randomUUID(),version:1,state:'approved',note:'模拟批准响应丢失'};
  ok(await f.call(path,payload,f.reviewer.cookie));
  const retry=await f.call(path,payload,f.reviewer.cookie);ok(retry);assert.equal(retry.body.replayed,true);
  assert.equal(f.adjustmentCount(),1);assert.equal((await f.detail()).finance.expense,0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM engineering_history WHERE action='reversal_approved'").get().n,1);
  ok(await f.call(path,{...payload,note:'相同请求号不能改变内容'},f.reviewer.cookie),409);
  ok(await f.review(created.body.id),409);ok(await f.reverse('cost',payment.id),409);
});

test('cost reversal releases budget and settlement amount, reopens a closed contract and allows a corrected payment',async t=>{
  const f=await fixture(t),{c,s,payment}=await paidContract(f);ok(await f.transition(c,'closed'));
  const original=f.source('cost',payment.id),requested=await f.reverse('cost',payment.id);ok(requested,201);ok(await f.review(requested.body.id));
  const view=await f.detail();assert.equal(view.items.find(i=>i.id===c.id).state,'approved');assert.equal(view.finance.expense,0);assert.equal(view.finance.payable,100000);
  assert.deepEqual(f.source('cost',payment.id),original);ok(await f.transition(c,'closed'),409);
  ok(await f.post(f.base,{version:view.project.version,data:{...f.projectData,budget:0}},f.admin,'PUT'));
  const corrected=await f.item('costs',cost({settlementId:s.id,voucher:'TEST-PAY-CORRECTED'}));
  ok(await f.transition(corrected,'submitted',f.author.cookie));ok(await f.transition(corrected,'approved'),409);
  const updated=await f.detail();ok(await f.post(f.base,{version:updated.project.version,data:f.projectData},f.admin,'PUT'));
  ok(await f.transition(corrected,'approved'));ok(await f.transition(c,'closed'));
  assert.equal((await f.detail()).finance.expense,100000);
  const over=await f.item('costs',cost({amount:1}));ok(await f.transition(over,'submitted',f.author.cookie));ok(await f.transition(over,'approved'),409);
});

test('income reversal changes only collected income and does not create expense budget',async t=>{
  const f=await fixture(t),{c,payment}=await paidContract(f,'income');ok(await f.transition(c,'closed'));
  const view=await f.detail();ok(await f.post(f.base,{version:view.project.version,data:{...f.projectData,budget:0}},f.admin,'PUT'));
  const requested=await f.reverse('cost',payment.id);ok(requested,201);ok(await f.review(requested.body.id));
  const after=await f.detail();assert.equal(after.finance.income,0);assert.equal(after.finance.expense,0);assert.equal(after.finance.receivable,100000);assert.equal(after.finance.budget,0);
  const expense=await f.item('costs',cost({amount:1}));ok(await f.transition(expense,'submitted',f.author.cookie));ok(await f.transition(expense,'approved'),409);
});

test('receipt reversal reopens closed procurement and contract, adjusts net receipts and preserves source movement',async t=>{
  const f=await fixture(t),m=await f.item('materials',material),{c}=await paidContract(f);
  const p=await f.item('purchases',{title:'合成中砂采购',supplier:'测试供应商',materialId:m.id,quantity:10000,unitPrice:10000,contractId:c.id,dueDate:'2026-10-20',note:'合成采购依据'});await f.approve(p);
  const incoming=await f.movement(m.id,'receive',10000,p.id);ok(incoming,201);ok(await f.transition(p,'closed'));ok(await f.transition(c,'closed'));
  const original=f.source('stock',incoming.body.id),requested=await f.reverse('stock',incoming.body.id);ok(requested,201);
  ok(await f.review(requested.body.id,'approved',f.author.cookie),409);ok(await f.review(requested.body.id));
  const view=await f.detail();assert.equal(view.balances[m.id],0);assert.equal(view.receipts[p.id],0);assert.equal(view.items.find(i=>i.id===p.id).state,'approved');assert.equal(view.items.find(i=>i.id===c.id).state,'approved');
  assert.equal(view.stock.find(i=>i.id===incoming.body.id).reversed,true);assert.deepEqual(f.source('stock',incoming.body.id),original);
  ok(await f.transition(p,'closed'),409);ok(await f.transition(c,'closed'),409);
  ok(await f.movement(m.id,'receive',10000,p.id),201);ok(await f.movement(m.id,'receive',1,p.id),409);
  ok(await f.transition(p,'closed'));ok(await f.transition(c,'closed'));
});

test('stock reversal follows return dependencies, conserves inventory, and prevents returning against a reversed issue',async t=>{
  const f=await fixture(t),m=await f.item('materials',material);ok(await f.movement(m.id,'opening',10000),201);
  const issue=await f.movement(m.id,'issue',7000);ok(issue,201);const returned=await f.movement(m.id,'return',2000,issue.body.id);ok(returned,201);
  ok(await f.reverse('stock',issue.body.id),409);
  const returnReversal=await f.reverse('stock',returned.body.id);ok(returnReversal,201);ok(await f.review(returnReversal.body.id));assert.equal((await f.detail()).balances[m.id],3000);
  // A reversed return must release the original issue's return allowance.
  const replacementReturn=await f.movement(m.id,'return',7000,issue.body.id);ok(replacementReturn,201);ok(await f.movement(m.id,'return',1,issue.body.id),409);
  const replacementReversal=await f.reverse('stock',replacementReturn.body.id);ok(replacementReversal,201);ok(await f.review(replacementReversal.body.id));
  const issueReversal=await f.reverse('stock',issue.body.id);ok(issueReversal,201);ok(await f.review(issueReversal.body.id));
  assert.equal((await f.detail()).balances[m.id],10000);ok(await f.movement(m.id,'return',1,issue.body.id),400);
});

test('issue reversal approval rechecks returns added after the request and stale versions cannot approve',async t=>{
  const f=await fixture(t),m=await f.item('materials',material);ok(await f.movement(m.id,'opening',10000),201);
  const issue=await f.movement(m.id,'issue',7000);ok(issue,201);const requested=await f.reverse('stock',issue.body.id);ok(requested,201);
  ok(await f.review(requested.body.id,'approved',f.reviewer.cookie,2),409);assert.equal(f.adjustmentCount(),0);
  ok(await f.movement(m.id,'return',1000,issue.body.id),201);ok(await f.review(requested.body.id),409);
  const view=await f.detail();assert.equal(view.balances[m.id],4000);assert.equal(view.reversals.find(r=>r.id===requested.body.id).state,'submitted');assert.equal(f.adjustmentCount(),0);
});

test('approval rechecks inventory consumed after the request and rolls back all side effects on failure',async t=>{
  const f=await fixture(t),m=await f.item('materials',material),opening=await f.movement(m.id,'opening',10000);ok(opening,201);
  const requested=await f.reverse('stock',opening.body.id);ok(requested,201);ok(await f.movement(m.id,'issue',1),201);
  ok(await f.review(requested.body.id),409);
  const view=await f.detail();assert.equal(view.balances[m.id],9999);assert.equal(view.reversals.find(r=>r.id===requested.body.id).state,'submitted');assert.equal(f.adjustmentCount(),0);
  assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM engineering_history WHERE action='reversal_approved'").get().n,0);
});

test('return reversal cannot remove stock already consumed by a later issue',async t=>{
  const f=await fixture(t),m=await f.item('materials',material);ok(await f.movement(m.id,'opening',10000),201);
  const issue=await f.movement(m.id,'issue',10000);ok(issue,201);const returned=await f.movement(m.id,'return',5000,issue.body.id);ok(returned,201);
  const requested=await f.reverse('stock',returned.body.id);ok(requested,201);ok(await f.movement(m.id,'issue',5000),201);
  ok(await f.review(requested.body.id),409);assert.equal((await f.detail()).balances[m.id],0);assert.equal(f.adjustmentCount(),0);
});

test('opening correction permits a replacement only when no other effective stock movement remains',async t=>{
  const f=await fixture(t),m=await f.item('materials',material),opening=await f.movement(m.id,'opening',10000);ok(opening,201);
  const requested=await f.reverse('stock',opening.body.id);ok(requested,201);ok(await f.review(requested.body.id));
  ok(await f.movement(m.id,'opening',8000),201);assert.equal((await f.detail()).balances[m.id],8000);
  ok(await f.movement(m.id,'opening',1),409);
  ok(await f.post(f.base+'/items/'+m.id,{version:m.version,data:{...material,unit:'袋'}},f.admin,'PUT'),409);
});

test('pending reversals block completion; completed and archived projects reject reversal mutations',async t=>{
  const f=await fixture(t),payment=await f.item('costs',cost());await f.approve(payment);
  const requested=await f.reverse('cost',payment.id);ok(requested,201);
  ok(await f.post(f.base+'/state',{version:2,state:'completed',note:'检查未办冲销'}),409);
  ok(await f.review(requested.body.id,'cancelled',f.finance.cookie));ok(await f.post(f.base+'/state',{version:2,state:'completed',note:'合成完工'}));
  ok(await f.reverse('cost',payment.id),409);ok(await f.post(f.base+'/state',{version:3,state:'active',note:'恢复施工纠错'}));
  const next=await f.reverse('cost',payment.id);ok(next,201);ok(await f.review(next.body.id));
  ok(await f.post(f.base+'/state',{version:4,state:'completed',note:'纠错完毕'}));ok(await f.post(f.base+'/state',{version:5,state:'archived',note:'合成归档'}));
  ok(await f.reverse('cost',payment.id),409);
});

test('reversal endpoints enforce financial and field ACL, CSRF, mobile membership and server-derived snapshots',async t=>{
  const f=await fixture(t),payment=await f.item('costs',cost());await f.approve(payment);
  const m=await f.item('materials',material),opening=await f.movement(m.id,'opening',10000);ok(opening,201);
  ok(await f.reverse('cost',payment.id,f.engineer.cookie),403);ok(await f.reverse('stock',opening.body.id,f.finance.cookie),403);
  ok(await f.reverse('cost',payment.id,f.viewer.cookie),403);ok(await f.reverse('cost',payment.id,f.outsider.cookie),404);
  ok(await f.post(f.base+'/reversals',{targetType:'cost',targetId:payment.id,note:'不能指定金额',amount:1},f.finance.cookie),400);
  const payload={requestId:randomUUID(),targetType:'cost',targetId:payment.id,note:'权限验证'};
  ok(await f.call('/engineering'+f.base+'/reversals',payload,f.finance.cookie,'POST',{'X-Workspace-Request':''}),403);
  const requested=await f.reverse('cost',payment.id);ok(requested,201);
  const restricted=await f.detail(f.engineer.cookie);assert.equal(restricted.reversals.length,0);assert.equal(restricted.history.some(h=>h.action.startsWith('reversal_')),false);assert.equal(restricted.items.some(i=>i.id===payment.id),false);
  ok(await f.review(requested.body.id,'approved',f.engineer.cookie),404);
  const login=await f.call('/mobile/login',{username:'qa-reviewer',password:'test-isolated-only-123'});ok(login);
  const authorization={Authorization:'Bearer '+login.body.token};
  ok(await f.call('/mobile/engineering'+f.base+'/reversals/'+requested.body.id+'/state',{requestId:randomUUID(),version:1,state:'approved',note:'移动端审核'},'','POST',authorization));
  ok(await f.post(f.base+'/members',{userId:f.reviewer.id,role:'remove'},f.admin,'PUT'));
  ok(await f.call('/mobile/engineering'+f.base,undefined,'','GET',authorization),404);
  const other=await f.post('/projects',{data:{...f.projectData,code:'CROSS-PROJECT'}});ok(other,201);ok(await f.post('/projects/'+other.body.id+'/state',{version:1,state:'active',note:'跨项目隔离测试'}));
  ok(await f.post('/projects/'+other.body.id+'/reversals',{targetType:'stock',targetId:opening.body.id,note:'不能跨项目'}),404);
  ok(await f.post('/projects/'+other.body.id+'/reversals/'+requested.body.id+'/state',{version:2,state:'approved',note:'不能跨项目审批'}),404);
});
