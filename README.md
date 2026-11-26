# Wand Circle 🪄📺

An Android TV app for **Harry Potter: Magic Caster Wands**. Leave it open and every wand that wakes up nearby connects on its own. Each wand gets a wizard or witch on screen who holds it and moves it the way you do. Built for a big screen (a 115" TCL Google TV), on the driver from [web-wand](https://github.com/rayhe/web-wand).

- **Automatic.** The app scans all the time. Wake a wand (a flick or a squeeze of the grip) and it joins the circle in a swirl of sparks. When a wand sleeps or leaves, its avatar vanishes. It handles up to 16 wands, and the lineup re-frames itself for any number: up to a handful stand in a shallow arc, past that the arc widens into a circle and the camera pulls back.
- **An avatar per wand.** Each wizard or witch is built procedurally: robe, trim, pointed hat, beard or long hair, and a name like *Morwenna Starweaver*. The look comes from the wand's name, so the same wand always gets the same character, and a name already in the circle re-rolls so two wands are never the same person. On joining, the wand buzzes and lights up in its avatar's colour, so everyone can tell which avatar is theirs.
- **Motion.** The wand's gyro and accelerometer are fused with web-wand's Mahony filter, which also learns the sensor's axis alignment. Each avatar mirrors its wand: point at the screen and the avatar points out, with a slight turn to the side so the wand reads side-on. Two-bone IK moves the arm, and the head and body follow the wand. Characters face the viewer wherever they stand in the arc, and the body swings round with its own wand, so swinging across the room turns the wizard, not just their arm.
- **Spells.** When the wand recognises a spell, the avatar casts it: Lumos lights the tip, Incendio throws fire, Aguamenti a water arc, Protego a shield bubble, levitation spells lift the caster, and so on. Unknown spells burst in a colour of their own. The wand answers with web-wand's light-and-buzz effects. Holding all four grip buttons leaves a glowing trail from the tip.

**Remote:** **OK** re-centres every wand (point them at the screen first, since there's no compass). You rarely need it: heading drift is corrected automatically whenever a wand rests. **Menu** summons or dismisses three demo wizards, for trying it without wands. On a touchscreen, tap to re-centre and long-press (or two-finger tap) for the demos; tap the version label to show a live telemetry panel.

## Install on the TV

1. On the TV, open **Settings > System > About** and select **Android TV OS build** 7 times to enable Developer options. Then open **Settings > System > Developer options** and turn on **USB debugging** (and **Network debugging** or **Wireless debugging** if listed).
2. Note the TV's IP address, under **Settings > Network & Internet**.
3. From a computer with [platform-tools](https://developer.android.com/tools/releases/platform-tools):

   ```bash
   adb connect <tv-ip>:5555        # Android 11+ wireless debugging: adb pair <ip>:<pair-port> first
   adb install -r app-debug.apk
   ```

   Accept the "Allow USB debugging?" prompt on the TV. **Wand Circle** then shows up in the apps row.

The APK is attached to the [latest release](../../releases/latest). You can also sideload it with *Send Files to TV* or *Downloader*.

On first launch, allow the Bluetooth ("Nearby devices") permission. The wands must not be connected to a phone app at the same time.

## Install on a Meta Portal (or any device that cannot scan)

A Portal ("aloha", Android 9) runs a Bluetooth stack with its BLE scanner turned off: every
`startScan` fails with `SCAN_FAILED_INTERNAL_ERROR`, the Settings app can never discover a BLE
accessory, and the wand advertises on a rotating *random* address that Android 9 has no API to
address. So no app on the Portal can reach a wand directly — root doesn't help, `adbd` won't even
run as root on a production build.

`relay/wand_relay.py` bridges it. Run the relay on any machine that can see the wand (this works
with bleak on Windows, macOS and Linux); it keeps the BLE link and forwards packets as JSON over a
WebSocket, while the Portal runs the whole scene and parses every packet exactly as it would
natively:

```bash
uv run --with bleak --with websockets python relay/wand_relay.py --port 8770
adb install -r app-release.apk
adb shell am start -n io.github.rayhe.tvwand/.MainActivity --es relay ws://<relay-host>:8770
```

The relay address is remembered, so from then on launching **Wand Circle** from the Portal's home
screen uses it. Keep the relay running while you play; the app reconnects on its own if it drops.
The only things that differ from a native link are that the Portal never touches its own radio and
that the relay (not the Portal) is what has to be near the wands.

## Debugging

- **Telemetry panel:** tap the version label, press **T**, or launch with `--ez telemetry true`.
  Per wand: address, packets/s, bytes/s, age of the last packet, battery, type, firmware, serial,
  tilt/yaw/roll and a breakdown of packet kinds. Plus relay message count and scene FPS.
- **Crowd preview:** `?demowands=N` stands in N demo wizards, so you can check the layout without N
  wands. In the app: `--es query "demowands=10"`.
- **WebView console:** `adb logcat -s WandConsole` (the page's `console.log` reaches logcat).

## Build

JDK 17 and the Android SDK (platform 35, build-tools 35.0.0):

```bash
./gradlew assembleDebug           # app/build/outputs/apk/debug/app-debug.apk
```

The scene is a plain static web page in `app/src/main/assets/www`, so you can work on it in a desktop browser:

```bash
python -m http.server 8000 --directory app/src/main/assets/www
```

Open http://localhost:8000. Without the Android bridge it starts three demo wands (`?nodemo` turns them off). **Enter** re-centres and **M** toggles demos. In the app, `window.wandCircle` exposes the stage and players, and the WebView can be debugged with `chrome://inspect` over adb.

## How it works

Android WebView has no Web Bluetooth, so the app splits in two:

| Part | Files | Job |
| --- | --- | --- |
| Native | `MainActivity.java`, `WandManager.java` | Scans without stopping for `MCW-` wands, connects one at a time, raises the MTU (IMU packets don't fit in 23 bytes), subscribes to notifications and battery, and serialises GATT writes per wand. Events reach the page in one batch per frame. |
| Bridge | `www/native-wand.js` | `NativeWand` extends web-wand's `MagicCasterWand` with the native link as its transport. Packet parsing, macros and IMU start/retry are reused unchanged. |
| Relay | `relay/wand_relay.py`, `www/relay.js` | For devices that cannot reach a wand themselves: the relay host keeps the BLE link and the page speaks the same event JSON over a WebSocket, so nothing above the transport changes. |
| Motion | `www/tracker.js`, `www/orientation.js` | Per-wand fusion and alignment learning, as in web-wand's Motion card. |
| Scene | `www/stage.js`, `www/avatar.js`, `www/app.js` | three.js stone circle, avatars, IK, particle spells, HUD. |

`wand.js`, `orientation.js` and `demo.js` are copied from web-wand (commit `8710e12`). three.js r160 is vendored, so the app runs offline.

## Credits

The wand protocol comes from community reverse-engineering, mainly [eigger/hass-magic-caster-wand](https://github.com/eigger/hass-magic-caster-wand) (MIT), by way of [web-wand](https://github.com/rayhe/web-wand). The avatars, names and scene are original.

This is an unofficial fan project, not affiliated with or endorsed by Warner Bros., Wizarding World or the wand's makers. Harry Potter is a trademark of Warner Bros. Entertainment Inc.

## License

[MIT](LICENSE)
