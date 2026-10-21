import type {BoqContract} from './EngineeringBoq';

export type MeasurementMode='free'|'boq';
export type MeasurementTask={id:string;state:string;data:{title:string;location:string}};
type Line={name:string;location:string;unit:string;quantity:string;unitPrice:string;note:string;boqItemId?:string;taskId?:string};
type FreeInput={name:string;location:string;unit:string;quantity:number;unitPrice:number;note:string;taskId?:string};
type BoqInput={boqItemId:string;quantity:number;note:string;taskId?:string};
const blank=(mode:MeasurementMode='free'):Line=>({name:'',location:'',unit:'',quantity:'',unitPrice:'',note:'',taskId:'',...(mode==='boq'?{boqItemId:''}:{})});
export function measurementInput(rows?:any[],mode:MeasurementMode='free'){
  return JSON.stringify(rows?.length?rows.map(r=>r.boqItemId?{boqItemId:r.boqItemId,quantity:String(r.quantity/1000),note:r.note||'',taskId:r.taskId||''}:{name:r.name,location:r.location,unit:r.unit,quantity:String(r.quantity/1000),unitPrice:String(r.unitPrice/100),note:r.note||'',taskId:r.taskId||''}):[blank(mode)]);
}
function decimal(value:string,digits:number,max:number){
  if(!new RegExp(`^\\d+(?:\\.\\d{1,${digits}})?$`).test(String(value).trim()))throw new Error('数量最多3位小数，单价最多2位小数');
  const [whole,fraction='']=String(value).trim().split('.'),result=Number(whole)*10**digits+Number(fraction.padEnd(digits,'0'));
  if(!Number.isSafeInteger(result)||result<1||result>max)throw new Error('计量数量或单价超出范围');return result;
}
export function parseMeasurementInput(value:string,mode?:MeasurementMode):Array<FreeInput|BoqInput>{
  const rows=JSON.parse(value) as Line[];
  if(!Array.isArray(rows)||!rows.length||rows.length>50)throw new Error('每期计量须有1至50项明细');
  const useBoq=mode==='boq'||(mode===undefined&&rows.some(r=>Object.prototype.hasOwnProperty.call(r,'boqItemId'))),seen=new Set<string>();
  return rows.map((r,i)=>{
    const quantity=decimal(r.quantity,3,1_000_000_000),note=(r.note||'').trim(),taskId=(r.taskId||'').trim(),task=taskId?{taskId}:{};
    if(useBoq){
      if(!r.boqItemId)throw new Error(`第${i+1}项请选择批准清单条目`);
      if(seen.has(r.boqItemId))throw new Error(`第${i+1}项清单条目重复，请合并本期数量`);seen.add(r.boqItemId);
      return {boqItemId:r.boqItemId,quantity,note,...task};
    }
    if(r.boqItemId)throw new Error('该计量含清单条目，请在对应合同的清单模式中办理');
    if(!r.name?.trim()||!r.location?.trim()||!r.unit?.trim())throw new Error(`第${i+1}项请填写项目名称、部位及单位`);
    return {name:r.name.trim(),location:r.location.trim(),unit:r.unit.trim(),quantity,unitPrice:decimal(r.unitPrice,2,1_000_000_000_000),note,...task};
  });
}
const money=(n:number)=>(n/100).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2});
const qty=(n:number)=>(n/1000).toLocaleString('zh-CN',{maximumFractionDigits:3});
export function EngineeringMeasurementLines({value,onChange,mode,boqContract,tasks=[]}:{value:string;onChange:(value:string)=>void;mode?:MeasurementMode;boqContract?:BoqContract|null;tasks?:MeasurementTask[]}){
  const rows=JSON.parse(value) as Line[],useBoq=mode==='boq'||(mode===undefined&&(boqContract?.mode==='boq'||rows.some(r=>Object.prototype.hasOwnProperty.call(r,'boqItemId'))));
  function update(index:number,key:keyof Line,text:string){onChange(JSON.stringify(rows.map((r,i)=>i===index?{...r,[key]:text}:r)));}
  function estimate(r:BoqInput){
    const item=boqContract?.items.find(b=>b.id===r.boqItemId);if(!item)throw new Error('清单条目已不可用，请重新选择');
    if(r.quantity>item.remainingQuantity)throw new Error(`「${item.code}」本期数量超过可用余额`);
    const cents=(BigInt(item.usedQuantity+r.quantity)*BigInt(item.unitPrice)+500n)/1000n-BigInt(item.usedAmount);return cents>0n?cents:0n;
  }
  let total='待填写完整明细';
  try{const n=parseMeasurementInput(value,useBoq?'boq':'free').reduce((sum,r)=>sum+('boqItemId'in r?estimate(r):(BigInt(r.quantity)*BigInt(r.unitPrice)+500n)/1000n),0n);total=n<=1_000_000_000_000n?'¥ '+money(Number(n)):'金额超过允许范围';}catch(e){if(useBoq&&rows.every(r=>r.boqItemId&&r.quantity))total=(e as Error).message;}
  return <div className="eng-measure-lines">
    <p>{useBoq?'按批准清单填写本期新增数量。同一条目每单只能出现一次；名称、单位和单价沿用批准清单。':'数量按各项单位填写，单价以元计。系统逐项四舍五入到分后汇总，每期最多50项。'}</p>
    {useBoq&&<p className="eng-boq-help">估价按累计数量取整后的差额计算，可能为 0 分。审批期间清单或已计量数量变化时，应退回重核。</p>}
    <p className="eng-measure-task-help">每行可选择归集施工任务；留空记为未归集。批准后保留原任务名称与部位，已完成任务仍可补录计量。任务归属不会改变人工填报进度。</p>
    {rows.map((r,i)=>{const item=boqContract?.items.find(b=>b.id===r.boqItemId);let lineEstimate='待填写数量';if(useBoq&&item&&r.quantity)try{lineEstimate='¥ '+money(Number(estimate({boqItemId:item.id,quantity:decimal(r.quantity,3,1_000_000_000),note:r.note||''})));}catch(e){lineEstimate=(e as Error).message;}return <fieldset key={i}><legend>第 {i+1} 项</legend>
      {useBoq?<><div className="eng-measure-grid"><label className="eng-boq-select-line">批准清单条目 *<select required value={r.boqItemId||''} onChange={e=>update(i,'boqItemId',e.target.value)}><option value="">请选择清单条目</option>{r.boqItemId&&!item&&<option value={r.boqItemId}>原清单条目不可用，请重新选择</option>}{boqContract?.items.map(b=><option key={b.id} value={b.id} disabled={b.id!==r.boqItemId&&(b.remainingQuantity<=0||rows.some((other,j)=>j!==i&&other.boqItemId===b.id))}>{b.code} · {b.name} · {b.location} · 余额 {qty(b.remainingQuantity)} {b.unit}</option>)}</select></label><label>本期数量 *<input required inputMode="decimal" value={r.quantity} maxLength={30} onChange={e=>update(i,'quantity',e.target.value)}/></label><label>计量依据<input value={r.note||''} maxLength={500} onChange={e=>update(i,'note',e.target.value)}/></label></div>
      {item&&<dl className="eng-boq-measure-balance"><div><dt>部位 / 单位</dt><dd>{item.location} / {item.unit}</dd></div><div><dt>含税单价</dt><dd>¥ {money(item.unitPrice)}</dd></div><div><dt>批准数量</dt><dd>{qty(item.quantity)}</dd></div><div><dt>已计量数量</dt><dd>{qty(item.usedQuantity)}</dd></div><div><dt>可用数量</dt><dd>{qty(item.remainingQuantity)}</dd></div><div><dt>剩余金额</dt><dd>¥ {money(item.remainingAmount)}</dd></div><div><dt>本行计量估价</dt><dd>{lineEstimate}</dd></div></dl>}</>:
      <div className="eng-measure-grid">{([['name','计量项目'],['location','部位 / 桩号'],['unit','计量单位'],['quantity','本期数量'],['unitPrice','含税单价（元）'],['note','计量依据']] as [keyof Line,string][]).map(([k,label])=><label key={k}>{label}{k!=='note'?' *':''}<input value={r[k]||''} required={k!=='note'} maxLength={k==='unit'?30:k==='note'?500:200} inputMode={['quantity','unitPrice'].includes(k)?'decimal':undefined} onChange={e=>update(i,k,e.target.value)}/></label>)}</div>}
      <label className="eng-measure-task-select">归属施工任务<select value={r.taskId||''} onChange={e=>update(i,'taskId',e.target.value)}><option value="">未归集到任务</option>{r.taskId&&!tasks.some(t=>t.id===r.taskId)&&<option value={r.taskId} disabled>原任务不可用，请改选或取消归属</option>}{tasks.filter(t=>t.state!=='cancelled'||t.id===r.taskId).map(t=><option key={t.id} value={t.id} disabled={t.state==='cancelled'}>{t.data.title} · {t.data.location}{t.state==='completed'?' · 已完成':t.state==='cancelled'?' · 已取消':''}</option>)}</select></label>
      <button type="button" className="text-button" disabled={rows.length===1} onClick={()=>onChange(JSON.stringify(rows.filter((_,n)=>n!==i)))}>移除第 {i+1} 项</button>
    </fieldset>;})}
    <div className="eng-actions"><button type="button" className="button" disabled={rows.length>=50} onClick={()=>onChange(JSON.stringify([...rows,blank(useBoq?'boq':'free')]))}>新增计量行</button><strong role="status">本期计量{useBoq?'估价':'金额'}：{total}</strong></div>
  </div>;
}
export function EngineeringMeasurementView({rows,tasks=[]}:{rows:any[];tasks?:MeasurementTask[]}){return <div className="eng-table-wrap"><table className="eng-table"><thead><tr><th>计量项目 / 部位</th><th>原归集任务 / 部位</th><th>数量 / 单位</th><th>单价（元）</th><th>合价（元）</th><th>依据</th></tr></thead><tbody>{rows.map((r,i)=>{const current=tasks.find(t=>t.id===r.taskId),changed=current&&(current.data.title!==r.taskTitle||current.data.location!==r.taskLocation);return <tr key={i}><td>{r.name}<small>{r.location}{r.boqItemId?` · 清单 ${r.code||r.boqItemId}`:''}</small></td><td>{r.taskId?<>{r.taskTitle||'原任务名称未记录'}<small>{r.taskLocation||'原部位未记录'}</small>{changed&&<small>当前：{current.data.title} · {current.data.location}</small>}{!current&&<small>当前任务不可用，原归属保留</small>}</>:'未归集'}</td><td>{r.quantity/1000} {r.unit}</td><td>{money(r.unitPrice)}</td><td>{money(r.amount)}</td><td>{r.note||'—'}</td></tr>;})}</tbody></table></div>;}


