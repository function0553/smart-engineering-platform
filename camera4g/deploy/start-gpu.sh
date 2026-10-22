#!/usr/bin/env bash
# 启动脚本：仅在 GPU 服务器启动 PPE、预览代理或人脸打卡服务。
set -euo pipefail
REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${CAMERA4G_GPU_ENV:-/etc/camera4g/private/gpu.env}"
[[ -r "$ENV_FILE" ]] || { echo '缺少 GPU 私有环境配置 CAMERA4G_GPU_ENV' >&2; exit 1; }
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a
: "${GPU_PYTHON:?请指定 GPU Python 虚拟环境的绝对路径}"
[[ "$GPU_PYTHON" = /* && -x "$GPU_PYTHON" ]] || { echo 'GPU_PYTHON 必须是可执行文件绝对路径' >&2; exit 1; }
export PYTHONUNBUFFERED=1
if [[ -n "${GPU_CUDA_LIBRARY_PATH_FILE:-}" ]]; then
  [[ -r "$GPU_CUDA_LIBRARY_PATH_FILE" ]] || { echo 'CUDA 动态库路径文件不可读' >&2; exit 1; }
  export LD_LIBRARY_PATH="$(cat -- "$GPU_CUDA_LIBRARY_PATH_FILE")${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi
case "${1:-}" in
  ppe)
    : "${VIDEO_CONFIG:?缺少 VIDEO_CONFIG}"
    "$GPU_PYTHON" -c 'import json,sys; c=json.load(open(sys.argv[1])); assert c["device"] == "cuda", "GPU PPE requires device=cuda"' "$VIDEO_CONFIG"
    cd "$REPO_ROOT/camera4g/ppe"
    exec "$GPU_PYTHON" server.py --config "$VIDEO_CONFIG" "${@:2}"
    ;;
  preview)
    : "${PREVIEW_CONFIG:?缺少 PREVIEW_CONFIG}"
    cd "$REPO_ROOT/camera4g/preview"
    exec "$GPU_PYTHON" preview_server.py --config "$PREVIEW_CONFIG" "${@:2}"
    ;;
  attendance)
    : "${ATTENDANCE_CONFIG:?缺少 ATTENDANCE_CONFIG}"
    : "${ATTENDANCE_ADMIN_TOKEN:?缺少 ATTENDANCE_ADMIN_TOKEN}"
    export PYTHONPATH="$REPO_ROOT/camera4g/attendance/vendor_original${PYTHONPATH:+:$PYTHONPATH}"
    cd "$REPO_ROOT/camera4g/attendance"
    exec "$GPU_PYTHON" attendance_service.py --config "$ATTENDANCE_CONFIG" "${@:2}"
    ;;
  *) echo '启动脚本用法：start-gpu.sh {ppe|preview|attendance} [服务参数]' >&2; exit 2 ;;
esac
