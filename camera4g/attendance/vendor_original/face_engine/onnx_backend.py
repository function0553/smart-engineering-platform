"""ONNX Runtime provider selection with visible fallback."""

from pathlib import Path


def create_session(model_path: str | Path, device: str = "cuda", cpu_threads: int | None = None):
    path = Path(model_path)
    if not path.is_file():
        raise FileNotFoundError(f"ONNX model not found: {path}")
    try:
        import onnxruntime as ort
    except ImportError as exc:
        raise RuntimeError("Install onnxruntime-gpu or onnxruntime") from exc
    available = ort.get_available_providers()
    if device not in ("cuda", "cpu"):
        raise ValueError("device must be 'cuda' or 'cpu'")
    if cpu_threads is not None and cpu_threads <= 0:
        raise ValueError("cpu_threads must be positive")
    if device == "cuda" and "CUDAExecutionProvider" in available:
        # Loads CUDA/cuDNN DLLs from the venv's NVIDIA packages on Windows.
        # A listed provider alone does not prove its dependent DLLs can load.
        if hasattr(ort, "preload_dlls"):
            ort.preload_dlls()
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    else:
        if device == "cuda":
            print("CUDA provider unavailable; falling back to ONNX Runtime CPU")
        providers = ["CPUExecutionProvider"]
    options = ort.SessionOptions()
    if cpu_threads is not None:
        options.intra_op_num_threads = cpu_threads
    session = ort.InferenceSession(str(path), sess_options=options, providers=providers)
    active = session.get_providers()[0]
    backend = "CUDA" if active == "CUDAExecutionProvider" else "CPU"
    if device == "cuda" and backend != "CUDA" and "CUDAExecutionProvider" in available:
        print("CUDA provider initialization failed; falling back to ONNX Runtime CPU")
    print(f"ONNX Runtime Backend: {backend}")
    return session, backend
