import {zipSync,strToU8} from 'fflate';

const XML='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const keys=['id','code','name','location','unit','quantity','unitPrice'];
const headers=['条目 ID','清单编码','清单名称','部位','计量单位','清单数量','含税单价'];
function text(value){
  const s=String(value??'');
  if(s.length>32767)throw new Error('模板单元格超过 32767 字符，请缩短内容');
  if(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/u.test(s)||/[\uD800-\uDFFF]/u.test(s))throw new Error('模板内容包含无效字符，请检查条目');
  return s.replace(/_x([0-9a-f]{4})_/gi,'_x005F_x$1_').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;').replace(/\r/g,'&#13;');
}
function sheet(rows,widths){
  const last=String.fromCharCode(64+widths.length);
  return XML+`<worksheet xmlns="${NS}"><dimension ref="A1:${last}${rows.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="24"/><cols>${widths.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${rows.map((row,i)=>`<row r="${i+1}" ht="${i?Math.min(409,Math.max(28,...row.map((v,j)=>String(v??'').split(/\r\n|\n|\r/).reduce((sum,line)=>sum+Math.max(1,Math.ceil(Array.from(line).reduce((n,c)=>n+(c.codePointAt(0)>255?2:1),0)/(widths[j]-2))),0)*17+6))):32}" customHeight="1">${row.map((v,j)=>`<c r="${String.fromCharCode(65+j)}${i+1}" s="${i?2:1}" t="inlineStr"><is><t xml:space="preserve">${text(v)}</t></is></c>`).join('')}</row>`).join('')}</sheetData><autoFilter ref="A1:${last}${rows.length}"/><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup orientation="landscape" paperSize="9" fitToWidth="1"/></worksheet>`;
}

/** Preserve IDs and exact decimal strings; importing still requires preview, save and independent approval. */
export function buildBoqImportTemplate(lines){
  if(!Array.isArray(lines)||lines.length>200)throw new Error('清单模板最多支持 200 条');
  const rows=[headers,...(lines.length?lines:[{}]).map(line=>{if(!line||typeof line!=='object')throw new Error('清单模板条目无效');return keys.map(key=>line[key]??'');})];
  const instructions=[['填写项目','填写说明'],
    ['使用顺序','在“清单导入”工作表填写 → 选择文件和字段 → 预览核对 → 确认替换编辑器条目 → 保存草稿 → 提交独立审批。导入本身不会保存或批准。'],
    ['条目 ID','已有条目请保留此列。新条目留空。不得复制其他合同或旧版本的 ID。已批准条目必须保留，停用时数量可填 0。'],
    ['未填写 ID','仅当编码、名称、部位、单位、含税单价五项完全匹配且只有一个候选条目时，预览才匹配现有 ID；仍需核对逐行结果。'],
    ['编码和单位','编码按文本保存，保留前导零；同编码不代表同一条目。已批准条目的编码、名称、部位、单位、含税单价不能修改。'],
    ['数量和单价','数量使用十进制，最多 3 位小数；含税单价单位为元，最多 2 位小数且大于 0。请填具体数值，不使用公式、千分位分隔符或货币符号。'],
    ['金额检查','逐行金额四舍五入到分后汇总。首次清单总额须等于合同有效金额；后续调整不能低于已计量数量和金额，后台保存、提交及审批时再次检查。'],
    ['替换范围','导入会替换当前编辑器的全部条目，请保留需要的旧条目并检查未保留的草稿条目数。最多 200 条；文件不超过 2 MiB。'],
    ['工作表','只选择“清单导入”工作表，表头为第 1 行，数据从第 2 行开始。请勿把本说明表或不同合同、多版本台账一起导入。'],
    ['文件留存','导入文件只在当前设备解析，后台保存的是确认后的清单条目。系统不会上传或留存原 Excel／CSV 文件，请自行保管原件。']];
  const styles=XML+`<styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Microsoft YaHei"/><color rgb="FF172B4D"/></font><font><b/><sz val="11"/><name val="Microsoft YaHei"/><color rgb="FFFFFFFF"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF234C77"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const parts={
    '[Content_Types].xml':XML+'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels':XML+`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml':XML+`<workbook xmlns="${NS}" xmlns:r="${REL}"><sheets><sheet name="清单导入" sheetId="1" r:id="rId1"/><sheet name="填写说明" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':XML+`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml':styles,
    'xl/worksheets/sheet1.xml':sheet(rows,[40,20,32,28,14,20,20]),
    'xl/worksheets/sheet2.xml':sheet(instructions,[22,104])
  };
  return zipSync(Object.fromEntries(Object.entries(parts).map(([path,xml])=>[path,strToU8(xml)])),{level:6});
}
