"""Install a pinned, optional specialist and run inference before marking ready."""
import hashlib
import json
import sys
import urllib.request
import zipfile
from model_paths import ROOT, models_directory


def prepare():
    spec = json.loads((ROOT / 'vision' / 'specialist-models.json').read_text('utf-8'))['smoking']
    directory = models_directory() / 'smoking'
    directory.mkdir(parents=True, exist_ok=True)
    marker = directory / 'runtime.json'
    marker.unlink(missing_ok=True)
    def valid(entry):
        path = directory / entry['name']
        return path.exists() and path.stat().st_size == entry['size'] and hashlib.sha256(path.read_bytes()).hexdigest() == entry['sha256']
    if not all(valid(entry) for entry in spec['files']):
        archive = directory / 'model.download.zip'
        with urllib.request.urlopen(spec['url'], timeout=60) as response, archive.open('wb') as output:
            while chunk := response.read(1024*1024):
                output.write(chunk)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != spec['sha256']:
            raise ValueError('Specialist archive checksum mismatch')
        with zipfile.ZipFile(archive) as bundle:
            for entry in spec['files']:
                name = 'ppyoloe_crn_s_80e_smoking_visdrone/' + entry['name']
                data = bundle.read(name)
                if len(data) != entry['size'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
                    raise ValueError('Specialist file checksum mismatch')
                temporary = directory / (entry['name'] + '.tmp')
                temporary.write_bytes(data)
                temporary.replace(directory / entry['name'])
        archive.unlink()
    from smoking import SmokingModel
    import numpy as np
    model = SmokingModel(directory)
    result = model.detect_crop(np.zeros((256, 256, 3), np.uint8), .5)
    import paddle
    if result or paddle.__version__ != '3.2.2':
        raise ValueError('Specialist inference probe failed')
    receipt = dict(modelId=spec['id'], paddle=paddle.__version__, python=sys.version.split()[0], probe='blank-frame-inference-passed', backend='Paddle Inference / CPU')
    temporary = marker.with_suffix('.tmp')
    temporary.write_text(json.dumps(receipt, indent=2), encoding='utf-8')
    temporary.replace(marker)
    print(json.dumps(receipt), flush=True)


if __name__ == '__main__':
    prepare()
