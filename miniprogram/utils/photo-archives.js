const {digest}=require('./submission');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function clone(value){return JSON.parse(JSON.stringify(value));}
// A retry identifier only; authentication always uses the existing session.
function uuid(){return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const n=Math.floor(Math.random()*16);return (c==='x'?n:(n&3)|8).toString(16);});}
function emptySegment(template){return {id:uuid(),start:'',end:'',content:'',completedAt:'',stages:template.stages.map(name=>({id:uuid(),name,completedAt:''}))};}
function createArchive(template){return {title:'开挖至回填影像资料',projectName:template.projectName,roadName:template.roadName,segments:[emptySegment(template)]};}
function segmentLabel(segment,index){return segment.content || (segment.start || segment.end ? (segment.start || '起点待填')+' ～ '+(segment.end || '终点待填') : '路段 '+(index+1));}
function draftKey(baseUrl,userId,archiveId='new'){return 'photo-archive:draft:'+digest(String(baseUrl)+'\n'+String(userId)).slice(0,24)+':'+archiveId;}
function validateStructure(data){
  return !!data && typeof data.title==='string' && typeof data.projectName==='string' && typeof data.roadName==='string' && Array.isArray(data.segments) && data.segments.length>=1 && data.segments.length<=32 && data.segments.every(s=>s && UUID.test(s.id) && ['start','end','content','completedAt'].every(k=>typeof s[k]==='string') && Array.isArray(s.stages) && s.stages.length>=1 && s.stages.length<=16 && s.stages.every(t=>t && UUID.test(t.id) && typeof t.name==='string' && typeof t.completedAt==='string'));
}
function validationMessage(data){
  if(!validateStructure(data))return '填写数据无法读取，请重新打开资料册';
  for(const [key,label] of [['title','资料册名称'],['projectName','工程名称'],['roadName','道路名称']])if(!data[key].trim())return '请填写'+label;
  const date=/^\d{4}-\d{2}-\d{2}$/;
  for(let i=0;i<data.segments.length;i++){
    const s=data.segments[i];
    if(!s.content.trim()){
      const parse=v=>/^K\d+\+\d{1,3}(?:\.\d{1,3})?$/i.test(v.trim())?Number(v.trim().slice(1).split('+')[0])*1000+Number(v.trim().split('+')[1]):NaN;
      if(!Number.isFinite(parse(s.start)) || !Number.isFinite(parse(s.end)) || parse(s.start)>=parse(s.end))return '路段 '+(i+1)+'：请填写起止桩号（如 K0+000～K0+100），或填写施工内容';
    }
    if(s.completedAt && !date.test(s.completedAt))return '路段 '+(i+1)+'：日期格式应为 年-月-日';
    for(const t of s.stages){if(!t.name.trim())return '路段 '+(i+1)+'：工序名称不能为空';if(t.completedAt && !date.test(t.completedAt))return '工序日期格式应为 年-月-日';}
  }
  return '';
}
function readDraft(key){const saved=wx.getStorageSync(key);return saved && saved.schemaVersion===1 && validateStructure(saved.data)?saved:null;}
function writeDraft(key,value){wx.setStorageSync(key,Object.assign({},value,{schemaVersion:1,savedAt:new Date().toISOString()}));}
function removeDraft(key){wx.removeStorageSync(key);}
function wordFileName(roadName,exportId){return '施工影像_'+String(roadName || '资料册').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').slice(0,40)+'_'+exportId+'.docx';}
module.exports={clone,uuid,emptySegment,createArchive,segmentLabel,draftKey,validateStructure,validationMessage,readDraft,writeDraft,removeDraft,wordFileName,UUID};
