class_name Lanes
## Traffic classification, kept in sync with web/js/lanes.js: which lane a
## packet runs in, and whether it looks suspicious.

const PROTO_ICMP := 1
const PROTO_TCP := 6
const PROTO_UDP := 17
const PROTO_ICMPV6 := 58

const LANES := [
	{"key": "https", "name": "HTTPS", "color": Color("#4f9dff")},
	{"key": "quic", "name": "QUIC", "color": Color("#9b7bff")},
	{"key": "http", "name": "HTTP", "color": Color("#3fd0c9")},
	{"key": "dns", "name": "DNS", "color": Color("#f5c542")},
	{"key": "ssh", "name": "SSH", "color": Color("#5fd068")},
	{"key": "icmp", "name": "ICMP", "color": Color("#ff8a3d")},
	{"key": "lan", "name": "LAN", "color": Color("#e86bd0")},
	{"key": "other", "name": "OTHER", "color": Color("#ff5468")},
]

const LAN_PORTS := [67, 68, 137, 138, 139, 546, 547, 1900, 5353, 5355]
const WELL_KNOWN := [20, 21, 22, 25, 53, 67, 68, 80, 110, 123, 137, 138, 139, 143, 443, 465, 546,
	547, 587, 853, 993, 995, 1900, 3478, 5228, 5353, 5355, 8080, 8443]


static func is_icmp(p: Dictionary) -> bool:
	return int(p.proto) == PROTO_ICMP or int(p.proto) == PROTO_ICMPV6


## The remote "service" port of an ingress packet.
static func service_port(p: Dictionary) -> int:
	var sp := int(p.sp)
	var dp := int(p.dp)
	if sp in WELL_KNOWN:
		return sp
	if dp in WELL_KNOWN:
		return dp
	return mini(sp, dp)


static func lane_index(key: String) -> int:
	for i in LANES.size():
		if LANES[i].key == key:
			return i
	return LANES.size() - 1


static func classify(p: Dictionary) -> int:
	if is_icmp(p):
		return lane_index("icmp")
	var proto := int(p.proto)
	var port := service_port(p)
	var key := "other"
	if int(p.sp) in LAN_PORTS or int(p.dp) in LAN_PORTS:
		key = "lan"
	elif port == 53 or port == 853:
		key = "dns"
	elif port == 22:
		key = "ssh"
	elif proto == PROTO_TCP and (port == 443 or port == 8443):
		key = "https"
	elif proto == PROTO_UDP and port == 443:
		key = "quic"
	elif proto == PROTO_TCP and (port == 80 or port == 8080):
		key = "http"
	return lane_index(key)


static func is_syn(p: Dictionary) -> bool:
	var f := int(p.flags)
	return int(p.proto) == PROTO_TCP and (f & 0x02) != 0 and (f & 0x10) == 0


## Unsolicited inbound connection attempts, pings, UDP to odd low ports.
static func is_suspicious(p: Dictionary) -> bool:
	if p.prot:
		return false
	var dp := int(p.dp)
	var sp := int(p.sp)
	if is_syn(p):
		return not (dp in WELL_KNOWN) or dp == 23
	if int(p.proto) == PROTO_ICMP:
		return dp == 8
	if int(p.proto) == PROTO_ICMPV6:
		return dp == 128
	if int(p.proto) == PROTO_UDP:
		return not (sp in WELL_KNOWN) and not (dp in WELL_KNOWN) and dp < 1024
	return false


static func host_port(addr: String, port: int) -> String:
	return "[%s]:%d" % [addr, port] if ":" in addr else "%s:%d" % [addr, port]


static func short_label(p: Dictionary) -> String:
	if is_icmp(p):
		return "%s t%d" % [p.src, int(p.dp)]
	return host_port(p.src, int(p.sp))


static func proto_name(p: Dictionary) -> String:
	match int(p.proto):
		PROTO_TCP: return "TCP"
		PROTO_UDP: return "UDP"
		PROTO_ICMP: return "ICMP"
		PROTO_ICMPV6: return "ICMPv6"
	return "IP%d" % int(p.proto)


## Stable per-flow hue so sprites of one flow look related.
static func flow_tint(id: String) -> Color:
	var h := 0
	for i in id.length():
		h = (h * 31 + id.unicode_at(i)) & 0x7fffffff
	return Color.from_hsv(float(h % 360) / 360.0, 0.85, 1.0)
