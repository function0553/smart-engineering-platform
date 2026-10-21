import {prepareTemplatePhoto,readTemplatePhotoBytes} from './template-photo-original.mjs';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { weatherLocationSchema, weatherInfoSchema } from './daily-report-weather.mjs';

const template = readFileSync(new URL('./templates/daily-report.docx', import.meta.url));
const { roles } = JSON.parse(readFileSync(new URL('./templates/daily-report-roles.json', import.meta.url), 'utf8'));
const text = max => z.string().trim().max(max).refine(v => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v), '文字包含不支持的控制字符');
const required = max => text(max).pipe(z.string().min(1, '请填写此项'));
const quantity = text(24).refine(v => /^\d{1,10}(?:\.\d{1,4})?$/.test(v), '请输入非负数，最多4位小数');
const optionalQuantity = z.union([z.literal(''), quantity]);
const count = text(10).refine(v => v === '' || /^\d{1,7}$/.test(v), '请输入整数人数，未核实可留空');
const section = z.object({
  name: required(100), kind: z.enum(['pipeline', 'meter']), designQuantity: quantity,
  todayProgress: quantity, cumulativeProgress: quantity,
  works: z.array(z.object({ name: required(80), quantity: optionalQuantity, unit: required(12) }).strict()).max(40),
  todayNotes: text(2000), machinery: text(1000), workers: count, security: text(100),
  tomorrow: required(2000), procedures: text(2000), difficulties: text(2000),
}).strict().superRefine((v, ctx) => {
  if (v.kind === 'pipeline') for (const key of ['todayProgress', 'cumulativeProgress']) if (Number(v[key]) > 100) ctx.addIssue({ code: 'custom', path: [key], message: '占比不能超过100%' });
  if (!v.todayNotes && !v.works.some(w => w.quantity !== '')) ctx.addIssue({ code: 'custom', path: ['todayNotes'], message: '请填写已完成工序数量，或说明当天未施工的情况' });
});
export const dailyReportSchema = z.object({
  projectName: required(150), region: required(100), reportDate: z.iso.date(), number: text(60), weather: required(100),
  weatherAuto: z.boolean().optional(), weatherLocation: weatherLocationSchema.optional(), weatherInfo: weatherInfoSchema.optional(),
  sections: z.array(section).min(1, '请至少保留一个施工片区').max(12), nextPlan: required(4000), otherItems: text(4000),
  photos: z.array(z.object({ name: required(180), caption: text(500), mime: z.enum(['image/png', 'image/jpeg']), base64: z.string().max(7_000_000), width: z.number().int().min(1).max(16000), height: z.number().int().min(1).max(16000) }).strict()).max(12),
}).strict().superRefine((v,ctx) => {
  if (v.weatherAuto && (!v.weatherInfo || v.weatherInfo.date !== v.reportDate || v.weatherInfo.latitude !== v.weatherLocation?.latitude || v.weatherInfo.longitude !== v.weatherLocation?.longitude || v.weather !== v.weatherInfo.condition)) ctx.addIssue({ code:'custom', path:['weather'], message:'自动天气尚未取得，或与当前日期和位置不符，请刷新天气或改为现场填写' });
});

const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const normalizeLines = value => value.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
const para = (role, label, value) => {
  const style = roles[role];
  const run = (t, pr) => `<w:r>${pr}<w:t xml:space="preserve">${xml(t)}</w:t></w:r>`;
  const properties = role === 'section' ? style.pPr.replace(/<w:keepNext[^>]*\/>/g, '').replace(/(<w:pPr>(?:<w:pStyle[^>]*\/>)?)/, '$1<w:keepNext/><w:spacing w:before="120"/>') : style.pPr;
  return `<w:p>${properties}${run(label, style.rPr)}${value === undefined ? '' : run(value, style.valuePr)}</w:p>`;
};
const list = value => normalizeLines(value).map((line, index) => para('normal', `（${index + 1}）${line}`)).join('');
const numbers = ['一','二','三','四','五','六','七','八','九','十','十一','十二'];
const missing = value => value === '' ? '未填写' : value;

function mainContent(report) {
  return para('region', report.region) + report.sections.map((s, index) => {
    const meter = s.kind === 'meter';
    const works = s.works.filter(w => w.quantity !== '').map(w => `${w.name}：${w.quantity}${w.unit}`);
    const lines = [...normalizeLines(s.todayNotes), ...works];
    return para('section', `${numbers[index]}、${s.name}`)
      + para('metric', meter ? '1、水表工程量：' : '1、管道设计工程量：', `${s.designQuantity}${meter ? '块' : '米'}。`)
      + para('metric', meter ? '2、今日完成工程量：' : '2、今日完成工程量占比：', `${s.todayProgress}${meter ? '块' : '%'}。`)
      + para('metric', meter ? '3、累计完成工程量：' : '3、累计完成工程量占比：', `${s.cumulativeProgress}${meter ? '块' : '%'}。`)
      + para('normal', '4、今日完成工作：') + list(lines.join('\n'))
      + para('normal', '5、施工人员及机械情况：')
      + para('normal', `（1）施工机械：${missing(s.machinery)}。`)
      + para('normal', `（2）施工作业人员：${s.workers === '' ? '未填写' : s.workers + '人'}。`)
      + para('normal', `（3）交通安保人员：${missing(s.security)}${/^\d+$/.test(s.security) ? '人' : ''}。`)
      + para('normal', '明日施工计划：') + list(s.tomorrow)
      + (!meter || s.procedures ? para('normal', `6、手续办理情况：${missing(s.procedures)}`) : '')
      + (!meter || s.difficulties ? para('normal', `7、工程难点及推进情况：${missing(s.difficulties)}`) : '');
  }).join('');
}

function photoContent(photos, parts) {
  let relationships = strFromU8(parts['word/_rels/document.xml.rels']);
  let types = strFromU8(parts['[Content_Types].xml']);
  let total = 0;
  const result = photos.map((photo, i) => {
    const bytes = readTemplatePhotoBytes(photo.base64); total += bytes.length;
    if (!bytes.length || bytes.length > 5 * 1024 * 1024 || total > 20 * 1024 * 1024) throw new Error('单张照片限5MB，合计限20MB');
    const png = photo.mime === 'image/png';
    if (png ? bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : bytes[0] !== 255 || bytes[1] !== 216 || bytes.lastIndexOf(Buffer.from([255,217])) < 2) throw new Error('照片内容与类型不一致，请重新选择PNG或JPEG图片');
    const extension = png ? 'png' : 'jpg', filename = `daily-report-${i + 1}.${extension}`, rid = `rIdDailyReport${i + 1}`;
    if (png && (bytes.readUInt32BE(16) !== photo.width || bytes.readUInt32BE(20) !== photo.height)) throw new Error('照片尺寸与文件不一致');
    parts[`word/media/${filename}`] = bytes;
    relationships = relationships.replace('</Relationships>', `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${filename}"/></Relationships>`);
    if (!types.includes(`Extension="${extension}"`)) types = types.replace('</Types>', `<Default Extension="${extension}" ContentType="${photo.mime}"/></Types>`);
    const factor = Math.min(2_950_000 / photo.width, 3_800_000 / photo.height);
    const cx = Math.round(photo.width * factor), cy = Math.round(photo.height * factor);
    return `<w:p><w:pPr><w:keepNext/><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${i + 100}" name="施工照片${i + 1}" descr="${xml(photo.caption || photo.name)}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="${filename}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>${para('normal', `图${i + 1} ${photo.caption || photo.name}`)}`;
  }).join('');
  if (photos.length) { parts['word/_rels/document.xml.rels'] = strToU8(relationships); parts['[Content_Types].xml'] = strToU8(types); }
  return result || para('normal', '');
}

export function generateDailyReport(input) {
  const report = dailyReportSchema.parse(input);
  const parts = unzipSync(template);
  let document = strFromU8(parts['word/document.xml']);
  // The reference positions the number with spaces and a first-line indent.
  // Use paragraph alignment so wrapped continuation lines stay at the right edge.
  document = document.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, p => {
    if (!p.includes('{{REPORT_NUMBER}}')) return p;
    return p.replace(/<w:ind\b[^>]*\/>/g, '').replace(/<w:jc\b[^>]*\/>/g, '')
      .replace('<w:pPr>', '<w:pPr><w:jc w:val="right"/><w:keepNext/><w:keepLines/>')
      .replace(/(<w:t\b[^>]*>)\s+(编\s*号：)/, '$1$2');
  });
  for (const [token, value] of Object.entries({ PROJECT_NAME: report.projectName, REPORT_NUMBER: report.number, WEATHER: report.weather, DATE: report.reportDate.replaceAll('-', '. ') })) document = document.replace(`{{${token}}}`, xml(value));
  const attribution=report.weatherAuto ? para('normal',`天气资料来源：Open-Meteo（https://open-meteo.com/），${report.reportDate}，${report.weatherInfo.kind==='forecast'?'预报资料':'历史天气资料'}。`) : '';
  const content = { MAIN_CONTENT: mainContent(report), NEXT_PLAN: normalizeLines(report.nextPlan).map((line, i) => para('normal', `${i + 1}.${line}`)).join(''), OTHER_ITEMS: normalizeLines(missing(report.otherItems)).map(x => para('normal', x)).join('')+attribution, PHOTOS: photoContent(report.photos, parts) };
  document = document.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, p => {
    const match = p.match(/\{\{(MAIN_CONTENT|NEXT_PLAN|OTHER_ITEMS|PHOTOS)\}\}/);
    return match ? content[match[1]] : p;
  });
  if (/\{\{[A-Z_]+\}\}/.test(document)) throw new Error('模板字段未完整替换');
  parts['word/document.xml'] = strToU8(document);
  // Word/WPS recalculates these statistics; copied page/word counts would be stale.
  if (parts['docProps/app.xml']) parts['docProps/app.xml'] = strToU8(strFromU8(parts['docProps/app.xml']).replace(/<(Pages|Words|Characters|Paragraphs|CharactersWithSpaces)>\d+<\/\1>/g, ''));
  return Buffer.from(zipSync(parts, { level: 6 }));
}

export function mountDailyReportRoutes(app, { auth, writer, mobileAuth, weatherService }) {
  const exporter = async (req, res, authorize) => {
    const parsed = dailyReportSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: '请检查日报内容', fields: parsed.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message })) });
    try {
      if (parsed.data.weatherAuto && weatherService) {
        const {latitude,longitude}=parsed.data.weatherLocation;
        const fresh = await weatherService({ date:parsed.data.reportDate, latitude, longitude });
        parsed.data.weather = fresh.condition; parsed.data.weatherInfo = fresh;
      }
      for(let i=0;i<parsed.data.photos.length;i++)parsed.data.photos[i]=await prepareTemplatePhoto(parsed.data.photos[i]);
      let stillAuthorized=false;authorize(req,res,()=>writer(req,res,()=>{stillAuthorized=true;}));if(!stillAuthorized)return;
      const bytes = generateDailyReport(parsed.data);
      const filename = `施工日报_${parsed.data.reportDate}.docx`;
      res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Content-Disposition': `attachment; filename="daily-report-${parsed.data.reportDate}.docx"; filename*=UTF-8''${encodeURIComponent(filename)}`, 'Cache-Control': 'no-store' });
      res.send(bytes);
    } catch (error) { res.status(error.status || 400).json({ error: error.message || '日报生成失败，请检查输入内容' }); }
  };
  app.post('/api/daily-report/export', auth, writer, (req,res)=>exporter(req,res,auth));
  if (mobileAuth) app.post('/api/mobile/daily-report/export', mobileAuth, writer, (req,res)=>exporter(req,res,mobileAuth));
}
