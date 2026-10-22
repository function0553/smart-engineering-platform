---
license: agpl-3.0
library_name: ultralytics
pipeline_tag: object-detection
base_model: ultralytics/yolov8
language:
  - en
tags:
  - object-detection
  - construction
  - construction-safety
  - construction-site-safety
  - site-safety
  - safety
  - safety-monitoring
  - hazard-detection
  - ppe
  - ppe-detection
  - personal-protective-equipment
  - hard-hat
  - hard-hat-detection
  - safety-helmet
  - helmet-detection
  - high-visibility
  - safety-vest
  - hi-vis
  - missing-ppe
  - worker-detection
  - person-detection
  - excavator
  - heavy-equipment
  - heavy-machinery
  - wheel-loader
  - dump-truck
  - job-site
  - computer-vision
  - yolov8
  - yolo
  - ultralytics
  - onnx
  - onnxruntime
  - browser
  - edge-ai
datasets:
  - roboflow-universe-projects/construction-site-safety
  - roboflow-100/construction-safety-gsnvb
metrics:
  - map50
  - map
model-index:
  - name: construction-site-safety-hazards
    results:
      - task:
          type: object-detection
        dataset:
          type: construction-safety-merged-test
          name: Construction safety test set (573 images, 4 sources)
          split: test
        metrics:
          - type: map50
            value: 0.6337
            name: mAP@50
          - type: map
            value: 0.3729
            name: mAP@50-95
---

# Construction Site Safety Hazards

**PPE and heavy-equipment detection for construction-site imagery.** A YOLOv8s detector that finds workers,
worn and missing PPE — hard hats, hi-vis vests, gloves, goggles, safety boots — and heavy plant (excavators, wheel
loaders, dump trucks) in a single pass. At 44.8 MB it runs entirely on-device, including in a web browser.

![Predictions on four held-out test images](example.jpg)

<sub>Predictions on held-out test images at confidence ≥ 0.4. Green: PPE worn · Red: PPE missing · Amber: heavy plant · Outline: worker.</sub>

| Test mAP@50 | Classes | Input | Runs on |
|:---:|:---:|:---:|:---:|
| **0.634** <sub>(v0.1: 0.442)</sub> | 14 | 640 × 640 | PyTorch · ONNX Runtime · Web |

> **Intended use.** Decision support for site teams: the model surfaces images and frames worth a closer look. It is
> not safety-rated, does not replace inspection by a competent person, and must not be used as a compliance record.

## Model details

| | |
|---|---|
| **Version** | v0.3 |
| **Architecture** | YOLOv8s (Ultralytics), fine-tuned from COCO |
| **Input** | RGB `1×3×640×640`, `float32` in `[0, 1]`, letterboxed with grey (114) padding |
| **Output** | `1×18×anchors`: `cx, cy, w, h` in input pixels, then one score per class (apply NMS) |
| **Classes** | `person`, `hardhat`, `no-hardhat`, `safety vest`, `no-safety vest`, `no-mask`, `gloves`, `safety shoes`, `excavator`, `wheel loader`, `dump truck`, `goggles`, `no-goggles`, `no-gloves` |
| **Files** | `buildvision-hazards-v0.3.onnx` · `buildvision-hazards-v0.3.pt` · `predict_onnx.py` · `config.json` · `metrics.json` |
| **Licence** | AGPL-3.0 (weights) · CC BY 4.0 (training data) |

## Performance

Evaluated on **573 held-out images** from the test splits of 4 public construction-safety datasets, with
near-duplicates of training and validation images removed.

| mAP@50 | mAP@50-95 | Precision | Recall |
|:---:|:---:|:---:|:---:|
| **0.634** | 0.373 | 0.754 | 0.604 |

### By class

| Class | Boxes | Precision | Recall | mAP@50 | mAP@50-95 | v0.1 mAP@50 |
|---|---:|---:|---:|---:|---:|---:|
| `person` | 713 | 0.874 | 0.892 | **0.908** | 0.555 | 0.807 |
| `hardhat` | 547 | 0.873 | 0.861 | **0.899** | 0.468 | 0.795 |
| `no-hardhat` | 126 | 0.452 | 0.381 | **0.379** | 0.143 | 0.047 |
| `safety vest` | 382 | 0.827 | 0.809 | **0.860** | 0.508 | 0.708 |
| `no-safety vest` | 222 | 0.635 | 0.581 | **0.522** | 0.241 | 0.368 |
| `no-mask` — not detected | 2 | 1.000 | 0.000 | **0.000** | 0.000 | 0.000 |
| `gloves` | 248 | 0.917 | 0.685 | **0.776** | 0.341 | 0.000 |
| `safety shoes` | 268 | 0.840 | 0.616 | **0.709** | 0.399 | 0.000 |
| `excavator` | 133 | 0.864 | 0.895 | **0.928** | 0.699 | 0.698 |
| `wheel loader` | 46 | 1.000 | 0.909 | **0.968** | 0.785 | 0.777 |
| `dump truck` | 78 | 0.849 | 0.821 | **0.888** | 0.712 | 0.666 |
| `goggles` (new) | 78 | 0.821 | 0.692 | **0.751** | 0.304 | — |
| `no-goggles` (new) | 67 | 0.384 | 0.254 | **0.208** | 0.045 | — |
| `no-gloves` (new) | 104 | 0.214 | 0.058 | **0.074** | 0.020 | — |

### By source

| Source | Images | mAP@50 | mAP@50-95 | v0.1 mAP@50 |
|---|---:|---:|---:|---:|
| Construction Site Safety | 34 | **0.531** | 0.337 | 0.503 |
| PPE detection 1 | 101 | **0.846** | 0.505 | 0.641 |
| PPE_Dectection v4 | 254 | **0.588** | 0.278 | 0.375 |
| excavators-czvg9 (RF100) | 184 | **0.911** | 0.695 | 0.677 |

*Evaluation notes.* Two sources label people incompletely; in their test images, people found by a stock COCO
YOLOv8s (confidence ≥ 0.5) were added as `person` boxes so that correct detections are not counted as false
positives. Scores reported by other PPE models use their own test sets and are not directly comparable.

## Usage

**Ultralytics**

```python
from ultralytics import YOLO

model = YOLO("buildvision-hazards-v0.3.pt")
for box in model("site.jpg", imgsz=640, conf=0.35)[0].boxes:
    print(model.names[int(box.cls)], float(box.conf), box.xyxy.tolist())
```

**ONNX Runtime** — no PyTorch required:

```bash
pip install onnxruntime numpy pillow
python predict_onnx.py site.jpg --out boxes.jpg
```

**Browser** — load the same ONNX file with `onnxruntime-web` (WASM). No server is involved; images never leave the device.

## Training

- **Data:** Construction Site Safety, construction-safety-gsnvb (RF100), PPE detection 1, PPE_Dectection v4, excavators-czvg9 (RF100) — 7,450 training and 567 validation images, all CC BY 4.0.
- **Recipe:** YOLOv8s from COCO weights at 640 px. Mosaic and mixup augmentation with a cosine learning-rate schedule.
- **Label clean-up:** classes with only a handful of boxes across the corpus (barricade, dumpster, mask, mini-van,
  truck, safety net) were removed before training.

## Limitations

- **Missing PPE is harder than worn PPE.** `no-hardhat` (0.379), `no-goggles` (0.208), `no-gloves` (0.074) trail
  their worn counterparts; expect missed violations and some false alarms, especially on unfamiliar sites and cameras.
- **Unsupported output channels.** `no-mask` — too few training examples to learn; ignore these outputs.
- **No fall protection.** Harnesses, lanyards and edge protection are not labelled in any training source.
- **No zones.** Exclusion zones around plant and vehicles are not predicted; derive them downstream from the detected boxes.
- **Model size.** YOLOv8s is chosen to run on-device; larger models trained on the same data did not score higher.

## FAQ

**Which PPE does it detect?** Hard hats, hi-vis vests, gloves, goggles and safety boots — and, for hard hats, vests,
gloves and goggles, their absence.

**Which equipment?** Excavators, wheel loaders and dump trucks, plus workers (`person`).

**Does it run offline?** Yes. The ONNX export runs in ONNX Runtime on CPU or in the browser with no network access.

**Can it be used for compliance decisions?** No. It is a screening aid for people, not a safety system.

## Licence

- **Weights — AGPL-3.0.** Trained with Ultralytics YOLOv8, whose models and derivatives are AGPL-3.0 unless covered
  by an Ultralytics Enterprise licence. Offering the model in a network service requires publishing that service's source.
- **Data — CC BY 4.0.** Sources below.

## Attribution

- **Construction Site Safety** — Roboflow Universe Projects, CC BY 4.0 — <https://universe.roboflow.com/roboflow-universe-projects/construction-site-safety>
- **construction-safety-gsnvb (RF100)** — Roboflow 100, CC BY 4.0 — <https://universe.roboflow.com/roboflow-100/construction-safety-gsnvb>
- **PPE detection 1** — vincentspace, CC BY 4.0 — <https://universe.roboflow.com/vincentspace/ppe-detection-1-cniwr>
- **PPE_Dectection v4** — himanshu-bharati, CC BY 4.0 — <https://universe.roboflow.com/himanshu-bharati/ppe_dectection-dtt4q>
- **excavators-czvg9 (RF100)** — Roboflow 100, CC BY 4.0 — <https://universe.roboflow.com/roboflow-100/excavators-czvg9>

Person pseudo-labels in the test set come from Ultralytics YOLOv8s (COCO).

## Citation

```bibtex
@misc{construction-site-safety-hazards,
  title  = {Construction Site Safety Hazards: PPE and Heavy-Equipment Detection},
  author = {Constructelligence},
  year   = {2026},
  url    = {https://huggingface.co/constructelligence/construction-site-safety-hazards}
}
```
