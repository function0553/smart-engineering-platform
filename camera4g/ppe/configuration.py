"""Strict, secret-free, single-source video candidate configuration."""
from copy import deepcopy
import ipaddress
import math
import re
from urllib.parse import urlsplit

MODEL_SHA256 = '55f4dd2f53158eac4ff093d938b9fbda80c99454a03672145bbc36f539988249'


def number(value, low, high, name, integer=False):
    if type(value) not in ((int,) if integer else (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError('invalid_' + name)
    return value


def env_name(value):
    return isinstance(value, str) and re.fullmatch(r'[A-Z][A-Z0-9_]{2,80}', value) is not None


def validate_config(value):
    c = deepcopy(value)
    if c.get('schema_version') != 1 or c.get('device') not in ('cpu', 'cuda'):
        raise ValueError('explicit_cpu_or_cuda_required')
    if not isinstance(c.get('model_directory'), str) or not c['model_directory']:
        raise ValueError('model_directory_required')
    c.setdefault('diagnostic_jpeg_enabled', True)
    if type(c['diagnostic_jpeg_enabled']) is not bool:
        raise ValueError('invalid_diagnostic_jpeg_enabled')
    number(c.setdefault('device_id', 0), 0, 32, 'device_id', True)
    number(c.setdefault('intra_threads', 1), 1, 8, 'intra_threads', True)
    limits = c.setdefault('limits', {})
    defaults = {'max_pixels': 4194304, 'max_edge': 4096, 'decode_threads': 1,
                'inference_fps': 1, 'max_person_rois': 0, 'max_pending_age_seconds': 2,
                'result_ttl_seconds': 3, 'open_timeout_seconds': 5, 'read_timeout_seconds': 5,
                'reconnect_seconds': 2, 'max_http_concurrent': 4, 'http_timeout_seconds': 3,
                'max_source_backlog_seconds': 2, 'max_jpeg_bytes': 8*1024*1024}
    for k, v in defaults.items():
        limits.setdefault(k, v)
    limits.setdefault('source_pts_policy', 'observe')
    if limits['source_pts_policy'] not in ('observe', 'strict'):
        raise ValueError('invalid_source_pts_policy')
    for k, lo, hi in [('max_pixels', 1, 25000000), ('max_edge', 1, 8192), ('decode_threads', 1, 4),
                      ('max_person_rois', 0, 4), ('max_http_concurrent', 1, 8), ('max_jpeg_bytes', 1024, 16*1024*1024)]:
        number(limits[k], lo, hi, k, True)
    for k, lo, hi in [('inference_fps', .1, 10), ('max_pending_age_seconds', .1, 30),
                      ('result_ttl_seconds', .1, 30), ('open_timeout_seconds', .1, 10),
                      ('read_timeout_seconds', .1, 10), ('reconnect_seconds', .1, 30),
                      ('http_timeout_seconds', .1, 10), ('max_source_backlog_seconds', .1, 10)]:
        number(limits[k], lo, hi, k)
    p = c.get('camera', {})
    if not isinstance(p, dict) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', p.get('camera_id', '')):
        raise ValueError('camera_id_required')
    if p.get('source_stream') != 'MAIN' or type(p.get('main_source_verified')) is not bool:
        raise ValueError('explicit_main_source_contract_required')
    if not isinstance(p.get('view_id'), str) or not 1 <= len(p['view_id']) <= 64:
        raise ValueError('view_id_required')
    for name in ('source_url_env', 'token_env'):
        if not env_name(p.get(name)):
            raise ValueError('invalid_' + name)
    size = p.get('expected_size')
    if not isinstance(size, list) or len(size) != 2:
        raise ValueError('expected_size_required')
    for edge in size:
        number(edge, 2, limits['max_edge'], 'expected_size', True)
        if edge % 2:
            raise ValueError('yuv420_requires_even_dimensions')
    if math.prod(size) > limits['max_pixels']:
        raise ValueError('expected_size_pixel_limit')
    if p.get('rotation_degrees') not in (0, 90, 180, 270) or type(p.get('rotation_degrees')) is not int:
        raise ValueError('invalid_rotation')
    if type(p.get('mirror_horizontal')) is not bool:
        raise ValueError('invalid_mirror')
    p.setdefault('temporal_confirmation_enabled', False)
    p.setdefault('stream_timing_contract_verified', False)
    for k in ('temporal_confirmation_enabled', 'stream_timing_contract_verified'):
        if type(p[k]) is not bool:
            raise ValueError('invalid_' + k)
    if p['temporal_confirmation_enabled'] and not p['stream_timing_contract_verified']:
        raise ValueError('temporal_confirmation_requires_stream_timing_acceptance')
    if p['temporal_confirmation_enabled'] and limits['source_pts_policy'] != 'strict':
        raise ValueError('observe_pts_cannot_enable_temporal_confirmation')
    if not env_name(c.get('admin_token_env')):
        raise ValueError('admin_token_env_required')
    bind = c.setdefault('bind', {'host': '127.0.0.1', 'port': 8878})
    ipaddress.ip_address(bind.get('host', ''))
    number(bind.get('port'), 1024, 65535, 'http_port', True)
    media = c.setdefault('media', {})
    media.setdefault('enabled', True)
    if type(media['enabled']) is not bool:
        raise ValueError('invalid_media_enabled')
    media.setdefault('encoder', 'libx264')
    if media['encoder'] not in ('libx264', 'h264_nvenc'):
        raise ValueError('unsupported_explicit_encoder')
    if c['device'] == 'cpu' and media['encoder'] != 'libx264':
        raise ValueError('cpu_candidate_requires_libx264')
    media.setdefault('ffmpeg_binary', '/usr/bin/ffmpeg')
    if not isinstance(media['ffmpeg_binary'], str) or not media['ffmpeg_binary']:
        raise ValueError('ffmpeg_binary_required')
    number(media.setdefault('threads', 1), 1, 4, 'encode_threads', True)
    number(media.setdefault('fps', 1), .1, 10, 'media_fps')
    number(media.setdefault('bitrate_kbps', 1200), 128, 20000, 'bitrate_kbps', True)
    number(media.setdefault('write_timeout_seconds', 5), .5, 10, 'write_timeout_seconds')
    if media['enabled']:
        validate_publish_url(media.get('publish_rtsp_url', ''))
    # Public read URLs are optional, secret-free metadata supplied by the deployer.
    for k in ('read_rtsp_url', 'read_web_url'):
        u = media.get(k)
        if u is not None:
            parsed = urlsplit(u)
            if parsed.scheme not in ('rtsp', 'http', 'https') or not parsed.hostname or parsed.username or parsed.password:
                raise ValueError('invalid_' + k)
    return c


def validate_source_url(url):
    if not isinstance(url, str) or len(url) > 4096 or any(ord(x) < 32 for x in url):
        raise ValueError('invalid_source_url')
    p = urlsplit(url)
    if p.scheme not in ('rtsp', 'rtsps') or not p.hostname or p.fragment:
        raise ValueError('rtsp_source_required')
    return url


def validate_publish_url(url):
    p = urlsplit(url)
    if p.scheme != 'rtsp' or p.username or p.password or p.query or p.fragment:
        raise ValueError('secret_free_loopback_publish_required')
    try:
        if not ipaddress.ip_address(p.hostname or '').is_loopback:
            raise ValueError('loopback_publish_required')
    except ValueError:
        raise ValueError('loopback_publish_required') from None
    if not p.path or p.path == '/':
        raise ValueError('publish_path_required')
    return url
