// Package engine owns the loaded XDP program and its maps: it attaches the
// program, streams sampled packets, and turns "shots" into blocklist entries.
package engine

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"log"
	"net"
	"net/netip"
	"sort"
	"sync"
	"time"

	"github.com/cilium/ebpf"
	"github.com/cilium/ebpf/link"
	"github.com/cilium/ebpf/ringbuf"
	"golang.org/x/sys/unix"

	"flowbreaker/internal/bpfobj"
	"flowbreaker/internal/flow"
)

// Options configure the engine.
type Options struct {
	Iface  string
	Policy flow.Policy
	// Never-droppable remote ends: fixed networks plus hostnames that are
	// resolved at start and re-resolved every minute.
	ProtectNets  []netip.Prefix
	ProtectHosts []string
	TTL          time.Duration // 0 = blocks last until the daemon exits
	MaxEPS       int           // sampled events per second (whole host)
	SampleIv     time.Duration // min interval between two events of one flow
}

// Packet is one sampled packet as sent to the browser.
type Packet struct {
	ID        string `json:"id"`
	Src       string `json:"src"`
	Dst       string `json:"dst"`
	Sport     uint16 `json:"sp"`
	Dport     uint16 `json:"dp"`
	Proto     uint8  `json:"proto"`
	Len       uint32 `json:"len"`
	Flags     uint8  `json:"flags"`
	Protected bool   `json:"prot"`
}

// Rule is one active blocklist entry.
type Rule struct {
	ID        string  `json:"id"`
	Label     string  `json:"label"`
	Drops     uint64  `json:"drops"`
	ExpiresIn float64 `json:"expiresIn"` // seconds, -1 = never
}

// Stats are the kernel counters summed over all CPUs.
type Stats struct {
	Seen      uint64 `json:"seen"`
	Sampled   uint64 `json:"sampled"`
	Dropped   uint64 `json:"dropped"`
	Protected uint64 `json:"protected"`
	RBFull    uint64 `json:"rbFull"`
}

// ErrProtected is returned when the player shoots a protected flow.
var ErrProtected = errors.New("flow is protected")

// ErrUnknownFlow is returned for IDs the daemon has never emitted.
var ErrUnknownFlow = errors.New("unknown flow")

type Engine struct {
	opts  Options
	objs  bpfobj.ShooterObjects
	link  link.Link
	mode  string
	ncpu  int
	rd    *ringbuf.Reader
	flows *registry
	nets  *flow.NetSet
	mu    sync.Mutex // serialises blocklist writes
}

// New loads the XDP program, configures it and attaches it to opts.Iface.
func New(opts Options) (*Engine, error) {
	iface, err := net.InterfaceByName(opts.Iface)
	if err != nil {
		return nil, fmt.Errorf("interface %q: %w", opts.Iface, err)
	}
	ncpu, err := ebpf.PossibleCPU()
	if err != nil {
		return nil, err
	}
	e := &Engine{opts: opts, ncpu: ncpu, flows: newRegistry(8192), nets: flow.NewNetSet()}

	if err := bpfobj.LoadShooterObjects(&e.objs, nil); err != nil {
		var ve *ebpf.VerifierError
		if errors.As(err, &ve) {
			return nil, fmt.Errorf("verifier: %+v", ve)
		}
		return nil, fmt.Errorf("loading eBPF objects (are you root / have CAP_BPF?): %w", err)
	}
	for _, k := range opts.Policy.Keys() {
		if err := e.objs.ProtectedPorts.Put(k, uint8(1)); err != nil {
			e.objs.Close()
			return nil, fmt.Errorf("protected_ports: %w", err)
		}
	}
	for _, p := range opts.ProtectNets {
		if err := e.addNet(p); err != nil {
			e.objs.Close()
			return nil, err
		}
	}
	// Resolve before attaching so protected hosts are safe from the first packet.
	rctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	e.resolveHosts(rctx)
	cancel()

	if err := e.writeConfig(opts.MaxEPS); err != nil {
		e.objs.Close()
		return nil, err
	}

	// Native mode first; many Wi-Fi drivers only support generic (SKB) XDP.
	for _, m := range []struct {
		name  string
		flags link.XDPAttachFlags
	}{{"driver", link.XDPDriverMode}, {"generic", link.XDPGenericMode}} {
		e.link, err = link.AttachXDP(link.XDPOptions{
			Program:   e.objs.XdpShooter,
			Interface: iface.Index,
			Flags:     m.flags,
		})
		if err == nil {
			e.mode = m.name
			break
		}
	}
	if err != nil {
		e.objs.Close()
		return nil, fmt.Errorf("attaching XDP to %s: %w", opts.Iface, err)
	}

	e.rd, err = ringbuf.NewReader(e.objs.Events)
	if err != nil {
		e.Close()
		return nil, err
	}
	return e, nil
}

func (e *Engine) addNet(p netip.Prefix) error {
	if !e.nets.Add(p) {
		return nil
	}
	if err := e.objs.ProtectedNets.Put(flow.ToLPM(p), uint8(1)); err != nil {
		return fmt.Errorf("protected_nets %s: %w", p, err)
	}
	return nil
}

func (e *Engine) resolveHosts(ctx context.Context) {
	for _, h := range e.opts.ProtectHosts {
		addrs, err := net.DefaultResolver.LookupNetIP(ctx, "ip", h)
		if err != nil {
			log.Printf("protect host %s: %v", h, err)
			continue
		}
		for _, a := range addrs {
			a = a.Unmap()
			p := netip.PrefixFrom(a, a.BitLen())
			if e.nets.Contains(a) {
				continue
			}
			if err := e.addNet(p); err != nil {
				log.Print(err)
				continue
			}
			log.Printf("protecting %s (%s)", a, h)
		}
	}
}

// WatchHosts re-resolves protected hostnames every minute, since CDN-backed
// names rotate addresses. Addresses are only ever added, never removed.
func (e *Engine) WatchHosts(ctx context.Context) {
	if len(e.opts.ProtectHosts) == 0 {
		return
	}
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			rctx, cancel := context.WithTimeout(ctx, 10*time.Second)
			e.resolveHosts(rctx)
			cancel()
		}
	}
}

// ProtectedNets lists every protected network, including resolved hosts.
func (e *Engine) ProtectedNets() []string { return e.nets.Strings() }

// Mode reports the XDP attach mode ("driver" or "generic").
func (e *Engine) Mode() string { return e.mode }

func (e *Engine) writeConfig(maxEPS int) error {
	perCPU := maxEPS / e.ncpu
	if perCPU < 1 {
		perCPU = 1
	}
	c := bpfobj.ShooterConfig{
		SampleNs:  uint64(e.opts.SampleIv.Nanoseconds()),
		PerCpuEps: uint32(perCPU),
		Enabled:   1,
	}
	if err := e.objs.Cfg.Put(uint32(0), c); err != nil {
		return fmt.Errorf("cfg: %w", err)
	}
	return nil
}

// SetMaxEPS changes the sampling budget at runtime.
func (e *Engine) SetMaxEPS(n int) error {
	if n < 1 || n > 5000 {
		return fmt.Errorf("maxEps out of range: %d", n)
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	e.opts.MaxEPS = n
	return e.writeConfig(n)
}

// Run reads sampled packets until ctx is cancelled or the engine is closed.
func (e *Engine) Run(ctx context.Context, out chan<- Packet) error {
	go func() {
		<-ctx.Done()
		e.rd.Close()
	}()
	var ev bpfobj.ShooterEvent
	for {
		rec, err := e.rd.Read()
		if err != nil {
			if errors.Is(err, ringbuf.ErrClosed) {
				return nil
			}
			return err
		}
		if err := binary.Read(bytes.NewReader(rec.RawSample), binary.LittleEndian, &ev); err != nil {
			log.Printf("decoding event: %v", err)
			continue
		}
		id := e.flows.put(ev.Key)
		p := Packet{
			ID:        id,
			Src:       flow.Src(ev.Key).String(),
			Dst:       flow.Dst(ev.Key).String(),
			Sport:     ev.Key.Sport,
			Dport:     ev.Key.Dport,
			Proto:     ev.Key.Proto,
			Len:       ev.Len,
			Flags:     ev.TcpFlags,
			Protected: ev.Protected != 0,
		}
		select {
		case out <- p:
		default: // UI is behind; drop the sample, never the packet
		}
	}
}

func monoNow() uint64 {
	var ts unix.Timespec
	_ = unix.ClockGettime(unix.CLOCK_MONOTONIC, &ts)
	return uint64(ts.Nano())
}

// Kill blocks the flow with the given ID. It returns the flow's label.
func (e *Engine) Kill(id string) (string, error) {
	k, ok := e.flows.get(id)
	if !ok {
		return "", ErrUnknownFlow
	}
	label := flow.Label(k)
	if e.opts.Policy.Protects(k) || e.nets.ProtectsKey(k) {
		return label, ErrProtected
	}
	v := bpfobj.ShooterBlockVal{}
	if e.opts.TTL > 0 {
		v.ExpiresNs = monoNow() + uint64(e.opts.TTL.Nanoseconds())
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	// Keep the drop counter if the flow is already blocked; just refresh TTL.
	var old bpfobj.ShooterBlockVal
	if err := e.objs.Blocklist.Lookup(k, &old); err == nil {
		v.Drops = old.Drops
	}
	if err := e.objs.Blocklist.Put(k, v); err != nil {
		return label, fmt.Errorf("blocklist: %w", err)
	}
	return label, nil
}

// Unblock removes a single flow from the blocklist.
func (e *Engine) Unblock(id string) error {
	k, ok := e.flows.get(id)
	if !ok {
		return ErrUnknownFlow
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.objs.Blocklist.Delete(k); err != nil && !errors.Is(err, ebpf.ErrKeyNotExist) {
		return err
	}
	return nil
}

// Panic clears the whole blocklist and returns how many rules were removed.
func (e *Engine) Panic() int {
	e.mu.Lock()
	defer e.mu.Unlock()
	var keys []flow.Key
	var k flow.Key
	var v bpfobj.ShooterBlockVal
	it := e.objs.Blocklist.Iterate()
	for it.Next(&k, &v) {
		keys = append(keys, k)
	}
	n := 0
	for _, k := range keys {
		if err := e.objs.Blocklist.Delete(k); err == nil {
			n++
		}
	}
	return n
}

// Rules lists active blocklist entries and evicts expired ones.
func (e *Engine) Rules() []Rule {
	e.mu.Lock()
	defer e.mu.Unlock()
	now := monoNow()
	var rules []Rule
	var expired []flow.Key
	var k flow.Key
	var v bpfobj.ShooterBlockVal
	it := e.objs.Blocklist.Iterate()
	for it.Next(&k, &v) {
		r := Rule{ID: e.flows.put(k), Label: flow.Label(k), Drops: v.Drops, ExpiresIn: -1}
		if v.ExpiresNs != 0 {
			if now >= v.ExpiresNs {
				expired = append(expired, k)
				continue
			}
			r.ExpiresIn = float64(v.ExpiresNs-now) / 1e9
		}
		rules = append(rules, r)
	}
	for _, k := range expired {
		_ = e.objs.Blocklist.Delete(k)
	}
	sort.Slice(rules, func(i, j int) bool { return rules[i].Label < rules[j].Label })
	return rules
}

// Stats sums the per-CPU kernel counters.
func (e *Engine) Stats() Stats {
	var s Stats
	fields := []*uint64{&s.Seen, &s.Sampled, &s.Dropped, &s.Protected, &s.RBFull}
	for i, f := range fields {
		var per []uint64
		if err := e.objs.Stats.Lookup(uint32(i), &per); err != nil {
			continue
		}
		for _, n := range per {
			*f += n
		}
	}
	return s
}

// Close detaches the program. Because the link is not pinned, the kernel
// would also detach it on its own if the process died.
func (e *Engine) Close() error {
	if e.rd != nil {
		e.rd.Close()
	}
	if e.link != nil {
		e.link.Close()
	}
	return e.objs.Close()
}
