# 人脸打卡：GPU 原引擎恢复、252 录入与结果同步

2026-10-22。GPU 负责人员库、SCRFD/ArcFace、RGB 活体、打卡判定、姓名音频准备和球机语音发送；252 提供人员录入入口、定时拉取和持久化结果查询。无需先创建平台员工档案，本次不新增前端。

## GPU 原引擎和模型

原版最小源码已从 GPU 当前 `/data/edge-face/releases/20260924-scrfd-arcface` 恢复到 [`attendance/vendor_original`](../attendance/vendor_original/README.md)，逐文件原始摘要见该目录 source-manifest.json。GPU 启动脚本自动加入 PYTHONPATH，不再依赖仓库外的 facekit/face_engine 源码。

模型清单见 [`face-models.json`](../attendance/face-models.json)，保持原 det_10g.onnx、w600k_r50.onnx 和原 modelId，不替换现有图库特征空间。原 GPU 模型已只读核验摘要，并使用无人物合成图验证 CUDA 检测和 512 维特征提取。

权重不随 Git 再分发；[InsightFace 官方许可](https://github.com/deepinsight/insightface#license) 对代码和预训练权重分别规定。部署从受控原环境恢复有权使用的原文件，并核对使用授权。

**在当前 GPU 沿用已有权重：**

```sh
cd /opt/hyc
/data/4g-camera-inference/venv/bin/python camera4g/attendance/face_runtime.py \
  --model-directory /data/edge-face/releases/20260924-scrfd-arcface/models
```

**复制到独立部署目录（来源必须是受控原文件）：**

```sh
cd /opt/hyc
python3 camera4g/attendance/face_runtime.py \
  --source-models /data/edge-face/releases/20260924-scrfd-arcface/models \
  --model-directory /data/4g-camera-inference/models/scrfd-arcface
```

脚本先校验两份来源模型再复制，重复执行可校验通过；目标已有不同内容时拒绝覆盖。新机器先通过受控文件传输恢复来源文件，不从不明镜像自动下载模型。

`attendance/config.example.json` 的 model_directory 指向最终权重目录。`liveness_model_directory` 指向随仓库提供的活体模型目录。gpu_id 默认 1，单 GPU 改为 0。保留原图库 modelId，禁止直接用其他模型识别旧向量。

## GPU 依赖、姓名音频和启动

完整打卡 Python 依赖已按实际 GPU 环境版本写入 [`attendance/requirements-gpu.txt`](../attendance/requirements-gpu.txt)，不再用 PPE 清单代替。沿用原虚拟环境可先检查，独立新环境按该清单安装，并配置兼容的 CUDA/cuDNN 动态库。

```sh
cd /opt/hyc
/opt/camera4g/venv/bin/python -m pip install -r camera4g/attendance/requirements-gpu.txt
```

推荐使用本地中文神经模型；先按 [神经语音安装与启动说明](NEURAL_TTS_20261023.md)安装独立环境和模型。GPU 私有配置示例：

```json
{
  "voice_base_url": "http://127.0.0.1:12981",
  "voice_prepare_command": ["/opt/camera4g/venv-tts-neural/bin/python", "/opt/hyc/camera4g/attendance/prepare_neural_voice.py", "--model-dir", "/opt/camera4g/models/tts/vits-melo-tts-zh_en"],
  "voice_prepare_timeout": 30
}
```

voice_base_url 支持每摄像头覆盖、HTTP/HTTPS，WebSocket 自动映射为 ws/wss。它是 **GPU 发送语音所访问的广播通道**；保留本机隧道时用默认值，直连 252 媒体服务时填写 GPU 实际可达地址。此通道不同于 252 拉取 GPU 打卡结果的地址。

原姓名音频适配器在 GPU 本地调用 espeak-ng（中文）和 ffmpeg，输出 8kHz 单声道 G.711 A-law，不在录入时播放。2026-10-22 已在当前 GPU 安装 espeak-ng（1.50+dfsg-10ubuntu0.1），保留已有 ffmpeg；没有升级或卸载其他软件包，也没有重启业务服务。新机器恢复环境可执行：

```sh
sudo apt-get update
sudo apt-get install -y espeak-ng ffmpeg
```

已将本仓库适配器源码临时传入 GPU 内存执行，使用“测试人员”验证中文姓名音频生成：24777 bytes，3.097125 秒，8kHz、单声道 G.711 A-law；PCM 解码和非静音检查通过。没有保存或播放测试音频，没有录入真实人员，也未部署新服务或修改其配置。摘要见 [`TTS_VALIDATION_20261022.json`](../TTS_VALIDATION_20261022.json)。

**2026-10-22 球机发送测试未通过听音验收：** 在线设备/通道 `34020000001320000012` 当日协商 UDP。正式 Speaker 因要求 TCP 就绪而超时，发送 0 bytes；随后通过 GPU 独立诊断脚本，按实际协商的 UDP 通道发送“语音测试打卡成功”，源音频 24645 bytes，网关发出 25200 bytes（含静音补齐）、158 包，队列清空，BYE 与清理完成。19:44 首发，19:47、19:59 按要求重发后，用户明确反馈“没听见”，本次播音验收失败。未修改正式发送器、球机配置、图库或打卡记录，见 [`VOICE_CAMERA_TEST_20261022.json`](../VOICE_CAMERA_TEST_20261022.json)。正式发送器仍要求已验证的 TCP 通道；本次 UDP 诊断不等于打卡服务已支持或验收 UDP 播音。

也可通过 voice_prepare_command 使用已有受控本地语音工具：stdin 为 `{"name":"测试人员"}`，stdout 为 `{"voice_text":"测试人员打卡成功","voice_pcma_base64":"..."}`，音频长度为 2000–120000 bytes。命令必须使用绝对可执行文件路径，不经过 shell；超时、输出超限、姓名不符或音频格式错误会失败且不写入人员库。

GPU 原有已录入人员的音频仍保留，252 拉取、补录或重复查询不触发语音。submitted_unverified 仍表示已提交、待实际听音确认。

```sh
cd /opt/hyc
# 启动脚本：先做原引擎/模型/CUDA 预检，不访问图库和摄像头
bash camera4g/deploy/start-gpu.sh attendance --check-only
# 启动脚本：GPU 打卡服务
bash camera4g/deploy/start-gpu.sh attendance
```

预检检查推理引擎、模型、CUDA、活体模型与语音地址，不会实际调用 TTS 或球机；GPU 音频生成已单独验证，独立神经语音纯 4G 播放已通过现场听音；新版服务的正式配置接入和完整业务流程仍需部署验证。已部署机器在维护窗口先备份数据库，停止旧打卡 unit 后启动新版，避免两个服务同时处理同一球机。本次未执行该上线步骤。

## 252 配置和启动

将 [`attendance-upstream.example.json`](../deploy/attendance-upstream.example.json) 复制到 `/etc/camera4g/private/attendance-upstream.json`，填写稳定 sourceId、GPU HTTPS baseUrl 和 ATTENDANCE_ADMIN_TOKEN。baseUrl 示例 `https://实际GPU域名:29482`，不是 SSH 2222 端口，也不是 252 的 127.0.0.1。

252 私有环境增加：

```sh
CAMERA4G_ATTENDANCE_CONFIG_FILE=/etc/camera4g/private/attendance-upstream.json
```

现有 GPU TLS 网关模板已允许 `/api/`，保持 Bearer 和 TLS 校验；私有 CA 使用 NODE_EXTRA_CA_CERTS。定时拉取默认每 5 秒、每页 200 条、每轮最多 10 页；未拉完的后续轮次继续。没有配置接入时，既有后端继续运行，打卡接口返回 503 未配置。

```sh
cd /opt/hyc
# 启动脚本：252 既有后端，同时启动打卡结果同步任务
bash camera4g/deploy/start-252.sh
```

252 后端仍需要原有受控 Word 模板等业务资产，恢复要求见仓库 TEMPLATE_ASSETS.md。这是平台启动前提，不应把算法依赖安装当成完整平台恢复。

## 252 业务接口（已有平台登录会话，管理员）

统一前缀 `/api/camera4g-attendance`，所有接口仅管理员可用；POST 还需 JSON、`X-Workspace-Request: 1` 及既有同源校验。GPU token 始终保留在 252 服务端。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| POST | `/people/enroll` | 提交编号、姓名、照片，转 GPU 完成录入与姓名音频准备 |
| GET | `/people` | 252 已同步的人员列表及同步时间 |
| GET | `/records?after=0&limit=200` | 252 入库结果，返回 records/next_cursor/has_more |
| GET | `/records?from=2026-10-22&to=2026-10-22&person_id=EMP001` | 按北京时间业务日期和 GPU 人员编号筛选 |
| GET | `/status` | source_id、stream_id、cursor、last_sync、people_synced、error、syncing |
| POST | `/sync` | 立即执行一轮有限批次拉取，参数 `{}` |

录入请求：

```json
{"person_id":"EMP001","name":"测试人员","photo_base64":"<JPEG/PNG/WebP原始base64，图片不超过5MiB>"}
```

不需要 personId/employeeId。252 不持久化照片、人脸向量或音频。GPU 确认录入后 252 返回人员结果；明确拒绝的照片问题返回 422/rejected，可修正后重新提交。超时、断线或不确定的上游故障返回 503/unknown，不能自动重试以免覆盖未知的成功录入，应先核对 GPU 人员状态。

people 是已同步镜像，响应 last_sync；录入成功会立即更新该人员镜像。待核实超时结果时，先触发 `/sync` 成功后查询 `/people` 并确认同步时间，不能用旧列表判断是否录入成功。

镜像数据位于 252 原业务数据库的独立 `camera4g_attendance_*` 表；人员按 sourceId/person_id，记录按 sourceId/attendance_id 唯一，不自动创建业务员工、不混写通用考勤表。source_reset 标志表示 GPU 测试清除，镜像保留历史供审计。

## GPU 新增增量接口

`GET /api/attendance/changes?after=0&limit=200`，Bearer ATTENDANCE_ADMIN_TOKEN。limit 范围 1–500。原 `/api/attendance` 最近 200 条接口保留兼容用途。

```json
{
  "stream_id":"<持久化数据流标识>",
  "after_digest":null,
  "events":[{"sequence":1,"kind":"checkin","attendance_id":"...","digest":"<64hex>","record":{}}],
  "next_cursor":1,
  "has_more":false
}
```

record 包含 attendance_id/person_id/name/business_date/occurred_at/camera_id/similarity/voice_status/liveness_status/attendance_status/late_seconds。事件类型 checkin、voice_update、test_reset，均与原写入事务一起提交；照片、音频和特征不进入日志。

每条 digest 是包含前一条摘要的累积哈希链，绑定完整历史前缀；252 校验连续序号、stream_id 及上个游标的 after_digest，防止缺号或 GPU 恢复旧备份后序号复用而静默漏录。单页事件与游标在一个事务中入库。校验失败会停在原游标，保留已导入数据并在 status 报错。

出现 attendance_stream_changed、attendance_checkpoint_changed 或 attendance_cursor_rejected 时，不手改游标跳过记录。先备份双方数据库，核对是否换库/回滚；经核对需要重建镜像时，配置新的 sourceId 重新全量同步，旧来源记录保留用于对账，不能把两份来源累计当成新增打卡。

## 验证范围

专项测试覆盖 1000+ 条补录、重启续传、幂等、日志迁移、语音状态/测试清除、无员工档案录入、权限、大小限制、上游错误、备份回滚检测和超时子进程清理；另有真实 Python HTTP API 与 Node 镜像的本地合成数据联调。

GPU 原版 CUDA 推理已以合成空白图只读验证，GPU TTS 依赖已安装并通过合成姓名音频生成验证；上述独立球机语音发送诊断后用户反馈未听见，现场播音验收失败。2026-10-23 已核对目标球机序列号，仅修改语音字段恢复 TCP，纯 4G 下已能播出完整句子；随后改用本地中文神经模型，11:06:46 重发现场确认“完整清楚，可以使用”，见 [神经语音测试记录](../TTS_NEURAL_VALIDATION_20261023.json)。没有读取真实图库、录入人员或重启线上服务。新版部署、252 到 GPU HTTPS 实际连通、正式发送器传输配置和现场效果仍需上线时核验。
