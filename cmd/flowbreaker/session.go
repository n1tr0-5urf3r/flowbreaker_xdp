package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
)

// The session file tells native clients (the Godot frontend) where the UI
// listens and which token to use, so nobody has to copy it out of a URL.
// It lives in the invoking user's runtime dir and is readable only by them.
type session struct {
	Listen string `json:"listen"` // host:port of the HTTP/WebSocket server
	Token  string `json:"token"`
}

// defaultSessionPath picks /run/user/<uid>/flowbreaker.json for the user who
// ran sudo, or $XDG_RUNTIME_DIR/flowbreaker.json when not running via sudo.
func defaultSessionPath() string {
	if uid := os.Getenv("SUDO_UID"); uid != "" {
		dir := filepath.Join("/run/user", uid)
		if st, err := os.Stat(dir); err == nil && st.IsDir() {
			return filepath.Join(dir, "flowbreaker.json")
		}
	}
	if dir := os.Getenv("XDG_RUNTIME_DIR"); dir != "" {
		return filepath.Join(dir, "flowbreaker.json")
	}
	return ""
}

// writeSession writes the file and returns a cleanup func that removes it.
func writeSession(path, listen, token string) (func(), error) {
	b, err := json.Marshal(session{Listen: listen, Token: token})
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, b, 0o600); err != nil {
		return nil, fmt.Errorf("session file: %w", err)
	}
	// Under sudo the file would belong to root; hand it to the real user.
	if uid, err := strconv.Atoi(os.Getenv("SUDO_UID")); err == nil {
		gid, _ := strconv.Atoi(os.Getenv("SUDO_GID"))
		if err := os.Chown(path, uid, gid); err != nil {
			os.Remove(path)
			return nil, fmt.Errorf("session file: %w", err)
		}
	}
	return func() { os.Remove(path) }, nil
}
