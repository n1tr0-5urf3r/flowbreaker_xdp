class_name Level
extends Node3D
## A world layout. Main owns packets, bolts and kills; a level decides where
## packets come from, how they move, where the core is, how the player moves
## and where the camera looks. Override what you need.

var game: Main
var world: World


func title() -> String:
	return ""


func blurb() -> String:
	return ""


## "cannon" (classic lanes), "rover" (drive on the ground) or "ship" (fly in 3D).
func player_mode() -> String:
	return "rover"


## How far the player may roam from the origin.
func play_radius() -> float:
	return 120.0


## No building this close to the core (its wall would fill the cockpit view).
func core_keepout() -> float:
	return 13.0


func player_start() -> Vector3:
	return Vector3(0, 1, 20)


func setup() -> void:
	pass


## Set pk.pos (and any per-level state) for a freshly sampled packet.
func spawn(_pk: Dictionary) -> void:
	pass


## Advance pk.pos.
func move(_pk: Dictionary, _dt: float, _t: float) -> void:
	pass


func reached_core(_pk: Dictionary) -> bool:
	return false


## Called when a new sample arrives for a flow that already has `alive`
## sprites on screen (`newest` is the latest). True merges the sample into
## it (a "×n" badge) instead of spawning another sprite.
func should_merge(_newest: Dictionary, alive: int) -> bool:
	return alive >= 3


## Where the camera sits relative to the player (scaled by the wheel zoom).
func cam_offset() -> Vector3:
	return Vector3(0, 38, 30)


func camera_transform(player: Player) -> Transform3D:
	if player.craft == "jet":
		# Chase cam behind the jet's heading.
		var back := Vector3(sin(player.yaw), 0, cos(player.yaw))
		var pos := player.position + back * 16.0 * game.zoom + Vector3(0, 6.0 * game.zoom, 0)
		var look := player.position - back * 26.0 - Vector3(0, 4, 0)
		return Transform3D.IDENTITY.looking_at(look - pos, Vector3.UP).translated(pos)
	var off := cam_offset() * game.zoom
	return Transform3D.IDENTITY.looking_at(-off, Vector3.UP).translated(player.position + off)


## Level animation that isn't tied to one packet.
func tick(_dt: float, _t: float) -> void:
	pass


## Shootable things besides packets: [{pos: Vector3, r: float, hit: Callable(dmg)}].
func targets() -> Array:
	return []


func on_flow_blocked(_id: String) -> void:
	pass


## Radar scale in world units (0 hides the radar) and landmarks to draw.
func radar_range() -> float:
	return play_radius()


func radar_marks() -> Array:
	return []


func help() -> String:
	return "WASD: move · mouse: aim · wheel: zoom · click/Space: fire"
