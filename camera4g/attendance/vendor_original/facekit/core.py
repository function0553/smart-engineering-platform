"""SCRFD + ArcFace adapter for the existing edge-face HTTP contract.

The former YuNet + SFace implementation is retained as core_yunet_sface.py in
the previous release. Embeddings from the two backends are incompatible.
"""

import hashlib
import math
from pathlib import Path

import cv2
import numpy as np

from face_engine.alignment.face_align import align_face
from face_engine.detector.scrfd import SCRFDDetector, SizeAwareSCRFDDetector
from face_engine.recognizer.arcface import ArcFaceRecognizer

from .core_yunet_sface import DESTINATION, FaceError, cosine, decode_base64, decode_image, make_session, similarity_transform


class FacePipeline:
    def __init__(self, model_dir, provider="cpu", gpu_id=0, detection_threshold=0.5, profile_dir=None):
        if provider not in {"cpu", "cuda"}:
            raise ValueError("provider must be cpu or cuda")
        if not 0 < detection_threshold <= 1:
            raise ValueError("Invalid detection threshold")
        if profile_dir is not None:
            raise ValueError("Profiling is unavailable for this adapter")
        cv2.setNumThreads(2)
        self.provider = provider
        self.gpu_id = gpu_id
        self.detection_threshold = detection_threshold
        model_dir = Path(model_dir)
        detector_path = model_dir / "det_10g.onnx"
        recognizer_path = model_dir / "w600k_r50.onnx"
        expected_hashes = {
            detector_path: "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91",
            recognizer_path: "4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43",
        }
        for path, expected_hash in expected_hashes.items():
            if hashlib.sha256(path.read_bytes()).hexdigest() != expected_hash:
                raise RuntimeError("Model integrity check failed: " + path.name)
        self.detector = SizeAwareSCRFDDetector(
            SCRFDDetector(detector_path, (640, 640), detection_threshold, 0.4, provider,
                          session=make_session(detector_path, provider, gpu_id)),
            SCRFDDetector(detector_path, (320, 320), detection_threshold, 0.4, provider,
                          session=make_session(detector_path, provider, gpu_id)),
            small_image_max_side=576,
        )
        self.recognizer = ArcFaceRecognizer(recognizer_path, batch_size=1, device=provider,
                                            session=make_session(recognizer_path, provider, gpu_id))
        sessions = [self.detector.standard.session, self.detector.small.session, self.recognizer.session]
        expected = "CUDAExecutionProvider" if provider == "cuda" else "CPUExecutionProvider"
        if any(session.get_providers()[0] != expected for session in sessions):
            raise RuntimeError(f"Requested {expected}, but model loaded on another provider")
        for session in sessions:
            session.disable_fallback()
        model_hash = hashlib.sha256(recognizer_path.read_bytes()).hexdigest()
        self.model_id = "arcface-w600k-r50-sha256:" + model_hash

    def info(self):
        return {
            "backend": "scrfd-arcface",
            "providerRequested": self.provider,
            "detectorProviders": self.detector.standard.session.get_providers(),
            "smallDetectorProviders": self.detector.small.session.get_providers(),
            "recognizerProviders": self.recognizer.session.get_providers(),
            "gpuId": self.gpu_id if self.provider == "cuda" else None,
            "modelId": self.model_id,
            "embeddingDimensions": 512,
            "detectorInput": [640, 640],
            "smallDetectorInput": [320, 320],
            "smallImageMaxSide": 576,
            "detectionThreshold": self.detection_threshold,
            "storesFaces": False,
        }

    def detect(self, image):
        return self.detector.detect_faces(image)

    @staticmethod
    def detection_json(rows):
        result = []
        for row in rows:
            x1, y1, x2, y2 = row["bbox"]
            result.append({
                "box": [round(float(x1), 3), round(float(y1), 3),
                        round(float(x2 - x1), 3), round(float(y2 - y1), 3)],
                "landmarks": np.round(np.asarray(row["landmarks"]), 3).tolist(),
                "detectionScore": round(float(row["score"]), 6),
            })
        return result

    def embed(self, image):
        rows = self.detect(image)
        if len(rows) != 1:
            raise FaceError("face_count", f"Expected exactly one face; detected {len(rows)}")
        row = rows[0]
        x1, y1, x2, y2 = row["bbox"]
        if min(x2 - x1, y2 - y1) < 40:
            raise FaceError("face_too_small", "Use a face at least 40 pixels wide and high")
        try:
            aligned = align_face(image, row["landmarks"])
            vector = self.recognizer.extract_embeddings([aligned])[0]
        except ValueError as exc:
            raise FaceError("invalid_feature", str(exc)) from exc
        return vector, self.detection_json(rows)[0]

    def compare(self, left, right, threshold=None):
        if threshold is not None and (not math.isfinite(threshold) or not -1 <= threshold <= 1):
            raise FaceError("invalid_threshold", "Cosine threshold must be finite and between -1 and 1")
        a, face_a = self.embed(left)
        b, face_b = self.embed(right)
        score = cosine(a, b)
        return {
            "backend": "scrfd-arcface", "modelId": self.model_id,
            "metric": "cosine_similarity", "score": score,
            "threshold": threshold, "aboveThreshold": None if threshold is None else score >= threshold,
            "thresholdCalibrated": False, "identityConfirmed": False,
            "faces": [face_a, face_b],
        }
