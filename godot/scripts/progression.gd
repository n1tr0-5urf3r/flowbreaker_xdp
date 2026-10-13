class_name Profile
extends RefCounted
## Meta progression that survives between runs (port of web/js/progression.js):
## XP and levels, rank titles, Kernel Points (KP) for permanent perks,
## achievements and lifetime stats. Saved to user://profile.json.

signal level_up(level: int, kp: int, rank: String)
signal achievement(a: Dictionary)

var path := "user://profile.json"

const RANKS := [[1, "Script Kiddie"], [3, "Packet Pusher"], [6, "Port Warden"], [10, "Flow Breaker"],
	[15, "Kernel Whisperer"], [21, "Ring Zero Ronin"], [30, "XDP Overlord"]]

## cost[i] = KP for level i+1. desc uses the level the perk would have.
const PERKS := [
	{"key": "capital", "name": "Seed Capital", "desc": "start with +%d¢", "per": 60, "cost": [1, 2, 3]},
	{"key": "hardening", "name": "Kernel Hardening", "desc": "+%d max integrity", "per": 15, "cost": [1, 2, 3]},
	{"key": "regen", "name": "Self-Healing", "desc": "integrity regen +%d%%", "per": 40, "cost": [2, 3]},
	{"key": "stockpile", "name": "Stockpile", "desc": "start with +%d%% heavy ammo", "per": 50, "cost": [1, 2]},
	{"key": "airforce", "name": "Air Superiority", "desc": "start with +%d airstrikes", "per": 1, "cost": [2, 3]},
	{"key": "scavenger", "name": "Scavenger", "desc": "+%d%% power-up drop chance", "per": 4, "cost": [1, 2, 3]},
	{"key": "overclock", "name": "Overclock", "desc": "power-ups last +%d%%", "per": 25, "cost": [1, 2]},
	{"key": "engineering", "name": "Cheap Silicon", "desc": "turrets & gunships −%d%%", "per": 15, "cost": [2, 3]},
	{"key": "veteran", "name": "Veteran Gunner", "desc": "start runs with the twin blaster", "per": 0, "cost": [3]},
]

const ACHIEVEMENTS := [
	{"id": "first_blood", "name": "First Blood", "desc": "Block your first flow", "xp": 50},
	{"id": "panic", "name": "Don't Panic", "desc": "Hit the PANIC button", "xp": 25},
	{"id": "combo", "name": "Chain Reaction", "desc": "Reach a ×5 combo multiplier", "xp": 150},
	{"id": "elephant", "name": "Elephant Hunter", "desc": "Defeat an elephant flow", "xp": 300},
	{"id": "carpet", "name": "Carpet Bomber", "desc": "Destroy 5 packets with one airstrike", "xp": 200},
	{"id": "portal", "name": "Cut the Cable", "desc": "Cut off a whole network in the Topology Arena", "xp": 200},
	{"id": "roadkill", "name": "Roadkill", "desc": "Ram 10 packets with the tank in one run", "xp": 150},
	{"id": "chopper", "name": "Get to the Chopper", "desc": "Destroy 10 packets flying the helicopter in one run", "xp": 150},
	{"id": "ace", "name": "Top Gun", "desc": "Destroy 10 packets flying the jet in one run", "xp": 200},
	{"id": "laser", "name": "Laser Show", "desc": "Destroy 20 packets with the laser in one run", "xp": 150},
	{"id": "ducks", "name": "Duck Hunt", "desc": "Destroy 25 rubber ducks (lifetime)", "xp": 100},
	{"id": "explorer", "name": "Explorer", "desc": "Play all four levels", "xp": 100},
	{"id": "survivor", "name": "Uptime", "desc": "Survive 10 minutes in one run", "xp": 250},
	{"id": "centurion", "name": "Centurion", "desc": "Block 100 flows (lifetime)", "xp": 300},
	{"id": "kilo", "name": "Kilodrop", "desc": "Have the kernel drop 1000 packets for you (lifetime)", "xp": 300},
]

var data := {}
var run := {}
var _dirty := false
var _save_t := 0.0


static func xp_for(lvl: int) -> int:
	return roundi(120.0 * pow(lvl, 1.5))


func _init(p := "user://profile.json") -> void:
	path = p
	data = _fresh()
	if FileAccess.file_exists(path):
		var s = JSON.parse_string(FileAccess.get_file_as_string(path))
		if s is Dictionary:
			for k in data.keys():
				var numeric: bool = (s.get(k) is float or s.get(k) is int) and (data[k] is float or data[k] is int)
				if s.has(k) and (typeof(s[k]) == typeof(data[k]) or numeric):
					if data[k] is Dictionary:
						data[k].merge(s[k], true)
					elif data[k] is int:
						data[k] = int(s[k]) # JSON hands numbers back as floats
					else:
						data[k] = s[k]
	new_run()


static func _fresh() -> Dictionary:
	return {"xp": 0.0, "level": 1, "kp": 0, "perks": {}, "achievements": {}, "levels_played": {},
		"stats": {"runs": 0, "blocked": 0, "kernel_drops": 0, "bosses": 0, "best_score": 0, "play_seconds": 0.0, "ducks": 0}}


func save() -> void:
	_dirty = false
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f:
		f.store_string(JSON.stringify(data))


## Call every frame; writes the profile at most every 5 s.
func tick(dt: float, alive: bool) -> void:
	if alive:
		run.seconds += dt
		data.stats.play_seconds += dt
		if run.seconds >= 600.0:
			unlock("survivor")
		_dirty = true
	_save_t -= dt
	if _save_t <= 0.0:
		_save_t = 5.0
		if _dirty:
			save()


func new_run() -> void:
	run = {"xp": 0.0, "start_level": int(data.level), "unlocked": [], "laser": 0, "ram": 0, "heli": 0, "jet": 0, "seconds": 0.0, "strike_kills": {}}


func perk(key: String) -> int:
	return int(data.perks.get(key, 0))


func rank() -> String:
	var r: String = RANKS[0][1]
	for pair in RANKS:
		if int(data.level) >= pair[0]:
			r = pair[1]
	return r


static func perk_desc(p: Dictionary, lvl: int) -> String:
	return p.desc % (p.per * lvl) if "%" in p.desc else p.desc


func add_xp(n: float) -> void:
	if n <= 0.0:
		return
	data.xp += n
	run.xp += n
	while data.xp >= xp_for(int(data.level)):
		data.xp -= xp_for(int(data.level))
		data.level = int(data.level) + 1
		var kp := 2 if int(data.level) % 5 == 0 else 1
		data.kp = int(data.kp) + kp
		level_up.emit(int(data.level), kp, rank())
	_dirty = true


func unlock(id: String) -> void:
	if data.achievements.has(id):
		return
	for a in ACHIEVEMENTS:
		if a.id == id:
			data.achievements[id] = Time.get_unix_time_from_system()
			run.unlocked.append(a)
			achievement.emit(a)
			add_xp(a.xp)
			save()
			return


func buy_perk(key: String) -> bool:
	for p in PERKS:
		if p.key == key:
			var lvl := perk(key)
			if lvl >= p.cost.size() or int(data.kp) < p.cost[lvl]:
				return false
			data.kp = int(data.kp) - p.cost[lvl]
			data.perks[key] = lvl + 1
			save()
			return true
	return false


func respec() -> void:
	var back := 0
	for p in PERKS:
		for i in perk(p.key):
			back += p.cost[i]
	data.kp = int(data.kp) + back
	data.perks = {}
	save()


# ------------------------------------------------------------- events

## A packet destroyed. src: player/laser/ram/strike/turret/heli; vehicle: the
## craft the player was in.
func on_kill(src: String, vehicle: String, skin: String, boss: bool) -> void:
	if src == "laser": run.laser += 1
	if src == "ram": run.ram += 1
	if vehicle == "heli" and src in ["player", "laser"]: run.heli += 1
	if vehicle == "jet" and src in ["player", "laser"]: run.jet += 1
	if skin == "ducks": data.stats.ducks += 1
	if boss:
		data.stats.bosses += 1
		unlock("elephant")
	if run.laser >= 20: unlock("laser")
	if run.ram >= 10: unlock("roadkill")
	if run.heli >= 10: unlock("chopper")
	if run.jet >= 10: unlock("ace")
	if data.stats.ducks >= 25: unlock("ducks")
	_dirty = true


func on_strike_kill(tag: int) -> void:
	var n: int = run.strike_kills.get(tag, 0) + 1
	run.strike_kills[tag] = n
	if n >= 5:
		unlock("carpet")


func on_blocked() -> void:
	data.stats.blocked += 1
	unlock("first_blood")
	if data.stats.blocked >= 100:
		unlock("centurion")
	_dirty = true


func on_kernel_drops(n: int) -> void:
	data.stats.kernel_drops += n
	if data.stats.kernel_drops >= 1000:
		unlock("kilo")
	_dirty = true


func on_level_played(key: String) -> void:
	data.levels_played[key] = true
	if data.levels_played.size() >= 4:
		unlock("explorer")


func end_run(score: int) -> Dictionary:
	data.stats.runs += 1
	data.stats.best_score = maxi(int(data.stats.best_score), score)
	save()
	return {"xp": run.xp, "levels": int(data.level) - int(run.start_level), "unlocked": run.unlocked, "best": data.stats.best_score}
