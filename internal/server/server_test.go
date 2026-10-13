package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/coder/websocket"

	"flowbreaker/internal/engine"
)

type fakeBackend struct {
	killed []string
	panics int
}

func (f *fakeBackend) Kill(id string) (string, error) {
	switch id {
	case "prot":
		return "udp 1.1.1.1:53 → 10.0.0.2:4000", engine.ErrProtected
	case "nope":
		return "", engine.ErrUnknownFlow
	}
	f.killed = append(f.killed, id)
	return "tcp " + id, nil
}
func (f *fakeBackend) Unblock(string) error  { return nil }
func (f *fakeBackend) Panic() int            { f.panics++; return 3 }
func (f *fakeBackend) Rules() []engine.Rule  { return nil }
func (f *fakeBackend) Stats() engine.Stats   { return engine.Stats{} }
func (f *fakeBackend) SetMaxEPS(n int) error { return nil }

func setup(t *testing.T) (*Server, *fakeBackend, *httptest.Server) {
	be := &fakeBackend{}
	s := New(be, Hello{Iface: "test0"}, fstest.MapFS{"index.html": {Data: []byte("hi")}})
	ts := httptest.NewServer(s.Handler())
	t.Cleanup(ts.Close)
	return s, be, ts
}

func TestTokenRequired(t *testing.T) {
	_, _, ts := setup(t)
	resp, err := http.Get(ts.URL + "/ws?token=wrong")
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("status %d, want 403", resp.StatusCode)
	}
}

func TestForeignOriginRejected(t *testing.T) {
	s, _, ts := setup(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws?token="+s.Token, &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": {"https://evil.example"}},
	})
	if err == nil || resp == nil || resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin dial: err=%v resp=%v", err, resp)
	}
}

// Backends may return nil slices; clients must still get JSON arrays.
func TestRulesNeverNull(t *testing.T) {
	s, _, ts := setup(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	go s.Pump(ctx, make(chan engine.Packet))
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws?token="+s.Token, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	for {
		_, b, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]json.RawMessage
		json.Unmarshal(b, &m)
		if string(m["t"]) == `"rules"` {
			if got := string(m["rules"]); got != "[]" {
				t.Fatalf("rules = %s, want []", got)
			}
			return
		}
	}
}

func TestCommands(t *testing.T) {
	s, be, ts := setup(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws?token="+s.Token, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()

	read := func() map[string]any {
		t.Helper()
		_, b, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var m map[string]any
		json.Unmarshal(b, &m)
		return m
	}
	send := func(v string) {
		t.Helper()
		if err := c.Write(ctx, websocket.MessageText, []byte(v)); err != nil {
			t.Fatal(err)
		}
	}

	if m := read(); m["t"] != "hello" {
		t.Fatalf("first message %v", m)
	}
	cases := []struct{ cmd, want string }{
		{`{"t":"kill","id":"abc"}`, "killed"},
		{`{"t":"kill","id":"prot"}`, "deflect"},
		{`{"t":"kill","id":"nope"}`, "error"},
		{`{"t":"panic"}`, "panicked"},
		{`{"t":"bogus"}`, "error"},
		{`not json`, "error"},
	}
	for _, tc := range cases {
		send(tc.cmd)
		if m := read(); m["t"] != tc.want {
			t.Errorf("%s -> %v, want %s", tc.cmd, m, tc.want)
		}
	}
	if len(be.killed) != 1 || be.killed[0] != "abc" || be.panics != 1 {
		t.Fatalf("backend saw killed=%v panics=%d", be.killed, be.panics)
	}
}
