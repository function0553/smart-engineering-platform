"""Similarity-transform alignment to the ArcFace 112x112 five-point template."""

import cv2
import numpy as np


_TEMPLATE = np.array(
    [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366],
     [41.5493, 92.3655], [70.7299, 92.2041]], dtype=np.float32
)


def _estimate_similarity_transform(points: np.ndarray, target: np.ndarray) -> np.ndarray:
    """Fit one scale, rotation and translation to all five landmarks.

    ArcFace's reference alignment fits the complete five-point set. A robust
    outlier estimator can drop a moving mouth corner and shift the face crop.
    """
    source = np.asarray(points, dtype=np.float64)
    destination = np.asarray(target, dtype=np.float64)
    if (source.shape != (5, 2) or destination.shape != (5, 2) or
            not np.isfinite(source).all() or not np.isfinite(destination).all()):
        raise ValueError("landmarks must contain five finite [x, y] pairs")
    source_mean = source.mean(axis=0)
    target_mean = destination.mean(axis=0)
    source_centered = source - source_mean
    target_centered = destination - target_mean
    xx = float(np.sum(source_centered[:, 0] ** 2))
    yy = float(np.sum(source_centered[:, 1] ** 2))
    xy = float(np.sum(source_centered[:, 0] * source_centered[:, 1]))
    variance = xx + yy
    if variance <= 1e-8 or xx * yy - xy * xy <= variance * variance * 1e-8:
        raise ValueError("cannot align degenerate face landmarks")

    # Closed-form least-squares 2-D similarity: [[a, -b], [b, a]].
    # This uses all landmarks and avoids the two SVDs needed by a generic fit.
    a = float(np.sum(source_centered * target_centered) / variance)
    b = float(np.sum(source_centered[:, 0] * target_centered[:, 1] -
                     source_centered[:, 1] * target_centered[:, 0]) / variance)
    rotation_scale = np.array([[a, -b], [b, a]])
    translation = target_mean - rotation_scale @ source_mean
    transform = np.column_stack((rotation_scale, translation))
    if not np.isfinite(transform).all() or a * a + b * b <= 1e-12:
        raise ValueError("cannot align degenerate face landmarks")
    return transform


def align_face(image: np.ndarray, landmarks: np.ndarray | list, output_size: int = 112) -> np.ndarray:
    points = np.asarray(landmarks, dtype=np.float32)
    if image.ndim != 3 or image.shape[2] != 3 or image.dtype != np.uint8:
        raise ValueError("image must be uint8 BGR [H, W, 3]")
    if points.shape != (5, 2) or not np.isfinite(points).all():
        raise ValueError("landmarks must contain five finite [x, y] pairs")
    if output_size != 112:
        raise ValueError("only 112x112 ArcFace alignment is supported")
    transform = _estimate_similarity_transform(points, _TEMPLATE)
    return cv2.warpAffine(image, transform, (112, 112), flags=cv2.INTER_LINEAR)
