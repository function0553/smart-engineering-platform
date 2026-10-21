const api=require('../../utils/api');
Page({
  data:{user:null,loading:true,opening:false,saving:false,items:[],total:0,offset:0,pageNumber:1,hasNext:false,date:'',q:'',error:'',notice:'',detail:null,photos:[],savedFile:''},
  async onLoad(options) {
    this.active=true;this.version=0;this.photoPaths=[];this.filters={date:'',q:''};
    if(!api.session()){wx.redirectTo({url:'/pages/login/index'});return;}
    try{const user=await api.request('/me');if(!this.active)return;this.setData({user});await this.load();if(options.id)await this.openId(options.id);}catch(e){this.fail(e);this.setData({loading:false});}
  },
  onUnload(){this.active=false;this.version++;this.clearPhotos();},
  clearPhotos(){const fs=wx.getFileSystemManager();(this.photoPaths || []).forEach(filePath=>fs.unlink({filePath,fail(){}}));this.photoPaths=[];},
  fail(e){if(!this.active)return;this.setData({error:e.message || '操作未完成，请重试'});if(e.status===401)wx.redirectTo({url:'/pages/login/index'});},
  async load() {
    if(!this.active)return;
    this.setData({loading:true,error:''});
    const {date,q}=this.filters,query='?limit=20&offset='+this.data.offset+(date?'&date='+encodeURIComponent(date):'')+(q?'&q='+encodeURIComponent(q):'');
    try{const result=await api.request('/daily-report/submissions'+query);if(this.active)this.setData({items:result.items,total:result.total,pageNumber:Math.floor(this.data.offset/20)+1,hasNext:this.data.offset+20<result.total});}catch(e){this.fail(e);}finally{if(this.active)this.setData({loading:false});}
  },
  refresh(){if(!this.data.loading)this.load();},
  dateChange(e){this.setData({date:e.detail.value});},
  searchInput(e){this.setData({q:e.detail.value});},
  search(){if(this.data.loading)return;this.filters={date:this.data.date,q:this.data.q.trim()};this.setData({offset:0});this.load();},
  clearFilter(){if(this.data.loading)return;this.filters={date:'',q:''};this.setData({date:'',q:'',offset:0});this.load();},
  previous(){if(this.data.loading || !this.data.offset)return;this.setData({offset:Math.max(0,this.data.offset-20)});this.load();},
  next(){if(this.data.loading || !this.data.hasNext)return;this.setData({offset:this.data.offset+20});this.load();},
  open(e){this.openId(e.currentTarget.dataset.id);},
  async openId(id){
    if(this.data.opening || !/^[a-f0-9-]{36}$/i.test(id))return;
    const version=++this.version;this.clearPhotos();this.setData({opening:true,error:'',notice:'',photos:[],savedFile:''});
    try{
      const detail=await api.request('/daily-report/submissions/'+id);if(!this.active || version!==this.version)return;
      const sections=detail.data.sections.map(section=>Object.assign({},section,{workText:section.works.filter(work=>work.quantity!=='').map(work=>work.name+'：'+work.quantity+work.unit).join('；') || '未填写'}));
      this.setData({detail:Object.assign({},detail,{data:Object.assign({},detail.data,{sections})}),photos:detail.photos.map(photo=>Object.assign({},photo,{path:'',failed:false}))});
      wx.pageScrollTo({scrollTop:0,duration:0});
      await Promise.all(detail.photos.map(async photo=>{
        let filePath;
        try{
          const bytes=await api.request('/daily-report/submissions/'+id+'/photos/'+photo.index,'GET',undefined,true);
          if(!this.active || version!==this.version)return;
          filePath=wx.env.USER_DATA_PATH+'/daily-report-history_'+id+'_'+photo.index+(photo.mime==='image/png'?'.png':'.jpg');
          await new Promise((resolve,reject)=>wx.getFileSystemManager().writeFile({filePath,data:bytes,success:resolve,fail:()=>reject(new Error('照片保存失败'))}));
          if(!this.active || version!==this.version){wx.getFileSystemManager().unlink({filePath,fail(){}});return;}
          this.photoPaths.push(filePath);this.setData({['photos['+photo.index+'].path']:filePath});
        }catch(e){if(this.active && version===this.version){this.setData({['photos['+photo.index+'].failed']:true});if(e.status===401)this.fail(e);}}
      }));
    }catch(e){this.fail(e);}finally{if(this.active && version===this.version)this.setData({opening:false});}
  },
  back(){this.version++;this.clearPhotos();this.setData({detail:null,photos:[],opening:false,error:'',notice:'',savedFile:''});wx.pageScrollTo({scrollTop:0,duration:0});},
  preview(e){const path=e.currentTarget.dataset.path;if(path)wx.previewImage({current:path,urls:this.data.photos.map(photo=>photo.path).filter(Boolean)});},
  async word(e){
    if(this.data.saving)return;
    const id=e.currentTarget.dataset.id, item=this.data.detail || this.data.items.find(record=>record.id===id);if(!item)return;
    this.setData({saving:true,error:'',notice:''});
    try{const bytes=await api.request('/daily-report/submissions/'+item.id+'/word','GET',undefined,true),path=await api.saveWord(bytes,item.reportDate,item.id);if(!this.active)return;this.setData({savedFile:path,notice:'Word 已保存；服务器原记录保留。'});wx.openDocument({filePath:path,fileType:'docx',showMenu:true});}catch(e){this.fail(e);}finally{if(this.active)this.setData({saving:false});}
  },
  async originalData(){
    if(this.data.saving || !this.data.detail)return;const item=this.data.detail;this.setData({saving:true,error:'',notice:''});
    try{const bytes=await api.request('/daily-report/submissions/'+item.id+'/data','GET',undefined,true),filePath=wx.env.USER_DATA_PATH+'/日报填写数据_'+item.reportDate+'_'+item.id.slice(0,8)+'.json';await new Promise((resolve,reject)=>wx.getFileSystemManager().writeFile({filePath,data:bytes,success:resolve,fail:()=>reject(new Error('填写数据保存失败，请检查手机空间'))}));if(!this.active)return;this.setData({notice:'原图与填写数据已保存；服务器原记录保留。'});if(wx.canIUse('shareFileMessage'))wx.shareFileMessage({filePath});}catch(e){this.fail(e);}finally{if(this.active)this.setData({saving:false});}
  },
  share(){if(this.data.savedFile && wx.canIUse('shareFileMessage'))wx.shareFileMessage({filePath:this.data.savedFile});else this.setData({notice:'请在 Word 文档预览菜单中转发文件。'});}
});
