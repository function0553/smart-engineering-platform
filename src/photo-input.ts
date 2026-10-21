export type PhotoMime='image/jpeg'|'image/png'|'image/webp';
export const photoMime=(b:Uint8Array):PhotoMime|undefined=>b[0]===255&&b[1]===216&&b[2]===255?'image/jpeg':b.length>=8&&[137,80,78,71,13,10,26,10].every((v,i)=>b[i]===v)?'image/png':b.length>=12&&String.fromCharCode(...b.slice(0,4))==='RIFF'&&String.fromCharCode(...b.slice(8,12))==='WEBP'?'image/webp':undefined;
/** Correct provider labels without changing, compressing or re-encoding original bytes. */
export async function normalizePhotoFile(file:File,allowed:readonly PhotoMime[]=['image/jpeg','image/png'],allowOther=false):Promise<File>{
 const mime=photoMime(new Uint8Array(await file.slice(0,32).arrayBuffer()));
 const supported=allowed.includes('image/webp')?'JPG/JPEG、PNG、WebP':'JPG/JPEG、PNG';
 if(!mime){if(allowOther&&!file.type.startsWith('image/')&&!/\.(?:jpe?g|png|webp|heic|heif|jfif)$/i.test(file.name))return file;throw Error(`${file.name||'所选图片'}不是可识别的照片，请选择有效的${supported}图片。`);}
 if(!allowed.includes(mime))throw Error(`${file.name}是WebP图片；此在线模板入口支持JPG/JPEG、PNG，WebP原图可在七类施工资料中上传。`);
 const ext=mime==='image/jpeg'?'jpg':mime==='image/png'?'png':'webp',matches=mime==='image/jpeg'?/\.jpe?g$/i:/\.png$/i;
 const correct=mime==='image/webp'?/\.webp$/i.test(file.name):matches.test(file.name),name=correct?file.name:(file.name||'照片')+'.'+ext;
 return file.type===mime&&name===file.name?file:new File([file],name,{type:mime,lastModified:file.lastModified});
}
