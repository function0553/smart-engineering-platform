package plugin_gb28181pro

import (
	"encoding/json"
	"fmt"
	"github.com/gobwas/ws"
	"github.com/gobwas/ws/wsutil"
	task "github.com/langhuihui/gotask"
	"net"
	"sync"
)

type TalkWebsocketTask struct {
	task.Task
	conn      net.Conn
	plugin    *GB28181Plugin
	mutex     sync.Mutex
	broadcast *BroadcastSession
}

func NewTalkWebsocketTask(plugin *GB28181Plugin, conn net.Conn) *TalkWebsocketTask {
	return &TalkWebsocketTask{conn: conn, plugin: plugin}
}
func (t *TalkWebsocketTask) GetKey() uint32 { return t.Task.ID }
func (t *TalkWebsocketTask) Go() error {
	for {
		msg, op, err := wsutil.ReadClientData(t.conn)
		if err != nil {
			return err
		}
		switch op {
		case ws.OpText:
			if err = t.handleCommand(msg); err != nil {
				return err
			}
		case ws.OpBinary:
			if err = t.sendAudio(msg); err != nil {
				return err
			}
		}
	}
}
func (t *TalkWebsocketTask) handleCommand(msg []byte) error {
	var c struct {
		Type    string `json:"type"`
		Device  string `json:"deviceId"`
		Channel string `json:"channelId"`
		Session string `json:"sessionId"`
	}
	if err := json.Unmarshal(msg, &c); err != nil {
		return err
	}
	if c.Type == "stopBroadcast" {
		t.mutex.Lock()
		bs := t.broadcast
		t.broadcast = nil
		t.mutex.Unlock()
		if bs != nil {
			return bs.StopBroadcast()
		}
		return nil
	}
	if c.Type != "startBroadcast" {
		return fmt.Errorf("unsupported voice command")
	}
	t.mutex.Lock()
	defer t.mutex.Unlock()
	if t.broadcast != nil {
		return fmt.Errorf("socket already bound")
	}
	bs, ok := BroadcastSessions.Get(c.Channel)
	if !ok {
		return fmt.Errorf("no broadcast")
	}
	bs.mu.Lock()
	defer bs.mu.Unlock()
	if c.Session == "" || c.Session != bs.sessionID || c.Device != bs.Device.DeviceId || bs.stopped || !bs.ready || !bs.inviteReceived || bs.wsOwner != nil || (bs.isTCP && !bs.tcpConnected) {
		return fmt.Errorf("live ready session required")
	}
	t.broadcast = bs
	bs.wsOwner = t
	return nil
}
func (t *TalkWebsocketTask) sendAudio(data []byte) error {
	t.mutex.Lock()
	bs := t.broadcast
	t.mutex.Unlock()
	if bs == nil {
		return fmt.Errorf("unbound audio")
	}
	return bs.SendAudioData(data)
}
func (t *TalkWebsocketTask) Dispose() {
	t.mutex.Lock()
	bs := t.broadcast
	t.broadcast = nil
	t.mutex.Unlock()
	if bs != nil {
		_ = bs.StopBroadcast()
	}
	if t.conn != nil {
		_ = t.conn.Close()
	}
}
