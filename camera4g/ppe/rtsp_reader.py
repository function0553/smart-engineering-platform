"""Read registered RTSP only. Native exceptions/URLs are never logged."""
import threading
import time

from configuration import validate_source_url


class SourceFailure(RuntimeError):
    pass


class RTSPReader:
    def __init__(self, runtime, source_url, opener=None):
        self.runtime = runtime
        self.url = validate_source_url(source_url)
        self.opener = opener
        self.stop_event = threading.Event()
        self.thread = None

    def start(self):
        if self.thread is not None:
            raise RuntimeError('reader_already_started')
        self.thread = threading.Thread(target=self.run, name='ppe-rtsp', daemon=True)
        self.thread.start()

    def run(self):
        import av
        av.logging.set_level(av.logging.PANIC)
        limits = self.runtime.config['limits']
        profile = self.runtime.config['camera']
        opener = self.opener or av.open
        while not self.stop_event.is_set():
            container = None
            epoch = None
            try:
                if not profile['main_source_verified']:
                    raise SourceFailure('main_source_not_verified')
                # Capture and discard native log records; they may contain URLs.
                with av.logging.Capture():
                    container = opener(self.url, mode='r',
                        options={'rtsp_transport': 'tcp', 'fflags': 'nobuffer', 'flags': 'low_delay',
                                 'max_delay': '0', 'protocol_whitelist': 'rtsp,rtsps,tcp,tls,crypto'},
                        timeout=(limits['open_timeout_seconds'], limits['read_timeout_seconds']))
                    videos = container.streams.video
                    if len(videos) != 1:
                        raise SourceFailure('single_video_stream_required')
                    stream = videos[0]
                    stream.codec_context.thread_count = limits['decode_threads']
                    stream.codec_context.thread_type = 'SLICE'
                    epoch = self.runtime.connected()
                    anchor_pts = anchor_received = previous_pts = None
                    pts_unstable = False
                    for frame in container.decode(stream):
                        if self.stop_event.is_set():
                            break
                        now = time.monotonic()
                        if [frame.width, frame.height] != profile['expected_size']:
                            raise SourceFailure('source_size_mismatch')
                        if frame.width*frame.height > limits['max_pixels']:
                            raise SourceFailure('source_pixel_limit')
                        pts = float(frame.pts*frame.time_base) if frame.pts is not None and frame.time_base is not None else None
                        source_lag = None
                        if limits['source_pts_policy'] == 'strict':
                            if pts is None:
                                raise SourceFailure('source_pts_missing')
                            if previous_pts is not None and pts <= previous_pts:
                                raise SourceFailure('source_pts_discontinuity')
                            if anchor_pts is None:
                                anchor_pts, anchor_received = pts, now
                            source_lag = now-anchor_received-(pts-anchor_pts)
                            if abs(source_lag) > limits['max_source_backlog_seconds']:
                                raise SourceFailure('source_timeline_backlog')
                            previous_pts = pts
                            pts_status = 'strict_monotonic_relative'
                        else:
                            if pts is None or (previous_pts is not None and pts <= previous_pts):
                                pts_unstable = True
                            if pts is not None:
                                previous_pts = pts
                            pts_status = 'unstable' if pts_unstable else 'observed_unverified'
                            # Observe-only timestamps never justify a lag/reconnect
                            # decision or exposure-based temporal confirmation.
                        self.runtime.decoded(epoch, now, pts, pts_status)
                        # Decoder arrivals may be bursts. Keep every valid decoded
                        # frame eligible to replace the single latest pending slot;
                        # only the inference worker applies the start-to-start cap.
                        # A reader time gate would keep the first frame of a burst
                        # and discard its newer frames. There is still no FIFO.
                        image = frame.to_ndarray(format='bgr24')
                        self.runtime.accept_frame(epoch, image, now, pts, source_lag, pts_status)
                    if not self.stop_event.is_set():
                        raise SourceFailure('source_ended')
            except SourceFailure as error:
                self.runtime.disconnected(epoch, str(error))
            except Exception:
                self.runtime.disconnected(epoch, 'rtsp_read_failed')
            finally:
                if container is not None:
                    try:
                        container.close()
                    except Exception:
                        pass
            self.stop_event.wait(limits['reconnect_seconds'])
        self.runtime.disconnected(epoch, 'source_stopped')

    def stop(self):
        self.stop_event.set()
        if self.thread is not None:
            self.thread.join(self.runtime.config['limits']['read_timeout_seconds']+1)
        return self.thread is None or not self.thread.is_alive()
