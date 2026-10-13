package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestSessionFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("SUDO_UID", "")
	t.Setenv("XDG_RUNTIME_DIR", dir)
	path := defaultSessionPath()
	if path != filepath.Join(dir, "flowbreaker.json") {
		t.Fatalf("default path %q", path)
	}
	cleanup, err := writeSession(path, "127.0.0.1:8088", "abc123")
	if err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(path)
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("stat %v, mode %v", err, st.Mode())
	}
	var s session
	b, _ := os.ReadFile(path)
	if err := json.Unmarshal(b, &s); err != nil || s.Listen != "127.0.0.1:8088" || s.Token != "abc123" {
		t.Fatalf("content %s (%v)", b, err)
	}
	cleanup()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("session file not removed: %v", err)
	}
}
