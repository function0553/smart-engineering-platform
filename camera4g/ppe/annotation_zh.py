"""Readable Chinese PPE overlays without converting full camera frames to Pillow.

Only small label patches use Pillow. A Chinese font is required; falling back to
OpenCV Hershey fonts would silently turn the actual camera labels into boxes.
"""
from functools import lru_cache
import os
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont


TEXT = {'worn': '已佩戴', 'not_worn': '未佩戴', 'unknown': '无法判断'}
# RGB for the Pillow label patches; person rectangles remain neutral.
COLORS = {'worn': (103, 235, 151), 'not_worn': (255, 130, 132),
          'unknown': (255, 219, 113)}
NEUTRAL = (236, 240, 246)


@lru_cache(maxsize=12)
def chinese_font(size):
    candidates = [os.environ.get('PPE_FONT_PATH'),
                  str(Path(os.environ.get('WINDIR', 'C:/Windows')) / 'Fonts/msyh.ttc'),
                  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
                  '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc']
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return ImageFont.truetype(candidate, size=size)
    raise RuntimeError('Chinese annotation requires Microsoft YaHei or a PPE_FONT_PATH CJK font')


def status_lines(person, still=False):
    """Display observations independently and never retain PPE on a lost track."""
    marker = person.get('tracking_status', person.get('tracking_display'))
    if isinstance(marker, dict):
        marker = marker.get('state', marker.get('status'))
    lost = marker in ('predicted', 'temporarily_lost')
    header = f"人员 #{person.get('track_id', '—')}" + (' · 短时丢失' if lost else '')
    states = person.get('raw_states' if still else 'states', {})
    lines = [(header, NEUTRAL)]
    for item, name in (('helmet', '安全帽'), ('vest', '反光背心')):
        state = 'unknown' if lost else states.get(item, 'unknown')
        if state not in TEXT:
            state = 'unknown'
        pending = (not still and not lost and state == 'unknown' and
                   person.get('raw_states', {}).get(item) in ('worn', 'not_worn'))
        label = '确认中' if pending else TEXT[state]
        lines.append((f'{name}：{label}', COLORS[state]))
    return lines


@lru_cache(maxsize=64)
def _patch(lines, font_size):
    font = chinese_font(font_size)
    padding = max(4, round(font_size * .27))
    spacing = max(3, round(font_size * .15))
    measures = [font.getbbox(text) for text, color in lines]
    width = max(right-left for left, top, right, bottom in measures) + padding*2
    line_height = max(bottom-top for left, top, right, bottom in measures)
    height = len(lines)*line_height + (len(lines)-1)*spacing + padding*2
    patch = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    drawer = ImageDraw.Draw(patch)
    drawer.rounded_rectangle((0, 0, width-1, height-1), radius=padding,
                             fill=(20, 29, 38, 225))
    for index, ((text, color), bounds) in enumerate(zip(lines, measures)):
        drawer.text((padding-bounds[0], padding+index*(line_height+spacing)-bounds[1]),
                    text, font=font, fill=(*color, 255))
    rgba = np.asarray(patch)
    # Keep a cached contiguous BGR patch and alpha instead of converting frames.
    return np.ascontiguousarray(rgba[:, :, 2::-1]), rgba[:, :, 3:4].astype(np.float32)/255


def _overlay(image, patch, x, y):
    pixels, alpha = patch
    height, width = pixels.shape[:2]
    x, y = int(x), int(y)
    x2, y2 = min(image.shape[1], x+width), min(image.shape[0], y+height)
    if x2 <= x or y2 <= y:
        return
    pixels = pixels[:y2-y, :x2-x]
    alpha = alpha[:y2-y, :x2-x]
    roi = image[y:y2, x:x2]
    roi[:] = (pixels*alpha + roi*(1-alpha)).astype(np.uint8)


def _overlap(a, b):
    return max(0, min(a[2], b[2])-max(a[0], b[0])) * max(0, min(a[3], b[3])-max(a[1], b[1]))


def annotate_zh(bgr, persons, still=False, title=None):
    image = bgr.copy()
    height, width = image.shape[:2]
    scale = width/1280
    font_size = max(16, round(26*scale))
    margin = max(4, round(8*scale))
    thickness = max(1, round(2*scale))
    caption = title or ('离线单帧检测 · 仅供复核' if still else '实时安全装备检测 · 连续帧确认')
    title_patch = _patch(((caption, NEUTRAL),), max(12, round(18*scale)))
    _overlay(image, title_patch, margin, margin)
    occupied = [(margin, margin, margin+title_patch[0].shape[1], margin+title_patch[0].shape[0])]
    floor = occupied[0][3]+margin
    boxes = []
    for person in persons:
        x1, y1, x2, y2 = [round(v) for v in person['box']]
        x1, x2 = max(0, min(x1, width-1)), max(0, min(x2, width-1))
        y1, y2 = max(0, min(y1, height-1)), max(0, min(y2, height-1))
        boxes.append((x1, y1, x2, y2))
        cv2.rectangle(image, (x1, y1), (x2, y2), (210, 210, 210), thickness)
    for person, box in zip(persons, boxes):
        x1, y1, x2, y2 = box
        patch = _patch(tuple(status_lines(person, still)), font_size)
        ph, pw = patch[0].shape[:2]
        # Prefer a card above the person. Other candidates keep neighbouring
        # labels apart and avoid covering faces when people stand side by side.
        candidates = [(x1, y1-ph-margin), (x2+margin, y1), (x1-pw-margin, y1),
                      (x1, y2+margin), (x1, y1+margin)]
        candidates += [(x, floor) for x in range(margin, max(margin+1, width-pw), max(1, pw+margin))]
        options = []
        for cx, cy in candidates:
            cx = max(0, min(cx, max(0, width-pw)))
            cy = max(min(floor, max(0, height-ph)), min(cy, max(0, height-ph)))
            rect = (cx, cy, cx+pw, cy+ph)
            collisions = sum(_overlap(rect, other) for other in occupied)
            faces = sum(_overlap(rect, (a, b, c, b+(d-b)*.3)) for a, b, c, d in boxes)
            distance = abs(cx-x1)+abs(cy+ph-y1)
            options.append((collisions*100 + faces*3 + distance, cx, cy, rect))
        _, cx, cy, rect = min(options, key=lambda item: item[0])
        # A leader joins detached labels to the anonymous person's rectangle.
        if abs(cx-x1) > margin*2 or abs(cy+ph-y1) > margin*2:
            start = (max(cx, min((x1+x2)//2, cx+pw)), max(cy, min(y1, cy+ph)))
            cv2.line(image, start, ((x1+x2)//2, y1), (185, 185, 185), thickness)
        _overlay(image, patch, cx, cy)
        occupied.append(rect)
    return image
