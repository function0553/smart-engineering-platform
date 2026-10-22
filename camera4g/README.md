# 4G 球机：安全帽、反光背心检测与打卡

本目录为现有工程的选定源码快照（2026-10-22，北京时间），上传目标为 Gitee `systemaths/hyc`。PPE、打卡业务逻辑及模型保持原文件内容，逐文件来源和 SHA-256 见 `SOURCE_EXPORT.json`。运行时测试夹具补齐了服务已要求的 `voice_gate`、`camera_id` 属性，使其与现有初始化契约一致。本次提交用于源码归档，不代表重新部署或现场验收。

## 目录

| 目录 | 内容 |
| --- | --- |
| `ppe/` | ONNX CPU/CUDA 安全帽、未戴安全帽、反光背心、未穿反光背心检测，匿名跟踪、人员穿戴关联、鉴权 JSON API、参考模型及依赖清单 |
| `preview/` | 连续 H.264 视频、HLS、中文 Canvas 叠框及 camera-02 显示适配 |
| `attendance/` | 人工录入、SCRFD/ArcFace 人脸打卡、SQLite 存储、双摄共享、活体检查、打卡页面、姓名语音与现有单元测试 |
| `attendance/models/liveness/` | 双尺度 Minivision ONNX 活体模型、哈希清单 |
| `voice-adapter/` | Monibuca 5.1.6 的实际语音补丁文件及版本/摘要依据 |
| `docs/` | 历史 PPE 后端接入契约；历史地址和状态需按实际部署复核 |
| `licenses/` | 随附第三方许可；组件范围见 `THIRD_PARTY_NOTICES.md` |

## PPE 安装和配置

在独立 Python 环境中安装 `ppe/requirements-cpu.txt`；CUDA 环境改用 `ppe/requirements-cuda.txt`。按 `ppe/config.example.json` 创建私有运行配置，填写已验证的 MAIN 流尺寸、设备标识、模型路径及资源预算；示例中的 `main_source_verified=false` 会保留启动阻断。

```sh
python -m pip install -r ppe/requirements-cpu.txt
python ppe/server.py --config /path/to/private/video.json --check-only
python ppe/server.py --config /path/to/private/video.json
```

流地址与鉴权从 `PPE_MAIN_STREAM_ENDPOINT`、`PPE_VIDEO_ADMIN_TOKEN`、`PPE_VIDEO_CAMERA_TOKEN` 读取。预览使用 `preview/config.example.json` 及 `PPE_VIDEO_CAMERA_TOKEN`、`PPE_PREVIEW_PASS`、`PPE_MEDIA_READ_USER`、`PPE_MEDIA_READ_PASS`。示例中的模型相对路径需按实际工作目录解析并配置。详细说明见 `ppe/README.md` 与 `docs/PPE_BACKEND_20261009.md`。

## 打卡配置和边界

现有打卡规则使用北京时间：08:00 起记录，09:05:00（含）前正常，之后迟到；同一人员每天保留首次打卡。PPE 匿名轨迹不作为实名打卡身份。

打卡启动方式：`python attendance/attendance_service.py --config /path/to/private/attendance.json`。服务要求 `ATTENDANCE_ADMIN_TOKEN`，当前 HTTP 绑定 `127.0.0.1:28982`。配置结构示例见 `attendance/config.example.json`，私有流地址和数据库另行配置，示例不含实际账号密码。

当前工作目录未找到打卡所依赖的 `facekit.core`、`face_engine.alignment.face_align` 源码及其 SCRFD/ArcFace 模型，部署方必须恢复既有匹配版本；未用名称相同的其他包替代。其他运行依赖包含 PyAV、NumPy、OpenCV、CUDA 版 ONNX Runtime、paramiko 和 websocket-client，具体版本以已验证环境为准；PPE 依赖清单不能当作完整打卡环境清单。现有打卡代码指定 GPU 1，PPE 可单独使用 GPU 0。

活体模型已随附，`liveness_model_directory` 指向本目录的 `attendance/models/liveness`。RGB 活体输出需现场验证。语音依赖本次适配的 Monibuca 广播接口和现场听音验证文件；`submitted_unverified` 仅表示已提交，不能代替确认听到。

`attendance/local_preview.py` 是现有业主本机 SSH 预览工具，保留历史服务器地址和 SSH 主机指纹，凭据从标准输入读取；迁移到不同服务器前应核对地址及可信指纹。该工具使用 Python `audioop`，需使用支持该模块的既有 Python 环境。

## 离线验证

以下现有测试使用临时数据库、合成人员向量和模拟运行时，不读取真实人员库，也不连接摄像头：

```sh
cd attendance
python -m unittest test_attendance test_attendance_policy test_attendance_runtime test_face_liveness test_ssh_http test_voice_prepare
```

验证结果见 `VALIDATION.json`。离线通过不能证明远端视频在线、GPU 推理可用、听音成功或现场识别准确率。

## 未纳入内容

未包含 `private/`、真实人脸照片/特征库、考勤数据库和记录、姓名音频、账号密码、token、SSH 私钥、运行环境、下载缓存、固件和历史备份。办公室双摄电子围栏项目 `office_monitor/` 不在本次提交范围。

第三方权利和原有许可仍然有效；本提交未为自有代码授予新的开源许可。上游来源链接仅用于溯源，本次 Git 远程目标只有 Gitee。
