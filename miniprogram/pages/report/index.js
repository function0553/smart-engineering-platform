const api=require('../../utils/api'), model=require('../../utils/report'), drafts=require('../../utils/draft');
const submissions=require('../../utils/submission');
Page({
  data:{loading:true,busy:false,uploading:false,user:null,step:0,selected:0,kindOptions:['管网施工 · 完成比例','水表更换 · 完成数量'],base:{},sections:[],current:{works:[]},photos:[],errors:[],notice:'',draftNotice:'填写内容与照片草稿自动保存在本机，提交后保存到服务器',draftWarning:'',weatherLoading:false,weatherError:'',weatherDescription:'',locationExpanded:false,savedFile:'',submittedId:''},
  async onLoad() {
    this.weatherVersion=0; this.photoPaths=[];
    const session=api.session(); if(!session) { wx.redirectTo({url:'/pages/login/index'}); return; }
    try {
      const user=await api.request('/me'); this.user=user; this.key=model.draftKey(api.baseUrl(),user.id);
      const template=await api.request('/daily-report/template');
      this.template=template;this.draftStorage=drafts.createDraftStorage(this.key);
      try {const draft=this.draftStorage.load();this.report=draft?draft.report:template;this.photoPaths=draft?draft.paths:[];}
      catch(_) {this.draftStorage=null;const old=wx.getStorageSync(this.key);this.report=model.checkReport(old)?model.textDraft(old):template;delete this.report._photoDraft;this.setData({draftNotice:'本机照片草稿无法恢复，请导入填写数据或重新选择照片',draftWarning:'本机照片草稿未能恢复，请导入已备份的填写数据。'});}
      this.setData({user,loading:false}); this.updateView(); if(this.report.weatherAuto) this.fetchWeather();
    } catch(e) { this.fail(e); this.setData({loading:false}); }
  },
  onHide() { this.saveDraft(); }, onUnload() { this.weatherVersion++; clearTimeout(this.saveTimer); this.saveDraft(); },
  updateView() {
    if (!this.report) return;
    const r=this.report, index=Math.min(this.data.selected,r.sections.length-1);
    const info=r.weatherInfo;
    this.setData({selected:index,base:{projectName:r.projectName,region:r.region,reportDate:r.reportDate,number:r.number,weather:r.weather,weatherAuto:!!r.weatherAuto,weatherLocation:r.weatherLocation || this.template.weatherLocation,nextPlan:r.nextPlan,otherItems:r.otherItems},sections:r.sections.map(s=>({name:s.name,kind:s.kind})),current:model.clone(r.sections[index]),photos:r.photos.map((p,i)=>({name:p.name,caption:p.caption,path:this.photoPaths[i] || ''})),weatherDescription:r.weatherAuto && info?`Open-Meteo · ${info.date} · ${info.kind==='forecast'?'预报资料':'历史天气资料'}${info.temperatureMin!==null && info.temperatureMax!==null ? ' · '+info.temperatureMin+'～'+info.temperatureMax+'℃':''}`:'现场填写'});
  },
  scheduleSave() { clearTimeout(this.saveTimer); this.saveTimer=setTimeout(()=>this.saveDraft(),500); },
  writable() { return !!this.report && !!this.user && this.user.role!=='viewer' && !this.data.busy && !this.data.uploading; },
  saveDraft() { if(!this.report || !this.key || !this.user || this.user.role==='viewer') return;
    try {if(!this.draftStorage){this.setData({draftNotice:'照片草稿不可用，请下载填写数据留存',draftWarning:'本机照片草稿不可用，请下载填写数据备份本次内容和照片。'});return;}this.photoPaths=this.draftStorage.save(this.report);this.setData({draftNotice:'填写内容与照片草稿已保存在本机',draftWarning:''});this.updateView();}
    catch(_) {this.setData({draftNotice:'本机照片草稿保存失败，请下载填写数据留存',draftWarning:'本机照片草稿保存失败，请下载填写数据备份本次内容和照片。'});}
  },
  input(e) {
    if(!this.writable()) return;
    const {scope,key,index}=e.currentTarget.dataset, v=e.detail.value;
    if(scope==='base' && ['projectName','region','number','weather','nextPlan','otherItems'].includes(key)) { this.report[key]=v; if(key==='weather') {this.report.weatherAuto=false;delete this.report.weatherInfo;this.weatherVersion++;this.setData({weatherLoading:false,weatherError:''});} }
    else if(scope==='location' && ['name','latitude','longitude'].includes(key)) { this.report.weatherLocation=this.report.weatherLocation || model.clone(this.template.weatherLocation); this.report.weatherLocation[key]=key==='name'?v:v===''?null:Number(v); }
    else if(scope==='section' && ['name','designQuantity','todayProgress','cumulativeProgress','todayNotes','machinery','workers','security','tomorrow','procedures','difficulties'].includes(key)) this.report.sections[this.data.selected][key]=v;
    else if(scope==='work' && ['name','quantity','unit'].includes(key)) this.report.sections[this.data.selected].works[Number(index)][key]=v;
    else if(scope==='photo' && key==='caption') this.report.photos[Number(index)].caption=v;
    this.updateView();this.scheduleSave();
  },
  locationBlur() { if(this.report.weatherAuto) this.fetchWeather(); },
  changeDate(e) {if(!this.writable())return;this.report.reportDate=e.detail.value;this.updateView();this.scheduleSave();if(this.report.weatherAuto)this.fetchWeather();},
  toggleLocation() {this.setData({locationExpanded:!this.data.locationExpanded});},
  changeStep(e) {this.setData({step:Number(e.currentTarget.dataset.index)});wx.pageScrollTo({scrollTop:0,duration:0});},
  selectSection(e) {this.setData({selected:Number(e.detail.value)});this.updateView();},
  changeKind(e) {if(!this.writable())return;this.report.sections[this.data.selected].kind=Number(e.detail.value)===1?'meter':'pipeline';this.updateView();this.scheduleSave();},
  addSection() {if(!this.writable())return;if(this.report.sections.length>=12)return;this.report.sections.push(model.emptySection());this.setData({selected:this.report.sections.length-1});this.updateView();this.scheduleSave();},
  removeSection() {if(!this.writable())return;if(this.report.sections.length<=1)return;wx.showModal({title:'删除施工片区',content:'删除此片区及已填写内容？',success:r=>{if(r.confirm){this.report.sections.splice(this.data.selected,1);this.setData({selected:0});this.updateView();this.scheduleSave();}}});},
  addWork() {if(!this.writable())return;const works=this.report.sections[this.data.selected].works;if(works.length>=40)return;works.push({name:'新增工序',quantity:'',unit:'m'});this.updateView();this.scheduleSave();},
  removeWork(e) {if(!this.writable())return;this.report.sections[this.data.selected].works.splice(Number(e.currentTarget.dataset.index),1);this.updateView();this.scheduleSave();},
  weatherToggle(e) {if(!this.writable())return;this.report.weatherAuto=e.detail.value;this.updateView();this.scheduleSave();if(e.detail.value)this.fetchWeather();else {this.weatherVersion++;this.setData({weatherLoading:false,weatherError:''});}},
  async fetchWeather() {
    if(!this.report || this.data.busy || this.user.role==='viewer')return;
    const version=++this.weatherVersion, date=this.report.reportDate, location=this.report.weatherLocation || this.template.weatherLocation;
    const cached=this.report.weatherInfo;
    this.report.weatherAuto=true;this.report.weatherLocation=model.clone(location);
    if(!cached || cached.date!==date || cached.latitude!==location.latitude || cached.longitude!==location.longitude){this.report.weather='';delete this.report.weatherInfo;}
    this.setData({weatherLoading:true,weatherError:''});this.updateView();
    try {
      if(!Number.isFinite(location.latitude)||!Number.isFinite(location.longitude))throw new Error('请填写有效的项目坐标');
      const info=await api.request('/daily-report/weather?date='+encodeURIComponent(date)+'&latitude='+location.latitude+'&longitude='+location.longitude);
      if(version!==this.weatherVersion || !this.report.weatherAuto)return;
      this.report.weather=info.condition;this.report.weatherInfo=info;this.updateView();this.scheduleSave();
    } catch(e) {if(version===this.weatherVersion)this.setData({weatherError:e.message});} finally {if(version===this.weatherVersion)this.setData({weatherLoading:false});}
  },
  async addPhotos() {
    if(!this.writable() || this.report.photos.length>=12)return;
    wx.chooseMedia({count:Math.min(9,12-this.report.photos.length),mediaType:['image'],sourceType:['album','camera'],success:async result=>{
      this.setData({uploading:true,errors:[]});
      try {
        let total=this.report.photos.reduce((n,p)=>n+p.base64.length*3/4,0);
        const addition=[];
        for(const file of result.tempFiles) {
          if(file.size>5*1024*1024)throw new Error('单张照片不能超过5MB');total+=file.size;if(total>20*1024*1024)throw new Error('照片合计不能超过20MB');
          const image=await new Promise((resolve,reject)=>wx.getImageInfo({src:file.tempFilePath,success:resolve,fail:()=>reject(new Error('无法读取照片'))}));
          const mime=image.type==='png'?'image/png':['jpeg','jpg'].includes(image.type)?'image/jpeg':'';
          if(!mime || image.width>16000 || image.height>16000)throw new Error('请选择PNG/JPEG照片，边长不超过16000像素');
          const base64=await new Promise((resolve,reject)=>wx.getFileSystemManager().readFile({filePath:file.tempFilePath,encoding:'base64',success:r=>resolve(r.data),fail:()=>reject(new Error('读取照片失败'))}));
          addition.push({photo:{name:file.tempFilePath.split('/').pop(),caption:'',mime,base64,width:image.width,height:image.height},path:file.tempFilePath});
        }
        addition.forEach(x=>{this.report.photos.push(x.photo);this.photoPaths.push(x.path);});this.updateView();this.saveDraft();
      }catch(e){this.fail(e,'photos');}finally{this.setData({uploading:false});}
    }});
  },
  removePhoto(e) {if(!this.writable())return;const i=Number(e.currentTarget.dataset.index);this.report.photos.splice(i,1);this.photoPaths.splice(i,1);this.updateView();this.saveDraft();},
  fail(e,path='') {this.setData({errors:e.fields || [{path,message:e.message || '操作未完成'}]});wx.pageScrollTo({scrollTop:0,duration:0});if(e.status===401){this.saveDraft();wx.redirectTo({url:'/pages/login/index'});}},
  locateError(e) {const path=e.currentTarget.dataset.path || '';if(path.startsWith('sections.'))this.setData({step:1,selected:Number(path.split('.')[1])});else this.setData({step:path.startsWith('photos') || ['nextPlan','otherItems'].includes(path)?2:0});this.updateView();wx.pageScrollTo({scrollTop:0,duration:0});},
  async generate() {
    if(this.data.busy || this.data.uploading || this.data.weatherLoading || !this.report || this.user.role==='viewer')return;
    this.saveDraft();this.setData({busy:true,errors:[],notice:'',savedFile:'',submittedId:''});
    let receipt;
    try {
      const submissionId=submissions.submissionKey(this.key,this.report);
      receipt=await api.request('/daily-report/submissions','POST',{submissionId,data:this.report});
      this.setData({submittedId:receipt.id,notice:'日报文字、原图和 Word 已保存在服务器，正在下载 Word…'});
      const bytes=await api.request('/daily-report/submissions/'+receipt.id+'/word','GET',undefined,true), path=await api.saveWord(bytes,receipt.reportDate,receipt.id);
      this.setData({savedFile:path,notice:'日报已提交到服务器，Word 已保存，可查看或转发文件'});
      wx.openDocument({filePath:path,fileType:'docx',showMenu:true,fail:()=>this.setData({notice:'日报已提交，Word 已保存；可点击转发文件或稍后查看'})});
    } catch(e){if(receipt)this.setData({notice:'日报已提交到服务器。Word 下载未完成，可在汇报记录中重新下载。'});this.fail(e);}finally{this.setData({busy:false});}
  },
  history() {this.saveDraft();wx.navigateTo({url:'/pages/history/index'});},
  archives() {this.saveDraft();wx.navigateTo({url:'/pages/archives/index'});},
  submitted() {if(this.data.submittedId)wx.navigateTo({url:'/pages/history/index?id='+this.data.submittedId});},
  openWord() {wx.openDocument({filePath:this.data.savedFile,fileType:'docx',showMenu:true});},
  shareWord() {if(wx.canIUse('shareFileMessage'))wx.shareFileMessage({filePath:this.data.savedFile,fileName:'施工日报_'+this.report.reportDate+'.docx'});else this.setData({notice:'当前微信版本不支持直接转发文件，可在文档预览菜单操作'});},
  exportData() {
    const path=wx.env.USER_DATA_PATH+'/日报填写数据_'+this.report.reportDate+'.json';
    wx.getFileSystemManager().writeFile({filePath:path,data:JSON.stringify({schemaVersion:1,data:this.report}),encoding:'utf8',success:()=>{if(wx.canIUse('shareFileMessage'))wx.shareFileMessage({filePath:path,fileName:'日报填写数据_'+this.report.reportDate+'.json'});else this.setData({notice:'填写数据已保存在小程序文件空间'});},fail:()=>this.fail(new Error('保存填写数据失败'))});
  },
  importData() {if(!this.writable())return;
    wx.chooseMessageFile({count:1,type:'file',extension:['json'],success:result=>{
      const file=result.tempFiles[0];if(file.size>30*1024*1024){this.fail(new Error('填写数据文件过大'));return;}
      wx.getFileSystemManager().readFile({filePath:file.path,encoding:'utf8',success:r=>{try{const body=JSON.parse(r.data);if(body.schemaVersion!==1 || !model.checkReport(body.data))throw new Error('请选择本系统导出的填写数据');const imported=body.data;this.weatherVersion++;this.report=imported;this.photoPaths=[];this.setData({selected:0,step:0,errors:[],weatherLoading:false,notice:'已导入，请核对日期及当天内容'});this.updateView();this.saveDraft();if(this.report.weatherAuto)this.fetchWeather();}catch(e){this.fail(e);}},fail:()=>this.fail(new Error('读取填写数据失败'))});
    }});
  },
  async logout() {this.saveDraft();try{await api.request('/logout','POST',{});}catch(_){}api.clearSession();wx.redirectTo({url:'/pages/login/index'});}
});
