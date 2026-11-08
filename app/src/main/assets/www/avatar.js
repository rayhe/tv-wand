// avatar.js — procedurally built low-poly wizards and witches that hold a wand.
//
// Each avatar faces +Z (towards the camera) and acts as a mirror: the wand's
// orientation from tracker.js (world: X = towards the TV, Y = the player's
// left, Z = up) is reflected so that pointing at the TV points the avatar's
// wand out of the screen, and moving to your right moves it to screen-right.
// The wand is held in the hand on the screen-right side, and a two-bone IK
// arm reaches for wherever the wand is.

import * as THREE from 'three';

// ---------- Look, chosen deterministically from the wand's name ----------

const SKIN = [0xf3cfb0, 0xe7b48f, 0xc98e66, 0xa36a45, 0x7a4b30, 0x5a3624];
const ROBES = [
  [0x4b2d8f, 0xe2b75d], [0x1f5a3a, 0xd8d8d8], [0x8b1e2d, 0xe2b75d], [0x1d3f7a, 0xd4a017],
  [0x2f2f38, 0xa77bff], [0x6b2f5f, 0xffc8e0], [0x0f5f6b, 0xffe08a], [0x1e4d6b, 0xf2c14e],
  [0x3d1a5c, 0x7cffc4], [0x8a3b12, 0xffd27a],
];
const HAIR = [0x1b1b1b, 0x5a3420, 0xa0522d, 0xd8b26a, 0xcfcfd8, 0x7a3fb0, 0xb03a2e, 0x2a4fa0];
const BEARD = [0xf2f2f2, 0xb8b8b8, 0x6a4024, 0x9a6a35, 0x2a2a2a];

const WITCH_NAMES = ['Morwenna', 'Elspeth', 'Isolde', 'Briallen', 'Seraphine', 'Tamsin', 'Wren', 'Odalys',
  'Marigold', 'Ysolde', 'Calla', 'Rosalind', 'Nerys', 'Ottilie', 'Saffi', 'Liesel'];
const WIZARD_NAMES = ['Alaric', 'Bartholomew', 'Caspian', 'Ignatius', 'Osric', 'Peregrine', 'Thaddeus', 'Barnaby',
  'Fenwick', 'Leopold', 'Mordecai', 'Silas', 'Ambrose', 'Evander', 'Hollis', 'Quillon'];
const EPITHETS = ['the Bright', 'of the Hollow', 'Starweaver', 'Moonwhisper', 'the Wise', 'Emberheart',
  'Thornwood', 'Mistvale', 'the Bold', 'Quickfinger', 'Silverleaf', 'Stormcaller', 'Duskmantle', 'of the Fen',
  'Brightwater', 'the Wanderer'];

export function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed) {
  let a = seed || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (r, list) => list[Math.floor(r() * list.length)];

/** A stable look and name for a wand. */
export function designFor(key) {
  const r = rng(hashString(key));
  const kind = r() < 0.5 ? 'witch' : 'wizard';
  const [robe, trim] = pick(r, ROBES);
  return {
    kind,
    robe,
    trim,
    skin: pick(r, SKIN),
    hair: pick(r, HAIR),
    beard: pick(r, BEARD),
    hatTilt: (r() - 0.5) * 0.5,
    height: 0.95 + r() * 0.1,
    name: `${pick(r, kind === 'witch' ? WITCH_NAMES : WIZARD_NAMES)} ${pick(r, EPITHETS)}`,
  };
}

// ---------- Geometry helpers ----------

function mat(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, flatShading: true, ...extra });
}

function lathe(points, segments, material) {
  return new THREE.Mesh(new THREE.LatheGeometry(points.map(([r, y]) => new THREE.Vector2(r, y)), segments), material);
}

/** Cylinder along +X from x0 to x1 (radius r0 at x0). */
function segmentX(x0, x1, r0, r1, material) {
  const geo = new THREE.CylinderGeometry(r1, r0, x1 - x0, 10);
  geo.rotateZ(-Math.PI / 2);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.x = (x0 + x1) / 2;
  return mesh;
}

let glowTexture = null;
/** Soft round sprite texture, shared by every glow. */
export function glowMap() {
  if (glowTexture) return glowTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  glowTexture = new THREE.CanvasTexture(c);
  glowTexture.colorSpace = THREE.SRGBColorSpace;
  return glowTexture;
}

export const WAND_TIP = 0.34; // wand-local X of the tip, metres

const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);
const STANCE_YAW = 0.6; // radians towards the wand side
const UPPER_ARM = 0.3;
const FOREARM = 0.29; // elbow to the centre of the hand
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpM = new THREE.Matrix4();

function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

// ---------- The avatar ----------

export class Avatar {
  constructor(design) {
    this.design = design;
    this.root = new THREE.Group();
    this.body = new THREE.Group(); // scaled for height and the join/leave animation
    this.root.add(this.body);
    this.phase = Math.random() * 10;
    this.age = 0;
    this.leaving = null; // seconds into the leave animation
    this.tipLit = 0; // seconds of extra tip light left (Lumos)
    this.levitate = 0; // seconds of float left (levitation spells)
    this.casting = false;

    // Smoothed wand axes in avatar space.
    this.tip = new THREE.Vector3(0.15, -0.35, 0.92).normalize();
    this.top = new THREE.Vector3(0, 0.92, 0.35).normalize();

    this._build();
    this.body.scale.setScalar(0.001);
  }

  _build() {
    const d = this.design;
    const robe = mat(d.robe);
    const trim = mat(d.trim, { roughness: 0.5, metalness: 0.3 });
    const skin = mat(d.skin, { roughness: 0.7 });
    const dark = mat(0x1a1420);

    // Lower robe, to the hips.
    this.body.add(lathe([[0.001, 0], [0.47, 0], [0.45, 0.07], [0.37, 0.5], [0.27, 0.95], [0.001, 0.95]], 14, robe));
    const hem = new THREE.Mesh(new THREE.TorusGeometry(0.455, 0.025, 5, 20), trim);
    hem.rotation.x = Math.PI / 2;
    hem.position.y = 0.05;
    this.body.add(hem);

    // Everything above the hips leans and twists as one.
    this.upper = new THREE.Group();
    this.upper.position.y = 0.95;
    this.body.add(this.upper);
    this.upper.add(lathe([[0.27, 0], [0.29, 0.18], [0.26, 0.36], [0.14, 0.46], [0.06, 0.5], [0.001, 0.5]], 14, robe));
    const sash = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 0.06, 14), trim);
    sash.position.y = 0.03;
    this.upper.add(sash);
    const clasp = new THREE.Mesh(new THREE.OctahedronGeometry(0.03), trim);
    clasp.position.set(0, 0.42, 0.13);
    this.upper.add(clasp);

    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.08, 8), skin);
    neck.position.y = 0.52;
    this.upper.add(neck);

    // Head.
    this.head = new THREE.Group();
    this.head.position.y = 0.66;
    this.upper.add(this.head);
    this.head.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.13, 1), skin));
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.017, 8, 6), dark);
      eye.position.set(s * 0.045, 0.02, 0.112);
      this.head.add(eye);
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.012, 0.012), mat(d.kind === 'wizard' ? d.beard : d.hair));
      brow.position.set(s * 0.047, 0.055, 0.113);
      brow.rotation.z = s * -0.15;
      this.head.add(brow);
    }
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.07, 6), skin);
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, -0.005, 0.15);
    this.head.add(nose);

    if (d.kind === 'wizard') {
      const beardMat = mat(d.beard);
      const beard = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.42, 8), beardMat);
      beard.rotation.x = Math.PI - 0.25; // point down, tip forward over the chest
      beard.position.set(0, -0.27, 0.08);
      this.head.add(beard);
      const tache = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.016, 5, 10, Math.PI), beardMat);
      tache.rotation.z = Math.PI;
      tache.position.set(0, -0.035, 0.115);
      this.head.add(tache);
    } else {
      const hairMat = mat(d.hair, { side: THREE.DoubleSide });
      // Tilted back so its front edge sits above the eyes.
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.142, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.36), hairMat);
      cap.rotation.x = -0.35;
      this.head.add(cap);
      // Long hair down the back: an open half-cylinder behind the head.
      const drape = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.19, 0.5, 12, 1, true, Math.PI / 2, Math.PI), hairMat);
      drape.position.set(0, -0.2, -0.01);
      this.head.add(drape);
      const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.025, 0.007, 4, 8, Math.PI), mat(0x8a2a3a));
      mouth.rotation.z = Math.PI;
      mouth.position.set(0, -0.055, 0.118);
      this.head.add(mouth);
    }

    // Pointed hat, built from stacked frustums that each bend a little.
    const hatMat = mat(d.robe, { roughness: 0.9 });
    const hat = new THREE.Group();
    hat.position.y = 0.075;
    hat.rotation.z = d.hatTilt * 0.3;
    this.head.add(hat);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(d.kind === 'witch' ? 0.3 : 0.25, 0.27, 0.02, 20), hatMat);
    hat.add(brim);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.152, 0.155, 0.04, 16), trim);
    band.position.y = 0.03;
    hat.add(band);
    const tall = d.kind === 'witch' ? 0.62 : 0.5;
    const radii = [0.15, 0.11, 0.07, 0.035, 0.004];
    let parent = hat;
    let y = 0.01;
    for (let i = 0; i < 4; i++) {
      const h = tall / 4;
      const seg = new THREE.Group();
      seg.position.y = y;
      seg.rotation.x = i === 0 ? 0 : -0.12 - (d.kind === 'witch' ? 0.1 : 0.03) * i;
      seg.rotation.z = d.hatTilt * (i / 4);
      parent.add(seg);
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radii[i + 1], radii[i], h, 12), hatMat);
      mesh.position.y = h / 2;
      seg.add(mesh);
      parent = seg;
      y = h;
    }
    if (d.kind === 'wizard') {
      const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.035), mat(0xffe08a, { emissive: 0x806020 }));
      star.position.set(0, 0.12, 0.125);
      hat.add(star);
    }

    // Arms. The avatar faces +Z, so +X is its left hand: screen-right, the wand side.
    this.wandArm = this._arm(1, robe, trim, skin);
    this.freeArm = this._arm(-1, robe, trim, skin);

    // The wand. Built along +X with the grip buttons on +Z, like web-wand's model.
    this.wand = new THREE.Group();
    const handleMat = mat(0x3b2a1e, { flatShading: false, roughness: 0.6 });
    const shaftMat = mat(0x6b4a30, { flatShading: false, roughness: 0.5 });
    this.wand.add(segmentX(-0.07, -0.055, 0.011, 0.016, handleMat));
    this.wand.add(segmentX(-0.055, 0.07, 0.016, 0.014, handleMat));
    this.wand.add(segmentX(0.07, 0.085, 0.014, 0.011, mat(0x2a1d14)));
    this.wand.add(segmentX(0.085, WAND_TIP, 0.009, 0.0035, shaftMat));
    this.tipMat = new THREE.MeshBasicMaterial({ color: 0xfff2c0 });
    const tipBall = new THREE.Mesh(new THREE.SphereGeometry(0.008, 8, 6), this.tipMat);
    tipBall.position.x = WAND_TIP;
    this.wand.add(tipBall);
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowMap(), color: d.trim, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
    }));
    this.glow.position.x = WAND_TIP;
    this.glow.scale.setScalar(0.12);
    this.wand.add(this.glow);
    this.body.add(this.wand);

    // Soft shadow.
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.55, 24),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.004;
    this.root.add(shadow);
  }

  _arm(side, robe, trim, skin) {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.25, 0.4, 0);
    this.upper.add(shoulder);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), robe);
    shoulder.add(ball);

    const upperArm = new THREE.Group();
    shoulder.add(upperArm);
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.07, UPPER_ARM, 8), robe);
    sleeve.position.y = -UPPER_ARM / 2;
    upperArm.add(sleeve);

    const elbow = new THREE.Group();
    elbow.position.y = -UPPER_ARM;
    upperArm.add(elbow);
    const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.065, 0.24, 8, 1, true), mat(this.design.robe, { side: THREE.DoubleSide }));
    fore.position.y = -0.12;
    elbow.add(fore);
    const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.012, 4, 12), trim);
    cuff.rotation.x = Math.PI / 2;
    cuff.position.y = -0.235;
    elbow.add(cuff);
    const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.08, 6), skin);
    wrist.position.y = -0.24;
    elbow.add(wrist);
    const hand = new THREE.Mesh(new THREE.IcosahedronGeometry(0.045, 0), skin);
    hand.position.y = -FOREARM;
    elbow.add(hand);
    return { side, shoulder, upperArm, elbow };
  }

  get leftOver() {
    return this.leaving !== null && this.leaving > 0.6;
  }

  leave() {
    if (this.leaving === null) this.leaving = 0;
  }

  /**
   * @param dt seconds since the last frame
   * @param q  wand orientation [w, x, y, z] (body -> world) or null when the wand is quiet
   */
  update(dt, q) {
    this.age += dt;
    this.phase += dt;
    const t = this.phase;

    // Join / leave.
    let s = this.design.height * easeOutBack(Math.min(1, this.age / 0.7));
    if (this.leaving !== null) {
      this.leaving += dt;
      s *= Math.max(0.001, 1 - this.leaving / 0.6);
    }
    this.body.scale.setScalar(Math.max(0.001, s));
    if (this.levitate > 0) this.levitate = Math.max(0, this.levitate - dt);
    this.body.position.y = Math.sin(Math.PI * (1 - this.levitate / 2.6)) * (this.levitate > 0 ? 0.35 : 0);

    // Target wand axes in avatar space.
    let tipT, topT;
    if (q) {
      // Pointing at the TV becomes pointing out and to the wand side, so the
      // wand is seen side-on instead of end-on.
      tipT = mirror(rotate(q, [1, 0, 0])).applyAxisAngle(UP, STANCE_YAW);
      topT = mirror(rotate(q, [0, 0, 1])).applyAxisAngle(UP, STANCE_YAW);
    } else {
      // Resting pose: tip forward and a little down, bobbing.
      tipT = new THREE.Vector3(0.45 + 0.05 * Math.sin(t * 0.7), -0.45 + 0.04 * Math.sin(t * 1.1), 0.75).normalize();
      topT = new THREE.Vector3(0, 0.9, 0.4).normalize();
    }
    const k = 1 - Math.exp(-dt * (q ? 30 : 6));
    this.tip.lerp(tipT, k).normalize();
    this.top.lerp(topT, k);
    this.top.addScaledVector(this.tip, -this.top.dot(this.tip)).normalize(); // keep orthogonal
    const side = new THREE.Vector3().crossVectors(this.top, this.tip);

    // Body language: breathe, lean and look towards the wand.
    const tip = this.tip;
    this.upper.position.y = 0.95 + Math.sin(t * 1.7) * 0.006;
    this.upper.rotation.set(
      Math.max(-0.05, tip.z * 0.07 - Math.max(0, tip.y) * 0.05),
      THREE.MathUtils.clamp(tip.x * 0.35, -0.35, 0.35),
      THREE.MathUtils.clamp(-tip.x * 0.06 - 0.02, -0.1, 0.1),
    );
    this.head.rotation.set(
      THREE.MathUtils.clamp(-tip.y * 0.35, -0.35, 0.3),
      THREE.MathUtils.clamp(tip.x * 0.4, -0.5, 0.5),
      Math.sin(t * 0.8) * 0.03,
    );
    this.root.updateMatrixWorld(true);

    // Where the hand goes: out along the wand from the shoulder, biased down and forward.
    const shoulder = this.wandArm.shoulder.getWorldPosition(new THREE.Vector3());
    this.body.worldToLocal(shoulder);
    const reach = new THREE.Vector3().copy(tip).multiplyScalar(0.8).add(tmpV.set(0.05, -0.5, 0.35)).normalize();
    const hand = shoulder.clone().addScaledVector(reach, (UPPER_ARM + FOREARM) * 0.84);
    this._solveArm(this.wandArm, shoulder, hand, new THREE.Vector3(0.7, -1, -0.4));

    // The wand sits in that hand.
    this.wand.position.copy(hand);
    tmpM.makeBasis(tip, side, this.top);
    this.wand.quaternion.setFromRotationMatrix(tmpM);

    // The other arm hangs, with a little sway; it lifts for flourish while casting.
    const freeShoulder = this.freeArm.shoulder.getWorldPosition(new THREE.Vector3());
    this.body.worldToLocal(freeShoulder);
    const lift = this.casting ? 0.25 : 0;
    const freeHand = freeShoulder.clone().add(tmpV.set(-0.12 - lift * 0.4, -0.5 + lift, 0.12 + Math.sin(t * 0.9) * 0.03 + lift * 0.3));
    this._solveArm(this.freeArm, freeShoulder, freeHand, new THREE.Vector3(-0.7, -1, -0.4));

    // Tip glow.
    if (this.tipLit > 0) this.tipLit -= dt;
    const lit = this.tipLit > 0;
    const pulse = 0.85 + 0.15 * Math.sin(t * 9);
    this.glow.scale.setScalar((lit ? 0.75 : this.casting ? 0.3 : 0.12) * pulse);
    this.glow.material.color.set(lit ? 0xfff4d8 : this.design.trim);
  }

  /** Two-bone IK in body space, then written into the bones' local rotations. */
  _solveArm(arm, s, h, pole) {
    const toHand = new THREE.Vector3().subVectors(h, s);
    const dist = THREE.MathUtils.clamp(toHand.length(), 0.08, UPPER_ARM + FOREARM - 0.001);
    const dir = toHand.normalize();
    const cosA = (UPPER_ARM * UPPER_ARM + dist * dist - FOREARM * FOREARM) / (2 * UPPER_ARM * dist);
    const a = Math.acos(THREE.MathUtils.clamp(cosA, -1, 1));
    const bend = pole.clone().addScaledVector(dir, -pole.dot(dir)).normalize();
    const elbow = s.clone()
      .addScaledVector(dir, Math.cos(a) * UPPER_ARM)
      .addScaledVector(bend, Math.sin(a) * UPPER_ARM);
    const handAt = s.clone().addScaledVector(dir, dist);
    this._aim(arm.upperArm, elbow.clone().sub(s).normalize());
    this._aim(arm.elbow, handAt.sub(elbow).normalize());
  }

  /** Point a bone's -Y axis along a body-space direction. */
  _aim(bone, dirBody) {
    const bodyQ = this.body.getWorldQuaternion(tmpQ2);
    const dirWorld = dirBody.clone().applyQuaternion(bodyQ);
    const worldQ = new THREE.Quaternion().setFromUnitVectors(DOWN, dirWorld);
    const parentQ = bone.parent.getWorldQuaternion(tmpQ);
    bone.quaternion.copy(parentQ.invert().multiply(worldQ));
    bone.updateMatrixWorld(true);
  }

  /** World position of the wand tip. */
  tipWorld(target = new THREE.Vector3()) {
    return this.wand.localToWorld(target.set(WAND_TIP, 0, 0));
  }

  /** World direction the wand points. */
  tipDirWorld(target = new THREE.Vector3()) {
    return target.set(1, 0, 0).transformDirection(this.wand.matrixWorld);
  }

  /** World position just above the hat, for the name tag. */
  tagAnchor(target = new THREE.Vector3()) {
    return this.root.localToWorld(target.set(0, 2.45 * this.body.scale.y, 0));
  }
}

// ---------- Frame maths ----------

/** Rotate a body vector into the world frame (orientation.js's convention). */
function rotate(q, v) {
  const [w, x, y, z] = q;
  return [
    (1 - 2 * (y * y + z * z)) * v[0] + 2 * (x * y - w * z) * v[1] + 2 * (x * z + w * y) * v[2],
    2 * (x * y + w * z) * v[0] + (1 - 2 * (x * x + z * z)) * v[1] + 2 * (y * z - w * x) * v[2],
    2 * (x * z - w * y) * v[0] + 2 * (y * z + w * x) * v[1] + (1 - 2 * (x * x + y * y)) * v[2],
  ];
}

/**
 * World (X = towards the TV, Y = player's left, Z = up) to avatar space
 * (X = screen-right, Y = up, Z = out of the screen), as a mirror image.
 */
function mirror([x, y, z]) {
  return new THREE.Vector3(-y, z, x);
}
