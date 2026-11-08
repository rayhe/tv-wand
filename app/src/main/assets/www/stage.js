// stage.js — the scene: a moonlit stone circle, the avatars standing in an
// arc that re-frames itself as wands join and leave, and particle spells.

import * as THREE from 'three';
import { glowMap, hashString } from './avatar.js';

const SPACING = 1.75; // metres between avatars
const CAMERA_FOV = 36;

// ---------- Particles: one shared additive point cloud ----------

const PARTICLE_VS = `
attribute float aSize;
attribute vec4 aColor;
uniform float uProj;
varying vec4 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uProj / max(0.1, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FS = `
varying vec4 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.0, d);
  gl_FragColor = vec4(vColor.rgb, a * a * vColor.a);
}`;

class Particles {
  constructor(scene, capacity = 6000) {
    this.cap = capacity;
    this.next = 0;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 4);
    this.size = new Float32Array(capacity);
    this.base = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('aColor', this.colAttr);
    geo.setAttribute('aSize', this.sizeAttr);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uProj: { value: 800 } },
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.live = 0;
  }

  /** color: an sRGB THREE.Color (the shader writes it straight out). */
  emit(p, v, color, size, life, gravity = 0, drag = 0.5) {
    const i = this.next;
    this.next = (i + 1) % this.cap;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.col.set([color.r, color.g, color.b, 1], i * 4);
    this.base[i] = size;
    this.size[i] = size;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.gravity[i] = gravity;
    this.drag[i] = drag;
  }

  update(dt) {
    let live = 0;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        this.col[i * 4 + 3] = 0;
        this.size[i] = 0;
        continue;
      }
      live++;
      const k = Math.pow(this.drag[i], dt);
      const o = i * 3;
      this.vel[o] *= k;
      this.vel[o + 1] = this.vel[o + 1] * k + this.gravity[i] * dt;
      this.vel[o + 2] *= k;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      const f = this.life[i] / this.maxLife[i];
      this.col[i * 4 + 3] = Math.min(1, f * 2);
      this.size[i] = this.base[i] * (0.35 + 0.65 * f);
    }
    if (live || this.live) {
      this.posAttr.needsUpdate = true;
      this.colAttr.needsUpdate = true;
      this.sizeAttr.needsUpdate = true;
    }
    this.live = live;
  }
}

// ---------- Spell looks ----------

const SPELL_FX = {
  lumos: { color: '#fff4c8', kind: 'light' },
  nox: { color: '#7a4bb0', kind: 'nox' },
  incendio: { color: '#ff6a1a', kind: 'fire' },
  aguamenti: { color: '#3aa0ff', kind: 'water' },
  expelliarmus: { color: '#ff3030', kind: 'beam' },
  stupefy: { color: '#ff4040', kind: 'beam' },
  protego: { color: '#8fd8ff', kind: 'shield' },
  'expecto patronum': { color: '#d8ecff', kind: 'patronus' },
  'wingardium leviosa': { color: '#fff59a', kind: 'float' },
  ascendio: { color: '#aaccff', kind: 'float' },
  colovaria: { color: '#ffffff', kind: 'rainbow' },
  'avada kedavra': { color: '#3dff6a', kind: 'beam' },
};

/** Look for a spell name: known ones get a signature effect, others a burst in a stable colour. */
export function spellLook(name) {
  const key = name.toLowerCase();
  if (SPELL_FX[key]) return SPELL_FX[key];
  const hue = (hashString(key) % 360) / 360;
  return { color: '#' + new THREE.Color().setHSL(hue, 0.85, 0.62).getHexString(), kind: 'burst' };
}

const rand = (a, b) => a + Math.random() * (b - a);

/** A random unit vector within `spread` (radians, roughly) of dir. */
function jitterDir(dir, spread, out = new THREE.Vector3()) {
  out.set(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
  if (spread >= Math.PI / 2) return out; // any direction
  out.multiplyScalar(Math.tan(spread) * Math.random());
  return out.add(dir).normalize();
}

function srgb(hex) {
  return new THREE.Color(hex).convertLinearToSRGB();
}

// ---------- The stage ----------

export class Stage {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x0d0a1f, 0.026);
    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 300);
    this.camPos = new THREE.Vector3(0, 1.7, 6.5);
    this.camera.position.copy(this.camPos);
    this.lookAt = new THREE.Vector3(0, 1.2, 0);

    this.avatars = [];
    this.frameHooks = [];
    this.transients = []; // { update(dt) -> keep? }
    this.emitters = []; // spread-out emission over time
    this.clock = new THREE.Clock();
    this.time = 0;

    this._buildWorld();
    this.particles = new Particles(this.scene);

    window.addEventListener('resize', () => this._resize());
    this._resize();
    this.renderer.setAnimationLoop(() => this._frame());
  }

  onFrame(fn) {
    this.frameHooks.push(fn);
  }

  add(avatar) {
    // Start where the arc will put it, so it doesn't slide in from the middle.
    this.avatars.push(avatar);
    this.scene.add(avatar.root);
    const { x, z } = this._slot(this.avatars.length - 1, this.avatars.length);
    avatar.root.position.set(x, 0, z);
    this.joinFx(avatar);
  }

  remove(avatar) {
    this.leaveFx(avatar);
    avatar.leave();
  }

  /** Screen position (CSS px) of a world point, or null if behind the camera. */
  project(v) {
    const p = v.clone().project(this.camera);
    if (p.z > 1) return null;
    const el = this.renderer.domElement;
    return { x: ((p.x + 1) / 2) * el.clientWidth, y: ((1 - p.y) / 2) * el.clientHeight };
  }

  // ---------- World ----------

  _buildWorld() {
    const s = this.scene;

    // Sky dome with a vertical gradient and a glow around the moon.
    const moonDir = new THREE.Vector3(-0.35, 0.42, -0.84).normalize();
    s.add(new THREE.Mesh(
      new THREE.SphereGeometry(150, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: { uMoon: { value: moonDir } },
        vertexShader: 'varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: `
          uniform vec3 uMoon; varying vec3 vDir;
          void main(){
            float h = clamp(vDir.y, -0.2, 1.0);
            vec3 horizon = vec3(0.16, 0.09, 0.30);
            vec3 zenith = vec3(0.012, 0.01, 0.045);
            vec3 c = mix(horizon, zenith, pow(max(h, 0.0), 0.55));
            float m = max(dot(vDir, uMoon), 0.0);
            c += vec3(0.25, 0.27, 0.4) * pow(m, 24.0) + vec3(0.08, 0.06, 0.16) * pow(m, 4.0);
            gl_FragColor = vec4(c, 1.0);
          }`,
      }),
    ));

    // Stars, in three groups that twinkle out of phase.
    this.starGroups = [];
    for (let g = 0; g < 3; g++) {
      const n = 500;
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const v = new THREE.Vector3(rand(-1, 1), rand(0.08, 1), rand(-1, 0.4)).normalize().multiplyScalar(120);
        pos.set([v.x, v.y, v.z], i * 3);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const m = new THREE.PointsMaterial({
        size: g === 0 ? 1.1 : 0.7, map: glowMap(), color: [0xfff6e0, 0xdfe6ff, 0xffe0f0][g],
        transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
      });
      const pts = new THREE.Points(geo, m);
      s.add(pts);
      this.starGroups.push(m);
    }

    // Moon.
    const moonAt = moonDir.clone().multiplyScalar(130);
    for (const [size, color, opacity] of [[46, 0x6f78b8, 0.35], [15, 0xf2f4ff, 1]]) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowMap(), color, transparent: true, opacity, depthWrite: false, fog: false, blending: THREE.AdditiveBlending,
      }));
      sp.position.copy(moonAt);
      sp.scale.setScalar(size);
      s.add(sp);
    }

    // Light.
    s.add(new THREE.HemisphereLight(0x9db0ff, 0x150c26, 1.1));
    const moon = new THREE.DirectionalLight(0xcdd8ff, 1.7);
    moon.position.set(-5, 9, 8);
    s.add(moon);
    const rim = new THREE.DirectionalLight(0xa070ff, 1.4);
    rim.position.set(4, 5, -8);
    s.add(rim);
    const warm = new THREE.PointLight(0xffb070, 6, 9, 1.6);
    warm.position.set(0, 0.5, 2.6);
    s.add(warm);
    this.warmLight = warm;

    // Ground and the raised stone stage.
    const ground = new THREE.Mesh(new THREE.CircleGeometry(80, 48), new THREE.MeshStandardMaterial({ color: 0x0c0a18, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.22;
    s.add(ground);
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(5.4, 5.7, 0.22, 40),
      new THREE.MeshStandardMaterial({ color: 0x2b2540, roughness: 0.95, flatShading: true }),
    );
    disc.position.y = -0.11;
    s.add(disc);

    // Glowing rune circle on the stage floor.
    this.runes = new THREE.Group();
    this.runes.position.y = 0.006;
    const runeMat = new THREE.MeshBasicMaterial({
      color: 0x8f6bff, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.runeMat = runeMat;
    for (const [a, b] of [[4.4, 4.5], [3.25, 3.3], [4.85, 4.88]]) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(a, b, 96), runeMat);
      ring.rotation.x = -Math.PI / 2;
      this.runes.add(ring);
    }
    const glyphs = 28;
    for (let i = 0; i < glyphs; i++) {
      const ang = (i / glyphs) * Math.PI * 2;
      const r = 3.87;
      const g = new THREE.Group();
      g.position.set(Math.cos(ang) * r, 0, Math.sin(ang) * r);
      g.rotation.y = -ang + Math.PI / 2;
      const seed = hashString('glyph' + i);
      for (let k = 0; k < 3; k++) {
        const vertical = (seed >> k) & 1;
        const bar = new THREE.Mesh(new THREE.PlaneGeometry(vertical ? 0.05 : 0.26, vertical ? 0.34 : 0.05), runeMat);
        bar.rotation.x = -Math.PI / 2;
        bar.position.set((((seed >> (k + 3)) & 3) - 1.5) * 0.08, 0, (((seed >> (k + 6)) & 3) - 1.5) * 0.08);
        bar.rotation.z = (((seed >> (k + 9)) & 3) - 1.5) * 0.4;
        g.add(bar);
      }
      this.runes.add(g);
    }
    s.add(this.runes);

    // Standing stones in an arc behind the stage.
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x3a3552, roughness: 1, flatShading: true });
    const glyphMat = new THREE.MeshBasicMaterial({ color: 0x7fd1ff, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false });
    const count = 11;
    for (let i = 0; i < count; i++) {
      const ang = THREE.MathUtils.degToRad(196 + (i / (count - 1)) * 148);
      const R = 8.6 + Math.sin(i * 2.3) * 0.5;
      const h = 2.2 + ((hashString('stone' + i) % 100) / 100) * 1.6;
      const stone = new THREE.Mesh(new THREE.BoxGeometry(0.75, h, 0.5, 1, 3, 1), stoneMat);
      const p = stone.geometry.attributes.position;
      for (let v = 0; v < p.count; v++) {
        // Taper the top and rough up the faces a little.
        const y = p.getY(v) / h + 0.5;
        p.setX(v, p.getX(v) * (1 - y * 0.3) + Math.sin(v * 7.1 + i) * 0.03);
        p.setZ(v, p.getZ(v) * (1 - y * 0.2) + Math.cos(v * 5.3 + i) * 0.03);
      }
      stone.geometry.computeVertexNormals();
      stone.position.set(Math.cos(ang) * R, h / 2 - 0.2, Math.sin(ang) * R);
      stone.lookAt(0, h / 2 - 0.2, 0);
      stone.rotation.z += Math.sin(i * 1.7) * 0.06;
      s.add(stone);
      if (i % 3 === 1) {
        const glyph = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.5), glyphMat);
        glyph.position.set(0, h * 0.12, 0.26);
        stone.add(glyph);
      }
    }

    // Drifting wisps of light.
    this.wisps = [];
    const wispColors = [0xffd27a, 0x7fd1ff, 0xb48cff, 0x9effc8];
    for (let i = 0; i < 26; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: glowMap(), color: wispColors[i % wispColors.length], transparent: true, opacity: 0.8,
        depthWrite: false, blending: THREE.AdditiveBlending,
      }));
      sp.scale.setScalar(rand(0.12, 0.28));
      s.add(sp);
      this.wisps.push({
        sp, r: rand(2.5, 9), ang: rand(0, Math.PI * 2), speed: rand(0.03, 0.12) * (Math.random() < 0.5 ? -1 : 1),
        y: rand(0.6, 4.5), bob: rand(0.2, 0.6), phase: rand(0, 10),
      });
    }
  }

  // ---------- Layout ----------

  _slot(i, n) {
    const x = (i - (n - 1) / 2) * SPACING;
    return { x, z: -0.07 * x * x };
  }

  _layout(dt) {
    const live = this.avatars.filter((a) => a.leaving === null);
    const n = live.length;
    const k = 1 - Math.exp(-dt * 2.5);
    live.forEach((a, i) => {
      const { x, z } = this._slot(i, n);
      a.root.position.x += (x - a.root.position.x) * k;
      a.root.position.z += (z - a.root.position.z) * k;
      // Turn partly towards the camera.
      const face = Math.atan2(this.camera.position.x - a.root.position.x, this.camera.position.z - a.root.position.z) * 0.85;
      a.root.rotation.y += (face - a.root.rotation.y) * k;
    });

    // Pull the camera back far enough for everyone (plus room for spells).
    const halfWidth = Math.max(1, ((n - 1) / 2) * SPACING + 1.1);
    const vfov = THREE.MathUtils.degToRad(CAMERA_FOV);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * this.camera.aspect);
    const dist = Math.max(4.8, halfWidth / Math.tan(hfov / 2) + 0.6);
    const sway = Math.sin(this.time * 0.11) * 0.25;
    this.camPos.set(sway, 1.45 + dist * 0.06, dist);
    this.camera.position.lerp(this.camPos, 1 - Math.exp(-dt * 1.5));
    this.lookAt.set(0, 1.15, 0);
    this.camera.lookAt(this.lookAt);
  }

  _resize() {
    const el = this.renderer.domElement;
    const w = el.clientWidth || window.innerWidth;
    const h = el.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const bufH = this.renderer.getDrawingBufferSize(new THREE.Vector2()).y;
    this.particles.material.uniforms.uProj.value = bufH / (2 * Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV) / 2));
  }

  _frame() {
    const dt = Math.min(0.05, this.clock.getDelta());
    this.time += dt;
    const t = this.time;

    this._layout(dt);
    for (const fn of this.frameHooks) fn(dt, t);

    for (let i = this.avatars.length - 1; i >= 0; i--) {
      const a = this.avatars[i];
      if (a.leftOver) {
        this.scene.remove(a.root);
        this.avatars.splice(i, 1);
      }
    }

    // Ambient motion.
    this.runes.rotation.y += dt * 0.04;
    this.runeMat.opacity = 0.42 + 0.14 * Math.sin(t * 1.3);
    this.starGroups.forEach((m, i) => { m.opacity = 0.65 + 0.35 * Math.sin(t * (0.9 + i * 0.4) + i * 2); });
    for (const w of this.wisps) {
      w.ang += w.speed * dt;
      w.sp.position.set(Math.cos(w.ang) * w.r, w.y + Math.sin(t * 0.7 + w.phase) * w.bob, Math.sin(w.ang) * w.r - 1.5);
      w.sp.material.opacity = 0.5 + 0.35 * Math.sin(t * 1.9 + w.phase);
    }
    this.warmLight.intensity = 5.5 + Math.sin(t * 7.3) * 0.4 + Math.sin(t * 13.1) * 0.25;

    for (let i = this.emitters.length - 1; i >= 0; i--) {
      const e = this.emitters[i];
      e.t += dt;
      e.acc += e.rate * dt;
      while (e.acc >= 1) {
        e.acc -= 1;
        e.fn(e.t / e.dur);
      }
      if (e.t >= e.dur) this.emitters.splice(i, 1);
    }
    for (let i = this.transients.length - 1; i >= 0; i--) {
      if (!this.transients[i](dt)) this.transients.splice(i, 1);
    }
    this.particles.update(dt);
    this.renderer.render(this.scene, this.camera);
  }

  // ---------- Effects ----------

  /** Emit `rate` particles per second for `dur` seconds; fn(progress) emits one. */
  _over(dur, rate, fn) {
    this.emitters.push({ t: 0, dur, rate, acc: 0, fn });
  }

  _flash(pos, hex, size = 1, dur = 0.5) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowMap(), color: hex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    sp.position.copy(pos);
    this.scene.add(sp);
    let t = 0;
    this.transients.push((dt) => {
      t += dt;
      const f = t / dur;
      sp.scale.setScalar(size * (0.3 + f));
      sp.material.opacity = Math.max(0, 1 - f);
      if (f < 1) return true;
      this.scene.remove(sp);
      sp.material.dispose();
      return false;
    });
  }

  joinFx(avatar) {
    const base = avatar.root.position.clone();
    const c = srgb(avatar.design.trim);
    this._over(0.9, 220, () => {
      const ang = rand(0, Math.PI * 2);
      const r = rand(0.3, 0.75);
      const p = new THREE.Vector3(base.x + Math.cos(ang) * r, rand(0, 0.3), base.z + Math.sin(ang) * r);
      const v = new THREE.Vector3(-Math.sin(ang) * 1.2, rand(1.2, 3), Math.cos(ang) * 1.2);
      this.particles.emit(p, v, c, rand(0.05, 0.1), rand(0.8, 1.5), 0.5, 0.4);
    });
    this._flash(base.clone().setY(1.2), avatar.design.trim, 3.5, 0.8);
  }

  leaveFx(avatar) {
    const base = avatar.root.position.clone();
    const c = srgb(0x9a7ad8);
    for (let i = 0; i < 140; i++) {
      const p = base.clone().add(new THREE.Vector3(rand(-0.4, 0.4), rand(0.1, 1.9), rand(-0.3, 0.3)));
      const v = new THREE.Vector3(rand(-0.6, 0.6), rand(0.2, 1.2), rand(-0.6, 0.6));
      this.particles.emit(p, v, c, rand(0.08, 0.16), rand(0.6, 1.3), 0.3, 0.3);
    }
  }

  /** Glowing motes left by the wand tip while all four grip buttons are held. */
  trail(avatar) {
    const tip = avatar.tipWorld();
    const c = srgb(avatar.design.trim);
    for (let i = 0; i < 3; i++) {
      const v = new THREE.Vector3(rand(-0.08, 0.08), rand(-0.05, 0.1), rand(-0.08, 0.08));
      this.particles.emit(tip, v, c, rand(0.035, 0.07), rand(0.9, 1.4), 0, 0.6);
    }
  }

  spell(avatar, name) {
    const look = spellLook(name);
    const tip = avatar.tipWorld();
    const dir = avatar.tipDirWorld();
    const color = srgb(look.color);
    const P = this.particles;
    const tmp = new THREE.Vector3();
    this._flash(tip, look.color, 1.6, 0.45);

    switch (look.kind) {
      case 'light':
        avatar.tipLit = 9;
        for (let i = 0; i < 90; i++) P.emit(tip, jitterDir(dir, Math.PI, tmp).multiplyScalar(rand(0.3, 1.4)), color, rand(0.04, 0.09), rand(0.6, 1.4), 0, 0.3);
        break;
      case 'nox':
        avatar.tipLit = 0;
        for (let i = 0; i < 120; i++) {
          const off = jitterDir(dir, Math.PI, tmp).multiplyScalar(rand(0.4, 0.8));
          P.emit(tip.clone().add(off), off.clone().multiplyScalar(-1.6), color, rand(0.05, 0.1), 0.55, 0, 1);
        }
        break;
      case 'fire': {
        const fireCols = ['#ff3a10', '#ff7a1a', '#ffc040', '#ff5a00'].map(srgb);
        this._over(0.9, 320, () => {
          const v = jitterDir(dir, 0.45, new THREE.Vector3()).multiplyScalar(rand(1.8, 3.6));
          P.emit(avatar.tipWorld(), v, fireCols[(Math.random() * 4) | 0], rand(0.08, 0.2), rand(0.5, 1.1), 2.6, 0.25);
        });
        break;
      }
      case 'water':
        this._over(1.1, 300, () => {
          const v = jitterDir(avatar.tipDirWorld(), 0.1, new THREE.Vector3()).multiplyScalar(rand(4, 5.5));
          P.emit(avatar.tipWorld(), v, Math.random() < 0.3 ? srgb('#bfe6ff') : color, rand(0.05, 0.11), rand(0.9, 1.4), -6, 0.8);
        });
        break;
      case 'beam':
        this._over(0.45, 520, () => {
          const v = jitterDir(avatar.tipDirWorld(), 0.04, new THREE.Vector3()).multiplyScalar(rand(8, 12));
          P.emit(avatar.tipWorld(), v, color, rand(0.06, 0.12), rand(0.5, 0.9), 0, 0.9);
        });
        break;
      case 'shield': {
        const center = avatar.root.position.clone().setY(1.1);
        const bubble = new THREE.Mesh(
          new THREE.IcosahedronGeometry(1, 3),
          new THREE.MeshBasicMaterial({ color: look.color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, wireframe: true }),
        );
        bubble.position.copy(center);
        this.scene.add(bubble);
        let t = 0;
        this.transients.push((dt) => {
          t += dt;
          bubble.scale.setScalar(0.3 + Math.min(1, t / 0.35) * 1.05);
          bubble.rotation.y += dt * 0.6;
          bubble.material.opacity = 0.4 * Math.max(0, 1 - Math.max(0, t - 1.2) / 0.8);
          if (t < 2) return true;
          this.scene.remove(bubble);
          bubble.geometry.dispose();
          bubble.material.dispose();
          return false;
        });
        for (let i = 0; i < 160; i++) {
          const n = jitterDir(dir, Math.PI, tmp).clone();
          P.emit(center.clone().addScaledVector(n, 1.3), n.multiplyScalar(0.3), color, rand(0.05, 0.1), rand(0.8, 1.6), 0, 0.4);
        }
        break;
      }
      case 'patronus':
        this._over(1.6, 420, (f) => {
          const a = f * Math.PI * 10 + rand(0, 0.6);
          const d = avatar.tipDirWorld();
          const side = new THREE.Vector3(0, 1, 0).cross(d).normalize();
          const up = new THREE.Vector3().crossVectors(d, side);
          const r = 0.15 + f * 0.9;
          const v = d.clone().multiplyScalar(rand(1.5, 2.6))
            .addScaledVector(side, Math.cos(a) * r * 2)
            .addScaledVector(up, Math.sin(a) * r * 2);
          P.emit(avatar.tipWorld(), v, Math.random() < 0.4 ? srgb('#ffffff') : color, rand(0.07, 0.16), rand(1.6, 2.6), 0.15, 0.55);
        });
        break;
      case 'float': {
        avatar.levitate = 2.6;
        const base = avatar.root.position.clone();
        this._over(1.8, 160, () => {
          const ang = rand(0, Math.PI * 2);
          const r = rand(0.2, 1.1);
          P.emit(new THREE.Vector3(base.x + Math.cos(ang) * r, rand(0, 0.4), base.z + Math.sin(ang) * r),
            new THREE.Vector3(0, rand(0.4, 1.2), 0), color, rand(0.05, 0.1), rand(1.6, 2.6), 0.4, 0.8);
        });
        break;
      }
      case 'rainbow':
        for (let i = 0; i < 260; i++) {
          const c = new THREE.Color().setHSL(Math.random(), 0.9, 0.6).convertLinearToSRGB();
          P.emit(tip, jitterDir(dir, 0.6, tmp).multiplyScalar(rand(1.5, 5)), c, rand(0.06, 0.12), rand(0.8, 1.6), -0.6, 0.3);
        }
        break;
      default:
        for (let i = 0; i < 200; i++) {
          P.emit(tip, jitterDir(dir, 0.5, tmp).multiplyScalar(rand(1.5, 5)), color, rand(0.05, 0.12), rand(0.8, 1.6), -0.6, 0.3);
        }
    }
  }
}
