"""Restore and verify the exact deployed SCRFD/ArcFace assets, without a gallery."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import tempfile

ROOT=Path(__file__).resolve().parent


def model_manifest():
    return json.loads((ROOT/'face-models.json').read_text(encoding='utf-8'))


def _entries(manifest):
    entries=manifest.get('models')
    if not isinstance(entries,list) or not entries:
        raise ValueError('model_manifest_required')
    for entry in entries:
        name=entry['filename']
        if not isinstance(name,str) or Path(name).name!=name or '/' in name or '\\' in name or name in ('.','..'):
            raise ValueError('invalid_model_filename')
    return entries


def _verified(path,entry):
    if not path.is_file() or path.stat().st_size!=entry['bytes']:
        raise ValueError('model_size_mismatch:'+entry['filename'])
    digest=hashlib.sha256()
    with path.open('rb') as file:
        for chunk in iter(lambda:file.read(1024*1024),b''):digest.update(chunk)
    if digest.hexdigest()!=entry['sha256']:
        raise ValueError('model_hash_mismatch:'+entry['filename'])


def verify_assets(directory,manifest=None):
    manifest=manifest or model_manifest()
    for entry in _entries(manifest):_verified(Path(directory)/entry['filename'],entry)
    return {'verified_models':len(manifest['models']),'model_id':manifest.get('model_id')}


def verify_sources():
    vendor=ROOT/'vendor_original'
    manifest=json.loads((vendor/'source-manifest.json').read_text(encoding='utf-8'))
    for entry in manifest['files']:
        path=(vendor/entry['file']).resolve()
        if not path.is_relative_to(vendor.resolve()):raise ValueError('invalid_source_path')
        _verified(path,{**entry,'filename':entry['file']})
    return {'verified_source_files':len(manifest['files'])}


def restore_models(source,destination,manifest=None):
    manifest=manifest or model_manifest();entries=_entries(manifest)
    source,destination=Path(source).resolve(),Path(destination).resolve()
    # Verify everything before changing the destination. Never replace other bytes.
    for entry in entries:
        _verified(source/entry['filename'],entry)
        target=destination/entry['filename']
        if target.exists():_verified(target,entry)
    destination.mkdir(parents=True,exist_ok=True)
    for entry in entries:
        target=destination/entry['filename']
        if target.exists():continue
        with tempfile.NamedTemporaryFile(dir=destination,prefix='.restore-',delete=False) as file:
            temporary=Path(file.name)
        try:
            shutil.copyfile(source/entry['filename'],temporary)
            _verified(temporary,entry)
            # Exclusive creation prevents replacing a concurrently installed file.
            with target.open('xb') as output,temporary.open('rb') as input_file:
                shutil.copyfileobj(input_file,output)
        finally:
            temporary.unlink(missing_ok=True)
    return verify_assets(destination,manifest)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-models',type=Path)
    parser.add_argument('--model-directory',required=True,type=Path)
    args=parser.parse_args()
    if args.source_models:restore_models(args.source_models,args.model_directory)
    print(json.dumps({**verify_sources(),**verify_assets(args.model_directory),'gallery_accessed':False}))


if __name__=='__main__':main()
