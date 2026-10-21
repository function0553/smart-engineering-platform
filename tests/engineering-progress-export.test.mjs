import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync,strFromU8} from 'fflate';
import {buildEngineeringProgressWorkbook} from '../server/engineering-progress-export.mjs';

const snapshot=()=>({
  exportedAt:'2026-10-12T03:00:00.000Z',project:{id:'p1',data:{name:'=项目_x000A_',code:'0001',budget:123456789,secret:'FINANCE_ONLY_SECRET'}},
  progress:{projectId:'p1',asOf:'2026-10-10',tasks:[{taskId:'t1',title:'当前名称',location:'当前部位',state:'active',currentProgress:50,currentProgressHasDateBasis:true,currentProgressRecordId:'r2',pendingRecordId:null,actual:{progress:30,recordId:'r1',effectiveDate:'2026-10-09',carriedForward:true,reviewedAt:'2026-10-11T03:00:00Z'}},{taskId:'t2',title:'无日期依据任务',location:'旧任务',state:'active',currentProgress:80,currentProgressHasDateBasis:false,currentProgressRecordId:null,pendingRecordId:null,actual:{progress:null,recordId:null,effectiveDate:null,carriedForward:false,reviewedAt:null}}],records:[{id:'r1',project_id:'p1',task_id:'t1',effective_date:'2026-10-09',progress:30,note:'=SUM(A1:A2)\n冻结依据_x000A_',state:'approved',version:2,task_version:2,corrects_id:'old',snapshot:{title:'冻结名称',location:'冻结部位'},requested_by:'u1',requester_name:'现场',created_at:'2026-10-11T01:00:00Z',reviewer_name:'经理',reviewed_at:'2026-10-11T03:00:00Z',review_note:'独立复核',superseded:false,secret:'RECORD_HIDDEN_SECRET'}]},
});
const inspect=bytes=>{const files=Object.fromEntries(Object.entries(unzipSync(bytes)).map(([k,v])=>[k,strFromU8(v)]));return {files,text:Object.values(files).join('\n')};};

test('progress workbook explicitly projects field data and preserves unknown / provenance with passive cells',()=>{
  const s=snapshot(),b=inspect(buildEngineeringProgressWorkbook(s));
  assert.deepEqual([...b.files['xl/workbook.xml'].matchAll(/<sheet name="([^"]+)"/g)].map(m=>m[1]),['日期进度','填报更正历史','口径说明']);
  assert.doesNotMatch(b.text,/FINANCE_ONLY_SECRET|RECORD_HIDDEN_SECRET|123456789|<f[ >]|externalLink|vbaProject/);
  for(const word of ['未知','当前名称','冻结名称','冻结部位','沿用此前记录','更正原记录ID','北京时间','按当前已批准的更正回看'])assert.ok(b.text.includes(word),word);
  assert.match(b.files['xl/worksheets/sheet2.xml'],/t="inlineStr"[^]*=SUM\(A1:A2\)/);
  assert.match(b.text,/_x005F_x000A_/);assert.match(b.text,/<v>30<\/v>/);assert.match(b.text,/<v>80<\/v>/);
  assert.match(b.files['xl/worksheets/sheet1.xml'],/<pane[^>]+state="frozen"/);assert.match(b.files['xl/worksheets/sheet2.xml'],/autoFilter/);
  assert.match(b.files['xl/worksheets/sheet1.xml'],/<c r="E2" s="3" t="n"><v>30.00<\/v>/);
  assert.match(b.files['xl/worksheets/sheet1.xml'],/<c r="E3" s="2" t="inlineStr"><is><t xml:space="preserve">未知/);
});

test('dated baseline export retains full scope and explicit unknown aggregate rather than partial average',()=>{
  const s=snapshot();s.baseline={actualMode:'dated',asOf:s.progress.asOf,selectedBaselineId:'b1',selectedBaseline:{id:'b1',project_id:'p1',title:'批准计划'},comparison:{tasks:[{id:'t1',title:'冻结名称',location:'A',baselineStart:'2026-10-01',baselineDue:'2026-10-10',baselineDuration:10,plannedProgress:100,actualProgress:30,variance:-70,currentState:'active',actualObservation:s.progress.tasks[0].actual},{id:'t2',title:'缺少依据',location:'B',baselineStart:'2026-10-10',baselineDue:'2026-10-13',baselineDuration:4,plannedProgress:25,actualProgress:null,variance:null,currentState:'cancelled',actualObservation:s.progress.tasks[1].actual}],summary:{knownTasks:1,totalTasks:2,knownWeightPercent:71.43,plannedProgress:78.57,actualProgress:null,variance:null}}};
  const b=inspect(buildEngineeringProgressWorkbook(s));assert.match(b.text,/计划基线对照/);assert.match(b.text,/实际 未知；偏差 未知/);assert.match(b.text,/71.43%/);assert.match(b.text,/不受日期进度表的单任务筛选影响/);
  assert.match(b.files['xl/worksheets/sheet2.xml'],/<c r="K2" s="3" t="n"><v>-70.00<\/v>/);
  s.baseline.actualMode='latest';assert.throws(()=>buildEngineeringProgressWorkbook(s),/口径不一致/);
  s.baseline.actualMode='dated';s.baseline.asOf='2026-10-11';assert.throws(()=>buildEngineeringProgressWorkbook(s),/口径不一致/);
});

test('progress export rejects mixed project or filter sources and never truncates over-budget histories',()=>{
  let s=snapshot();s.progress.records[0].project_id='foreign';assert.throws(()=>buildEngineeringProgressWorkbook(s),/其他项目/);
  s=snapshot();s.progress.records[0].task_id='foreign';assert.throws(()=>buildEngineeringProgressWorkbook(s),/范围之外/);
  s=snapshot();s.baseline={selectedBaseline:{project_id:'foreign'}};assert.throws(()=>buildEngineeringProgressWorkbook(s),/不属于本项目/);
  s=snapshot();s.progress.records=Array(20001).fill(s.progress.records[0]);assert.throws(()=>buildEngineeringProgressWorkbook(s),/20000/);
});
