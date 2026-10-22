import json
import threading
import time
import types
import unittest
from unittest.mock import patch

from gb_voice import Speaker


class FakeTransport(Speaker):
    def __init__(self):
        super().__init__()
        self.starts = self.stops = self.payload = self.ws_connections = 0
        self.active = None

    def status(self):
        return {'code': 404} if self.active is None else {'code': 0, 'data': dict(self.active)}

    def post(self, action):
        if action == 'start':
            self.starts += 1
            self.active = dict(sessionId=f'session-{self.starts}',inviteReceived=True,
                ackReady=True,tcpConnected=True,transport='TCP',wsBound=False,
                senderStarted=True,senderDone=False,stopped=False,failureReason='',
                payloadBytesSent=0,queuePackets=0,localCleanupComplete=False)
        else:
            self.stops += 1
            self.active.update(stopped=True,localCleanupComplete=True,byeConfirmed=True)
        return {'code': 0}

    def socket(self, *args, **kwargs):
        self.ws_connections += 1
        owner = self
        class Socket:
            def send(self, text):
                request = json.loads(text)
                if request['sessionId'] != owner.active['sessionId']:
                    raise RuntimeError('wrong_session')
                owner.active['wsBound'] = True
            def send_binary(self, audio):
                owner.payload += len(audio)
                owner.active['payloadBytesSent'] += len(audio)
            def close(self):
                pass
        return Socket()


class VoicePreparationTests(unittest.TestCase):
    def prepared(self):
        speaker = FakeTransport()
        speaker.prepare()
        deadline = time.monotonic()+1
        while speaker.starts == 0 or speaker._prepared is None:
            if time.monotonic() > deadline:
                self.fail('preparation did not finish')
            time.sleep(.005)
        return speaker

    def test_preparation_never_sends_audio_and_confirmed_send_reuses_session(self):
        speaker = self.prepared()
        self.assertEqual(speaker.payload, 0)
        self.assertEqual(speaker.ws_connections, 0)
        fake = types.SimpleNamespace(create_connection=speaker.socket)
        with patch.dict('sys.modules', {'websocket': fake}):
            result = speaker.send(b'\xd5'*2000)
        self.assertEqual(speaker.starts, 1)
        self.assertEqual(speaker.stops, 1)
        self.assertEqual(result['status'], 'submitted_unverified')
        self.assertTrue(result['connection_prepared'])
        self.assertEqual(speaker.payload, 2400)

    def test_unconfirmed_preparation_expires_without_audio_and_without_stopping_new_session(self):
        speaker = self.prepared()
        ticket = speaker._prepared
        speaker._expire_prepared(ticket)
        self.assertEqual(speaker.stops, 1)
        self.assertEqual(speaker.payload, 0)
        self.assertIsNone(speaker._prepared)
        speaker.prepare()
        deadline = time.monotonic()+1
        while speaker._prepared is None and time.monotonic()<deadline:
            time.sleep(.005)
        self.assertEqual(speaker.starts, 2)
        speaker._expire_prepared(ticket)
        self.assertEqual(speaker.stops, 1)
        speaker._expire_prepared(speaker._prepared)

    def test_changed_session_never_receives_audio_or_stop(self):
        speaker = self.prepared()
        speaker.active['sessionId'] = 'unrelated-session'
        fake = types.SimpleNamespace(create_connection=speaker.socket)
        with patch.dict('sys.modules', {'websocket': fake}):
            result = speaker.send(b'\xd5'*2000)
        self.assertEqual(result['status'], 'failed_not_sent')
        self.assertEqual(speaker.payload, 0)
        self.assertEqual(speaker.stops, 0)

    def test_confirmed_send_waits_for_preparation_in_progress_without_duplicate_start(self):
        speaker = FakeTransport()
        entered, release = threading.Event(), threading.Event()
        original = speaker.post
        def slow_post(action):
            if action == 'start':
                entered.set()
                release.wait(1)
            return original(action)
        speaker.post = slow_post
        speaker.prepare()
        self.assertTrue(entered.wait(1))
        result = []
        fake = types.SimpleNamespace(create_connection=speaker.socket)
        with patch.dict('sys.modules', {'websocket': fake}):
            worker = threading.Thread(target=lambda: result.append(speaker.send(b'\xd5'*2000)))
            worker.start()
            time.sleep(.02)
            self.assertEqual(speaker.payload, 0)
            release.set()
            worker.join(2)
        self.assertEqual(speaker.starts, 1)
        self.assertTrue(result[0]['connection_prepared'])


if __name__ == '__main__':
    unittest.main()
