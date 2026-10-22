# Monibuca 5.1.6 语音适配

`monibuca-5.1.6/` 是覆盖文件集，不是完整 Monibuca 发行源码。将其覆盖到独立的完整官方 v5.1.6 源码树中，保留原其余文件，然后使用 Go 1.24.10、`CGO_ENABLED=0` 和 `sqlite,mysql,postgres` 构建标签编译。禁止覆盖其他版本后直接部署。

已保留八个实际部署相关 Go 文件（包括 ACK 和媒体测试）、原 `go.mod`、`go.sum`、AGPL-3.0 许可，以及 `voice-source-manifest.json`。在完整源码树的 `plugin/gb28181` 包运行相应测试。此次归档没有重新编译远端广播服务。

打卡 `gb_voice.py` 使用 `/gb28181/api/broadcast/start`、`status`、`stop` 和绑定 session 的 WebSocket 音频接口；输入是 8 kHz 单声道 PCMA 数据。会话状态与发送计数不等于摄像头实际播放成功，仍按原流程进行现场听音验证。
