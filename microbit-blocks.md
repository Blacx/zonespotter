# ZoneSpotter micro:bit program as blocks

Build this in <https://makecode.microbit.org> (New Project). Three ways, pick one:

1. **Paste and convert (fastest):** open the **JavaScript** tab, paste all of `microbit-makecode.ts`, then click **Blocks**. MakeCode turns it into the blocks below.
2. **Build it by hand:** follow the picture and the table below.
3. **Then:** do the two one-time settings at the bottom (extension and *No pairing*).

## The finished blocks

```
┌─ on start ───────────────────────────────┐
│  set [zone] to [ "" ]                    │
│  start UART service                      │
└──────────────────────────────────────────┘

┌─ on Bluetooth connected ─────────────────┐
│  show icon [✔ yes]                       │
│  pause (ms) [600]                        │
│  clear screen                            │
│  plot x [2] y [2]                        │
└──────────────────────────────────────────┘

┌─ on Bluetooth disconnected ──────────────┐
│  show icon [✖ no]                        │
└──────────────────────────────────────────┘

┌─ on UART data received  delimiter [new line] ─────────────────────┐
│  set [zone] to [ UART read until [new line] ]                     │
│  if < [zone] = [ "CLEAR" ] > then                                 │
│      clear screen                                                 │
│      plot x [2] y [2]                                             │
│  else                                                             │
│      show string [zone]                                           │
└───────────────────────────────────────────────────────────────────┘
```

## Where to find each block

| Block | Drawer in MakeCode |
|---|---|
| `on start` | Basic |
| `set zone to ""` | Variables (click **Make a Variable**, name it `zone`) |
| `start UART service` | Bluetooth (the drawer appears after you add the extension) |
| `on Bluetooth connected`, `on Bluetooth disconnected` | Bluetooth |
| `on UART data received delimiter new line` | Bluetooth |
| `UART read until new line` | Bluetooth |
| `if ... then ... else` | Logic (click the **+** or the gear on the block to add the `else` part) |
| `zone = "CLEAR"` | Logic: take the `0 = 0` block, put the `zone` variable on the left and a text block `"CLEAR"` on the right (Text drawer) |
| `show icon`, `pause`, `clear screen`, `show string` | Basic (`clear screen` is under **… more**) |
| `plot x 2 y 2` | Led |

Type `CLEAR` in capitals. It is the word ZoneSpotter sends when every zone is empty.

## Make it react to your own zones

The program above scrolls the zone's name across the LEDs. To do something special for a zone, add an `else if` for it **before** the final `else`:

1. Click the **gear** on the `if` block and drag an **else if** into the stack, between `if` and `else`.
2. In the new `else if` put the test `zone = "stop_car"` (use your zone's exact name, capitals matter).
3. Under it, add what should happen, for example `show icon [✖ no]`, or `play tone [Middle C] for [1/2 beat]` from the Music drawer.

```
  if < zone = "CLEAR" > then
      clear screen
      plot x [2] y [2]
  else if < zone = "stop_car" > then
      show icon [✖ no]
      play tone [Middle C] for [1/2 beat]
  else if < zone = "slow" > then
      show icon [😮 surprised]
  else
      show string [zone]
```

## What you should see

| On the micro:bit | Meaning |
|---|---|
| ✔ tick, then **one dot in the middle** | Connected, nobody is in a zone |
| The zone's name scrolls across | Someone stepped into that zone |
| Back to the single dot | All zones are empty again |
| ✖ cross | The connection was lost (tap 🤖 in ZoneSpotter to reconnect) |
| **Completely blank screen** | The micro:bit crashed or is not running this program. Press reset. A micro:bit V1 often crashes with Bluetooth, so use a V2. |

A blank screen right after connecting is **not** normal in this version of the program. (An older version cleared the screen on `CLEAR`, which looked like the board had died.)

## Test the connection

1. Connect the micro:bit in ZoneSpotter. You should see the ✔ tick and then the single dot.
2. Turn on debug mode (add `?debug` to the address). Look at the line `micro:bit connected, sent N, last "..."`. `sent` must go up when zones change.
3. Tap the **"Sending ..." pill** once. It sends the current message again. Put a zone name in a zone to make the micro:bit scroll it.
4. If `sent` goes up but the micro:bit shows nothing: the program is not reading the message. Check the `on UART data received` block uses delimiter **new line** (not a comma or anything else) and that `start UART service` is in `on start`.
5. If a `bt error` line appears, or a "Could not send" message: disconnect and reconnect, restart the micro:bit, and close any other app or tab connected to it.

## Still nothing on the micro:bit? Use the test program

`microbit-test.ts` is a tiny program that shows a **heart** the moment any message arrives, then scrolls the text. Paste it in the JavaScript tab, download it, connect from ZoneSpotter and tap the **Sending ...** pill (it sends the current message again, `CLEAR` when nobody is in a zone).

| You see | What it means |
|---|---|
| ✔ tick, never a heart | The message never reaches the micro:bit. Check **No Pairing**, the Bluetooth extension, restart the micro:bit, and close other apps connected to it. Test with a phone app that speaks the "Nordic UART" service (nRF Toolbox, "Serial Bluetooth Terminal" in BLE mode): send `hello` followed by a new line. If that does not show a heart either, it is the micro:bit program or its settings, not ZoneSpotter. |
| ♥ heart, but no text | The message arrived but was not read. Make sure both blocks use the delimiter **new line**. |
| ♥ heart, then the text scrolls | The connection works. Put your real program back. |

## One-time settings (needed for the program to work)

1. Click **Extensions** (under the gear or at the bottom of the toolbox), add **Bluetooth**. If MakeCode says it must remove **Radio**, accept: they cannot be used together.
2. Click the **gear** (top right) → **Project Settings** → set **Bluetooth** to **No Pairing**. Without this, the micro:bit often does not appear in the browser's device list.
3. Click **Download** and copy the file to the micro:bit.

Then in ZoneSpotter tap 🤖 and choose **BBC micro:bit [...]**.
