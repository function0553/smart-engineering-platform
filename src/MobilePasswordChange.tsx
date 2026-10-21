import {useState,type FormEvent} from 'react';
import {KeyRound} from 'lucide-react';
import {Modal} from './components';
export default function MobilePasswordChange({changePassword}:{changePassword:(data:{current:string;password:string})=>Promise<void>}){
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();if(busy)return;const data=new FormData(event.currentTarget);setError('');
  if(data.get('password')!==data.get('confirm')){setError('两次新密码不一致');return;}
  setBusy(true);try{await changePassword({current:String(data.get('current')),password:String(data.get('password'))});setOpen(false);setMessage('密码已修改，其他登录已失效，本机草稿保留。');}catch(e){setError((e as Error).message||'结果未确认，请用新密码重新登录核对，本机草稿保留。');}finally{setBusy(false);}
 }
 return <><div className="mw-panel"><button className="mw-row" onClick={()=>{setError('');setMessage('');setOpen(true);}}><KeyRound size={19}/><span className="mw-row-main"><strong>修改本人密码</strong><small>至少6位，不要求复杂字符</small></span></button></div>{message&&<p className="mw-notice" role="status">{message}</p>}{open&&<Modal title="修改本人密码" subtitle="修改后其他登录失效，资料与本机草稿保留。" onClose={()=>{if(!busy)setOpen(false);}}><form onSubmit={submit}><div className="form-stack"><label>当前密码<input name="current" type="password" required maxLength={128} autoComplete="current-password"/></label><label>新密码<input aria-label="新密码" aria-describedby="mobile-password-hint" name="password" type="password" required minLength={6} maxLength={128} autoComplete="new-password"/><small id="mobile-password-hint">至少6位，可使用简单数字或字母。</small></label><label>确认新密码<input name="confirm" type="password" required minLength={6} maxLength={128} autoComplete="new-password"/></label></div>{error&&<p className="form-error" role="alert">{error}</p>}<div className="modal-footer"><button type="button" className="button" disabled={busy} onClick={()=>setOpen(false)}>取消</button><button className="button primary" disabled={busy}>{busy?'正在修改…':'保存新密码'}</button></div></form></Modal>}</>;
}
