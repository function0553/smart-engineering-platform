"""Owned FFmpeg encoder; raw frames in, standard RTSP out, no protocol code."""
from fractions import Fraction
from pathlib import Path
import subprocess
import threading
from uuid import uuid4

from configuration import validate_publish_url


def command(config, width, height, output=None):
    m = config['media']
    fps = str(Fraction(str(m['fps'])))
    args = [m['ffmpeg_binary'], '-hide_banner', '-loglevel', 'error', '-nostats',
            '-f', 'rawvideo', '-pixel_format', 'bgr24', '-video_size', f'{width}x{height}',
            '-framerate', fps, '-i', 'pipe:0', '-an', '-c:v', m['encoder'],
            '-threads', str(m['threads']), '-pix_fmt', 'yuv420p',
            '-b:v', f"{m['bitrate_kbps']}k", '-maxrate', f"{m['bitrate_kbps']}k",
            '-bufsize', f"{m['bitrate_kbps']}k", '-g', str(max(1,round(m['fps']*2))), '-bf', '0']
    if m['encoder'] == 'libx264':
        args += ['-preset', 'ultrafast', '-tune', 'zerolatency']
    else:
        args += ['-preset', 'p1', '-tune', 'ull']
    if output is None:
        args += ['-rtsp_transport', 'tcp', '-rw_timeout', str(round(m['write_timeout_seconds']*1000000)),
                 '-f', 'rtsp', validate_publish_url(m['publish_rtsp_url'])]
    else:
        # Only the explicit finite offline verifier supplies this existing parent
        # directory file; deployment config cannot redirect an encoder to disk.
        args += ['-f', 'mp4', '-movflags', '+faststart', '-y', str(Path(output).resolve())]
    return args


class FFmpegPublisher:
    def __init__(self, config, output=None, popen=subprocess.Popen):
        self.config, self.output, self.popen = config, output, popen
        self.process = None
        self.epoch = None
        self.media_session_id = None
        self.frame_index = 0
        self.lock = threading.Lock()
        self.last_error = None

    def _close(self, graceful=False):
        p, self.process = self.process, None
        if p is None:
            return
        try:
            if graceful and p.stdin:
                p.stdin.close()
            elif p.poll() is None:
                p.kill()
            p.wait(timeout=3)
        except (OSError, subprocess.TimeoutExpired):
            if p.poll() is None:
                p.kill()
            try:
                p.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.last_error = 'encoder_reap_timeout'
        finally:
            if p.stdin and not p.stdin.closed:
                p.stdin.close()

    def reset(self):
        with self.lock:
            self._close()
            self.epoch = None

    def write(self, epoch, image):
        with self.lock:
            if self.epoch != epoch or self.process is None or self.process.poll() is not None:
                self._close()
                self.media_session_id = uuid4().hex
                self.frame_index = 0
                self.epoch = epoch
                try:
                    self.process = self.popen(command(self.config, image.shape[1], image.shape[0], self.output),
                        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                        bufsize=0, shell=False)
                except (OSError, ValueError):
                    self.last_error = 'encoder_start_failed'
                    return None
            p = self.process
            expired = threading.Event()
            def expire():
                expired.set()
                if p.poll() is None:
                    try:
                        p.kill()  # Only this owned, still-running FFmpeg process.
                    except OSError:
                        pass
            timer = threading.Timer(self.config['media']['write_timeout_seconds'], expire)
            timer.daemon = True
            timer.start()
            try:
                data = memoryview(image).cast('B')
                while data:
                    written = p.stdin.write(data)
                    if not written:
                        raise BrokenPipeError()
                    data = data[written:]
                if expired.is_set() or p.poll() is not None:
                    raise BrokenPipeError()
                index = self.frame_index
                self.frame_index += 1
                self.last_error = None
                return {'media_session_id': self.media_session_id, 'video_frame_index': index,
                        'video_pts_seconds': index/self.config['media']['fps'],
                        'media_delivery_status': 'encoder_input_written_not_remote_receipt'}
            except (OSError, ValueError):
                self.last_error = 'encoder_write_timeout' if expired.is_set() else 'encoder_write_failed'
                self._close()
                return None
            finally:
                timer.cancel()

    def close(self, graceful=False):
        with self.lock:
            self._close(graceful)
