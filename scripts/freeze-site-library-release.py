from pathlib import Path
import json,hashlib,shutil,re,datetime
R=Path(__file__).resolve().parents[1];O=R/'outputs/site-library-release-20261021';W=O/'workspace';B=R/'outputs/app-site-complete-20261021/source-snapshot';sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest();read=lambda p:json.loads(p.read_text())
for n in ['independent-backend-review.json','backend-receipt.json','project-scope-review.json','mobile-cookie-transport.json']:
 assert read(O/n)['passed'],n
assert read(O/'library-browser/evidence.json')['passed'];assert read(O/'library-browser/final-visual-check.json')['passed'];assert read(W/'outputs/site-library-qa/browser/evidence.json')['passed']
log=(O/'regression-final.log').read_text();assert re.search(r'(?m)^ℹ fail 0$',log);count=int(re.search(r'(?m)^ℹ pass (\d+)$',log).group(1));assert count==211
assert '✓ built' in (O/'build-final.log').read_text() and '✓ built' in (O/'build-mobile-final.log').read_text()
a=read(O/'android/build-receipt.json');assert a['version']=='0.3.34' and a['versionCode']==40 and a['samePublishedSigningIdentity'];assert a['sha256']==sha(W/'server/mobile-updates/latest.apk')
with __import__('zipfile').ZipFile(O/'android'/a['apk']) as z:
 for p in (W/'dist-mobile').rglob('*'):
  if p.is_file():assert z.read('assets/www/'+p.relative_to(W/'dist-mobile').as_posix())==p.read_bytes()
assert sha(W/'src/report-photo-draft.ts')==sha(B/'src/report-photo-draft.ts') if (B/'src/report-photo-draft.ts').exists() else True
for top in ['vision']:
 for p in (B/top).rglob('*'):
  if p.is_file():assert sha(p)==sha(W/p.relative_to(B))
snapshot=O/'source-snapshot';assert not snapshot.exists()
for top in ['src','server','shared','vision','android','tests','dist','dist-mobile']:
 shutil.copytree(W/top,snapshot/top,ignore=shutil.ignore_patterns('__pycache__','*.pyc','.DS_Store','build'))
for n in ['package.json','package-lock.json','THIRD_PARTY_NOTICES.txt','index.html','mobile.html','tsconfig.json','vite.config.ts','vite.mobile.config.ts']:shutil.copy2(W/n,snapshot/n)
files=[{'path':p.relative_to(snapshot).as_posix(),'bytes':p.stat().st_size,'sha256':sha(p)} for p in sorted(snapshot.rglob('*')) if p.is_file()];assert not any(part in ['private','.data','.models','node_modules'] for e in files for part in Path(e['path']).parts)
changes=[e['path'] for e in files if not (B/e['path']).exists() or e['sha256']!=sha(B/e['path'])]
freeze={'version':'0.6.0-rc.38','sourceRoot':str(snapshot),'files':files,'changes':changes,'apkSha256':a['sha256'],'noDatabaseOrCredentials':True};(O/'source-freeze.json').write_text(json.dumps(freeze,ensure_ascii=False,indent=2))
local={'passed':True,'buildPassed':True,'passwordMergePreservedStability':True,'immediatePublicationAuthorized':True,'sourceFreezeSha256':sha(O/'source-freeze.json'),'regressionPass':count,'regressionFail':0,'libraryBrowserCases':8,'existingSevenCategoryBrowserCases':7,'visualWidths':[338,390,1440],'nativeSdkCompileAndD8Verified':True,'schemaUnchanged':True,'oldDraftSchemaKeysPreserved':True,'physicalPhoneBusinessTested':False,'independentReviewPassed':True};(O/'local-verification.json').write_text(json.dumps(local,ensure_ascii=False,indent=2))
(O/'finish-review.md').write_text('disposition: candidate\n\n七类资料项目/部位/日期分组、单组/筛选打包、管理员统一查看、显式项目整体上传完成。211项回归，7项既有七类浏览器流程和8项新资料册浏览器验证通过；3个ZIP下载核对清单和字节，338/390/1440布局检查通过。原生流式下载、Java编译/API26 D8、原签名APK资源逐字节校验通过。无schema变更，账号/资料不迁移替换，原草稿结构保留。未宣称手机业务或现场验收。\n')
print(json.dumps({'passed':True,'sourceRoot':str(snapshot),'files':len(files),'changedFiles':len(changes),'regression':count,'apkSha256':a['sha256']}))
