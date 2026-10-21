"""PP-Human's cigarette detector, applied to visible person crops.

Output means a cigarette candidate near a person, not a confirmed action.
Preprocessing follows the official export's infer_cfg.yml (RGB, 640 square,
ImageNet normalization). The export includes NMS and rescales its output boxes.
"""
import hashlib
import json
import os
from pathlib import Path

import cv2
import numpy as np
from model_paths import ROOT, models_directory

SPEC = json.loads((ROOT / 'vision' / 'specialist-models.json').read_text('utf-8'))['smoking']
SMOKING_MODEL_ID = SPEC['id']


class SmokingModel:
    def __init__(self, directory=None):
        directory = Path(directory) if directory is not None else models_directory() / 'smoking'
        self.buffers = {}
        for entry in SPEC['files']:
            data = (directory / entry['name']).read_bytes()
            if len(data) != entry['size'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
                raise ValueError('smoking_model_checksum_mismatch')
            self.buffers[entry['name']] = data
        # This official export is a legacy ProgramDesc, not a PIR model.
        os.environ['FLAGS_enable_pir_api'] = '0'
        from paddle.inference import Config, create_predictor
        config = Config()
        model, weights = self.buffers['model.pdmodel'], self.buffers['model.pdiparams']
        config.set_model_buffer(model, len(model), weights, len(weights))
        config.disable_gpu()
        config.disable_glog_info()
        config.disable_mkldnn()
        config.set_cpu_math_library_num_threads(2)
        self.predictor = create_predictor(config)
        if set(self.predictor.get_input_names()) != {'image', 'scale_factor'}:
            raise ValueError('smoking_model_input_mismatch')

    def detect_crop(self, crop, threshold=0.5):
        height, width = crop.shape[:2]
        rgb = cv2.cvtColor(cv2.resize(crop, (640, 640), interpolation=cv2.INTER_CUBIC), cv2.COLOR_BGR2RGB)
        data = (rgb.astype(np.float32) / 255.0 - np.array([.485, .456, .406], np.float32)) / np.array([.229, .224, .225], np.float32)
        inputs = {'image': data.transpose(2, 0, 1)[None], 'scale_factor': np.array([[640/height, 640/width]], np.float32)}
        for name, value in inputs.items():
            self.predictor.get_input_handle(name).copy_from_cpu(np.ascontiguousarray(value))
        self.predictor.run()
        boxes = self.predictor.get_output_handle(self.predictor.get_output_names()[0]).copy_to_cpu()
        result = []
        # The exported label_list incorrectly contains COCO names; the official
        # training config and action adapter define class 0 as cigarette only.
        for cls, score, x1, y1, x2, y2 in boxes:
            if int(cls) != 0 or not np.isfinite([score, x1, y1, x2, y2]).all() or score < threshold:
                continue
            x1, y1 = max(0., float(x1)), max(0., float(y1))
            x2, y2 = min(float(width), float(x2)), min(float(height), float(y2))
            if x2 > x1 and y2 > y1:
                result.append(dict(box=[x1, y1, x2-x1, y2-y1], confidence=float(score)))
        return result

    def detect(self, image, persons, threshold=0.5):
        height, width = image.shape[:2]
        results = []
        for person in persons:
            x, y, w, h = person['box']
            left, top = max(0, int(x-w*.1)), max(0, int(y-h*.1))
            right, bottom = min(width, int(x+w*1.1)), min(height, int(y+h*1.1))
            if right-left < 32 or bottom-top < 32:
                continue
            candidates = self.detect_crop(image[top:bottom, left:right], threshold)
            if not candidates:
                continue
            # One result for each person in each newly analyzed frame. Never
            # replay the previous frame's positive result as a new detection.
            best = max(candidates, key=lambda item: item['confidence'])
            bx, by, bw, bh = best['box']
            results.append(dict(algorithm='smoking', modelId=SMOKING_MODEL_ID,
                objectId=person['objectId'], confidence=best['confidence'], point=person['point'],
                personBox=person['box'], box=[bx+left, by+top, bw, bh]))
        return results
