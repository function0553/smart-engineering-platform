"""Supervision ByteTrack IDs with conservative, current-observation PPE states.

Track IDs are anonymous, ephemeral video tracks, not face/attendance identities.
The short missing-detection display is explicitly unknown and never creates PPE
evidence. It must only run for newly decoded frames, not a disconnected stream.
"""
from collections import deque
from copy import deepcopy
from dataclasses import dataclass, field
import math
from uuid import uuid4

import numpy as np
import supervision as sv

from engine import iou


@dataclass
class _Track:
    observation: dict
    timestamp: float
    byte_track_id: int | None = None
    histories: dict = field(default_factory=lambda: {
        name: deque(maxlen=5) for name in ('helmet', 'vest')})

    def clear_evidence(self):
        for history in self.histories.values():
            history.clear()


class SupervisionPPE:
    """Keep strong detections and bridge at most .8 s with pending boxes.

    ByteTrack provides motion-based track association. PPE history is reusable
    only when geometry also identifies one unambiguous previous observation.
    Thus a ByteTrack identity switch cannot alone transfer a green PPE state.
    The pinned supervision dependency is required; there is no silent fallback.
    """
    NEW_PERSON_CONFIDENCE = .4
    EXISTING_PERSON_CONFIDENCE = .2

    def __init__(self, max_gap_seconds=.6, lost_display_seconds=.8,
                 track_lifetime_seconds=1.5):
        if not 0 < max_gap_seconds <= track_lifetime_seconds <= 1.5:
            raise ValueError('Confirmation gap must be within the 1.5 second track lifetime')
        if not 0 <= lost_display_seconds <= .8:
            raise ValueError('Unobserved display is limited to 0.8 seconds')
        self.max_gap_seconds = max_gap_seconds
        self.lost_display_seconds = lost_display_seconds
        self.track_lifetime_seconds = track_lifetime_seconds
        self.backend = sv.ByteTrack(
            track_activation_threshold=.25, lost_track_buffer=45,
            minimum_matching_threshold=.8, frame_rate=30,
            minimum_consecutive_frames=1)
        self.next_id = 1
        self.reset()

    def reset(self):
        self.backend.reset()
        self.tracks = {}
        self.byte_to_local = {}
        self.last_timestamp = None
        self.tracking_epoch = uuid4().hex

    @property
    def metadata(self):
        return {'backend': 'supervision.ByteTrack', 'version': sv.__version__,
                'tracking_epoch': self.tracking_epoch,
                'identity_scope': 'anonymous_video_track',
                'face_identity_available': False,
                'lost_display_seconds': self.lost_display_seconds,
                'track_lifetime_seconds': self.track_lifetime_seconds,
                'new_person_min_confidence': self.NEW_PERSON_CONFIDENCE,
                'existing_person_min_confidence': self.EXISTING_PERSON_CONFIDENCE,
                'weak_person_requires_unique_existing_match': True,
                'confirmation_frames': 3}

    def _drop(self, tid):
        track = self.tracks.pop(tid)
        if self.byte_to_local.get(track.byte_track_id) == tid:
            self.byte_to_local.pop(track.byte_track_id, None)

    def should_refine_person(self, person, all_persons, timestamp):
        """Read-only ROI work gate using the existing weak-track admission rule.

        Strong observations always retain high-resolution inference. A weak
        observation must uniquely match a live old track before spending an ROI
        model call. The caller keeps every person in PPE ownership association;
        this method never creates tracks, confirms PPE, or reuses old evidence.
        ``person`` is one of the objects in the current ``all_persons`` list.
        """
        if not math.isfinite(timestamp) or (
                self.last_timestamp is not None and timestamp <= self.last_timestamp):
            raise ValueError('Timestamps must increase')
        score = person.get('confidence', .5)
        if not math.isfinite(score) or score < self.EXISTING_PERSON_CONFIDENCE:
            return False
        if score >= self.NEW_PERSON_CONFIDENCE:
            return True
        active = {tid: old for tid, old in self.tracks.items()
                  if timestamp - old.timestamp <= self.track_lifetime_seconds}
        plausible = [p for p in all_persons if math.isfinite(p.get('confidence', .5))
                     and p.get('confidence', .5) >= self.EXISTING_PERSON_CONFIDENCE]
        index = next((i for i, p in enumerate(plausible) if p is person), None)
        if index is None:
            return False
        candidates = [[tid for tid, old in active.items()
                       if iou(p['box'], old.observation['box']) >= .35] for p in plausible]
        possible = candidates[index]
        if len(possible) != 1 or sum(possible[0] in match for match in candidates) != 1:
            return False
        return not any(iou(person['box'], other['box']) >= .35
                       for other_index, other in enumerate(plausible) if other_index != index)

    def update(self, persons, timestamp):
        if not math.isfinite(timestamp) or (
                self.last_timestamp is not None and timestamp <= self.last_timestamp):
            raise ValueError('Timestamps must increase')
        if (self.last_timestamp is not None and
                timestamp - self.last_timestamp > self.track_lifetime_seconds):
            self.reset()
        self.last_timestamp = timestamp
        for tid in list(self.tracks):
            if timestamp - self.tracks[tid].timestamp > self.track_lifetime_seconds:
                self._drop(tid)

        # Lower-confidence person observations can continue an existing track,
        # never create one. Gate before ByteTrack: its own activation threshold
        # must not turn an otherwise rejected weak person into a new local ID.
        plausible = [p for p in persons if math.isfinite(p.get('confidence', .5))
                     and p.get('confidence', .5) >= self.EXISTING_PERSON_CONFIDENCE]
        all_candidates = [[tid for tid, old in self.tracks.items()
                           if iou(p['box'], old.observation['box']) >= .35] for p in plausible]
        all_usages = {tid: sum(tid in possible for possible in all_candidates) for tid in self.tracks}
        persons, weak_targets = [], {}
        for index, person in enumerate(plausible):
            if person.get('confidence', .5) >= self.NEW_PERSON_CONFIDENCE:
                persons.append(person)
                continue
            possible = all_candidates[index]
            unique = len(possible) == 1 and all_usages[possible[0]] == 1
            competing = any(iou(person['box'], other['box']) >= .35
                            for other_index, other in enumerate(plausible) if other_index != index)
            if unique and not competing:
                weak_targets[len(persons)] = possible[0]
                persons.append(person)

        # data follows sv.Detections slicing, preserving indices even if ByteTrack
        # activation suppresses a new track for one frame. Such observations still
        # appear immediately below with a provisional anonymous local ID.
        count = len(persons)
        detections = sv.Detections(
            xyxy=np.asarray([p['box'] for p in persons], dtype=np.float32).reshape(-1, 4),
            confidence=np.asarray([p.get('confidence', .5) for p in persons], dtype=np.float32),
            class_id=np.zeros(count, dtype=np.int32),
            data={'source_index': np.arange(count, dtype=np.int32)})
        tracked = self.backend.update_with_detections(detections)
        byte_ids = {}
        if len(tracked):
            byte_ids = {int(index): int(tid) for index, tid in
                        zip(tracked.data['source_index'], tracked.tracker_id)}

        previous = dict(self.tracks)
        candidates = [[tid for tid, old in previous.items()
                       if iou(p['box'], old.observation['box']) >= .35] for p in persons]
        usages = {tid: sum(tid in possible for possible in candidates) for tid in previous}
        proposals = []
        for index, possible in enumerate(candidates):
            by_motion = self.byte_to_local.get(byte_ids.get(index))
            unique = len(possible) == 1 and usages[possible[0]] == 1
            proposals.append(weak_targets[index] if index in weak_targets else
                             by_motion if by_motion in previous else (
                possible[0] if unique else None))
        proposal_usages = {tid: proposals.count(tid) for tid in set(proposals) if tid is not None}

        results, used = [], set()
        for index, person in enumerate(persons):
            tid = proposals[index]
            if index in weak_targets and (tid not in self.tracks or proposal_usages.get(tid) != 1):
                # A backend motion conflict cannot promote a weak observation.
                continue
            if tid is None or proposal_usages[tid] != 1:
                tid = self.next_id
                self.next_id += 1
                self.tracks[tid] = _Track(deepcopy(person), timestamp)
            track = self.tracks[tid]
            possible = candidates[index]
            same_previous = (len(possible) == 1 and possible[0] == tid and usages[tid] == 1)
            crowded = any(iou(person['box'], other['box']) >= .35
                          for other_index, other in enumerate(persons) if other_index != index)
            if not same_previous or crowded or timestamp - track.timestamp > self.max_gap_seconds:
                track.clear_evidence()

            byte_id = byte_ids.get(index)
            if byte_id is not None:
                if self.byte_to_local.get(track.byte_track_id) == tid:
                    self.byte_to_local.pop(track.byte_track_id, None)
                # Remove an older alias, so the same backend ID cannot display twice.
                old_alias = self.byte_to_local.get(byte_id)
                if old_alias is not None and old_alias != tid and old_alias not in used:
                    self._drop(old_alias)
                track.byte_track_id = byte_id
                self.byte_to_local[byte_id] = tid

            stable = {}
            for item in ('helmet', 'vest'):
                history = track.histories[item]
                state = person['raw_states'][item]
                if state == 'unknown' or (history and history[-1] != state):
                    history.clear()
                history.append(state)
                stable[item] = (state if state != 'unknown' and len(history) >= 3
                                and all(value == state for value in history) else 'unknown')
            track.observation, track.timestamp = deepcopy(person), timestamp
            used.add(tid)
            results.append({**deepcopy(person), 'track_id': tid, 'states': stable,
                            'byte_track_id': track.byte_track_id,
                            'weak_person_observation': index in weak_targets,
                            'tracking_epoch': self.tracking_epoch,
                            'tracking_status': 'observed', 'observation_age_seconds': 0.0})

        for tid in list(self.tracks):
            if tid in used:
                continue
            track = self.tracks[tid]
            track.clear_evidence()
            # An unmatched old box overlapping a current person is ambiguous, not
            # a second person. Retire that alias instead of showing a ghost box.
            if any(iou(track.observation['box'], p['box']) >= .20 for p in persons):
                self._drop(tid)
                continue
            age = timestamp - track.timestamp
            if age <= self.lost_display_seconds:
                unknown = {'helmet': 'unknown', 'vest': 'unknown'}
                results.append({**deepcopy(track.observation), 'track_id': tid,
                                'raw_states': unknown.copy(), 'states': unknown.copy(),
                                'reasons': {k: 'brief_detection_gap' for k in unknown},
                                'evidence': {k: [] for k in unknown}, 'confidence': None,
                                'byte_track_id': track.byte_track_id,
                                'tracking_epoch': self.tracking_epoch,
                                'tracking_status': 'temporarily_lost',
                                'observation_age_seconds': round(age, 6)})
        return results
