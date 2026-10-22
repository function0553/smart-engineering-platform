"""Small, validated runtime configuration."""

from pathlib import Path
from typing import Any

import yaml


def load_config(path: str | Path) -> dict[str, Any]:
    with Path(path).open(encoding="utf-8") as stream:
        config = yaml.safe_load(stream)
    if not isinstance(config, dict):
        raise ValueError("Configuration must be a YAML mapping")
    required = ("device", "detector", "recognizer", "face_index", "matching", "video")
    if any(key not in config for key in required):
        raise ValueError(f"Configuration requires: {', '.join(required)}")
    low = config["matching"]["low_threshold"]
    high = config["matching"]["high_threshold"]
    if not (-1 <= low < high <= 1):
        raise ValueError("Require -1 <= low_threshold < high_threshold <= 1")
    return config
