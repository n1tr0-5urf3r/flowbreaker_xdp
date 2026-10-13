class_name Airstrike
extends RefCounted
## A warning strip, then jets that fly along a line and carpet-bomb it.

const RUN := 70.0 # half-length of the bombed stretch
const SPEED := 85.0

var game: Main
var center: Vector3
var dir: Vector3
var warn := 1.2
var jets: Array[Dictionary] = []
var markers: Array[Node3D] = []
var done := false
var tag := 0


func setup(g: Main, c: Vector3, d: Vector3, count: int) -> void:
	game = g
	center = c
	dir = d
	tag = randi()
	var side := dir.cross(Vector3.UP).normalized()
	for i in count:
		var offset := side * (i - (count - 1) / 2.0) * 4.5
		var strip := PlaneMesh.new()
		strip.size = Vector2(3.8, RUN * 2)
		var m := World.mesh_node(strip, World.unshaded(Color("#ff3355"), 1.5, 0.2, true))
		m.transform = Transform3D(Basis.looking_at(dir, Vector3.UP), center + offset + Vector3(0, 0.08, 0))
		g.world.add_child(m)
		markers.append(m)
		jets.append({"offset": offset, "node": null, "pos": Vector3.ZERO, "drop": 0.0})
	g.sfx.play("siren")


func _make_jet() -> Node3D:
	var j := Node3D.new()
	var body := World.mesh_node(World.cylinder(0.0, 0.7, 6.0, 6), World.emissive(Color("#6a7cb0"), 0.4, 0.8))
	body.rotation_degrees.x = -90
	j.add_child(body)
	j.add_child(World.mesh_node(World.box(Vector3(8.4, 0.12, 2.2)), World.emissive(Color("#6a7cb0"), 0.4, 0.8), Vector3(0, 0, 0.8)))
	j.add_child(World.mesh_node(World.box(Vector3(5.2, 0.05, 0.15)), World.unshaded(Color("#ff3355"), 2.5), Vector3(0, 0.08, 1.1)))
	j.add_child(World.mesh_node(World.sphere(0.45, 8, 4), World.unshaded(Color("#ff8a3d"), 5.0), Vector3(0, 0, 3.0)))
	game.world.add_child(j)
	return j


func update(dt: float) -> void:
	if done:
		return
	if warn > 0.0:
		warn -= dt
		for m in markers:
			m.visible = fmod(Time.get_ticks_msec() / 140.0, 2.0) < 1.2
		if warn <= 0.0:
			var alt := 19.0 if game.player.mode != "ship" else 14.0
			for j in jets:
				j.node = _make_jet()
				j.pos = center + j.offset - dir * (RUN + 45.0) + Vector3(0, alt, 0)
			game.sfx.play("jet")
		return
	var all_gone := true
	for j in jets:
		j.pos += dir * SPEED * dt
		var node := j.node as Node3D
		node.transform = Transform3D(Basis.looking_at(dir, Vector3.UP), j.pos)
		var along: float = (j.pos - center).dot(dir)
		j.drop -= dt
		if absf(along) < RUN and j.drop <= 0.0:
			j.drop = 0.075
			var vel := dir * 28.0 + Vector3(0, -6, 0)
			game.arsenal.bomb(j.pos + Vector3(randf_range(-0.8, 0.8), -1, 0), vel, tag)
		if along < RUN + 60.0:
			all_gone = false
	for m in markers:
		m.visible = true
		(m.material_override as StandardMaterial3D).albedo_color.a *= exp(-dt * 1.5)
	if all_gone:
		cancel()


func cancel() -> void:
	for m in markers:
		if is_instance_valid(m):
			m.queue_free()
	for j in jets:
		if j.node and is_instance_valid(j.node):
			j.node.queue_free()
	markers.clear()
	jets.clear()
	done = true
