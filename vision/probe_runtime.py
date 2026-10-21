"""Probe the actual interpreter; emit only a bounded JSON result on stdout.

--quick checks imports and pinned versions, without loading model weights.
The full probe also executes each of the four model networks on blank inputs.
Neither mode reads business records, opens a camera, or identifies a person.
"""
import argparse
import contextlib
import io
import json
import os
import platform
import sys
import tempfile
import time
from datetime import datetime, timezone


@contextlib.contextmanager
def quiet_native_stdout():
    """Suppress Python and C extension diagnostics, keeping JSON parseable."""
    sys.stdout.flush()
    saved = os.dup(1)
    try:
        with tempfile.TemporaryFile() as sink:
            os.dup2(sink.fileno(), 1)
            with contextlib.redirect_stdout(io.StringIO()):
                yield
    finally:
        os.dup2(saved, 1)
        os.close(saved)


def probe(quick=False):
    started = time.monotonic()
    result = {
        'base': {'ready': False},
        'smoking': {'ready': False},
        'versions': {'python': platform.python_version()},
        'errors': [],
        'checkedAt': datetime.now(timezone.utc).isoformat(),
    }
    np = cv2 = paddle = None
    try:
        import numpy as np
        result['versions']['numpy'] = np.__version__
        if np.__version__ != '2.2.6':
            result['errors'].append('numpy_version_mismatch')
    except Exception:
        result['errors'].append('numpy_import_failed')
    try:
        import cv2
        result['versions']['opencv'] = cv2.__version__
        if cv2.__version__ != '4.12.0':
            result['errors'].append('opencv_version_mismatch')
    except Exception:
        result['errors'].append('opencv_import_failed')
    result['base']['ready'] = np is not None and cv2 is not None and not result['errors']
    os.environ['FLAGS_enable_pir_api'] = '0'
    try:
        import paddle
        result['versions']['paddle'] = paddle.__version__
        if paddle.__version__ != '3.2.2':
            result['errors'].append('paddle_version_mismatch')
        else:
            result['smoking']['ready'] = result['base']['ready']
    except Exception:
        result['errors'].append('paddle_import_failed')

    if not quick and result['base']['ready']:
        try:
            from core import Models
            models = Models()
            blank = np.zeros((480, 640, 3), dtype=np.uint8)
            faces = models.faces(blank)
            objects = models.detect_objects(blank)
            vector = models.recognizer.feature(np.zeros((112, 112, 3), dtype=np.uint8))
            if len(faces) or len(objects) or vector.size != 128 or not np.isfinite(vector).all():
                raise ValueError('invalid_blank_probe')
            result['base']['probe'] = 'blank-frame-inference-passed'
            result['base']['faceCount'] = len(faces)
            result['base']['objectCount'] = len(objects)
            result['base']['featureDimensions'] = int(vector.size)
        except Exception:
            result['base']['ready'] = False
            result['errors'].append('base_inference_failed')

    if not quick and result['smoking']['ready']:
        try:
            from smoking import SmokingModel
            detector = SmokingModel()
            found = detector.detect_crop(np.zeros((480, 640, 3), dtype=np.uint8))
            if found:
                raise ValueError('invalid_blank_probe')
            result['smoking']['probe'] = 'blank-frame-inference-passed'
            result['smoking']['candidateCount'] = len(found)
        except Exception:
            result['smoking']['ready'] = False
            result['errors'].append('smoking_inference_failed')
    result['durationMs'] = round((time.monotonic() - started) * 1000)
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--quick', action='store_true')
    args = parser.parse_args()
    # Most libraries log to stderr. Native stdout is also redirected so API
    # callers cannot receive paths, import diagnostics, or multiple JSON lines.
    with quiet_native_stdout():
        output = probe(args.quick)
    print(json.dumps(output, separators=(',', ':')))
    # Missing optional Paddle is a reported capability state, not a broken
    # protocol; JS can continue serving the three verified OpenCV models.
