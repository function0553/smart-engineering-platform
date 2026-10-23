import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { z } from 'zod';
import { invalidXmlText } from './site-photo-document.mjs';
const fieldBytes=readFileSync(new URL('../shared/supervision-daily-fields.json',import.meta.url));
export const supervisionFields=JSON.parse(fieldBytes);
export const supervisionSchema=z.object(Object.fromEntries(supervisionFields.map(f=>[f.key,z.string().trim().max(f.maxLength).refine(s=>!invalidXmlText(s),'文字包含无效控制字符').default('')]))).strict();
let template = Buffer.alloc(0);
try {
  template = readFileSync(new URL('./templates/supervision-daily.docx', import.meta.url));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
export const supervisionTemplateHash=createHash('sha256').update(template).digest('hex');
export const supervisionLayoutHash=createHash('sha256').update(readFileSync(new URL(import.meta.url))).update(fieldBytes).digest('hex');
export function supervisionMissing(data){return supervisionFields.filter(f=>f.required&&!data?.[f.key]?.trim()).map(f=>f.label);}
const xml=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'})[c]);
export function generateSupervisionDocument(metadata,body){
  const data=supervisionSchema.parse(body),values={...metadata,...data};
  if(Object.values(values).some(invalidXmlText))throw new Error('监理日报包含无效字符');
  const parts=unzipSync(template);let document=strFromU8(parts['word/document.xml']);
  // Replace tokens using callbacks so dollar signs and XML input remain literal.
  document=document.replace(/\{\{([A-Za-z]+)\}\}/g,(_,key)=>{
    if(!Object.hasOwn(values,key))throw new Error('监理日报模板字段缺失');
    return String(values[key]||'未填写').split(/\r\n?|\n/).map(xml).join('</w:t><w:br/><w:t xml:space="preserve">');
  });
  parts['word/document.xml']=strToU8(document);return Buffer.from(zipSync(parts,{level:6}));
}
