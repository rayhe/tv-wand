// wand.js — Web Bluetooth driver for the Harry Potter: Magic Caster Wand.
//
// Protocol notes come from the community reverse-engineering work in
// eigger/hass-magic-caster-wand (MIT). No official documentation exists.
//
// Usage:
//   import { MagicCasterWand } from './wand.js';
//   const wand = new MagicCasterWand();
//   wand.addEventListener('spell', e => console.log(e.detail.name));
//   await wand.connect();          // must be called from a click handler

export const SERVICE_UUID = '57420001-587e-48a0-974c-544d6163c577';
export const COMMAND_UUID = '57420002-587e-48a0-974c-544d6163c577';
export const NOTIFY_UUID = '57420003-587e-48a0-974c-544d6163c577';
export const NAME_PREFIX = 'MCW-';

// Commands written to COMMAND_UUID.
export const CMD = {
  FIRMWARE_VERSION_READ: 0x00,
  CHALLENGE: 0x01,
  BOX_ADDRESS_READ: 0x09,
  PRODUCT_INFO_READ: 0x0e,
  IMU_START: 0x30,
  IMU_STOP: 0x31,
  LED_CLEAR_ALL: 0x40,
  LED_SET: 0x42,
  BUTTON_SET_THRESHOLD: 0xdc,
  BUTTON_READ_THRESHOLD: 0xdd,
  MACRO: 0x68,
};

// First byte of packets arriving on NOTIFY_UUID.
export const MSG = {
  FIRMWARE_VERSION: 0x00,
  CHALLENGE: 0x01,
  PONG: 0x02,
  BOX_ADDRESS: 0x09,
  PRODUCT_INFO: 0x0e,
  BUTTONS: 0x10,
  SPELL: 0x24,
  IMU: 0x2c,
  BUTTON_THRESHOLD: 0xdd,
  BUTTON_CALIBRATION: 0xfb,
  IMU_CALIBRATION: 0xfc,
};

/**
 * Grip-button sensitivity presets: [value for index 0-3, value for 4-7].
 * The official app writes 7/10 (seen in a Bluetooth capture of it); other
 * community projects write 5/8. Neither is confirmed by any documentation.
 */
export const BUTTON_SENSITIVITY = {
  '5/8': [5, 8],
  '7/10': [7, 10],
  '10/13': [10, 13],
};

// The four light groups along the wand, tip to handle.
export const LED = { TIP: 0, MID_UPPER: 1, MID_LOWER: 2, POMMEL: 3 };

const ACCEL_SCALE = 0.00048828125; // raw -> g
const GYRO_SCALE = 0.0010908308; // raw -> rad/s

const WAND_TYPES = {
  DF: 'Defiant', LY: 'Loyal', HR: 'Heroic',
  HN: 'Honourable', AV: 'Adventurous', WS: 'Wise',
};

// ---------- Packet parsing (pure functions, testable without Bluetooth) ----------

/** Parse one notification into { type, ...fields }. */
export function parsePacket(bytes) {
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.length === 0) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const op = data[0];

  switch (op) {
    case MSG.SPELL: {
      // [0x24, ?, ?, len, ...utf8 name]
      if (data.length < 5) return null;
      const len = data[3];
      const name = new TextDecoder()
        .decode(data.subarray(4, 4 + len))
        .replace(/\0/g, '')
        .replace(/_/g, ' ')
        .trim();
      return name ? { type: 'spell', name } : null;
    }
    case MSG.BUTTONS: {
      if (data.length < 2) return null;
      const mask = data[1];
      const pressed = [0, 1, 2, 3].map((i) => Boolean(mask & (1 << i)));
      return { type: 'buttons', mask, pressed, all: (mask & 0x0f) === 0x0f };
    }
    case MSG.IMU: {
      // [0x2c, startIndex u16, count, count * (gx gy gz ax ay az : i16)]
      if (data.length < 4) return null;
      const count = data[3];
      if (data.length < 4 + count * 12) return null;
      const samples = [];
      for (let i = 0, o = 4; i < count; i++, o += 12) {
        samples.push({
          gyro: [0, 2, 4].map((d) => view.getInt16(o + d, true) * GYRO_SCALE),
          accel: [6, 8, 10].map((d) => view.getInt16(o + d, true) * ACCEL_SCALE),
        });
      }
      return { type: 'imu', start: view.getUint16(1, true), samples };
    }
    case MSG.FIRMWARE_VERSION:
      return data.length >= 2 ? { type: 'firmware', version: [...data.subarray(1)].join('.') } : null;
    case MSG.BOX_ADDRESS:
      if (data.length < 7) return null;
      return {
        type: 'boxAddress',
        address: [...data.subarray(1, 7)].reverse().map((b) => b.toString(16).padStart(2, '0')).join(':').toUpperCase(),
      };
    case MSG.PRODUCT_INFO: {
      if (data.length < 3) return null;
      const kind = data[1];
      const text = () => new TextDecoder('ascii').decode(data.subarray(2)).replace(/\0/g, '');
      if (kind === 0x01 && data.length >= 6) return { type: 'serial', serial: String(view.getUint32(2, true)) };
      if (kind === 0x02) return { type: 'sku', sku: text() }; // the retail barcode (UPC)
      if (kind === 0x03) return { type: 'part', part: text() };
      if (kind === 0x04) {
        const id = text();
        return { type: 'deviceId', deviceId: id, wandType: WAND_TYPES[id.slice(0, -1).slice(-2)] || 'Unknown' };
      }
      return { type: 'productInfo', kind };
    }
    case MSG.BUTTON_THRESHOLD:
      // [0xdd, index, value]: index 0-3 and 4-7 pair up per grip button.
      return data.length >= 3 ? { type: 'threshold', index: data[1], value: data[2] } : null;
    case MSG.BUTTON_CALIBRATION:
      return { type: 'calibrated', what: 'buttons' };
    case MSG.IMU_CALIBRATION:
      return { type: 'calibrated', what: 'imu' };
    default:
      return { type: 'unknown', opcode: op };
  }
}

/**
 * Coarse battery state from the level. The wand has no charging flag; it
 * appears to report exactly 100 while on the charger, so 100 reads as
 * 'charging' (a full wand off the charger can read 100 too).
 */
export function batteryState(level) {
  if (level >= 100) return 'charging';
  if (level >= 56) return 'high';
  if (level >= 34) return 'medium';
  if (level >= 16) return 'low';
  return 'critical';
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(id); resolve(); }, { once: true });
  });
}

// ---------- Macros: queued light + vibration sequences run on the wand ----------

export class Macro {
  constructor() { this.parts = []; }
  led(group, r, g, b, ms = 0) { this.parts.push(0x22, group, r & 255, g & 255, b & 255, ms & 255, (ms >> 8) & 255); return this; }
  ledHex(group, hex, ms = 0) {
    const n = parseInt(hex.replace('#', ''), 16);
    return this.led(group, (n >> 16) & 255, (n >> 8) & 255, n & 255, ms);
  }
  buzz(ms) { this.parts.push(0x50, ms & 255, (ms >> 8) & 255); return this; }
  delay(ms) { this.parts.push(0x10, ms & 255, (ms >> 8) & 255); return this; }
  clear() { this.parts.push(0x20); return this; }
  bytes() { return new Uint8Array([CMD.MACRO, ...this.parts]); }
}

// ---------- The device ----------

/**
 * Events (CustomEvent, data in e.detail):
 *   connect {name}, disconnect {expected}, waiting {name}  — auto-connect is watching for the wand,
 *   spell {name}, buttons {pressed[4], all, mask},
 *   imu {samples[{gyro[3], accel[3]}]}, battery {level, state},
 *   info {firmware?, deviceId?, wandType?, serial?, sku? (barcode), part?, boxAddress?},
 *   thresholds {values[8]}  — grip sensitivity as read back from the wand,
 *   packet {bytes, parsed}  — every raw notification, for debugging
 */
export class MagicCasterWand extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.command = null;
    this.info = {};
    this.battery = null;
    this.imuStreaming = false;
    this._queue = Promise.resolve();
    this._watch = null;
    this._userDisconnect = false;
    this.settleMs = 500;
    this.writeGapMs = 50; // the wand drops writes that arrive back to back
    this.thresholds = new Array(8).fill(null);
    // Grip sensitivity to write on every connect, or null to leave the wand's own values.
    this.buttonSensitivity = null;
    this._onNotify = (e) => this._handle(new Uint8Array(e.target.value.buffer));
    this._onBattery = (e) => this._setBattery(e.target.value.getUint8(0));
    this._onDisconnect = () => {
      this.command = null;
      this.imuStreaming = false;
      const expected = this._userDisconnect;
      this._userDisconnect = false;
      this._emit('disconnect', { expected });
    };
  }

  static get supported() {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
  }

  /** Whether this browser can reconnect to a wand without showing the picker. */
  static get canAutoConnect() {
    return MagicCasterWand.supported && typeof navigator.bluetooth.getDevices === 'function';
  }

  get connected() {
    return Boolean(this.device?.gatt?.connected && this.command);
  }

  /** Show the browser's device picker and connect. Call from a user gesture. */
  async connect() {
    if (!MagicCasterWand.supported) {
      throw new Error('Web Bluetooth is not available. Use Chrome or Edge on desktop or Android, over HTTPS.');
    }
    this.stopAutoConnect();
    this._adopt(await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: NAME_PREFIX }, { services: [SERVICE_UUID] }],
      optionalServices: [SERVICE_UUID, 'battery_service', 'device_information'],
    }));
    await this._open();
  }

  /** A wand this site was given access to before, or null. */
  async rememberedDevice() {
    if (!MagicCasterWand.canAutoConnect) return null;
    const devices = await navigator.bluetooth.getDevices();
    return devices.find((d) => d.name?.startsWith(NAME_PREFIX)) ?? null;
  }

  /**
   * Wait for the remembered wand to come into range, then connect — no picker,
   * no user gesture. Keeps trying until it connects or stopAutoConnect() /
   * disconnect() is called. Resolves true once connected, false if there is no
   * remembered wand or it was stopped.
   */
  async autoConnect() {
    const device = this.device ?? (await this.rememberedDevice());
    if (!device) return false;
    this._adopt(device);
    this.stopAutoConnect();
    const watch = (this._watch = new AbortController());
    const { signal } = watch;
    this._emit('waiting', { name: device.name });

    let canWatch = typeof device.watchAdvertisements === 'function';
    while (!signal.aborted) {
      try {
        // A sleeping wand isn't advertising and connect() would just time out,
        // so wait until it is heard when the browser can tell us.
        if (canWatch) await this._heard(device, signal);
        if (signal.aborted) break;
        await this._open();
        if (this._watch === watch) this._watch = null;
        return true;
      } catch (err) {
        if (err?.name === 'NotSupportedError' || err?.name === 'NotAllowedError') canWatch = false;
        await sleep(canWatch ? 500 : 3000, signal);
      }
    }
    return false;
  }

  stopAutoConnect() {
    this._watch?.abort();
    this._watch = null;
  }

  /** Revoke this site's access to the wand, so it is no longer auto-connected. */
  async forget() {
    this.stopAutoConnect();
    const device = this.device ?? (await this.rememberedDevice());
    this.disconnect();
    await device?.forget?.();
    if (this.device === device) this._adopt(null);
  }

  _adopt(device) {
    if (this.device === device) return;
    this.device?.removeEventListener('gattserverdisconnected', this._onDisconnect);
    this.device = device;
    device?.addEventListener('gattserverdisconnected', this._onDisconnect);
  }

  /** Resolve on the device's next advertisement (or on abort). */
  _heard(device, signal) {
    return new Promise((resolve, reject) => {
      const inner = new AbortController();
      const finish = () => {
        device.removeEventListener('advertisementreceived', finish);
        signal.removeEventListener('abort', finish);
        inner.abort();
        resolve();
      };
      device.addEventListener('advertisementreceived', finish);
      signal.addEventListener('abort', finish);
      device.watchAdvertisements({ signal: inner.signal }).catch((err) => {
        device.removeEventListener('advertisementreceived', finish);
        signal.removeEventListener('abort', finish);
        reject(err);
      });
    });
  }

  async _open() {
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    this.command = await service.getCharacteristic(COMMAND_UUID);
    const notify = await service.getCharacteristic(NOTIFY_UUID);
    notify.addEventListener('characteristicvaluechanged', this._onNotify);
    await notify.startNotifications();

    try {
      const batt = await (await server.getPrimaryService('battery_service')).getCharacteristic('battery_level');
      batt.addEventListener('characteristicvaluechanged', this._onBattery);
      await batt.startNotifications().catch(() => {});
      this._setBattery((await batt.readValue()).getUint8(0));
    } catch {
      // Some firmware does not expose the battery service; not fatal.
    }

    // The wand ignores commands sent right after subscribing.
    await sleep(this.settleMs);

    await this.send([CMD.FIRMWARE_VERSION_READ]);
    await this.send([CMD.PRODUCT_INFO_READ, 0x04]);
    await this.send([CMD.PRODUCT_INFO_READ, 0x01]);
    await this.send([CMD.PRODUCT_INFO_READ, 0x02]);
    await this.send([CMD.PRODUCT_INFO_READ, 0x03]);
    await this.send([CMD.BOX_ADDRESS_READ]);
    // Grip sensitivity is only written when asked for: writing values the wand
    // doesn't expect can stop the grip buttons from reporting at all.
    if (this.buttonSensitivity) await this.setButtonSensitivity(this.buttonSensitivity);
    else await this.readButtonThresholds();

    // Only now, so commands sent from 'connect' listeners (like startImu)
    // come after the setup instead of being interleaved with it.
    this._emit('connect', { name: this.device.name });
  }

  disconnect() {
    this.stopAutoConnect();
    if (this.device?.gatt?.connected) {
      this._userDisconnect = true;
      this.device.gatt.disconnect();
    }
  }

  /** Write raw bytes to the command characteristic. Writes are serialized. */
  send(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    // Chain off a caught copy so one failed write doesn't fail every later one.
    this._queue = this._queue.catch(() => {}).then(async () => {
      if (!this.command) throw new Error('Wand not connected');
      if (this.command.writeValueWithoutResponse) await this.command.writeValueWithoutResponse(data);
      else await this.command.writeValue(data);
      await sleep(this.writeGapMs);
    });
    return this._queue;
  }

  /** Start streaming gyroscope + accelerometer samples ('imu' events). */
  /**
   * Start streaming gyroscope + accelerometer samples ('imu' events).
   * The start command is unacknowledged and sometimes ignored, so it is
   * resent until samples arrive. Resolves true once samples are flowing,
   * false if none came after every attempt (the wand may only report while
   * moving).
   */
  async startImu({ attempts = 3, waitMs = 1000 } = {}) {
    this.imuStreaming = true;
    for (let i = 1; i <= attempts && this.imuStreaming; i++) {
      await this.send([CMD.IMU_STOP]);
      await sleep(100);
      if (!this.imuStreaming) break; // stopped meanwhile
      const heard = this._nextEvent('imu', waitMs);
      await this.send([CMD.IMU_START, 0x00, 0x80]);
      if (await heard) return true;
    }
    return false;
  }

  async stopImu() {
    await this.send([CMD.IMU_STOP]);
    this.imuStreaming = false;
  }

  /** Ask the wand for its eight grip thresholds; answers arrive as 'thresholds' events. */
  async readButtonThresholds() {
    for (let i = 0; i < 8; i++) await this.send([CMD.BUTTON_READ_THRESHOLD, i]);
  }

  /**
   * Write grip sensitivity, as a preset name from BUTTON_SENSITIVITY or a
   * [low, high] pair, then read the values back to confirm.
   */
  async setButtonSensitivity(preset) {
    const [low, high] = Array.isArray(preset) ? preset : BUTTON_SENSITIVITY[preset];
    for (let i = 0; i < 4; i++) {
      await this.send([CMD.BUTTON_SET_THRESHOLD, i, low]);
      await this.send([CMD.BUTTON_SET_THRESHOLD, i + 4, high]);
    }
    await this.readButtonThresholds();
  }

  /** Set one light group to a solid colour. */
  setLed(group, r, g, b) {
    return this.send([CMD.LED_SET, group, r, g, b]);
  }

  clearLeds() {
    return this.send([CMD.LED_CLEAR_ALL]);
  }

  buzz(ms = 200) {
    return this.runMacro(new Macro().buzz(ms));
  }

  runMacro(macro) {
    return this.send(macro.bytes());
  }

  /** Resolve true on the next event of this type, or false after ms. */
  _nextEvent(type, ms) {
    return new Promise((resolve) => {
      const done = (ok) => { clearTimeout(timer); this.removeEventListener(type, onEvent); resolve(ok); };
      const onEvent = () => done(true);
      const timer = setTimeout(() => done(false), ms);
      this.addEventListener(type, onEvent);
    });
  }

  /** Feed a packet as if the wand sent it. Used by the demo mode and tests. */
  inject(bytes) {
    this._handle(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }

  _setBattery(level) {
    this.battery = level;
    this._emit('battery', { level, state: batteryState(level) });
  }

  _handle(bytes) {
    const parsed = parsePacket(bytes);
    this._emit('packet', { bytes, parsed });
    if (!parsed) return;
    switch (parsed.type) {
      case 'spell':
      case 'buttons':
      case 'imu':
      case 'calibrated':
        this._emit(parsed.type, parsed);
        break;
      case 'firmware':
        this._info({ firmware: parsed.version });
        break;
      case 'deviceId':
        this._info({ deviceId: parsed.deviceId, wandType: parsed.wandType });
        break;
      case 'serial':
        this._info({ serial: parsed.serial });
        break;
      case 'sku':
        this._info({ sku: parsed.sku });
        break;
      case 'part':
        this._info({ part: parsed.part });
        break;
      case 'threshold':
        if (parsed.index < 8) {
          this.thresholds[parsed.index] = parsed.value;
          this._emit('thresholds', { values: [...this.thresholds] });
        }
        break;
      case 'boxAddress':
        this._info({ boxAddress: parsed.address });
        break;
    }
  }

  _info(patch) {
    Object.assign(this.info, patch);
    this._emit('info', { ...this.info });
  }

  _emit(type, detail = {}) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
