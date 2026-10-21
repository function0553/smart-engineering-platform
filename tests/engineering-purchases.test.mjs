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
  const dir=persistent?mkdtempSync(join(tmpdir(),'engineering-purchases-')):null;
  const database=dir?join(dir,'test.sqlite'):':memory:';let server,state,url,running=false;
  const start=async()=>{server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+server.address().port;state=createApp({database,baseUrl:url,distPath:'__none__'});server.on('request',state.app);running=true;};
  const stop=async()=>{if(!running)return;state.vision.close();server.closeAllConnections();await new Promise(r=>server.close(r));state.store.close();running=false;};
  await start();t.after(async()=>{await stop();if(dir){assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep)&&dir.includes('engineering-purchases-'));rmSync(dir,{recursive:true,force:true});}});
  const call=async(path,body,cookie='',method=body===undefined?'GET':'POST',headers={})=>{const r=await fetch(url+'/api'+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json','X-Workspace-Request':'1',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),bytes=Buffer.from(await r.arrayBuffer());let parsed;try{parsed=JSON.parse(bytes.toString());}catch{parsed=bytes;}return {status:r.status,body:parsed,bytes,headers:r.headers,cookie:r.headers.get('set-cookie')?.split(';')[0]};};
  const password='isolated-purchases-test-123',setup=await call('/setup',{organization:'采购履约隔离验证',username:'qa-admin',name:'管理员',password});ok(setup,201);const admin=setup.cookie,users={};
  for(const name of ['author','reviewer','reviewer2','finance','engineer','viewer','outsider']){ok(await call('/users',{username:'qa-'+name,name,role:name==='viewer'?'viewer':'operator',password},admin),201);const list=(await call('/users',undefined,admin)).body;users[name]={id:list.find(u=>u.name===name).id,cookie:(await call('/login',{username:'qa-'+name,password})).cookie};}
  const post=(path,body,cookie=admin,method='POST')=>call('/engineering'+path,{requestId:randomUUID(),...body},cookie,method);
  const projectData={code:randomUUID(),name:'多行采购合成项目',address:'本机隔离场所',owner:'测试负责人',startDate:'2026-10-01',dueDate:'2026-12-31',budget:10000000,note:'合成采购验证'};
  const project=await post('/projects',{data:projectData});ok(project,201);const pid=project.body.id,pb='/projects/'+pid;
  ok(await post(pb+'/state',{version:1,state:'active',note:'合成开工'}));
  for(const [name,role] of [['author','manager'],['reviewer','manager'],['reviewer2','manager'],['finance','finance'],['engineer','engineer'],['viewer','manager']])ok(await post(pb+'/members',{userId:users[name].id,role},admin,'PUT'));
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
  const dbState=()=>Object.fromEntries(state.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'engineering_%' ORDER BY name").all().map(({name})=>[name,state.store.db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]));
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

test('new purchases freeze row identities and sum per-row rounded amounts without mixing materials units or prices',async t=>{
  const f=await fixture(t),sand=await f.material({title:'中砂',unit:'吨'}),pipe=await f.material({title:'管材',unit:'米'});
  const p=await f.item('purchases',purchaseData([line(sand,1500,101),line(pipe,500,101),line(sand,1,1)]));
  assert.equal(p.data.amount,203);assert.deepEqual(p.data.lines.map(r=>r.amount),[152,51,0]);assert.equal(new Set(p.data.lines.map(r=>r.id)).size,3);assert.deepEqual(p.data.lines.map(r=>r.unit),['吨','米','吨']);assert.deepEqual(p.data.lines.map(r=>r.unitPrice),[101,101,1]);
  const draft=await order(f,p);assert.equal(draft.legacy,false);assert.equal(draft.identityFrozen,true);assert.equal(draft.originalAmount,203);assert.equal(draft.effectiveAmount,0);assert.equal(draft.releasedAmount,0);assert.ok(draft.lines.every(r=>r.effectiveAmount===0));
  await f.approve(p);const approved=await order(f,p);assert.equal(approved.effectiveAmount,203);assert.equal(approved.lines.length,3);assert.equal('quantity' in approved,false);assert.equal((await f.detail()).receipts[p.id],undefined);
});

test('purchase input rejects forged fields mixed modes borrowed duplicate IDs overlimits and mode conversion',async t=>{
  const f=await fixture(t),m=await f.material(),p=await f.item('purchases',purchaseData([line(m)])),legacy=await f.item('purchases',legacyPurchase(m));
  for(const forged of [{amount:1},{materialTitle:'伪造'},{unit:'伪造单位'},{warehouse:'伪造库房'}])ok(await f.post(f.pb+'/items/purchases',{data:purchaseData([line(m,1000,1000,forged)])},f.users.author.cookie),400);
  for(const lines of [[],Array.from({length:51},()=>line(m)),[line(m,0)],[line(m,1.5)],[line(m,1000000001)],[line(m,1000,0)],[line(m,1000,1000000000001)],[line(m,1,1)],[line(m,1000000000,1000000000000)],[line(m,1000,600000000000),line(m,1000,600000000000)]])ok(await f.post(f.pb+'/items/purchases',{data:purchaseData(lines)},f.users.author.cookie),400);
  ok(await f.post(f.pb+'/items/purchases',{data:{...legacyPurchase(m),lines:[line(m)]}},f.users.author.cookie),400);
  ok(await f.post(f.pb+'/items/purchases',{data:purchaseData([line(m,1000,1000,{id:p.data.lines[0].id})])},f.users.author.cookie),400);
  ok(await f.edit(p,purchaseData([line(m,1000,1000,{id:p.data.lines[0].id}),line(m,2000,1000,{id:p.data.lines[0].id})])),400);
  ok(await f.edit(p,legacyPurchase(m)),409);ok(await f.edit(legacy,purchaseData([line(m)])),409);
  ok(await f.edit(p,purchaseData([line(m,12000,1000,{id:p.data.lines[0].id}),line(m,2000,1100)])));assert.equal((await f.row(p)).data.lines[0].id,p.data.lines[0].id);
});

test('material identity drift blocks submission and approved purchase locks every identity field before first receipt',async t=>{
  const f=await fixture(t),m=await f.material(),p=await f.item('purchases',purchaseData([line(m)]));
  ok(await f.edit(m,{...m.data,title:'保存后更名'}));ok(await f.transition(p,'submitted'),409);ok(await f.edit(p,purchaseData(inputLines(p))));await f.approve(p);
  const current=await f.row(m);for(const key of ['title','code','specification','unit','warehouse'])ok(await f.edit(m,{...current.data,[key]:'批准后不得修改'+key}),409);
  const frozen=(await order(f,p)).lines[0];assert.equal(frozen.materialTitle,'保存后更名');assert.equal((await f.detail()).stock.length,0);ok(await f.edit(m,{...current.data,note:'可修改说明'}));assert.equal((await order(f,p)).lines[0].materialTitle,frozen.materialTitle);
});

test('batch receipts are atomic and per-line caps prevent cross-material or same-material price-line pooling',async t=>{
  const f=await fixture(t),a=await f.material({unit:'吨'}),b=await f.material({unit:'米'}),p=await f.approve(await f.item('purchases',purchaseData([line(a,10000,1000),line(b,5000,2000),line(a,3000,1200)]))),o=await order(f,p),[x,y,z]=o.lines;
  const first=await receive(f,p,[{lineId:x.id,quantity:4000},{lineId:y.id,quantity:2000},{lineId:z.id,quantity:1000}]);ok(first,201);assert.equal(first.body.stockIds.length,3);assert.equal(new Set(first.body.stockIds).size,3);assert.ok(first.body.receiptBatchId);
  const movements=(await f.detail()).stock;assert.equal(new Set(movements.map(s=>s.receipt_batch_id)).size,1);assert.equal(movements[0].receipt_batch_id,first.body.receiptBatchId);assert.deepEqual(movements.map(s=>s.purchase_line_id).sort(),[x.id,y.id,z.id].sort());
  const before=f.dbState();ok(await receive(f,p,[{lineId:x.id,quantity:6000},{lineId:y.id,quantity:3001}]),409);assert.deepEqual(f.dbState(),before);
  ok(await receive(f,p,[{lineId:z.id,quantity:2001}]),409);ok(await receive(f,p,[{lineId:x.id,quantity:1},{lineId:x.id,quantity:1}]),400);assert.deepEqual(f.dbState(),before);
  const next=await receive(f,p,[{lineId:x.id,quantity:6000},{lineId:y.id,quantity:3000},{lineId:z.id,quantity:2000}]);ok(next,201);assert.notEqual(next.body.receiptBatchId,first.body.receiptBatchId);const final=await order(f,p);assert.deepEqual(final.lines.map(r=>r.remainingQuantity),[0,0,0]);assert.equal((await f.detail()).balances[a.id],13000);assert.equal((await f.detail()).balances[b.id],5000);assert.equal(final.canClose,true);ok(await f.transition(p,'closed'));
});

test('old receive endpoint requires a correct line for new purchases and rejects line metadata on unrelated movement kinds',async t=>{
  const f=await fixture(t),a=await f.material(),b=await f.material(),p=await f.approve(await f.item('purchases',purchaseData([line(a),line(b)]))),o=await order(f,p),[x,y]=o.lines;
  ok(await f.movement(a.id,'receive',1000,p.id),400);ok(await f.post(f.pb+'/stock',{materialId:a.id,kind:'receive',quantity:1000,referenceId:p.id,purchaseLineId:y.id,note:'错材料行'}),400);
  const r=await f.post(f.pb+'/stock',{materialId:a.id,kind:'receive',quantity:1000,referenceId:p.id,purchaseLineId:x.id,note:'兼容逐行入口'});ok(r,201);const stock=f.source('engineering_stock',r.body.id);assert.equal(stock.purchase_line_id,x.id);assert.ok(stock.receipt_batch_id);assert.equal((await order(f,p)).lines[0].receivedQuantity,1000);
  for(const kind of ['opening','issue','return'])ok(await f.post(f.pb+'/stock',{materialId:a.id,kind,quantity:1,referenceId:'',purchaseLineId:x.id,note:'不相关行号'}),400);
});

test('receipt permissions foreign purchases lines and materials and closed contract gates are rechecked',async t=>{
  const f=await fixture(t),m=await f.material(),p=await f.approve(await f.item('purchases',purchaseData([line(m)]))),l=await orderLine(f,p);
  for(const role of ['finance','engineer','viewer'])ok(await receive(f,p,[{lineId:l.id,quantity:1}],f.users[role].cookie),403);ok(await receive(f,p,[{lineId:l.id,quantity:1}],f.users.outsider.cookie),404);
  const q=await f.approve(await f.item('purchases',purchaseData([line(m)]))),foreignLine=await orderLine(f,q);ok(await receive(f,p,[{lineId:foreignLine.id,quantity:1}]),400);
  const other=await f.post('/projects',{data:{...f.projectData,code:randomUUID()}});ok(other,201);const otherPb='/projects/'+other.body.id;ok(await f.post(otherPb+'/state',{version:1,state:'active',note:'另项目'}));const otherMaterial=await f.post(otherPb+'/items/materials',{data:{...m.data,code:randomUUID()}});ok(otherMaterial,201);ok(await f.post(f.pb+'/items/purchases',{data:purchaseData([line(otherMaterial.body)])},f.users.author.cookie),400);ok(await f.post(otherPb+'/purchases/'+p.id+'/receipts',{note:'跨项目',lines:[{lineId:l.id,quantity:1}]}),400);
  const c=await f.contract(),linked=await f.approve(await f.item('purchases',purchaseData([line(m)],{contractId:c.id}))),cl=await orderLine(f,linked);f.store.db.prepare("UPDATE engineering_items SET state='closed' WHERE id=?").run(c.id);const before=f.dbState();ok(await receive(f,linked,[{lineId:cl.id,quantity:1}]),409);assert.deepEqual(f.dbState(),before);
});

test('receipt idempotency concurrent capacity and restart never duplicate batches or stock',async t=>{
  const f=await fixture(t,true),m=await f.material(),p=await f.approve(await f.item('purchases',purchaseData([line(m)]))),l=await orderLine(f,p),requestId=randomUUID(),input=[{lineId:l.id,quantity:6000}];
  const r=await receive(f,p,input,f.users.author.cookie,{requestId});ok(r,201);const before=f.dbState();await f.restart();const retry=await receive(f,p,input,f.users.author.cookie,{requestId});ok(retry,201);assert.equal(retry.body.replayed,true);assert.equal(retry.body.receiptBatchId,r.body.receiptBatchId);assert.deepEqual(retry.body.stockIds,r.body.stockIds);assert.deepEqual(f.dbState(),before);
  ok(await receive(f,p,[{lineId:l.id,quantity:6001}],f.users.author.cookie,{requestId}),409);const race=await Promise.all([receive(f,p,[{lineId:l.id,quantity:4000}]),receive(f,p,[{lineId:l.id,quantity:4000}])]);assert.deepEqual(race.map(r=>r.status).sort(),[201,409]);assert.equal((await orderLine(f,p)).receivedQuantity,10000);assert.equal((await f.detail()).stock.length,2);
});

test('partial and repeated termination uses remaining total rounding and preserves original data state version and inventory',async t=>{
  const f=await fixture(t),m=await f.material(),p=await f.approve(await f.item('purchases',purchaseData([line(m,1000,1)]))),l=await orderLine(f,p),original=f.source('engineering_items',p),before=(await f.detail()).balances[m.id];
  const first=await terminateApproved(f,p,[{lineId:l.id,quantity:500}]);let o=await order(f,p);assert.equal(o.effectiveAmount,1);assert.equal(o.releasedAmount,0);assert.equal(o.lines[0].remainingQuantity,500);
  const second=await terminateApproved(f,p,[{lineId:l.id,quantity:1}]);o=await order(f,p);assert.equal(o.effectiveAmount,0);assert.equal(o.releasedAmount,1);assert.equal(o.lines[0].terminatedQuantity,501);
  await terminateApproved(f,p,[{lineId:l.id,quantity:499}]);o=await order(f,p);assert.equal(o.releasedAmount,1);assert.equal(o.lines[0].remainingQuantity,0);assert.equal(o.canClose,true);assert.deepEqual(f.source('engineering_items',p),original);assert.equal((await f.detail()).balances[m.id],before);assert.equal((await f.detail()).stock.length,0);
  const terms=(await f.detail()).purchaseFulfillment.terminations;assert.equal(terms.find(t=>t.id===first.id).snapshot.lines[0].releasedAmount,0);assert.equal(terms.find(t=>t.id===second.id).snapshot.lines[0].releasedAmount,1);ok(await terminate(f,p,[{lineId:l.id,quantity:1}]),409);ok(await receive(f,p,[{lineId:l.id,quantity:1}]),409);
});

test('termination rejects already received quantity and requires independent requester creator and editor approval',async t=>{
  const f=await fixture(t),m=await f.material(),p=await f.item('purchases',purchaseData([line(m)]));ok(await f.edit(p,purchaseData(inputLines(p)),f.users.finance.cookie));await f.approve(p);const l=await orderLine(f,p);ok(await receive(f,p,[{lineId:l.id,quantity:4000}]),201);
  ok(await terminate(f,p,[{lineId:l.id,quantity:6001}]),409);const r=await terminate(f,p,[{lineId:l.id,quantity:6000}],f.users.reviewer.cookie);ok(r,201);const before=f.dbState();
  ok(await reviewTermination(f,p,r.body,'approved',f.users.reviewer.cookie),409);ok(await reviewTermination(f,p,r.body,'approved',f.users.author.cookie),409);assert.deepEqual(f.dbState(),before);
  ok(await f.post(f.pb+'/members',{userId:f.users.finance.id,role:'manager'},f.admin,'PUT'));ok(await reviewTermination(f,p,r.body,'approved',f.users.finance.cookie),409);ok(await reviewTermination(f,p,r.body));assert.equal((await orderLine(f,p)).terminatedQuantity,6000);assert.equal((await f.detail()).balances[m.id],4000);
});

test('pending termination locks receipts reversals and closure; pending receipt reversal blocks termination',async t=>{
  const f=await fixture(t),m=await f.material(),p=await f.approve(await f.item('purchases',purchaseData([line(m)]))),l=await orderLine(f,p),receipt=await receive(f,p,[{lineId:l.id,quantity:4000}]);ok(receipt,201);
  const r=await terminate(f,p,[{lineId:l.id,quantity:2000}]);ok(r,201);const before=f.dbState();ok(await receive(f,p,[{lineId:l.id,quantity:1}]),409);ok(await f.reverse(receipt.body.stockIds[0]),409);ok(await terminate(f,p,[{lineId:l.id,quantity:1}]),409);ok(await f.transition(p,'closed'),409);assert.deepEqual(f.dbState(),before);
  const project=(await f.detail()).project;ok(await f.post(f.pb+'/state',{version:project.version,state:'completed',note:'待审不能完工'}),409);ok(await reviewTermination(f,p,r.body,'cancelled',f.users.finance.cookie));
  const reversal=await f.reverse(receipt.body.stockIds[0]);ok(reversal,201);ok(await terminate(f,p,[{lineId:l.id,quantity:1}]),409);ok(await f.reviewReversal(reversal.body,'cancelled',f.users.engineer.cookie));ok(await terminate(f,p,[{lineId:l.id,quantity:1}]),201);
});

test('termination approval rechecks frozen original and observed quantities with a fully rolled back stale decision',async t=>{
  const f=await fixture(t),m=await f.material(),p=await f.approve(await f.item('purchases',purchaseData([line(m)]))),l=await orderLine(f,p),r=await terminate(f,p,[{lineId:l.id,quantity:2000}]);ok(r,201);const original=f.source('engineering_items',p),term=f.source('engineering_purchase_terminations',r.body.id);
  // Simulate a legacy maintenance/import writer bypassing the normal lock; the approval boundary must still recheck.
  f.store.db.prepare('UPDATE engineering_items SET version=version+1 WHERE id=?').run(p.id);let before=f.dbState();ok(await reviewTermination(f,p,r.body),409);assert.deepEqual(f.dbState(),before);assert.equal(f.source('engineering_purchase_terminations',r.body.id).snapshot,term.snapshot);
  f.store.db.prepare('UPDATE engineering_items SET version=? WHERE id=?').run(original.version,p.id);
  f.store.db.prepare('INSERT INTO engineering_stock(id,project_id,material_id,kind,quantity,reference_id,note,actor_id,created_at,purchase_line_id,receipt_batch_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),f.pid,m.id,'receive',1,p.id,'模拟外部旧入库',f.users.author.id,new Date().toISOString(),l.id,'');
  before=f.dbState();ok(await reviewTermination(f,p,r.body),409);assert.deepEqual(f.dbState(),before);ok(await reviewTermination(f,p,r.body,'cancelled',f.users.finance.cookie));
});

test('termination cancelled and rejected histories have no business effect and exact receipts survive restart',async t=>{
  const f=await fixture(t,true),m=await f.material(),p=await f.approve(await f.item('purchases',purchaseData([line(m)]))),l=await orderLine(f,p),requestId=randomUUID();
  const first=await terminate(f,p,[{lineId:l.id,quantity:2000}],f.users.finance.cookie,{requestId});ok(first,201);ok(await reviewTermination(f,p,first.body,'cancelled',f.users.author.cookie));assert.equal((await orderLine(f,p)).terminatedQuantity,0);
  const replay=await terminate(f,p,[{lineId:l.id,quantity:2000}],f.users.finance.cookie,{requestId});ok(replay,201);assert.equal(replay.body.replayed,true);assert.equal(replay.body.id,first.body.id);
  const second=await terminate(f,p,[{lineId:l.id,quantity:3000}]);ok(second,201);ok(await reviewTermination(f,p,second.body,'rejected'));assert.equal((await orderLine(f,p)).terminatedQuantity,0);
  const third=await terminate(f,p,[{lineId:l.id,quantity:4000}]);ok(third,201);const reviewId=randomUUID();ok(await reviewTermination(f,p,third.body,'approved',f.users.reviewer2.cookie,{requestId:reviewId}));const before=f.dbState();await f.restart();const decision=await reviewTermination(f,p,third.body,'approved',f.users.reviewer2.cookie,{requestId:reviewId});ok(decision);assert.equal(decision.body.replayed,true);assert.deepEqual(f.dbState(),before);assert.equal((await orderLine(f,p)).terminatedQuantity,4000);assert.equal((await f.detail()).purchaseFulfillment.terminations.length,3);
});

test('released purchase commitment feeds contract summaries while measured commitments still protect reductions',async t=>{
  const f=await fixture(t),m=await f.material(),c=await f.contract({amount:10000}),p=await f.approve(await f.item('purchases',purchaseData([line(m)],{contractId:c.id}))),l=await orderLine(f,p);
  const measurement=await f.approve(await f.item('measurements',{title:'已批实测',code:randomUUID(),contractId:c.id,periodStart:'2026-10-01',periodEnd:'2026-10-10',lines:[{name:'实测量',location:'测试段',unit:'米',quantity:7000,unitPrice:1000,note:''}],note:'合成计量依据'}));
  await terminateApproved(f,p,[{lineId:l.id,quantity:4000}]);let summary=(await f.row(c)).commercial;assert.equal(summary.purchaseAmount,6000);assert.equal(summary.measurementAmount,7000);assert.equal(summary.committedAmount,7000);
  const change=await f.item('variations',{title:'试减合同额',code:randomUUID(),contractId:c.id,changeType:'decrease',amount:4000,occurredDate:'2026-10-12',note:'不能绕过计量承诺'});ok(await f.transition(change,'submitted'));ok(await f.transition(change,'approved',f.users.reviewer.cookie),409);ok(await f.transition(change,'draft'));ok(await f.edit(change,{...change.data,amount:3000}));await f.approve(change);summary=(await f.row(c)).commercial;assert.equal(summary.effectiveAmount,7000);assert.equal(summary.purchaseAmount,6000);assert.equal((await f.row(measurement)).data.amount,7000);
});

test('BOQ revision guards use effective purchase commitments after independently approved termination',async t=>{
  const f=await fixture(t),m=await f.material(),c=await f.contract({amount:10000}),initial=await approveBoq(f,c,[{code:'BOQ-1',name:'合同范围',location:'测试段',unit:'米',quantity:10000,unitPrice:1000}]);ok(initial.approved);
  const boq=(await f.call('/engineering'+f.pb+'/boq',undefined,f.admin)).body,baseLine=boq.contracts.find(r=>r.contractId===c.id).items[0];
  const p=await f.approve(await f.item('purchases',purchaseData([line(m)],{contractId:c.id}))),l=await orderLine(f,p),lines=[{id:baseLine.id,code:baseLine.code,name:baseLine.name,location:baseLine.location,unit:baseLine.unit,quantity:6000,unitPrice:1000}],body={contractId:c.id,title:'减量修订',note:'采购余量终止后调整',lines};
  ok(await f.post(f.pb+'/boq',body,f.users.author.cookie),409);await terminateApproved(f,p,[{lineId:l.id,quantity:4000}]);
  const reduced=await f.post(f.pb+'/boq',body,f.users.author.cookie);ok(reduced,201);ok(await f.post(f.pb+'/boq/'+reduced.body.id+'/state',{version:1,state:'submitted',note:'送审'},f.users.author.cookie));
  const later=await f.approve(await f.item('purchases',purchaseData([line(m,4000)],{contractId:c.id}))),laterLine=await orderLine(f,later);const before=f.dbState();ok(await f.post(f.pb+'/boq/'+reduced.body.id+'/state',{version:2,state:'approved',note:'审批重检新增采购承诺'},f.users.reviewer.cookie),409);assert.deepEqual(f.dbState(),before);
  await terminateApproved(f,later,[{lineId:laterLine.id,quantity:4000}]);const result=await f.post(f.pb+'/boq/'+reduced.body.id+'/state',{version:2,state:'approved',note:'采购余量已独立终止，可重核合同承诺'},f.users.reviewer.cookie);ok(result);assert.equal((await f.row(c)).commercial.effectiveAmount,6000);assert.equal((await f.row(c)).commercial.purchaseAmount,6000);assert.equal((await order(f,p)).effectiveAmount,6000);
});

test('receipt reversal reopens only its line and closed purchase contract without changing approved terminated quantities',async t=>{
  const f=await fixture(t),a=await f.material({title:'甲料'}),b=await f.material({title:'乙料'}),c=await f.contract({amount:14000}),p=await f.approve(await f.item('purchases',purchaseData([line(a,10000,1000),line(b,2000,2000)],{contractId:c.id}))),o=await order(f,p),[x,y]=o.lines;
  const receipt=await receive(f,p,[{lineId:x.id,quantity:6000},{lineId:y.id,quantity:2000}]);ok(receipt,201);const termination=await terminateApproved(f,p,[{lineId:x.id,quantity:4000}]);ok(await f.transition(p,'closed'));
  const settlement=await f.approve(await f.item('settlements',{title:'合成合同结算',contractId:c.id,measurementId:'',amount:14000,dueDate:'2026-10-25',note:'合成结算依据'}));await f.approve(await f.item('costs',{title:'合成付款',direction:'expense',category:'material',settlementId:settlement.id,amount:14000,occurredDate:'2026-10-12',voucher:randomUUID(),note:'合成付款依据'}));ok(await f.transition(c,'closed'));
  const aStockId=receipt.body.lines.find(r=>r.lineId===x.id).stockId,bStockId=receipt.body.lines.find(r=>r.lineId===y.id).stockId,oldA=f.source('engineering_stock',aStockId),oldB=f.source('engineering_stock',bStockId),oldTermination=f.source('engineering_purchase_terminations',termination.id);
  const reversal=await f.reverse(aStockId);ok(reversal,201);ok(await f.reviewReversal(reversal.body));const after=await order(f,p);assert.equal(after.lines[0].receivedQuantity,0);assert.equal(after.lines[0].terminatedQuantity,4000);assert.equal(after.lines[0].remainingQuantity,6000);assert.equal(after.lines[1].receivedQuantity,2000);assert.equal(after.lines[1].remainingQuantity,0);assert.equal(after.effectiveAmount,10000);assert.equal((await f.row(p)).state,'approved');assert.equal((await f.row(c)).state,'approved');assert.deepEqual(f.source('engineering_stock',aStockId),oldA);assert.deepEqual(f.source('engineering_stock',bStockId),oldB);assert.deepEqual(f.source('engineering_purchase_terminations',termination.id),oldTermination);
  ok(await f.transition(p,'closed'),409);ok(await receive(f,p,[{lineId:x.id,quantity:6000}]),201);ok(await f.transition(p,'closed'));ok(await f.transition(c,'closed'));assert.equal((await orderLine(f,p)).terminatedQuantity,4000);
});

test('field detail hides financial projections and procurement references while retaining quantities and return operations',async t=>{
  const f=await fixture(t),m=await f.material(),p=await f.approve(await f.item('purchases',purchaseData([line(m,10000,12345)],{title:'PRIVATE_PURCHASE_TITLE',supplier:'PRIVATE_PURCHASE_SUPPLIER'}))),l=await orderLine(f,p),r=await receive(f,p,[{lineId:l.id,quantity:6000}]);ok(r,201);const reversal=await f.reverse(r.body.stockIds[0]);ok(reversal,201);
  const view=await f.detail(f.users.engineer.cookie);assert.equal(view.purchaseFulfillment,null);assert.equal(view.items.some(i=>i.id===p.id),false);assert.deepEqual(view.receipts,{});assert.equal(view.balances[m.id],6000);const stock=view.stock.find(s=>s.id===r.body.stockIds[0]);assert.equal(stock.quantity,6000);
  const text=JSON.stringify(view);for(const secret of [p.id,l.id,r.body.receiptBatchId,'PRIVATE_PURCHASE_TITLE','PRIVATE_PURCHASE_SUPPLIER'])assert.equal(text.includes(secret),false,'Field projection leaked '+secret);assert.equal('unitPrice' in stock,false);
  ok(await f.reviewReversal(reversal.body,'cancelled',f.users.engineer.cookie));const issue=await f.movement(m.id,'issue',1000,'',f.users.engineer.cookie);ok(issue,201);ok(await f.movement(m.id,'return',1000,issue.body.id,f.users.engineer.cookie),201);
});

test('termination ACL mobile parity optimistic state and project locks apply to new routes',async t=>{
  const f=await fixture(t),m=await f.material(),p=await f.approve(await f.item('purchases',purchaseData([line(m)]))),l=await orderLine(f,p);
  for(const role of ['engineer','viewer'])ok(await terminate(f,p,[{lineId:l.id,quantity:1}],f.users[role].cookie),403);ok(await terminate(f,p,[{lineId:l.id,quantity:1}],f.users.outsider.cookie),404);ok(await terminate(f,p,[{lineId:l.id,quantity:1}],f.users.finance.cookie,{version:1}),409);
  const login=await f.call('/mobile/login',{username:'qa-finance',password:f.password});ok(login);const headers={Authorization:'Bearer '+login.body.token},path='/mobile/engineering'+f.pb+'/purchases/'+p.id+'/terminations';const r=await f.call(path,{requestId:randomUUID(),version:(await f.row(p)).version,note:'移动端财务终止申请',lines:[{lineId:l.id,quantity:10000}]},'','POST',headers);ok(r,201);
  ok(await reviewTermination(f,p,r.body,'approved',f.users.finance.cookie),403);ok(await reviewTermination(f,p,r.body,'approved',f.users.reviewer2.cookie,{version:2}),409);ok(await reviewTermination(f,p,r.body));ok(await f.transition(p,'closed'));const project=(await f.detail()).project;ok(await f.post(f.pb+'/state',{version:project.version,state:'completed',note:'业务全部办理后完工'}));const before=f.dbState();ok(await receive(f,p,[{lineId:l.id,quantity:1}]),409);ok(await terminate(f,p,[{lineId:l.id,quantity:1}]),409);assert.deepEqual(f.dbState(),before);
  ok(await f.post(f.pb+'/members',{userId:f.users.finance.id,role:'remove'},f.admin,'PUT'));ok(await f.call(path,{requestId:randomUUID(),version:1,note:'权限撤销后不得重放',lines:[{lineId:l.id,quantity:1}]},'','POST',headers),404);
});

test('legacy single-material purchase and old stock payload remain compatible with partial receipts and returns',async t=>{
  const f=await fixture(t),m=await f.material(),p=await f.approve(await f.item('purchases',legacyPurchase(m)));
  assert.equal(p.data.amount,10000);const purchaseOriginal=f.source('engineering_items',p);
  const first=await f.movement(m.id,'receive',4000,p.id);ok(first,201);
  // The same legacy order can span receipts written before and after the schema migration.
  f.store.db.prepare("UPDATE engineering_stock SET purchase_line_id='',receipt_batch_id='' WHERE id=?").run(first.body.id);
  const legacyLine=await orderLine(f,p);const second=await receive(f,p,[{lineId:legacyLine.id,quantity:6000}]);ok(second,201);ok(await f.movement(m.id,'receive',1,p.id),409);assert.equal((await orderLine(f,p)).receivedQuantity,10000);assert.ok(f.source('engineering_stock',second.body.stockIds[0]).purchase_line_id);assert.equal(f.source('engineering_stock',first.body.id).purchase_line_id,'');
  const issue=await f.movement(m.id,'issue',3000);ok(issue,201);ok(await f.movement(m.id,'return',1000,issue.body.id),201);
  const detail=await f.detail();assert.equal(detail.balances[m.id],8000);assert.equal(detail.receipts[p.id],10000);assert.deepEqual(f.source('engineering_items',p),purchaseOriginal);ok(await f.transition(p,'closed'));
});

test('real restart migrates the old nine-column stock schema without rewriting legacy purchase or pending reversal snapshot',async t=>{
  const f=await fixture(t,true),m=await f.material(),p=await f.approve(await f.item('purchases',legacyPurchase(m)));
  const payload={requestId:randomUUID(),materialId:m.id,kind:'receive',quantity:10000,referenceId:p.id,note:'旧九列版本验收入库'};
  const incoming=await f.post(f.pb+'/stock',payload,f.users.author.cookie);ok(incoming,201);ok(await f.transition(p,'closed'));
  const reversal=await f.reverse(incoming.body);ok(reversal,201);const sid=incoming.body.id,rid=reversal.body.id,old=pick(f.source('engineering_stock',sid),oldStockColumns);
  // This is the exact pre-migration server snapshot format, including key order.
  const oldSnapshot=JSON.stringify({title:m.data.title,kind:'receive',quantity:10000,materialId:m.id,referenceId:p.id,createdBy:f.users.author.id,editedBy:'',amount:0,quantityDelta:-10000});
  f.store.db.prepare('UPDATE engineering_reversals SET snapshot=? WHERE id=?').run(oldSnapshot,rid);
  // The old version did not have a source snapshot table; do not invent frozen identity on restart.
  f.store.db.prepare('DELETE FROM engineering_purchase_sources WHERE purchase_id=?').run(p.id);
  const originalPurchase=f.source('engineering_items',p),originalReversal=f.source('engineering_reversals',rid);
  await f.restart(db=>{
    for(const index of db.prepare("PRAGMA index_list('engineering_stock')").all()){
      assert.match(index.name,/^[a-zA-Z_][a-zA-Z0-9_]*$/);
      const columns=db.prepare('PRAGMA index_info('+index.name+')').all().map(c=>c.name);
      if(columns.some(name=>['purchase_line_id','receipt_batch_id'].includes(name)))db.exec('DROP INDEX '+index.name);
    }
    for(const column of ['purchase_line_id','receipt_batch_id'])if(db.prepare("PRAGMA table_info('engineering_stock')").all().some(c=>c.name===column))db.exec('ALTER TABLE engineering_stock DROP COLUMN '+column);
    assert.deepEqual(db.prepare("PRAGMA table_info('engineering_stock')").all().map(c=>c.name),oldStockColumns);
  });
  const columns=f.store.db.prepare("PRAGMA table_info('engineering_stock')").all().map(c=>c.name);assert.ok(columns.includes('purchase_line_id')&&columns.includes('receipt_batch_id'));assert.equal(columns.length,11);
  assert.equal((await order(f,p)).identityFrozen,false);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM engineering_purchase_sources WHERE purchase_id=?').get(p.id).n,0);
  assert.deepEqual(pick(f.source('engineering_stock',sid),oldStockColumns),old);assert.deepEqual(f.source('engineering_items',p),originalPurchase);assert.deepEqual(f.source('engineering_reversals',rid),originalReversal);assert.equal(f.source('engineering_reversals',rid).snapshot,oldSnapshot);
  const replay=await f.post(f.pb+'/stock',payload,f.users.author.cookie);ok(replay,201);assert.equal(replay.body.id,sid);assert.equal(replay.body.replayed,true);assert.equal((await f.detail()).stock.length,1);
  await f.restart();assert.equal(f.store.db.prepare("PRAGMA table_info('engineering_stock')").all().length,11);assert.equal(f.source('engineering_reversals',rid).snapshot,oldSnapshot);
  ok(await f.reviewReversal(rid));assert.equal(f.source('engineering_reversals',rid).snapshot,oldSnapshot);assert.deepEqual(pick(f.source('engineering_stock',sid),oldStockColumns),old);assert.equal((await f.row(p)).state,'approved');assert.equal((await f.detail()).balances[m.id],0);assert.equal((await f.detail()).receipts[p.id],0);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM engineering_adjustments WHERE reversal_id=?').get(rid).n,1);
});

test('receipt and termination bodies reject foreign lines forged snapshots duplicates and invalid quantities without partial writes',async t=>{
  const f=await fixture(t),m=await f.material(),p=await f.approve(await f.item('purchases',purchaseData([line(m),line(m,4000,1100)]))),q=await f.approve(await f.item('purchases',purchaseData([line(m)]))),[x,y]=(await order(f,p)).lines,foreign=await orderLine(f,q);
  const invalid=[[],[{lineId:x.id,quantity:0}],[{lineId:x.id,quantity:-1}],[{lineId:x.id,quantity:1.5}],[{lineId:x.id,quantity:1000000001}],[{lineId:x.id,quantity:1},{lineId:x.id,quantity:1}],[{lineId:x.id,quantity:1},{lineId:foreign.id,quantity:1}],[{lineId:x.id,quantity:1,materialId:m.id}]];
  const before=f.dbState();for(const entries of invalid){ok(await receive(f,p,entries),400);ok(await terminate(f,p,entries),400);assert.deepEqual(f.dbState(),before);}
  ok(await terminate(f,p,[{lineId:x.id,quantity:1},{lineId:y.id,quantity:4001}]),409);ok(await terminate(f,p,[{lineId:x.id,quantity:1}],f.users.finance.cookie,{snapshot:{releasedAmount:1}}),400);assert.deepEqual(f.dbState(),before);
  const decision=await terminate(f,p,[{lineId:x.id,quantity:1000},{lineId:y.id,quantity:2000}]);ok(decision,201);ok(await reviewTermination(f,q,decision.body),404);ok(await reviewTermination(f,p,decision.body));assert.deepEqual((await order(f,p)).lines.map(r=>r.terminatedQuantity),[1000,2000]);assert.equal((await orderLine(f,q)).terminatedQuantity,0);
});

test('termination concurrent exact retries produce one decision and replays still require current membership',async t=>{
  const f=await fixture(t),m=await f.material(),p=await f.approve(await f.item('purchases',purchaseData([line(m)]))),l=await orderLine(f,p),requestId=randomUUID(),entries=[{lineId:l.id,quantity:2000}];
  const race=await Promise.all([terminate(f,p,entries,f.users.finance.cookie,{requestId}),terminate(f,p,entries,f.users.finance.cookie,{requestId})]);for(const r of race)ok(r,201);assert.equal(race[0].body.id,race[1].body.id);assert.equal((await f.detail()).purchaseFulfillment.terminations.length,1);
  ok(await terminate(f,p,[{lineId:l.id,quantity:2001}],f.users.finance.cookie,{requestId}),409);
  ok(await f.post(f.pb+'/members',{userId:f.users.reviewer.id,role:'finance'},f.admin,'PUT'));ok(await reviewTermination(f,p,race[0].body,'cancelled',f.users.reviewer.cookie),403);
  const reviewId=randomUUID(),decisions=await Promise.all([reviewTermination(f,p,race[0].body,'approved',f.users.reviewer2.cookie,{requestId:reviewId}),reviewTermination(f,p,race[0].body,'approved',f.users.reviewer2.cookie,{requestId:reviewId})]);for(const r of decisions)ok(r);assert.equal((await orderLine(f,p)).terminatedQuantity,2000);assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM engineering_history WHERE project_id=? AND action='termination_approved'").get(f.pid).n,1);
  ok(await f.post(f.pb+'/members',{userId:f.users.finance.id,role:'remove'},f.admin,'PUT'));ok(await terminate(f,p,entries,f.users.finance.cookie,{requestId}),404);
});

test('termination releases procurement capacity without erasing settled commitments or changing signed contract amount',async t=>{
  const f=await fixture(t),m=await f.material(),c=await f.contract({amount:10000}),p=await f.approve(await f.item('purchases',purchaseData([line(m)],{contractId:c.id}))),l=await orderLine(f,p),originalContract=f.source('engineering_items',c);
  const later=await f.item('purchases',purchaseData([line(m,2000)],{contractId:c.id}));ok(await f.transition(later,'submitted'));ok(await f.transition(later,'approved',f.users.reviewer.cookie),409);
  const settlement=await f.approve(await f.item('settlements',{title:'未关联计量的旧式结算',contractId:c.id,measurementId:'',amount:8000,dueDate:'2026-10-25',note:'合成手工结算依据'}));
  await terminateApproved(f,p,[{lineId:l.id,quantity:4000}]);let summary=(await f.row(c)).commercial;assert.equal(summary.effectiveAmount,10000);assert.equal(summary.purchaseAmount,6000);assert.equal(summary.settlementAmount,8000);assert.equal(summary.committedAmount,8000);assert.deepEqual(f.source('engineering_items',c),originalContract);assert.equal((await f.row(settlement)).data.amount,8000);
  const decrease=await f.item('variations',{title:'低于结算的调减',code:randomUUID(),contractId:c.id,changeType:'decrease',amount:3000,occurredDate:'2026-10-12',note:'不得绕过结算承诺'});ok(await f.transition(decrease,'submitted'));const before=f.dbState();ok(await f.transition(decrease,'approved',f.users.reviewer.cookie),409);assert.deepEqual(f.dbState(),before);
  ok(await f.transition(later,'approved',f.users.reviewer.cookie));summary=(await f.row(c)).commercial;assert.equal(summary.purchaseAmount,8000);assert.equal(summary.settlementAmount,8000);assert.equal(summary.committedAmount,8000);
});

test('approval rechecks a termination introduced after a receipt reversal request and close guards explain the pending decision',async t=>{
  const f=await fixture(t),m=await f.material(),c=await f.contract(),p=await f.approve(await f.item('purchases',purchaseData([line(m)],{contractId:c.id}))),l=await orderLine(f,p),receipt=await receive(f,p,[{lineId:l.id,quantity:4000}]);ok(receipt,201);
  const term=await terminate(f,p,[{lineId:l.id,quantity:2000}]);ok(term,201);const contractClose=await f.transition(c,'closed');ok(contractClose,409);assert.match(contractClose.body.error,/待审采购余量终止/);
  ok(await reviewTermination(f,p,term.body,'cancelled',f.users.finance.cookie));const reversal=await f.reverse(receipt.body.stockIds[0]);ok(reversal,201);
  // Restore the pending source as if a legacy maintenance writer raced after reversal creation.
  f.store.db.prepare("UPDATE engineering_purchase_terminations SET state='submitted',version=1,reviewed_by=NULL,reviewer_name=NULL,review_note=NULL,reviewed_at=NULL WHERE id=?").run(term.body.id);
  const before=f.dbState();ok(await f.reviewReversal(reversal.body),409);assert.deepEqual(f.dbState(),before);assert.equal((await orderLine(f,p)).receivedQuantity,4000);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM engineering_adjustments WHERE reversal_id=?').get(reversal.body.id).n,0);
});

test('mobile receipts and terminal decisions enforce role changes and current project status before writes',async t=>{
  const f=await fixture(t),m=await f.material(),p=await f.approve(await f.item('purchases',purchaseData([line(m)]))),l=await orderLine(f,p),login=await f.call('/mobile/login',{username:'qa-author',password:f.password});ok(login);
  const headers={Authorization:'Bearer '+login.body.token},path='/mobile/engineering'+f.pb+'/purchases/'+p.id+'/receipts',body={requestId:randomUUID(),note:'移动采购验收',lines:[{lineId:l.id,quantity:4000}]};const receipt=await f.call(path,body,'','POST',headers);ok(receipt,201);assert.equal((await orderLine(f,p)).receivedQuantity,4000);
  ok(await f.post(f.pb+'/members',{userId:f.users.author.id,role:'engineer'},f.admin,'PUT'));ok(await f.call(path,body,'','POST',headers),403);assert.equal((await f.detail()).stock.length,1);
  const term=await terminate(f,p,[{lineId:l.id,quantity:1000}]);ok(term,201);f.store.db.prepare("UPDATE engineering_projects SET state='completed' WHERE id=?").run(f.pid);const before=f.dbState();for(const state of ['approved','rejected','cancelled'])ok(await reviewTermination(f,p,term.body,state),409);assert.deepEqual(f.dbState(),before);
});
