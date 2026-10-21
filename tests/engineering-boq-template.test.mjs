import test from 'node:test';
import assert from 'node:assert/strict';
import {unzipSync,strFromU8} from 'fflate';
import {DOMParser} from '@xmldom/xmldom';
import {buildBoqImportTemplate} from '../shared/engineering-boq-template.mjs';

const parse=xml=>new DOMParser({onError:level=>{throw new Error(level);}}).parseFromString(xml,'application/xml');
const line={id:'00000000-0000-4000-8000-000000000001',code:'00001',name:'=1+2 & <土方> _x0041_ 🏗',location:'第一段\r\n第二段',unit:'m³',quantity:'1000000.000',unitPrice:'0.01'};
test('template keeps IDs, leading zeros, exact decimals and formula-like names as text in a valid two-sheet workbook',()=>{
  const parts=unzipSync(buildBoqImportTemplate([line]));
  for(const [path,bytes] of Object.entries(parts))if(path.endsWith('.xml')||path.endsWith('.rels'))assert.ok(parse(strFromU8(bytes)).documentElement,path);
  const xml=strFromU8(parts['xl/worksheets/sheet1.xml']),doc=parse(xml);
  assert.equal(doc.getElementsByTagName('f').length,0);
  const rows=doc.getElementsByTagName('row');assert.equal(rows.length,2);
  const cells=Array.from(rows[1].getElementsByTagName('c'));
  assert.ok(cells.every(c=>c.getAttribute('t')==='inlineStr'));
  const values=cells.map(c=>c.textContent);
  assert.deepEqual(values,[line.id,'00001','=1+2 & <土方> _x005F_x0041_ 🏗',line.location,'m³','1000000.000','0.01']);
  assert.equal(parse(strFromU8(parts['xl/workbook.xml'])).getElementsByTagName('sheet').length,2);
  assert.match(strFromU8(parts['xl/worksheets/sheet2.xml']),/不会上传或留存/);
});
test('blank template supplies one fillable row and refuses truncation or invalid XML text',()=>{
  const empty=unzipSync(buildBoqImportTemplate([]));
  assert.equal(parse(strFromU8(empty['xl/worksheets/sheet1.xml'])).getElementsByTagName('row').length,2);
  assert.throws(()=>buildBoqImportTemplate(Array(201).fill(line)),/200/);
  assert.throws(()=>buildBoqImportTemplate([{...line,name:'a\u0000b'}]),/无效字符/);
  assert.throws(()=>buildBoqImportTemplate([{...line,name:'a'.repeat(32768)}]),/32767/);
  assert.throws(()=>buildBoqImportTemplate([{...line,name:'\uD800'}]),/无效字符/);
});
