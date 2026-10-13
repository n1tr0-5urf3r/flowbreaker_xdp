class_name TopologyArena
extends Level
## Your host is a fortress in the middle of an open map. Every remote network
## your traffic comes from (an IPv4 /24 or an IPv6 /48) opens a portal on a
## ring around it, so the map grows out of your real traffic. Flows travel
## curving routes to the core: TCP as trains, UDP scattering, ICMP bouncing.
## Shoot a portal to block every live flow coming out of it.

const RING := 105.0
const CORE_R := 9.0
const PORTAL_HP := 25.0
const PORTAL_IDLE := 45.0

var portals := {} # prefix -> portal dict
var core: Node3D


func title() -> String:
	return "Topology Arena"


func blurb() -> String:
	return "Every remote network becomes a portal around your fortress. Flows snake in from all sides. Shoot a portal to cut off a whole network."


func play_radius() -> float:
	return RING + 15.0


func player_start() -> Vector3:
	return Vector3(0, 1, 22)


func cam_offset() -> Vector3:
	return Vector3(0, 72, 54)


func setup() -> void:
	var floor := world.make_floor(RING * 3.2, Vector3.ZERO)
	(floor.material_override as ShaderMaterial).set_shader_parameter("fade_k", 0.008)
	add_child(floor)
	add_child(world.make_stars(900, 220, 380))
	add_child(Scenery.core_wall(CORE_R))
	core = world.make_core(2.2)
	core.position.y = 4
	add_child(core)
	# Outer rim of the known internet.
	add_child(World.mesh_node(World.torus(RING + 6, RING + 6.3), World.unshaded(Color("#ff3355"), 1.4), Vector3(0, 0.05, 0)))


static func prefix_of(addr: String) -> String:
	if ":" in addr:
		var parts := addr.split(":")
		return ":".join(parts.slice(0, 3)) + "::/48"
	var o := addr.split(".")
	return "%s.%s.%s.0/24" % [o[0], o[1], o[2]]


func _portal_for(pk: Dictionary) -> Dictionary:
	var key := prefix_of(pk.p.src)
	if portals.has(key):
		return portals[key]
	# Stable angle per network, nudged so portals don't overlap.
	var angle := float(hash(key) % 3600) / 3600.0 * TAU
	var r := RING - float(hash(key + "r") % 20)
	var pos := Vector3(cos(angle) * r, 0, sin(angle) * r)
	for _i in 24:
		var clash := false
		for other in portals.values():
			if other.pos.distance_to(pos) < 13.0:
				clash = true
				break
		if not clash:
			break
		angle += 0.21
		pos = Vector3(cos(angle) * r, 0, sin(angle) * r)
	var color: Color = Lanes.LANES[pk.lane].color
	var node := Node3D.new()
	node.transform = Transform3D(Basis.looking_at(-pos.normalized(), Vector3.UP), pos) # facing the core
	var ring := World.mesh_node(World.torus(2.6, 3.1), World.unshaded(color, 2.2))
	ring.rotation_degrees.x = 90
	ring.position.y = 3.4
	ring.name = "Ring"
	node.add_child(ring)
	var disc := QuadMesh.new()
	disc.size = Vector2(5, 5)
	node.add_child(World.mesh_node(disc, World.unshaded(color, 0.8, 0.25, true), Vector3(0, 3.4, 0)))
	var beam := World.mesh_node(World.cylinder(0.15, 0.6, 30, 8), World.unshaded(color, 1.0, 0.18, true), Vector3(0, 15, 0))
	node.add_child(beam)
	var label := World.label3d(key, 64, 0.02, color)
	label.position.y = 8
	label.name = "Label"
	node.add_child(label)
	add_child(node)
	var portal := {"key": key, "pos": pos, "node": node, "color": color, "hp": PORTAL_HP,
		"last": 0.0, "flows": {}, "sus": 0, "total": 0, "prot_only": true, "label": label}
	portals[key] = portal
	return portal


func spawn(pk: Dictionary) -> void:
	var portal := _portal_for(pk)
	var now := Time.get_ticks_msec() / 1000.0
	portal.last = now
	portal.flows[pk.id] = now
	portal.total += 1
	if pk.suspicious:
		portal.sus += 1
	if not pk.p.prot:
		portal.prot_only = false
	pk.portal = portal.key
	# Each flow gets its own curve (stable per flow id), so a TCP connection
	# arrives as a train of packets following the same route.
	var a: Vector3 = portal.pos + Vector3(0, 3.4, 0)
	var b: Vector3 = portal.pos.normalized() * CORE_R
	var side := Vector3(-b.z, 0, b.x).normalized()
	var bend := float(hash(pk.id) % 70) - 35.0
	pk.a = a
	pk.b = b
	pk.c = (a + b) * 0.5 + side * bend + Vector3(0, 6, 0)
	pk.s = 0.0
	pk.len = a.distance_to(b) * 1.2
	pk.speed *= 1.35
	pk.pos = a


func _bezier(pk: Dictionary, s: float) -> Vector3:
	var u := 1.0 - s
	return pk.a * u * u + pk.c * 2.0 * u * s + pk.b * s * s


func move(pk: Dictionary, dt: float, t: float) -> void:
	pk.s = minf(1.0, pk.s + pk.speed * dt / pk.len)
	var p := _bezier(pk, pk.s)
	var ground := lerpf(p.y, pk.y, smoothstep(0.0, 0.3, pk.s)) # drop from the portal to the ground
	if Lanes.is_icmp(pk.p):
		p.y = pk.y + absf(sin(pk.s * PI * 10.0)) * 4.0 # pings bounce in
	elif int(pk.p.proto) == Lanes.PROTO_UDP:
		var side := Vector3(-pk.b.z, 0, pk.b.x).normalized()
		p += side * sin(t * 1.7 + pk.phase) * 3.0 * sin(pk.s * PI) # UDP scatters
		p.y = ground + sin(t * 3.0 + pk.phase) * 0.8 * sin(pk.s * PI)
	else:
		p.y = ground # TCP rolls in on the ground
	pk.pos = p


func reached_core(pk: Dictionary) -> bool:
	return pk.s >= 1.0


## TCP flows arrive as trains of up to 6 cars; others as small groups.
func should_merge(newest: Dictionary, alive: int) -> bool:
	return alive >= (6 if int(newest.p.proto) == Lanes.PROTO_TCP else 3)


func tick(dt: float, t: float) -> void:
	var now := Time.get_ticks_msec() / 1000.0
	core.rotation.y = t * 0.3
	for key in portals.keys():
		var portal: Dictionary = portals[key]
		var ring := portal.node.get_node("Ring") as Node3D
		ring.rotation.y += dt * 1.5
		var idle: float = now - portal.last
		var label := portal.label as Label3D
		if portal.sus * 3 > portal.total and portal.total >= 3:
			label.text = "%s  ⚠ SCANNER" % key
			label.modulate = Color("#ff3355")
		portal.node.scale = Vector3.ONE * clampf(1.0 - (idle - PORTAL_IDLE) / 10.0, 0.0, 1.0) * (1.0 + minf(portal.total, 60) / 60.0 * 0.6)
		if idle > PORTAL_IDLE + 10.0:
			portal.node.queue_free()
			portals.erase(key)


func radar_marks() -> Array:
	var out := []
	for portal in portals.values():
		out.append({"pos": portal.pos, "color": portal.color, "size": 5.0})
	return out


func targets() -> Array:
	var out := []
	for portal in portals.values():
		var p: Dictionary = portal
		out.append({"pos": p.pos + Vector3(0, 3.4, 0), "r": 3.4, "hit": func(dmg): _hit_portal(p, dmg)})
	return out


func _hit_portal(portal: Dictionary, dmg: float) -> void:
	if not portals.has(portal.key):
		return
	if portal.prot_only:
		world.explode(portal.pos + Vector3(0, 3.4, 0), Color("#7fe7ff"), 16, 5)
		game.hud.toast("%s only carries protected flows" % portal.key, Color("#7fe7ff"))
		return
	portal.hp -= dmg
	world.explode(portal.pos + Vector3(0, 3.4, 0), portal.color, 10, 5)
	if portal.hp > 0:
		return
	# Portal down: block every live flow from this network.
	var now := Time.get_ticks_msec() / 1000.0
	var n := 0
	for id in portal.flows.keys():
		if now - portal.flows[id] < 30.0 and game.request_kill(id):
			n += 1
	world.explode(portal.pos + Vector3(0, 4, 0), portal.color, 120, 18)
	world.shake = 0.5
	game.score += 100
	game.credits += 50
	game.profile.unlock("portal")
	game.hud.show_banner("NETWORK %s CUT OFF · %d flows" % [portal.key, n], portal.color)
	portal.node.queue_free()
	portals.erase(portal.key)
