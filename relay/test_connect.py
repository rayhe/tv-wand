import asyncio, sys
from bleak import BleakScanner, BleakClient

NOTIFY = "57420003-587e-48a0-974c-544d6163c577"
COMMAND = "57420002-587e-48a0-974c-544d6163c577"

async def main():
    dev = None
    def cb(d, adv):
        nonlocal dev
        name = adv.local_name or d.name or ""
        if name.startswith("MCW-"):
            dev = d
    sc = BleakScanner(cb)
    await sc.start()
    await asyncio.sleep(15)
    await sc.stop()
    if dev is None:
        print("no MCW- wand advertising; wake one and retry")
        return
    print("found", dev.address, dev.name)
    n = [0]
    def on_notify(ch, data):
        n[0] += 1
        if n[0] <= 5:
            print("notify", bytes(data).hex())
    for attempt in range(3):
        try:
            async with BleakClient(dev, disconnected_callback=lambda c: print("DISCONNECTED")) as client:
                print("connected:", client.is_connected)
                svcs = [s.uuid for s in client.services]
                print("services:", svcs)
                await client.start_notify(NOTIFY, on_notify)
                try:
                    bat = await client.read_gatt_char("00002a19-0000-1000-8000-00805f9b34fb")
                    print("battery:", bat.hex())
                except Exception as e:
                    print("battery read failed:", type(e).__name__, e)
                await asyncio.sleep(15)
                print("notifications:", n[0])
                return
        except Exception as e:
            print("attempt", attempt, "failed:", type(e).__name__, e)
            await asyncio.sleep(3)

asyncio.run(main())
