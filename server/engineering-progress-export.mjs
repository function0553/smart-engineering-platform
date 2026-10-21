import {z} from 'zod';
import {fail} from './service.mjs';
import {buildEngineeringSheets} from './engineering-export.mjs';

const col=(label,key,kind='text',width=22)=>({label,key,kind,width});
const labels={planned:'待开工',active:'施工中',completed:'已完成',cancelled:'已撤回 / 取消',submitted:'待复核',approved:'已批准',rejected:'已驳回'};
const pct=value=>value===null||value===undefined?'未知':String(value);
// Existing two-decimal number format has no currency symbol. Values remain
// numeric for sorting/calculation; an unknown observation stays literal text.
const percentCell=value=>value===null||value===undefined?'未知':{kind:'money',value:Math.round(value*100)};
const yes=value=>value?'是':'否';

/** Explicit field projection only: no financial detail object enters this builder. */
export function buildEngineeringProgressWorkbook({project,progress,baseline=null,exportedAt=new Date().toISOString()}){
  if(!project?.id||progress?.projectId!==project.id||!Array.isArray(progress.tasks)||!Array.isArray(progress.records))fail(422,'现场进度导出快照不完整');
  const taskIds=new Set(progress.tasks.map(t=>t.taskId));
  if(progress.records.some(r=>r.project_id!==project.id||!taskIds.has(r.task_id)))fail(422,'日期进度包含其他项目或筛选范围之外的记录');
  if(baseline?.selectedBaseline&&baseline.selectedBaseline.project_id!==project.id)fail(422,'基线不属于本项目');
  const sheets=[],add=(name,columns,records)=>sheets.push({name,columns,records});
  add('日期进度',[
    col('任务ID','taskId','text',38),col('当前任务名称','title','text',30),col('当前部位','location','text',28),
    col('查询施工日期',()=>progress.asOf,'date',16),col('当日累计比例（%）',r=>percentCell(r.actual.progress),'text',24),
    col('依据发生日期',r=>r.actual.effectiveDate,'date',16),col('沿用此前记录',r=>yes(r.actual.carriedForward),'text',18),
    col('依据记录ID',r=>r.actual.recordId,'text',38),col('依据批准时间（北京时间）',r=>r.actual.reviewedAt,'time',28),
    col('当前任务状态',r=>labels[r.state]||r.state,'text',18),col('当前完成比例（%）','currentProgress','integer',24),
    col('当前比例有日期依据',r=>yes(r.currentProgressHasDateBasis),'text',24),col('当前依据记录ID','currentProgressRecordId','text',38),
    col('待复核记录ID','pendingRecordId','text',38),
  ],progress.tasks);
  if(baseline?.comparison){
    if(baseline.actualMode!=='dated'||baseline.asOf!==progress.asOf)fail(422,'基线与进度的查询日期或实际口径不一致');
    add('计划基线对照',[
      col('基线ID',()=>baseline.selectedBaselineId,'text',38),col('基线名称',()=>baseline.selectedBaseline.title,'text',28),
      col('任务ID','id','text',38),col('冻结任务名称','title','text',30),col('冻结部位','location','text',28),
      col('基线开始','baselineStart','date',16),col('基线完成','baselineDue','date',16),col('工期权重（天）','baselineDuration','integer',20),
      col('计划比例（%）',r=>percentCell(r.plannedProgress),'text',20),col('当日累计比例（%）',r=>percentCell(r.actualProgress),'text',24),
      col('偏差（百分点）',r=>percentCell(r.variance),'text',20),col('依据发生日期',r=>r.actualObservation?.effectiveDate,'date',16),
      col('依据记录ID',r=>r.actualObservation?.recordId,'text',38),col('沿用此前记录',r=>yes(r.actualObservation?.carriedForward),'text',18),
      col('当前任务状态',r=>labels[r.currentState]||r.currentState,'text',18),
    ],baseline.comparison.tasks);
  }
  add('填报更正历史',[
    col('记录ID','id','text',38),col('任务ID','task_id','text',38),col('填报时任务名称',r=>r.snapshot.title,'text',30),col('填报时部位',r=>r.snapshot.location,'text',28),
    col('发生日期','effective_date','date',16),col('累计比例（%）','progress','integer',20),col('办理状态',r=>labels[r.state]||r.state,'text',18),
    col('已被批准更正替代',r=>yes(r.superseded),'text',24),col('更正原记录ID','corrects_id','text',38),col('提交时任务版本','task_version','integer',22),
    col('填报人','requester_name'),col('填报时间（北京时间）','created_at','time',26),col('复核人','reviewer_name'),col('复核时间（北京时间）','reviewed_at','time',26),
    col('填报 / 更正依据','note','text',52),col('复核依据','review_note','text',52),
  ],progress.records);
  const explanation=[
    {item:'项目',value:project.data.name+'（'+project.data.code+'）'},
    {item:'项目ID',value:project.id},{item:'查询施工日期',value:progress.asOf},{item:'导出时间（UTC）',value:exportedAt},
    {item:'筛选范围',value:progress.tasks.length+' 项任务；日期进度表和历史表按任务筛选，历史表保留所选任务全部办理记录，不按查询日期截断。'},
    {item:'历史实际',value:'按当前已批准的更正回看，不代表施工当日系统已经知道的结果。取不晚于查询日的最近有效已批准填报；较早来源为沿用，不作插值。未知表示没有依据，不能当作 0。'},
    {item:'日期与时间',value:'发生日期为施工业务日期；填报及复核时间另列。时间单元格按北京时间显示。查询日期不接受未来日期。'},
    {item:'当前与历史',value:'当前名称、部位、状态、完成比例仅表示导出时状态，不还原历史状态。存量百分比没有日期依据时明确标记；基线提交时捕获值不补造历史。'},
    {item:'更正与审批',value:'同任务同日只保留一个有效已批版本，原件始终保留；待复核、驳回和撤回不改变已批准实际。历史百分比不能跨行相加。'},
    {item:'现场数据范围',value:'本册只投影现场任务、进度及选定计划基线，不包含经营金额、合同、采购价、收支、账号或施工资料原件。'},
  ];
  if(baseline?.comparison){
    const s=baseline.comparison.summary;
    explanation.push({item:'选定基线',value:baseline.selectedBaseline.title+'（'+baseline.selectedBaselineId+'）'},
      {item:'基线范围',value:'基线表保留该批准基线的全部任务和冻结工期权重，不受日期进度表的单任务筛选影响。基线选择不按施工日期自动回退；可选择历史批准基线。'},
      {item:'基线实际覆盖',value:`已知 ${s.knownTasks} / ${s.totalTasks} 项，工期权重覆盖 ${s.knownWeightPercent}%。`},
      {item:'基线总体比较',value:`计划 ${pct(s.plannedProgress)}%；实际 ${s.actualProgress===null?'未知':pct(s.actualProgress)+'%'}；偏差 ${s.variance===null?'未知':pct(s.variance)+' 个百分点'}。`},
      {item:'基线计算',value:'计划按施工日期结束、自然日线性计算，以冻结工期加权；并非工程量或产值。任一任务实际未知时，总体实际及偏差为未知。当前已取消任务保留历史观测，不强制清零；基线外新增任务不进入该基线权重。'});
  }
  add('口径说明',[col('项目 / 口径','item','text',26),col('说明','value','text',96)],explanation);
  return buildEngineeringSheets(sheets,{title:project.data.name+' 施工日期进度',exportedAt});
}

export function mountEngineeringProgressExport(app,{base,authorize,store,access,progress,baselines}){
  app.get(base+'/projects/:pid/progress/export',authorize,(req,res)=>{
    const query=z.object({asOf:z.iso.date().optional(),taskId:z.string().uuid().optional(),baselineId:z.string().uuid().optional()}).strict().parse(req.query);
    const snapshot=store.transaction(()=>{
      const {p}=access(req),view=progress.view(p.id,{asOf:query.asOf,taskId:query.taskId});
      const baseline=baselines.view(p.id,{asOf:view.asOf,baselineId:query.baselineId,actualMode:'dated'});
      if(query.baselineId&&!baseline.comparison)fail(409,'请先批准所选计划基线，再导出日期对照');
      return {project:{id:p.id,data:{name:p.data.name,code:p.data.code}},progress:view,baseline,exportedAt:new Date().toISOString()};
    });
    const bytes=buildEngineeringProgressWorkbook(snapshot);
    const filename='施工日期进度_'+snapshot.progress.asOf+'.xlsx';
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="engineering-progress.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Content-Length',String(bytes.length));res.send(bytes);
  });
}
