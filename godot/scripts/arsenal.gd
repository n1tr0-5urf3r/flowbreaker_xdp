class_name Arsenal
extends Node
## Weapons, upgrades, power-ups and every projectile in flight (a port of
## web/js/arsenal.js). All damage ends in Main.damage(), which turns a
## destroyed packet into a real flow kill.

const WEAPONS := [
	{"key": "blaster", "name": "BLASTER", "cd": 0.11, "ammo": -1, "max": -1, "color": Color("#dffaff")},
	{"key": "laser", "name": "LASER", "cd": 0.0, "ammo": -1, "max": -1, "color": Color("#ff3355")},
	{"key": "rocket", "name": "ROCKETS", "cd": 0.4, "ammo": 8, "max": 40, "color": Color("#ff8a3d")},
	{"key": "grenade", "name": "GRENADES", "cd": 0.45, "ammo": 10, "max": 40, "color": Color("#9fe870")},
	{"key": "cluster", "name": "CLUSTER", "cd": 0.9, "ammo": 3, "max": 15, "color": Color("#e86bd0")},
]

const UPGRADES := [
	{"key": "blaster", "name": "Blaster", "levels": ["single", "twin", "triple spread"], "cost": [90, 180]},
	{"key": "laser", "name": "Laser", "levels": ["basic", "cool-running", "wide & hot"], "cost": [110, 220]},
	{"key": "rocket", "name": "Rockets", "levels": ["single", "2-salvo", "3-salvo"], "cost": [110, 220]},
	{"key": "grenade", "name": "Grenades", "levels": ["radius 4", "radius 5.5", "radius 7"], "cost": [90, 180]},
	{"key": "cluster", "name": "Cluster", "levels": ["8 bomblets", "12 bomblets", "16 bomblets"], "cost": [120, 240]},
	{"key": "turret", "name": "Turrets", "levels": ["standard", "rapid", "long range"], "cost": [100, 200]},
	{"key": "strike", "name": "Airstrike", "levels": ["1 jet", "2 jets", "3 jets"], "cost": [150, 300]},
]

const POWERUPS := {
	"rapid": {"glyph": "»", "color": Color("#f5c542"), "name": "RAPID FIRE", "dur": 10.0},
	"spread": {"glyph": "✶", "color": Color("#5fe0ff"), "name": "SPREAD SHOT", "dur": 10.0},
	"overcharge": {"glyph": "ϟ", "color": Color("#b388ff"), "name": "OVERCHARGE", "dur": 8.0},
	"ammo": {"glyph": "A", "color": Color("#ff8a3d"), "name": "AMMO CRATE"},
	"repair": {"glyph": "+", "color": Color("#5fd068"), "name": "REPAIR +15"},
	"strike": {"glyph": "✈", "color": Color("#ff3355"), "name": "AIRSTRIKE +1"},
	"credits": {"glyph": "¢", "color": Color("#ffe14d"), "name": "+40¢"},
}

const AMMO_PACK_COST := 40
const G := 30.0
const BOLT_SPEED := 150.0
const DROP_CHANCE := 0.1

var game: Main
var world: World
var weapon := 0
var ammo := {}
var upgrades := {}
var buffs := {} # key -> expires at (s)
var heat := 0.0
var overheated := false
var cd := 0.0
var shots := {} # weapon key -> times fired (selftest)
var projectiles: Array[Dictionary] = []
var powerups: Array[Dictionary] = []
var strikes: Array[Airstrike] = []
var beam: Node3D


func reset() -> void:
	for p in projectiles:
		if is_instance_valid(p.node):
			p.node.queue_free()
	for pu in powerups:
		if is_instance_valid(pu.node):
			pu.node.queue_free()
	for s in strikes:
		s.cancel()
	projectiles.clear()
	powerups.clear()
	strikes.clear()
	stop_beam()


func new_run() -> void:
	reset()
	weapon = 0
	heat = 0.0
	overheated = false
	buffs = {}
	ammo = {}
	upgrades = {}
	var stock := 1.0 + game.profile.perk("stockpile") * 0.5
	for w in WEAPONS:
		ammo[w.key] = w.ammo if w.ammo < 0 else roundi(w.ammo * stock)
	for u in UPGRADES:
		upgrades[u.key] = 0
	if game.profile.perk("veteran") > 0:
		upgrades.blaster = 1


func now() -> float:
	return Time.get_ticks_msec() / 1000.0


func has_buff(k: String) -> bool:
	return buffs.get(k, 0.0) > now()


func current() -> Dictionary:
	return WEAPONS[weapon]


func select(i: int) -> void:
	if i == weapon or i < 0 or i >= WEAPONS.size():
		return
	weapon = i
	stop_beam()
	game.sfx.play("click")


func next_weapon() -> void:
	select((weapon + 1) % WEAPONS.size())


func add_ammo() -> void:
	for pair in [["rocket", 4], ["grenade", 5], ["cluster", 1]]:
		var w: Dictionary = WEAPONS.filter(func(x): return x.key == pair[0])[0]
		ammo[pair[0]] = mini(w.max, ammo[pair[0]] + pair[1])


func gravity() -> float:
	return 0.0 if game.player.mode == "ship" else G


# ------------------------------------------------------------- firing

## Called every frame. Handles the laser (continuous) and the cooldowns.
func update_fire(dt: float, firing: bool, origin: Vector3, aim: Vector3) -> void:
	cd = maxf(0.0, cd - dt)
	var dir := (aim - origin).normalized() if game.player.mode != "cannon" or game.manned else Vector3(0, 0, -1)
	if game.player.craft == "jet" and not game.manned and dir.dot(game.player.forward()) < 0.2:
		dir = (game.player.forward() + Vector3(0, -0.35, 0)).normalized() # the jet's guns only reach forward
	if firing and current().key == "laser":
		_fire_beam(origin, dir, dt)
		return
	stop_beam()
	heat = maxf(0.0, heat - 45.0 * dt)
	if overheated and heat < 25.0:
		overheated = false
	if firing:
		_fire(origin, dir, aim)


func _fire(origin: Vector3, dir: Vector3, aim: Vector3) -> void:
	if cd > 0.0:
		return
	var w := current()
	if w.ammo >= 0 and ammo[w.key] <= 0:
		cd = 0.3
		game.sfx.play("error")
		game.hud.toast("Out of %s. Grab an ammo crate (A) or buy ammo (U)." % w.name.to_lower(), Color("#ff8899"))
		return
	cd = w.cd * (0.5 if has_buff("rapid") else 1.0)
	shots[w.key] = shots.get(w.key, 0) + 1
	var side := dir.cross(Vector3.UP).normalized()
	if side.length() < 0.1:
		side = Vector3.RIGHT
	match w.key:
		"blaster":
			var lvl: int = upgrades.blaster
			var spread := [[0.0, 0.0]] if lvl == 0 else [[-0.35, 0.0], [0.35, 0.0]] if lvl == 1 else [[0.0, -6.0], [0.0, 0.0], [0.0, 6.0]]
			if has_buff("spread"):
				spread.append_array([[0.0, -14.0], [0.0, 14.0]])
			for s in spread:
				bolt(origin + side * s[0], dir.rotated(Vector3.UP, deg_to_rad(s[1])), Color("#dffaff"))
			game.sfx.play("pew", -4.0)
		"rocket":
			var target := game.lock_target(aim)
			var n: int = upgrades.rocket + 1
			for i in n:
				var d := (dir + Vector3(0, 0.35, 0) + side * (i - (n - 1) / 2.0) * 0.5).normalized()
				rocket(origin, d, target)
			ammo.rocket -= 1
			game.sfx.play("rocket")
		"grenade", "cluster":
			lob(w.key, origin, aim)
			ammo[w.key] -= 1
			game.sfx.play("launch")


func bolt(origin: Vector3, dir: Vector3, color: Color, from := "player") -> void:
	var node := world.make_bolt(color)
	_orient(node, origin, dir)
	projectiles.append({"kind": "bolt", "pos": origin, "vel": dir * BOLT_SPEED, "node": node, "life": 1.1, "from": from, "passed": {}, "age": 0.0})


func rocket(origin: Vector3, dir: Vector3, target: Dictionary) -> void:
	var node := Node3D.new()
	node.add_child(World.mesh_node(World.cylinder(0.11, 0.11, 0.9, 6), World.emissive(Color("#b0b8d0"), 0.3, 0.8)))
	var flame := World.mesh_node(World.sphere(0.2, 6, 3), World.unshaded(Color("#ffb347"), 4.0), Vector3(0, -0.6, 0))
	node.add_child(flame)
	world.add_child(node)
	_orient(node, origin, dir)
	projectiles.append({"kind": "rocket", "pos": origin, "vel": dir * 35.0, "node": node, "life": 4.0, "target": target, "from": "player", "age": 0.0, "smoke": 0.0})


## Grenades land on the aim point: ballistic on the ground, a timed fuse in space.
func lob(kind: String, origin: Vector3, aim: Vector3) -> void:
	var g := gravity()
	var d := aim - origin
	var vel: Vector3
	var life := 4.0
	if g > 0.0:
		var flat := Vector2(d.x, d.z).length()
		var t := clampf(flat / 45.0, 0.55, 1.5)
		vel = Vector3(d.x / t, (d.y + 0.5 * g * t * t) / t, d.z / t)
	else:
		vel = d.normalized() * 45.0
		life = d.length() / 45.0
	var col: Color = Color("#e86bd0") if kind == "cluster" else Color("#9fe870")
	var node := World.mesh_node(World.sphere(0.32, 6, 3), World.emissive(col, 1.6, 0.4))
	world.add_child(node)
	node.position = origin
	projectiles.append({"kind": kind, "pos": origin, "vel": vel, "node": node, "life": life, "from": "player", "age": 0.0})


func bomb(pos: Vector3, vel: Vector3, tag: int) -> void:
	var node := World.mesh_node(World.cylinder(0.3, 0.3, 1.1, 8), World.emissive(Color("#ff3355"), 1.4, 0.5))
	world.add_child(node)
	node.position = pos
	projectiles.append({"kind": "bomb", "pos": pos, "vel": vel, "node": node, "life": 1.4, "from": "strike", "tag": tag, "age": 0.0})


static func _orient(node: Node3D, origin: Vector3, dir: Vector3) -> void:
	node.position = origin
	if dir.length() < 0.01:
		return
	var up := Vector3.UP if absf(dir.normalized().y) < 0.98 else Vector3.RIGHT
	node.basis = Basis.looking_at(dir, up) * Basis(Vector3.RIGHT, PI / 2) # the meshes run along Y


# ------------------------------------------------------------- laser

func laser_stats() -> Dictionary:
	var lvl: int = upgrades.laser
	var over := has_buff("overcharge")
	return {"heat": 0.0 if over else [38.0, 26.0, 22.0][lvl], "dps": [14.0, 18.0, 28.0][lvl] * (2.0 if over else 1.0), "width": [0.35, 0.45, 0.7][lvl]}


func _fire_beam(origin: Vector3, dir: Vector3, dt: float) -> void:
	if overheated:
		stop_beam()
		heat = maxf(0.0, heat - 45.0 * dt)
		if heat < 25.0:
			overheated = false
		return
	var st := laser_stats()
	heat = minf(100.0, heat + st.heat * dt)
	if heat >= 100.0:
		overheated = true
		game.sfx.play("overheat")
		stop_beam()
		return
	shots.laser = shots.get("laser", 0) + 1
	var length := 95.0
	if beam == null:
		beam = Node3D.new()
		beam.add_child(World.mesh_node(World.cylinder(0.06, 0.06, 1.0, 8), World.unshaded(Color.WHITE, 3.0)))
		beam.add_child(World.mesh_node(World.cylinder(0.3, 0.3, 1.0, 10), World.unshaded(Color("#ff3355"), 1.6, 0.3, true)))
		world.add_child(beam)
		game.sfx.laser(true)
	var end := origin + dir * length
	beam.position = (origin + end) * 0.5
	var up := Vector3.UP if absf(dir.y) < 0.98 else Vector3.RIGHT
	beam.basis = Basis.looking_at(dir, up) * Basis(Vector3.RIGHT, PI / 2) * Basis.from_scale(Vector3(st.width / 0.35, length, st.width / 0.35))
	for pk in game.packets:
		if pk.dead:
			continue
		var c: Vector3 = pk.pos
		var closest := Geometry3D.get_closest_point_to_segment(c, origin, end)
		if closest.distance_to(c) > pk.r + st.width:
			continue
		if pk.p.prot:
			continue
		if randf() < 0.3:
			world.explode(closest, Color("#ff3355"), 3, 5)
		game.damage(pk, st.dps * dt, "laser")
	for tg in game.level.targets():
		if Geometry3D.get_closest_point_to_segment(tg.pos, origin, end).distance_to(tg.pos) < tg.r:
			tg.hit.call(st.dps * dt * 0.2)
	for pu in powerups.duplicate():
		if Geometry3D.get_closest_point_to_segment(pu.pos, origin, end).distance_to(pu.pos) < 1.5:
			collect(pu)


func stop_beam() -> void:
	if beam:
		beam.queue_free()
		beam = null
		if game:
			game.sfx.laser(false)


# ---------------------------------------------------------- explosions

func explode(pos: Vector3, radius: float, dmg: float, color: Color, src := "player", tag := 0, big := false) -> void:
	world.explode(pos, color, int(30 + radius * 14), 4.0 + radius * 2.2)
	world.shockwave(pos, radius, color)
	world.shake = maxf(world.shake, 0.45 if big else 0.12 + radius * 0.03)
	game.sfx.play("boom", -2.0 if big else -6.0 + radius)
	for pk in game.packets:
		if not pk.dead and pk.pos.distance_to(pos) <= radius + pk.r:
			game.damage(pk, dmg, src, tag)
	for tg in game.level.targets():
		if tg.pos.distance_to(pos) <= radius + tg.r:
			tg.hit.call(dmg)
	for pu in powerups.duplicate():
		if pu.pos.distance_to(pos) < radius + 1.0:
			collect(pu)


# -------------------------------------------------------------- update

func update(dt: float) -> void:
	var g := gravity()
	var targets := game.level.targets()
	for p in projectiles:
		p.age += dt
		p.life -= dt
		var from: Vector3 = p.pos
		match p.kind:
			"bolt":
				p.pos += p.vel * dt
			"rocket":
				var speed := minf(95.0, 35.0 + p.age * 110.0)
				var tg: Dictionary = p.target
				if not tg.is_empty() and not tg.dead:
					p.vel = p.vel.lerp((tg.pos - p.pos).normalized() * speed, minf(1.0, dt * 6.0))
				p.vel = p.vel.normalized() * speed
				p.pos += p.vel * dt
				p.smoke -= dt
				if p.smoke <= 0.0:
					p.smoke = 0.05
					world.explode(p.pos, Color(0.5, 0.45, 0.5), 2, 1)
			_:
				p.vel.y -= g * dt
				p.pos += p.vel * dt
				(p.node as Node3D).rotate_x(dt * 8.0)
				if p.kind == "cluster" and p.age > 0.3 and (p.vel.y < 0.0 if g > 0.0 else p.life <= 0.0):
					_split(p)
					continue
		if p.kind != "rocket" and p.kind != "bolt":
			(p.node as Node3D).position = p.pos
		else:
			_orient(p.node, p.pos, p.vel)
		# Contact with packets (swept).
		var best := {}
		var best_d := INF
		for pk in game.packets:
			if pk.dead:
				continue
			var c: Vector3 = pk.pos
			var closest := Geometry3D.get_closest_point_to_segment(c, from, p.pos)
			if closest.distance_to(c) > pk.r + 0.3:
				continue
			if pk.p.prot:
				if p.kind == "bolt" and not p.passed.has(pk.id):
					p.passed[pk.id] = true
					world.explode(c, Color("#7fe7ff"), 12, 4)
					game.sfx.play("shield", -10.0)
				continue # everything passes through shields: protected flows never die
			var d := from.distance_to(closest)
			if d < best_d:
				best_d = d
				best = pk
		for pu in powerups.duplicate():
			if Geometry3D.get_closest_point_to_segment(pu.pos, from, p.pos).distance_to(pu.pos) < 1.4:
				collect(pu)
		var hit_target := {}
		if best.is_empty():
			for tg in targets:
				if Geometry3D.get_closest_point_to_segment(tg.pos, from, p.pos).distance_to(tg.pos) < tg.r:
					hit_target = tg
					break
		if not best.is_empty() or not hit_target.is_empty():
			_impact(p, best, hit_target)
		elif p.kind not in ["bolt", "rocket"] and g > 0.0 and p.pos.y <= 0.2:
			p.pos.y = 0.2
			_impact(p, {}, {})
		elif p.life <= 0.0:
			if p.kind == "bolt":
				p.dead = true
			else:
				_impact(p, {}, {})
	for p in projectiles:
		if p.get("dead", false) and is_instance_valid(p.node):
			p.node.queue_free()
	projectiles = projectiles.filter(func(p): return not p.get("dead", false))
	_update_powerups(dt)
	for s in strikes:
		s.update(dt)
	strikes = strikes.filter(func(s): return not s.done)


func _impact(p: Dictionary, pk: Dictionary, tg: Dictionary) -> void:
	p.dead = true
	match p.kind:
		"bolt":
			if not pk.is_empty():
				game.damage(pk, 1.0, p.from)
			elif not tg.is_empty():
				tg.hit.call(1.0)
		"rocket":
			explode(p.pos, 2.6, 6.0, Color("#ff8a3d"))
		"grenade":
			explode(p.pos, [4.0, 5.5, 7.0][upgrades.grenade], 4.0, Color("#9fe870"))
		"cluster":
			_split(p)
		"bomblet":
			explode(p.pos, 2.4, 3.0, Color("#ff8a3d"))
		"bomb":
			explode(p.pos, 5.0, 14.0, Color("#ff3355"), "strike", p.tag, true)


func _split(p: Dictionary) -> void:
	p.dead = true
	var n: int = [8, 12, 16][upgrades.cluster]
	world.explode(p.pos, Color("#e86bd0"), 30, 6)
	game.sfx.play("pop")
	var g := gravity()
	for i in n:
		var a := float(i) / n * TAU + randf() * 0.4
		var s := randf_range(5, 12)
		var vel := Vector3(p.vel.x * 0.35 + cos(a) * s, randf_range(3, 9) if g > 0.0 else randf_range(-4, 4), p.vel.z * 0.35 + sin(a) * s)
		var node := World.mesh_node(World.sphere(0.18, 6, 3), World.emissive(Color("#ff8a3d"), 2.0, 0.4))
		world.add_child(node)
		node.position = p.pos
		projectiles.append({"kind": "bomblet", "pos": p.pos, "vel": vel, "node": node, "life": 3.0 if g > 0.0 else 0.6, "from": p.from, "age": 0.0})


# ------------------------------------------------------------ powerups

func maybe_drop(at: Vector3, suspicious: bool) -> void:
	if randf() < DROP_CHANCE + game.profile.perk("scavenger") * 0.04 + (0.15 if suspicious else 0.0):
		spawn_powerup(at)


func spawn_powerup(at: Vector3, type := "") -> void:
	if type == "":
		type = POWERUPS.keys().pick_random()
	var def: Dictionary = POWERUPS[type]
	var node := Node3D.new()
	var cage := World.mesh_node(World.sphere(1.0, 4, 2), World.unshaded(def.color, 1.8, 0.35, true))
	cage.name = "Cage"
	node.add_child(cage)
	node.add_child(World.mesh_node(World.sphere(0.5, 4, 2), World.unshaded(def.color, 2.2)))
	var icon := World.label3d(def.glyph, 128, 0.012, def.color)
	icon.position.y = 1.8
	node.add_child(icon)
	world.add_child(node)
	var pos := at
	if game.player.mode != "ship":
		pos.y = 1.4
	node.position = pos
	powerups.append({"type": type, "def": def, "node": node, "pos": pos, "life": 14.0, "phase": randf() * TAU})


func collect(pu: Dictionary) -> void:
	if not powerups.has(pu):
		return
	powerups.erase(pu)
	pu.node.queue_free()
	world.explode(pu.pos, pu.def.color, 40, 6)
	game.hud.toast(pu.def.name, pu.def.color)
	game.sfx.play("powerup")
	match pu.type:
		"rapid", "spread", "overcharge":
			buffs[pu.type] = maxf(buffs.get(pu.type, 0.0), now()) + pu.def.dur * (1.0 + game.profile.perk("overclock") * 0.25)
			if pu.type == "overcharge":
				heat = 0.0
		"ammo":
			add_ammo()
		"repair":
			game.integrity = minf(game.max_integrity, game.integrity + 15.0)
		"strike":
			game.strikes += 1
		"credits":
			game.credits += 40


func _update_powerups(dt: float) -> void:
	var t := now()
	var core := Vector3.ZERO
	for pu in powerups.duplicate():
		pu.life -= dt
		# Drift slowly towards the core (along +Z on the classic board).
		var drift: Vector3 = Vector3(0, 0, 2.2) if game.player.mode == "cannon" else (core - pu.pos).normalized() * 2.2
		if game.player.mode != "ship":
			drift.y = 0
		pu.pos += drift * dt
		var node := pu.node as Node3D
		node.position = pu.pos + Vector3(0, sin(t * 3.0 + pu.phase) * 0.3, 0)
		(node.get_node("Cage") as Node3D).rotate_y(dt * 2.0)
		node.visible = pu.life > 3.0 or sin(t * 20.0) > 0.0
		# Fly or drive through a power-up to grab it.
		if game.player.mode != "cannon" and game.player.position.distance_to(pu.pos) < 3.2:
			collect(pu)
		elif pu.life <= 0.0:
			powerups.erase(pu)
			pu.node.queue_free()


# --------------------------------------------------------------- shop

func buy_upgrade(key: String) -> bool:
	var u: Dictionary = UPGRADES.filter(func(x): return x.key == key)[0]
	var lvl: int = upgrades[key]
	if lvl >= u.levels.size() - 1 or game.credits < u.cost[lvl]:
		game.sfx.play("error")
		return false
	game.credits -= u.cost[lvl]
	upgrades[key] = lvl + 1
	game.sfx.play("upgrade")
	game.hud.toast("%s upgraded: %s" % [u.name, u.levels[lvl + 1]], Color("#9fe870"))
	return true


func buy_ammo() -> bool:
	if game.credits < AMMO_PACK_COST:
		game.sfx.play("error")
		return false
	game.credits -= AMMO_PACK_COST
	add_ammo()
	game.sfx.play("click")
	return true


# ------------------------------------------------------------ airstrike

## Jets carpet-bomb a line through `aim`. On the classic board that's the
## lane under the aim point; elsewhere the line runs from you through it.
func call_strike(aim: Vector3) -> bool:
	if game.strikes <= 0:
		game.hud.toast("No airstrikes left. Pick up ✈ power-ups or keep blocking flows.", Color("#ff8899"))
		game.sfx.play("error")
		return false
	game.strikes -= 1
	var dir: Vector3
	var center := aim
	if game.player.mode == "cannon":
		center = Vector3(ClassicLanes.lane_x(ClassicLanes.lane_at(aim.x)), 0, -42)
		dir = Vector3(0, 0, -1)
	else:
		dir = aim - game.player.position
		dir.y = 0
		dir = dir.normalized() if dir.length() > 1.0 else -game.world.camera.global_basis.z * Vector3(1, 0, 1)
		dir = dir.normalized()
		if game.player.mode != "ship":
			center.y = 0
	var s := Airstrike.new()
	s.setup(game, center, dir, upgrades.strike + 1)
	strikes.append(s)
	game.hud.show_banner("AIRSTRIKE INBOUND", Color("#ff8a3d"))
	return true
