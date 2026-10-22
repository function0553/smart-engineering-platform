# 4G 球机：安全帽、反光背心检测与打卡

本目录为 4G 球机算法服务，上传目标为 Gitee `systemaths/hyc`。安全帽、反光背心检测和人脸打卡在 GPU 运行，由 252 后端接入；本次不新增前端。2026-10-22 增补跨服务器 HTTPS 接入、启动脚本和交接说明，来源与后续修改摘要见 `SOURCE_EXPORT.json`。源码交付不代表远端上线或现场验收。

**先读：[GPU 算法服务与 252 后端交接文档](docs/GPU_252_HANDOFF_20261022.md)。启动脚本：[GPU 算法服务启动脚本](deploy/start-gpu.sh)、[252 既有后端启动脚本](deploy/start-252.sh)，用途与命令见 [启动脚本清单](deploy/README.md)。**

已恢复原版人脸引擎最小源码，新增 GPU 增量日志、252 录入/持久化同步和 GPU 姓名音频准备。接口和模型恢复见 [打卡 GPU/252 接入说明](docs/ATTENDANCE_GPU_252_20261022.md)。

## GPU 服务启动命令

以下从仓库根目录执行；先准备 `/etc/camera4g/private/gpu.env` 及其引用的私有 JSON 配置，步骤见 [仓库首页 README](../README.md)。`/opt/hyc` 按实际部署目录替换。

```sh
cd /opt/hyc
# 启动脚本：安全帽、反光背心 CUDA 检测
bash camera4g/deploy/start-gpu.sh ppe
```

```sh
cd /opt/hyc
# 启动脚本：GPU 人脸打卡
bash camera4g/deploy/start-gpu.sh attendance
```

```sh
cd /opt/hyc
# 启动脚本：已有视频与结果历史代理
bash camera4g/deploy/start-gpu.sh preview
```

三个独立常驻进程，分别用终端或 systemd 管理，不能在同一终端串行等待三条命令。

## 目录

| 目录 | 内容 |
| --- | --- |
| `ppe/` | ONNX CPU/CUDA 安全帽、未戴安全帽、反光背心、未穿反光背心检测，匿名跟踪、人员穿戴关联、鉴权 JSON API、参考模型及依赖清单 |
| `preview/` | 连续 H.264 视频、HLS、中文 Canvas 叠框及 camera-02 显示适配 |
| `attendance/` | 人工录入、SCRFD/ArcFace 人脸打卡、SQLite 存储、双摄共享、活体检查、打卡页面、姓名语音与现有单元测试 |
| `attendance/models/liveness/` | 双尺度 Minivision ONNX 活体模型、哈希清单 |
| `voice-adapter/` | Monibuca 5.1.6 的实际语音补丁文件及版本/摘要依据 |
| `docs/` | 历史 PPE 后端接入契约；历史地址和状态需按实际部署复核 |
| `deploy/` | GPU/252 启动脚本、systemd、GPU HTTPS 网关和配置模板 |
| `licenses/` | 随附第三方许可；组件范围见 `THIRD_PARTY_NOTICES.md` |

## PPE 安装和配置

GPU 部署在独立 Python CUDA 环境中安装 `ppe/requirements-cuda.txt`。按 `ppe/config.example.json` 创建私有运行配置，设置 device=cuda、实际 device_id、模型绝对路径、已验证的 MAIN 流尺寸、设备标识及资源预算；示例中的 `main_source_verified=false` 会保留启动阻断。

```sh
cd /opt/hyc
/opt/camera4g/venv/bin/python -m pip install -r camera4g/ppe/requirements-cuda.txt
bash camera4g/deploy/start-gpu.sh ppe --check-only
bash camera4g/deploy/start-gpu.sh ppe
```

流地址与鉴权从 `PPE_MAIN_STREAM_ENDPOINT`、`PPE_VIDEO_ADMIN_TOKEN`、`PPE_VIDEO_CAMERA_TOKEN` 读取。预览使用 `preview/config.example.json` 及 `PPE_VIDEO_CAMERA_TOKEN`、`PPE_PREVIEW_PASS`、`PPE_MEDIA_READ_USER`、`PPE_MEDIA_READ_PASS`。示例中的模型相对路径需按实际工作目录解析并配置。详细说明见 `ppe/README.md` 与 `docs/PPE_BACKEND_20261009.md`。

## 打卡配置和边界

现有打卡规则使用北京时间：08:00 起记录，09:05:00（含）前正常，之后迟到；同一人员每天保留首次打卡。PPE 匿名轨迹不作为实名打卡身份。

打卡启动方式：`bash deploy/start-gpu.sh attendance`，或直接 `python attendance/attendance_service.py --config /path/to/private/attendance.json`。监听用 `bind.host`/`bind.port` 配置；要求 ATTENDANCE_ADMIN_TOKEN。推荐由 GPU TLS 网关提供 `https://实际GPU域名:29482`；默认回环监听只供 GPU 本机网关使用，不是 252 调用地址。配置见 `attendance/config.example.json`。

原版 facekit/face_engine 已恢复在 `attendance/vendor_original`，来源和原始 SHA-256 随附；`attendance/requirements-gpu.txt` 是按当前 GPU 环境记录的打卡依赖。权重通过 `attendance/face_runtime.py` 从受控源恢复/校验，不在 Git 再分发。gpu_id 默认 1、可配置；PPE 使用独立 device_id。姓名音频适配器在 GPU 本机运行，需 espeak-ng 与 ffmpeg。

活体模型已随附，`liveness_model_directory` 指向本目录的 `attendance/models/liveness`。RGB 活体输出需现场验证。语音依赖本次适配的 Monibuca 广播接口和现场听音验证文件；`submitted_unverified` 仅表示已提交，不能代替确认听到。

`attendance/local_preview.py` 是现有业主本机 SSH 预览工具，保留历史服务器地址和 SSH 主机指纹，凭据从标准输入读取；迁移到不同服务器前应核对地址及可信指纹。该工具使用 Python `audioop`，需使用支持该模块的既有 Python 环境。

## 离线验证

以下现有测试使用临时数据库、合成人员向量和模拟运行时，不读取真实人员库，也不连接摄像头：

```sh
cd attendance
python -m unittest discover -p "test_*.py"
```

验证结果见 `VALIDATION.json`。离线通过不能证明远端视频在线、GPU 推理可用、听音成功或现场识别准确率。

## 未纳入内容

未包含 `private/`、真实人脸照片/特征库、考勤数据库和记录、姓名音频、账号密码、token、SSH 私钥、运行环境、下载缓存、固件和历史备份。办公室双摄电子围栏项目 `office_monitor/` 不在本次提交范围。

第三方权利和原有许可仍然有效；本提交未为自有代码授予新的开源许可。上游来源链接仅用于溯源，本次 Git 远程目标只有 Gitee。
