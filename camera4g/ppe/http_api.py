"""Bounded authenticated GET API. No capture URLs, uploads or camera commands."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import re
import socket
import threading
from urllib.parse import parse_qs, urlsplit

from video_runtime import ApiError


class BoundedHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self, address, runtime):
        self.runtime = runtime
        self.gate = threading.BoundedSemaphore(runtime.config['limits']['max_http_concurrent'])
        super().__init__(address, Handler)

    def process_request(self, request, address):
        if not self.gate.acquire(False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except Exception:
            self.gate.release()
            raise

    def process_request_thread(self, request, address):
        try:
            request.settimeout(self.runtime.config['limits']['http_timeout_seconds'])
            super().process_request_thread(request, address)
        finally:
            self.gate.release()

    def handle_error(self, request, address):
        pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'
    server_version = 'PPEVideoCandidate/1'

    def setup(self):
        super().setup()
        def expire():
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.deadline = threading.Timer(self.server.runtime.config['limits']['http_timeout_seconds'], expire)
        self.deadline.daemon = True
        self.deadline.start()

    def finish(self):
        if hasattr(self, 'deadline'):
            self.deadline.cancel()
        super().finish()

    def log_message(self, *_):
        pass

    def send(self, status, body, mime, headers=None):
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Connection', 'close')
        if status == 401:
            self.send_header('WWW-Authenticate', 'Bearer')
        for k, v in (headers or {}).items():
            self.send_header(k, str(v))
        self.end_headers()
        self.wfile.write(body)
        self.close_connection = True

    def json(self, status, value):
        self.send(status, json.dumps(value, ensure_ascii=False, allow_nan=False).encode(), 'application/json; charset=utf-8')

    def authorize(self, camera_id=None, admin=False):
        auth = self.headers.get_all('Authorization', [])
        if len(auth) != 1 or not self.server.runtime.authenticated(auth[0], camera_id, admin):
            raise ApiError(401, 'unauthorized')

    def route(self):
        if len(self.path) > 2048:
            raise ApiError(414, 'uri_limit')
        parsed = urlsplit(self.path)
        r = self.server.runtime
        if parsed.path in ('/healthz', '/v1/status'):
            self.authorize(admin=True)
            return self.json(200, r.status())
        match = re.fullmatch(r'/v1/cameras/([A-Za-z0-9_-]{1,64})/(status|results|frame.jpg)', parsed.path)
        if match is None:
            self.authorize(admin=True)
            raise ApiError(404, 'not_found')
        cid, action = match.groups()
        self.authorize(cid)
        if cid != r.config['camera']['camera_id']:
            raise ApiError(404, 'unknown_camera')
        if action == 'status':
            return self.json(200, r.status())
        if action == 'results':
            result, jpeg = r.snapshot(jpeg=False), None
        else:
            result, jpeg = r.snapshot(jpeg=True)
        query = parse_qs(parsed.query, keep_blank_values=True)
        if query:
            if set(query) != {'epoch', 'sequence'} or any(len(v) != 1 or not re.fullmatch(r'[0-9]{1,19}', v[0]) for v in query.values()):
                raise ApiError(400, 'invalid_frame_key')
            if int(query['epoch'][0]) != result['capture_epoch'] or int(query['sequence'][0]) != result['sequence']:
                raise ApiError(409, 'snapshot_changed')
        if action == 'results':
            result['frame_jpeg_path'] = (f"/v1/cameras/{cid}/frame.jpg?epoch={result['capture_epoch']}&sequence={result['sequence']}"
                                         if r.config['diagnostic_jpeg_enabled'] else None)
            return self.json(200, result)
        return self.send(200, jpeg, 'image/jpeg', {'X-Camera-ID': cid,
            'X-Session-ID': result['session_id'], 'X-Capture-Epoch': result['capture_epoch'],
            'X-Frame-Sequence': result['sequence']})

    def do_GET(self):
        try:
            self.route()
        except ApiError as error:
            self.json(error.status, {'error': error.code})
        except (OSError, TimeoutError):
            self.close_connection = True
        except Exception:
            self.json(500, {'error': 'internal_error'})

    def unsupported(self):
        try:
            self.authorize(admin=True)
            self.json(405, {'error': 'method_not_allowed'})
        except ApiError as error:
            self.json(error.status, {'error': error.code})
    do_POST = do_PUT = do_PATCH = do_DELETE = unsupported
