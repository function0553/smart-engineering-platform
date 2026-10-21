import {useEffect,useState} from 'react';
import DailyReports from './DailyReports';
import PhotoArchives from './PhotoArchives';
import {api,type User} from './model';
import {permittedSiteNodes} from '../shared/site-workspace.mjs';
import {engineeringNavigationBlocked} from './engineering-navigation-guard';
import type {FilingProject} from './DailySiteFiling';
export default function ProjectDailyReports({user,kind='daily'}:{user:User;kind?:'daily'|'photo'}){
 const key=kind+':project:'+JSON.stringify([location.origin,user.id]);
 const [projects,setProjects]=useState<any[]>([]),[pid,setPid]=useState(()=>localStorage.getItem(key)||''),[project,setProject]=useState<FilingProject>(),[error,setError]=useState(''),[loading,setLoading]=useState(true),[filed,setFiled]=useState('');
 useEffect(()=>{let live=true;api<{projects:any[]}>('/engineering').then(({projects:rows})=>{if(live){setProjects(rows);if(pid&&!rows.some(p=>p.id===pid))setPid('');}}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[user.id]);
 useEffect(()=>{let live=true;setProject(undefined);setFiled('');setLoading(!!pid);setError('');if(!pid)return;Promise.all([api<any>('/engineering/projects/'+pid),api<any>('/engineering/projects/'+pid+'/site-records?limit=1')]).then(([d,list])=>{if(live)setProject({id:pid,name:d.project.data.name,nodes:permittedSiteNodes(d.wbs?.nodes||[],list.permission),canCreate:list.writable&&(!list.permission?.enabled||!list.permission.categories.length||list.permission.categories.includes(kind==='daily'?'construction_daily':'work_photos'))});}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setLoading(false);});return()=>{live=false;};},[pid,user.id,kind]);
 return <><section className="report-history-summary"><label className="report-field">{kind==='daily'?'日报所属项目':'影像所属项目'}<select value={pid} onChange={e=>{if(engineeringNavigationBlocked()){setError('请先等待当前填写内容和照片保存，再切换项目。');return;}setPid(e.target.value);localStorage.setItem(key,e.target.value);}}><option value="">旧版未指定项目草稿</option>{projects.map(p=><option key={p.id} value={p.id}>{p.data.name}</option>)}</select></label>{error&&<p className="report-errors" role="alert">{error}</p>}{filed&&<p role="status">已归入当前项目施工资料，可在工程管理的施工资料中查看、提交审核。</p>}</section>{loading?<p role="status">正在读取项目权限…</p>:(!pid||project?.id===pid)&&(kind==='photo'?<PhotoArchives key={user.id+pid} user={user} projectId={pid} projectName={project?.name} canCreate={!pid||project?.canCreate}/>:<DailyReports key={user.id+pid} user={user} storageScope="" filingProject={project} onFiled={id=>setFiled(id)}/> )}</>;
}
