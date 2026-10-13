class_name DemoSim
extends Node
## Local stand-in for the daemon (port of the simulator in web/js/net.js).
## Emits the same messages, so the game code can't tell the difference.

signal message(msg: Dictionary)

const TTL := 60.0
var flows: Array[Dictionary] = []
var all := {} # every flow ever emitted, like the daemon's registry
var blocked := {} # id -> {label, drops, expires}
var stats := {"seen": 0, "sampled": 0, "dropped": 0, "protected": 0, "rbFull": 0}
var _tick := 0.0
var _slow := 0.0


func _ready() -> void:
	call_deferred("_hello")
	for i in 14:
		flows.append(_random_flow())


func _hello() -> void:
	message.emit({"t": "hello", "hello": {"iface": "demo0", "mode": "simulated",
		"protect": ["tcp:22", "tcp:53", "udp:53", "udp:67-68", "udp:546-547", "icmpv6:133-137"],
		"protectHosts": ["api.anthropic.com", "claude.ai"], "ttl": TTL, "maxEps": 150}})


func _ip() -> String:
	return "%d.%d.%d.%d" % [randi_range(1, 222), randi_range(0, 255), randi_range(0, 255), randi_range(1, 253)]


func _random_flow() -> Dictionary:
	var r := randf()
	var eph := randi_range(32768, 60999)
	var f: Dictionary
	if r < 0.35: f = {"proto": 6, "sp": 443, "dp": eph, "flags": 0x18}
	elif r < 0.5: f = {"proto": 17, "sp": 443, "dp": eph, "flags": 0}
	elif r < 0.58: f = {"proto": 6, "sp": 80, "dp": eph, "flags": 0x10}
	elif r < 0.68: f = {"proto": 17, "sp": 53, "dp": eph, "flags": 0, "prot": true}
	elif r < 0.72: f = {"proto": 6, "sp": eph, "dp": 22, "flags": 0x10, "prot": true}
	elif r < 0.8: f = {"proto": 1, "sp": 0, "dp": [0, 8].pick_random(), "flags": 0}
	elif r < 0.87: f = {"proto": 17, "sp": 5353, "dp": 5353, "flags": 0, "src": "192.168.1.%d" % randi_range(2, 250)}
	elif r < 0.94: f = {"proto": 6, "sp": eph, "dp": [23, 445, 3389, 8081].pick_random(), "flags": 0x02}
	else: f = {"proto": 17, "sp": eph, "dp": [111, 161, 500].pick_random(), "flags": 0}
	f.src = f.get("src", _ip())
	f.dst = "192.168.1.42"
	f.id = "%012x" % (randi() * 65536 + randi() % 65536)
	f.prot = f.get("prot", false)
	f.rate = randf_range(0.3, 3.3)
	f.life = randf_range(5.0, 45.0)
	f.len = 1500 if f.proto == 6 and f.sp == 443 else randi_range(60, 460)
	all[f.id] = f
	return f


func _label(f: Dictionary) -> String:
	if f.proto == 1:
		return "icmp type %d %s → %s" % [f.dp, f.src, f.dst]
	return "%s %s:%d → %s:%d" % ["tcp" if f.proto == 6 else "udp", f.src, f.sp, f.dst, f.dp]


func _process(delta: float) -> void:
	_tick += delta
	_slow += delta
	if _tick >= 0.1:
		_tick = 0.0
		var pkts := []
		for f in flows:
			f.life -= 0.1
			stats.seen += randi_range(1, 20)
			if randf() >= f.rate * 0.1:
				continue
			if blocked.has(f.id) and not f.prot:
				blocked[f.id].drops += randi_range(1, 8)
				stats.dropped += 1
				continue
			stats.sampled += 1
			pkts.append({"id": f.id, "src": f.src, "dst": f.dst, "sp": f.sp, "dp": f.dp,
				"proto": f.proto, "len": f.len, "flags": f.flags, "prot": f.prot})
		flows = flows.filter(func(f): return f.life > 0)
		while flows.size() < 14:
			flows.append(_random_flow())
		if not pkts.is_empty():
			message.emit({"t": "batch", "pkts": pkts})
	if _slow >= 0.5:
		_slow = 0.0
		var now := Time.get_ticks_msec() / 1000.0
		var rules := []
		for id in blocked.keys():
			var b: Dictionary = blocked[id]
			if b.expires <= now:
				blocked.erase(id)
				continue
			rules.append({"id": id, "label": b.label, "drops": b.drops, "expiresIn": b.expires - now})
		message.emit({"t": "stats", "stats": stats.duplicate()})
		message.emit({"t": "rules", "rules": rules})


func handle(m: Dictionary) -> void:
	var f: Dictionary = all.get(m.get("id", ""), {})
	match m.t:
		"kill":
			if f.is_empty():
				message.emit({"t": "error", "id": m.id, "msg": "unknown flow"})
			elif f.prot:
				message.emit({"t": "deflect", "id": m.id, "label": _label(f)})
			else:
				var drops: int = blocked[m.id].drops if blocked.has(m.id) else 0
				blocked[m.id] = {"label": _label(f), "drops": drops, "expires": Time.get_ticks_msec() / 1000.0 + TTL}
				message.emit({"t": "killed", "id": m.id, "label": _label(f)})
		"unblock":
			blocked.erase(m.id)
		"panic":
			var n := blocked.size()
			blocked.clear()
			message.emit({"t": "panicked", "n": n})
