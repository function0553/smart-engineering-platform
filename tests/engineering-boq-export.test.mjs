import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {existsSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {spawnSync} from 'node:child_process';
import {unzipSync,strFromU8} from 'fflate';
import {createApp} from '../server/app.mjs';
import {buildEngineeringWorkbook} from '../server/engineering-export.mjs';

const ok=(r,status=200)=>assert.equal(r.status,status,Buffer.isBuffer(r.body)?r.body.subarray(0,100).toString():JSON.stringify(r.body));
async function fixture(t,projectExtra={}){
  const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const baseUrl='http://127.0.0.1:'+server.address().port;
  const {app,store,vision}=createApp({database:':memory:',baseUrl,distPath:'__none__'});server.on('request',app);
  t.after(async()=>{vision.close();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();});
  const call=async(path,body,cookie='',method=body===undefined?'GET':'POST',headers={})=>{
    const res=await fetch(baseUrl+'/api'+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json','X-Workspace-Request':'1',...headers},...(body===undefined?{}:{body:JSON.stringify(body)})}),bytes=Buffer.from(await res.arrayBuffer());let parsed;try{parsed=JSON.parse(bytes.toString());}catch{parsed=bytes;}
    return {status:res.status,body:parsed,bytes,headers:res.headers,cookie:res.headers.get('set-cookie')?.split(';')[0]};
  };
  const password='export-test-fixture-only-123',setup=await call('/setup',{organization:'导出隔离测试',username:'qa-admin',name:'管理员',password});ok(setup,201);const admin=setup.cookie,users={};
  for(const name of ['manager','finance','engineer','viewer','outsider']){
    ok(await call('/users',{username:'qa-'+name,name,role:name==='viewer'?'viewer':'operator',password},admin),201);const list=(await call('/users',undefined,admin)).body;
    users[name]={id:list.find(r=>r.name===name).id,cookie:(await call('/login',{username:'qa-'+name,password})).cookie};
  }
  const post=(path,data,cookie=admin,method='POST')=>call('/engineering'+path,{requestId:randomUUID(),...data},cookie,method);
  const projectData={code:randomUUID(),name:'本机合成导出项目',address:'隔离测试场所',owner:'合成负责人',startDate:'2026-10-01',dueDate:'2026-12-31',budget:1000000,note:'合成项目依据',...projectExtra};
  const pr=await post('/projects',{data:projectData});ok(pr,201);const pid=pr.body.id,pb='/projects/'+pid;
  ok(await post(pb+'/state',{version:1,state:'active',note:'测试开工'}));
  for(const [name,role] of [['manager','manager'],['finance','finance'],['engineer','engineer'],['viewer','manager']])ok(await post(pb+'/members',{userId:users[name].id,role},admin,'PUT'));
  const detail=async()=>(await call('/engineering'+pb,undefined,admin)).body;
  const row=async item=>(await detail()).items.find(r=>r.id===(typeof item==='string'?item:item.id));
  const item=async(kind,data)=>{const r=await post(pb+'/items/'+kind,{data},users.manager.cookie);ok(r,201);return row(r.body.id);};
  const transition=async(item,state)=>{const current=await row(item);return post(pb+'/items/'+current.id+'/state',{version:current.version,state,note:'合成审批依据'});};
  const approve=async item=>{ok(await transition(item,'submitted'));ok(await transition(item,'approved'));return row(item);};
  const correct=async item=>{const r=await post(pb+'/corrections',{targetId:item.id,note:'合成错误单撤销'},users.finance.cookie);ok(r,201);ok(await post(pb+'/corrections/'+r.body.id+'/state',{version:1,state:'approved',note:'合成独立复核'}));};
  const reverse=async(type,item)=>{const r=await post(pb+'/reversals',{targetType:type,targetId:item.id,note:'合成冲销'},type==='cost'?users.finance.cookie:users.engineer.cookie);ok(r,201);ok(await post(pb+'/reversals/'+r.body.id+'/state',{version:1,state:'approved',note:'合成独立复核'}));};
  const movement=async(materialId,kind,quantity,referenceId='')=>{const r=await post(pb+'/stock',{materialId,kind,quantity,referenceId,note:'合成库存依据'},users.manager.cookie);ok(r,201);return {id:r.body.id};};
  const download=(cookie=admin)=>call('/engineering'+pb+'/export',undefined,cookie);
  return {call,post,store,admin,users,password,pid,pb,projectData,detail,row,item,transition,approve,correct,reverse,movement,download};
}
const contract=(extra={})=>({title:'合成材料合同',code:randomUUID(),counterparty:'合成供应商',direction:'expense',amount:100000,dueDate:'2026-12-31',note:'合成签署依据',...extra});
const variation=(contractId,amount=1000)=>({title:'合成增额签证',code:randomUUID(),contractId,changeType:'increase',amount,occurredDate:'2026-10-11',note:'合成签证依据'});
const measurement=(contractId,amount=1000,extra={})=>({title:'合成计量',code:randomUUID(),contractId,periodStart:'2026-10-01',periodEnd:'2026-10-10',lines:[{name:'测试工程量',location:'测试段',unit:'立方米',quantity:1000,unitPrice:amount,note:''}],note:'合成计量依据',...extra});
const settlement=(contractId,amount=1000,measurementId='')=>({title:'合成结算',contractId,measurementId,amount,dueDate:'2026-10-25',note:'合成结算依据'});
const cost=(settlementId,amount=1000,direction='expense')=>({title:'合成收支',direction,category:'material',settlementId,amount,occurredDate:'2026-10-11',voucher:randomUUID(),note:'合成凭据'});
const decode=value=>value.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
function workbook(bytes){
  const files=Object.fromEntries(Object.entries(unzipSync(bytes)).map(([name,value])=>[name,strFromU8(value)]));
  const relations=Object.fromEntries([...files['xl/_rels/workbook.xml.rels'].matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map(m=>[m[1],m[2]]));
  const sheets={};
  for(const match of files['xl/workbook.xml'].matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)){
    const source=files['xl/'+relations[match[2]]],rows=[];
    for(const row of source.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g))rows.push([...row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map(c=>{
      const type=/\bt="([^"]+)"/.exec(c[1])?.[1],style=Number(/\bs="(\d+)"/.exec(c[1])?.[1]||0),ref=/\br="([^"]+)"/.exec(c[1])?.[1];
      return {value:type==='n'?Number(/<v>([^<]*)<\/v>/.exec(c[2])?.[1]):decode(/<t\b[^>]*>([\s\S]*?)<\/t>/.exec(c[2])?.[1]||''),type,style,ref};
    }));
    const headers=rows[0].map(c=>c.value);sheets[decode(match[1])]={source,rows,headers,records:rows.slice(1).map(row=>Object.fromEntries(row.map((c,i)=>[headers[i],c.value])))};
  }
  return {files,sheets,text:Object.values(files).join('\n')};
}
const find=(book,sheet,id)=>book.sheets[sheet].records.find(r=>r['记录ID']===id||r['计量ID']===id||r['流水ID']===id||r['办理ID']===id);
const summary=book=>Object.fromEntries(book.sheets['项目汇总'].records.map(r=>[r['项目 / 指标'],r['值']]));

const scope=(extra={})=>({code:'BOQ-01',name:'合成土方',location:'合成一段',unit:'立方米',quantity:100000,unitPrice:10000,...extra});
const boqDetail=async f=>{const r=await f.call('/engineering'+f.pb+'/boq',undefined,f.admin);ok(r);return r.body;};
const revision=async(f,id)=>(await boqDetail(f)).revisions.find(row=>row.id===id);
async function draftBoq(f,c,lines=[scope()],extra={}){
  const r=await f.post(f.pb+'/boq',{contractId:c.id,title:'合成清单',note:'合成清单依据',lines,...extra},f.users.manager.cookie);ok(r,201);return revision(f,r.body.id);
}
async function approveBoq(f,r){
  ok(await f.post(f.pb+'/boq/'+r.id+'/state',{version:r.version,state:'submitted',note:'合成提交'},f.users.manager.cookie));
  r=await revision(f,r.id);ok(await f.post(f.pb+'/boq/'+r.id+'/state',{version:r.version,state:'approved',note:'合成独立复核'}));return revision(f,r.id);
}
const scopeInputs=r=>r.lines.map(({amount,...line})=>line);
const boqMeasurement=(c,line,quantity)=>measurement(c.id,1,{lines:[{boqItemId:line.id,quantity,note:'合成清单计量'}]});
const cleanFixture=async t=>{const f=await fixture(t),c=await f.approve(await f.item('contracts',contract({amount:1000000})));return{f,c};};

test('BOQ export retains the free-contract 12-sheet workbook and adds three complete sheets once a draft exists',async t=>{
  const {f,c}=await cleanFixture(t);assert.equal(Object.keys(workbook((await f.download()).bytes).sheets).length,12);
  const r=await draftBoq(f,c,[scope(),scope({code:'ZERO',name:'保留零数量范围',quantity:0})]);
  let result=await f.download();ok(result);let book=workbook(result.bytes);
  assert.equal(Object.keys(book.sheets).length,15);assert.equal(book.sheets['清单余额'].records.length,0);
  assert.equal(book.sheets['清单版本'].records[0]['状态'],'草稿');assert.equal(book.sheets['清单版本明细'].records.length,2);
  assert.equal(book.sheets['清单版本明细'].records.find(row=>row['清单编码']==='ZERO')['清单数量'],0);
  await approveBoq(f,r);result=await f.download();ok(result);book=workbook(result.bytes);
  assert.equal(book.sheets['清单余额'].records.length,2);assert.equal(book.sheets['清单版本'].records[0]['当前有效版本'],'是');
  const balance=book.sheets['清单余额'].records.find(row=>row['清单编码']==='BOQ-01');
  assert.equal(balance['清单数量'],100);assert.equal(balance['单价（元）'],100);assert.equal(balance['清单金额（元）'],10000);assert.equal(balance['有效已批计量数量'],0);assert.equal(balance['剩余可计量数量'],100);
  for(const name of ['清单余额','清单版本','清单版本明细']){assert.match(book.sheets[name].source,/<pane[^>]*state="frozen"/);assert.match(book.sheets[name].source,/<autoFilter/);}
  assert.match(book.text,/累计数量应计金额/);assert.doesNotMatch(book.text,/<f(?:\s|>)/);
});

test('BOQ export uses one current snapshot after 100 to 120 revision, voided 40 and replacement 20 while retaining source versions',async t=>{
  const {f,c}=await cleanFixture(t),initial=await approveBoq(f,await draftBoq(f,c));
  const revised=await approveBoq(f,await draftBoq(f,c,scopeInputs(initial).map(line=>({...line,quantity:120000})),{title:'增量至120'}));
  const source=revised.lines[0],old=await f.approve(await f.item('measurements',boqMeasurement(c,source,40000)));await f.correct(old);
  const current=await f.approve(await f.item('measurements',boqMeasurement(c,source,20000)));
  const before=JSON.stringify(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'engineering_%' ORDER BY name").all().map(({name})=>[name,f.store.db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]));
  const result=await f.download();ok(result);const book=workbook(result.bytes),balance=book.sheets['清单余额'].records[0],detail=await f.detail();
  assert.equal(balance['清单数量'],120);assert.equal(balance['有效已批计量数量'],20);assert.equal(balance['剩余可计量数量'],100);
  assert.equal(balance['清单金额（元）'],12000);assert.equal(balance['有效已批计量金额（元）'],2000);assert.equal(balance['剩余可计量金额（元）'],10000);
  assert.equal(balance['当前清单版本ID'],revised.id);assert.equal(balance['有效已批计量金额（元）'],detail.boq.contracts.find(row=>row.contractId===c.id).items[0].usedAmount/100);
  assert.equal(find(book,'计量明细',old.id)['原数量'],40);assert.equal(find(book,'计量明细',old.id)['原行金额（元）'],4000);assert.equal(find(book,'计量明细',old.id)['有效行金额（元）'],0);assert.equal(find(book,'计量明细',old.id)['业务影响已撤销'],'是');
  for(const measurement of [old,current]){assert.equal(find(book,'计量明细',measurement.id)['清单条目ID'],source.id);assert.equal(find(book,'计量明细',measurement.id)['清单版本ID'],revised.id);}
  assert.equal(book.sheets['清单版本'].records.find(row=>row['清单版本ID']===initial.id)['原版本总额（元）'],10000);
  const vr=book.sheets['清单版本'].records.find(row=>row['清单版本ID']===revised.id);assert.equal(vr['修订增减额（元）'],2000);assert.equal(vr['配套签证ID'],revised.variation_id);
  const after=JSON.stringify(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'engineering_%' ORDER BY name").all().map(({name})=>[name,f.store.db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]));assert.equal(after,before);
});

test('BOQ export retains reversed revision signs, cancelled zero lines and literal formula-like business text',async t=>{
  const {f,c}=await cleanFixture(t),initial=await approveBoq(f,await draftBoq(f,c,[scope({name:'=SUM(A1:A2)',code:'+清单',location:'@部位'})]));
  const decrease=await approveBoq(f,await draftBoq(f,c,scopeInputs(initial).map(line=>({...line,quantity:80000})),{title:'-减少20'}));
  const variationRow=await f.row(decrease.variation_id);await f.correct(variationRow);
  const cancelled=await draftBoq(f,c,[...scopeInputs(initial),scope({code:'ZERO',name:'零量原件',quantity:0})],{title:'已作废草稿'});
  ok(await f.post(f.pb+'/boq/'+cancelled.id+'/state',{version:cancelled.version,state:'cancelled',note:'草稿作废'}));
  const result=await f.download();ok(result);const book=workbook(result.bytes),balance=book.sheets['清单余额'].records[0],history=book.sheets['清单版本'].records;
  assert.equal(balance['当前清单版本ID'],initial.id);assert.equal(balance['清单数量'],100);
  const withdrawn=history.find(row=>row['清单版本ID']===decrease.id);assert.equal(withdrawn['状态'],'已批准');assert.equal(withdrawn['配套签证已撤销'],'是');assert.equal(withdrawn['当前有效版本'],'否');assert.equal(withdrawn['原版本总额（元）'],8000);assert.equal(withdrawn['修订增减额（元）'],-2000);
  assert.equal(book.sheets['清单版本明细'].records.find(row=>row['清单版本ID']===cancelled.id&&row['清单编码']==='ZERO')['清单数量'],0);
  assert.equal(find(book,'变更签证',decrease.variation_id)['有效增减影响（元）'],0);assert.equal(book.sheets['纠错与冲销'].records.find(row=>row['原单ID']===decrease.variation_id)['业务金额调整（元）'],2000);
  assert.equal(balance['项目名称'],'=SUM(A1:A2)');assert.equal(balance['清单编码'],'+清单');assert.equal(balance['部位'],'@部位');assert.doesNotMatch(book.text,/<f(?:\s|>)/);
  for(const name of ['清单余额','清单版本','清单版本明细']){const sheet=book.sheets[name];for(const label of ['清单数量','清单金额（元）','原版本总额（元）','修订增减额（元）']){const index=sheet.headers.indexOf(label);if(index>=0)for(const row of sheet.rows.slice(1))assert.equal(row[index].type,'n');}}
});

test('BOQ zero-cent measurements and correction carry retain numeric zeros without silently repricing original approved rows',async t=>{
  const f=await fixture(t),c=await f.approve(await f.item('contracts',contract({amount:1}))),r=await approveBoq(f,await draftBoq(f,c,[scope({quantity:1000,unitPrice:1})])),line=r.lines[0];
  const first=await f.approve(await f.item('measurements',boqMeasurement(c,line,500))),second=await f.approve(await f.item('measurements',boqMeasurement(c,line,500)));await f.correct(first);
  const replacement=await f.approve(await f.item('measurements',boqMeasurement(c,line,500)));
  const result=await f.download();ok(result);const book=workbook(result.bytes),balance=book.sheets['清单余额'].records[0];
  assert.equal(find(book,'计量明细',second.id)['原行金额（元）'],0);assert.equal(find(book,'计量明细',replacement.id)['原行金额（元）'],0.01);
  assert.equal(find(book,'计量明细',first.id)['原行金额（元）'],0.01);assert.equal(find(book,'计量明细',first.id)['有效行金额（元）'],0);
  assert.equal(balance['有效已批计量数量'],1);assert.equal(balance['有效已批计量金额（元）'],0.01);assert.equal(balance['剩余可计量数量'],0);assert.equal(balance['剩余可计量金额（元）'],0);
  const original=await f.row(first.id);assert.deepEqual(original.data,first.data);assert.equal(original.version,first.version);
});

test('BOQ export validates source project, contract, revision, line totals, remaining figures and row limits',async t=>{
  const {f,c}=await cleanFixture(t),initial=await approveBoq(f,await draftBoq(f,c));await f.approve(await f.item('measurements',boqMeasurement(c,initial.lines[0],1000)));
  const detail=await f.detail();
  const corrupt=[
    d=>d.boq.revisions[0].project_id=randomUUID(),d=>d.boq.revisions[0].contract_id=randomUUID(),
    d=>d.boq.revisions[0].base_revision_id=randomUUID(),d=>d.boq.revisions[0].variation_id=randomUUID(),
    d=>d.boq.revisions[0].lines[0].amount++,d=>d.boq.revisions[0].lines[0].quantity=Number.MAX_SAFE_INTEGER+1,
    d=>d.boq.contracts[0].currentRevisionId=randomUUID(),d=>d.boq.contracts[0].items[0].usedQuantity++,d=>d.boq.contracts[0].items[0].remainingAmount++,
    d=>d.items.find(row=>row.kind==='measurements').data.lines[0].boqRevisionId=randomUUID(),
    d=>d.items.find(row=>row.kind==='measurements').data.lines[0].unitPrice++,
  ];
  for(const modify of corrupt){const copy=structuredClone(detail);modify(copy);assert.throws(()=>buildEngineeringWorkbook(copy),error=>error.status===422);}
  const rows=structuredClone(detail);rows.boq.revisions=Array.from({length:20001},()=>rows.boq.revisions[0]);assert.throws(()=>buildEngineeringWorkbook(rows),error=>error.status===413);
  const lines=structuredClone(detail);lines.boq.revisions[0].lines=Array.from({length:20001},()=>lines.boq.revisions[0].lines[0]);assert.throws(()=>buildEngineeringWorkbook(lines),error=>error.status===413);
  const other=await f.post('/projects',{data:{...f.projectData,code:randomUUID(),name:'OTHER-BOQ-SECRET'}});ok(other,201);
  const result=await f.download();ok(result);assert.doesNotMatch(workbook(result.bytes).text,/OTHER-BOQ-SECRET/);
});

test('BOQ XLSX remains financial-only on desktop and mobile and openpyxl independently reads all 15 sheets',async t=>{
  const {f,c}=await cleanFixture(t);await approveBoq(f,await draftBoq(f,c));
  for(const user of ['engineer','viewer'])ok(await f.download(f.users[user].cookie),403);ok(await f.download(f.users.outsider.cookie),404);
  const login=await f.call('/mobile/login',{username:'qa-finance',password:f.password});ok(login);
  const result=await f.call('/mobile/engineering'+f.pb+'/export',undefined,'','GET',{Authorization:'Bearer '+login.body.token});ok(result);assert.equal(Object.keys(workbook(result.bytes).sheets).length,15);
  const python=process.env.ENGINEERING_TEST_PYTHON || join(homedir(),'.cache','codex-runtimes','codex-primary-runtime','dependencies','python',process.platform==='win32'?'python.exe':'bin/python3');assert.ok(existsSync(python),'Bundled Python is required for independent XLSX verification');
  const dir=mkdtempSync(join(tmpdir(),'engineering-boq-export-')),path=join(dir,'boq.xlsx');
  try{
    writeFileSync(path,result.bytes);
    const verify=spawnSync(python,['-c',"import sys,json,openpyxl\nw=openpyxl.load_workbook(sys.argv[1],data_only=False)\nassert len(w.sheetnames)==15\ns=w['清单余额']; h={c.value:c.column for c in s[1]}\nassert s.cell(2,h['清单数量']).value==100\nassert s.cell(2,h['清单金额（元）']).value==10000\nassert s.cell(2,h['清单数量']).data_type=='n'\nassert '0.000' in s.cell(2,h['清单数量']).number_format\nassert '0.00' in s.cell(2,h['清单金额（元）']).number_format\nassert s.freeze_panes=='A2'\nassert s.auto_filter.ref\nfor sheet in w:\n for row in sheet:\n  assert all(c.data_type!='f' for c in row)\nassert not w._external_links\nprint(json.dumps({'sheets':len(w.sheetnames),'verified':True}))",path],{encoding:'utf8'});
    assert.equal(verify.status,0,verify.stderr||verify.stdout);assert.deepEqual(JSON.parse(verify.stdout),{sheets:15,verified:true});
  }finally{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));assert.ok(dir.includes('engineering-boq-export-'));rmSync(dir,{recursive:true,force:true});}
});

test('export row heights fit wrapped CJK and explicit newlines, preserve minimums and cap long notes at 409 points',async t=>{
  const f=await fixture(t),short=await f.item('contracts',contract({title:'短',code:'short',counterparty:'甲',note:'短'}));
  const multiline=await f.item('contracts',contract({title:'多行',code:'multiline',counterparty:'甲',note:'第一行\r\n第二行\n第三行\r第四行'}));
  const long=await f.item('contracts',contract({title:'长说明',code:'long',counterparty:'甲',note:'长'.repeat(2000)}));
  const result=await f.download();ok(result);const book=workbook(result.bytes),sheet=book.sheets['合同'];
  const heights=source=>new Map([...source.matchAll(/<row\b[^>]*r="(\d+)"[^>]*ht="([\d.]+)"[^>]*customHeight="1"/g)].map(match=>[Number(match[1]),Number(match[2])]));
  const contractHeights=heights(sheet.source),height=item=>contractHeights.get(sheet.records.findIndex(row=>row['记录ID']===item.id)+2);
  assert.equal(height(short),20);assert.ok(height(multiline)>=74,'CRLF, LF and CR must each start a new display line');assert.equal(height(long),409);
  const definitions=book.sheets['口径说明'],definitionHeights=heights(definitions.source);
  for(const label of ['计量','工程量清单'])assert.ok(definitionHeights.get(definitions.records.findIndex(row=>row['项目']===label)+2)>20,label+' must not overflow the next row');
  assert.ok(contractHeights.get(1)>30,'wrapped column labels must grow beyond the minimum header height');assert.equal(definitionHeights.get(1),30);
  for(const current of Object.values(book.sheets))for(const [row,height] of heights(current.source)){assert.ok(height>=(row===1?30:20));assert.ok(height<=409);}
  assert.equal(find(book,'合同',multiline.id)['依据 / 备注'],'第一行\r\n第二行\n第三行\r第四行');
  assert.equal(sheet.rows[sheet.records.findIndex(row=>row['记录ID']===short.id)+1][sheet.headers.indexOf('原合同金额（元）')].type,'n');
});

