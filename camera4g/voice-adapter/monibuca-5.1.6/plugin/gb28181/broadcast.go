package plugin_gb28181pro

import (
	"fmt"
	"github.com/emiago/sipgo/sip"
	"m7s.live/v5/pkg/util"
	"net"
)

const (
	MinRTPPayloadSize    = 160
	DefaultRTPPayloadMax = 1200
	RTPHeaderOverhead    = 40
)

var MaxRTPPayloadSize = DefaultRTPPayloadMax
var BroadcastSessions util.Collection[string, *BroadcastSession]

func (bs *BroadcastSession) GetKey() string {
	if bs.Channel != nil {
		return bs.Channel.ChannelId
	}
	return ""
}

// DetectMTU 检测网络接口的 MTU 并计算合适的 RTP 负载大小

func DetectMTU(ipAddress string) int {
	interfaces, err := net.Interfaces()
	if err != nil {
		return DefaultRTPPayloadMax
	}

	minMTU := 1500
	foundSpecific := false

	for _, iface := range interfaces {
		if iface.Flags&net.FlagLoopback != 0 || iface.Flags&net.FlagUp == 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil || len(addrs) == 0 {
			continue
		}

		if ipAddress != "" {
			for _, addr := range addrs {
				var ip net.IP
				switch v := addr.(type) {
				case *net.IPNet:
					ip = v.IP
				case *net.IPAddr:
					ip = v.IP
				}
				if ip != nil && ip.String() == ipAddress {
					foundSpecific = true
					minMTU = iface.MTU
					break
				}
			}
			if foundSpecific {
				break
			}
		} else {
			if iface.MTU > 0 && iface.MTU < minMTU {
				minMTU = iface.MTU
			}
		}
	}

	if ipAddress != "" && !foundSpecific {
		return DetectMTU("")
	}

	payloadSize := minMTU - RTPHeaderOverhead
	if payloadSize < MinRTPPayloadSize {
		payloadSize = MinRTPPayloadSize
	}
	if payloadSize > 1400 {
		payloadSize = 1400
	}
	return payloadSize
}

// InitRTPPayloadSize 初始化 RTP 负载大小

func InitRTPPayloadSize() {
	MaxRTPPayloadSize = DetectMTU("")
}

// StartBroadcast 启动广播会话

func (bs *BroadcastSession) generateSSRC() string {
	return fmt.Sprintf("%010d", bs.Device.CreateSSRC(bs.Device.plugin.Serial))
}

// prepareRTPConn 准备 RTP 连接

func (bs *BroadcastSession) prepareRTPConn() error {
	// 从端口位图分配端口
	var port uint16
	var ok bool
	if bs.Device.plugin.MediaPort.Valid() && bs.Device.plugin.MediaPort.Size() > 0 {
		port, ok = bs.Device.plugin.udpPB.Allocate()
		if !ok {
			return fmt.Errorf("no available port")
		}
	} else {
		// 单端口模式
		port = bs.Device.plugin.udpPort
	}

	localAddr, err := net.ResolveUDPAddr("udp", fmt.Sprintf(":%d", port))
	if err != nil {
		if bs.Device.plugin.MediaPort.Valid() && bs.Device.plugin.MediaPort.Size() > 0 {
			bs.Device.plugin.udpPB.Release(port)
		}
		return err
	}

	conn, err := net.ListenUDP("udp", localAddr)
	if err != nil {
		if bs.Device.plugin.MediaPort.Valid() && bs.Device.plugin.MediaPort.Size() > 0 {
			bs.Device.plugin.udpPB.Release(port)
		}
		return err
	}

	bs.rtpConn = conn
	bs.RTPPort = int(port)
	return nil
}

// prepareTCPListener 准备 TCP 监听器（用于 TCP/RTP）

func (bs *BroadcastSession) prepareTCPListener() error {
	// 从端口位图分配端口
	var port uint16
	var ok bool
	if bs.Device.plugin.MediaPort.Valid() && bs.Device.plugin.MediaPort.Size() > 0 {
		port, ok = bs.Device.plugin.tcpPB.Allocate()
		if !ok {
			return fmt.Errorf("no available tcp port")
		}
	} else {
		// 单端口模式
		port = bs.Device.plugin.tcpPort
	}

	addr := fmt.Sprintf(":%d", port)
	listener, err := net.Listen("tcp4", addr)
	if err != nil {
		if bs.Device.plugin.MediaPort.Valid() && bs.Device.plugin.MediaPort.Size() > 0 {
			bs.Device.plugin.tcpPB.Release(port)
		}
		return fmt.Errorf("listen failed: %v", err)
	}

	bs.tcpListener = listener
	bs.RTPPort = int(port)
	bs.gb.Info("prepareTCPListener: TCP listener created", "port", port)
	return nil
}

// WaitInvite 等待设备 INVITE

func (d *Device) SendBroadcast(sourceId, targetId string) error {
	recipient := d.Recipient
	recipient.User = targetId

	request := d.CreateRequest(sip.MESSAGE, recipient)

	xmlContent := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<Notify>
<CmdType>Broadcast</CmdType>
<SN>%d</SN>
<SourceID>%s</SourceID>
<TargetID>%s</TargetID>
</Notify>`, d.SN, sourceId, targetId)

	request.SetBody([]byte(xmlContent))

	response, err := d.send(request)
	if err != nil {
		return fmt.Errorf("send broadcast notification failed: %v", err)
	}

	if response.StatusCode != 200 {
		return fmt.Errorf("broadcast notification failed with status: %d", response.StatusCode)
	}

	return nil
}

// OnBroadcastInvite 处理广播 INVITE

var ALawToULawTable = [256]uint8{
	0x2a, 0x2b, 0x28, 0x29, 0x2e, 0x2f, 0x2c, 0x2d,
	0x22, 0x23, 0x20, 0x21, 0x26, 0x27, 0x24, 0x25,
	0x3a, 0x3b, 0x38, 0x39, 0x3e, 0x3f, 0x3c, 0x3d,
	0x32, 0x33, 0x30, 0x31, 0x36, 0x37, 0x34, 0x35,
	0x0a, 0x0b, 0x08, 0x09, 0x0e, 0x0f, 0x0c, 0x0d,
	0x02, 0x03, 0x00, 0x01, 0x06, 0x07, 0x04, 0x05,
	0x1a, 0x1b, 0x18, 0x19, 0x1e, 0x1f, 0x1c, 0x1d,
	0x12, 0x13, 0x10, 0x11, 0x16, 0x17, 0x14, 0x15,
	0x6a, 0x6b, 0x68, 0x69, 0x6e, 0x6f, 0x6c, 0x6d,
	0x62, 0x63, 0x60, 0x61, 0x66, 0x67, 0x64, 0x65,
	0x7a, 0x7b, 0x78, 0x79, 0x7e, 0x7f, 0x7c, 0x7d,
	0x72, 0x73, 0x70, 0x71, 0x76, 0x77, 0x74, 0x75,
	0x4a, 0x4b, 0x48, 0x49, 0x4e, 0x4f, 0x4c, 0x4d,
	0x42, 0x43, 0x40, 0x41, 0x46, 0x47, 0x44, 0x45,
	0x5a, 0x5b, 0x58, 0x59, 0x5e, 0x5f, 0x5c, 0x5d,
	0x52, 0x53, 0x50, 0x51, 0x56, 0x57, 0x54, 0x55,
	0xaa, 0xab, 0xa8, 0xa9, 0xae, 0xaf, 0xac, 0xad,
	0xa2, 0xa3, 0xa0, 0xa1, 0xa6, 0xa7, 0xa4, 0xa5,
	0xba, 0xbb, 0xb8, 0xb9, 0xbe, 0xbf, 0xbc, 0xbd,
	0xb2, 0xb3, 0xb0, 0xb1, 0xb6, 0xb7, 0xb4, 0xb5,
	0x8a, 0x8b, 0x88, 0x89, 0x8e, 0x8f, 0x8c, 0x8d,
	0x82, 0x83, 0x80, 0x81, 0x86, 0x87, 0x84, 0x85,
	0x9a, 0x9b, 0x98, 0x99, 0x9e, 0x9f, 0x9c, 0x9d,
	0x92, 0x93, 0x90, 0x91, 0x96, 0x97, 0x94, 0x95,
	0xea, 0xeb, 0xe8, 0xe9, 0xee, 0xef, 0xec, 0xed,
	0xe2, 0xe3, 0xe0, 0xe1, 0xe6, 0xe7, 0xe4, 0xe5,
	0xfa, 0xfb, 0xf8, 0xf9, 0xfe, 0xff, 0xfc, 0xfd,
	0xf2, 0xf3, 0xf0, 0xf1, 0xf6, 0xf7, 0xf4, 0xf5,
	0xca, 0xcb, 0xc8, 0xc9, 0xce, 0xcf, 0xcc, 0xcd,
	0xc2, 0xc3, 0xc0, 0xc1, 0xc6, 0xc7, 0xc4, 0xc5,
	0xda, 0xdb, 0xd8, 0xd9, 0xde, 0xdf, 0xdc, 0xdd,
	0xd2, 0xd3, 0xd0, 0xd1, 0xd6, 0xd7, 0xd4, 0xd5,
}
