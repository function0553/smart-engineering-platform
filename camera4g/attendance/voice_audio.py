"""Prepare name audio on GPU, or validate the legacy caller-supplied PCMA."""
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import threading

MAX_OUTPUT = 256 * 1024


def prepare_voice(config, name, request=None):
    if not isinstance(name, str) or not re.fullmatch(r'[\w\u3400-\u9fff·• .-]{1,40}', name.strip()):
        raise ValueError('invalid_name')
    name = name.strip()
    request = request or {}
    if 'voice_text' in request or 'voice_pcma_base64' in request:
        value = request
    else:
        command = config.get('voice_prepare_command')
        if (not isinstance(command, list) or not command or not all(isinstance(x,str) and x for x in command)
                or not Path(command[0]).is_absolute()):
            raise RuntimeError('gpu_voice_preparer_not_configured')
        timeout = config.get('voice_prepare_timeout', 20)
        if type(timeout) not in (int,float) or not .05 <= timeout <= 60:
            raise ValueError('invalid_voice_prepare_timeout')
        chunks = []
        try:
            with subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, shell=False,
                                  env={**os.environ,'PYTHONIOENCODING':'utf-8'}) as process:
                def read_output():
                    data = process.stdout.read(MAX_OUTPUT+1)
                    chunks.append(data)
                    if len(data) > MAX_OUTPUT:
                        process.kill()
                reader = threading.Thread(target=read_output, daemon=True)
                reader.start()
                try:
                    process.stdin.write(json.dumps({'name':name},ensure_ascii=False).encode())
                    process.stdin.close()
                    process.wait(timeout=timeout)
                    reader.join(2)
                    if reader.is_alive() or process.returncode != 0 or not chunks or len(chunks[0]) > MAX_OUTPUT:
                        raise RuntimeError('gpu_voice_prepare_failed')
                    value = json.loads(chunks[0])
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait()
                    reader.join(2)
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
            raise RuntimeError('gpu_voice_prepare_failed') from error
    if not isinstance(value,dict) or value.get('voice_text') != name + '打卡成功':
        raise ValueError('name_voice_mismatch')
    audio = base64.b64decode(value['voice_pcma_base64'], validate=True)
    if not 2000 <= len(audio) <= 120000 or audio.startswith(b'RIFF'):
        raise ValueError('pcma8_voice_required')
    return audio
