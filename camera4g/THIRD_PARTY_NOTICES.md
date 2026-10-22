# 第三方来源与许可

- PPE 参考模型：`constructelligence/construction-site-safety-hazards`，revision `45d07d8e27a4754df1ea651f62153e000133bece`；原 `provenance.json` 声明权重 AGPL-3.0，保留模型 README、配置、来源及哈希。许可文本见 `licenses/AGPL-3.0.txt`。
- Silent-Face-Anti-Spoofing：Minivision，commit `b6d5f04ad78778917853b25c778acef6d5626d15`，Apache-2.0；`fas_crop.py` 保留原作者信息，双尺度转换模型及输入约定见 `attendance/models/liveness/model-manifest.json`。原许可见 `licenses/Silent-Face-Anti-Spoofing.LICENSE`。
- Monibuca 5.1.6 及其语音适配基线：AGPL-3.0，原许可随覆盖文件集保留。Go 模块依赖仍适用各自许可。
- hls.js 1.7.3：保留 `preview/vendor/LICENSE.hls.js` 与原脚本。
- MediaMTX reader 1.21.2：保留原 JavaScript 文件及其内嵌来源声明；运行 MediaMTX 需从上游另行取得对应版本和完整许可。
- Python/Go 依赖未连同虚拟环境或包缓存上传；依赖适用各自许可。

本文件用于记录原有来源和声明，不授予自有源码新的开源许可，也不变更第三方组件许可。

- SCRFD/ArcFace 适配器：最小原版源码从当前 GPU 发布目录只读恢复，文件摘要见 attendance/vendor_original/source-manifest.json；权重清单见 attendance/face-models.json。InsightFace 代码与预训练权重许可不同，官方说明 https://github.com/deepinsight/insightface#license；本仓库不再分发该权重。保留的 YuNet/SFace 许可属于原适配器工具来源，不能充当 SCRFD/ArcFace 权重许可。
- GPU 姓名音频适配器通过本机命令调用 espeak-ng 和 ffmpeg；二进制不随本仓库分发，各自遵循原项目许可。
