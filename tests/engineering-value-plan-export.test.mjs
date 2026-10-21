import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {unzipSync,strFromU8} from 'fflate';
import {buildEngineeringWorkbook} from '../server/engineering-export.mjs';

const decode=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
function read(bytes){
  const files=Object.fromEntries(Object.entries(unzipSync(bytes)).map(([k,v])=>[k,strFromU8(v)])),sheets={};
  const names=[...files['xl/workbook.xml'].matchAll(/<sheet name="([^"]+)"/g)].map(m=>decode(m[1]));
  names.forEach((name,i)=>{
    const xml=files[`xl/worksheets/sheet${i+1}.xml`];
    const rows=[...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map(r=>[...r[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map(c=>/t="n"/.test(c[1])?Number(/<v>(.*?)<\/v>/.exec(c[2])?.[1]):decode(/<t\b[^>]*>([\s\S]*?)<\/t>/.exec(c[2])?.[1]||'')));
    sheets[name]={xml,rows,records:rows.slice(1).map(r=>Object.fromEntries(rows[0].map((h,j)=>[h,r[j]])))};
  });return {names,sheets,xml:Object.values(files).join('\n')};
}
function fixture(){
  const pid=randomUUID(),stamp='2026-10-12T01:00:00.000Z',items=[];
  const add=(kind,data,state='approved',extra={})=>{const row={id:randomUUID(),project_id:pid,kind,data,state,version:1,created_at:stamp,updated_at:stamp,...extra};items.push(row);return row;};
  const task=add('tasks',{title:'=1+1',location:'现部位',owner:'班组A',startDate:'2026-10-01',dueDate:'2026-10-31',progress:35,note:'TASK_PRIVATE_NOTE'},'active');
  const second=add('tasks',{title:'无计量任务',location:'第二段',owner:'班组B',startDate:'2026-10-10',dueDate:'2026-10-20',progress:0,note:''},'planned');
  const contract=direction=>add('contracts',{title:direction+'合同',code:randomUUID(),counterparty:'合成方',direction,amount:100000,dueDate:'2026-10-31',note:'合成合同'},'approved',{commercial:{originalAmount:100000,changeAmount:0,effectiveAmount:100000,purchaseAmount:0,measurementAmount:0,unmeasuredSettlementAmount:0,settlementAmount:0,committedAmount:0,remainingMeasurementAmount:100000,remainingSettlementAmount:100000}});
  const expense=contract('expense'),income=contract('income');
  const measure=(c,cents,{linked=true,state='approved',voided=false,unit='立方米',quantity=1000,name='开挖',lines}={})=>add('measurements',{title:'合成计量',code:randomUUID(),contractId:c.id,periodStart:'2026-10-01',periodEnd:'2026-10-10',note:'合成计量依据',amount:cents,lines:lines||[{name,location:'施工段',unit,quantity,unitPrice:cents,amount:cents,note:'',...(linked?{taskId:task.id,taskTitle:'保存时任务',taskLocation:'保存时部位'}:{})}]},state,{voided,commercial:{measuredAmount:state==='approved'&&!voided?cents:0,settledAmount:0,remainingSettlementAmount:state==='approved'&&!voided?cents:0}});
  const detail={project:{id:pid,state:'active',data:{code:'TV-TEST',name:'合成任务产值',owner:'测试',address:'隔离场所',startDate:'2026-10-01',dueDate:'2026-10-31',budget:100000}},finance:{budget:100000,expense:0,income:0,payable:0,receivable:0},items,stock:[],balances:{},receipts:{},corrections:[],reversals:[]};
  return {pid,task,second,expense,income,measure,detail};
}
function targetFixture(){
  const f=fixture(),bid=randomUUID(),rid=randomUUID(),boqId=randomUUID(),stamp='2026-10-12T01:00:00.000Z';
  const boqLine={id:boqId,code:'TARGET-01',name:'=1+1',location:'全施工段',unit:'立方米',quantity:100000,unitPrice:1000,amount:100000};
  const tasks=[f.task,f.second].map(row=>({id:row.id,title:row.data.title,location:row.data.location,owner:row.data.owner,startDate:row.data.startDate,dueDate:row.data.dueDate,predecessorId:''})).sort((a,b)=>a.id.localeCompare(b.id));
  const baseline={id:bid,project_id:f.pid,title:'冻结日期',state:'approved',approved_seq:1,snapshot:{project:{startDate:'2026-10-01',dueDate:'2026-10-31'},tasks}};
  f.detail.boq={contracts:[{contractId:f.expense.id,mode:'boq',currentRevisionId:rid,pendingRevisionId:null,items:[{...boqLine,usedQuantity:80000,usedAmount:80000,remainingQuantity:20000,remainingAmount:20000}]}],revisions:[{id:rid,project_id:f.pid,contract_id:f.expense.id,title:'清单冻结',state:'approved',version:3,approved_seq:1,total:100000,delta:0,voided:false,lines:[boqLine]}]};
  const plan=(seq,amountA=60000,state='approved')=>{
    const lines=tasks.map(task=>({boqItemId:boqId,taskId:task.id,code:boqLine.code,name:boqLine.name,location:boqLine.location,unit:boqLine.unit,unitPrice:1000,quantity:task.id===f.task.id?amountA:100000-amountA,amount:task.id===f.task.id?amountA:100000-amountA,taskTitle:task.title,taskLocation:task.location,startDate:task.startDate,dueDate:task.dueDate}));
    return {id:randomUUID(),project_id:f.pid,contract_id:f.expense.id,boq_revision_id:rid,schedule_baseline_id:bid,title:'合成目标'+seq,note:'目标分配签认',state,version:3,approved_seq:state==='approved'?seq:null,created_at:stamp,updated_at:stamp,creator_name:'合成编制人',reviewer_name:'独立复核人',snapshot:{contractId:f.expense.id,contractTitle:f.expense.data.title,contractDirection:'expense',boqRevisionId:rid,boqRevisionTitle:'清单冻结',scheduleBaselineId:bid,scheduleBaselineTitle:'冻结日期',project:baseline.snapshot.project,boqLines:[boqLine],tasks,lines,totalAmount:100000,allocatedAmount:100000,remainingAmount:0,remaining:[{boqItemId:boqId,quantity:0,amount:0}]}};
  };
  const original=plan(1),current=plan(2,50000);f.detail.valuePlans={plans:[current,original],baselines:{currentBaselineId:bid,baselines:[baseline]},comparison:{summary:{actualAmount:99999999}},selectedPlanId:original.id,asOf:'1900-01-01'};
  const measurement=(q,linked)=>f.measure(f.expense,q,{linked,quantity:q,lines:[{name:boqLine.name,location:boqLine.location,unit:boqLine.unit,quantity:q,unitPrice:1000,amount:q,note:'签认明细',boqItemId:boqId,boqRevisionId:rid,...(linked?{taskId:f.task.id,taskTitle:f.task.data.title,taskLocation:f.task.data.location}:{})}]});
  measurement(70000,true);measurement(10000,false);
  return {...f,original,current,boqId,rid};
}

test('value plan export keeps full history and computes current actual, target and outside from immutable sources',()=>{
  const f=targetFixture(),before=JSON.stringify(f.detail),book=read(buildEngineeringWorkbook(f.detail,{exportedAt:'2026-11-01T01:00:00.000Z'}));
  assert.equal(book.names.length,21);assert.equal(book.sheets['目标版本'].records.length,2);assert.equal(book.sheets['目标分配'].records.length,4);
  const rows=book.sheets['目标对比'].records;assert.equal(rows.length,2);assert.ok(rows.every(row=>row['目标方案ID']===f.current.id));
  const a=rows.find(row=>row['任务ID']===f.task.id);assert.equal(a['目标数量'],50);assert.equal(a['截至比较日计划数量'],50);assert.equal(a['最新有效已批数量'],70);assert.equal(a['实际减目标数量'],20);
  assert.equal(a['目标金额（元）'],500);assert.equal(a['最新有效已批金额（元）'],700);assert.equal(a['实际减计划金额（元）'],200);
  assert.equal(book.sheets['目标外计量'].records[0]['有效已批金额（元）'],100);assert.equal(book.sheets['目标外计量'].records[0]['目标外原因'],'计量未归属任务');
  assert.equal(JSON.stringify(f.detail),before);assert.ok(!book.xml.includes('TASK_PRIVATE_NOTE'));assert.ok(!book.xml.includes('<f>'));
  assert.equal(book.sheets['目标版本'].records.filter(row=>row['当前已批目标']==='是').length,1);
});

test('value plan export retains original dates and drift after task change and recalculates corrections',()=>{
  const f=targetFixture();f.task.data.dueDate='2026-11-02';const original=f.detail.items.find(row=>row.kind==='measurements'&&row.data.lines[0].taskId);original.voided=true;
  Object.assign(f.detail.boq.contracts[0].items[0],{usedQuantity:10000,usedAmount:10000,remainingQuantity:90000,remainingAmount:90000});
  const book=read(buildEngineeringWorkbook(f.detail,{exportedAt:'2026-11-01T01:00:00.000Z'}));const a=book.sheets['目标对比'].records.find(row=>row['任务ID']===f.task.id);
  assert.equal(a['最新有效已批数量'],0);assert.equal(a['最新有效已批金额（元）'],0);assert.match(a['来源变化说明'],/任务名称、部位、负责人、计划日期/);assert.equal(book.sheets['目标外计量'].records[0]['有效已批金额（元）'],100);
  assert.equal(a['冻结完成'],(Date.parse('2026-10-31')-Date.UTC(1899,11,30))/86400000);
});

test('inconsistent target snapshots and cross-project plan sources fail export',()=>{
  const f=targetFixture();f.current.snapshot.lines[0].amount++;
  assert.throws(()=>buildEngineeringWorkbook(f.detail),e=>e.status===422);f.current.snapshot.lines[0].amount--;
  f.current.project_id=randomUUID();assert.throws(()=>buildEngineeringWorkbook(f.detail),e=>e.status===422);
});

test('target history without task measurements exports targets but keeps comparison empty for drafts',()=>{
  const f=targetFixture();f.detail.items=f.detail.items.filter(row=>row.kind!=='measurements');f.current.state='draft';f.current.approved_seq=null;f.detail.valuePlans.plans=[f.current];
  Object.assign(f.detail.boq.contracts[0].items[0],{usedQuantity:0,usedAmount:0,remainingQuantity:100000,remainingAmount:100000});
  const book=read(buildEngineeringWorkbook(f.detail));assert.equal(book.names.length,19);assert.equal(book.sheets['目标分配'].records.length,2);assert.equal(book.sheets['目标对比'].records.length,0);assert.equal(book.sheets['目标外计量'].records.length,0);
});
