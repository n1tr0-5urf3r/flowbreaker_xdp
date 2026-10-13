# Client protocol

`flowbreaker` (the daemon) owns everything that touches the kernel. Game frontends
(the web UI in `web/` and the Godot client in `godot/`) are clients. They talk
JSON text frames over one WebSocket. Several clients can be connected at the same
time; they all see the same traffic and the same kernel rules.

## Connecting

```
ws://127.0.0.1:8088/ws?token=<token>
```

- **Token:** a random hex string, printed in the startup URL. A fixed one can be set
  with `-token`.
- **Session file:** for native clients, the daemon also writes the token to
  `/run/user/<uid>/flowbreaker.json` (`$XDG_RUNTIME_DIR`; the file is mode 0600 and
  owned by the user who ran `sudo`). It is removed on exit, and `-session-file`
  changes the path:

  ```json
  {"listen": "127.0.0.1:8088", "token": "3f9a…"}
  ```

- **Origin check:** requests that carry an `Origin` header must come from the same
  host, so other websites can't drive the firewall from your browser. Native clients
  usually send no `Origin` and are accepted.

## Daemon → client

Every message has a `t` field.

| `t` | When | Payload |
|---|---|---|
| `hello` | once, on connect | `hello: {iface, mode, protect: [str], protectHosts: [str], ttl, maxEps}`. `mode` is `driver` or `generic` XDP; `ttl` is in seconds, `0` = until exit |
| `batch` | ≤ 30×/s | `pkts: [Packet]`, sampled ingress packets (see below) |
| `stats` | 2×/s | `stats: {seen, sampled, dropped, protected, rbFull}`, cumulative kernel counters |
| `rules` | 2×/s | `rules: [{id, label, drops, expiresIn}]`, the active blocklist. `expiresIn` is in seconds, `-1` = never |
| `killed` | reply to `kill` | `{id, label}`: the flow is now dropped in the kernel |
| `deflect` | reply to `kill` | `{id, label}`: the flow is protected and was not blocked |
| `panicked` | reply to `panic` | `{n}`: number of rules cleared |
| `error` | reply | `{msg, id?}` |

`Packet`:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | opaque flow ID (12 hex chars); the only handle a client can block |
| `src`, `dst` | string | IP addresses (IPv4 or IPv6) |
| `sp`, `dp` | int | ports in host byte order. For ICMP/ICMPv6, `sp` = 0 and `dp` = ICMP type |
| `proto` | int | IP protocol number (1 ICMP, 6 TCP, 17 UDP, 58 ICMPv6) |
| `len` | int | frame length in bytes |
| `flags` | int | TCP flags byte (FIN 0x01, SYN 0x02, RST 0x04, PSH 0x08, ACK 0x10) |
| `prot` | bool | protected flow: it can never be blocked |

Sampling: at most one packet per flow every `-sample` (default 200 ms), and at most
`maxEps` packets per second in total. A flow that is already blocked produces no
samples, since its packets never get past XDP.

## Client → daemon

| `t` | Payload | Effect |
|---|---|---|
| `kill` | `{id}` | block the flow for the daemon's TTL. Protected flows answer `deflect` |
| `unblock` | `{id}` | remove one rule |
| `panic` | – | clear all rules |
| `cfg` | `{maxEps}` | change the sampling budget (1–5000) |
| `hb` | – | heartbeat. Send one every few seconds |

**Dead-man switch:** if no client has sent anything for 15 s while rules exist, the
daemon clears them all. Any message counts as a heartbeat, `hb` included.

**PANIC in frontends:** besides sending `panic`, a frontend should stand down
anything automated it controls (turrets, gunships, airstrikes), so the board doesn't
re-block flows a second later.
