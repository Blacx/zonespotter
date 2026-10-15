// ZoneSpotter receiver for the micro:bit  (MakeCode)
//
// This code only uses blocks, so you can paste it in the JavaScript tab and then click
// "Blocks" to see it as blocks. Or build the same blocks by hand: see microbit-blocks.md.
//
// How to use:
//   1. Go to https://makecode.microbit.org and start a New Project.
//   2. Switch to the JavaScript tab and paste ALL of this code over what is there.
//   3. Add the Bluetooth extension if MakeCode asks (and remove Radio, they cannot be used together).
//   4. IMPORTANT: set Project Settings -> "No Pairing" (see README.md, "micro:bit setup").
//   5. Click "Blocks" to look at it, then download the program to the micro:bit.
//
// ZoneSpotter sends one line of text each time something changes:
//   - the NAME of the zone someone stepped into (for example: stop_car)
//   - the word CLEAR when every zone is empty
//
// What you should see:
//   - a tick when ZoneSpotter connects, then ONE small dot in the middle = connected and waiting
//   - the zone's name scrolling across the LEDs when someone steps into a zone
//   - back to the single dot when the zones are empty
//   - a cross when the connection is lost. A completely blank screen means the micro:bit crashed.

let zone = ""
bluetooth.startUartService()
bluetooth.onBluetoothConnected(function () {
    basic.showIcon(IconNames.Yes)
    basic.pause(600)
    basic.clearScreen()
    led.plot(2, 2)
})
bluetooth.onBluetoothDisconnected(function () {
    basic.showIcon(IconNames.No)
})
bluetooth.onUartDataReceived(serial.delimiters(Delimiters.NewLine), function () {
    zone = bluetooth.uartReadUntil(serial.delimiters(Delimiters.NewLine))
    if (zone == "CLEAR") {
        basic.clearScreen()
        led.plot(2, 2)
    } else {
        basic.showString(zone, 60)
    }
})
