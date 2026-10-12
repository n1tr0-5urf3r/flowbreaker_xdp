// Procedural sound: every effect and the music loop are synthesised with the
// Web Audio API, so there are no audio assets to ship. Browsers only allow
// audio after a user gesture; the context is created on the first click/key.

const STORE_KEY = 'flowbreaker-audio';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const midi = (n) => 440 * 2 ** ((n - 69) / 12);

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && typeof s === 'object') return { muted: !!s.muted, sfx: clamp(+s.sfx || 0, 0, 1), music: clamp(+s.music || 0, 0, 1) };
  } catch { /* storage unavailable: use defaults */ }
  return { muted: false, sfx: 0.8, music: 0.45 };
}

export class Sound {
  constructor() {
    this.ctx = null;
    this.settings = loadSettings();
    this.intensity = 0; // 0..1, set by the game; drives the music
    this.paused = false;
    this.last = {};
    const unlock = () => this.ensure();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    document.addEventListener('visibilitychange', () => {
      if (!this.ctx) return;
      if (document.hidden) this.ctx.suspend();
      else this.ctx.resume();
    });
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      const ctx = new AC();
      this.ctx = ctx;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 6;
      comp.connect(ctx.destination);
      this.master = ctx.createGain();
      this.master.connect(comp);
      this.sfxBus = ctx.createGain();
      this.sfxBus.connect(this.master);
      this.musicBus = ctx.createGain();
      this.musicBus.connect(this.master);
      // Echo for the arpeggio.
      this.delay = ctx.createDelay(1);
      this.delay.delayTime.value = (60 / 96) * 0.75;
      const fb = ctx.createGain();
      fb.gain.value = 0.32;
      const wet = ctx.createGain();
      wet.gain.value = 0.35;
      this.delay.connect(fb).connect(this.delay);
      this.delay.connect(wet).connect(this.musicBus);

      const len = ctx.sampleRate;
      this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

      this.applySettings();
      this.startMusic();
    }
    if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume();
    return true;
  }

  // ------------------------------------------------------------ settings

  applySettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.settings)); } catch { /* ignore */ }
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.settings.muted ? 0 : 1, t, 0.03);
    this.sfxBus.gain.setTargetAtTime(this.settings.sfx, t, 0.03);
    this.musicBus.gain.setTargetAtTime(this.settings.music * (this.paused ? 0.35 : 1), t, 0.2);
  }

  set(key, value) {
    this.settings[key] = value;
    this.applySettings();
  }

  toggleMute() {
    this.set('muted', !this.settings.muted);
    return this.settings.muted;
  }

  setPaused(on) {
    this.paused = on;
    this.applySettings();
  }

  // ------------------------------------------------------------ helpers

  ready(name, minMs) {
    if (!this.ctx || this.settings.muted) return false;
    const now = performance.now();
    if (minMs && now - (this.last[name] ?? 0) < minMs) return false;
    this.last[name] = now;
    return true;
  }

  // Output node for a sound at world position (x, z): stereo pan by x and
  // quieter towards the far gate.
  out(x = 0, z = 0, bus = this.sfxBus) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    g.gain.value = 1 - 0.6 * clamp(-z / 84, 0, 1);
    if (ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(x / 18, -0.9, 0.9);
      g.connect(p).connect(bus);
    } else {
      g.connect(bus);
    }
    return g;
  }

  tone({ type = 'sine', f0, f1 = f0, dur, gain, at = 0, dest, attack = 0.004, curve = 'exp' }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + at;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) {
      if (curve === 'exp') o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
      else o.frequency.linearRampToValueAtTime(f1, t + dur);
    }
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(dest ?? this.sfxBus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  noise({ dur, gain, filter = 'lowpass', f0 = 2000, f1 = f0, q = 0.8, at = 0, dest, attack = 0.003 }) {
    const ctx = this.ctx;
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const bq = ctx.createBiquadFilter();
    bq.type = filter;
    bq.Q.value = q;
    bq.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) bq.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bq).connect(g).connect(dest ?? this.sfxBus);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  // ------------------------------------------------------------ effects

  // Laser "pew": a fast downward pitch sweep, layered with a detuned second
  // oscillator and a click transient. Pitch varies a little per shot so
  // rapid fire doesn't sound like one sample on repeat.
  pew({ f0, f1, dur, gain, types = ['square', 'sawtooth'], dest, click = 0.08 }) {
    const v = 0.92 + Math.random() * 0.16;
    this.tone({ type: types[0], f0: f0 * v, f1: f1 * v, dur, gain, dest, attack: 0.002 });
    this.tone({ type: types[1], f0: f0 * v * 1.012, f1: f1 * v * 0.99, dur: dur * 0.9, gain: gain * 0.55, dest, attack: 0.002 });
    this.tone({ type: 'sine', f0: f0 * v * 2, f1: f1 * v * 2, dur: dur * 0.5, gain: gain * 0.35, dest, attack: 0.002 });
    if (click) this.noise({ dur: 0.035, gain: click, filter: 'highpass', f0: 3500, dest, attack: 0.001 });
  }

  shoot(kind, x = 0, z = 0) {
    if (kind === 'turret') {
      if (!this.ready('turret', 40)) return;
      this.pew({ f0: 2100, f1: 420, dur: 0.14, gain: 0.13, types: ['triangle', 'square'], dest: this.out(x, z), click: 0.04 });
      return;
    }
    if (kind === 'cockpit') {
      if (!this.ready('cockpit', 25)) return;
      this.pew({ f0: 1500, f1: 130, dur: 0.24, gain: 0.2, click: 0.12 });
      this.tone({ type: 'sine', f0: 170, f1: 38, dur: 0.22, gain: 0.38, attack: 0.002 }); // chest thump
      return;
    }
    if (kind === 'heli') {
      if (!this.ready('heli', 50)) return;
      const d = this.out(x, z);
      this.noise({ dur: 0.05, gain: 0.12, filter: 'bandpass', f0: 1400, q: 2, dest: d });
      this.tone({ type: 'square', f0: 300, f1: 120, dur: 0.05, gain: 0.05, dest: d });
      return;
    }
    if (kind === 'tank') {
      if (!this.ready('tankgun', 25)) return;
      this.pew({ f0: 1200, f1: 150, dur: 0.22, gain: 0.2, dest: this.out(x, z), click: 0.1 });
      this.tone({ type: 'sine', f0: 120, f1: 40, dur: 0.2, gain: 0.3 });
      return;
    }
    if (!this.ready('cannon', 25)) return;
    this.pew({ f0: 1700, f1: 210, dur: 0.19, gain: 0.2, dest: this.out(x, 0) });
  }

  // Continuous laser hum while the beam is on.
  laser(on) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    if (on && !this.laserVoice) {
      const o1 = ctx.createOscillator();
      const o2 = ctx.createOscillator();
      const lfo = ctx.createOscillator();
      const lfoGain = ctx.createGain();
      o1.type = 'sawtooth';
      o1.frequency.value = 110;
      o2.type = 'square';
      o2.frequency.value = 221;
      lfo.frequency.value = 23;
      lfoGain.gain.value = 30;
      lfo.connect(lfoGain).connect(o1.frequency);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 900;
      bp.Q.value = 1.5;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.14, ctx.currentTime + 0.05);
      o1.connect(bp);
      o2.connect(bp);
      bp.connect(g).connect(this.sfxBus);
      for (const o of [o1, o2, lfo]) o.start();
      this.laserVoice = { oscs: [o1, o2, lfo], g };
      this.tone({ type: 'sawtooth', f0: 1800, f1: 300, dur: 0.12, gain: 0.08 });
    } else if (!on && this.laserVoice) {
      const v = this.laserVoice;
      this.laserVoice = null;
      v.g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.04);
      for (const o of v.oscs) o.stop(ctx.currentTime + 0.3);
    }
  }

  overheat() {
    if (!this.ready('overheat', 400)) return;
    this.noise({ dur: 0.6, gain: 0.18, filter: 'highpass', f0: 2500, f1: 6000, attack: 0.01 });
    this.tone({ type: 'square', f0: 400, f1: 200, dur: 0.3, gain: 0.06 });
  }

  boom(size = 1) {
    if (!this.ready('boom', 30)) return;
    const s = clamp(size, 0.4, 1.8);
    this.noise({ dur: 0.55 * s, gain: 0.35 * Math.min(1.2, s), filter: 'lowpass', f0: 2600, f1: 90, attack: 0.004 });
    this.tone({ type: 'sine', f0: 120, f1: 30, dur: 0.45 * s, gain: 0.45 * Math.min(1.2, s) });
  }

  pop() {
    if (!this.ready('pop', 60)) return;
    for (let i = 0; i < 4; i++) this.noise({ dur: 0.05, gain: 0.12, filter: 'bandpass', f0: 1500 + i * 600, q: 3, at: i * 0.03 });
  }

  rocket() {
    if (!this.ready('rocket', 40)) return;
    this.noise({ dur: 0.7, gain: 0.16, filter: 'bandpass', f0: 600, f1: 2400, q: 1.2, attack: 0.02 });
    this.tone({ type: 'sawtooth', f0: 90, f1: 220, dur: 0.4, gain: 0.07 });
  }

  launch() {
    if (!this.ready('launch', 40)) return;
    this.tone({ type: 'sine', f0: 220, f1: 70, dur: 0.15, gain: 0.35 });
    this.noise({ dur: 0.08, gain: 0.15, filter: 'lowpass', f0: 1200 });
  }

  siren() {
    if (!this.ready('siren', 500)) return;
    for (let i = 0; i < 3; i++) this.tone({ type: 'sawtooth', f0: 600, f1: 900, dur: 0.38, gain: 0.07, at: i * 0.4, curve: 'lin', attack: 0.05 });
  }

  jet() {
    if (!this.ready('jet', 300)) return;
    this.noise({ dur: 2.4, gain: 0.3, filter: 'bandpass', f0: 2600, f1: 350, q: 0.7, attack: 0.6 });
    this.tone({ type: 'sawtooth', f0: 180, f1: 70, dur: 2.2, gain: 0.06, attack: 0.5 });
  }

  // Tank engine: level 0..1 while driving, null to stop.
  engine(level) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    if (level === null) {
      if (this.engineVoice) {
        this.engineVoice.g.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.1);
        this.engineVoice.o.stop(ctx.currentTime + 0.6);
        this.engineVoice = null;
      }
      return;
    }
    if (!this.engineVoice) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 300;
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      o.connect(lp).connect(g).connect(this.sfxBus);
      o.start();
      this.engineVoice = { o, lp, g };
    }
    const v = this.engineVoice;
    v.o.frequency.setTargetAtTime(38 + level * 50, ctx.currentTime, 0.1);
    v.lp.frequency.setTargetAtTime(220 + level * 600, ctx.currentTime, 0.1);
    v.g.gain.setTargetAtTime(this.settings.muted ? 0.0001 : 0.05 + level * 0.07, ctx.currentTime, 0.1);
  }

  // Rotor thump loop; n = number of helicopters in the air.
  rotor(n) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    if (n > 0 && !this.rotorVoice) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      src.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 380;
      const am = ctx.createGain();
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 11;
      const depth = ctx.createGain();
      depth.gain.value = 0.5;
      lfo.connect(depth).connect(am.gain);
      am.gain.value = 0.5;
      const g = ctx.createGain();
      g.gain.value = 0.0001;
      src.connect(lp).connect(am).connect(g).connect(this.sfxBus);
      src.start();
      lfo.start();
      this.rotorVoice = { src, lfo, g };
    }
    if (this.rotorVoice) {
      this.rotorVoice.g.gain.setTargetAtTime(n > 0 ? 0.22 : 0.0001, ctx.currentTime, 0.4);
      if (n === 0) {
        const v = this.rotorVoice;
        this.rotorVoice = null;
        v.src.stop(ctx.currentTime + 2);
        v.lfo.stop(ctx.currentTime + 2);
      }
    }
  }

  powerup() {
    if (!this.ready('powerup', 80)) return;
    [76, 81, 85, 88, 93].forEach((n, i) => this.tone({ type: 'triangle', f0: midi(n), dur: 0.12, gain: 0.07, at: i * 0.045 }));
    this.tone({ type: 'sine', f0: 600, f1: 2400, dur: 0.3, gain: 0.04 });
  }

  upgrade() {
    if (!this.ready('upgrade', 120)) return;
    this.noise({ dur: 0.05, gain: 0.15, filter: 'bandpass', f0: 4000, q: 5 });
    [72, 79, 84].forEach((n, i) => this.tone({ type: 'square', f0: midi(n), dur: 0.18, gain: 0.05, at: 0.05 + i * 0.08 }));
  }

  bossAlarm() {
    if (!this.ready('bossAlarm', 2000)) return;
    for (let i = 0; i < 4; i++) {
      this.tone({ type: 'square', f0: 330, dur: 0.22, gain: 0.08, at: i * 0.5 });
      this.tone({ type: 'square', f0: 247, dur: 0.22, gain: 0.08, at: i * 0.5 + 0.25 });
    }
    this.tone({ type: 'sawtooth', f0: 55, f1: 40, dur: 2, gain: 0.15, attack: 0.3 });
  }

  bossDown() {
    if (!this.ready('bossDown', 1000)) return;
    [69, 72, 76, 81, 84, 88].forEach((n, i) => this.tone({ type: 'sawtooth', f0: midi(n), dur: 0.3, gain: 0.06, at: 0.3 + i * 0.09, attack: 0.01 }));
    this.tone({ type: 'triangle', f0: midi(93), dur: 1.2, gain: 0.08, at: 0.9 });
  }

  emp() {
    if (!this.ready('emp', 300)) return;
    this.tone({ type: 'sine', f0: 80, f1: 1600, dur: 0.5, gain: 0.12 });
    this.noise({ dur: 0.6, gain: 0.12, filter: 'bandpass', f0: 3000, f1: 400, q: 3 });
  }

  explode(x = 0, z = 0, scale = 1) {
    if (!this.ready('explode', 35)) return;
    const d = this.out(x, z);
    const s = clamp(scale, 0.6, 1.5);
    this.noise({ dur: 0.45 * s, gain: 0.32 * s, filter: 'lowpass', f0: 3200, f1: 160, dest: d });
    this.tone({ type: 'sine', f0: 160, f1: 38, dur: 0.32 * s, gain: 0.38 * s, dest: d });
  }

  blocked(mult = 1) {
    if (!this.ready('blocked', 60)) return;
    const base = 81 + (mult - 1) * 2; // A5, climbing with the combo
    [0, 4, 7, 12].forEach((iv, i) => {
      this.tone({ type: 'triangle', f0: midi(base + iv), dur: 0.16, gain: 0.07, at: i * 0.055 });
    });
  }

  shield(x = 0, z = 0) {
    if (!this.ready('shield', 90)) return;
    const d = this.out(x, z);
    this.tone({ type: 'sine', f0: 1900, f1: 2300, dur: 0.28, gain: 0.07, dest: d, curve: 'lin' });
    this.tone({ type: 'sine', f0: 2850, dur: 0.2, gain: 0.04, at: 0.02, dest: d });
  }

  damage(x = 0) {
    if (!this.ready('damage', 120)) return;
    const d = this.out(x, 0);
    this.tone({ type: 'sawtooth', f0: 240, f1: 90, dur: 0.38, gain: 0.16, dest: d });
    this.noise({ dur: 0.3, gain: 0.18, filter: 'lowpass', f0: 900, f1: 120, dest: d });
    this.tone({ type: 'square', f0: 880, dur: 0.1, gain: 0.05, at: 0.05 });
    this.tone({ type: 'square', f0: 660, dur: 0.1, gain: 0.05, at: 0.2 });
  }

  build() {
    if (!this.ready('build', 60)) return;
    this.noise({ dur: 0.06, gain: 0.15, filter: 'bandpass', f0: 1800, q: 4 });
    this.tone({ type: 'triangle', f0: 330, f1: 990, dur: 0.22, gain: 0.1, at: 0.04 });
    this.tone({ type: 'triangle', f0: midi(88), dur: 0.15, gain: 0.05, at: 0.22 });
  }

  reload() {
    if (!this.ready('reload', 100)) return;
    this.noise({ dur: 0.04, gain: 0.2, filter: 'bandpass', f0: 3200, q: 6 });
    this.noise({ dur: 0.05, gain: 0.2, filter: 'bandpass', f0: 2200, q: 6, at: 0.14 });
    this.tone({ type: 'sine', f0: 400, f1: 1000, dur: 0.25, gain: 0.07, at: 0.05 });
  }

  whoosh(entering) {
    if (!this.ready('whoosh', 150)) return;
    this.noise({ dur: 0.5, gain: 0.16, filter: 'bandpass', f0: entering ? 300 : 3000, f1: entering ? 3000 : 300, q: 1.5, attack: 0.08 });
    this.tone({ type: 'sine', f0: entering ? 90 : 160, f1: entering ? 160 : 70, dur: 0.45, gain: 0.12, attack: 0.05 });
  }

  panic() {
    if (!this.ready('panic', 300)) return;
    this.tone({ type: 'sawtooth', f0: 1400, f1: 55, dur: 0.9, gain: 0.12 });
    this.noise({ dur: 1.1, gain: 0.18, filter: 'lowpass', f0: 6000, f1: 200, attack: 0.02 });
    this.tone({ type: 'sine', f0: 60, f1: 30, dur: 0.8, gain: 0.3 });
  }

  gameOver() {
    if (!this.ready('gameover', 1000)) return;
    [69, 65, 62, 57].forEach((n, i) => {
      this.tone({ type: 'sawtooth', f0: midi(n), f1: midi(n) * 0.97, dur: 0.55, gain: 0.09, at: i * 0.32, attack: 0.02 });
      this.tone({ type: 'sine', f0: midi(n - 12), dur: 0.6, gain: 0.12, at: i * 0.32 });
    });
    this.noise({ dur: 1.8, gain: 0.12, filter: 'lowpass', f0: 1200, f1: 80, at: 0.2, attack: 0.3 });
  }

  // Tiny tick for packets bouncing off the gate (kernel drops).
  spark(x = 0) {
    if (!this.ready('spark', 70)) return;
    this.noise({ dur: 0.05, gain: 0.05, filter: 'highpass', f0: 5000, dest: this.out(x, -84) });
  }

  error() {
    if (!this.ready('error', 150)) return;
    this.tone({ type: 'square', f0: 150, dur: 0.09, gain: 0.08 });
    this.tone({ type: 'square', f0: 120, dur: 0.12, gain: 0.08, at: 0.11 });
  }

  // -------------------------------------------------------------- music

  // A small synthwave loop in A minor (Am F C G) with a lookahead scheduler.
  startMusic() {
    const bpm = 96;
    this.step16 = 60 / bpm / 4;
    this.stepNo = 0;
    this.nextAt = this.ctx.currentTime + 0.1;
    this.chords = [
      { root: 45, third: 3 }, // Am
      { root: 41, third: 4 }, // F
      { root: 48, third: 4 }, // C
      { root: 43, third: 4 }, // G
    ];
    this.musicTimer = setInterval(() => this.schedule(), 25);
  }

  schedule() {
    const ctx = this.ctx;
    while (this.nextAt < ctx.currentTime + 0.12) {
      this.playStep(this.stepNo, this.nextAt);
      this.nextAt += this.step16;
      this.stepNo = (this.stepNo + 1) % 64;
    }
  }

  playStep(n, t) {
    if (this.settings.muted || this.settings.music === 0) return;
    const ctx = this.ctx;
    const bar = Math.floor(n / 16);
    const s = n % 16;
    const ch = this.chords[bar];
    const k = clamp(this.intensity, 0, 1);
    const bus = this.musicBus;

    const env = (node, gain, attack, dur) => {
      node.gain.setValueAtTime(0.0001, t);
      node.gain.exponentialRampToValueAtTime(gain, t + attack);
      node.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    };

    // Pad: one detuned triad per bar.
    if (s === 0) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 700 + k * 900;
      const g = ctx.createGain();
      env(g, 0.035, 0.5, this.step16 * 16);
      lp.connect(g).connect(bus);
      for (const iv of [12, 12 + ch.third, 19]) {
        for (const det of [-7, 7]) {
          const o = ctx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = midi(ch.root + iv);
          o.detune.value = det;
          o.connect(lp);
          o.start(t);
          o.stop(t + this.step16 * 16 + 0.1);
        }
      }
    }

    // Bass: driving eighths with an octave bounce.
    if (s % 2 === 0) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midi(ch.root + (s % 4 === 2 ? 12 : 0));
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 6;
      lp.frequency.setValueAtTime(300 + k * 1400, t);
      lp.frequency.exponentialRampToValueAtTime(140, t + this.step16 * 1.8);
      const g = ctx.createGain();
      env(g, 0.12, 0.005, this.step16 * 1.9);
      o.connect(lp).connect(g).connect(bus);
      o.start(t);
      o.stop(t + this.step16 * 2);
    }

    // Arpeggio: sixteenths, louder as the board fills up.
    if (k > 0.08) {
      const pattern = [12, 12 + ch.third, 19, 24, 19, 12 + ch.third];
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = midi(ch.root + 12 + pattern[s % pattern.length]);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1800 + k * 2500;
      const g = ctx.createGain();
      env(g, 0.012 + 0.03 * k, 0.003, this.step16 * 0.9);
      o.connect(lp).connect(g);
      g.connect(bus);
      g.connect(this.delay);
      o.start(t);
      o.stop(t + this.step16);
    }

    // Drums
    if (s % 4 === 0) {
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime(150, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.22);
      const g = ctx.createGain();
      env(g, 0.32, 0.003, 0.26);
      o.connect(g).connect(bus);
      o.start(t);
      o.stop(t + 0.3);
    }
    const hit = (gain, type, f, dur) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuf;
      const bq = ctx.createBiquadFilter();
      bq.type = type;
      bq.frequency.value = f;
      const g = ctx.createGain();
      env(g, gain, 0.002, dur);
      src.connect(bq).connect(g).connect(bus);
      src.start(t, Math.random() * 0.5);
      src.stop(t + dur + 0.02);
    };
    if (s === 4 || s === 12) hit(0.12, 'bandpass', 1800, 0.16);
    if (s % 4 === 2) hit(0.04 + 0.03 * k, 'highpass', 7000, 0.05);
    if (k > 0.5 && s % 2 === 1) hit(0.02, 'highpass', 9000, 0.03);
  }
}
