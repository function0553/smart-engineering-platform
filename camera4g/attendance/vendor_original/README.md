# 原版人脸引擎最小源码

2026-10-22 从 GPU 当前使用的 `/data/edge-face/releases/20260924-scrfd-arcface` 只读恢复。文件原始字节及摘要见 `source-manifest.json`，未重新实现预处理或替换识别模型；入口是 `facekit.core.FacePipeline`。

启动脚本已将本目录加入 PYTHONPATH。`facekit/core_yunet_sface.py` 是原适配器依赖的图片解码、ORT 会话及通用数学工具；当前打卡入口仍为 SCRFD/ArcFace 512 维，不启用 YuNet/SFace 识别路径。

识别权重不在本目录，必须按 `../face-models.json` 恢复原文件并通过 `../face_runtime.py` 校验。旧发布的 models/manifest.json 描述 YuNet/SFace，不能用它证明 SCRFD/ArcFace 的来源；本交付使用原版 core.py 固定的 SCRFD/ArcFace 摘要。

预训练权重遵循 [InsightFace 官方模型许可](https://github.com/deepinsight/insightface#license)，与代码许可不同，商业使用需核对对应授权。此处不重新分发权重，也未为自有源码授予新许可。

保留的 `licenses/detector-LICENSE.txt`、`recognizer-LICENSE.txt` 属于旧适配器 YuNet/SFace 来源记录，不应当作 SCRFD/ArcFace 权重许可。
