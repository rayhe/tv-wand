// app.js — every wand that connects gets an avatar that holds it.
//
// Wands arrive from the Android side (MainActivity/WandManager) as batched
// events on window.tvwand.onNative. In a desktop browser, or after pressing
// Menu on the remote, demo wands stand in, using web-wand's packet-level demo.

import { Stage } from './stage.js';
import { Avatar, designFor } from './avatar.js';
import { NativeWand, bridge, hexToBytes, nativeTransport, nullTransport } from './native-wand.js';
import { startRelay } from './relay.js';
import { MotionTracker } from './tracker.js';
import { eulerOf } from './orientation.js';
import { Macro, LED } from './wand.js';
import { startDemo } from './demo.js';

const $ = (s) => document.querySelector(s);
const hex6 = (n) => n.toString(16).padStart(6, '0');

const stage = new Stage($('#stage'));
const players = new Map(); // id -> Player
const departing = new Set(); // players whose avatar is still animating out
const connecting = new Map(); // id -> name, found but not ready yet
let problem = null; // a native status that needs the viewer's attention
let wandTransport = nativeTransport; // replaced by the relay when one is configured
const relayUrl = new URLSearchParams(location.search).get('relay'); // ws://host:port, or null

// Lights and buzz answered on the wand itself, from web-wand.
const EFFECTS = {
  lumos: () => new Macro().buzz(150).ledHex(LED.TIP, 'ffffff', 2000),
  nox: () => new Macro().buzz(100).ledHex(LED.TIP, '330033', 200).delay(100).clear(),
  incendio: () => new Macro().buzz(200).ledHex(LED.TIP, 'ff4500', 300).ledHex(LED.MID_UPPER, 'ff6600', 200).delay(100).ledHex(LED.TIP, 'ff0000', 300).delay(200).clear(),
  aguamenti: () => new Macro().buzz(200).ledHex(LED.TIP, '0066ff', 400).ledHex(LED.MID_UPPER, '00aaff', 300).delay(200).clear(),
  'expecto patronum': () => new Macro().buzz(400)
    .ledHex(LED.TIP, 'e0e0ff', 300).ledHex(LED.MID_UPPER, 'c0c0ff', 300).ledHex(LED.MID_LOWER, 'a0a0ff', 300).ledHex(LED.POMMEL, '8080ff', 300)
    .delay(500).ledHex(LED.TIP, 'ffffff', 1000).delay(500).clear(),
  expelliarmus: () => new Macro().buzz(300).ledHex(LED.TIP, 'ff0000', 200).ledHex(LED.MID_UPPER, 'ff0000', 150).ledHex(LED.POMMEL, 'ff0000', 100).delay(300).clear(),
  stupefy: () => new Macro().buzz(250).ledHex(LED.TIP, 'ff0000', 150).delay(50).ledHex(LED.TIP, '880000', 150).delay(50).ledHex(LED.TIP, 'ff0000', 150).delay(100).clear(),
  'wingardium leviosa': () => new Macro().buzz(150).ledHex(LED.TIP, 'ffffaa', 300).delay(200).ledHex(LED.TIP, 'ffff66', 300).delay(200).ledHex(LED.TIP, 'ffffaa', 300).delay(300).clear(),
  ascendio: () => new Macro().buzz(250)
    .ledHex(LED.POMMEL, '88aaff', 100).delay(50).ledHex(LED.MID_LOWER, '88aaff', 100).delay(50)
    .ledHex(LED.MID_UPPER, '88aaff', 100).delay(50).ledHex(LED.TIP, 'aaccff', 200).delay(100).clear(),
  colovaria: () => new Macro().buzz(200).ledHex(LED.TIP, 'ff0000', 200).delay(100).ledHex(LED.TIP, '00ff00', 200).delay(100).ledHex(LED.TIP, '0000ff', 200).delay(100).clear(),
  'avada kedavra': () => new Macro().buzz(500)
    .ledHex(LED.TIP, '00ff00', 100).ledHex(LED.MID_UPPER, '00ff00', 100).ledHex(LED.MID_LOWER, '00ff00', 100).ledHex(LED.POMMEL, '00ff00', 100)
    .delay(200).clear(),
};
const DEFAULT_EFFECT = () => new Macro().buzz(200).ledHex(LED.TIP, '00ff00', 300).delay(200).clear();

// A wand that stops streaming still holds its pose for this long (it may only
// report while moving), then the avatar lowers it.
const HOLD_POSE_MS = 20_000;
const IMU_RESTART_MS = 6_000;

class Player {
  constructor(wand, { demo = false, design = null } = {}) {
    this.wand = wand;
    this.demo = demo;
    this.design = design ?? designFor(wand.name);
    this.avatar = new Avatar(this.design);
    this.tracker = new MotionTracker(demo ? null : wand.name);
    this.info = {};
    this.battery = null;
    this.restartingImu = false;
    this.banners = new Set();

    this.tag = document.createElement('div');
    this.tag.className = 'tag';
    this.tag.style.setProperty('--trim', '#' + hex6(this.design.trim));
    this.tag.innerHTML = '<div class="tag-name"></div><div class="tag-sub"></div>';
    this.tag.querySelector('.tag-name').textContent = this.design.name;
    $('#tags').append(this.tag);

    wand.addEventListener('imu', (e) => this.tracker.push(e.detail.samples));
    wand.addEventListener('buttons', (e) => { this.avatar.casting = e.detail.all; });
    wand.addEventListener('spell', (e) => this.onSpell(e.detail.name));
    wand.addEventListener('battery', (e) => { this.battery = e.detail; this.renderTag(); });
    wand.addEventListener('info', (e) => { this.info = e.detail; this.renderTag(); dropDuplicate(this); });
    wand.addEventListener('connect', () => this.greet());

    stage.add(this.avatar);
    this.renderTag();
  }

  async greet() {
    if (this.demo) return;
    // Colour the wand up in its avatar's colour, tip to pommel, so everyone can
    // see which one is theirs; then start the IMU stream.
    const colour = hex6(this.design.trim);
    const raise = new Macro().clear().buzz(120);
    [LED.TIP, LED.MID_UPPER, LED.MID_LOWER, LED.POMMEL].forEach((group, i) => {
      raise.ledHex(group, colour, 2200 - i * 200).delay(140);
    });
    try {
      await this.wand.runMacro(raise.delay(1200).clear());
      await this.wand.startImu();
    } catch (err) {
      console.log(`greet failed for ${this.design.name}: ${err}`);
    }
  }

  renderTag() {
    const parts = [];
    if (this.demo) parts.push('Demo');
    else if (this.info.wandType && this.info.wandType !== 'Unknown') parts.push(`${this.info.wandType} wand`);
    else parts.push(this.wand.name);
    if (this.battery) parts.push(this.battery.state === 'charging' ? 'Charging' : `${this.battery.level}%`);
    this.tag.querySelector('.tag-sub').textContent = parts.join(' · ');
    this.tag.classList.toggle('low', this.battery?.state === 'low' || this.battery?.state === 'critical');
  }

  onSpell(name) {
    stage.spell(this.avatar, name);
    showBanner(this, name);
    if (!this.demo) this.wand.runMacro((EFFECTS[name.toLowerCase()] || DEFAULT_EFFECT)()).catch(() => {});
  }

  frame(dt) {
    const t = this.tracker;
    const holding = t.filter.ready && performance.now() - t.lastSampleAt < HOLD_POSE_MS;
    this.avatar.update(dt, holding ? t.q : null);
    // The character faces the viewer and leans a little into where the wand points.
    this.avatar.yawHint = t.filter.ready ? eulerOf(t.q).yaw : 0;
    if (this.avatar.casting) stage.trail(this.avatar);

    const p = stage.project(this.avatar.tagAnchor());
    if (p) this.tag.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -100%)`;
    this.tag.classList.toggle('resting', !holding);
    this.placeBanners();
  }

  /** Spell names follow their caster across the screen. */
  placeBanners() {
    if (!this.banners.size) return;
    const p = stage.project(this.avatar.tagAnchor());
    if (!p) return;
    for (const el of this.banners) {
      el.style.left = `${p.x.toFixed(1)}px`;
      el.style.top = `${Math.max(2, p.y - 14).toFixed(1)}px`;
    }
  }

  /** Nudge a quiet wand to start streaming again. */
  watchdog() {
    if (this.demo || this.restartingImu || !this.wand.connected) return;
    if (performance.now() - this.tracker.lastSampleAt < IMU_RESTART_MS) return;
    this.restartingImu = true;
    this.wand.startImu({ attempts: 1 }).catch(() => {}).finally(() => { this.restartingImu = false; });
  }

  leave() {
    stage.remove(this.avatar);
    this.tag.classList.add('gone');
    setTimeout(() => this.tag.remove(), 900);
    this.demoCtl?.stop();
    departing.add(this);
  }
}

// ---------- HUD ----------

function showBanner(player, name) {
  const el = document.createElement('div');
  el.className = 'banner';
  el.style.setProperty('--trim', '#' + hex6(player.design.trim));
  el.textContent = name.replace(/\b\w/g, (c) => c.toUpperCase()) + '!';
  $('#banners').append(el);
  player.banners.add(el);
  player.placeBanners();
  setTimeout(() => {
    el.remove();
    player.banners.delete(el);
  }, 2600);
}

let toastTimer = 0;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function renderStatus() {
  const n = players.size;
  const main = $('#status-main');
  const sub = $('#status-sub');
  if (problem) {
    main.textContent = problem;
    sub.textContent = '';
  } else if (n === 0) {
    main.textContent = connecting.size ? `Summoning ${[...connecting.values()].join(', ')}…` : 'Wake a wand to join the circle';
    sub.textContent = 'Give it a flick or squeeze the grip. Wands connect by themselves.';
  } else {
    main.textContent = `${n} ${n === 1 ? 'wand' : 'wands'} in the circle`;
    sub.textContent = connecting.size
      ? `Summoning ${[...connecting.values()].join(', ')}…`
      : 'Wake another wand to join  ·  Heading drift is corrected automatically';
  }
  document.body.classList.toggle('empty', n === 0);
  // Past a handful of characters the name tags would cover the whole screen.
  document.body.classList.toggle('crowded', n > 8);
}

// ---------- Native events ----------

/** A design whose name nobody in the circle has yet: collisions re-roll with a salt. */
function freshDesign(name) {
  const taken = new Set([...players.values()].map((p) => p.design.name));
  let design = designFor(name);
  for (let i = 2; taken.has(design.name) && i < 32; i++) design = designFor(`${name}#${i}`);
  return design;
}

/** A wand's BLE address rotates, so one wand can join the circle twice. The serial is stable. */
function dropDuplicate(player) {
  const serial = player.info && player.info.serial;
  if (!serial) return;
  for (const other of players.values()) {
    if (other === player) continue;
    if (other.info && String(other.info.serial) === String(serial)) {
      toast(`${player.design.name} is the same wand twice — releasing the newer link`);
      player.wand.disconnect?.();
      removeWand(player.wand.id);
      renderStatus();
      return;
    }
  }
}

function addNativeWand(id, name) {
  connecting.delete(id);
  if (players.has(id)) return;
  const wand = new NativeWand(id, name, wandTransport);
  const player = new Player(wand, { design: freshDesign(wand.name) });
  players.set(id, player);
  wand.open().catch(() => {});
}

function removeWand(id) {
  connecting.delete(id);
  const p = players.get(id);
  if (!p) return;
  players.delete(id);
  p.wand.lost();
  p.leave();
}

const handlers = {
  status(ev) {
    problem = (ev.code === 'scanning' || ev.code === 'relay') ? null : ev.text;
    renderStatus();
  },
  found(ev) {
    connecting.set(ev.id, ev.name);
    renderStatus();
  },
  connected(ev) {
    addNativeWand(ev.id, ev.name);
    renderStatus();
  },
  notify(ev) {
    const s = statFor(ev.id);
    s.times.push(performance.now());
    s.bytes += ev.hex.length >> 1;
    s.last = performance.now();
    const kind = ev.hex.slice(0, 2);
    s.kinds.set(kind, (s.kinds.get(kind) || 0) + 1);
    players.get(ev.id)?.wand.inject(hexToBytes(ev.hex));
  },
  battery(ev) {
    players.get(ev.id)?.wand.setBatteryLevel(ev.level);
  },
  disconnected(ev) {
    removeWand(ev.id);
    renderStatus();
  },
  key(ev) {
    onKey(ev.key);
  },
};

window.tvwand = {
  onNative(events) {
    for (const ev of events) handlers[ev.type]?.(ev);
  },
};

// ---------- Remote control ----------

function recenterAll() {
  let n = 0;
  for (const p of players.values()) {
    p.tracker.recenter();
    n++;
  }
  if (n) toast('Re-centred: straight ahead is wherever the wands point now');
}

let demoCount = 0;
function addDemo() {
  const id = `demo-${demoCount}`;
  const wand = new NativeWand(id, `MCW-DEMO-${['A', 'B', 'C', 'D', 'E', 'F'][demoCount % 6]}${demoCount}`, nullTransport);
  demoCount++;
  const player = new Player(wand, { demo: true });
  players.set(id, player);
  player.demoCtl = startDemo(wand);
  renderStatus();
}

/** Demo wizards exist for the desktop preview and for explicit ?demo, nothing else. */
function demosAllowed() {
  if (new URLSearchParams(location.search).has('demo')) return true;
  return !bridge && !relayUrl;
}

function toggleDemo() {
  if (!demosAllowed()) return;
  const demos = [...players.entries()].filter(([, p]) => p.demo);
  if (demos.length) {
    for (const [id] of demos) removeWand(id);
    toast('Demo wizards dismissed');
  } else {
    [0, 900, 1800].forEach((ms) => setTimeout(addDemo, ms));
    toast('Demo wizards summoned (Menu again to dismiss)');
  }
  renderStatus();
}

function onKey(key) {
  if (key === 'center') recenterAll();
  else if (key === 'menu' && demosAllowed()) toggleDemo();
}

// Keyboard equivalents, for testing in a desktop browser.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') onKey('center');
  else if (e.key === 'm' || e.key === 'ContextMenu') onKey('menu');
});

// Touchscreens (Portal and similar): tap re-centres where there is no remote or
// keyboard. Deliberately nothing else — a stray long press should not change
// what is on screen.
{
  let downAt = 0;
  window.addEventListener('touchstart', () => { downAt = Date.now(); }, { passive: true });
  window.addEventListener('touchend', (e) => {
    if (!downAt) return;
    if (e.touches.length === 0 && Date.now() - downAt < 600) onKey('center');
    downAt = 0;
  }, { passive: true });
  window.addEventListener('touchcancel', () => { downAt = 0; }, { passive: true });
}

// ---------- Telemetry ----------

// Per-wand receive stats, for the debug panel. Nothing here is needed to play.
const stats = new Map(); // id -> {times, bytes, kinds, last, seenBytes, seenAt, bps}
let frames = 0;
let fps = 0;

function statFor(id) {
  let s = stats.get(id);
  if (!s) {
    s = { times: [], bytes: 0, kinds: new Map(), last: 0, seenBytes: 0, seenAt: 0, bps: 0 };
    stats.set(id, s);
  }
  return s;
}

const telemetry = $('#telemetry');

function setTelemetry(on) {
  telemetry.hidden = on === undefined ? !telemetry.hidden : !on;
  if (telemetry.hidden) return;
  refreshTelemetry();
}

const deg = (rad) => `${(rad * 180 / Math.PI).toFixed(0)}°`;

function refreshTelemetry() {
  if (telemetry.hidden) return;
  const now = performance.now();
  const rows = [];

  const linkName = relayUrl ? relayUrl.replace(/^wss?:\/\//, '') : bridge ? 'native BLE' : 'desktop preview';
  const relay = window.__relayStats;
  const linkState = relayUrl
    ? (relay?.connected ? '<span class="ok">up</span>' : '<span class="warn">down</span>')
    : (bridge ? '<span class="ok">up</span>' : '<span class="dim">—</span>');
  rows.push(`link    <span class="dim">${linkName}</span> ${linkState}`);
  if (relayUrl && relay) rows.push(`relay   ${relay.messages} msgs${relay.lastAt ? ` · ${((now - relay.lastAt) / 1000).toFixed(1)}s ago` : ''}`);
  rows.push(`scene   ${players.size} wand${players.size === 1 ? '' : 's'} · ${fps} fps`);

  for (const [id, p] of players) {
    const s = stats.get(id);
    const name = p.design.name;
    if (p.demo) {
      rows.push(`<div class="wand"><span class="name">${name}</span>\n<span class="dim">demo wand — no packets</span></div>`);
      continue;
    }

    // Packets and bytes per second, over a sliding second.
    if (s) {
      while (s.times.length && now - s.times[0] > 1000) s.times.shift();
      if (!s.seenAt) {
        s.seenAt = now;
        s.seenBytes = s.bytes;
      } else if (now - s.seenAt >= 1000) {
        s.bps = Math.round((s.bytes - s.seenBytes) * 1000 / (now - s.seenAt));
        s.seenAt = now;
        s.seenBytes = s.bytes;
      }
    }

    const rate = s ? `${s.times.length} pkt/s` : 'no packets';
    const age = s && s.last ? `${((now - s.last) / 1000).toFixed(2)}s` : '—';
    const batt = p.battery ? `${p.battery.level}%${p.battery.state === 'charging' ? ' ⚡' : ''}` : '—';
    const info = p.info || {};
    const meta = [info.wandType && info.wandType !== 'Unknown' ? info.wandType : null,
                  info.firmware ? `fw ${info.firmware}` : null,
                  info.serial ? `sn ${info.serial}` : null].filter(Boolean).join(' · ') || 'no device info yet';

    const e = eulerOf(p.tracker.q);
    const tilt = `tilt ${deg(e.pitch)} yaw ${deg(e.yaw)} roll ${deg(e.roll)}`;
    const kinds = s && s.kinds.size
      ? [...s.kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `0x${k}×${n}`).join(' ')
      : '—';

    rows.push(`<div class="wand"><span class="name">${name}</span> <span class="dim">${id}</span>
<span>${rate} · ${s ? s.bps : 0} B/s · last ${age} · batt ${batt}</span>
<span class="dim">${meta}</span>
<span class="dim">${tilt} · ${kinds}</span></div>`);
  }

  $('#telemetry-body').innerHTML = rows.join('\n');
}

// Tap the version label, or press T, to show or hide the panel.
$('#version').addEventListener('click', () => setTelemetry());
window.addEventListener('keydown', (e) => {
  if (e.key === 't' || e.key === 'T') setTelemetry();
});
setInterval(() => {
  fps = frames;
  frames = 0;
  refreshTelemetry();
}, 1000);
if (new URLSearchParams(location.search).has('telemetry')) setTelemetry(true);

// ---------- Run ----------

stage.onFrame((dt) => {
  frames++;
  for (const p of players.values()) p.frame(dt);
  for (const p of departing) {
    p.avatar.update(dt, null);
    if (p.avatar.leftOver) departing.delete(p);
  }
});
setInterval(() => { for (const p of players.values()) p.watchdog(); }, 2000);

// For poking at from chrome://inspect (adb) or a desktop devtools console.
window.wandCircle = { stage, players };

renderStatus();
// ?demowands=N stands in N demo wizards, handy for checking the layout of a crowd.
const extraDemos = Number(new URLSearchParams(location.search).get('demowands') || 0);
if (extraDemos > 0) for (let i = 0; i < Math.min(extraDemos, 24); i++) setTimeout(addDemo, i * 150);
if (relayUrl) {
  // Wands are reached through a relay host; this device's own radio is left alone.
  if (bridge) $('#version').textContent = `v${bridge.version()}`;
  wandTransport = startRelay(relayUrl);
} else if (bridge) {
  $('#version').textContent = `v${bridge.version()}`;
  bridge.ready();
} else {
  // No Android bridge: a desktop preview. Show demo wands unless asked not to.
  if (!new URLSearchParams(location.search).has('nodemo')) toggleDemo();
}
