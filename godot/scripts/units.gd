class_name Units
## Automated helpers: turrets you build (and can climb into) and AI
## gunships you call in. Both stand down on PANIC.

const TURRET_COST := 60
const TURRET_AMMO := 12
const TURRET_RANGE := [34.0, 34.0, 48.0]
const TURRET_COOLDOWN := [0.9, 0.55, 0.5]
const GUNSHIP_COST := 150
const GUNSHIP_LIFE := 40.0
const MAX_GUNSHIPS := 2


static func make_turret(pos: Vector3) -> Dictionary:
	var node := Node3D.new()
	node.position = pos
	var metal := World.emissive(Color("#6a80b8"), 0.25, 0.8)
	var rim := World.unshaded(Color("#9fe870"), 2.4)
	node.add_child(World.mesh_node(World.cylinder(0.95, 1.15, 0.5, 8), metal, Vector3(0, 0.25, 0)))
	var ring := World.mesh_node(World.torus(1.0, 1.12), rim, Vector3(0, 0.5, 0))
	ring.name = "Rim"
	node.add_child(ring)
	var pad := QuadMesh.new()
	pad.size = Vector2(3.2, 3.2)
	var padn := World.mesh_node(pad, World.unshaded(Color("#9fe870"), 1.2, 0.18, true), Vector3(0, 0.03, 0))
	padn.rotation_degrees.x = -90
	node.add_child(padn)
	var head := Node3D.new()
	head.name = "Head"
	head.position.y = 1.0
	head.add_child(World.mesh_node(World.sphere(0.55, 12, 6), metal))
	var barrel := World.mesh_node(World.cylinder(0.1, 0.12, 1.5, 8), metal, Vector3(0, 0.2, -0.85))
	barrel.rotation_degrees.x = 90
	head.add_child(barrel)
	head.add_child(World.mesh_node(World.torus(0.1, 0.16), rim, Vector3(0, 0.2, -1.6)))
	node.add_child(head)
	return {"node": node, "pos": pos, "cd": 0.0, "ammo": TURRET_AMMO, "rim": rim, "head": head, "stunned": 0.0}


static func set_turret_look(t: Dictionary, manned: bool) -> void:
	var c := Color("#ffb347") if manned else Color("#9fe870") if t.ammo > 0 and t.stunned <= 0.0 else Color("#3a4255")
	(t.rim as StandardMaterial3D).albedo_color = c * (2.4 if c != Color("#3a4255") else 1.0)


static func make_gunship(start: Vector3) -> Dictionary:
	var node := Node3D.new()
	node.position = start
	var body := World.emissive(Color("#5a6ea8"), 0.35, 0.8)
	var capsule := CapsuleMesh.new()
	capsule.radius = 0.8
	capsule.height = 3.4
	var hull := World.mesh_node(capsule, body)
	hull.rotation_degrees.x = 90
	node.add_child(hull)
	node.add_child(World.mesh_node(World.sphere(0.72, 12, 8), World.emissive(Color("#2a6aff"), 0.9, 0.3), Vector3(0, 0.15, -1.2)))
	var rotor := Node3D.new()
	rotor.name = "Rotor"
	rotor.position.y = 1.05
	for i in 2:
		var blade := World.mesh_node(World.box(Vector3(7.5, 0.05, 0.28)), World.unshaded(Color("#ffb347"), 1.0, 0.55, true))
		blade.rotation.y = i * PI / 2
		rotor.add_child(blade)
	node.add_child(rotor)
	var light := OmniLight3D.new()
	light.light_color = Color("#ffb347")
	light.light_energy = 3.0
	light.omni_range = 14
	light.position.y = -1.5
	node.add_child(light)
	node.scale = Vector3.ONE * 1.35
	return {"node": node, "pos": start, "vel": Vector3.ZERO, "life": GUNSHIP_LIFE, "state": "arrive", "gun": 0.0, "rocket": 1.5, "t": randf() * 10.0}
