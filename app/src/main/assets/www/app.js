// app.js — every wand that connects gets an avatar that holds it.
//
// Wands arrive from the Android side (MainActivity/WandManager) as batched
// events on window.tvwand.onNative. In a desktop browser, or after pressing
// Menu on the remote, demo wands stand in, using web-wand's packet-level demo.

import { Stage } from './stage.js';
import { Avatar, designFor } from './avatar.js';
import { NativeWand, bridge, hexToBytes, nativeTransport, nullTransport } from './native-wand.js';
import { MotionTracker } from './tracker.js';
import { Macro, LED } from './wand.js';
import { startDemo } from './demo.js';

const $ = (s) => document.querySelector(s);
const hex6 = (n) => n.toString(16).padStart(6, '0');

const stage = new Stage($('#stage'));
const players = new Map(); // id -> Player
const departing = new Set(); // players whose avatar is still animating out
const connecting = new Map(); // id -> name, found but not ready yet
let problem = null; // a native status that needs the viewer's attention

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
  constructor(wand, { demo = false } = {}) {
    this.wand = wand;
    this.demo = demo;
    this.design = designFor(wand.name);
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
    wand.addEventListener('info', (e) => { this.info = e.detail; this.renderTag(); });
    wand.addEventListener('connect', () => this.greet());

    stage.add(this.avatar);
    this.renderTag();
  }

  async greet() {
    if (this.demo) return;
    // Light the wand in its avatar's colour, so everyone can tell which one is theirs.
    try {
      await this.wand.runMacro(new Macro().buzz(120).ledHex(LED.TIP, hex6(this.design.trim), 1500).delay(1500).clear());
      await this.wand.startImu();
    } catch {
      // Dropped while greeting; the disconnect event tidies up.
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
      : 'Wake another wand to join  ·  Point at the TV and press OK to re-centre';
  }
  document.body.classList.toggle('empty', n === 0);
}

// ---------- Native events ----------

function addNativeWand(id, name) {
  connecting.delete(id);
  if (players.has(id)) return;
  const wand = new NativeWand(id, name, nativeTransport);
  const player = new Player(wand);
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
    problem = ev.code === 'scanning' ? null : ev.text;
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

function toggleDemo() {
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
  else if (key === 'menu') toggleDemo();
}

// Keyboard equivalents, for testing in a desktop browser.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') onKey('center');
  else if (e.key === 'm' || e.key === 'ContextMenu') onKey('menu');
});

// ---------- Run ----------

stage.onFrame((dt) => {
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
if (bridge) {
  $('#version').textContent = `v${bridge.version()}`;
  bridge.ready();
} else {
  // No Android bridge: a desktop preview. Show demo wands unless asked not to.
  if (!new URLSearchParams(location.search).has('nodemo')) toggleDemo();
}
