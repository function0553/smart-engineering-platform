import sharp from 'sharp';

/** Decode bounded canonical base64 without a repeated capture group that overflows on phone-size photos. */
export function readTemplatePhotoBytes(base64) {
  if (typeof base64 !== 'string' || base64.length > 4*Math.ceil(5*1024*1024/3)) throw new Error('单张照片限5MB，请选择5MB以内的原图');
  if (base64.length%4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('照片编码无效');
  const bytes=Buffer.from(base64,'base64');
  if (bytes.toString('base64')!==base64) throw new Error('照片编码无效');
  if (!bytes.length || bytes.length>5*1024*1024) throw new Error('单张照片限5MB，请选择5MB以内的原图');
  return bytes;
}

/** Identify actual template-image content; keep every original byte, including camera trailers. */
export async function prepareTemplatePhoto(photo) {
  const bytes=readTemplatePhotoBytes(photo.base64);
  const png = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes.length >= 12 && bytes.subarray(0, 3).equals(Buffer.from([255,216,255]));
  if (!png && !jpeg) throw new Error('照片不是有效的PNG或JPEG原图，请重新选择');
  if (jpeg) {
    // Motion-photo/metadata bytes may follow EOI. A genuine decoder, rather than
    // the final two bytes, decides validity. Decode fully with shrink-on-load off.
    let metadata;
    try {
      if (bytes.lastIndexOf(Buffer.from([255,217])) < 2) throw new Error('Missing JPEG EOI');
      const image = sharp(bytes, {failOn:'warning', limitInputPixels:16000*16000});
      metadata = await image.metadata();
      if (metadata.format !== 'jpeg') throw new Error('Not JPEG');
      await image.resize({width:1,height:1,fastShrinkOnLoad:false}).raw().toBuffer();
    } catch { throw new Error('JPEG照片无法完整解码，可能已损坏或下载不完整，请重新选择原图'); }
    const {width,height} = metadata;
    if (!width || !height || width>16000 || height>16000 || !((width===photo.width&&height===photo.height)||(width===photo.height&&height===photo.width))) throw new Error('照片尺寸与原图不一致，请重新选择');
  }
  return {...photo, mime:png?'image/png':'image/jpeg'};
}
