"""Replaceable batched embedding extractor contract."""

from abc import ABC, abstractmethod
from collections.abc import Sequence

import numpy as np


EMBEDDING_DIM = 512


class FaceRecognizer(ABC):
    @abstractmethod
    def extract_embeddings(self, faces: Sequence[np.ndarray]) -> np.ndarray:
        """Return float32, L2-normalized [N, 512] embeddings; empty -> [0, 512]."""

    def extract_embedding(self, face: np.ndarray) -> np.ndarray:
        return self.extract_embeddings([face])[0]
