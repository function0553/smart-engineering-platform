import fields from '../shared/supervision-daily-fields.json';
export type SupervisionData = Record<string,string>;
export const blankSupervision = (): SupervisionData => Object.fromEntries(fields.map(f=>[f.key,'']));
export function SupervisionDailyFields({value,onChange}:{value:SupervisionData;onChange:(value:SupervisionData)=>void}) {
  return <fieldset className="site-record-span site-supervision-fields"><legend>监理日报在线正文</legend><p className="site-record-help site-record-span">草稿可以暂不填完。标 * 的内容在生成 Word 和归档前必填；未填写的选填项在文档中如实标注，人员姓名不作为电子签章。</p>{fields.map(f=><label key={f.key} className={f.kind==='textarea'?'site-record-span':''}>{f.label}{f.required?' *':''}{f.kind==='textarea'?<textarea rows={4} maxLength={f.maxLength} value={value[f.key]||''} onChange={e=>onChange({...value,[f.key]:e.target.value})}/>:<input maxLength={f.maxLength} value={value[f.key]||''} onChange={e=>onChange({...value,[f.key]:e.target.value})}/>}</label>)}</fieldset>;
}
export function SupervisionDailyBody({value}:{value:SupervisionData}) {
  return <section className="site-supervision-body" aria-label="监理日报在线正文"><h4>监理日报在线正文</h4><dl>{fields.map(f=><div key={f.key} className={f.kind==='textarea'?'site-record-span':''}><dt>{f.label}</dt><dd>{value[f.key]||'未填写'}</dd></div>)}</dl></section>;
}
