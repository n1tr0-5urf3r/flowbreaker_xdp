// Package flow contains the user-space view of flow keys and the
// protected-port policy shared by the kernel program and the daemon.
package flow

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"net/netip"

	"flowbreaker/internal/bpfobj"
)

// Key mirrors struct flow_key in bpf/shooter.bpf.c.
type Key = bpfobj.ShooterFlowKey

const (
	ProtoICMP   = 1
	ProtoTCP    = 6
	ProtoUDP    = 17
	ProtoICMPv6 = 58
)

// ID returns a short, stable identifier for a flow key. The browser only ever
// sees IDs, so it cannot ask the daemon to block arbitrary keys.
func ID(k Key) string {
	h := sha1.New()
	h.Write(k.Saddr[:])
	h.Write(k.Daddr[:])
	h.Write([]byte{byte(k.Sport >> 8), byte(k.Sport), byte(k.Dport >> 8), byte(k.Dport), k.Proto, k.Family})
	return hex.EncodeToString(h.Sum(nil)[:6])
}

func addr(b [16]byte, family uint8) netip.Addr {
	a := netip.AddrFrom16(b)
	if family == 4 {
		return a.Unmap()
	}
	return a
}

// Src returns the source address of the flow.
func Src(k Key) netip.Addr { return addr(k.Saddr, k.Family) }

// Dst returns the destination address of the flow.
func Dst(k Key) netip.Addr { return addr(k.Daddr, k.Family) }

// ProtoName returns a short protocol name.
func ProtoName(p uint8) string {
	switch p {
	case ProtoICMP:
		return "icmp"
	case ProtoTCP:
		return "tcp"
	case ProtoUDP:
		return "udp"
	case ProtoICMPv6:
		return "icmpv6"
	}
	return fmt.Sprintf("ip%d", p)
}

func hostPort(a netip.Addr, port uint16) string {
	if a.Is6() {
		return fmt.Sprintf("[%s]:%d", a, port)
	}
	return fmt.Sprintf("%s:%d", a, port)
}

// Label renders a flow as "tcp 1.2.3.4:443 → 10.0.0.2:51234".
func Label(k Key) string {
	p := ProtoName(k.Proto)
	switch k.Proto {
	case ProtoTCP, ProtoUDP:
		return fmt.Sprintf("%s %s → %s", p, hostPort(Src(k), k.Sport), hostPort(Dst(k), k.Dport))
	case ProtoICMP, ProtoICMPv6:
		return fmt.Sprintf("%s type %d %s → %s", p, k.Dport, Src(k), Dst(k))
	}
	return fmt.Sprintf("%s %s → %s", p, Src(k), Dst(k))
}
