class_name ClassicLanes
extends Level
## The original board: one lane per protocol class, packets roll from the
## NIC/XDP gate straight at the host. The cannon slides along the near end.

const LANE_W := 4.2
const GATE_Z := -84.0
const HOST_Z := 0.0
const MERGE_DEPTH := 0.22


static func lane_x(i: int) -> float:
	return (i - (Lanes.LANES.size() - 1) / 2.0) * LANE_W


static func lane_at(x: float) -> int:
	return clampi(roundi(x / LANE_W + (Lanes.LANES.size() - 1) / 2.0), 0, Lanes.LANES.size() - 1)


func title() -> String:
	return "Classic Lanes"


func blurb() -> String:
	return "One lane per protocol, straight from the NIC to your host. The original."


func core_keepout() -> float:
	return 0.0


func player_mode() -> String:
	return "cannon"


func player_start() -> Vector3:
	return Vector3(0, 1, 3)


func radar_range() -> float:
	return 0.0 # the whole board is on screen


func help() -> String:
	return "A/D or mouse: lane · click/Space: fire"


func camera_transform(player: Player) -> Transform3D:
	if player.craft != "cannon":
		return super(player) # driving or flying a vehicle over the board
	return Transform3D.IDENTITY.looking_at(Vector3(0, 0, -31) - Vector3(0, 22, 27), Vector3.UP).translated(Vector3(0, 22, 27))


func setup() -> void:
	var board_w := LANE_W * Lanes.LANES.size()
	var length := HOST_Z - GATE_Z
	add_child(world.make_floor(400, Vector3(0, 0, -60)))
	add_child(world.make_stars(700, 150, 300))
	for i in Lanes.LANES.size():
		var lane: Dictionary = Lanes.LANES[i]
		var pm := PlaneMesh.new()
		pm.size = Vector2(LANE_W - 0.5, length)
		var mat := ShaderMaterial.new()
		mat.shader = load("res://shaders/lane.gdshader")
		mat.set_shader_parameter("tint", lane.color)
		add_child(World.mesh_node(pm, mat, Vector3(lane_x(i), 0.01, GATE_Z + length / 2)))
		var label := World.label3d(lane.name, 96, 0.008, lane.color, false)
		label.outline_size = 0
		label.rotation_degrees = Vector3(-90, 0, 0)
		label.position = Vector3(lane_x(i), 0.04, HOST_Z - 3.5)
		add_child(label)
	for i in Lanes.LANES.size() + 1:
		var outer := i == 0 or i == Lanes.LANES.size()
		add_child(World.mesh_node(World.box(Vector3(0.07, 0.07, length)),
			World.unshaded(Color("#5fe0ff") if outer else Color("#2a3a7a"), 2.2 if outer else 1.0),
			Vector3(lane_x(0) - LANE_W / 2 + i * LANE_W, 0.03, GATE_Z + length / 2)))
	add_child(World.mesh_node(World.box(Vector3(board_w + 1, 0.12, 0.12)), World.unshaded(Color("#5fe0ff"), 1.6), Vector3(0, 0.06, HOST_Z)))
	add_child(Scenery.gate(board_w + 2, 9.0, Vector3(0, 0, GATE_Z)))
	add_child(Scenery.sun(Vector3(0, 2, -200), 80))
	var core := world.make_core()
	# Left of the board: the rules panel covers the right edge of the screen.
	core.position = Vector3(-(board_w / 2 + 5), 3.2, HOST_Z - 7)
	add_child(core)


func spawn(pk: Dictionary) -> void:
	pk.pos = Vector3(lane_x(pk.lane) + randf_range(-1.3, 1.3), pk.y, GATE_Z + 0.5)


func move(pk: Dictionary, dt: float, t: float) -> void:
	pk.pos.z += pk.speed * dt
	pk.pos.y = pk.y + sin(t * 2.4 + pk.phase) * 0.18


func reached_core(pk: Dictionary) -> bool:
	return pk.pos.z >= HOST_Z


## Merge samples of a flow while its newest sprite is still near the gate.
func should_merge(newest: Dictionary, _alive: int) -> bool:
	return newest.pos.z < GATE_Z + (HOST_Z - GATE_Z) * MERGE_DEPTH
