# ZoneSpotter

A kid-friendly web app that uses AI vision to spot people's feet inside zones you draw on the camera picture, and tells a micro:bit over Bluetooth.

- Draw as many zones as you like (up to 12) and give each one a name.
- Each zone watches for one of two things (you choose when you save it):
  - 🦶 **Feet**: the AI finds a left or right **ankle** inside the zone. Works with several people at once.
  - 🏃 **Movement**: something **moves** inside the zone (no AI needed, so it also works when feet are hidden).
- When a zone is occupied, its name is sent to the micro:bit. When every zone is empty, the micro:bit receives `CLEAR`.
- Runs entirely in the browser. The camera picture never leaves the device. Zones and names are saved in that browser only (no accounts).

## Files

| File | What it is |
|---|---|
| `index.html`, `styles.css`, `app.js` | The website |
| `manifest.webmanifest`, `sw.js`, `icons/` | Lets people install it on a phone's home screen |
| `microbit-makecode.ts` | The program for the micro:bit (paste into MakeCode, then click **Blocks**) |
| `microbit-test.ts` | A tiny test program: shows a heart whenever a message arrives |
| `microbit-blocks.md` | The same program drawn as blocks, with a table of where each block lives |

There is no build step and no backend. It is plain static files.

## Try it on your computer

HTTPS or `localhost` is required by browsers for the camera and Bluetooth.

```
cd zonespotter
python3 -m http.server 8000
```

Open `http://localhost:8000` in **Chrome or Edge**.

## Put it on your website

1. Upload the whole `zonespotter` folder to your web host. It works from the site root or from a subfolder, because every path is relative.
2. Make sure it is served over **HTTPS**.
3. Link to it directly (for example `https://yoursite.com/zonespotter/`). Please do not embed it in an `<iframe>` unless you also add `allow="camera; bluetooth; fullscreen"` to the iframe.
4. If your site sends a strict `Content-Security-Policy` or `Permissions-Policy` header, it must allow:
   - scripts from `https://unpkg.com` (the ml5 library),
   - the AI model download from `tfhub.dev` (and whatever host it redirects to, check the browser's Network tab),
   - `camera=(self)` and `bluetooth=(self)`.
5. When you update the files later, change `CACHE = "zonespotter-v1"` in `sw.js` to `v2`, `v3`, and so on, so phones pick up the new version.

The first start downloads the AI model, so it needs an internet connection and takes a few seconds.

## Which devices work

| Device | Browser |
|---|---|
| Android phone or tablet | Chrome |
| Windows, Mac, Linux laptop | Chrome, Edge or Opera |
| Chromebook | Chrome |
| iPhone or iPad | **Bluefy** (free app). Safari cannot use Web Bluetooth. |

On a phone, use the browser menu's **Add to Home Screen / Install app** to open ZoneSpotter without browser bars. The camera and Bluetooth still work when it is installed.

The camera and the zone drawing work in any modern browser. Only the Bluetooth connection needs one of the browsers above.

## micro:bit setup

A **micro:bit V2** is strongly recommended. The V1 has so little memory that Bluetooth can crash it.

1. Open <https://makecode.microbit.org> and start a **New Project**.
2. Click the **JavaScript** tab and paste the contents of `microbit-makecode.ts`, then click **Blocks** to see it as blocks. (Prefer to build it block by block? Follow `microbit-blocks.md`.)
3. If MakeCode asks, add the **Bluetooth** extension and remove the **Radio** extension (they cannot be used together).
4. **Turn off pairing** (otherwise the micro:bit often does not show up in the browser's device list):
   - Click the gear icon, then **Project Settings**.
   - Set the Bluetooth option to **No Pairing**.
   - Click **Edit Settings As Text** and, in the Bluetooth section, make sure it contains `"pairing_mode": 0`:

   ```json
   "config": {
     "microbit-dal": {
       "bluetooth": {
         "open": 1,
         "pairing_mode": 0,
         "whitelist": 0,
         "security_level": null
       }
     }
   }
   ```
   This setting belongs to each MakeCode project, so repeat it for every new project.
5. Download the program to the micro:bit.
6. In ZoneSpotter, tap the 🤖 button and pick **BBC micro:bit [...]** from the list.

If the micro:bit is not listed or crashes after connecting, check step 4, make sure no other device is connected to it, and restart it.

## How the two zone types work

**Feet zones (AI).** The camera picture goes to **MoveNet** (through the ml5.js library), which finds the body points of every person it can see. ZoneSpotter looks at the **left and right ankle** points. An ankle counts only if the AI is at least 20% sure about it. If any ankle is inside the zone, the zone is "occupied". It becomes empty when a fresh AI result no longer shows an ankle in it (with a 0.3 second grace period against flicker). Because zones only change when fresh results arrive, a slow phone does not make zones flicker.

**Movement zones.** The picture is shrunk to a tiny copy and compared with the copy from a moment earlier, about 12 times a second. If enough pixels inside the zone changed brightness, the zone is "occupied" and stays that way for 0.6 seconds after the last movement. Things that stand still do not count. If more than half of the whole picture changes at once (camera shaken, lights switched), that frame is ignored. While only movement zones exist, the AI is switched off to save battery.

In both cases the micro:bit is sent the name of the most recently entered zone that is still occupied, or `CLEAR`. A message is sent only when it changes.

The settings are at the top of `app.js`: `ANKLE_CONFIDENCE`, `MIN_POSE_SCORE`, `MODEL_MAX_DIMENSION`, `HOLD_MS`, the `MOTION_*` values, `MAX_ZONES`, `MAX_TAG_LENGTH` and `COLORS`.

## Debug mode (hidden)

Shows what the AI really sees: a **skeleton for every person**, every body point, the **confidence of each ankle** (a hollow red ring means "too unsure, ignored"), how long one AI check takes, how many people and ankles it sees, how many bones and points were drawn, which AI engine is running (`webgl`, `webgpu`...), the last AI error if there was one, the video size, and the "moving %" of every movement zone.

Turn it on or off in any of these ways:
- add `?debug` to the address (`https://yoursite.com/zonespotter/?debug`),
- press the **D** key on a keyboard,
- tap the **"Sending ..." pill** at the top 5 times quickly (works on phones).

Debug mode is never remembered: it is off every time the page is opened, unless the address has `?debug`.

## If a zone does not trigger

Turn on debug mode and look:

| What you see | What it means | What to try |
|---|---|---|
| No skeleton at all | The AI does not see a person | More light, step back, make the person bigger in the picture |
| Skeleton, but no ankles (or the legs are cut off) | Feet are out of the picture or hidden | Tilt the camera down, step back, or use a **Movement** zone |
| Ankle shown as a hollow red ring | The AI is too unsure about the ankle (under 20%) | Better light, a plain floor, step closer; or lower `ANKLE_CONFIDENCE` |
| White ankle dot outside your zone | The zone is in the wrong place | Redraw it around where the ankles actually appear (ankles sit a little above the floor) |
| Skeleton is right and the dot is inside the zone, but nothing is sent | Bluetooth | Check the 🤖 button shows a green dot, see "micro:bit setup" |
| "AI ... ms" is more than about 400 | A slow device | Use a faster phone or laptop, or fewer people in the picture |

Debug mode also shows a `micro:bit ... sent N, last "..."` line, and a `bt error` line if sending fails. Tapping the **Sending ...** pill sends the current message again, which is handy for testing. See `microbit-blocks.md` ("Test the connection").

Small or faraway people are found more easily with a larger `MODEL_MAX_DIMENSION` (320 or 384, in `app.js`), but the AI then runs slower.

## Rules for zone names

- Letters, numbers and `_` only. Spaces turn into `_` automatically, other symbols are removed.
- Up to 20 characters.
- `CLEAR` is reserved (it means all zones are empty).
- Capital letters matter. `Stop` and `stop` are different names in MakeCode.

## Tips for a good classroom demo

- Fix the camera in place (phone stand or tape) and draw zones **after** it is fixed. If the camera moves, the zones will not line up any more.
- Make sure feet and ankles are in the picture and not hidden behind furniture or other people.
- Good, even light helps a lot. Strong backlight (a window behind people) makes detection worse.
- Start with big zones on the floor, and test indoors with tape lines before trying anything outside.
- Feet zones need ankles in the picture. If only the upper body is visible (for example a laptop camera on a desk), use **Movement** zones.
- Phones are slower than laptops. If the dots on the ankles lag, move closer, reduce the number of people, or use a laptop.

## Important

ZoneSpotter is a learning project. AI vision misses people and sometimes sees people who are not there, so it must never be used as a real traffic or safety system. Real crossings need real crossing guards, signs and signals.
