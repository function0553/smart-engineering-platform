"""Loopback-only, same-origin raw-video preview proxy and bounded result history.

It serves owned static files, proxies dedicated MediaMTX ports and reads the new
inference API. It never accesses a camera, modifies configuration, or emits keys.
All credentials remain in target-server private environment variables.
"""
from __future__ import annotations

import argparse
import base64
from collections import deque
from datetime import datetime, timezone
import hmac
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import signal
import socket
import threading
import time
import uuid
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit

ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/preview.js": ("preview.js", "text/javascript; charset=utf-8"),
    "/overlay_logic.js": ("overlay_logic.js", "text/javascript; charset=utf-8"),
    "/vendor/hls.v1.7.3.min.js": ("vendor/hls.v1.7.3.min.js", "text/javascript; charset=utf-8"),
    "/vendor/mediamtx-reader.v1.21.2.js": ("vendor/mediamtx-reader.v1.21.2.js", "text/javascript; charset=utf-8"),
}


def utc_epoch(value):
    if not isinstance(value, str) or len(value) > 64:
        raise ValueError("invalid_time")
    stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        raise ValueError("timezone_required")
    return stamp.timestamp()


def load_config(path):
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    for key in ("bind_port", "inference_port", "hls_port", "webrtc_port"):
        if type(value.get(key)) is not int or not 1024 <= value[key] <= 65535:
            raise ValueError("dedicated_port_required")
    if len({value[key] for key in ("bind_port", "inference_port", "hls_port", "webrtc_port")}) != 4:
        raise ValueError("ports_must_differ")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value.get("camera_id", "")):
        raise ValueError("invalid_camera_id")
    if value.get("stream_path") != "raw-main" or value.get("video_protocol") not in ("hls", "webrtc"):
        raise ValueError("explicit_raw_path_required")
    if type(value.get("history_limit")) is not int or not 1 <= value["history_limit"] <= 100:
        raise ValueError("history_limit")
    if not 1 <= value.get("history_seconds", 0) <= 10 or not .1 <= value.get("poll_interval_seconds", 0) <= 1:
        raise ValueError("history_interval")
    if type(value.get("overlay_timing_verified")) is not bool:
        raise ValueError("timing_gate_required")
    if value.get("alignment_mode") not in ("receive_time_estimate", "disabled"):
        raise ValueError("explicit_approximate_alignment_required")
    for key, minimum, maximum in (("overlay_clock_offset_ms", -10000, 10000),
                                  ("overlay_match_max_error_ms", 1, 500),
                                  ("overlay_sample_ttl_ms", 100, 1000)):
        if type(value.get(key)) is not int or not minimum <= value[key] <= maximum:
            raise ValueError("timing_budget")
    return value


class History:
    def __init__(self, config, token):
        self.config, self.token = config, token
        self.values = deque(maxlen=config["history_limit"])
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.thread = None
        self.identity = None
        self.last_key = None
        self.state = "waiting"

    def clear(self, state):
        with self.lock:
            self.values.clear()
            self.identity = self.last_key = None
            self.state = state

    def accept(self, data, now):
        if data.get("camera_id") != self.config["camera_id"] or data.get("source_stream") != "MAIN":
            raise ValueError("unexpected_source")
        received = utc_epoch(data.get("received_at_utc"))
        if not -1 <= now - received <= self.config["history_seconds"]:
            raise ValueError("stale_or_future")
        identity = (data.get("session_id"), data.get("capture_epoch"))
        sequence = data.get("sequence")
        if not isinstance(identity[0], str) or not identity[0] or type(identity[1]) is not int or type(sequence) is not int:
            raise ValueError("frame_key_required")
        with self.lock:
            if self.identity != identity:
                self.values.clear()
                self.last_key = None
                self.identity = identity
            if self.last_key is not None and sequence < self.last_key:
                raise ValueError("sequence_regression")
            if self.last_key != sequence:
                # Only the needed data contract is exposed; media URLs may contain
                # credentials in future backends and are deliberately not proxied.
                keep = ("schema_version", "camera_id", "source_stream", "session_id", "capture_epoch", "sequence",
                        "frame_size", "coordinate_space", "rotation_degrees", "mirror_horizontal",
                        "received_at_utc", "processed_at_utc", "source_pts_seconds", "inference_ms",
                        "detections", "persons", "temporal_confirmation_enabled",
                        "sensor_exposure_utc_verified", "field_accuracy_verified")
                record = {key: data[key] for key in keep if key in data}
                record["decoder_received_epoch_ms"] = received * 1000
                self.values.append(record)
                self.last_key = sequence
            self.state = "fresh"
            self._prune(now)

    def _prune(self, now):
        while self.values and now * 1000 - self.values[0]["decoder_received_epoch_ms"] > self.config["history_seconds"] * 1000:
            self.values.popleft()

    def snapshot(self):
        now = time.time()
        with self.lock:
            self._prune(now)
            values = list(self.values)
            latest = values[-1]["decoder_received_epoch_ms"] if values else None
            return {"server_now_epoch_ms": now * 1000, "results": values, "state": self.state,
                    "latest_result_age_ms": None if latest is None else now * 1000 - latest,
                    "alignment": "decoder_receive_time_estimate_not_sensor_exposure"}

    def run(self):
        path = f"/v1/cameras/{self.config['camera_id']}/results"
        while not self.stop.is_set():
            connection = http.client.HTTPConnection("127.0.0.1", self.config["inference_port"], timeout=2)
            try:
                connection.request("GET", path, headers={"Authorization": "Bearer " + self.token})
                response = connection.getresponse()
                payload = response.read(1024 * 1024 + 1)
                if response.status != 200 or len(payload) > 1024 * 1024:
                    self.clear("unavailable")
                else:
                    self.accept(json.loads(payload), time.time())
            except Exception:
                self.clear("unavailable")
            finally:
                connection.close()
            self.stop.wait(self.config["poll_interval_seconds"])

    def start(self):
        self.thread = threading.Thread(target=self.run, name="owned-result-history", daemon=True)
        self.thread.start()


class PreviewServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 12

    def __init__(self, config, history, preview_password, media_authorization):
        self.config, self.history = config, history
        self.viewer_authorization = "Basic " + base64.b64encode(("viewer:" + preview_password).encode()).decode()
        self.media_authorization = media_authorization
        self.hls_session = None
        self.hls_session_used = 0
        self.hls_session_lock = threading.Lock()
        self.gate = threading.BoundedSemaphore(12)
        super().__init__(("127.0.0.1", config["bind_port"]), Handler)

    def hls_cookie_header(self):
        with self.hls_session_lock:
            current = self.hls_session if time.monotonic() - self.hls_session_used < 25 else None
        return "cookieCheck=1" + ("; hlsSession=" + current if current else "")

    def accept_hls_session(self, cookie_headers):
        for cookie in cookie_headers:
            found = re.match(r"hlsSession=([0-9a-fA-F-]{36})(?:;|$)", cookie)
            if found:
                value = str(uuid.UUID(found.group(1)))
                with self.hls_session_lock:
                    self.hls_session = value
                    self.hls_session_used = time.monotonic()

    def touch_hls_session(self):
        with self.hls_session_lock:
            self.hls_session_used = time.monotonic()

    def process_request(self, request, address):
        if not self.gate.acquire(False):
            self.shutdown_request(request)
            return
        try:
            request.settimeout(8)
            super().process_request(request, address)
        except Exception:
            self.gate.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.gate.release()

    def handle_error(self, *_):
        pass


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    server_version = "OwnedRawPreview/1"

    def log_message(self, *_):
        pass

    def setup(self):
        super().setup()
        def expire():
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.deadline = threading.Timer(12, expire)
        self.deadline.daemon = True
        self.deadline.start()

    def finish(self):
        self.deadline.cancel()
        super().finish()

    def send(self, status, body, content_type, headers=None):
        self.request_stage = "response_headers"
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; frame-ancestors 'none'")
        if status == 401:
            self.send_header("WWW-Authenticate", 'Basic realm="Owned camera preview"')
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.request_stage = "response_body"
            self.wfile.write(body)
        self.request_stage = "response_complete"
        self.close_connection = True

    def authorized(self):
        headers = self.headers.get_all("Authorization", [])
        return len(headers) == 1 and hmac.compare_digest(headers[0], self.server.viewer_authorization)

    def json_response(self, status, value):
        self.send(status, json.dumps(value, allow_nan=False).encode(), "application/json")

    def proxy_media(self, parsed, kind):
        prefix = "/media/" + kind
        upstream_path = parsed.path[len(prefix):]
        stream = self.server.config["stream_path"]
        if kind == "hls":
            if self.command not in ("GET", "HEAD") or not re.fullmatch(r"/" + re.escape(stream) + r"/[A-Za-z0-9_.-]{1,128}\.(m3u8|mp4|m4s|ts)", upstream_path):
                return self.json_response(404, {"error": "media_path_rejected"})
        else:
            if self.command not in ("OPTIONS", "POST", "PATCH", "DELETE") or not re.fullmatch(r"/" + re.escape(stream) + r"/whep(?:/[A-Za-z0-9_-]{1,128})?", upstream_path):
                return self.json_response(404, {"error": "media_path_rejected"})
        if parsed.query:
            if kind != "hls" or not re.fullmatch(r"(?:cookieCheck=1|_HLS_(?:msn|part)=[0-9]{1,12}|_HLS_skip=(?:YES|v2))(?:&(?:cookieCheck=1|_HLS_(?:msn|part)=[0-9]{1,12}|_HLS_skip=(?:YES|v2)))*", parsed.query):
                return self.json_response(400, {"error": "query_rejected"})
            if "cookieCheck" in dict(parse_qsl(parsed.query)) and not upstream_path.endswith("/index.m3u8"):
                return self.json_response(400, {"error": "cookie_check_path_rejected"})
        query = parsed.query
        if kind == "hls" and upstream_path.endswith("/index.m3u8"):
            # MediaMTX v1.21.2 always probes partitioned browser cookies on its
            # master playlist. Keep that handshake and its session cookie inside
            # this server-side proxy, including on an HTTP SSH tunnel.
            values = dict(parse_qsl(query))
            values["cookieCheck"] = "1"
            query = urlencode(values)
        if query:
            upstream_path += "?" + query
        length = self.headers.get("Content-Length", "0")
        if not re.fullmatch(r"[0-9]{1,6}", length) or int(length) > 65536:
            return self.json_response(413, {"error": "body_limit"})
        body = self.rfile.read(int(length)) if int(length) else None
        headers = {"Authorization": self.server.media_authorization}
        if kind == "hls":
            headers["Cookie"] = self.server.hls_cookie_header()
        if self.headers.get("Content-Type"):
            headers["Content-Type"] = self.headers["Content-Type"]
        for name in ("If-Match", "Range"):
            if self.headers.get(name):
                headers[name] = self.headers[name]
        port = self.server.config["hls_port" if kind == "hls" else "webrtc_port"]
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            connection.request(self.command, upstream_path, body=body, headers=headers)
            response = connection.getresponse()
            payload = response.read(8 * 1024 * 1024 + 1)
            if len(payload) > 8 * 1024 * 1024:
                return self.json_response(502, {"error": "response_limit"})
            returned_headers = {}
            if kind == "hls":
                self.server.accept_hls_session([value for name, value in response.getheaders() if name.lower() == "set-cookie"])
                if 200 <= response.status < 300:
                    self.server.touch_hls_session()
            for name in ("ETag", "Accept-Patch", "Link", "Accept-Ranges", "Content-Range"):
                if response.getheader(name):
                    returned_headers[name] = response.getheader(name)
            location = response.getheader("Location")
            if location:
                location_base = upstream_path.split("?", 1)[0]
                if kind == "webrtc":
                    location_base = location_base.rstrip("/") + "/"
                target = urlsplit(urljoin(location_base, location))
                if target.scheme or target.netloc or target.fragment:
                    return self.json_response(502, {"error": "external_location_rejected"})
                if kind == "hls":
                    if response.status != 302 or target.path != f"/{stream}/index.m3u8" or target.query != "cookieCheck=1":
                        return self.json_response(502, {"error": "hls_location_rejected"})
                    returned_headers["Location"] = prefix + target.path + "?cookieCheck=1"
                else:
                    if target.query or not re.fullmatch(r"/" + re.escape(stream) + r"/whep/[A-Za-z0-9_-]{1,128}", target.path):
                        return self.json_response(502, {"error": "session_location_rejected"})
                    returned_headers["Location"] = prefix + target.path
            self.send(response.status, payload, response.getheader("Content-Type") or "application/octet-stream", returned_headers)
        except Exception as error:
            self.json_response(502, {"error": "media_unavailable", "error_type": type(error).__name__})
        finally:
            connection.close()

    def route(self):
        if not self.authorized():
            return self.json_response(401, {"error": "viewer_auth_required"})
        if len(self.path) > 2048:
            return self.json_response(414, {"error": "uri_limit"})
        parsed = urlsplit(self.path)
        if parsed.path.startswith("/media/hls/"):
            return self.proxy_media(parsed, "hls")
        if parsed.path.startswith("/media/webrtc/"):
            return self.proxy_media(parsed, "webrtc")
        if self.command not in ("GET", "HEAD") or parsed.query:
            return self.json_response(405, {"error": "method_or_query_rejected"})
        if parsed.path == "/config.public.json":
            public = {key: value for key, value in self.server.config.items()
                      if key not in ("bind_port", "inference_port", "hls_port", "webrtc_port", "poll_interval_seconds")}
            return self.json_response(200, public)
        if parsed.path == "/api/results-history":
            return self.json_response(200, self.server.history.snapshot())
        if parsed.path in ASSETS:
            relative, mime = ASSETS[parsed.path]
            self.request_stage = "static_asset_read"
            return self.send(200, (Path(__file__).resolve().parent / relative).read_bytes(), mime)
        return self.json_response(404, {"error": "not_found"})

    def handle_request(self):
        self.request_stage = "routing"
        try:
            self.route()
        except Exception as error:
            print(json.dumps({"owned_preview_request_failed": True,
                              "stage": self.request_stage, "error_type": type(error).__name__,
                              "credentials_or_uri_logged": False}), flush=True)
            self.close_connection = True

    do_GET = do_HEAD = do_OPTIONS = do_POST = do_PATCH = do_DELETE = handle_request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()
    try:
        config = load_config(args.config)
        token, media_user, media_password, viewer_password = (os.environ.get(name, "") for name in
            ("PPE_VIDEO_CAMERA_TOKEN", "PPE_MEDIA_READ_USER", "PPE_MEDIA_READ_PASS", "PPE_PREVIEW_PASS"))
        if len(token) < 32 or len(media_password) < 32 or len(viewer_password) < 32 or not media_user:
            raise ValueError("private_environment_required")
        for relative, _ in ASSETS.values():
            if not (Path(__file__).resolve().parent / relative).is_file():
                raise ValueError("asset_missing")
        if args.check_only:
            print(json.dumps({"preflight": "passed", "bound": False, "upstream_accessed": False}))
            return
        media_auth = "Basic " + base64.b64encode((media_user + ":" + media_password).encode()).decode()
        history = History(config, token)
        server = PreviewServer(config, history, viewer_password, media_auth)
        def shutdown(*_):
            threading.Thread(target=server.shutdown, daemon=True).start()
        signal.signal(signal.SIGINT, shutdown)
        signal.signal(signal.SIGTERM, shutdown)
        history.start()
        print(json.dumps({"owned_preview_started": True, "bind": "127.0.0.1", "port": config["bind_port"], "source": "MAIN", "secrets_logged": False}), flush=True)
        try:
            server.serve_forever(poll_interval=.2)
        finally:
            history.stop.set()
            server.server_close()
            history.thread.join(3)
    except Exception:
        print(json.dumps({"owned_preview_failed": True, "error": "preflight_or_runtime_failure"}), flush=True)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
