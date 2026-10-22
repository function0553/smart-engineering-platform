"""Camera RGB presentation attack checks using pinned Minivision models.

Crop preprocessing is the unmodified Apache-2.0 upstream fas_crop.py.
RGB PAD needs field evaluation; scores are model outputs, not guarantees.
"""
import hashlib
import json
import math
from pathlib import Path
import time


def decision(scores, min_pixels, threshold=.9, individual_threshold=.8):
    if (len(scores) != 2 or not all(math.isfinite(float(x)) and 0 <= x <= 1 for x in scores)
            or not math.isfinite(min_pixels) or min_pixels < 80):
        return 'unknown'
    return 'passed' if sum(scores)/2 >= threshold and min(scores) >= individual_threshold else 'rejected'


class Liveness:
    def __init__(self, directory):
        import onnxruntime as ort
        root=Path(directory)
        manifest=json.loads((root/'model-manifest.json').read_text())
        self.model_id='silent-face:'+manifest['commit']+':dual-scale'
        expected=['2.7_80x80_MiniFASNetV2.onnx','4_0_0_80x80_MiniFASNetV1SE.onnx']
        if [x['filename'] for x in manifest['models']] != expected or manifest['live_class_index'] != 1:
            raise ValueError('unexpected_liveness_model_set')
        self.models=[]
        for info in manifest['models']:
            path=root/info['filename']
            if hashlib.sha256(path.read_bytes()).hexdigest()!=info['onnx_sha256']:
                raise ValueError('liveness_model_hash_mismatch')
            opts=ort.SessionOptions();opts.intra_op_num_threads=2;opts.inter_op_num_threads=1
            session=ort.InferenceSession(str(path),sess_options=opts,providers=['CPUExecutionProvider'])
            self.models.append((info,session))

    def evaluate(self,image,bbox):
        import numpy as np
        from fas_crop import CropImage
        began=time.monotonic()
        x1,y1,x2,y2=map(float,bbox)
        pixels=min(x2-x1,y2-y1)
        if (image.ndim!=3 or image.shape[2]!=3 or image.dtype!=np.uint8
                or not all(np.isfinite([x1,y1,x2,y2])) or pixels<80
                or x1<0 or y1<0 or x2>image.shape[1] or y2>image.shape[0]):
            return {'state':'unknown','reason':'face_too_small_or_invalid','model_id':self.model_id}
        scores=[]
        for info,session in self.models:
            patch=CropImage().crop(image,[x1,y1,x2-x1,y2-y1],info['scale'],80,80)
            value=np.ascontiguousarray(patch.transpose(2,0,1)[None],dtype=np.float32)
            output=session.run(None,{'image':value})[0][0]
            if output.shape!=(3,) or not np.all(np.isfinite(output)):
                raise ValueError('invalid_liveness_output')
            scores.append(float(output[1]))
        return {'state':decision(scores,pixels),'model_id':self.model_id,
                'individual_live_scores':scores,'mean_live_score':sum(scores)/2,
                'threshold':.9,'individual_threshold':.8,'min_face_pixels':pixels,
                'processing_ms':(time.monotonic()-began)*1000}
