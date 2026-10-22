# 服务启动脚本

`.sh` 是**启动脚本**，`.example` 是配置模板。交付算法服务与后端接入，不新增前端。

| 启动脚本 | 位置 | 命令 |
| --- | --- | --- |
| [`start-gpu.sh`](start-gpu.sh) | GPU | `bash start-gpu.sh ppe`：安全帽、反光背心 CUDA 检测 |
| [`start-gpu.sh`](start-gpu.sh) | GPU | `bash start-gpu.sh attendance`：打卡、活体检查 |
| [`start-gpu.sh`](start-gpu.sh) | GPU | `bash start-gpu.sh preview`：已有视频、结果历史代理 |
| [`start-252.sh`](start-252.sh) | 252 | `bash start-252.sh`：现有后端；启动 GPU 打卡结果同步并提供人员录入接口 |

先恢复模型、配置流地址和凭据。私有配置默认路径为 `/etc/camera4g/private/gpu.env` 和 `/etc/camera4g/private/platform.env`，可用 CAMERA4G_GPU_ENV、CAMERA4G_252_ENV 指定其他绝对路径。替换全部 REPLACE_ 和 gpu.example.com。

拓扑、安装、systemd、HTTPS 网关和接口契约见 [GPU 与 252 交接文档](../docs/GPU_252_HANDOFF_20261022.md)。

打卡需要配置 `attendance-upstream.example.json` 和 CAMERA4G_ATTENDANCE_CONFIG_FILE；GPU 原引擎、模型恢复、姓名音频依赖和 252 API 见 [打卡接入说明](../docs/ATTENDANCE_GPU_252_20261022.md)。
