// Weapons, upgrades, power-ups and the projectile system. Every hit ends up
// in Game.damage(), which turns a destroyed packet into a real flow kill.

import * as THREE from 'three';
import { makeRocket, makeGrenade, makeBolt, makeBeam } from './models.js';
import { GATE_Z, BOARD_W } from './world.js';

export const WEAPONS = [
  { key: 'blaster', name: 'BLASTER', cd: 0.12, ammo: Infinity, color: 0xdffaff },
  { key: 'laser', name: 'LASER', cd: 0, ammo: Infinity, color: 0xff3355 },
  { key: 'rocket', name: 'ROCKETS', cd: 0.4, ammo: 8, max: 40, color: 0xff8a3d },
  { key: 'grenade', name: 'GRENADES', cd: 0.45, ammo: 10, max: 40, color: 0x9fe870 },
  { key: 'cluster', name: 'CLUSTER', cd: 0.9, ammo: 3, max: 15, color: 0xe86bd0 },
];

export const UPGRADES = [
  { key: 'blaster', name: 'Blaster', levels: ['single', 'twin', 'triple spread'], cost: [90, 180] },
  { key: 'laser', name: 'Laser', levels: ['basic', 'cool-running', 'wide & hot'], cost: [110, 220] },
  { key: 'rocket', name: 'Rockets', levels: ['single', '2-salvo', '3-salvo'], cost: [110, 220] },
  { key: 'grenade', name: 'Grenades', levels: ['radius 4', 'radius 5.5', 'radius 7'], cost: [90, 180] },
  { key: 'cluster', name: 'Cluster', levels: ['8 bomblets', '12 bomblets', '16 bomblets'], cost: [120, 240] },
  { key: 'turret', name: 'Turrets', levels: ['standard', 'rapid', 'long range'], cost: [100, 200] },
  { key: 'strike', name: 'Airstrike', levels: ['1 jet', '2 jets', '3 jets'], cost: [150, 300] },
];

export const POWERUPS = {
  rapid: { glyph: '»', color: 0xf5c542, name: 'RAPID FIRE', dur: 10 },
  spread: { glyph: '✶', color: 0x5fe0ff, name: 'SPREAD SHOT', dur: 10 },
  overcharge: { glyph: 'ϟ', color: 0xb388ff, name: 'OVERCHARGE', dur: 8 },
  ammo: { glyph: 'A', color: 0xff8a3d, name: 'AMMO CRATE' },
  repair: { glyph: '+', color: 0x5fd068, name: 'REPAIR +15' },
  strike: { glyph: '✈', color: 0xff3355, name: 'AIRSTRIKE +1' },
  credits: { glyph: '¢', color: 0xffe14d, name: '+40¢' },
};
export const POWERUP_KEYS = Object.keys(POWERUPS);

const G = 30; // gravity for ballistic projectiles
const BOLT_SPEED = 150;
const tmpSeg = new THREE.Line3();
const tmpPt = new THREE.Vector3();

export class Arsenal {
  constructor(game) {
    this.game = game;
    this.world = game.world;
    this.list = [];
    this.beam = null; // {obj, from} while the laser is firing
    this.heat = 0;
    this.overheated = false;
  }

  clear() {
    for (const p of this.list) this.world.removeObject(p.obj);
    this.list = [];
    this.stopBeam();
  }

  add(p) {
    this.world.scene.add(p.obj);
    p.obj.position.copy(p.pos);
    p.age = 0;
    this.list.push(p);
    return p;
  }

  // ------------------------------------------------------------ spawners

  bolt(origin, dir, { color = 0xdffaff, from = 'player', dmg = 1, speed = BOLT_SPEED } = {}) {
    // Player bolts are often right in front of the camera (cockpit, vehicles): keep bloom in check.
    const obj = makeBolt(color, from === 'player' ? 2.6 : 3);
    const vel = dir.clone().normalize().multiplyScalar(speed);
    obj.lookAt(origin.clone().add(vel));
    return this.add({ kind: 'bolt', pos: origin.clone(), vel, obj, life: 1.1, dmg, from, passed: new Set() });
  }

  rocket(origin, dir, target, from = 'player') {
    const obj = makeRocket();
    const vel = dir.clone().normalize().multiplyScalar(35);
    return this.add({ kind: 'rocket', pos: origin.clone(), vel, obj, life: 4, target, from, smoke: 0 });
  }

  // Ballistic launch so the projectile lands on `aim`.
  lob(kind, origin, aim, from = 'player') {
    const d = aim.clone().sub(origin);
    const flat = Math.hypot(d.x, d.z);
    const T = Math.max(0.55, Math.min(1.5, flat / 45));
    const vel = new THREE.Vector3(d.x / T, (d.y + 0.5 * G * T * T) / T, d.z / T);
    return this.add({ kind, pos: origin.clone(), vel, obj: makeGrenade(kind), life: 4, from });
  }

  bomb(pos, vel, tag) {
    return this.add({ kind: 'bomb', pos: pos.clone(), vel: vel.clone(), obj: makeGrenade('bomb'), life: 4, from: 'strike', tag });
  }

  // ---------------------------------------------------------- the laser

  laserStats() {
    const lvl = this.game.upgrades.laser;
    const over = this.game.hasBuff('overcharge');
    return {
      heatRate: over ? 0 : [38, 26, 22][lvl],
      dps: [14, 18, 28][lvl] * (over ? 2 : 1),
      width: [0.35, 0.45, 0.7][lvl],
    };
  }

  // Called every frame while the player holds fire with the laser selected.
  fireBeam(origin, dir, dt) {
    const st = this.laserStats();
    if (this.overheated) {
      this.stopBeam();
      return;
    }
    this.heat = Math.min(100, this.heat + st.heatRate * dt);
    if (this.heat >= 100) {
      this.overheated = true;
      this.game.sound.overheat();
      this.stopBeam();
      return;
    }
    if (!this.beam) {
      this.beam = makeBeam(0xff3355);
      this.world.scene.add(this.beam);
      this.game.sound.laser(true);
    }
    const len = 95;
    const end = origin.clone().addScaledVector(dir, len);
    this.beam.position.copy(origin);
    this.beam.lookAt(end);
    this.beam.scale.set(st.width / 0.35, st.width / 0.35, len);
    this.beam.halo.material.opacity = (this.game.manned ? 0.12 : 0.22) + Math.random() * 0.12;
    tmpSeg.set(origin, end);
    for (const pk of this.game.packets) {
      if (pk.dead) continue;
      const c = pk.obj.position;
      tmpSeg.closestPointToPoint(c, true, tmpPt);
      if (tmpPt.distanceTo(c) > pk.r + st.width) continue;
      if (pk.p.prot) {
        if (Math.random() < dt * 8) this.world.burst(c, 0x7fe7ff, 4, 3, 0.3);
        continue;
      }
      this.world.burst(tmpPt, 0xff3355, 2, 6, 0.25);
      this.game.damage(pk, st.dps * dt, 'laser');
    }
    for (const pu of this.game.powerups) {
      tmpSeg.closestPointToPoint(pu.pos, true, tmpPt);
      if (tmpPt.distanceTo(pu.pos) < 1.4) this.game.collect(pu);
    }
  }

  stopBeam() {
    if (!this.beam) return;
    this.world.removeObject(this.beam);
    this.beam = null;
    this.game.sound.laser(false);
  }

  coolDown(dt) {
    this.heat = Math.max(0, this.heat - 45 * dt);
    if (this.overheated && this.heat < 25) this.overheated = false;
  }

  // ---------------------------------------------------------- explosions

  explode(pos, radius, dmg, color, big = false, src = 'player', tag) {
    this.world.explosion(pos, radius, color);
    this.game.sound.boom(big ? 1.6 : Math.min(1.4, radius / 4));
    this.world.shake = Math.max(this.world.shake, big ? 0.45 : 0.12 + radius * 0.03);
    for (const pk of this.game.packets) {
      if (pk.dead) continue;
      const d = pk.obj.position.distanceTo(pos);
      if (d > radius + pk.r) continue;
      this.game.damage(pk, dmg, src, tag);
    }
    for (const pu of [...this.game.powerups]) if (pu.pos.distanceTo(pos) < radius + 1) this.game.collect(pu);
  }

  // -------------------------------------------------------------- update

  update(dt) {
    const game = this.game;
    for (const p of this.list) {
      p.age += dt;
      p.life -= dt;
      const from = p.pos.clone();
      switch (p.kind) {
        case 'bolt':
          p.pos.addScaledVector(p.vel, dt);
          break;
        case 'rocket': {
          const speed = Math.min(95, 35 + p.age * 110);
          if (p.target && !p.target.dead) {
            const want = p.target.obj.position.clone().sub(p.pos).normalize().multiplyScalar(speed);
            p.vel.lerp(want, Math.min(1, dt * 6));
          }
          p.vel.setLength(speed);
          p.pos.addScaledVector(p.vel, dt);
          p.obj.lookAt(p.pos.clone().add(p.vel));
          p.obj.flame.scale.setScalar(0.7 + Math.random() * 0.6);
          p.smoke -= dt;
          if (p.smoke <= 0) {
            p.smoke = 0.025;
            this.world.particles.add({ x: p.pos.x, y: p.pos.y, z: p.pos.z, vx: (Math.random() - 0.5), vy: 0.6, vz: (Math.random() - 0.5), life: 0.6, max: 0.6, r: 0.5, g: 0.45, b: 0.5, s: 0.5, grav: -1 });
          }
          break;
        }
        default: // grenade, cluster, bomblet, bomb
          p.vel.y -= G * dt;
          p.pos.addScaledVector(p.vel, dt);
          p.obj.rotation.x += dt * 8;
          p.obj.rotation.z += dt * 5;
          if (p.kind === 'cluster' && p.vel.y < 0 && p.age > 0.3) {
            this.split(p);
            continue;
          }
      }
      p.obj.position.copy(p.pos);

      // Contact with packets (swept)
      tmpSeg.set(from, p.pos);
      let best = null;
      let bestT = Infinity;
      for (const pk of game.packets) {
        if (pk.dead) continue;
        const c = pk.obj.position;
        tmpSeg.closestPointToPoint(c, true, tmpPt);
        if (tmpPt.distanceTo(c) > pk.r + 0.25) continue;
        if (pk.p.prot) {
          if (!p.passed?.has(pk)) {
            p.passed?.add(pk);
            this.world.burst(c, 0x7fe7ff, 18, 4, 0.4);
            game.sound.shield(c.x, c.z);
          }
          continue; // everything passes through shields: protected flows never die
        }
        const t = tmpSeg.closestPointToPointParameter(c, true);
        if (t < bestT) { bestT = t; best = pk; }
      }
      // Shooting a power-up collects it.
      for (const pu of [...game.powerups]) {
        tmpSeg.closestPointToPoint(pu.pos, true, tmpPt);
        if (tmpPt.distanceTo(pu.pos) < 1.3) game.collect(pu);
      }

      if (best) {
        this.impact(p, best);
      } else if (p.kind === 'bolt' && p.pos.y <= 0.05) {
        p.dead = true; // bolt hit the floor
        this.world.burst(p.pos.setY(0.1), 0x8899aa, 6, 3, 0.3);
        if (p.from === 'player' && !game.over) game.score = Math.max(0, game.score - 1);
      } else if (p.kind !== 'bolt' && p.kind !== 'rocket' && p.pos.y <= 0.2) {
        p.pos.y = 0.2;
        this.impact(p, null);
      } else if (p.life <= 0 || p.pos.z < GATE_Z - 5 || p.pos.y < -1 || Math.abs(p.pos.x) > BOARD_W) {
        p.dead = true;
        if (p.kind === 'rocket') this.explode(p.pos, 2.2, 4, 0xff8a3d, false, p.from);
        else if (p.from === 'player' && !game.over) game.score = Math.max(0, game.score - 1);
      }
    }
    for (const p of this.list) if (p.dead) this.world.removeObject(p.obj);
    this.list = this.list.filter((p) => !p.dead);
  }

  impact(p, pk) {
    p.dead = true;
    const g = this.game;
    switch (p.kind) {
      case 'bolt':
        g.damage(pk, p.dmg, p.from);
        break;
      case 'rocket':
        this.explode(p.pos, 2.6, 6, 0xff8a3d, false, p.from);
        break;
      case 'grenade':
        this.explode(p.pos, [4, 5.5, 7][g.upgrades.grenade], 4, 0x9fe870, false, p.from);
        break;
      case 'cluster':
        this.split(p);
        break;
      case 'bomblet':
        this.explode(p.pos, 2.4, 3, 0xff8a3d, false, p.from);
        break;
      case 'bomb':
        this.explode(p.pos, 4.8, 14, 0xff3355, true, 'strike', p.tag);
        break;
    }
  }

  split(p) {
    p.dead = true;
    const n = [8, 12, 16][this.game.upgrades.cluster];
    this.world.burst(p.pos, 0xe86bd0, 30, 6, 0.4);
    this.game.sound.pop();
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.4;
      const s = 5 + Math.random() * 7;
      const vel = new THREE.Vector3(p.vel.x * 0.35 + Math.cos(a) * s, 3 + Math.random() * 6, p.vel.z * 0.35 + Math.sin(a) * s);
      this.add({ kind: 'bomblet', pos: p.pos.clone(), vel, obj: makeGrenade('bomblet'), life: 3, from: p.from });
    }
  }
}

