import {engineeringNavigationBlocked} from './engineering-navigation-guard';
import { useEffect, useRef, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { backend, checkMobileUpdate, installMobileUpdate, type UpdateInfo } from './mobile-transport';

export default function AppUpdate({scope,compact=false}:{scope:string;compact?:boolean}) {
  const [info,setInfo]=useState<UpdateInfo>(),[busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const checking=useRef(false),last=useRef(0),generation=useRef(0);
  async function check(){if(checking.current||!window.AndroidDailyReport?.checkUpdate)return;checking.current=true;setBusy(true);setMessage('正在检查版本并下载更新…');const request=++generation.current;
    try{const value=await checkMobileUpdate();if(request!==generation.current)return;setInfo(value);last.current=Date.now();setMessage(value.ready?'更新包已下载并校验，可安装后继续使用。':'已是最新版本。');}
    catch(e){if(request===generation.current)setMessage((e as Error).message+'，可稍后重试。');}finally{if(request===generation.current){checking.current=false;setBusy(false);}}
  }
  useEffect(()=>{generation.current++;checking.current=false;setInfo(undefined);void check();const visible=()=>{if(document.visibilityState==='visible'&&Date.now()-last.current>6*3600000)void check();};document.addEventListener('visibilitychange',visible);return()=>{generation.current++;document.removeEventListener('visibilitychange',visible);};},[scope]);
  async function install(){if(engineeringNavigationBlocked()){setMessage('请先保存本机草稿、完成或核对待上传原件，并关闭当前表单，再安装更新。');return;}setBusy(true);try{if(scope!==backend())throw new Error('连接状态已变化，请重新检查更新');const result=await installMobileUpdate();setMessage(result.permissionRequired?'请在系统页面允许本应用安装更新，返回后继续安装。':'安装确认已打开，完成后重新打开 APP；账号和草稿保留。');}catch(e){setMessage((e as Error).message);}finally{setBusy(false);}}
  if(!window.AndroidDailyReport?.checkUpdate)return compact?null:<p className="mw-hint">请在安卓APP内查看版本与检查更新。</p>;
  if(compact&&!info?.ready)return null;
  return <aside className="app-update" aria-label="APP 更新"><div><strong>{info?.ready?'新版本 '+info.versionName:info?.currentVersion?'APP '+info.currentVersion:'APP 更新'}</strong><p role="status">{message}</p>{info?.ready&&info.notes&&<ul>{info.notes.map(note=><li key={note}>{note}</li>)}</ul>}</div><div>{info?.ready?<button className="button primary" disabled={busy} onClick={()=>void install()}><Download size={16}/>安装更新</button>:<button className="text-button" disabled={busy} onClick={()=>void check()}><RefreshCw size={16}/>{busy?'正在检查':'检查更新'}</button>}</div></aside>;
}
