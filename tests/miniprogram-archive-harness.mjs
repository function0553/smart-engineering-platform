import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {Script,createContext} from 'node:vm';
import {createApp} from '../server/app.mjs';

// Only WeChat APIs are simulated. Requests execute the real isolated server and
// SQLite code; this harness does not establish Developer Tools or device acceptance.
export const pixels=readFileSync(new URL('./assets/daily-report-qa.png',import.meta.url));
export const otherPixels=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
const copy=value=>value===undefined?undefined:structuredClone(value);
const arrayBuffer=bytes=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);

export async function archiveServer(t){
  const directory=mkdtempSync(join(tmpdir(),'miniprogram-archive-')),server=createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const baseUrl='http://127.0.0.1:'+server.address().port;
  const {app,store,vision}=createApp({database:join(directory,'test.sqlite'),baseUrl,distPath:join(directory,'no-dist'),filesDir:join(directory,'models'),updateDir:join(directory,'updates')});
  server.on('request',app);
  const clients=[];
  t.after(async()=>{for(const c of clients)c.dispose();vision.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));store.close();rmSync(directory,{recursive:true,force:true});});
  async function web(path,body,cookie='',method=body===undefined?'GET':'POST'){
    return fetch(baseUrl+'/api'+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json','X-Workspace-Request':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  }
  const setup=await web('/setup',{organization:'小程序隔离测试',username:'test-admin',name:'测试管理员',password:'isolated-test-12345'}),adminCookie=setup.headers.get('set-cookie').split(';')[0];
  const admin=(await setup.json()).user;
  async function user(username,role='operator'){
    const response=await web('/users',{username,name:username,role,password:'isolated-test-12345'},adminCookie);assert.equal(response.status,201);
    return {username,role,password:'isolated-test-12345'};
  }
  function runtime(options={}){const client=wechatRuntime({...options,baseUrl});clients.push(client);return client;}
  return {baseUrl,store,web,adminCookie,admin,user,runtime};
}

export function wechatRuntime({baseUrl,storage=new Map(),files=new Map()}={}){
  const pending=new Set(),timers=new Set(),requests=[],rules=[],controls=[],events=[],writes=[],removed=[],scroll={top:0};let choice,chooseOptions,page,failWrite,failCopy,failStorage,failOpen=false,failShare='',heldOpening;
  function track(promise){pending.add(promise);promise.then(()=>pending.delete(promise),()=>pending.delete(promise));return promise;}
  const callback=(options,result,error)=>track(Promise.resolve().then(()=>error?options.fail?.({errMsg:error}):options.success?.(result)).then(value=>options.complete?.()).catch(error=>{throw error;}));
  function bytesOf(data,encoding){return typeof data==='string'?Buffer.from(data,encoding||'utf8'):Buffer.from(data);}
  function read(path,encoding){if(!files.has(path))throw new Error('file missing: '+path);const bytes=files.get(path);return encoding?bytes.toString(encoding):arrayBuffer(bytes);}
  function write(path,data,encoding){if(failWrite && failWrite(path)){throw new Error('simulated storage failure');}const bytes=bytesOf(data,encoding);files.set(path,bytes);writes.push({path,bytes:Buffer.from(bytes)});}
  function remove(path){if(!files.has(path))throw new Error('file missing');files.delete(path);removed.push(path);}
  const fs={
    readFileSync:read,writeFileSync:write,unlinkSync:remove,
    accessSync:path=>{if(!files.has(path))throw new Error('file missing');},mkdirSync(){},
    statSync:path=>({size:files.get(path)?.length||0,isFile:()=>files.has(path),isDirectory:()=>false}),
    copyFileSync:(source,dest)=>{if(failCopy && failCopy(source,dest))throw new Error('simulated copy failure');write(dest,read(source));},
    renameSync:(source,dest)=>{write(dest,read(source));remove(source);},
    readFile(options){try{callback(options,{data:read(options.filePath,options.encoding)});}catch(error){callback(options,null,error.message);}},
    writeFile(options){try{write(options.filePath,options.data,options.encoding);callback(options,{});}catch(error){callback(options,null,error.message);}},
    copyFile(options){try{this.copyFileSync(options.srcPath,options.destPath);callback(options,{});}catch(error){callback(options,null,error.message);}},
    unlink(options){try{remove(options.filePath);callback(options,{});}catch(error){callback(options,null,error.message);}},
    stat(options){callback(options,{stats:this.statSync(options.path)});},
    access(options){try{this.accessSync(options.path);callback(options,{});}catch(error){callback(options,null,error.message);}}
  };
  const wx={
    env:{USER_DATA_PATH:'/private'},getFileSystemManager:()=>fs,
    getStorageSync:key=>copy(storage.get(key)),setStorageSync:(key,value)=>{if(failStorage && failStorage(key))throw new Error('simulated storage index failure');storage.set(key,copy(value));},removeStorageSync:key=>storage.delete(key),
    getAccountInfoSync:()=>({miniProgram:{envVersion:'develop'}}),
    request(options){
      const record={url:options.url,path:new URL(options.url).pathname+new URL(options.url).search,method:options.method||'GET',data:copy(options.data),headers:{...options.header},binary:options.responseType==='arraybuffer'};requests.push(record);
      const index=rules.findIndex(rule=>rule.match(record));const rule=index<0?null:rules.splice(index,1)[0];
      track((async()=>{
        if(rule?.action==='fail-before'){options.fail?.({errMsg:'simulated unavailable service'});return;}
        const response=await fetch(record.url,{method:record.method,headers:record.headers,...(record.data===undefined || record.method==='GET'?{}:{body:JSON.stringify(record.data)})});
        let data;if(record.binary)data=await response.arrayBuffer();else{const body=await response.text();try{data=JSON.parse(body);}catch(_){data=body;}}
        const result={statusCode:response.status,data,header:Object.fromEntries(response.headers)};
        if(rule?.action==='hold'){rule.result=result;rule.record=record;await new Promise(resolve=>{rule.release=resolve;});}
        if(rule?.action==='fail-after'){options.fail?.({errMsg:'simulated reply lost after commit'});return;}
        options.success?.(result);
      })().catch(error=>options.fail?.({errMsg:error.message})).finally(()=>options.complete?.()));
      return {abort(){events.push({type:'abort',record});}};
    },
    chooseMedia(options){chooseOptions=options;const selected=choice;choice=null;if(!selected)throw new Error('chooseMedia fixture missing');if(selected.cancel)callback(options,null,'chooseMedia:fail cancel');else callback(options,{tempFiles:selected.files});},
    getImageInfo(options){const bytes=files.get(options.src);if(!bytes){callback(options,null,'file missing');return;}const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));callback(options,{width:png?bytes.readUInt32BE(16):1,height:png?bytes.readUInt32BE(20):1,type:png?'png':'jpeg',path:options.src});},
    showModal(options){events.push({type:'modal',options});callback(options,{confirm:true,cancel:false});},
    showToast(options){events.push({type:'toast',options});},pageScrollTo(options){events.push({type:'scroll',options});scroll.top=options.scrollTop;},
    redirectTo(options){events.push({type:'redirect',...options});},navigateTo(options){events.push({type:'navigate',...options});},navigateBack(options){events.push({type:'back',...options});},reLaunch(options){events.push({type:'relaunch',...options});},
    previewImage(options){events.push({type:'preview',options});},
    openDocument(options){events.push({type:'open',options});if(heldOpening){const control=heldOpening;heldOpening=null;control.options=options;track(new Promise(resolve=>{control.release=resolve;}).then(()=>callback(options,{},control.error)));}else callback(options,{},failOpen?'openDocument:fail':null);},
    shareFileMessage(options){events.push({type:'share',options});callback(options,{},failShare);},canIUse:()=>true,
    arrayBufferToBase64:value=>Buffer.from(value).toString('base64'),base64ToArrayBuffer:value=>arrayBuffer(Buffer.from(value,'base64'))
  };
  const cache=new Map(),context=createContext({wx,console,Buffer,Uint8Array,ArrayBuffer,TextEncoder,TextDecoder,URL,Promise,JSON,Date,Math,Number,String,Boolean,Error,encodeURIComponent,decodeURIComponent,
    setTimeout:(fn,ms,...args)=>{const timer=setTimeout(()=>{timers.delete(timer);fn(...args);},ms);timers.add(timer);return timer;},clearTimeout:timer=>{clearTimeout(timer);timers.delete(timer);},Page:value=>{page=value;}});
  function load(relative){const absolute=resolve('miniprogram',relative);if(cache.has(absolute))return cache.get(absolute).exports;const module={exports:{}};cache.set(absolute,module);const source=readFileSync(absolute,'utf8');const fn=new Script('(function(require,module,exports){'+source+'\n})',{filename:absolute}).runInContext(context);fn(request=>{let target=resolve(dirname(absolute),request);if(!/\.js$/.test(target))target+='.js';return load(target.slice(resolve('miniprogram').length+1));},module,module.exports);return module.exports;}
  const api=load('utils/api.js');api.setBaseUrl(baseUrl);
  function loadPage(){page=null;load('pages/archives/index.js');page.data=copy(page.data);page.setData=patch=>{for(const [key,value] of Object.entries(patch)){const path=key.replace(/\[(\d+)\]/g,'.$1').split('.');let target=page.data;for(let i=0;i<path.length-1;i++)target=target[path[i]]??(target[path[i]]={});target[path.at(-1)]=value;}};return page;}
  async function login(username='test-admin',password='isolated-test-12345'){const session=await api.request('/login','POST',{username,password});api.setSession(session);return session.user;}
  async function settle(){for(let round=0;round<100;round++){if(!pending.size){await new Promise(resolve=>setTimeout(resolve,0));if(!pending.size)return;}await Promise.all([...pending]);}throw new Error('simulated wx callbacks did not settle');}
  async function waitFor(predicate,message='condition',timeout=3000){const started=Date.now();while(!predicate()){if(Date.now()-started>timeout)throw new Error('Timed out: '+message);await new Promise(resolve=>setTimeout(resolve,5));}}
  function requestRule(match,action){const rule={match:typeof match==='function'?match:r=>r.path.includes(match),action};rules.push(rule);controls.push(rule);return rule;}
  function media(bytes=pixels,path='/temp/selected.png',size=bytes.length){files.set(path,Buffer.from(bytes));return {tempFilePath:path,size,fileType:'image'};}
  return {wx,api,load,loadPage,login,settle,waitFor,requestRule,requests,events,writes,removed,storage,files,fs,media,
    choose:files=>{choice={files};},cancelChoose:()=>{choice={cancel:true};},chooseOptions:()=>chooseOptions,
    failWrites:predicate=>{failWrite=predicate;},failCopies:predicate=>{failCopy=predicate;},failStorage:predicate=>{failStorage=predicate;},failOpening:value=>{failOpen=value;},failSharing:value=>{failShare=value;},
    holdOpening(error='openDocument:fail'){heldOpening={error};controls.push(heldOpening);return heldOpening;},setScrollTop:value=>{scroll.top=value;},scrollTop:()=>scroll.top,
    dispose(){if(page?.onUnload)page.onUnload();for(const timer of timers)clearTimeout(timer);timers.clear();for(const control of controls)control.release?.();}
  };
}

export const event=(dataset={},value='')=>({currentTarget:{dataset},detail:{value}});
