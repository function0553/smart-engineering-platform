# 4G 球机算法服务

安全帽检测、反光背心检测和人脸打卡在 **GPU 服务器**运行，供 **252 服务器的业务后端**接入。算法源码在 [`camera4g/`](camera4g/README.md)。本次不新增前端。

## 服务启动脚本与命令

以下命令均从仓库根目录执行，`/opt/hyc` 为示例路径，请换成实际部署目录。**先完成下方私有配置和依赖准备，再启动服务。**

| 启动脚本 | 执行位置 | 用途 |
| --- | --- | --- |
| [`camera4g/deploy/start-gpu.sh`](camera4g/deploy/start-gpu.sh) | **GPU** | 安全帽、反光背心检测；人脸打卡；已有视频与结果历史代理 |
| [`camera4g/deploy/start-252.sh`](camera4g/deploy/start-252.sh) | **252** | 启动仓库既有业务后端，加载 GPU HTTPS 接入配置 |

**GPU：启动安全帽、反光背心 CUDA 检测**

```sh
cd /opt/hyc
bash camera4g/deploy/start-gpu.sh ppe
```

**GPU：启动人脸打卡**

```sh
cd /opt/hyc
bash camera4g/deploy/start-gpu.sh attendance
```

**GPU：启动已有视频与检测历史代理**

```sh
cd /opt/hyc
bash camera4g/deploy/start-gpu.sh preview
```

三个服务是独立常驻进程，分别使用终端或 systemd 管理；不要在同一终端串行等待三条命令。preview 提供已有 HLS 与历史结果，不需要新增业务前端。

**252：启动既有业务后端**

```sh
cd /opt/hyc
bash camera4g/deploy/start-252.sh
```

252 已有服务时应合并环境配置，避免重复启动。后端已接入 GPU 人员录入与定时结果同步，不需要预建员工档案。GPU 保留人脸库并负责语音准备和发送。

## 首次启动前准备

GPU 使用独立 Python CUDA 环境；已有环境按实际路径使用。PPE 依赖安装命令：

```sh
cd /opt/hyc
/opt/camera4g/venv/bin/python -m pip install -r camera4g/ppe/requirements-cuda.txt
```

打卡原版 facekit/face_engine 最小源码已恢复到 `camera4g/attendance/vendor_original/`，启动脚本自动加载。完整打卡依赖见 `camera4g/attendance/requirements-gpu.txt`。SCRFD/ArcFace 权重沿用 GPU 受控原文件，用下方命令校验；权重不随 Git 再分发。GPU 已安装 espeak-ng 和 ffmpeg，并验证中文姓名音频生成；独立 UDP 诊断及重发后，用户反馈未听见，**本次球机播音验收失败**，正式发送器仍要求 TCP。下方安装命令供新机器恢复环境使用，详细步骤见 [打卡接入与模型恢复](camera4g/docs/ATTENDANCE_GPU_252_20261022.md)。

```sh
cd /opt/hyc
/opt/camera4g/venv/bin/python -m pip install -r camera4g/attendance/requirements-gpu.txt
python3 camera4g/attendance/face_runtime.py --model-directory /data/edge-face/releases/20260924-scrfd-arcface/models
# GPU 部署管理员安装姓名音频所需系统工具
sudo apt-get install -y espeak-ng ffmpeg
```

将以下模板复制到服务器私有目录并填写真实值；已有部署应保留原配置与数据。

| 配置模板 | 私有配置位置 | 关键设置 |
| --- | --- | --- |
| [`gpu.env.example`](camera4g/deploy/gpu.env.example) | GPU：`/etc/camera4g/private/gpu.env` | GPU_PYTHON、三个 JSON 路径、流地址和独立 token |
| [`ppe/config.example.json`](camera4g/ppe/config.example.json) | GPU：`/etc/camera4g/private/video.json` | device=cuda、device_id、模型绝对路径、camera_id、尺寸；确认 MAIN 流后设置 main_source_verified=true |
| [`attendance/config.example.json`](camera4g/attendance/config.example.json) | GPU：`/etc/camera4g/private/attendance.json` | 人脸/活体模型、数据库路径、cameras、gpu_id（默认 1，单 GPU 改为 0） |
| [`preview/config.example.json`](camera4g/preview/config.example.json) | GPU：`/etc/camera4g/private/preview.json` | inference_port 与 PPE bind.port 一致，恢复 HLS 媒体链路 |
| [`platform.env.example`](camera4g/deploy/platform.env.example) | 252：`/etc/camera4g/private/platform.env` | Node 路径、BASE_URL、原有数据库/模型路径、PPE_CONFIG_FILE |
| [`ppe-upstream.example.json`](camera4g/deploy/ppe-upstream.example.json) | 252：`/etc/camera4g/private/ppe-upstream.json` | GPU 实际 HTTPS 地址、cameraId、读取凭据和授权用户 |
| [`attendance-upstream.example.json`](camera4g/deploy/attendance-upstream.example.json) | 252：`/etc/camera4g/private/attendance-upstream.json` | sourceId、GPU HTTPS 地址、打卡 token、分页和轮询参数 |

替换全部 REPLACE_ 和 gpu.example.com，限制私有配置为服务用户可读。GPU 环境文件可用 CAMERA4G_GPU_ENV 指定，252 环境文件可用 CAMERA4G_252_ENV 指定。密码、token、真实人员数据不提交 Git。

GPU PPE/视频代理可先进行本地预检，不连接视频：

```sh
cd /opt/hyc
bash camera4g/deploy/start-gpu.sh ppe --check-only
bash camera4g/deploy/start-gpu.sh preview --check-only
bash camera4g/deploy/start-gpu.sh attendance --check-only
```

## systemd 常驻启动

先按实际环境调整 [GPU systemd 模板](camera4g/deploy/camera4g-gpu@.service.example) 中的服务用户、仓库路径及私有配置权限，再执行：

```sh
cd /opt/hyc
sudo cp camera4g/deploy/camera4g-gpu@.service.example /etc/systemd/system/camera4g-gpu@.service
sudo systemctl daemon-reload
sudo systemctl enable --now camera4g-gpu@ppe camera4g-gpu@attendance camera4g-gpu@preview
sudo systemctl status camera4g-gpu@ppe camera4g-gpu@attendance camera4g-gpu@preview
```

手动启动和 systemd 启动二选一，避免端口冲突。252 可参考 [既有后端 systemd 模板](camera4g/deploy/camera4g-platform.service.example)。

## GPU 对外接口与 252 接入

GPU SSH 连接命令（已只读核验原版运行环境与模型）：

```sh
ssh -p 2222 dell@211.139.12.141
```

**2222 是 SSH 端口，不是算法 HTTP/HTTPS 端口。** 252 调用算法必须使用 GPU 可达 IP 或域名，以下是待配置的外部入口示例，需替换域名并确认端口映射：

| GPU 外部接口示例 | 用途 | 鉴权 |
| --- | --- | --- |
| `https://gpu.example.com:29478` | 安全帽、反光背心检测 JSON 与状态 | Bearer：PPE_VIDEO_CAMERA_TOKEN |
| `https://gpu.example.com:29480` | HLS、检测历史、叠框参数 | HTTP Basic：viewer / PPE_PREVIEW_PASS |
| `https://gpu.example.com:29482` | 人脸打卡、人员录入、识别记录 | Bearer：ATTENDANCE_ADMIN_TOKEN |

跨服务器地址不能填 127.0.0.1、localhost 或 0.0.0.0。GPU 网关访问 GPU 本机算法进程可使用本机回环地址。部署时配置 [GPU HTTPS 网关模板](camera4g/deploy/gpu-gateway.nginx.conf.example)、TLS 证书、NAT 和 252 出口放行规则。

## 252 打卡服务接口

已有平台管理员登录后调用，POST 需 `X-Workspace-Request: 1` 与 JSON：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/api/camera4g-attendance/people/enroll` | 提交 person_id、name、photo_base64，由 GPU 录入、准备姓名语音 |
| GET | `/api/camera4g-attendance/people` | 查询已同步人员 |
| GET | `/api/camera4g-attendance/records?after=0&limit=200` | 查询 252 入库结果，可按日期和人员编号筛选 |
| GET | `/api/camera4g-attendance/status` | 查询同步时间、游标和安全错误状态 |
| POST | `/api/camera4g-attendance/sync` | 立即拉取一轮 GPU 结果 |

GPU 新增 `/api/attendance/changes?after=0&limit=200` 增量接口，252 持久化游标和摘要，支持超过 200 条的断线补录、重复同步去重和备份回滚检测。语音始终由 GPU 发出，252 拉取不会重播。完整说明见 [打卡接入文档](camera4g/docs/ATTENDANCE_GPU_252_20261022.md)。

## 交接文档与验证

- [GPU 算法服务 / 252 后端完整交接](camera4g/docs/GPU_252_HANDOFF_20261022.md)：接口路径、录入参数、语音依赖和联调步骤。
- [启动脚本清单](camera4g/deploy/README.md)：区分启动脚本与配置模板。
- [算法目录说明](camera4g/README.md)：依赖、模型和交付范围。
- [本次验证记录](camera4g/DEPLOYMENT_VALIDATION_20261022.json)：包含最新打卡专项、跨语言接口联调和原 PPE 回归结果；全仓测试仍有受控业务资产缺失。

本次为代码和文档交付，已验证原版 GPU 合成图推理，未执行远端上线。新版本部署、252 到 GPU 的 HTTPS 连通和现场语音效果仍需上线核验。

仓库保留的智慧工程平台本地运行、安卓构建和资产说明见 [PLATFORM_README.md](PLATFORM_README.md)。
