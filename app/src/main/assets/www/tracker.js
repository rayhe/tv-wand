// tracker.js — one wand's orientation, from its raw IMU samples.
//
// The same pipeline as web-wand's Motion card (motion.js): learn the sensor's
// mounting from normal use, fuse gyro + accel with a Mahony filter, and keep
// a yaw offset so "pointing at the TV" reads as straight ahead.

import {
  AXES, AutoAligner, OrientationFilter, alignmentMatrix, applyMatrix, eulerOf, quatFromYaw, quatMultiply, validAlignment,
} from './orientation.js';

const DEFAULT_ALIGNMENT = { tip: '+x', up: '+z' };
const STORAGE_PREFIX = 'tv-wand-alignment:';

// Automatic re-centring. A gyro's yaw bias accumulates, so a wand that is held
// still slowly turns its avatar. While the wand is nearly still, "still" is
// taken to mean "pointing forward" and the offset is pulled back at a slow,
// steady rate — enough to undo drift, too slow to fight a deliberate pose.
const STILL_RATE = 0.35; // rad/s of body motion that still counts as resting
const STILL_MS = 1200; // how long it must rest before correcting
const CORRECT_RATE = 0.09; // rad/s the heading is pulled back (about 5°/s)

function load(key) {
  if (!key) return null;
  try {
    const a = JSON.parse(localStorage.getItem(STORAGE_PREFIX + key));
    return a && validAlignment(a) ? a : null;
  } catch {
    return null;
  }
}

function save(key, alignment) {
  if (!key) return;
  try { localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(alignment)); } catch { /* not fatal */ }
}

export class MotionTracker {
  /** @param key a stable id for the wand (its name) to remember its alignment by, or null */
  constructor(key) {
    this.key = key;
    this.alignment = load(key) ?? DEFAULT_ALIGNMENT;
    this.matrix = alignmentMatrix(this.alignment);
    this.filter = new OrientationFilter();
    this.aligner = new AutoAligner();
    this.yawOffset = 0;
    this.recenterNext = true;
    this.q = [1, 0, 0, 0]; // body -> world, after recentring
    this.rate = 0; // body-frame angular speed of the latest sample, rad/s
    this.period = 0.01; // seconds per sample, re-measured every second
    this.lastSampleAt = 0;
    this.autoRecenter = true;
    this._stillMs = 0;
    this._lastPushAt = 0;
    this._count = 0;
    this._windowStart = performance.now();
  }

  /** Samples arrived recently. A sleeping or idle wand stops streaming. */
  get live() {
    return performance.now() - this.lastSampleAt < 1500;
  }

  push(samples) {
    const now = performance.now();
    this._count += samples.length;
    if (now - this._windowStart >= 1000) {
      const perSecond = (this._count * 1000) / (now - this._windowStart);
      if (perSecond > 20 && perSecond < 2000) this.period = 1 / perSecond;
      this._count = 0;
      this._windowStart = now;
    }
    this.lastSampleAt = now;

    for (const s of samples) {
      if (this.aligner.push(s.gyro, s.accel, this.period)) this._applyLearned();
      const gyro = applyMatrix(this.matrix, s.gyro);
      const accel = applyMatrix(this.matrix, s.accel);
      this.filter.update(gyro, accel, this.period);
      if (this.recenterNext && this.filter.ready) {
        this.yawOffset = -eulerOf(this.filter.q).yaw;
        this.recenterNext = false;
      }
      this.rate = Math.hypot(...gyro);
    }
    this.q = quatMultiply(quatFromYaw(this.yawOffset), this.filter.q);

    // Undo yaw drift whenever the wand is resting (see CORRECT_RATE above).
    const dt = this._lastPushAt ? Math.max(0, (now - this._lastPushAt) / 1000) : 0;
    this._lastPushAt = now;
    if (!this.autoRecenter || this.recenterNext || !this.filter.ready || dt <= 0) return;
    this._stillMs = this.rate < STILL_RATE ? this._stillMs + dt * 1000 : 0;
    if (this._stillMs < STILL_MS) return;
    const yaw = eulerOf(this.q).yaw;
    const step = Math.sign(yaw) * Math.min(Math.abs(yaw), CORRECT_RATE * dt);
    this.yawOffset -= step;
    this.q = quatMultiply(quatFromYaw(this.yawOffset), this.filter.q);
  }

  /** Make the wand's current heading count as "pointing at the TV". */
  recenter() {
    if (!this.filter.ready) {
      this.recenterNext = true;
      return;
    }
    this.yawOffset = -eulerOf(this.filter.q).yaw;
    this.q = quatMultiply(quatFromYaw(this.yawOffset), this.filter.q);
  }

  _applyLearned() {
    const { tip, up } = this.aligner.result;
    if (!tip) return;
    const top = up && up[1] !== tip[1] ? up
      : this.alignment.up[1] !== tip[1] ? this.alignment.up
      : AXES.find((a) => a[1] !== tip[1]);
    if (tip === this.alignment.tip && top === this.alignment.up) return;
    this.alignment = { tip, up: top };
    this.matrix = alignmentMatrix(this.alignment);
    save(this.key, this.alignment);
    this.filter.reset();
    this.recenterNext = true;
  }
}
