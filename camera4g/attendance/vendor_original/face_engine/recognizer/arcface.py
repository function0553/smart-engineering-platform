"""ArcFace ONNX batched embedding extraction."""

from pathlib import Path

import numpy as np

from face_engine.onnx_backend import create_session
from face_engine.recognizer.base import EMBEDDING_DIM, FaceRecognizer


def prepare_arcface_input(faces) -> np.ndarray:
    """Convert aligned BGR faces to normalized RGB NCHW without float HWC copies."""
    batch = np.asarray(faces)
    if batch.ndim != 4 or batch.shape[1:] != (112, 112, 3) or batch.dtype != np.uint8:
        raise ValueError("aligned faces must be uint8 BGR [N, 112, 112, 3]")
    input_data = np.empty((len(batch), 3, 112, 112), dtype=np.float32)
    input_data[:, 0] = batch[:, :, :, 2]
    input_data[:, 1] = batch[:, :, :, 1]
    input_data[:, 2] = batch[:, :, :, 0]
    input_data -= 127.5
    input_data /= 127.5
    return input_data


class ArcFaceRecognizer(FaceRecognizer):
    def __init__(self, model_path: str | Path, batch_size=32, device="cuda", session=None,
                 cpu_threads: int | None = None):
        self.session, self.backend = create_session(model_path, device, cpu_threads) if session is None else (session, "TEST")
        self.input_name = self.session.get_inputs()[0].name
        shape = self.session.get_inputs()[0].shape
        if len(shape) != 4 or shape[1:] != [3, 112, 112]:
            raise ValueError("ArcFace model input must be [batch, 3, 112, 112]")
        if isinstance(shape[0], int):
            raise ValueError("ArcFace ONNX model needs a dynamic batch dimension")
        if batch_size <= 0:
            raise ValueError("batch_size must be positive")
        self.batch_size = batch_size

    def extract_embeddings(self, faces) -> np.ndarray:
        if len(faces) == 0:
            return np.empty((0, EMBEDDING_DIM), dtype=np.float32)
        chunks = []
        for start in range(0, len(faces), self.batch_size):
            input_data = prepare_arcface_input(faces[start:start + self.batch_size])
            embeddings = np.asarray(self.session.run(None, {self.input_name: input_data})[0], dtype=np.float32)
            if embeddings.shape != (len(input_data), EMBEDDING_DIM):
                raise ValueError(f"ArcFace output must be [{len(input_data)}, 512]")
            norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
            if not np.isfinite(embeddings).all() or (norms <= 0).any():
                raise ValueError("ArcFace returned non-finite or zero embeddings")
            chunks.append(embeddings / norms)
        return np.concatenate(chunks, axis=0)
