import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';

const schema = z.object({ package:z.literal('cn.smartengineering.dailyreport'),versionCode:z.number().int().positive(),versionName:z.string().regex(/^\d+\.\d+\.\d+$/),
  minAndroidApi:z.number().int().min(26),size:z.number().int().positive().max(16*1024*1024),sha256:z.string().regex(/^[0-9a-f]{64}$/),notes:z.array(z.string().max(300)).max(12),publishedAt:z.iso.datetime() }).strict();

export function mountAppUpdateRoutes(app, directory = resolve('server/mobile-updates')) {
  // Every app launch checks for updates: re-hash the APK (up to 16 MB) only after the manifest text or the APK file changes.
  let verified = { key: '', manifest: null };
  const release = () => {
    const manifestPath=resolve(directory,'manifest.json'),apkPath=resolve(directory,'latest.apk');
    if(!existsSync(manifestPath)||!existsSync(apkPath))return null;
    const text=readFileSync(manifestPath,'utf8'),stat=statSync(apkPath),key=`${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}\n${text}`;
    if(verified.key===key)return {manifest:verified.manifest,apkPath};
    const manifest=schema.parse(JSON.parse(text));
    if(stat.size!==manifest.size || createHash('sha256').update(readFileSync(apkPath)).digest('hex')!==manifest.sha256)throw new Error('发布包校验失败');
    verified={key,manifest};
    return {manifest,apkPath};
  };
  for(const base of ['/api/app-update','/api/mobile/app-update']) {
    app.get(base,(req,res)=>{
      const {versionCode}=z.object({versionCode:z.coerce.number().int().min(0).default(0)}).strict().parse(req.query);
      const latest=release();res.json(latest?{available:latest.manifest.versionCode>versionCode,...latest.manifest,downloadPath:base+'/apk'}:{available:false,versionCode:0,notes:[]});
    });
    app.get(base+'/apk',(req,res)=>{const latest=release();if(!latest)return res.status(404).json({error:'暂无发布安装包'});
      res.set({'Content-Type':'application/vnd.android.package-archive','Content-Disposition':'attachment; filename="smart-engineering-'+latest.manifest.versionName+'.apk"','X-APK-SHA256':latest.manifest.sha256});res.sendFile(latest.apkPath);
    });
  }
}
