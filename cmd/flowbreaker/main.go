// Command flowbreaker attaches the Flowbreaker XDP program to an interface
// and serves the game UI on localhost.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/netip"
	"os"
	"os/signal"
	"syscall"
	"time"

	"flowbreaker/internal/engine"
	"flowbreaker/internal/flow"
	"flowbreaker/internal/server"
	"flowbreaker/web"
)

// version is set at release build time via -ldflags "-X main.version=...".
var version = "dev"

func main() {
	showVersion := flag.Bool("version", false, "print the version and exit")
	iface := flag.String("iface", "", "network interface to defend (required)")
	listen := flag.String("listen", "127.0.0.1:8088", "UI listen address (keep it on loopback)")
	protect := flag.String("protect", flow.DefaultProtect, "never-droppable proto:port rules, comma separated")
	protectHosts := flag.String("protect-hosts", flow.DefaultProtectHosts, "never-droppable remote hosts: hostnames, IPs or CIDRs, comma separated")
	ttl := flag.Duration("ttl", 60*time.Second, "how long a shot flow stays blocked (0 = until exit)")
	maxEPS := flag.Int("max-eps", 150, "max sampled packets per second sent to the UI")
	sample := flag.Duration("sample", 200*time.Millisecond, "min interval between two samples of the same flow")
	flag.Parse()
	if *showVersion {
		fmt.Println("flowbreaker", version)
		return
	}

	if *iface == "" {
		fmt.Fprintln(os.Stderr, "usage: flowbreaker -iface <dev> [flags]")
		flag.PrintDefaults()
		os.Exit(2)
	}
	if host, _, err := net.SplitHostPort(*listen); err == nil {
		if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
			log.Printf("WARNING: listening on %s; anyone who can reach it and knows the token can drop your traffic", *listen)
		}
	}
	policy, err := flow.ParsePolicy(*protect)
	if err != nil {
		log.Fatal(err)
	}

	pnets, phosts, err := flow.ParseHosts(*protectHosts)
	if err != nil {
		log.Fatal(err)
	}

	eng, err := engine.New(engine.Options{
		Iface: *iface, Policy: policy, ProtectNets: pnets, ProtectHosts: phosts,
		TTL: *ttl, MaxEPS: *maxEPS, SampleIv: *sample,
	})
	if err != nil {
		log.Fatal(err)
	}
	defer eng.Close()
	log.Printf("XDP attached to %s (%s mode); protected ports: %s; protected hosts: %s", *iface, eng.Mode(), policy.Strings(), eng.ProtectedNets())

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	srv := server.New(eng, server.Hello{
		Iface: *iface, Mode: eng.Mode(), Protect: policy.Strings(), ProtectHosts: protectHostList(phosts, pnets),
		TTL: ttl.Seconds(), MaxEPS: *maxEPS,
	}, web.FS)

	pkts := make(chan engine.Packet, 1024)
	go func() {
		if err := eng.Run(ctx, pkts); err != nil {
			log.Printf("ringbuf: %v", err)
			stop()
		}
	}()
	go srv.Pump(ctx, pkts)
	go eng.WatchHosts(ctx)

	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Fatal(err)
	}
	hs := &http.Server{Handler: srv.Handler(), ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		hs.Shutdown(sctx)
	}()
	log.Printf("open http://%s/?token=%s", ln.Addr(), srv.Token)
	if err := hs.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Print(err)
	}
	log.Print("shutting down: detaching XDP, all blocks lifted")
}

func protectHostList(hosts []string, nets []netip.Prefix) []string {
	out := append([]string(nil), hosts...)
	for _, p := range nets {
		out = append(out, p.String())
	}
	return out
}
