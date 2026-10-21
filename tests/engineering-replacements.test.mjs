import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {unzipSync,strFromU8} from 'fflate';
import {createApp} from '../server/app.mjs';
import {buildEngineeringWorkbook} from '../server/engineering-export.mjs';
import {buildEngineeringReplacementsView} from '../server/engineering-replacements.mjs';

// Real HTTP routes, synthetic accounts and disposable SQLite files only. No production service is contacted.
const ok=(response,status=200)=>assert.equal(response.status,status,JSON.stringify(response.body));
async function fixture(t,persistent=false){
  const dir=persistent?mkdtempSync(join(tmpdir(),'engineering-replacements-')):null;
  let server,state,url;
  const start=async()=>{server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));url='http://127.0.0.1:'+server.address().port;state=createApp({database:dir?join(dir,'test.sqlite'):':memory:',baseUrl:url,distPath:'__none__'});server.on('request',state.app);};
  const stop=async()=>{state.vision.close();server.closeAllConnections();await new Promise(r=>server.close(r));state.store.close();};
  await start();t.after(async()=>{await stop();if(dir){assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));assert.ok(dir.includes('engineering-replacements-'));rmSync(dir,{recursive:true,force:true});}});
  const call=async(path,body,cookie='',method=body===undefined?'GET':'POST',headers={})=>{
    const response=await fetch(url+'/api'+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json','X-Workspace-Request':'1',...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
    const bytes=Buffer.from(await response.arrayBuffer());let parsed;try{parsed=JSON.parse(bytes.toString());}catch{parsed=bytes;}
    return {status:response.status,body:parsed,bytes,cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const password='isolated-replacements-test-123',setup=await call('/setup',{organization:'纠错替代关系隔离验证',username:'qa-admin',name:'测试管理员',password});ok(setup,201);const admin=setup.cookie,users={};
  for(const name of ['author','reviewer','approver','finance','engineer','viewer','outsider']){
    ok(await call('/users',{username:'qa-'+name,name,role:name==='viewer'?'viewer':'operator',password},admin),201);
    const list=(await call('/users',undefined,admin)).body;users[name]={id:list.find(u=>u.name===name).id,cookie:(await call('/login',{username:'qa-'+name,password})).cookie};
  }
  const post=(path,body,cookie=admin,method='POST')=>call('/engineering'+path,{requestId:randomUUID(),...body},cookie,method);
  const projectData={code:randomUUID(),name:'纠错替代关系合成项目',address:'本机隔离场所',owner:'测试负责人',startDate:'2026-10-01',dueDate:'2026-12-31',budget:1000000,note:'合成数据'};
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

const path=f=>f.pb+'/replacements';
const read=async(f,query='',cookie=f.admin)=>{const response=await f.call('/engineering'+path(f)+query,undefined,cookie);ok(response);return response.body;};
const versionRow=async(f,value)=>(await read(f)).versions.find(row=>row.id===(typeof value==='string'?value:value.id));
const itemTarget=value=>({type:'item',id:typeof value==='string'?value:value.id});
const boqTarget=value=>({type:'boq',id:typeof value==='string'?value:value.id});
const relationBody=(correction,targets,resolution='replaced',extra={})=>({sourceCorrectionId:typeof correction==='string'?correction:correction.id,resolution,targets,note:'合成替代关系追溯依据',...extra});
const createRelation=async(f,body,cookie=f.users.finance.cookie)=>{const response=await f.post(path(f),body,cookie);ok(response,201);return versionRow(f,response.body.id);};
const decide=async(f,value,state='approved',cookie=f.admin)=>{const row=await versionRow(f,value);return f.post(path(f)+'/'+row.id+'/state',{version:row.version,state,note:'合成独立复核替代关联'},cookie);};
const approvedCorrection=async(f,source,{requester=f.users.finance.cookie,reviewer=f.users.reviewer.cookie}={})=>{
  const response=await f.correct(source,requester);ok(response,201);ok(await f.reviewCorrection(response.body.id,reviewer));return (await f.detail()).corrections.find(row=>row.id===response.body.id);
};
const dataFor=(kind,c,amount=1000)=>kind==='measurements'?freeMeasurement(c.id,amount):kind==='settlements'?settlement(c.id,amount):variation(c.id,{amount});
const prepare=async(f,kind='measurements',amount=1000)=>{
  const c=await approvedContract(f),source=await f.approve(await f.item(kind,dataFor(kind,c,amount))),correction=await approvedCorrection(f,source);
  const target=await f.approve(await f.item(kind,dataFor(kind,c,amount)));return {c,kind,source,correction,target,body:relationBody(correction,[itemTarget(target)])};
};
const business=async f=>({
  items:f.store.db.prepare('SELECT * FROM engineering_items WHERE project_id=? ORDER BY id').all(f.pid),
  boq:f.store.db.prepare('SELECT * FROM engineering_boq_revisions WHERE project_id=? ORDER BY id').all(f.pid),
  finance:(await f.detail()).finance,
});
const currentId=(report,correction)=>report.current.find(row=>row.sourceCorrectionId===(typeof correction==='string'?correction:correction.id))?.versionId;

test('replacement relations accept only approved corrections and schema-bounded typed targets with explicit resolutions',async t=>{
  const f=await fixture(t),p=await prepare(f);
  for(const extra of [{snapshot:{}},{amount:1000},{contractId:p.c.id},{state:'approved'}])ok(await f.post(path(f),{...p.body,...extra}),400);
  for(const targets of [[],Array.from({length:51},()=>itemTarget(p.target)),[{type:'measurement',id:p.target.id}],[{type:'item',id:'not-uuid'}],[{...itemTarget(p.target),amount:1000}],[itemTarget(p.target),itemTarget(p.target)]])ok(await f.post(path(f),{...p.body,targets}),400);
  for(const note of ['', ' '.repeat(3), '字'.repeat(2001)])ok(await f.post(path(f),{...p.body,note}),400);
  ok(await f.post(path(f),{...p.body,resolution:'no_replacement'}),400);ok(await f.post(path(f),{...p.body,resolution:'unknown'}),400);
  ok(await f.post(path(f),{...p.body,sourceCorrectionId:randomUUID()}),400);ok(await f.post(path(f),{...p.body,sourceCorrectionId:p.source.id}),400);
  const other=await f.approve(await f.item('measurements',freeMeasurement(p.c.id))),pending=await f.correct(other);ok(pending,201);ok(await f.post(path(f),{...p.body,sourceCorrectionId:pending.body.id}),409);
  ok(await f.post(f.pb+'/corrections/'+pending.body.id+'/state',{version:1,state:'rejected',note:'纠错未批准'},f.users.reviewer.cookie));ok(await f.post(path(f),{...p.body,sourceCorrectionId:pending.body.id}),409);
  const before=await read(f);assert.equal(before.versions.length,0);const relation=await createRelation(f,p.body);assert.equal(relation.state,'submitted');assert.equal(currentId(await read(f),p.correction),undefined);
});

test('measurement settlement and free variation replacement decisions append trace without changing originals targets or financial amounts',async t=>{
  const f=await fixture(t);
  for(const kind of ['measurements','settlements','variations']){
    const p=await prepare(f,kind),before=await business(f),oldSource=f.source(p.source),newSource=f.source(p.target),relation=await createRelation(f,p.body);ok(await decide(f,relation));
    assert.deepEqual(await business(f),before);assert.deepEqual(f.source(p.source),oldSource);assert.deepEqual(f.source(p.target),newSource);assert.equal((await f.row(p.source)).voided,true);assert.equal((await f.row(p.target)).voided,false);assert.equal(currentId(await read(f),p.correction),relation.id);
    const approved=await versionRow(f,relation);assert.equal(approved.state,'approved');assert.ok(approved.snapshot);assert.equal(approved.approved_seq>0,true);
  }
});

test('item targets must belong to the same project contract and business kind and be currently approved and unvoided',async t=>{
  const f=await fixture(t),p=await prepare(f),otherContract=await approvedContract(f),wrongContract=await f.approve(await f.item('measurements',freeMeasurement(otherContract.id))),wrongKind=await f.approve(await f.item('settlements',settlement(p.c.id)));
  for(const target of [wrongContract,wrongKind,p.source,p.c])ok(await f.post(path(f),{...p.body,targets:[itemTarget(target)]}),409);
  ok(await f.post(path(f),{...p.body,targets:[itemTarget(randomUUID())]}),409);
  const draft=await f.item('measurements',freeMeasurement(p.c.id));ok(await f.post(path(f),{...p.body,targets:[itemTarget(draft)]}),409);ok(await f.transition(draft,'submitted',f.users.author.cookie));ok(await f.post(path(f),{...p.body,targets:[itemTarget(draft)]}),409);await f.cancel(draft);ok(await f.post(path(f),{...p.body,targets:[itemTarget(draft)]}),409);
  const voided=await f.approve(await f.item('measurements',freeMeasurement(p.c.id)));await approvedCorrection(f,voided);ok(await f.post(path(f),{...p.body,targets:[itemTarget(voided)]}),409);
  const foreign=await f.post('/projects',{data:{...f.projectData,code:randomUUID()}});ok(foreign,201);const foreignBase='/projects/'+foreign.body.id;ok(await f.post(foreignBase+'/state',{version:1,state:'active',note:'独立项目'}));
  const foreignC=await f.post(foreignBase+'/items/contracts',{data:contract()});ok(foreignC,201);ok(await f.post(foreignBase+'/items/'+foreignC.body.id+'/state',{version:1,state:'submitted',note:'提交'}));ok(await f.post(foreignBase+'/members',{userId:f.users.reviewer.id,role:'manager'},f.admin,'PUT'));ok(await f.post(foreignBase+'/items/'+foreignC.body.id+'/state',{version:2,state:'approved',note:'独立批准'},f.users.reviewer.cookie));
  const foreignM=await f.post(foreignBase+'/items/measurements',{data:freeMeasurement(foreignC.body.id)});ok(foreignM,201);ok(await f.post(path(f),{...p.body,targets:[itemTarget(foreignM.body.id)]}),409);
  ok(await f.post(foreignBase+'/replacements',p.body),400);
});

test('target chronology uses last approval or update time and accepts equality instead of relying on creation time',async t=>{
  const f=await fixture(t),c=await approvedContract(f),source=await f.approve(await f.item('measurements',freeMeasurement(c.id))),early=await f.approve(await f.item('measurements',freeMeasurement(c.id))),draftBeforeCorrection=await f.item('measurements',freeMeasurement(c.id)),correction=await approvedCorrection(f,source);
  // Deterministic timestamp boundary in an isolated fixture: early is 1 ms before, not a timing-dependent sleep.
  f.store.db.prepare('UPDATE engineering_items SET updated_at=? WHERE id=?').run(new Date(Date.parse(correction.reviewed_at)-1).toISOString(),early.id);
  ok(await f.post(path(f),relationBody(correction,[itemTarget(early)])),409);
  f.store.db.prepare('UPDATE engineering_items SET updated_at=? WHERE id=?').run(correction.reviewed_at,early.id);const equal=await createRelation(f,relationBody(correction,[itemTarget(early)]));ok(await decide(f,equal,'cancelled',f.users.finance.cookie));
  const later=await f.approve(draftBeforeCorrection);assert.ok(later.created_at<=correction.reviewed_at);assert.ok(later.updated_at>=correction.reviewed_at);const accepted=await createRelation(f,relationBody(correction,[itemTarget(later)]));ok(await decide(f,accepted));
});

test('one-to-many and many-to-one trace permit unequal amounts and never multiply effective accounting',async t=>{
  const f=await fixture(t),c=await approvedContract(f),sources=[];
  for(let index=0;index<2;index++){const original=await f.approve(await f.item('measurements',freeMeasurement(c.id,1000)));sources.push(await approvedCorrection(f,original));}
  const targets=[];for(let index=0;index<50;index++)targets.push(await f.approve(await f.item('measurements',freeMeasurement(c.id,1))));
  const before=await business(f),one=await createRelation(f,relationBody(sources[0],targets.map(itemTarget)));ok(await decide(f,one));const two=await createRelation(f,relationBody(sources[1],[itemTarget(targets[0])]));ok(await decide(f,two));
  assert.deepEqual(await business(f),before);assert.equal((await f.row(c)).commercial.measurementAmount,50);assert.equal((await read(f)).current.length,2);
});

test('no-replacement decisions require a reason and newer approved resolutions supersede current while all snapshots remain immutable',async t=>{
  const f=await fixture(t),p=await prepare(f),before=await business(f),first=await createRelation(f,p.body);ok(await decide(f,first));const frozen=(await versionRow(f,first)).snapshot;
  const second=await createRelation(f,relationBody(p.correction,[],'no_replacement',{note:'核对确认无需新单，只保留撤销处理'}));assert.equal(currentId(await read(f),p.correction),first.id);ok(await decide(f,second));assert.equal(currentId(await read(f),p.correction),second.id);assert.equal((await versionRow(f,second)).resolution,'no_replacement');
  const third=await createRelation(f,p.body);ok(await decide(f,third));const report=await read(f);assert.equal(currentId(report,p.correction),third.id);assert.equal(report.versions.length,3);assert.deepEqual(report.versions.find(row=>row.id===first.id).snapshot,frozen);assert.equal(new Set(report.versions.map(row=>row.approved_seq)).size,3);assert.deepEqual(await business(f),before);
  for(const state of ['approved','rejected','cancelled'])ok(await decide(f,first,state),409);
  ok(await f.post(path(f)+'/'+first.id,{version:2,note:'不得编辑已批追溯'},f.users.finance.cookie,'PUT'),404);
});

test('review excludes the requester and all original target creators and last editors including attachment edits',async t=>{
  const f=await fixture(t),c=await approvedContract(f),source=await f.item('measurements',freeMeasurement(c.id)),bytes=Buffer.from('%PDF-1.7\nsynthetic immutable attachment\n%%EOF'),attachments=f.pb+'/items/'+source.id+'/attachments';
  const file=await f.post(attachments,{version:1,name:'原计量依据.pdf',caption:'合成原件',base64:bytes.toString('base64')},f.users.reviewer.cookie);ok(file,201);await f.approve(source);const correction=await approvedCorrection(f,source,{reviewer:f.users.approver.cookie});
  const targetInput=freeMeasurement(c.id),target=await f.item('measurements',targetInput,f.users.approver.cookie);ok(await f.edit(target,{...targetInput,title:'经过编辑的新单'},f.users.reviewer.cookie));await f.approve(target);
  const relation=await createRelation(f,relationBody(correction,[itemTarget(target)]),f.admin);
  for(const who of [f.admin,f.users.author.cookie,f.users.reviewer.cookie,f.users.approver.cookie])ok(await decide(f,relation,'approved',who),409);
  ok(await decide(f,relation,'approved',f.users.finance.cookie),403);ok(await f.post(f.pb+'/members',{userId:f.users.engineer.id,role:'manager'},f.admin,'PUT'));ok(await decide(f,relation,'approved',f.users.engineer.cookie));
  const downloaded=await f.call('/engineering'+attachments+'/'+file.body.id+'/download',undefined,f.admin);ok(downloaded);assert.deepEqual(downloaded.bytes,bytes);assert.equal((await f.call('/engineering'+attachments,undefined,f.admin)).body.writable,false);
  const excluded=(await versionRow(f,relation)).excludedReviewerIds;for(const id of [f.users.author.id,f.users.reviewer.id,f.users.approver.id])assert.ok(excluded.includes(id));
});

test('only requester or a manager may cancel and rejected or cancelled applications release the pending slot',async t=>{
  const f=await fixture(t),p=await prepare(f),first=await createRelation(f,p.body);ok(await f.post(path(f),p.body),409);
  ok(await f.post(f.pb+'/members',{userId:f.users.approver.id,role:'finance'},f.admin,'PUT'));ok(await decide(f,first,'cancelled',f.users.approver.cookie),403);ok(await decide(f,first,'approved',f.users.finance.cookie),403);ok(await decide(f,first,'cancelled',f.users.finance.cookie));
  const second=await createRelation(f,p.body);ok(await decide(f,second,'rejected',f.users.reviewer.cookie));const third=await createRelation(f,p.body);ok(await decide(f,third,'cancelled',f.users.reviewer.cookie));
  const report=await read(f);assert.equal(report.versions.length,3);assert.equal(report.current.length,0);for(const relation of [first,second,third])ok(await decide(f,relation),409);
});

test('approval rechecks a target corrected after submission and preserves the rejected application snapshot',async t=>{
  const f=await fixture(t),p=await prepare(f),relation=await createRelation(f,p.body),frozen=relation.snapshot;await approvedCorrection(f,p.target);
  ok(await decide(f,relation),409);const after=await versionRow(f,relation);assert.equal(after.state,'submitted');assert.deepEqual(after.snapshot,frozen);assert.equal(currentId(await read(f),p.correction),undefined);
  ok(await decide(f,relation,'cancelled',f.users.finance.cookie));
});

test('later correction of an approved replacement target preserves its original trace and exposes a continuing chain',async t=>{
  const f=await fixture(t),p=await prepare(f),first=await createRelation(f,p.body);ok(await decide(f,first));const frozen=(await versionRow(f,first)).snapshot;
  const nextCorrection=await approvedCorrection(f,p.target),nextTarget=await f.approve(await f.item('measurements',freeMeasurement(p.c.id,1200))),next=await createRelation(f,relationBody(nextCorrection,[itemTarget(nextTarget)]));ok(await decide(f,next));
  const report=await read(f),original=report.versions.find(row=>row.id===first.id);assert.equal(currentId(report,p.correction),first.id);assert.deepEqual(original.snapshot,frozen);assert.equal(original.targetStatuses[0].status,'voided');assert.equal(original.targetStatuses[0].effective,false);assert.equal(original.targetStatuses[0].sourceCorrectionId,nextCorrection.id);assert.ok(JSON.stringify(report.chains).includes(nextCorrection.id));assert.ok(JSON.stringify(report.chains).includes(nextTarget.id));assert.equal((await f.row(p.c)).commercial.measurementAmount,1200);
});

test('approval never silently replaces source or target frozen metadata when an imported record changes',async t=>{
  const f=await fixture(t),p=await prepare(f),relation=await createRelation(f,p.body),frozen=relation.snapshot;
  for(const item of [p.source,p.target]){
    const original=f.source(item),changed={...JSON.parse(original.data),title:'模拟遗留外部改写'};f.store.db.prepare('UPDATE engineering_items SET data=? WHERE id=?').run(JSON.stringify(changed),item.id);
    const response=await f.post(path(f)+'/'+relation.id+'/state',{version:1,state:'approved',note:'应先核对被冻结依据'});ok(response,422);
    f.store.db.prepare('UPDATE engineering_items SET data=? WHERE id=?').run(original.data,item.id);assert.deepEqual((await versionRow(f,relation)).snapshot,frozen);assert.equal((await versionRow(f,relation)).state,'submitted');
  }
  ok(await decide(f,relation));
});

async function prepareBoqCorrection(f){
  const c=await approvedContract(f),initial=await enableBoq(f,c),changed=await approveBoq(f,await createBoq(f,c,requestLines(initial.lines).map(line=>({...line,quantity:12000}))));
  const source=await f.row(changed.variation_id),correction=await approvedCorrection(f,source);assert.equal((await getContractBoq(f,c)).currentRevisionId,initial.id);
  return {c,initial,changed,source,correction};
}

test('BOQ signed-change corrections accept a later current zero-delta revision and freeze total separately from change amount',async t=>{
  const f=await fixture(t),p=await prepareBoqCorrection(f),replacement=await approveBoq(f,await createBoq(f,p.c,requestLines(p.initial.lines)));assert.equal(replacement.delta,0);assert.equal(replacement.variation_id,null);assert.ok(replacement.approved_seq>p.changed.approved_seq);
  const before=await business(f),relation=await createRelation(f,relationBody(p.correction,[boqTarget(replacement)]));ok(await decide(f,relation));assert.deepEqual(await business(f),before);
  const approved=await versionRow(f,relation);assert.equal(approved.snapshot.source.item.id,p.source.id);assert.equal(approved.snapshot.source.item.amount,2000);assert.equal(approved.snapshot.source.boqRevision.id,p.changed.id);assert.equal(approved.snapshot.targets[0].type,'boq');assert.equal(approved.snapshot.targets[0].amount,null);assert.equal(approved.snapshot.targets[0].total,10000);assert.equal(approved.snapshot.targets[0].delta,0);assert.equal(approved.targetStatuses[0].effective,true);
});

test('BOQ replacement eligibility requires current later approved sequence and approval chronology and rejects generic item targets',async t=>{
  const f=await fixture(t),p=await prepareBoqCorrection(f),make=targets=>f.post(path(f),relationBody(p.correction,targets));
  ok(await make([boqTarget(p.initial)]),409);ok(await make([boqTarget(p.changed)]),409);ok(await make([itemTarget(p.source)]),409);
  const draft=await createBoq(f,p.c,requestLines(p.initial.lines));ok(await make([boqTarget(draft)]),409);const replacement=await approveBoq(f,draft);
  f.store.db.prepare('UPDATE engineering_boq_revisions SET reviewed_at=? WHERE id=?').run(new Date(Date.parse(p.correction.reviewed_at)-1).toISOString(),replacement.id);ok(await make([boqTarget(replacement)]),409);
  f.store.db.prepare('UPDATE engineering_boq_revisions SET reviewed_at=? WHERE id=?').run(p.correction.reviewed_at,replacement.id);const exact=await createRelation(f,relationBody(p.correction,[boqTarget(replacement)]));ok(await decide(f,exact,'cancelled',f.users.finance.cookie));
  const pending=await createRelation(f,relationBody(p.correction,[boqTarget(replacement)])),newCurrent=await approveBoq(f,await createBoq(f,p.c,requestLines(replacement.lines)));ok(await decide(f,pending),409);ok(await decide(f,pending,'cancelled',f.users.finance.cookie));
  ok(await make([boqTarget(replacement)]),409);const accepted=await createRelation(f,relationBody(p.correction,[boqTarget(newCurrent)]));ok(await decide(f,accepted));const later=await approveBoq(f,await createBoq(f,p.c,requestLines(newCurrent.lines)));assert.notEqual(later.id,newCurrent.id);const oldTrace=await versionRow(f,accepted);assert.equal(oldTrace.targetStatuses[0].status,'superseded');assert.equal(oldTrace.state,'approved');
});

test('financial project permissions protect relation history snapshots candidates and all write endpoints',async t=>{
  const f=await fixture(t),p=await prepare(f),relation=await createRelation(f,{...p.body,note:'保密替代依据_827193'});
  ok(await f.call('/engineering'+path(f)),401);ok(await f.call('/engineering'+path(f),undefined,f.users.outsider.cookie),404);
  for(const name of ['engineer','viewer']){
    ok(await f.call('/engineering'+path(f),undefined,f.users[name].cookie),403);ok(await f.post(path(f),p.body,f.users[name].cookie),403);ok(await f.post(path(f)+'/'+relation.id+'/state',{version:1,state:'approved',note:'越权应拒绝'},f.users[name].cookie),403);
    const publicDetail=await f.detail(f.users[name].cookie);assert.equal(JSON.stringify(publicDetail).includes('827193'),false);assert.equal(publicDetail.items.some(row=>row.id===p.source.id||row.id===p.target.id),false);
  }
  for(const name of ['author','reviewer','finance']){const data=await read(f,'',f.users[name].cookie);assert.ok(data.versions.some(row=>row.id===relation.id));assert.ok(data.eligibleSources.length>0);}
  ok(await f.call('/engineering'+path(f)+'?sourceCorrectionId='+randomUUID(),undefined,f.admin),404);ok(await f.call('/engineering'+path(f)+'?sourceCorrectionId=bad',undefined,f.admin),400);ok(await f.call('/engineering'+path(f)+'?unknown=1',undefined,f.admin),400);
  const filtered=await read(f,'?sourceCorrectionId='+p.correction.id);assert.equal(filtered.selectedSourceCorrectionId,p.correction.id);
  ok(await f.call('/engineering'+path(f),{requestId:randomUUID(),...p.body},f.users.finance.cookie,'POST',{'X-Workspace-Request':''}),403);
});

test('simultaneous create and approve calls have one winner and stale versions cannot change the current relation',async t=>{
  const f=await fixture(t),p=await prepare(f),created=await Promise.all([f.post(path(f),p.body,f.users.finance.cookie),f.post(path(f),p.body,f.users.author.cookie)]);assert.deepEqual(created.map(row=>row.status).sort(),[201,409]);const rid=created.find(row=>row.status===201).body.id;
  ok(await f.post(path(f)+'/'+rid+'/state',{version:2,state:'approved',note:'过期版本'}),409);
  const responses=await Promise.all([f.admin,f.users.reviewer.cookie].map(cookie=>f.post(path(f)+'/'+rid+'/state',{version:1,state:'approved',note:'并发独立复核'},cookie)));assert.deepEqual(responses.map(row=>row.status).sort(),[200,409]);
  let report=await read(f);assert.equal(report.versions.length,1);assert.equal(currentId(report,p.correction),rid);assert.equal(report.versions[0].version,2);
  const next=await createRelation(f,relationBody(p.correction,[],'no_replacement'));assert.equal(currentId(await read(f),p.correction),rid);ok(await decide(f,next));report=await read(f);assert.equal(report.current.length,1);assert.equal(currentId(report,p.correction),next.id);assert.ok(report.versions.find(row=>row.id===next.id).approved_seq>report.versions.find(row=>row.id===rid).approved_seq);
});

test('relation and decision request receipts survive SQLite reopening without duplicate relationships history or accounting',async t=>{
  const f=await fixture(t,true),p=await prepare(f),createPath='/engineering'+path(f),createBody={requestId:randomUUID(),...p.body};
  const created=await f.call(createPath,createBody,f.users.finance.cookie);ok(created,201);const retry=await f.call(createPath,createBody,f.users.finance.cookie);ok(retry,201);assert.equal(retry.body.id,created.body.id);assert.equal(retry.body.replayed,true);ok(await f.call(createPath,{...createBody,note:'同号不得不同内容'},f.users.finance.cookie),409);
  const statePath=createPath+'/'+created.body.id+'/state',approveBody={requestId:randomUUID(),version:1,state:'approved',note:'持久化独立批准'};ok(await f.call(statePath,approveBody,f.admin));
  const version=await versionRow(f,created.body.id),money=await business(f),history=(await f.detail()).history.length;await f.restart();assert.deepEqual(await versionRow(f,created.body.id),version);assert.deepEqual(await business(f),money);
  for(const [route,body,cookie,status] of [[createPath,createBody,f.users.finance.cookie,201],[statePath,approveBody,f.admin,200]]){const response=await f.call(route,body,cookie);ok(response,status);assert.equal(response.body.replayed,true);}
  const report=await read(f);assert.equal(report.versions.length,1);assert.equal(report.current.length,1);assert.equal(currentId(report,p.correction),created.body.id);assert.equal((await f.detail()).history.length,history);assert.deepEqual(await business(f),money);ok(await f.call(statePath,{...approveBody,requestId:randomUUID()},f.admin),409);
});

test('submitted relations block fully settled contract close and legacy project completion until a decision releases the pending slot',async t=>{
  const f=await fixture(t),p=await prepare(f,'measurements',10000),relation=await createRelation(f,p.body),s=await f.approve(await f.item('settlements',settlement(p.c.id,10000,p.target.id)));await f.approve(await f.item('costs',cost(s.id,10000)));
  const close=await f.transition(p.c,'closed');ok(close,409);assert.match(JSON.stringify(close.body),/更正关联/);
  // Isolate the project guard for a legacy import where the contract is already closed.
  f.store.db.prepare("UPDATE engineering_items SET state='closed' WHERE id=?").run(p.c.id);const project=(await f.detail()).project;ok(await f.post(f.pb+'/state',{version:project.version,state:'completed',note:'仅替代关系待审仍须阻断'}),409);
  ok(await decide(f,relation,'cancelled',f.users.finance.cookie));ok(await f.post(f.pb+'/state',{version:project.version,state:'completed',note:'待办已撤回可完成'}));ok(await f.post(path(f),p.body),409);await read(f);
  const completed=(await f.detail()).project;ok(await f.post(f.pb+'/state',{version:completed.version,state:'archived',note:'归档合成项目'}));ok(await f.post(path(f),p.body),409);await read(f);
});

test('a closed contract accepts pure trace after settlement without reopening or altering any original business record',async t=>{
  const f=await fixture(t),p=await prepare(f,'measurements',10000),s=await f.approve(await f.item('settlements',settlement(p.c.id,10000,p.target.id)));await f.approve(await f.item('costs',cost(s.id,10000)));ok(await f.transition(p.c,'closed'));
  const before=await business(f),closed=f.source(p.c),relation=await createRelation(f,p.body);ok(await decide(f,relation));assert.deepEqual(await business(f),before);assert.deepEqual(f.source(p.c),closed);assert.equal((await f.row(p.c)).state,'closed');
});

test('mobile finance creation independent review and membership revocation match desktop authorization immediately',async t=>{
  const f=await fixture(t),p=await prepare(f),login=await f.call('/mobile/login',{username:'qa-finance',password:f.password});ok(login);const headers={Authorization:'Bearer '+login.body.token},mobile='/mobile/engineering'+path(f);
  const created=await f.call(mobile,{requestId:randomUUID(),...p.body},'','POST',headers);ok(created,201);ok(await f.call(mobile,undefined,'','GET',headers));
  const managerLogin=await f.call('/mobile/login',{username:'qa-reviewer',password:f.password});ok(managerLogin);const managerHeaders={Authorization:'Bearer '+managerLogin.body.token};
  ok(await f.post(f.pb+'/members',{userId:f.users.reviewer.id,role:'finance'},f.admin,'PUT'));ok(await f.call(mobile+'/'+created.body.id+'/state',{requestId:randomUUID(),version:1,state:'approved',note:'经理角色已撤销'},'','POST',managerHeaders),403);
  ok(await f.post(f.pb+'/members',{userId:f.users.reviewer.id,role:'manager'},f.admin,'PUT'));ok(await f.call(mobile+'/'+created.body.id+'/state',{requestId:randomUUID(),version:1,state:'approved',note:'移动端独立复核'},'','POST',managerHeaders));
  ok(await f.post(f.pb+'/members',{userId:f.users.finance.id,role:'remove'},f.admin,'PUT'));ok(await f.call(mobile,undefined,'','GET',headers),404);ok(await f.call(mobile,{requestId:randomUUID(),...p.body},'','POST',headers),404);ok(await f.call('/engineering'+path(f),undefined,f.users.finance.cookie),404);
  const siteLogin=await f.call('/mobile/login',{username:'qa-engineer',password:f.password});ok(siteLogin);ok(await f.call(mobile,undefined,'','GET',{Authorization:'Bearer '+siteLogin.body.token}),403);
});

test('a concurrent target correction and relation approval cannot leave accounting duplicated or a voided target shown as effective',async t=>{
  const f=await fixture(t),p=await prepare(f),relation=await createRelation(f,p.body),correction=await f.correct(p.target);ok(correction,201);
  const responses=await Promise.all([
    f.post(path(f)+'/'+relation.id+'/state',{version:1,state:'approved',note:'并发替代追溯批准'}),
    f.post(f.pb+'/corrections/'+correction.body.id+'/state',{version:1,state:'approved',note:'并发纠错批准'},f.users.reviewer.cookie),
  ]);ok(responses[1]);assert.ok([200,409].includes(responses[0].status),JSON.stringify(responses[0].body));assert.equal((await f.row(p.c)).commercial.measurementAmount,0);
  const result=await versionRow(f,relation);assert.equal(result.targetStatuses[0].effective,false);assert.equal(result.targetStatuses[0].status,'voided');assert.equal(result.targetStatuses[0].sourceCorrectionId,correction.body.id);assert.equal(result.state,responses[0].status===200?'approved':'submitted');assert.equal(currentId(await read(f),p.correction),responses[0].status===200?relation.id:undefined);
});

function workbook(bytes){
  const archive=unzipSync(bytes),xml=name=>strFromU8(archive[name]),decode=value=>value.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
  const names=[...xml('xl/workbook.xml').matchAll(/<sheet name="([^"]+)"/g)].map(match=>decode(match[1]));
  const records=name=>{
    const index=names.indexOf(name);assert.ok(index>=0,'Missing worksheet '+name);
    const [keys,...values]=[...xml('xl/worksheets/sheet'+(index+1)+'.xml').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(row=>[...row[1].matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>/g)].map(cell=>{const n=cell[1].match(/<v>([^<]*)<\/v>/);return n?Number(n[1]):decode(cell[1].match(/<t\b[^>]*>([\s\S]*?)<\/t>/)?.[1]||'');}));
    return values.map(row=>Object.fromEntries(keys.map((key,index)=>[key,row[index]])));
  };
  return {archive,names,records};
}

test('HTTP workbooks preserve all relation versions rebuild target status and reject cross-project or altered frozen export snapshots',async t=>{
  const f=await fixture(t),p=await prepare(f),first=await createRelation(f,p.body);ok(await decide(f,first));const second=await createRelation(f,relationBody(p.correction,[],'no_replacement'));ok(await decide(f,second));const targetCorrection=await approvedCorrection(f,p.target);
  const finalTarget=await f.approve(await f.item('measurements',freeMeasurement(p.c.id,1500))),before=await business(f),snapshot=await f.detail();
  const login=await f.call('/mobile/login',{username:'qa-finance',password:f.password});ok(login);
  const check=book=>{
    assert.equal(book.names.length,14);const relations=book.records('更正关联'),targets=book.records('更正替代明细');assert.equal(relations.length,2);assert.equal(targets.length,1);
    assert.equal(relations.filter(row=>row['当前已批关联']==='是').length,1);assert.equal(relations.find(row=>row['当前已批关联']==='是')['关联版本ID'],second.id);assert.equal(relations.find(row=>row['关联版本ID']===second.id)['办理结论'],'无需补单');
    assert.equal(targets[0]['正确依据ID'],p.target.id);assert.equal(targets[0]['当前依据状态'],'已撤销业务影响');assert.equal(targets[0]['后续纠错ID'],targetCorrection.id);assert.equal(targets[0]['单据金额（元）'],10);
    const measures=book.records('计量总表');assert.equal(measures.reduce((total,row)=>total+row['有效计量（元）'],0),15);assert.equal(measures.find(row=>row['记录ID']===finalTarget.id)['原计量金额（元）'],15);assert.equal(book.records('合同')[0]['有效计量（元）'],15);
    const allXml=Object.values(book.archive).map(bytes=>strFromU8(bytes)).join('\n');assert.equal(allXml.includes(f.password),false);assert.equal(/<f(?:\s|>)/.test(allXml),false);
  };
  for(const [route,cookie,headers] of [['/engineering'+f.pb+'/export',f.users.finance.cookie,{}],['/mobile/engineering'+f.pb+'/export','',{Authorization:'Bearer '+login.body.token}]]){const response=await f.call(route,undefined,cookie,'GET',headers);ok(response);check(workbook(response.bytes));}
  const cached=structuredClone(snapshot);cached.replacements.current=[{sourceCorrectionId:p.correction.id,versionId:first.id}];for(const row of cached.replacements.versions){row.isCurrent=row.id===first.id;row.targetStatuses=row.snapshot.targets.map(target=>({type:target.type,id:target.id,effective:true,status:'effective',sourceCorrectionId:null}));}check(workbook(buildEngineeringWorkbook(cached)));
  const foreign=structuredClone(snapshot);foreign.replacements.versions[0].project_id=randomUUID();assert.throws(()=>buildEngineeringWorkbook(foreign),error=>error.status===422);
  const altered=structuredClone(snapshot),hasTarget=altered.replacements.versions.find(row=>row.snapshot.targets.length);hasTarget.snapshot.targets[0].amount+=1;assert.throws(()=>buildEngineeringWorkbook(altered),error=>error.status===422);assert.deepEqual(await business(f),before);
});

const replacementContext=detail=>({project:detail.project,items:detail.items,corrections:detail.corrections,boq:detail.boq,versions:detail.replacements.versions});
const assertInvalidReplacementSnapshot=detail=>{
  assert.throws(()=>buildEngineeringReplacementsView(replacementContext(detail)),error=>error.status===422);
  assert.throws(()=>buildEngineeringWorkbook(detail),error=>error.status===422);
};

test('pure builder and export reject duplicate project-wide approval sequences across same or different correction sources regardless of order',async t=>{
  const f=await fixture(t),firstSource=await prepare(f),first=await createRelation(f,firstSource.body);ok(await decide(f,first));
  const second=await createRelation(f,relationBody(firstSource.correction,[],'no_replacement'));ok(await decide(f,second));
  const otherSource=await prepare(f),third=await createRelation(f,otherSource.body);ok(await decide(f,third));
  const detail=await f.detail(),original=structuredClone(detail.replacements.versions),valid=buildEngineeringReplacementsView(replacementContext(detail));assert.equal(valid.current.length,2);assert.equal(currentId(valid,firstSource.correction),second.id);assert.equal(currentId(valid,otherSource.correction),third.id);assert.ok(buildEngineeringWorkbook(detail).byteLength>0);
  const firstSequence=original.find(row=>row.id===first.id).approved_seq;assert.equal(new Set(original.map(row=>row.approved_seq)).size,3);
  for(const duplicateId of [second.id,third.id])for(const reverse of [false,true]){
    const tampered=structuredClone(detail);tampered.replacements.versions.find(row=>row.id===duplicateId).approved_seq=firstSequence;if(reverse)tampered.replacements.versions.reverse();assertInvalidReplacementSnapshot(tampered);
  }
  assert.deepEqual((await read(f)).versions,original);
});

test('pure builder and export reject null target snapshots as an explicit 422 instead of throwing a TypeError',async t=>{
  const f=await fixture(t),p=await prepare(f),relation=await createRelation(f,p.body);ok(await decide(f,relation));const detail=await f.detail(),before=await business(f);
  assert.equal(buildEngineeringReplacementsView(replacementContext(detail)).current[0].versionId,relation.id);
  for(const targets of [[null],null]){const tampered=structuredClone(detail);tampered.replacements.versions[0].snapshot.targets=targets;assertInvalidReplacementSnapshot(tampered);}
  assert.equal((await versionRow(f,relation)).snapshot.targets[0].id,p.target.id);assert.deepEqual(await business(f),before);
});

