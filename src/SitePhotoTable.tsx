import {useEffect,useState} from 'react';
import {Download,RefreshCw} from 'lucide-react';
import steps from '../shared/site-work-steps.json';
type Photo={id:string;name:string;sha256:string;step_id?:string;representative?:number;mime:string;byte_count:number;created_name:string;created_at:string;removed_at:string|null};
export function ProtectedPhoto({base,file,version,onPreview}:{base:string;file:Photo;version:number;onPreview?:()=>void}){
  const [url,setUrl]=useState(''),[error,setError]=useState(''),[retry,setRetry]=useState(0);
  useEffect(()=>{
    const controller=new AbortController();let disposed=false,objectUrl='';setUrl('');setError('');
    void(async()=>{try{
      const r=await fetch('/api'+base+'/files/'+file.id+'/thumbnail?sha256='+file.sha256,{signal:controller.signal});
      if(!r.ok){const fault=await r.json().catch(()=>null);throw Error(fault?.error||'照片读取失败，请重试');}
      const blob=await r.blob();if(blob.type!=='image/jpeg'||blob.size>1048576)throw Error('照片预览格式异常，请核对原件');
      if(disposed)return;objectUrl=URL.createObjectURL(blob);setUrl(objectUrl);
    }catch(e){if(!disposed&&!controller.signal.aborted)setError((e as Error).message);}})();
    return()=>{disposed=true;controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[base,file.id,file.sha256,version,retry]);
  return error?<div className="site-photo-cell-error"><p role="alert">{error}</p><button className="button" onClick={()=>setRetry(n=>n+1)}><RefreshCw size={14}/>重试照片</button></div>:url?onPreview?<button className="site-photo-image" onClick={onPreview} aria-label={'预览入表照片 '+file.name}><img src={url} alt={file.name} onError={()=>setError('照片显示失败，请重试或预览原件')}/></button>:<div className="site-photo-image"><img src={url} alt={file.name}/></div>:<p role="status">正在填入照片…</p>;
}
export function SitePhotoTable({base,version,files,projectName,address,location,number,completedAt,onPreview,onPickStep,onDownload,downloading,downloadDisabled}:{base:string;version:number;files:Photo[];projectName:string;address:string;location:string;number:string;completedAt:string;onPreview?:(file:Photo)=>void;onPickStep?:(id:string)=>void;onDownload?:()=>void;downloading:boolean;downloadDisabled:boolean}){
  return <section className="site-photo-table-section" aria-label="工序照片自动填表">
    <div className="site-record-heading"><div><h4>工序照片表</h4><p className="site-record-help">点工序即可添加照片，首张自动入表；全部原件与代表图设置可在下方查看。</p></div>{onDownload&&<button className="button primary" disabled={downloadDisabled||downloading} onClick={onDownload}><Download size={16}/>{downloading?'正在准备Word…':'下载当前A4Word'}</button>}</div>
    {files.some(f=>!f.step_id)&&<p className="site-record-help">有待整理原件，请先选择所属工序，再下载当前Word。</p>}
    <div className="site-photo-table-meta"><dl><div><dt>工程名称</dt><dd>{projectName||'未填写'}</dd></div><div><dt>工程地址</dt><dd>{address||'未填写'}</dd></div><div><dt>施工内容</dt><dd>{location||'未填写'}</dd></div><div><dt>资料编号</dt><dd>{number||'未填写'}</dd></div><div><dt>完工日期</dt><dd>{completedAt||'未填写'}</dd></div></dl></div>
    <table className="site-photo-live-table"><caption>十道工序照片 · 与当前A4 Word对应</caption><tbody>{Array.from({length:5},(_,row)=><tr key={row}>{steps.slice(row*2,row*2+2).map((step,i)=>{const originals=files.filter(f=>f.step_id===step.id),photo=originals.find(f=>f.representative===1);return <td key={step.id} data-photo-table-step={step.id} data-photo-table-file={photo?.id||''}><h5>{row*2+i+1}. {step.name}</h5><div className="site-photo-slot">{photo?<ProtectedPhoto key={photo.id} base={base} file={photo} version={version} onPreview={onPreview?()=>onPreview(photo):undefined}/>:<p>{originals.length?'已上传照片，请在下方选择A4代表照片':'未提供照片'}</p>}</div><p className="site-photo-cell-note">{originals.length?'已保存 '+originals.length+' 张':'尚未上传'}</p>{onPickStep&&<button className="text-button" onClick={()=>onPickStep(step.id)}>向此工序上传</button>}</td>;})}</tr>)}</tbody></table>
    <p className="site-record-help">当前Word随工序、代表照片和资料正文更新；下载无需另点生成，历史Word版本仍保留原快照。</p>
  </section>;
}
