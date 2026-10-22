import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from face_runtime import verify_assets, restore_models


class AssetTests(unittest.TestCase):
    def fixtures(self, directory):
        root=Path(directory);source=root/'source';source.mkdir();models=root/'models'
        payload=b'synthetic-controlled-model'
        (source/'det.onnx').write_bytes(payload)
        manifest={'models':[{'filename':'det.onnx','bytes':len(payload),'sha256':hashlib.sha256(payload).hexdigest()}]}
        return root,source,models,manifest

    def test_recovery_preserves_hashes_is_idempotent_and_refuses_overwrite(self):
        with tempfile.TemporaryDirectory() as d:
            root,source,models,manifest=self.fixtures(d)
            restore_models(source,models,manifest)
            self.assertEqual(verify_assets(models,manifest)['verified_models'],1)
            restore_models(source,models,manifest)
            (models/'det.onnx').write_bytes(b'other')
            with self.assertRaises(ValueError):restore_models(source,models,manifest)
            self.assertEqual((models/'det.onnx').read_bytes(),b'other')

    def test_wrong_source_and_unsafe_manifest_are_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            root,source,models,manifest=self.fixtures(d)
            (source/'det.onnx').write_bytes(b'bad')
            with self.assertRaises(ValueError):restore_models(source,models,manifest)
            self.assertFalse((models/'det.onnx').exists())
            manifest['models'][0]['filename']='../escape.onnx'
            with self.assertRaises(ValueError):restore_models(source,models,manifest)

    def test_checked_in_original_engine_sources_match_recovery_manifest(self):
        root=Path(__file__).parent/'vendor_original'
        manifest=json.loads((root/'source-manifest.json').read_text(encoding='utf-8'))
        for entry in manifest['files']:
            data=(root/entry['file']).read_bytes()
            self.assertEqual(hashlib.sha256(data).hexdigest(),entry['sha256'],entry['file'])
        constants=(root/'facekit/core.py').read_text()
        models=json.loads(Path(__file__).with_name('face-models.json').read_text())
        for model in models['models']:self.assertIn(model['sha256'],constants)


if __name__ == '__main__':unittest.main()
