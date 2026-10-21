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

test('engineering export enforces project financial permissions and mobile bearer revocation',async t=>{
  const f=await fixture(t);ok(await f.call('/engineering'+f.pb+'/export'),401);
  for(const name of ['engineer','viewer'])ok(await f.download(f.users[name].cookie),403);ok(await f.download(f.users.outsider.cookie),404);
  for(const actor of [f.admin,f.users.manager.cookie,f.users.finance.cookie])ok(await f.download(actor));
  const login=await f.call('/mobile/login',{username:'qa-finance',password:f.password});ok(login);const headers={Authorization:'Bearer '+login.body.token};
  const mobile=await f.call('/mobile/engineering'+f.pb+'/export',undefined,'','GET',headers);ok(mobile);assert.equal(mobile.bytes.subarray(0,4).toString('hex'),'504b0304');
  ok(await f.post(f.pb+'/members',{userId:f.users.finance.id,role:'remove'},f.admin,'PUT'));ok(await f.call('/mobile/engineering'+f.pb+'/export',undefined,'','GET',headers),404);
});

test('engineering export is a standard multi-sheet XLSX with numeric money, quantity, dates, frozen headers and no active content',async t=>{
  const f=await fixture(t),c=await f.approve(await f.item('contracts',contract({amount:12345}))),m=await f.approve(await f.item('measurements',measurement(c.id,1000,{lines:[{name:'土方',location:'测试段',unit:'立方米',quantity:1234,unitPrice:100,note:'原记录'}]})));
  const result=await f.download();ok(result);assert.match(result.headers.get('content-type'),/^application\/vnd.openxmlformats-officedocument.spreadsheetml.sheet/);assert.match(result.headers.get('content-disposition'),/^attachment;/);assert.match(result.headers.get('content-disposition'),/filename\*=UTF-8''/);assert.equal(result.headers.get('cache-control'),'private, no-store');assert.equal(result.headers.get('x-content-type-options'),'nosniff');assert.equal(Number(result.headers.get('content-length')),result.bytes.length);
  const book=workbook(result.bytes);assert.deepEqual(Object.keys(book.sheets),['项目汇总','口径说明','合同','变更签证','计量总表','计量明细','结算','收支','采购','库存流水','材料余额','纠错与冲销']);
  for(const sheet of Object.values(book.sheets)){assert.match(sheet.source,/<pane[^>]*ySplit="1"[^>]*state="frozen"/);assert.match(sheet.source,/<autoFilter ref="A1:/);assert.match(sheet.source,/<col\b[^>]*width=/);assert.match(sheet.source,/xml:space="preserve"/);}
  assert.equal(find(book,'合同',c.id)['原合同金额（元）'],123.45);assert.equal(find(book,'计量明细',m.id)['原数量'],1.234);assert.equal(find(book,'计量明细',m.id)['原行金额（元）'],1.23);
  assert.match(book.files['xl/styles.xml'],/formatCode="#,##0.00/);assert.match(book.files['xl/styles.xml'],/formatCode="#,##0.000/);assert.doesNotMatch(book.text,/<f(?:\s|>)/);assert.doesNotMatch(Object.keys(book.files).join(' '),/vbaProject|externalLinks|embeddings|connections/i);assert.doesNotMatch(book.text,/TargetMode="External"/);
  const moneyIndex=book.sheets['合同'].headers.indexOf('原合同金额（元）');assert.equal(book.sheets['合同'].rows[1][moneyIndex].type,'n');
  const dateIndex=book.sheets['合同'].headers.indexOf('截止日期');assert.equal(book.sheets['合同'].rows[1][dateIndex].type,'n');
});

async function populatedFixture(t){
  const f=await fixture(t),c=await f.approve(await f.item('contracts',contract()));
  const increase=await f.approve(await f.item('variations',variation(c.id,20000))),voidVariation=await f.approve(await f.item('variations',variation(c.id,1000)));await f.correct(voidVariation);
  const voidMeasurement=await f.approve(await f.item('measurements',measurement(c.id,1000)));await f.correct(voidMeasurement);
  const voidSettlement=await f.approve(await f.item('settlements',settlement(c.id,1000)));await f.correct(voidSettlement);
  const m=await f.approve(await f.item('measurements',measurement(c.id,100000,{lines:[{name:'土方',location:'一段',unit:'立方米',quantity:1500,unitPrice:10000,note:''},{name:'回填',location:'二段',unit:'立方米',quantity:4250,unitPrice:20000,note:''}]})));
  const s=await f.approve(await f.item('settlements',settlement(c.id,60000,m.id))),manual=await f.approve(await f.item('settlements',settlement(c.id,20000)));
  const paid=await f.approve(await f.item('costs',cost(s.id,25000))),reversed=await f.approve(await f.item('costs',cost(s.id,10000)));await f.reverse('cost',reversed);await f.approve(await f.item('costs',cost('',5000)));
  const drafts={contract:await f.item('contracts',contract({amount:77777})),variation:await f.item('variations',variation(c.id,7777)),measurement:await f.item('measurements',measurement(c.id,7777)),settlement:await f.item('settlements',settlement(c.id,7777,m.id)),cost:await f.item('costs',cost(s.id,7777))};
  const material=await f.item('materials',{title:'合成中砂',code:randomUUID(),specification:'测试规格',unit:'吨',warehouse:'测试仓库',note:''}),purchase=await f.approve(await f.item('purchases',{title:'中砂采购',supplier:'合成供应商',materialId:material.id,quantity:10000,unitPrice:1000,contractId:c.id,dueDate:'2026-10-20',note:'合成采购依据'}));
  const receipt=await f.movement(material.id,'receive',5000,purchase.id),issue=await f.movement(material.id,'issue',3000),returned=await f.movement(material.id,'return',1000,issue.id);await f.reverse('stock',returned);
  return {f,c,increase,voidVariation,voidMeasurement,voidSettlement,m,s,manual,paid,reversed,drafts,material,purchase,receipt,issue,returned};
}

test('export reconciles effective contracts, measured installments, voided originals and reversed costs without double counting',async t=>{
  const {f,c,increase,voidVariation,voidMeasurement,voidSettlement,m,s,manual,paid,reversed,drafts}=await populatedFixture(t),result=await f.download();ok(result);const book=workbook(result.bytes),totals=summary(book),detail=await f.detail();
  assert.equal(totals['有效支出'],300);assert.equal(totals['已批应付'],800);assert.equal(totals['结算未付'],550);assert.equal(totals['剩余预算'],9700);assert.equal(totals['有效支出'],detail.finance.expense/100);
  const cr=find(book,'合同',c.id);assert.equal(cr['原合同金额（元）'],1000);assert.equal(cr['累计净变更（元）'],200);assert.equal(cr['有效合同额（元）'],1200);assert.equal(cr['有效计量（元）'],1000);assert.equal(cr['未关联计量结算（元）'],200);assert.equal(cr['有效结算（元）'],800);assert.equal(cr['履约承诺（元）'],1200);assert.equal(cr['剩余可计量（元）'],0);assert.equal(cr['剩余可结算（元）'],400);
  assert.equal(find(book,'变更签证',increase.id)['有效增减影响（元）'],200);assert.equal(find(book,'变更签证',voidVariation.id)['原签证金额（元）'],10);assert.equal(find(book,'变更签证',voidVariation.id)['有效增减影响（元）'],0);assert.equal(find(book,'变更签证',voidVariation.id)['业务影响已撤销'],'是');
  assert.equal(find(book,'计量总表',m.id)['计量可结算（元）'],400);assert.equal(find(book,'计量总表',voidMeasurement.id)['有效计量（元）'],0);assert.equal(find(book,'计量总表',voidMeasurement.id)['原计量金额（元）'],10);assert.equal(find(book,'计量明细',voidMeasurement.id)['有效行金额（元）'],0);
  assert.equal(find(book,'结算',s.id)['有效已收付（元）'],250);assert.equal(find(book,'结算',s.id)['未收付（元）'],350);assert.equal(find(book,'结算',manual.id)['计量ID'],'');assert.equal(find(book,'结算',voidSettlement.id)['有效结算（元）'],0);
  assert.equal(find(book,'收支',paid.id)['有效收支金额（元）'],250);assert.equal(find(book,'收支',reversed.id)['原收支金额（元）'],100);assert.equal(find(book,'收支',reversed.id)['有效收支金额（元）'],0);assert.equal(find(book,'收支',reversed.id)['已冲销'],'是');
  for(const [sheet,item,key] of [['合同',drafts.contract,'有效合同额（元）'],['变更签证',drafts.variation,'有效增减影响（元）'],['计量总表',drafts.measurement,'有效计量（元）'],['结算',drafts.settlement,'有效结算（元）'],['收支',drafts.cost,'有效收支金额（元）']])assert.equal(find(book,sheet,item.id)[key],0);
  assert.equal(book.sheets['纠错与冲销'].records.length,5);assert.equal(book.sheets['收支'].records.reduce((sum,r)=>sum+r['有效收支金额（元）'],0),totals['有效支出']);
});

test('inventory export states original signs, reversal adjustments, net balances and procurement remaining quantities',async t=>{
  const {f,material,purchase,receipt,issue,returned}=await populatedFixture(t),result=await f.download();ok(result);const book=workbook(result.bytes);
  const incoming=find(book,'库存流水',receipt.id),outgoing=find(book,'库存流水',issue.id),cancelledReturn=find(book,'库存流水',returned.id);
  assert.equal(incoming['原始库存影响'],5);assert.equal(outgoing['原数量'],3);assert.equal(outgoing['原始库存影响'],-3);assert.equal(cancelledReturn['原数量'],1);assert.equal(cancelledReturn['原始库存影响'],1);assert.equal(cancelledReturn['批准冲销调整'],-1);assert.equal(cancelledReturn['当前有效库存影响'],0);assert.equal(cancelledReturn['已冲销'],'是');
  assert.equal(find(book,'材料余额',material.id)['当前净库存'],2);assert.equal(book.sheets['库存流水'].records.reduce((sum,r)=>sum+r['当前有效库存影响'],0),2);
  const po=find(book,'采购',purchase.id);assert.equal(po['原采购数量'],10);assert.equal(po['净入库数量'],5);assert.equal(po['待收货数量'],5);assert.equal(po['有效采购金额（元）'],100);
  assert.equal(book.sheets['纠错与冲销'].records.find(r=>r['原单ID']===returned.id)['库存数量调整'],-1);
  await f.reverse('stock',issue);const corrected=workbook((await f.download()).bytes),correctedIssue=find(corrected,'库存流水',issue.id);
  assert.equal(correctedIssue['原始库存影响'],-3);assert.equal(correctedIssue['批准冲销调整'],3);assert.equal(correctedIssue['当前有效库存影响'],0);assert.equal(find(corrected,'材料余额',material.id)['当前净库存'],5);
});

test('income installments and withdrawal of a decrease retain correct positive reversal signs and outstanding amounts',async t=>{
  const f=await fixture(t),c=await f.approve(await f.item('contracts',contract({direction:'income',amount:10000}))),decrease=await f.approve(await f.item('variations',{...variation(c.id,2000),changeType:'decrease'}));await f.correct(decrease);
  const s=await f.approve(await f.item('settlements',settlement(c.id,10000))),p=await f.approve(await f.item('costs',cost(s.id,6000,'income')));await f.reverse('cost',p);await f.approve(await f.item('costs',cost(s.id,6000,'income')));
  const result=await f.download();ok(result);const book=workbook(result.bytes),totals=summary(book),v=find(book,'变更签证',decrease.id),decision=book.sheets['纠错与冲销'].records.find(r=>r['原单ID']===decrease.id);
  assert.equal(v['原增减影响（元）'],-20);assert.equal(v['有效增减影响（元）'],0);assert.equal(decision['业务金额调整（元）'],20);assert.equal(find(book,'合同',c.id)['有效合同额（元）'],100);
  assert.equal(totals['有效收入'],60);assert.equal(totals['有效支出'],0);assert.equal(totals['已批应收'],100);assert.equal(totals['结算未收'],40);assert.equal(find(book,'结算',s.id)['未收付（元）'],40);
  const detail=await f.detail(),negative=workbook(buildEngineeringWorkbook({...detail,finance:{...detail.finance,budget:0,expense:2000}}));assert.equal(summary(negative)['剩余预算'],-20);
});

test('text beginning with spreadsheet formula operators remains literal and XML controls cannot corrupt the workbook or headers',async t=>{
  const f=await fixture(t,{code:'导出"\r\n测试',name:'=HYPERLINK("https://example.invalid")'}),titles=['=1+1','+SUM(A1:A2)','-2+3','@SUM(A1:A2)'],note='甲 & <记录> "引号" 😀\u0000\u000b\n  保留空白';
  for(const title of titles)await f.item('contracts',contract({title,note}));const result=await f.download();ok(result);assert.doesNotMatch(result.headers.get('content-disposition'),/[\r\n]/);
  const book=workbook(result.bytes);assert.deepEqual(book.sheets['合同'].records.map(r=>r['名称']).sort(),titles.sort());assert.doesNotMatch(book.text,/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);assert.doesNotMatch(book.text,/<f(?:\s|>)/);assert.doesNotMatch(book.text,/TargetMode="External"/);
  const titleIndex=book.sheets['合同'].headers.indexOf('名称');for(const row of book.sheets['合同'].rows.slice(1))assert.equal(row[titleIndex].type,'inlineStr');
  assert.equal(book.sheets['合同'].records[0]['依据 / 备注'],note.replace(/[\u0000\u000b]/g,''));assert.equal(summary(book)['工程名称'],'=HYPERLINK("https://example.invalid")');
});

test('export excludes other projects, accounts and original document payloads and leaves every engineering table unchanged',async t=>{
  const f=await fixture(t),c=await f.item('contracts',contract());
  const attachment=await f.post(f.pb+'/items/'+c.id+'/attachments',{version:1,name:'原件.pdf',caption:'PRIVATE_ATTACHMENT_SENTINEL',base64:Buffer.from('%PDF-1.7\nPRIVATE_BYTES_SENTINEL\n%%EOF').toString('base64')},f.users.manager.cookie);ok(attachment,201);await f.approve(c);
  const other=await f.post('/projects',{data:{...f.projectData,code:randomUUID(),name:'OTHER_PROJECT_PRIVATE_SENTINEL'}});ok(other,201);const otherBase='/projects/'+other.body.id;
  ok(await f.post(otherBase+'/state',{version:1,state:'active',note:'另一个合成项目'}));ok(await f.post(otherBase+'/items/contracts',{data:contract({title:'OTHER_CONTRACT_PRIVATE_SENTINEL'})}),201);
  const aid=randomUUID(),stamp=new Date().toISOString();f.store.db.prepare('INSERT INTO photo_archives VALUES(?,?,?,?,?,?,?,?,?,?)').run(aid,f.users.manager.id,'PRIVATE_AUTHOR_SENTINEL','PHOTO_ORIGINAL_PRIVATE_SENTINEL','现场资料项目','测试道路','{}',1,stamp,stamp);ok(await f.post(f.pb+'/documents',{kind:'photo',documentId:aid}));
  const tables=f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'engineering_%' ORDER BY name").all().map(r=>r.name),snapshot=()=>createHash('sha256').update(JSON.stringify(tables.map(name=>[name,f.store.db.prepare('SELECT * FROM '+name+' ORDER BY rowid').all()]),(_,value)=>typeof value==='bigint'?String(value):value)).digest('hex');
  const before=snapshot(),result=await f.download();ok(result);assert.equal(snapshot(),before);const book=workbook(result.bytes);
  for(const secret of ['OTHER_PROJECT_PRIVATE_SENTINEL','OTHER_CONTRACT_PRIVATE_SENTINEL','PHOTO_ORIGINAL_PRIVATE_SENTINEL','PRIVATE_AUTHOR_SENTINEL','PRIVATE_ATTACHMENT_SENTINEL','PRIVATE_BYTES_SENTINEL',f.password])assert.equal(book.text.includes(secret),false,secret);
  assert.equal(book.sheets['合同'].records.length,1);assert.equal(find(book,'合同',c.id)['名称'],c.data.title);
});

test('completed and archived project ledgers remain downloadable as read-only snapshots',async t=>{
  const f=await fixture(t);ok(await f.post(f.pb+'/state',{version:2,state:'completed',note:'合成项目完成'}));let result=await f.download(f.users.finance.cookie);ok(result);assert.equal(summary(workbook(result.bytes))['项目状态'],'已完成');
  ok(await f.post(f.pb+'/state',{version:3,state:'archived',note:'合成项目归档'}));result=await f.download(f.users.manager.cookie);ok(result);assert.equal(summary(workbook(result.bytes))['项目状态'],'已归档');ok(await f.download(f.users.viewer.cookie),403);
});

test('export limits fail explicitly, reject mixed-project snapshots and never hide unsafe numeric data',async t=>{
  const f=await fixture(t),detail=await f.detail();
  const tooMany={...detail,stock:Array.from({length:20001},(_,i)=>({id:'row-'+i,project_id:f.pid,material_id:'missing',kind:'opening',quantity:1,reference_id:'',note:'',created_at:new Date().toISOString(),reversed:false}))};
  assert.throws(()=>buildEngineeringWorkbook(tooMany),error=>error.status===413&&/20000/.test(error.message));
  assert.throws(()=>buildEngineeringWorkbook({...detail,items:[{id:'other',project_id:randomUUID(),kind:'contracts',data:{}}]}),error=>error.status===422&&/其他项目/.test(error.message));
  assert.throws(()=>buildEngineeringWorkbook({...detail,finance:{...detail.finance,expense:Number.MAX_SAFE_INTEGER+1}}),error=>error.status===422);
  assert.throws(()=>buildEngineeringWorkbook({...detail,project:{...detail.project,data:{...detail.project.data,name:'长'.repeat(32768)}}}),error=>error.status===413);
  assert.equal((await f.detail()).items.length,0);
});

test('bundled openpyxl independently reads all exported sheets, literal text, styles and numeric ledger values',async t=>{
  const {f,c,m,s}=await populatedFixture(t);await f.item('contracts',contract({title:'=1+1'}));const downloaded=await f.download();ok(downloaded);
  const dir=mkdtempSync(join(tmpdir(),'engineering-export-reader-'));t.after(()=>{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));assert.ok(dir.includes('engineering-export-reader-'));rmSync(dir,{recursive:true,force:true});});
  const path=join(dir,'ledger.xlsx');writeFileSync(path,downloaded.bytes);
  const bundled=join(homedir(),'.cache/codex-runtimes/codex-primary-runtime/dependencies/python/'+(process.platform==='win32'?'python.exe':'bin/python3')),python=process.env.ENGINEERING_TEST_PYTHON||(existsSync(bundled)?bundled:'python');
  const script=`import json,sys,datetime,openpyxl
w=openpyxl.load_workbook(sys.argv[1],data_only=False)
assert len(w.sheetnames)==12,w.sheetnames
assert not w._external_links
for s in w:
 assert s.freeze_panes=='A2',s.title
 assert s.auto_filter.ref.startswith('A1:'),s.title
 for row in s:
  for cell in row: assert cell.data_type!='f',(s.title,cell.coordinate)
def records(name):
 rows=list(w[name].values);return [dict(zip(rows[0],row)) for row in rows[1:]]
def find(name,key,value): return next(r for r in records(name) if r[key]==value)
c=find('合同','记录ID',sys.argv[2]);assert c['有效合同额（元）']==1200,c
m=find('计量总表','记录ID',sys.argv[3]);assert m['计量可结算（元）']==400,m
s=find('结算','记录ID',sys.argv[4]);assert s['未收付（元）']==350,s
literal=next(cell for row in w['合同'] for cell in row if cell.value=='=1+1');assert literal.data_type=='s'
money=next(cell for row in w['合同'] for cell in row if cell.value==1200);assert money.data_type=='n' and '0.00' in money.number_format
q=next(cell for row in w['计量明细'] for cell in row if cell.value==4.25);assert q.data_type=='n' and '0.000' in q.number_format
assert isinstance(c['截止日期'],datetime.datetime)
print(json.dumps({'reader':'openpyxl '+openpyxl.__version__,'sheets':w.sheetnames,'numericMoney':True,'numericQuantity':True,'literalFormulaText':True,'dateValues':True,'allSheetsReadable':True},ensure_ascii=False))
`;
  const result=spawnSync(python,['-c',script,path,c.id,m.id,s.id],{encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});assert.equal(result.status,0,result.error?.message||result.stderr||result.stdout);const evidence=JSON.parse(result.stdout);assert.equal(evidence.allSheetsReadable,true);assert.equal(evidence.literalFormulaText,true);assert.equal(evidence.numericMoney,true);
});
