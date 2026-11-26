#!/usr/bin/env python3
"""wand-relay — connect a Magic Caster Wand on a machine that can see it and
serve it over a WebSocket so a device that cannot (a Meta Portal, whose
Bluetooth stack has no working BLE scanner and cannot address a random-address
peripheral) can still run the scene.

    uv run --with bleak --with websockets python wand_relay.py [--port 8770]

Protocol (JSON, one object per frame, both directions):
    -> {"type": "found", "id": mac, "name": "MCW-xxxx"}
    -> {"type": "connected", "id": mac, "name": ...}
    -> {"type": "disconnected", "id": mac}
    -> {"type": "notify", "id": mac, "hex": "..."}
    -> {"type": "battery", "id": mac, "level": 87}
    -> {"type": "status", "code": "...", "text": "..."}
    <- {"type": "write", "id": mac, "hex": "..."}
    <- {"type": "disconnect", "id": mac}
"""

import argparse
import asyncio
import json
import logging

from bleak import BleakClient, BleakScanner
from websockets.exceptions import ConnectionClosed

SERVICE = "57420001-587e-48a0-974c-544d6163c577"
COMMAND = "57420002-587e-48a0-974c-544d6163c577"
NOTIFY = "57420003-587e-48a0-974c-544d6163c577"
BATTERY_LEVEL = "00002a19-0000-1000-8000-00805f9b34fb"
NAME_PREFIX = "MCW-"

log = logging.getLogger("wand-relay")

clients = set()
wands = {}  # address -> WandLink
current_scanner = None
lock = asyncio.Lock()


async def broadcast(msg):
    if not clients:
        return
    data = json.dumps(msg)
    for ws in list(clients):
        try:
            await ws.send(data)
        except Exception:
            clients.discard(ws)


class WandLink:
    def __init__(self, address, name):
        self.address = address
        self.name = name
        self.client = None
        self.connected = False
        self.connecting = False
        self.battery = None
        self.last_packet = 0.0
        self.writes = 0
        self.loop = asyncio.get_event_loop()

    async def connect(self):
        if self.connected:
            return
        log.info("connecting to %s (%s)", self.name, self.address)
        self.client = BleakClient(self.address, disconnected_callback=self._gone)
        try:
            await self.client.connect()
            await self.client.start_notify(NOTIFY, self._notified)
        except Exception as e:
            log.warning("connect failed for %s: %s", self.address, e)
            self.connecting = False
            await self.close()
            wands.pop(self.address, None)  # let the next advert try again
            return
        self.connecting = False
        self.connected = True
        self.last_packet = self.loop.time()
        log.info("connected to %s", self.name)
        await broadcast({"type": "connected", "id": self.address, "name": self.name})
        await broadcast({"type": "status", "code": "relay", "text": "Relay connected"})
        asyncio.ensure_future(self._read_battery())

    async def _read_battery(self):
        try:
            value = await self.client.read_gatt_char(BATTERY_LEVEL)
            if value:
                self.battery = value[0]
                await broadcast({"type": "battery", "id": self.address, "level": self.battery})
        except Exception:
            pass

    def _gone(self, _client):
        self.loop.create_task(self._dropped())

    async def _dropped(self):
        if not self.connected:
            return
        self.connected = False
        log.info("lost %s", self.name)
        wands.pop(self.address, None)
        await broadcast({"type": "disconnected", "id": self.address})
        await broadcast({"type": "status", "code": "wake-wand",
                         "text": "Wake the wand again to rejoin"})

    def _notified(self, _char, data: bytearray):
        # bleak calls this on the event loop already
        self.last_packet = self.loop.time()
        self.loop.create_task(
            broadcast({"type": "notify", "id": self.address, "hex": bytes(data).hex()})
        )

    async def write(self, data: bytes):
        if not self.connected or self.client is None:
            return
        self.writes += 1
        if self.writes <= 6:
            log.info("%s: write %s", self.name, data.hex())
        # Acknowledged writes first: a Write Command (no response) is dropped
        # silently by this wand when it is busy, which looks like "the wand
        # never lights up".
        try:
            await self.client.write_gatt_char(COMMAND, data, response=True)
        except Exception:
            try:
                await self.client.write_gatt_char(COMMAND, data, response=False)
            except Exception as e:
                log.warning("write failed (%s) %s: %s", self.name, data.hex(), e)

    async def alive(self):
        """Cheap liveness probe: the link can look connected long after it died."""
        if not self.connected or self.client is None:
            return False
        try:
            await self.client.read_gatt_char(BATTERY_LEVEL)
            return True
        except Exception:
            return False

    async def close(self):
        self.connected = False
        if self.client is not None:
            try:
                await self.client.disconnect()
            except Exception:
                pass
            self.client = None


async def on_detection(device, advertisement):
    name = advertisement.local_name or device.name or ""
    if not name.startswith(NAME_PREFIX):
        return
    existing = wands.get(device.address)
    if existing is not None:
        # Still connecting, or up. A dead-but-registered link is retired by the
        # watchdog below, which frees the address for a fresh attempt.
        if existing.connected or existing.connecting:
            return
        wands.pop(device.address, None)
    if len(wands) >= 16:
        return
    link = WandLink(device.address, name)
    # Mark it before the task starts, or two adverts in one scan cycle would
    # schedule two connects to the same wand and wedge the link.
    link.connecting = True
    wands[device.address] = link
    await broadcast({"type": "found", "id": device.address, "name": name})
    asyncio.ensure_future(link.connect())


async def watchdog():
    """Retire links that only look alive, and keep the Windows scanner fresh.

    bleak on Windows can hold a BleakClient that the radio dropped without a
    disconnect callback, and the scanner goes quiet after a long run. Both leave
    wands silently missing, so check in periodically.
    """
    scanner = current_scanner
    ticks = 0
    while True:
        await asyncio.sleep(30)
        ticks += 1
        now = asyncio.get_event_loop().time()
        for address, link in list(wands.items()):
            if not link.connected:
                continue
            quiet = now - link.last_packet if link.last_packet else 999
            if quiet < 120:
                continue
            if await link.alive():
                continue
            log.info("retiring stale link to %s", link.name)
            await link.close()
            wands.pop(address, None)
            await broadcast({"type": "disconnected", "id": address})
        if ticks % 20 == 0 and scanner is not None:
            log.info("restarting scanner")
            await scanner.stop()
            await asyncio.sleep(1)
            await scanner.start()


async def handler(ws):
    clients.add(ws)
    log.info("app connected (%d)", len(clients))
    for link in list(wands.values()):
        if link.connected:
            await ws.send(json.dumps({"type": "connected", "id": link.address, "name": link.name}))
            if link.battery is not None:
                await ws.send(json.dumps({"type": "battery", "id": link.address, "level": link.battery}))
    try:
        async for raw in ws:
            try:
                msg = json.loads(raw)
            except ValueError:
                continue
            link = wands.get(msg.get("id"))
            if msg.get("type") == "write" and link is not None:
                await link.write(bytes.fromhex(msg.get("hex", "")))
            elif msg.get("type") == "disconnect" and link is not None:
                await link.close()
                wands.pop(msg.get("id"), None)
    except ConnectionClosed:
        pass  # the app was force-stopped or dropped off the network
    finally:
        clients.discard(ws)
        log.info("app disconnected (%d)", len(clients))


async def main(port):
    from websockets.asyncio.server import serve

    # A plain HTTP GET at the socket is not a bug worth a traceback.
    logging.getLogger("websockets.server").setLevel(logging.CRITICAL)

    async def ws_handler(ws, *_):
        await handler(ws)

    async with serve(ws_handler, "0.0.0.0", port):
        log.info("relay listening on ws://0.0.0.0:%d", port)
        global current_scanner
        current_scanner = BleakScanner(on_detection)
        await current_scanner.start()
        log.info("scanning for %s* wands", NAME_PREFIX)
        asyncio.ensure_future(watchdog())
        await asyncio.Future()  # run until killed


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8770)
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    try:
        asyncio.run(main(args.port))
    except KeyboardInterrupt:
        pass
