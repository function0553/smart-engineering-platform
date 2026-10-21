import { Inflate } from 'fflate';

// Import only prepares an editor value. It never creates identities, reserves
// quantities, saves business records, or replaces server approval validation.
export const BOQ_IMPORT_LIMITS = Object.freeze({ fileBytes: 2 * 1024 * 1024, inflatedBytes: 16 * 1024 * 1024, sheets: 20, rows: 5000, columns: 64, cells: 100000, lines: 200 });
const FIELDS = ['id', 'code', 'name', 'location', 'unit', 'quantity', 'unitPrice'];
const IDENTITY = ['code', 'name', 'location', 'unit', 'unitPrice'];
const MAX_AMOUNT = 1_000_000_000_000n, MAX_QUANTITY = 1_000_000_000n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const error = message => { throw new Error(message); };
const blank = () => ({ text: '', kind: 'blank' });
const nonempty = cell => !!cell && (cell.text.trim() !== '' || cell.formula !== undefined || cell.kind === 'error');
const isData = row => row.cells.some(nonempty);
const localName = node => node.localName || node.nodeName?.split(':').pop();
const children = (node, name) => Array.from(node.childNodes || []).filter(n => n.nodeType === 1 && (!name || localName(n) === name));
const descendants = (node, name) => Array.from(node.getElementsByTagName('*')).filter(n => localName(n) === name);
const attr = (node, name) => node.getAttribute(name) || '';
const roundAmount = (quantity, unitPrice) => (quantity * unitPrice + 500n) / 1000n;
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = (n & 1) ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }

function decode(bytes, encoding = 'utf-8') {
  let offset = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { encoding = 'utf-8'; offset = 3; }
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) { encoding = 'utf-16le'; offset = 2; }
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) { encoding = 'utf-16be'; offset = 2; }
  if (!['utf-8', 'utf-16le', 'utf-16be', 'gb18030'].includes(encoding.toLowerCase())) error('不支持该文本编码，请选择 UTF-8、UTF-16 或 GB18030');
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes.subarray(offset)); }
  catch { error('文件文本编码无效，请核对 CSV 编码或重新导出文件'); }
}

// Read the directory before inflating, then count actual streaming output too.
// A forged uncompressed size must not turn a small ZIP into an unbounded buffer.
function unzipBounded(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = p => view.getUint16(p, true), u32 = p => view.getUint32(p, true);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (u32(i) === 0x06054b50 && i + 22 + u16(i + 20) === bytes.length) { end = i; break; }
  if (end < 0) error('XLSX ZIP 目录损坏或文件被截断');
  const count = u16(end + 10), size = u32(end + 12), start = u32(end + 16);
  if (u16(end + 4) || u16(end + 6) || u16(end + 8) !== count || count === 65535 || count > 2048 || start + size !== end) error('不支持分卷、ZIP64 或异常 XLSX ZIP 目录');
  const entries = [], names = new Set(); let cursor = start, declared = 0;
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > end || u32(cursor) !== 0x02014b50) error('XLSX ZIP 文件条目损坏');
    const flags = u16(cursor + 8), method = u16(cursor + 10), checksum = u32(cursor + 16), compressed = u32(cursor + 20), expanded = u32(cursor + 24);
    const nameLength = u16(cursor + 28), extra = u16(cursor + 30), comment = u16(cursor + 32), offset = u32(cursor + 42);
    if (cursor + 46 + nameLength + extra + comment > end || !nameLength || u16(cursor + 34)) error('XLSX ZIP 条目目录无效');
    const name = decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (/^[\/]|\\|\x00/.test(name) || name.split('/').some(part => part === '..' || part === '.') || names.has(name)) error('XLSX ZIP 路径重复或不安全');
    if (flags & 0x41) error('不支持加密的 XLSX 文件');
    if (![0, 8].includes(method) || expanded === 0xffffffff || compressed === 0xffffffff) error('XLSX 使用不支持的压缩方式');
    declared += expanded;
    if (declared > BOQ_IMPORT_LIMITS.inflatedBytes) error('XLSX 解压内容超过 16 MiB 限制');
    if (offset + 30 > start || u32(offset) !== 0x04034b50 || u16(offset + 6) !== flags || u16(offset + 8) !== method) error('XLSX ZIP 本地条目与目录不一致');
    const localNameLength = u16(offset + 26), localExtra = u16(offset + 28), dataStart = offset + 30 + localNameLength + localExtra;
    if (dataStart + compressed > start || decode(bytes.subarray(offset + 30, offset + 30 + localNameLength)) !== name) error('XLSX ZIP 条目数据越界或名称不一致');
    if (!(flags & 8) && (u32(offset + 14) !== checksum || u32(offset + 18) !== compressed || u32(offset + 22) !== expanded)) error('XLSX ZIP 长度或校验信息不一致');
    names.add(name); entries.push({ name, method, checksum, compressed, expanded, dataStart }); cursor += 46 + nameLength + extra + comment;
  }
  if (cursor !== end) error('XLSX ZIP 目录长度不一致');
  const files = new Map(); let actualTotal = 0;
  for (const entry of entries) {
    const input = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressed), chunks = []; let length = 0;
    const accept = chunk => {
      length += chunk.length; actualTotal += chunk.length;
      if (length > entry.expanded || actualTotal > BOQ_IMPORT_LIMITS.inflatedBytes) error('XLSX 解压长度超限或与目录不一致');
      chunks.push(chunk);
    };
    if (entry.method === 0) accept(input);
    else {
      try {
        const stream = new Inflate(chunk => accept(chunk));
        for (let p = 0; p < input.length; p += 512) stream.push(input.subarray(p, p + 512), p + 512 >= input.length);
        if (!input.length) error('空压缩数据');
      } catch (fault) { error(`XLSX 压缩数据无效：${fault.message}`); }
    }
    if (length !== entry.expanded) error('XLSX 解压长度与目录不一致');
    const output = new Uint8Array(length); let p = 0; for (const chunk of chunks) { output.set(chunk, p); p += chunk.length; }
    if (crc32(output) !== entry.checksum) error('XLSX ZIP 校验失败，文件可能损坏');
    files.set(entry.name, output);
  }
  return files;
}

function inspectXml(text, budget) {
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text)) error('XLSX 不允许 DTD 或实体声明');
  let depth = 0, p = 0;
  while ((p = text.indexOf('<', p)) !== -1) {
    // Comments, CDATA and processing instructions also allocate DOM nodes.
    // Count every opening construct, including those outside the sheet data.
    if (text[p + 1] !== '/' && ++budget.nodes > 350000) error('XLSX XML 结构节点总数超过 350000 限制');
    if (text.startsWith('<!--', p)) { const end = text.indexOf('-->', p + 4); if (end < 0) error('XLSX XML 注释未闭合'); p = end + 3; continue; }
    if (text.startsWith('<![CDATA[', p)) { const end = text.indexOf(']]>', p + 9); if (end < 0) error('XLSX XML 文本未闭合'); p = end + 3; continue; }
    if (text.startsWith('<?', p)) { const end = text.indexOf('?>', p + 2); if (end < 0) error('XLSX XML 声明未闭合'); p = end + 2; continue; }
    let quote = '', end = p + 1;
    for (; end < text.length; end++) { const char = text[end]; if (quote) { if (char === quote) quote = ''; } else if (char === '"' || char === "'") quote = char; else if (char === '>') break; }
    if (end >= text.length) error('XLSX XML 标签未闭合');
    if (text[p + 1] === '!') error('XLSX XML 声明不受支持');
    if (text[p + 1] === '/') { if (--depth < 0) error('XLSX XML 标签层级无效'); }
    else {
      if (depth + 1 > 64) error('XLSX XML 嵌套层级超过 64 限制');
      if (!/\/\s*$/.test(text.slice(p + 1, end))) depth++;
    }
    p = end + 1;
  }
  if (depth) error('XLSX XML 标签未闭合');
}
function xmlDocument(text, parseXml, path) {
  let doc;
  try { doc = parseXml(text); } catch { error(`XLSX XML 无法解析：${path}`); }
  if (!doc?.documentElement || localName(doc.documentElement) === 'parsererror' || descendants(doc, 'parsererror').length) error(`XLSX XML 格式损坏：${path}`);
  return doc;
}
function resolvePart(source, target) {
  if (!target || /[\\\x00?#]/.test(target) || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) error('XLSX 存在外部或不安全的关系路径');
  let decoded;
  try { decoded = decodeURIComponent(target); } catch { error('XLSX 关系路径编码无效'); }
  if (/[\\\x00?#]/.test(decoded) || /^[a-z][a-z0-9+.-]*:/i.test(decoded) || decoded.startsWith('//')) error('XLSX 关系路径不安全');
  const parts = decoded.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) error('XLSX 关系路径超出工作簿'); parts.pop(); } else parts.push(part);
  }
  return parts.join('/');
}
const relationshipPath = source => { const parts = source.split('/'), name = parts.pop(); return [...parts, '_rels', name + '.rels'].join('/'); };
const unescapeExcel = value => value.replace(/_x([0-9a-f]{4})_/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
function richText(node) {
  const visit = n => children(n).map(child => localName(child) === 't' ? child.textContent || '' : localName(child) === 'rPh' ? '' : visit(child)).join('');
  return unescapeExcel(visit(node));
}
function coordinate(value) {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/i.exec(value);
  if (!match) error('XLSX 单元格坐标无效');
  let column = 0; for (const char of match[1].toUpperCase()) column = column * 26 + char.charCodeAt(0) - 64;
  const row = Number(match[2]);
  if (row > BOQ_IMPORT_LIMITS.rows || column > BOQ_IMPORT_LIMITS.columns) error('XLSX 工作表超过 5000 行或 64 列限制');
  return { row, column: column - 1 };
}
function readXlsx(bytes, parseXml) {
  if (typeof parseXml !== 'function') error('读取 XLSX 需要 XML 解析器');
  const files = unzipBounded(bytes), documents = new Map(), xmlTexts = new Map(), warnings = [], xmlBudget = { nodes: 0 };
  for (const [path, content] of files) {
    if (/vbaProject|activeX|externalLinks|(?:^|\/)workbook\.bin$/i.test(path)) error('不支持宏、外部链接或二进制工作簿内容');
    if (/\.xml$|\.rels$/i.test(path)) { const text = decode(content); inspectXml(text, xmlBudget); xmlTexts.set(path, text); }
  }
  for (const [path, text] of xmlTexts) documents.set(path, xmlDocument(text, parseXml, path));
  const types = documents.get('[Content_Types].xml');
  if (!types || descendants(types, 'Override').some(n => /macroEnabled|vbaProject/i.test(attr(n, 'ContentType')))) error('文件不是普通无宏 XLSX 工作簿');
  const rels = path => {
    const doc = documents.get(path); if (!doc) error(`XLSX 缺少关系文件：${path}`);
    const result = new Map();
    for (const node of children(doc.documentElement, 'Relationship')) {
      const id = attr(node, 'Id');
      if (!id || result.has(id)) error('XLSX 关系 ID 为空或重复');
      if (attr(node, 'TargetMode').toLowerCase() === 'external') error('XLSX 包含外部关系，不支持导入');
      result.set(id, { type: attr(node, 'Type'), target: attr(node, 'Target') });
    }
    return result;
  };
  // Check even unused relationship files; a hidden external relationship is not
  // made safe by merely skipping the sheet that contains it.
  for (const path of documents.keys()) if (path.endsWith('.rels')) {
    const source = path === '_rels/.rels' ? '' : path.replace(/(^|\/)\_rels\/([^/]+)\.rels$/, '$1$2');
    if (source === path) error('XLSX 关系文件路径无效');
    for (const rel of rels(path).values()) if (!files.has(resolvePart(source, rel.target))) error('XLSX 关系引用的内部文件缺失');
  }
  const rootRels = rels('_rels/.rels'), workbookRel = [...rootRels.values()].filter(r => /\/officeDocument$/.test(r.type));
  if (workbookRel.length !== 1) error('XLSX 工作簿关系缺失或重复');
  const workbookPath = resolvePart('', workbookRel[0].target), workbook = documents.get(workbookPath);
  if (!workbook || localName(workbook.documentElement) !== 'workbook') error('XLSX 缺少有效工作簿');
  const relationships = rels(relationshipPath(workbookPath));
  const sharedRel = [...relationships.values()].filter(r => /\/sharedStrings$/.test(r.type));
  if (sharedRel.length > 1) error('XLSX 共享字符串关系重复');
  let shared = [];
  if (sharedRel.length) {
    const doc = documents.get(resolvePart(workbookPath, sharedRel[0].target));
    if (!doc) error('XLSX 共享字符串文件缺失');
    shared = children(doc.documentElement, 'si').map(richText);
    if (shared.length > BOQ_IMPORT_LIMITS.cells) error('XLSX 共享字符串过多');
  }
  const sheetNodes = children(children(workbook.documentElement, 'sheets')[0] || {}, 'sheet');
  if (!sheetNodes.length || sheetNodes.length > BOQ_IMPORT_LIMITS.sheets) error('XLSX 必须包含 1 至 20 张工作表');
  const sheets = [], ids = new Set(), sheetPaths = new Set(); let cellCount = 0;
  for (const node of sheetNodes) {
    const relationId = Array.from(node.attributes || []).find(a => localName(a) === 'id')?.value;
    const rel = relationships.get(relationId), id = attr(node, 'sheetId'), name = attr(node, 'name');
    if (!id || !name || ids.has(id) || !rel || !/\/worksheet$/.test(rel.type)) error('XLSX 工作表标识或关系无效');
    ids.add(id); const path = resolvePart(workbookPath, rel.target), doc = documents.get(path);
    if (!doc || sheetPaths.has(path) || localName(doc.documentElement) !== 'worksheet') error('XLSX 工作表文件缺失或重复');
    sheetPaths.add(path);
    const rows = [], rowMap = new Map();
    for (const rowNode of children(children(doc.documentElement, 'sheetData')[0] || {}, 'row')) {
      const rawNumber = attr(rowNode, 'r'), number = rawNumber ? Number(rawNumber) : (rows.at(-1)?.number || 0) + 1;
      if (!Number.isInteger(number) || number < 1 || number > BOQ_IMPORT_LIMITS.rows || rowMap.has(number)) error('XLSX 行号重复或超过 5000 行限制');
      const row = { number, cells: [] }; const occupied = new Set();
      for (const cellNode of children(rowNode, 'c')) {
        const reference = attr(cellNode, 'r'), pos = reference ? coordinate(reference) : { row: number, column: row.cells.length };
        if (pos.row !== number || pos.column >= BOQ_IMPORT_LIMITS.columns || occupied.has(pos.column)) error('XLSX 单元格坐标重复或不属于当前行');
        occupied.add(pos.column);
        while (row.cells.length <= pos.column) { row.cells.push(blank()); if (++cellCount > BOQ_IMPORT_LIMITS.cells) error('工作簿单元格超过 100000 个限制'); }
        const type = attr(cellNode, 't'), value = children(cellNode, 'v')[0]?.textContent || '', formula = children(cellNode, 'f')[0];
        let cell;
        if (type === 's') { if (!/^\d+$/.test(value) || Number(value) >= shared.length) error('XLSX 共享字符串索引无效'); cell = { text: shared[Number(value)], kind: 'text' }; }
        else if (type === 'inlineStr') cell = { text: richText(children(cellNode, 'is')[0] || {}), kind: 'text' };
        else if (type === 'str' || type === 'd') cell = { text: unescapeExcel(value), kind: 'text' };
        else if (type === 'b') cell = { text: value, kind: 'boolean' };
        else if (type === 'e') cell = { text: value, kind: 'error' };
        else if (!type || type === 'n') cell = { text: value, kind: value ? 'number' : 'blank' };
        else error(`XLSX 含不支持的单元格类型：${type}`);
        if (formula) cell.formula = formula.textContent || '';
        row.cells[pos.column] = cell;
      }
      if (attr(rowNode, 'hidden') === '1') warnings.push(`工作表「${name}」第 ${number} 行隐藏，仍按原数据检查和导入`);
      rows.push(row); rowMap.set(number, row);
    }
    const merges = descendants(doc, 'mergeCell'); let mergedCount = 0;
    for (const merge of merges) {
      const pair = attr(merge, 'ref').split(':'); if (pair.length > 2) error('XLSX 合并单元格范围无效');
      const from = coordinate(pair[0]), to = coordinate(pair[1] || pair[0]);
      if (from.row > to.row || from.column > to.column) error('XLSX 合并单元格范围倒置');
      mergedCount += (to.row - from.row + 1) * (to.column - from.column + 1);
      if (mergedCount > BOQ_IMPORT_LIMITS.cells) error('XLSX 合并单元格范围过大');
      for (let r = from.row; r <= to.row; r++) {
        let row = rowMap.get(r); if (!row) { row = { number: r, cells: [] }; rows.push(row); rowMap.set(r, row); }
        while (row.cells.length <= to.column) { row.cells.push(blank()); if (++cellCount > BOQ_IMPORT_LIMITS.cells) error('工作簿单元格超过 100000 个限制'); }
        for (let c = from.column; c <= to.column; c++) row.cells[c].merged = true;
      }
    }
    rows.sort((a, b) => a.number - b.number);
    const hidden = ['hidden', 'veryHidden'].includes(attr(node, 'state'));
    if (hidden) warnings.push(`工作表「${name}」已隐藏，选择前请核对用途`);
    sheets.push({ id, name, hidden, rows });
  }
  return { format: 'xlsx', sheets, warnings };
}

function readCsv(bytes, filename, encoding) {
  const text = decode(bytes, encoding); if (text.includes('\x00')) error('CSV 含空字符，请核对文件编码');
  const rows = []; let cells = [], field = '', quoted = false, closed = false, fieldStarted = false, total = 0;
  const pushField = () => { if (cells.length >= BOQ_IMPORT_LIMITS.columns || ++total > BOQ_IMPORT_LIMITS.cells) error('CSV 超过 64 列或 100000 单元格限制'); cells.push({ text: field, kind: field ? 'text' : 'blank' }); field = ''; quoted = false; closed = false; fieldStarted = false; };
  const pushRow = () => { pushField(); if (rows.length >= BOQ_IMPORT_LIMITS.rows) error('CSV 超过 5000 行限制'); rows.push({ number: rows.length + 1, cells }); cells = []; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) { if (char === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } } else field += char; continue; }
    if (char === ',') { pushField(); continue; }
    if (char === '\r' || char === '\n') { pushRow(); if (char === '\r' && text[i + 1] === '\n') i++; continue; }
    if (closed) error('CSV 引号结束后存在非法字符');
    if (char === '"') { if (fieldStarted) error('CSV 非引号字段内出现双引号'); quoted = true; fieldStarted = true; }
    else { field += char; fieldStarted = true; }
  }
  if (quoted) error('CSV 引号未闭合');
  if (cells.length || fieldStarted || closed) pushRow();
  if (!rows.length) error('CSV 文件为空');
  return { format: 'csv', sheets: [{ id: 'csv', name: filename.replace(/^.*[\\/]/, ''), hidden: false, rows }], warnings: [] };
}

export function readBoqImportFile(input, { filename, encoding = 'utf-8', parseXml } = {}) {
  const bytes = input instanceof Uint8Array ? input : input instanceof ArrayBuffer ? new Uint8Array(input) : null;
  if (!bytes || !bytes.length) error('导入文件为空或格式无效');
  if (bytes.length > BOQ_IMPORT_LIMITS.fileBytes) error('导入文件超过 2 MiB 限制');
  if (typeof filename !== 'string') error('缺少导入文件名');
  if (/\.csv$/i.test(filename)) return readCsv(bytes, filename, encoding);
  if (!/\.xlsx$/i.test(filename)) error('仅支持普通 .xlsx 和 .csv；不支持 XLS、XLSM 或加密文件');
  return readXlsx(bytes, parseXml);
}

const aliases = {
  id: ['条目id', '清单条目id', '清单id', 'id', 'boqitemid'], code: ['编码', '清单编码', '条目编码', '项目编码', 'code'],
  name: ['名称', '项目名称', '清单名称', '条目名称', 'name'], location: ['部位', '施工部位', '位置', 'location'],
  unit: ['单位', '计量单位', 'unit'], quantity: ['数量', '工程量', '清单数量', 'quantity'], unitPrice: ['单价', '单价元', '含税单价', '含税单价元', '综合单价', '综合单价元', 'unitprice', 'unitpriceyuan'],
};
const headerKey = value => value.toLowerCase().replace(/[\s()（）_\-/]/g, '');
export function inferBoqImportMapping(sheet, headerRow) {
  const row = sheet.rows.find(r => r.number === headerRow), mapping = {};
  for (const field of FIELDS) {
    const indices = (row?.cells || []).flatMap((cell, i) => aliases[field].includes(headerKey(cell.text.trim())) ? [i] : []);
    mapping[field] = indices.length === 1 ? indices[0] : -1;
  }
  return mapping;
}

// Expansion operates on digits, never on IEEE floating point. XLSX numeric cells
// can use exponent notation; user text deliberately retains stricter decimals.
function numericLexeme(text) {
  const match = /^([+]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) error('数值格式无效');
  const fraction = match[3] || '', exponent = Number(match[4] || 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100 || match[2].length + fraction.length > 200) error('数值超出允许范围');
  const digits = match[2] + fraction, point = match[2].length + exponent;
  let result = point <= 0 ? '0.' + '0'.repeat(-point) + digits : point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point);
  result = result.replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  return result;
}
function scaled(text, digits, max, min = 0n, numeric = false) {
  const value = numeric ? numericLexeme(text.trim()) : text.trim();
  if (!new RegExp(`^\\d+(?:\\.\\d{1,${digits}})?$`).test(value)) error(`仅支持非负十进制数，最多 ${digits} 位小数`);
  if (value.length > 100) error('数值超出允许范围');
  const [whole, decimal = ''] = value.split('.'), integer = BigInt(whole) * 10n ** BigInt(digits) + BigInt(decimal.padEnd(digits, '0'));
  if (integer < min || integer > max) error('数值超出允许范围');
  return integer;
}
function decimal(integer, digits) {
  const scale = 10n ** BigInt(digits), fraction = (integer % scale).toString().padStart(digits, '0').replace(/0+$/, '');
  return (integer / scale).toString() + (fraction ? '.' + fraction : '');
}
const identityKey = line => JSON.stringify([line.code.trim(), line.name.trim(), line.location.trim(), line.unit.trim(), line.price.toString()]);
function existingIdentity(line, canonical = false) {
  const price = canonical ? BigInt(line.unitPrice) : scaled(line.unitPrice, 2, MAX_AMOUNT, 1n);
  return { ...line, price };
}

export function previewBoqImport({ sheet, headerRow, startRow = headerRow + 1, endRow, mapping, existingLines = [], lockedLines = [], usedLines = [], effectiveAmount, isInitial } = {}) {
  const errors = [], warnings = [], rows = [], output = [];
  const add = (row, field, message, local) => { const fault = { row, field, message }; errors.push(fault); local?.push(fault); };
  const finish = (total = 0n, removedDraftCount = 0) => ({ allowed: !errors.length, rows, errors, warnings, lines: errors.length ? [] : output, summary: { rowCount: rows.length, newCount: rows.filter(r => r.action === 'new').length, matchedCount: rows.filter(r => r.action === 'matched').length, removedDraftCount, totalAmount: total <= MAX_AMOUNT ? Number(total) : 0, deltaAmount: total <= MAX_AMOUNT && Number.isSafeInteger(effectiveAmount) ? Number(total) - effectiveAmount : 0 } });
  if (!sheet || !Array.isArray(sheet.rows)) { add(0, '*', '未选择有效工作表'); return finish(); }
  const last = Math.max(0, ...sheet.rows.map(r => r.number)); endRow ??= last;
  if (!Number.isInteger(headerRow) || headerRow < 1 || !Number.isInteger(startRow) || startRow <= headerRow || !Number.isInteger(endRow) || endRow < startRow || endRow > BOQ_IMPORT_LIMITS.rows || last > BOQ_IMPORT_LIMITS.rows) { add(0, '*', '标题行或数据范围无效'); return finish(); }
  if (!Number.isSafeInteger(effectiveAmount) || effectiveAmount < 0 || BigInt(effectiveAmount) > MAX_AMOUNT) { add(0, '*', '有效合同金额无效，请刷新项目'); return finish(); }
  const columns = [];
  for (const field of FIELDS) {
    const column = mapping?.[field];
    if (!Number.isInteger(column) || column < (field === 'id' ? -1 : 0) || column >= BOQ_IMPORT_LIMITS.columns) add(headerRow, field, field === 'id' ? '条目 ID 列映射无效' : '请选择该字段对应的列');
    else if (column >= 0) { if (columns.includes(column)) add(headerRow, field, '同一列不能重复映射到多个字段'); columns.push(column); }
  }
  if (errors.length) return finish();
  const meaningfulExisting = existingLines.filter(line => ['id', ...IDENTITY, 'quantity'].some(field => String(line[field] ?? '').trim() !== ''));
  const existing = new Map(), locked = new Map(), identities = new Map(), used = new Map();
  const addIdentity = line => { const key = identityKey(line), collection = identities.get(key) || new Map(); collection.set(line.id || `unsaved:${collection.size}`, line); identities.set(key, collection); };
  try {
    for (const raw of meaningfulExisting) {
      let line; try { line = existingIdentity(raw); } catch { line = { ...raw, price: null }; }
      if (line.id) { if (existing.has(line.id)) error('编辑器条目 ID 重复'); existing.set(line.id, line); }
      if (line.price !== null && ['code', 'name', 'location', 'unit'].every(field => line[field]?.trim())) addIdentity(line);
    }
    for (const raw of lockedLines) {
      if (!UUID.test(raw.id) || !Number.isSafeInteger(raw.quantity) || raw.quantity < 0 || !Number.isSafeInteger(raw.unitPrice) || raw.unitPrice < 1) error('已批准清单快照无效');
      const line = existingIdentity(raw, true); if (locked.has(line.id)) error('已批准条目 ID 重复'); locked.set(line.id, line);
      if (!existing.has(line.id)) existing.set(line.id, line);
      addIdentity(line);
    }
    for (const row of usedLines) {
      if (!Number.isSafeInteger(row.usedQuantity) || row.usedQuantity < 0 || !Number.isSafeInteger(row.usedAmount) || row.usedAmount < 0 || used.has(row.id)) error('当前计量用量无效，请刷新项目');
      used.set(row.id, row);
    }
  } catch (fault) { add(0, '*', fault.message); return finish(); }
  const seenIds = new Set(), seenIdentities = new Map(), keptDrafts = new Set(), excludedBefore = [], excludedAfter = []; let total = 0n;
  for (const source of sheet.rows) {
    if (!isData(source) || source.number === headerRow) continue;
    if (source.number < headerRow) { excludedBefore.push(source.number); continue; }
    if (source.number < startRow || source.number > endRow) { excludedAfter.push(source.number); continue; }
    const local = [], values = {}, numeric = {};
    for (const field of FIELDS) {
      const cell = mapping[field] >= 0 ? source.cells[mapping[field]] || blank() : blank(); values[field] = cell.text.trim(); numeric[field] = cell.kind === 'number';
      if (cell.formula !== undefined) add(source.number, field, '公式单元格不能导入，请转为已核实的固定值', local);
      if (cell.merged) add(source.number, field, '映射字段包含合并单元格，请拆分并补齐数据', local);
      if (cell.kind === 'error' || cell.kind === 'boolean') add(source.number, field, '不支持错误值或布尔值', local);
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(values[field])) add(source.number, field, '字段包含非法控制字符', local);
    }
    const ignored = source.cells.flatMap((cell, i) => !columns.includes(i) && nonempty(cell) ? [i + 1] : []);
    if (ignored.length) warnings.push(`第 ${source.number} 行未映射的第 ${ignored.join('、')} 列不会导入`);
    for (const [field, max] of [['code', 80], ['name', 200], ['location', 200], ['unit', 30]]) if (!values[field] || values[field].length > max) add(source.number, field, `字段必填且不得超过 ${max} 个字符`, local);
    if (values.id && !UUID.test(values.id)) add(source.number, 'id', '条目 ID 不是有效 UUID', local);
    let quantity, price, amount = null;
    try { quantity = scaled(values.quantity, 3, MAX_QUANTITY, 0n, numeric.quantity); } catch (fault) { add(source.number, 'quantity', fault.message, local); }
    try { price = scaled(values.unitPrice, 2, MAX_AMOUNT, 1n, numeric.unitPrice); } catch (fault) { add(source.number, 'unitPrice', fault.message, local); }
    let line = null, action = 'invalid';
    if (quantity !== undefined && price !== undefined) {
      const candidate = { code: values.code, name: values.name, location: values.location, unit: values.unit, quantity: decimal(quantity, 3), unitPrice: decimal(price, 2) };
      const key = identityKey({ ...candidate, price }); let matched = null;
      if (values.id) {
        matched = existing.get(values.id);
        if (!matched) add(source.number, 'id', '条目 ID 不属于当前清单或正在编辑的草稿；新增条目请留空 ID', local);
      } else {
        const matches = [...(identities.get(key)?.values() || [])];
        if (matches.length > 1) add(source.number, 'id', '相同编码、名称、部位、单位和单价对应多条现有条目，请填写明确的条目 ID', local);
        else if (matches.length === 1) matched = matches[0];
      }
      if (matched?.id) candidate.id = matched.id;
      action = matched ? 'matched' : 'new';
      if (candidate.id) {
        if (seenIds.has(candidate.id)) add(source.number, 'id', '同一条目 ID 在文件中重复', local);
        seenIds.add(candidate.id); keptDrafts.add(candidate.id);
        const original = locked.get(candidate.id);
        if (original && identityKey(original) !== key) add(source.number, 'id', '已批准条目的编码、名称、部位、单位和单价不可修改；变价须新增条目并保留旧条目', local);
      }
      const duplicate = seenIdentities.get(key) || [];
      // Explicit distinct IDs preserve legitimate historical duplicate identities.
      if (duplicate.length && (!values.id || duplicate.some(previous => !previous.explicitId))) add(source.number, 'id', '重复身份条目无法自动区分，请为现有条目填写各自的 ID，或调整新增条目身份', local);
      duplicate.push({ explicitId: values.id }); seenIdentities.set(key, duplicate);
      const cents = roundAmount(quantity, price);
      if (cents > MAX_AMOUNT) add(source.number, 'unitPrice', '该行金额超过允许上限', local);
      else amount = Number(cents);
      const consumption = candidate.id ? used.get(candidate.id) : null;
      if (consumption && (quantity < BigInt(consumption.usedQuantity) || cents < BigInt(consumption.usedAmount))) add(source.number, 'quantity', '数量或金额低于当前有效已批准计量，请先办理计量纠错', local);
      line = candidate;
      if (!local.length) { output.push(candidate); total += cents; }
    }
    rows.push({ sourceRow: source.number, action: local.length ? 'invalid' : action, line, amount, errors: local });
  }
  const reportExcluded = (numbers, label) => { if (numbers.length) warnings.push(`${label}已排除 ${numbers.length} 个非空行：${numbers.slice(0, 20).join('、')}${numbers.length > 20 ? `，另 ${numbers.length - 20} 行` : ''}；这些行不会导入，请核对选择范围`); };
  reportExcluded(excludedBefore, '标题行之前'); reportExcluded(excludedAfter, '所选数据范围之外');
  if (!rows.length) add(0, '*', '没有可导入的数据行');
  if (rows.length > BOQ_IMPORT_LIMITS.lines) add(0, '*', '完整清单不得超过 200 行；不会截断导入');
  for (const original of locked.values()) if (!seenIds.has(original.id)) add(0, 'id', `缺少已批准条目「${original.code} / ${original.name}」；完整清单必须保留，停用请将数量设为 0`);
  if (total > MAX_AMOUNT) add(0, '*', '清单总额超过允许上限');
  if (isInitial && !output.some(line => scaled(line.quantity, 3, MAX_QUANTITY) > 0n)) add(0, 'quantity', '初始清单至少需要一项正数量');
  if (isInitial && !rows.some(row => row.errors.length) && total !== BigInt(effectiveAmount)) add(0, '*', '初始清单合计必须等于当前有效合同额');
  const remainingUnsaved = new Map();
  for (const line of output.filter(line => !line.id)) { const key = identityKey(existingIdentity(line)); remainingUnsaved.set(key, (remainingUnsaved.get(key) || 0) + 1); }
  let removed = 0;
  for (const line of meaningfulExisting) if (!line.id || !locked.has(line.id)) {
    if (line.id) { if (!keptDrafts.has(line.id)) removed++; }
    else { let key; try { key = identityKey(existingIdentity(line)); } catch { key = null; } const count = remainingUnsaved.get(key) || 0; if (count) remainingUnsaved.set(key, count - 1); else removed++; }
  }
  if (removed) warnings.push(`应用将移除编辑器中 ${removed} 条尚未批准且文件未保留的草稿条目`);
  warnings.push('预览不保留额度；保存、提交和批准仍由服务器按最新清单版本及计量用量复核');
  return finish(total, removed);
}
