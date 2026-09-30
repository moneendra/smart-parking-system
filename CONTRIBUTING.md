# Contributing

Thanks for your interest in improving the Smart Parking System!

## Project structure in one minute

- `server.js` — central server: embedded MQTT broker (aedes), slot state,
  event history, REST API, Socket.IO push to the dashboard.
- `public/` — the dashboard (plain HTML/CSS/JS + Socket.IO client, no build step).
- `firmware/smart_parking_uno_serial/` — Arduino Uno sketch (USB-serial mode).
- `firmware/smart_parking_node.ino` + `config.h` — ESP32/ESP8266 sketch (Wi-Fi mode).
- `serial-bridge.js` — relays Uno USB-serial messages onto MQTT.
- `simulator.js` — fake devices for testing without hardware.

## Making changes

1. Fork / create a branch.
2. Server or scripts changed? Run the stack locally and try it:

   ```bash
   npm install
   npm start            # terminal 1
   npm run simulate     # terminal 2
   ```

3. Firmware changed? Compile it in Arduino IDE (Board: Arduino Uno for the
   serial sketch, ESP32 Dev Module for the wireless one) — CI can't compile
   Arduino code, so this check is on you.
4. Keep the MQTT topic contract documented in README §4 intact — external
   integrations depend on it.

## Commit style

Short imperative subject lines, e.g. `add device uptime to slot cards`,
`fix bridge reconnect loop`. PRs that add hardware variants (new boards,
sensors) are welcome — document the wiring in the README as part of the PR.
