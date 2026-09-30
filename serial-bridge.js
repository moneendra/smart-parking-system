/**
 * Smart Parking System — Serial → MQTT bridge (for Arduino Uno nodes)
 * -------------------------------------------------------------------
 * The Uno has no network hardware, so it streams JSON status lines over
 * its USB cable. This script opens that serial port and republishes each
 * line to the central MQTT broker with the exact topics/payloads the
 * ESP32 node uses — the server and dashboard can't tell the difference.
 *
 *   Uno USB  ──serial──►  serial-bridge.js (this PC)  ──MQTT──►  server.js
 *
 * Usage (from the project folder, with server.js already running):
 *   node tools/../../serial-bridge.js                 → auto-detect the Uno's port
 *   node serial-bridge.js --port COM3 --slot S1      → explicit port
 *   node serial-bridge.js --list                     → just show available ports
 *
 * Multiple Unos: run one bridge per Uno with its own --port.
 * NOTE: the bridge owns the serial port — close it (Ctrl+C) before
 * uploading a new sketch from the Arduino IDE.
 */
'use strict';

const mqtt = require('mqtt');

/* portable-node-friendly: run with tools/node/node.exe serial-bridge.js */
const config = require('./config.json');
const PREFIX = config.mqtt.prefix;
const MQTT_URL = `mqtt://${config.mqtt.host}:${config.mqtt.port}`;

/* ---------- args ---------- */
function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const hasFlag = (name) => process.argv.includes(name);
const PORT_ARG = arg('--port', null);
const SLOT_DEFAULT = arg('--slot', null);
const BAUD = parseInt(arg('--baud', '9600'), 10);
const log = (...a) => console.log(`[${new Date().toLocaleTimeString()}]`, ...a);

/* ---------- serial port selection ---------- */
async function pickPort() {
  const { SerialPort } = require('serialport');
  const ports = (await SerialPort.list()).filter((p) => p.path && !/Bluetooth|COM1$/i.test(p.path));

  if (hasFlag('--list')) {
    console.log('Available serial ports:');
    ports.forEach((p) =>
      console.log(`  ${p.path.padEnd(10)} ${(p.friendlyName || '').padEnd(38)} ${p.serialNumber || ''}`)
    );
    process.exit(0);
  }

  if (PORT_ARG) {
    const found = ports.find((p) => p.path.toLowerCase() === PORT_ARG.toLowerCase());
    if (!found) throw new Error(`port ${PORT_ARG} not found`);
    return found;
  }

  const arduinoLike = ports.filter((p) =>
    /arduino|ch340|ch341|wch|ftdi|usb.?serial|usb.?uart|atmel/i.test(
      `${p.friendlyName || ''} ${p.path}`
    )
  );
  if (arduinoLike.length === 1) return arduinoLike[0];
  if (ports.length === 1) return ports[0];

  throw new Error(
    'could not auto-detect the Uno. Available ports:\n  ' +
      (ports.length
        ? ports.map((p) => `${p.path} — ${p.friendlyName || 'unknown'}`).join('\n  ')
        : '(none — is the Uno plugged in?)') +
      '\nRun "node serial-bridge.js --list" or pass --port COMx'
  );
}

/* ---------- MQTT client ---------- */
let slotAvailability = new Map(); // slotId -> published online?
const mqttClient = mqtt.connect(MQTT_URL, {
  clientId: 'serial-bridge-' + Math.random().toString(16).slice(2, 8),
  clean: true,
  reconnectPeriod: 3000,
});

mqttClient.on('connect', () => log(`connected to MQTT broker ${MQTT_URL}`));
mqttClient.on('error', (e) => log('MQTT error:', e.message));

function publishStatus(slotId, obj) {
  const topic = `${PREFIX}/slot/${slotId}/status`;
  mqttClient.publish(topic, JSON.stringify(obj), { retain: true });
  if (!slotAvailability.get(slotId)) {
    slotAvailability.set(slotId, true);
    // announce + program the LWT the moment we first see this slot
    mqttClient.publish(`${PREFIX}/slot/${slotId}/availability`, 'online', { retain: true });
    log(`slot ${slotId} online (via USB serial)`);
  }
}

function markAllOffline() {
  for (const slotId of slotAvailability.keys()) {
    mqttClient.publish(`${PREFIX}/slot/${slotId}/availability`, 'offline', { retain: true });
    log(`slot ${slotId} offline (bridge stopping)`);
  }
}
process.on('SIGINT', () => {
  log('stopping bridge…');
  markAllOffline();
  setTimeout(() => process.exit(0), 400);
});

/* ---------- serial reading ---------- */
let serial; // handle for reopen loop
let lineBuf = '';
let opening = false;

async function openSerial() {
  if (opening) return;
  opening = true;
  try {
    const info = await pickPort();
    const { SerialPort } = require('serialport');
    log(`opening ${info.path} @ ${BAUD} baud (${info.friendlyName || 'serial device'})`);

    serial = new SerialPort({ path: info.path, baudRate: BAUD, autoOpen: true });
    serial.on('open', () => {
      opening = false;
      lineBuf = '';
    });
    serial.on('data', (chunk) => {
      lineBuf += chunk.toString('utf8');
      let nl;
      while ((nl = lineBuf.indexOf('\n')) !== -1) {
        handleLine(lineBuf.slice(0, nl).trim());
        lineBuf = lineBuf.slice(nl + 1);
      }
    });
    serial.on('error', (e) => {
      opening = false;
      const busy = /access denied|busy|EBUSY|EACCES/i.test(e.message);
      log(`serial error: ${e.message}${busy ? ' — close the Arduino Serial Monitor (or another bridge) and I will retry' : ' — retrying in 5 s'}`);
      setTimeout(openSerial, 5000);
    });
    serial.on('close', () => {
      opening = false;
      log('serial port closed — retrying in 5 s');
      setTimeout(openSerial, 5000);
    });
  } catch (e) {
    opening = false;
    log(e.message);
    log('retrying in 5 s…');
    setTimeout(openSerial, 5000);
  }
}

function handleLine(line) {
  if (!line) return;
  if (!line.startsWith('{')) {
    log(`uno says: ${line}`); // debug prints from the sketch, shown as-is
    return;
  }
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return; // torn line right after (re)connect — next full line will arrive
  }
  const slotId = String(obj.slot || SLOT_DEFAULT || 'S1');
  if (typeof obj.occupied !== 'boolean') {
    log(`ignored malformed status for ${slotId}: ${line}`);
    return;
  }
  const wait = () => (mqttClient.connected ? publishStatus(slotId, obj) : mqttClient.once('connect', () => publishStatus(slotId, obj)));
  wait();
}

/* ---------- go ---------- */
log(`Serial→MQTT bridge for Smart Parking (broker ${MQTT_URL}, prefix ${PREFIX})`);
openSerial();
