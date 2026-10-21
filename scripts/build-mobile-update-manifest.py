"""Create local update metadata from an already signed official build; never deploys."""
from pathlib import Path
from datetime import datetime,timezone
import argparse,hashlib,json,re,os,tempfile
ROOT=Path(__file__).resolve().parents[1]
def build_manifest(receipt,notes):
 assert receipt['package']=='cn.smartengineering.dailyreport' and receipt['samePublishedSigningIdentity'] and receipt['signatureAndAlignmentVerified']
 assert re.fullmatch(r'\d+\.\d+\.\d+',receipt['version']) and isinstance(receipt['versionCode'],int) and receipt['versionCode']>0
 assert 0<receipt['bytes']<=16*1024*1024 and re.fullmatch(r'[0-9a-f]{64}',receipt['sha256'])
 assert isinstance(notes,list) and len(notes)<=12 and all(isinstance(n,str) and len(n)<=300 for n in notes)
 return {'package':receipt['package'],'versionCode':receipt['versionCode'],'versionName':receipt['version'],'minAndroidApi':receipt['minAndroidApi'],'size':receipt['bytes'],'sha256':receipt['sha256'],'notes':notes,'publishedAt':datetime.now(timezone.utc).isoformat().replace('+00:00','Z')}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--receipt',required=True);p.add_argument('--notes',required=True);p.add_argument('--out',required=True);a=p.parse_args()
 receiptPath=Path(a.receipt).resolve();out=Path(a.out).resolve();assert receiptPath.is_relative_to(ROOT/'outputs') and out.is_relative_to(ROOT) and 'private' not in out.relative_to(ROOT).parts
 receipt=json.loads(receiptPath.read_text());apk=receiptPath.parent/receipt['apk'];assert apk.stat().st_size==receipt['bytes'] and hashlib.sha256(apk.read_bytes()).hexdigest()==receipt['sha256']
 data=build_manifest(receipt,json.loads(Path(a.notes).read_text()));out.parent.mkdir(parents=True,exist_ok=True)
 fd,tmp=tempfile.mkstemp(prefix='.manifest-',dir=out.parent)
 try:
  with os.fdopen(fd,'w') as f:f.write(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
  os.replace(tmp,out)
 finally:
  if Path(tmp).exists():Path(tmp).unlink()
 print(json.dumps({'generated':str(out.relative_to(ROOT)),'versionCode':data['versionCode'],'utcZ':True,'deployed':False}))
