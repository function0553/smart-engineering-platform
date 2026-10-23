import {readTemplatePhotoBytes} from './template-photo-original.mjs';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

let template = Buffer.alloc(0);
try {
  template = readFileSync(new URL('./templates/photo-archive.docx', import.meta.url));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}
export const photoTemplate = JSON.parse(readFileSync(new URL('./templates/photo-archive-roles.json', import.meta.url), 'utf8'));
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

export function validateArchivePhoto(photo) {
  const bytes = readTemplatePhotoBytes(photo.base64);
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error('单张照片限 5MB，请选择 PNG 或 JPEG 原图');
  let width, height;
  if (photo.mime === 'image/png') {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.subarray(12,16).toString() !== 'IHDR') throw new Error('照片内容与 PNG 类型不符');
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
  } else {
    if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.lastIndexOf(Buffer.from([255,217])) < 2) throw new Error('照片内容与 JPEG 类型不符');
    for (let at = 2; at + 8 < bytes.length;) {
      if (bytes[at++] !== 255) break;
      while (bytes[at] === 255) at++;
      const marker = bytes[at++]; if (marker === 218 || marker === 217) break;
      const length = bytes.readUInt16BE(at); if (length < 2 || at + length > bytes.length) break;
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) { height = bytes.readUInt16BE(at + 3); width = bytes.readUInt16BE(at + 5); break; }
      at += length;
    }
  }
  if (!width || !height || width > 16000 || height > 16000 || !((width === photo.width && height === photo.height) || (width === photo.height && height === photo.width))) throw new Error('照片尺寸无效，请重新选择图片');
  return bytes;
}

/** Clone the original paired-table pattern; original photo bytes are embedded intact. */
export function generatePhotoArchive(data, images) {
  const parts = unzipSync(template), byStage = new Map(); let pictureId = 1000;
  let rels = strFromU8(parts['word/_rels/document.xml.rels']), types = strFromU8(parts['[Content_Types].xml']);
  for (const photo of images) {
    const key = photo.segment_id + '/' + photo.stage_id;
    if (!byStage.has(key)) byStage.set(key, []);
    byStage.get(key).push(photo);
  }
  const drawing = photo => {
    if (!photo) return '<w:p></w:p>';
    const number = pictureId++, extension = photo.mime === 'image/png' ? 'png' : 'jpeg', filename = `archive-${photo.id}.${extension}`, rid = `rIdArchive${number}`;
    parts['word/media/' + filename] = new Uint8Array(photo.bytes);
    rels = rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${filename}"/></Relationships>`);
    if (!types.includes(`Extension="${extension}"`)) types = types.replace('</Types>', `<Default Extension="${extension}" ContentType="${photo.mime}"/></Types>`);
    const fit = Math.min(2_460_000 / photo.width, 1_570_000 / photo.height), cx = Math.round(photo.width * fit), cy = Math.round(photo.height * fit);
    return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="0" w:after="0"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${number}" name="施工影像${number}" descr="${xml(photo.caption || photo.name)}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="${filename}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  };
  const pages = [];
  for (const segment of data.segments) {
    const group = segment.stages.map(stage => byStage.get(segment.id + '/' + stage.id) || []);
    const count = Math.max(1, ...group.map(photos => photos.length));
    for (let page = 0; page < count; page++) for (let offset = 0; offset < segment.stages.length; offset += 8) {
      let rows = '';
      for (let i = offset; i < Math.min(offset + 8, segment.stages.length); i += 2) {
        let labels = photoTemplate.labels, pictures = photoTemplate.pictures;
        for (let j = 0; j < 2; j++) {
          const stage = segment.stages[i + j], photo = group[i + j]?.[page];
          const label = stage ? stage.name + (stage.completedAt ? ' ' + stage.completedAt : '') : '';
          labels = labels.replace(`{{LABEL${j}}}`, xml(label));
          pictures = pictures.replace(/<w:p(?=\s|>)[^>]*>[\s\S]*?<\/w:p>/g, p => p.includes(`{{IMAGE${j}}}`) ? drawing(photo) : p);
        }
        rows += labels + pictures;
      }
      const number = page * Math.ceil(segment.stages.length / 8) + offset / 8 + 1;
      const content = (segment.content || `${segment.start}～${segment.end}段`) + (number > 1 ? `（续${number}）` : '');
      pages.push(photoTemplate.table.replace('{{PROJECT}}', xml(data.projectName + (data.roadName ? '-' + data.roadName : '')))
        .replace('{{CONTENT}}', xml(content)).replace('{{DATE}}', xml(segment.completedAt)).replace('{{ROWS}}', rows));
    }
  }
  const tables = pages.join('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
  parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace(photoTemplate.bodyMarker, tables));
  parts['word/_rels/document.xml.rels'] = strToU8(rels); parts['[Content_Types].xml'] = strToU8(types);
  return Buffer.from(zipSync(parts, { level: 6 }));
}
