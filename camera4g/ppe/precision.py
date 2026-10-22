"""Auditable PPE confidence gate and bounded person-ROI verification.

The original detector keeps its 0.4 diagnostic output. Positive hardhat/vest
evidence requires 0.50/0.65; absence is never inferred from missing detections.
ROI evidence competes against every original person through engine.associate.
"""
from __future__ import annotations

import copy
import math
import time

import numpy as np

from engine import PPE, associate


class PrecisionDetector:
    def __init__(self, detector, positive_confidences=None, negative_conf=.4, max_rois=4, padding=.08):
        positives = {"hardhat": .50, "safety vest": .65} if positive_confidences is None else dict(positive_confidences)
        if set(positives) != {"hardhat", "safety vest"}:
            raise ValueError("Positive thresholds require exactly hardhat and safety vest")
        if not all(isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v)
                   and 0 < negative_conf <= v <= 1 for v in positives.values()):
            raise ValueError("Confidence thresholds must satisfy 0 < negative <= each positive <= 1")
        if isinstance(max_rois, bool) or not isinstance(max_rois, int) or not 0 <= max_rois <= 4:
            raise ValueError("max_rois must be an integer between 0 and 4")
        if not math.isfinite(padding) or not 0 <= padding <= .25:
            raise ValueError("ROI padding must be between 0 and 0.25")
        if getattr(detector, "conf", negative_conf) > negative_conf:
            raise ValueError("Base detector threshold would discard required negative evidence")
        self.detector = detector
        self.positive_confidences = positives
        self.negative_conf = negative_conf
        self.max_rois = max_rois
        self.padding = padding
        self.class_confidences = {**positives, "no-hardhat": negative_conf, "no-safety vest": negative_conf}
        self.config = {"class_confidence_thresholds": dict(self.class_confidences),
                       "max_person_rois": max_rois, "person_roi_padding": padding,
                       "minimum_source_person_width": 20, "minimum_source_person_height": 64,
                       "small_person_roi_decision_gate": {"person_source_minimum": [32, 96],
                           "helmet_source_minimum": [12, 12], "vest_source_minimum": [20, 24],
                           "person_tensor_minimum": [20, 64],
                           "threshold_status": "conservative engineering limits; not field-calibrated"},
                       "unknown_is_noncompliant": False, "field_accuracy_verified": False,
                       "threshold_status": "limited-sample testing parameters, not field-calibrated thresholds"}

    def _gate(self, detections, source, suppressed):
        accepted = []
        for raw in detections:
            detection = copy.deepcopy(raw)
            label = detection["label"]
            if label in PPE:
                threshold = self.class_confidences[label]
                if detection["confidence"] < threshold:
                    suppressed.append({"source": source, "reason": "below_class_confidence",
                                       "required_confidence": threshold, "detection": detection})
                    continue
            accepted.append(detection)
        return accepted

    @staticmethod
    def _map_roi_detection(detection, crop, shape, person_box):
        h, w = shape[:2]
        left, top, right, bottom = crop
        values = detection["box"]
        if len(values) != 4 or not all(math.isfinite(float(v)) for v in values):
            return None
        # Clamp to the actual sampled ROI before translating. Never invent
        # pixels outside the crop or outside the source image.
        x1 = min(right-left, max(0., float(values[0]))) + left
        y1 = min(bottom-top, max(0., float(values[1]))) + top
        x2 = min(right-left, max(0., float(values[2]))) + left
        y2 = min(bottom-top, max(0., float(values[3]))) + top
        box = [min(w, max(0., x1)), min(h, max(0., y1)), min(w, max(0., x2)), min(h, max(0., y2))]
        if box[2] <= box[0] or box[3] <= box[1]:
            return None
        return {**copy.deepcopy(detection), "box": box, "evidence_source": "person_roi",
                "roi_context": {"crop_xyxy": list(crop), "source_frame_size": [w, h],
                    "source_person_box": list(person_box), "detector_input_size": [640, 640],
                    "touches_crop_boundary": bool(float(values[0]) <= 1 or float(values[1]) <= 1 or
                        float(values[2]) >= right-left-1 or float(values[3]) >= bottom-top-1)}}

    def predict(self, frame, roi_eligibility=None):
        if not isinstance(frame, np.ndarray) or frame.ndim != 3 or frame.shape[2] != 3 or min(frame.shape[:2]) <= 0:
            raise ValueError("Expected nonempty HxWx3 source frame")
        started = time.perf_counter()
        full_raw, full_ms = self.detector.predict(frame)
        diagnostics = {"config": dict(self.config), "full_frame_raw_detections": copy.deepcopy(full_raw),
                       "full_frame_inference_ms": full_ms, "suppressed": [], "rois": [], "skipped_rois": []}
        filtered = self._gate(full_raw, "full_frame", diagnostics["suppressed"])
        initial = associate(filtered, frame.shape)
        diagnostics["initial_person_states"] = copy.deepcopy(initial)
        candidates = sorted((p for p in initial if "unknown" in p["raw_states"].values()),
                            key=lambda p: -p["confidence"])
        total_ms = float(full_ms)
        h, w = frame.shape[:2]
        for person in candidates:
            # Live tracking can avoid ROI work for weak observations that will
            # be rejected anyway. Keep these person boxes in ``filtered`` and
            # ``initial`` so they still compete for PPE ownership. Offline
            # callers retain the original behavior when no callback is given.
            if roi_eligibility is not None and not roi_eligibility(person, initial):
                diagnostics["skipped_rois"].append({"person_box": person["box"],
                    "person_confidence": person["confidence"], "reason": "ineligible_tracking_observation"})
                continue
            x1, y1, x2, y2 = [float(v) for v in person["box"]]
            # Source pixels, before ROI resizing: upsampling a tiny person does
            # not create evidence. Retain the original person and unknown state.
            source_width = min(w, x2) - max(0., x1)
            source_height = min(h, y2) - max(0., y1)
            if source_width < 20 or source_height < 64:
                diagnostics["skipped_rois"].append({"person_box": person["box"], "reason": "source_person_too_small"})
                continue
            if len(diagnostics["rois"]) >= self.max_rois:
                diagnostics["skipped_rois"].append({"person_box": person["box"], "reason": "max_rois_reached"})
                continue
            pw, ph = x2-x1, y2-y1
            crop = [max(0, math.floor(x1-self.padding*pw)), max(0, math.floor(y1-self.padding*ph)),
                    min(w, math.ceil(x2+self.padding*pw)), min(h, math.ceil(y2+self.padding*ph))]
            left, top, right, bottom = crop
            if right <= left or bottom <= top:
                diagnostics["skipped_rois"].append({"person_box": person["box"], "reason": "empty_clamped_roi"})
                continue
            roi_raw, roi_ms = self.detector.predict(np.ascontiguousarray(frame[top:bottom, left:right]))
            total_ms += float(roi_ms)
            index = len(diagnostics["rois"])
            accepted = self._gate(roi_raw, f"person_roi:{index}", diagnostics["suppressed"])
            mapped = []
            for detection in accepted:
                if detection["label"] not in PPE:
                    continue  # ROI person boxes never replace or add identities.
                result = self._map_roi_detection(detection, crop, frame.shape, person["box"])
                if result is not None:
                    mapped.append(result)
                else:
                    diagnostics["suppressed"].append({"source": f"person_roi:{index}",
                                                       "reason": "invalid_clamped_box", "detection": detection})
            filtered.extend(mapped)
            diagnostics["rois"].append({"person_box": person["box"], "person_confidence": person["confidence"],
                                         "crop_xyxy": crop, "inference_ms": roi_ms,
                                         "raw_detections": copy.deepcopy(roi_raw), "mapped_ppe_detections": mapped})
        # Use all original people. Positive/negative conflicts and multiple
        # competing people stay unknown through the shared association rules.
        diagnostics["final_person_states"] = associate(filtered, frame.shape)
        diagnostics["total_inference_ms"] = total_ms
        diagnostics["total_wall_ms"] = (time.perf_counter()-started)*1000
        diagnostics["roi_count"] = len(diagnostics["rois"])
        return filtered, total_ms, diagnostics
