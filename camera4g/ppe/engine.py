"""Offline reference detector and conservative per-person PPE association.

Geometric association is a baseline. Crowded/occluded cases stay unknown;
these anonymous track IDs must never be used as face or attendance identities.
"""
from collections import deque
from dataclasses import dataclass, field
import ast
import hashlib
import json
import math
from pathlib import Path
import time

import cv2
import numpy as np
import onnxruntime as ort

LABELS = ['person', 'hardhat', 'no-hardhat', 'safety vest', 'no-safety vest',
          'no-mask', 'gloves', 'safety shoes', 'excavator', 'wheel loader',
          'dump truck', 'goggles', 'no-goggles', 'no-gloves']
PPE = {'hardhat': ('helmet', 'worn'), 'no-hardhat': ('helmet', 'not_worn'),
       'safety vest': ('vest', 'worn'), 'no-safety vest': ('vest', 'not_worn')}


def orient_frame(bgr, rotation_degrees, mirror_horizontal=False):
    """Rotate clockwise, then mirror left/right in the resulting image space."""
    if type(rotation_degrees) is not int or rotation_degrees not in (0, 90, 180, 270):
        raise ValueError('Supported clockwise rotations are 0, 90, 180 and 270 degrees')
    if type(mirror_horizontal) is not bool:
        raise ValueError('mirror_horizontal must be a boolean')
    rotations = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180,
                 270: cv2.ROTATE_90_COUNTERCLOCKWISE}
    image = cv2.rotate(bgr, rotations[rotation_degrees]) if rotation_degrees else bgr
    return cv2.flip(image, 1) if mirror_horizontal else image

def iou(a, b):
    intersection = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    area_a = max(0, a[2]-a[0]) * max(0, a[3]-a[1])
    area_b = max(0, b[2]-b[0]) * max(0, b[3]-b[1])
    return intersection / max(area_a + area_b - intersection, 1e-8)

def letterbox(bgr, size=640):
    h, w = bgr.shape[:2]
    gain = min(size / w, size / h)
    nw, nh = round(w * gain), round(h * gain)
    left, top = (size - nw) // 2, (size - nh) // 2
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    canvas[top:top+nh, left:left+nw] = cv2.resize(bgr, (nw, nh))
    tensor = np.ascontiguousarray(canvas[:, :, ::-1].transpose(2, 0, 1)[None], dtype=np.float32) / 255
    return tensor, (nw / w, nh / h, left, top)

def decode(raw, shape, transform, conf=.4, nms=.45, person_conf=None):
    if person_conf is not None and not 0 < person_conf <= conf:
        raise ValueError('Person floor must be positive and no higher than the main confidence')
    if raw.ndim != 3 or raw.shape[0] != 1 or raw.shape[1] != 4 + len(LABELS):
        raise ValueError('Unsupported ONNX output contract')
    rows = raw[0].T
    rows = rows[np.isfinite(rows).all(axis=1)]
    classes = np.argmax(rows[:, 4:], axis=1)
    scores = rows[np.arange(len(rows)), 4 + classes]
    thresholds = np.where(classes == 0, conf if person_conf is None else person_conf, conf)
    keep = (scores >= thresholds) & (rows[:, 2] > 0) & (rows[:, 3] > 0)
    rows, classes, scores = rows[keep], classes[keep], scores[keep]
    result = []
    sx, sy, left, top = transform
    h, w = shape[:2]
    for cid in sorted(set(classes.tolist())):
        indices = np.where(classes == cid)[0]
        boxes = [[float(x-y/2) for x,y in zip(row[:2], row[2:4])] + row[2:4].tolist() for row in rows[indices]]
        class_floor = person_conf if cid == 0 and person_conf is not None else conf
        selected = cv2.dnn.NMSBoxes(boxes, scores[indices].tolist(), class_floor, nms)
        for k in np.asarray(selected).reshape(-1):
            idx = indices[int(k)]
            cx, cy, bw, bh = rows[idx, :4]
            box = [float(np.clip((cx-bw/2-left)/sx, 0, w)), float(np.clip((cy-bh/2-top)/sy, 0, h)),
                   float(np.clip((cx+bw/2-left)/sx, 0, w)), float(np.clip((cy+bh/2-top)/sy, 0, h))]
            if box[2] > box[0] and box[3] > box[1]:
                result.append({'label': LABELS[cid], 'confidence': float(scores[idx]), 'box': box})
    return result

class Detector:
    def __init__(self, directory, conf=.4, device='cpu', device_id=0, profile_prefix=None, person_conf=None, intra_threads=1):
        if device not in ('cpu', 'cuda'):
            raise ValueError('Server device must be explicitly cpu or cuda; DirectML is unsupported')
        if type(device_id) is not int or device_id < 0:
            raise ValueError('device_id must be a nonnegative integer')
        if type(intra_threads) is not int or not 1 <= intra_threads <= 8:
            raise ValueError('intra_threads must be between 1 and 8')
        directory = Path(directory)
        config = json.loads((directory / 'config.json').read_text(encoding='utf-8'))
        if config['classes'] != LABELS or config['imgsz'] != 640:
            raise ValueError('Model class/input contract mismatch')
        model_path = directory / config['onnx']
        self.sha256 = hashlib.sha256(model_path.read_bytes()).hexdigest()
        provenance = json.loads((directory / 'provenance.json').read_text(encoding='utf-8'))
        record = next(r for r in provenance['files'] if r['file'] == config['onnx'])
        if self.sha256 != record['sha256']:
            raise ValueError('Local model integrity mismatch')
        options = ort.SessionOptions()
        options.intra_op_num_threads = intra_threads
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        options.add_session_config_entry('session.inter_op.allow_spinning', '0')
        if profile_prefix:
            options.enable_profiling = True
            options.profile_file_prefix = str(profile_prefix)
        provider = 'CUDAExecutionProvider' if device == 'cuda' else 'CPUExecutionProvider'
        if provider not in ort.get_available_providers():
            raise RuntimeError('Required execution provider missing: ' + provider)
        if device == 'cuda':
            options.add_session_config_entry('session.disable_cpu_ep_fallback','1')
            providers = [('CUDAExecutionProvider', {'device_id': device_id})]
        else:
            providers = ['CPUExecutionProvider']
        self.session = ort.InferenceSession(str(model_path), options, providers=providers)
        self.session.disable_fallback()
        if self.session.get_providers()[0] != provider:
            raise RuntimeError('Required provider initialization failed; fallback is disabled')
        inputs = self.session.get_inputs()
        outputs = self.session.get_outputs()
        if len(inputs) != 1 or inputs[0].shape != [1, 3, 640, 640] or inputs[0].type != 'tensor(float)':
            raise ValueError('Unsupported input contract')
        if len(outputs) != 1 or outputs[0].shape[:2] != [1, 18]:
            raise ValueError('Unsupported output contract')
        names = self.session.get_modelmeta().custom_metadata_map.get('names')
        if names:
            parsed = ast.literal_eval(names)
            labels = [parsed[i] for i in range(len(parsed))] if isinstance(parsed, dict) else parsed
            if labels != LABELS:
                raise ValueError('Embedded model labels disagree')
        self.input_name = inputs[0].name
        self.conf = conf
        if person_conf is not None and not 0 < person_conf <= conf:
            raise ValueError('Invalid person confidence floor')
        self.person_conf = person_conf
        self.contract = {'input': inputs[0].shape, 'output': outputs[0].shape, 'providers': self.session.get_providers(),
                         'requested_provider': provider, 'device': device, 'device_id': device_id,
                         'cpu_fallback_disabled': device == 'cuda',
                         'intra_threads': intra_threads, 'inter_threads': 1, 'thread_spinning': False}

    def predict(self, bgr):
        tensor, transform = letterbox(bgr)
        started = time.perf_counter()
        raw = self.session.run(None, {self.input_name: tensor})[0]
        ms = (time.perf_counter() - started) * 1000
        return decode(raw, bgr.shape, transform, self.conf, person_conf=self.person_conf), ms

def load_region(path, view_id):
    data = json.loads(Path(path).read_text(encoding='utf-8-sig'))
    region = data['region']
    if data.get('schema_version') != 1 or data.get('view_id') != view_id:
        raise ValueError('Region schema/view mismatch')
    if region.get('role') != 'work_area' or region.get('coordinate_space') != 'normalized_0_1' or region.get('shape') != 'rectangle':
        raise ValueError('Unsupported work-area contract')
    x, y, w, h = [region[k] for k in ('x','y','width','height')]
    if any(isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) for v in (x,y,w,h)):
        raise ValueError('Invalid region coordinates')
    if not (0 <= x < 1 and 0 <= y < 1 and w > 0 and h > 0 and x+w <= 1 and y+h <= 1):
        raise ValueError('Region outside image')
    return region

def associate(detections, shape, region=None):
    h, w = shape[:2]
    def resolved_person_roi(detection, person, item):
        # A source-resolution crop can retain detail lost in full-frame 640px
        # inference. Require provenance and both source-pixel and tensor sizes;
        # magnifying a tiny original image does not create visible PPE evidence.
        context = detection.get('roi_context')
        if detection.get('evidence_source') != 'person_roi' or not isinstance(context, dict):
            return False
        if (context.get('source_frame_size') != [w, h] or
                context.get('detector_input_size') != [640, 640] or
                context.get('source_person_box') != person['box'] or
                context.get('touches_crop_boundary') is not False):
            return False
        crop = context.get('crop_xyxy')
        if not isinstance(crop, (list, tuple)) or len(crop) != 4 or not all(type(v) is int for v in crop):
            return False
        left, top, right, bottom = crop
        if not (0 <= left < right <= w and 0 <= top < bottom <= h):
            return False
        x1, y1, x2, y2 = person['box']
        a, b, c, d = detection['box']
        if not all(math.isfinite(float(v)) for v in (x1, y1, x2, y2, a, b, c, d)):
            return False
        # A crop cannot restore a body/equipment region cut off at the source
        # boundary. The existing global clipping rule is also applied below.
        if not (1 < x1 < x2 < w-1 and 1 < y1 < y2 < h-1 and
                left <= x1 < x2 <= right and top <= y1 < y2 <= bottom and
                left < a < c < right and top < b < d < bottom):
            return False
        pw, ph, ew, eh = x2-x1, y2-y1, c-a, d-b
        minimum = (12, 12) if item == 'helmet' else (20, 24)
        if pw < 32 or ph < 96 or ew < minimum[0] or eh < minimum[1]:
            return False
        gain = min(640/(right-left), 640/(bottom-top))
        sx = round((right-left)*gain)/(right-left)
        sy = round((bottom-top)*gain)/(bottom-top)
        return pw*sx >= 20 and ph*sy >= 64 and ew*sx >= minimum[0] and eh*sy >= minimum[1]

    # Associate all people before ROI filtering, so an outside worker cannot donate PPE.
    persons = [d for d in detections if d['label'] == 'person']
    votes = [{k: set() for k in ('helmet','vest')} for _ in persons]
    evidence = [{k: [] for k in ('helmet','vest')} for _ in persons]
    ambiguous = [{k: False for k in ('helmet','vest')} for _ in persons]
    for detection in detections:
        if detection['label'] not in PPE:
            continue
        item, state = PPE[detection['label']]
        a, b, c, d = detection['box']
        cx, cy = (a+c)/2, (b+d)/2
        candidates = []
        possible_owners = []
        for i, person in enumerate(persons):
            x1,y1,x2,y2 = person['box']
            ph = y2-y1
            intersection = max(0,min(c,x2)-max(a,x1))*max(0,min(d,y2)-max(b,y1))
            contained = intersection / max((c-a)*(d-b),1e-8)
            # A seated/occluded person's box can end at the waist. A vest centre
            # beyond 72% of that box is still torso evidence. Use its upper edge
            # plus containment; keep low leg boxes and neighbouring clothes out.
            if item == 'vest':
                vertical_match = b <= y1+.60*ph and y1+.15*ph <= cy <= y2
                geometry_match = contained >= .70
            else:
                vertical_match = y1-.08*ph <= cy <= y1+.35*ph
                geometry_match = contained >= .50
            if x1 <= cx <= x2 and geometry_match:
                possible_owners.append(i)
                if vertical_match:
                    candidates.append(i)
        if len(candidates) == 1 and len(possible_owners) == 1:
            votes[candidates[0]][item].add(state)
            evidence[candidates[0]][item].append(detection)
        elif candidates and len(possible_owners) > 1:
            # A partial/occluded neighbour may fail the normal body-ratio rule.
            # It still competes for a garment contained in its visible body box.
            for i in possible_owners:
                ambiguous[i][item] = True
    results = []
    for i, person in enumerate(persons):
        x1,y1,x2,y2 = person['box']
        if region:
            foot_x, foot_y = (x1+x2)/2/w, y2/h
            if not (region['x'] <= foot_x <= region['x']+region['width'] and region['y'] <= foot_y <= region['y']+region['height']):
                continue
        # Full-frame detections require enough pixels after the global resize.
        # Independently qualified high-resolution ROI evidence may resolve each
        # item; do not discard it solely because the full frame was reduced.
        gain = min(640/w, 640/h)
        too_small = (x2-x1)*gain < 20 or (y2-y1)*gain < 64
        states, reasons = {}, {}
        for item in ('helmet','vest'):
            clipped = y1 <= 1 or (item == 'vest' and y2 >= h-1)
            choices = votes[i][item]
            roi_resolved = any(resolved_person_roi(d, person, item) for d in evidence[i][item])
            reason = ('small_person' if too_small and not roi_resolved else 'clipped_person' if clipped else
                      'ambiguous_association' if ambiguous[i][item] else
                      'conflicting_evidence' if len(choices) > 1 else 'no_explicit_evidence' if not choices else 'explicit_detection')
            states[item] = next(iter(choices)) if reason == 'explicit_detection' else 'unknown'
            reasons[item] = reason
        results.append({**person, 'raw_states': states, 'reasons': reasons, 'evidence': evidence[i]})
    return results

@dataclass
class Track:
    box: list
    timestamp: float
    histories: dict = field(default_factory=lambda: {k: deque(maxlen=5) for k in ('helmet','vest')})

class TemporalPPE:
    def __init__(self, max_gap_seconds=.6):
        if not 0 < max_gap_seconds <= 1.5:
            raise ValueError('Confirmation gap must be within track lifetime')
        self.max_gap_seconds = max_gap_seconds
        self.tracks = {}
        self.next_id = 1
        self.last_timestamp = None

    def update(self, persons, timestamp):
        if not math.isfinite(timestamp) or (self.last_timestamp is not None and timestamp <= self.last_timestamp):
            raise ValueError('Timestamps must increase')
        self.last_timestamp = timestamp
        self.tracks = {k:v for k,v in self.tracks.items() if timestamp-v.timestamp <= 1.5}
        candidates = [[k for k,v in self.tracks.items() if iou(p['box'],v.box) >= .35] for p in persons]
        usage = {k:sum(k in c for c in candidates) for k in self.tracks}
        used = set()
        results = []
        for p, possible in zip(persons, candidates):
            unique = len(possible) == 1 and usage[possible[0]] == 1
            if unique:
                tid = possible[0]
                track = self.tracks[tid]
                if timestamp-track.timestamp > self.max_gap_seconds:
                    for history in track.histories.values():
                        history.clear()
            else:
                tid = self.next_id
                self.next_id += 1
                track = self.tracks[tid] = Track(p['box'],timestamp)
            used.add(tid)
            track.box, track.timestamp = p['box'], timestamp
            stable = {}
            for item in ('helmet','vest'):
                history = track.histories[item]
                state = p['raw_states'][item]
                # Unknown or contradictory latest evidence immediately retracts stale decisions.
                if state == 'unknown' or (history and history[-1] != state):
                    history.clear()
                history.append(state)
                stable[item] = state if state != 'unknown' and len(history) >= 3 and all(s == state for s in history) else 'unknown'
            results.append({**p, 'track_id': tid, 'states': stable})
        # Lost observations must not count as consecutive confirmations on reappearance.
        for tid, track in self.tracks.items():
            if tid not in used:
                for history in track.histories.values():
                    history.clear()
        return results

def annotate(bgr, persons, still=False, title=None):
    from annotation_zh import annotate_zh
    return annotate_zh(bgr, persons, still=still, title=title)
