const config = require('../config');
const baseKey = 'daily-report:server', sessionKey = 'daily-report:session';
function baseUrl() { return wx.getStorageSync(baseKey) || config.defaultBaseUrl; }
function setBaseUrl(value) {
  const v = String(value).trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[a-zA-Z0-9.\-\[\]:]+$/.test(v)) throw new Error('请输入后台访问地址，不含路径');
  const info = wx.getAccountInfoSync ? wx.getAccountInfoSync() : null;
  if (info && info.miniProgram.envVersion === 'release' && !v.startsWith('https://')) throw new Error('正式版本需要 HTTPS 后台');
  if (v !== baseUrl()) { wx.removeStorageSync(sessionKey); wx.setStorageSync(baseKey,v); }
  return v;
}
function session() { const s=wx.getStorageSync(sessionKey); return s && s.baseUrl===baseUrl() && s.expiresAt>Date.now() ? s : null; }
function setSession(value) { wx.setStorageSync(sessionKey, Object.assign({}, value, {baseUrl:baseUrl()})); }
function clearSession() { wx.removeStorageSync(sessionKey); }
function decodeJson(buffer) {
  const bytes=new Uint8Array(buffer); let escaped=''; for (let i=0;i<bytes.length;i++) escaped+='%'+bytes[i].toString(16).padStart(2,'0');
  try { return JSON.parse(decodeURIComponent(escaped)); } catch (_) { return {error:'服务返回内容异常'}; }
}
function request(path, method='GET', data, binary=false) {
  const s=session();
  return new Promise((resolve,reject) => wx.request({url:baseUrl()+'/api/mobile'+path,method,data,timeout:60000,responseType:binary?'arraybuffer':'text',header:{'Content-Type':'application/json','X-Workspace-Request':'1', ...(s?{Authorization:'Bearer '+s.token}:{})},success(res) {
    if (res.statusCode>=200 && res.statusCode<300) { resolve(res.data); return; }
    const body=binary?decodeJson(res.data):res.data;
    if (res.statusCode===401) clearSession();
    const error=new Error(body.error || '请求未完成'); error.status=res.statusCode; error.fields=body.fields; reject(error);
  },fail() { reject(new Error('连接失败，填写内容已保留，请检查后台地址和网络后重试')); }}));
}
function saveDocument(buffer,fileName) {
  const safe=String(fileName).replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').slice(0,170);
  if(!safe || safe==='.' || safe==='..')return Promise.reject(new Error('文件名称无效'));
  const path=wx.env.USER_DATA_PATH+'/'+safe;
  return new Promise((resolve,reject) => wx.getFileSystemManager().writeFile({filePath:path,data:buffer,success:()=>resolve(path),fail:()=>reject(new Error('Word 保存失败，请检查手机可用空间'))}));
}
function saveWord(buffer,date,id='') {
  const suffix=id?'_'+id.replace(/[^a-f0-9]/gi,'').slice(0,8):'';
  return saveDocument(buffer,'施工日报_'+date+suffix+'.docx');
}
module.exports={baseUrl,setBaseUrl,session,setSession,clearSession,request,saveWord,saveDocument,decodeJson};
