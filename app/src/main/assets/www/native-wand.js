// native-wand.js — the web-wand driver, fed by the Android app's Bluetooth
// stack instead of Web Bluetooth (which Android WebView does not have).
//
// Packet parsing, macros, the IMU start/retry dance and the write queue are
// all inherited from MagicCasterWand in wand.js; only the transport differs.

import { MagicCasterWand, CMD } from './wand.js';

/** The Java bridge (MainActivity.Bridge), or null in a desktop browser. */
export const bridge = window.TvWandNative ?? null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export function bytesToHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Sends to the Android Bluetooth stack. */
export const nativeTransport = {
  write: (id, bytes) => bridge?.write(id, bytesToHex(bytes)),
  disconnect: (id) => bridge?.disconnect(id),
};

/** Swallows everything; used by demo wands. */
export const nullTransport = { write() {}, disconnect() {} };

export class NativeWand extends MagicCasterWand {
  /**
   * @param id native id (the Bluetooth address)
   * @param name advertised name, MCW-xxxx
   * @param transport { write(id, bytes), disconnect(id) }
   */
  constructor(id, name, transport) {
    super();
    this.id = id;
    this.transport = transport;
    // Stand-ins for the Web Bluetooth objects the base class looks at.
    this.device = { name, gatt: { connected: true } };
    this.command = { writeValueWithoutResponse: async (data) => transport.write(id, data) };
  }

  get name() {
    return this.device.name;
  }

  /**
   * The part of MagicCasterWand._open() that runs after notifications are on
   * (native code has already subscribed). Emits 'connect' when done.
   */
  async open() {
    await sleep(this.settleMs); // the wand ignores commands sent right after subscribing
    await this.send([CMD.FIRMWARE_VERSION_READ]);
    await this.send([CMD.PRODUCT_INFO_READ, 0x04]); // device id -> wand type
    await this.send([CMD.PRODUCT_INFO_READ, 0x01]); // serial
    this._emit('connect', { name: this.name });
  }

  /** Native side reported the link gone. */
  lost() {
    if (!this.device.gatt.connected) return;
    this.device.gatt.connected = false;
    this.command = null;
    this.imuStreaming = false;
    this._emit('disconnect', { expected: false });
  }

  setBatteryLevel(level) {
    this._setBattery(level);
  }

  disconnect() {
    this.transport.disconnect(this.id);
  }
}
