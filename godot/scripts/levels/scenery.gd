class_name Scenery
## Reusable set pieces shared by the levels.


## The NIC·XDP gate: a red frame with a scanline force field.
static func gate(width: float, height: float, pos: Vector3, label := "NIC · XDP") -> Node3D:
	var g := Node3D.new()
	g.position = pos
	var red := World.unshaded(Color("#ff3355"), 2.4)
	for sx in [-1, 1]:
		g.add_child(World.mesh_node(World.box(Vector3(0.5, height, 0.5)), red, Vector3(sx * width / 2, height / 2, 0)))
	g.add_child(World.mesh_node(World.box(Vector3(width + 0.5, 0.5, 0.5)), red, Vector3(0, height, 0)))
	var qm := QuadMesh.new()
	qm.size = Vector2(width, height)
	var cm := ShaderMaterial.new()
	cm.shader = load("res://shaders/curtain.gdshader")
	g.add_child(World.mesh_node(qm, cm, Vector3(0, height / 2, 0)))
	var l := World.label3d(label, 160, 0.012, Color(1.0, 0.33, 0.41) * 1.8, false)
	l.position.y = height + 2
	g.add_child(l)
	var light := OmniLight3D.new()
	light.light_color = Color("#ff3355")
	light.light_energy = 6
	light.omni_range = 40
	light.position = Vector3(0, 4, 3)
	g.add_child(light)
	return g


static func sun(pos: Vector3, size: float) -> MeshInstance3D:
	var qm := QuadMesh.new()
	qm.size = Vector2(size, size)
	var sm := ShaderMaterial.new()
	sm.shader = load("res://shaders/sun.gdshader")
	return World.mesh_node(qm, sm, pos)


## A glowing ring wall around the core: crossing it is a breach.
static func core_wall(radius: float, color := Color("#5fe0ff")) -> Node3D:
	var g := Node3D.new()
	g.add_child(World.mesh_node(World.torus(radius - 0.12, radius + 0.12), World.unshaded(color, 2.2), Vector3(0, 0.1, 0)))
	var cyl := World.cylinder(radius, radius, 2.5, 48)
	(cyl as CylinderMesh).cap_top = false
	(cyl as CylinderMesh).cap_bottom = false
	g.add_child(World.mesh_node(cyl, World.unshaded(color, 0.6, 0.12, true), Vector3(0, 1.25, 0)))
	return g
