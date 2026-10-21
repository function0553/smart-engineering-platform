// Original image files stay in this mini-program's private, account-scoped draft.
const model=require('./report');
const validFile=/^daily-report-photo-[0-9]+-[a-z0-9]+\.(png|jpg)$/;
function createDraftStorage(key) {
  const fs=wx.getFileSystemManager(),root=wx.env.USER_DATA_PATH;
  let cached=[];
  const path=file=>{if(!validFile.test(file))throw new Error('照片草稿路径无效');return root+'/'+file;};
  function discard(file) {try{fs.unlinkSync(path(file));}catch(_){} }
  function load() {
    const stored=wx.getStorageSync(key);if(!stored)return null;
    if(!model.checkReport(stored))throw new Error('本机草稿格式无效');
    const report=model.textDraft(stored),reference=stored._photoDraft;delete report._photoDraft;
    if(!reference)return {report,paths:[]};
    if(reference.schemaVersion!==1 || reference.scope!==key || !Array.isArray(reference.photos) || reference.photos.length>12)throw new Error('照片草稿与当前账号不匹配');
    const photos=reference.photos.map(({file,...photo})=>({...photo,base64:fs.readFileSync(path(file),'base64')}));
    report.photos=photos;if(!model.checkReport(report))throw new Error('本机照片草稿不完整');
    cached=reference.photos.map((photo,i)=>({file:photo.file,mime:photo.mime,base64:photos[i].base64}));
    return {report,paths:reference.photos.map(p=>path(p.file))};
  }
  function save(report) {
    if(!model.checkReport(report))throw new Error('草稿格式无效');
    const created=[];let committed=false;
    try {
      const next=report.photos.map(photo=>{
        const old=cached.find(p=>p.mime===photo.mime && p.base64===photo.base64);
        let file=old && old.file;
        if(!file) {file='daily-report-photo-'+Date.now()+'-'+Math.random().toString(36).slice(2,12)+'.'+(photo.mime==='image/png'?'png':'jpg');created.push(file);fs.writeFileSync(path(file),photo.base64,'base64');}
        const {base64,...metadata}=photo;return {file,base64,...metadata};
      });
      const reference={schemaVersion:1,scope:key,photos:next.map(({base64,...metadata})=>metadata)};
      wx.setStorageSync(key,{...model.textDraft(report),_photoDraft:reference});committed=true;
      const used=new Set(next.map(p=>p.file));cached.forEach(p=>{if(!used.has(p.file))discard(p.file);});cached=next;
      return next.map(p=>path(p.file));
    } finally {if(!committed)created.forEach(discard);}
  }
  return {load,save};
}
module.exports={createDraftStorage};
