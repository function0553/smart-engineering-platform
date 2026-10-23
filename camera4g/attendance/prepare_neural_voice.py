"""Offline Mandarin neural TTS: JSON name to raw 8 kHz mono PCMA JSON.

Run with the separate sherpa-onnx TTS Python environment and --model-dir.
No network request or camera playback is performed by this adapter.
"""
import argparse
import base64
import json
from pathlib import Path
import re
import subprocess
import sys


def prepare(name, model_dir):
    if not isinstance(name, str) or not re.fullmatch(r'[\w\u3400-\u9fff·• .-]{1,40}', name.strip()):
        raise ValueError('invalid_name')
    directory = Path(model_dir)
    if not directory.is_absolute():
        raise ValueError('absolute_model_directory_required')
    for item in ['model.onnx', 'lexicon.txt', 'tokens.txt']:
        if not (directory / item).is_file():
            raise ValueError('neural_voice_model_missing')
    import numpy as np
    import sherpa_onnx

    text = name.strip() + '打卡成功'
    config = sherpa_onnx.OfflineTtsConfig(
        model=sherpa_onnx.OfflineTtsModelConfig(
            vits=sherpa_onnx.OfflineTtsVitsModelConfig(
                model=str(directory / 'model.onnx'),
                lexicon=str(directory / 'lexicon.txt'),
                tokens=str(directory / 'tokens.txt'),
                dict_dir=str(directory / 'dict'),
            ),
            num_threads=2, provider='cpu', debug=False,
        ),
        max_num_sentences=1,
    )
    if not config.validate():
        raise ValueError('neural_voice_config_invalid')
    tts = sherpa_onnx.OfflineTts(config)
    generated = tts.generate(text, sid=0, speed=0.92)
    samples = np.asarray(generated.samples, dtype='<f4')
    if not 0 < generated.sample_rate <= 192000 or not np.isfinite(samples).all():
        raise ValueError('invalid_neural_audio')
    duration = len(samples) / generated.sample_rate
    if not 0.25 <= duration <= 14:
        raise ValueError('invalid_audio_length')
    audio = subprocess.run(
        ['ffmpeg', '-nostdin', '-hide_banner', '-loglevel', 'error',
         '-f', 'f32le', '-ar', str(generated.sample_rate), '-ac', '1', '-i', 'pipe:0',
         '-ar', '8000', '-ac', '1', '-f', 'alaw', 'pipe:1'],
        input=samples.tobytes(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        check=True, timeout=8,
    ).stdout
    if not 2000 <= len(audio) <= 120000:
        raise ValueError('invalid_audio_length')
    return {'voice_text': text, 'voice_pcma_base64': base64.b64encode(audio).decode()}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model-dir', required=True)
    options = parser.parse_args()
    try:
        request = sys.stdin.read(1025)
        if len(request) > 1024:
            raise ValueError('input_too_large')
        print(json.dumps(prepare(json.loads(request)['name'], options.model_dir), ensure_ascii=False))
    except Exception:
        print('gpu_neural_name_voice_failed', file=sys.stderr)
        sys.exit(1)
