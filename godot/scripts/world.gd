class_name World
extends Node3D
## Level-independent scene parts: environment, camera, materials and the
## factories for packets, bolts and explosions. Each level (scripts/levels/)
## builds its own geometry and drives the camera through `cam_target`.

var camera: Camera3D
var cam_target := Transform3D.IDENTITY
var shake := 0.0
var env: Environment
var _lane_mats: Array[StandardMaterial3D] = []
var _meshes := {}
var _glow_mat: ShaderMaterial


static func emissive(color: Color, energy := 2.0, albedo_k := 0.25) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = color * albedo_k
	m.emission_enabled = true
	m.emission = color
	m.emission_energy_multiplier = energy
	m.metallic = 0.4
	m.roughness = 0.35
	return m


static func unshaded(color: Color, energy := 1.0, alpha := 1.0, add := false) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	m.albedo_color = Color(color.r * energy, color.g * energy, color.b * energy, alpha)
	if alpha < 1.0 or add:
		m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	if add:
		m.blend_mode = BaseMaterial3D.BLEND_MODE_ADD
	return m


static func sphere(r: float, seg: int, rings: int) -> Mesh:
	var m := SphereMesh.new()
	m.radius = r
	m.height = r * 2
	m.radial_segments = seg
	m.rings = rings
	return m


static func box(size: Vector3) -> Mesh:
	var m := BoxMesh.new()
	m.size = size
	return m


static func cylinder(top: float, bottom: float, height: float, seg: int) -> Mesh:
	var m := CylinderMesh.new()
	m.top_radius = top
	m.bottom_radius = bottom
	m.height = height
	m.radial_segments = seg
	return m


static func torus(inner: float, outer: float) -> Mesh:
	var m := TorusMesh.new()
	m.inner_radius = inner
	m.outer_radius = outer
	return m


static func mesh_node(mesh: Mesh, mat: Material, pos := Vector3.ZERO) -> MeshInstance3D:
	var n := MeshInstance3D.new()
	n.mesh = mesh
	n.material_override = mat
	n.position = pos
	return n


static func label3d(text: String, size: int, pixel: float, color: Color, billboard := true) -> Label3D:
	var l := Label3D.new()
	l.text = text
	l.font_size = size
	l.pixel_size = pixel
	l.modulate = color
	l.outline_size = 10
	if billboard:
		l.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	return l


func _ready() -> void:
	env = Environment.new()
	env.background_mode = Environment.BG_COLOR
	env.background_color = Color(0.02, 0.024, 0.06)
	env.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	env.ambient_light_color = Color(0.25, 0.3, 0.6)
	env.ambient_light_energy = 0.6
	env.tonemap_mode = Environment.TONE_MAPPER_ACES
	env.glow_enabled = true
	env.glow_intensity = 0.9
	env.glow_bloom = 0.08
	env.glow_hdr_threshold = 0.9
	env.glow_blend_mode = Environment.GLOW_BLEND_MODE_ADDITIVE
	for i in [1, 3, 5]:
		env.set_glow_level(i, 1.0)
	env.fog_enabled = true
	env.fog_light_color = Color(0.03, 0.035, 0.1)
	env.fog_density = 0.006
	var we := WorldEnvironment.new()
	we.environment = env
	add_child(we)
	var key := DirectionalLight3D.new()
	key.light_color = Color(0.75, 0.84, 1.0)
	key.light_energy = 0.6
	key.rotation_degrees = Vector3(-55, 20, 0)
	add_child(key)
	camera = Camera3D.new()
	camera.fov = 50
	camera.far = 900
	add_child(camera)
	for l in Lanes.LANES:
		_lane_mats.append(emissive(l.color, 0.8, 0.35))
	var capsule := CapsuleMesh.new()
	capsule.radius = 0.42
	capsule.height = 1.75
	capsule.radial_segments = 10
	capsule.rings = 3
	_meshes = {
		"tcp": capsule,
		"udp": sphere(0.75, 4, 2),
		"icmp": sphere(0.65, 10, 6),
		"other": cylinder(0.7, 0.7, 1.0, 6),
	}
	_glow_mat = ShaderMaterial.new()
	_glow_mat.shader = load("res://shaders/glow.gdshader")


func _process(delta: float) -> void:
	# Levels set cam_target before this runs (Main processes before World).
	var t := cam_target
	if shake > 0.0:
		shake -= delta
		t = t.translated_local(Vector3(randf_range(-0.4, 0.4), randf_range(-0.4, 0.4), 0))
	camera.global_transform = camera.global_transform.interpolate_with(t, minf(1.0, delta * 10.0)) if shake <= 0.0 else t


func snap_camera() -> void:
	camera.global_transform = cam_target


# ----------------------------------------------------------- scenery

## Neon grid floor (used by the ground levels).
func make_floor(size: float, center: Vector3, color := Color(0.16, 0.36, 1.0)) -> MeshInstance3D:
	var plane := PlaneMesh.new()
	plane.size = Vector2(size, size)
	var mat := ShaderMaterial.new()
	mat.shader = load("res://shaders/grid.gdshader")
	mat.set_shader_parameter("line_color", color)
	mat.set_shader_parameter("center", Vector2(center.x, center.z))
	var floor := mesh_node(plane, mat, center + Vector3(0, -0.01, 0))
	return floor


func make_stars(count: int, inner: float, outer: float, upper_only := true) -> MultiMeshInstance3D:
	var stars := MultiMeshInstance3D.new()
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.mesh = sphere(0.25, 4, 2)
	mm.instance_count = count
	for i in count:
		var d := Vector3(randf_range(-1, 1), randf_range(0.05 if upper_only else -1.0, 1), randf_range(-1, 1)).normalized()
		mm.set_instance_transform(i, Transform3D(Basis().scaled(Vector3.ONE * randf_range(0.6, 2.0)), d * randf_range(inner, outer)))
	stars.multimesh = mm
	stars.material_override = unshaded(Color(0.55, 0.6, 1.0), 1.4)
	return stars


## The host core: a glowing sphere with a ring and a light.
func make_core(radius := 1.2) -> Node3D:
	var host := Node3D.new()
	var core := mesh_node(sphere(radius, 10, 6), unshaded(Color("#5fe0ff"), 1.3))
	core.name = "Core"
	host.add_child(core)
	host.add_child(mesh_node(torus(radius * 2.4, radius * 2.55), unshaded(Color("#5fe0ff"), 1.2)))
	var light := OmniLight3D.new()
	light.light_color = Color("#5fe0ff")
	light.light_energy = 2
	light.omni_range = radius * 20
	host.add_child(light)
	var label := label3d("HOST", 96, 0.01, Color.WHITE)
	label.position.y = -radius * 2.2
	host.add_child(label)
	return host


# ----------------------------------------------------------- entities

## Swap a live packet's body for the current skin choice.
func reskin(g: Node3D, p: Dictionary, lane: int, scale: float) -> void:
	var old := g.get_node_or_null("Body")
	if old:
		g.remove_child(old)
		old.queue_free()
	var body := Skins.build(Skins.skin_for(lane), p, Lanes.LANES[lane].color, Lanes.flow_tint(p.id), _meshes[Skins.shape_of(p)])
	body.scale = Vector3.ONE * scale
	body.name = "Body"
	g.add_child(body)


## Packet body (skinned), flow tint, shield/warning rings, address label.
func make_packet(p: Dictionary, lane: int, suspicious: bool, scale: float) -> Node3D:
	var g := Node3D.new()
	var body := Skins.build(Skins.skin_for(lane), p, Lanes.LANES[lane].color, Lanes.flow_tint(p.id), _meshes[Skins.shape_of(p)])
	body.scale = Vector3.ONE * scale
	body.name = "Body"
	g.add_child(body)
	g.add_child(mesh_node(sphere(0.18, 6, 3), unshaded(Lanes.flow_tint(p.id), 2.0), Vector3(0, 0.8 * scale + 0.2, 0)))
	if p.prot:
		g.add_child(mesh_node(sphere(1.45 * scale, 12, 6), unshaded(Color("#7fe7ff"), 1.0, 0.16, true)))
	if suspicious:
		var warn := mesh_node(torus(1.1 * scale, 1.2 * scale), unshaded(Color("#ff3355"), 3.0))
		warn.name = "Warn"
		g.add_child(warn)
	var label := label3d(Lanes.short_label(p), 40, 0.01, Color(0.8, 0.85, 0.95))
	label.position.y = 1.25 * scale + 0.8
	label.name = "Label"
	g.add_child(label)
	add_child(g)
	return g


func make_bolt(color: Color) -> MeshInstance3D:
	var b := mesh_node(cylinder(0.08, 0.08, 2.4, 6), unshaded(color, 3.0))
	add_child(b)
	return b


## One-shot particle burst plus a short light flash.
func explode(pos: Vector3, color: Color, amount := 48, speed := 9.0) -> void:
	var p := CPUParticles3D.new()
	p.one_shot = true
	p.explosiveness = 1.0
	p.amount = amount
	p.lifetime = 0.8
	var dot := sphere(0.08, 4, 2) as SphereMesh
	dot.material = _glow_mat
	p.mesh = dot
	p.emission_shape = CPUParticles3D.EMISSION_SHAPE_SPHERE
	p.emission_sphere_radius = 0.3
	p.direction = Vector3.UP
	p.spread = 180
	p.initial_velocity_min = speed * 0.3
	p.initial_velocity_max = speed
	p.gravity = Vector3(0, -9, 0)
	p.damping_min = 2
	p.damping_max = 5
	var ramp := Gradient.new()
	ramp.set_color(0, Color(color, 1.0))
	ramp.set_color(1, Color(color, 0.0))
	p.color_ramp = ramp
	p.scale_amount_min = 0.6
	p.scale_amount_max = 1.6
	add_child(p)
	p.global_position = pos
	p.emitting = true
	p.finished.connect(p.queue_free)
	var light := OmniLight3D.new()
	light.light_color = color
	light.light_energy = 8
	light.omni_range = 12
	add_child(light)
	light.global_position = pos + Vector3.UP
	var tw := light.create_tween()
	tw.tween_property(light, "light_energy", 0.0, 0.35)
	tw.tween_callback(light.queue_free)


## Expanding ring + flash sphere for explosions with a blast radius.
func shockwave(pos: Vector3, radius: float, color: Color) -> void:
	var ring := mesh_node(torus(0.85, 1.0), unshaded(color, 3.0, 0.9, true))
	add_child(ring)
	ring.global_position = Vector3(pos.x, maxf(0.15, pos.y * 0.3), pos.z)
	ring.scale = Vector3.ONE * 0.2
	var flash := mesh_node(sphere(1.0, 12, 6), unshaded(color, 4.0, 0.8, true))
	add_child(flash)
	flash.global_position = pos
	flash.scale = Vector3.ONE * radius * 0.3
	var tw := ring.create_tween().set_parallel()
	tw.tween_property(ring, "scale", Vector3.ONE * radius, 0.45).set_ease(Tween.EASE_OUT)
	tw.tween_property(ring.material_override, "albedo_color:a", 0.0, 0.45)
	tw.chain().tween_callback(ring.queue_free)
	var tf := flash.create_tween().set_parallel()
	tf.tween_property(flash, "scale", Vector3.ONE * radius * 0.7, 0.22)
	tf.tween_property(flash.material_override, "albedo_color:a", 0.0, 0.22)
	tf.chain().tween_callback(flash.queue_free)


## Point where the mouse ray meets a plane, or null.
func pick_plane(screen: Vector2, plane: Plane) -> Variant:
	return plane.intersects_ray(camera.project_ray_origin(screen), camera.project_ray_normal(screen))
