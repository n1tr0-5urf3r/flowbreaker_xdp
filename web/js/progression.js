// Meta progression that survives between runs: XP and levels, rank titles,
// Kernel Points (KP) spent on permanent perks, achievements and lifetime
// stats. Everything lives in this browser's localStorage.

const STORE_KEY = 'flowbreaker-profile';

export const RANKS = [
  [1, 'Script Kiddie'],
  [3, 'Packet Pusher'],
  [6, 'Port Warden'],
  [10, 'Flow Breaker'],
  [15, 'Kernel Whisperer'],
  [21, 'Ring Zero Ronin'],
  [30, 'XDP Overlord'],
];

// Permanent perks. cost[i] = KP for level i+1.
export const PERKS = [
  { key: 'capital', name: 'Seed Capital', desc: (l) => `start with +${l * 60}¢`, cost: [1, 2, 3] },
  { key: 'hardening', name: 'Kernel Hardening', desc: (l) => `+${l * 15} max integrity`, cost: [1, 2, 3] },
  { key: 'regen', name: 'Self-Healing', desc: (l) => `integrity regen +${l * 40}%`, cost: [2, 3] },
  { key: 'stockpile', name: 'Stockpile', desc: (l) => `start with +${l * 50}% heavy ammo`, cost: [1, 2] },
  { key: 'airforce', name: 'Air Superiority', desc: (l) => `start with +${l} airstrike${l === 1 ? '' : 's'}`, cost: [2, 3] },
  { key: 'scavenger', name: 'Scavenger', desc: (l) => `+${l * 4}% power-up drop chance`, cost: [1, 2, 3] },
  { key: 'overclock', name: 'Overclock', desc: (l) => `power-ups last +${l * 25}%`, cost: [1, 2] },
  { key: 'engineering', name: 'Cheap Silicon', desc: (l) => `turrets & gunships −${l * 15}%`, cost: [2, 3] },
  { key: 'veteran', name: 'Veteran Gunner', desc: () => 'start runs with the twin blaster', cost: [3] },
];

export const ACHIEVEMENTS = [
  { id: 'first_blood', name: 'First Blood', desc: 'Block your first flow', xp: 50 },
  { id: 'panic', name: 'Don\'t Panic', desc: 'Hit the PANIC button', xp: 25 },
  { id: 'combo', name: 'Chain Reaction', desc: 'Reach a ×5 combo multiplier', xp: 150 },
  { id: 'elephant', name: 'Elephant Hunter', desc: 'Defeat an elephant flow', xp: 300 },
  { id: 'carpet', name: 'Carpet Bomber', desc: 'Destroy 5 packets with one airstrike', xp: 200 },
  { id: 'roadkill', name: 'Roadkill', desc: 'Ram 10 packets with the tank in one run', xp: 150 },
  { id: 'chopper', name: 'Get to the Chopper', desc: 'Destroy 10 packets flying the helicopter in one run', xp: 150 },
  { id: 'ace', name: 'Top Gun', desc: 'Destroy 10 packets flying the jet in one run', xp: 200 },
  { id: 'laser', name: 'Laser Show', desc: 'Destroy 20 packets with the laser in one run', xp: 150 },
  { id: 'ducks', name: 'Duck Hunt', desc: 'Destroy 25 rubber ducks (lifetime)', xp: 100 },
  { id: 'survivor', name: 'Uptime', desc: 'Survive 10 minutes in one run', xp: 250 },
  { id: 'centurion', name: 'Centurion', desc: 'Block 100 flows (lifetime)', xp: 300 },
  { id: 'kilo', name: 'Kilodrop', desc: 'Have the kernel drop 1000 packets for you (lifetime)', xp: 300 },
];

export const xpForLevel = (lvl) => Math.round(120 * lvl ** 1.5);

const fresh = () => ({
  xp: 0, // xp into the current level
  level: 1,
  kp: 0,
  perks: {},
  achievements: {},
  stats: { runs: 0, blocked: 0, kernelDrops: 0, bosses: 0, bestScore: 0, playSeconds: 0, ducks: 0 },
});

export class Profile {
  constructor() {
    this.data = fresh();
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && typeof s === 'object') {
        const f = fresh();
        this.data = { ...f, ...s, stats: { ...f.stats, ...s.stats }, perks: { ...s.perks }, achievements: { ...s.achievements } };
      }
    } catch { /* storage unavailable: progress lasts for this tab only */ }
    this.listeners = new Set();
    this.dirty = false;
    setInterval(() => this.flush(), 5000);
    window.addEventListener('pagehide', () => this.flush());
    this.newRun();
  }

  on(fn) { this.listeners.add(fn); }
  emit(type, payload) { for (const fn of this.listeners) fn(type, payload); }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try { localStorage.setItem(STORE_KEY, JSON.stringify(this.data)); } catch { /* ignore */ }
  }

  // --------------------------------------------------------------- run

  newRun() {
    this.run = { xp: 0, startLevel: this.data.level, unlocked: [], laser: 0, ram: 0, heli: 0, jet: 0, seconds: 0, strikeKills: new Map() };
  }

  perk(key) { return this.data.perks[key] ?? 0; }

  get rank() {
    let r = RANKS[0][1];
    for (const [lvl, name] of RANKS) if (this.data.level >= lvl) r = name;
    return r;
  }

  addXP(n) {
    if (n <= 0) return;
    const d = this.data;
    d.xp += n;
    this.run.xp += n;
    while (d.xp >= xpForLevel(d.level)) {
      d.xp -= xpForLevel(d.level);
      d.level++;
      const kp = d.level % 5 === 0 ? 2 : 1;
      d.kp += kp;
      this.emit('levelup', { level: d.level, kp, rank: this.rank });
    }
    this.dirty = true;
  }

  unlock(id) {
    if (this.data.achievements[id]) return;
    const a = ACHIEVEMENTS.find((x) => x.id === id);
    if (!a) return;
    this.data.achievements[id] = Date.now();
    this.run.unlocked.push(a);
    this.dirty = true;
    this.emit('achievement', a);
    this.addXP(a.xp);
  }

  buyPerk(key) {
    const p = PERKS.find((x) => x.key === key);
    const lvl = this.perk(key);
    if (!p || lvl >= p.cost.length || this.data.kp < p.cost[lvl]) return false;
    this.data.kp -= p.cost[lvl];
    this.data.perks[key] = lvl + 1;
    this.dirty = true;
    this.flush();
    return true;
  }

  // Refund every perk (handy for trying other builds).
  respec() {
    let back = 0;
    for (const p of PERKS) for (let i = 0; i < this.perk(p.key); i++) back += p.cost[i];
    this.data.kp += back;
    this.data.perks = {};
    this.dirty = true;
    this.flush();
  }

  // ------------------------------------------------------------ events

  // A packet destroyed by the player's side. src: player/turret/heli/strike/laser/ram;
  // vehicle: the kind the player was in (or null).
  onKill({ src, vehicle, skin, boss }) {
    const r = this.run;
    if (src === 'laser') r.laser++;
    if (src === 'ram') r.ram++;
    if (vehicle === 'heli' && (src === 'player' || src === 'laser')) r.heli++;
    if (vehicle === 'jet' && (src === 'player' || src === 'laser')) r.jet++;
    if (skin === 'ducks') this.data.stats.ducks++;
    if (boss) {
      this.data.stats.bosses++;
      this.unlock('elephant');
    }
    if (r.laser >= 20) this.unlock('laser');
    if (r.ram >= 10) this.unlock('roadkill');
    if (r.heli >= 10) this.unlock('chopper');
    if (r.jet >= 10) this.unlock('ace');
    if (this.data.stats.ducks >= 25) this.unlock('ducks');
    this.dirty = true;
  }

  onStrikeKill(strikeId) {
    const n = (this.run.strikeKills.get(strikeId) ?? 0) + 1;
    this.run.strikeKills.set(strikeId, n);
    if (n >= 5) this.unlock('carpet');
  }

  // A kernel-confirmed block.
  onBlocked() {
    this.data.stats.blocked++;
    this.unlock('first_blood');
    if (this.data.stats.blocked >= 100) this.unlock('centurion');
    this.dirty = true;
  }

  onKernelDrops(n) {
    this.data.stats.kernelDrops += n;
    if (this.data.stats.kernelDrops >= 1000) this.unlock('kilo');
    this.dirty = true;
  }

  onCombo(mult) { if (mult >= 5) this.unlock('combo'); }

  tick(dt) {
    this.run.seconds += dt;
    this.data.stats.playSeconds += dt;
    if (this.run.seconds >= 600) this.unlock('survivor');
    this.dirty = true;
  }

  // Returns a summary for the game-over card.
  endRun(score) {
    const d = this.data;
    d.stats.runs++;
    d.stats.bestScore = Math.max(d.stats.bestScore, score);
    this.dirty = true;
    this.flush();
    return { xp: this.run.xp, levels: d.level - this.run.startLevel, unlocked: this.run.unlocked, best: d.stats.bestScore };
  }
}
