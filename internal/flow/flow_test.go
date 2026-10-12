package flow

import (
	"net/netip"
	"testing"
)

func v4Key(src, dst string, proto uint8, sport, dport uint16) Key {
	k := Key{Proto: proto, Sport: sport, Dport: dport, Family: 4}
	k.Saddr = netip.MustParseAddr("::ffff:" + src).As16()
	k.Daddr = netip.MustParseAddr("::ffff:" + dst).As16()
	return k
}

func TestParsePolicy(t *testing.T) {
	p, err := ParsePolicy(DefaultProtect)
	if err != nil {
		t.Fatal(err)
	}
	if got := len(p.Keys()); got != 1+1+1+2+2+5 {
		t.Fatalf("default policy expands to %d keys", got)
	}

	for _, bad := range []string{"tcp", "tcp:0", "foo:1", "udp:9-3", "tcp:70000", "tcp:1-2000"} {
		if _, err := ParsePolicy(bad); err == nil {
			t.Errorf("ParsePolicy(%q) succeeded", bad)
		}
	}

	p, err = ParsePolicy(" ICMP:* , udp:5000 ")
	if err != nil {
		t.Fatal(err)
	}
	if s := p.Strings(); len(s) != 2 || s[0] != "icmp:*" || s[1] != "udp:5000" {
		t.Fatalf("unexpected rules %v", s)
	}
	if k := p.Keys(); k[0].Port != 0 || k[0].Proto != ProtoICMP {
		t.Fatalf("wildcard key %+v", k[0])
	}
}

func TestProtects(t *testing.T) {
	p, _ := ParsePolicy(DefaultProtect)
	cases := []struct {
		k    Key
		want bool
	}{
		{v4Key("1.1.1.1", "10.0.0.2", ProtoUDP, 53, 40000), true},   // DNS reply
		{v4Key("10.0.0.9", "10.0.0.2", ProtoTCP, 50000, 22), true},  // inbound SSH
		{v4Key("1.1.1.1", "10.0.0.2", ProtoTCP, 443, 40000), false}, // HTTPS
		{v4Key("1.1.1.1", "10.0.0.2", ProtoICMP, 0, 0), false},      // echo reply
		{Key{Proto: ProtoICMPv6, Dport: 135, Family: 6}, true},      // neighbour solicitation
		{Key{Proto: ProtoICMPv6, Dport: 129, Family: 6}, false},     // echo reply
	}
	for _, c := range cases {
		if got := p.Protects(c.k); got != c.want {
			t.Errorf("Protects(%s) = %v, want %v", Label(c.k), got, c.want)
		}
	}
}

func TestIDAndLabel(t *testing.T) {
	a := v4Key("1.2.3.4", "10.0.0.2", ProtoTCP, 443, 51234)
	b := a
	b.Dport++
	if ID(a) != ID(a) || ID(a) == ID(b) || len(ID(a)) != 12 {
		t.Fatalf("bad ids %s %s", ID(a), ID(b))
	}
	if got, want := Label(a), "tcp 1.2.3.4:443 → 10.0.0.2:51234"; got != want {
		t.Fatalf("Label = %q, want %q", got, want)
	}
	if Src(a).String() != "1.2.3.4" {
		t.Fatalf("Src = %s", Src(a))
	}
}

func TestParseHostsAndNetSet(t *testing.T) {
	nets, hosts, err := ParseHosts("api.anthropic.com, 10.1.2.3, 160.79.104.0/23, 2001:db8::/32, Claude.AI")
	if err != nil {
		t.Fatal(err)
	}
	if len(hosts) != 2 || hosts[0] != "api.anthropic.com" || hosts[1] != "claude.ai" {
		t.Fatalf("hosts = %v", hosts)
	}
	if len(nets) != 3 || nets[0].String() != "10.1.2.3/32" {
		t.Fatalf("nets = %v", nets)
	}
	for _, bad := range []string{"not a host!", "-x.com", "localhost"} {
		if _, _, err := ParseHosts(bad); err == nil {
			t.Errorf("ParseHosts(%q) succeeded", bad)
		}
	}

	s := NewNetSet()
	for _, p := range nets {
		s.Add(p)
	}
	if s.Add(nets[0]) {
		t.Fatal("duplicate Add reported new")
	}
	in := v4Key("160.79.105.7", "10.0.0.2", ProtoTCP, 443, 40000)
	out := v4Key("1.2.3.4", "10.0.0.2", ProtoTCP, 443, 40000)
	if !s.ProtectsKey(in) || s.ProtectsKey(out) {
		t.Fatalf("ProtectsKey wrong: in=%v out=%v", s.ProtectsKey(in), s.ProtectsKey(out))
	}

	k := ToLPM(nets[1])
	if k.Prefixlen != 96+23 || k.Addr[10] != 0xff || k.Addr[12] != 160 {
		t.Fatalf("v4 LPM key %+v", k)
	}
	if k := ToLPM(nets[2]); k.Prefixlen != 32 || k.Addr[0] != 0x20 {
		t.Fatalf("v6 LPM key %+v", k)
	}
}
