"""Make a repeated-frame regression clip from a caller-supplied test image.

This does not assess action continuity or accuracy on independent scene data.
Use only material authorized for testing; no automatic media downloads.
"""
import argparse
from pathlib import Path
import cv2
import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument('--image', required=True)
args = parser.parse_args()
frame = cv2.imdecode(np.frombuffer(Path(args.image).read_bytes(), np.uint8), cv2.IMREAD_COLOR)
if frame is None:
    raise SystemExit('Cannot decode input image')
target = Path(__file__).resolve().parents[1] / '.data' / 'vision-test'
target.mkdir(parents=True, exist_ok=True)
writer = cv2.VideoWriter(str(target / 'smoking-regression.avi'), cv2.VideoWriter_fourcc(*'MJPG'), 2, (frame.shape[1], frame.shape[0]))
if not writer.isOpened():
    raise SystemExit('Cannot create fixture')
for _ in range(12):
    writer.write(frame)
writer.release()
print('Created isolated repeated-frame regression fixture, not a field-camera evaluation.')
