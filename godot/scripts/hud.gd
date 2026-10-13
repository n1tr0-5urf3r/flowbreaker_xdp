class_name Hud
extends CanvasLayer
## 2D overlay: top bar, firewall rules panel, toasts, hover tooltip.

signal panic_pressed
signal unblock_pressed(id: String)
signal level_chosen(key: String)

const ACCENT := Color("#5fe0ff")
const RED := Color("#ff3355")
const DIM := Color("#8392b3")
const PANEL := Color(0.06, 0.09, 0.16, 0.92)

var game: Main
var font := SystemFont.new()
var credits_l: Label
var strikes_l: Label
var weapons_box: HBoxContainer
var buffs_l: Label
var boss_box: VBoxContainer
var boss_name: Label
var boss_bar: ProgressBar
var armory: PanelContainer
var research: PanelContainer
var skins_panel: PanelContainer
var crosshair: Label
var rank_l: Label
var xp_bar: ProgressBar
var _arsenal_t := 0.0
var score_l: Label
var integrity_bar: ProgressBar
var pps_l: Label
var drop_l: Label
var conn_l: Label
var rules_box: VBoxContainer
var rules_title: Label
var toasts: VBoxContainer
var tooltip: Label
var banner: Label
var hint: Label
var menu: PanelContainer
var radar: Radar
var _menu_keys: Array = []
var _rules_sig := ""


func _ready() -> void:
	font.font_names = PackedStringArray(["JetBrains Mono", "Fira Code", "DejaVu Sans Mono", "Monospace"])
	var root := Control.new()
	root.set_anchors_preset(Control.PRESET_FULL_RECT)
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(root)
	_build_top(root)
	_build_rules(root)
	toasts = VBoxContainer.new()
	# Top centre, under the bar: the bottom of the screen is where the cannon lives.
	toasts.set_anchors_preset(Control.PRESET_CENTER_TOP)
	toasts.position = Vector2(-450, 64)
	toasts.custom_minimum_size = Vector2(600, 0)
	toasts.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(toasts)
	tooltip = _label("", 13)
	tooltip.add_theme_stylebox_override("normal", _box(PANEL, Color("#2a3758")))
	tooltip.visible = false
	root.add_child(tooltip)
	banner = _label("", 30, ACCENT)
	banner.set_anchors_preset(Control.PRESET_CENTER_TOP)
	banner.position = Vector2(-400, 260)
	banner.custom_minimum_size = Vector2(800, 0)
	banner.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	banner.modulate.a = 0
	root.add_child(banner)
	hint = _label("", 12, DIM)
	hint.set_anchors_preset(Control.PRESET_BOTTOM_LEFT)
	hint.position = Vector2(250, -44)
	root.add_child(hint)
	var keys := _label("1–5/right-click weapon · F airstrike · B turret · E cockpit · T/H/J tank/heli/jet · G gunship · U armory · K research · O skins · M mute · Tab levels · Esc PANIC", 11, Color("#5a6a8c"))
	keys.set_anchors_preset(Control.PRESET_BOTTOM_LEFT)
	keys.position = Vector2(250, -24)
	root.add_child(keys)
	_build_arsenal(root)
	crosshair = _label("[ + ]", 28, Color("#ffb347"))
	crosshair.set_anchors_preset(Control.PRESET_CENTER)
	crosshair.position = Vector2(-34, -20)
	crosshair.visible = false
	root.add_child(crosshair)
	radar = Radar.new()
	radar.set_anchors_preset(Control.PRESET_BOTTOM_LEFT)
	radar.position = Vector2(16, -262)
	root.add_child(radar)
	_build_menu(root)


func _label(text: String, size := 14, color := Color.WHITE) -> Label:
	var l := Label.new()
	l.text = text
	l.add_theme_font_override("font", font)
	l.add_theme_font_size_override("font_size", size)
	l.add_theme_color_override("font_color", color)
	l.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return l


func _box(bg: Color, border: Color) -> StyleBoxFlat:
	var s := StyleBoxFlat.new()
	s.bg_color = bg
	s.border_color = border
	s.set_border_width_all(1)
	s.set_corner_radius_all(6)
	s.set_content_margin_all(8)
	return s


func _stat(parent: Control, caption: String) -> Label:
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 0)
	v.add_child(_label(caption, 10, DIM))
	var value := _label("0", 20)
	v.add_child(value)
	parent.add_child(v)
	return value


func _build_top(root: Control) -> void:
	var bar := PanelContainer.new()
	bar.set_anchors_preset(Control.PRESET_TOP_WIDE)
	bar.add_theme_stylebox_override("panel", _box(PANEL, Color("#1f2a44")))
	root.add_child(bar)
	var h := HBoxContainer.new()
	h.add_theme_constant_override("separation", 26)
	bar.add_child(h)
	var brand := _label("FLOWBREAKER", 20, ACCENT)
	h.add_child(brand)
	h.add_child(_label("XDP", 11, ACCENT))
	score_l = _stat(h, "SCORE")
	var iv := VBoxContainer.new()
	iv.add_child(_label("HOST INTEGRITY", 10, DIM))
	integrity_bar = ProgressBar.new()
	integrity_bar.custom_minimum_size = Vector2(170, 14)
	integrity_bar.show_percentage = false
	var fill := StyleBoxFlat.new()
	fill.bg_color = ACCENT
	fill.set_corner_radius_all(4)
	integrity_bar.add_theme_stylebox_override("fill", fill)
	integrity_bar.add_theme_stylebox_override("background", _box(Color("#1a2238"), Color("#1a2238")))
	iv.add_child(integrity_bar)
	h.add_child(iv)
	credits_l = _stat(h, "CREDITS ¢")
	strikes_l = _stat(h, "AIRSTRIKES")
	pps_l = _stat(h, "INGRESS pkt/s")
	drop_l = _stat(h, "DROPPED")
	var pv := VBoxContainer.new()
	rank_l = _label("LVL 1 · Script Kiddie", 10, Color("#f5c542"))
	pv.add_child(rank_l)
	xp_bar = ProgressBar.new()
	xp_bar.custom_minimum_size = Vector2(150, 8)
	xp_bar.show_percentage = false
	var xf := StyleBoxFlat.new()
	xf.bg_color = Color("#f5c542")
	xf.set_corner_radius_all(3)
	xp_bar.add_theme_stylebox_override("fill", xf)
	xp_bar.add_theme_stylebox_override("background", _box(Color("#1a2238"), Color("#1a2238")))
	pv.add_child(xp_bar)
	h.add_child(pv)
	var spacer := Control.new()
	spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	h.add_child(spacer)
	conn_l = _label("…", 12, DIM)
	h.add_child(conn_l)
	var panic := Button.new()
	panic.text = "PANIC"
	panic.add_theme_font_override("font", font)
	panic.add_theme_color_override("font_color", Color("#ff8899"))
	panic.add_theme_stylebox_override("normal", _box(Color("#3a1220"), RED))
	panic.add_theme_stylebox_override("hover", _box(Color("#561a2e"), RED))
	panic.add_theme_stylebox_override("pressed", _box(Color("#561a2e"), RED))
	panic.focus_mode = Control.FOCUS_NONE
	panic.pressed.connect(func(): panic_pressed.emit())
	h.add_child(panic)


func _build_rules(root: Control) -> void:
	var panel := PanelContainer.new()
	panel.set_anchors_preset(Control.PRESET_RIGHT_WIDE)
	panel.offset_left = -300
	panel.offset_top = 70
	panel.offset_bottom = -40
	panel.add_theme_stylebox_override("panel", _box(PANEL, Color("#1f2a44")))
	root.add_child(panel)
	var v := VBoxContainer.new()
	panel.add_child(v)
	rules_title = _label("FIREWALL RULES  0", 11, DIM)
	v.add_child(rules_title)
	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	v.add_child(scroll)
	rules_box = VBoxContainer.new()
	rules_box.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.add_child(rules_box)


# -------------------------------------------------------------- updates

func set_status(state: String, detail: String) -> void:
	var col: Color = {"online": Color("#9fe870"), "demo": Color("#f5c542")}.get(state, RED)
	conn_l.text = "%s · %s" % [state.to_upper(), detail]
	conn_l.add_theme_color_override("font_color", col)


func set_stats(score: int, integrity: float, pps: float, dropped: int) -> void:
	score_l.text = str(score)
	integrity_bar.value = integrity
	var fill: StyleBoxFlat = integrity_bar.get_theme_stylebox("fill")
	fill.bg_color = ACCENT if integrity > 50 else Color("#f5c542") if integrity > 25 else RED
	pps_l.text = str(int(pps))
	drop_l.text = str(dropped)


func set_rules(rules: Array) -> void:
	rules_title.text = "FIREWALL RULES  %d" % rules.size()
	# Rebuild only when the set of rules changes; otherwise update text in place.
	var sig := ",".join(PackedStringArray(rules.map(func(r): return str(r.id))))
	if sig != _rules_sig:
		_rules_sig = sig
		for c in rules_box.get_children():
			rules_box.remove_child(c) # detach now: queued nodes would still count as children
			c.queue_free()
		for r in rules:
			var row := PanelContainer.new()
			row.add_theme_stylebox_override("panel", _box(Color("#0c1222"), Color("#ff335588")))
			var v := VBoxContainer.new()
			row.add_child(v)
			var title := _label(r.label, 11)
			title.clip_text = true
			title.custom_minimum_size.x = 250
			v.add_child(title)
			var h := HBoxContainer.new()
			var meta := _label("", 11, Color("#ff8899"))
			meta.name = "Meta"
			meta.size_flags_horizontal = Control.SIZE_EXPAND_FILL
			h.add_child(meta)
			var x := Button.new()
			x.text = "✕"
			x.focus_mode = Control.FOCUS_NONE
			var id: String = r.id
			x.pressed.connect(func(): unblock_pressed.emit(id))
			h.add_child(x)
			v.add_child(h)
			rules_box.add_child(row)
	for i in rules.size():
		if i >= rules_box.get_child_count():
			break
		var meta := rules_box.get_child(i).find_child("Meta", true, false) as Label
		if meta:
			var r: Dictionary = rules[i]
			var ttl := "∞" if r.expiresIn < 0 else "%ds" % ceili(r.expiresIn)
			meta.text = "%d dropped · %s" % [int(r.drops), ttl]


func toast(text: String, color := Color.WHITE) -> void:
	var l := _label(text, 13, color)
	l.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	l.add_theme_stylebox_override("normal", _box(PANEL, color * Color(1, 1, 1, 0.6)))
	toasts.add_child(l)
	while toasts.get_child_count() > 3:
		toasts.get_child(0).free()
	var tw := l.create_tween() # bound to the label, so it dies with it
	tw.tween_interval(3.0)
	tw.tween_property(l, "modulate:a", 0.0, 0.6)
	tw.tween_callback(l.queue_free)


func show_banner(text: String, color := ACCENT) -> void:
	banner.text = text
	banner.add_theme_color_override("font_color", color)
	var tw := create_tween()
	tw.tween_property(banner, "modulate:a", 1.0, 0.2)
	tw.tween_interval(2.0)
	tw.tween_property(banner, "modulate:a", 0.0, 0.4)


func set_tooltip(text: String, at: Vector2) -> void:
	tooltip.visible = text != ""
	if text != "":
		tooltip.text = text
		tooltip.position = at + Vector2(18, 18)


# ---------------------------------------------------------- level menu

func _build_menu(root: Control) -> void:
	menu = PanelContainer.new()
	menu.set_anchors_preset(Control.PRESET_CENTER)
	menu.custom_minimum_size = Vector2(760, 0)
	menu.position = Vector2(-380, -260)
	menu.add_theme_stylebox_override("panel", _box(Color(0.04, 0.06, 0.12, 0.96), ACCENT))
	menu.visible = false
	root.add_child(menu)


func show_menu(cards: Array, current: String) -> void:
	for c in menu.get_children():
		menu.remove_child(c)
		c.queue_free()
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 10)
	menu.add_child(v)
	var title := _label("CHOOSE YOUR BATTLEFIELD", 22, ACCENT)
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	v.add_child(title)
	_menu_keys = []
	for i in cards.size():
		var card: Dictionary = cards[i]
		_menu_keys.append(card.key)
		var b := Button.new()
		b.text = "%d   %s\n     %s" % [i + 1, card.title, card.blurb]
		b.alignment = HORIZONTAL_ALIGNMENT_LEFT
		b.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		b.custom_minimum_size = Vector2(720, 64)
		b.add_theme_font_override("font", font)
		b.add_theme_font_size_override("font_size", 14)
		var border := ACCENT if card.key == current else Color("#2a3758")
		b.add_theme_stylebox_override("normal", _box(Color("#0c1222"), border))
		b.add_theme_stylebox_override("hover", _box(Color("#13203a"), ACCENT))
		b.add_theme_stylebox_override("pressed", _box(Color("#13203a"), ACCENT))
		b.focus_mode = Control.FOCUS_NONE
		var key: String = card.key
		b.pressed.connect(func(): _choose(key))
		v.add_child(b)
	v.add_child(_label("1–4 or click to play · Esc to close · Tab reopens this menu", 12, DIM))
	menu.visible = true


func menu_open() -> bool:
	return menu.visible or armory.visible or research.visible or skins_panel.visible


func _choose(key: String) -> void:
	menu.visible = false
	level_chosen.emit(key)


func _unhandled_input(event: InputEvent) -> void:
	for overlay in [armory, research, skins_panel]:
		if overlay.visible and event is InputEventKey and event.pressed and not event.echo:
			if event.keycode in [KEY_ESCAPE, KEY_U, KEY_K, KEY_O, KEY_TAB]:
				overlay.visible = false
				get_viewport().set_input_as_handled()
			return
	if not menu.visible or not (event is InputEventKey) or not event.pressed or event.echo:
		return
	var k: int = event.keycode
	if k >= KEY_1 and k < KEY_1 + _menu_keys.size():
		_choose(_menu_keys[k - KEY_1])
	elif k == KEY_ESCAPE or k == KEY_TAB:
		menu.visible = false
	get_viewport().set_input_as_handled()


func set_level(title: String, help: String) -> void:
	hint.text = help
	show_banner(title.to_upper())


# -------------------------------------------------------------- arsenal

func _build_arsenal(root: Control) -> void:
	var bottom := VBoxContainer.new()
	bottom.set_anchors_preset(Control.PRESET_CENTER_BOTTOM)
	bottom.position = Vector2(-330, -118)
	bottom.custom_minimum_size = Vector2(520, 0)
	bottom.alignment = BoxContainer.ALIGNMENT_END
	bottom.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(bottom)
	buffs_l = _label("", 13, Color("#f5c542"))
	buffs_l.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	bottom.add_child(buffs_l)
	weapons_box = HBoxContainer.new()
	weapons_box.add_theme_constant_override("separation", 6)
	weapons_box.alignment = BoxContainer.ALIGNMENT_CENTER
	bottom.add_child(weapons_box)
	for i in Arsenal.WEAPONS.size():
		var w: Dictionary = Arsenal.WEAPONS[i]
		var slot := PanelContainer.new()
		slot.custom_minimum_size = Vector2(96, 0)
		var v := VBoxContainer.new()
		v.add_theme_constant_override("separation", 0)
		slot.add_child(v)
		var name := _label("%d  %s" % [i + 1, w.name], 11, w.color)
		name.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		v.add_child(name)
		var ammo := _label("", 11, DIM)
		ammo.name = "Ammo"
		ammo.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		v.add_child(ammo)
		weapons_box.add_child(slot)
	boss_box = VBoxContainer.new()
	boss_box.set_anchors_preset(Control.PRESET_CENTER_TOP)
	boss_box.position = Vector2(-300, 190)
	boss_box.custom_minimum_size = Vector2(600, 0)
	boss_box.visible = false
	root.add_child(boss_box)
	boss_name = _label("", 14, RED)
	boss_name.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	boss_box.add_child(boss_name)
	boss_bar = ProgressBar.new()
	boss_bar.custom_minimum_size = Vector2(600, 12)
	boss_bar.show_percentage = false
	var fill := StyleBoxFlat.new()
	fill.bg_color = RED
	fill.set_corner_radius_all(5)
	boss_bar.add_theme_stylebox_override("fill", fill)
	boss_bar.add_theme_stylebox_override("background", _box(Color("#2a0f18"), RED))
	boss_box.add_child(boss_bar)
	var sub := _label("regenerates while its flow keeps flowing · its EMP jams nearby guns", 11, Color("#ffb0bb"))
	sub.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	boss_box.add_child(sub)
	armory = PanelContainer.new()
	armory.set_anchors_preset(Control.PRESET_CENTER)
	armory.custom_minimum_size = Vector2(640, 0)
	armory.position = Vector2(-320, -230)
	armory.add_theme_stylebox_override("panel", _box(Color(0.04, 0.06, 0.12, 0.96), Color("#9fe870")))
	armory.visible = false
	root.add_child(armory)
	research = PanelContainer.new()
	research.set_anchors_preset(Control.PRESET_CENTER)
	research.custom_minimum_size = Vector2(900, 0)
	research.position = Vector2(-450, -330)
	research.add_theme_stylebox_override("panel", _box(Color(0.04, 0.06, 0.12, 0.97), Color("#f5c542")))
	research.visible = false
	root.add_child(research)
	skins_panel = PanelContainer.new()
	skins_panel.set_anchors_preset(Control.PRESET_CENTER)
	skins_panel.custom_minimum_size = Vector2(560, 0)
	skins_panel.position = Vector2(-280, -260)
	skins_panel.add_theme_stylebox_override("panel", _box(Color(0.04, 0.06, 0.12, 0.97), Color("#e86bd0")))
	skins_panel.visible = false
	root.add_child(skins_panel)


func update_arsenal() -> void:
	_arsenal_t -= get_process_delta_time()
	if _arsenal_t > 0.0:
		return
	_arsenal_t = 0.1
	var a := game.arsenal
	var pr := game.profile
	rank_l.text = "LVL %d · %s · %d KP" % [int(pr.data.level), pr.rank(), int(pr.data.kp)]
	xp_bar.max_value = Profile.xp_for(int(pr.data.level))
	xp_bar.value = pr.data.xp
	credits_l.text = str(game.credits)
	strikes_l.text = "✈ %d" % game.strikes
	for i in Arsenal.WEAPONS.size():
		var w: Dictionary = Arsenal.WEAPONS[i]
		var slot := weapons_box.get_child(i) as PanelContainer
		var sel := i == a.weapon
		var empty: bool = w.ammo >= 0 and a.ammo[w.key] <= 0
		slot.add_theme_stylebox_override("panel", _box(Color("#13203a") if sel else Color(0.04, 0.06, 0.12, 0.85), w.color if sel else Color("#263252")))
		slot.modulate.a = 0.45 if empty else 1.0
		var ammo := slot.find_child("Ammo", true, false) as Label
		if w.key == "laser":
			var bars := int(a.heat / 10.0)
			ammo.text = ("OVERHEAT" if a.overheated else "heat " + "▮".repeat(bars) + "▯".repeat(10 - bars))
		else:
			ammo.text = "∞" if w.ammo < 0 else str(a.ammo[w.key])
	var parts := []
	for k in ["rapid", "spread", "overcharge"]:
		if a.has_buff(k):
			parts.append("%s %s %ds" % [Arsenal.POWERUPS[k].glyph, Arsenal.POWERUPS[k].name, ceili(a.buffs[k] - a.now())])
	if game.jammed > 0.0:
		parts.append("⚠ GUNS JAMMED")
	buffs_l.text = "   ".join(PackedStringArray(parts))


func set_boss(pk: Dictionary) -> void:
	boss_box.visible = not pk.is_empty()
	if pk.is_empty():
		return
	boss_name.text = "ELEPHANT FLOW · %s:%d → :%d  ×%d" % [pk.p.src, int(pk.p.sp), int(pk.p.dp), pk.count]
	boss_bar.max_value = pk.max_hp
	boss_bar.value = pk.hp


func show_armory() -> void:
	for c in armory.get_children():
		armory.remove_child(c)
		c.queue_free()
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 6)
	armory.add_child(v)
	var title := _label("ARMORY  ·  %d¢" % game.credits, 20, Color("#9fe870"))
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	v.add_child(title)
	var a := game.arsenal
	for u in Arsenal.UPGRADES:
		var lvl: int = a.upgrades[u.key]
		var maxed: bool = lvl >= u.levels.size() - 1
		var row := HBoxContainer.new()
		var pips := "●".repeat(lvl + 1) + "○".repeat(u.levels.size() - lvl - 1)
		var info := _label("%s  %s   %s%s" % [u.name, pips, u.levels[lvl], "" if maxed else "  →  " + u.levels[lvl + 1]], 13)
		info.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		row.add_child(info)
		var b := _button("MAX" if maxed else "%d¢" % u.cost[lvl])
		b.disabled = maxed or game.credits < u.cost[lvl]
		var key: String = u.key
		b.pressed.connect(func():
			a.buy_upgrade(key)
			show_armory())
		row.add_child(b)
		v.add_child(row)
	var ammo_row := HBoxContainer.new()
	var ammo_info := _label("Ammo pack   +4 rockets  +5 grenades  +1 cluster", 13)
	ammo_info.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	ammo_row.add_child(ammo_info)
	var ab := _button("%d¢" % Arsenal.AMMO_PACK_COST)
	ab.disabled = game.credits < Arsenal.AMMO_PACK_COST
	ab.pressed.connect(func():
		a.buy_ammo()
		show_armory())
	ammo_row.add_child(ab)
	v.add_child(ammo_row)
	v.add_child(_label("Credits come from blocked flows (more for suspicious ones), portals and bosses. U / Esc closes.", 11, DIM))
	armory.visible = true


func _button(text: String) -> Button:
	var b := Button.new()
	b.text = text
	b.custom_minimum_size = Vector2(80, 0)
	b.add_theme_font_override("font", font)
	b.focus_mode = Control.FOCUS_NONE
	return b


# ------------------------------------------------------------- research

func show_research() -> void:
	for c in research.get_children():
		research.remove_child(c)
		c.queue_free()
	var pr := game.profile
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 6)
	research.add_child(v)
	var title := _label("RESEARCH  ·  LVL %d %s  ·  %d KP to spend" % [int(pr.data.level), pr.rank(), int(pr.data.kp)], 18, Color("#f5c542"))
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	v.add_child(title)
	v.add_child(_label("PERMANENT PERKS (apply from your next run)", 11, DIM))
	var grid := GridContainer.new()
	grid.columns = 2
	grid.add_theme_constant_override("h_separation", 12)
	v.add_child(grid)
	for p in Profile.PERKS:
		var lvl := pr.perk(p.key)
		var maxed: bool = lvl >= p.cost.size()
		var row := HBoxContainer.new()
		row.custom_minimum_size.x = 430
		var now_txt := "now: " + Profile.perk_desc(p, lvl) if lvl > 0 else "not unlocked"
		var next_txt := "" if maxed else " · next: " + Profile.perk_desc(p, lvl + 1)
		var info := _label("%s  %s\n%s%s" % [p.name, "●".repeat(lvl) + "○".repeat(p.cost.size() - lvl), now_txt, next_txt], 11)
		info.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		info.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		row.add_child(info)
		var b := _button("MAX" if maxed else "%d KP" % p.cost[lvl])
		b.disabled = maxed or int(pr.data.kp) < p.cost[lvl]
		var key: String = p.key
		b.pressed.connect(func():
			if pr.buy_perk(key):
				game.sfx.play("upgrade")
			show_research())
		row.add_child(b)
		grid.add_child(row)
	var respec := _button("refund all perks")
	respec.pressed.connect(func():
		pr.respec()
		show_research())
	v.add_child(respec)
	v.add_child(_label("MEDALS", 11, DIM))
	var medals := GridContainer.new()
	medals.columns = 3
	v.add_child(medals)
	for a in Profile.ACHIEVEMENTS:
		var got: bool = pr.data.achievements.has(a.id)
		var l := _label("%s %s" % ["🏆" if got else "🔒", a.name], 12, Color("#f5c542") if got else DIM)
		l.tooltip_text = "%s · %d XP" % [a.desc, a.xp]
		l.mouse_filter = Control.MOUSE_FILTER_PASS
		l.custom_minimum_size.x = 290
		medals.add_child(l)
	var st: Dictionary = pr.data.stats
	v.add_child(_label("LIFETIME  runs %d · flows blocked %d · kernel drops %d · elephants %d · best score %d · %d min defending" % [
		int(st.runs), int(st.blocked), int(st.kernel_drops), int(st.bosses), int(st.best_score), int(st.play_seconds / 60.0)], 11, DIM))
	v.add_child(_label("K / Esc closes", 11, DIM))
	research.visible = true


# ---------------------------------------------------------------- skins

func show_skins() -> void:
	for c in skins_panel.get_children():
		skins_panel.remove_child(c)
		c.queue_free()
	var v := VBoxContainer.new()
	v.add_theme_constant_override("separation", 6)
	skins_panel.add_child(v)
	var title := _label("SKINS", 20, Color("#e86bd0"))
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	v.add_child(title)
	var all := HBoxContainer.new()
	all.add_child(_label("all packets", 13))
	all.add_child(_skin_picker(Skins.global, false, func(k):
		Skins.global = k
		_skins_changed()))
	v.add_child(all)
	v.add_child(_label("per lane (overrides)", 11, DIM))
	for lane in Lanes.LANES:
		var row := HBoxContainer.new()
		var l := _label(lane.name, 13, lane.color)
		l.custom_minimum_size.x = 120
		row.add_child(l)
		var key: String = lane.key
		row.add_child(_skin_picker(Skins.per_lane.get(key, ""), true, func(k):
			if k == "":
				Skins.per_lane.erase(key)
			else:
				Skins.per_lane[key] = k
			_skins_changed()))
		v.add_child(row)
	v.add_child(_label("O / Esc closes · saved for next time", 11, DIM))
	skins_panel.visible = true


func _skin_picker(current: String, allow_default: bool, on_pick: Callable) -> OptionButton:
	var ob := OptionButton.new()
	ob.add_theme_font_override("font", font)
	ob.focus_mode = Control.FOCUS_NONE
	var keys := ([""] if allow_default else []) + Skins.ORDER
	for i in keys.size():
		ob.add_item("(default)" if keys[i] == "" else Skins.NAMES[keys[i]], i)
		if keys[i] == current:
			ob.select(i)
	ob.item_selected.connect(func(i): on_pick.call(keys[i]))
	return ob


func _skins_changed() -> void:
	Skins.save()
	game.reskin_all()


func set_cockpit(on: bool) -> void:
	crosshair.visible = on
	if on:
		show_banner("TURRET COCKPIT")
		hint.text = "mouse: aim · click/Space: fire (unlimited) · R: reload auto-fire (25¢) · E: get out · Esc: PANIC"
	elif game and game.level:
		hint.text = game.level.help() + game._craft_help()
