"""Build the official manifest version with existing signing identity on macOS/Linux."""
from pathlib import Path
import datetime,hashlib,json,os,re,shutil,subprocess,tempfile,zipfile
import xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parents[1]
JAVA=Path(os.environ['REPORT_JAVA_HOME']);TOOLS=Path(os.environ['REPORT_ANDROID_TOOLS']);PLATFORM=Path(os.environ['REPORT_ANDROID_PLATFORM'])
OUT=Path(os.environ['REPORT_ANDROID_OUTPUT']);OUT.mkdir(parents=True,exist_ok=True)
BUILD=Path(tempfile.mkdtemp(prefix='smart-engineering-android-'))
PRIVATE=ROOT/'private/android'; assert (PRIVATE/'signing.json').is_file() and (PRIVATE/'daily-report.p12').is_file(),'Restore original signing identity; do not generate a replacement'
SIGNING=json.loads((PRIVATE/'signing.json').read_text());ENV={**os.environ,'REPORT_SIGN_PASSWORD':SIGNING['password'],'JAVA_HOME':str(JAVA)}
ns='{http://schemas.android.com/apk/res/android}';manifest=ET.parse(ROOT/'android/AndroidManifest.xml').getroot();version=manifest.get(ns+'versionName');code=int(manifest.get(ns+'versionCode'));assert version=='0.3.34' and code==40
expectedSigner='e6725a59aaee68378fd0c2db490f542f1875055c33de3921e06417a14bc2e21b'
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def run(args):
 r=subprocess.run(list(map(str,args)),cwd=BUILD,env=ENV,capture_output=True,text=True)
 if r.returncode:raise RuntimeError(Path(str(args[0])).name+' failed: '+(r.stdout+r.stderr).replace(SIGNING['password'],'[private]')[-3500:])
 return r.stdout+r.stderr
shutil.copytree(ROOT/'android',BUILD/'android',ignore=shutil.ignore_patterns('build'))
shutil.copytree(ROOT/'dist-mobile',BUILD/'assets/www');shutil.copy2(ROOT/'THIRD_PARTY_NOTICES.txt',BUILD/'assets/THIRD_PARTY_NOTICES.txt')
for name in ['generated','classes','dex']:(BUILD/name).mkdir()
run([TOOLS/'aapt2','compile','--dir',BUILD/'android/res','-o',BUILD/'res.zip'])
run([TOOLS/'aapt2','link','-o',BUILD/'base.apk','-I',PLATFORM,'--manifest',BUILD/'android/AndroidManifest.xml','--java',BUILD/'generated','-A',BUILD/'assets',BUILD/'res.zip'])
java=list((BUILD/'android/src').rglob('*.java'))+list((BUILD/'generated').rglob('*.java'))
run([JAVA/'bin/javac','-encoding','UTF-8','--release','8','-classpath',PLATFORM,'-d',BUILD/'classes',*java])
run([JAVA/'bin/jar','cf',BUILD/'classes.jar','-C',BUILD/'classes','.'])
run([JAVA/'bin/java','-cp',TOOLS/'lib/d8.jar','com.android.tools.r8.D8','--release','--min-api','26','--lib',PLATFORM,'--output',BUILD/'dex',BUILD/'classes.jar'])
with zipfile.ZipFile(BUILD/'base.apk','a',zipfile.ZIP_DEFLATED) as z:
 for p in (BUILD/'dex').glob('*.dex'):z.write(p,p.name)
run([TOOLS/'zipalign','-p','-f','4',BUILD/'base.apk',BUILD/'aligned.apk'])
final=BUILD/('smart-engineering-daily-report-'+version+'.apk')
run([JAVA/'bin/java','-jar',TOOLS/'lib/apksigner.jar','sign','--ks',PRIVATE/'daily-report.p12','--ks-key-alias',SIGNING['alias'],'--ks-pass','env:REPORT_SIGN_PASSWORD','--key-pass','env:REPORT_SIGN_PASSWORD','--min-sdk-version','26','--v4-signing-enabled','false','--out',final,BUILD/'aligned.apk'])
verification=run([JAVA/'bin/java','-jar',TOOLS/'lib/apksigner.jar','verify','--verbose','--print-certs',final]);fingerprint=re.search(r'Signer #1 certificate SHA-256 digest:\s*([0-9a-f]+)',verification).group(1);assert fingerprint==expectedSigner
old=ROOT/'delivery/smart-engineering-daily-report-0.3.13.apk';oldverify=run([JAVA/'bin/java','-jar',TOOLS/'lib/apksigner.jar','verify','--print-certs',old]);assert expectedSigner in oldverify
badging=run([TOOLS/'aapt','dump','badging',final]);assert "versionCode='40'" in badging and "versionName='0.3.34'" in badging and "name='cn.smartengineering.dailyreport'" in badging
run([TOOLS/'zipalign','-c','-p','4',final]);assets={}
with zipfile.ZipFile(final) as z:
 assert 'classes.dex' in z.namelist()
 for p in (ROOT/'dist-mobile').rglob('*'):
  if p.is_file():
   name=p.relative_to(ROOT/'dist-mobile').as_posix();assets[name]=hashlib.sha256(z.read('assets/www/'+name)).hexdigest()==sha(p)
 assert all(assets.values())
 assert hashlib.sha256(z.read('res/raw/server252_ca.pem')).hexdigest()==sha(ROOT/'android/res/raw/server252_ca.pem')
(OUT/'apk-verification.txt').write_text(verification+'\n'+badging+'\nZip alignment check passed.\n')
shutil.copy2(final,OUT/final.name)
receipt={'version':version,'versionCode':code,'package':manifest.get('package'),'builtAt':datetime.datetime.now().astimezone().isoformat(),'apk':final.name,'bytes':final.stat().st_size,'sha256':sha(final),'signerSha256':fingerprint,'samePublishedSigningIdentity':True,'signatureAndAlignmentVerified':True,'bundledAssetsVerified':assets,'minAndroidApi':26,'targetAndroidApi':35,'physicalDeviceTested':False,'buildPlatform':'macOS','candidateOnly':True,'requiresBackendVersion':'0.6.0-rc.38','publicUpdateManifestChanged':False}
(OUT/'build-receipt.json').write_text(json.dumps(receipt,ensure_ascii=False,indent=2))
print(json.dumps({k:receipt[k] for k in ['version','versionCode','bytes','sha256','samePublishedSigningIdentity','candidateOnly']},ensure_ascii=False))
