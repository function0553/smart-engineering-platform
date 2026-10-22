package plugin_gb28181pro

import (
	"bytes"
	"encoding/binary"
	"github.com/pion/rtp"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

type ownedPartialWriter struct{ net.Conn }

func (w ownedPartialWriter) Write(p []byte) (int, error) {
	if len(p) > 7 {
		p = p[:7]
	}
	return w.Conn.Write(p)
}

func TestOwnedPCMUOverFramedTCP(t *testing.T) {
	sender, receiver := net.Pipe()
	defer sender.Close()
	defer receiver.Close()
	_ = receiver.SetReadDeadline(time.Now().Add(3 * time.Second))
	bs := &BroadcastSession{isTCP: true, TranscodePCMA: true, PayloadType: 0, tcpConn: ownedPartialWriter{sender}}
	done := make(chan error, 1)
	go func() { done <- bs.sendRTPPacket([]byte{0xd5, 0x55, 0x00, 0x80}, 12345, nil) }()
	prefix := make([]byte, 2)
	if _, err := io.ReadFull(receiver, prefix); err != nil {
		t.Fatal(err)
	}
	packet := make([]byte, binary.BigEndian.Uint16(prefix))
	if _, err := io.ReadFull(receiver, packet); err != nil {
		t.Fatal(err)
	}
	var decoded rtp.Packet
	if err := decoded.Unmarshal(packet); err != nil {
		t.Fatal(err)
	}
	if decoded.PayloadType != 0 || decoded.SequenceNumber != 1 || decoded.Timestamp != 0 || decoded.SSRC != 12345 || !bytes.Equal(decoded.Payload, []byte{0xff, 0x7f, 0x2a, 0xaa}) {
		t.Fatalf("invalid PCMU RTP: %+v", decoded)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if bs.packetsSent != 1 || bs.payloadBytesSent != 4 || bs.timestamp != 4 {
		t.Fatal("transport completion counters inconsistent")
	}
}

func TestOwnedStopWhileAudioEnqueues(t *testing.T) {
	bs := &BroadcastSession{ready: true, wsOwner: &TalkWebsocketTask{}, done: make(chan struct{}), audioChan: make(chan []byte, 2)}
	var workers sync.WaitGroup
	for i := 0; i < 30; i++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for j := 0; j < 30; j++ {
				_ = bs.SendAudioData([]byte{0xd5})
			}
			_ = bs.StopBroadcast()
		}()
	}
	workers.Wait()
	if !bs.stopped || !bs.cleanupComplete {
		t.Fatal("stop did not release local resources")
	}
	if err := bs.SendAudioData([]byte{0xd5}); err == nil {
		t.Fatal("accepted audio after stop")
	}
}
