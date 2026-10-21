import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {createApp} from '../server/app.mjs';
import {buildEngineeringWorkbook} from '../server/engineering-export.mjs';
import {unzipSync,strFromU8} from 'fflate';
import {DOMParser} from '@xmldom/xmldom';

const ok=(r,status=200)=>assert.equal(r.status,status,JSON.stringify(r.body));
const ident=value=>typeof value==='string'?value:value.id;
const oldStockColumns=['id','project_id','material_id','kind','quantity','reference_id','note','actor_id','created_at'];
const pick=(row,keys)=>Object.fromEntries(keys.map(key=>[key,row[key]]));

// Synthetic users and disposable SQLite only; the migration case closes the
// server/store and changes the isolated on-disk fixture before restarting it.
async function fixture(t,persistent=false){
  const dir=persistent?mkdtempSync(join(tmpdir(),'engineering-supplier-finance-')):null;
  const database=dir?join(dir,'test.sqlite'):':memory:';let server,state,url,running=false;
  const start=async()=>{server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+server.address().port;state=createApp({database,baseUrl:url,distPath:'__none__'});server.on('request',state.app);running=true;};
  const stop=async()=>{if(!running)return;state.vision.close();server.closeAllConnections();await new Promise(r=>server.close(r));state.store.close();running=false;};
  await start();t.after(async()=>{await stop();if(dir){assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep)&&dir.includes('engineering-supplier-finance-'));rmSync(dir,{recursive:true,force:true});}});
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

const creditPath=(f,p)=>f.pb+'/purchases/'+ident(p)+'/credits';
const refundPath=(f,p)=>f.pb+'/purchases/'+ident(p)+'/refunds';
const credit=(f,p,r,s,amount,cookie=f.users.finance.cookie,extra={})=>f.post(creditPath(f,p),{returnId:ident(r),settlementId:ident(s),amount,note:'合成供应商双方确认抵减依据',...extra},cookie);
const reviewCredit=(f,p,c,state='approved',cookie=f.users.reviewer2.cookie,extra={})=>f.post(creditPath(f,p)+'/'+ident(c)+'/state',{version:1,state,note:'独立核对供应商抵减依据',...extra},cookie);
const refund=(f,p,c,cost,amount,cookie=f.users.finance.cookie,extra={})=>f.post(refundPath(f,p),{creditId:ident(c),costId:ident(cost),amount,occurredDate:today(),voucher:'REFUND-'+randomUUID(),note:'合成银行到账退款凭据',...extra},cookie);
const reviewRefund=(f,p,r,state='approved',cookie=f.users.reviewer2.cookie,extra={})=>f.post(refundPath(f,p)+'/'+ident(r)+'/state',{version:1,state,note:'独立复核实际退款到账',...extra},cookie);
const creditApproved=async(f,p,r,s,amount)=>{const c=await credit(f,p,r,s,amount);ok(c,201);ok(await reviewCredit(f,p,c.body));return c.body;};
const refundApproved=async(f,p,c,cost,amount)=>{const r=await refund(f,p,c,cost,amount);ok(r,201);ok(await reviewRefund(f,p,r.body));return r.body;};
const finance=async f=>(await f.detail()).supplierFinance;
const settlementView=async(f,s)=>(await finance(f)).settlements.find(x=>x.settlementId===ident(s));
const paymentView=async(f,c)=>(await finance(f)).payments.find(x=>x.costId===ident(c));
const costReversal=(f,c)=>f.post(f.pb+'/reversals',{targetType:'cost',targetId:ident(c),note:'独立纠错原付款剩余净额'},f.users.finance.cookie);
const correction=(f,s)=>f.post(f.pb+'/corrections',{targetId:ident(s),note:'原结算净付款清零后纠错'},f.users.finance.cookie);
const approveCorrection=(f,r)=>f.post(f.pb+'/corrections/'+ident(r)+'/state',{version:1,state:'approved',note:'独立检查净付款及关联依赖'},f.users.reviewer2.cookie);
const commercialFixture=async(f,{paid=10000,returnQuantity=4000,legacy=false,withContract=true}={})=>{const c=withContract?await f.contract({amount:10000}):null,{m,p,l,receipt}=await receivedPurchase(f,{contractId:c?.id||'',legacy}),s=c?await settlement(f,c):null,cost=paid&&s?await payment(f,s,paid):null,r=await dispatchApproved(f,p,[{receiptId:receipt,quantity:returnQuantity}]);return {m,p,l,receipt,c,s,cost,r};};

function exportedSheets(detail){
  const files=unzipSync(buildEngineeringWorkbook(detail));
  const parse=path=>new DOMParser().parseFromString(strFromU8(files[path]),'application/xml');
  const all=(node,name)=>Array.from(node.getElementsByTagName(name));
  return Object.fromEntries(all(parse('xl/workbook.xml'),'sheet').map((sheet,i)=>{
    const rows=all(parse('xl/worksheets/sheet'+(i+1)+'.xml'),'row').map(row=>all(row,'c').map(cell=>cell.getAttribute('t')==='n'?Number(all(cell,'v')[0].textContent):all(cell,'t').map(t=>t.textContent).join('')));
    return [sheet.getAttribute('name'),rows.slice(1).map(row=>Object.fromEntries(rows[0].map((name,j)=>[name,row[j]])))];
  }));
}

test('supplier workbook reconciles physical stock credit refund and cash without cached derived amounts or source mutation',async t=>{
  const f=await fixture(t),{m,p,s,cost,r}=await commercialFixture(f),c=await creditApproved(f,p,r,s,4000);await refundApproved(f,p,c,cost,1000);
  const detail=await f.detail(),original=f.dbState();detail.supplierFinance.settlements[0].effectiveAmount=999999;detail.supplierFinance.payments[0].effectiveAmount=999999;detail.finance.expense=999999;const exportInput=JSON.stringify(detail);
  const sheets=exportedSheets(detail),settled=sheets['结算'][0],paid=sheets['收支'][0];
  assert.equal(settled['有效结算（元）'],60);assert.equal(settled['有效已收付（元）'],90);assert.equal(settled['未收付（元）'],0);assert.equal(settled['超付待退（元）'],30);
  assert.equal(paid['有效收支金额（元）'],90);assert.equal(paid['净现金流入（元）'],-90);assert.equal(sheets['供应商抵减'][0]['有效抵减（元）'],40);assert.equal(sheets['供应商退款'][0]['有效到账（元）'],10);
  assert.equal(sheets['采购退货历史'][0]['实际发退数量'],4);assert.equal(sheets['供应商实退流水'][0]['有效库存影响'],-4);assert.equal(sheets['材料余额'].find(row=>row['记录ID']===m.id)['当前净库存'],6);assert.equal(sheets['采购'][0]['净入库数量'],6);
  const metrics=new Map(sheets['项目汇总'].map(row=>[row['项目 / 指标'],row['值']]));assert.equal(metrics.get('有效支出'),90);assert.equal(metrics.get('有效收入'),0);assert.equal(metrics.get('已批应付'),60);
  assert.equal(JSON.stringify(detail),exportInput);assert.deepEqual(f.dbState(),original);assert.equal((await order(f,p)).effectiveAmount,10000);
});

test('supplier workbook retains pending money with zero financial effect and rejects corrupted source or stock balances',async t=>{
  const f=await fixture(t),{m,p,s,r}=await commercialFixture(f),c=await credit(f,p,r,s,4000);ok(c,201);
  const detail=await f.detail(),sheets=exportedSheets(detail);assert.equal(sheets['供应商抵减'][0]['有效抵减（元）'],0);assert.equal(sheets['结算'][0]['有效结算（元）'],100);
  const corrupt=structuredClone(detail);corrupt.supplierFinance.credits[0].snapshot.amount++;assert.throws(()=>exportedSheets(corrupt),e=>e.status===422);
  const foreign=structuredClone(detail);foreign.purchaseReturns.returns[0].project_id=randomUUID();assert.throws(()=>exportedSheets(foreign),e=>e.status===422);
  const balance=structuredClone(detail);balance.balances[m.id]++;assert.throws(()=>exportedSheets(balance),e=>e.status===422);
});

test('supplier workbook refunded cost reversal exports only remaining cash impact',async t=>{
  const f=await fixture(t),{p,s,cost,r}=await commercialFixture(f),c=await creditApproved(f,p,r,s,4000);await refundApproved(f,p,c,cost,1000);
  const reversal=await costReversal(f,cost);ok(reversal,201);ok(await f.reviewReversal(reversal.body));
  const sheets=exportedSheets(await f.detail());assert.equal(sheets['收支'][0]['有效收支金额（元）'],0);assert.equal(sheets['供应商退款'][0]['有效到账（元）'],10);assert.equal(sheets['纠错与冲销'][0]['业务金额调整（元）'],-90);assert.equal(sheets['结算'][0]['有效已收付（元）'],0);
});

test('credits on unpaid partially paid and fully paid settlements produce different refund obligations without fictitious income',async t=>{
  const f=await fixture(t);
  for(const paid of [0,8000,10000]){const {p,s,cost,r}=await commercialFixture(f,{paid}),original=f.source('engineering_items',s),before=(await f.detail()).finance;
    const pending=await credit(f,p,r,s,4000);ok(pending,201);assert.equal((await settlementView(f,s)).effectiveAmount,10000);assert.equal((await f.detail()).finance.expense,before.expense);ok(await reviewCredit(f,p,pending.body));
    let v=await settlementView(f,s);assert.equal(v.originalAmount,10000);assert.equal(v.creditAmount,4000);assert.equal(v.effectiveAmount,6000);assert.equal(v.paidAmount,paid);assert.equal(v.unpaidAmount,Math.max(0,6000-paid));assert.equal(v.refundableAmount,Math.max(0,paid-6000));assert.equal((await f.detail()).finance.income,before.income);assert.deepEqual(f.source('engineering_items',s),original);
    if(paid>6000){const amount=paid-6000,rr=await refund(f,p,pending.body,cost,amount);ok(rr,201);assert.equal((await paymentView(f,cost)).effectiveAmount,paid);ok(await reviewRefund(f,p,rr.body));v=await settlementView(f,s);assert.equal(v.refundableAmount,0);assert.equal(v.paidAmount,6000);assert.equal((await paymentView(f,cost)).refundedAmount,amount);assert.equal((await f.detail()).finance.expense,before.expense-amount);assert.equal((await f.detail()).finance.income,before.income);}
  }
});

test('reference return value agreed credit and actual cash refund remain separate immutable amounts',async t=>{
  const f=await fixture(t),{p,s,cost,r}=await commercialFixture(f),sources=[p,s,cost].map(x=>f.source('engineering_items',x)),c=await creditApproved(f,p,r,s,3000),rr=await refundApproved(f,p,c,cost,1000),v=await finance(f);
  assert.equal(r.snapshot.amount,4000);assert.equal(v.credits.find(x=>x.id===c.id).amount,3000);assert.equal(v.refunds.find(x=>x.id===rr.id).amount,1000);assert.equal((await settlementView(f,s)).effectiveAmount,7000);assert.equal((await paymentView(f,cost)).effectiveAmount,9000);assert.equal((await settlementView(f,s)).refundableAmount,2000);assert.equal((await f.detail()).finance.income,0);assert.equal((await f.detail()).finance.expense,9000);assert.equal((await f.detail()).finance.payable,7000);assert.equal((await order(f,p)).effectiveAmount,10000);assert.deepEqual([p,s,cost].map(x=>f.source('engineering_items',x)),sources);
});

test('credit caps use dispatched return and matching expense settlement rather than supplier name or pooled contracts',async t=>{
  const f=await fixture(t),a=await commercialFixture(f),b=await commercialFixture(f),noContract=await commercialFixture(f,{withContract:false});
  const before=f.dbState();ok(await credit(f,a.p,a.r,a.s,4001),409);ok(await credit(f,a.p,b.r,a.s,1),400);ok(await credit(f,a.p,a.r,b.s,1),400);ok(await credit(f,noContract.p,noContract.r,a.s,1),400);assert.deepEqual(f.dbState(),before);
  const income=await f.contract({direction:'income',amount:10000}),incomeSettlement=await settlement(f,income);ok(await credit(f,a.p,a.r,incomeSettlement,1000),400);
  const pendingReturn=await requestReturn(f,a.p,[{receiptId:a.receipt,quantity:1000}]);ok(pendingReturn,201);ok(await credit(f,a.p,pendingReturn.body,a.s,1000),409);ok(await reviewReturn(f,a.p,pendingReturn.body));ok(await credit(f,a.p,pendingReturn.body,a.s,1000),409);
});

test('credit cumulative cap and original settlement cap apply after prior approved credits and cancelled requests release only pending status',async t=>{
  const f=await fixture(t),{p,r,s}=await commercialFixture(f),first=await creditApproved(f,p,r,s,3000);ok(await credit(f,p,r,s,1001),409);
  const request=await credit(f,p,r,s,1000);ok(request,201);ok(await credit(f,p,r,s,1),409);ok(await reviewCredit(f,p,request.body,'cancelled',f.users.finance.cookie));const last=await creditApproved(f,p,r,s,1000);assert.notEqual(last.id,first.id);assert.equal((await settlementView(f,s)).creditAmount,4000);assert.equal((await settlementView(f,s)).effectiveAmount,6000);ok(await credit(f,p,r,s,1),409);
  const contract=await f.contract({amount:10000}),{p:q,receipt}=await receivedPurchase(f,{contractId:contract.id}),small=await settlement(f,contract,1000),rq=await dispatchApproved(f,q,[{receiptId:receipt,quantity:10000}]);ok(await credit(f,q,rq,small,1001),409);
});

test('refunds are bounded by specific original payment remaining amount credit balance and settlement overpayment',async t=>{
  const f=await fixture(t),c=await f.contract({amount:10000}),{p,receipt}=await receivedPurchase(f,{contractId:c.id}),s=await settlement(f,c),one=await payment(f,s,3000),two=await payment(f,s,7000),r=await dispatchApproved(f,p,[{receiptId:receipt,quantity:4000}]),creditId=await creditApproved(f,p,r,s,4000);
  ok(await refund(f,p,creditId,one,3001),409);await refundApproved(f,p,creditId,one,3000);ok(await refund(f,p,creditId,one,1),409);ok(await refund(f,p,creditId,two,1001),409);await refundApproved(f,p,creditId,two,1000);assert.equal((await paymentView(f,one)).effectiveAmount,0);assert.equal((await paymentView(f,two)).effectiveAmount,6000);assert.equal((await settlementView(f,s)).refundableAmount,0);assert.equal((await finance(f)).credits.find(x=>x.id===creditId.id).availableRefundAmount,0);ok(await refund(f,p,creditId,two,1),409);
});

test('refund reference validation rejects income other settlement same supplier void and reversed payments',async t=>{
  const f=await fixture(t),a=await commercialFixture(f),b=await commercialFixture(f),c=await creditApproved(f,a.p,a.r,a.s,4000),incomeContract=await f.contract({direction:'income',amount:10000}),incomeSettlement=await settlement(f,incomeContract),incomePayment=await payment(f,incomeSettlement,10000,{direction:'income'});
  const before=f.dbState();for(const cost of [b.cost,incomePayment])ok(await refund(f,a.p,c,cost,1),400);assert.deepEqual(f.dbState(),before);
  const reversal=await costReversal(f,a.cost);ok(reversal,201);ok(await f.reviewReversal(reversal.body));ok(await refund(f,a.p,c,a.cost,1),409);
});

test('credit and refund approvals exclude requester and original business authors even after role promotion',async t=>{
  const f=await fixture(t),{p,s,cost,r}=await commercialFixture(f),cr=await credit(f,p,r,s,4000);ok(cr,201);ok(await f.post(f.pb+'/members',{userId:f.users.finance.id,role:'manager'},f.admin,'PUT'));
  const before=f.dbState();for(const actor of ['finance','author','reviewer'])for(const state of ['approved','rejected']){ok(await reviewCredit(f,p,cr.body,state,f.users[actor].cookie),409);assert.deepEqual(f.dbState(),before);}ok(await reviewCredit(f,p,cr.body));
  const rr=await refund(f,p,cr.body,cost,1000);ok(rr,201);const beforeRefund=f.dbState();for(const actor of ['finance','author'])for(const state of ['approved','rejected']){ok(await reviewRefund(f,p,rr.body,state,f.users[actor].cookie),409);assert.deepEqual(f.dbState(),beforeRefund);}ok(await reviewRefund(f,p,rr.body));
});

test('pending cash refund and cost reversal are mutually exclusive and remaining-net reversal never deducts refunded money twice',async t=>{
  const f=await fixture(t),{p,s,cost,r}=await commercialFixture(f),c=await creditApproved(f,p,r,s,4000),rr=await refund(f,p,c,cost,1000);ok(rr,201);ok(await costReversal(f,cost),409);ok(await correction(f,s),409);ok(await reviewRefund(f,p,rr.body));
  const original=f.source('engineering_items',cost),reversal=await costReversal(f,cost);ok(reversal,201);ok(await refund(f,p,c,cost,1000),409);ok(await f.reviewReversal(reversal.body));assert.equal(f.store.db.prepare('SELECT amount_delta FROM engineering_adjustments WHERE reversal_id=?').get(reversal.body.id).amount_delta,-9000);assert.equal((await f.detail()).finance.expense,0);assert.equal((await paymentView(f,cost)).effectiveAmount,0);assert.deepEqual(f.source('engineering_items',cost),original);assert.equal((await finance(f)).refunds.find(x=>x.id===rr.body.id).state,'approved');
  const corrected=await correction(f,s);ok(corrected,201);ok(await approveCorrection(f,corrected.body));assert.equal((await f.row(s)).voided,true);
});

test('a fully refunded payment permits settlement correction without requiring impossible zero-value cost reversal',async t=>{
  const f=await fixture(t),{p,s,cost,r}=await commercialFixture(f,{returnQuantity:10000}),c=await creditApproved(f,p,r,s,10000);await refundApproved(f,p,c,cost,10000);assert.equal((await f.row(cost)).reversed,false);assert.equal((await paymentView(f,cost)).effectiveAmount,0);assert.equal((await settlementView(f,s)).effectiveAmount,0);const source=f.source('engineering_items',s),corrected=await correction(f,s);ok(corrected,201);ok(await approveCorrection(f,corrected.body));assert.equal((await f.row(s)).voided,true);assert.deepEqual(f.source('engineering_items',s),source);assert.equal((await f.detail()).finance.expense,0);assert.equal((await f.detail()).finance.income,0);
});

test('permanent return termination settlement credit refund contract variation and final project closure form a reachable full chain',async t=>{
  const f=await fixture(t),{p,l,c,s,cost,r}=await commercialFixture(f,{returnQuantity:3000});await terminateApproved(f,p,[{lineId:l.id,quantity:3000}]);const cr=await creditApproved(f,p,r,s,3000);ok(await f.transition(c,'closed'),409);await refundApproved(f,p,cr,cost,3000);
  const variation=await f.approve(await f.item('variations',{title:'供应商永久退货合同调减',code:randomUUID(),contractId:c.id,changeType:'decrease',amount:3000,occurredDate:today(),note:'单独确认合同金额调整'}));assert.equal((await f.row(c)).commercial.effectiveAmount,7000);assert.equal((await f.row(c)).commercial.purchaseAmount,7000);assert.equal((await f.row(c)).commercial.settlementAmount,7000);assert.equal((await settlementView(f,s)).paidAmount,7000);assert.equal((await f.detail()).finance.expense,7000);assert.equal(variation.data.amount,3000);ok(await f.transition(p,'closed'));ok(await f.transition(c,'closed'));ok(await projectState(f,'completed'));ok(await projectState(f,'archived'));
});

test('credits do not erase approved measured quantity or its existing contract commitment guard',async t=>{
  const f=await fixture(t),c=await f.contract({amount:10000}),{p,l,receipt}=await receivedPurchase(f,{contractId:c.id}),m=await f.approve(await f.item('measurements',{title:'原批准工程计量',code:randomUUID(),contractId:c.id,periodStart:'2026-10-01',periodEnd:'2026-10-10',note:'计量依据',lines:[{name:'已完成工程',location:'A段',unit:'米',quantity:10000,unitPrice:1000,note:''}]})),s=await f.approve(await f.item('settlements',{title:'关联原批准计量结算',contractId:c.id,measurementId:m.id,amount:10000,dueDate:'2026-10-25',note:'计量结算依据'})),cost=await payment(f,s),original=f.source('engineering_items',m),r=await dispatchApproved(f,p,[{receiptId:receipt,quantity:3000}]);await terminateApproved(f,p,[{lineId:l.id,quantity:3000}]);const cr=await creditApproved(f,p,r,s,3000);await refundApproved(f,p,cr,cost,3000);
  const reduction=await f.item('variations',{title:'不得抹掉已批计量承诺',code:randomUUID(),contractId:c.id,changeType:'decrease',amount:3000,occurredDate:today(),note:'调减仍受计量保护'});ok(await f.transition(reduction,'submitted'));const before=f.dbState();ok(await f.transition(reduction,'approved',f.users.reviewer.cookie),409);assert.deepEqual(f.dbState(),before);assert.deepEqual(f.source('engineering_items',m),original);assert.equal((await f.row(c)).commercial.measurementAmount,10000);assert.equal((await f.row(c)).commercial.settlementAmount,7000);assert.equal((await f.detail()).taskValues.summary.expense.totalAmount,10000);
});

test('refund approval recomputes shared settlement capacity after a competing refund on another original payment',async t=>{
  const f=await fixture(t),c=await f.contract({amount:10000}),{p,receipt}=await receivedPurchase(f,{contractId:c.id}),s=await settlement(f,c),one=await payment(f,s,5000),two=await payment(f,s,5000),r=await dispatchApproved(f,p,[{receiptId:receipt,quantity:4000}]),cr=await creditApproved(f,p,r,s,4000),a=await refund(f,p,cr,one,3000),b=await refund(f,p,cr,two,3000);ok(a,201);ok(b,201);
  ok(await reviewRefund(f,p,a.body));const before=f.dbState();ok(await reviewRefund(f,p,b.body),409);assert.deepEqual(f.dbState(),before);assert.equal((await finance(f)).refunds.find(x=>x.id===b.body.id).state,'submitted');assert.equal((await f.detail()).finance.expense,7000);ok(await reviewRefund(f,p,b.body,'cancelled',f.users.finance.cookie));await refundApproved(f,p,cr,two,1000);assert.equal((await f.detail()).finance.expense,6000);
});

test('credit approval rechecks cumulative return cap when another settlement consumes the same return',async t=>{
  const f=await fixture(t),c=await f.contract({amount:10000}),{p,receipt}=await receivedPurchase(f,{contractId:c.id}),a=await settlement(f,c,5000),b=await settlement(f,c,5000),r=await dispatchApproved(f,p,[{receiptId:receipt,quantity:4000}]),ca=await credit(f,p,r,a,3000),cb=await credit(f,p,r,b,3000);ok(ca,201);ok(cb,201);ok(await reviewCredit(f,p,ca.body));const before=f.dbState();ok(await reviewCredit(f,p,cb.body),409);assert.deepEqual(f.dbState(),before);assert.equal((await settlementView(f,b)).effectiveAmount,5000);ok(await reviewCredit(f,p,cb.body,'rejected'));assert.equal((await finance(f)).credits.find(x=>x.id===cb.body.id).state,'rejected');
});

test('financial replay uses exact original payload across concurrent decisions and restart with one approved cash effect',async t=>{
  const f=await fixture(t,true),{p,s,cost,r}=await commercialFixture(f),body={requestId:randomUUID(),returnId:r.id,settlementId:s.id,amount:4000,note:'合成幂等抵减'},cp=creditPath(f,p),race=await Promise.all([f.post(cp,body,f.users.finance.cookie),f.post(cp,body,f.users.finance.cookie)]);for(const x of race)ok(x,201);assert.equal(race[0].body.id,race[1].body.id);const cr=race[0].body,decision={requestId:randomUUID(),version:1,state:'approved',note:'幂等独立抵减审批'},dp=cp+'/'+cr.id+'/state';for(const x of await Promise.all([f.post(dp,decision,f.users.reviewer2.cookie),f.post(dp,decision,f.users.reviewer2.cookie)]))ok(x);
  const rb={requestId:randomUUID(),creditId:cr.id,costId:cost.id,amount:4000,occurredDate:today(),voucher:'IDEMPOTENT-REFUND',note:'合成实际到账'},rp=refundPath(f,p),rr=await f.post(rp,rb,f.users.finance.cookie);ok(rr,201);const rd={requestId:randomUUID(),version:1,state:'approved',note:'独立复核幂等到账'},rdp=rp+'/'+rr.body.id+'/state';for(const x of await Promise.all([f.post(rdp,rd,f.users.reviewer2.cookie),f.post(rdp,rd,f.users.reviewer2.cookie)]))ok(x);const before=f.dbState();await f.restart();for(const [path,payload,cookie,status] of [[cp,body,f.users.finance.cookie,201],[dp,decision,f.users.reviewer2.cookie,200],[rp,rb,f.users.finance.cookie,201],[rdp,rd,f.users.reviewer2.cookie,200]]){const replay=await f.post(path,payload,cookie);ok(replay,status);assert.equal(replay.body.replayed,true);}assert.deepEqual(f.dbState(),before);assert.equal((await f.detail()).finance.expense,6000);assert.equal((await finance(f)).refunds.length,1);ok(await f.post(rp,{...rb,amount:3999},f.users.finance.cookie),409);
});

test('financial schema reference and role errors have no records or audit side effects',async t=>{
  const f=await fixture(t),{p,s,cost,r}=await commercialFixture(f);const before=f.dbState();for(const amount of [0,-1,1.5,1000000000001])ok(await credit(f,p,r,s,amount),400);ok(await credit(f,p,r,s,1,undefined,{snapshot:{}}),400);for(const actor of ['engineer','viewer'])ok(await credit(f,p,r,s,1,f.users[actor].cookie),403);ok(await credit(f,p,r,s,1,f.users.outsider.cookie),404);assert.deepEqual(f.dbState(),before);
  const cr=await creditApproved(f,p,r,s,4000),b=f.dbState();for(const extra of [{occurredDate:dayAfter()},{occurredDate:'2026-02-30'},{voucher:''},{note:''},{refundedAmount:1}])ok(await refund(f,p,cr,cost,1,undefined,extra),400);for(const actor of ['engineer','viewer'])ok(await refund(f,p,cr,cost,1,f.users[actor].cookie),403);assert.deepEqual(f.dbState(),b);
});

test('pending credits and refunds block source correction and purchase contract and project closure without changing approved sources',async t=>{
  const f=await fixture(t),{p,s,cost,c,r}=await commercialFixture(f),cr=await credit(f,p,r,s,4000);ok(cr,201);const before=f.dbState();ok(await correction(f,s),409);ok(await f.transition(p,'closed'),409);ok(await f.transition(c,'closed'),409);ok(await projectState(f,'completed'),409);assert.deepEqual(f.dbState(),before);ok(await reviewCredit(f,p,cr.body));const rr=await refund(f,p,cr.body,cost,1000);ok(rr,201);const next=f.dbState();ok(await correction(f,s),409);ok(await f.transition(p,'closed'),409);ok(await f.transition(c,'closed'),409);ok(await projectState(f,'completed'),409);assert.deepEqual(f.dbState(),next);ok(await reviewRefund(f,p,rr.body,'cancelled',f.users.finance.cookie));
});

test('mobile finance permissions and revocation apply to replay while field JSON never exposes supplier credit or payment identifiers',async t=>{
  const f=await fixture(t),{p,s,cost,r}=await commercialFixture(f),login=await f.call('/mobile/login',{username:'qa-finance',password:f.password});ok(login);const headers={Authorization:'Bearer '+login.body.token},body={requestId:randomUUID(),returnId:r.id,settlementId:s.id,amount:4000,note:'移动财务抵减'},path='/mobile/engineering'+creditPath(f,p),cr=await f.call(path,body,'','POST',headers);ok(cr,201);ok(await reviewCredit(f,p,cr.body));const rr=await refundApproved(f,p,cr.body,cost,4000);
  for(const actor of ['engineer','viewer']){const detail=await f.detail(f.users[actor].cookie);assert.equal(detail.supplierFinance,null);assert.equal(detail.finance,null);const serialized=JSON.stringify(detail);for(const secret of [cr.body.id,rr.id,cost.id,s.id,p.id,'合成银行到账退款凭据'])assert.equal(serialized.includes(secret),false,secret);}
  ok(await f.post(f.pb+'/members',{userId:f.users.finance.id,role:'remove'},f.admin,'PUT'));ok(await f.call(path,body,'','POST',headers),404);
});

test('terminal rejected cancelled and approved records retain history and new writes require an active project',async t=>{
  const f=await fixture(t),{p,s,cost,r}=await commercialFixture(f),a=await credit(f,p,r,s,1000);ok(a,201);ok(await reviewCredit(f,p,a.body,'rejected'));const b=await credit(f,p,r,s,1000);ok(b,201);ok(await reviewCredit(f,p,b.body,'cancelled',f.users.finance.cookie));const c=await creditApproved(f,p,r,s,4000),rr=await refund(f,p,c,cost,1000);ok(rr,201);ok(await reviewCredit(f,p,c,'cancelled'),409);
  for(const state of ['completed','archived']){f.store.db.prepare('UPDATE engineering_projects SET state=? WHERE id=?').run(state,f.pid);const before=f.dbState();for(const action of ['approved','rejected','cancelled'])ok(await reviewRefund(f,p,rr.body,action),409);ok(await credit(f,p,r,s,1),409);ok(await refund(f,p,c,cost,1),409);assert.deepEqual(f.dbState(),before);}assert.equal((await finance(f)).credits.length,3);
});
