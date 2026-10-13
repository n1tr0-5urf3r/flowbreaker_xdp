class_name Main
extends Node3D
## Flowbreaker native client. Main owns what every level shares: packets,
## kills, bosses, score/credits and the HUD; the Arsenal owns weapons and
## projectiles. The level (scripts/levels/) decides the world layout, how
## packets move and how the player gets around.
##
## Command-line (after "--"): --demo, --url=ws://host:port/ws, --token=…,
## --level=arena|swarm|graph|lanes, --selftest, --screenshot=path.png

const LEVELS := ["arena", "swarm", "graph", "lanes"]
const MAX_PACKETS := 180
const BOSS_SAMPLES := 16 # merged samples that turn a flow into an elephant
const BOSS_GAP := 60.0

var world: World
var hud: Hud
var net: Net
var sfx: Sfx
var music: Music
var arsenal: Arsenal
var profile: Profile
var level: Level
var level_key := ""
var player: Player
var packets: Array[Dictionary] = []
var blocked := {} # flow id -> confirmed at (s)
var pending := {}
var flow_lane := {}
var flow_prot := {}
var prev_drops := {}
var firing := false
var zoom := 1.0 # camera distance multiplier, mouse wheel
var score := 0
var credits := 120
var strikes := 1
var integrity := 100.0
var max_integrity := 100.0
var _xp_score := 0
var combo := 0
var combo_timer := 0.0
var kills := 0
var hover: Dictionary = {}
var boss: Dictionary = {}
var turrets: Array[Dictionary] = []
var gunships: Array[Dictionary] = []
var manned: Dictionary = {} # the turret whose cockpit you're in
var _ck_look := Vector2.ZERO
var next_boss_at := 25.0
var jammed := 0.0 # boss EMP: guns offline
var _suspicious_hits := {}
var _last_seen := 0
var _pps := 0.0
var _dropped := 0
var _stats_at := 0.0
var _regen := 0.0
var _shot_at := -1.0
var _selftest := {}
var _radar_t := 0.0


static func user_args() -> Dictionary:
	var out := {}
	for a in OS.get_cmdline_user_args():
		var kv := a.trim_prefix("--").split("=", true, 1)
		out[kv[0]] = kv[1] if kv.size() > 1 else ""
	return out


static func make_level(key: String) -> Level:
	match key:
		"swarm": return SwarmArena.new()
		"graph": return GraphSpace.new()
		"lanes": return ClassicLanes.new()
	return TopologyArena.new()


func _ready() -> void:
	world = World.new()
	add_child(world)
	sfx = Sfx.new()
	add_child(sfx)
	music = Music.new()
	add_child(music)
	# Self-tests get a throwaway profile so they never touch your real progress.
	profile = Profile.new("user://profile-selftest.json" if user_args().has("selftest") else "user://profile.json")
	profile.level_up.connect(func(lvl, kp, rank):
		hud.show_banner("LEVEL %d · %s  +%d KP" % [lvl, rank.to_upper(), kp], Color("#f5c542"))
		sfx.play("fanfare", -4.0))
	profile.achievement.connect(func(a):
		hud.toast("🏆 %s: %s  +%d XP" % [a.name, a.desc, a.xp], Color("#f5c542"))
		sfx.play("powerup"))
	arsenal = Arsenal.new()
	arsenal.game = self
	arsenal.world = world
	add_child(arsenal)
	player = Player.new()
	add_child(player)
	hud = Hud.new()
	hud.game = self
	add_child(hud)
	hud.panic_pressed.connect(panic)
	hud.unblock_pressed.connect(func(id): net.send({"t": "unblock", "id": id}))
	hud.level_chosen.connect(set_level)
	new_run()
	net = Net.new()
	net.status.connect(hud.set_status)
	net.message.connect(_on_message)
	add_child(net)
	var args := user_args()
	set_level(args.get("level", "arena"))
	if args.has("selftest"):
		_selftest = {"queue": [args.level] if args.has("level") else LEVELS.duplicate(), "left": 0.0, "kills": {}, "done_steps": {}}
		firing = true
		credits = 5000
	elif not args.has("level"):
		hud.show_menu(_level_cards(), level_key)
	if args.has("screenshot"):
		_shot_at = float(args.get("shot-at", "5.0"))


func _level_cards() -> Array:
	var out := []
	for key in LEVELS:
		var l := make_level(key)
		out.append({"key": key, "title": l.title(), "blurb": l.blurb()})
		l.free()
	return out


## A fresh run: score, credits and integrity reset; perks shape the start.
func new_run() -> void:
	profile.new_run()
	arsenal.new_run()
	score = 0
	_xp_score = 0
	kills = 0
	combo = 0
	max_integrity = 100.0 + profile.perk("hardening") * 15.0
	integrity = max_integrity
	credits = 120 + profile.perk("capital") * 60
	strikes = 1 + profile.perk("airforce")


## Swap the world. Kernel state (rules) is untouched; only the board resets.
func set_level(key: String) -> void:
	for pk in packets:
		pk.dead = true # pending chain-explosion timers must skip these
		pk.node.queue_free()
	packets.clear()
	arsenal.reset()
	_dismantle(false)
	manned = {}
	hover = {}
	_end_boss()
	if level:
		remove_child(level)
		level.queue_free()
	level_key = key if key in LEVELS else "arena"
	level = make_level(level_key)
	level.game = self
	level.world = world
	level.name = "Level"
	add_child(level)
	level.setup()
	player.setup(level)
	zoom = 1.0
	world.cam_target = level.camera_transform(player)
	world.snap_camera()
	hud.set_level(level.title(), level.help() + _craft_help())
	profile.on_level_played(level_key)


# --------------------------------------------------------------- input

func _unhandled_input(event: InputEvent) -> void:
	if hud.menu_open():
		return
	if event is InputEventMouseMotion and not manned.is_empty():
		var vs := get_viewport().get_visible_rect().size
		_ck_look = Vector2(event.position.x / vs.x * 2.0 - 1.0, event.position.y / vs.y * 2.0 - 1.0)
	elif event is InputEventMouseMotion and player.mode == "cannon":
		var hit = world.pick_plane(event.position, Plane(Vector3.UP, 0.0))
		if hit != null:
			player.lane = ClassicLanes.lane_at(hit.x)
	elif event is InputEventMouseButton:
		match event.button_index:
			MOUSE_BUTTON_LEFT:
				firing = event.pressed
			MOUSE_BUTTON_RIGHT:
				if event.pressed:
					arsenal.next_weapon()
			MOUSE_BUTTON_WHEEL_UP, MOUSE_BUTTON_WHEEL_DOWN:
				if event.pressed:
					zoom = clampf(zoom * (0.9 if event.button_index == MOUSE_BUTTON_WHEEL_UP else 1.1), 0.45, 2.2)
	elif event is InputEventKey and not event.echo:
		var k: int = event.keycode
		if not event.pressed:
			if k == KEY_SPACE:
				firing = false
			return
		if k >= KEY_1 and k <= KEY_5:
			arsenal.select(k - KEY_1)
			return
		match k:
			KEY_SPACE:
				firing = true
			KEY_A, KEY_LEFT:
				if player.mode == "cannon":
					player.lane = maxi(0, player.lane - 1)
			KEY_D, KEY_RIGHT:
				if player.mode == "cannon":
					player.lane = mini(Lanes.LANES.size() - 1, player.lane + 1)
			KEY_F:
				arsenal.call_strike(_aim_point())
			KEY_T, KEY_H, KEY_J:
				if manned.is_empty():
					var c: String = {KEY_T: "tank", KEY_H: "heli", KEY_J: "jet"}[k]
					if player.toggle(c):
						sfx.play("launch")
						hud.set_level(level.title(), level.help() + _craft_help())
					else:
						hud.toast("Nothing to drive on in space. Try H or J.", Color("#ff8899"))
			KEY_G:
				_call_gunship()
			KEY_B:
				_build_turret(_aim_point())
			KEY_X:
				_sell_turret(_aim_point())
			KEY_E:
				if manned.is_empty():
					_enter_cockpit()
				else:
					_exit_cockpit()
			KEY_R:
				if not manned.is_empty():
					_reload(manned)
			KEY_U:
				firing = false
				hud.show_armory()
			KEY_K:
				firing = false
				hud.show_research()
			KEY_O:
				firing = false
				hud.show_skins()
			KEY_M:
				sfx.set_muted(not sfx.muted)
				music.set_muted(sfx.muted)
				hud.toast("sound off" if sfx.muted else "sound on", Color("#8392b3"))
			KEY_TAB:
				firing = false
				hud.show_menu(_level_cards(), level_key)
			KEY_ESCAPE:
				panic()


func _notification(what: int) -> void:
	if what == NOTIFICATION_APPLICATION_FOCUS_OUT:
		firing = false # never keep firing after the release got lost


## PANIC clears every kernel rule and stands down anything automated that
## would block flows again a second later (airstrikes in flight).
func panic() -> void:
	net.send({"t": "panic"})
	profile.unlock("panic")
	for s in arsenal.strikes:
		s.cancel()
	arsenal.strikes.clear()
	_dismantle(true)


## Stand down everything automated: turrets (50% refund) and gunships.
func _dismantle(refund: bool) -> void:
	_exit_cockpit()
	var back := 0
	for t in turrets:
		back += price("turret") / 2
		world.explode(t.pos + Vector3.UP, Color("#5fe0ff"), 20, 5)
		t.node.queue_free()
	turrets.clear()
	for g in gunships:
		g.state = "leave"
	if refund and back > 0:
		credits += back
		hud.toast("Turrets dismantled +%d¢" % back, Color("#5fe0ff"))


func price(key: String) -> int:
	var base: int = {"turret": Units.TURRET_COST, "gunship": Units.GUNSHIP_COST}[key]
	return roundi(base * (1.0 - profile.perk("engineering") * 0.15))


func _craft_help() -> String:
	match player.craft:
		"tank": return "   ·   TANK: ram packets, T to get out"
		"heli": return "   ·   HELI: E/Q up/down, fly low over power-ups, H to get out"
		"jet": return "   ·   JET: W/S throttle, A/D bank, E/Q climb, J to get out"
	return ""


# ----------------------------------------------------------- turrets

func _build_turret(at: Vector3) -> void:
	var pos := at
	if player.ground:
		pos.y = 0.0
	if pos.length() > level.play_radius():
		return
	if Vector2(pos.x, pos.z).length() < level.core_keepout():
		hud.toast("Too close to the core to build", Color("#ff8899"))
		return
	for t in turrets:
		if t.pos.distance_to(pos) < 3.0:
			return
	if credits < price("turret"):
		hud.toast("Need %d¢ for a turret" % price("turret"), Color("#ff8899"))
		sfx.play("error")
		return
	credits -= price("turret")
	var t := Units.make_turret(pos)
	world.add_child(t.node)
	turrets.append(t)
	world.explode(pos + Vector3.UP, Color("#9fe870"), 30, 6)
	sfx.play("upgrade")


func _nearest_turret(to: Vector3, within: float) -> Dictionary:
	var best := {}
	var best_d := within
	for t in turrets:
		var d: float = t.pos.distance_to(to)
		if d < best_d:
			best_d = d
			best = t
	return best


func _sell_turret(at: Vector3) -> void:
	var t := _nearest_turret(at, 5.0)
	if t.is_empty():
		return
	if t == manned:
		_exit_cockpit()
	var back := roundi(price("turret") * 0.5 * float(t.ammo) / Units.TURRET_AMMO)
	credits += back
	t.node.queue_free()
	turrets.erase(t)
	hud.toast("+%d¢" % back, Color("#f5c542"))


func _reload(t: Dictionary) -> void:
	if t.ammo >= Units.TURRET_AMMO or credits < 25:
		sfx.play("error")
		return
	credits -= 25
	t.ammo = Units.TURRET_AMMO
	sfx.play("click")
	hud.toast("Turret reloaded", Color("#9fe870"))


func _enter_cockpit() -> void:
	var t := _nearest_turret(_aim_point(), 12.0)
	if t.is_empty():
		t = _nearest_turret(player.position, 40.0)
	if t.is_empty():
		hud.toast("Build a turret first (B), then E near it", Color("#8392b3"))
		return
	manned = t
	t.node.get_node("Head").visible = false
	_ck_look = Vector2.ZERO
	sfx.play("launch")
	hud.set_cockpit(true)


func _exit_cockpit() -> void:
	if manned.is_empty():
		return
	if is_instance_valid(manned.node):
		manned.node.get_node("Head").visible = true
	manned = {}
	hud.set_cockpit(false)


func _cockpit_transform() -> Transform3D:
	var eye: Vector3 = manned.pos + Vector3(0, 1.9, 0.5)
	# Look-follow: the further the mouse is from the centre, the further you turn.
	var basis := Basis.from_euler(Vector3(-_ck_look.y * 0.42 - 0.05, -_ck_look.x * 0.95, 0), EULER_ORDER_YXZ)
	return Transform3D(basis, eye)


func _update_turrets(delta: float) -> void:
	var lvl: int = arsenal.upgrades.turret
	for t in turrets:
		t.cd -= delta
		t.stunned = maxf(0.0, t.stunned - delta)
		Units.set_turret_look(t, t == manned)
		if t == manned or t.stunned > 0.0 or t.ammo <= 0:
			continue
		var target := {}
		var best: float = Units.TURRET_RANGE[lvl]
		for pk in packets:
			if pk.dead or pk.p.prot or pending.has(pk.id) or blocked.has(pk.id):
				continue
			var d: float = pk.pos.distance_to(t.pos)
			if d < best:
				best = d
				target = pk
		if target.is_empty():
			continue
		var head := t.head as Node3D
		var to: Vector3 = target.pos - (t.pos + Vector3.UP)
		head.rotation.y = atan2(-to.x, -to.z)
		if t.cd <= 0.0:
			t.cd = Units.TURRET_COOLDOWN[lvl]
			t.ammo -= 1
			var origin: Vector3 = t.pos + Vector3(0, 1.2, 0) + Vector3(-sin(head.rotation.y), 0, -cos(head.rotation.y)) * 1.7
			arsenal.bolt(origin, (target.pos - origin).normalized(), Color("#9fe870"), "turret")
			sfx.play("pew", -14.0, 0.05)


# ---------------------------------------------------------- gunships

func _call_gunship() -> void:
	if gunships.filter(func(g): return g.state != "leave").size() >= Units.MAX_GUNSHIPS:
		hud.toast("Max %d gunships in the air" % Units.MAX_GUNSHIPS, Color("#ff8899"))
		return
	if credits < price("gunship"):
		hud.toast("Need %d¢ for a gunship" % price("gunship"), Color("#ff8899"))
		sfx.play("error")
		return
	credits -= price("gunship")
	var r := level.radar_range()
	var g := Units.make_gunship(Vector3(r, 30, r))
	world.add_child(g.node)
	gunships.append(g)
	hud.toast("GUNSHIP INBOUND (40 s)", Color("#ffb347"))
	sfx.play("jet", -6.0)


func _update_gunships(delta: float) -> void:
	var r := maxf(30.0, level.radar_range() * 0.35)
	var hub_y := 9.0 if player.ground else 0.0
	for g in gunships:
		g.t += delta
		g.life -= delta
		if g.life <= 0.0 and g.state != "leave":
			g.state = "leave"
		var goal: Vector3
		if g.state == "leave":
			goal = g.pos + Vector3(0, 40, 0) + g.pos.normalized() * 60.0
		else:
			var s: float = g.t * 0.45
			goal = Vector3(sin(s) * r, hub_y + sin(s * 2.0) * 3.0, cos(s * 1.3) * r)
			if g.state == "arrive" and g.pos.distance_to(goal) < 8.0:
				g.state = "patrol"
		var want: Vector3 = goal - g.pos
		want = want.limit_length(14.0 if g.state == "patrol" else 30.0)
		g.vel = g.vel.lerp(want, minf(1.0, delta * 1.5))
		g.pos += g.vel * delta
		var node := g.node as Node3D
		node.position = g.pos
		(node.get_node("Rotor") as Node3D).rotate_y(delta * 40.0)
		var target := {}
		if g.state == "patrol":
			var best := 50.0
			for pk in packets:
				if pk.dead or pk.p.prot:
					continue
				if pk.get("boss", false):
					target = pk
					break
				var d: float = pk.pos.distance_to(g.pos)
				if d < best:
					best = d
					target = pk
		var look: Vector3 = (target.pos - g.pos) if not target.is_empty() else g.vel
		look.y = 0
		if look.length() > 0.1:
			node.rotation.y = lerp_angle(node.rotation.y, atan2(-look.x, -look.z), minf(1.0, delta * 3.0))
		if not target.is_empty():
			g.gun -= delta
			g.rocket -= delta
			var muzzle: Vector3 = g.pos + Vector3(0, -0.6, 0)
			if g.gun <= 0.0:
				g.gun = 0.16
				var dir: Vector3 = (target.pos - muzzle).normalized() + Vector3(randf_range(-0.03, 0.03), 0, randf_range(-0.03, 0.03))
				arsenal.bolt(muzzle, dir.normalized(), Color("#ffb347"), "heli")
			if g.rocket <= 0.0:
				g.rocket = 2.4
				arsenal.rocket(muzzle, Vector3(0, -0.4, -1), target)
				sfx.play("rocket", -8.0)
	for g in gunships.duplicate():
		if g.state == "leave" and g.pos.y > hub_y + 45.0:
			g.node.queue_free()
			gunships.erase(g)


## Tanks block flows by driving through them.
func _ram() -> void:
	if player.craft != "tank":
		return
	for pk in packets:
		if pk.dead or pk.pos.y > 4.0:
			continue
		var d := Vector2(pk.pos.x - player.position.x, pk.pos.z - player.position.z)
		if d.length() > 2.4 + pk.r:
			continue
		if pk.p.prot or pk.get("boss", false):
			player.position -= Vector3(d.x, 0, d.y).normalized() * 0.6
			player.velocity *= -0.3
			if pk.get("boss", false):
				damage(pk, 3.0 * get_process_delta_time() * 10.0, "ram")
			continue
		damage(pk, 99.0, "ram")
		sfx.play("boom", -8.0)


## Ask the daemon to block a flow. False if it's protected or already handled.
func request_kill(id: String) -> bool:
	if blocked.has(id) or pending.has(id) or flow_prot.get(id, false):
		return false
	pending[id] = true
	net.send({"t": "kill", "id": id})
	return true


func reskin_all() -> void:
	for pk in packets:
		if not pk.dead:
			world.reskin(pk.node, pk.p, pk.lane, pk.scale)


## Rockets lock onto the hovered packet, else the nearest one to the aim point.
func lock_target(aim: Vector3) -> Dictionary:
	if not hover.is_empty() and not hover.p.prot:
		return hover
	var best := {}
	var best_d := 30.0 * 30.0
	for pk in packets:
		if pk.dead or pk.p.prot:
			continue
		var d := aim.distance_squared_to(pk.pos)
		if d < best_d:
			best_d = d
			best = pk
	return best


# ------------------------------------------------------------- network

func _on_message(m: Dictionary) -> void:
	match m.get("t", ""):
		"hello":
			var h: Dictionary = m.hello
			var hosts: Array = h.protectHosts if h.get("protectHosts") != null else []
			hud.toast("Defending %s (%s XDP). Protected: %s" % [h.iface, h.mode, ", ".join(PackedStringArray(hosts))], Color("#5fe0ff"))
		"batch":
			_on_batch(m.pkts if m.get("pkts") != null else [])
		"stats":
			_on_stats(m.stats)
		"rules":
			var rules: Array = m.rules if m.get("rules") != null else []
			_on_rules(rules)
			hud.set_rules(rules)
		"killed":
			_on_killed(m)
		"deflect":
			pending.erase(m.id)
			hud.toast("Protected flow, shot deflected: %s" % m.label, Color("#7fe7ff"))
			sfx.play("shield")
		"panicked":
			blocked.clear()
			prev_drops.clear()
			hud.toast("PANIC: %d rules cleared, all traffic flows again" % int(m.n), Color("#5fe0ff"))
			world.explode(player.position + Vector3.UP * 3, Color("#5fe0ff"), 80, 16)
			sfx.play("jet", -8.0)
		"error":
			pending.erase(m.get("id", ""))
			hud.toast(str(m.msg), Color("#ff8899"))


func _now() -> float:
	return Time.get_ticks_msec() / 1000.0


func _on_batch(pkts: Array) -> void:
	for p in pkts:
		var lane := Lanes.classify(p)
		flow_lane[p.id] = lane
		flow_prot[p.id] = p.prot
		if blocked.has(p.id):
			continue # sampled before the rule landed; the kernel drops the rest
		var alive := 0
		var newest := {}
		for q in packets:
			if q.id == p.id and not q.dead:
				alive += 1
				newest = q
		if alive > 0 and (newest.get("boss", false) or level.should_merge(newest, alive)):
			newest.count += 1
			(newest.node.get_node("Label") as Label3D).text = "%s ×%d" % [Lanes.short_label(p), newest.count]
			if newest.get("boss", false):
				newest.hp = minf(newest.max_hp, newest.hp + 1.5) # the elephant feeds while its flow flows
			elif boss.is_empty() and _now() > next_boss_at and newest.count >= BOSS_SAMPLES and not p.prot:
				_promote_boss(newest)
			continue
		if packets.size() >= MAX_PACKETS:
			continue
		var suspicious := Lanes.is_suspicious(p)
		var scale := clampf(0.45 + 0.17 * log(maxf(p.len, 64) / 16.0) / log(2.0), 0.65, 1.5)
		var pk := {
			"id": p.id, "p": p, "lane": lane, "suspicious": suspicious, "count": 1,
			"scale": scale, "r": 0.95 * scale, "y": 0.9 * scale + 0.25, "hp": 1.0,
			"speed": randf_range(5.2, 8.0) * (1.3 if suspicious else 1.0),
			"phase": randf() * TAU, "dead": false, "pos": Vector3.ZERO,
		}
		pk.node = world.make_packet(p, lane, suspicious, scale)
		level.spawn(pk)
		pk.node.position = pk.pos
		packets.append(pk)


func _on_stats(s: Dictionary) -> void:
	var now := _now()
	if _stats_at > 0.0 and now > _stats_at:
		_pps = maxf(0.0, (int(s.seen) - _last_seen) / (now - _stats_at))
	_last_seen = int(s.seen)
	_stats_at = now
	_dropped = int(s.dropped)


func _on_rules(rules: Array) -> void:
	var ids := {}
	for r in rules:
		ids[r.id] = true
		var delta := int(r.drops) - int(prev_drops.get(r.id, 0))
		prev_drops[r.id] = int(r.drops)
		if not blocked.has(r.id):
			blocked[r.id] = _now()
		if delta > 0:
			score += delta
			profile.on_kernel_drops(delta)
	for id in blocked.keys():
		if not ids.has(id) and _now() - blocked[id] > 1.5:
			blocked.erase(id)
			prev_drops.erase(id)


func _on_killed(m: Dictionary) -> void:
	pending.erase(m.id)
	blocked[m.id] = _now()
	level.on_flow_blocked(m.id)
	var i := 0
	for q in packets.duplicate():
		if q.id == m.id and not q.dead and not q.get("boss", false):
			i += 1
			get_tree().create_timer(0.07 * i).timeout.connect(func(): _explode(q))
	combo = combo + 1 if combo_timer > 0.0 else 1
	combo_timer = 2.5
	var mult := mini(5, 1 + combo / 3)
	profile.on_blocked()
	if mult >= 5:
		profile.unlock("combo")
	var susp: bool = _suspicious_hits.has(m.id)
	_suspicious_hits.erase(m.id)
	score += (10 + (25 if susp else 0)) * mult
	credits += 20 if susp else 10
	kills += 1
	if kills % 15 == 0:
		strikes += 1
		hud.toast("+1 AIRSTRIKE for 15 blocked flows (F)", Color("#ff8a3d"))
	if not _selftest.is_empty():
		_selftest.kills[level_key] = _selftest.kills.get(level_key, 0) + 1
	hud.toast("FLOW BLOCKED  %s%s" % [m.label, "   ×%d" % mult if mult > 1 else ""], Color("#ffb3c0"))
	sfx.play("blocked", -6.0, 0.06)


# ----------------------------------------------------------- damage

## Every weapon ends here. Protected flows shrug it off; a destroyed packet
## becomes a kill request for its flow.
func damage(pk: Dictionary, amount: float, src := "player", tag := 0) -> void:
	if pk.dead or pk.p.prot:
		return
	pk.hp -= amount
	if pk.get("boss", false):
		pk.hit_flash = 0.08
		hud.set_boss(pk)
	if pk.hp <= 0.0:
		_kill(pk, src, tag)


func _kill(pk: Dictionary, src := "player", tag := 0) -> void:
	var was_boss: bool = pk.get("boss", false)
	_explode(pk)
	profile.on_kill(src, "cockpit" if not manned.is_empty() else player.craft, Skins.skin_for(pk.lane), was_boss)
	if src == "strike":
		profile.on_strike_kill(tag)
	if was_boss:
		_boss_defeated(pk)
	else:
		arsenal.maybe_drop(pk.pos, pk.suspicious)
	if pk.suspicious:
		_suspicious_hits[pk.id] = true
	request_kill(pk.id)


func _explode(pk: Dictionary) -> void:
	if pk.dead:
		return
	pk.dead = true
	world.explode(pk.pos, Lanes.LANES[pk.lane].color, 40 + int(pk.scale * 20))
	sfx.play("boom", -12.0)
	if is_instance_valid(pk.node):
		pk.node.queue_free()
	if hover.get("id", "") == pk.id:
		hover = {}


func _breach(pk: Dictionary) -> void:
	pk.dead = true
	pk.node.queue_free()
	var dmg := 20.0 if pk.get("boss", false) else 5.0 if pk.suspicious else 0.0
	if pk.get("boss", false):
		_end_boss()
	if dmg > 0.0:
		integrity = maxf(0.0, integrity - dmg)
		world.shake = 0.6 if dmg > 5.0 else 0.3
		world.explode(pk.pos, Color("#ff3355"), 30, 8)
		sfx.play("damage")
		if integrity <= 0.0:
			_game_over()


func _game_over() -> void:
	_award_xp()
	var sum := profile.end_run(score)
	var extra := "" if sum.unlocked.is_empty() else " · 🏆 " + ", ".join(PackedStringArray(sum.unlocked.map(func(a): return a.name)))
	hud.show_banner("HOST COMPROMISED · score %d · +%d XP%s" % [score, int(sum.xp), extra], Color("#ff3355"))
	hud.toast("New run started. Best score %d. K: research perks" % int(sum.best), Color("#f5c542"))
	sfx.play("damage")
	new_run()


## Score earns XP as you go (half a point of XP per point of score).
func _award_xp() -> void:
	if score > _xp_score:
		profile.add_xp((score - _xp_score) * 0.5)
	_xp_score = score


# ------------------------------------------------------------- bosses

func _promote_boss(pk: Dictionary) -> void:
	pk.boss = true
	pk.max_hp = minf(120.0, 40.0 + pk.count * 1.5)
	pk.hp = pk.max_hp
	pk.speed *= 0.4
	pk.base_scale = 2.4
	pk.r *= 2.4
	pk.emp = 5.0
	pk.hit_flash = 0.0
	var node: Node3D = pk.node
	var armor := Node3D.new()
	armor.name = "Armor"
	var plate := World.emissive(Color("#4a1828"), 0.5, 0.6)
	var edge := World.unshaded(Color("#ff3355"), 3.0)
	for i in 8:
		var a := float(i) / 8 * TAU
		var p := World.mesh_node(World.box(Vector3(0.9, 1.4, 0.18)), plate, Vector3(cos(a) * 1.9, 0, sin(a) * 1.9))
		p.rotation.y = -a + PI / 2
		armor.add_child(p)
		var e := World.mesh_node(World.box(Vector3(0.92, 0.06, 0.2)), edge, Vector3(cos(a) * 1.9, 0.72, sin(a) * 1.9))
		e.rotation.y = -a + PI / 2
		armor.add_child(e)
	node.add_child(armor)
	node.add_child(World.mesh_node(World.torus(2.5, 2.65), World.unshaded(Lanes.LANES[pk.lane].color, 3.0), Vector3(0, 1.1, 0)))
	boss = pk
	hud.set_boss(pk)
	hud.show_banner("⚠ ELEPHANT FLOW ⚠  %s:%d" % [pk.p.src, int(pk.p.sp)], Color("#ff3355"))
	sfx.play("boss")
	world.shake = 0.4


func _update_boss(pk: Dictionary, dt: float) -> void:
	pk.hit_flash = maxf(0.0, pk.hit_flash - dt)
	(pk.node.get_node("Armor") as Node3D).rotate_y(dt * 0.9)
	pk.emp -= dt
	if pk.emp <= 0.0:
		pk.emp = 7.0
		world.shockwave(pk.pos, 14.0, Color("#ff3355"))
		sfx.play("overheat")
		if player.position.distance_to(pk.pos) < 14.0:
			jammed = 2.5
			player.stunned = 2.5
			hud.toast("EMP! Guns jammed", Color("#ff3355"))
		for t in turrets:
			if t.pos.distance_to(pk.pos) < 14.0:
				t.stunned = 4.0


func _boss_defeated(pk: Dictionary) -> void:
	world.explode(pk.pos, Lanes.LANES[pk.lane].color, 160, 22)
	world.shockwave(pk.pos, 9.0, Color.WHITE)
	world.shake = 0.8
	sfx.play("fanfare")
	score += 500
	credits += 150
	for i in 4:
		arsenal.spawn_powerup(pk.pos + Vector3(randf_range(-3, 3), 0, randf_range(-3, 3)))
	hud.show_banner("ELEPHANT FLOW BLOCKED  +500", Color("#9fe870"))
	_end_boss()


func _end_boss() -> void:
	boss = {}
	next_boss_at = _now() + BOSS_GAP
	if hud:
		hud.set_boss({})


# ---------------------------------------------------------------- loop

func _process(delta: float) -> void:
	var t := _now()
	combo_timer = maxf(0.0, combo_timer - delta)
	jammed = maxf(0.0, jammed - delta)
	_regen += delta * (1.0 + profile.perk("regen") * 0.4)
	if _regen > 4.0:
		_regen = 0.0
		integrity = minf(max_integrity, integrity + 1.0)
	_award_xp()
	profile.tick(delta, _selftest.is_empty())
	if _selftest.is_empty():
		_update_hover()
	var aim := _aim_point()
	var menu := hud.menu_open()
	if not menu and manned.is_empty():
		player.update(delta, world.camera, aim)
	var muzzle := player.muzzle()
	if not manned.is_empty():
		var ck := _cockpit_transform()
		muzzle = ck.origin - ck.basis.z * 2.0 + Vector3(0, -0.5, 0)
	arsenal.update_fire(delta, firing and not menu and jammed <= 0.0, muzzle, aim)
	arsenal.update(delta)
	_update_turrets(delta)
	_update_gunships(delta)
	_ram()
	world.cam_target = _cockpit_transform() if not manned.is_empty() else level.camera_transform(player)
	player.visible = manned.is_empty()
	level.tick(delta, t)
	_update_packets(delta, t)
	_declutter()
	hud.set_stats(score, integrity / max_integrity * 100.0, _pps, _dropped)
	hud.update_arsenal()
	_update_radar(delta)
	music.intensity = minf(1.0, packets.size() / 50.0 + combo * 0.08 + (0.4 if not boss.is_empty() else 0.0))
	if not _selftest.is_empty():
		_run_selftest(delta)
	if _shot_at >= 0.0:
		_shot_at -= delta
		if _shot_at < 0.0:
			var path: String = user_args().get("screenshot", "user://shot.png")
			get_viewport().get_texture().get_image().save_png(path)
			print("screenshot saved to ", path)
			get_tree().quit()


## Where the player is aiming: the hovered packet, else the mouse projected
## onto the play plane (the ground for rovers, a camera-facing plane through
## the ship in space, straight down the lane for the classic cannon).
func _aim_point() -> Vector3:
	if not hover.is_empty():
		return hover.pos
	if not manned.is_empty():
		var ck := _cockpit_transform()
		return ck.origin - ck.basis.z * 80.0
	var mouse := get_viewport().get_mouse_position()
	var hit = null
	match player.mode:
		"cannon":
			hit = world.pick_plane(mouse, Plane(Vector3.UP, 0.0))
			return hit if hit != null else player.position + Vector3(0, 0, -60)
		"rover":
			hit = world.pick_plane(mouse, Plane(Vector3.UP, 1.0))
		"ship":
			hit = world.pick_plane(mouse, Plane(-world.camera.global_basis.z, player.position))
	return hit if hit != null else player.position + Vector3(0, 0, -50)


func _update_packets(delta: float, t: float) -> void:
	for pk in packets:
		if pk.dead:
			continue
		var before: Vector3 = pk.pos
		level.move(pk, delta, t)
		var node: Node3D = pk.node
		node.position = pk.pos
		var body := node.get_node("Body") as Node3D
		if body.get_meta("no_spin", false):
			# Creatures face where they're going (they're modelled facing +Z).
			var dir: Vector3 = pk.pos - before
			dir.y = 0
			if dir.length() > 0.001:
				body.basis = Basis.looking_at(-dir.normalized(), Vector3.UP).scaled(Vector3.ONE * pk.scale)
		else:
			body.rotation.y += delta * 1.2
		var warn := node.get_node_or_null("Warn") as MeshInstance3D
		if warn:
			warn.scale = Vector3.ONE * (1.0 + 0.08 * sin(t * 9.0))
		var base: float = pk.get("base_scale", 1.0)
		node.scale = Vector3.ONE * base * (1.25 if hover.get("id", "") == pk.id else 1.0) * (1.08 if pk.get("hit_flash", 0.0) > 0.0 else 1.0)
		if pk.get("boss", false):
			_update_boss(pk, delta)
		if level.reached_core(pk):
			_breach(pk)
	packets = packets.filter(func(q): return not q.dead)


func _update_hover() -> void:
	var mouse := get_viewport().get_mouse_position()
	if not manned.is_empty():
		mouse = get_viewport().get_visible_rect().size / 2 # cockpit: what's under the crosshair
	var o := world.camera.project_ray_origin(mouse)
	var d := world.camera.project_ray_normal(mouse)
	var best := {}
	var best_d := INF
	for pk in packets:
		if pk.dead:
			continue
		var c: Vector3 = pk.pos
		var along := (c - o).dot(d)
		if along < 0.0 or c.distance_to(o + d * along) > pk.r * 1.6:
			continue
		if along < best_d:
			best_d = along
			best = pk
	hover = best
	if hover.is_empty():
		hud.set_tooltip("", mouse)
		return
	var p: Dictionary = hover.p
	var ports := int(p.proto) == Lanes.PROTO_TCP or int(p.proto) == Lanes.PROTO_UDP
	var tags := (" · PROTECTED" if p.prot else "") + (" · SUSPICIOUS" if hover.suspicious else "")
	hud.set_tooltip("%s · %s%s\n%s\n→ %s\n%d B · flow %s" % [
		Lanes.LANES[hover.lane].name, Lanes.proto_name(p), tags,
		Lanes.host_port(p.src, int(p.sp)) if ports else p.src,
		Lanes.host_port(p.dst, int(p.dp)) if ports else p.dst,
		int(p.len), p.id], mouse)


func _update_radar(delta: float) -> void:
	_radar_t -= delta
	if _radar_t > 0.0:
		return
	_radar_t = 1.0 / 15.0
	var r := hud.radar
	r.world_range = level.radar_range()
	r.visible = r.world_range > 0.0
	if not r.visible:
		return
	r.marks = level.radar_marks()
	for pu in arsenal.powerups:
		r.marks.append({"pos": pu.pos, "color": pu.def.color, "size": 3.5})
	r.dots.clear()
	for pk in packets:
		r.dots.append(pk.pos)
		r.dots.append(Color("#ff3355") if pk.suspicious else Lanes.LANES[pk.lane].color)
	if not boss.is_empty():
		r.marks.append({"pos": boss.pos, "color": Color("#ff3355"), "size": 7.0})
	r.player_pos = player.position
	var fwd := _aim_point() - player.position
	r.player_dir = fwd if fwd.length() > 0.1 else Vector3.FORWARD
	r.queue_redraw()


## Labels in screen space: nearest first, never two within 70 px, at most 14.
func _declutter() -> void:
	var cam := world.camera
	var shown: Array[Vector2] = []
	var order := packets.duplicate()
	order.sort_custom(func(a, b): return cam.global_position.distance_squared_to(a.pos) < cam.global_position.distance_squared_to(b.pos))
	for pk in order:
		var label := pk.node.get_node("Label") as Label3D
		var vis := false
		if hover.get("id", "") == pk.id or pk.get("boss", false):
			vis = true
		elif shown.size() < 14 and not cam.is_position_behind(pk.pos) and cam.global_position.distance_to(pk.pos) < 95.0:
			var sp := cam.unproject_position(pk.pos)
			vis = true
			for o in shown:
				if o.distance_to(sp) < 70.0:
					vis = false
					break
			if vis:
				shown.append(sp)
		label.visible = vis


# ------------------------------------------------------------ selftest

## Headless smoke test (CI): demo traffic, auto-aim at the nearest packet,
## every level in turn, cycling through all weapons and calling an
## airstrike. Each level must block at least one flow.
func _run_selftest(delta: float) -> void:
	var st := _selftest
	var nearest := {}
	var best := INF
	for pk in packets:
		if pk.dead or pk.p.prot:
			continue
		var d := player.position.distance_to(pk.pos)
		if d < best:
			best = d
			nearest = pk
	hover = nearest # auto-aim
	if player.mode == "cannon" and not nearest.is_empty():
		player.lane = nearest.lane
	st.wt = st.get("wt", 0.0) + delta
	if st.wt > 1.2:
		st.wt = 0.0
		arsenal.next_weapon()
		arsenal.ammo.rocket = 40
		arsenal.ammo.grenade = 40
		arsenal.ammo.cluster = 15
	if not st.get("striked", false) and st.left < 5.0 and not nearest.is_empty():
		st.striked = true
		strikes = maxi(strikes, 1)
		arsenal.call_strike(nearest.pos)
	# Scripted tour of the other systems, keyed on time left in the level.
	var steps := [
		[7.5, func(): _build_turret(Vector3(16, 0, 14)); _build_turret(Vector3(-16, 0, -14)); _call_gunship()],
		[6.5, func(): _enter_cockpit()],
		[5.5, func(): _exit_cockpit(); player.toggle("tank")],
		[4.0, func(): player.toggle("heli")],
		[2.8, func(): player.toggle("jet")],
		[1.6, func():
			if boss.is_empty() and not nearest.is_empty():
				nearest.count = BOSS_SAMPLES
				_promote_boss(nearest)],
		[1.0, func(): player.set_craft(player.level_default)],
	]
	for i in steps.size():
		if st.has("current") and st.left <= steps[i][0] and not st.done_steps.has(i):
			st.done_steps[i] = true
			steps[i][1].call()
	st.left -= delta
	if st.left > 0.0:
		return
	if st.has("current"):
		print("SELFTEST level=%s kills=%d packets=%d" % [st.current, st.kills.get(st.current, 0), packets.size()])
	if st.queue.is_empty():
		var ok := true
		for key in st.kills.keys():
			ok = ok and st.kills[key] > 0
		ok = ok and st.kills.size() == st.get("ran", 0)
		for w in Arsenal.WEAPONS:
			ok = ok and arsenal.shots.get(w.key, 0) > 0
		print("SELFTEST %s kills=%s shots=%s profile_level=%d" % ["OK" if ok else "FAIL", st.kills, arsenal.shots, int(profile.data.level)])
		get_tree().quit(0 if ok else 1)
		return
	st.current = st.queue.pop_front()
	st.ran = st.get("ran", 0) + 1
	st.kills[st.current] = 0
	st.left = 8.0
	st.striked = false
	st.done_steps = {}
	Skins.global = {"arena": "neon", "swarm": "ducks", "graph": "invaders", "lanes": "critters"}[st.current]
	panic() # fresh traffic for each level: blocked flows stop producing samples
	set_level(st.current)
