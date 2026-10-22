"""Optional clean H264 display transcoder, separate from sampled inference.

Preserves every decoded source image and resolution. Rebuilds a display-only
monotonic frame-count timebase; the separate inference JSON keeps original PTS.
No YOLO, JPEG, boxes, scaling, fps filter or intentional frame drop/duplication.
"""
import argparse
import json
import os
import re
import signal
import subprocess
from urllib.parse import parse_qs, urlsplit


def command(ffmpeg, source, threads, display_fps=15):
    parsed = urlsplit(source)
    query = parse_qs(parsed.query, keep_blank_values=True)
    if (parsed.scheme != "rtsp" or parsed.hostname != "127.0.0.1" or parsed.port != 12854 or
            parsed.path != "/camera_main" or parsed.username or parsed.password or parsed.fragment or
            any(key != "stream" for key in query) or query.get("stream", ["0"]) != ["0"]):
        raise ValueError("dedicated_uncredentialed_loopback_main_source_required")
    if type(display_fps) is not int or not 1 <= display_fps <= 30:
        raise ValueError("bounded_display_cadence_required")
    return [ffmpeg, "-hide_banner", "-nostdin", "-loglevel", "error", "-nostats", "-filter_threads", "1",
            "-rtsp_transport", "tcp", "-allowed_media_types", "video", "-timeout", "12000000",
            "-fflags", "nobuffer", "-flags", "low_delay", "-probesize", "32768",
            "-analyzeduration", "1000000", "-threads", "1", "-i", source,
            "-map", "0:v:0", "-an", "-c:v", "libx264", "-threads", str(threads),
            "-vf", f"settb=1/90000,setpts=N/({display_fps}*TB)",
            "-enc_time_base", f"1:{display_fps}",
            "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline",
            "-pix_fmt", "yuv420p", "-bf", "0", "-g", str(display_fps), "-keyint_min", str(display_fps),
            "-sc_threshold", "0", "-b:v", "4M", "-maxrate", "4M", "-bufsize", "8M",
            "-fps_mode", "passthrough", "-rtsp_transport", "tcp", "-f", "rtsp",
            "rtsp://127.0.0.1:28554/raw-main"]


def safe_error(raw):
    message = raw.decode("utf-8", errors="replace")
    message = re.sub(r"[a-zA-Z][a-zA-Z0-9+.-]*://[^\s]+", "<owned-media-url>", message)
    message = "".join(char for char in message if 32 <= ord(char) < 127)[:512]
    if re.search(r"authorization|password|passwd|token|secret|cookie", message, re.I):
        message = "credential-like error content redacted"
    lower = message.lower()
    label = "ffmpeg_error"
    for words, value in ((r"option|unrecognized|not found", "option_or_component_error"),
                         (r"timestamp|non.monoton|pts|dts", "timestamp_error"),
                         (r"ref with poc|decode|corrupt|invalid nal", "decode_error"),
                         (r"refused|timed out|connection|broken pipe", "connection_error"),
                         (r"filter|expression|setpts|settb", "filter_error")):
        if re.search(words, lower):
            label = value
            break
    return label, message


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--threads", type=int, choices=(1, 2, 3, 4), default=2)
    parser.add_argument("--display-fps", type=int, choices=range(1, 31), default=15,
                        help="display timebase cadence, measured separately from camera metadata")
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()
    import imageio_ffmpeg
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    source = os.environ.get("PPE_RAW_SOURCE_URL", "rtsp://127.0.0.1:12854/camera_main?stream=0")
    argv = command(ffmpeg, source, args.threads, args.display_fps)
    if args.check_only:
        print(json.dumps({"preflight": "passed", "ffmpeg_started": False,
                          "display_independent_of_inference": True, "rescale_or_fps_filter": False,
                          "display_timebase": "frame_count_reencoded", "configured_display_fps": args.display_fps,
                          "actual_cadence_verified": False, "original_json_pts_modified": False}))
        return
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.PIPE, start_new_session=True)
    def stop(*_):
        if process.poll() is None:
            process.terminate()
    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    print(json.dumps({"owned_clean_transcoder_started": True, "configured_display_fps": args.display_fps,
                      "display_timebase": "frame_count_reencoded", "actual_cadence_verified": False,
                      "original_json_pts_modified": False, "camera_codec_modified": False}), flush=True)
    try:
        reported = 0
        # Always drain the owned child's pipe. Only a small, sanitized diagnostic
        # sample enters its journal; never dump argv or upstream URLs.
        while True:
            raw = process.stderr.readline(2048)
            if not raw:
                break
            if reported < 12:
                label, message = safe_error(raw)
                print(json.dumps({"owned_clean_transcoder_error": label, "message": message}), flush=True)
                reported += 1
        return_code = process.wait()
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(3)
    print(json.dumps({"owned_clean_transcoder_stopped": True, "return_code": return_code}), flush=True)
    raise SystemExit(0 if return_code == 0 else 1)


if __name__ == "__main__":
    main()
