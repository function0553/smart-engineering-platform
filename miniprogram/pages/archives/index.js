const api=require('../../utils/api'),model=require('../../utils/photo-archives'),drafts=require('../../utils/archive-draft');
const {digest}=require('../../utils/submission');
const cancelled=e=>/cancel/i.test(e && e.errMsg || '');
const confirm=(title,content)=>new Promise(resolve=>wx.showModal({title,content,success:r=>resolve(!!r.confirm),fail:()=>resolve(false)}));
Page({
  data:{mode:'list',loading:true,busy:false,uploading:false,user:null,readOnly:true,items:[],total:0,offset:0,pageNumber:1,hasNext:false,query:'',archive:null,base:{},segments:[],current:{stages:[]},selectedSegment:0,stageViews:[],exports:[],photoCount:0,photoBytesText:'0',pendingPhotos:[],pendingCount:0,notice:'',error:'',uploadNotice:'',draftNotice:'',conflict:false,savedFile:'',savedFileName:'',newDraftAvailable:false},
  async onLoad(options={}){
    this.active=true;this._generation=0;this._imageCache={};this._photoPaths=[];this._pendingLoads={};this._pageId=model.uuid();this.query='';this.queue=[];this.backend=api.baseUrl();this.token=api.session() && api.session().token;
    if(!api.session()){wx.redirectTo({url:'/pages/login/index'});return;}
    try{
      this.user=await api.request('/me');if(!this.contextActive())return;
      this.template=await api.request('/photo-archives/template');if(!this.contextActive())return;
      this.setData({user:this.user,readOnly:this.user.role==='viewer',newDraftAvailable:!!model.readDraft(model.draftKey(this.backend,this.user.id))});
      await this.loadList();if(options.id)await this.openId(options.id);
    }catch(e){this.fail(e);if(this.active)this.setData({loading:false});}
  },
  onShow(){if(this.active && this.backend && (this.backend!==api.baseUrl() || !api.session() || this.token!==api.session().token)){this.saveDraft();this.active=false;this._generation++;this.clearPhotos();wx.redirectTo({url:'/pages/login/index'});}},
  onHide(){this.saveDraft();},
  onUnload(){clearTimeout(this.saveTimer);this.saveDraft();this.active=false;this._generation++;this.clearPhotos();},
  contextActive(){return this.active && this.backend===api.baseUrl() && api.session() && this.token===api.session().token;},
  writable(){return !!this.metadata && !!this.user && this.user.role!=='viewer' && this.contextActive() && !this.data.busy && !this.data.uploading;},
  canWrite(){return !!this.user && this.user.role!=='viewer' && this.contextActive();},
  revealFeedback(){if(this.contextActive())wx.pageScrollTo({scrollTop:0,duration:0,fail(){}});},
  fail(e){if(!this.active)return;this.setData({error:e.message || '操作未完成，请重试'});if(e.status===409)this.setData({conflict:true});if(e.status===401){this.saveDraft();wx.redirectTo({url:'/pages/login/index'});return;}this.revealFeedback();},
  async loadList(){
    if(!this.contextActive() || this.data.busy || this.data.uploading)return;
    const generation=this._listGeneration=(this._listGeneration || 0)+1;this.setData({loading:true,error:''});
    try{const result=await api.request('/photo-archives?limit=20&offset='+this.data.offset+'&q='+encodeURIComponent(this.query || ''));if(!this.contextActive() || generation!==this._listGeneration)return;this.setData({items:result.items.map(x=>Object.assign({},x,{updatedText:x.updatedAt.slice(0,16).replace('T',' ')})),total:result.total,pageNumber:Math.floor(this.data.offset/20)+1,hasNext:this.data.offset+20<result.total,newDraftAvailable:this.user.role!=='viewer' && !!model.readDraft(model.draftKey(this.backend,this.user.id))});}catch(e){this.fail(e);}finally{if(this.contextActive() && generation===this._listGeneration)this.setData({loading:false});}
  },
  searchInput(e){this.setData({query:e.detail.value});},
  search(){if(this.data.loading)return;this.query=this.data.query.trim();this.setData({offset:0});return this.loadList();},
  clearSearch(){if(this.data.loading)return;this.query='';this.setData({query:'',offset:0});return this.loadList();},
  previous(){if(this.data.loading || !this.data.offset)return;this.setData({offset:Math.max(0,this.data.offset-20)});return this.loadList();},
  next(){if(this.data.loading || !this.data.hasNext)return;this.setData({offset:this.data.offset+20});return this.loadList();},
  refresh(){if(this.data.mode==='list' && !this.data.loading)return this.loadList();},
  async newArchive(){
    if(!this.canWrite() || this.data.busy || this.data.uploading || !this.template)return;
    this.saveDraft();this._generation++;this.clearPhotos();
    let saved;try{saved=model.readDraft(model.draftKey(this.backend,this.user.id));}catch(_){}
    this.creationId=saved && model.UUID.test(saved.creationId)?saved.creationId:model.uuid();this.creationData=saved && saved.creationData || null;this.detail=null;this.metadata=saved?model.clone(saved.data):model.createArchive(this.template);this.draftId='new';this.draftStorage=drafts.createStorage(this.backend,this.user.id,this.creationId);this.queue=this.draftStorage.validQueue(saved && saved.queue);this.pendingExport=saved && saved.pendingExport || null;
    this.setData({mode:'editor',loading:false,selectedSegment:0,conflict:false,error:'',notice:saved?'已恢复本机未保存的填写内容和原图队列':'',uploadNotice:'',savedFile:'',savedFileName:''});this.updateView();this.saveDraft();wx.pageScrollTo({scrollTop:0,duration:0});
  },
  openArchive(e){return this.openId(e.currentTarget.dataset.id);},
  async openId(id){
    if(!model.UUID.test(id) || !this.contextActive() || this.data.busy || this.data.uploading)return;
    this.saveDraft();const generation=++this._generation;this.clearPhotos();this.setData({loading:true,error:'',notice:'',uploadNotice:'',savedFile:'',savedFileName:''});
    try{
      const row=await api.request('/photo-archives/'+id);if(!this.contextActive() || generation!==this._generation)return;
      this.draftId=id;this.creationId=null;this.creationData=null;this.draftStorage=drafts.createStorage(this.backend,this.user.id,id);this.detail=row;this.metadata=model.clone(row.data);this.queue=[];this.pendingExport=null;
      let saved;if(this.user.role!=='viewer')try{saved=model.readDraft(model.draftKey(this.backend,this.user.id,id));}catch(_){}
      if(saved){this.metadata=model.clone(saved.data);this.queue=this.draftStorage.validQueue(saved.queue);this.pendingExport=saved.pendingExport || null;this.detail.version=Number.isInteger(saved.version) && saved.version>0?saved.version:row.version;}
      this.reconcileQueue(row.photos);if(this.pendingExport && row.exports.some(e=>e.id===this.pendingExport.id))this.pendingExport=null;this.setData({mode:'editor',loading:false,selectedSegment:0,conflict:!!saved && saved.version!==row.version,notice:saved?'已恢复本机填写草稿；服务器上的原图和历史 Word 保留':'',error:''});this.updateView();this.saveDraft();wx.pageScrollTo({scrollTop:0,duration:0});await this.loadCurrentPhotos();
    }catch(e){this.fail(e);}finally{if(this.contextActive() && generation===this._generation)this.setData({loading:false});}
  },
  saveDraft(){
    if(!this.metadata || !this.user || this.user.role==='viewer' || !this.draftId || !model.validateStructure(this.metadata))return false;
    try{model.writeDraft(model.draftKey(this.backend,this.user.id,this.draftId),{data:model.clone(this.metadata),version:this.detail?this.detail.version:null,creationId:this.creationId,creationData:this.creationData,queue:this.queue || [],pendingExport:this.pendingExport || null});if(this.active)this.setData({draftNotice:this.queue && this.queue.length?'填写内容和 '+this.queue.length+' 张待上传原图已保存在本机':'填写草稿已保存在本机；保存后同步到服务器'});return true;}catch(_){if(this.active)this.setData({draftNotice:'本机草稿保存失败，请先保存到服务器，暂勿退出',error:'本机草稿保存失败，请检查手机可用空间'});return false;}
  },
  scheduleSave(){clearTimeout(this.saveTimer);this.saveTimer=setTimeout(()=>this.saveDraft(),350);},
  updateView(){
    if(!this.active || !this.metadata)return;
    const selected=Math.max(0,Math.min(this.data.selectedSegment,this.metadata.segments.length-1)),segment=this.metadata.segments[selected],photos=this.detail && this.detail.photos || [],current=model.clone(segment);
    const stages=segment.stages.map((stage,index)=>{const uploaded=photos.filter(p=>p.segmentId===segment.id && p.stageId===stage.id).map(p=>Object.assign({},p,this._imageCache[p.id] || {path:'',loading:false,failed:false}));const pending=(this.queue || []).filter(p=>p.segmentId===segment.id && p.stageId===stage.id).map(p=>Object.assign({},p,{path:p.filePath,pending:true}));return Object.assign({},stage,{index,photos:uploaded,pendingPhotos:pending,count:uploaded.length+pending.length,caption:this._captions && this._captions[stage.id] || ''});});
    const photoBytes=photos.reduce((n,p)=>n+p.bytes,0);
    this.setData({archive:this.detail?Object.assign({},this.detail,{data:model.clone(this.metadata)}):null,base:{title:this.metadata.title,projectName:this.metadata.projectName,roadName:this.metadata.roadName},segments:this.metadata.segments.map((s,i)=>({id:s.id,name:model.segmentLabel(s,i)})),current,selectedSegment:selected,stageViews:stages,exports:(this.detail && this.detail.exports || []).map(e=>Object.assign({},e,{createdText:e.createdAt.slice(0,19).replace('T',' '),shortId:e.id.slice(0,8)})),photoCount:photos.length,photoBytesText:(photoBytes/1048576).toFixed(1),pendingPhotos:this.queue || [],pendingCount:(this.queue || []).length,hasPendingExport:!!this.pendingExport});
  },
  input(e){
    if(!this.writable())return;const {scope,key,index,stageId}=e.currentTarget.dataset,value=e.detail.value;
    if(scope==='base' && ['title','projectName','roadName'].includes(key))this.metadata[key]=value;
    else if(scope==='segment' && ['start','end','content'].includes(key))this.metadata.segments[this.data.selectedSegment][key]=value;
    else if(scope==='stage' && key==='name' && this.metadata.segments[this.data.selectedSegment].stages[Number(index)])this.metadata.segments[this.data.selectedSegment].stages[Number(index)].name=value;
    else if(scope==='caption'){this._captions=this._captions || {};this._captions[stageId]=value;}
    this.updateView();this.scheduleSave();
  },
  changeDate(e){if(!this.writable())return;const s=this.metadata.segments[this.data.selectedSegment];if(e.currentTarget.dataset.scope==='stage'){const stage=s.stages[Number(e.currentTarget.dataset.index)];if(stage)stage.completedAt=e.detail.value;}else s.completedAt=e.detail.value;this.updateView();this.scheduleSave();},
  clearDate(e){if(!this.writable())return;const s=this.metadata.segments[this.data.selectedSegment];if(e.currentTarget.dataset.scope==='stage'){const stage=s.stages[Number(e.currentTarget.dataset.index)];if(stage)stage.completedAt='';}else s.completedAt='';this.updateView();this.scheduleSave();},
  selectSegment(e){if(this.data.busy || this.data.uploading)return;this.saveDraft();this.setData({selectedSegment:Number(e.detail.value),uploadNotice:''});this.updateView();return this.loadCurrentPhotos();},
  addSegment(){if(!this.writable() || this.metadata.segments.length>=32)return;this.metadata.segments.push(model.emptySegment(this.template));this.setData({selectedSegment:this.metadata.segments.length-1,uploadNotice:''});this.updateView();this.saveDraft();},
  async removeSegment(){if(!this.writable() || this.metadata.segments.length<=1)return;const s=this.metadata.segments[this.data.selectedSegment];if((this.detail && this.detail.photos || []).some(p=>p.segmentId===s.id) || this.queue.some(p=>p.segmentId===s.id)){this.fail(new Error('此路段还有原图或待上传照片，请先逐张移除'));return;}if(await confirm('删除当前路段','此路段的桩号、日期和工序填写将移除，已生成的 Word 保留。') && this.writable()){this.metadata.segments.splice(this.data.selectedSegment,1);this.setData({selectedSegment:0});this.updateView();this.saveDraft();}},
  addStage(){if(!this.writable())return;const stages=this.metadata.segments[this.data.selectedSegment].stages;if(stages.length>=16)return;stages.push({id:model.uuid(),name:'新增工序',completedAt:''});this.updateView();this.saveDraft();},
  async removeStage(e){if(!this.writable())return;const stages=this.metadata.segments[this.data.selectedSegment].stages,index=Number(e.currentTarget.dataset.index),stage=stages[index];if(!stage || stages.length<=1)return;if((this.detail && this.detail.photos || []).some(p=>p.stageId===stage.id) || this.queue.some(p=>p.stageId===stage.id)){this.fail(new Error('此工序还有原图或待上传照片，请先逐张移除'));return;}if(await confirm('删除工序',stage.name+' 的填写将移除，已生成的 Word 保留。') && this.writable()){stages.splice(index,1);this.updateView();this.saveDraft();}},
  async _save(){
    if(!this.canWrite())throw new Error('当前账号为只读，不能保存');
    if(this.data.conflict)throw Object.assign(new Error('服务器内容已更新，请重新加载；本机草稿仍保留'),{status:409});
    if(this.pendingExport)throw new Error('上一份 Word 的生成结果尚未确认，请先重试生成或重新加载历史版本');
    const message=model.validationMessage(this.metadata);if(message)throw new Error(message);
    const value=model.clone(this.metadata);if(!this.saveDraft())throw new Error('无法保存本机重试记录，请检查手机空间后重试');let row;
    if(!this.detail){
      if(!this.creationData){this.creationData=model.clone(value);if(!this.saveDraft())throw new Error('无法保存重试记录，请检查手机空间后重试');}
      row=await api.request('/photo-archives','POST',{creationId:this.creationId,data:this.creationData});
      if(!this.contextActive())return null;
      const oldKey=model.draftKey(this.backend,this.user.id,'new');this.detail=row;this.draftId=row.id;this.creationId=null;this.creationData=null;if(this.saveDraft())model.removeDraft(oldKey);
    }else row=this.detail;
    if(JSON.stringify(row.data)!==JSON.stringify(value))row=await api.request('/photo-archives/'+row.id,'PUT',{version:row.version,data:value});
    if(!this.contextActive())return null;
    this.detail=row;this.metadata=model.clone(row.data);this.reconcileQueue(row.photos);this.setData({conflict:false});this.updateView();this.saveDraft();return row;
  },
  async saveArchive(){if(!this.writable())return;this.setData({busy:true,error:'',notice:''});try{const row=await this._save();if(row)this.setData({notice:'填写内容已保存到服务器，原图和历史 Word 同步保留'});}catch(e){this.fail(e);}finally{if(this.active)this.setData({busy:false});}},
  async reloadArchive(){
    if(!this.detail || this.data.busy || this.data.uploading)return;
    if(this.user.role!=='viewer' && !await confirm('重新加载服务器内容','本机填写草稿将替换为服务器最新内容。待上传原图和已有 Word 保留；若新增工序不在服务器中，原图仍可逐项移除。'))return;
    const id=this.detail.id;this.setData({busy:true,error:''});const generation=this._generation;
    try{const row=await api.request('/photo-archives/'+id);if(!this.contextActive() || generation!==this._generation)return;this.detail=row;this.metadata=model.clone(row.data);this.reconcileQueue(row.photos);this.pendingExport=null;this.setData({conflict:false,selectedSegment:0,notice:'已载入服务器最新填写内容，原图队列和历史 Word 保留'});this.updateView();this.saveDraft();await this.loadCurrentPhotos();}catch(e){this.fail(e);}finally{if(this.active)this.setData({busy:false});}
  },
  async chooseOriginals(count){
    return new Promise((resolve,reject)=>{
      if(wx.chooseMedia)wx.chooseMedia({count,mediaType:['image'],sizeType:['original'],sourceType:['album','camera'],success:r=>resolve(r.tempFiles.map(f=>({path:f.tempFilePath,size:f.size}))),fail:e=>cancelled(e)?resolve(null):reject(new Error('照片选择未完成，请检查相机或相册权限'))});
      else wx.chooseImage({count,sizeType:['original'],sourceType:['album','camera'],success:r=>resolve((r.tempFiles || r.tempFilePaths.map(path=>({path}))).map(f=>({path:f.path,size:f.size}))),fail:e=>cancelled(e)?resolve(null):reject(new Error('照片选择未完成，请检查相机或相册权限'))});
    });
  },
  async addPhotos(e){
    if(!this.writable())return;if(this.pendingExport){this.fail(new Error('请先重试生成，确认上一份 Word 的结果后再上传新原图'));return;}const segment=this.metadata.segments[this.data.selectedSegment],stage=segment.stages.find(s=>s.id===e.currentTarget.dataset.stageId);if(!stage)return;
    const all=this.detail && this.detail.photos || [],currentCount=all.filter(p=>p.stageId===stage.id).length+this.queue.filter(p=>p.stageId===stage.id).length;
    if(currentCount>=6 || all.length+this.queue.length>=120)return;
    let chosen;try{chosen=await this.chooseOriginals(Math.min(6-currentCount,120-all.length-this.queue.length));}catch(error){this.fail(error);return;}
    if(!chosen || !this.writable())return;
    this.setData({uploading:true,error:'',uploadNotice:'正在保存所选原图到本机…'});let added=0;
    try{
      let total=all.reduce((n,p)=>n+p.bytes,0)+this.queue.reduce((n,p)=>n+p.bytes,0);
      for(const file of chosen){
        if(!this.contextActive())return;
        const info=await new Promise((resolve,reject)=>wx.getImageInfo({src:file.path,success:resolve,fail:()=>reject(new Error('无法读取原图，请重新选择 PNG/JPEG 照片'))}));
        const mime=info.type==='png'?'image/png':['jpeg','jpg'].includes(info.type)?'image/jpeg':'';
        if(!mime || !info.width || !info.height || info.width>16000 || info.height>16000)throw new Error('请选择 PNG/JPEG 原图，边长不超过16000像素');
        const bytes=await new Promise((resolve,reject)=>wx.getFileSystemManager().readFile({filePath:file.path,success:r=>resolve(r.data.byteLength),fail:()=>reject(new Error('读取原图失败'))}));
        if(bytes>5242880)throw new Error('单张原图不能超过5MB');if(!bytes || total+bytes>25165824)throw new Error('每册原图合计不能超过24MB，请另建资料册');
        const photo={id:model.uuid(),segmentId:segment.id,stageId:stage.id,name:file.path.split('/').pop().slice(0,180) || '现场原图',caption:this._captions && this._captions[stage.id] || '',mime,width:info.width,height:info.height,bytes};
        const copy=await this.draftStorage.copy(photo,file.path);if(!this.contextActive()){this.draftStorage.remove(copy.filePath);return;}
        this.queue.push(copy);this.updateView();if(!this.saveDraft()){this.queue.pop();this.draftStorage.remove(copy.filePath);this.updateView();throw new Error('原图草稿记录保存失败，请检查手机可用空间');}total+=bytes;added++;
      }
      await this.uploadQueued();
    }catch(error){this.fail(error);this.setData({uploadNotice:added+' 张原图已保存在本机。'+(this.queue.length?'待上传照片可点击重试上传；':'')+'未上传部分请核对后重新选择。'});}finally{if(this.active)this.setData({uploading:false});}
  },
  reconcileQueue(photos){
    if(!this.draftStorage)return;const ids=new Set((photos || []).map(p=>p.id));this.queue=(this.queue || []).filter(p=>{if(ids.has(p.id)){this.draftStorage.remove(p.filePath);return false;}return true;});
  },
  async uploadQueued(){
    if(!this.canWrite() || !this.queue.length)return;
    const row=await this._save();if(!row)return;const generation=this._generation,list=this.queue.slice();let completed=0,replayed=0;
    for(const photo of list){
      if(!this.contextActive() || generation!==this._generation)return;
      this.setData({uploadNotice:'正在上传原图 '+(completed+1)+' / '+list.length+'；已确认 '+completed+' 张'});
      try{
        const base64=await this.draftStorage.readBase64(photo);const body={id:photo.id,segmentId:photo.segmentId,stageId:photo.stageId,name:photo.name,caption:photo.caption,mime:photo.mime,width:photo.width,height:photo.height,base64};
        const receipt=await api.request('/photo-archives/'+row.id+'/photos','POST',body);if(!this.contextActive() || generation!==this._generation)return;
        if(!this.detail.photos.some(p=>p.id===receipt.photo.id))this.detail.photos.push(receipt.photo);
        const remaining=this.queue.filter(p=>p.id!==photo.id),prior=this.queue;this.queue=remaining;
        if(!this.saveDraft()){this.queue=prior;throw new Error('服务器已保存此图，本机重试记录尚未写入；请重试，系统会避免重复图');}
        this.draftStorage.remove(photo.filePath);completed++;if(receipt.replayed)replayed++;this.updateView();
      }catch(error){const pending=this.queue.find(p=>p.id===photo.id);if(pending)pending.lastError=error.message;this.saveDraft();this.updateView();this.setData({uploadNotice:'已确认 '+completed+' / '+list.length+' 张，剩余原图保存在本机，可重试上传'});this.fail(error);return;}
    }
    this.setData({uploadNotice:'已确认 '+completed+' 张原图保存到服务器'+(replayed?'（含 '+replayed+' 张重复识别，未重复保存）':'')});await this.loadCurrentPhotos();
  },
  async retryUploads(){if(!this.writable() || !this.queue.length)return;this.setData({uploading:true,error:''});try{await this.uploadQueued();}catch(e){this.fail(e);}finally{if(this.active)this.setData({uploading:false});}},
  async removePending(e){
    if(!this.writable())return;const photo=this.queue.find(p=>p.id===e.currentTarget.dataset.id);if(!photo)return;
    if(await confirm('移除待上传原图','将移除此项的本机原图草稿。若网络响应曾丢失，服务器可能已有原图；请刷新后核对，已生成的 Word 保留。') && this.writable()){const old=this.queue;this.queue=this.queue.filter(p=>p.id!==photo.id);if(this.saveDraft()){this.draftStorage.remove(photo.filePath);this.updateView();}else this.queue=old;}
  },
  clearPhotos(){const fs=wx.getFileSystemManager();(this._photoPaths || []).forEach(filePath=>fs.unlink({filePath,fail(){}}));this._photoPaths=[];this._imageCache={};this._pendingLoads={};},
  async loadPhoto(photo,generation=this._generation){
    if(!this.detail || !this.contextActive() || this._pendingLoads[photo.id] || this._imageCache[photo.id] && this._imageCache[photo.id].path)return;
    const archiveId=this.detail.id;this._pendingLoads[photo.id]=true;this._imageCache[photo.id]={path:'',failed:false,loading:true};this.updateView();let path;
    try{
      const bytes=await api.request('/photo-archives/'+archiveId+'/photos/'+photo.id,'GET',undefined,true);if(!this.contextActive() || generation!==this._generation || !this.detail || archiveId!==this.detail.id)return;
      path=wx.env.USER_DATA_PATH+'/photo-archive-view_'+this._pageId+'_'+photo.id+(photo.mime==='image/png'?'.png':'.jpg');
      await new Promise((resolve,reject)=>wx.getFileSystemManager().writeFile({filePath:path,data:bytes,success:resolve,fail:()=>reject(new Error('原图缓存失败，请检查手机空间'))}));
      if(!this.contextActive() || generation!==this._generation){wx.getFileSystemManager().unlink({filePath:path,fail(){}});return;}
      this._photoPaths.push(path);this._imageCache[photo.id]={path,failed:false,loading:false};this.updateView();
    }catch(e){if(this.contextActive() && generation===this._generation){this._imageCache[photo.id]={path:'',failed:true,loading:false};this.updateView();if(e.status===401)this.fail(e);}}finally{if(generation===this._generation)delete this._pendingLoads[photo.id];}
  },
  async loadCurrentPhotos(){if(!this.metadata || !this.detail)return;const segment=this.metadata.segments[this.data.selectedSegment],generation=this._generation;for(const photo of this.detail.photos.filter(p=>p.segmentId===segment.id)){if(!this.contextActive() || generation!==this._generation)return;await this.loadPhoto(photo,generation);}},
  retryPhoto(e){const photo=this.detail && this.detail.photos.find(p=>p.id===e.currentTarget.dataset.id);if(photo)return this.loadPhoto(photo);},
  previewPhoto(e){const id=e.currentTarget.dataset.id,cache=this._imageCache[id],pending=this.queue.find(p=>p.id===id),path=cache && cache.path || pending && pending.filePath,generation=this._generation;if(!path || !this.contextActive())return;wx.previewImage({current:path,urls:[path],fail:()=>{if(this.contextActive() && generation===this._generation)this.fail(new Error('原图预览未完成，请返回工序原图后重试'));}});},
  async removePhoto(e){if(!this.writable() || !this.detail)return;if(this.pendingExport){this.fail(new Error('请先重试生成，确认上一份 Word 的结果后再移除原图'));return;}const id=e.currentTarget.dataset.id,photo=this.detail.photos.find(p=>p.id===id);if(!photo)return;if(!await confirm('移除当前原图','将从资料册移除此图。已经生成的 Word 及其中原图仍保留。') || !this.writable())return;this.setData({busy:true,error:''});try{await api.request('/photo-archives/'+this.detail.id+'/photos/'+id,'DELETE',{});if(!this.contextActive())return;this.detail.photos=this.detail.photos.filter(p=>p.id!==id);const cache=this._imageCache[id];if(cache && cache.path){wx.getFileSystemManager().unlink({filePath:cache.path,fail(){}});this._photoPaths=this._photoPaths.filter(p=>p!==cache.path);}delete this._imageCache[id];this.updateView();this.saveDraft();this.setData({notice:'当前原图已移除，历史 Word 保留'});}catch(error){this.fail(error);}finally{if(this.active)this.setData({busy:false});}},
  async generate(){
    if(!this.writable())return;if(this.queue.length){this.fail(new Error('还有待上传原图，请先重试上传或明确移除后生成'));return;}
    this.setData({busy:true,error:'',notice:'',savedFile:'',savedFileName:''});let confirmed=false;
    try{
      const row=this.pendingExport?this.detail:await this._save();if(!row)return;if(!row.photos.length)throw new Error('请至少上传一张工序原图后生成');
      const snapshot=digest(JSON.stringify({version:row.version,photos:row.photos.map(p=>({id:p.id,sha256:p.sha256}))}));
      if(!this.pendingExport){this.pendingExport={id:model.uuid(),snapshot,version:row.version};if(!this.saveDraft())throw new Error('生成重试记录保存失败，请检查手机空间后重试');this.updateView();}
      if(!this.saveDraft())throw new Error('生成重试记录尚未保存，请检查手机空间后重试');
      const receipt=await api.request('/photo-archives/'+row.id+'/exports','POST',{exportId:this.pendingExport.id,version:this.pendingExport.version});if(!this.contextActive())return;
      confirmed=true;if(!this.detail.exports.some(e=>e.id===receipt.id))this.detail.exports.unshift({id:receipt.id,version:row.version,createdAt:receipt.createdAt,photoCount:receipt.photoCount});this.pendingExport=null;this.updateView();this.saveDraft();this.setData({notice:'Word 版本已保存在服务器，正在下载…'});await this.fetchWord(receipt.id);
    }catch(error){if(confirmed)this.setData({notice:'Word 版本已保存在服务器，可在历史版本中重新下载'});else if(this.pendingExport)this.setData({notice:'生成结果尚未确认；重试会使用同一个编号，避免重复版本'});this.updateView();this.fail(error);}finally{if(this.active)this.setData({busy:false});}
  },
  async fetchWord(exportId){
    const id=this.detail && this.detail.id,generation=this._generation;if(!id || !model.UUID.test(exportId))throw new Error('Word 版本不存在');
    const bytes=await api.request('/photo-archives/'+id+'/exports/'+exportId+'/word','GET',undefined,true);if(!this.contextActive() || generation!==this._generation)return;
    const name=model.wordFileName(this.metadata.roadName,exportId),path=await api.saveDocument(bytes,name);if(!this.contextActive() || generation!==this._generation)return;
    this.setData({savedFile:path,savedFileName:name,notice:'Word 已保存到手机文件空间；服务器历史版本保留，可查看或转发'});this.openWord();
  },
  async downloadWord(e){if(this.data.busy || this.data.uploading || !this.detail)return;this.setData({busy:true,error:'',notice:'',savedFile:'',savedFileName:''});try{await this.fetchWord(e.currentTarget.dataset.id);}catch(error){this.setData({notice:'服务器 Word 版本保留，下载失败可再次重试'});this.fail(error);}finally{if(this.active)this.setData({busy:false});}},
  openWord(){if(!this.data.savedFile || !this.contextActive())return;const generation=this._generation;wx.openDocument({filePath:this.data.savedFile,fileType:'docx',showMenu:true,fail:()=>{if(this.contextActive() && generation===this._generation){this.setData({notice:'Word 已保存，预览未完成；可点击“转发文件”或稍后重新查看'});this.revealFeedback();}}});},
  shareWord(){if(!this.data.savedFile || !this.contextActive())return;const generation=this._generation;if(wx.canIUse('shareFileMessage'))wx.shareFileMessage({filePath:this.data.savedFile,fileName:this.data.savedFileName,fail:e=>{if(this.contextActive() && generation===this._generation && !cancelled(e)){this.setData({notice:'转发未完成，Word 和服务器历史版本保留，可点击“转发文件”重试'});this.revealFeedback();}}});else{this.setData({notice:'当前微信版本不支持直接转发，可点击“查看 Word”，在文档预览菜单中操作'});this.revealFeedback();}},
  async backToList(){if(this.data.busy || this.data.uploading)return;this.saveDraft();this._generation++;this.clearPhotos();this.detail=null;this.metadata=null;this.queue=[];this.draftId=null;this.setData({mode:'list',archive:null,error:'',notice:'',uploadNotice:'',savedFile:'',savedFileName:'',conflict:false});wx.pageScrollTo({scrollTop:0,duration:0});await this.loadList();},
  backToReport(){if(this.data.busy || this.data.uploading)return;this.saveDraft();wx.navigateBack({delta:1,fail:()=>wx.redirectTo({url:'/pages/report/index'})});}
});
