class_name GraphSpace
extends Level
## No floor, no lanes: your host floats in space as the hub of a live graph.
## Every remote host is a node, clustered by network (/16), and every flow
## is a glowing edge into your host. Packets travel along the edges; fly your
## ship through the graph to intercept them. Blocking a flow cuts its edge.

const SHELL := 80.0
const CORE_R := 5.0
const EDGE_IDLE := 12.0

var nodes := {} # remote ip -> {node, pos, last}
var edges := {} # flow id -> {node, last, color}
var hub: Node3D


func title() -> String:
	return "Graph Space"


func blurb() -> String:
	return "Your host is the hub of a live 3D graph of everyone it talks to. Fly through it and cut edges."


func player_mode() -> String:
	return "ship"


func play_radius() -> float:
	return SHELL * 1.4


func player_start() -> Vector3:
	return Vector3(0, 8, 30)


func help() -> String:
	return "WASD: fly · E/Q: up/down · Shift: boost · mouse: aim · wheel: zoom · click/Space: fire"


func cam_offset() -> Vector3:
	return Vector3(0, 14, 40)


func setup() -> void:
	world.env.fog_density = 0.002
	add_child(world.make_stars(1600, 220, 420, false))
	hub = world.make_core(CORE_R * 0.6)
	add_child(hub)
	# Faint orbit rings so the space has a sense of scale.
	for r in [25.0, 50.0, SHELL]:
		var ring := World.mesh_node(World.torus(r, r + 0.15), World.unshaded(Color("#2a3a7a"), 1.2))
		add_child(ring)


func _exit_tree() -> void:
	world.env.fog_density = 0.006


## Fibonacci-ish stable direction for a key.
static func _dir(key: String) -> Vector3:
	var h := hash(key)
	var u := float(h % 10007) / 10007.0
	var v := float((h / 10007) % 10009) / 10009.0
	var theta := u * TAU
	var z := v * 2.0 - 1.0
	var r := sqrt(1.0 - z * z)
	return Vector3(r * cos(theta), z * 0.7, r * sin(theta)).normalized()


static func _net16(addr: String) -> String:
	if ":" in addr:
		return ":".join(addr.split(":").slice(0, 2))
	var o := addr.split(".")
	return "%s.%s" % [o[0], o[1]]


func _node_for(pk: Dictionary) -> Dictionary:
	var ip: String = pk.p.src
	if nodes.has(ip):
		return nodes[ip]
	var center := _dir(_net16(ip)) * SHELL
	var pos := center + _dir(ip) * 9.0
	var color: Color = Lanes.LANES[pk.lane].color
	var n := Node3D.new()
	n.position = pos
	n.add_child(World.mesh_node(World.sphere(1.3, 12, 6), World.unshaded(color, 2.0)))
	n.add_child(World.mesh_node(World.sphere(2.2, 12, 6), World.unshaded(color, 0.6, 0.15, true)))
	var label := World.label3d(ip, 48, 0.015, color)
	label.position.y = 2.8
	n.add_child(label)
	add_child(n)
	var entry := {"node": n, "pos": pos, "last": 0.0}
	nodes[ip] = entry
	return entry


func _edge_for(pk: Dictionary, from: Vector3) -> void:
	var now := Time.get_ticks_msec() / 1000.0
	if edges.has(pk.id):
		edges[pk.id].last = now
		return
	var color: Color = Lanes.LANES[pk.lane].color
	var length := from.length()
	var e := World.mesh_node(World.cylinder(0.07, 0.07, 1.0, 5), World.unshaded(color, 1.2, 0.55, true))
	# Unit cylinder along Y, stretched from the remote node to the hub.
	var y := from.normalized()
	var x := y.cross(Vector3.UP if absf(y.y) < 0.95 else Vector3.RIGHT).normalized()
	e.transform = Transform3D(Basis(x, y * length, x.cross(y)), from * 0.5)
	add_child(e)
	edges[pk.id] = {"node": e, "last": now, "color": color}


func spawn(pk: Dictionary) -> void:
	var n := _node_for(pk)
	n.last = Time.get_ticks_msec() / 1000.0
	_edge_for(pk, n.pos)
	pk.from = n.pos
	pk.s = 0.0
	pk.len = n.pos.length()
	pk.speed *= 1.1
	pk.pos = n.pos


func move(pk: Dictionary, dt: float, t: float) -> void:
	pk.s = minf(1.0, pk.s + pk.speed * dt / pk.len)
	var p: Vector3 = pk.from * (1.0 - pk.s)
	# Spiral around the edge so trains of packets read as a stream.
	var axis: Vector3 = pk.from.normalized()
	var side := axis.cross(Vector3.UP if absf(axis.y) < 0.95 else Vector3.RIGHT).normalized()
	var up := axis.cross(side)
	var swirl: float = t * 3.0 + pk.phase
	pk.pos = p + (side * cos(swirl) + up * sin(swirl)) * 0.6


func radar_marks() -> Array:
	var out := []
	for n in nodes.values():
		out.append({"pos": n.pos, "color": Color("#5fe0ff", 0.7), "size": 2.5})
	return out


func reached_core(pk: Dictionary) -> bool:
	return pk.s >= 1.0 - CORE_R / pk.len


func should_merge(_newest: Dictionary, alive: int) -> bool:
	return alive >= 4


func tick(dt: float, t: float) -> void:
	var now := Time.get_ticks_msec() / 1000.0
	hub.rotation.y = t * 0.3
	for id in edges.keys():
		var e: Dictionary = edges[id]
		if now - e.last > EDGE_IDLE:
			e.node.queue_free()
			edges.erase(id)
	for ip in nodes.keys():
		var n: Dictionary = nodes[ip]
		if now - n.last > EDGE_IDLE * 3:
			n.node.queue_free()
			nodes.erase(ip)


## A blocked flow's edge flashes red and dies.
func on_flow_blocked(id: String) -> void:
	if not edges.has(id):
		return
	var e: Dictionary = edges[id]
	var mat := (e.node as MeshInstance3D).material_override as StandardMaterial3D
	mat.albedo_color = Color(3.0, 0.4, 0.6, 1.0)
	var tw := (e.node as Node).create_tween()
	var sc: Vector3 = (e.node as Node3D).scale
	tw.tween_property(e.node, "scale", Vector3(0.01, sc.y, 0.01), 0.6)
	tw.tween_callback((e.node as Node).queue_free)
	edges.erase(id)
