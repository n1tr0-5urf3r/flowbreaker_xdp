class_name Music
extends Node
## A procedural synthwave loop in A minor (Am F C G, 96 bpm), like the web
## version. Two layers are rendered on a worker thread: the base (drums, bass,
## pad) and an arpeggio whose volume follows how busy the board is.

const RATE := 22050
const BPM := 96.0
const CHORDS := [[45, 3], [41, 4], [48, 4], [43, 4]] # root midi note, third

var intensity := 0.0
var _base: AudioStreamPlayer
var _arp: AudioStreamPlayer
var _thread: Thread


func _ready() -> void:
	_base = AudioStreamPlayer.new()
	_arp = AudioStreamPlayer.new()
	_base.volume_db = -9.0
	_arp.volume_db = -40.0
	add_child(_base)
	add_child(_arp)
	_thread = Thread.new()
	_thread.start(_render)


func _exit_tree() -> void:
	if _thread and _thread.is_started():
		_thread.wait_to_finish()


func _process(delta: float) -> void:
	var target := lerpf(-28.0, -11.0, clampf(intensity, 0.0, 1.0)) if intensity > 0.05 else -40.0
	_arp.volume_db = lerpf(_arp.volume_db, target, minf(1.0, delta * 2.0))


func set_muted(m: bool) -> void:
	_base.stream_paused = m
	_arp.stream_paused = m


static func _midi(n: float) -> float:
	return 440.0 * pow(2.0, (n - 69.0) / 12.0)


func _render() -> void:
	var step := 60.0 / BPM / 4.0 # sixteenth
	var steps := 64
	var n := int(step * steps * RATE)
	var base := PackedFloat32Array()
	var arp := PackedFloat32Array()
	base.resize(n)
	arp.resize(n)
	var lp := 0.0
	for i in n:
		var t := float(i) / RATE
		var s := int(t / step)
		var st := t - s * step
		var bar := s / 16
		var chord: Array = CHORDS[bar % 4]
		var root: int = chord[0]
		var third: int = chord[1]
		var bt := t - bar * 16 * step
		# Pad: detuned saw triad, slow attack per bar.
		var pad := 0.0
		for iv in [12, 12 + third, 19]:
			var f := _midi(root + iv)
			pad += fmod(t * f * 1.004, 1.0) + fmod(t * f * 0.996, 1.0) - 1.0
		pad *= 0.045 * minf(1.0, bt / 0.5)
		# Bass: eighths with an octave bounce, plucked through a lowpass.
		var bass_note: int = root + (12 if s % 4 == 2 else 0)
		var et := t - (s / 2) * 2 * step
		var raw := fmod(t * _midi(bass_note), 1.0) * 2.0 - 1.0
		var cut := 1.0 - exp(-TAU * (180.0 + 900.0 * exp(-et * 14.0)) / RATE)
		lp += cut * (raw - lp)
		var bass := lp * 0.32 * exp(-et * 5.0)
		# Drums: kick on beats, snare on 2 and 4, hats on the off-eighths.
		var drums := 0.0
		if s % 4 == 0:
			drums += sin(TAU * (45.0 * st + 105.0 * (1.0 - exp(-st * 18.0)) / 18.0)) * exp(-st * 11.0) * 0.55
		if s % 16 == 4 or s % 16 == 12:
			drums += randf_range(-1, 1) * exp(-st * 22.0) * 0.18
		if s % 4 == 2:
			drums += randf_range(-1, 1) * exp(-st * 60.0) * 0.08
		base[i] = pad + bass + drums
		# Arpeggio: square sixteenths over the chord tones.
		var pattern := [12, 12 + third, 19, 24, 19, 12 + third]
		var an := _midi(root + 12 + pattern[s % pattern.size()])
		arp[i] = (1.0 if fmod(t * an, 1.0) < 0.5 else -1.0) * exp(-st * 14.0) * 0.12
	call_deferred("_start", _wav(base), _wav(arp), n)


func _wav(buf: PackedFloat32Array) -> AudioStreamWAV:
	var data := PackedByteArray()
	data.resize(buf.size() * 2)
	for i in buf.size():
		data.encode_s16(i * 2, int(clampf(buf[i], -1.0, 1.0) * 30000))
	var w := AudioStreamWAV.new()
	w.format = AudioStreamWAV.FORMAT_16_BITS
	w.mix_rate = RATE
	w.data = data
	w.loop_mode = AudioStreamWAV.LOOP_FORWARD
	w.loop_end = buf.size()
	return w


func _start(base: AudioStreamWAV, arp: AudioStreamWAV, _n: int) -> void:
	_base.stream = base
	_arp.stream = arp
	_base.play()
	_arp.play()
