import test from'node:test';import assert from'node:assert/strict';import sharp from'sharp';import{createHash}from'node:crypto';import{normalizePhotoFile,photoMime}from'../src/photo-input.ts';
const sha=b=>createHash('sha256').update(b).digest('hex');
test('real JPEG and PNG bytes win over empty incorrect and Android MIME aliases without changing originals',async()=>{
 const png=await sharp({create:{width:24,height:16,channels:3,background:'#336699'}}).png().toBuffer(),jpeg=await sharp(png).jpeg().toBuffer();
 for(const [bytes,ext,mime]of[[png,'png','image/png'],[jpeg,'jpg','image/jpeg']])for(const label of['', 'application/octet-stream','image/jpg','image/pjpeg','image/jpeg','image/png']){
  const source=new File([bytes],'原图.'+ext,{type:label,lastModified:123456}),file=await normalizePhotoFile(source);assert.equal(file.type,mime);assert.equal(file.name,source.name);assert.equal(file.lastModified,123456);assert.equal(sha(Buffer.from(await file.arrayBuffer())),sha(bytes));}
 const mislabeled=await normalizePhotoFile(new File([png],'image.jpg',{type:'image/jpeg'}));assert.equal(mislabeled.name,'image.jpg.png');assert.equal(mislabeled.type,'image/png');
 const noName=await normalizePhotoFile(new File([jpeg],'content-12345',{type:''}));assert.equal(noName.name,'content-12345.jpg');assert.equal(noName.type,'image/jpeg');
});
test('primary site accepts real WebP while template entries clearly identify their supported types; videos and documents remain unchanged',async()=>{
 const webp=await sharp({create:{width:24,height:16,channels:3,background:'#336699'}}).webp().toBuffer(),source=new File([webp],'photo.webp',{type:'image/jpeg'}),file=await normalizePhotoFile(source,['image/jpeg','image/png','image/webp'],true);assert.equal(file.type,'image/webp');assert.equal(sha(Buffer.from(await file.arrayBuffer())),sha(webp));await assert.rejects(()=>normalizePhotoFile(source),/WebP.*JPG\/JPEG、PNG/);
 const video=new File(['video fixture'],'clip.mp4',{type:'video/mp4'});assert.equal(await normalizePhotoFile(video,['image/jpeg','image/png','image/webp'],true),video);
 await assert.rejects(()=>normalizePhotoFile(new File(['not an image'],'fake.jpg',{type:'image/jpeg'})),/不是可识别的照片/);assert.equal(photoMime(new Uint8Array([])),undefined);
});
