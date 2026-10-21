export const siteTemplateCategories = Object.freeze({
 site_measurement:'现场收方单扫描件',work_photos:'现场施工步骤照片',work_videos:'现场施工步骤视频',material_measurement:'现场材料收方单扫描件',hidden_work:'隐蔽工程图片',construction_daily:'施工日报',supervision_daily:'监理日报',
});
const guidance={site_measurement:'上传收方单原图，可多张；核对页序、日期和施工部位。',work_photos:'按固定十道工序上传，每道可多张，并选一张A4代表照片。',work_videos:'先选择对应照片组，再按相同十道工序补充视频。',material_measurement:'上传材料收方单原图，可多张；核对材料、数量及签认页面。',hidden_work:'上传隐蔽前现场图片，可多张；填写部位和现场说明。',construction_daily:'上传施工日报扫描图片，可多张；在线填报及原Word归入仍用原辅助入口。',supervision_daily:'上传监理日报扫描图片，可多张；在线填报和生成Word仍用原辅助入口。'};
export const builtinSiteTemplates=Object.freeze(Object.entries(siteTemplateCategories).map(([category,name])=>Object.freeze({id:'builtin.'+category,version:1,builtin:true,state:'active',category,name,scopeWbsId:'',description:guidance[category],defaults:{titlePattern:'{类别} {日期}',note:'',...(['work_photos','work_videos'].includes(category)?{workInfo:{road:'{地址}',location:'{部位}'}}:{})}})));
export const siteTemplateVariables=Object.freeze(['工程','类别','日期','部位','地址']);
const clip=(s,n)=>String(s??'').slice(0,n).replace(/[\uD800-\uDBFF]$/,'');
export function expandSiteTemplate(text,context,max=160){const values={'工程':context.projectName||'','类别':siteTemplateCategories[context.category]||'','日期':context.recordDate||'','部位':context.location||'','地址':context.address||''};return clip(String(text??'').replace(/\{(工程|类别|日期|部位|地址)\}/g,(_,key)=>values[key]),max);}
// Reuse bounded text only. Record identity, originals and workflow are supplied by the current draft.
export function applySiteRecordTemplate(template,current,context){
 if(template.category!==current.category)throw Error('请选择与当前资料分类相同的模板');
 const c={...context,category:current.category,recordDate:current.recordDate};
 const next={...current,title:expandSiteTemplate(template.defaults.titlePattern,c),note:expandSiteTemplate(template.defaults.note,c,2000),templateRef:{id:template.id,version:template.version}};
 if(['work_photos','work_videos'].includes(current.category)&&template.defaults.workInfo)next.workInfo={road:expandSiteTemplate(template.defaults.workInfo.road,c,60),location:expandSiteTemplate(template.defaults.workInfo.location,c,60),number:current.workInfo?.number||'',completedAt:current.workInfo?.completedAt||''};
 return next;
}
export function defaultsFromSiteRecord(data){return {titlePattern:'{类别} {日期}',note:String(data.note||''),...(['work_photos','work_videos'].includes(data.category)&&data.workInfo?{workInfo:{road:String(data.workInfo.road||''),location:String(data.workInfo.location||'')}}:{})};}
