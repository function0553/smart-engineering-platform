const model=require('./photo-archives'),{digest}=require('./submission');
function filesystem(){return wx.getFileSystemManager();}
function createStorage(baseUrl,userId,archiveId){
  const scope=digest(String(baseUrl)+'\n'+String(userId)+'\n'+String(archiveId)).slice(0,32);
  const prefix=wx.env.USER_DATA_PATH+'/photo-archive-draft_'+scope+'_';
  const owns=filePath=>typeof filePath==='string' && filePath.startsWith(prefix) && /^[a-f0-9-]{36}\.(png|jpg)$/i.test(filePath.slice(prefix.length));
  const remove=filePath=>{if(owns(filePath))filesystem().unlink({filePath,fail(){}});};
  async function copy(photo,tempPath){
    const filePath=prefix+photo.id+(photo.mime==='image/png'?'.png':'.jpg');
    await new Promise((resolve,reject)=>filesystem().copyFile({srcPath:tempPath,destPath:filePath,success:resolve,fail:()=>{remove(filePath);reject(new Error('原图草稿保存失败，请检查手机可用空间'));}}));
    return Object.assign({},photo,{filePath});
  }
  function validQueue(queue){return (Array.isArray(queue)?queue:[]).filter(p=>p && model.UUID.test(p.id) && model.UUID.test(p.segmentId) && model.UUID.test(p.stageId) && owns(p.filePath) && ['image/png','image/jpeg'].includes(p.mime) && Number.isInteger(p.bytes) && p.bytes>0 && p.bytes<=5242880);}
  function readBase64(photo){
    if(!owns(photo.filePath))return Promise.reject(new Error('原图草稿来源不符，请重新选择照片'));
    return new Promise((resolve,reject)=>filesystem().readFile({filePath:photo.filePath,encoding:'base64',success:r=>resolve(r.data),fail:()=>reject(new Error('原图草稿无法读取，请移除此项后重新选择原图'))}));
  }
  return {copy,remove,owns,validQueue,readBase64};
}
module.exports={createStorage};
