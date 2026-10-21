"""Check active runtime file identity and public TLS against the existing project CA."""
from portable_252 import ROOT,connect,execute,python_on
from release_rc39 import archive_manifest,runtime_verification_source
from datetime import datetime
from pathlib import Path
import hashlib,json,socket,ssl,base64
from cryptography import x509
from cryptography.hazmat.primitives import serialization
OUT=ROOT/'outputs/deploy-252-20261021-rc39'
release=json.loads((OUT/'release-receipt.json').read_text());archive_manifest(release)
dest='/opt/smart-engineering/releases/'+release['release'];c=connect()
try:
 assert execute(c,'readlink /opt/smart-engineering/current').strip()=='releases/'+release['release']
 result=python_on(c,runtime_verification_source(dest,release['releaseManifestSha256']))
 (OUT/'runtime-verification.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
finally:c.close()
context=ssl.create_default_context(cafile=str(ROOT/'private/deploy252/ca.pem'))
with socket.create_connection(('211.139.12.141',21901),timeout=15) as conn:
 with context.wrap_socket(conn,server_hostname='211.139.12.141') as secured:
  cert=secured.getpeercert(binary_form=True);proto=secured.version()
pub=x509.load_der_x509_certificate(cert).public_key().public_bytes(serialization.Encoding.DER,serialization.PublicFormat.SubjectPublicKeyInfo)
pin={'checkedAt':datetime.now().astimezone().isoformat(),'tlsChainAndHostnameVerified':True,'trustSource':'existing project CA, not default public trust','tlsVersion':proto,'certificateSha256':hashlib.sha256(cert).hexdigest(),'spkiSha256Base64':base64.b64encode(hashlib.sha256(pub).digest()).decode()}
(OUT/'browser-tls-pin.json').write_text(json.dumps(pin,indent=2));print(json.dumps({'tlsChainAndHostnameVerified':True,'tlsVersion':proto}))
