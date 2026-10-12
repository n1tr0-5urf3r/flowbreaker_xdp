package flow

import (
	"fmt"
	"strconv"
	"strings"

	"flowbreaker/internal/bpfobj"
)

// DefaultProtect keeps the host reachable and its name resolution, DHCP and
// IPv6 neighbour discovery working no matter what the player shoots.
const DefaultProtect = "tcp:22,tcp:53,udp:53,udp:67-68,udp:546-547,icmpv6:133-137"

// ProtKey mirrors struct prot_key. Port 0 protects the whole protocol.
type ProtKey = bpfobj.ShooterProtKey

// Rule is one entry of a protect spec, e.g. "udp:67-68" or "icmp:*".
// For ICMP protocols the "port" is the ICMP type.
type Rule struct {
	Proto    uint8
	From, To uint16 // both 0 = whole protocol
}

func (r Rule) String() string {
	switch {
	case r.From == 0 && r.To == 0:
		return ProtoName(r.Proto) + ":*"
	case r.From == r.To:
		return fmt.Sprintf("%s:%d", ProtoName(r.Proto), r.From)
	}
	return fmt.Sprintf("%s:%d-%d", ProtoName(r.Proto), r.From, r.To)
}

// Policy is the parsed set of protected protocol/port rules.
type Policy []Rule

const maxProtKeys = 1024 // max_entries of protected_ports

func parseProto(s string) (uint8, error) {
	switch s {
	case "tcp":
		return ProtoTCP, nil
	case "udp":
		return ProtoUDP, nil
	case "icmp":
		return ProtoICMP, nil
	case "icmpv6", "icmp6":
		return ProtoICMPv6, nil
	}
	return 0, fmt.Errorf("unknown protocol %q", s)
}

func parsePort(s string) (uint16, error) {
	n, err := strconv.ParseUint(s, 10, 16)
	if err != nil || n == 0 {
		return 0, fmt.Errorf("invalid port %q", s)
	}
	return uint16(n), nil
}

// ParsePolicy parses a comma separated list like "tcp:22,udp:67-68,icmp:*".
func ParsePolicy(spec string) (Policy, error) {
	var p Policy
	total := 0
	for _, item := range strings.Split(spec, ",") {
		item = strings.TrimSpace(strings.ToLower(item))
		if item == "" {
			continue
		}
		protoS, portS, ok := strings.Cut(item, ":")
		if !ok {
			return nil, fmt.Errorf("protect rule %q: want proto:port", item)
		}
		proto, err := parseProto(protoS)
		if err != nil {
			return nil, fmt.Errorf("protect rule %q: %w", item, err)
		}
		r := Rule{Proto: proto}
		if portS != "*" {
			fromS, toS, isRange := strings.Cut(portS, "-")
			if r.From, err = parsePort(fromS); err != nil {
				return nil, fmt.Errorf("protect rule %q: %w", item, err)
			}
			r.To = r.From
			if isRange {
				if r.To, err = parsePort(toS); err != nil {
					return nil, fmt.Errorf("protect rule %q: %w", item, err)
				}
				if r.To < r.From {
					return nil, fmt.Errorf("protect rule %q: empty range", item)
				}
			}
			total += int(r.To-r.From) + 1
		} else {
			total++
		}
		if total > maxProtKeys {
			return nil, fmt.Errorf("protect spec expands to more than %d entries", maxProtKeys)
		}
		p = append(p, r)
	}
	return p, nil
}

// Keys expands the policy into kernel map keys.
func (p Policy) Keys() []ProtKey {
	var keys []ProtKey
	for _, r := range p {
		if r.From == 0 {
			keys = append(keys, ProtKey{Proto: r.Proto})
			continue
		}
		for port := uint32(r.From); port <= uint32(r.To); port++ {
			keys = append(keys, ProtKey{Proto: r.Proto, Port: uint16(port)})
		}
	}
	return keys
}

// Protects reports whether the kernel would treat k as protected. It mirrors
// is_protected() in the BPF program.
func (p Policy) Protects(k Key) bool {
	match := func(r Rule, port uint16) bool {
		return port != 0 && port >= r.From && port <= r.To
	}
	for _, r := range p {
		if r.Proto != k.Proto {
			continue
		}
		if r.From == 0 || match(r, k.Sport) || match(r, k.Dport) {
			return true
		}
	}
	return false
}

func (p Policy) Strings() []string {
	out := make([]string, len(p))
	for i, r := range p {
		out[i] = r.String()
	}
	return out
}
