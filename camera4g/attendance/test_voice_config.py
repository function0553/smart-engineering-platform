import base64
import json
from pathlib import Path
import sys
import tempfile
import unittest

from gb_voice import Speaker
from attendance_service import speaker_for
from voice_audio import prepare_voice


class VoiceConfigTests(unittest.TestCase):
    def test_remote_https_maps_to_wss_and_is_wired_from_camera_config(self):
        speaker = speaker_for({'voice_base_url':'https://voice.internal.example:12981',
                               'device_id':'device-2','channel_id':'channel-2'})
        self.assertEqual(speaker.base, 'https://voice.internal.example:12981')
        self.assertEqual(speaker.websocket_url, 'wss://voice.internal.example:12981/gb28181/api/talk/start')
        self.assertEqual(speaker.device, 'device-2')
        self.assertEqual(Speaker().base, 'http://127.0.0.1:12981')
        for base in ['file:///tmp/x','http://user:pass@host','https://host/?token=x','https://host/#x','http://host/path']:
            with self.assertRaises(ValueError):
                Speaker(base=base)

    def test_gpu_command_prepares_matching_pcma_without_playback(self):
        with tempfile.TemporaryDirectory() as d:
            script = Path(d)/'synth.py'
            script.write_text("import sys,json,base64\nn=json.load(sys.stdin)['name']\nprint(json.dumps({'voice_text':n+'打卡成功','voice_pcma_base64':base64.b64encode(b'\\xd5'*8000).decode()}))",encoding='utf-8')
            config = {'voice_prepare_command':[sys.executable,str(script)]}
            self.assertEqual(prepare_voice(config,'测试'), b'\xd5'*8000)
            with self.assertRaises(ValueError):
                prepare_voice(config,'; invalid / name')

    def test_legacy_audio_and_gpu_command_failures(self):
        audio = base64.b64encode(b'\xd5'*8000).decode()
        self.assertEqual(prepare_voice({},'测试',{'voice_text':'测试打卡成功','voice_pcma_base64':audio}),b'\xd5'*8000)
        for request in [{'voice_text':'错误','voice_pcma_base64':audio},{'voice_text':'测试打卡成功','voice_pcma_base64':'bad!'}]:
            with self.assertRaises(ValueError):prepare_voice({},'测试',request)
        with self.assertRaises(RuntimeError):prepare_voice({},'测试')
        with tempfile.TemporaryDirectory() as d:
            script=Path(d)/'bad.py';script.write_text('import time;time.sleep(2)',encoding='utf-8')
            with self.assertRaises(RuntimeError):prepare_voice({'voice_prepare_command':[sys.executable,str(script)],'voice_prepare_timeout':.05},'测试')
            script.write_text("print('x'*300000)",encoding='utf-8')
            with self.assertRaises(RuntimeError):prepare_voice({'voice_prepare_command':[sys.executable,str(script)]},'测试')


if __name__ == '__main__':unittest.main()
