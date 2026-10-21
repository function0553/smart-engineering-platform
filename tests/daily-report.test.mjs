import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { unzipSync, strFromU8 } from 'fflate';
import { generateDailyReport, dailyReportSchema } from '../server/daily-report.mjs';
import { createApp } from '../server/app.mjs';
import { referenceReport } from './daily-report-fixture.mjs';

test('report replaces all daily values, escapes text, keeps zero and preserves template furniture', () => {
  const data = referenceReport(); data.projectName = '核对 <A&B> 工程'; data.weather = '阴'; data.reportDate = '2026-10-08';
  data.sections[0].works.push({ name: '空白工序不能导出', quantity: '', unit: 'm' }, { name: '零值工序', quantity: '0', unit: '座' });
  const result = unzipSync(generateDailyReport(data)); const document = strFromU8(result['word/document.xml']);
  assert.match(document, /核对 &lt;A&amp;B&gt; 工程/); assert.match(document, /2026\. 10\. 08/);
  assert.match(document, /零值工序：0座/); assert.match(document, /水表更换：0块/);
  assert.doesNotMatch(document, /空白工序不能导出|\{\{|2026\. 10\. 07|>晴</);
  const original = unzipSync(readFileSync(new URL('../server/templates/daily-report.docx', import.meta.url)));
  for (const [name, bytes] of Object.entries(original)) if (!['word/document.xml', 'docProps/app.xml'].includes(name)) assert.deepEqual(result[name], bytes, name);
  assert.equal(document.match(/<w:tbl>/g)?.length, 1); assert.equal(document.match(/<w:sectPr>/g)?.length, 1);
});
test('report rejects invalid dates, negative values, oversized ratios and blank activity without inventing numbers', () => {
  for (const change of [r => r.reportDate = '2026-02-30', r => r.sections[0].todayProgress = '-1', r => r.sections[0].todayProgress = '101', r => r.sections[0].workers = '1.5', r => r.projectName = '\u0000bad', r => { r.sections[0].works = []; r.sections[0].todayNotes = ''; }]) { const r = referenceReport(); change(r); assert.equal(dailyReportSchema.safeParse(r).success, false); }
});
test('empty, short and maximum-length report numbers use right aligned paragraphs without space padding or first-line indent', () => {
  for (const number of ['', 'A-01', 'TEST-SECTION-A-20261020', '施工日报编号'.repeat(10), 'A'.repeat(60), 'A<&>01']) {
    const data = referenceReport(); data.number = number;
    const xml = strFromU8(unzipSync(generateDailyReport(data))['word/document.xml']);
    const p = xml.match(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g).find(p => /编\s*号：/.test(p));
    assert.match(p, /<w:jc w:val="right"\/>/); assert.match(p, /<w:keepLines\/>/);
    assert.doesNotMatch(p, /<w:ind\b|<w:t[^>]*>\s+编/);
    assert.ok(p.includes(number.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;')));
  }
});
test('PNG evidence bytes, relationships and caption are preserved and invalid photo content is rejected', () => {
  const r = referenceReport();
  const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2ioAAAAASUVORK5CYII=';
  r.photos.push({ name: 'test.png', caption: '仅测试图片接口 <&>', mime: 'image/png', base64, width: 1, height: 1 });
  const output = unzipSync(generateDailyReport(r));
  assert.deepEqual(Buffer.from(output['word/media/daily-report-1.png']), Buffer.from(base64, 'base64'));
  assert.match(strFromU8(output['word/_rels/document.xml.rels']), /rIdDailyReport1/);
  assert.match(strFromU8(output['word/document.xml']), /仅测试图片接口 &lt;&amp;&gt;/);
  r.photos[0].width = 2; assert.throws(() => generateDailyReport(r), /尺寸/);
  r.photos[0].width = 1; r.photos[0].base64 = Buffer.from('<svg/>').toString('base64'); assert.throws(() => generateDailyReport(r), /类型不一致/);
});
test('export endpoint enforces session, write role, CSRF marker and returns usable docx without adding records', async t => {
  const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { app, store, vision } = createApp({ database: ':memory:', baseUrl, distPath: '__test_no_dist__' }); server.on('request', app);
  t.after(async () => { vision?.close?.(); await new Promise(resolve => server.close(resolve)); store.close(); });
  let cookie = '';
  const request = (path, body, extra = {}) => fetch(`${baseUrl}/api${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Workspace-Request': '1', Cookie: cookie, ...extra }, body: JSON.stringify(body) });
  assert.equal((await request('/daily-report/export', referenceReport())).status, 401);
  const setup = await request('/setup', { organization: '日报生成测试', username: 'report-test', name: '测试用户', password: 'test-only-report-9374' }); cookie = setup.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/daily-report/export', referenceReport(), { 'X-Workspace-Request': '' })).status, 403);
  const invalid = await request('/daily-report/export', { ...referenceReport(), weather: '' }); assert.equal(invalid.status, 400); assert.ok((await invalid.json()).fields.some(f => f.path === 'weather'));
  const result = await request('/daily-report/export', referenceReport()); assert.equal(result.status, 200); assert.match(result.headers.get('content-disposition'), /\.docx/);
  assert.ok(unzipSync(new Uint8Array(await result.arrayBuffer()))['word/document.xml']); assert.equal(store.db.prepare('SELECT COUNT(*) n FROM records').get().n, 0);
  await request('/users', { username: 'readonly-report', name: '只读', role: 'viewer', password: 'test-only-report-9374' });
  const login = await request('/login', { username: 'readonly-report', password: 'test-only-report-9374' }); cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/daily-report/export', referenceReport())).status, 403);
});
