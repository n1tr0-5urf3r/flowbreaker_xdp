class_name Player
extends Node3D
## The player's craft. The level picks the default: the cannon on the
## classic lanes, a hover craft on the ground, a ship in space. T/H/J swap in
## a tank (rams packets), a helicopter (hovers at any height) or a jet
## (always moving, chase camera). Movement is camera-relative, except the jet.
##
## mode is what the rest of the game cares about: "cannon", "rover" (on the
## ground) or "ship" (flying in 3D).

var craft := "hover"
var mode := "rover"
var radius := 120.0
var velocity := Vector3.ZERO
var lane := 3
var yaw := 0.0 # jet heading (0 = towards -Z)
var speed := 34.0
var stunned := 0.0
var level_default := "hover"
var ground := true
var _body: Node3D
var _rotor: Node3D


func _ready() -> void:
	_body = Node3D.new()
	add_child(_body)


func setup(level: Level) -> void:
	radius = level.play_radius()
	ground = level.player_mode() != "ship"
	level_default = {"cannon": "cannon", "rover": "hover", "ship": "ship"}[level.player_mode()]
	position = level.player_start()
	set_craft(level_default)


func set_craft(c: String) -> void:
	craft = c
	mode = {"cannon": "cannon", "hover": "rover", "tank": "rover", "heli": "ship", "jet": "ship", "ship": "ship"}[c]
	velocity = Vector3.ZERO
	yaw = 0.0
	speed = 34.0
	for ch in _body.get_children():
		_body.remove_child(ch)
		ch.queue_free()
	_rotor = null
	_body.basis = Basis()
	match c:
		"tank": _build_tank()
		"heli": _build_heli()
		"jet": _build_jet()
		_: _build_hover()
	if mode == "rover":
		position.y = 1.0
	elif ground and position.y < 6.0:
		position.y = 8.0


## Toggle a vehicle: the same key again returns to the level's default craft.
func toggle(c: String) -> bool:
	if c == "tank" and not ground:
		return false # nothing to drive on in space
	set_craft(level_default if craft == c else c)
	return true


func _build_hover() -> void:
	var hull := World.mesh_node(World.cylinder(0.0, 0.9, 2.4, 6), World.emissive(Color("#5fe0ff"), 0.8, 0.3))
	hull.rotation_degrees.x = -90
	_body.add_child(hull)
	_body.add_child(World.mesh_node(World.box(Vector3(2.6, 0.12, 0.8)), World.unshaded(Color("#5fe0ff"), 2.4), Vector3(0, 0, 0.5)))
	_body.add_child(World.mesh_node(World.sphere(0.5, 8, 4), World.unshaded(Color("#5fe0ff"), 2.0, 0.5, true), Vector3(0, -0.4, 0.9)))


func _build_tank() -> void:
	var hull := World.emissive(Color("#4a64a0"), 0.35, 0.8)
	var accent := World.unshaded(Color("#5fe0ff"), 2.0)
	_body.add_child(World.mesh_node(World.box(Vector3(2.6, 0.8, 3.6)), hull, Vector3(0, -0.2, 0)))
	for sx in [-1, 1]:
		_body.add_child(World.mesh_node(World.box(Vector3(0.7, 0.75, 4.0)), World.emissive(Color("#141c30"), 0.2, 0.8), Vector3(sx * 1.55, -0.55, 0)))
		_body.add_child(World.mesh_node(World.box(Vector3(0.06, 0.08, 3.9)), accent, Vector3(sx * 1.92, -0.45, 0)))
	_body.add_child(World.mesh_node(World.cylinder(0.85, 1.05, 0.55, 8), hull, Vector3(0, 0.45, 0)))
	var barrel := World.mesh_node(World.cylinder(0.14, 0.18, 2.6, 8), hull, Vector3(0, 0.55, -1.6))
	barrel.rotation_degrees.x = 90
	_body.add_child(barrel)
	_body.add_child(World.mesh_node(World.torus(0.14, 0.24), accent, Vector3(0, 0.55, -2.9)))


func _build_heli() -> void:
	var body := World.emissive(Color("#5a6ea8"), 0.35, 0.8)
	var capsule := CapsuleMesh.new()
	capsule.radius = 0.8
	capsule.height = 3.4
	var hull := World.mesh_node(capsule, body)
	hull.rotation_degrees.x = 90
	_body.add_child(hull)
	_body.add_child(World.mesh_node(World.sphere(0.72, 12, 8), World.emissive(Color("#2a6aff"), 0.9, 0.3), Vector3(0, 0.15, -1.2)))
	var boom := World.mesh_node(World.cylinder(0.12, 0.3, 3.2, 6), body, Vector3(0, 0.2, 2.6))
	boom.rotation_degrees.x = 90
	_body.add_child(boom)
	_rotor = Node3D.new()
	_rotor.position.y = 1.05
	for i in 2:
		var blade := World.mesh_node(World.box(Vector3(7.0, 0.05, 0.28)), World.unshaded(Color("#9fb4ff"), 1.0, 0.55, true))
		blade.rotation.y = i * PI / 2
		_rotor.add_child(blade)
	_body.add_child(_rotor)
	for sx in [-1, 1]:
		_body.add_child(World.mesh_node(World.cylinder(0.16, 0.16, 1.0, 8), World.unshaded(Color("#ffb347"), 1.6), Vector3(sx * 1.0, -0.3, -0.4)))


func _build_jet() -> void:
	var mat := World.emissive(Color("#6a7cb0"), 0.4, 0.8)
	var nose := World.mesh_node(World.cylinder(0.0, 0.7, 6.0, 6), mat)
	nose.rotation_degrees.x = -90
	_body.add_child(nose)
	_body.add_child(World.mesh_node(World.box(Vector3(8.4, 0.12, 2.2)), mat, Vector3(0, 0, 0.8)))
	_body.add_child(World.mesh_node(World.box(Vector3(0.08, 1.3, 1.1)), mat, Vector3(0, 0.6, 2.4)))
	_body.add_child(World.mesh_node(World.box(Vector3(5.2, 0.05, 0.15)), World.unshaded(Color("#ff8a3d"), 2.5), Vector3(0, 0.08, 1.1)))
	_body.add_child(World.mesh_node(World.sphere(0.45, 8, 4), World.unshaded(Color("#ff8a3d"), 5.0), Vector3(0, 0, 3.0)))


func update(dt: float, camera: Camera3D, aim: Vector3) -> void:
	stunned = maxf(0.0, stunned - dt)
	var t := Time.get_ticks_msec() / 1000.0
	if craft == "cannon":
		position.x = lerpf(position.x, ClassicLanes.lane_x(lane), minf(1.0, dt * 14.0))
		position.y = 1.0 + sin(t * 3.0) * 0.12
		return
	if craft == "jet":
		_update_jet(dt)
		return
	var fwd := -camera.global_basis.z
	fwd.y = 0
	fwd = fwd.normalized()
	var right := fwd.cross(Vector3.UP)
	var want := Vector3.ZERO
	if stunned <= 0.0:
		if Input.is_key_pressed(KEY_W): want += fwd
		if Input.is_key_pressed(KEY_S): want -= fwd
		if Input.is_key_pressed(KEY_D): want += right
		if Input.is_key_pressed(KEY_A): want -= right
		if mode == "ship":
			if Input.is_key_pressed(KEY_E): want.y += 1
			if Input.is_key_pressed(KEY_Q): want.y -= 1
	var top: float = {"tank": 16.0, "heli": 20.0}.get(craft, 22.0)
	var spd := top * (1.55 if Input.is_key_pressed(KEY_SHIFT) else 1.0)
	velocity = velocity.lerp(want.normalized() * spd, minf(1.0, dt * (2.5 if craft == "tank" else 4.0)))
	position += velocity * dt
	if mode == "rover":
		position.y = 1.0
	elif ground:
		position.y = clampf(position.y, 2.5, 26.0)
	if position.length() > radius:
		position = position.normalized() * radius
	if _rotor:
		_rotor.rotate_y(dt * 40.0)
	# Face the aim point.
	var look := aim - position
	if mode == "rover":
		look.y = 0
	if look.length() > 0.5 and absf(look.normalized().dot(Vector3.UP)) < 0.98:
		_body.look_at(global_position + look, Vector3.UP) # look_at points -Z, where the nose is
	_body.scale = Vector3.ONE * (0.8 if craft == "heli" else 1.0)


func _update_jet(dt: float) -> void:
	var throttle := (1 if Input.is_key_pressed(KEY_W) else 0) - (1 if Input.is_key_pressed(KEY_S) else 0)
	var target := 58.0 if throttle > 0 else 20.0 if throttle < 0 else 34.0
	speed = lerpf(speed, target * (1.3 if Input.is_key_pressed(KEY_SHIFT) else 1.0), minf(1.0, dt * 1.5))
	var turn := 0.0
	if stunned <= 0.0:
		turn = (1.0 if Input.is_key_pressed(KEY_A) else 0.0) - (1.0 if Input.is_key_pressed(KEY_D) else 0.0)
	# Leaving the airspace turns you back automatically.
	if Vector2(position.x, position.z).length() > radius:
		var home := atan2(position.x, position.z)
		turn = signf(wrapf(home - yaw, -PI, PI))
	yaw += turn * dt * 1.6
	var climb := 0.0
	if stunned <= 0.0:
		climb = (1.0 if Input.is_key_pressed(KEY_E) else 0.0) - (1.0 if Input.is_key_pressed(KEY_Q) else 0.0)
	var fwd := Vector3(-sin(yaw), 0, -cos(yaw))
	velocity = fwd * speed
	position += velocity * dt
	position.y = clampf(position.y + climb * 10.0 * dt, 4.0 if ground else -60.0, 30.0 if ground else 60.0)
	_body.basis = Basis.from_euler(Vector3(-climb * 0.25, yaw, turn * 0.6), EULER_ORDER_YXZ) * Basis.from_scale(Vector3.ONE * 0.75)


func muzzle() -> Vector3:
	return global_position + Vector3(0, 0.2, 0) + forward() * 1.8


func forward() -> Vector3:
	return -_body.global_basis.z.normalized()
