"""Official build entry: reuse the original signer; never generate a key."""
from pathlib import Path
import runpy
runpy.run_path(str(Path(__file__).with_name("build-auto-word-android.py")),run_name="__main__")
