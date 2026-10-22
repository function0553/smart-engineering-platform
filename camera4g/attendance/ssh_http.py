"""Bridge a Paramiko channel to HTTP without closing its response prematurely."""
import io


class ChannelRaw(io.RawIOBase):
    def __init__(self, channel):
        super().__init__()
        self.channel = channel

    def readable(self):
        return True

    def readinto(self, buffer):
        data = self.channel.recv(len(buffer))
        buffer[:len(data)] = data
        return len(data)


class ChannelSocket:
    def __init__(self, channel):
        self.channel = channel

    def sendall(self, data):
        return self.channel.sendall(data)

    def makefile(self, mode):
        if mode != 'rb':
            raise ValueError('read_only_http_response')
        return io.BufferedReader(ChannelRaw(self.channel))

    def close(self):
        # HTTPConnection.getresponse closes its socket immediately for HTTP/1.0.
        # A native socket's makefile keeps its descriptor alive; Paramiko's does
        # not. The request owner always closes the channel in its finally block.
        pass


def read_bounded_response(response, limit=16*1024*1024):
    length = response.length
    if length is not None and not 0 <= length <= limit:
        raise ValueError('upstream_response_too_large')
    body = response.read() if length is not None else response.read(limit+1)
    if len(body) > limit:
        raise ValueError('upstream_response_too_large')
    return body
