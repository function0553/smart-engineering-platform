"""JSON-lines worker owned by the authenticated platform, one per source."""
import json
import os
import queue
import sys
import threading
import time
from datetime import datetime, timezone

os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = 'rtsp_transport;tcp'
os.environ['OPENCV_LOG_LEVEL'] = 'SILENT'
import cv2
from core import Models, MODEL_ID, Tracker, jpeg, quality

def emit(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)

def main():
    config = json.loads(sys.stdin.readline())
    try:
        models = Models()
    except Exception:
        emit(dict(type='error', code='model_load_failed', message='基础视觉模型加载失败，请核对模型校验和运行环境。'))
        return 2
    updates = queue.Queue(maxsize=1)
    stopped = threading.Event()
    def control():
        for line in sys.stdin:
            try:
                value = json.loads(line)
                try:
                    updates.get_nowait()
                except queue.Empty:
                    pass
                updates.put_nowait(value)
            except ValueError:
                pass
        # Stop if the owning platform has exited, including an unexpected exit.
        stopped.set()
    threading.Thread(target=control, daemon=True).start()
    source = config['source']
    # Timeout values are passed at open, so failed RTSP connections cannot stall forever.
    cap = cv2.VideoCapture(source['uri'], cv2.CAP_FFMPEG, [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 6000, cv2.CAP_PROP_READ_TIMEOUT_MSEC, 6000])
    if not cap.isOpened():
        emit(dict(type='error', code='video_open_failed', message='无法打开视频，请核对地址、账号、通道和网络。'))
        return 2
    latest = queue.Queue(maxsize=1)
    if source['kind'] == 'rtsp':
        def read_live():
            while not stopped.is_set():
                ok, frame = cap.read()
                item = (ok, frame, datetime.now(timezone.utc).isoformat())
                try:
                    latest.put_nowait(item)
                except queue.Full:
                    try:
                        latest.get_nowait()
                    except queue.Empty:
                        pass
                    latest.put_nowait(item)
                if not ok:
                    break
        threading.Thread(target=read_live, daemon=True).start()
    tracker = Tracker()
    frame_no, processed, next_at = 0, 0, 0.
    video_fps = cap.get(cv2.CAP_PROP_FPS) or 25.
    emit(dict(type='ready', modelId=MODEL_ID, backend='OpenCV DNN / CPU', width=int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), height=int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))))
    smoking = None
    while not stopped.is_set():
        while not updates.empty():
            config = updates.get()
        # Only analysis settings may change on a live connection. Replacing a
        # source is handled by the parent stopping this process first.
        source['fps'] = config['source']['fps']
        source['captureFaces'] = config['source'].get('captureFaces', False)
        started = time.monotonic()
        if source['kind'] == 'rtsp':
            try:
                ok, frame, captured_at = latest.get(timeout=8)
            except queue.Empty:
                ok, frame = False, None
        else:
            ok, frame = cap.read()
            captured_at = datetime.now(timezone.utc).isoformat()
        if not ok:
            emit(dict(type='ended' if source['kind'] == 'file' else 'error', code='end_of_file' if source['kind'] == 'file' else 'video_read_failed'))
            break
        frame_no += 1
        if source['kind'] == 'file':
            stride = max(1, round(video_fps / source['fps']))
            if (frame_no-1) % stride:
                continue
        elif started < next_at:
            continue
        next_at = started + 1 / source['fps']
        if max(frame.shape[:2]) > 1280:
            frame = cv2.resize(frame, (round(frame.shape[1]*1280/max(frame.shape[:2])), round(frame.shape[0]*1280/max(frame.shape[:2]))))
        models.set_gallery(config.get('portraits', []))
        rules = config.get('rules', [])
        threshold = min([.35] + [r['data'].get('confidence', .7) for r in rules + config.get('fenceRules', [])])
        observed_at = (frame_no-1)/video_fps if source['kind'] == 'file' else datetime.fromisoformat(captured_at).timestamp()
        objects = tracker.update(models.detect_objects(frame, threshold), observed_at)
        faces = models.detect_faces(frame) if source.get('captureFaces') or config.get('watchRules') or any(r['data']['algorithm'] == 'face_capture' for r in config.get('rules', [])) else []
        behaviors, warnings = [], []
        smoking_rules = [r for r in rules if r['data']['algorithm'] == 'smoking']
        if smoking_rules:
            if smoking is None:
                try:
                    from smoking import SmokingModel
                    smoking = SmokingModel()
                except Exception:
                    emit(dict(type='error', code='model_load_failed', message='抽烟专项模型加载失败，请重新运行专项模型准备。'))
                    return 2
            persons = [obj for obj in objects if obj['classId'] == 0]
            if len(persons) > 16:
                warnings.append('当前画面超过 16 人，抽烟专项仅分析最大的 16 个人员目标；请拆分近景点位。')
            persons = sorted(persons, key=lambda obj: -obj['box'][2]*obj['box'][3])[:16]
            behaviors = smoking.detect(frame, persons, min(r['data']['confidence'] for r in smoking_rules))
        preview = frame.copy()
        for obj in objects:
            if obj['classId'] != 0:
                continue
            x, y, w, h = map(int, obj['box'])
            cv2.rectangle(preview, (x, y), (x+w, y+h), (80, 200, 80), 2)
            cv2.putText(preview, obj['objectId'], (x, max(16, y)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (80, 200, 80), 1)
        for behavior in behaviors:
            x, y, w, h = map(int, behavior['box'])
            cv2.rectangle(preview, (x, y), (x+w, y+h), (0, 180, 255), 2)
            cv2.putText(preview, f"Cigarette? {behavior['confidence']:.2f}", (x, max(16, y-5)), cv2.FONT_HERSHEY_SIMPLEX, .45, (0, 180, 255), 1)
        processed += 1
        emit(dict(type='frame', sequence=processed, occurredAt=captured_at, mediaSeconds=round(observed_at, 3) if source['kind'] == 'file' else None,
            objects=objects, faces=faces, behaviors=behaviors, warnings=warnings, quality=quality(frame), frame=jpeg(frame), preview=jpeg(preview), width=frame.shape[1], height=frame.shape[0], inferenceMs=round((time.monotonic()-started)*1000), modelId=MODEL_ID,
            appliedWatches=[dict(ruleId=r['id'], version=r['version']) for r in config.get('watchRules', [])], appliedFences=[dict(ruleId=r['id'], version=r['version']) for r in config.get('fenceRules', [])], appliedRules=[dict(ruleId=r['id'], version=r['version']) for r in config.get('rules', [])], galleryErrors=models.gallery_errors))
        if source['kind'] == 'file':
            stopped.wait(max(0, 1/source['fps']-(time.monotonic()-started)))
    stopped.set()
    cap.release()
    return 0

if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        # Native error strings can include stream credentials; emit only the type.
        emit(dict(type='error', code='inference_failed', message=f'视觉服务异常：{type(error).__name__}'))
        sys.exit(1)
