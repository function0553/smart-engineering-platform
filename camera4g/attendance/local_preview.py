"""Owner-only localhost viewer; SSH and API credentials stay in process memory."""
import audioop
import base64
import hashlib
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import socket
import subprocess
import sys
import threading
import uuid
import wave

import paramiko
from ssh_http import ChannelSocket, read_bounded_response

ROOT = Path(__file__).resolve().parent
CREDENTIALS = json.loads(sys.stdin.readline())
CONNECTION = None
LOCK = threading.Lock()
PASSWORDS = None


def connect():
    global CONNECTION, PASSWORDS
    with LOCK:
        if CONNECTION is not None and CONNECTION.is_active():
            return CONNECTION
        sock = socket.socket()
        sock.settimeout(10)
        sock.setsockopt(socket.IPPROTO_IP, 31, socket.htonl(9))
        sock.bind(('0.0.0.0', 0))
        sock.connect(('211.139.12.141', 2222))
        conn = paramiko.Transport(sock)
        conn.start_client(timeout=10)
        key = base64.b64encode(hashlib.sha256(conn.get_remote_server_key().asbytes()).digest()).decode().rstrip('=')
        if key != 'c4QdpKS0Qwf/lwAv8QjDAAoUMsnoOSVeM6HXuNYY894':
            conn.close()
            raise ValueError('host_fingerprint_mismatch')
        conn.auth_password('dell', CREDENTIALS['gpu'])
        conn.set_keepalive(20)
        sftp = paramiko.SFTPClient.from_transport(conn)
        values = {}
        try:
            for name in ['preview.env', 'attendance.env']:
                with sftp.open('/data/4g-camera-inference/private/' + name) as f:
                    for line in f.read().decode().splitlines():
                        k, v = line.split('=', 1)
                        values[k] = v
        finally:
            sftp.close()
        PASSWORDS, CONNECTION = values, conn
        return conn


def name_audio(name):
    if not isinstance(name, str) or not name.strip() or not re.fullmatch(r'[\w\u3400-\u9fff·• .-]{1,40}', name):
        raise ValueError('invalid_name')
    text = name.strip() + '打卡成功'
    directory = ROOT / 'private/voice-temporary'
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / (uuid.uuid4().hex + '.wav')
    try:
        result = subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy',
                                 'Bypass', '-File', str(ROOT/'render_voice.ps1')],
                                input=json.dumps({'text': text, 'path': str(path)}).encode(),
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20,
                                creationflags=subprocess.CREATE_NO_WINDOW)
        if result.returncode:
            raise ValueError('name_voice_generation_failed')
        with wave.open(str(path), 'rb') as audio:
            if (audio.getframerate(), audio.getnchannels(), audio.getsampwidth()) != (8000, 1, 2):
                raise ValueError('voice_format_mismatch')
            data = audioop.lin2alaw(audio.readframes(audio.getnframes()), 2)
        return text, data
    finally:
        if path.exists():
            path.unlink()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def failure(self, code):
        data = json.dumps({'error': 'service_unavailable', 'message': '连接或录入未完成，请稍后重试。'}).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def route(self):
        if self.headers.get('Host') not in {'127.0.0.1:18888', 'localhost:18888'}:
            return self.failure(403)
        if not self.path.startswith('/') or self.path.startswith('//') or '\r' in self.path or '\n' in self.path:
            return self.failure(400)
        attendance = self.path.startswith('/attendance/') or self.path == '/attendance'
        path = self.path[len('/attendance'):] or '/' if attendance else self.path
        if self.command not in {'GET', 'HEAD', 'POST'}:
            return self.failure(405)
        if self.command == 'POST':
            if not attendance or path not in {'/api/enroll', '/api/voice/confirm', '/api/attendance/clear'}:
                return self.failure(405)
            if self.headers.get('Origin') not in {None, 'http://127.0.0.1:18888', 'http://localhost:18888'}:
                return self.failure(403)
        size = int(self.headers.get('Content-Length', '0'))
        if not 0 <= size <= 8*1024*1024:
            return self.failure(413)
        data = self.rfile.read(size) if size else None
        if self.command == 'POST' and path == '/api/enroll':
            request = json.loads(data)
            text, audio = name_audio(request['name'])
            request['voice_text'] = text
            request['voice_pcma_base64'] = base64.b64encode(audio).decode()
            data = json.dumps(request).encode()
        conn = connect()
        headers = {'Connection': 'close', 'Accept-Encoding': 'identity'}
        if attendance:
            headers['Authorization'] = 'Bearer ' + PASSWORDS['ATTENDANCE_ADMIN_TOKEN']
            port = 28982
        else:
            headers['Authorization'] = 'Basic ' + base64.b64encode(('viewer:' + PASSWORDS['PPE_PREVIEW_PASS']).encode()).decode()
            port = 28980
        if data is not None:
            headers['Content-Type'] = 'application/json'
            headers['Content-Length'] = str(len(data))
        channel = conn.open_channel('direct-tcpip', ('127.0.0.1', port), ('127.0.0.1', self.client_address[1]), timeout=10)
        channel.settimeout(30)
        upstream = http.client.HTTPConnection('127.0.0.1', port, timeout=30)
        upstream.sock = ChannelSocket(channel)
        try:
            upstream.request(self.command, path, body=data, headers=headers)
            response = upstream.getresponse()
            body = read_bounded_response(response)
            self.send_response(response.status)
            self.send_header('Content-Type', response.getheader('Content-Type', 'application/octet-stream'))
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)
        finally:
            upstream.close()
            channel.close()

    def safe_route(self):
        try:
            self.route()
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception:
            self.failure(502)

    do_GET = do_HEAD = do_POST = do_OPTIONS = safe_route


if __name__ == '__main__':
    connect()
    server = ThreadingHTTPServer(('127.0.0.1', 18888), Handler)
    server.daemon_threads = True
    print(json.dumps({'viewer_ready': True, 'preview': 'http://127.0.0.1:18888/',
                      'enrollment': 'http://127.0.0.1:18888/attendance/',
                      'credentials_saved': False}), flush=True)
    server.serve_forever()
