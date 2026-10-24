import { useEffect, useState, type FormEvent } from 'react';
import MobileWorkspace from './MobileWorkspace';
import AppUpdate from './AppUpdate';
import MobilePasswordChange from './MobilePasswordChange';
import { inIOSShell } from './native-shell';
import { backend, session, saveSession, clearSession, saveMobileFile, saveMobileSiteFile } from './mobile-transport';
import type { User } from './model';
import './mobile-app.css';

export default function MobileApp() {
  const [user,setUser]=useState<User|null>(null),[checking,setChecking]=useState(true),[username,setUsername]=useState(''),[password,setPassword]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [updateScope]=useState(backend()),[iosShell]=useState(inIOSShell);
  useEffect(()=>{if(!session()){setChecking(false);return;}fetch('/api/mobile/me').then(async r=>{if(!r.ok)throw new Error('登录已失效，请重新登录');setUser(await r.json());}).catch(e=>setError(e.message)).finally(()=>setChecking(false));},[]);
  useEffect(()=>{const expired=()=>{setUser(null);setError('登录已失效，本机草稿保留，请重新登录。');};window.addEventListener('daily-session-expired',expired);return()=>window.removeEventListener('daily-session-expired',expired);},[]);
  async function login(e:FormEvent) {e.preventDefault();setBusy(true);setError('');try{const r=await fetch('/api/mobile/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})});const data=await r.json();if(!r.ok)throw new Error(data.error||'登录失败');saveSession(data);setPassword('');setUser(data.user);}catch(e){setError((e as Error).message||'连接失败，请检查网络后重试');}finally{setBusy(false);}}
  async function changePassword(data:{current:string;password:string}){
    const requestBase=backend(),requestToken=session()?.token;
    const response=await fetch('/api/mobile/password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'密码修改失败');
    if(backend()!==requestBase||session()?.token!==requestToken)throw new Error('原账号密码已修改，请使用新密码重新登录。');
    saveSession(result);setUser(result.user);
  }
  async function logout(){setBusy(true);try{await fetch('/api/mobile/logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});}catch{/* Local sign-out remains available offline. */}finally{clearSession();setUser(null);setBusy(false);}}
  const mark=<span className="brand-mark" aria-hidden="true"><i/><i/><i/></span>;
  if(checking)return <div className="mobile-loading" role="status">{mark}<span>正在连接智慧工程…</span></div>;
  return <div className={'mobile-app os-shell os-app'+(iosShell?' is-ios-shell':'')}><header className="mobile-bar"><span className="mobile-brand">{mark}智慧工程</span>{user&&<span className="mobile-user-name">{user.name}</span>}</header>
    {!user&&<AppUpdate scope={updateScope} compact/>}
    {user?<main className="mobile-work os-page"><MobileWorkspace key={backend()+user.id} user={user} storageScope={backend()} saveFile={saveMobileFile} saveSiteFile={saveMobileSiteFile} onLogout={()=>void logout()} native accountTools={expanded=><>{expanded&&<MobilePasswordChange changePassword={changePassword}/>}<AppUpdate scope={updateScope} compact={!expanded}/></>}/></main>:<main className="mobile-login"><span className="mobile-login-mark">{mark}</span><h1>登录智慧工程</h1><p>按项目管理施工、资料、材料与经营业务。</p><form onSubmit={login}><label>平台账号<input required value={username} onChange={e=>setUsername(e.target.value)} autoComplete="username" autoCapitalize="none"/></label><label>密码<input type="password" required value={password} onChange={e=>setPassword(e.target.value)} autoComplete="current-password"/></label>{error&&<p className="error-banner" role="alert">{error}</p>}<button className="button primary" disabled={busy}>{busy?'正在登录…':'登录智慧工程'}</button></form><p className="mobile-template-note">使用现有平台账号 · 资料统一保存在服务器</p></main>}
  </div>;
}
