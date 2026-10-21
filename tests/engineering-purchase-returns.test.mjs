import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createApp} from '../server/app.mjs';

const ok=(r,status=200)=>assert.equal(r.status,status,JSON.stringify(r.body));
const ident=value=>typeof value==='string'?value:value.id;
const oldStockColumns=['id','project_id','material_id','kind','quantity','reference_id','note','actor_id','created_at'];
const pick=(row,keys)=>Object.fromEntries(keys.map(key=>[key,row[key]]));

// Synthetic users and disposable SQLite only; the migration case closes the
// server/store and changes the isolated on-disk fixture before restarting it.
async function fixture(t,persistent=false){
  const dir=persistent?mkdtempSync(join(tmpdir(),'engineering-purchase-returns-')):null;
  const database=dir?join(dir,'test.sqlite'):':memory:';let server,state,url,running=false;
  const start=async()=>{server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+server.address().port;state=createApp({database,baseUrl:url,distPath:'__none__'});server.on('request',state.app);running=true;};
  const stop=async()=>{if(!running)return;state.vision.close();server.closeAllConnections();await new Promise(r=>server.close(r));state.store.close();running=false;};
  await start();t.after(async()=>{await stop();if(dir){assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep)&&dir.includes('engineering-purchase-returns-'));rmSync(dir,{recursive:true,force:true});}});
  const call=async(path,body,cookie='',method=body===undefined?'GET':'POST',headers={})=>{const r=await fetch(url+'/api'+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json','X-Workspace-Request':'1',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),bytes=Buffer.from(await r.arrayBuffer());let parsed;try{parsed=JSON.parse(bytes.toString());}catch{parsed=bytes;}return {status:r.status,body:parsed,bytes,headers:r.headers,cookie:r.headers.get('set-cookie')?.split(';')[0]};};
  const password='isolated-purchases-test-123',setup=await call('/setup',{organization:'采购履约隔离验证',username:'qa-admin',name:'管理员',password});ok(setup,201);const admin=setup.cookie,users={};
  for(const name of ['author','reviewer','reviewer2','reviewer3','finance','engineer','viewer','outsider']){ok(await call('/users',{username:'qa-'+name,name,role:name==='viewer'?'viewer':'operator',password},admin),201);const list=(await call('/users',undefined,admin)).body;users[name]={id:list.find(u=>u.name===name).id,cookie:(await call('/login',{username:'qa-'+name,password})).cookie};}
  const post=(path,body,cookie=admin,method='POST')=>call('/engineering'+path,{requestId:randomUUID(),...body},cookie,method);
  const projectData={code:randomUUID(),name:'多行采购合成项目',address:'本机隔离场所',owner:'测试负责人',startDate:'2026-10-01',dueDate:'2026-12-31',budget:10000000,note:'合成采购验证'};
  const project=await post('/projects',{data:projectData});ok(project,201);const pid=project.body.id,pb='/projects/'+pid;
  ok(await post(pb+'/state',{version:1,state:'active',note:'合成开工'}));
  for(const [name,role] of [['author','manager'],['reviewer','manager'],['reviewer2','manager'],['reviewer3','manager'],['finance','finance'],['engineer','engineer'],['viewer','manager']])ok(await post(pb+'/members',{userId:users[name].id,role},admin,'PUT'));
  const detail=async(cookie=admin)=>{const r=await call('/engineering'+pb,undefined,cookie);ok(r);return r.body;};
  const row=async value=>(await detail()).items.find(r=>r.id===ident(value));
  const item=async(kind,data,cookie=users.author.cookie)=>{const r=await post(pb+'/items/'+kind,{data},cookie);ok(r,201);return row(r.body.id);};
  const transition=async(value,target,cookie=users.author.cookie)=>{const current=await row(value);return post(pb+'/items/'+current.id+'/state',{version:current.version,state:target,note:'合成业务办理依据'},cookie);};
  const approve=async value=>{ok(await transition(value,'submitted'));ok(await transition(value,'approved',users.reviewer.cookie));return row(value);};
  const edit=async(value,data,cookie=users.author.cookie)=>{const current=await row(value);return post(pb+'/items/'+current.id,{version:current.version,data},cookie,'PUT');};
  const material=async(extra={})=>item('materials',{title:'合成材料',code:randomUUID(),specification:'合成规格',unit:'吨',warehouse:'测试仓',note:'',...extra});
  const contract=async(extra={})=>approve(await item('contracts',{title:'合成采购合同',code:randomUUID(),counterparty:'合成供应单位',direction:'expense',amount:100000,dueDate:'2026-12-31',note:'合成合同依据',...extra}));
  const movement=(materialId,kind,quantity,referenceId='',cookie=users.author.cookie)=>post(pb+'/stock',{materialId,kind,quantity,referenceId,note:'合成库存原单'},cookie);
  const reverse=(sid,cookie=users.engineer.cookie)=>post(pb+'/reversals',{targetType:'stock',targetId:ident(sid),note:'合成入库纠错依据'},cookie);
  const reviewReversal=(rid,target='approved',cookie=users.reviewer2.cookie)=>post(pb+'/reversals/'+ident(rid)+'/state',{version:1,state:target,note:'独立核对原库存及下游依赖'},cookie);
  const dbState=()=>Object.fromEntries(state.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'engineering_%' OR name='audit') ORDER BY name").all().map(({name})=>[name,state.store.db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]));
  const source=(table,iid)=>({...state.store.db.prepare('SELECT * FROM '+table+' WHERE id=?').get(ident(iid))});
  const restart=async rewrite=>{assert.ok(dir,'Persistent fixture required');await stop();if(rewrite){const offline=new DatabaseSync(database);try{rewrite(offline);}finally{offline.close();}}await start();};
  return {call,post,admin,users,password,pid,pb,projectData,detail,row,item,transition,approve,edit,material,contract,movement,reverse,reviewReversal,dbState,source,restart,get store(){return state.store;}};
}

const legacyPurchase=(m,extra={})=>({title:'合成旧单料采购',supplier:'合成供应商',materialId:ident(m),quantity:10000,unitPrice:1000,contractId:'',dueDate:'2026-10-20',note:'合成旧采购依据',...extra});
const purchaseData=(lines,extra={})=>({title:'多行合成采购',supplier:'合成供应商',contractId:'',dueDate:'2026-10-20',note:'合成采购依据',lines,...extra});
const line=(m,quantity=10000,unitPrice=1000,extra={})=>({materialId:ident(m),quantity,unitPrice,...extra});
const inputLines=p=>p.data.lines.map(({id,materialId,quantity,unitPrice})=>({id,materialId,quantity,unitPrice}));
const order=async(f,p)=>(await f.detail()).purchaseFulfillment.orders.find(r=>r.purchaseId===ident(p));
const orderLine=async(f,p,index=0)=>(await order(f,p)).lines[index];
const receive=(f,p,lines,cookie=f.users.author.cookie,extra={})=>f.post(f.pb+'/purchases/'+ident(p)+'/receipts',{note:'合成逐行验收批次',lines,...extra},cookie);
const terminate=async(f,p,lines,cookie=f.users.finance.cookie,extra={})=>f.post(f.pb+'/purchases/'+ident(p)+'/terminations',{version:(await f.row(p)).version,note:'核对未交余量后申请终止',lines,...extra},cookie);
const reviewTermination=(f,p,r,state='approved',cookie=f.users.reviewer2.cookie,extra={})=>f.post(f.pb+'/purchases/'+ident(p)+'/terminations/'+ident(r)+'/state',{version:1,state,note:'独立复核未交数量与合同承诺',...extra},cookie);
const terminateApproved=async(f,p,lines)=>{const r=await terminate(f,p,lines);ok(r,201);ok(await reviewTermination(f,p,r.body));return r.body;};
const approveBoq=async(f,c,lines)=>{const r=await f.post(f.pb+'/boq',{contractId:ident(c),title:'合成采购承诺对照清单',note:'独立清单依据',lines},f.users.author.cookie);ok(r,201);ok(await f.post(f.pb+'/boq/'+r.body.id+'/state',{version:1,state:'submitted',note:'送审'},f.users.author.cookie));const approved=await f.post(f.pb+'/boq/'+r.body.id+'/state',{version:2,state:'approved',note:'独立审核清单'},f.users.reviewer.cookie);return {request:r,approved};};


const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const dayAfter=()=>new Date(Date.now()+86400000).toISOString().slice(0,10);
const returnPath=(f,p)=>f.pb+'/purchases/'+ident(p)+'/returns';
const requestReturn=async(f,p,lines,cookie=f.users.reviewer.cookie,extra={})=>f.post(returnPath(f,p),{version:(await f.row(p)).version,note:'退货申请合成交接依据',lines,...extra},cookie);
const returnRow=async(f,r)=>(await f.detail()).purchaseReturns.returns.find(x=>x.id===ident(r));
const reviewReturn=async(f,p,r,state='approved',cookie=f.users.reviewer2.cookie,extra={})=>f.post(returnPath(f,p)+'/'+ident(r)+'/state',{version:(await returnRow(f,r)).version,state,note:'独立复核实物退货来源',...extra},cookie);
const dispatch=async(f,p,r,cookie=f.users.author.cookie,extra={})=>f.post(returnPath(f,p)+'/'+ident(r)+'/dispatch',{version:(await returnRow(f,r)).version,effectiveDate:today(),documentNo:'RETURN-'+ident(r),note:'合成实际交接出库凭据',...extra},cookie);
const dispatchApproved=async(f,p,lines)=>{const r=await requestReturn(f,p,lines);ok(r,201);ok(await reviewReturn(f,p,r.body));ok(await dispatch(f,p,r.body));return returnRow(f,r.body);};
const receivedPurchase=async(f,{quantity=10000,unitPrice=1000,legacy=false,contractId='',received=quantity}={})=>{const m=await f.material(),p=await f.approve(await f.item('purchases',legacy?legacyPurchase(m,{quantity,unitPrice,contractId}):purchaseData([line(m,quantity,unitPrice)],{contractId}))),l=await orderLine(f,p),r=await receive(f,p,[{lineId:l.id,quantity:received}]);ok(r,201);return {m,p,l,receipt:r.body.lines[0].stockId,batch:r.body};};
const settlement=async(f,c,amount=10000)=>f.approve(await f.item('settlements',{title:'合成供应商结算',contractId:ident(c),measurementId:'',amount,dueDate:'2026-10-25',note:'双方确认合成结算依据'}));
const payment=async(f,s,amount=10000,extra={})=>f.approve(await f.item('costs',{title:'合成原付款',direction:'expense',category:'material',settlementId:ident(s),amount,occurredDate:today(),voucher:randomUUID(),note:'合成支付凭据',...extra}));
const projectState=async(f,state)=>{const d=await f.detail();return f.post(f.pb+'/state',{version:d.project.version,state,note:'合成项目状态办理'});};

test('physical return approval does not deduct stock; dispatch restores only its line for replacement delivery',async t=>{
  const f=await fixture(t),m=await f.material(),n=await f.material({unit:'米'}),p=await f.approve(await f.item('purchases',purchaseData([line(m,10000,1000),line(m,5000,2000),line(n,2000,3000)]))),[a,b,c]=(await order(f,p)).lines;
  const r=await receive(f,p,[{lineId:a.id,quantity:6000},{lineId:b.id,quantity:5000},{lineId:c.id,quantity:2000}]);ok(r,201);const sid=r.body.lines.find(x=>x.lineId===a.id).stockId;
  const term=await terminateApproved(f,p,[{lineId:a.id,quantity:4000}]),original=f.source('engineering_items',p),stock=f.source('engineering_stock',sid),termination=f.source('engineering_purchase_terminations',term.id);
  const request=await requestReturn(f,p,[{receiptId:sid,quantity:2000}]);ok(request,201);assert.equal(request.body.state,'submitted');assert.equal((await f.detail()).balances[m.id],11000);
  ok(await reviewReturn(f,p,request.body));assert.equal((await f.detail()).balances[m.id],11000);assert.equal((await orderLine(f,p)).receivedQuantity,6000);
  const dispatched=await dispatch(f,p,request.body);ok(dispatched);assert.equal(dispatched.body.state,'dispatched');assert.equal(dispatched.body.version,3);assert.equal(dispatched.body.dispatchId,request.body.id);
  const o=await order(f,p);assert.deepEqual(o.lines.map(x=>[x.grossReceivedQuantity,x.supplierReturnedQuantity,x.receivedQuantity,x.terminatedQuantity,x.remainingQuantity]),[[6000,2000,4000,4000,2000],[5000,0,5000,0,0],[2000,0,2000,0,0]]);assert.equal((await f.detail()).balances[m.id],9000);assert.equal(o.effectiveAmount,22000);
  assert.deepEqual(f.source('engineering_items',p),original);assert.deepEqual(f.source('engineering_stock',sid),stock);assert.deepEqual(f.source('engineering_purchase_terminations',term.id),termination);
  ok(await receive(f,p,[{lineId:a.id,quantity:2000}]),201);const final=await order(f,p);assert.equal(final.lines[0].grossReceivedQuantity,8000);assert.equal(final.lines[0].receivedQuantity,6000);assert.equal(final.lines[0].remainingQuantity,0);ok(await f.transition(p,'closed'));
});

test('source receipt limits are independent of aggregate stock and same-material price lines cannot pool',async t=>{
  const f=await fixture(t),m=await f.material(),p=await f.approve(await f.item('purchases',purchaseData([line(m,10000,1000),line(m,5000,2000)]))),[a,b]=(await order(f,p)).lines;
  const one=await receive(f,p,[{lineId:a.id,quantity:4000}]),two=await receive(f,p,[{lineId:a.id,quantity:6000},{lineId:b.id,quantity:5000}]);ok(one,201);ok(two,201);const sid=one.body.stockIds[0],other=two.body.lines.find(x=>x.lineId===b.id).stockId;
  const before=f.dbState();ok(await requestReturn(f,p,[{receiptId:sid,quantity:4001}]),409);assert.deepEqual(f.dbState(),before);
  const request=await requestReturn(f,p,[{receiptId:sid,quantity:2000},{receiptId:other,quantity:2000}]);ok(request,201);const snapshot=(await returnRow(f,request.body)).snapshot;assert.equal(snapshot.amount,6000);assert.deepEqual(snapshot.lines.map(x=>x.amount),[2000,4000]);ok(await reviewReturn(f,p,request.body));ok(await dispatch(f,p,request.body));
  ok(await requestReturn(f,p,[{receiptId:sid,quantity:2001}]),409);assert.deepEqual((await order(f,p)).lines.map(x=>x.remainingQuantity),[2000,2000]);assert.equal((await f.detail()).balances[m.id],11000);
});

test('inventory consumed after request or approval prevents atomic dispatch with no audit or partial deduction',async t=>{
  const f=await fixture(t),m=await f.material(),n=await f.material(),p=await f.approve(await f.item('purchases',purchaseData([line(m),line(n)]))),[a,b]=(await order(f,p)).lines,r=await receive(f,p,[{lineId:a.id,quantity:10000},{lineId:b.id,quantity:10000}]);ok(r,201);
  const entries=r.body.stockIds.map(receiptId=>({receiptId,quantity:3000})),request=await requestReturn(f,p,entries);ok(request,201);ok(await reviewReturn(f,p,request.body));const snap=(await returnRow(f,request.body)).snapshot;
  ok(await f.movement(n.id,'issue',8000,'',f.users.engineer.cookie),201);const before=f.dbState();ok(await dispatch(f,p,request.body),409);assert.deepEqual(f.dbState(),before);assert.equal((await returnRow(f,request.body)).state,'approved');assert.deepEqual((await returnRow(f,request.body)).snapshot,snap);assert.equal((await f.detail()).balances[m.id],10000);
  const issued=(await f.detail()).stock.find(x=>x.kind==='issue');ok(await f.movement(n.id,'return',1000,issued.id,f.users.engineer.cookie),201);ok(await dispatch(f,p,request.body));assert.equal((await f.detail()).balances[m.id],7000);assert.equal((await f.detail()).balances[n.id],0);
});

test('fractional returns use per-source cumulative rounding including positive quantity with zero nominal value',async t=>{
  const f=await fixture(t),{m,p,receipt}=await receivedPurchase(f,{quantity:1000,unitPrice:1});const amounts=[];
  for(const quantity of [499,1,500]){const r=await dispatchApproved(f,p,[{receiptId:receipt,quantity}]);amounts.push(r.snapshot.amount);assert.equal(r.dispatch.amount,r.snapshot.amount);}
  assert.deepEqual(amounts,[0,1,0]);const view=(await f.detail()).purchaseReturns,source=view.receipts.find(x=>x.receiptId===receipt);assert.equal(source.returnedQuantity,1000);assert.equal(source.availableQuantity,0);assert.equal(source.returnedAmount,1);assert.equal((await f.detail()).balances[m.id],0);assert.equal((await orderLine(f,p)).remainingQuantity,1000);assert.equal((await order(f,p)).effectiveAmount,1);
  ok(await requestReturn(f,p,[{receiptId:receipt,quantity:1}]),409);
});

test('return input rejects duplicate foreign non-receipt and forged sources without any partial record',async t=>{
  const f=await fixture(t),{p,receipt}=await receivedPurchase(f),other=await receivedPurchase(f),openingMaterial=await f.material(),opening=await f.movement(openingMaterial.id,'opening',1000);ok(opening,201);
  const invalid=[[],[{receiptId:receipt,quantity:0}],[{receiptId:receipt,quantity:-1}],[{receiptId:receipt,quantity:1.5}],[{receiptId:receipt,quantity:1000000001}],[{receiptId:receipt,quantity:1,amount:1}],[{receiptId:receipt,quantity:1},{receiptId:receipt,quantity:1}],[{receiptId:receipt,quantity:1},{receiptId:other.receipt,quantity:1}],[{receiptId:opening.body.id,quantity:1}]];
  const before=f.dbState();for(const lines of invalid){ok(await requestReturn(f,p,lines),400);assert.deepEqual(f.dbState(),before);}ok(await requestReturn(f,p,[{receiptId:receipt,quantity:1}],undefined,{amount:1}),400);assert.deepEqual(f.dbState(),before);
  const otherProject=await f.post('/projects',{data:{...f.projectData,code:randomUUID()}});ok(otherProject,201);ok(await f.post('/projects/'+otherProject.body.id+'/state',{version:1,state:'active',note:'启动隔离跨项目校验场景'}));ok(await f.post('/projects/'+otherProject.body.id+'/purchases/'+p.id+'/returns',{version:p.version,note:'跨项目',lines:[{receiptId:receipt,quantity:1}]}),400);
});

test('independent manager review excludes requester original purchase editor and every receipt actor',async t=>{
  const f=await fixture(t),m=await f.material(),p=await f.item('purchases',purchaseData([line(m)]));ok(await f.edit(p,purchaseData(inputLines(p)),f.users.finance.cookie));await f.approve(p);const l=await orderLine(f,p),r=await receive(f,p,[{lineId:l.id,quantity:10000}],f.users.reviewer2.cookie);ok(r,201);
  const request=await requestReturn(f,p,[{receiptId:r.body.stockIds[0],quantity:1000}]);ok(request,201);ok(await f.post(f.pb+'/members',{userId:f.users.finance.id,role:'manager'},f.admin,'PUT'));
  const before=f.dbState();for(const actor of ['author','finance','reviewer','reviewer2'])for(const state of ['approved','rejected']){ok(await reviewReturn(f,p,request.body,state,f.users[actor].cookie),409);assert.deepEqual(f.dbState(),before);}ok(await reviewReturn(f,p,request.body,'approved',f.users.reviewer3.cookie));
  for(const actor of ['engineer','viewer'])ok(await dispatch(f,p,request.body,f.users[actor].cookie),403);ok(await dispatch(f,p,request.body));
});

test('roles and mobile parity are checked before successful replay and field details hide financial references',async t=>{
  const f=await fixture(t),{m,p,receipt}=await receivedPurchase(f);for(const actor of ['finance','engineer','viewer'])ok(await requestReturn(f,p,[{receiptId:receipt,quantity:1000}],f.users[actor].cookie),403);ok(await requestReturn(f,p,[{receiptId:receipt,quantity:1000}],f.users.outsider.cookie),404);
  const login=await f.call('/mobile/login',{username:'qa-reviewer',password:f.password});ok(login);const headers={Authorization:'Bearer '+login.body.token},path='/mobile/engineering'+returnPath(f,p),body={requestId:randomUUID(),version:(await f.row(p)).version,note:'移动端合成退货',lines:[{receiptId:receipt,quantity:1000}]};
  const r=await f.call(path,body,'','POST',headers);ok(r,201);ok(await reviewReturn(f,p,r.body));ok(await dispatch(f,p,r.body));const field=await f.detail(f.users.engineer.cookie);assert.equal(field.purchaseReturns,null);assert.equal(field.purchaseFulfillment,null);assert.equal(field.supplierFinance,null);assert.equal(field.balances[m.id],9000);const serialized=JSON.stringify(field);for(const secret of [p.id,p.data.supplier])assert.equal(serialized.includes(secret),false,secret);
  ok(await f.post(f.pb+'/members',{userId:f.users.reviewer.id,role:'engineer'},f.admin,'PUT'));ok(await f.call(path,body,'','POST',headers),403);
});

test('pending return is mutually exclusive with receipts terminations source reversal and every close',async t=>{
  const f=await fixture(t),c=await f.contract({amount:10000}),{p,l,receipt}=await receivedPurchase(f,{contractId:c.id,received:6000});const request=await requestReturn(f,p,[{receiptId:receipt,quantity:2000}]);ok(request,201);
  const before=f.dbState();ok(await receive(f,p,[{lineId:l.id,quantity:1000}]),409);ok(await terminate(f,p,[{lineId:l.id,quantity:1000}]),409);ok(await f.reverse(receipt),409);ok(await f.transition(p,'closed'),409);ok(await f.transition(c,'closed'),409);ok(await projectState(f,'completed'),409);assert.deepEqual(f.dbState(),before);
  ok(await reviewReturn(f,p,request.body));ok(await receive(f,p,[{lineId:l.id,quantity:1000}]),409);ok(await reviewReturn(f,p,request.body,'cancelled'));const term=await terminate(f,p,[{lineId:l.id,quantity:1000}]);ok(term,201);ok(await requestReturn(f,p,[{receiptId:receipt,quantity:1000}]),409);ok(await reviewTermination(f,p,term.body,'cancelled',f.users.finance.cookie));const reversal=await f.reverse(receipt);ok(reversal,201);ok(await requestReturn(f,p,[{receiptId:receipt,quantity:1000}]),409);
});

test('dispatch on a closed paid contract reopens contract and purchase; original records and settlement remain unchanged',async t=>{
  const f=await fixture(t),c=await f.contract({amount:10000}),{m,p,receipt}=await receivedPurchase(f,{contractId:c.id}),s=await settlement(f,c),cost=await payment(f,s);ok(await f.transition(p,'closed'));ok(await f.transition(c,'closed'));
  const originals=Object.fromEntries([p,c,s,cost].map(x=>[x.id,f.source('engineering_items',x)])),stock=f.source('engineering_stock',receipt),r=await requestReturn(f,p,[{receiptId:receipt,quantity:2000}]);ok(r,201);ok(await reviewReturn(f,p,r.body));assert.equal((await f.row(p)).state,'closed');ok(await dispatch(f,p,r.body));
  for(const x of [p,c]){const current=f.source('engineering_items',x);assert.equal(current.state,'approved');assert.equal(current.version,originals[x.id].version+1);assert.equal(current.data,originals[x.id].data);}for(const x of [s,cost])assert.deepEqual(f.source('engineering_items',x),originals[x.id]);assert.deepEqual(f.source('engineering_stock',receipt),stock);assert.equal((await f.detail()).finance.expense,10000);assert.equal((await f.row(c)).commercial.effectiveAmount,10000);assert.equal((await f.detail()).balances[m.id],8000);
  ok(await f.transition(p,'closed'),409);ok(await receive(f,p,[{lineId:(await orderLine(f,p)).id,quantity:2000}]),201);ok(await f.transition(p,'closed'));ok(await f.transition(c,'closed'));ok(await projectState(f,'completed'));ok(await projectState(f,'archived'));
});

test('permanent return needs independent remaining-quantity termination and never auto-reduces contract commitment',async t=>{
  const f=await fixture(t),c=await f.contract({amount:10000}),{p,l,receipt}=await receivedPurchase(f,{contractId:c.id}),r=await dispatchApproved(f,p,[{receiptId:receipt,quantity:3000}]);
  assert.equal((await order(f,p)).effectiveAmount,10000);assert.equal((await f.row(c)).commercial.purchaseAmount,10000);const data=(await f.row(p)).data;ok(await f.transition(p,'closed'),409);await terminateApproved(f,p,[{lineId:l.id,quantity:3000}]);assert.equal((await order(f,p)).effectiveAmount,7000);assert.equal((await orderLine(f,p)).terminatedQuantity,3000);assert.equal((await orderLine(f,p)).remainingQuantity,0);assert.deepEqual((await f.row(p)).data,data);assert.equal((await f.row(c)).data.amount,10000);ok(await f.transition(p,'closed'));ok(await reviewReturn(f,p,r,'cancelled'),409);ok(await f.reverse(receipt),409);
});

test('concurrent creation and dispatch exact retries survive restart with one stock impact and no altered-payload replay',async t=>{
  const f=await fixture(t,true),{m,p,receipt}=await receivedPurchase(f),create={requestId:randomUUID(),version:p.version,note:'幂等退货',lines:[{receiptId:receipt,quantity:3000}]},path=returnPath(f,p);
  const created=await Promise.all([f.post(path,create,f.users.reviewer.cookie),f.post(path,create,f.users.reviewer.cookie)]);for(const x of created)ok(x,201);assert.equal(created[0].body.id,created[1].body.id);const rid=created[0].body.id;ok(await reviewReturn(f,p,rid));
  const body={requestId:randomUUID(),version:2,effectiveDate:today(),documentNo:'IDEMPOTENT-DISPATCH',note:'合成实退'},dp=path+'/'+rid+'/dispatch',decisions=await Promise.all([f.post(dp,body,f.users.author.cookie),f.post(dp,body,f.users.author.cookie)]);for(const x of decisions)ok(x);assert.equal(decisions[0].body.dispatchId,decisions[1].body.dispatchId);const before=f.dbState();await f.restart();const replay=await f.post(dp,body,f.users.author.cookie);ok(replay);assert.equal(replay.body.replayed,true);assert.deepEqual(f.dbState(),before);assert.equal((await f.detail()).balances[m.id],7000);assert.equal((await f.detail()).purchaseReturns.returns.length,1);
  ok(await f.post(dp,{...body,documentNo:'CHANGED'},f.users.author.cookie),409);assert.deepEqual(f.dbState(),before);ok(await f.post(path,{...create,lines:[{receiptId:receipt,quantity:3001}]},f.users.reviewer.cookie),409);
});

test('competing new returns serialize one pending application and old decisions cannot be applied twice',async t=>{
  const f=await fixture(t),{p,receipt}=await receivedPurchase(f),race=await Promise.all([requestReturn(f,p,[{receiptId:receipt,quantity:6000}]),requestReturn(f,p,[{receiptId:receipt,quantity:6000}])]);assert.deepEqual(race.map(x=>x.status).sort(),[201,409]);const rid=race.find(x=>x.status===201).body.id;ok(await reviewReturn(f,p,rid));const before=f.dbState();ok(await f.post(returnPath(f,p)+'/'+rid+'/state',{version:1,state:'approved',note:'旧版本'},f.users.reviewer2.cookie),409);assert.deepEqual(f.dbState(),before);ok(await dispatch(f,p,rid));ok(await requestReturn(f,p,[{receiptId:receipt,quantity:4001}]),409);
});

test('dispatch dates and strict receipt proofs are checked while rejected and cancelled history stays immutable',async t=>{
  const f=await fixture(t),{p,receipt}=await receivedPurchase(f),r=await requestReturn(f,p,[{receiptId:receipt,quantity:1000}]);ok(r,201);ok(await reviewReturn(f,p,r.body));const before=f.dbState();
  for(const extra of [{effectiveDate:dayAfter()},{effectiveDate:'2000-01-01'},{effectiveDate:'2026-02-30'},{documentNo:''},{note:''},{amount:1}]){ok(await dispatch(f,p,r.body,undefined,extra),400);assert.deepEqual(f.dbState(),before);}ok(await reviewReturn(f,p,r.body,'cancelled'));const cancelled=await returnRow(f,r.body);
  const next=await requestReturn(f,p,[{receiptId:receipt,quantity:1000}]);ok(next,201);ok(await reviewReturn(f,p,next.body,'rejected'));const rejected=await returnRow(f,next.body);const reversal=await f.reverse(receipt);ok(reversal,201);ok(await f.reviewReversal(reversal.body));assert.deepEqual((await returnRow(f,r.body)).snapshot,cancelled.snapshot);assert.deepEqual((await returnRow(f,next.body)).snapshot,rejected.snapshot);ok(await dispatch(f,p,r.body),409);
});

test('legacy unlabelled stock sources coexist with new receipt line IDs and remain untouched across restart',async t=>{
  const f=await fixture(t,true),{m,p,l,receipt}=await receivedPurchase(f,{legacy:true,received:6000});f.store.db.prepare("UPDATE engineering_stock SET purchase_line_id='',receipt_batch_id='' WHERE id=?").run(receipt);const original=f.source('engineering_stock',receipt);await f.restart();
  const r=await dispatchApproved(f,p,[{receiptId:receipt,quantity:2000}]);assert.equal(r.snapshot.lines[0].purchaseLineId,l.id);assert.equal((await f.detail()).receipts[p.id],4000);ok(await receive(f,p,[{lineId:l.id,quantity:6000}]),201);assert.equal((await orderLine(f,p)).grossReceivedQuantity,12000);assert.equal((await orderLine(f,p)).receivedQuantity,10000);assert.equal((await f.detail()).receipts[p.id],10000);assert.equal((await f.detail()).balances[m.id],10000);assert.deepEqual(f.source('engineering_stock',receipt),original);await f.restart();assert.equal((await f.detail()).receipts[p.id],10000);assert.deepEqual(f.source('engineering_stock',receipt),original);
});

test('completed and archived projects prevent every new return decision while original successful receipt remains replayable',async t=>{
  const f=await fixture(t),{p,receipt}=await receivedPurchase(f),r=await requestReturn(f,p,[{receiptId:receipt,quantity:1000}]);ok(r,201);
  for(const state of ['completed','archived']){f.store.db.prepare('UPDATE engineering_projects SET state=? WHERE id=?').run(state,f.pid);const before=f.dbState();for(const decision of ['approved','rejected','cancelled'])ok(await reviewReturn(f,p,r.body,decision),409);ok(await dispatch(f,p,r.body),409);ok(await requestReturn(f,p,[{receiptId:receipt,quantity:1000}]),409);assert.deepEqual(f.dbState(),before);}
});
