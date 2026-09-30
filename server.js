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
const crypto = require('crypto');
const mqtt = require('mqtt');
const { Server: SocketIOServer } = require('socket.io');

const config = require('./config.json');
const store = require('./store');
// Environment variables override config.json (cloud hosts like Render inject these)
const MQTT_EMBEDDED = process.env.MQTT_EMBEDDED
  ? process.env.MQTT_EMBEDDED !== 'false'
  : config.mqtt.embeddedBroker;
const MQTT_HOST = process.env.MQTT_HOST || config.mqtt.host;
const MQTT_PORT = parseInt(process.env.MQTT_PORT || config.mqtt.port, 10) || 1883;
const PORT = parseInt(process.env.PORT || config.httpPort, 10) || 3000;
const PREFIX = process.env.MQTT_PREFIX || config.mqtt.prefix;
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
/* Sessions (HMAC-signed cookie, no extra dependencies)                */
/* ------------------------------------------------------------------ */
const SESSION_COOKIE = 'sp_session';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
let SESSION_SECRET = '';
try {
  SESSION_SECRET = fs.readFileSync(SECRET_FILE, 'utf8').trim();
} catch {}
if (!SESSION_SECRET) {
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(SECRET_FILE, SESSION_SECRET);
  } catch (e) {
    log('could not persist session secret:', e.message);
  }
}

const sign = (v) => crypto.createHmac('sha256', SESSION_SECRET).update(v).digest('hex');
const sessionCookie = (token) =>
  `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;

function makeSessionToken(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function readSessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const i = token.lastIndexOf('.');
  if (i <= 0) return null;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(payload)))) return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return data.u && Date.now() <= data.exp ? String(data.u) : null;
  } catch {
    return null;
  }
}
function currentUser(req) {
  const cookie = (req.headers.cookie || '')
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(SESSION_COOKIE + '='));
  if (!cookie) return null;
  try {
    return readSessionToken(decodeURIComponent(cookie.slice(SESSION_COOKIE.length + 1)));
  } catch {
    return null;
  }
}

/* ---------- passwords (salted scrypt from node:crypto) ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    const h = crypto.scryptSync(pw, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
  } catch {
    return false;
  }
}

/* ---------- active reservations (slotId -> reservation) ---------- */
const activeRes = new Map();

async function refreshActiveReservations() {
  try {
    const list = await store.listReservations(500);
    const now = Date.now();
    activeRes.clear();
    for (const r of list) {
      if (r.status === 'active' && new Date(r.endsAt).getTime() > now) activeRes.set(r.slotId, r);
    }
  } catch (e) {
    log('could not load reservations:', e.message);
  }
}

function slotView(slot) {
  return Object.assign({}, slot, { reservation: activeRes.get(slot.id) || null });
}

/* ------------------------------------------------------------------ */
/* Embedded MQTT broker                                                */
/* ------------------------------------------------------------------ */
if (MQTT_EMBEDDED) {
  const aedes = require('aedes')();
  net.createServer(aedes.handle).listen(MQTT_PORT, () => {
    log(`Embedded MQTT broker listening on tcp://0.0.0.0:${MQTT_PORT}`);
    log(`Point Arduino nodes at this machine's LAN IP, port ${MQTT_PORT} (run "ipconfig" to find it)`);
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
app.use(express.json());
app.get('/api/health', (req, res) => res.json({ ok: true, uptimeSec: Math.round(process.uptime()), slots: slots.size }));
app.get('/api/slots', (req, res) => res.json([...slots.values()].map(slotView)));
app.get('/api/stats', (req, res) => res.json(computeStats()));
app.get('/api/events', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, config.historyLimit);
  res.json(events.slice(-limit).reverse()); // newest first
});

/* ------------------------- auth ------------------------- */
app.post('/api/auth/signup', async (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) {
    return res.status(400).json({ error: 'username must be 3–24 letters, numbers or _' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'password must be at least 6 characters' });
  }
  try {
    await store.createUser({ username, passwordHash: hashPassword(password) });
    log(`account created: ${username} (store: ${store.mode})`);
    res.setHeader('Set-Cookie', sessionCookie(makeSessionToken(username)));
    res.json({ ok: true, username });
  } catch (e) {
    if (e.code === 'duplicate') return res.status(409).json({ error: 'username already taken' });
    log('signup failed:', e.message);
    res.status(500).json({ error: 'could not create account' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const username = String((req.body && req.body.username) || '').trim();
  try {
    const user = await store.getUserByUsername(username);
    if (!user || !verifyPassword(String((req.body && req.body.password) || ''), user.passwordHash)) {
      return res.status(401).json({ error: 'wrong username or password' });
    }
    res.setHeader('Set-Cookie', sessionCookie(makeSessionToken(user.username)));
    res.json({ ok: true, username: user.username });
  } catch (e) {
    log('login failed:', e.message);
    res.status(500).json({ error: 'login failed' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => res.json({ username: currentUser(req) }));

/* --------------------- reservations --------------------- */
app.post('/api/reservations', async (req, res) => {
  const username = currentUser(req);
  if (!username) return res.status(401).json({ error: 'sign in first' });

  const slotId = String((req.body && req.body.slotId) || '').trim();
  const minutes = Math.min(Math.max(parseInt((req.body && req.body.minutes) || 60, 10) || 60, 5), 480);
  if (!slots.has(slotId)) return res.status(404).json({ error: 'unknown slot' });
  if (slots.get(slotId).occupied) return res.status(409).json({ error: 'slot is physically occupied right now' });
  if (activeRes.has(slotId)) return res.status(409).json({ error: 'slot is already reserved' });

  try {
    const mine = await store.listReservations(200);
    if (mine.some((r) => r.username === username && r.status === 'active' && new Date(r.endsAt).getTime() > Date.now())) {
      return res.status(409).json({ error: 'you already have an active reservation' });
    }
    const reservation = await store.createReservation({
      id: crypto.randomUUID(),
      slotId,
      username,
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + minutes * 60000).toISOString(),
    });
    activeRes.set(slotId, reservation);
    recordEvent({ ts: Date.now(), slotId, type: 'reserved', username, endsAt: reservation.endsAt });
    log(`slot ${slotId} reserved by ${username} until ${reservation.endsAt}`);
    io.emit('slot', slotView(slots.get(slotId)));
    res.json({ ok: true, reservation });
  } catch (e) {
    log('reservation failed:', e.message);
    res.status(500).json({ error: 'could not save reservation' });
  }
});

app.post('/api/reservations/:id/release', async (req, res) => {
  const username = currentUser(req);
  if (!username) return res.status(401).json({ error: 'sign in first' });
  try {
    const r = await store.getReservation(req.params.id);
    if (!r) return res.status(404).json({ error: 'unknown reservation' });
    if (r.username !== username) return res.status(403).json({ error: 'not your reservation' });
    if (r.status !== 'active') return res.status(409).json({ error: 'reservation is not active' });
    await store.updateReservationStatus(r.id, 'released');
    if (activeRes.get(r.slotId) && activeRes.get(r.slotId).id === r.id) {
      activeRes.delete(r.slotId);
      if (slots.has(r.slotId)) io.emit('slot', slotView(slots.get(r.slotId)));
    }
    recordEvent({ ts: Date.now(), slotId: r.slotId, type: 'reservation-released', username });
    res.json({ ok: true });
  } catch (e) {
    log('release failed:', e.message);
    res.status(500).json({ error: 'could not release reservation' });
  }
});

app.get('/api/reservations', async (req, res) => {
  try {
    res.json(await store.listReservations(50));
  } catch (e) {
    res.status(500).json({ error: 'could not list reservations' });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer);

io.on('connection', (sock) => {
  sock.emit('init', {
    siteName: config.siteName,
    serverTime: Date.now(),
    brokerConnected,
    slots: [...slots.values()].map(slotView),
    events: events.slice(-60).reverse(),
    stats: computeStats(),
  });
});

httpServer.listen(PORT, () => {
  log(`Dashboard:  http://localhost:${PORT}`);
  log(`store: ${store.mode} | mqtt: ${MQTT_EMBEDDED ? 'embedded' : `external ${MQTT_HOST}:${MQTT_PORT}`} | prefix: ${PREFIX}`);
  refreshActiveReservations();
  // expire due reservations every 30 s and push the change to all clients
  const resweep = setInterval(async () => {
    try {
      const expired = await store.expireDueReservations();
      for (const r of expired) {
        if (activeRes.get(r.slotId) && activeRes.get(r.slotId).id === r.id) {
          activeRes.delete(r.slotId);
          if (slots.has(r.slotId)) io.emit('slot', slotView(slots.get(r.slotId)));
        }
        recordEvent({ ts: Date.now(), slotId: r.slotId, type: 'reservation-expired', username: r.username });
        log(`reservation on slot ${r.slotId} (${r.username}) expired`);
      }
    } catch {}
  }, 30000);
  if (resweep.unref) resweep.unref();
});

/* ------------------------------------------------------------------ */
/* MQTT client (server side)                                           */
/* ------------------------------------------------------------------ */
let brokerConnected = false;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const statusRe = new RegExp(`^${escapeRe(PREFIX)}/slot/([^/]+)/status$`);
const availRe = new RegExp(`^${escapeRe(PREFIX)}/slot/([^/]+)/availability$`);

const client = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
  clientId: 'smart-parking-server-' + Math.random().toString(16).slice(2, 8),
  clean: true,
  reconnectPeriod: 3000,
  connectTimeout: 8000,
});

client.on('connect', () => {
  brokerConnected = true;
  io.emit('broker', true);
  log(`Connected to MQTT broker ${MQTT_HOST}:${MQTT_PORT}`);
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
    io.emit('slot', slotView(slot));
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
    io.emit('slot', slotView(slot));
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
