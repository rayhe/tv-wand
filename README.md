# Wand Circle 🪄📺

An Android TV app for **Harry Potter: Magic Caster Wands**. Leave it open and every wand that wakes up nearby connects on its own. Each wand gets a wizard or witch on screen who holds it and moves it the way you do. Built for a big screen (a 115" TCL Google TV), on the driver from [web-wand](https://github.com/rayhe/web-wand).

- **Automatic.** The app scans all the time. Wake a wand (a flick or a squeeze of the grip) and it joins the circle in a swirl of sparks. When a wand sleeps or leaves, its avatar vanishes. It handles up to 7 wands, the usual Bluetooth LE connection limit.
- **An avatar per wand.** Each wizard or witch is built procedurally: robe, trim, pointed hat, beard or long hair, and a name like *Morwenna Starweaver*. The look comes from the wand's name, so the same wand always gets the same character. On joining, the wand buzzes and lights up in its avatar's colour, so everyone can tell which avatar is theirs.
- **Motion.** The wand's gyro and accelerometer are fused with web-wand's Mahony filter, which also learns the sensor's axis alignment. Each avatar mirrors its wand: point at the TV and the avatar points out, with a slight turn to the side so the wand reads side-on. Two-bone IK moves the arm, and the head and body follow the wand.
- **Spells.** When the wand recognises a spell, the avatar casts it: Lumos lights the tip, Incendio throws fire, Aguamenti a water arc, Protego a shield bubble, levitation spells lift the caster, and so on. Unknown spells burst in a colour of their own. The wand answers with web-wand's light-and-buzz effects. Holding all four grip buttons leaves a glowing trail from the tip.

**Remote:** **OK** re-centres every wand (point them at the TV first, since there's no compass, so heading drifts slowly). **Menu** summons or dismisses three demo wizards, for trying it without wands.

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
| Motion | `www/tracker.js`, `www/orientation.js` | Per-wand fusion and alignment learning, as in web-wand's Motion card. |
| Scene | `www/stage.js`, `www/avatar.js`, `www/app.js` | three.js stone circle, avatars, IK, particle spells, HUD. |

`wand.js`, `orientation.js` and `demo.js` are copied from web-wand (commit `8710e12`). three.js r160 is vendored, so the app runs offline.

## Credits

The wand protocol comes from community reverse-engineering, mainly [eigger/hass-magic-caster-wand](https://github.com/eigger/hass-magic-caster-wand) (MIT), by way of [web-wand](https://github.com/rayhe/web-wand). The avatars, names and scene are original.

This is an unofficial fan project, not affiliated with or endorsed by Warner Bros., Wizarding World or the wand's makers. Harry Potter is a trademark of Warner Bros. Entertainment Inc.

## License

[MIT](LICENSE)
