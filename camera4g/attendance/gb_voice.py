"""PCMA8 through the existing patched Monibuca broadcast endpoint.

Protocol reference: Monibuca v5.1.6 plugin/gb28181/{api,talk,broadcast}.go.
The deployed readiness endpoint adds session binding and delivery counters.
"""
import json
import threading
import time
import urllib.request
from urllib.parse import urlsplit

from attendance_store import voice_ready


class Speaker:
    def __init__(self, base='http://127.0.0.1:12981', device='34020000001320000012', channel=None):
        parsed = urlsplit(base)
        if (parsed.scheme not in ('http','https') or not parsed.hostname or parsed.username
                or parsed.password or parsed.path not in ('','/') or parsed.query or parsed.fragment):
            raise ValueError('invalid_voice_base_url')
        parsed.port  # Validate port before starting camera threads.
        base = base.rstrip('/')
        self.base, self.device = base, device
        self.websocket_url = ('wss://' if parsed.scheme == 'https' else 'ws://') + parsed.netloc + '/gb28181/api/talk/start'
        self.channel = channel or device
        self.lock = threading.Lock()
        self.prepare_gate = threading.Lock()
        self._prepared = None
        self.http = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def _check_released(self):
        prior = self.status()
        if prior.get('code') == 0:
            state = prior.get('data', {})
            if not state.get('stopped') or not state.get('localCleanupComplete'):
                raise RuntimeError('previous_session_not_released')
            if state.get('payloadBytesSent', 0) and not (state.get('byeConfirmed') or state.get('remoteBye')):
                raise RuntimeError('previous_remote_delivery_uncertain')
        elif prior.get('code') != 404:
            raise RuntimeError('speaker_status_unavailable')

    def prepare(self):
        """Negotiate silently; audio still requires a confirmed attendance record."""
        if not self.prepare_gate.acquire(blocking=False):
            return False
        def worker():
            try:
                if not self.lock.acquire(blocking=False):
                    return
                requested, session = False, None
                try:
                    if self._prepared is not None:
                        return
                    self._check_released()
                    began = time.monotonic()
                    requested = True
                    response = self.post('start')
                    if response.get('code') != 0:
                        raise RuntimeError('broadcast_start_rejected')
                    state = self.status().get('data', {})
                    session = state.get('sessionId')
                    if not session or not state.get('inviteReceived') or state.get('stopped') or state.get('failureReason'):
                        raise RuntimeError('broadcast_preparation_failed')
                    ticket = {'session': session, 'began': began,
                              'invite_received': (time.monotonic()-began)*1000}
                    self._prepared = ticket
                    timer = threading.Timer(3, self._expire_prepared, (ticket,))
                    timer.daemon = True
                    timer.start()
                except Exception:
                    # Only stop the session created while holding our speaker lock.
                    if requested:
                        try:
                            state = self.status().get('data', {})
                            session = session or state.get('sessionId')
                            if session and state.get('sessionId') == session:
                                self.post('stop')
                        except Exception:
                            pass
                finally:
                    self.lock.release()
            finally:
                self.prepare_gate.release()
        threading.Thread(target=worker, daemon=True).start()
        return True

    def _expire_prepared(self, ticket):
        with self.lock:
            if self._prepared is not ticket:
                return
            self._prepared = None
            try:
                state = self.status().get('data', {})
                if state.get('sessionId') == ticket['session']:
                    self.post('stop')
            except Exception:
                pass  # A later attempt still has to pass _check_released().

    def status(self):
        path = f'/gb28181/api/broadcast/status?deviceId={self.device}&channelId={self.channel}'
        with self.http.open(self.base + path, timeout=5) as response:
            return json.load(response)

    def post(self, action):
        payload = json.dumps({'deviceId': self.device, 'channelId': self.channel}).encode()
        request = urllib.request.Request(self.base + '/gb28181/api/broadcast/' + action,
                                         data=payload, headers={'Content-Type': 'application/json'})
        with self.http.open(request, timeout=12) as response:
            return json.load(response)

    def send(self, audio):
        import websocket

        if not isinstance(audio, bytes) or not 2000 <= len(audio) <= 120000 or audio.startswith(b'RIFF'):
            raise ValueError('pcma8_audio_required')
        began = time.monotonic()
        if not self.lock.acquire(timeout=25):
            return {'status': 'failed_not_sent', 'reason': 'speaker_busy', 'payload_bytes_sent': 0}
        session, started, ws, failure = None, False, None, None
        last, stop_result = {}, {}
        timings = {}
        prepared = False
        try:
            ticket, self._prepared = self._prepared, None
            if ticket is not None:
                session, started, prepared = ticket['session'], True, True
                timings['preparation_lead'] = max(0, (began-ticket['began'])*1000)
                timings['invite_received'] = max(0, ticket['invite_received']-timings['preparation_lead'])
            else:
                self._check_released()
                response = self.post('start')
                timings['invite_received'] = (time.monotonic()-began)*1000
                started = True
                if response.get('code') != 0:
                    raise RuntimeError('broadcast_start_rejected')
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                reply = self.status()
                last = reply.get('data', {})
                session = session or last.get('sessionId')
                if not session or last.get('sessionId') != session:
                    raise RuntimeError('broadcast_session_changed')
                if last.get('stopped') or last.get('failureReason'):
                    raise RuntimeError('broadcast_negotiation_failed')
                if last.get('inviteReceived') and last.get('ackReady') and last.get('tcpConnected') and last.get('transport') == 'TCP':
                    timings['transport_ready'] = (time.monotonic()-began)*1000
                    break
                time.sleep(.1)
            else:
                raise RuntimeError('broadcast_readiness_timeout')
            ws = websocket.create_connection(self.websocket_url,
                                              timeout=5, http_no_proxy=['127.0.0.1', 'localhost'])
            ws.send(json.dumps({'type': 'startBroadcast', 'deviceId': self.device,
                                'channelId': self.channel, 'sessionId': session}))
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                last = self.status().get('data', {})
                if voice_ready(last, session):
                    timings['websocket_bound'] = (time.monotonic()-began)*1000
                    break
                if last.get('sessionId') != session or last.get('stopped') or last.get('failureReason'):
                    raise RuntimeError('audio_binding_failed')
                time.sleep(.1)
            else:
                raise RuntimeError('audio_binding_timeout')
            # A-law 0xd5 is silence. Whole 1200-byte blocks allow the existing
            # sender to drain completely before the BYE request.
            padded = audio + b'\xd5' * ((-len(audio)) % 1200)
            origin = time.monotonic()
            for offset in range(0, len(padded), 160):
                delay = origin + offset / 8000 - time.monotonic()
                if delay > 0:
                    time.sleep(delay)
                ws.send_binary(padded[offset:offset+160])
                if offset == 0:
                    timings['first_audio_submitted'] = (time.monotonic()-began)*1000
            deadline = time.monotonic() + 4
            while time.monotonic() < deadline:
                last = self.status().get('data', {})
                if last.get('sessionId') != session:
                    raise RuntimeError('session_changed_during_audio')
                if last.get('payloadBytesSent', 0) >= len(audio) and last.get('queuePackets') == 0:
                    break
                if last.get('failureReason'):
                    raise RuntimeError('audio_transport_failed')
                time.sleep(.1)
        except Exception as error:
            failure = str(error) if type(error) is RuntimeError else type(error).__name__
        finally:
            if started:
                try:
                    # Check that this is still our session before ending it.
                    state = self.status().get('data', {})
                    if session is None:
                        session = state.get('sessionId')
                    if state.get('sessionId') == session:
                        stop_result = self.post('stop')
                        deadline = time.monotonic() + 5
                        while time.monotonic() < deadline:
                            last = self.status().get('data', {})
                            if last.get('sessionId') != session:
                                break
                            if last.get('localCleanupComplete'):
                                break
                            time.sleep(.1)
                except Exception as error:
                    failure = failure or ('stop_' + type(error).__name__)
            if ws:
                try:
                    ws.close()
                except Exception:
                    pass
            self.lock.release()
        sent = int(last.get('payloadBytesSent', 0)) if last.get('sessionId') == session else 0
        complete = (not failure and sent >= len(audio) and last.get('localCleanupComplete')
                    and (last.get('byeConfirmed') or last.get('remoteBye')))
        timings['total_delivery_and_cleanup'] = (time.monotonic()-began)*1000
        return {'status': 'submitted_unverified' if complete else 'delivery_unknown' if sent else 'failed_not_sent',
                'reason': failure, 'session_id': session, 'payload_bytes_sent': sent,
                'source_bytes': len(audio), 'transport': last.get('transport'),
                'cleanup_complete': last.get('localCleanupComplete', False),
                'bye_confirmed': last.get('byeConfirmed', False),
                'stop_code': stop_result.get('code'), 'playback_verified': False,
                'connection_prepared': prepared,
                'timing_ms': timings}
