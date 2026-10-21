"""Local inference. No identity database, camera control, or network calls."""
import hashlib
import json
import time
import uuid
import cv2
import numpy as np
from model_paths import ROOT, models_directory

cv2.setNumThreads(2)
MODEL_ID = 'opencv-sface-2021dec-0ba9fbfa01b5270c-yunet-2023mar-8f2383e4dd3cfbb4'
MODEL_SPEC = json.loads((ROOT / 'vision' / 'base-models.json').read_text('utf-8'))

def jpeg(image):
    import base64
    ok, encoded = cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, 80])
    if not ok:
        raise ValueError('image_encode_failed')
    return base64.b64encode(encoded).decode('ascii')

def decode(value):
    import base64
    image = cv2.imdecode(np.frombuffer(base64.b64decode(value, validate=True), dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError('image_decode_failed')
    return image

class Models:
    def __init__(self, directory=None):
        directory = models_directory(directory)
        buffers = {}
        # The downloaded manifest is metadata, never the authority for weights.
        for entry in MODEL_SPEC['models']:
            data = (directory / entry['name']).read_bytes()
            if len(data) != entry['size'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
                raise ValueError('model_checksum_mismatch')
            buffers[entry['name']] = data
        def buffer(name):
            return np.frombuffer(buffers[name], dtype=np.uint8)
        empty = np.empty(0, dtype=np.uint8)
        self.detector = cv2.FaceDetectorYN.create('onnx', buffer('face_detection_yunet_2023mar.onnx'), empty, (320, 320), 0.8, 0.3, 5000)
        self.recognizer = cv2.FaceRecognizerSF.create('onnx', buffer('face_recognition_sface_2021dec.onnx'), empty)
        self.objects = cv2.dnn.readNetFromONNX(buffer('object_detection_yolox_2022nov.onnx'))
        grids, strides = [], []
        for stride in [8, 16, 32]:
            y, x = np.meshgrid(np.arange(640 // stride), np.arange(640 // stride), indexing='ij')
            grid = np.stack((x, y), axis=2).reshape(-1, 2)
            grids.append(grid)
            strides.append(np.full((len(grid), 1), stride))
        self.grid, self.strides = np.concatenate(grids), np.concatenate(strides)
        self.gallery, self.gallery_errors, self.gallery_revision = [], [], None

    def faces(self, image):
        self.detector.setInputSize((image.shape[1], image.shape[0]))
        _, faces = self.detector.detect(image)
        return [] if faces is None else faces

    def feature(self, image, face):
        aligned = self.recognizer.alignCrop(image, face)
        vector = self.recognizer.feature(aligned).flatten().copy()
        return vector / max(float(np.linalg.norm(vector)), 1e-12)

    def set_gallery(self, portraits):
        revision = [(p['id'], p['version']) for p in portraits]
        if revision == self.gallery_revision:
            return
        self.gallery, self.gallery_errors = [], []
        for person in portraits:
            try:
                image = decode(person['base64'])
                faces = self.faces(image)
                if len(faces) != 1:
                    raise ValueError('reference_requires_exactly_one_face')
                self.gallery.append((person['id'], person['version'], self.feature(image, faces[0])))
            except (ValueError, cv2.error):
                self.gallery_errors.append(person['id'])
        self.gallery_revision = revision

    def detect_faces(self, image):
        result = []
        for face in self.faces(image):
            x, y, w, h = map(int, face[:4])
            if min(w, h) < 32:
                continue
            vector = self.feature(image, face)
            matches = [dict(portraitId=pid, portraitVersion=version, similarity=max(0., min(1., float(vector @ reference)))) for pid, version, reference in self.gallery]
            matches = sorted(matches, key=lambda item: -item['similarity'])[:20]
            crop = image[max(y, 0):min(y+h, image.shape[0]), max(x, 0):min(x+w, image.shape[1])]
            if crop.size:
                result.append(dict(box=[x, y, w, h], confidence=float(face[-1]), base64=jpeg(crop), matches=matches))
        return result

    def detect_objects(self, image, threshold=0.35):
        height, width = image.shape[:2]
        ratio = min(640 / width, 640 / height)
        resized = cv2.resize(image, (int(width * ratio), int(height * ratio)))
        canvas = np.full((640, 640, 3), 114, dtype=np.uint8)
        canvas[:resized.shape[0], :resized.shape[1]] = resized
        self.objects.setInput(canvas.transpose(2, 0, 1)[None].astype(np.float32))
        output = self.objects.forward()[0]
        xy = (output[:, :2] + self.grid) * self.strides
        wh = np.exp(np.clip(output[:, 2:4], -20, 20)) * self.strides
        boxes = np.concatenate((xy - wh / 2, wh), axis=1) / ratio
        scores = output[:, 4:5] * output[:, 5:]
        classes = scores.argmax(axis=1)
        confidence = scores.max(axis=1)
        keep = cv2.dnn.NMSBoxesBatched(boxes.tolist(), confidence.tolist(), classes.tolist(), threshold, 0.45)
        result = []
        for i in keep:
            x, y, w, h = boxes[i]
            x1, y1 = max(0., float(x)), max(0., float(y))
            x2, y2 = min(float(width), float(x+w)), min(float(height), float(y+h))
            if x2 <= x1 or y2 <= y1:
                continue
            result.append(dict(box=[x1, y1, x2-x1, y2-y1], classId=int(classes[i]), confidence=float(confidence[i]), point=[(x1+x2)/2/width, y2/height]))
        return result

def quality(image):
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return dict(sharpness=float(cv2.Laplacian(gray, cv2.CV_64F).var()), brightness=float(gray.mean()), contrast=float(gray.std()))

def iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[0]+a[2], b[0]+b[2]), min(a[1]+a[3], b[1]+b[3])
    overlap = max(0, x2-x1) * max(0, y2-y1)
    return overlap / max(1, a[2]*a[3]+b[2]*b[3]-overlap)

class Tracker:
    """Per-stream short-term IoU tracks; not cross-camera identity deduplication."""
    def __init__(self):
        self.tracks = {}
        self.total = 0
        self.prefix = uuid.uuid4().hex[:10]

    def update(self, objects, now):
        self.tracks = {key: value for key, value in self.tracks.items() if now-value['last'] < 2.5}
        unused = set(self.tracks)
        for obj in objects:
            best = max((key for key in unused if self.tracks[key]['classId'] == obj['classId']), key=lambda key: iou(obj['box'], self.tracks[key]['box']), default=None)
            if best is None or iou(obj['box'], self.tracks[best]['box']) < 0.2:
                self.total += 1
                best = f'{self.prefix}-{self.total}'
                previous = dict(first=now)
            else:
                unused.remove(best)
                previous = self.tracks[best]
            obj['objectId'] = best
            obj['duration'] = now-previous['first']
            self.tracks[best] = dict(obj, first=previous['first'], last=now)
        return objects
