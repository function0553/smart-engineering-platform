package plugin_gb28181pro

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
	"github.com/google/uuid"
	"github.com/pion/rtp"
)

type BroadcastSession struct {
	Device         *Device
	Channel        *Channel
	gb             *GB28181Plugin
	RTPPort        int
	RTPPeerIP      string
	RTPPeerPort    int
	SSRC           string
	CallID         string
	PayloadType    uint8
	TranscodePCMA  bool
	inviteCh       chan struct{}
	audioChan      chan []byte
	ready          bool
	isTCP          bool
	rtpConn        *net.UDPConn
	tcpListener    net.Listener
	tcpConn        net.Conn
	sequenceNumber uint16
	timestamp      uint32

	mu                                                                sync.Mutex
	stopOnce                                                          sync.Once
	done                                                              chan struct{}
	senderDoneCh                                                      chan struct{}
	sessionID                                                         string
	identity                                                          ownedDialogIdentity
	dialog                                                            *sipgo.DialogServerSession
	inviteTx                                                          sip.ServerTransaction
	wsOwner                                                           *TalkWebsocketTask
	stopped, cleanupComplete, senderStarted, senderDone, tcpConnected bool
	inviteReceived, ackCompat, byeAttempted, byeConfirmed, remoteBye  bool
	packetsSent, payloadBytesSent                                     uint64
	inFlight                                                          int
	failureReason, cleanupReason                                      string
}

var ownedBroadcastStart sync.Mutex

func (d *Device) StartBroadcast(channelID string) (*BroadcastSession, error) {
	ownedBroadcastStart.Lock()
	defer ownedBroadcastStart.Unlock()
	var channel *Channel
	d.channels.Range(func(c *Channel) bool {
		if c.ChannelId == channelID {
			channel = c
			return false
		}
		return true
	})
	if channel == nil {
		return nil, fmt.Errorf("channel not found")
	}
	if prior, ok := BroadcastSessions.Get(channelID); ok {
		prior.mu.Lock()
		released := prior.stopped && prior.cleanupComplete && (prior.payloadBytesSent == 0 || prior.byeConfirmed || prior.remoteBye)
		prior.mu.Unlock()
		if !released {
			return nil, fmt.Errorf("prior broadcast not safely released")
		}
	}
	bs := &BroadcastSession{Device: d, Channel: channel, gb: d.plugin, inviteCh: make(chan struct{}), audioChan: make(chan []byte, 100), done: make(chan struct{}), senderDoneCh: make(chan struct{}), sessionID: uuid.NewString()}
	bs.SSRC = bs.generateSSRC()
	BroadcastSessions.Set(bs)
	source := d.plugin.Serial
	if source == "" {
		source = d.DeviceId
	}
	if err := d.SendBroadcast(source, channelID); err != nil {
		bs.fail("broadcast_message_failed")
		_ = bs.StopBroadcast()
		return nil, err
	}
	go func() {
		select {
		case <-time.After(40 * time.Second):
			bs.fail("session_deadline")
			_ = bs.StopBroadcast()
		case <-bs.done:
		}
	}()
	return bs, nil
}

func (bs *BroadcastSession) fail(reason string) {
	bs.mu.Lock()
	if bs.failureReason == "" {
		bs.failureReason = reason
	}
	bs.mu.Unlock()
}

func (bs *BroadcastSession) WaitInvite(ctx context.Context) error {
	select {
	case <-bs.inviteCh:
		return nil
	case <-bs.done:
		return fmt.Errorf("broadcast ended")
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (bs *BroadcastSession) notifyInvite() {
	bs.mu.Lock()
	defer bs.mu.Unlock()
	if !bs.inviteReceived {
		bs.inviteReceived = true
		close(bs.inviteCh)
	}
}

func (bs *BroadcastSession) status() map[string]any {
	bs.mu.Lock()
	defer bs.mu.Unlock()
	transport := "UDP"
	if bs.isTCP {
		transport = "TCP"
	}
	return map[string]any{"sessionId": bs.sessionID, "deviceId": bs.Device.DeviceId, "channelId": bs.Channel.ChannelId, "transport": transport, "payloadType": bs.PayloadType, "transcodePCMA": bs.TranscodePCMA, "inviteReceived": bs.inviteReceived, "ackReady": bs.ready, "ackFirmwareCompatibility": bs.ackCompat, "tcpConnected": bs.tcpConnected, "wsBound": bs.wsOwner != nil, "senderStarted": bs.senderStarted, "senderDone": bs.senderDone, "stopped": bs.stopped, "localCleanupComplete": bs.cleanupComplete, "byeAttempted": bs.byeAttempted, "byeConfirmed": bs.byeConfirmed, "remoteBye": bs.remoteBye, "packetsSent": bs.packetsSent, "payloadBytesSent": bs.payloadBytesSent, "queuePackets": len(bs.audioChan) + bs.inFlight, "failureReason": bs.failureReason, "cleanupReason": bs.cleanupReason, "playbackVerified": false}
}

func (gb *GB28181Plugin) API_broadcast_status(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil || net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback() {
		w.WriteHeader(403)
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 403})
		return
	}
	bs, ok := BroadcastSessions.Get(r.URL.Query().Get("channelId"))
	if !ok || bs.Device.DeviceId != r.URL.Query().Get("deviceId") {
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 404})
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": bs.status()})
}

func (gb *GB28181Plugin) OnBroadcastInvite(req *sip.Request, tx sip.ServerTransaction) {
	reject := func(code int, reason string) { _ = tx.Respond(sip.NewResponseFromRequest(req, code, reason, nil)) }
	if req.From() == nil || req.To() == nil || req.CallID() == nil || req.CSeq() == nil || req.Contact() == nil {
		reject(400, "Missing Dialog Headers")
		return
	}
	remote := req.From().Address.User
	bs, ok := BroadcastSessions.Find(func(b *BroadcastSession) bool {
		return b.Device != nil && b.Device.Online && (b.Device.DeviceId == remote || b.Channel.ChannelId == remote) && req.Source() == b.Device.HostAddress
	})
	if !ok {
		reject(404, "Active Device Session Not Found")
		return
	}
	bs.mu.Lock()
	if bs.stopped || bs.inviteReceived || bs.dialog != nil {
		bs.mu.Unlock()
		reject(409, "Session Already Invited")
		return
	}
	body := string(req.Body())
	var audio []string
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "m=audio ") {
			audio = strings.Fields(line)
		}
	}
	if len(audio) < 4 {
		bs.mu.Unlock()
		reject(488, "Audio Offer Required")
		return
	}
	tcp := audio[2] == "TCP/RTP/AVP" || audio[2] == "RTP/AVP/TCP"
	if (!tcp && audio[2] != "RTP/AVP") || (tcp && !strings.Contains(body, "a=setup:active")) {
		bs.mu.Unlock()
		reject(488, "Unsupported Audio Transport")
		return
	}
	payload := -1
	for _, f := range audio[3:] {
		if f == "8" {
			payload = 8
			break
		}
		if f == "0" {
			payload = 0
		}
	}
	if payload < 0 {
		bs.mu.Unlock()
		reject(488, "PCMA Or PCMU Required")
		return
	}
	port, err := strconv.Atoi(audio[1])
	if err != nil || port < 1 || port > 65535 {
		bs.mu.Unlock()
		reject(488, "Invalid Audio Port")
		return
	}
	var mediaIP string
	for _, line := range strings.Split(body, "\n") {
		f := strings.Fields(line)
		if len(f) == 3 && f[0] == "c=IN" && f[1] == "IP4" {
			mediaIP = f[2]
		}
	}
	if net.ParseIP(mediaIP) == nil {
		bs.mu.Unlock()
		reject(488, "Invalid Media Address")
		return
	}
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "y=") {
			if n, e := strconv.ParseUint(line[2:], 10, 32); e == nil {
				bs.SSRC = fmt.Sprintf("%010d", n)
			}
		}
	}
	bs.PayloadType = uint8(payload)
	bs.TranscodePCMA = payload == 0
	bs.isTCP = tcp
	bs.RTPPeerIP = mediaIP
	bs.RTPPeerPort = port
	if tcp {
		err = bs.prepareTCPListener()
	} else {
		err = bs.prepareRTPConn()
	}
	if err != nil {
		bs.mu.Unlock()
		bs.fail("audio_listener_failed")
		reject(503, "Audio Listener Failed")
		_ = bs.StopBroadcast()
		return
	}
	ip := gb.MediaIP
	if ip == "" {
		ip = gb.SipIP
	}
	if ip == "" {
		ip = bs.Device.SipIp
	}
	sipPort := bs.Device.LocalPort
	if sipPort == 0 {
		sipPort = gb.defaultSipPort
	}
	contact := sip.ContactHeader{Address: sip.Uri{User: gb.Serial, Host: ip, Port: sipPort}}
	ua := sipgo.DialogUA{Client: bs.Device.client, ContactHDR: contact, RewriteContact: true}
	dialog, err := ua.ReadInvite(req, tx)
	if err != nil {
		bs.mu.Unlock()
		bs.fail("dialog_create_failed")
		reject(400, "Dialog Failed")
		_ = bs.StopBroadcast()
		return
	}
	bs.dialog = dialog
	bs.inviteTx = tx
	bs.CallID = req.CallID().Value()
	bs.identity = ownedDialogIdentity{Device: bs.Device.DeviceId, RemoteUser: remote, LocalUser: gb.Serial, CallID: bs.CallID, Peer: req.Source(), Sequence: req.CSeq().SeqNo, ClientTag: req.From().Params["tag"], ServerTag: req.To().Params["tag"]}
	mediaPort := bs.RTPPort
	bs.senderStarted = true
	bs.mu.Unlock()
	bs.notifyInvite()
	go bs.startAudioSender()
	go func() {
		select {
		case <-time.After(10 * time.Second):
			bs.mu.Lock()
			ready := bs.ready
			bs.mu.Unlock()
			if !ready {
				bs.fail("actual_ack_timeout")
				_ = bs.StopBroadcast()
			}
		case <-bs.done:
		}
	}()
	protocol, codec := "RTP/AVP", "PCMA"
	if tcp {
		protocol = "TCP/RTP/AVP"
	}
	if payload == 0 {
		codec = "PCMU"
	}
	sdp := []string{"v=0", fmt.Sprintf("o=%s 0 0 IN IP4 %s", gb.Serial, ip), "s=Play", fmt.Sprintf("c=IN IP4 %s", ip), "t=0 0", fmt.Sprintf("m=audio %d %s %d", mediaPort, protocol, payload), "a=sendonly"}
	if tcp {
		sdp = append(sdp, "a=setup:passive", "a=connection:new")
	}
	sdp = append(sdp, fmt.Sprintf("a=rtpmap:%d %s/8000", payload, codec), "y="+bs.SSRC)
	if err := dialog.Respond(200, "OK", []byte(strings.Join(sdp, "\r\n")+"\r\n"), sip.NewHeader("Content-Type", "application/sdp")); err != nil {
		bs.mu.Lock()
		ended := bs.stopped
		bs.mu.Unlock()
		if !ended {
			bs.fail("dialog_response_failed")
			_ = bs.StopBroadcast()
		}
	}
}

func requestOwnedIdentity(req *sip.Request) (ownedDialogIdentity, bool) {
	if req.CallID() == nil || req.CSeq() == nil || req.From() == nil || req.To() == nil {
		return ownedDialogIdentity{}, false
	}
	return ownedDialogIdentity{CallID: req.CallID().Value(), Peer: req.Source(), Sequence: req.CSeq().SeqNo, RemoteUser: req.From().Address.User, LocalUser: req.To().Address.User, ClientTag: req.From().Params["tag"], ServerTag: req.To().Params["tag"]}, true
}

func (gb *GB28181Plugin) OnBroadcastAck(req *sip.Request, tx sip.ServerTransaction) {
	got, ok := requestOwnedIdentity(req)
	if !ok || req.Method != sip.ACK || req.CSeq().MethodName != sip.ACK {
		return
	}
	bs, ok := BroadcastSessions.Find(func(b *BroadcastSession) bool {
		b.mu.Lock()
		defer b.mu.Unlock()
		return b.CallID == got.CallID && !b.stopped
	})
	if !ok {
		return
	}
	bs.mu.Lock()
	defer bs.mu.Unlock()
	match, compat := acceptOwnedACK(bs.identity, got)
	if !match || bs.dialog == nil {
		return
	}
	// ReadAck consumes the real matched packet and changes the actual dialog state.
	if err := bs.dialog.ReadAck(req, tx); err != nil {
		return
	}
	bs.ready = true
	bs.ackCompat = compat
}

func (gb *GB28181Plugin) OnBroadcastBye(req *sip.Request, tx sip.ServerTransaction) {
	got, ok := requestOwnedIdentity(req)
	if !ok {
		return
	}
	bs, ok := BroadcastSessions.Find(func(b *BroadcastSession) bool { b.mu.Lock(); defer b.mu.Unlock(); return b.CallID == got.CallID })
	if !ok {
		return
	}
	bs.mu.Lock()
	if got.Sequence < bs.identity.Sequence {
		bs.mu.Unlock()
		return
	}
	originalSequence := got.Sequence
	got.Sequence = bs.identity.Sequence
	match, _ := acceptOwnedACK(bs.identity, got)
	if !match {
		bs.mu.Unlock()
		return
	}
	dialog := bs.dialog
	bs.remoteBye = true
	bs.mu.Unlock()
	if dialog != nil && originalSequence >= got.Sequence {
		_ = dialog.ReadBye(req, tx)
	} else {
		_ = tx.Respond(sip.NewResponseFromRequest(req, 200, "OK", nil))
	}
	go func() { _ = bs.StopBroadcast() }()
}

func (bs *BroadcastSession) startAudioSender() {
	defer func() { bs.mu.Lock(); bs.senderDone = true; bs.mu.Unlock(); close(bs.senderDoneCh) }()
	if bs.isTCP {
		listener := bs.tcpListener.(*net.TCPListener)
		_ = listener.SetDeadline(time.Now().Add(10 * time.Second))
		for {
			conn, err := listener.Accept()
			if err != nil {
				bs.mu.Lock()
				ended := bs.stopped
				bs.mu.Unlock()
				if !ended {
					bs.fail("tcp_accept_failed")
					go func() { _ = bs.StopBroadcast() }()
				}
				return
			}
			host, _, _ := net.SplitHostPort(conn.RemoteAddr().String())
			expected, _, _ := net.SplitHostPort(bs.identity.Peer)
			if host != expected {
				_ = conn.Close()
				continue
			}
			bs.mu.Lock()
			if bs.stopped {
				bs.mu.Unlock()
				_ = conn.Close()
				return
			}
			bs.tcpConn = conn
			bs.tcpConnected = true
			bs.mu.Unlock()
			break
		}
	}
	for {
		select {
		case <-bs.done:
			return
		case data := <-bs.audioChan:
			bs.mu.Lock()
			ready := bs.ready && !bs.stopped
			bs.inFlight++
			bs.mu.Unlock()
			if !ready {
				bs.fail("audio_before_actual_ack")
				return
			}
			err := bs.sendAudioDataInternal(data)
			bs.mu.Lock()
			bs.inFlight--
			bs.mu.Unlock()
			if err != nil {
				bs.fail("rtp_write_failed")
				go func() { _ = bs.StopBroadcast() }()
				return
			}
		}
	}
}

func (bs *BroadcastSession) SendAudioData(data []byte) error {
	if len(data) == 0 || len(data) > 1600 {
		return fmt.Errorf("invalid audio chunk")
	}
	bs.mu.Lock()
	defer bs.mu.Unlock()
	if bs.stopped || !bs.ready || bs.wsOwner == nil || (bs.isTCP && !bs.tcpConnected) {
		return fmt.Errorf("audio not ready")
	}
	select {
	case bs.audioChan <- append([]byte(nil), data...):
		return nil
	default:
		return fmt.Errorf("audio queue full")
	}
}

func ownedWriteFull(conn net.Conn, data []byte) error {
	for len(data) > 0 {
		n, err := conn.Write(data)
		if err != nil {
			return err
		}
		if n <= 0 {
			return io.ErrShortWrite
		}
		data = data[n:]
	}
	return nil
}

func (bs *BroadcastSession) sendAudioDataInternal(data []byte) error {
	ssrc, err := strconv.ParseUint(bs.SSRC, 10, 32)
	if err != nil {
		return err
	}
	peer, err := net.ResolveUDPAddr("udp", net.JoinHostPort(bs.RTPPeerIP, strconv.Itoa(bs.RTPPeerPort)))
	if err != nil {
		return err
	}
	return bs.sendRTPPacket(data, ssrc, peer)
}

func (bs *BroadcastSession) sendRTPPacket(data []byte, ssrc uint64, peer *net.UDPAddr) error {
	payload := data
	if bs.TranscodePCMA {
		payload = make([]byte, len(data))
		for i, b := range data {
			payload[i] = ALawToULawTable[b]
		}
	}
	bs.sequenceNumber++
	packet := rtp.Packet{Header: rtp.Header{Version: 2, PayloadType: bs.PayloadType, SequenceNumber: bs.sequenceNumber, Timestamp: bs.timestamp, SSRC: uint32(ssrc)}, Payload: payload}
	raw, err := packet.Marshal()
	if err != nil {
		return err
	}
	if bs.isTCP {
		bs.mu.Lock()
		conn := bs.tcpConn
		bs.mu.Unlock()
		if conn == nil {
			return fmt.Errorf("no TCP connection")
		}
		_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
		framed := append([]byte{byte(len(raw) >> 8), byte(len(raw))}, raw...)
		if err = ownedWriteFull(conn, framed); err != nil {
			return err
		}
	} else {
		if bs.rtpConn == nil {
			return fmt.Errorf("no UDP socket")
		}
		_ = bs.rtpConn.SetWriteDeadline(time.Now().Add(2 * time.Second))
		if _, err = bs.rtpConn.WriteToUDP(raw, peer); err != nil {
			return err
		}
	}
	bs.timestamp += uint32(len(data))
	bs.mu.Lock()
	bs.packetsSent++
	bs.payloadBytesSent += uint64(len(data))
	bs.mu.Unlock()
	return nil
}

func (bs *BroadcastSession) FlushAudioBuffer() error { return nil }

func (bs *BroadcastSession) StopBroadcast() error {
	bs.stopOnce.Do(func() {
		bs.mu.Lock()
		bs.stopped = true
		close(bs.done)
		listener, conn, udp := bs.tcpListener, bs.tcpConn, bs.rtpConn
		dialog, tx := bs.dialog, bs.inviteTx
		ready, remote, started := bs.ready, bs.remoteBye, bs.senderStarted
		bs.mu.Unlock()
		if listener != nil {
			_ = listener.Close()
		}
		if conn != nil {
			_ = conn.Close()
		}
		if udp != nil {
			_ = udp.Close()
		}
		if started {
			select {
			case <-bs.senderDoneCh:
			case <-time.After(3 * time.Second):
				bs.fail("sender_cleanup_timeout")
			}
		}
		confirmed := remote
		if ready && !remote && dialog != nil {
			bs.mu.Lock()
			bs.byeAttempted = true
			bs.mu.Unlock()
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			err := dialog.Bye(ctx)
			cancel()
			confirmed = err == nil
			if err != nil {
				bs.fail("bye_unconfirmed")
			}
		}
		if tx != nil {
			tx.Terminate()
		}
		if dialog != nil {
			_ = dialog.Close()
		}
		if bs.gb != nil && bs.gb.MediaPort.Valid() && bs.gb.MediaPort.Size() > 0 {
			if listener != nil {
				port := uint16(listener.Addr().(*net.TCPAddr).Port)
				go func() { time.Sleep(30 * time.Second); bs.gb.tcpPB.Release(port) }()
			}
			if udp != nil {
				port := uint16(udp.LocalAddr().(*net.UDPAddr).Port)
				go func() { time.Sleep(30 * time.Second); bs.gb.udpPB.Release(port) }()
			}
		}
		bs.mu.Lock()
		bs.byeConfirmed = confirmed
		bs.wsOwner = nil
		bs.cleanupComplete = !started || bs.senderDone
		bs.cleanupReason = "local_resources_closed"
		bs.mu.Unlock()
	})
	bs.mu.Lock()
	defer bs.mu.Unlock()
	if bs.payloadBytesSent > 0 && !bs.byeConfirmed && !bs.remoteBye {
		return fmt.Errorf("remote delivery uncertain")
	}
	return nil
}
