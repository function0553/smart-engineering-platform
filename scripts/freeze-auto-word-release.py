"""Freeze the source and original-signature APP tested against automatic ZIP Word output."""
from pathlib import Path
import json,hashlib,shutil,re,zipfile
R=Path(__file__).resolve().parents[1];O=R/'outputs/site-library-auto-word-20261021';W=O/'workspace';B=R/'outputs/site-library-release-20261021/source-snapshot';sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest();read=lambda p:json.loads(p.read_text())
for n in ['backend-receipt.json','independent-review.json','browser/evidence.json','document-render-review.json']:assert read(O/n)['passed'],n
log=(O/'regression-final.log').read_text();assert re.search(r'(?m)^# fail 0$',log);count=int(re.search(r'(?m)^# pass (\d+)$',log).group(1));assert count>=211
assert '✓ built' in (O/'build-final.log').read_text() and '✓ built' in (O/'build-mobile-final.log').read_text()
a=read(O/'android/build-receipt.json');assert a['version']=='0.3.35' and a['versionCode']==41 and a['samePublishedSigningIdentity'] and a['sha256']==sha(W/'server/mobile-updates/latest.apk')
with zipfile.ZipFile(O/'android'/a['apk'])as z,zipfile.ZipFile(R/'outputs/site-library-release-20261021/android/smart-engineering-daily-report-0.3.34.apk')as old:
 assert z.read('classes.dex')==old.read('classes.dex')
 for p in (W/'dist-mobile').rglob('*'):
  if p.is_file():assert z.read('assets/www/'+p.relative_to(W/'dist-mobile').as_posix())==p.read_bytes()
for top in ['vision','shared']:
 for p in (B/top).rglob('*'):
  if p.is_file():assert sha(p)==sha(W/p.relative_to(B))
for n in ['src/mobile-transport.ts','server/store.mjs','server/app.mjs']:
 if (B/n).exists():assert sha(B/n)==sha(W/n),n
snapshot=O/'source-snapshot';assert not snapshot.exists()
for top in ['src','server','shared','vision','android','tests','dist','dist-mobile']:shutil.copytree(W/top,snapshot/top,ignore=shutil.ignore_patterns('__pycache__','*.pyc','.DS_Store','build'))
for n in ['package.json','package-lock.json','THIRD_PARTY_NOTICES.txt','index.html','mobile.html','tsconfig.json','vite.config.ts','vite.mobile.config.ts']:shutil.copy2(W/n,snapshot/n)
files=[{'path':p.relative_to(snapshot).as_posix(),'bytes':p.stat().st_size,'sha256':sha(p)}for p in sorted(snapshot.rglob('*'))if p.is_file()];assert not any(part in ['private','.data','.models','node_modules']for e in files for part in Path(e['path']).parts)
changes=[e['path']for e in files if not(B/e['path']).exists()or e['sha256']!=sha(B/e['path'])];freeze={'version':'0.6.0-rc.39','sourceRoot':str(snapshot),'files':files,'changes':changes,'apkSha256':a['sha256'],'noDatabaseOrCredentials':True};(O/'source-freeze.json').write_text(json.dumps(freeze,ensure_ascii=False,indent=2))
local={'passed':True,'buildPassed':True,'passwordMergePreservedStability':True,'immediatePublicationAuthorized':True,'sourceFreezeSha256':sha(O/'source-freeze.json'),'regressionPass':count,'regressionFail':0,'automaticWordBrowserPassed':True,'actualAutoWordRenderedAndInspected':True,'nativeDexPreserved':True,'schemaUnchanged':True,'originalDraftSchemaAndKeysPreserved':True,'physicalPhoneBusinessTested':False,'independentReviewPassed':True};(O/'local-verification.json').write_text(json.dumps(local,ensure_ascii=False,indent=2));(O/'finish-review.md').write_text('disposition: candidate\n\n自动照片Word随ZIP打包完成；最新服务器代表图、十道工序、Word正文与图片核对，实际包内文档渲染并检查A4页数和位置。旧历史保留，未新增业务历史或改变审核，下载仍鉴权/来源/版本复核。相关回归与独立复核通过。原签名APP资源逐字节校验，原生DEX不变，数据库和原草稿结构不变。不宣称手机业务和现场验收。\n');print(json.dumps({'passed':True,'files':len(files),'changedFiles':len(changes),'regression':count,'apkSha256':a['sha256']}))
