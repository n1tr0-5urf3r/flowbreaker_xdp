package engine

import (
	"bytes"
	"encoding/binary"
	"errors"
	"net/netip"
	"os"
	"testing"
	"time"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/ringbuf"

	"flowbreaker/internal/bpfobj"
	"flowbreaker/internal/flow"
)

const (
	xdpDrop = 1
	xdpPass = 2
)

// ipv4Packet builds an Ethernet/IPv4/(TCP|UDP) frame.
func ipv4Packet(src, dst string, proto uint8, sport, dport uint16) []byte {
	l4len := 20
	if proto == flow.ProtoUDP {
		l4len = 8
	}
	b := make([]byte, 14+20+l4len)
	binary.BigEndian.PutUint16(b[12:], 0x0800)
	ip := b[14:]
	ip[0] = 0x45
	binary.BigEndian.PutUint16(ip[2:], uint16(20+l4len))
	ip[8] = 64
	ip[9] = proto
	s, d := netip.MustParseAddr(src).As4(), netip.MustParseAddr(dst).As4()
	copy(ip[12:], s[:])
	copy(ip[16:], d[:])
	l4 := ip[20:]
	binary.BigEndian.PutUint16(l4[0:], sport)
	binary.BigEndian.PutUint16(l4[2:], dport)
	if proto == flow.ProtoTCP {
		l4[12] = 5 << 4
		l4[13] = 0x12 // SYN|ACK
	}
	return b
}

func keyFor(src, dst string, proto uint8, sport, dport uint16) flow.Key {
	k := flow.Key{Proto: proto, Sport: sport, Dport: dport, Family: 4}
	k.Saddr = netip.MustParseAddr("::ffff:" + src).As16()
	k.Daddr = netip.MustParseAddr("::ffff:" + dst).As16()
	return k
}

func loadForTest(t *testing.T) *bpfobj.ShooterObjects {
	t.Helper()
	if os.Geteuid() != 0 {
		t.Skip("needs root (run: sudo -E go test ./internal/engine/)")
	}
	var objs bpfobj.ShooterObjects
	if err := bpfobj.LoadShooterObjects(&objs, nil); err != nil {
		var ve *ebpf.VerifierError
		if errors.As(err, &ve) {
			t.Fatalf("verifier: %+v", ve)
		}
		t.Fatal(err)
	}
	t.Cleanup(func() { objs.Close() })
	policy, _ := flow.ParsePolicy(flow.DefaultProtect)
	for _, k := range policy.Keys() {
		if err := objs.ProtectedPorts.Put(k, uint8(1)); err != nil {
			t.Fatal(err)
		}
	}
	cfg := bpfobj.ShooterConfig{SampleNs: 0, PerCpuEps: 1000, Enabled: 1}
	if err := objs.Cfg.Put(uint32(0), cfg); err != nil {
		t.Fatal(err)
	}
	return &objs
}

func run(t *testing.T, objs *bpfobj.ShooterObjects, pkt []byte) uint32 {
	t.Helper()
	ret, err := objs.XdpShooter.Run(&ebpf.RunOptions{Data: pkt})
	if err != nil {
		t.Fatal(err)
	}
	return ret
}

func TestXDPVerdicts(t *testing.T) {
	objs := loadForTest(t)
	rd, err := ringbuf.NewReader(objs.Events)
	if err != nil {
		t.Fatal(err)
	}
	defer rd.Close()

	https := ipv4Packet("1.2.3.4", "10.0.0.2", flow.ProtoTCP, 443, 5000)
	httpsKey := keyFor("1.2.3.4", "10.0.0.2", flow.ProtoTCP, 443, 5000)

	t.Run("pass and sample", func(t *testing.T) {
		if got := run(t, objs, https); got != xdpPass {
			t.Fatalf("verdict %d, want PASS", got)
		}
		rd.SetDeadline(time.Now().Add(time.Second))
		rec, err := rd.Read()
		if err != nil {
			t.Fatalf("no event: %v", err)
		}
		var ev bpfobj.ShooterEvent
		if err := binary.Read(bytes.NewReader(rec.RawSample), binary.LittleEndian, &ev); err != nil {
			t.Fatal(err)
		}
		if ev.Key != httpsKey || ev.TcpFlags != 0x12 || ev.Protected != 0 || ev.Len != uint32(len(https)) {
			t.Fatalf("unexpected event %+v", ev)
		}
	})

	t.Run("blocked flow drops", func(t *testing.T) {
		if err := objs.Blocklist.Put(httpsKey, bpfobj.ShooterBlockVal{}); err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 3; i++ {
			if got := run(t, objs, https); got != xdpDrop {
				t.Fatalf("verdict %d, want DROP", got)
			}
		}
		var v bpfobj.ShooterBlockVal
		if err := objs.Blocklist.Lookup(httpsKey, &v); err != nil || v.Drops != 3 {
			t.Fatalf("drops = %d (%v), want 3", v.Drops, err)
		}
		other := ipv4Packet("1.2.3.4", "10.0.0.2", flow.ProtoTCP, 443, 5001)
		if got := run(t, objs, other); got != xdpPass {
			t.Fatalf("other flow verdict %d, want PASS", got)
		}
	})

	t.Run("protected beats blocklist", func(t *testing.T) {
		dns := ipv4Packet("1.1.1.1", "10.0.0.2", flow.ProtoUDP, 53, 40000)
		k := keyFor("1.1.1.1", "10.0.0.2", flow.ProtoUDP, 53, 40000)
		if err := objs.Blocklist.Put(k, bpfobj.ShooterBlockVal{}); err != nil {
			t.Fatal(err)
		}
		if got := run(t, objs, dns); got != xdpPass {
			t.Fatalf("verdict %d, want PASS", got)
		}
	})

	t.Run("protected network beats blocklist", func(t *testing.T) {
		pkt := ipv4Packet("160.79.104.10", "10.0.0.2", flow.ProtoTCP, 443, 7000)
		k := keyFor("160.79.104.10", "10.0.0.2", flow.ProtoTCP, 443, 7000)
		if err := objs.Blocklist.Put(k, bpfobj.ShooterBlockVal{}); err != nil {
			t.Fatal(err)
		}
		if got := run(t, objs, pkt); got != xdpDrop {
			t.Fatalf("before protecting: verdict %d, want DROP", got)
		}
		if err := objs.ProtectedNets.Put(flow.ToLPM(netip.MustParsePrefix("160.79.104.0/23")), uint8(1)); err != nil {
			t.Fatal(err)
		}
		if got := run(t, objs, pkt); got != xdpPass {
			t.Fatalf("after protecting: verdict %d, want PASS", got)
		}
	})

	t.Run("expired entry passes and is evicted", func(t *testing.T) {
		pkt := ipv4Packet("5.6.7.8", "10.0.0.2", flow.ProtoTCP, 80, 6000)
		k := keyFor("5.6.7.8", "10.0.0.2", flow.ProtoTCP, 80, 6000)
		if err := objs.Blocklist.Put(k, bpfobj.ShooterBlockVal{ExpiresNs: 1}); err != nil {
			t.Fatal(err)
		}
		if got := run(t, objs, pkt); got != xdpPass {
			t.Fatalf("verdict %d, want PASS", got)
		}
		var v bpfobj.ShooterBlockVal
		if err := objs.Blocklist.Lookup(k, &v); !errors.Is(err, ebpf.ErrKeyNotExist) {
			t.Fatalf("expired entry still present (%v)", err)
		}
	})

	t.Run("non-IP passes", func(t *testing.T) {
		arp := make([]byte, 42)
		binary.BigEndian.PutUint16(arp[12:], 0x0806)
		if got := run(t, objs, arp); got != xdpPass {
			t.Fatalf("verdict %d, want PASS", got)
		}
	})
}
