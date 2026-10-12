// Vehicles: the drivable tank, helicopter gunships and airstrike jets.

import * as THREE from 'three';
import { makeTank, makeHeli, makeJet, makeStrikeMarker } from './models.js';
import { GATE_Z, HOST_Z, BOARD_W, LANE_W, laneX } from './world.js';

const v3 = (x, y, z) => new THREE.Vector3(x, y, z);

// ------------------------------------------------------------------ tank

export class Tank {
  kind = 'tank';
  cam = { back: 14, up: 9, ahead: 14 };

  constructor(game) {
    this.game = game;
    this.obj = makeTank();
    this.pos = v3(0, 0, HOST_Z - 8);
    this.yaw = 0; // 0 = facing the gate (-Z)
    this.turretYaw = 0;
    this.speed = 0;
    this.stunned = 0;
    this.ramCd = 0;
    this.obj.position.copy(this.pos);
    game.world.scene.add(this.obj);
  }

  forward() { return v3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }

  // The turret already tracks the aim point, so fire along the barrel.
  muzzle() {
    const a = this.yaw + this.turretYaw;
    return { pos: this.pos.clone().add(v3(-Math.sin(a) * 3.1, 1.45, -Math.cos(a) * 3.1)), dir: v3(-Math.sin(a), 0, -Math.cos(a)) };
  }

  update(dt, keys, aimPoint) {
    const g = this.game;
    this.stunned = Math.max(0, this.stunned - dt);
    this.ramCd = Math.max(0, this.ramCd - dt);
    const boost = keys.has('shift') ? 1.6 : 1;
    const throttle = this.stunned ? 0 : (keys.has('w') ? 1 : 0) - (keys.has('s') ? 0.6 : 0);
    const steer = this.stunned ? 0 : (keys.has('a') ? 1 : 0) - (keys.has('d') ? 1 : 0);
    this.speed += (throttle * 16 * boost - this.speed) * Math.min(1, dt * 3);
    this.yaw += steer * dt * 2.2 * (this.speed < -0.5 ? -1 : 1);
    this.pos.addScaledVector(this.forward(), this.speed * dt);
    const hw = BOARD_W / 2 - 1.6;
    this.pos.x = Math.max(-hw, Math.min(hw, this.pos.x));
    this.pos.z = Math.max(GATE_Z + 5, Math.min(HOST_Z + 1, this.pos.z));
    this.obj.position.copy(this.pos);
    this.obj.rotation.y = this.yaw;
    this.obj.position.y = Math.abs(this.speed) > 1 ? Math.sin(performance.now() / 40) * 0.03 : 0;

    if (aimPoint) {
      const d = aimPoint.clone().sub(this.pos);
      const want = Math.atan2(-d.x, -d.z) - this.yaw;
      let diff = Math.atan2(Math.sin(want - this.turretYaw), Math.cos(want - this.turretYaw));
      this.turretYaw += diff * Math.min(1, dt * 10);
    }
    this.obj.turret.rotation.y = this.turretYaw;
    this.obj.accent.color.setHex(this.stunned ? 0x334455 : 0x5fe0ff).multiplyScalar(this.stunned ? 1 : 2.2);

    // Ramming: drive through packets to block their flows.
    for (const pk of g.packets) {
      if (pk.dead) continue;
      const c = pk.obj.position;
      const dx = c.x - this.pos.x;
      const dz = c.z - this.pos.z;
      const reach = 2.2 + pk.r;
      if (dx * dx + dz * dz > reach * reach) continue;
      if (pk.p.prot || pk.boss) {
        // Bounce off shields and bosses.
        const n = v3(-dx, 0, -dz).normalize();
        this.pos.addScaledVector(n, 0.6);
        this.speed *= -0.3;
        if (pk.boss && this.ramCd === 0) {
          this.ramCd = 0.5;
          g.damage(pk, 3, 'ram');
          g.world.burst(c, 0xff3355, 20, 6, 0.4);
          g.sound.boom(0.6);
        } else if (pk.p.prot) {
          g.world.burst(c, 0x7fe7ff, 8, 3, 0.3);
        }
        continue;
      }
      g.damage(pk, 99, 'ram');
      g.sound.boom(0.5);
    }
    for (const pu of [...g.powerups]) if (pu.pos.distanceTo(this.pos.clone().setY(pu.pos.y)) < 2.8) g.collect(pu);
    g.sound.engine(Math.min(1, Math.abs(this.speed) / 20));
  }

  destroy() {
    this.game.world.removeObject(this.obj);
    this.game.sound.engine(null);
  }
}

// ------------------------------------------------------------ helicopter

const HELI_LIFE = 40;

export class Heli {
  constructor(game, index) {
    this.game = game;
    this.obj = makeHeli();
    this.obj.scale.setScalar(1.35);
    this.phase = index * Math.PI;
    this.pos = v3(BOARD_W / 2 + 30, 22, HOST_Z + 25);
    this.vel = v3();
    this.life = HELI_LIFE;
    this.state = 'arrive';
    this.gunCd = 0;
    this.rocketCd = 1.5;
    this.t = 0;
    this.obj.position.copy(this.pos);
    game.world.scene.add(this.obj);
  }

  recall() { this.state = 'leave'; }

  update(dt) {
    const g = this.game;
    this.t += dt;
    this.life -= dt;
    if (this.life <= 0 && this.state !== 'leave') this.state = 'leave';

    let goal;
    if (this.state === 'leave') {
      goal = v3(-BOARD_W - 40, 40, HOST_Z + 40);
    } else {
      const s = this.t * 0.45 + this.phase;
      goal = v3(Math.sin(s) * (BOARD_W / 2 - 3), 9 + Math.sin(s * 2) * 1.2, -32 + Math.sin(s * 2) * 18);
      if (this.state === 'arrive' && this.pos.distanceTo(goal) < 6) this.state = 'patrol';
    }
    const want = goal.clone().sub(this.pos);
    const maxV = this.state === 'patrol' ? 14 : 30;
    if (want.length() > maxV) want.setLength(maxV);
    this.vel.lerp(want, Math.min(1, dt * 1.5));
    this.pos.addScaledVector(this.vel, dt);
    this.obj.position.copy(this.pos);

    // Face the nearest target if there is one, else the direction of travel.
    const target = this.state === 'patrol' ? this.pickTarget() : null;
    const look = target ? target.obj.position.clone().sub(this.pos) : this.vel.clone();
    if (look.lengthSq() > 0.01) {
      const yaw = Math.atan2(-look.x, -look.z);
      const diff = Math.atan2(Math.sin(yaw - this.obj.rotation.y), Math.cos(yaw - this.obj.rotation.y));
      this.obj.rotation.y += diff * Math.min(1, dt * 3);
    }
    this.obj.rotation.z = THREE.MathUtils.clamp(-this.vel.x * 0.02, -0.35, 0.35);
    this.obj.rotation.x = THREE.MathUtils.clamp(-this.vel.length() * 0.012, -0.3, 0);
    this.obj.rotor.rotation.y += dt * 40;
    this.obj.tailRotor.rotation.x += dt * 50;
    const blink = Math.sin(this.t * 6) > 0.6;
    this.obj.navs.forEach((n) => { n.visible = blink; });

    if (target && !g.over) {
      this.gunCd -= dt;
      this.rocketCd -= dt;
      const muzzle = this.pos.clone().add(v3(0, -0.5, 0));
      const dir = target.obj.position.clone().sub(muzzle);
      if (this.gunCd <= 0) {
        this.gunCd = 0.16;
        dir.x += (Math.random() - 0.5) * 1.5;
        dir.z += (Math.random() - 0.5) * 1.5;
        g.arsenal.bolt(muzzle, dir, { color: 0xffb347, from: 'heli', speed: 120 });
        g.sound.shoot('heli', this.pos.x, this.pos.z);
      }
      if (this.rocketCd <= 0) {
        this.rocketCd = 2.4;
        const boss = g.packets.find((p) => p.boss && !p.dead);
        g.arsenal.rocket(muzzle, v3(0, -0.4, -1), boss ?? target, 'heli');
        g.sound.rocket();
      }
    }
    return !(this.state === 'leave' && this.pos.y > 35);
  }

  pickTarget() {
    let best = null;
    let bestD = 48 * 48;
    for (const pk of this.game.packets) {
      if (pk.dead || pk.p.prot) continue;
      const d = pk.obj.position.distanceToSquared(this.pos);
      if (pk.boss) return pk;
      if (d < bestD) { bestD = d; best = pk; }
    }
    return best;
  }

  destroy() { this.game.world.removeObject(this.obj); }
}

// -------------------------------------------------------------- airstrike

// A warning phase marks the lanes, then jets fly in from behind the host
// and carpet-bomb them all the way to the gate.
export class Airstrike {
  constructor(game, lanes) {
    this.game = game;
    this.lanes = lanes;
    this.id = Math.random();
    this.warn = 1.2;
    this.jets = [];
    this.markers = lanes.map((l) => {
      const m = makeStrikeMarker(LANE_W - 0.4, HOST_Z - GATE_Z);
      m.position.set(laneX(l), 0.06, (HOST_Z + GATE_Z) / 2);
      game.world.scene.add(m);
      return m;
    });
    game.sound.siren();
  }

  cancel() {
    for (const m of this.markers) this.game.world.removeObject(m);
    for (const j of this.jets) this.game.world.removeObject(j.obj);
    this.markers = [];
    this.jets = [];
    this.done = true;
  }

  update(dt) {
    const g = this.game;
    if (this.warn > 0) {
      this.warn -= dt;
      for (const m of this.markers) m.material.opacity = 0.12 + 0.18 * (Math.sin(performance.now() / 70) > 0 ? 1 : 0);
      if (this.warn <= 0) {
        this.jets = this.lanes.map((l, i) => {
          const obj = makeJet();
          const pos = v3(laneX(l), 19 + i * 1.5, HOST_Z + 45 + i * 8);
          obj.position.copy(pos);
          g.world.scene.add(obj);
          return { obj, pos, lane: l, dropCd: 0 };
        });
        g.sound.jet();
      }
      return true;
    }
    for (const j of this.jets) {
      j.pos.z -= 85 * dt;
      j.obj.position.copy(j.pos);
      j.obj.rotation.z = Math.sin(performance.now() / 300) * 0.08;
      j.dropCd -= dt;
      if (j.pos.z < HOST_Z - 2 && j.pos.z > GATE_Z + 4 && j.dropCd <= 0) {
        j.dropCd = 0.075;
        g.arsenal.bomb(j.pos.clone().add(v3((Math.random() - 0.5) * 1.6, -1, 0)), v3(0, -6, -28), this.id);
      }
      // Contrail
      g.world.particles.add({ x: j.pos.x, y: j.pos.y, z: j.pos.z + 3, vx: 0, vy: 0, vz: 0, life: 0.9, max: 0.9, r: 0.6, g: 0.6, b: 0.75, s: 0.6, grav: 0 });
    }
    for (const m of this.markers) m.material.opacity *= Math.exp(-dt * 1.5);
    if (this.jets.length && this.jets.every((j) => j.pos.z < GATE_Z - 60)) {
      this.cancel();
      return false;
    }
    return true;
  }
}

// ------------------------------------------------------ flyable aircraft

const AIRSPACE_X = BOARD_W / 2 + 22;
const AIRSPACE_Z = [GATE_Z - 25, HOST_Z + 22];

// Fire from `from` towards the aim point on the floor.
function aimDir(from, aimPoint, fallback) {
  if (!aimPoint) return fallback;
  return aimPoint.clone().sub(from).normalize();
}

// Player-piloted helicopter: W/S forward/back, A/D yaw, Q/E down/up,
// Shift boost. The chin gun aims wherever the mouse points.
export class PlayerHeli {
  kind = 'heli';
  cam = { back: 15, up: 7, ahead: 16, lookDown: 6 };

  constructor(game) {
    this.game = game;
    this.obj = makeHeli();
    this.obj.scale.setScalar(0.8);
    this.pos = v3(0, 9, HOST_Z - 6);
    this.vel = v3();
    this.yaw = 0;
    this.stunned = 0;
    this.obj.position.copy(this.pos);
    game.world.scene.add(this.obj);
  }

  forward() { return v3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }

  muzzle(aimPoint) {
    const pos = this.pos.clone().add(v3(0, -0.9, 0)).addScaledVector(this.forward(), 1.6);
    return { pos, dir: aimDir(pos, aimPoint, this.forward().add(v3(0, -0.35, 0)).normalize()) };
  }

  update(dt, keys) {
    const g = this.game;
    this.stunned = Math.max(0, this.stunned - dt);
    const live = !this.stunned;
    const boost = keys.has('shift') ? 1.8 : 1;
    const fwd = live ? (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0) : 0;
    const turn = live ? (keys.has('a') ? 1 : 0) - (keys.has('d') ? 1 : 0) : 0;
    const climb = live ? (keys.has('e') ? 1 : 0) - (keys.has('q') ? 1 : 0) : -0.3;
    this.yaw += turn * dt * 2.0;
    const want = this.forward().multiplyScalar(fwd * 22 * boost).setY(climb * 9);
    this.vel.lerp(want, Math.min(1, dt * 2.5));
    this.pos.addScaledVector(this.vel, dt);
    this.pos.x = Math.max(-AIRSPACE_X, Math.min(AIRSPACE_X, this.pos.x));
    this.pos.z = Math.max(AIRSPACE_Z[0], Math.min(AIRSPACE_Z[1], this.pos.z));
    this.pos.y = Math.max(2.2, Math.min(24, this.pos.y));
    const t = performance.now() / 1000;
    this.obj.position.copy(this.pos).setY(this.pos.y + Math.sin(t * 2) * 0.12);
    this.obj.rotation.set(-fwd * 0.18 * boost, this.yaw, turn * 0.2, 'YXZ');
    this.obj.rotor.rotation.y += dt * (live ? 45 : 12);
    this.obj.tailRotor.rotation.x += dt * 50;
    this.obj.navs.forEach((n, i) => { n.visible = Math.sin(t * 6 + i) > 0.5; });
    // Skim low to scoop up power-ups.
    if (this.pos.y < 5) {
      for (const pu of [...g.powerups]) {
        if (Math.hypot(pu.pos.x - this.pos.x, pu.pos.z - this.pos.z) < 3) g.collect(pu);
      }
    }
  }

  destroy() {
    this.game.world.removeObject(this.obj);
  }
}

// Player-flown jet: always moving. W/S throttle, A/D bank-turn, Q/E
// altitude. Leaving the airspace turns you back automatically.
export class PlayerJet {
  kind = 'jet';
  cam = { back: 12, up: 4, ahead: 26, lookDown: 8 };

  constructor(game) {
    this.game = game;
    this.obj = makeJet();
    this.obj.scale.setScalar(0.75);
    this.pos = v3(0, 14, HOST_Z + 10);
    this.yaw = 0;
    this.bank = 0;
    this.speed = 34;
    this.stunned = 0;
    this.obj.position.copy(this.pos);
    game.world.scene.add(this.obj);
  }

  forward() { return v3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }

  // Guns only reach the forward hemisphere; aim behind you and they fire ahead.
  muzzle(aimPoint) {
    const fwd = this.forward();
    const pos = this.pos.clone().addScaledVector(fwd, 2.5).add(v3(0, -0.6, 0));
    let dir = aimDir(pos, aimPoint, null);
    if (!dir || dir.dot(fwd) < 0.2) dir = fwd.clone().add(v3(0, -0.45, 0)).normalize();
    return { pos, dir };
  }

  update(dt, keys) {
    const g = this.game;
    this.stunned = Math.max(0, this.stunned - dt);
    const live = !this.stunned;
    const throttle = (keys.has('w') ? 1 : 0) - (keys.has('s') ? 1 : 0);
    this.speed += ((throttle > 0 ? 58 : throttle < 0 ? 20 : 34) * (keys.has('shift') ? 1.3 : 1) - this.speed) * Math.min(1, dt * 1.5);
    let turn = live ? (keys.has('a') ? 1 : 0) - (keys.has('d') ? 1 : 0) : 0;
    // Auto-return when leaving the airspace.
    const out = Math.abs(this.pos.x) > AIRSPACE_X || this.pos.z < AIRSPACE_Z[0] || this.pos.z > AIRSPACE_Z[1];
    if (out) {
      const home = Math.atan2(this.pos.x, this.pos.z - (GATE_Z + HOST_Z) / 2);
      const diff = Math.atan2(Math.sin(home - this.yaw), Math.cos(home - this.yaw));
      turn = Math.sign(diff);
      if (g.sound.ready('turnback', 3000)) g.ui.toast('Leaving the airspace, turning back', 'warn');
    }
    this.yaw += turn * dt * 1.6;
    this.bank += (turn * 0.75 - this.bank) * Math.min(1, dt * 4);
    const climb = live ? (keys.has('e') ? 1 : 0) - (keys.has('q') ? 1 : 0) : -0.5;
    this.pos.addScaledVector(this.forward(), this.speed * dt);
    this.pos.y = Math.max(4, Math.min(30, this.pos.y + climb * 10 * dt));
    this.obj.position.copy(this.pos);
    this.obj.rotation.set(-climb * 0.25, this.yaw, this.bank, 'YXZ');
    g.world.particles.add({ x: this.pos.x, y: this.pos.y, z: this.pos.z, vx: 0, vy: 0, vz: 0, life: 0.5, max: 0.5, r: 0.5, g: 0.55, b: 0.7, s: 0.45, grav: 0 });
    g.sound.engine(0.4 + (this.speed - 20) / 60);
  }

  destroy() {
    this.game.world.removeObject(this.obj);
    this.game.sound.engine(null);
  }
}
