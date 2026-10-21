import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { BOQ_IMPORT_LIMITS, readBoqImportFile, inferBoqImportMapping, previewBoqImport } from '../shared/engineering-boq-import.mjs';
import { buildBoqImportTemplate } from '../shared/engineering-boq-template.mjs';

const parseXml = xml => new DOMParser({ onError: level => { throw new Error(level); } }).parseFromString(xml, 'application/xml');
const ID1 = '00000000-0000-4000-8000-000000000001', ID2 = '00000000-0000-4000-8000-000000000002';
const ID3 = '00000000-0000-4000-8000-000000000003';
const header = ['条目 ID', '清单编码', '清单名称', '部位', '计量单位', '清单数量', '含税单价'];
const defaultLine = { code: '001', name: '混凝土', location: '一号楼', unit: 'm³', quantity: '10', unitPrice: '1.25' };
const edit = (change = {}) => ({ ...defaultLine, ...change });
const canonical = (change = {}) => ({ id: ID1, code: '001', name: '混凝土', location: '一号楼', unit: 'm³', quantity: 10000, unitPrice: 125, amount: 1250, ...change });
const cell = (text, kind = 'text', extra = {}) => ({ text: String(text), kind, ...extra });
const row = (number, values) => ({ number, cells: values.map(value => typeof value === 'object' ? value : cell(value)) });
const data = (line = defaultLine) => [line.id || '', line.code, line.name, line.location, line.unit, line.quantity, line.unitPrice];
const sheet = (lines = [data()]) => ({ id: '1', name: '清单', hidden: false, rows: [row(1, header), ...lines.map((value, i) => row(i + 2, value))] });
const preview = (selected = sheet(), rest = {}) => previewBoqImport({ sheet: selected, headerRow: 1, mapping: inferBoqImportMapping(selected, 1), existingLines: [], lockedLines: [], usedLines: [], effectiveAmount: 1250, isInitial: true, ...rest });
const xmlEscape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const cellXml = (r, value, { kind = 'text', formula } = {}) => `<s:c r="${r}"${kind === 'text' ? ' t="inlineStr"' : ''}>${formula === undefined ? '' : `<s:f>${xmlEscape(formula)}</s:f>`}${kind === 'text' ? `<s:is><s:t xml:space="preserve">${xmlEscape(value)}</s:t></s:is>` : `<s:v>${value}</s:v>`}</s:c>`;
const regularSheet = () => `<s:worksheet xmlns:s="${NS}"><s:sheetData><s:row r="1">${header.map((v, i) => cellXml(String.fromCharCode(65 + i) + '1', v)).join('')}</s:row><s:row r="2">${data().map((v, i) => cellXml(String.fromCharCode(65 + i) + '2', v)).join('')}</s:row></s:sheetData></s:worksheet>`;
function parts(overrides = {}) {
  return {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>',
    '_rels/.rels': `<p:Relationships xmlns:p="http://schemas.openxmlformats.org/package/2006/relationships"><p:Relationship Id="r1" Type="${REL}/officeDocument" Target="/xl/workbook.xml"/></p:Relationships>`,
    'xl/workbook.xml': `<s:workbook xmlns:s="${NS}" xmlns:r="${REL}"><s:sheets><s:sheet name="清单" sheetId="1" r:id="a"/></s:sheets></s:workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="a" Type="${REL}/worksheet" Target="worksheets/./sheet1.xml"/></Relationships>`,
    'xl/worksheets/sheet1.xml': regularSheet(), ...overrides,
  };
}
const zipParts = source => zipSync(Object.fromEntries(Object.entries(source).map(([name, value]) => [name, typeof value === 'string' ? strToU8(value) : value])));
const workbook = (overrides = {}) => zipParts(parts(overrides));
const read = bytes => readBoqImportFile(bytes, { filename: '清单.xlsx', parseXml });
const csv = (text, rest = {}) => readBoqImportFile(strToU8(text), { filename: '清单.csv', ...rest });

test('CSV parses quoted commas, escaped quotes, multiline values and CRLF without numeric coercion', () => {
  const parsed = csv('\uFEFF编码,名称,数量\r\n0001,"混凝土,\"\"特殊\"\"\n二层",1.001\r\n');
  assert.equal(parsed.sheets[0].rows.length, 2);
  assert.equal(parsed.sheets[0].rows[1].cells[0].text, '0001');
  assert.equal(parsed.sheets[0].rows[1].cells[1].text, '混凝土,"特殊"\n二层');
  assert.equal(parsed.sheets[0].rows[1].cells[2].text, '1.001');
  assert.throws(() => csv('a,"unterminated'), /未闭合/);
  assert.throws(() => csv('"a" trailing,b'), /非法字符/);
  assert.throws(() => csv('a"b,c'), /双引号/);
});

test('CSV handles UTF16 BOM and explicitly selected GB18030; invalid UTF8 is rejected', () => {
  const text = '编码,名称\n001,土方', le = Buffer.concat([Buffer.from([255, 254]), Buffer.from(text, 'utf16le')]);
  const be = Buffer.from(le); be[0] = 254; be[1] = 255; for (let i = 2; i < be.length; i += 2) [be[i], be[i + 1]] = [be[i + 1], be[i]];
  for (const bytes of [le, be]) assert.equal(readBoqImportFile(bytes, { filename: '1.csv' }).sheets[0].rows[1].cells[1].text, '土方');
  const gb = Uint8Array.from([0xb1, 0xe0, 0xc2, 0xeb, 44, 65]);
  assert.equal(readBoqImportFile(gb, { filename: '1.csv', encoding: 'gb18030' }).sheets[0].rows[0].cells[0].text, '编码');
  assert.throws(() => readBoqImportFile(gb, { filename: '1.csv' }), /编码/);
});

test('XLSX respects namespace prefixes and relationships, and preserves raw numeric lexemes', () => {
  let xml = regularSheet().replace(cellXml('F2', '10'), cellXml('F2', '1e1', { kind: 'number' })).replace(cellXml('G2', '1.25'), cellXml('G2', '1.25E+0', { kind: 'number' }));
  const parsed = read(workbook({ 'xl/worksheets/sheet1.xml': xml }));
  assert.equal(parsed.sheets[0].rows[1].cells[5].text, '1e1');
  assert.equal(parsed.sheets[0].rows[1].cells[5].kind, 'number');
  const checked = preview(parsed.sheets[0]); assert.equal(checked.allowed, true, JSON.stringify(checked.errors));
  assert.equal(checked.summary.totalAmount, 1250); assert.equal(checked.lines[0].quantity, '10');
});

test('actual downloadable template round trips approved IDs, Chinese headers, escapes, leading zeros and exact prices', () => {
  const line = edit({ id: ID1, name: '=literal _x0041_ 🏗', location: '一区\r\n二层', quantity: '0.005', unitPrice: '0.10' });
  const parsed = read(buildBoqImportTemplate([line])), selected = parsed.sheets[0];
  assert.equal(parsed.sheets.length, 2); assert.deepEqual(inferBoqImportMapping(selected, 1), { id: 0, code: 1, name: 2, location: 3, unit: 4, quantity: 5, unitPrice: 6 });
  assert.equal(selected.rows[1].cells[2].text, line.name);
  const checked = preview(selected, { existingLines: [line], lockedLines: [canonical({ name: line.name, location: line.location, quantity: 5, unitPrice: 10, amount: 0 })], isInitial: false, effectiveAmount: 0 });
  assert.equal(checked.allowed, true, JSON.stringify(checked.errors));
  assert.equal(checked.lines[0].id, ID1); assert.equal(checked.lines[0].code, '001'); assert.equal(checked.lines[0].name, line.name); assert.equal(checked.lines[0].unitPrice, '0.1');
  assert.equal(checked.summary.totalAmount, 0);
});

test('shared strings preserve rich text and literal Excel escapes while skipping phonetic annotation', () => {
  const shared = `<sst xmlns="${NS}"><si><r><t>000</t></r><r><t>1_x005F_x0041_</t></r><rPh><t>phonetic</t></rPh></si></sst>`;
  const rels = parts()['xl/_rels/workbook.xml.rels'].replace('</Relationships>', `<Relationship Id="strings" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`);
  const parsed = read(workbook({ 'xl/_rels/workbook.xml.rels': rels, 'xl/sharedStrings.xml': shared, 'xl/worksheets/sheet1.xml': regularSheet().replace(cellXml('B2', '001'), '<s:c r="B2" t="s"><s:v>0</s:v></s:c>') }));
  assert.equal(parsed.sheets[0].rows[1].cells[1].text, '0001_x0041_');
  assert.throws(() => read(workbook({ 'xl/worksheets/sheet1.xml': regularSheet().replace(cellXml('B2', '001'), '<s:c r="B2" t="s"><s:v>99</s:v></s:c>') })), /索引/);
});

test('formulas, merged mapped cells, spreadsheet errors and booleans are never applied', () => {
  const formulas = read(workbook({ 'xl/worksheets/sheet1.xml': regularSheet().replace(cellXml('F2', '10'), cellXml('F2', '10', { kind: 'number', formula: '5+5' })) }));
  const formula = preview(formulas.sheets[0]); assert.equal(formula.allowed, false); assert.match(formula.errors.find(e => e.field === 'quantity').message, /公式/); assert.deepEqual(formula.lines, []);
  const merged = read(workbook({ 'xl/worksheets/sheet1.xml': regularSheet().replace('</s:worksheet>', '<s:mergeCells><s:mergeCell ref="C2:D2"/></s:mergeCells></s:worksheet>') }));
  assert.equal(preview(merged.sheets[0]).allowed, false); assert.equal(merged.sheets[0].rows[1].cells[3].merged, true);
  for (const kind of ['error', 'boolean']) { const selected = sheet(); selected.rows[1].cells[2] = cell('#VALUE!', kind); assert.equal(preview(selected).allowed, false); }
});

test('XLSX exposes hidden worksheets and hidden rows without silently dropping them', () => {
  const parsed = read(workbook({ 'xl/workbook.xml': parts()['xl/workbook.xml'].replace('name="清单"', 'name="清单" state="hidden"'), 'xl/worksheets/sheet1.xml': regularSheet().replace('<s:row r="2">', '<s:row r="2" hidden="1">') }));
  assert.equal(parsed.sheets[0].hidden, true); assert.equal(parsed.sheets[0].rows.length, 2); assert.equal(parsed.warnings.length, 2);
});

test('file and workbook limits fail explicitly: bytes, rows, columns, cells and sheets', () => {
  assert.throws(() => readBoqImportFile(new Uint8Array(BOQ_IMPORT_LIMITS.fileBytes + 1), { filename: 'a.csv' }), /2 MiB/);
  assert.throws(() => csv('x\n'.repeat(5001)), /5000/);
  assert.throws(() => csv(Array(65).fill('x').join(',')), /64/);
  assert.throws(() => csv(Array(2000).fill(Array(51).fill('x').join(',')).join('\n')), /100000/);
  const manySheets = parts()['xl/workbook.xml'].replace('<s:sheet name="清单" sheetId="1" r:id="a"/>', Array.from({ length: 21 }, (_, i) => `<s:sheet name="表${i}" sheetId="${i + 1}" r:id="a"/>`).join(''));
  assert.throws(() => read(workbook({ 'xl/workbook.xml': manySheets })), /20/);
  for (const reference of ['BM2', 'A5001']) assert.throws(() => read(workbook({ 'xl/worksheets/sheet1.xml': regularSheet().replace('r="A2"', `r="${reference}"`) })), /5000|64/);
});

test('encrypted, macro, external, DTD, bad XML and unsupported workbooks fail closed', () => {
  assert.throws(() => readBoqImportFile(strToU8('not xls'), { filename: 'legacy.xls' }), /XLS/);
  assert.throws(() => readBoqImportFile(workbook(), { filename: 'a.xlsx' }), /解析器/);
  assert.throws(() => read(workbook({ 'xl/vbaProject.bin': new Uint8Array([1]) })), /宏/);
  assert.throws(() => read(workbook({ 'xl/_rels/unused.xml.rels': '<Relationships><Relationship Id="x" Target="https://example.invalid" TargetMode="External"/></Relationships>' })), /外部/);
  assert.throws(() => read(workbook({ 'xl/evil.xml': '<!DOCTYPE x [<!ENTITY a SYSTEM "file:///secret">]><x>&a;</x>' })), /DTD/);
  assert.throws(() => read(workbook({ 'xl/evil.xml': '<x>' })), /XML/);
  const encrypted = workbook(); const view = new DataView(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength);
  for (let i = 0; i < encrypted.length - 46; i++) if (view.getUint32(i, true) === 0x02014b50) { view.setUint16(i + 8, view.getUint16(i + 8, true) | 1, true); break; }
  assert.throws(() => read(encrypted), /加密/);
});

test('ZIP traversal, missing relationship target, corruption and actual inflation over a forged length are rejected', () => {
  assert.throws(() => read(workbook({ '../escaped.xml': '<x/>' })), /路径/);
  assert.throws(() => read(workbook({ 'xl/_rels/workbook.xml.rels': parts()['xl/_rels/workbook.xml.rels'].replace('worksheets/./sheet1.xml', '../../../escape.xml') })), /路径/);
  assert.throws(() => read(workbook({ 'xl/_rels/workbook.xml.rels': parts()['xl/_rels/workbook.xml.rels'].replace('worksheets/./sheet1.xml', 'missing.xml') })), /缺失/);
  assert.throws(() => read(workbook().slice(0, -8)), /截断/);
  const forged = workbook(), view = new DataView(forged.buffer, forged.byteOffset, forged.byteLength);
  for (let i = 0; i < forged.length - 46; i++) if (view.getUint32(i, true) === 0x02014b50) { const offset = view.getUint32(i + 42, true); view.setUint32(i + 24, 1, true); view.setUint32(offset + 22, 1, true); break; }
  assert.throws(() => read(forged), /长度/);
  assert.throws(() => read(workbook({ 'xl/huge.xml': new Uint8Array(BOQ_IMPORT_LIMITS.inflatedBytes + 1) })), /16 MiB/);
});

test('mapping finds exact supported aliases, refuses duplicate headers and reused columns', () => {
  const selected = sheet(); selected.rows[0].cells[2] = cell('编码');
  assert.equal(inferBoqImportMapping(selected, 1).code, -1); assert.equal(preview(selected).allowed, false);
  const source = sheet(), mapping = inferBoqImportMapping(source, 1); mapping.quantity = mapping.unitPrice;
  const checked = preview(source, { mapping }); assert.equal(checked.allowed, false); assert.match(checked.errors[0].message, /重复映射/);
});

test('initial blank editor and incomplete unapproved rows can be replaced, with explicit removal warnings', () => {
  const empty = { code: '', name: '', location: '', unit: '', quantity: '', unitPrice: '' };
  const checked = preview(sheet(), { existingLines: [empty] }); assert.equal(checked.allowed, true); assert.equal(checked.summary.removedDraftCount, 0);
  const incomplete = preview(sheet(), { existingLines: [empty, { ...empty, name: '未完成' }] });
  assert.equal(incomplete.allowed, true); assert.equal(incomplete.summary.removedDraftCount, 1); assert.ok(incomplete.warnings.some(w => /移除.*1/.test(w)));
});

test('initial totals and positive quantities are enforced with integer half-up cents', () => {
  const one = edit({ quantity: '0.005', unitPrice: '1' });
  const checked = preview(sheet([data(one)]), { effectiveAmount: 1 }); assert.equal(checked.allowed, true); assert.equal(checked.summary.totalAmount, 1);
  assert.equal(preview(sheet([data(one)]), { effectiveAmount: 2 }).allowed, false);
  assert.equal(preview(sheet([data(edit({ quantity: '0' }))]), { effectiveAmount: 0 }).allowed, false);
  const max = preview(sheet([data(edit({ quantity: '1000000', unitPrice: '10000' }))]), { effectiveAmount: 1e12 });
  assert.equal(max.allowed, true); assert.equal(max.summary.totalAmount, 1e12);
});

test('numeric scientific notation expands exactly but decimal text is never rounded or parsed loosely', () => {
  const selected = sheet([data(edit({ quantity: '0.001', unitPrice: '0.01' }))]);
  selected.rows[1].cells[5] = cell('1.000000000000000000e-3', 'number'); selected.rows[1].cells[6] = cell('1e-2', 'number');
  const checked = preview(selected, { effectiveAmount: 0, isInitial: false }); assert.equal(checked.allowed, true); assert.equal(checked.lines[0].quantity, '0.001'); assert.equal(checked.lines[0].unitPrice, '0.01');
  for (const value of ['1e3', '1,000', '¥1', '-1', '1.0001', '1x', 'Infinity', 'NaN']) assert.equal(preview(sheet([data(edit({ quantity: value }))])).allowed, false, value);
  for (const value of ['1.001', '0', '0.001', '1e2']) assert.equal(preview(sheet([data(edit({ unitPrice: value }))])).allowed, false, value);
  selected.rows[1].cells[5] = cell('1.000000000000000001e-3', 'number'); assert.equal(preview(selected, { isInitial: false }).allowed, false);
});

test('explicit IDs and exact five-field matching preserve approved identity, including same-code distinct rows', () => {
  const base = canonical(), old = edit({ id: ID1 });
  const options = { existingLines: [old], lockedLines: [base], isInitial: false };
  const implicit = preview(sheet(), options); assert.equal(implicit.allowed, true); assert.equal(implicit.lines[0].id, ID1); assert.equal(implicit.rows[0].action, 'matched');
  const changedQty = preview(sheet([data(edit({ id: ID1, quantity: '20' }))]), options); assert.equal(changedQty.allowed, true); assert.equal(changedQty.summary.deltaAmount, 1250);
  const changedPrice = preview(sheet([data(edit({ id: ID1, unitPrice: '2' }))]), options); assert.equal(changedPrice.allowed, false); assert.ok(changedPrice.errors.some(e => /不可修改/.test(e.message)));
  const second = edit({ id: ID2, location: '二号楼' }), secondLocked = canonical({ id: ID2, location: '二号楼' });
  const distinct = preview(sheet([data(), data(edit({ location: '二号楼' }))]), { existingLines: [old, second], lockedLines: [base, secondLocked], isInitial: false });
  assert.equal(distinct.allowed, true); assert.deepEqual(distinct.lines.map(l => l.id), [ID1, ID2]);
});

test('ambiguous identities demand explicit IDs, while real duplicate identities with distinct explicit IDs remain possible', () => {
  const options = { existingLines: [edit({ id: ID1 }), edit({ id: ID2 })], lockedLines: [canonical(), canonical({ id: ID2 })], isInitial: false };
  assert.equal(preview(sheet([data(), data()]), options).allowed, false);
  const explicit = preview(sheet([data(edit({ id: ID1 })), data(edit({ id: ID2 }))]), options); assert.equal(explicit.allowed, true);
  assert.equal(preview(sheet([data(), data()]), { isInitial: false }).allowed, false);
  assert.equal(preview(sheet([data(edit({ id: ID1 })), data(edit({ id: ID1 }))]), options).allowed, false);
});

test('unknown and cross-contract IDs cannot create imported identities; missing approved rows reject the entire snapshot', () => {
  const options = { existingLines: [edit({ id: ID1 })], lockedLines: [canonical()], isInitial: false };
  const unknown = preview(sheet([data(edit({ id: ID3 }))]), options); assert.equal(unknown.allowed, false); assert.ok(unknown.errors.some(e => /不属于/.test(e.message)));
  const missing = preview(sheet([data(edit({ name: '另一项' }))]), options); assert.equal(missing.allowed, false); assert.deepEqual(missing.lines, []); assert.ok(missing.errors.some(e => /缺少已批准/.test(e.message)));
  const retired = preview(sheet([data(edit({ id: ID1, quantity: '0' }))]), options); assert.equal(retired.allowed, true);
});

test('both used quantity and used amount caps are checked, including rounding and legal zero-value rows', () => {
  const options = { existingLines: [edit({ id: ID1 })], lockedLines: [canonical()], usedLines: [{ id: ID1, usedQuantity: 6000, usedAmount: 750 }], isInitial: false };
  assert.equal(preview(sheet([data(edit({ id: ID1, quantity: '5' }))]), options).allowed, false);
  assert.equal(preview(sheet([data(edit({ id: ID1, quantity: '6' }))]), options).allowed, true);
  const rounding = { existingLines: [edit({ id: ID1, quantity: '0.001', unitPrice: '0.01' })], lockedLines: [canonical({ quantity: 1, unitPrice: 1, amount: 0 })], usedLines: [{ id: ID1, usedQuantity: 1, usedAmount: 1 }], isInitial: false };
  assert.equal(preview(sheet([data(rounding.existingLines[0])]), rounding).allowed, false);
  assert.equal(preview(sheet([data(rounding.existingLines[0])]), { ...rounding, usedLines: [] }).allowed, true);
});

test('unapproved editor lines may be edited or removed only with visible preview counts', () => {
  const pending = edit({ id: ID2, name: '旧草稿' });
  const changed = preview(sheet([data(edit({ id: ID2, name: '新草稿' }))]), { existingLines: [pending], isInitial: false });
  assert.equal(changed.allowed, true); assert.equal(changed.lines[0].id, ID2); assert.equal(changed.summary.removedDraftCount, 0);
  const removed = preview(sheet(), { existingLines: [pending], isInitial: false });
  assert.equal(removed.allowed, true); assert.equal(removed.summary.removedDraftCount, 1); assert.match(removed.warnings.join('\n'), /移除/);
});

test('partial rows and over-200 records reject atomically; explicit range exclusions remain visible warnings', () => {
  const partial = sheet([data(), ['', '02', '', '位置', 'm³', '1', '1']]);
  const bad = preview(partial); assert.equal(bad.allowed, false); assert.deepEqual(bad.lines, []); assert.equal(bad.rows.length, 2);
  const selected = sheet([data(), data(edit({ code: '002' }))]);
  const range = preview(selected, { endRow: 2 }); assert.equal(range.allowed, true); assert.equal(range.lines.length, 1); assert.ok(range.warnings.some(w => /范围之外已排除 1 个非空行：3/.test(w)));
  const tooMany = preview(sheet(Array.from({ length: 201 }, (_, i) => data(edit({ code: String(i) })))), { isInitial: false });
  assert.equal(tooMany.allowed, false); assert.equal(tooMany.rows.length, 201); assert.match(tooMany.errors.map(e => e.message).join('\n'), /200/);
});

test('XML structure and depth budgets reject before invoking any injected DOM parser', () => {
  for (const [xml, pattern] of [['<probe>' + '<n/>'.repeat(350000) + '</probe>', /350000/], ['<probe>' + '<n>'.repeat(64) + '</n>'.repeat(64) + '</probe>', /64/]]) {
    let invoked = false;
    assert.throws(() => readBoqImportFile(workbook({ 'xl/probe.xml': xml }), { filename: 'probe.xlsx', parseXml: () => { invoked = true; throw new Error('must not reach DOM'); } }), pattern);
    assert.equal(invoked, false);
  }
  const safe = read(workbook({ 'xl/probe.xml': '<probe a="&gt;"><![CDATA[<not-a-node/>]]><!-- <ignored/> --><n/></probe>' }));
  assert.equal(safe.sheets.length, 1);
});

test('comments, CDATA and processing instructions share the global pre-DOM structural-node budget', () => {
  const probes = ['<!--p-->', '<![CDATA[p]]>', '<?p value?>'].map(node => ({ 'xl/probe.xml': '<probe>' + node.repeat(350001) + '</probe>' }));
  probes.push({ 'xl/first.xml': '<probe>' + '<!--p-->'.repeat(180000) + '</probe>', 'xl/second.xml': '<probe>' + '<![CDATA[p]]>'.repeat(180000) + '</probe>' });
  for (const source of probes) {
    let parseXmlCalls = 0;
    assert.throws(() => readBoqImportFile(workbook(source), { filename: 'probe.xlsx', parseXml: () => { parseXmlCalls++; throw new Error('must not reach DOM'); } }), /结构节点.*350000/);
    assert.equal(parseXmlCalls, 0);
  }
  const valid = read(workbook({ 'xl/probe.xml': '<probe><?p value?><!--p--><![CDATA[p]]></probe>' }));
  assert.equal(valid.sheets.length, 1);
});

test('range exclusion warnings bound row listings and explain nonblank pre-header material', () => {
  const selected = { ...sheet(), rows: [row(1, ['说明']), row(2, header), row(3, data()), ...Array.from({ length: 24 }, (_, i) => row(i + 4, ['汇总说明']))] };
  const checked = preview(selected, { headerRow: 2, startRow: 3, endRow: 3, mapping: inferBoqImportMapping(selected, 2) });
  assert.equal(checked.allowed, true); assert.equal(checked.lines.length, 1);
  assert.ok(checked.warnings.some(w => /标题行之前已排除 1/.test(w)));
  assert.ok(checked.warnings.some(w => /范围之外已排除 24/.test(w) && /另 4 行/.test(w)));
});

test('blank rows are skipped, ignored populated columns are warned, and original editor inputs stay unchanged', () => {
  const selected = sheet([data(), ['', '', '', '', '', '', ''], [...data(edit({ code: '002' })), '备注不会保存']]);
  const before = JSON.stringify(selected), existing = [edit({ id: ID1 })], beforeExisting = JSON.stringify(existing);
  const checked = preview(selected, { existingLines: existing, isInitial: false });
  assert.equal(checked.allowed, true); assert.equal(checked.rows.length, 2); assert.ok(checked.warnings.some(w => /第 4 行未映射/.test(w)));
  assert.equal(JSON.stringify(selected), before); assert.equal(JSON.stringify(existing), beforeExisting);
});
