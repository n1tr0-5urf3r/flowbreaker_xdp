// Three.js scene: a neon board where packets roll from the NIC/XDP gate
// (far end) towards the host core (near end). The game logic lives in
// game.js and drives this module through a small API.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { LANES, isSyn, shortLabel, flowTint } from './lanes.js';
import { makeRing, outline } from './models.js';
import { buildSkin } from './skins.js';

export const LANE_W = 4.2;
export const GATE_Z = -84;
export const HOST_Z = 0;
export const CANNON_Z = 3;
export const BOARD_W = LANE_W * LANES.length;
export const laneX = (i) => (i - (LANES.length - 1) / 2) * LANE_W;

const hdr = (hex, k) => new THREE.Color(hex).multiplyScalar(k);

// ------------------------------------------------------------ shared assets

const GEO = {
  shield: new THREE.IcosahedronGeometry(1.45, 1),
  warn: new THREE.TorusGeometry(1.15, 0.05, 6, 40).rotateX(Math.PI / 2),
  syn: new THREE.ConeGeometry(0.18, 0.6, 4),
  shadow: new THREE.CircleGeometry(0.9, 24).rotateX(-Math.PI / 2),
};
const shieldMat = new THREE.MeshBasicMaterial({ color: hdr(0x7fe7ff, 1.0), wireframe: true, transparent: true, opacity: 0.22 });
const warnMat = new THREE.MeshBasicMaterial({ color: hdr(0xff3355, 3), transparent: true, opacity: 0.9 });
const synMat = new THREE.MeshBasicMaterial({ color: hdr(0xffe14d, 2.5) });
const shadowMat = new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false });
function textTexture(text, { color = '#ffffff', size = 64, weight = 800, spacing = 6 } = {}) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  const font = `${weight} ${size}px "JetBrains Mono", "Fira Code", Menlo, monospace`;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(text).width + spacing * text.length + size);
  c.width = w;
  c.height = Math.ceil(size * 1.5);
  ctx.font = font;
  ctx.letterSpacing = `${spacing}px`;
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.shadowColor = color;
  ctx.shadowBlur = size * 0.3;
  ctx.fillText(text, size / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { tex, aspect: c.width / c.height };
}

function textPlane(text, height, opts) {
  const { tex, aspect } = textTexture(text, opts);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, color: opts?.tint ?? 0xffffff });
  return new THREE.Mesh(new THREE.PlaneGeometry(height * aspect, height), mat);
}

function chevronTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(10, 40);
  ctx.lineTo(32, 70);
  ctx.lineTo(54, 40);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ------------------------------------------------------------------- world

export class World {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'labels';
    container.appendChild(this.labels.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x05060f);
    this.scene.fog = new THREE.FogExp2(0x070818, 0.0085);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.1, 600);
    this.scene.add(this.camera);
    this.camPos = new THREE.Vector3();
    this.camQuat = new THREE.Quaternion();
    this.shake = 0;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.75, 0.4, 0.55);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.scene.add(new THREE.HemisphereLight(0x6080ff, 0x200020, 1.1));
    const key = new THREE.DirectionalLight(0xbfd6ff, 0.8);
    key.position.set(10, 30, 20);
    this.scene.add(key);

    this.uniforms = { uTime: { value: 0 } };
    this.buildFloor();
    this.buildLanes();
    this.buildGate();
    this.buildHost();
    this.buildSky();
    this.buildCannon();
    this.buildViewModel();
    this.buildPreview();
    this.particles = new Particles(this.scene);
    this.floats = [];
    this.rings = [];
    this.flashGeo = new THREE.SphereGeometry(1, 16, 10);
    this.flashLights = Array.from({ length: 4 }, () => {
      const l = new THREE.PointLight(0xffffff, 0, 30, 1.6);
      this.scene.add(l);
      return l;
    });
    this.flashIdx = 0;
    this.chaseCam = null;

    this.raycaster = new THREE.Raycaster();
    this.floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    this.overview();
    this.camera.position.copy(this.camPos);
    this.camera.quaternion.copy(this.camQuat);

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
  }

  // ------------------------------------------------------------- builders

  buildFloor() {
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms, uColor: { value: new THREE.Color(0x2a5cff) } },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        uniform float uTime;
        varying vec3 vWorld;
        float grid(vec2 p, float w) {
          vec2 d = abs(fract(p - 0.5) - 0.5) / fwidth(p);
          return 1.0 - min(min(d.x, d.y) / w, 1.0);
        }
        void main() {
          float fine = grid(vWorld.xz / 2.1, 1.0);
          float coarse = grid(vWorld.xz / 10.5, 1.4);
          float dist = length(vWorld.xz - vec2(0.0, -40.0));
          float fade = exp(-dist * 0.018);
          float pulse = 0.5 + 0.5 * sin(vWorld.z * 0.15 + uTime * 2.0);
          vec3 col = uColor * (fine * 0.18 + coarse * (0.45 + 0.25 * pulse)) * fade;
          gl_FragColor = vec4(col + vec3(0.006, 0.007, 0.02), 1.0);
        }`,
      fog: false,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), mat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -0.01, -60);
    this.scene.add(floor);
  }

  buildLanes() {
    const L = HOST_Z - GATE_Z;
    const chev = chevronTexture();
    this.laneStrips = [];
    this.laneLabels = [];
    LANES.forEach((lane, i) => {
      const tex = chev.clone();
      tex.needsUpdate = true;
      tex.repeat.set(1, L / 5);
      const strip = new THREE.Mesh(
        new THREE.PlaneGeometry(LANE_W - 0.5, L),
        new THREE.MeshBasicMaterial({ map: tex, color: lane.color, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false }),
      );
      strip.rotation.x = -Math.PI / 2;
      strip.position.set(laneX(i), 0.01, GATE_Z + L / 2);
      this.scene.add(strip);
      this.laneStrips.push(strip);

      const label = textPlane(lane.name, 1.3, { color: '#' + lane.color.toString(16).padStart(6, '0'), size: 56 });
      label.rotation.x = -Math.PI / 2;
      label.position.set(laneX(i), 0.03, HOST_Z - 3.5);
      const maxW = LANE_W - 0.6;
      const w = label.geometry.parameters.width;
      if (w > maxW) label.scale.setScalar(maxW / w);
      this.scene.add(label);
      this.laneLabels.push(label);
    });
    // Lane borders
    for (let i = 0; i <= LANES.length; i++) {
      const x = laneX(0) - LANE_W / 2 + i * LANE_W;
      const col = i === 0 || i === LANES.length ? 0x5fe0ff : 0x2a3a7a;
      const k = i === 0 || i === LANES.length ? 1.6 : 0.7;
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, L), new THREE.MeshBasicMaterial({ color: hdr(col, k) }));
      b.position.set(x, 0.03, GATE_Z + L / 2);
      this.scene.add(b);
    }
    // Firewall line at the host end: the point of no return.
    const fw = new THREE.Mesh(new THREE.BoxGeometry(BOARD_W + 1, 0.12, 0.12), new THREE.MeshBasicMaterial({ color: hdr(0x5fe0ff, 2.2) }));
    fw.position.set(0, 0.06, HOST_Z);
    this.scene.add(fw);
    this.firewallLine = fw;
  }

  buildGate() {
    const g = new THREE.Group();
    const red = new THREE.MeshBasicMaterial({ color: hdr(0xff3355, 2.2) });
    const W = BOARD_W + 2;
    const H = 9;
    for (const sx of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.5, H, 0.5), red);
      post.position.set((sx * W) / 2, H / 2, 0);
      g.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(W + 0.5, 0.5, 0.5), red);
    beam.position.set(0, H, 0);
    g.add(beam);
    const curtain = new THREE.Mesh(
      new THREE.PlaneGeometry(W, H),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: /* glsl */ `
          uniform float uTime; varying vec2 vUv;
          void main() {
            float scan = 0.5 + 0.5 * sin(vUv.y * 120.0 - uTime * 6.0);
            float bars = smoothstep(0.92, 1.0, abs(sin(vUv.x * 60.0)));
            float edge = smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.7, 1.0, vUv.y));
            float a = (0.05 + 0.08 * scan + 0.12 * bars) * edge;
            gl_FragColor = vec4(vec3(1.0, 0.2, 0.33) * 1.6, a);
          }`,
      }),
    );
    curtain.position.y = H / 2;
    g.add(curtain);
    const label = textPlane('NIC · XDP', 2.4, { color: '#ff5468', size: 96 });
    label.position.set(0, H + 2, 0);
    g.add(label);
    const glow = new THREE.PointLight(0xff3355, 40, 40, 1.6);
    glow.position.set(0, 4, 3);
    g.add(glow);
    g.position.z = GATE_Z;
    this.scene.add(g);
    this.gate = g;
  }

  buildHost() {
    const g = new THREE.Group();
    this.coreMat = new THREE.MeshBasicMaterial({ color: hdr(0x5fe0ff, 3) });
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(1.2, 2), this.coreMat);
    this.coreWire = new THREE.Mesh(new THREE.IcosahedronGeometry(2.1, 1), new THREE.MeshBasicMaterial({ color: hdr(0x5fe0ff, 1.5), wireframe: true, transparent: true, opacity: 0.6 }));
    this.coreRing = new THREE.Mesh(new THREE.TorusGeometry(3, 0.06, 8, 64), new THREE.MeshBasicMaterial({ color: hdr(0x5fe0ff, 2.5) }));
    this.coreRing.rotation.x = Math.PI / 2;
    g.add(core, this.coreWire, this.coreRing);
    this.coreLight = new THREE.PointLight(0x5fe0ff, 15, 30, 1.5);
    g.add(this.coreLight);
    const label = textPlane('HOST', 0.8, { color: '#dfe8ff', size: 56 });
    label.position.y = -2.6;
    g.add(label);
    g.position.set(BOARD_W / 2 + 5, 3.2, HOST_Z - 7);
    this.scene.add(g);
    this.host = g;
  }

  buildSky() {
    // Synthwave sun behind the gate.
    const sun = new THREE.Mesh(
      new THREE.CircleGeometry(46, 64),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        fog: false,
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: /* glsl */ `
          uniform float uTime; varying vec2 vUv;
          void main() {
            vec3 top = vec3(1.0, 0.75, 0.25), bot = vec3(1.0, 0.1, 0.55);
            vec3 col = mix(bot, top, vUv.y);
            float stripe = step(0.5, fract(vUv.y * 14.0 + uTime * 0.15)) + step(0.55, vUv.y);
            float a = clamp(stripe, 0.0, 1.0) * 0.42;
            gl_FragColor = vec4(col * 0.9, a);
          }`,
      }),
    );
    sun.position.set(0, 8, -200);
    this.scene.add(sun);

    const n = 900;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 500;
      pos[i * 3 + 1] = 10 + Math.random() * 120;
      pos[i * 3 + 2] = -100 - Math.random() * 200;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.scene.add(new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x8899ff, size: 0.8, sizeAttenuation: true, fog: false, transparent: true, opacity: 0.7 })));
  }

  buildCannon() {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2.4, 6).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x0c1830, emissive: 0x5fe0ff, emissiveIntensity: 0.6, metalness: 0.8, roughness: 0.3, flatShading: true }));
    const fins = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.12, 0.8), new THREE.MeshBasicMaterial({ color: hdr(0x5fe0ff, 2.5) }));
    fins.position.z = 0.5;
    const glow = new THREE.Mesh(new THREE.CircleGeometry(1.1, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: hdr(0x5fe0ff, 2), transparent: true, opacity: 0.35, depthWrite: false, blending: THREE.AdditiveBlending }));
    glow.position.y = -0.9;
    g.add(body, fins, glow);
    g.position.set(0, 1, CANNON_Z);
    this.scene.add(g);
    this.cannon = g;
  }

  // First-person gun that hangs below the camera in cockpit mode.
  buildViewModel() {
    const g = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0x46557a, metalness: 0.5, roughness: 0.35, emissive: 0x0a1020, flatShading: true });
    const accent = new THREE.MeshBasicMaterial({ color: hdr(0xffb347, 0.9) });
    for (const sx of [-1, 1]) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.09, 1.4, 8).rotateX(Math.PI / 2), metal);
      barrel.position.set(sx * 0.42, -0.5, -1.2);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 1.0), accent);
      stripe.position.set(sx * 0.42, -0.42, -1.15);
      g.add(barrel, stripe);
    }
    const housing = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.22, 0.6), metal);
    housing.position.set(0, -0.62, -0.55);
    g.add(housing);
    this.muzzle = new THREE.PointLight(0xffb347, 0, 8, 2);
    this.muzzle.position.set(0, -0.3, -2);
    g.add(this.muzzle);
    g.visible = false;
    this.camera.add(g);
    this.viewModel = g;
  }

  buildPreview() {
    const g = new THREE.Group();
    this.previewRing = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.25, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: hdr(0x9fe870, 2), transparent: true, opacity: 0.9, depthWrite: false }));
    this.previewRange = new THREE.Mesh(new THREE.PlaneGeometry(LANE_W - 0.6, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x9fe870, transparent: true, opacity: 0.08, depthWrite: false, blending: THREE.AdditiveBlending }));
    g.add(this.previewRing, this.previewRange);
    g.visible = false;
    this.scene.add(g);
    this.preview = g;
  }

  // ------------------------------------------------------------- entities

  makePacket(p, lane, suspicious, scale, skin, color) {
    const g = new THREE.Group();
    this.reskin(g, p, skin, color, scale);
    const shadow = new THREE.Mesh(GEO.shadow, shadowMat);
    shadow.scale.setScalar(scale);
    g.add(shadow);
    g.shadow = shadow;

    if (p.prot) {
      const s = new THREE.Mesh(GEO.shield, shieldMat);
      s.scale.setScalar(scale);
      g.add(s);
      g.shield = s;
    }
    if (suspicious) {
      const w = new THREE.Mesh(GEO.warn, warnMat);
      w.scale.setScalar(scale);
      g.add(w);
      g.warn = w;
    }
    if (isSyn(p)) {
      const s = new THREE.Mesh(GEO.syn, synMat);
      s.position.y = 1.0 * scale + 0.3;
      s.rotation.x = Math.PI;
      g.add(s);
    }

    const div = document.createElement('div');
    div.className = 'pkt-label';
    div.innerHTML = `<span></span><b></b>`;
    div.firstChild.textContent = shortLabel(p);
    const label = new CSS2DObject(div);
    label.position.y = 1.25 * scale + 0.7;
    label.center.set(0.5, 1);
    g.add(label);
    g.label = label;
    g.badge = div.lastChild;

    this.scene.add(g);
    return g;
  }

  // (Re)build the packet body with a skin; the rest of the group stays.
  reskin(g, p, skin, color, scale) {
    if (g.spin) g.remove(g.spin);
    const spin = buildSkin(skin, p, color, flowTint(p.id));
    spin.scale.setScalar(scale);
    g.add(spin);
    g.spin = spin;
  }

  removeObject(obj) {
    obj.traverse((o) => { if (o.isCSS2DObject) o.element.remove(); });
    this.scene.remove(obj);
  }

  makeTurret() {
    const g = new THREE.Group();
    const metal = new THREE.MeshStandardMaterial({ color: 0x6a80b8, metalness: 0.3, roughness: 0.45, flatShading: true, emissive: 0x1a2a50 });
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.15, 0.5, 8), metal);
    base.position.y = 0.25;
    const rimMat = new THREE.MeshBasicMaterial({ color: hdr(0x9fe870, 2.5) });
    const rim = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.06, 6, 32).rotateX(Math.PI / 2), rimMat);
    rim.position.y = 0.5;
    const head = new THREE.Group();
    head.position.y = 1.0;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.55, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), metal);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 1.5, 8).rotateX(Math.PI / 2), metal);
    barrel.position.set(0, 0.2, -0.85);
    const tip = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.03, 6, 12), rimMat);
    tip.position.set(0, 0.2, -1.6);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), rimMat);
    eye.position.set(0, 0.25, -0.45);
    head.add(dome, barrel, tip, eye);
    const pad = new THREE.Mesh(new THREE.CircleGeometry(1.6, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: hdr(0x9fe870, 1.2), transparent: true, opacity: 0.18, depthWrite: false, blending: THREE.AdditiveBlending }));
    pad.position.y = 0.03;
    g.add(base, rim, head, pad);
    outline(g, 0x9fe870, 1.2);
    g.head = head;
    g.rimMat = rimMat;
    this.scene.add(g);
    return g;
  }

  setTurretState(obj, { ammoFrac, manned, selected }) {
    const c = manned ? 0xffb347 : ammoFrac > 0 ? 0x9fe870 : 0x3a4255;
    obj.rimMat.color.copy(hdr(c, manned || ammoFrac > 0 ? 2.5 + (selected ? 2 : 0) : 1));
  }

  showPreview(x, z, ok, range) {
    if (x === null) {
      this.preview.visible = false;
      return;
    }
    this.preview.visible = true;
    this.preview.position.set(x, 0.05, z);
    const col = ok ? 0x9fe870 : 0xff5468;
    this.previewRing.material.color.copy(hdr(col, 2));
    this.previewRange.material.color.set(col);
    this.previewRange.scale.z = range;
    this.previewRange.position.z = -range / 2;
  }

  // Shockwave ring + flash light + debris.
  explosion(pos, radius, color) {
    const ring = makeRing(color);
    ring.position.copy(pos).setY(Math.max(0.1, pos.y * 0.3));
    this.scene.add(ring);
    this.rings.push({ obj: ring, life: 0.45, max: 0.45, radius });
    const flash = new THREE.Mesh(this.flashGeo, new THREE.MeshBasicMaterial({ color: hdr(color, 4), transparent: true, opacity: 0.9, depthWrite: false, blending: THREE.AdditiveBlending }));
    flash.position.copy(pos);
    this.scene.add(flash);
    this.rings.push({ obj: flash, life: 0.22, max: 0.22, radius: radius * 0.7, sphere: true });
    const light = this.flashLights[this.flashIdx++ % this.flashLights.length];
    light.position.copy(pos).setY(pos.y + 1.5);
    light.color.set(color);
    light.intensity = 40 + radius * 15;
    this.particles.burst(pos, color, 30 + radius * 14, 4 + radius * 2.2, 0.8);
    this.particles.burst(pos, 0xffffff, 10, 3 + radius, 0.3);
  }

  // Slow expanding ring, used for the boss EMP.
  pulse(pos, radius, color) {
    const ring = makeRing(color);
    ring.position.copy(pos).setY(0.3);
    this.scene.add(ring);
    this.rings.push({ obj: ring, life: 0.9, max: 0.9, radius });
  }

  addFloat(pos, text, color) {
    const div = document.createElement('div');
    div.className = 'float-text';
    div.textContent = text;
    div.style.color = '#' + color.toString(16).padStart(6, '0');
    const o = new CSS2DObject(div);
    o.position.copy(pos);
    this.scene.add(o);
    this.floats.push({ o, life: 1.2 });
    // Busy moments would stack dozens of floats; keep the newest few.
    while (this.floats.length > 8) this.removeObject(this.floats.shift().o);
  }

  // ------------------------------------------------------------- camera

  // Third-person camera behind a vehicle; call every frame while driving.
  chase(pos, yaw, { back: dist = 14, up = 9, ahead = 14, lookDown = 0 } = {}) {
    const back = new THREE.Vector3(Math.sin(yaw), 0, Math.cos(yaw));
    const camPos = pos.clone().addScaledVector(back, dist).setY(pos.y + up);
    const look = pos.clone().addScaledVector(back, -ahead).setY(Math.max(0, pos.y - lookDown));
    this.chaseCam = { pos: camPos, quat: new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(camPos, look, new THREE.Vector3(0, 1, 0))) };
  }

  overview() {
    this.chaseCam = null;
    const aspect = this.camera.aspect || 16 / 9;
    const k = Math.max(1, 1.75 / aspect);
    this.camPos.set(0, 22 * k, 27 * k);
    const m = new THREE.Matrix4().lookAt(this.camPos, new THREE.Vector3(0, 0, -31), new THREE.Vector3(0, 1, 0));
    this.camQuat.setFromRotationMatrix(m);
    this.viewModel.visible = false;
    this.cockpit = null;
  }

  enterCockpit(pos) {
    this.chaseCam = null;
    this.cockpit = { pos: pos.clone().add(new THREE.Vector3(0, 1.9, 0.6)), yaw: 0, pitch: -0.04 };
    this.viewModel.visible = true;
  }

  aim(yaw, pitch) {
    if (!this.cockpit) return;
    this.cockpit.yaw = yaw;
    this.cockpit.pitch = pitch;
  }

  // World-space ray through a point given in normalised device coordinates.
  ray(ndc) {
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray;
  }

  pickFloor(ndc) {
    const out = new THREE.Vector3();
    return this.ray(ndc).intersectPlane(this.floorPlane, out) ? out : null;
  }

  muzzleFlash() {
    this.muzzle.intensity = 25;
    this.viewModel.position.z = 0.12;
  }

  // ------------------------------------------------------------- frame

  resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.labels.setSize(w, h);
    if (!this.cockpit) this.overview();
  }

  render(dt, t, state) {
    this.uniforms.uTime.value = t;
    for (const s of this.laneStrips) s.material.map.offset.y = -t * 0.6;

    // Host core reflects integrity.
    const col = state.integrity > 50 ? 0x5fe0ff : state.integrity > 25 ? 0xf5c542 : 0xff3355;
    this.coreMat.color.copy(hdr(col, 1.1 + state.hostFlash * 5));
    this.coreWire.material.color.copy(hdr(col, 0.9));
    this.coreRing.material.color.copy(hdr(col, 1.4));
    this.coreLight.color.set(col);
    this.coreWire.rotation.y = t * 0.4;
    this.coreWire.rotation.x = t * 0.25;
    this.coreRing.rotation.z = t * 0.8;
    this.host.position.y = 3.2 + Math.sin(t * 1.5) * 0.25;
    this.host.rotation.y = t * 0.2;
    this.firewallLine.material.color.copy(hdr(col, 1.8 + state.hostFlash * 6));
    warnMat.opacity = 0.45 + 0.45 * Math.sin(t * 9);

    // Cannon
    this.cannon.position.x += (state.cannonX - this.cannon.position.x) * Math.min(1, dt * 14);
    this.cannon.position.y = 1 + Math.sin(t * 3) * 0.12;
    this.cannon.visible = !this.cockpit && !this.chaseCam;

    // Shockwaves and flashes
    this.rings = this.rings.filter((r) => {
      r.life -= dt;
      const f = 1 - r.life / r.max;
      r.obj.scale.setScalar(Math.max(0.01, r.radius * (r.sphere ? 0.4 + f * 0.6 : 0.15 + f * 0.85)));
      r.obj.material.opacity = Math.max(0, 1 - f) * (r.sphere ? 0.9 : 1);
      if (r.life <= 0) {
        this.scene.remove(r.obj);
        r.obj.material.dispose();
        return false;
      }
      return true;
    });
    for (const l of this.flashLights) l.intensity *= Math.exp(-dt * 12);

    // Floating texts
    this.floats = this.floats.filter((f) => {
      f.life -= dt;
      f.o.position.y += dt * 2.2;
      f.o.element.style.opacity = Math.min(1, f.life * 1.6);
      if (f.life <= 0) {
        this.removeObject(f.o);
        return false;
      }
      return true;
    });

    this.particles.update(dt);

    // Camera
    let tp = this.camPos;
    let tq = this.camQuat;
    if (this.chaseCam) {
      tp = this.chaseCam.pos;
      tq = this.chaseCam.quat;
    } else if (this.cockpit) {
      tp = this.cockpit.pos;
      tq = new THREE.Quaternion().setFromEuler(new THREE.Euler(this.cockpit.pitch, this.cockpit.yaw, 0, 'YXZ'));
    }
    // Vehicles move fast; a stiffer follow keeps them on screen.
    const k = 1 - Math.exp(-dt * (this.chaseCam ? 14 : 7));
    this.camera.position.lerp(tp, k);
    this.camera.quaternion.slerp(tq, k);
    if (this.shake > 0) {
      this.shake -= dt;
      this.camera.position.x += (Math.random() - 0.5) * 0.6;
      this.camera.position.y += (Math.random() - 0.5) * 0.6;
    }
    this.muzzle.intensity *= Math.exp(-dt * 20);
    this.viewModel.position.z *= Math.exp(-dt * 14);

    this.composer.render(dt);
    this.labels.render(this.scene, this.camera);
  }

  burst(pos, color, n, speed, life) { this.particles.burst(pos, color, n, speed, life); }
  bounce(x, color, n) { this.particles.bounce(new THREE.Vector3(x, 1, GATE_Z + 0.5), color, n); }
}

// ------------------------------------------------------------- particles

class Particles {
  constructor(scene, max = 3000) {
    this.max = max;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.list = [];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = geo;
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute float size; attribute vec3 color; varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (300.0 / -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vColor * 3.0 * a, a);
        }`,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  add(p) {
    if (this.list.length < this.max) this.list.push(p);
  }

  burst(pos, color, n = 30, speed = 8, life = 0.8) {
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) {
      const v = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5).normalize().multiplyScalar(speed * (0.3 + Math.random()));
      this.add({ x: pos.x, y: pos.y, z: pos.z, vx: v.x, vy: v.y, vz: v.z, life, max: life, r: c.r, g: c.g, b: c.b, s: 0.3 + Math.random() * 0.5, grav: 6 });
    }
  }

  // Sparks bouncing off the gate back towards the internet.
  bounce(pos, color, n = 5) {
    const c = new THREE.Color(color);
    for (let i = 0; i < n; i++) {
      this.add({ x: pos.x + (Math.random() - 0.5) * 2, y: pos.y + Math.random(), z: pos.z, vx: (Math.random() - 0.5) * 6, vy: 2 + Math.random() * 5, vz: -4 - Math.random() * 8, life: 0.7, max: 0.7, r: c.r, g: c.g, b: c.b, s: 0.25 + Math.random() * 0.3, grav: 9 });
    }
  }

  update(dt) {
    let w = 0;
    for (const p of this.list) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.vy -= p.grav * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < 0.05) { p.y = 0.05; p.vy *= -0.4; }
      const f = p.life / p.max;
      this.pos[w * 3] = p.x;
      this.pos[w * 3 + 1] = p.y;
      this.pos[w * 3 + 2] = p.z;
      this.col[w * 3] = p.r * f;
      this.col[w * 3 + 1] = p.g * f;
      this.col[w * 3 + 2] = p.b * f;
      this.size[w] = p.s * (0.4 + f);
      this.list[w++] = p;
    }
    this.list.length = w;
    this.geo.setDrawRange(0, w);
    for (const a of ['position', 'color', 'size']) this.geo.attributes[a].needsUpdate = true;
  }
}
