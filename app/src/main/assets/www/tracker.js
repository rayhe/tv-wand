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
