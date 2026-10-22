import http.client
import socket
import threading
import unittest

from ssh_http import ChannelSocket, read_bounded_response


class EagerClosingChannel:
    """Paramiko-like lifetime: closing a channel also closes its file readers."""
    def __init__(self, sock):
        self.sock = sock
    def recv(self, count):
        return self.sock.recv(count)
    def sendall(self, data):
        return self.sock.sendall(data)
    def makefile(self, mode):
        return self.sock.makefile(mode, buffering=0)
    def close(self):
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()


class SSHHTTPTest(unittest.TestCase):
    def response(self, payload, declared=None):
        client, server = socket.socketpair()
        client.settimeout(2)
        client = EagerClosingChannel(client)
        def serve():
            try:
                request = b''
                while b'\r\n\r\n' not in request:
                    request += server.recv(4096)
                size = len(payload) if declared is None else declared
                server.sendall(f'HTTP/1.0 200 OK\r\nContent-Length: {size}\r\n\r\n'.encode())
                for position in range(0, len(payload), 7000):
                    server.sendall(payload[position:position+7000])
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                server.close()
        thread = threading.Thread(target=serve)
        thread.start()
        connection = http.client.HTTPConnection('127.0.0.1')
        connection.sock = ChannelSocket(client)
        connection.request('GET', '/')
        return client, connection, connection.getresponse(), thread

    def test_http10_owner_close_preserves_multichunk_body(self):
        payload = b'{"results":"' + b'x'*120000 + b'"}'
        channel, connection, response, worker = self.response(payload)
        try:
            self.assertIsNone(connection.sock)  # HTTP/1.0 closes owner early.
            self.assertEqual(read_bounded_response(response), payload)
        finally:
            connection.close(); channel.close(); worker.join(2)

    def test_truncated_response_is_rejected(self):
        channel, connection, response, worker = self.response(b'partial', 200)
        try:
            with self.assertRaises(http.client.IncompleteRead):
                read_bounded_response(response)
        finally:
            connection.close(); channel.close(); worker.join(2)

    def test_oversized_header_rejected_before_body(self):
        channel, connection, response, worker = self.response(b'', 20000000)
        try:
            with self.assertRaises(ValueError):
                read_bounded_response(response)
        finally:
            response.close(); connection.close(); channel.close(); worker.join(2)


if __name__ == '__main__':
    unittest.main()
