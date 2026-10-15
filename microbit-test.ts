// ZoneSpotter connection TEST program for the micro:bit (MakeCode)
//
// Use this to find out where a message gets lost. Paste it over your program (JavaScript tab),
// keep Bluetooth extension + Project Settings "No Pairing", download it, then connect from ZoneSpotter.
//
// What you will see:
//   tick   = Bluetooth connected
//   heart  = a message ARRIVED at the micro:bit (this happens before anything else)
//   then the text of the message scrolls across the LEDs
//
//   tick but never a heart  -> the message does not reach the micro:bit's UART (see microbit-blocks.md)
//   heart but no text       -> the message arrived, reading it failed
//   heart + text            -> everything works, put your real program back

bluetooth.startUartService()
bluetooth.onBluetoothConnected(function () {
    basic.showIcon(IconNames.Yes)
})
bluetooth.onBluetoothDisconnected(function () {
    basic.showIcon(IconNames.No)
})
bluetooth.onUartDataReceived(serial.delimiters(Delimiters.NewLine), function () {
    basic.showIcon(IconNames.Heart)
    basic.pause(400)
    basic.showString(bluetooth.uartReadUntil(serial.delimiters(Delimiters.NewLine)), 60)
})
