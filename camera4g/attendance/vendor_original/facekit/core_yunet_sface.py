"""YuNet + SFace with explicit CPU/CUDA execution and versioned embeddings.

Model preprocessing follows the OpenCV FaceDetectorYN / FaceRecognizerSF
implementations. No face lists, recordings, or embeddings are persisted here.
"""
import base64
import binascii
import hashlib
import io
import json
import math
import warnings
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageOps

MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_IMAGE_PIXELS = 16_000_000
DESTINATION = np.array([
    [38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
    [41.5493, 92.3655], [70.7299, 92.2041],
], dtype=np.float64)


class FaceError(ValueError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def decode_base64(value):
    if not isinstance(value, str) or len(value) > ((MAX_IMAGE_BYTES + 2) // 3) * 4:
        raise FaceError("image_too_large", "Image must be base64 and at most 5 MiB")
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise FaceError("invalid_base64", "Use raw base64 without a data URL prefix") from None
    return decode_image(raw)


def decode_image(raw):
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise FaceError("invalid_image_size", "Image must contain 1 byte to 5 MiB")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as im:
                if im.format not in {"JPEG", "PNG", "WEBP"} or getattr(im, "n_frames", 1) != 1:
                    raise FaceError("unsupported_image", "Use a single JPEG, PNG or WebP image")
                if min(im.size) < 20 or im.width * im.height > MAX_IMAGE_PIXELS:
                    raise FaceError("invalid_dimensions", "Image dimensions are outside the supported range")
                im = ImageOps.exif_transpose(im).convert("RGB")
                return cv2.cvtColor(np.asarray(im), cv2.COLOR_RGB2BGR)
    except FaceError:
        raise
    except Exception:
        raise FaceError("invalid_image", "Image could not be decoded") from None


def similarity_transform(points):
    """Least-squares non-reflecting similarity transform for five landmarks."""
    src = np.asarray(points, dtype=np.float64)
    if src.shape != (5, 2) or not np.isfinite(src).all():
        raise FaceError("invalid_landmarks", "Expected five finite landmark coordinates")
    src_mean, dst_mean = src.mean(axis=0), DESTINATION.mean(axis=0)
    source, dest = src - src_mean, DESTINATION - dst_mean
    variance = np.sum(source ** 2) / 5
    if variance < 1e-8 or np.linalg.matrix_rank(source) < 2:
        raise FaceError("invalid_landmarks", "Landmarks are degenerate")
    u, singular, vt = np.linalg.svd(dest.T @ source / 5)
    sign = np.ones(2)
    if np.linalg.det(u @ vt) < 0:
        sign[-1] = -1
    rotation = u @ np.diag(sign) @ vt
    scale = float(singular @ sign) / variance
    matrix = np.empty((2, 3), dtype=np.float64)
    matrix[:, :2] = scale * rotation
    matrix[:, 2] = dst_mean - scale * rotation @ src_mean
    return matrix


def cosine(a, b):
    a, b = np.asarray(a, dtype=np.float32).ravel(), np.asarray(b, dtype=np.float32).ravel()
    if a.shape != b.shape or a.size == 0 or not np.isfinite(a).all() or not np.isfinite(b).all():
        raise FaceError("invalid_feature", "Feature vectors must have matching dimensions and finite values")
    denominator = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denominator <= 1e-12:
        raise FaceError("invalid_feature", "Zero-length feature vector")
    return float(np.clip(float(a @ b) / denominator, -1, 1))


def make_session(path, provider, gpu_id=0, profile_dir=None):
    if provider not in {"cpu", "cuda"}:
        raise ValueError("provider must be cpu or cuda")
    options = ort.SessionOptions()
    options.log_severity_level = 3
    options.intra_op_num_threads = 2
    options.inter_op_num_threads = 1
    if profile_dir:
        options.enable_profiling = True
        options.profile_file_prefix = str(Path(profile_dir) / Path(path).stem)
    if provider == "cuda":
        if hasattr(ort, "preload_dlls"):
            ort.preload_dlls()
        if "CUDAExecutionProvider" not in ort.get_available_providers():
            raise RuntimeError("CUDA provider is unavailable; install requirements-gpu.txt")
        providers = [("CUDAExecutionProvider", {
            "device_id": gpu_id,
            "gpu_mem_limit": 1024 * 1024 * 1024,
            "arena_extend_strategy": "kSameAsRequested",
            "cudnn_conv_algo_search": "HEURISTIC",
            "cudnn_conv_use_max_workspace": "0",
        }), "CPUExecutionProvider"]
    else:
        providers = ["CPUExecutionProvider"]
    session = ort.InferenceSession(str(path), sess_options=options, providers=providers)
    if provider == "cuda" and session.get_providers()[0] != "CUDAExecutionProvider":
        raise RuntimeError("CUDA initialization failed; refusing silent CPU fallback")
    session.disable_fallback()
    return session


class FacePipeline:
    def __init__(self, model_dir, provider="cpu", gpu_id=0, detection_threshold=0.9, profile_dir=None):
        # Image resizing/alignment should leave capacity for concurrent web I/O.
        cv2.setNumThreads(2)
        self.model_dir = Path(model_dir)
        self.provider = provider
        self.gpu_id = gpu_id
        if not 0 < detection_threshold <= 1:
            raise ValueError("Invalid detection threshold")
        self.detection_threshold = detection_threshold
        manifest = json.loads((self.model_dir / "manifest.json").read_text(encoding="utf-8"))
        models = {x["name"]: x for x in manifest["models"]}
        for item in models.values():
            path = self.model_dir / item["filename"]
            if path.stat().st_size != item["size"] or hashlib.sha256(path.read_bytes()).hexdigest() != item["sha256"]:
                raise RuntimeError("Model integrity check failed: " + item["name"])
        self.detector = make_session(self.model_dir / models["detector"]["filename"], provider, gpu_id, profile_dir)
        self.recognizer = make_session(self.model_dir / models["recognizer"]["filename"], provider, gpu_id, profile_dir)
        shape = self.detector.get_inputs()[0].shape
        self.input_height = shape[2] if isinstance(shape[2], int) else 640
        self.input_width = shape[3] if isinstance(shape[3], int) else 640
        self.model_id = "sface-2021dec-sha256:" + models["recognizer"]["sha256"]
        self.dimensions = int(self.recognizer.get_outputs()[0].shape[-1])

    def info(self):
        return {
            "backend": "yunet-sface", "providerRequested": self.provider,
            "detectorProviders": self.detector.get_providers(),
            "recognizerProviders": self.recognizer.get_providers(),
            "gpuId": self.gpu_id if self.provider == "cuda" else None,
            "modelId": self.model_id, "embeddingDimensions": self.dimensions,
            "detectorInput": [self.input_width, self.input_height],
            "storesFaces": False,
        }

    def detect(self, image):
        height, width = image.shape[:2]
        ratio = min(self.input_width / width, self.input_height / height)
        scaled_w, scaled_h = max(1, round(width * ratio)), max(1, round(height * ratio))
        padded = np.zeros((self.input_height, self.input_width, 3), dtype=np.uint8)
        padded[:scaled_h, :scaled_w] = cv2.resize(image, (scaled_w, scaled_h))
        blob = padded.transpose(2, 0, 1)[None].astype(np.float32)
        names = [x.name for x in self.detector.get_outputs()]
        outputs = dict(zip(names, self.detector.run(None, {self.detector.get_inputs()[0].name: blob})))
        candidates = []
        for stride in (8, 16, 32):
            cls = outputs[f"cls_{stride}"].reshape(-1)
            obj = outputs[f"obj_{stride}"].reshape(-1)
            scores = np.sqrt(np.clip(cls, 0, 1) * np.clip(obj, 0, 1))
            indices = np.flatnonzero(scores >= self.detection_threshold)
            if not indices.size:
                continue
            boxes = outputs[f"bbox_{stride}"].reshape(-1, 4)[indices]
            grid = np.column_stack((indices % (self.input_width // stride), indices // (self.input_width // stride)))
            center = (grid + boxes[:, :2]) * stride
            size = np.exp(np.clip(boxes[:, 2:], -20, 20)) * stride
            points = (outputs[f"kps_{stride}"].reshape(-1, 5, 2)[indices] + grid[:, None, :]) * stride
            candidates.append(np.column_stack((center - size / 2, size, points.reshape(-1, 10), scores[indices])))
        if not candidates:
            return np.empty((0, 15), dtype=np.float32)
        rows = np.concatenate(candidates).astype(np.float32)
        keep = cv2.dnn.NMSBoxes(rows[:, :4].tolist(), rows[:, 14].tolist(), self.detection_threshold, 0.3, top_k=5000)
        rows = rows[np.asarray(keep, dtype=int).reshape(-1)]
        # Undo the actual rounded resize independently on x and y coordinates.
        rows[:, [0, 2, 4, 6, 8, 10, 12]] *= width / scaled_w
        rows[:, [1, 3, 5, 7, 9, 11, 13]] *= height / scaled_h
        centers = rows[:, :2] + rows[:, 2:4] / 2
        valid = (centers[:, 0] >= 0) & (centers[:, 0] < width) & (centers[:, 1] >= 0) & (centers[:, 1] < height)
        rows = rows[valid]
        return rows[np.argsort(-rows[:, 14])]

    @staticmethod
    def detection_json(rows):
        return [{
            "box": [round(float(x), 3) for x in row[:4]],
            "landmarks": np.round(row[4:14].reshape(5, 2), 3).tolist(),
            "detectionScore": round(float(row[14]), 6),
        } for row in rows]

    def embed(self, image):
        rows = self.detect(image)
        if len(rows) != 1:
            raise FaceError("face_count", f"Expected exactly one face; detected {len(rows)}")
        row = rows[0]
        if min(row[2], row[3]) < 40:
            raise FaceError("face_too_small", "Use a face at least 40 pixels wide and high")
        transform = similarity_transform(row[4:14].reshape(5, 2))
        aligned = cv2.warpAffine(image, transform, (112, 112), flags=cv2.INTER_LINEAR)
        blob = aligned[:, :, ::-1].transpose(2, 0, 1)[None].astype(np.float32)
        vector = self.recognizer.run(None, {self.recognizer.get_inputs()[0].name: blob})[0].reshape(-1).copy()
        norm = float(np.linalg.norm(vector))
        if not math.isfinite(norm) or norm < 1e-8:
            raise FaceError("invalid_feature", "Model produced an invalid feature vector")
        vector /= norm
        return vector, self.detection_json(rows)[0]

    def compare(self, left, right, threshold=None):
        if threshold is not None and (not math.isfinite(threshold) or not -1 <= threshold <= 1):
            raise FaceError("invalid_threshold", "Cosine threshold must be finite and between -1 and 1")
        a, face_a = self.embed(left)
        b, face_b = self.embed(right)
        score = cosine(a, b)
        return {
            "backend": "yunet-sface", "modelId": self.model_id,
            "metric": "cosine_similarity", "score": score,
            "threshold": threshold, "aboveThreshold": None if threshold is None else score >= threshold,
            "thresholdCalibrated": False, "identityConfirmed": False,
            "faces": [face_a, face_b],
        }
