// Game state and main loop. Packets roll from the NIC/XDP gate (far end of
// the board) towards the host. Destroying one sends a "kill" for its flow to
// flowbreaker, which inserts it into the kernel blocklist.
//
// Views: the overview (hover cannon, turret building, airstrike targeting),
// the turret cockpit (first person), and the vehicles: tank, helicopter and
// jet, each with a third-person chase cam.

import * as THREE from 'three';
import { LANES, classify, isSuspicious } from './lanes.js';
import { World, LANE_W, GATE_Z, HOST_Z, CANNON_Z, laneX } from './world.js';
import { Sound } from './audio.js';
import { Arsenal, WEAPONS, UPGRADES, POWERUPS, POWERUP_KEYS } from './arsenal.js';
import { Tank, Heli, Airstrike, PlayerHeli, PlayerJet } from './units.js';
import { makePowerup, decorateBoss } from './models.js';
import { SkinSettings } from './skins.js';
import { Profile } from './progression.js';

const MAX_SPRITES = 160;
const MERGE_DEPTH = 0.22; // merge samples of a flow still in the far 22% of the board
const CELL_D = 7.5;
const CELL0_Z = HOST_Z - 10;
const CELLS = 9;

export const COST = { turret: 60, reload: 25, heli: 150, ammo: 40 };
const TURRET_AMMO = 12;
const TURRET_RANGE = [34, 34, 48];
const TURRET_COOLDOWN = [0.9, 0.55, 0.5];
const COCKPIT_COOLDOWN = 0.09;
const MAX_HELIS = 2;
const VEHICLES = { tank: Tank, heli: PlayerHeli, jet: PlayerJet };
const VEHICLE_COLOR = { tank: 0x5fe0ff, heli: 0xffb347, jet: 0xff8a3d };
const BOSS_SAMPLES = 16; // merged samples that turn a flow into an elephant
const BOSS_GAP = 60; // seconds between bosses
const DROP_CHANCE = 0.1;

const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
const DEG = Math.PI / 180;

export class Game {
  constructor(container, conn, ui) {
    this.conn = conn;
    this.ui = ui;
    this.container = container;
    this.world = new World(container);
    this.sound = new Sound();
    this.skins = new SkinSettings();
    this.profile = new Profile();
    this.profile.on((type, data) => this.onProfile(type, data));
    this.arsenal = new Arsenal(this);
    this.blocked = new Map(); // id -> confirmedAt (ms); survives restarts like the kernel rules
    this.pending = new Set();
    this.suspiciousHits = new Set();
    this.flowLane = new Map();
    this.prevDrops = new Map();
    this.mouse = null; // {x, y} in canvas pixels
    this.firingBy = new Set(); // 'mouse' / 'space' while held
    this.keys = new Set(); // held driving keys
    this.reset();
    this.bindInput();
    this.last = performance.now();
    this.world.renderer.setAnimationLoop(() => this.frame());
  }

  reset() {
    for (const p of this.packets ?? []) this.world.removeObject(p.obj);
    for (const t of this.turrets ?? []) this.world.removeObject(t.obj);
    for (const pu of this.powerups ?? []) this.world.removeObject(pu.obj);
    for (const h of this.helis ?? []) h.destroy();
    for (const a of this.airstrikes ?? []) a.cancel();
    this.vehicle?.destroy();
    this.arsenal.clear();
    this.packets = [];
    this.turrets = [];
    this.powerups = [];
    this.helis = [];
    this.airstrikes = [];
    this.vehicle = null;
    this.boss = null;
    this.nextBossAt = performance.now() / 1000 + 25;
    const perk = (k) => this.profile.perk(k);
    this.profile.newRun();
    this.xpScore = 0;
    this.score = 0;
    this.credits = 120 + perk('capital') * 60;
    this.maxIntegrity = 100 + perk('hardening') * 15;
    this.integrity = this.maxIntegrity;
    this.combo = 0;
    this.comboTimer = 0;
    this.kills = 0;
    this.regen = 0;
    this.cannonLane = 0;
    this.fireCd = 0;
    this.weapon = 0;
    this.ammo = Object.fromEntries(WEAPONS.map((w) => [w.key, w.ammo === Infinity ? w.ammo : Math.round(w.ammo * (1 + perk('stockpile') * 0.5))]));
    this.upgrades = Object.fromEntries(UPGRADES.map((u) => [u.key, 0]));
    if (perk('veteran')) this.upgrades.blaster = 1;
    this.buffs = {};
    this.strikes = 1 + perk('airforce');
    this.building = false;
    this.targeting = false;
    this.paused = false;
    this.over = false;
    this.hostFlash = 0;
    this.manned = null;
    this.hover = null;
    this.laneSeen = LANES.map(() => -1e9);
    this.world.overview();
    this.sound.engine(null);
    this.sound.rotor(0);
    this.ui.setGameOver(false);
    this.ui.setBuilding(false);
    this.ui.setTargeting(false);
    this.ui.setPaused(false);
    this.ui.setCockpit(null);
    this.ui.setMode('overview');
    this.ui.setBoss(null);
    this.ui.renderArmory(this);
    this.ui.renderProfile(this.profile);
  }

  // ---------------------------------------------------------- geometry

  laneAt(x) { return Math.max(0, Math.min(LANES.length - 1, Math.round(x / LANE_W + (LANES.length - 1) / 2))); }
  cellZ(c) { return CELL0_Z - c * CELL_D; }
  cellAt(z) {
    const c = Math.round((CELL0_Z - z) / CELL_D);
    return c >= 0 && c < CELLS ? c : -1;
  }

  ndc() {
    if (!this.mouse) return null;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    return new THREE.Vector2((this.mouse.x / w) * 2 - 1, -(this.mouse.y / h) * 2 + 1);
  }

  get mode() { return this.manned ? 'cockpit' : this.vehicle ? this.vehicle.kind : 'overview'; }

  hasBuff(k) { return (this.buffs[k] ?? 0) > performance.now() / 1000; }

  // Where lobbed weapons land and what vehicle guns look at.
  aimPoint() {
    if (this.manned) {
      const cam = this.world.camera;
      const ray = new THREE.Ray(cam.position.clone(), v3(0, 0, -1).applyQuaternion(cam.quaternion));
      const hit = ray.intersectPlane(this.world.floorPlane, new THREE.Vector3());
      return hit && hit.distanceTo(cam.position) < 110 ? hit : ray.at(70, new THREE.Vector3()).setY(0);
    }
    const ndc = this.ndc();
    const hit = ndc && this.world.pickFloor(ndc);
    if (hit) {
      hit.z = Math.max(GATE_Z + 2, Math.min(HOST_Z - 2, hit.z));
      return hit;
    }
    return v3(this.vehicle ? this.vehicle.pos.x : laneX(this.cannonLane), 0, -40);
  }

  // Origin/direction of the player's active gun.
  shooter() {
    if (this.manned) {
      const cam = this.world.camera;
      const dir = v3(0, 0, -1).applyQuaternion(cam.quaternion);
      const side = v3(1, 0, 0).applyQuaternion(cam.quaternion);
      this.cockpitSide = -(this.cockpitSide || 1); // alternate barrels
      return { origin: cam.position.clone().addScaledVector(dir, 2).addScaledVector(side, 0.42 * this.cockpitSide).add(v3(0, -0.5, 0)), dir, side, kind: 'cockpit', color: 0xffb347 };
    }
    if (this.vehicle) {
      const v = this.vehicle;
      const m = v.muzzle(this.aimPoint());
      const side = v3(-m.dir.z, 0, m.dir.x).normalize();
      return { origin: m.pos, dir: m.dir, side, kind: v.kind === 'tank' ? 'tank' : v.kind === 'jet' ? 'cockpit' : 'cannon', color: VEHICLE_COLOR[v.kind] };
    }
    return { origin: v3(laneX(this.cannonLane), 1, CANNON_Z - 1.5), dir: v3(0, 0, -1), side: v3(1, 0, 0), kind: 'cannon', color: 0xdffaff };
  }

  // ------------------------------------------------------------- input

  bindInput() {
    const el = this.world.renderer.domElement;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
      if (this.manned) {
        // Look-follow aiming: the further from centre, the further you turn.
        const nx = (this.mouse.x / r.width) * 2 - 1;
        const ny = (this.mouse.y / r.height) * 2 - 1;
        this.world.aim(-nx * 0.95, -ny * 0.42 - 0.05);
        return;
      }
      if (this.vehicle) return;
      const hit = this.world.pickFloor(this.ndc());
      if (hit && !this.building) this.cannonLane = this.laneAt(hit.x);
    });
    el.addEventListener('pointerleave', () => { this.mouse = null; });
    el.addEventListener('pointerdown', (e) => {
      // Capture the pointer so we always see the release, even outside the window.
      if (e.button === 0) el.setPointerCapture?.(e.pointerId);
      if (this.manned) {
        if (e.button === 2) this.exitCockpit();
        else this.startFiring('mouse');
        return;
      }
      if (this.vehicle) {
        if (e.button === 0) this.startFiring('mouse');
        return;
      }
      const hit = this.world.pickFloor(this.ndc());
      if (!hit) return;
      const lane = this.laneAt(hit.x);
      if (e.button === 2) {
        if (this.targeting) return this.setTargeting(false);
        return this.sellAt(lane, hit.z);
      }
      if (this.targeting) return this.callStrike(lane);
      if (this.building) return this.placeAt(lane, hit.z);
      const t = this.turretAt(lane, hit.z);
      if (t) return this.enterCockpit(t);
      this.cannonLane = lane;
      this.startFiring('mouse');
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.selectWeapon((this.weapon + (e.deltaY > 0 ? 1 : -1) + WEAPONS.length) % WEAPONS.length);
    }, { passive: false });
    window.addEventListener('pointerup', () => this.stopFiring('mouse'));
    el.addEventListener('pointercancel', () => this.stopFiring('mouse'));
    el.addEventListener('lostpointercapture', () => this.stopFiring('mouse'));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { this.firingBy.clear(); this.keys.clear(); this.arsenal.stopBeam(); }
    });
    window.addEventListener('blur', () => { this.firingBy.clear(); this.keys.clear(); });
    window.addEventListener('keyup', (e) => {
      if (e.key === ' ') this.stopFiring('space');
      this.keys.delete(e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase());
    });

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      // Modal screens swallow game keys.
      if (!document.getElementById('research').hidden) {
        if (k === 'Escape') this.ui.openResearch(false);
        return;
      }
      if (!document.getElementById('splash').hidden) return;
      // Global keys
      if (k >= '1' && k <= String(WEAPONS.length)) return this.selectWeapon(Number(k) - 1);
      switch (k) {
        case 'm': this.ui.setMuted(this.sound.toggleMute()); return;
        case 'p': this.togglePause(); return;
        case 'f': this.requestStrike(); return;
        case 'g': this.buyHeli(); return;
        case 't': this.toggleVehicle('tank'); return;
        case 'h': this.toggleVehicle('heli'); return;
        case 'j': this.toggleVehicle('jet'); return;
        case ' ': if (!e.repeat) this.startFiring('space'); e.preventDefault(); return;
      }
      if (this.vehicle) {
        if (k === 'Escape') return this.toggleVehicle(this.vehicle.kind);
        if (['w', 'a', 's', 'd', 'q', 'e'].includes(k) || k === 'Shift') {
          this.keys.add(k.toLowerCase());
          e.preventDefault();
        }
        return;
      }
      if (this.manned) {
        switch (k) {
          case 'r': this.reload(this.manned); return;
          case 'e': case 'q': case 'Escape': this.exitCockpit(); return;
          case 'a': case 'ArrowLeft': this.cycleTurret(-1); return;
          case 'd': case 'ArrowRight': this.cycleTurret(1); return;
        }
        return;
      }
      switch (k) {
        case 'a': case 'ArrowLeft':
          this.cannonLane = Math.max(0, this.cannonLane - 1); e.preventDefault(); break;
        case 'd': case 'ArrowRight':
          this.cannonLane = Math.min(LANES.length - 1, this.cannonLane + 1); e.preventDefault(); break;
        case 'b':
          this.toggleBuild(); break;
        case 'e':
          if (this.turrets.length) this.enterCockpit(this.nearestTurret()); break;
        case 'Escape':
          if (this.targeting) this.setTargeting(false);
          else if (this.building) this.toggleBuild(false);
          else this.panic();
          break;
      }
    });
  }

  selectWeapon(i) {
    if (i === this.weapon) return;
    this.weapon = i;
    this.arsenal.stopBeam();
    this.sound.reload();
  }

  toggleBuild(on = !this.building) {
    if (this.manned) this.exitCockpit();
    if (this.vehicle) this.toggleVehicle(this.vehicle.kind);
    this.setTargeting(false);
    this.building = on;
    this.ui.setBuilding(on);
  }

  setTargeting(on) {
    this.targeting = on;
    if (on) this.building = false;
    this.ui.setBuilding(this.building);
    this.ui.setTargeting(on);
  }

  togglePause(on = !this.paused) {
    this.paused = on;
    this.sound.setPaused(on);
    this.ui.setPaused(on);
    if (on) this.arsenal.stopBeam();
  }

  // PANIC lifts every kernel rule *and* stands down everything that would
  // immediately block flows again: turrets, gunships and airstrikes.
  panic() {
    this.conn.send({ t: 'panic' });
    this.profile.unlock('panic');
    this.standDown();
  }

  standDown() {
    if (this.manned) this.exitCockpit();
    let refund = 0;
    for (const t of this.turrets) {
      refund += Math.round(COST.turret * 0.5);
      this.world.burst(t.pos.clone().setY(1), 0x5fe0ff, 20, 5, 0.5);
      this.world.removeObject(t.obj);
    }
    this.turrets = [];
    for (const h of this.helis) h.recall();
    for (const a of this.airstrikes) a.cancel();
    this.airstrikes = [];
    this.arsenal.clear();
    this.setTargeting(false);
    this.credits += refund;
    if (refund) this.world.addFloat(v3(0, 3, HOST_Z - 6), `turrets dismantled +${refund}¢`, 0x5fe0ff);
  }

  restart() { this.reset(); }

  // ----------------------------------------------------------- turrets

  turretAt(lane, z) {
    const c = this.cellAt(z);
    return this.turrets.find((t) => t.lane === lane && t.cell === c);
  }

  nearestTurret() {
    return this.turrets.reduce((best, t) => (Math.abs(t.lane - this.cannonLane) < Math.abs(best.lane - this.cannonLane) ? t : best));
  }

  // Turret and gunship prices include the Cheap Silicon perk.
  price(key) {
    const k = key === 'turret' || key === 'heli' ? 1 - this.profile.perk('engineering') * 0.15 : 1;
    return Math.round(COST[key] * k);
  }

  spend(cost, where) {
    if (this.credits < cost) {
      if (where) this.world.addFloat(where, 'no credits', 0xff7788);
      this.ui.toast(`Need ${cost}¢`, 'warn');
      this.sound.error();
      return false;
    }
    this.credits -= cost;
    return true;
  }

  placeAt(lane, z) {
    const c = this.cellAt(z);
    if (c < 0 || this.turretAt(lane, z)) return;
    const pos = v3(laneX(lane), 0, this.cellZ(c));
    if (!this.spend(this.price('turret'), pos.clone().setY(2))) return;
    this.sound.build();
    const obj = this.world.makeTurret();
    obj.position.copy(pos);
    this.turrets.push({ lane, cell: c, pos, cd: 0, ammo: TURRET_AMMO, maxAmmo: TURRET_AMMO, obj, yaw: 0, stunned: 0 });
    this.world.burst(pos.clone().setY(1), 0x9fe870, 40, 7, 0.7);
  }

  sellAt(lane, z) {
    const t = this.turretAt(lane, z);
    if (!t) return;
    const refund = Math.round(COST.turret * 0.5 * (t.ammo / t.maxAmmo));
    this.credits += refund;
    this.world.addFloat(t.pos.clone().setY(2.5), `+${refund}¢`, 0xf5c542);
    this.world.removeObject(t.obj);
    this.turrets = this.turrets.filter((x) => x !== t);
  }

  reload(t) {
    if (t.ammo === t.maxAmmo) return;
    if (!this.spend(COST.reload, t.pos.clone().setY(2.5))) return;
    t.ammo = t.maxAmmo;
    this.sound.reload();
    this.world.addFloat(t.pos.clone().setY(2.5), 'RELOADED', 0x9fe870);
  }

  enterCockpit(t) {
    if (this.building) this.toggleBuild(false);
    if (this.vehicle) this.toggleVehicle(this.vehicle.kind);
    this.manned = t;
    t.obj.visible = false;
    this.world.enterCockpit(t.pos);
    this.sound.whoosh(true);
    this.ui.setCockpit(t);
    this.ui.setMode('cockpit');
  }

  exitCockpit() {
    if (!this.manned) return;
    this.arsenal.stopBeam();
    this.manned.obj.visible = true;
    this.manned = null;
    this.world.overview();
    this.sound.whoosh(false);
    this.ui.setCockpit(null);
    this.ui.setMode('overview');
  }

  cycleTurret(dir) {
    if (this.turrets.length < 2) return;
    const sorted = [...this.turrets].sort((a, b) => a.lane - b.lane || a.cell - b.cell);
    const next = sorted[(sorted.indexOf(this.manned) + dir + sorted.length) % sorted.length];
    this.manned.obj.visible = true;
    this.enterCockpit(next);
  }

  // ---------------------------------------------------------- vehicles

  // Enter a vehicle, switch to another one, or (same kind again) get out.
  toggleVehicle(kind) {
    const current = this.vehicle?.kind;
    if (this.vehicle) {
      this.arsenal.stopBeam();
      this.vehicle.destroy();
      this.vehicle = null;
      this.keys.clear();
      this.world.overview();
      this.sound.whoosh(false);
      this.ui.setMode('overview');
    }
    if (current === kind || this.over) return;
    if (this.manned) this.exitCockpit();
    if (this.building) this.toggleBuild(false);
    this.setTargeting(false);
    this.vehicle = new VEHICLES[kind](this);
    this.vehicle.pos.x = laneX(this.cannonLane);
    this.sound.whoosh(true);
    this.ui.setMode(kind);
    if (kind !== 'tank') this.ui.banner(kind === 'jet' ? 'WHEELS UP' : 'ROTORS SPINNING', 'strike');
  }

  buyHeli() {
    if (this.over) return;
    if (this.helis.filter((h) => h.state !== 'leave').length >= MAX_HELIS) {
      this.ui.toast(`Max ${MAX_HELIS} gunships in the air`, 'warn');
      return;
    }
    if (!this.spend(this.price('heli'))) return;
    this.helis.push(new Heli(this, this.helis.length));
    this.ui.toast('GUNSHIP INBOUND (40 s)', 'kill');
    this.sound.upgrade();
  }

  requestStrike() {
    if (this.over) return;
    if (this.strikes <= 0) {
      this.ui.toast('No airstrikes left. Pick up ✈ power-ups or keep blocking flows.', 'warn');
      this.sound.error();
      return;
    }
    if (this.mode === 'overview') {
      this.setTargeting(!this.targeting);
      return;
    }
    this.callStrike(this.laneAt(this.aimPoint().x));
  }

  callStrike(lane) {
    this.setTargeting(false);
    if (this.strikes <= 0) return;
    this.strikes--;
    const n = this.upgrades.strike + 1;
    const lanes = [lane];
    for (let d = 1; lanes.length < n; d++) {
      if (lane + d < LANES.length) lanes.push(lane + d);
      if (lanes.length < n && lane - d >= 0) lanes.push(lane - d);
    }
    this.airstrikes.push(new Airstrike(this, lanes));
    this.ui.banner(`AIRSTRIKE INBOUND · ${lanes.map((l) => LANES[l].name).join(' + ')}`, 'strike');
  }

  // ---------------------------------------------------------- shopping

  buyUpgrade(key) {
    const u = UPGRADES.find((x) => x.key === key);
    const lvl = this.upgrades[key];
    if (!u || lvl >= u.levels.length - 1) return;
    if (!this.spend(u.cost[lvl])) return;
    this.upgrades[key]++;
    this.sound.upgrade();
    this.ui.toast(`${u.name} upgraded: ${u.levels[this.upgrades[key]]}`, 'kill');
    this.ui.renderArmory(this);
  }

  buyAmmo() {
    if (!this.spend(COST.ammo)) return;
    this.addAmmo();
    this.sound.reload();
  }

  addAmmo() {
    for (const [k, n] of [['rocket', 4], ['grenade', 5], ['cluster', 1]]) {
      const w = WEAPONS.find((x) => x.key === k);
      this.ammo[k] = Math.min(w.max, this.ammo[k] + n);
    }
  }

  // ------------------------------------------------------------ firing

  // Hold mouse or Space for continuous fire; the cooldown sets the rate.
  startFiring(src) {
    this.firingBy.add(src);
    this.fire();
  }

  stopFiring(src) {
    this.firingBy.delete(src);
    if (!this.firingBy.size) this.arsenal.stopBeam();
  }

  fire() {
    if (this.over || this.paused || this.building || this.targeting || this.fireCd > 0) return;
    if (this.vehicle?.stunned) return;
    const w = WEAPONS[this.weapon];
    if (w.key === 'laser') return; // continuous, handled in update()
    if (this.ammo[w.key] <= 0) {
      if (this.sound.ready('dry', 400)) this.ui.toast(`Out of ${w.name.toLowerCase()}. Grab an ammo crate (A) or buy ammo.`, 'warn');
      this.sound.error();
      this.fireCd = 0.3;
      return;
    }
    const s = this.shooter();
    const rapid = this.hasBuff('rapid') ? 0.5 : 1;
    const base = w.key === 'blaster' && s.kind === 'cockpit' ? COCKPIT_COOLDOWN : w.cd;
    this.fireCd = base * rapid;
    if (s.kind === 'cockpit') this.world.muzzleFlash();
    const a = this.arsenal;

    switch (w.key) {
      case 'blaster': {
        const lvl = this.upgrades.blaster;
        const shots = lvl === 0 ? [[0, 0]] : lvl === 1 ? [[-0.35, 0], [0.35, 0]] : [[0, -6], [0, 0], [0, 6]];
        if (this.hasBuff('spread')) shots.push([0, -14], [0, 14]);
        for (const [off, ang] of shots) {
          const dir = s.dir.clone().applyAxisAngle(v3(0, 1, 0), ang * DEG);
          a.bolt(s.origin.clone().addScaledVector(s.side, off), dir, { color: s.color });
        }
        this.sound.shoot(s.kind, s.origin.x, s.origin.z);
        return;
      }
      case 'rocket': {
        const target = this.lockTarget();
        const n = this.upgrades.rocket + 1;
        for (let i = 0; i < n; i++) {
          const dir = s.dir.clone().add(v3(0, 0.35, 0)).addScaledVector(s.side, (i - (n - 1) / 2) * 0.5);
          a.rocket(s.origin, dir, target);
        }
        this.ammo.rocket--;
        this.sound.rocket();
        if (target) this.world.burst(target.obj.position, 0xff3355, 10, 2, 0.4);
        return;
      }
      case 'grenade':
      case 'cluster':
        a.lob(w.key, s.origin, this.aimPoint());
        this.ammo[w.key]--;
        this.sound.launch();
    }
  }

  // Rockets lock onto the packet under the cursor/crosshair, or the
  // nearest one to where you aim.
  lockTarget() {
    if (this.hover && !this.hover.p.prot) return this.hover;
    const aim = this.aimPoint();
    let best = null;
    let bestD = 30 * 30;
    for (const pk of this.packets) {
      if (pk.dead || pk.p.prot) continue;
      const d = pk.obj.position.distanceToSquared(aim);
      if (d < bestD) { bestD = d; best = pk; }
    }
    return best;
  }

  // ----------------------------------------------------------- damage

  damage(pk, amount, src = 'player', tag) {
    if (!pk || pk.dead) return;
    if (pk.p.prot) {
      this.world.burst(pk.obj.position, 0x7fe7ff, 8, 3, 0.3);
      this.sound.shield(pk.x, pk.z);
      return;
    }
    pk.hp -= amount;
    if (pk.boss) {
      pk.hitFlash = 0.08;
      if (pk.hp > 0) return;
    }
    if (pk.hp <= 0) this.kill(pk, src, tag);
  }

  kill(pk, src = 'player', tag) {
    this.lastHitPos = pk.obj.position.clone();
    const wasBoss = pk.boss;
    this.explode(pk);
    this.profile.onKill({ src, vehicle: this.vehicle?.kind ?? (this.manned ? 'cockpit' : null), skin: this.skins.skinFor(pk.lane), boss: wasBoss });
    if (src === 'strike') this.profile.onStrikeKill(tag);
    if (wasBoss) this.bossDefeated(pk);
    else if (Math.random() < DROP_CHANCE + this.profile.perk('scavenger') * 0.04 + (pk.suspicious ? 0.15 : 0)) this.spawnPowerup(pk.obj.position);
    if (this.blocked.has(pk.id) || this.pending.has(pk.id)) return;
    this.pending.add(pk.id);
    if (pk.suspicious) this.suspiciousHits.add(pk.id);
    this.conn.send({ t: 'kill', id: pk.id });
  }

  explode(pk) {
    if (pk.dead) return;
    pk.dead = true;
    const pos = pk.obj.position;
    this.world.burst(pos, LANES[pk.lane].color, 50 + pk.scale * 30, 9, 0.9);
    this.world.burst(pos, 0xffffff, 14, 5, 0.35);
    this.sound.explode(pos.x, pos.z, pk.scale);
    if (this.hover === pk) this.hover = null;
    this.world.removeObject(pk.obj);
  }

  breach(pk) {
    pk.dead = true;
    this.world.removeObject(pk.obj);
    if (this.hover === pk) this.hover = null;
    const pos = v3(pk.x, 0.8, HOST_Z);
    const dmg = pk.boss ? 20 : pk.suspicious ? 5 : 0;
    if (pk.boss) this.endBoss(false);
    if (dmg && !this.over) {
      this.integrity = Math.max(0, this.integrity - dmg);
      this.sound.damage(pk.x);
      this.world.shake = pk.boss ? 0.6 : 0.3;
      this.hostFlash = 1;
      this.world.addFloat(pos.clone().setY(2), `-${dmg} INTEGRITY`, 0xff3355);
      this.world.burst(pos, 0xff3355, 40, 8, 0.8);
      if (this.integrity === 0) {
        this.over = true;
        this.exitCockpit();
        if (this.vehicle) this.toggleVehicle(this.vehicle.kind);
        this.arsenal.stopBeam();
        this.awardXP();
        this.ui.setGameOver(true, this.score, this.kills, this.profile.endRun(this.score));
        this.sound.gameOver();
      }
    } else {
      this.world.burst(pos, LANES[pk.lane].color, 8, 3, 0.4);
    }
  }

  // ---------------------------------------------------------- powerups

  spawnPowerup(at, type) {
    type ??= POWERUP_KEYS[Math.floor(Math.random() * POWERUP_KEYS.length)];
    const def = POWERUPS[type];
    const obj = makePowerup(def);
    const pos = at.clone().setY(1.4);
    obj.position.copy(pos);
    this.world.scene.add(obj);
    this.powerups.push({ type, def, obj, pos, life: 14, phase: Math.random() * 6 });
  }

  collect(pu) {
    if (!this.powerups.includes(pu)) return;
    this.powerups = this.powerups.filter((x) => x !== pu);
    this.world.removeObject(pu.obj);
    this.world.burst(pu.pos, pu.def.color, 40, 6, 0.6);
    this.world.addFloat(pu.pos.clone().setY(3), pu.def.name, pu.def.color);
    this.sound.powerup();
    const now = performance.now() / 1000;
    switch (pu.type) {
      case 'rapid': case 'spread': case 'overcharge':
        this.buffs[pu.type] = Math.max(this.buffs[pu.type] ?? 0, now) + pu.def.dur * (1 + this.profile.perk('overclock') * 0.25);
        if (pu.type === 'overcharge') this.arsenal.heat = 0;
        break;
      case 'ammo': this.addAmmo(); break;
      case 'repair': this.integrity = Math.min(this.maxIntegrity, this.integrity + 15); break;
      case 'strike': this.strikes++; break;
      case 'credits': this.credits += 40; break;
    }
  }

  // -------------------------------------------------------------- boss

  promoteBoss(pk) {
    pk.boss = true;
    pk.maxHp = pk.hp = Math.min(120, 40 + pk.count * 1.5);
    pk.speed = 2.4;
    pk.baseScale = 2.4;
    pk.r *= 2.4;
    pk.empCd = 5;
    decorateBoss(pk.obj, LANES[pk.lane].color);
    this.boss = pk;
    this.ui.setBoss(pk);
    this.ui.banner(`⚠ ELEPHANT FLOW ⚠  ${pk.p.src}:${pk.p.sp} · ${LANES[pk.lane].name}`, 'boss');
    this.sound.bossAlarm();
    this.world.shake = 0.4;
  }

  bossDefeated(pk) {
    const pos = pk.obj.position.clone();
    this.world.explosion(pos, 9, LANES[pk.lane].color);
    this.world.explosion(pos.clone().add(v3(1.5, 1, 0)), 6, 0xffffff);
    this.world.shake = 0.8;
    this.sound.boom(1.8);
    this.sound.bossDown();
    this.score += 500;
    this.credits += 150;
    for (let i = 0; i < 4; i++) this.spawnPowerup(pos.clone().add(v3((Math.random() - 0.5) * 6, 0, (Math.random() - 0.5) * 4)));
    this.ui.banner('ELEPHANT FLOW BLOCKED  +500', 'win');
    this.endBoss(true);
  }

  endBoss() {
    this.boss = null;
    this.nextBossAt = performance.now() / 1000 + BOSS_GAP;
    this.ui.setBoss(null);
  }

  // Score earns XP as you go (half a point of XP per point of score).
  awardXP() {
    const delta = this.score - this.xpScore;
    if (delta > 0) {
      this.profile.addXP(delta * 0.5);
      this.xpScore = this.score;
    }
  }

  onProfile(type, data) {
    if (type === 'levelup') {
      this.ui.banner(`LEVEL ${data.level} · ${data.rank.toUpperCase()}  +${data.kp} KP`, 'win');
      this.sound.bossDown();
    } else if (type === 'achievement') {
      this.ui.toast(`🏆 ${data.name}: ${data.desc}  +${data.xp} XP`, 'kill');
      this.sound.powerup();
    }
    this.ui.renderProfile(this.profile);
  }

  // ----------------------------------------------------------- network

  onBatch(pkts) {
    if (this.paused || this.over) return;
    const now = performance.now();
    const mergeZ = GATE_Z + (HOST_Z - GATE_Z) * MERGE_DEPTH;
    for (const p of pkts) {
      const lane = classify(p);
      this.flowLane.set(p.id, lane);
      this.laneSeen[lane] = now;
      if (this.blocked.has(p.id)) {
        // Sampled before the kernel saw the rule: bounce it at the gate.
        this.world.bounce(laneX(lane), 0xff5468, 6);
        continue;
      }
      const existing = this.packets.find((q) => q.id === p.id && !q.dead && (q.boss || q.z < mergeZ));
      if (existing) {
        existing.count++;
        existing.obj.badge.textContent = `×${existing.count}`;
        // The elephant keeps feeding while its flow keeps flowing.
        if (existing.boss) existing.hp = Math.min(existing.maxHp, existing.hp + 1.5);
        else if (!this.boss && now / 1000 > this.nextBossAt && existing.count >= BOSS_SAMPLES && !existing.p.prot) this.promoteBoss(existing);
        continue;
      }
      if (this.packets.length >= MAX_SPRITES) continue;
      const suspicious = isSuspicious(p);
      const scale = Math.max(0.65, Math.min(1.5, 0.45 + 0.17 * Math.log2(Math.max(p.len, 64) / 16)));
      const obj = this.world.makePacket(p, lane, suspicious, scale, this.skins.skinFor(lane), this.skins.colorFor(lane));
      const pk = {
        id: p.id, p, lane, suspicious, obj, count: 1, scale, baseScale: 1, hp: 1, maxHp: 1,
        r: 0.95 * scale,
        x: laneX(lane) + (Math.random() - 0.5) * (LANE_W - 1.6),
        y: 0.9 * scale + 0.25,
        z: GATE_Z + 0.5,
        speed: (5.2 + Math.random() * 2.8) * (suspicious ? 1.3 : 1),
        phase: Math.random() * Math.PI * 2,
      };
      obj.position.set(pk.x, pk.y, pk.z);
      this.packets.push(pk);
    }
  }

  reskinAll() {
    for (const pk of this.packets) {
      if (!pk.dead) this.world.reskin(pk.obj, pk.p, this.skins.skinFor(pk.lane), this.skins.colorFor(pk.lane), pk.scale);
    }
  }

  onKilled(m) {
    this.pending.delete(m.id);
    this.blocked.set(m.id, performance.now());
    const lane = this.flowLane.get(m.id) ?? LANES.length - 1;
    const victims = this.packets.filter((q) => q.id === m.id && !q.dead);
    victims.forEach((q, i) => setTimeout(() => (q.boss ? null : this.explode(q)), 80 * (i + 1)));
    const susp = this.suspiciousHits.delete(m.id) || victims.some((q) => q.suspicious);
    this.combo = this.comboTimer > 0 ? this.combo + 1 : 1;
    this.comboTimer = 2.5;
    const mult = Math.min(5, 1 + Math.floor(this.combo / 3));
    this.profile.onBlocked();
    this.profile.onCombo(mult);
    const pts = (10 + (susp ? 25 : 0)) * mult;
    this.score += pts;
    this.credits += susp ? 20 : 10;
    this.kills++;
    if (this.kills % 15 === 0) {
      this.strikes++;
      this.ui.toast('+1 AIRSTRIKE for 15 blocked flows (F)', 'kill');
    }
    const where = this.lastHitPos ?? v3(laneX(lane), 2, -30);
    this.world.addFloat(where.clone().setY(where.y + 1.5), `BLOCKED +${pts}${mult > 1 ? ` ×${mult}` : ''}`, LANES[lane].color);
    this.ui.toast(`FLOW BLOCKED  ${m.label}`, 'kill');
    this.sound.blocked(mult);
  }

  onDeflect(m) {
    this.pending.delete(m.id);
    for (const q of this.packets.filter((q) => q.id === m.id)) this.world.burst(q.obj.position, 0x7fe7ff, 16, 4, 0.5);
    this.ui.toast(`Protected flow, shot deflected: ${m.label}`, 'warn');
    this.sound.shield();
  }

  onError(m) {
    if (m.id) this.pending.delete(m.id);
    this.ui.toast(m.msg, 'warn');
    this.sound.error();
  }

  onPanicked(m) {
    this.blocked.clear();
    this.prevDrops.clear();
    this.ui.toast(`PANIC: ${m.n} rule${m.n === 1 ? '' : 's'} cleared, all traffic flows again`, 'panic');
    this.sound.panic();
    for (let i = 0; i < LANES.length; i++) this.world.burst(v3(laneX(i), 3, GATE_Z + 1), 0x5fe0ff, 30, 10, 1);
  }

  onRules(rules) {
    const now = performance.now();
    const ids = new Set(rules.map((r) => r.id));
    for (const r of rules) {
      const prev = this.prevDrops.get(r.id) ?? 0;
      const delta = r.drops - prev;
      this.prevDrops.set(r.id, r.drops);
      if (!this.blocked.has(r.id)) this.blocked.set(r.id, now);
      if (delta > 0) {
        if (!this.over) this.score += delta;
        this.profile.onKernelDrops(delta);
        const lane = this.flowLane.get(r.id) ?? LANES.length - 1;
        this.world.bounce(laneX(lane), LANES[lane].color, Math.min(delta, 8));
        this.sound.spark(laneX(lane));
      }
    }
    // Rules that expired (or were unblocked) make the flow fair game again.
    for (const [id, t] of this.blocked) {
      if (!ids.has(id) && now - t > 1500) {
        this.blocked.delete(id);
        this.prevDrops.delete(id);
      }
    }
  }

  // ------------------------------------------------------------- frame

  frame() {
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;
    const t = now / 1000;
    if (!this.paused) this.update(dt, t);
    if (!this.arsenal.beam) this.sound.laser(false); // watchdog: the hum never outlives the beam
    if (this.vehicle) this.world.chase(this.vehicle.pos, this.vehicle.yaw, this.vehicle.cam);
    this.updateHover();
    this.hostFlash = Math.max(0, this.hostFlash - dt * 2);
    this.sound.intensity = Math.min(1, this.packets.length / 50 + this.combo * 0.08 + (this.boss ? 0.4 : 0));
    this.world.render(dt, t, { integrity: this.integrity, hostFlash: this.hostFlash, cannonX: laneX(this.cannonLane) });
    this.ui.updateHUD(this);
    this.ui.updateTooltip(this.manned ? null : this.hover, this.mouse);
    if (this.manned) this.ui.updateCockpit(this.manned, this.hover, this.fireCd);
  }

  update(dt, t) {
    this.fireCd = Math.max(0, this.fireCd - dt);
    this.comboTimer = Math.max(0, this.comboTimer - dt);
    if (this.comboTimer === 0) this.combo = 0;
    this.regen += dt * (1 + this.profile.perk('regen') * 0.4);
    if (this.regen > 4 && !this.over) {
      this.regen = 0;
      this.integrity = Math.min(this.maxIntegrity, this.integrity + 1);
    }
    if (!this.over) {
      this.profile.tick(dt);
      this.awardXP();
    }

    // Player weapon: held fire repeats; the laser is a continuous beam.
    const firing = this.firingBy.size > 0 && !this.building && !this.targeting && !this.over && !this.vehicle?.stunned;
    if (firing && WEAPONS[this.weapon].key === 'laser') {
      const s = this.shooter();
      this.arsenal.fireBeam(s.origin, s.dir, dt);
    } else {
      this.arsenal.stopBeam();
      this.arsenal.coolDown(dt);
      if (firing) this.fire();
    }

    if (this.vehicle) this.vehicle.update(dt, this.keys, this.aimPoint());
    this.updatePackets(dt, t);
    this.updateTurrets(dt);
    this.arsenal.update(dt);
    this.helis = this.helis.filter((h) => {
      if (h.update(dt)) return true;
      h.destroy();
      return false;
    });
    this.sound.rotor(this.helis.length + (this.vehicle?.kind === 'heli' ? 1 : 0));
    this.airstrikes = this.airstrikes.filter((a) => a.update(dt));
    this.updatePowerups(dt, t);
    this.packets = this.packets.filter((pk) => !pk.dead);
    this.updatePreview();
  }

  updatePackets(dt, t) {
    for (const pk of this.packets) {
      if (pk.dead) continue; // exploded by a chain reaction between frames
      pk.z += pk.speed * dt;
      const bob = Math.sin(t * 2.4 + pk.phase) * 0.18;
      const o = pk.obj;
      o.position.set(pk.x, pk.y * pk.baseScale + bob, pk.z);
      const spin = o.spin;
      if (spin.userData.noSpin) {
        spin.rotation.y = Math.sin(t * 1.5 + pk.phase) * 0.25;
        if (spin.userData.waddle) spin.rotation.z = Math.sin(t * 6 + pk.phase) * 0.15;
        spin.scale.set(pk.scale * (1 + Math.sin(t * 7 + pk.phase) * 0.04), pk.scale * (1 - Math.sin(t * 7 + pk.phase) * 0.05), pk.scale);
      } else {
        spin.rotation.y += dt * 1.2;
        spin.rotation.x = Math.sin(t + pk.phase) * 0.3;
      }
      o.shadow.position.y = -pk.y * pk.baseScale - bob + 0.02;
      if (o.shield) o.shield.rotation.y -= dt * 0.8;
      const hovered = this.hover && this.hover.id === pk.id;
      o.scale.setScalar(pk.baseScale * (hovered ? 1.15 : 1) * (pk.hitFlash > 0 ? 1.08 : 1));
      if (pk.boss) this.updateBoss(pk, dt);
      if (pk.z >= HOST_Z) this.breach(pk);
    }
    this.declutterLabels();
  }

  updateBoss(pk, dt) {
    pk.hitFlash = Math.max(0, (pk.hitFlash ?? 0) - dt);
    pk.obj.armor.rotation.y += dt * 0.9;
    pk.obj.crown.rotation.z += dt * 2;
    pk.empCd -= dt;
    if (pk.empCd <= 0 && !this.over) {
      pk.empCd = 7;
      const pos = pk.obj.position;
      this.world.pulse(pos, 14, 0xff3355);
      this.sound.emp();
      for (const tu of this.turrets) if (tu.pos.distanceTo(pos) < 14) tu.stunned = 4;
      if (this.vehicle && this.vehicle.pos.distanceTo(pos) < 14) this.vehicle.stunned = 2.5;
    }
    this.ui.updateBoss(pk);
  }

  updateTurrets(dt) {
    const lvl = this.upgrades.turret;
    for (const tu of this.turrets) {
      tu.cd -= dt;
      tu.stunned = Math.max(0, tu.stunned - dt);
      if (tu === this.manned) continue;
      const range = TURRET_RANGE[lvl];
      const target = tu.stunned ? null : this.packets.find((pk) => !pk.dead && !pk.p.prot && pk.lane === tu.lane && pk.z < tu.pos.z && pk.z > tu.pos.z - range && !this.pending.has(pk.id) && !this.blocked.has(pk.id));
      tu.yaw = target ? Math.atan2(-(target.x - tu.pos.x), -(target.z - tu.pos.z)) : tu.yaw * Math.exp(-dt * 2);
      const head = tu.obj.head;
      head.rotation.y += (tu.yaw - head.rotation.y) * Math.min(1, dt * 10);
      if (target && tu.ammo > 0 && tu.cd <= 0 && !this.over) {
        tu.cd = TURRET_COOLDOWN[lvl];
        tu.ammo--;
        const origin = tu.pos.clone().add(v3(-Math.sin(head.rotation.y) * 1.7, 1.2, -Math.cos(head.rotation.y) * 1.7));
        // Lead the target a little.
        const tp = target.obj.position;
        const aimAt = v3(tp.x, tp.y, tp.z + target.speed * (origin.distanceTo(tp) / 150));
        this.arsenal.bolt(origin, aimAt.sub(origin), { color: 0x9fe870, from: 'turret' });
        this.sound.shoot('turret', tu.pos.x, tu.pos.z);
      }
      this.world.setTurretState(tu.obj, { ammoFrac: tu.stunned ? 0 : tu.ammo / tu.maxAmmo, manned: false });
    }
  }

  updatePowerups(dt, t) {
    for (const pu of [...this.powerups]) {
      pu.life -= dt;
      pu.pos.z += 2.2 * dt;
      pu.obj.position.set(pu.pos.x, pu.pos.y + Math.sin(t * 3 + pu.phase) * 0.3, pu.pos.z);
      pu.obj.cage.rotation.y += dt * 2;
      pu.obj.cage.rotation.x += dt * 1.3;
      pu.obj.visible = pu.life > 3 || Math.sin(t * 20) > 0;
      if (pu.life <= 0 || pu.pos.z > HOST_Z + 2) {
        this.powerups = this.powerups.filter((x) => x !== pu);
        this.world.removeObject(pu.obj);
      }
    }
  }

  updatePreview() {
    const hit = (this.building || this.targeting) && this.mouse ? this.world.pickFloor(this.ndc()) : null;
    if (this.targeting) {
      this.world.showPreview(null);
      this.ui.setStrikeLane(hit ? LANES[this.laneAt(hit.x)].name : null);
      return;
    }
    const c = hit ? this.cellAt(hit.z) : -1;
    if (c < 0) return this.world.showPreview(null);
    const lane = this.laneAt(hit.x);
    const ok = this.credits >= this.price('turret') && !this.turretAt(lane, hit.z);
    this.world.showPreview(laneX(lane), this.cellZ(c), ok, TURRET_RANGE[this.upgrades.turret]);
  }

  // Hover in the overview/vehicles is the packet under the mouse; in the
  // cockpit it is the packet under the crosshair (target lock).
  updateHover() {
    let ray;
    if (this.manned) {
      const cam = this.world.camera;
      ray = new THREE.Ray(cam.position.clone(), v3(0, 0, -1).applyQuaternion(cam.quaternion));
    } else {
      const ndc = this.ndc();
      if (!ndc) { this.hover = null; return; }
      ray = this.world.ray(ndc).clone();
    }
    let best = null;
    let bestD = Infinity;
    for (const pk of this.packets) {
      if (pk.dead) continue;
      const c = pk.obj.position;
      if (ray.distanceSqToPoint(c) > (pk.r * (this.manned ? 1.6 : 1.3)) ** 2) continue;
      const d = ray.origin.distanceToSquared(c);
      if (d < bestD) { bestD = d; best = pk; }
    }
    this.hover = best;
  }

  // Only show a packet's address label when it has room, or when hovered.
  declutterLabels() {
    const byLane = LANES.map(() => []);
    for (const pk of this.packets) if (!pk.dead) byLane[pk.lane].push(pk);
    for (const list of byLane) {
      list.sort((a, b) => b.z - a.z);
      let lastZ = 1e9;
      for (const pk of list) {
        const room = lastZ - pk.z > 9;
        const nearGate = pk.z < GATE_Z + 14; // everything spawns there; labels would pile up
        pk.obj.label.visible = !this.manned && ((room && !nearGate) || this.hover?.id === pk.id || !!pk.boss);
        if (room) lastZ = pk.z;
      }
    }
  }
}
