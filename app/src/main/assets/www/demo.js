// demo.js — fakes a wand by injecting packets in the real wire format, so the
// whole parsing + UI path runs without hardware.

import { MSG } from './wand.js';

const GYRO_SCALE = 0.0010908308;
const ACCEL_SCALE = 0.00048828125;
const TICK_MS = 20; // one IMU packet per tick
const PER_PACKET = 2; // samples per packet

// Each shape maps t in [0,1] to a tip position in radians.
const CASTS = [
  { spell: 'lumos', shape: (t) => [0.05 * Math.sin(t * 6), 0.3 - 0.6 * t] },
  { spell: 'incendio', shape: (t) => [-0.35 + 0.7 * t, 0.2 * (Math.abs(((t * 4) % 2) - 1) * 2 - 1)] },
  {
    spell: 'wingardium leviosa',
    shape: (t) => (t < 0.75
      ? [-0.35 + 0.6 * (t / 0.75), 0.18 * Math.sin((t / 0.75) * Math.PI)]
      : [0.25 + 0.1 * ((t - 0.75) / 0.25), -0.3 * ((t - 0.75) / 0.25)]),
  },
  { spell: 'expecto patronum', shape: (t) => [0.35 * t * Math.cos(t * 14), 0.35 * t * Math.sin(t * 14)] },
];

/**
 * Turn guide polylines (x right, y down, any units) into a demo cast shape:
 * t in [0,1] -> [x, y] in radians, about 0.6 rad across, following the
 * strokes at constant speed.
 */
export function castFromPolylines(spell, polylines) {
  const pts = polylines.flat();
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const k = 0.6 / Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
  const lens = [0];
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = lens[lens.length - 1] || 1;
  return {
    spell,
    shape(t) {
      const target = t * total;
      let i = lens.findIndex((l) => l >= target);
      if (i <= 0) i = 1;
      const f = (target - lens[i - 1]) / ((lens[i] - lens[i - 1]) || 1);
      const x = pts[i - 1].x + (pts[i].x - pts[i - 1].x) * f;
      const y = pts[i - 1].y + (pts[i].y - pts[i - 1].y) * f;
      return [(x - cx) * k, -(y - cy) * k];
    },
  };
}

const buttons = (mask) => [MSG.BUTTONS, mask];

function spellPacket(name) {
  const bytes = new TextEncoder().encode(name.replace(/ /g, '_'));
  return [MSG.SPELL, 0, 0, bytes.length, ...bytes];
}

function imuPacket(index, samples) {
  const buf = new DataView(new ArrayBuffer(4 + samples.length * 12));
  buf.setUint8(0, MSG.IMU);
  buf.setUint16(1, index, true);
  buf.setUint8(3, samples.length);
  const clamp = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));
  samples.forEach(({ gyro, accel }, i) => {
    const o = 4 + i * 12;
    gyro.forEach((g, k) => buf.setInt16(o + k * 2, clamp(g / GYRO_SCALE), true));
    accel.forEach((a, k) => buf.setInt16(o + 6 + k * 2, clamp(a / ACCEL_SCALE), true));
  });
  return new Uint8Array(buf.buffer);
}

/**
 * Start the fake wand. `toRaw` converts body-frame vectors (X = tip, Z = top)
 * to the IMU's raw axes, so the data matches whatever alignment is in use.
 */
export function startDemo(wand, { toRaw = (v) => v, casts = CASTS } = {}) {
  let stopped = false;
  let index = 0;
  let elevation = 0.15; // radians, tip above level
  let heading = 0; // radians, left of straight ahead
  const timers = new Set();
  const wait = (ms) => new Promise((r) => { const id = setTimeout(() => { timers.delete(id); r(); }, ms); timers.add(id); });

  // One sample while turning at headingRate (rad/s, about world up) and
  // tilting at elevationRate, with no roll. Gravity reads as +1 g "up",
  // which in the body frame is (sin el, 0, cos el).
  function sample(headingRate, elevationRate) {
    const s = Math.sin(elevation), c = Math.cos(elevation);
    return {
      gyro: toRaw([headingRate * s, -elevationRate, headingRate * c]),
      accel: toRaw([s, 0, c]),
    };
  }

  async function idle(ms) {
    // Small wobble so the readouts look alive between casts.
    for (let t = 0; t < ms && !stopped; t += TICK_MS) {
      const jitter = () => (Math.random() - 0.5) * 0.05;
      wand.inject(imuPacket(index++ & 0xffff, [sample(jitter(), jitter()), sample(jitter(), jitter())]));
      await wait(TICK_MS);
    }
  }

  async function cast({ spell, shape }) {
    wand.inject(buttons(0x01));
    await wait(80);
    wand.inject(buttons(0x0f));
    const steps = 140;
    const dt = TICK_MS / 1000 / PER_PACKET;
    let prev = shape(0);
    for (let i = 1; i <= steps && !stopped; i += PER_PACKET) {
      const samples = [];
      for (let k = 0; k < PER_PACKET; k++) {
        const cur = shape(Math.min(1, (i + k) / steps));
        // Screen x is heading change scaled by cos(elevation); y is elevation.
        const headingRate = -(cur[0] - prev[0]) / Math.cos(elevation) / dt;
        const elevationRate = (cur[1] - prev[1]) / dt;
        samples.push(sample(headingRate, elevationRate));
        elevation += elevationRate * dt;
        heading += headingRate * dt;
        prev = cur;
      }
      wand.inject(imuPacket(index++ & 0xffff, samples));
      await wait(TICK_MS);
    }
    wand.inject(buttons(0x00));
    // Drift back to a comfortable pose before the next cast.
    const back = (0.15 - elevation) / 30;
    const turn = -heading / 30;
    for (let i = 0; i < 30 && !stopped; i++) {
      const smp = sample(turn / dt, back / dt);
      elevation += back;
      heading += turn;
      wand.inject(imuPacket(index++ & 0xffff, [smp]));
      await wait(10);
    }
    await wait(150);
    if (!stopped) wand.inject(spellPacket(spell));
  }

  (async () => {
    wand.inject(new Uint8Array([MSG.FIRMWARE_VERSION, 0, 3]));
    for (let n = 0; !stopped; n++) {
      await idle(1200);
      if (!stopped) await cast(casts[n % casts.length]);
    }
  })();

  return {
    stop() {
      stopped = true;
      timers.forEach(clearTimeout);
      wand.inject(buttons(0x00));
    },
  };
}
