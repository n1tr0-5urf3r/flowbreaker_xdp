class_name Skins
## Packet skins (port of web/js/skins.js). A skin builds one packet body
## about a unit in radius, facing +Z. Each varies by protocol and carries the
## per-flow tint somewhere so samples of one flow still look related.
## Choices are saved to user://skins.json.

const NAMES := {
	"neon": "Neon shapes", "invaders": "Space Invaders", "critters": "Critters",
	"ghosts": "Ghosts", "crystals": "Crystals", "ducks": "Rubber ducks",
}
const ORDER := ["neon", "invaders", "critters", "ghosts", "crystals", "ducks"]
const PATH := "user://skins.json"

static var global := "neon"
static var per_lane := {} # lane key -> skin key
static var _loaded := false
static var _cache := {}

const INVADERS := {
	"tcp": ["..X.....X..", "...X...X...", "..XXXXXXX..", ".XX.XXX.XX.", "XXXXXXXXXXX", "X.XXXXXXX.X", "X.X.....X.X", "...XX.XX..."],
	"udp": ["...XX...", "..XXXX..", ".XXXXXX.", "XX.XX.XX", "XXXXXXXX", "..X..X..", ".X.XX.X.", "X.X..X.X"],
	"icmp": ["....XXXX....", ".XXXXXXXXXX.", "XXXXXXXXXXXX", "XXX..XX..XXX", "XXXXXXXXXXXX", "...XX..XX...", "..XX.XX.XX..", "XX........XX"],
}


static func load_settings() -> void:
	if _loaded:
		return
	_loaded = true
	if FileAccess.file_exists(PATH):
		var s = JSON.parse_string(FileAccess.get_file_as_string(PATH))
		if s is Dictionary:
			if NAMES.has(s.get("global", "")):
				global = s.global
			if s.get("lanes") is Dictionary:
				for k in s.lanes:
					if NAMES.has(s.lanes[k]):
						per_lane[k] = s.lanes[k]


static func save() -> void:
	var f := FileAccess.open(PATH, FileAccess.WRITE)
	if f:
		f.store_string(JSON.stringify({"global": global, "lanes": per_lane}))


static func skin_for(lane: int) -> String:
	load_settings()
	return per_lane.get(Lanes.LANES[lane].key, global)


static func shape_of(p: Dictionary) -> String:
	if int(p.proto) == Lanes.PROTO_TCP:
		return "tcp"
	if int(p.proto) == Lanes.PROTO_UDP:
		return "udp"
	return "icmp" if Lanes.is_icmp(p) else "other"


# ---------------------------------------------------------- materials

static func _mat(key: String, make: Callable) -> Material:
	if not _cache.has(key):
		_cache[key] = make.call()
	return _cache[key]


static func body_mat(c: Color, k := 0.8) -> Material:
	return _mat("body%s%f" % [c.to_html(), k], func(): return World.emissive(c, k, 0.35))


static func soft_mat(c: Color) -> Material:
	return _mat("soft" + c.to_html(), func():
		var m := StandardMaterial3D.new()
		m.albedo_color = c * 0.6
		m.emission_enabled = true
		m.emission = c
		m.emission_energy_multiplier = 0.45
		m.roughness = 0.55
		return m)


static func plain(c: Color) -> Material:
	return _mat("plain" + c.to_html(), func():
		var m := StandardMaterial3D.new()
		m.albedo_color = c
		m.roughness = 0.3
		return m)


static func glow(c: Color, k := 2.0) -> Material:
	return _mat("glow%s%f" % [c.to_html(), k], func(): return World.unshaded(c, k))


static func _eyes(g: Node3D, x := 0.32, y := 0.25, z := 0.7, r := 0.22, pupil := Color("#0b0f1a")) -> void:
	for sx in [-1, 1]:
		g.add_child(World.mesh_node(World.sphere(r, 12, 8), plain(Color.WHITE), Vector3(sx * x, y, z)))
		g.add_child(World.mesh_node(World.sphere(r * 0.5, 10, 6), plain(pupil), Vector3(sx * x, y, z + r * 0.65)))


# -------------------------------------------------------------- build

## Returns the packet body. `no_spin` in its metadata asks Main to keep it
## facing its direction of travel instead of tumbling.
static func build(key: String, p: Dictionary, color: Color, tint: Color, neon_mesh: Mesh) -> Node3D:
	var g := Node3D.new()
	match key:
		"invaders": _invader(g, p, color, tint)
		"critters": _critter(g, p, color, tint)
		"ghosts": _ghost(g, color, tint)
		"crystals": _crystal(g, p, color, tint)
		"ducks": _duck(g, color, tint)
		_:
			var body := World.mesh_node(neon_mesh, body_mat(color))
			if shape_of(p) == "tcp":
				body.rotation_degrees.z = 90
			g.add_child(body)
	g.set_meta("no_spin", key != "neon" and key != "crystals")
	return g


static func _invader(g: Node3D, p: Dictionary, color: Color, tint: Color) -> void:
	var rows: Array = INVADERS.get(shape_of(p), INVADERS.tcp)
	var px: float = 1.9 / float(rows[0].length())
	var cells := []
	for y in rows.size():
		for x in rows[y].length():
			if rows[y][x] == "X":
				cells.append(Vector2(x, y))
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.mesh = World.box(Vector3(px * 0.92, px * 0.92, px * 1.6))
	mm.instance_count = cells.size()
	for i in cells.size():
		var c: Vector2 = cells[i]
		mm.set_instance_transform(i, Transform3D(Basis(), Vector3((c.x - (rows[0].length() - 1) / 2.0) * px, ((rows.size() - 1) / 2.0 - c.y) * px, 0)))
	var mi := MultiMeshInstance3D.new()
	mi.multimesh = mm
	mi.material_override = body_mat(color, 1.1)
	g.add_child(mi)
	g.add_child(World.mesh_node(World.box(Vector3(0.3, 0.12, 0.3)), glow(tint), Vector3(0, -0.95, 0)))


static func _critter(g: Node3D, p: Dictionary, color: Color, tint: Color) -> void:
	var body := World.mesh_node(World.sphere(0.8, 18, 12), soft_mat(color))
	body.scale = Vector3(1.05, 0.85, 1.0)
	g.add_child(body)
	if shape_of(p) == "icmp":
		g.add_child(World.mesh_node(World.sphere(0.34, 14, 10), plain(Color.WHITE), Vector3(0, 0.2, 0.62)))
		g.add_child(World.mesh_node(World.sphere(0.17, 10, 8), plain(Color("#0b0f1a")), Vector3(0, 0.2, 0.9)))
	else:
		_eyes(g, 0.32, 0.25, 0.62)
	for sx in [-1, 1]:
		if shape_of(p) == "udp":
			var horn := World.mesh_node(World.cylinder(0.0, 0.12, 0.5, 8), glow(tint, 1.6), Vector3(sx * 0.45, 0.8, 0))
			horn.rotation.z = -sx * 0.4
			g.add_child(horn)
		else:
			var stalk := World.mesh_node(World.cylinder(0.03, 0.03, 0.6, 5), plain(Color("#222a3a")), Vector3(sx * 0.25, 0.9, 0))
			stalk.rotation.z = -sx * 0.35
			g.add_child(stalk)
			g.add_child(World.mesh_node(World.sphere(0.1, 8, 6), glow(tint, 2.5), Vector3(sx * 0.37, 1.2, 0)))
	for i in 4:
		g.add_child(World.mesh_node(World.sphere(0.16, 8, 6), soft_mat(color), Vector3((1 if i % 2 else -1) * 0.4, -0.68, 0.3 if i < 2 else -0.3)))


static func _ghost(g: Node3D, color: Color, tint: Color) -> void:
	var mat := _mat("ghost" + color.to_html(), func():
		var m := World.emissive(color, 0.8, 0.5)
		m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		m.albedo_color.a = 0.82
		return m)
	var head := SphereMesh.new()
	head.radius = 0.8
	head.height = 1.6
	head.is_hemisphere = true
	g.add_child(World.mesh_node(head, mat, Vector3(0, 0.1, 0)))
	var skirt := World.cylinder(0.8, 0.85, 0.9, 18) as CylinderMesh
	skirt.cap_top = false
	skirt.cap_bottom = false
	g.add_child(World.mesh_node(skirt, mat, Vector3(0, -0.35, 0)))
	for i in 6:
		var a := float(i) / 6 * TAU
		var tent := World.mesh_node(World.cylinder(0.22, 0.0, 0.35, 8), mat, Vector3(cos(a) * 0.62, -0.95, sin(a) * 0.62))
		g.add_child(tent)
	_eyes(g, 0.32, 0.25, 0.62, 0.2, tint)


static func _crystal(g: Node3D, p: Dictionary, color: Color, tint: Color) -> void:
	var mat := _mat("crystal" + color.to_html(), func():
		var m := World.emissive(color, 0.7, 0.4)
		m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
		m.albedo_color.a = 0.85
		m.roughness = 0.05
		return m)
	var shard := World.sphere(0.5, 4, 2)
	var parts: Array = [[0, 0, 0, 1.0], [0, 0, 0, 0.75]]
	match shape_of(p):
		"udp": parts = [[0, 0, 0, 1.0], [0.45, -0.2, 0.1, 0.6], [-0.4, -0.25, -0.1, 0.55]]
		"icmp": parts = [[0, 0, 0, 0.7], [0.6, 0, 0, 0.45], [-0.6, 0, 0, 0.45], [0, 0, 0.6, 0.45], [0, 0, -0.6, 0.45]]
	for i in parts.size():
		var q: Array = parts[i]
		var m := World.mesh_node(shard, mat, Vector3(q[0], q[1], q[2]))
		m.scale = Vector3(q[3], q[3] * 2.0, q[3])
		if shape_of(p) == "tcp" and i == 1:
			m.rotation.x = PI / 2
		g.add_child(m)
	g.add_child(World.mesh_node(World.sphere(0.18, 6, 3), glow(tint, 3.0)))


static func _duck(g: Node3D, color: Color, tint: Color) -> void:
	var body := World.mesh_node(World.sphere(0.75, 18, 12), soft_mat(color))
	body.scale = Vector3(1.0, 0.75, 1.25)
	g.add_child(body)
	g.add_child(World.mesh_node(World.sphere(0.45, 16, 12), soft_mat(color), Vector3(0, 0.62, 0.55)))
	var beak := World.mesh_node(World.cylinder(0.0, 0.17, 0.42, 10), plain(Color("#ff8a1d")), Vector3(0, 0.55, 1.05))
	beak.rotation.x = PI / 2
	beak.scale = Vector3(1.4, 1.0, 0.6)
	g.add_child(beak)
	var tail := World.mesh_node(World.cylinder(0.0, 0.25, 0.5, 8), soft_mat(color), Vector3(0, 0.3, -0.95))
	tail.rotation.x = -PI / 3
	g.add_child(tail)
	var bow := World.mesh_node(World.torus(0.21, 0.35), glow(tint, 1.8), Vector3(0, 0.25, 0.5))
	bow.rotation.x = PI / 2.4
	g.add_child(bow)
	_eyes(g, 0.2, 0.75, 0.88, 0.09)
