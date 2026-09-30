/**
 * Smart Parking System — Device Simulator
 * ---------------------------------------
 * Emulates ESP32 IR-sensor nodes so the whole pipeline can be demoed
 * without hardware. Each simulated slot is its own MQTT client (with a
 * Last-Will, exactly like the real device) publishing the same JSON on
 * the same topics as the Arduino sketch.
 *
 * Usage:
 *   node simulator.js               # 4 slots, random activity
 *   node simulator.js --slots 8     # 8 slots
 *
 * Ctrl+C publishes "offline" for every simulated device (clean shutdown).
 */
'use strict';

const mqtt = require('mqtt');
const config = require('./config.json');

const PREFIX = config.mqtt.prefix;
const URL = `mqtt://${config.mqtt.host}:${config.mqtt.port}`;

function intArg(name, def) {
  const i = process.argv.indexOf(name);
  if (i === -1 || !process.argv[i + 1]) return def;
  const n = parseInt(process.argv[i + 1], 10);
  return Number.isFinite(n) ? n : def;
}
const SLOT_COUNT = Math.max(1, Math.min(20, intArg('--slots', 4)));

const rand = (min, max) => Math.floor(min + Math.random() * (max - min));
const clock = () => new Date().toLocaleTimeString();
const fmtDur = (ms) => {
  const s = Math.round(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

const slots = [];
for (let i = 0; i < SLOT_COUNT; i++) {
  slots.push({ id: `S${i + 1}`, occupied: false, since: null, seq: 0, client: null, timer: null });
}

function publish(s, occupied) {
  s.seq++;
  const since = s.since;
  s.occupied = occupied;
  s.since = occupied ? Date.now() : null;
  s.client.publish(
    `${PREFIX}/slot/${s.id}/status`,
    JSON.stringify({ slot: s.id, occupied, deviceTimeMs: s.seq * 1000, seq: s.seq }),
    { qos: 1, retain: true }
  );
  const dur = !occupied && since ? Date.now() - since : null;
  console.log(
    `[${clock()}] ${s.id.padEnd(3)} → ${occupied ? 'BOOKED  (hand placed on IR sensor)' : 'FREE    (hand removed)'}` +
      (dur ? `   session ${fmtDur(dur)}` : '')
  );
}

function schedule(s) {
  // hand stays on the sensor 6–28 s, slot then stays free 4–16 s
  const delay = s.occupied ? rand(6000, 28000) : rand(4000, 16000);
  s.timer = setTimeout(() => {
    publish(s, !s.occupied);
    schedule(s);
  }, delay);
}

console.log(`Smart Parking simulator → ${URL}`);
console.log(`Topics: ${PREFIX}/slot/S1..S${SLOT_COUNT}/{status,availability}`);
console.log('S1 will be "booked" a few seconds after start so you can see it live.\n');

for (const s of slots) {
  s.client = mqtt.connect(URL, {
    clientId: `sim-${s.id}-${Math.random().toString(16).slice(2, 6)}`,
    clean: true,
    reconnectPeriod: 3000,
    will: { topic: `${PREFIX}/slot/${s.id}/availability`, payload: 'offline', qos: 1, retain: true },
  });
  s.client.on('connect', () => {
    s.client.publish(`${PREFIX}/slot/${s.id}/availability`, 'online', { qos: 1, retain: true });
    publish(s, false); // every slot starts FREE (retained, so the server syncs instantly)
    schedule(s);
    if (s.id === 'S1') setTimeout(() => publish(s, true), 2500); // immediate demo booking
  });
  s.client.on('error', (e) => console.log(`[${clock()}] ${s.id} mqtt error: ${e.message}`));
}

process.on('SIGINT', () => {
  console.log('\nsimulator stopping — marking devices offline…');
  for (const s of slots) {
    clearTimeout(s.timer);
    try {
      s.client.publish(`${PREFIX}/slot/${s.id}/availability`, 'offline', { qos: 1, retain: true });
      s.client.end(false);
    } catch {}
  }
  setTimeout(() => process.exit(0), 400);
});
