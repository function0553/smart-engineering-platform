import {useEffect,useRef,useState} from 'react';
import {BOQ_IMPORT_LIMITS,readBoqImportFile,inferBoqImportMapping,previewBoqImport} from '../shared/engineering-boq-import.mjs';
import {buildBoqImportTemplate} from '../shared/engineering-boq-template.mjs';
import type {BoqLine,BoqItem} from './EngineeringBoq';
import './engineering-boq-import.css';

export type BoqImportEditLine={id?:string;code:string;name:string;location:string;unit:string;quantity:string;unitPrice:string};
type Workbook=ReturnType<typeof readBoqImportFile>;
type Mapping=ReturnType<typeof inferBoqImportMapping>;
type Preview=ReturnType<typeof previewBoqImport>;
type Props={existingLines:BoqImportEditLine[];lockedLines:BoqLine[];usedLines:BoqItem[];effectiveAmount:number;isInitial:boolean;disabled:boolean;onApply:(lines:BoqImportEditLine[])=>void;onActiveChange:(active:boolean)=>void};
const fields=[['id','条目 ID 列'],['code','清单编码列'],['name','清单名称列'],['location','部位列'],['unit','计量单位列'],['quantity','清单数量列'],['unitPrice','含税单价列']] as const;
const emptyMapping=():Mapping=>({id:-1,code:-1,name:-1,location:-1,unit:-1,quantity:-1,unitPrice:-1});
const money=(value:number)=>(value/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const columnName=(value:number)=>{let name='',n=value+1;while(n>0){n--;name=String.fromCharCode(65+n%26)+name;n=Math.floor(n/26);}return name;};
function rowNumber(text:string,label:string,optional=false){if(optional&&!text.trim())return undefined;if(!/^[1-9]\d*$/.test(text)||Number(text)>BOQ_IMPORT_LIMITS.rows)throw new Error(`${label}须为 1 至 ${BOQ_IMPORT_LIMITS.rows} 的整数`);return Number(text);}
function parseXml(text:string){const doc=new DOMParser().parseFromString(text,'application/xml');if(doc.getElementsByTagName('parsererror').length)throw new Error('Excel 内部 XML 无法读取，请另存为标准 .xlsx 后重试');return doc;}

export function EngineeringBoqImport({existingLines,lockedLines,usedLines,effectiveAmount,isInitial,disabled,onApply,onActiveChange}:Props){
  const [open,setOpen]=useState(false),[file,setFile]=useState<File|null>(null),[encoding,setEncoding]=useState('utf-8');
  const [workbook,setWorkbook]=useState<Workbook|null>(null),[sheetId,setSheetId]=useState(''),[headerRow,setHeaderRow]=useState('1'),[startRow,setStartRow]=useState(''),[endRow,setEndRow]=useState(''),[mapping,setMapping]=useState<Mapping>(emptyMapping);
  const [preview,setPreview]=useState<Preview|null>(null),[confirmed,setConfirmed]=useState(false),[reading,setReading]=useState(false),[downloading,setDownloading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const mounted=useRef(true);useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const sheet=workbook?.sheets.find(s=>s.id===sheetId),blocked=disabled||reading||downloading;
  function invalidate(){setPreview(null);setConfirmed(false);setError('');setNotice('');}
  useEffect(()=>{setPreview(null);setConfirmed(false);},[existingLines,lockedLines,usedLines,effectiveAmount,isInitial]);
  useEffect(()=>{
    let active=true;setWorkbook(null);setSheetId('');setPreview(null);setConfirmed(false);setError('');setReading(false);
    if(!open||!file)return;
    if(file.size>BOQ_IMPORT_LIMITS.fileBytes){setError('文件超过 2 MB，请精简为清单条目后重新选择。');return;}
    if(!/\.(xlsx|csv)$/i.test(file.name)){setError('请选择 .xlsx 或 .csv 文件；旧版 .xls 请先另存为 .xlsx。');return;}
    setReading(true);
    void file.arrayBuffer().then(buffer=>{
      if(!active)return;const book=readBoqImportFile(new Uint8Array(buffer),{filename:file.name,encoding,parseXml});
      const first=book.sheets.find(s=>!s.hidden)||book.sheets[0];if(!first)throw new Error('文件中没有可读取的工作表');
      setWorkbook(book);setSheetId(first.id);setHeaderRow('1');setStartRow('');setEndRow('');setMapping(inferBoqImportMapping(first,1));
    }).catch(e=>{if(active)setError((e as Error).message);}).finally(()=>{if(active)setReading(false);});
    return()=>{active=false;};
  },[open,file,encoding]);
  function close(){if(disabled)return;setOpen(false);setFile(null);setWorkbook(null);setPreview(null);setConfirmed(false);setError('');setNotice('');onActiveChange(false);}
  function chooseSheet(id:string){invalidate();setSheetId(id);setHeaderRow('1');setStartRow('');setEndRow('');const next=workbook?.sheets.find(s=>s.id===id);setMapping(next?inferBoqImportMapping(next,1):emptyMapping());}
  function changeHeader(value:string){invalidate();setHeaderRow(value);if(sheet&&/^[1-9]\d*$/.test(value))setMapping(inferBoqImportMapping(sheet,Number(value)));else setMapping(emptyMapping());}
  function makePreview(){if(!sheet)throw new Error('请先选择可读取的工作表');return previewBoqImport({sheet,headerRow:rowNumber(headerRow,'表头行')!,startRow:rowNumber(startRow,'数据起始行',true),endRow:rowNumber(endRow,'数据结束行',true),mapping,existingLines,lockedLines,usedLines,effectiveAmount,isInitial});}
  function inspect(){if(blocked)return;invalidate();try{setPreview(makePreview());}catch(e){setError((e as Error).message);}}
  function apply(){if(blocked||!preview?.allowed||!confirmed)return;try{const latest=makePreview();if(!latest.allowed||JSON.stringify(latest.lines)!==JSON.stringify(preview.lines)){setPreview(latest);setConfirmed(false);setError('清单依据发生变化，请重新核对预览后确认。');return;}onApply(latest.lines);setOpen(false);setFile(null);setWorkbook(null);setPreview(null);setConfirmed(false);setError('');setNotice('已替换编辑器条目，尚未保存。请核对名称和编制说明，再保存草稿并办理独立审批。');onActiveChange(false);}catch(e){setError((e as Error).message);}}
  async function download(){if(blocked)return;setDownloading(true);setError('');setNotice('');try{const bytes=buildBoqImportTemplate(existingLines),blob=new Blob([new Uint8Array(bytes)],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),name='工程量清单导入模板.xlsx';if(window.AndroidDailyReport){const {saveMobileFile}=await import('./mobile-transport');await saveMobileFile(blob,name);}else{const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}if(mounted.current)setNotice('模板已交给下载，请核对保存结果。已存在的条目 ID 随模板保留。');}catch(e){if(mounted.current)setError((e as Error).message);}finally{if(mounted.current)setDownloading(false);}}
  const header=sheet?.rows.find(r=>r.number===Number(headerRow));
  const columns=sheet?Array.from({length:Math.min(BOQ_IMPORT_LIMITS.columns,Math.max(0,...sheet.rows.map(r=>r.cells.length)))},(_,index)=>({index,label:`${columnName(index)} · ${(header?.cells[index]?.text||'无表头').slice(0,100)}`})):[];
  function coordinates(row:number,field:string){if(row<=0)return `${sheet?.name||'工作表'}（整表校验）`;const key=fields.find(([name])=>name===field)?.[0],index=key?mapping[key]:-1;return `${sheet?.name||'工作表'}!${index>=0?columnName(index):'第 '}${row>0?row:'—'}${index>=0?'':' 行'}`;}
  return <section className="eng-boq-import" aria-label="清单批量导入">
    <div className="eng-boq-import-toolbar"><div><h3>批量编制清单</h3><p>导入只填充当前草稿，保存后仍需独立审批。文件在本机读取，不上传或保存原文件。</p></div><div className="eng-boq-import-actions"><button type="button" className="button" disabled={blocked} onClick={()=>void download()}>{downloading?'正在生成模板…':'下载当前清单模板'}</button>{!open&&<button type="button" className="button" disabled={blocked} onClick={()=>{setOpen(true);setError('');setNotice('');onActiveChange(true);}}>批量导入清单</button>}{open&&<button type="button" className="button" disabled={disabled} onClick={close}>取消导入</button>}</div></div>
    {error&&<p className="error-banner" role="alert">{error}</p>}{notice&&<p className="eng-message" role="status">{notice}</p>}
    {open&&<div className="eng-boq-import-panel">
      <fieldset disabled={disabled||downloading} className="eng-boq-import-settings"><label className="eng-boq-import-file">选择 Excel 或 CSV 文件<input type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" onChange={e=>{invalidate();setFile(e.target.files?.[0]||null);}}/><small>支持 .xlsx、.csv，最大 2 MB，最多 200 条清单。取消导入不会改变原条目。</small></label>{file&&/\.csv$/i.test(file.name)&&<label>CSV 编码<select value={encoding} onChange={e=>{invalidate();setEncoding(e.target.value);}}><option value="utf-8">UTF-8</option><option value="gb18030">GB18030（简体中文）</option></select><small>有 BOM 时自动识别；若中文乱码，请切换编码后重新预览。</small></label>}</fieldset>
      {reading&&<p role="status" aria-live="polite">正在本地读取清单文件…</p>}
      {workbook&&sheet&&<><fieldset disabled={blocked} className="eng-boq-import-settings"><label>工作表<select value={sheetId} onChange={e=>chooseSheet(e.target.value)}>{workbook.sheets.map(s=><option key={s.id} value={s.id}>{s.name}{s.hidden?'（隐藏表）':''}</option>)}</select></label><label>表头行<input type="number" min="1" max={BOQ_IMPORT_LIMITS.rows} step="1" value={headerRow} onChange={e=>changeHeader(e.target.value)}/></label><label>数据起始行<input type="number" min="1" max={BOQ_IMPORT_LIMITS.rows} step="1" placeholder="默认表头下一行" value={startRow} onChange={e=>{invalidate();setStartRow(e.target.value);}}/></label><label>数据结束行<input type="number" min="1" max={BOQ_IMPORT_LIMITS.rows} step="1" placeholder="默认最后一行" value={endRow} onChange={e=>{invalidate();setEndRow(e.target.value);}}/></label></fieldset><p className="eng-boq-import-help">按原文件行号选择表头和数据范围。所选范围内非空行逐行校验，范围外内容在预览提示且不会导入；请核对排除行。</p>
      <fieldset disabled={blocked} className="eng-boq-import-mapping"><legend>核对列对应关系</legend>{fields.map(([key,label])=><label key={key}>{label}<select value={mapping[key]} onChange={e=>{invalidate();setMapping({...mapping,[key]:Number(e.target.value)});}}><option value={-1}>{key==='id'?'不提供 ID，按完整条目身份匹配':'请选择对应列'}</option>{columns.map(c=><option key={c.index} value={c.index}>{c.label}</option>)}</select></label>)}</fieldset><p className="eng-boq-import-help">已有条目优先按 ID 识别；无 ID 时，编码、名称、部位、单位、单价须唯一匹配。批准过的条目不能漏掉或改身份，停用请保留并把数量设为 0。</p>{workbook.warnings.length>0&&<ul className="eng-boq-import-warning">{workbook.warnings.map((warning,i)=><li key={i}>{warning}</li>)}</ul>}<button type="button" className="button" disabled={blocked} onClick={inspect}>预览导入</button>
      {preview&&<div className="eng-boq-import-preview"><h4>核对导入结果</h4><dl className="eng-boq-import-summary" aria-label="清单导入汇总"><div><dt>所选范围数据行数</dt><dd>{preview.summary.rowCount}</dd></div><div><dt>新增 / 匹配</dt><dd>{preview.summary.newCount} / {preview.summary.matchedCount}</dd></div><div><dt>移除未批准草稿条目</dt><dd>{preview.summary.removedDraftCount}</dd></div><div><dt>导入清单总额（元）</dt><dd>{money(preview.summary.totalAmount)}</dd></div><div><dt>与有效合同差额（元）</dt><dd>{preview.summary.deltaAmount>0?'+':''}{money(preview.summary.deltaAmount)}</dd></div></dl>
      {!preview.allowed&&<p className="eng-boq-import-help">存在错误时，预览合价仅供定位数据问题，不能作为完整清单金额。</p>}{preview.warnings.length>0&&<ul className="eng-boq-import-warning">{preview.warnings.map((warning,i)=><li key={i}>{warning}</li>)}</ul>}{!preview.allowed&&<div className="eng-boq-import-errors" role="alert"><strong>存在错误，不能替换草稿条目。</strong><ul>{preview.errors.map((issue,i)=><li key={i}>{coordinates(issue.row,issue.field)}：{issue.message}</li>)}</ul></div>}
      <div className="eng-table-wrap"><table className="eng-table eng-boq-import-table" aria-label="清单导入逐行预览"><thead><tr><th>来源 / 操作</th><th>编码 / 名称</th><th>部位 / 单位</th><th>数量 / 单价（元）</th><th>合价（元）</th><th>行校验</th></tr></thead><tbody>{preview.rows.map(row=><tr key={row.sourceRow} data-import-source-row={row.sourceRow}><td data-label="来源 / 操作"><div>{sheet.name}!{row.sourceRow}<small>{row.action==='new'?'新增':row.action==='matched'?'匹配已有条目':'无效行'}</small></div></td><td data-label="编码 / 名称"><div>{row.line?.code||'—'}<small>{row.line?.name||'—'}</small></div></td><td data-label="部位 / 单位"><div>{row.line?.location||'—'}<small>{row.line?.unit||'—'}</small></div></td><td data-label="数量 / 单价"><div>{row.line?.quantity??'—'} / {row.line?.unitPrice??'—'}</div></td><td data-label="合价（元）"><div>{row.amount===null?'—':money(row.amount)}</div></td><td data-label="行校验"><div>{row.errors.length?<ul>{row.errors.map((issue,i)=><li key={i}>{coordinates(issue.row,issue.field)}：{issue.message}</li>)}</ul>:'通过'}</div></td></tr>)}</tbody></table></div>
      <p className="eng-boq-import-warning">确认后将替换编辑器的全部清单条目，不是追加。版本名称与编制说明保留；还需手动保存草稿。{preview.summary.removedDraftCount>0?`本次会移除 ${preview.summary.removedDraftCount} 条未批准草稿条目。`:''}</p><label className="eng-boq-import-confirm"><input type="checkbox" checked={confirmed} disabled={blocked||!preview.allowed} onChange={e=>setConfirmed(e.target.checked)}/><span>我已核对，替换当前编辑器的全部清单条目</span></label><button type="button" className="button primary" disabled={blocked||!preview.allowed||!confirmed} onClick={apply}>确认替换草稿条目</button></div>}
      </>}
    </div>}
  </section>;
}
