type NativeBridge = { request:(id:string,config:string)=>void; saveFile:(id:string,name:string,mime:string,base64:string)=>void; downloadSiteFile?:(id:string,config:string)=>void; cancelSiteFile?:(id:string)=>void; checkUpdate?:(id:string,baseUrl:string)=>void; installUpdate?:(id:string,baseUrl:string)=>void };
declare global { interface Window { AndroidDailyReport?:NativeBridge; __dailyResult?:(id:string,payload:string)=>void } }
type Session = { token:string; expiresAt:number; baseUrl:string };
const nativeFetch=window.fetch.bind(window), pending=new Map<string,{resolve:(value:any)=>void;reject:(reason:Error)=>void;timer:ReturnType<typeof setTimeout>|null}>();
export const backend = () => localStorage.getItem('daily:backend') || 'https://211.139.12.141:21901';
export function configureBackend(value:string) {
  const url=new URL(value.trim());
  if(!['https:','http:'].includes(url.protocol) || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw new Error('请输入后台访问地址，不含路径和账号信息');
  if(url.origin!==backend()) { localStorage.removeItem('daily:session');localStorage.setItem('daily:backend',url.origin); }
  return url.origin;
}
export function session():Session|null { try {const s=JSON.parse(localStorage.getItem('daily:session')||'null');return s?.baseUrl===backend() && s.expiresAt>Date.now()?s:null;}catch{return null;} }
export const saveSession=(s:Omit<Session,'baseUrl'>)=>localStorage.setItem('daily:session',JSON.stringify({...s,baseUrl:backend()}));
export const clearSession=()=>localStorage.removeItem('daily:session');
const expired = (requestBase:string,requestSession:string|null) => { if(backend()!==requestBase||localStorage.getItem('daily:session')!==requestSession)return;clearSession();window.dispatchEvent(new Event('daily-session-expired')); };
const packageRoute=/^\/api\/mobile\/engineering\/(?:projects\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/)?site-library\/packages$/;
window.__dailyResult=(id,payload)=>{const item=pending.get(id);if(!item)return;clearTimeout(item.timer??undefined);pending.delete(id);try{const result=JSON.parse(payload);if(result.cancelled)item.reject(Object.assign(new Error('已取消保存，填写内容仍保留'),{cancelled:true}));else if(result.error)item.reject(new Error(result.error));else item.resolve(result);}catch{item.reject(new Error('手机返回内容异常'));}};
function invoke(run:(id:string)=>void,timeoutMs:number|null=120000,signal?:AbortSignal,cancel?:(id:string)=>void) {return new Promise<any>((resolve,reject)=>{if(signal?.aborted){reject(new DOMException('已取消','AbortError'));return;}const id=crypto.randomUUID(),cleanup=()=>signal?.removeEventListener('abort',aborted);const aborted=()=>{clearTimeout(timer??undefined);pending.delete(id);cleanup();cancel?.(id);reject(new DOMException('已取消','AbortError'));};const timer=timeoutMs===null?null:setTimeout(()=>{pending.delete(id);cleanup();cancel?.(id);reject(new Error('操作超时，请重试'));},timeoutMs);pending.set(id,{resolve:value=>{cleanup();resolve(value);},reject:error=>{cleanup();reject(error);},timer});signal?.addEventListener('abort',aborted,{once:true});try{run(id);}catch(e){clearTimeout(timer??undefined);pending.delete(id);cleanup();reject(e);}});}
export function installMobileTransport() {
  window.fetch=async (input,init={})=>{
    const path=typeof input==='string'?input:input instanceof URL?input.pathname:input.url;
    if(!path.startsWith('/api/'))return nativeFetch(input,init);
    const mobile=path.startsWith('/api/mobile/')?path:'/api/mobile/'+path.slice(5), requestBase=backend(),requestSession=localStorage.getItem('daily:session'),s=session();
    const headers=new Headers(init.headers);headers.set('X-Workspace-Request','1');if(s)headers.set('Authorization','Bearer '+s.token);
    if(init.signal?.aborted)throw new DOMException('Aborted','AbortError');
    if(!window.AndroidDailyReport) {const response=await nativeFetch(requestBase+mobile,{...init,headers,credentials:requestBase===window.location.origin?'same-origin':'omit',redirect:'error'});if(response.status===401)expired(requestBase,requestSession);return response;}
    const config={baseUrl:requestBase,path:mobile,method:init.method||'GET',body:init.body||'',token:s?.token||''};
    const result=await invoke(id=>window.AndroidDailyReport!.request(id,JSON.stringify(config)),config.method==='POST'&&packageRoute.test(mobile)?140000:120000);
    if(init.signal?.aborted)throw new DOMException('Aborted','AbortError');
    if(result.status===401)expired(requestBase,requestSession);
    const bytes=Uint8Array.from(atob(result.base64),c=>c.charCodeAt(0));
    return new Response(bytes,{status:result.status,headers:{'Content-Type':result.contentType||'application/json'}});
  };
}
export async function saveMobileFile(blob:Blob,name:string) {
  if(!window.AndroidDailyReport) {const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;}
  const base64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('文件读取失败'));reader.readAsDataURL(blob);});
  // The system document picker waits for the user, not a network response.
  // Settle on the native saved/cancelled/error callback; a two-minute timer
  // could report failure while the user is still choosing a destination.
  await invoke(id=>window.AndroidDailyReport!.saveFile(id,name,blob.type||'application/octet-stream',base64),null);
}
export async function saveMobileSiteFile(url:string,name:string,mime:string,bytes:number,sha256:string,signal?:AbortSignal) {
  const address=new URL(url,backend()),path=address.pathname;
  const packaged=/^\/api\/engineering-site-packages\/[A-Za-z0-9_-]{43}$/.test(path),original=/^\/api\/engineering-site-media\/[A-Za-z0-9_-]{43}$/.test(path);
  const media=['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/jpeg','image/png','image/webp','video/mp4','video/webm'];
  const limit=packaged?1024*1024*1024:mime.startsWith('video/')?256*1024*1024:16*1024*1024;
  const rawPath=url.replace(/^https?:\/\/[^/?#]+(?=\/)/,'');
  if((!packaged&&!original)||!['http:','https:'].includes(address.protocol)||address.username||address.password||rawPath!==path||address.search||address.hash||(packaged?mime!=='application/zip':!media.includes(mime))||!Number.isSafeInteger(bytes)||bytes<1||bytes>limit||!/^[a-f0-9]{64}$/.test(sha256)||!name.trim()||name.length>160||['.','..'].includes(name.trim())||/[/\\\x00-\x1f\x7f-\x9f]/.test(name))throw new Error('施工资料下载依据无效，请刷新资料后重试');
  const target=backend()+path;
  if(!window.AndroidDailyReport){const a=document.createElement('a');a.href=target;a.download=name;a.rel='noopener';a.click();return{downloadStarted:true};}
  if(!window.AndroidDailyReport.downloadSiteFile)throw new Error('当前APP尚不支持施工资料原件下载，请更新APP后重试');
  const s=session();if(!s)throw new Error('请重新登录后下载施工资料');
  return invoke(id=>window.AndroidDailyReport!.downloadSiteFile!(id,JSON.stringify({baseUrl:backend(),path,token:s.token,name,mime,bytes,sha256})),10*60*1000,signal,id=>window.AndroidDailyReport?.cancelSiteFile?.(id));
}
export function siteMediaPreviewUrl(url:string):string {
  if(!window.AndroidDailyReport)return url;
  if(!window.AndroidDailyReport.downloadSiteFile)throw new Error('当前APP尚不支持施工资料预览，请更新APP后重试');
  const address=new URL(url,backend());
  if(!/^\/api\/engineering-site-media\/[A-Za-z0-9_-]{43}$/.test(address.pathname)||address.search||address.hash)throw new Error('施工资料预览依据无效，请刷新资料后重试');
  return 'https://appassets.androidplatform.net'+address.pathname;
}
export type UpdateInfo = {currentVersion:string;currentCode:number;available:boolean;ready?:boolean;versionName?:string;notes?:string[]};
export function checkMobileUpdate():Promise<UpdateInfo> {if(!window.AndroidDailyReport?.checkUpdate)return Promise.reject(new Error('请在新版安卓 APP 内检查更新'));return invoke(id=>window.AndroidDailyReport!.checkUpdate!(id,backend()));}
export function installMobileUpdate():Promise<{permissionRequired?:boolean;installerOpened?:boolean}> {if(!window.AndroidDailyReport?.installUpdate)return Promise.reject(new Error('请先安装支持更新的 APP'));return invoke(id=>window.AndroidDailyReport!.installUpdate!(id,backend()));}
