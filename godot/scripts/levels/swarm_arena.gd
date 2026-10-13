class_name SwarmArena
extends Level
## A walled arena full of pillars. Packets pour in from every edge as flocks
## (boids): they seek the core, keep their distance, steer around pillars
## and fly with others of their protocol. TCP crawls along the ground,
## UDP and ICMP come in through the air.

const HALF := 100.0
const CORE_R := 8.0
const NEIGHBOUR := 7.0

var pillars: Array[Vector3] = [] # x, z, radius in y


func title() -> String:
	return "Swarm Arena"


func blurb() -> String:
	return "Packets flock at your core from every direction, on the ground and in the air. Pure chaos."


func play_radius() -> float:
	return HALF * 1.3


func cam_offset() -> Vector3:
	return Vector3(0, 66, 46)


func setup() -> void:
	var floor := world.make_floor(HALF * 3, Vector3.ZERO, Color(0.55, 0.2, 1.0))
	(floor.material_override as ShaderMaterial).set_shader_parameter("fade_k", 0.01)
	add_child(floor)
	add_child(world.make_stars(800, 220, 380))
	add_child(Scenery.core_wall(CORE_R, Color("#e86bd0")))
	var core := world.make_core(2.0)
	core.position.y = 4
	add_child(core)
	# Neon walls on all four sides.
	var wall := World.unshaded(Color("#e86bd0"), 2.0)
	for side in [Vector3(1, 0, 0), Vector3(-1, 0, 0), Vector3(0, 0, 1), Vector3(0, 0, -1)]:
		var along_x: bool = side.z != 0
		var size := Vector3(HALF * 2, 0.4, 0.4) if along_x else Vector3(0.4, 0.4, HALF * 2)
		add_child(World.mesh_node(World.box(size), wall, side * HALF + Vector3(0, 0.2, 0)))
	# Pillars, fixed per run so the arena feels like a place.
	var rng := RandomNumberGenerator.new()
	rng.seed = 1337
	var pillar_mat := World.emissive(Color("#2a3a7a"), 0.5, 0.6)
	var cap := World.unshaded(Color("#9b7bff"), 1.3)
	while pillars.size() < 16:
		var p := Vector3(rng.randf_range(-HALF + 10, HALF - 10), rng.randf_range(1.5, 3.0), rng.randf_range(-HALF + 10, HALF - 10))
		if Vector2(p.x, p.z).length() < 25:
			continue
		pillars.append(p)
		var h := rng.randf_range(5, 14)
		add_child(World.mesh_node(World.cylinder(p.y, p.y, h, 8), pillar_mat, Vector3(p.x, h / 2, p.z)))
		add_child(World.mesh_node(World.torus(p.y, p.y + 0.25), cap, Vector3(p.x, h, p.z)))


func _flies(pk: Dictionary) -> bool:
	return int(pk.p.proto) != Lanes.PROTO_TCP


func spawn(pk: Dictionary) -> void:
	# A random point on the arena edge, all the way round.
	var a := randf() * TAU
	var d := Vector2(cos(a), sin(a))
	d /= maxf(absf(d.x), absf(d.y))
	var height: float = randf_range(5, 13) if _flies(pk) else pk.y
	pk.pos = Vector3(d.x * (HALF - 2), height, d.y * (HALF - 2))
	pk.vel = -pk.pos.normalized() * pk.speed
	pk.vel.y = 0
	pk.alt = height
	pk.speed *= 1.25 if _flies(pk) else 0.95


func move(pk: Dictionary, dt: float, t: float) -> void:
	var to_core := -Vector3(pk.pos.x, 0, pk.pos.z).normalized()
	var steer := to_core * 1.0
	var sep := Vector3.ZERO
	var align := Vector3.ZERO
	var n := 0
	for q in game.packets:
		if q == pk or q.dead:
			continue
		var d: Vector3 = pk.pos - q.pos
		var dist := d.length()
		if dist < 3.0 and dist > 0.01:
			sep += d / (dist * dist)
		if dist < NEIGHBOUR and q.lane == pk.lane and q.has("vel"):
			align += q.vel
			n += 1
	steer += sep * 3.0
	if n > 0:
		steer += (align / n).normalized() * 0.6
	for p in pillars:
		var d := Vector3(pk.pos.x - p.x, 0, pk.pos.z - p.z)
		var dist := d.length()
		if dist < p.y + 3.0 and not _flies(pk):
			steer += d.normalized() * (p.y + 3.0 - dist) * 1.5
	# A bit of wander; ICMP zig-zags hard.
	var wander := 0.9 if Lanes.is_icmp(pk.p) else 0.3
	steer += Vector3(sin(t * 2.3 + pk.phase), 0, cos(t * 1.9 + pk.phase * 1.3)) * wander
	steer.y = 0
	pk.vel = pk.vel.lerp(steer.normalized() * pk.speed, minf(1.0, dt * 2.5))
	pk.pos += pk.vel * dt
	pk.pos.y = pk.alt + sin(t * 2.0 + pk.phase) * (1.2 if _flies(pk) else 0.15)
	# Flyers descend as they close in.
	if _flies(pk):
		pk.alt = lerpf(pk.alt, 2.5, dt * 0.15)


func radar_marks() -> Array:
	var out := []
	for p in pillars:
		out.append({"pos": Vector3(p.x, 0, p.z), "color": Color("#9b7bff", 0.6), "size": 3.0})
	return out


func reached_core(pk: Dictionary) -> bool:
	return Vector2(pk.pos.x, pk.pos.z).length() < CORE_R


func should_merge(_newest: Dictionary, alive: int) -> bool:
	return alive >= 3


func help() -> String:
	return "WASD: drive · mouse: aim, hover a flyer to target it · wheel: zoom · click/Space: fire"
