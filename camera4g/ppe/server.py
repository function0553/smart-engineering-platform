"""Isolated RTSP inference service. Importing does not access any source."""
import argparse
import json
import os
from pathlib import Path
import signal
import threading

import cv2

from annotation_zh import chinese_font
from configuration import validate_config, validate_source_url
from engine import Detector
from http_api import BoundedHTTPServer
from media_publisher import FFmpegPublisher
from rtsp_reader import RTSPReader
from video_runtime import VideoRuntime


def resolve(config_path):
    path = Path(config_path).resolve()
    c = validate_config(json.loads(path.read_text(encoding='utf-8')))
    model = Path(c['model_directory'])
    c['model_directory'] = str(model if model.is_absolute() else path.parent/model)
    p = c['camera']
    source = validate_source_url(os.environ.get(p['source_url_env']))
    tokens = {'admin': os.environ.get(c['admin_token_env']), p['camera_id']: os.environ.get(p['token_env'])}
    if any(not isinstance(t, str) or len(t.encode()) < 32 for t in tokens.values()) or len(set(tokens.values())) != 2:
        raise ValueError('required_distinct_tokens_missing')
    # Private venv FFmpeg avoids changing a server's global media installation.
    if c['media']['enabled'] and c['media']['ffmpeg_binary'] == 'imageio':
        import imageio_ffmpeg
        c['media']['ffmpeg_binary'] = imageio_ffmpeg.get_ffmpeg_exe()
    if c['media']['enabled'] and not Path(c['media']['ffmpeg_binary']).is_file():
        raise ValueError('ffmpeg_binary_missing')
    return c, source, tokens


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    parser.add_argument('--check-only', action='store_true', help='Validate local config/env/assets; never connect or bind')
    args = parser.parse_args()
    try:
        c, source, tokens = resolve(args.config)
        if c['media']['enabled'] or c['diagnostic_jpeg_enabled']:
            chinese_font(16)
        cv2.setNumThreads(1)
        detector = Detector(c['model_directory'], device=c['device'], device_id=c['device_id'],
                            intra_threads=c['intra_threads'], person_conf=.20)
        publisher = FFmpegPublisher(c) if c['media']['enabled'] else None
        runtime = VideoRuntime(c, detector, tokens, publisher)
        if args.check_only:
            print(json.dumps({'stage': 'local_preflight_passed', 'model_sha256': detector.sha256,
                              'backend': detector.contract, 'source_contacted': False, 'listener_started': False}))
            return
        if not c['camera']['main_source_verified']:
            raise ValueError('main_source_not_verified')
        server = BoundedHTTPServer((c['bind']['host'], c['bind']['port']), runtime)
        reader = RTSPReader(runtime, source)
        def stop(*_):
            threading.Thread(target=server.shutdown, daemon=True).start()
        signal.signal(signal.SIGINT, stop)
        signal.signal(signal.SIGTERM, stop)
        runtime.start()
        reader.start()
        print(json.dumps({'stage': 'video_candidate_started', 'http_bind': list(server.server_address),
                          'model_sha256': detector.sha256, 'backend': detector.contract,
                          'production_accepted': False}), flush=True)
        try:
            server.serve_forever(poll_interval=.2)
        finally:
            server.server_close()
            reader_stopped = reader.stop()
            runtime_stopped = runtime.stop()
            print(json.dumps({'stage': 'video_candidate_stopped', 'reader_joined': reader_stopped,
                              'inference_joined': runtime_stopped}), flush=True)
            if not reader_stopped or not runtime_stopped:
                raise RuntimeError('owned_thread_stop_unverified')
    except Exception:
        # Native/model/network errors can contain paths or authenticated URLs.
        print(json.dumps({'stage': 'video_candidate_failed', 'error': 'preflight_or_runtime_failed'}), flush=True)
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
