/**
 * Smart Parking System — Central Server
 * -------------------------------------
 * 1. Runs an embedded MQTT broker (aedes) so the whole system works with
 *    zero external infrastructure (set mqtt.embeddedBroker=false in
 *    config.json to use an external broker such as Mosquitto instead).
 * 2. Subscribes to slot topics published by the Arduino/ESP32 IR nodes.
 * 3. Keeps current slot state + event history (persisted to data/data.json).
 * 4. Serves the real-time web dashboard (Express + Socket.IO) and a REST API.
 *
 * Topics (PREFIX = config.mqtt.prefix, e.g. "smartparking/demo01"):
 *   PREFIX/slot/<ID>/status        {"slot":"S1","occupied":true,"deviceTimeMs":12345,"seq":7}   (retained)
 *   PREFIX/slot/<ID>/availability  "online" | "offline"                                        (retained, LWT)
 */
'use strict';

const express = require('express');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');
const { Server: SocketIOServer } = require('socket.io');

const config = require('./config.json');
const PREFIX = config.mqtt.prefix;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

const log = (...a) =>
  console.log(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}]`, ...a);

const fmtDur = (ms) => {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};

/* ------------------------------------------------------------------ */
/* Embedded MQTT broker                                                */
/* ------------------------------------------------------------------ */
if (config.mqtt.embeddedBroker) {
  const aedes = require('aedes')();
  net.createServer(aedes.handle).listen(config.mqtt.port, () => {
    log(`Embedded MQTT broker listening on tcp://0.0.0.0:${config.mqtt.port}`);
    log(`Point Arduino nodes at this machine's LAN IP, port ${config.mqtt.port} (run "ipconfig" to find it)`);
  });
}

/* ------------------------------------------------------------------ */
/* State + persistence                                                 */
/* ------------------------------------------------------------------ */
const slots = new Map(); // slotId -> { id, occupied, since, lastSeen, deviceTimeMs, online, seq }
let events = [];         // newest last: { ts, slotId, type, durationMs? }

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(
    DATA_FILE,
    JSON.stringify(
      { savedAt: Date.now(), slots: [...slots.values()], events: events.slice(-config.historyLimit) },
      null,
      2
    )
  );
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      save();
    } catch (err) {
      log('save failed:', err.message);
    }
  }, 500);
}

(function load() {
  try {
    if (!fs.existsSync(DATA_FILE)) return;
    const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    for (const s of data.slots || []) {
      s.online = false; // devices must re-announce after a server restart
      slots.set(s.id, s);
    }
    events = data.events || [];
    log(`Restored ${slots.size} slot(s) and ${events.length} event(s) from data/data.json`);
  } catch (err) {
    log('could not restore data file:', err.message);
  }
})();

function upsertSlot(id) {
  if (!slots.has(id)) {
    slots.set(id, { id, occupied: false, since: null, lastSeen: null, deviceTimeMs: null, online: false, seq: null });
  }
  return slots.get(id);
}

function computeStats() {
  const list = [...slots.values()];
  const occupied = list.filter((s) => s.occupied).length;
  return {
    total: list.length,
    occupied,
    free: list.length - occupied,
    occupancyRate: list.length ? Math.round((occupied * 100) / list.length) : 0,
  };
}

function recordEvent(evt) {
  events.push(evt);
  if (events.length > config.historyLimit) events = events.slice(-config.historyLimit);
  io.emit('event', evt);
  scheduleSave();
}

/* ------------------------------------------------------------------ */
/* HTTP server + dashboard                                             */
/* ------------------------------------------------------------------ */
const app = express();
app.get('/api/health', (req, res) => res.json({ ok: true, uptimeSec: Math.round(process.uptime()), slots: slots.size }));
app.get('/api/slots', (req, res) => res.json([...slots.values()]));
app.get('/api/stats', (req, res) => res.json(computeStats()));
app.get('/api/events', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, config.historyLimit);
  res.json(events.slice(-limit).reverse()); // newest first
});
app.use(express.static(path.join(__dirname, 'public')));

const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer);

io.on('connection', (sock) => {
  sock.emit('init', {
    siteName: config.siteName,
    serverTime: Date.now(),
    brokerConnected,
    slots: [...slots.values()],
    events: events.slice(-60).reverse(),
    stats: computeStats(),
  });
});

httpServer.listen(config.httpPort, () => {
  log(`Dashboard:  http://localhost:${config.httpPort}`);
});

/* ------------------------------------------------------------------ */
/* MQTT client (server side)                                           */
/* ------------------------------------------------------------------ */
let brokerConnected = false;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const statusRe = new RegExp(`^${escapeRe(PREFIX)}/slot/([^/]+)/status$`);
const availRe = new RegExp(`^${escapeRe(PREFIX)}/slot/([^/]+)/availability$`);

const client = mqtt.connect(`mqtt://${config.mqtt.host}:${config.mqtt.port}`, {
  clientId: 'smart-parking-server-' + Math.random().toString(16).slice(2, 8),
  clean: true,
  reconnectPeriod: 3000,
  connectTimeout: 8000,
});

client.on('connect', () => {
  brokerConnected = true;
  io.emit('broker', true);
  log(`Connected to MQTT broker ${config.mqtt.host}:${config.mqtt.port}`);
  client.subscribe([`${PREFIX}/slot/+/status`, `${PREFIX}/slot/+/availability`], (err) => {
    if (err) log('subscribe failed:', err.message);
  });
});

client.on('close', () => {
  if (brokerConnected) {
    brokerConnected = false;
    io.emit('broker', false);
    log('MQTT broker connection lost — retrying');
  }
});

client.on('error', (err) => log('MQTT error:', err.message));

client.on('message', (topic, payload) => {
  const text = payload.toString();

  let m = topic.match(statusRe);
  if (m) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      log(`bad JSON on ${topic}: ${text}`);
      return;
    }
    const id = String(msg.slot || m[1]);
    const now = Date.now();
    const slot = upsertSlot(id);
    const occupied = !!msg.occupied;

    if (occupied !== slot.occupied) {
      const durationMs = !occupied && slot.since ? now - slot.since : null;
      slot.occupied = occupied;
      slot.since = occupied ? now : null;
      recordEvent({ ts: now, slotId: id, type: occupied ? 'occupied' : 'free', durationMs });
      log(
        `slot ${id} → ${occupied ? 'BOOKED' : 'FREE'}` +
          (durationMs != null ? ` (session ${fmtDur(durationMs)})` : '')
      );
    }
    slot.lastSeen = now;
    slot.deviceTimeMs = msg.deviceTimeMs ?? null;
    slot.online = true;
    if (msg.seq != null) slot.seq = msg.seq;
    io.emit('slot', slot);
    scheduleSave();
    return;
  }

  m = topic.match(availRe);
  if (m) {
    const id = m[1];
    const online = text.trim() === 'online';
    const slot = upsertSlot(id);
    if (slot.online !== online) {
      slot.online = online;
      recordEvent({ ts: Date.now(), slotId: id, type: online ? 'device-online' : 'device-offline' });
      log(`device ${id} ${online ? 'online' : 'OFFLINE'}`);
    }
    io.emit('slot', slot);
    scheduleSave();
  }
});

/* graceful shutdown */
process.on('SIGINT', () => {
  log('shutting down…');
  try {
    save();
  } catch {}
  client.end();
  process.exit(0);
});
