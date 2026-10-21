"""Build a clearly isolated inference fixture from a caller-supplied public image."""
import argparse
from pathlib import Path
import cv2
import numpy as np

parser = argparse.ArgumentParser()
parser.add_argument('--image', required=True, help='Path to the public astronaut test image; never a business portrait')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
image = cv2.imdecode(np.frombuffer(Path(args.image).read_bytes(), np.uint8), cv2.IMREAD_COLOR)
if image is None:
    raise SystemExit('Cannot decode test image')
image = cv2.resize(image, (512, 512))
directory = root / '.data' / 'vision-test'
directory.mkdir(parents=True, exist_ok=True)
writer = cv2.VideoWriter(str(directory / 'public-astronaut.avi'), cv2.VideoWriter_fourcc(*'MJPG'), 4, (512, 512))
if not writer.isOpened():
    raise SystemExit('Cannot create test video')
for _ in range(24):
    writer.write(image)
writer.release()
(directory / 'public-reference.jpg').write_bytes(cv2.imencode('.jpg', image)[1].tobytes())
print('Created isolated video inference fixtures. No business database was modified.')
