# GPU 服务器本地中文神经语音

2026-10-23。纯 4G TCP 已恢复播放；旧 espeak-ng 音色现场反馈为“整句都有，但中文发音含糊或机械”，因此新增本地中文神经语音适配器。音质验收结果见 [球机测试记录](../VOICE_CAMERA_TEST_20261022.json)。

## 当前 GPU 安装位置

- 独立 Python：`/data/4g-camera-inference/venv-tts-neural/bin/python`。
- 姓名语音适配器：`/data/4g-camera-inference/tts-neural-20261023/prepare_neural_voice.py`。
- 模型目录：`/data/4g-camera-inference/tts-neural-20261023/vits-melo-tts-zh_en`。
- sherpa-onnx / sherpa-onnx-core 均为 `1.12.26`，numpy 为 `2.2.6`。该独立环境使用 CPU provider、2 线程，在 GPU 服务器本地合成；不调用云端 TTS，也不改变原 CUDA 推理环境。
- 当前 GPU 缺少系统 venv/pip 引导依赖，实际采用独立 venv 加受控 pip wheel 引导、离线安装 wheel。模型与安装包上传后校验摘要；没有重启业务服务、修改人员库或替换现有人员音频。

适配器源码为 [`prepare_neural_voice.py`](../attendance/prepare_neural_voice.py)，依赖为 [`requirements-tts-neural.txt`](../attendance/requirements-tts-neural.txt)。输入输出复用现有 `voice_prepare_command` JSON 合约，输出为 8kHz、单声道、裸 G.711 A-law；只生成音频，不直接播放。姓名、路径、时长、样本有限值与输出长度均检查，失败时退出，不回退为旧机械音色。

## 新机器安装命令

以下按仓库 `/opt/hyc`、运行目录 `/opt/camera4g` 示例。当前 GPU 的实际路径见上一节；不要覆盖其原推理环境。

```sh
sudo apt-get update
sudo apt-get install -y python3-venv ffmpeg curl bzip2
python3 -m venv /opt/camera4g/venv-tts-neural
/opt/camera4g/venv-tts-neural/bin/python -m pip install -r /opt/hyc/camera4g/attendance/requirements-tts-neural.txt
mkdir -p /opt/camera4g/models/tts
cd /opt/camera4g/models/tts
curl -fL --connect-timeout 10 --max-time 600 -o vits-melo-tts-zh_en.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2
printf '%s  %s\n' e58351ed7149f290a54534538badd4077cdbe6fddc964b24d0bee870415d1514 vits-melo-tts-zh_en.tar.bz2 | sha256sum -c -
tar -xjf vits-melo-tts-zh_en.tar.bz2
```

下载网络受限时，可在受控电脑下载相同归档和 Linux Python 3.10 wheel 后传入服务器，再校验摘要、离线安装。模型权重未放入 Git。

## 打卡服务接入配置与启动脚本

在 GPU 私有打卡配置中设置：

```json
{
  "voice_prepare_command": [
    "/opt/camera4g/venv-tts-neural/bin/python",
    "/opt/hyc/camera4g/attendance/prepare_neural_voice.py",
    "--model-dir",
    "/opt/camera4g/models/tts/vits-melo-tts-zh_en"
  ],
  "voice_prepare_timeout": 30
}
```

这是录入时调用的一次性姓名音频准备命令，不是常驻进程。**打卡服务启动脚本**仍是 [`deploy/start-gpu.sh`](../deploy/start-gpu.sh)：

```sh
bash /opt/hyc/camera4g/deploy/start-gpu.sh attendance
```

现有 GPU 此次仅安装独立语音环境并完成独立合成与球机测试，未修改线上打卡配置或部署新版打卡应用。已有人员音频继续沿用，只有新录入且使用上述配置时才采用新音色；252 拉取结果不会触发重播。

## 来源与可核验摘要

使用 [sherpa-onnx 官方 MeloTTS 中文模型说明](https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/vits.html) 中的 `vits-melo-tts-zh_en`；上游 [模型许可证](https://huggingface.co/csukuangfj/vits-melo-tts-zh_en/blob/main/LICENSE) 为 MIT，随下载保留 `LICENSE`。

| 文件 | bytes | SHA256 |
| --- | ---: | --- |
| `vits-melo-tts-zh_en.tar.bz2` | 167006755 | `e58351ed7149f290a54534538badd4077cdbe6fddc964b24d0bee870415d1514` |
| `model.onnx` | 170429550 | `bf30582eb1b012250a35b1a4a80e7dfbcf8485e7bb9de0d95efbbeef0e4ad86d` |
| `lexicon.txt` | 6837671 | `7236884b02435ac5d10cf69b4be40a61b45aa676b5300f0e412f185748fee528` |
| `tokens.txt` | 655 | `d18664a7e12bd7ea1022ddaf951e534e136815016c5a809d6b64156bffb4369d` |

同一句合成和 TCP 发送计数只证明运行链路；最终清晰度以现场听音反馈为准。球机重启后的 `tcpActive` 保持情况尚未验证。
