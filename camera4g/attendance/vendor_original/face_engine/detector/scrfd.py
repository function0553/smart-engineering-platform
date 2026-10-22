"""SCRFD ONNX decoder for standard three- or five-stride models with keypoints."""

from pathlib import Path

import cv2
import numpy as np

from face_engine.detector.base import FaceDetection, FaceDetector
from face_engine.onnx_backend import create_session


def prepare_scrfd_input(image: np.ndarray, input_size: tuple[int, int]) -> tuple[np.ndarray, float]:
    """Letterbox BGR frame and make the SCRFD RGB NCHW float32 input."""
    if image.ndim != 3 or image.shape[2] != 3 or image.dtype != np.uint8:
        raise ValueError("image must be uint8 BGR [H, W, 3]")
    height, width = image.shape[:2]
    if min(height, width) == 0:
        raise ValueError("image dimensions must be positive")
    input_w, input_h = input_size
    scale = min(input_w / width, input_h / height)
    resized_w, resized_h = max(1, round(width * scale)), max(1, round(height * scale))
    canvas = np.zeros((input_h, input_w, 3), dtype=np.uint8)
    canvas[:resized_h, :resized_w] = cv2.resize(image, (resized_w, resized_h))
    blob = np.empty((1, 3, input_h, input_w), dtype=np.float32)
    # Fill the NCHW channels directly; avoids an extra interleaved float32 copy.
    blob[0, 0] = canvas[:, :, 2]
    blob[0, 1] = canvas[:, :, 1]
    blob[0, 2] = canvas[:, :, 0]
    blob -= 127.5
    blob *= 1 / 128
    return blob, scale


class SCRFDDetector(FaceDetector):
    def __init__(self, model_path: str | Path, input_size=(640, 640), confidence_threshold=0.5,
                 nms_threshold=0.4, device="cuda", session=None, cpu_threads: int | None = None):
        self.session, self.backend = create_session(model_path, device, cpu_threads) if session is None else (session, "TEST")
        self.input_name = self.session.get_inputs()[0].name
        self.input_size = tuple(input_size)
        if len(self.input_size) != 2 or any(x <= 0 or x % 32 for x in self.input_size):
            raise ValueError("input_size must be positive [width, height] divisible by 32")
        self.confidence_threshold = confidence_threshold
        self.nms_threshold = nms_threshold
        self._anchor_centers: dict[tuple[int, int], np.ndarray] = {}
        outputs = self.session.get_outputs()
        if len(outputs) == 9:
            self.strides = (8, 16, 32)
        elif len(outputs) == 15:
            self.strides = (8, 16, 32, 64, 128)
        else:
            raise ValueError("SCRFD model must have 9 or 15 outputs including five keypoints")

    def detect_faces(self, image: np.ndarray) -> list[FaceDetection]:
        if image.ndim != 3 or image.shape[2] != 3 or image.dtype != np.uint8:
            raise ValueError("image must be uint8 BGR [H, W, 3]")
        height, width = image.shape[:2]
        if min(height, width) == 0:
            return []
        input_w, input_h = self.input_size
        blob, scale = prepare_scrfd_input(image, self.input_size)
        outputs = self.session.run(None, {self.input_name: blob})
        count = len(self.strides)
        boxes, points, scores = [], [], []
        for level, stride in enumerate(self.strides):
            score = np.asarray(outputs[level]).reshape(-1)
            box = np.asarray(outputs[level + count]).reshape(-1, 4)
            kps = np.asarray(outputs[level + 2 * count]).reshape(-1, 5, 2)
            grid_h, grid_w = input_h // stride, input_w // stride
            cell_count = grid_h * grid_w
            if len(score) != len(box) or len(score) != len(kps) or len(score) % cell_count:
                raise ValueError(f"Unexpected SCRFD output shape at stride {stride}")
            anchors = len(score) // cell_count
            selected = np.flatnonzero(score >= self.confidence_threshold)
            if not len(selected):
                continue
            key = (stride, anchors)
            centers = self._anchor_centers.get(key)
            if centers is None:
                grid = np.stack(np.mgrid[:grid_h, :grid_w][::-1], axis=-1).reshape(-1, 2)
                centers = np.repeat(grid, anchors, axis=0).astype(np.float32) * stride
                self._anchor_centers[key] = centers
            centers = centers[selected]
            d = box[selected] * stride
            decoded = np.concatenate((centers - d[:, :2], centers + d[:, 2:]), axis=1) / scale
            decoded[:, [0, 2]] = np.clip(decoded[:, [0, 2]], 0, width)
            decoded[:, [1, 3]] = np.clip(decoded[:, [1, 3]], 0, height)
            landmarks = (kps[selected] * stride + centers[:, None, :]) / scale
            boxes.append(decoded)
            points.append(landmarks)
            scores.append(score[selected])
        if not boxes:
            return []
        boxes = np.concatenate(boxes)
        points = np.concatenate(points)
        scores = np.concatenate(scores)
        valid = (boxes[:, 2] > boxes[:, 0]) & (boxes[:, 3] > boxes[:, 1])
        boxes, points, scores = boxes[valid], points[valid], scores[valid]
        if not len(boxes):
            return []
        # OpenCV NMSBoxes expects x, y, width, height; final order is score descending.
        xywh = np.column_stack((boxes[:, :2], boxes[:, 2:] - boxes[:, :2]))
        kept = cv2.dnn.NMSBoxes(xywh.tolist(), scores.tolist(), self.confidence_threshold,
                                self.nms_threshold)
        kept = np.asarray(kept).reshape(-1)
        kept = kept[np.argsort(-scores[kept])]
        return [{"bbox": boxes[i].tolist(), "landmarks": points[i].tolist(), "score": float(scores[i])}
                for i in kept]


class SizeAwareSCRFDDetector(FaceDetector):
    """Use a smaller SCRFD input for small crops while retaining full-frame resolution."""

    def __init__(self, standard: SCRFDDetector, small: SCRFDDetector, small_image_max_side: int):
        if small_image_max_side <= 0:
            raise ValueError("small_image_max_side must be positive")
        self.standard = standard
        self.small = small
        self.small_image_max_side = small_image_max_side
        self.backend = standard.backend

    def detect_faces(self, image: np.ndarray) -> list[FaceDetection]:
        if image.ndim >= 2 and max(image.shape[:2]) <= self.small_image_max_side:
            return self.small.detect_faces(image)
        return self.standard.detect_faces(image)
