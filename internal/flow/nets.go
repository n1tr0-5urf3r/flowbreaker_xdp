package flow

import (
	"fmt"
	"net/netip"
	"regexp"
	"sort"
	"strings"
	"sync"

	"flowbreaker/internal/bpfobj"
)

// DefaultProtectHosts keeps the Claude session alive while you play.
const DefaultProtectHosts = "api.anthropic.com,claude.ai"

// LPMKey mirrors struct lpm_key in the BPF program.
type LPMKey = bpfobj.ShooterLpmKey

var hostnameRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$`)

// ParseHosts splits a comma separated list of IPs, CIDRs and hostnames.
func ParseHosts(spec string) (nets []netip.Prefix, hosts []string, err error) {
	for _, item := range strings.Split(spec, ",") {
		item = strings.TrimSpace(strings.ToLower(item))
		if item == "" {
			continue
		}
		if p, err := netip.ParsePrefix(item); err == nil {
			nets = append(nets, p.Masked())
			continue
		}
		if a, err := netip.ParseAddr(item); err == nil {
			nets = append(nets, netip.PrefixFrom(a.Unmap(), a.Unmap().BitLen()))
			continue
		}
		if !hostnameRe.MatchString(item) {
			return nil, nil, fmt.Errorf("protect host %q: not an IP, CIDR or hostname", item)
		}
		hosts = append(hosts, item)
	}
	return nets, hosts, nil
}

// ToLPM converts a prefix to the kernel's v4-mapped LPM key.
func ToLPM(p netip.Prefix) LPMKey {
	p = p.Masked()
	a := p.Addr()
	bits := p.Bits()
	if a.Is4() {
		bits += 96
	}
	return LPMKey{Prefixlen: uint32(bits), Addr: a.As16()}
}

// NetSet is the daemon-side copy of protected_nets. Safe for concurrent use.
type NetSet struct {
	mu   sync.RWMutex
	nets map[netip.Prefix]struct{}
}

func NewNetSet() *NetSet { return &NetSet{nets: make(map[netip.Prefix]struct{})} }

// Add reports whether p was new.
func (s *NetSet) Add(p netip.Prefix) bool {
	p = p.Masked()
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.nets[p]; ok {
		return false
	}
	s.nets[p] = struct{}{}
	return true
}

func (s *NetSet) Contains(a netip.Addr) bool {
	a = a.Unmap()
	s.mu.RLock()
	defer s.mu.RUnlock()
	for p := range s.nets {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// ProtectsKey reports whether either end of the flow is a protected address.
func (s *NetSet) ProtectsKey(k Key) bool {
	return s.Contains(Src(k)) || s.Contains(Dst(k))
}

func (s *NetSet) Len() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.nets)
}

func (s *NetSet) Strings() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, 0, len(s.nets))
	for p := range s.nets {
		out = append(out, p.String())
	}
	sort.Strings(out)
	return out
}
