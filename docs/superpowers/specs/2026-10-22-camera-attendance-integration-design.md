# GPU 打卡恢复与 252 服务接入设计

日期：2026-10-22（北京时间）。状态：用户确认开始改动，已实施代码并进行专项验证；远端未上线。

## 用户需求和服务分工

1. GPU 运行人脸检测、识别、活体检查、打卡判定、姓名语音准备和球机语音发送。
2. 252 定时拉取 GPU 的人员与打卡结果，持久化、查询，并支持断线后的完整补录。
3. 252 服务也提供人员录入接口。用户提交编号、姓名和照片，252 转交 GPU 识别并入库，不在 252 执行人脸模型。
4. 本次不新增前端；不以 252 已有员工档案为接入前提。仓库虽有组织人员模块，不能假定现网已有对应档案。
5. GPU 保持人员库和识别记录的权威来源，252 保存业务可查询的镜像和同步状态。
6. 完成代码、测试、启动配置、README 和交接后推送 Gitee。远端上线、重启服务、修改实际人脸库不属于本次代码交付。

## 已验证的原始资产

已通过校验 SSH 主机指纹的连接只读查看 GPU 文件。

- 现有打卡配置：`/data/4g-camera-inference/config/attendance.json`。
- 现用引擎根目录与 PYTHONPATH：`/data/edge-face/releases/20260924-scrfd-arcface`。
- 原版源码包含 `facekit/core.py`、`face_engine/alignment/face_align.py`、SCRFD 检测与 ArcFace 识别实现。
- 现用模型目录：该引擎目录下的 `models`。
- SCRFD：`det_10g.onnx`，16,923,827 bytes，SHA-256 `5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91`。
- ArcFace：`w600k_r50.onnx`，174,383,860 bytes，SHA-256 `4c06341c33c2ca1f86781dab0e829f88ad5b64be9fba56e56bc9ebdefc619e43`。
- 现有 Python：`/data/4g-camera-inference/venv/bin/python`。

实施时恢复最小必需源码、依赖版本和来源摘要，核查源码与模型许可。允许发布的文件随源码交付；若模型不允许在该仓库再分发，提供从受控原部署恢复和校验的脚本，不用替代模型掩盖缺失。检查项及结果写入交接。

保持原模型摘要、预处理、512 维特征空间、modelId、识别阈值和既有图库兼容；不将新模型用于直接匹配旧向量，不导出真实人员照片、特征库或考勤数据库。

## 选择的集成方式

采用 252 主动拉取 GPU。与 GPU 主动推送相比，这与用户指定分工一致，无需让 GPU 获得 252 写入凭据；252 自己持有读取游标和事务。

252 录入请求流：调用者 → 252 登录鉴权/参数验证 → GPU HTTPS 录入 API → GPU 人脸及音频准备 → GPU 人员库 → 返回录入结果。252 不保存原始照片、特征向量和姓名音频。

打卡结果流：球机 → GPU 检测/活体/识别 → GPU 本地打卡事务和增量日志 → 252 拉取 → 252 持久化镜像和游标。语音始终从 GPU 的播报任务发送给媒体/球机通道，252 结果同步不会触发播报。

## GPU 数据和接口

### 保持兼容

现有 `/api/status`、`/api/people`、`/api/dashboard`、不带参数的 `/api/attendance` 保持可用，历史最近 200 条查询仅作为兼容接口。

新增独立增量接口 `GET /api/attendance/changes?after=<sequence>&limit=<1..500>`，默认 limit=200。参数严格验证，拒绝负数、非整数、重复或未知参数。

返回结构：`{stream_id, after_digest, events, next_cursor, has_more}`，各事件附带绑定此前所有事件的累积哈希链 digest，252 验证上一游标摘要以发现同 stream_id 备份回滚。event 包含单调递增 sequence、kind、attendance_id 及无生物特征的记录快照；kind 为 checkin、voice_update、test_reset。

### 增量日志和迁移

- 独立 SQLite AUTOINCREMENT 序号和持久化 stream_id，不用事件时间或普通 rowid 作为同步游标。
- 初次升级将现有打卡行按确定顺序一次性补建 checkin 事件，不修改其 attendance_id、人员特征或已播报状态。
- 新打卡、语音状态更新、今日测试清除分别在对应事务内记录事件。
- 日志快照不包含照片、向量、PCMA 内容、token 和私有路径。
- 测试清除不删除增量日志。252 收到 test_reset 后标记来源测试记录已撤销，保留历史可审计数据；不同 camera_id 的记录不受影响。
- stream_id 改变、服务恢复旧备份或游标超过上游范围时，252 停止推进并报告状态，不静默跳过未知数据。

### 人员录入与姓名语音

GPU `/api/enroll` 支持仅提交 person_id、name、photo_base64，由 GPU 完成姓名音频准备。现有包含 voice_text、voice_pcma_base64 的调用继续兼容并校验姓名与音频格式。

GPU 使用私有配置指定的本地音频准备命令，stdin/stdout 为明确 JSON 契约，禁用 shell 拼接，设置超时和输出大小限制。可按服务器已验证能力提供 Linux 音频适配器；缺少配置或音频准备失败时明确返回错误，不录入半成品，不退化成静默无播报记录。录入本身不播放声音。

语音发送读取 `voice_base_url`（支持公共配置及 camera 覆盖），默认仍为 `http://127.0.0.1:12981` 以兼容现有隧道。Speaker 同时使用该地址执行 HTTP 与相应 WebSocket 操作，支持 http/https、ws/wss 和可信证书校验；地址只来自 GPU 私有配置。

语音任务保持现有并发、超时、提交结果与现场听音验证边界。submitted_unverified 仍不表示确认听到，不因 252 重试、补录或重启而重新播报。

## 252 接入服务

### 公开给业务调用方的服务端 API

使用独立 `/api/camera4g-attendance` 路由，复用现有平台登录鉴权、请求校验标记和同源限制，不创建业务页面。

- `POST /api/camera4g-attendance/people/enroll`：管理员录入编号、姓名和单人照片，转交 GPU，返回已确认结果；不要求员工档案 ID。
- `GET /api/camera4g-attendance/people`：管理员查询 GPU 同步的人员列表和同步新鲜度。
- `GET /api/camera4g-attendance/records`：管理员按日期、人员编号和游标查询 252 已保存结果。
- `GET /api/camera4g-attendance/status`：管理员查看配置、GPU 可达性、stream_id、同步游标、时间和安全错误码。
- `POST /api/camera4g-attendance/sync`：管理员立即触发一次有限批次同步，正常运行仍由定时器拉取。

真实 HTTP 路由注册使用与现有后端一致的 JSON 大小和 CSRF 校验；GPU token 不下发调用者。不暴露任意上游路径/地址代理。

### 独立数据镜像

独立表保存人员镜像、打卡镜像、已处理事件和来源同步状态，不写入要求 personId 关联员工档案的通用 attendance 模块。

来源由私有配置的稳定 source_id 标识。打卡唯一键为 `(source_id, attendance_id)`；人员按 `(source_id, person_id)` 区分。记录保留 GPU 的编号、姓名快照、业务日期、camera_id、时间、正常/迟到、活体和语音状态。

重复拉取同一事件或同一记录不新增重复数据；一页的事件应用和游标更新处于一个 SQLite 事务中。无法处理的事件导致整页回滚并报告错误，不跳过后推进游标。

定时拉取有并发互斥、请求截止时间、单轮页数/记录上限和错误重试间隔；has_more 时后续轮次继续。退出时停止定时器并取消未完成请求。同步失败保留已有记录并展示同步状态，不能把旧结果称为实时结果。

### 252 到 GPU 网络配置

GPU 基地址、Bearer token 和 source_id 只从私有配置读取；跨机使用真实 HTTPS 域名或 IP，继续校验 TLS。地址不接受请求参数覆盖，不转发客户端 Cookie，不跟随越界重定向。

提供 `attendance-upstream.example.json`、252 环境模板与启动检查，保留原 PPE 配置。没有配置打卡接入时，既有业务后端仍能启动，打卡 API 返回明确未配置状态。

## 文件边界

- `camera4g/attendance/`：分页日志、录入语音准备、可配置 Speaker 地址、资产恢复/校验和专项测试。
- `server/camera4g-attendance*.mjs`：252 私有配置、上游访问、同步事务、人员录入和查询 API。
- `server/app.mjs`、`server/index.mjs`：注册 JSON 限额、接入模块、启动与关闭生命周期。
- `camera4g/deploy/`：私有配置和启动脚本扩展。
- `tests/`：252 模块和集成测试，使用临时数据库与合成数据，不依赖真实人员库。
- 首页 README、算法 README、交接文档、来源清单与验证记录：同步实际接口和启动方式。

不修改已有前端、业务员工档案、PPE 匿名身份规则、摄像头配置和现网服务。

## 验收与验证

1. 201 条和 1000 条合成打卡均能完整分页获取；同时间、跨重启、增量追加、测试清除和语音更新不遗漏或重播。
2. 252 中断多页后补录完整；重复同步幂等；单页失败事务回滚；游标与 stream_id 异常明确报错。
3. 没有员工档案也能通过 252 录入 GPU；管理员权限、照片大小、输入边界、上游错误和未知录入结果处理正确。
4. 姓名音频只在 GPU 准备和发送；录入不播报，252 拉取不播报；可配置语音地址实际传递给 HTTP/WebSocket。
5. 原引擎导入、依赖与模型摘要校验完成；图库 modelId 兼容。运行验证用非人员测试夹具；未经额外授权不执行真实人脸库写入。
6. 运行 Python 打卡专项测试、Node 接入专项测试和原 PPE 测试；检查脚本语法、README 路径及来源摘要。完整业务测试仍需按既有资产规则恢复 Word 模板，不能用伪造模板替代。
7. 书面记录本地通过项、未执行的远端上线与现场验证，不以代码推送宣称生产可用。
