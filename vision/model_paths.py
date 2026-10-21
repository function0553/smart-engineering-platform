"""Keep persistent model storage independent of the versioned source release."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def models_directory(directory=None):
    if directory is not None:
        return Path(directory)
    override = os.environ.get('AI_MODELS_PATH', '').strip()
    if not override:
        return ROOT / '.data' / 'ai-models'
    path = Path(override)
    if not path.is_absolute():
        raise ValueError('ai_models_path_must_be_absolute')
    return path
