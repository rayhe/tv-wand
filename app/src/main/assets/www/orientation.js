// orientation.js — turns raw gyro + accel samples into the wand's 3D orientation.
//
// Frames
//   raw:   the IMU chip's own X/Y/Z, whatever way it is mounted in the wand.
//   body:  X = towards the tip, Z = out of the top (grip-button side), Y = Z × X.
//   world: Z = up (against gravity), X = "forward" (where the wand pointed when
//          last recentred). There is no magnetometer, so heading slowly drifts.
//
// Quaternions are [w, x, y, z] and rotate body vectors into the world frame.

// ---------- Axis alignment (raw -> body) ----------

export const AXES = ['+x', '-x', '+y', '-y', '+z', '-z'];

function axisVector(name) {
  const v = [0, 0, 0];
  v['xyz'.indexOf(name[1])] = name[0] === '-' ? -1 : 1;
  return v;
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/** Two axes are usable together only if they are different raw axes. */
export function validAlignment({ tip, up }) {
  return AXES.includes(tip) && AXES.includes(up) && tip[1] !== up[1];
}

/** 3×3 matrix taking raw vectors to body vectors, from which raw axis points to the tip and to the top. */
export function alignmentMatrix({ tip, up }) {
  const x = axisVector(tip);
  const z = axisVector(up);
  return [x, cross(z, x), z];
}

export function applyMatrix(m, v) {
  return m.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
}

/** Inverse of an alignment matrix (it is a signed permutation, so the transpose). */
export function transpose(m) {
  return [0, 1, 2].map((c) => m.map((row) => row[c]));
}

/**
 * Which raw axis points up while the wand is held still, from an accelerometer
 * reading (at rest it measures +1 g straight up). Returns { axis, confidence },
 * where confidence is how cleanly one axis dominates (1 = perfectly aligned).
 */
export function upAxisFromAccel(accel, exclude) {
  const mag = Math.hypot(...accel) || 1;
  let best = -1;
  for (let i = 0; i < 3; i++) {
    if ('xyz'[i] === exclude?.[1]) continue;
    if (best < 0 || Math.abs(accel[i]) > Math.abs(accel[best])) best = i;
  }
  return { axis: (accel[best] < 0 ? '-' : '+') + 'xyz'[best], confidence: Math.abs(accel[best]) / mag };
}

// ---------- Quaternion helpers ----------

export function quatMultiply(a, b) {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

export function quatFromYaw(yaw) {
  return [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)];
}

/** Rotate a body vector into the world frame. */
export function rotate(q, v) {
  const [w, x, y, z] = q;
  return [
    (1 - 2 * (y * y + z * z)) * v[0] + 2 * (x * y - w * z) * v[1] + 2 * (x * z + w * y) * v[2],
    2 * (x * y + w * z) * v[0] + (1 - 2 * (x * x + z * z)) * v[1] + 2 * (y * z - w * x) * v[2],
    2 * (x * z - w * y) * v[0] + 2 * (y * z + w * x) * v[1] + (1 - 2 * (x * x + y * y)) * v[2],
  ];
}

/** Heading, elevation (tip up = positive) and roll, in radians. */
export function eulerOf(q) {
  const [w, x, y, z] = q;
  return {
    yaw: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)),
    pitch: Math.asin(Math.max(-1, Math.min(1, 2 * (x * z - w * y)))),
    roll: Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)),
  };
}

export function wrapAngle(a) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

// ---------- Sensor fusion ----------

/**
 * Mahony complementary filter: integrates the gyro, and nudges the result
 * towards the accelerometer's idea of "down" whenever the wand isn't being
 * swung hard (so a fast flick doesn't drag the horizon around).
 */
export class OrientationFilter {
  constructor({ kp = 1.0 } = {}) {
    this.kp = kp;
    this.reset();
  }

  /** Forget the orientation; the next sample re-levels it from gravity. */
  reset() {
    this.q = [1, 0, 0, 0];
    this.ready = false;
  }

  /** gyro in rad/s and accel in g, both in the body frame; dt in seconds. */
  update(gyro, accel, dt) {
    if (!this.ready) {
      this._levelFrom(accel);
      return this.q;
    }
    let [gx, gy, gz] = gyro;
    const norm = Math.hypot(...accel);
    if (norm > 0.85 && norm < 1.15) {
      const [ax, ay, az] = accel.map((a) => a / norm);
      // Where the current estimate thinks "up" is, in the body frame.
      const [w, x, y, z] = this.q;
      const vx = 2 * (x * z - w * y);
      const vy = 2 * (w * x + y * z);
      const vz = w * w - x * x - y * y + z * z;
      // Rotate towards the measurement by the cross-product error.
      gx += this.kp * (ay * vz - az * vy);
      gy += this.kp * (az * vx - ax * vz);
      gz += this.kp * (ax * vy - ay * vx);
    }
    const [w, x, y, z] = this.q;
    const h = 0.5 * dt;
    const q = [
      w + (-x * gx - y * gy - z * gz) * h,
      x + (w * gx + y * gz - z * gy) * h,
      y + (w * gy - x * gz + z * gx) * h,
      z + (w * gz + x * gy - y * gx) * h,
    ];
    const n = Math.hypot(...q);
    this.q = q.map((c) => c / n);
    return this.q;
  }

  _levelFrom(accel) {
    const [ax, ay, az] = accel;
    if (!Math.hypot(ax, ay, az)) return;
    const roll = Math.atan2(ay, az);
    const noseDown = Math.atan2(-ax, Math.hypot(ay, az));
    const cr = Math.cos(roll / 2), sr = Math.sin(roll / 2);
    const cp = Math.cos(noseDown / 2), sp = Math.sin(noseDown / 2);
    this.q = [cr * cp, sr * cp, cr * sp, -sr * sp];
    this.ready = true;
  }
}

// ---------- Learning the alignment from normal use ----------

const SWING_RATE = 1.0; // rad/s: faster than this counts as a swing
const MIN_SWING_SAMPLES = 150;
const STILL_RATE = 0.3; // rad/s: slower than this counts as held still

/**
 * Learns the alignment from raw samples, without any setup:
 *  - Tip axis: casting swings the wand about its pivot but rarely twists it
 *    along its length, so the raw axis with the least swing rotation is the
 *    long axis.
 *  - Tip direction: holding the wand still and straight up puts gravity along
 *    that axis, and its sign says which end is the tip.
 *  - Top axis: each still, roughly level hold votes for whichever other axis
 *    gravity falls on.
 */
export class AutoAligner {
  constructor({ holdSeconds = 1 } = {}) {
    this.holdSeconds = holdSeconds;
    this.reset();
  }

  reset() {
    this.energy = [0, 0, 0];
    this.swings = 0;
    this.longAxis = null; // 0/1/2 once the swings make it clear
    this.tipSign = 0;
    this.upVotes = {};
    this._sinceSwing = Infinity;
    this._still = null;
  }

  /** The raw axis index that rotates least during swings, once that is clear. */
  _longAxisFromSwings() {
    if (this.swings < MIN_SWING_SAMPLES) return null;
    const order = [0, 1, 2].sort((a, b) => this.energy[a] - this.energy[b]);
    return this.energy[order[0]] < 0.35 * this.energy[order[1]] ? order[0] : null;
  }

  /**
   * Feed one raw sample (gyro rad/s, accel g, dt s). Returns 'hold-up' or
   * 'level' when a still hold was just counted, otherwise null.
   */
  push(gyro, accel, dt) {
    const rate = Math.hypot(...gyro);
    const g = Math.hypot(...accel);
    if (rate > SWING_RATE) {
      for (let i = 0; i < 3; i++) this.energy[i] += gyro[i] * gyro[i];
      this.swings++;
      this._sinceSwing = 0;
      const axis = this._longAxisFromSwings();
      if (axis !== this.longAxis) {
        // A different long axis invalidates what the holds told us.
        this.longAxis = axis;
        this.tipSign = 0;
        this.upVotes = {};
      }
    } else {
      this._sinceSwing += dt;
    }

    if (rate > STILL_RATE || g < 0.9 || g > 1.1) {
      this._still = null;
      return null;
    }
    // A different pose (gravity moved) is a new hold, even without a swing between.
    const prev = this._still;
    if (prev?.n > 5 && Math.hypot(...accel.map((a, i) => a - prev.sum[i] / prev.n)) > 0.2) {
      this._still = { t: 0, sum: [0, 0, 0], n: 0, inHand: this._sinceSwing < 3, counted: false };
    }
    if (!this._still) this._still = { t: 0, sum: [0, 0, 0], n: 0, inHand: this._sinceSwing < 3, counted: false };
    const st = this._still;
    st.t += dt;
    st.n++;
    for (let i = 0; i < 3; i++) st.sum[i] += accel[i];
    if (st.counted || st.t < this.holdSeconds || this.longAxis === null) return null;
    st.counted = true;

    const mag = Math.hypot(...st.sum);
    const up = st.sum.map((s) => s / mag); // unit "up" in raw axes
    const L = this.longAxis;
    if (Math.abs(up[L]) > 0.9) {
      // Held vertical: people hold a wand tip-up, not tip-down.
      this.tipSign = Math.sign(up[L]);
      return 'hold-up';
    }
    if (Math.abs(up[L]) < 0.5 && st.inHand) {
      let best = -1;
      for (let i = 0; i < 3; i++) if (i !== L && (best < 0 || Math.abs(up[i]) > Math.abs(up[best]))) best = i;
      if (Math.abs(up[best]) > 0.7) {
        const axis = (up[best] < 0 ? '-' : '+') + 'xyz'[best];
        this.upVotes[axis] = (this.upVotes[axis] || 0) + 1;
        return 'level';
      }
    }
    return null;
  }

  /** Best alignment so far: { tip, up } with either possibly null. */
  get result() {
    const tip = this.longAxis !== null && this.tipSign ? (this.tipSign < 0 ? '-' : '+') + 'xyz'[this.longAxis] : null;
    const votes = Object.entries(this.upVotes).sort((a, b) => b[1] - a[1]);
    const total = votes.reduce((s, [, n]) => s + n, 0);
    const up = votes.length && votes[0][1] >= 2 && votes[0][1] / total >= 0.6 ? votes[0][0] : null;
    return { tip, up };
  }

  /** Progress for the UI. */
  get status() {
    return {
      swingProgress: Math.min(1, this.swings / MIN_SWING_SAMPLES),
      longAxis: this.longAxis === null ? null : 'xyz'[this.longAxis],
      ...this.result,
    };
  }
}
