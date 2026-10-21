import {buildEngineeringSheets} from './engineering-export.mjs';
import {siteWorkSteps, isStepCategory} from './site-work-steps.mjs';
import {supervisionMissing} from './supervision-daily-document.mjs';

export const siteRegisterLimits = Object.freeze({records:2000, files:10000});
const states={draft:'草稿',archived:'已归档',withdrawn:'已撤回'};
const path=r=>(r.snapshot.path||[]).map(n=>[n.code,n.title].filter(Boolean).join(' ')).join(' / ');
const col=(label,key,kind='text',width=24)=>({label,key,kind,width});

// Inputs have already passed project AND original-source visibility checks.
// Coverage describes files present in the snapshot, never completion or acceptance.
export function inspectSiteRecords(records,categories){
  const totals=Object.fromEntries(Object.keys(categories).map(category=>[category,{draft:0,archived:0,withdrawn:0,pendingUploads:0,unassigned:0}]));
  const checks={};
  for(const r of records){
    const active=r.files.filter(f=>!f.removed_at),steps=isStepCategory(r.data.category);
    const provided=steps?siteWorkSteps.filter(s=>active.some(f=>f.step_id===s.id)).map(s=>s.id):[];
    const representatives=r.data.category==='work_photos'?siteWorkSteps.filter(s=>active.some(f=>f.step_id===s.id&&f.representative===1)).map(s=>s.id):[];
    const check={activeFiles:active.length,removedFiles:r.files.length-active.length,pendingUploads:r.pendingUploads,
      unassigned:steps?active.filter(f=>!siteWorkSteps.some(s=>s.id===f.step_id)).length:0,
      provided,representatives,missingFields:r.data.supervision?supervisionMissing(r.data.supervision):[],wordCount:r.wordCount};
    checks[r.id]=check;const total=totals[r.data.category];total[r.state]++;total.pendingUploads+=check.pendingUploads;total.unassigned+=check.unassigned;
  }
  return {totals,checks,total:records.length,pendingUploads:records.reduce((n,r)=>n+r.pendingUploads,0),
    pendingRecords:records.filter(r=>r.pendingUploads>0).length};
}

export function buildSiteRegister({project,records,categories,filters,actorName,exportedAt}){
  const view=inspectSiteRecords(records,categories),steps=[];
  for(const r of records.filter(r=>isStepCategory(r.data.category)))for(const s of siteWorkSteps){
    const fs=r.files.filter(f=>!f.removed_at&&f.step_id===s.id);
    steps.push({record:r.id,title:r.data.title,category:categories[r.data.category],state:states[r.state],path:path(r),step:s.name,
      provided:fs.length?'已提供':'本份未提供',count:fs.length,representative:r.data.category==='work_photos'?(fs.some(f=>f.representative===1)?'已选':'未选'):'不适用'});
  }
  const sheets=[{name:'资料台账',columns:[col('资料ID','id','text',38),col('标题',r=>r.data.title,'text',32),col('分类',r=>categories[r.data.category]),
    col('上传规则',r=>r.data.uploadPolicy==='seven_v1'?'七类图片/视频':'历史或辅助资料'),col('对应照片组ID',r=>r.data.photoRecordId,'text',38),col('填报时照片组名称',r=>r.snapshot.photoGroup?.title,'text',32),
    col('资料日期',r=>r.data.recordDate,'date',16),col('状态',r=>states[r.state]),col('复核状态',r=>r.review?({submitted:'待复核',approved:'复核通过',returned:'退回补充',draft:'草稿'})[r.review.state]:'历史或未提交'),col('指定复核人员ID',r=>r.review?.reviewer_id||''),col('复核意见',r=>r.review?.note||'','text',40),col('填报时施工部位',path,'text',42),col('任务',r=>r.snapshot.task?.title),
    col('作业批次ID',r=>r.data.batchId,'text',38),col('作业批次',r=>r.snapshot.batch? r.snapshot.batch.code+' '+r.snapshot.batch.title:'未关联批次'),col('批次要求版本',r=>r.snapshot.batch?.version??''),col('版本','version','integer',12),col('创建人','creator_name'),col('更新时间','updated_at','time',24),col('归档人','archived_name'),col('归档时间','archived_at','time',24),
    col('撤回人','withdrawn_name'),col('撤回时间','withdrawn_at','time',24),col('撤回原因','withdraw_reason','text',40),
    col('当前原件数',r=>view.checks[r.id].activeFiles,'integer',18),col('已移除原件数',r=>view.checks[r.id].removedFiles,'integer',20),col('未完成上传数','pendingUploads','integer',20),
    col('待整理原件数',r=>view.checks[r.id].unassigned,'integer',20),col('已提供工序数',r=>isStepCategory(r.data.category)?view.checks[r.id].provided.length:'不适用'),
    col('A4代表图工序数',r=>r.data.category==='work_photos'?view.checks[r.id].representatives.length:'不适用'),
    col('监理正文待补字段',r=>view.checks[r.id].missingFields.join('、'),'text',40),col('生成Word版本数','wordCount','integer',22),
    col('最新生成Word名称',r=>r.latestWord?.name,'text',34),col('最新Word来源版本',r=>r.latestWord?.source_version??''),col('最新Word SHA256',r=>r.latestWord?.sha256,'text',68),
    col('已提交日报来源ID',r=>r.data.dailyReportId,'text',38),col('日报原作者',r=>r.snapshot.dailyReport?.authorName),col('日报原图出现次数',r=>r.snapshot.dailyReport?.photos.length??''),col('备注',r=>r.data.note,'text',48)
  ],records}, {name:'原件清单',columns:[col('资料ID','recordId','text',38),col('原件ID','id','text',38),col('原件名称','name','text',38),col('类型','mime','text',42),
    col('字节数','byte_count','integer',18),col('SHA256','sha256','text',68),col('所属工序',r=>siteWorkSteps.find(s=>s.id===r.step_id)?.name||'未分配'),col('当前A4代表照片',r=>!r.removed_at&&r.representative===1?'是':'否'),
    col('保存人','created_name'),col('保存时间','created_at','time',24),col('是否已移除',r=>r.removed_at?'是':'否'),col('移除人','removed_name'),col('移除时间','removed_at','time',24),col('移除原因','remove_reason','text',40)
  ],records:records.flatMap(r=>r.files.map(f=>({...f,recordId:r.id})))}, {name:'十道工序检查',columns:[col('资料ID','record','text',38),col('资料标题','title','text',30),col('分类','category'),col('状态','state'),col('填报时部位','path','text',42),col('工序','step'),col('原件情况','provided'),col('当前原件数','count','integer',18),col('A4代表照片','representative')],records:steps},
  {name:'导出口径',columns:[col('项目 / 口径','item','text',26),col('说明','value','text',100)],records:[
    {item:'项目',value:project.data.name+'（'+project.id+'）'},{item:'导出人',value:actorName},{item:'导出时点（UTC）',value:exportedAt},
    {item:'筛选条件',value:JSON.stringify(filters)},{item:'范围',value:`当前账号可见资料 ${records.length} 份；覆盖全部筛选结果，不受页面分页影响。日报来源仍限原作者或系统管理员。`},
    {item:'检查口径',value:'工序只统计本份当前未移除原件；撤回资料保留状态单独列示，不计作有效归档。照片、视频和A4代表图分别检查。未提供不表示工程缺项；资料齐备不表示施工完成或验收通过。'},
    {item:'原件与Word',value:'台账不包含原文件字节、下载凭据或监理全文；原件摘要用于核对，移除历史保留。日报重复原图可共用一个物理原件，出现次数另列。最新生成Word不一定对应当前正文版本，需核对来源版本。'},
    {item:'限制',value:'超过2000份资料或10000份原件请缩小筛选范围；不生成截断文件。施工部位及任务名称取填报快照。未完成上传不计作已保存原件。'}
  ]}];
  return buildEngineeringSheets(sheets,{title:project.data.name+' 施工资料台账',exportedAt});
}
