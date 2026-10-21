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
test('task export separates contract directions, preserves original/withdrawn values and reconciles unassigned work',()=>{
  const f=fixture();f.measure(f.expense,500);f.measure(f.income,1000);f.measure(f.expense,200,{linked:false});const withdrawn=f.measure(f.expense,300,{voided:true});f.measure(f.expense,700,{state:'submitted'});
  const book=read(buildEngineeringWorkbook(f.detail));assert.equal(book.names.length,14);const records=book.sheets['任务产值'].records;
  const task=records.find(r=>r['任务ID']===f.task.id),unassigned=records.find(r=>r['当前任务名称']==='未归集任务');
  assert.equal(task['收入合同已批计量（元）'],10);assert.equal(task['支出合同已批计量（元）'],5);assert.equal(task['人工完成比例（%）'],35);
  assert.equal(unassigned['支出合同已批计量（元）'],2);assert.equal(task['历史来源行数'],4);assert.equal(task['有效已批来源行数'],2);
  assert.equal(records.find(r=>r['任务ID']===f.second.id)['支出合同已批计量（元）'],0);
  const original=book.sheets['计量明细'].records.find(r=>r['计量ID']===withdrawn.id);assert.equal(original['原行金额（元）'],3);assert.equal(original['有效行金额（元）'],0);assert.equal(original['有效数量'],0);
  assert.equal(original['保存时任务名称'],'保存时任务');assert.equal(original['当前任务名称'],'=1+1');assert.equal(original['保存时任务部位'],'保存时部位');
  assert.ok(!book.xml.includes('<f>'));assert.ok(!book.xml.includes('TASK_PRIVATE_NOTE'));assert.match(book.xml,/t="inlineStr"[^>]*><is><t[^>]*>=1\+1<\/t>/);
});
test('task quantity export keeps contract, unit and item scopes separate and retains zero-cent quantities',()=>{
  const f=fixture();f.measure(f.expense,500);f.measure(f.income,700);f.measure(f.expense,300,{unit:'米'});f.measure(f.expense,200,{linked:false});
  f.measure(f.expense,1,{lines:[{taskId:f.task.id,taskTitle:'任务快照',taskLocation:'部位快照',name:'零分数量',location:'施工段',unit:'套',quantity:1,unitPrice:1,amount:0,note:''},{taskId:f.task.id,taskTitle:'任务快照',taskLocation:'部位快照',name:'补充数量',location:'施工段',unit:'套',quantity:1,unitPrice:1000,amount:1,note:''}]});
  const groups=read(buildEngineeringWorkbook(f.detail)).sheets['任务工程量'].records;
  assert.equal(groups.length,6);assert.equal(groups.find(r=>r['计量项目']==='零分数量')['有效已批数量'],0.001);assert.equal(groups.find(r=>r['计量项目']==='零分数量')['有效已批计量（元）'],0);
  assert.equal(groups.filter(r=>r['合同方向']==='收入').length,1);assert.equal(groups.filter(r=>r['当前任务名称']==='未归集任务').length,1);
});
test('export recomputes task projection from source snapshot and leaves originals untouched',()=>{
  const f=fixture();f.measure(f.expense,1234);f.detail.taskValues={summary:{expense:{totalAmount:9999999}},tasks:[]};const before=JSON.stringify(f.detail);
  const result=read(buildEngineeringWorkbook(f.detail));assert.equal(result.sheets['任务产值'].records.find(r=>r['任务ID']===f.task.id)['支出合同已批计量（元）'],12.34);assert.equal(JSON.stringify(f.detail),before);
});
test('broken task references or mismatched line totals fail export instead of dropping accounting sources',()=>{
  const f=fixture(),m=f.measure(f.expense,500);m.data.lines[0].taskId=randomUUID();assert.throws(()=>buildEngineeringWorkbook(f.detail),e=>e.status===422);
  m.data.lines[0].taskId=f.task.id;m.data.amount=501;assert.throws(()=>buildEngineeringWorkbook(f.detail),e=>e.status===422);
});
test('legacy projects without task links retain their original sheet count and unassigned history',()=>{
  const f=fixture();f.measure(f.expense,500,{linked:false});const book=read(buildEngineeringWorkbook(f.detail));assert.equal(book.names.length,12);assert.ok(!book.names.includes('任务产值'));assert.equal(book.sheets['计量明细'].records[0]['归属任务ID'],'');
});
