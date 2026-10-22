# 高清主码流服务器推理候选交接

2026-10-09最新方向：正式显示保持原连续 MAIN 视频帧率（用户目标25fps，实际源参数须验收），检测JSON由前端Canvas叠框。推理采样率与视频显示帧率独立，最新检测框不能冒称当前显示帧的同帧检测。此目录实现隔离读取、算法、鉴权JSON；旧烧框视频/JPEG只保留可显式开启的诊断路径。原 `ppe` 和图片 `server_candidate` 未修改。部署与4G实流验收由主任务负责；本目录代码验证为有限本机离线验证。

新示例默认 `media.enabled=false`、`diagnostic_jpeg_enabled=false`：worker不创建FFmpeg publisher、不画框、不编码JPEG，JSON明确 `inference_worker_does_not_publish_display_video`，不是错误。旧配置省略两个flag时均默认true以保持兼容。原连续视频/前端Canvas由独立媒体管线负责；必须利用session/epoch、真实PTS状态与结果age/TTL撤掉旧框，PTS未映射时不得声称精确同帧。

## 已实现

- `rtsp_reader.py` 使用 PyAV/FFmpeg 读取一个经确认的 RTSP/TCP 视频源，源URL仅环境变量与进程内存。每次重连创建新 session/epoch；断流清帧、结果和JPEG。连续解码保持编解码依赖，每个合法解码帧转 BGR 并替换唯一 pending 最新帧；reader不按到达时间限频，唯一推理限频在worker。没有旧帧队列，也不会重复推理同一旧帧填足配置fps。默认 `limits.source_pts_policy=observe`：重复、回退、缺失PTS保留原值/标unstable，不因PTS断流，时轴降为decoder-arrival，禁连续确认；不按不可信PTS lag重连。未来严格校准可显式strict，才启用PTS递增/缺失/backlog门槛。始终保留read超时、尺寸、像素、pending age和TTL。
- `video_runtime.py` 复用明确 CPU/CUDA 的 ONNX Detector、PrecisionDetector、Supervision ByteTrack。每台设备仅一个 pending 最新帧，只有一个推理拥有者；重连/过期/推理异常撤回旧结果。默认只生成JSON，诊断显式开启时才在同一原分辨率帧画框/编码；方向只处理一次，框坐标为 `oriented_source_pixels`。
- 推理节拍按实际step开始时间加1/fps限制，不再处理完成后额外idle完整周期。单步过慢时立即消费唯一最新pending，下一周期从这次实际开始计算；不会追赶历史deadline或补推旧帧。
- status与results新增 `processed_results_count`：仅成功提交仍新鲜的JSON后加1，整个进程生命周期累计，重连不清零；被覆盖pending、过期、失败或重连中的旧推理不计数。实际推理结果fps用该计数的增量/观测时间计算，不能使用HTTP去重数或被覆盖的sequence代替。进程重启会清零，跨重启窗口必须重新取基线。
- `media_publisher.py` 为显式开启的诊断路径，通过独立FFmpeg子进程将BGR编成H264，发布到仅loopback的标准RTSP router。限制线程、码率和写入截止时间；异常只杀拥有的FFmpeg。视频烧入 `E<epoch> S<sequence>`，JSON携带诊断帧键与编码session/index/PTS。写入编码器不是远端接收证明，也不是正式原25fps显示路径。
- `http_api.py` 提供 Bearer 鉴权 GET；关闭请求日志，限并发和绝对请求期限，无上传或摄像头配置操作。JSON/JPEG过期返回503；按指定epoch/sequence取JPEG，快照已变化返回409，避免错帧。媒体URL由部署方填写。

模型继续使用 `55f4dd2f53158eac4ff093d938b9fbda80c99454a03672145bbc36f539988249`。原算法三态和ROI规则保留，匿名视频轨迹不代表人脸身份。`temporal_confirmation_enabled=false` 默认仅输出诊断检测/匿名跟踪和 PPE unknown；启用连续确认还要求strict及声明已验收流时序契约。`source_pts_seconds` 保留未改写的原值，`source_pts_status`为observed_unverified/unstable或严格校准状态，`source_decode_sequence_local`只标识本reader帧。PTS和解码收件时间均没有被标作传感器曝光UTC。

## CPU服务器安装与启动

目标首次环境：Ubuntu22.04 x86_64/Python3.10，无GPU；不更新或重启原Java、nginx、Docker或媒体服务。新根目录 `/home/haha/4g-camera-inference`、独立venv、user systemd。根任务已批准初始CPUQuota200%、MemoryMax3G、ORT/decode/encode各1线程、推理1fps、ROI0。处理视频的目标帧率是推理采样帧率，不能称为25fps逐帧推理。

后续用户批准整个本任务8核预算：主任务已迁移到新system级 `camera4g.slice`，实际kernel `cpu.max=800000 100000`，总内存4G；worker建议3G，禁止spinning且不使用全机48核。远端同一历史图模拟2560×1440负载：ORT4/8 YOLO均120.264/86.177ms，完整HD含ByteTrack/JPEG/H264为5.327/5.625fps，全链均CPU286.33%/450.37%，10帧均真实解码。4线程完整P95=194.648ms、8线程=188.556ms，8线程仅少6ms却平均多57%CPU。建议先ORT4、decode1、encode1、ROI0、推理/媒体cap4fps；主任务也可选择ORT8/cap4并实测全slice资源。该选择不是4G实流、曝光时效或现场准确率验收。

```sh
# 在独立venv完整解析依赖，禁止与现有环境混装。
/home/haha/4g-camera-inference/venv/bin/python -m pip install -r video_server_candidate/requirements-cpu.txt
# 只核本地资产/配置/显式CPU；不读相机、不绑定端口。
/home/haha/4g-camera-inference/venv/bin/python video_server_candidate/server.py --config video_server_candidate/config.json --check-only
# 仅经根任务确认 MAIN 来源、实际尺寸、端口和资源隔离后启动。
/home/haha/4g-camera-inference/venv/bin/python video_server_candidate/server.py --config video_server_candidate/config.json
```

`config.example.json` 使用 API `127.0.0.1:28878`、发布 `rtsp://127.0.0.1:28554/annotated-main`；示例源尺寸2560×1440来自历史LAN，当前4G流必须重新核对。`main_source_verified=false` 保留为启动阻断。仅loopback匿名发布精确 annotated-main 的权限由独立router配置；匿名read关闭、其它原服务端口不复用。原码入口可由成熟GB28181/官方通道提供，worker本身只消费最终经过验证的RTSP路径，不实现或猜测相机P2P/GB协议。

秘密使用 `PPE_MAIN_STREAM_ENDPOINT`、`PPE_VIDEO_ADMIN_TOKEN`、`PPE_VIDEO_CAMERA_TOKEN`，token各至少32字节且不同。禁止把账号密码放进示例、交付包或日志。URL不打印；native异常不外传。FFmpeg发布地址只允许无凭据loopback。HTTP只绑定loopback，经批准TLS网关或SSH转发再给后端；不要将明文候选API直接开放公网。

仅诊断画框开启时需要Noto/WQY或合法 `PPE_FONT_PATH`；没有字体则相应预检失败。两个flag均false时无需字体或FFmpeg CLI存在，不解析imageio路径、不创建publisher。没有复制Windows微软雅黑。诊断FFmpeg采用独立venv `imageio-ffmpeg==0.6.0`，无需更换服务器全局安装。

GPU迁移另建环境安装 `requirements-cuda.txt`，显式 `device=cuda`/device_id，核GPU驱动/CUDA/cuDNN与全模型必需算子；CUDA禁止CPU回退。编码器可另选 `h264_nvenc` 并实测，不凭GPU推理成功推断NVENC可用。

## 后端契约

- `GET /healthz`、`GET /v1/status`：admin token，仅状态。
- `GET /v1/cameras/camera-01/status`：camera/admin token，返回连接、epoch、帧年龄、pending覆盖、媒体URL，无旧persons。
- `GET /v1/cameras/camera-01/results`：新鲜JSON，包括 camera/session/epoch/sequence、source_pts_seconds、接收/处理UTC、模型/provider、原尺寸、坐标/方向、detections/persons和媒体帧索引。
- `GET /v1/cameras/camera-01/frame.jpg?epoch=<e>&sequence=<s>`：仅诊断JPEG开启时提供与指定推理JSON同帧的JPEG。默认返回503 `diagnostic_jpeg_disabled`，不会读取/返回旧JPEG；JSON仍正常返回，`frame_jpeg_path=null`。

后端主动POST、数据库、告警和事件重试没有实现，先提供上述鉴权查询与router媒体读取URL。媒体客户端也必须根据状态/503撤去旧标签和冻结画面；外部播放器缓存不受本进程控制。实际HTTP TLS、媒体读账号和backend对接由根任务完成。

## 本轮验证与坑

`offline_verification.json` 的14项有限本机检查通过：既有最新帧/TTL/epoch隔离/Bearer/错帧、节拍fake clock、真实诊断H264/PyAV和CPU1/8；两个flag严格bool/旧配置默认兼容、JSON-only不调用publisher/render/JPEG且正常200/诊断503、observe重复/回退/缺失PTS不重连而strict阻断、原不稳定PTS保留且采用arrival时间/禁连续确认；新增35ms内8帧全部进入latest-slot、保留第8帧/覆盖7帧、只提交1次、重连不重置累计提交计数且重连中旧推理不计数。有限代码检查没有启动HTTP listener、联系相机/服务器或运行常驻服务。视频尺寸320×180及CPU8单帧640×360是合成验证尺寸，不是4G高清验收。当前本机PyAV19/ORT1.23.0，目标Python3.10 pins为PyAV16.0.1/ORT1.23.2。

1. 本机PyAV19.0.1要求Python>=3.12，不能复制版本到服务器3.10；改pin PyAV16.0.1，官方元数据确认有cp310 Linux wheel。ORT1.23.2同样核cp310 wheel。
2. PowerShell捕获Python输出的含中文FFmpeg路径出现编码损坏；改在Python内部解析imageio路径，部署也是相同实现。
3. 高速页面原JPEG+Canvas框不等于画框视频；本实现直接在同一原分辨率帧烧框，再重新编码。
4. 编码器stdin成功仅证明送入编码器。JSON明确 `encoder_input_written_not_remote_receipt`；必须另验媒体实际解码与帧键。
5. ByteTrack0.30.8提示将于0.31移除接口，因此固定当前版本；迁移须隔离回归，不能无界升级。
6. 原worker“完成后再等1/fps”会把配置3fps减至约2fps；已改为实际开始时刻+period，并以fake clock验证100.00/100.25/100.70三个开始时刻（0.10/0.45/0.02秒负载），慢步没有追赶旧周期。服务器只接收主任务核对SHA后的单文件补丁，本代理未改远端源码或服务。
7. 主任务真实4G原流发现PTS非严格递增、avg_rate元数据也不等于真实fps。不能把重复PTS当断流并反复重连，已设observe默认；不伪造单调PTS或曝光UTC，只有future strict校准使用递增和backlog门槛。前端显示仍保留原连续视频，检测JSON是独立低频观察。
8. 2026-10-09 06:38UTC独立只读30秒监测已部署ORT4/cap4版本：MAIN2560×1440，61次status/results均200、epoch稳定；解码450帧=15.00fps，但reader只准入26帧=0.867fps。60个半秒窗有27窗解码零、非零窗最多26帧；reader原到达时间门只取一批的首帧，丢掉更晚帧。已在本地取消该门，改latest-slot+唯一worker cap；修复后的实流效果须根任务上传并另测。全BGR转换从准入频率增至解码频率，需看CPU变化。原现场YOLO median209.885/P95219.108ms，worker均CPU61.8%、共享slice62.84%、无throttle，不能用离线86ms预期值直接承诺ORT8现场fps。报告在 `../server_deployment/live_worker_monitor_result_20261009.json`；本次仅只读API/cgroup，未改服务/参数/其它服务。

`SOURCE_MANIFEST.json` 为明确交付资产哈希；不交付 `_offline_tools`、`__pycache__`、虚拟环境、包库、下载缓存或秘密。有限验证产生的临时MP4由TemporaryDirectory清理，报告保留结果与哈希。

## 接手验收

先核本地预检/字体/CPU provider与资源隔离，再核通过4G获取的设备身份、MAIN实际尺寸/codec/PTS/方向，连续输入、重连清空、输出媒体解码与JSON帧键、同帧原分辨率画框、CPU负载/内存/时延。完成前保留 `production_accepted=false` 和 `field_accuracy_verified=false`。CPU率不足时减采样率或提升隔离预算后复验；不可默默降低主码流分辨率、积压旧帧或冒称已迁GPU。

原理/接口依据：[PyAV open与超时](https://pyav.org/docs/stable/api/_globals.html)、[FFmpeg RTSP与rw_timeout](https://ffmpeg.org/ffmpeg-protocols.html)、[PyAV16.0.1元数据](https://pypi.org/pypi/av/16.0.1/json)、[ORT1.23.2元数据](https://pypi.org/pypi/onnxruntime/1.23.2/json)。
