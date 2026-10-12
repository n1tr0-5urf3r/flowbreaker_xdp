// Low-poly neon models for vehicles, projectiles, power-ups and bosses.
// Everything is built from primitives; emissive colours above 1.0 feed the
// bloom pass.

import * as THREE from 'three';

export const hdr = (hex, k) => new THREE.Color(hex).multiplyScalar(k);

const metal = (color = 0x56689a, emissive = 0x16213d) => new THREE.MeshStandardMaterial({ color, metalness: 0.35, roughness: 0.45, flatShading: true, emissive });

// Neon edge lines on every mesh in a model, so dark hulls read against the
// dark board.
export function outline(group, color, k = 1.8) {
  const mat = new THREE.LineBasicMaterial({ color: hdr(color, k), transparent: true, opacity: 0.85 });
  const meshes = [];
  group.traverse((o) => { if (o.isMesh && !o.material.transparent) meshes.push(o); });
  for (const m of meshes) m.add(new THREE.LineSegments(new THREE.EdgesGeometry(m.geometry, 25), mat));
  return group;
}
const glow = (hex, k = 2) => new THREE.MeshBasicMaterial({ color: hdr(hex, k) });
const box = (w, h, d, mat) => new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);

// ------------------------------------------------------------------ tank

export function makeTank() {
  const g = new THREE.Group();
  const hullMat = metal(0x4a64a0, 0x14244a);
  const accent = glow(0x5fe0ff, 2.2);
  const hull = box(2.6, 0.8, 3.6, hullMat);
  hull.position.y = 0.8;
  const nose = new THREE.Mesh(new THREE.CylinderGeometry(0, 1.3, 0.8, 4, 1).rotateY(Math.PI / 4).rotateX(-Math.PI / 2), hullMat);
  nose.scale.set(1, 1, 0.5);
  nose.position.set(0, 0.8, -2.0);
  g.add(hull, nose);
  for (const sx of [-1, 1]) {
    const track = box(0.7, 0.75, 4.0, metal(0x141c30));
    track.position.set(sx * 1.55, 0.45, 0);
    const stripe = box(0.06, 0.08, 3.9, accent);
    stripe.position.set(sx * 1.92, 0.55, 0);
    g.add(track, stripe);
  }
  const turret = new THREE.Group();
  turret.position.y = 1.35;
  const dome = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 1.05, 0.55, 8), metal(0x3a5080));
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 2.6, 8).rotateX(Math.PI / 2), metal(0x46557a));
  barrel.position.set(0, 0.1, -1.6);
  const muzzle = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.05, 6, 12), accent);
  muzzle.position.set(0, 0.1, -2.9);
  const hatch = new THREE.Mesh(new THREE.CircleGeometry(0.35, 12).rotateX(-Math.PI / 2), accent);
  hatch.position.y = 0.29;
  turret.add(dome, barrel, muzzle, hatch);
  g.add(turret);
  const under = new THREE.Mesh(new THREE.CircleGeometry(2.4, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: hdr(0x5fe0ff, 1.5), transparent: true, opacity: 0.25, depthWrite: false, blending: THREE.AdditiveBlending }));
  under.position.y = 0.04;
  g.add(under);
  g.turret = turret;
  g.accent = accent;
  return outline(g, 0x5fe0ff, 1.4);
}

// ------------------------------------------------------------ helicopter

export function makeHeli() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.8, 1.8, 4, 10).rotateX(Math.PI / 2), metal(0x5a6ea8, 0x1a2648));
  const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.72, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x0a1830, emissive: 0x2a6aff, emissiveIntensity: 0.8, metalness: 0.9, roughness: 0.1 }));
  canopy.position.set(0, 0.15, -1.2);
  const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.3, 3.2, 6).rotateX(Math.PI / 2), metal(0x30406a));
  boom.position.set(0, 0.2, 2.6);
  const fin = box(0.08, 0.9, 0.6, metal(0x30406a));
  fin.position.set(0, 0.6, 4.0);
  const rotor = new THREE.Group();
  rotor.position.y = 1.05;
  const bladeMat = new THREE.MeshBasicMaterial({ color: 0x9fb4ff, transparent: true, opacity: 0.55 });
  for (let i = 0; i < 2; i++) {
    const b = box(7.5, 0.05, 0.28, bladeMat);
    b.rotation.y = (i * Math.PI) / 2;
    rotor.add(b);
  }
  const disc = new THREE.Mesh(new THREE.CircleGeometry(3.7, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x9fb4ff, transparent: true, opacity: 0.08, depthWrite: false }));
  rotor.add(disc);
  const tailRotor = new THREE.Group();
  tailRotor.position.set(0.2, 0.7, 4.05);
  tailRotor.add(box(0.04, 1.2, 0.12, bladeMat));
  const skidMat = metal(0x141c30);
  for (const sx of [-1, 1]) {
    const skid = box(0.08, 0.08, 2.6, skidMat);
    skid.position.set(sx * 0.75, -0.95, -0.2);
    g.add(skid);
  }
  const pods = glow(0xffb347, 1.6);
  for (const sx of [-1, 1]) {
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.0, 8).rotateX(Math.PI / 2), pods);
    pod.position.set(sx * 1.0, -0.3, -0.4);
    g.add(pod);
  }
  const navR = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 4), glow(0xff3355, 4));
  navR.position.set(-0.85, 0, -0.5);
  const navG = new THREE.Mesh(new THREE.SphereGeometry(0.08, 6, 4), glow(0x5fd068, 4));
  navG.position.set(0.85, 0, -0.5);
  g.add(body, canopy, boom, fin, rotor, tailRotor, navR, navG);
  g.rotor = rotor;
  g.tailRotor = tailRotor;
  g.navs = [navR, navG];
  // Belly light so the gunship reads from above.
  const belly = new THREE.PointLight(0xffb347, 12, 14, 1.5);
  belly.position.y = -1.5;
  g.add(belly);
  return outline(g, 0xffb347, 1.6);
}

// ------------------------------------------------------------------- jet

export function makeJet() {
  const g = new THREE.Group();
  const mat = metal(0x6a7cb0, 0x1c2850);
  const body = new THREE.Mesh(new THREE.ConeGeometry(0.7, 6, 6).rotateX(-Math.PI / 2), mat);
  const wing = new THREE.Mesh(new THREE.BufferGeometry(), mat);
  wing.geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0, 0, -1.5, -4.2, 0, 1.6, 4.2, 0, 1.6,
    0, 0, -1.5, 4.2, 0, 1.6, -4.2, 0, 1.6,
  ], 3));
  wing.geometry.computeVertexNormals();
  const tail = box(0.08, 1.3, 1.1, mat);
  tail.position.set(0, 0.6, 2.4);
  const engine = new THREE.Mesh(new THREE.CircleGeometry(0.45, 12), glow(0xff8a3d, 5));
  engine.position.set(0, 0, 3.01);
  const stripes = glow(0xff3355, 2.5);
  for (const sx of [-1, 1]) {
    const s = box(2.6, 0.03, 0.12, stripes);
    s.position.set(sx * 2.1, 0.02, 1.1);
    s.rotation.y = sx * -0.55;
    g.add(s);
  }
  g.add(body, wing, tail, engine);
  return outline(g, 0xff8a3d, 1.6);
}

// ------------------------------------------------------------ projectiles

export function makeRocket() {
  // Modelled nose-to--Z, then flipped: Object3D.lookAt() points +Z at the target.
  const outer = new THREE.Group();
  const g = new THREE.Group();
  g.rotation.y = Math.PI;
  outer.add(g);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.9, 6).rotateX(Math.PI / 2), metal(0xb0b8d0, 0x202020));
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.3, 6).rotateX(-Math.PI / 2), glow(0xff3355, 2));
  tip.position.z = -0.6;
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.7, 6).rotateX(Math.PI / 2), glow(0xffb347, 5));
  flame.position.z = 0.8;
  g.add(body, tip, flame);
  outer.flame = flame;
  return outer;
}

export function makeGrenade(kind) {
  const col = kind === 'cluster' ? 0xe86bd0 : kind === 'bomblet' ? 0xff8a3d : kind === 'bomb' ? 0xff3355 : 0x9fe870;
  const r = kind === 'bomblet' ? 0.18 : kind === 'bomb' ? 0.45 : 0.32;
  const g = new THREE.Group();
  const shell = new THREE.Mesh(kind === 'bomb' ? new THREE.CapsuleGeometry(r, r * 2.5, 3, 8) : new THREE.IcosahedronGeometry(r, 0), metal(0x2a3550));
  const band = new THREE.Mesh(new THREE.TorusGeometry(r * 1.02, r * 0.18, 6, 12), glow(col, 3));
  band.rotation.x = Math.PI / 2;
  g.add(shell, band);
  return g;
}

export function makeBolt(color, k = 5) {
  return new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 2.4, 6).rotateX(Math.PI / 2), glow(color, k));
}

// A stretchable laser beam along local +Z with length 1 (lookAt points +Z).
export function makeBeam(color) {
  const g = new THREE.Group();
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1, 8, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5), glow(0xffffff, 3.2));
  const halo = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1, 12, 1, true).rotateX(Math.PI / 2).translate(0, 0, 0.5), new THREE.MeshBasicMaterial({ color: hdr(color, 1.6), transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending }));
  g.add(core, halo);
  g.halo = halo;
  g.core = core;
  return g;
}

// --------------------------------------------------------------- powerups

const iconCache = new Map();
function iconTexture(glyph, color) {
  const key = glyph + color;
  if (iconCache.has(key)) return iconCache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 18;
  ctx.font = '800 76px "JetBrains Mono", Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(glyph, 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  iconCache.set(key, tex);
  return tex;
}

export function makePowerup(def) {
  const g = new THREE.Group();
  const cage = new THREE.Mesh(new THREE.OctahedronGeometry(1.0), new THREE.MeshBasicMaterial({ color: hdr(def.color, 1.8), wireframe: true }));
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.55), new THREE.MeshBasicMaterial({ color: hdr(def.color, 1.2), transparent: true, opacity: 0.6 }));
  const icon = new THREE.Sprite(new THREE.SpriteMaterial({ map: iconTexture(def.glyph, '#' + def.color.toString(16).padStart(6, '0')), depthWrite: false }));
  icon.scale.setScalar(1.3);
  icon.position.y = 1.7;
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.4, 6, 8, 1, true), new THREE.MeshBasicMaterial({ color: hdr(def.color, 1.2), transparent: true, opacity: 0.15, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
  pillar.position.y = 3;
  g.add(cage, core, icon, pillar);
  g.cage = cage;
  return g;
}

// ------------------------------------------------------------------ boss

// Wraps a packet object in armour: orbiting plates and a menacing ring.
export function decorateBoss(obj, color) {
  const armor = new THREE.Group();
  const plateMat = metal(0x4a1828, 0x300810);
  const edge = glow(0xff3355, 3);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const p = box(0.9, 1.4, 0.18, plateMat);
    p.position.set(Math.cos(a) * 1.9, 0, Math.sin(a) * 1.9);
    p.lookAt(0, 0, 0);
    const e = box(0.92, 0.06, 0.2, edge);
    e.position.copy(p.position).setY(0.72);
    e.lookAt(0, 0.72, 0);
    armor.add(p, e);
  }
  const crown = new THREE.Mesh(new THREE.TorusGeometry(2.6, 0.08, 6, 48).rotateX(Math.PI / 2), glow(color, 3));
  crown.position.y = 1.1;
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.35, 12, 8), glow(0xff3355, 6));
  eye.position.set(0, 0.2, 1.2);
  obj.add(armor, crown, eye);
  obj.armor = armor;
  obj.crown = crown;
  return obj;
}

// ------------------------------------------------------- strike/emp marks

export function makeStrikeMarker(width, length) {
  return new THREE.Mesh(
    new THREE.PlaneGeometry(width, length).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: hdr(0xff3355, 1.5), transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending }),
  );
}

export function makeRing(color) {
  return new THREE.Mesh(
    new THREE.RingGeometry(0.85, 1, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: hdr(color, 3), transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }),
  );
}
