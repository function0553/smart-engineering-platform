"""Fetch pinned OpenCV Zoo assets and verify LFS digests before installing."""
import hashlib
import json
import re
import urllib.request
from model_paths import ROOT, models_directory

SPEC = json.loads((ROOT / 'vision' / 'base-models.json').read_text('utf-8'))
COMMIT = SPEC['commit']
MODELS = SPEC['models']

def prepare():
    target = models_directory()
    target.mkdir(parents=True, exist_ok=True)
    licenses = ROOT / 'vision' / 'licenses'
    licenses.mkdir(parents=True, exist_ok=True)
    manifest = []
    for entry in MODELS:
        directory, name, license_name = entry['directory'], entry['name'], entry['license']
        relative = f'models/{directory}/{name}'
        raw = entry['source']
        pointer = urllib.request.urlopen(raw, timeout=30).read().decode()
        pointer_digest = re.search(r'oid sha256:([a-f0-9]{64})', pointer)
        pointer_size = re.search(r'size (\d+)', pointer)
        digest, size = entry['sha256'], entry['size']
        if not pointer_digest or not pointer_size or pointer_digest.group(1) != digest or int(pointer_size.group(1)) != size:
            raise RuntimeError(f'Model source does not match pinned manifest: {name}')
        path = target / name
        if not path.exists() or path.stat().st_size != size or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            url = f'https://media.githubusercontent.com/media/opencv/opencv_zoo/{COMMIT}/{relative}'
            temporary = path.with_suffix('.download')
            urllib.request.urlretrieve(url, temporary)
            if temporary.stat().st_size != size or hashlib.sha256(temporary.read_bytes()).hexdigest() != digest:
                raise RuntimeError(f'Model checksum mismatch: {name}')
            temporary.replace(path)
        license_url = f'https://raw.githubusercontent.com/opencv/opencv_zoo/{COMMIT}/models/{directory}/LICENSE'
        license_text = urllib.request.urlopen(license_url, timeout=30).read()
        if len(license_text) < 500:
            raise RuntimeError('License download incomplete')
        (licenses / f'{directory}.txt').write_bytes(license_text)
        manifest.append(dict(name=name, sha256=digest, size=size, license=license_name, source=raw))
        print(json.dumps(dict(model=name, verified=True, size=size)), flush=True)
    (target / 'manifest.json').write_text(json.dumps(dict(commit=COMMIT, models=manifest), indent=2), encoding='utf-8')

if __name__ == '__main__':
    prepare()
