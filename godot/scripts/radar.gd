class_name Radar
extends Control
## Top-down minimap for the open levels: the core in the middle, level
## landmarks (portals, nodes, pillars), every live packet, and the player.

var world_range := 0.0
var marks: Array = [] # [{pos: Vector3, color: Color, size: float}]
var dots: Array = [] # [Vector3, Color] pairs, flattened
var player_pos := Vector3.ZERO
var player_dir := Vector3.FORWARD


func _ready() -> void:
	custom_minimum_size = Vector2(220, 220)
	mouse_filter = Control.MOUSE_FILTER_IGNORE


func _to_screen(p: Vector3) -> Vector2:
	var c := size / 2
	return c + Vector2(p.x, p.z) / world_range * (size.x / 2 - 6)


func _draw() -> void:
	if world_range <= 0.0:
		return
	var c := size / 2
	var r := size.x / 2
	draw_circle(c, r, Color(0.03, 0.05, 0.1, 0.85))
	draw_arc(c, r - 1, 0, TAU, 64, Color("#2a3758"), 2)
	draw_arc(c, r * 0.5, 0, TAU, 48, Color(0.16, 0.22, 0.4, 0.6), 1)
	draw_circle(c, 4, Color("#5fe0ff"))
	for m in marks:
		var p := _to_screen(m.pos)
		if p.distance_to(c) < r:
			draw_circle(p, m.size, m.color)
	for i in range(0, dots.size(), 2):
		var p := _to_screen(dots[i])
		if p.distance_to(c) < r:
			draw_circle(p, 1.6, dots[i + 1])
	var pp := _to_screen(player_pos)
	var d := Vector2(player_dir.x, player_dir.z).normalized()
	draw_colored_polygon(PackedVector2Array([pp + d * 7, pp + d.orthogonal() * 4 - d * 4, pp - d.orthogonal() * 4 - d * 4]), Color.WHITE)
