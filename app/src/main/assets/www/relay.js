// relay.js — wands reached over the network, for devices whose own Bluetooth
// cannot see them.
//
// The Magic Caster Wand answers BLE on a rotating random address. Android 9 has
// no way to address a random-address peripheral (getRemoteLeDevice arrived in
// API 31), and a Meta Portal's Bluetooth stack cannot even scan, so a Portal can
// never connect to a wand by itself. relay/wand_relay.py runs on a machine that
// can, keeps the link, and forwards packets as JSON events — the same shape the
// Android bridge sends — so everything downstream is unchanged.

import { bytesToHex } from './native-wand.js';

export function startRelay(url) {
  let ws = null;
  const outbox = [];
  const stats = { connected: false, messages: 0, lastAt: 0 };
  window.__relayStats = stats;

  const send = (msg) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    else if (outbox.length < 32) outbox.push(msg);
  };

  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => {
      stats.connected = true;
      window.tvwand.onNative([{ type: 'status', code: 'relay', text: 'Relay connected' }]);
      while (outbox.length && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(outbox.shift()));
    };
    ws.onmessage = (e) => {
      let ev;
      try {
        ev = JSON.parse(e.data);
      } catch {
        return;
      }
      stats.messages++;
      stats.lastAt = performance.now();
      window.tvwand.onNative([ev]);
    };
    ws.onclose = (e) => {
      stats.connected = false;
      console.log(`relay closed code=${e.code} reason=${e.reason}`);
      window.tvwand.onNative([{ type: 'status', code: 'relay-lost', text: `Relay lost — retrying ${url}` }]);
      setTimeout(open, 2000);
    };
    ws.onerror = () => console.log(`relay error ${url}`);
  };
  open();

  return {
    write: (id, bytes) => send({ type: 'write', id, hex: bytesToHex(bytes) }),
    disconnect: (id) => send({ type: 'disconnect', id }),
  };
}
