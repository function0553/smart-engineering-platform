"""Replaceable multi-face detector contract."""

from abc import ABC, abstractmethod
from typing import TypedDict

import numpy as np


class FaceDetection(TypedDict):
    bbox: list[float]  # x1, y1, x2, y2 in original image pixels
    landmarks: list[list[float]]  # five [x, y] pairs in original image pixels
    score: float


class FaceDetector(ABC):
    @abstractmethod
    def detect_faces(self, image: np.ndarray) -> list[FaceDetection]:
        """Accept a BGR HWC image; return zero or more faces."""
