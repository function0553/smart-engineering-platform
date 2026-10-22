"""Hash explicit delivery assets only; never bundle environments or credentials."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ASSETS = ['engine.py', 'precision.py', 'tracking.py', 'annotation_zh.py', 'configuration.py',
          'rtsp_reader.py', 'media_publisher.py', 'video_runtime.py', 'http_api.py', 'server.py',
          'requirements-common.txt', 'requirements-cpu.txt', 'requirements-cuda.txt',
          'config.example.json', 'ppe-video.service.example', 'README.md',
          'verify_offline.py', 'offline_verification.json', 'build_manifest.py',
          'models/reference-v0.3/config.json', 'models/reference-v0.3/provenance.json',
          'models/reference-v0.3/README.md', 'models/reference-v0.3/buildvision-hazards-v0.3.onnx']


def main():
    files = {}
    for name in ASSETS:
        path = ROOT/name
        data = path.read_bytes()
        files[name] = {'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
    report = {'schema_version': 1, 'generated_at_utc':datetime.now(timezone.utc).isoformat(),
              'kind':'isolated_video_server_candidate', 'model_sha256':files['models/reference-v0.3/buildvision-hazards-v0.3.onnx']['sha256'],
              'verification_scope':'finite_local_offline_only', 'secrets_included':False,
              'environment_or_native_library_included':False,'remote_deployed_by_this_agent':False,
              'four_g_main_stream_verified_by_this_agent':False, 'production_accepted':False, 'files':files}
    (ROOT/'SOURCE_MANIFEST.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'assets':len(files),'model_sha256':report['model_sha256']}))


if __name__ == '__main__':
    main()
