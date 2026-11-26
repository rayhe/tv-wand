import asyncio, json, sys, urllib.request
import websockets

EXPR = sys.argv[1] if len(sys.argv) > 1 else "location.href"

def targets():
    with urllib.request.urlopen("http://127.0.0.1:9222/json", timeout=10) as r:
        return json.load(r)

async def main():
    ts = [t for t in targets() if t.get("type") in ("page", "webview")]
    if not ts:
        print("no targets"); return
    async with websockets.connect(ts[0]["webSocketDebuggerUrl"], max_size=8_000_000) as ws:
        await ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                                  "params": {"expression": EXPR, "returnByValue": True,
                                             "awaitPromise": True}}))
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=20))
            if msg.get("id") == 1:
                res = msg.get("result", {})
                if "exceptionDetails" in res:
                    print("EXCEPTION:", res["exceptionDetails"].get("text"),
                          res["exceptionDetails"].get("exception", {}).get("description"))
                else:
                    print(json.dumps(res.get("result", {}).get("value"), indent=1))
                return

asyncio.run(main())
