"""GPU local TTS adapter: JSON name -> PCMA8 JSON, never plays audio.

Requires espeak-ng with Mandarin voice and ffmpeg in the GPU runtime PATH.
"""
import base64
import json
import re
import subprocess
import sys


def prepare(name):
    if not isinstance(name,str) or not re.fullmatch(r'[\w\u3400-\u9fff·• .-]{1,40}',name.strip()):
        raise ValueError('invalid_name')
    text=name.strip()+'打卡成功'
    wav=subprocess.run(['espeak-ng','-v','cmn','-s','140','--stdout',text],check=True,
                       stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=8).stdout
    audio=subprocess.run(['ffmpeg','-nostdin','-hide_banner','-loglevel','error','-i','pipe:0',
                          '-ar','8000','-ac','1','-t','15','-f','alaw','pipe:1'],input=wav,check=True,
                         stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=8).stdout
    if not 2000 <= len(audio) <= 120000:
        raise ValueError('invalid_audio_length')
    return {'voice_text':text,'voice_pcma_base64':base64.b64encode(audio).decode()}


if __name__ == '__main__':
    try:
        print(json.dumps(prepare(json.loads(sys.stdin.read(1024))['name']),ensure_ascii=False))
    except Exception:
        print('gpu_name_voice_failed',file=sys.stderr)
        sys.exit(1)
