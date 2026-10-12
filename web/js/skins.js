// Packet skins. A skin builds the body of one packet (about one unit in
// radius, facing +Z, the direction it travels). Each skin varies by protocol
// and carries the per-flow tint somewhere, so samples of one flow still look
// related. Choices are per-viewer and saved in localStorage.

import * as THREE from 'three';
import { LANES, PROTO } from './lanes.js';
import { hdr } from './models.js';

export const SKINS = {
  neon: 'Neon shapes',
  invaders: 'Space Invaders',
  critters: 'Critters',
  ghosts: 'Ghosts',
  crystals: 'Crystals',
  ducks: 'Rubber ducks',
};

const STORE_KEY = 'flowbreaker-skins';

export class SkinSettings {
  constructor() {
    this.global = 'neon';
    this.lane = {}; // lane key -> skin key
    this.color = {}; // lane key -> '#rrggbb'
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY));
      if (s && SKINS[s.global]) this.global = s.global;
      if (s?.lane) for (const [k, v] of Object.entries(s.lane)) if (SKINS[v]) this.lane[k] = v;
      if (s?.color) for (const [k, v] of Object.entries(s.color)) if (/^#[0-9a-f]{6}$/i.test(v)) this.color[k] = v;
    } catch { /* storage unavailable: defaults */ }
  }

  save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ global: this.global, lane: this.lane, color: this.color })); } catch { /* ignore */ }
  }

  skinFor(laneIdx) { return this.lane[LANES[laneIdx].key] || this.global; }

  colorFor(laneIdx) {
    const c = this.color[LANES[laneIdx].key];
    return c ? parseInt(c.slice(1), 16) : LANES[laneIdx].color;
  }
}

// ------------------------------------------------------- material caches

const cache = new Map();
const cached = (key, make) => {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key);
};
const bodyMat = (color, k = 0.95) => cached(`body${color}${k}`, () => new THREE.MeshStandardMaterial({
  color: new THREE.Color(color).multiplyScalar(0.3), emissive: color, emissiveIntensity: k, metalness: 0.35, roughness: 0.4, flatShading: true,
}));
const softMat = (color) => cached(`soft${color}`, () => new THREE.MeshStandardMaterial({
  color: new THREE.Color(color).multiplyScalar(0.55), emissive: color, emissiveIntensity: 0.55, metalness: 0.05, roughness: 0.55,
}));
const glowMat = (color, k = 2) => cached(`glow${color}${k}`, () => new THREE.MeshBasicMaterial({ color: hdr(color, k) }));
const plain = (color) => cached(`plain${color}`, () => new THREE.MeshStandardMaterial({ color, roughness: 0.3, metalness: 0 }));
const geo = (key, make) => cached(`g${key}`, make);

const shapeOf = (p) => (p.proto === PROTO.TCP ? 'tcp' : p.proto === PROTO.UDP ? 'udp' : p.proto === PROTO.ICMP || p.proto === PROTO.ICMPV6 ? 'icmp' : 'other');

function eyes(group, { x = 0.32, y = 0.25, z = 0.7, r = 0.22, pupil = 0x0b0f1a } = {}) {
  for (const sx of [-1, 1]) {
    const w = new THREE.Mesh(geo(`eye${r}`, () => new THREE.SphereGeometry(r, 12, 8)), plain(0xffffff));
    w.position.set(sx * x, y, z);
    const p = new THREE.Mesh(geo(`pupil${r}`, () => new THREE.SphereGeometry(r * 0.5, 10, 6)), plain(pupil));
    p.position.set(sx * x, y, z + r * 0.65);
    group.add(w, p);
  }
}

// ---------------------------------------------------------------- skins

function neon(p, color, tint) {
  const s = shapeOf(p);
  const g = new THREE.Group();
  const geom = geo(`neon${s}`, () => ({
    tcp: new THREE.CapsuleGeometry(0.42, 0.9, 3, 10).rotateZ(Math.PI / 2),
    udp: new THREE.OctahedronGeometry(0.75),
    icmp: new THREE.IcosahedronGeometry(0.65, 1),
    other: new THREE.DodecahedronGeometry(0.7),
  })[s]);
  const edges = geo(`neonE${s}`, () => new THREE.EdgesGeometry(geom, 20));
  g.add(new THREE.Mesh(geom, bodyMat(color)));
  g.add(new THREE.LineSegments(edges, cached(`line${tint}`, () => new THREE.LineBasicMaterial({ color: hdr(tint, 1.6) }))));
  return g;
}

const INVADERS = {
  tcp: ['..X.....X..', '...X...X...', '..XXXXXXX..', '.XX.XXX.XX.', 'XXXXXXXXXXX', 'X.XXXXXXX.X', 'X.X.....X.X', '...XX.XX...'],
  udp: ['...XX...', '..XXXX..', '.XXXXXX.', 'XX.XX.XX', 'XXXXXXXX', '..X..X..', '.X.XX.X.', 'X.X..X.X'],
  icmp: ['....XXXX....', '.XXXXXXXXXX.', 'XXXXXXXXXXXX', 'XXX..XX..XXX', 'XXXXXXXXXXXX', '...XX..XX...', '..XX.XX.XX..', 'XX........XX'],
};
INVADERS.other = INVADERS.tcp;

function invaders(p, color, tint) {
  const s = shapeOf(p);
  const rows = INVADERS[s];
  const px = 1.9 / rows[0].length;
  const cells = [];
  rows.forEach((row, y) => [...row].forEach((c, x) => { if (c === 'X') cells.push([x, y]); }));
  const m = new THREE.InstancedMesh(geo(`vox${px}`, () => new THREE.BoxGeometry(px * 0.92, px * 0.92, px * 1.6)), bodyMat(color, 1.1), cells.length);
  const mat4 = new THREE.Matrix4();
  cells.forEach(([x, y], i) => {
    mat4.makeTranslation((x - (rows[0].length - 1) / 2) * px, ((rows.length - 1) / 2 - y) * px, 0);
    m.setMatrixAt(i, mat4);
  });
  const g = new THREE.Group();
  g.add(m);
  const badge = new THREE.Mesh(geo('vbadge', () => new THREE.BoxGeometry(0.3, 0.12, 0.3)), glowMat(tint, 2));
  badge.position.set(0, -0.95, 0);
  g.add(badge);
  g.userData.noSpin = true;
  return g;
}

function critters(p, color, tint) {
  const s = shapeOf(p);
  const g = new THREE.Group();
  const body = new THREE.Mesh(geo('critter', () => new THREE.SphereGeometry(0.8, 18, 12)), softMat(color));
  body.scale.set(1.05, 0.85, 1);
  g.add(body);
  if (s === 'icmp') {
    const w = new THREE.Mesh(geo('cyc', () => new THREE.SphereGeometry(0.34, 14, 10)), plain(0xffffff));
    w.position.set(0, 0.2, 0.62);
    const pu = new THREE.Mesh(geo('cycp', () => new THREE.SphereGeometry(0.17, 10, 8)), plain(0x0b0f1a));
    pu.position.set(0, 0.2, 0.9);
    g.add(w, pu);
  } else {
    eyes(g, { z: 0.62 });
  }
  if (s === 'udp') {
    for (const sx of [-1, 1]) {
      const horn = new THREE.Mesh(geo('horn', () => new THREE.ConeGeometry(0.12, 0.5, 8)), glowMat(tint, 1.6));
      horn.position.set(sx * 0.45, 0.8, 0);
      horn.rotation.z = -sx * 0.4;
      g.add(horn);
    }
  } else {
    for (const sx of [-1, 1]) {
      const stalk = new THREE.Mesh(geo('stalk', () => new THREE.CylinderGeometry(0.03, 0.03, 0.6, 5)), plain(0x222a3a));
      stalk.position.set(sx * 0.25, 0.9, 0);
      stalk.rotation.z = -sx * 0.35;
      const tip = new THREE.Mesh(geo('tip', () => new THREE.SphereGeometry(0.1, 8, 6)), glowMat(tint, 2.5));
      tip.position.set(sx * 0.37, 1.2, 0);
      g.add(stalk, tip);
    }
  }
  for (let i = 0; i < 4; i++) {
    const foot = new THREE.Mesh(geo('foot', () => new THREE.SphereGeometry(0.16, 8, 6)), softMat(color));
    foot.position.set((i % 2 ? 1 : -1) * 0.4, -0.68, i < 2 ? 0.3 : -0.3);
    g.add(foot);
  }
  g.userData.noSpin = true;
  return g;
}

function ghosts(p, color, tint) {
  const g = new THREE.Group();
  const mat = cached(`ghost${color}`, () => new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.5), emissive: color, emissiveIntensity: 0.8, transparent: true, opacity: 0.82, roughness: 0.5 }));
  const head = new THREE.Mesh(geo('ghostHead', () => new THREE.SphereGeometry(0.8, 18, 10, 0, Math.PI * 2, 0, Math.PI / 2)), mat);
  head.position.y = 0.1;
  const skirt = new THREE.Mesh(geo('ghostSkirt', () => new THREE.CylinderGeometry(0.8, 0.85, 0.9, 18, 1, true)), mat);
  skirt.position.y = -0.35;
  g.add(head, skirt);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const t = new THREE.Mesh(geo('ghostTent', () => new THREE.ConeGeometry(0.22, 0.35, 8).rotateX(Math.PI)), mat);
    t.position.set(Math.cos(a) * 0.62, -0.95, Math.sin(a) * 0.62);
    g.add(t);
  }
  eyes(g, { y: 0.25, z: 0.62, r: 0.2, pupil: tint });
  g.userData.noSpin = true;
  return g;
}

function crystals(p, color, tint) {
  const s = shapeOf(p);
  const g = new THREE.Group();
  const mat = cached(`crystal${color}`, () => new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.4), emissive: color, emissiveIntensity: 0.7, metalness: 0.1, roughness: 0.05, transparent: true, opacity: 0.85, flatShading: true }));
  const shard = geo('shard', () => new THREE.OctahedronGeometry(0.5, 0).scale(1, 2, 1));
  const shards = s === 'udp' ? [[0, 0, 0, 1], [0.45, -0.2, 0.1, 0.6], [-0.4, -0.25, -0.1, 0.55]] : s === 'icmp' ? [[0, 0, 0, 0.7], [0.6, 0, 0, 0.45], [-0.6, 0, 0, 0.45], [0, 0, 0.6, 0.45], [0, 0, -0.6, 0.45]] : [[0, 0, 0, 1], [0, 0, 0, 0.75]];
  shards.forEach(([x, y, z, k], i) => {
    const m = new THREE.Mesh(shard, mat);
    m.position.set(x, y, z);
    m.scale.setScalar(k);
    if (s === 'tcp' && i === 1) m.rotation.x = Math.PI / 2;
    g.add(m);
  });
  const heart = new THREE.Mesh(geo('heart', () => new THREE.IcosahedronGeometry(0.18, 0)), glowMat(tint, 3));
  g.add(heart);
  return g;
}

function ducks(p, color, tint) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(geo('duckBody', () => new THREE.SphereGeometry(0.75, 18, 12)), softMat(color));
  body.scale.set(1, 0.75, 1.25);
  const head = new THREE.Mesh(geo('duckHead', () => new THREE.SphereGeometry(0.45, 16, 12)), softMat(color));
  head.position.set(0, 0.62, 0.55);
  const beak = new THREE.Mesh(geo('beak', () => new THREE.ConeGeometry(0.17, 0.42, 10).rotateX(Math.PI / 2)), plain(0xff8a1d));
  beak.position.set(0, 0.55, 1.05);
  beak.scale.set(1.4, 0.6, 1);
  const tail = new THREE.Mesh(geo('duckTail', () => new THREE.ConeGeometry(0.25, 0.5, 8).rotateX(-Math.PI / 3)), softMat(color));
  tail.position.set(0, 0.3, -0.95);
  const bow = new THREE.Mesh(geo('bow', () => new THREE.TorusGeometry(0.28, 0.07, 6, 14)), glowMat(tint, 1.8));
  bow.position.set(0, 0.25, 0.5);
  bow.rotation.x = Math.PI / 2.4;
  g.add(body, head, beak, tail, bow);
  eyes(g, { x: 0.2, y: 0.75, z: 0.88, r: 0.09 });
  g.userData.noSpin = true;
  g.userData.waddle = true;
  return g;
}

const BUILDERS = { neon, invaders, critters, ghosts, crystals, ducks };

export function buildSkin(key, p, color, tint) {
  return (BUILDERS[key] ?? neon)(p, color, tint);
}
