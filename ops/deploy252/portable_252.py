"""Pinned 252 connection on migrated hosts. Never prints credential contents."""
import base64,hashlib,json,os
from pathlib import Path
import paramiko
ROOT=Path(__file__).resolve().parents[2]
PRIVATE=Path(os.environ.get('SMART_CREDENTIALS_DIR',str(ROOT.parents[3]/'memory/context/memory/private')))
def connect():
 record=next(r for r in json.loads((PRIVATE/'ssh-servers-20260921.credentials.json').read_text(encoding='utf-8-sig'))['credentials'] if r['target']=='252')
 class Pinned(paramiko.MissingHostKeyPolicy):
  def missing_host_key(self,client,hostname,key):
   fp='SHA256:'+base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip('=')
   if fp!=record['ssh_host_key']:raise paramiko.SSHException('252 host key changed')
 c=paramiko.SSHClient();c.set_missing_host_key_policy(Pinned());c.connect(record['public_host'],port=record['port'],username=record['username'],password=record['password'],timeout=12,banner_timeout=12,auth_timeout=12,allow_agent=False,look_for_keys=False);return c

def execute(c,command,timeout=45):
 _,out,err=c.exec_command(command,timeout=timeout);value=out.read().decode();error=err.read().decode();status=out.channel.recv_exit_status()
 if status:raise RuntimeError('Remote operation failed '+str(status)+': '+error[-1500:])
 return value

def python_on(c,source,root=False,timeout=60):
 stdin,out,err=c.exec_command(('sudo -n ' if root else '')+'python3 -',timeout=timeout);stdin.write(source);stdin.flush();stdin.channel.shutdown_write();value=out.read().decode();error=err.read().decode();status=out.channel.recv_exit_status()
 if status:raise RuntimeError('Remote Python failed '+str(status)+': '+error[-2000:])
 return json.loads(value)
