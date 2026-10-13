// Package server serves the browser game and bridges it to the engine over a
// WebSocket.
package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io/fs"
	"log"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"flowbreaker/internal/engine"
)

// Backend is the subset of *engine.Engine the server needs.
type Backend interface {
	Kill(id string) (string, error)
	Unblock(id string) error
	Panic() int
	Rules() []engine.Rule
	Stats() engine.Stats
	SetMaxEPS(n int) error
}

// Hello is sent once per connection.
type Hello struct {
	Iface   string   `json:"iface"`
	Mode    string   `json:"mode"`
	Protect []string `json:"protect"`
	// ProtectHosts are the never-droppable remote hosts and networks.
	ProtectHosts []string `json:"protectHosts"`
	TTL          float64  `json:"ttl"` // seconds, 0 = until exit
	MaxEPS       int      `json:"maxEps"`
}

const deadManTimeout = 15 * time.Second

type Server struct {
	be      Backend
	hello   Hello
	static  fs.FS
	Token   string
	lastHB  atomic.Int64 // unix nanos of the last client heartbeat
	clients sync.Map     // *client -> struct{}
}

type client struct {
	send chan []byte
}

func New(be Backend, hello Hello, static fs.FS) *Server {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	s := &Server{be: be, hello: hello, static: static, Token: hex.EncodeToString(b)}
	s.lastHB.Store(time.Now().UnixNano())
	return s
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(s.static)))
	mux.HandleFunc("/ws", s.serveWS)
	return mux
}

func (s *Server) broadcast(msg any) {
	b, err := json.Marshal(msg)
	if err != nil {
		log.Printf("marshal: %v", err)
		return
	}
	s.clients.Range(func(k, _ any) bool {
		select {
		case k.(*client).send <- b:
		default: // slow client: skip this frame
		}
		return true
	})
}

// Pump batches packets and periodically pushes stats/rules until ctx ends.
// It also runs the dead-man switch.
func (s *Server) Pump(ctx context.Context, pkts <-chan engine.Packet) {
	frame := time.NewTicker(33 * time.Millisecond)
	slow := time.NewTicker(500 * time.Millisecond)
	defer frame.Stop()
	defer slow.Stop()
	batch := make([]engine.Packet, 0, 64)
	for {
		select {
		case <-ctx.Done():
			return
		case p := <-pkts:
			if len(batch) < 256 {
				batch = append(batch, p)
			}
		case <-frame.C:
			if len(batch) > 0 {
				s.broadcast(map[string]any{"t": "batch", "pkts": batch})
				batch = batch[:0]
			}
		case <-slow.C:
			rules := s.be.Rules()
			if rules == nil {
				rules = []engine.Rule{} // a JSON array, never null
			}
			s.broadcast(map[string]any{"t": "stats", "stats": s.be.Stats()})
			s.broadcast(map[string]any{"t": "rules", "rules": rules})
			if len(rules) > 0 && time.Since(time.Unix(0, s.lastHB.Load())) > deadManTimeout {
				n := s.be.Panic()
				log.Printf("dead-man switch: no UI heartbeat for %s, cleared %d rules", deadManTimeout, n)
			}
		}
	}
}

type command struct {
	T      string `json:"t"`
	ID     string `json:"id"`
	MaxEPS int    `json:"maxEps"`
}

func (s *Server) serveWS(w http.ResponseWriter, r *http.Request) {
	tok := r.URL.Query().Get("token")
	if subtle.ConstantTimeCompare([]byte(tok), []byte(s.Token)) != 1 {
		http.Error(w, "bad token", http.StatusForbidden)
		return
	}
	// Default AcceptOptions enforce Origin == Host, so other sites cannot
	// drive the firewall from the user's browser.
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(4096)

	c := &client{send: make(chan []byte, 64)}
	s.clients.Store(c, struct{}{})
	defer s.clients.Delete(c)
	s.lastHB.Store(time.Now().UnixNano())

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	go func() {
		defer cancel()
		for {
			select {
			case <-ctx.Done():
				return
			case b := <-c.send:
				wctx, wcancel := context.WithTimeout(ctx, 2*time.Second)
				err := conn.Write(wctx, websocket.MessageText, b)
				wcancel()
				if err != nil {
					return
				}
			}
		}
	}()

	reply := func(msg any) {
		b, _ := json.Marshal(msg)
		select {
		case c.send <- b:
		case <-ctx.Done():
		}
	}
	reply(map[string]any{"t": "hello", "hello": s.hello})

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		var cmd command
		if err := json.Unmarshal(data, &cmd); err != nil {
			reply(map[string]any{"t": "error", "msg": "bad json"})
			continue
		}
		s.lastHB.Store(time.Now().UnixNano())
		s.handle(cmd, reply)
	}
}

func (s *Server) handle(cmd command, reply func(any)) {
	switch cmd.T {
	case "hb":
	case "kill":
		label, err := s.be.Kill(cmd.ID)
		switch {
		case errors.Is(err, engine.ErrProtected):
			reply(map[string]any{"t": "deflect", "id": cmd.ID, "label": label})
		case err != nil:
			reply(map[string]any{"t": "error", "id": cmd.ID, "msg": err.Error()})
		default:
			log.Printf("BLOCK %s", label)
			reply(map[string]any{"t": "killed", "id": cmd.ID, "label": label})
		}
	case "unblock":
		if err := s.be.Unblock(cmd.ID); err != nil {
			reply(map[string]any{"t": "error", "id": cmd.ID, "msg": err.Error()})
		}
	case "panic":
		n := s.be.Panic()
		log.Printf("PANIC: cleared %d rules", n)
		reply(map[string]any{"t": "panicked", "n": n})
	case "cfg":
		if err := s.be.SetMaxEPS(cmd.MaxEPS); err != nil {
			reply(map[string]any{"t": "error", "msg": err.Error()})
		}
	default:
		reply(map[string]any{"t": "error", "msg": "unknown command"})
	}
}
