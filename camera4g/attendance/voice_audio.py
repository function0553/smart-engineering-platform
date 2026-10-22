"""Prepare name audio on GPU, or validate the legacy caller-supplied PCMA."""
import base64
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import threading
import time

MAX_OUTPUT = 256 * 1024


def _terminate(process):
    if os.name == 'posix':
        try:os.killpg(process.pid,signal.SIGKILL)
        except ProcessLookupError:pass
    elif process.poll() is None:
        try:subprocess.run(['taskkill','/PID',str(process.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=1)
        except (OSError,subprocess.SubprocessError):process.kill()
    if process.poll() is None:
        process.kill()
    try:process.wait(timeout=1)
    except subprocess.TimeoutExpired:pass


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
            process = subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,shell=False,start_new_session=os.name=='posix',
                creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name=='nt' else 0,
                env={**os.environ,'PYTHONIOENCODING':'utf-8'})
            def read_output():
                data=process.stdout.read(MAX_OUTPUT+1)
                chunks.append(data)
                if len(data)>MAX_OUTPUT:_terminate(process)
            reader=threading.Thread(target=read_output,daemon=True)
            reader.start()
            deadline=time.monotonic()+timeout
            try:
                process.stdin.write(json.dumps({'name':name},ensure_ascii=False).encode())
                process.stdin.close()
                process.wait(timeout=max(.001,deadline-time.monotonic()))
                reader.join(max(0,deadline-time.monotonic()))
                if reader.is_alive() or process.returncode!=0 or not chunks or len(chunks[0])>MAX_OUTPUT:
                    raise RuntimeError('gpu_voice_prepare_failed')
                value=json.loads(chunks[0])
            finally:
                _terminate(process)
                reader.join(.5)
                if not process.stdin.closed:process.stdin.close()
                # Never wait on a buffered pipe lock held by a surviving descendant.
                if not reader.is_alive():process.stdout.close()
        except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
            raise RuntimeError('gpu_voice_prepare_failed') from error
    if not isinstance(value,dict) or value.get('voice_text') != name + '打卡成功':
        raise ValueError('name_voice_mismatch')
    audio = base64.b64decode(value['voice_pcma_base64'], validate=True)
    if not 2000 <= len(audio) <= 120000 or audio.startswith(b'RIFF'):
        raise ValueError('pcma8_voice_required')
    return audio
