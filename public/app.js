/* Smart Parking dashboard — live client (Socket.IO) */
'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  slots: new Map(),   // id -> {id, occupied, since, lastSeen, deviceTimeMs, online, seq}
  samples: [],        // chart history: {t, occ, total}
};

/* ---------- formatting helpers ---------- */
const pad = (n) => String(n).padStart(2, '0');
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleTimeString('en-GB') : '—');
const fmtDur = (ms) => {
  if (ms == null) return '—';
  const s = Math.floor(ms / 1000);
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
};
const ago = (ts) => {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

/* ---------- stats ---------- */
function updateStats() {
  const list = [...state.slots.values()];
  const occ = list.filter((s) => s.occupied).length;
  const total = list.length;
  $('#stat-total').textContent = total;
  $('#stat-occupied').textContent = occ;
  $('#stat-free').textContent = total - occ;
  $('#stat-rate').textContent = total ? Math.round((occ * 100) / total) : 0;
  $('#bar-fill').style.width = (total ? (occ * 100) / total : 0) + '%';
}

/* ---------- slot cards ---------- */
function slotCard(slot) {
  let card = document.getElementById('slot-' + slot.id);
  if (!card) {
    card = document.createElement('article');
    card.className = 'slot-card';
    card.id = 'slot-' + slot.id;
    card.innerHTML = `
      <div class="slot-top">
        <span class="slot-name">Slot ${slot.id}</span>
        <span class="device-dot" title="device online/offline"></span>
      </div>
      <span class="slot-status">…</span>
      <div class="slot-meta">
        <span>State since <b class="m-since">—</b></span>
        <span>Last update <b class="m-last">—</b></span>
        <span>Device uptime <b class="m-up">—</b></span>
      </div>`;
    const note = $('#empty-note');
    if (note) note.remove();
    $('#slots').appendChild(card);
  }
  card.classList.toggle('occupied', slot.occupied);
  card.querySelector('.device-dot').classList.toggle('on', !!slot.online);
  card.querySelector('.device-dot').title = slot.online ? 'Device online' : 'Device offline (last known state shown)';
  const st = card.querySelector('.slot-status');
  st.textContent = slot.occupied ? 'BOOKED' : 'AVAILABLE';
  card.querySelector('.m-since').textContent = slot.occupied ? fmtTime(slot.since) : '—';
  card.querySelector('.m-last').textContent = ago(slot.lastSeen);
  card.querySelector('.m-up').textContent = fmtDur(slot.deviceTimeMs);
  return card;
}

/* ---------- events table ---------- */
function eventRow(evt, prepend) {
  const body = $('#events-body');
  const ph = body.querySelector('tr.placeholder');
  if (ph) ph.remove();

  const map = {
    'occupied':       ['BOOKED', 'b-red'],
    'free':           ['FREED', 'b-green'],
    'device-online':  ['DEVICE ONLINE', 'b-blue'],
    'device-offline': ['DEVICE OFFLINE', 'b-gray'],
  };
  const [label, cls] = map[evt.type] || [evt.type.toUpperCase(), 'b-gray'];

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${fmtTime(evt.ts)}</td>
    <td><b>${evt.slotId}</b></td>
    <td><span class="badge ${cls}">${label}</span></td>
    <td>${evt.type === 'free' ? fmtDur(evt.durationMs) : '—'}</td>`;
  prepend ? body.prepend(tr) : body.appendChild(tr);

  while (body.children.length > 60) body.removeChild(body.lastChild);
}

/* ---------- occupancy chart (last 20 min, 5 s samples) ---------- */
function sample() {
  const list = [...state.slots.values()];
  state.samples.push({ t: Date.now(), occ: list.filter((s) => s.occupied).length, total: list.length });
  const cutoff = Date.now() - 21 * 60 * 1000;
  state.samples = state.samples.filter((p) => p.t >= cutoff);
  drawChart();
}

function drawChart() {
  const cv = $('#chart');
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const padL = 34, padR = 10, padT = 12, padB = 22;
  const iw = W - padL - padR, ih = H - padT - padB;
  const span = 20 * 60 * 1000;
  const now = Date.now();
  const x = (t) => padL + iw * (1 - (now - t) / span);
  const maxY = Math.max(1, ...state.samples.map((p) => p.total));
  const y = (v) => padT + ih * (1 - v / maxY);

  ctx.clearRect(0, 0, W, H);
  ctx.font = '11px "Segoe UI", sans-serif';

  // horizontal grid + y labels
  ctx.strokeStyle = 'rgba(38,48,77,0.9)';
  ctx.fillStyle = '#93a0bd';
  ctx.textAlign = 'right';
  for (let v = 0; v <= maxY; v++) {
    ctx.beginPath();
    ctx.moveTo(padL, y(v));
    ctx.lineTo(W - padR, y(v));
    ctx.stroke();
    ctx.fillText(String(v), padL - 6, y(v) + 4);
  }

  // vertical grid every 5 min + x labels
  ctx.textAlign = 'center';
  for (let m = 0; m <= 20; m += 5) {
    const px = x(now - m * 60 * 1000);
    ctx.beginPath();
    ctx.moveTo(px, padT);
    ctx.lineTo(px, padT + ih);
    ctx.stroke();
    ctx.fillText(m === 0 ? 'now' : `-${m}m`, px, H - 6);
  }

  if (state.samples.length < 2) return;

  const line = (key, color, width) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    state.samples.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p[key])) : ctx.moveTo(x(p.t), y(p[key]))));
    ctx.stroke();
  };
  line('total', '#38bdf8', 1.5);
  line('occ', '#ef4444', 2.5);
}

/* ---------- connection pills ---------- */
function setPill(el, up, upText, downText) {
  el.classList.toggle('up', up);
  el.classList.toggle('down', !up);
  el.querySelector('.pill-text').textContent = up ? upText : downText;
}

/* ---------- socket wiring ---------- */
const socket = io();

socket.on('connect', () => setPill($('#ws-pill'), true, 'Dashboard live', 'Dashboard offline'));
socket.on('disconnect', () => setPill($('#ws-pill'), false, 'Dashboard live', 'Dashboard offline'));

socket.on('broker', (up) => setPill($('#mqtt-pill'), up, 'MQTT broker', 'MQTT broker down'));

socket.on('init', (d) => {
  $('#site-name').textContent = d.siteName || 'Smart Parking';
  setPill($('#mqtt-pill'), d.brokerConnected, 'MQTT broker', 'MQTT broker down');
  state.slots = new Map(d.slots.map((s) => [s.id, s]));
  d.slots.forEach(slotCard);
  $('#events-body').innerHTML = '';
  (d.events || []).slice().reverse().forEach((e) => eventRow(e, true));
  if (!d.events || !d.events.length) {
    $('#events-body').innerHTML = '<tr class="placeholder"><td colspan="4">Waiting for events…</td></tr>';
  }
  updateStats();
  sample();
});

socket.on('slot', (slot) => {
  state.slots.set(slot.id, slot);
  slotCard(slot);
  updateStats();
});

socket.on('event', (evt) => {
  eventRow(evt, true);
  if (evt.type === 'free' || evt.type === 'occupied') sample();
});

/* ---------- clocks ---------- */
setInterval(() => ($('#clock').textContent = new Date().toLocaleTimeString('en-GB')), 1000);
setInterval(sample, 5000); // chart keeps moving even without events
setInterval(() => state.slots.forEach((s) => slotCard(s)), 15000); // refresh "x ago" labels
