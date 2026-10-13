class_name Sfx
extends Node
## Procedural sound effects: every sound is synthesised into a WAV buffer at
## startup (no audio assets), then played from a small pool of players.

const RATE := 22050
const POOL := 14

var streams := {}
var _players: Array[AudioStreamPlayer] = []
var _next := 0
var _laser: AudioStreamPlayer
var _last := {}
var muted := false


func _ready() -> void:
	streams = {
		"pew": _render(0.2, func(t, d): return _sweep(t, d, 1700, 210, "square") * 0.5 + _sweep(t, d, 1720, 200, "saw") * 0.25 + _noise_burst(t, 0.03) * 0.25),
		"rocket": _render(0.7, func(t, d): return _band_noise(t, d, 600, 2400) * 0.6 + _sweep(t, d, 90, 220, "saw") * 0.2),
		"launch": _render(0.18, func(t, d): return _sweep(t, d, 220, 70, "sine") * 0.9 + _noise_burst(t, 0.06) * 0.3),
		"boom": _render(0.7, func(t, d): return _low_noise(t, d, 2600, 90) * 0.8 + _sweep(t, d, 120, 30, "sine") * 0.9),
		"pop": _render(0.18, func(t, d): return _noise_burst(fmod(t, 0.045), 0.03) * 0.7),
		"powerup": _render(0.35, func(t, _d): return _arp(t, [76, 81, 85, 88, 93], 0.045, "triangle") * 0.6),
		"blocked": _render(0.32, func(t, _d): return _arp(t, [81, 85, 88, 93], 0.055, "triangle") * 0.5),
		"upgrade": _render(0.35, func(t, _d): return _arp(t, [72, 79, 84], 0.08, "square") * 0.35),
		"error": _render(0.25, func(t, _d): return _tone(t, 150 if t < 0.1 else 120, "square") * 0.4 * float(fmod(t, 0.12) < 0.09)),
		"click": _render(0.05, func(t, _d): return _noise_burst(t, 0.02) * 0.4),
		"shield": _render(0.3, func(t, d): return _sweep(t, d, 1900, 2300, "sine") * 0.4 * (1.0 - t / d)),
		"siren": _render(1.2, func(t, _d): return _tone(t, 600 + 300 * fmod(t, 0.4) / 0.4, "saw") * 0.25),
		"jet": _render(2.4, func(t, d): return _band_noise(t, d, 2600, 350) * sin(PI * t / d) * 0.8),
		"overheat": _render(0.6, func(t, d): return _band_noise(t, d, 2500, 6000) * 0.5 * (1.0 - t / d)),
		"damage": _render(0.4, func(t, d): return _sweep(t, d, 240, 90, "saw") * 0.5 + _low_noise(t, d, 900, 120) * 0.4),
		"boss": _render(2.0, func(t, _d): return _tone(t, 330 if fmod(t, 0.5) < 0.25 else 247, "square") * 0.25),
		"fanfare": _render(1.4, func(t, _d): return _arp(t, [69, 72, 76, 81, 84, 88, 93], 0.09, "saw") * 0.3),
	}
	var laser := AudioStreamWAV.new()
	laser.format = AudioStreamWAV.FORMAT_16_BITS
	laser.mix_rate = RATE
	laser.data = _pcm(0.5, func(t, _d): return (_tone(t, 110 + 30 * sin(TAU * 22 * t), "saw") * 0.5 + _tone(t, 222, "square") * 0.2))
	laser.loop_mode = AudioStreamWAV.LOOP_FORWARD
	laser.loop_end = int(0.5 * RATE)
	streams.laser = laser
	for i in POOL:
		var p := AudioStreamPlayer.new()
		add_child(p)
		_players.append(p)
	_laser = AudioStreamPlayer.new()
	_laser.stream = laser
	_laser.volume_db = -10
	add_child(_laser)


func play(name: String, db := 0.0, min_gap := 0.03) -> void:
	if muted or not streams.has(name):
		return
	var now := Time.get_ticks_msec() / 1000.0
	if now - _last.get(name, -1.0) < min_gap:
		return
	_last[name] = now
	var p := _players[_next]
	_next = (_next + 1) % POOL
	p.stream = streams[name]
	p.volume_db = db
	p.pitch_scale = randf_range(0.93, 1.07)
	p.play()


func laser(on: bool) -> void:
	if on and not muted and not _laser.playing:
		_laser.play()
	elif not on and _laser.playing:
		_laser.stop()


func set_muted(m: bool) -> void:
	muted = m
	if m:
		_laser.stop()
	AudioServer.set_bus_mute(0, m)


# ------------------------------------------------------------- synthesis

func _render(dur: float, f: Callable) -> AudioStreamWAV:
	var s := AudioStreamWAV.new()
	s.format = AudioStreamWAV.FORMAT_16_BITS
	s.mix_rate = RATE
	s.data = _pcm(dur, f)
	return s


## Renders f(t, dur) into 16-bit PCM with a short fade-in/out.
func _pcm(dur: float, f: Callable) -> PackedByteArray:
	var n := int(dur * RATE)
	var out := PackedByteArray()
	out.resize(n * 2)
	_lp = 0.0
	_lp2 = 0.0
	for i in n:
		var t := float(i) / RATE
		var env := minf(1.0, t / 0.004) * minf(1.0, (dur - t) / 0.02)
		var v := clampf(float(f.call(t, dur)) * env, -1.0, 1.0)
		out.encode_s16(i * 2, int(v * 32000))
	return out


static func _wave(phase: float, kind: String) -> float:
	var x := fmod(phase, 1.0)
	match kind:
		"square": return 1.0 if x < 0.5 else -1.0
		"saw": return x * 2.0 - 1.0
		"triangle": return 4.0 * absf(x - 0.5) - 1.0
	return sin(TAU * x)


static func _tone(t: float, freq: float, kind: String) -> float:
	return _wave(t * freq, kind)


## Exponential pitch sweep from f0 to f1 over dur, with a decaying envelope.
static func _sweep(t: float, dur: float, f0: float, f1: float, kind: String) -> float:
	var k := log(f1 / f0) / dur
	var phase := f0 * (exp(k * t) - 1.0) / k
	return _wave(phase, kind) * exp(-3.0 * t / dur)


static func _noise_burst(t: float, len: float) -> float:
	return randf_range(-1, 1) * maxf(0.0, 1.0 - t / len)


var _lp := 0.0
var _lp2 := 0.0


## Noise through a lowpass whose cutoff sweeps from f0 to f1 (an explosion).
func _low_noise(t: float, dur: float, f0: float, f1: float) -> float:
	var fc := f0 * pow(f1 / f0, t / dur)
	var a := 1.0 - exp(-TAU * fc / RATE)
	_lp += a * (randf_range(-1, 1) - _lp)
	return _lp * 2.5 * exp(-2.5 * t / dur)


## Band-ish noise: the difference of two lowpasses, centre sweeping f0 -> f1.
func _band_noise(t: float, dur: float, f0: float, f1: float) -> float:
	var fc := f0 * pow(f1 / f0, t / dur)
	var a := 1.0 - exp(-TAU * fc * 1.5 / RATE)
	var b := 1.0 - exp(-TAU * fc * 0.6 / RATE)
	var x := randf_range(-1, 1)
	_lp += a * (x - _lp)
	_lp2 += b * (x - _lp2)
	return (_lp - _lp2) * 3.0


static func _arp(t: float, notes: Array, step: float, kind: String) -> float:
	var i := mini(int(t / step), notes.size() - 1)
	var local := t - i * step
	var freq := 440.0 * pow(2.0, (float(notes[i]) - 69.0) / 12.0)
	return _wave(t * freq, kind) * exp(-6.0 * local)
