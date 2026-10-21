// Navigation descriptors only. All authorization and business mutations stay on the server.
export const engineeringGroups = Object.freeze([
 {id:'project',name:'项目与组织',modules:[['overview','项目概况','工期、状态与经营汇总'],['wbs','施工部位','施工部位层级与任务归属'],['members','项目成员','项目岗位与资料权限'],['crews','班组入退场','安全教育、入场审核与退场']]},
 {id:'plan',name:'施工计划',modules:[['tasks','施工计划','任务、前置关系与施工状态'],['progress','日期进度','按日期填报、独立复核与更正'],['baselines','计划基线','冻结计划、比较实际进度'],['value-plans','目标产值','清单与任务分配、产值比较'],['task-values','任务产值','追溯已批计量与任务实绩']]},
 {id:'quality',name:'质量安全',modules:[['issues','质量安全','问题、整改、独立复查与关闭']]},
 {id:'supply',name:'采购与材料',modules:[['purchases','采购管理','逐行验收、退货、抵减与退款'],['materials','材料库存','期初、领退料与库存流水']]},
 {id:'commercial',name:'合同与经营',modules:[['contracts','合同台账','提交、独立审批与结清'],['boq','工程量清单','清单版本、修订与独立审批'],['variations','变更签证','变更依据、审批与纠错'],['measurements','工程量计量','本期新增数量与累计控制'],['settlements','合同结算','依据已批计量办理结算'],['subcontracts','分包保留金','分包政策、完工与保留金释放']]},
 {id:'funds',name:'资金与成本',modules:[['costs','收支与成本','凭据、独立确认与净额'],['cost-control','目标成本','目标计划、材料耗用与偏差'],['reversals','冲销办理','反向金额或库存，保留原单'],['corrections','经营纠错','撤销影响与替代办理追溯']]},
 {id:'records',name:'施工资料',modules:[['documents','施工资料','七类原件、十道工序与独立复核'],['library','资料册','按施工部位和日期整理、打包下载'],['history','办理记录','查阅项目内可见业务历史']]},
]);
const moneyModules=new Set(['purchases','contracts','boq','variations','measurements','settlements','subcontracts','costs','cost-control','corrections','value-plans','task-values']);
export const financialModule = id => moneyModules.has(id);
export const engineeringModules = Object.freeze(engineeringGroups.flatMap(g=>g.modules.map(([id,name,description])=>({id,name,description,group:g.id}))));
export function visibleEngineeringGroups(role){return engineeringGroups.map(g=>({...g,modules:g.modules.filter(([id])=>!financialModule(id)||['admin','manager','finance'].includes(role))})).filter(g=>g.modules.length);}
export function moduleInfo(id){return engineeringModules.find(m=>m.id===id)||engineeringModules[0];}
export function readMobileRoute(hash,fallbackProject=''){
 const [path,query='']=String(hash).replace(/^#/,'').split('?'),p=new URLSearchParams(query);
 if(path!=='engineering')return{view:'workbench',projectId:fallbackProject,module:'',itemId:''};
 const view=['workbench','projects','todos','me'].includes(p.get('view'))?p.get('view'):'workbench';
 const safeId=v=>/^[a-f\d-]{36}$/i.test(v||'')?v:'';
 const projectId=safeId(p.get('project'))||fallbackProject;
 const module=engineeringModules.some(m=>m.id===p.get('module'))?p.get('module'):['daily','photos','menu','library-all'].includes(p.get('module'))?p.get('module'):view==='projects'&&projectId?'documents':'';
 return{view,projectId,module,itemId:safeId(p.get('item'))};
}
export function mobileRouteHash(route){const p=new URLSearchParams({view:route.view});if(route.projectId)p.set('project',route.projectId);if(route.module)p.set('module',route.module);if(route.itemId)p.set('item',route.itemId);return '#engineering?'+p;}
// Labels describe the server's effective permission; they never grant an action.
export function siteWorkspaceIdentity(role,permission,projectState='active'){
 const roles={admin:'项目管理员',manager:'项目经理',engineer:'施工员',finance:'商务 / 财务',viewer:'只读人员'};
 const templates={manager:'项目经理',documenter:'资料员',engineer:'施工员',supervisor:'监理 / 复核人员',material:'材料员',finance:'商务 / 财务',viewer:'只读人员',crew:'班组负责人'};
 if(!permission)return{label:roles[role]||'项目成员',actions:[],ready:false};
 if(permission.enabled&&permission.expired)return{label:'资料授权未生效',actions:[],ready:true};
 const writable=projectState==='active'&&role!=='viewer';
 if(!permission.enabled)return{label:roles[role]||'项目成员',actions:writable?['上传资料','整理归档','查阅原件']:['查阅资料'],ready:true};
 const allowed=new Set(permission.actions||[]),actions=[];
 if(writable){
  if(allowed.has('create'))actions.push('上传资料');
  else if(allowed.has('editOwn')||allowed.has('editAny'))actions.push('补充资料');
  if(allowed.has('submit'))actions.push('提交审核');
  if(allowed.has('review'))actions.push('审核资料');
  if(allowed.has('archive'))actions.push('归档资料');
 }
 if(allowed.has('download'))actions.push('下载原件');
 else if(allowed.has('read'))actions.push('查阅资料');
 return{label:role==='admin'?'项目管理员':role==='viewer'?'只读人员':templates[permission.template]||roles[role]||'项目成员',actions,ready:true};
}
const title=r=>r.data?.title||r.snapshot?.title||r.title||r.snapshot?.purchaseTitle||r.snapshot?.purchase?.data?.title||r.snapshot?.contractTitle||'待办理记录';
const actor=r=>r.review?.submitted_by||r.requested_by||r.submitted_by||r.created_by||r.submitter_id||'';
// This is a project queue, not a claim that the current account can approve every row.
export function projectQueue(detail,extras={},today=''){
 if(!detail)return[];const rows=[],seen=new Set();
 const add=(records,module,label)=>{for(const r of records||[]){if(!r?.id)continue;const pending=r.navigationPending||['submitted','returned','open','rectifying','review','pending'].includes(r.state),overdue=!!(today&&r.data?.dueDate<today&&r.data?.dueDate&&!['completed','closed','cancelled','approved','voided'].includes(r.state));if(!pending&&!overdue)continue;const key=module+':'+r.id;if(seen.has(key))continue;seen.add(key);rows.push({id:r.id,module,title:title(r),state:r.state,label,actorId:actor(r),overdue,date:r.effective_date||r.data?.dueDate||r.created_at||'',itemId:(detail.items||[]).some(i=>i.id===r.id)?r.id:(detail.items||[]).some(i=>i.id===r.purchase_id)?r.purchase_id:r.id,recordId:module==='documents'?r.id:''});}};
 add(detail.items,'','');for(const r of rows){const i=detail.items.find(i=>i.id===r.id);r.module=i.kind;r.label=moduleInfo(i.kind).name;}
 add((detail.items||[]).filter(i=>i.kind==='purchases'&&i.state==='approved').map(i=>({...i,navigationPending:true})),'purchases','采购待履约 / 关闭');
 add((detail.purchaseReturns?.returns||[]).filter(r=>r.state==='approved'&&!r.dispatch).map(r=>({...r,navigationPending:true})),'purchases','退货待实际发退');
 add(detail.reversals,'reversals','冲销待复核');add(detail.corrections,'corrections','经营纠错待复核');
 add(detail.boq?.revisions,'boq','清单待审批');add(detail.costControl?.records,'cost-control','目标成本 / 耗用待复核');add(detail.subcontracts?.records,'subcontracts','分包保留金待复核');
 for(const [records,label] of [[detail.purchaseReturns?.returns,'采购退货待审批'],[detail.supplierFinance?.credits,'结算抵减待审批'],[detail.supplierFinance?.refunds,'退款到账待复核'],[detail.purchaseFulfillment?.terminations,'余量终止待审批']])add(records,'purchases',label);
 add(extras.progress?.records,'progress','日期进度待复核');add(extras.baselines?.baselines,'baselines','计划基线待审批');add(extras.valuePlans?.plans,'value-plans','目标产值待审批');
 for(const r of extras.siteRecords?.records||[]){
  if(r.state!=='draft')continue;
  const state=r.review?.state||r.review_state||'draft';
  add([{...r,state,navigationPending:state==='approved'}],'documents',state==='approved'?'施工资料待归档':state==='returned'?'施工资料待补充':'施工资料待复核');
 }
 return rows.sort((a,b)=>Number(b.overdue)-Number(a.overdue)||a.date.localeCompare(b.date));
}
export function pendingCountFor(module,detail,extras,today){return projectQueue(detail,extras,today).filter(r=>r.module===module).length;}
