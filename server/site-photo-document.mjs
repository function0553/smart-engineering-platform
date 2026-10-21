import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import sharp from 'sharp';
import { siteWorkSteps } from './site-work-steps.mjs';

const template = readFileSync(new URL('./templates/site-photo-a4-aligned.docx', import.meta.url));
const rolesBytes=readFileSync(new URL('./templates/site-photo-ten-steps-roles.json', import.meta.url));
const roles = JSON.parse(rolesBytes.toString('utf8'));
if (createHash('sha256').update(template).digest('hex') !== roles.sourceSha256) throw new Error('照片模板与工序槽位不一致');
export const invalidXmlText = value => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/u.test(String(value ?? ''));
const xml = value => { if(invalidXmlText(value))throw new Error('文档文字包含无效字符');return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'})[c]); };
export const sitePhotoTemplateHash = roles.sourceSha256;
export const sitePhotoLayoutHash = createHash('sha256').update(readFileSync(new URL(import.meta.url))).update(rolesBytes).digest('hex');

// Only print derivatives are resized/oriented. Archive originals and their hashes are untouched.
export async function generateSitePhotoDocument(metadata, photos) {
  const parts = unzipSync(template);
  for (const name of Object.keys(parts)) if (name.startsWith('word/media/')) delete parts[name];
  let rels = strFromU8(parts['word/_rels/document.xml.rels']).replace(/<Relationship\b[^>]*\bType="[^"]*\/image"[^>]*\/?\s*>/g, '');
  let document = roles.documentXml;
  const compact = String(metadata.PROJECT||'').length>64 || String(metadata.ADDRESS||'').length>32 || String(metadata.LOCATION||'').length>24 || String(metadata.NUMBER||'').length>32;
  document=document.replace(/<w:trHeight w:val="(?:2172|2218|1828|1842)" w:hRule="atLeast"\s*\/>/g,`<w:trHeight w:val="${compact?1200:1800}" w:hRule="atLeast"/>`);
  for (const [key, value] of Object.entries(metadata)) document = document.replace('{{'+key+'}}', () => xml(value));
  for (let i = 0; i < siteWorkSteps.length; i++) {
    document = document.replace('{{STEP'+i+'}}', () => xml(siteWorkSteps[i].name));
    const photo = photos.find(p => p.step_id === siteWorkSteps[i].id);
    let content = '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Noto Sans CJK SC" w:eastAsia="Noto Sans CJK SC"/><w:sz w:val="20"/></w:rPr><w:t>未提供照片</w:t></w:r></w:p>';
    if (photo) {
      const {data, info} = await sharp(photo.bytes, {limitInputPixels: 40000000, failOn:'warning'}).rotate().resize({width:1200,height:690,fit:'contain',background:'#ffffff'}).flatten({background:'#ffffff'}).jpeg({quality:90}).toBuffer({resolveWithObject:true});
      const factor = Math.min(1828800/info.width, (compact?700000:1050000)/info.height), cx = Math.round(info.width*factor), cy = Math.round(info.height*factor), rid = 'rIdSiteStep'+i;
      parts['word/media/site-step-'+i+'.jpeg'] = data;
      rels = rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/site-step-${i}.jpeg"/></Relationships>`);
      content = `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0"/><w:snapToGrid w:val="0"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${900+i}" name="工序照片${i+1}" descr="${xml(photo.name)}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="site-step-${i}.jpeg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
    }
    document = document.replace(new RegExp('<w:p><w:r><w:t>\\{\\{IMAGE'+i+'\\}\\}</w:t></w:r></w:p>'), () => content);
  }
  if (/\{\{(?:IMAGE|STEP|PROJECT|ADDRESS|LOCATION|NUMBER|DATE)/.test(document)) throw new Error('照片模板存在未填充位置');
  // Explicit fallback avoids the original WPS-only font becoming invisible in Linux renderers.
  document = document.replace(/w:(?:ascii|hAnsi|eastAsia)="[^"]*"/g, a => a.replace(/="[^"]*"/, '="Noto Sans CJK SC"'));
  parts['word/document.xml'] = strToU8(document); parts['word/_rels/document.xml.rels'] = strToU8(rels);
  let types = strFromU8(parts['[Content_Types].xml']);
  if (!types.includes('Extension="jpeg"')) types = types.replace('</Types>','<Default Extension="jpeg" ContentType="image/jpeg"/></Types>');
  parts['[Content_Types].xml'] = strToU8(types);
  return Buffer.from(zipSync(parts,{level:6}));
}
