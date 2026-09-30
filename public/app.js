/* Smart Parking dashboard — live client (Socket.IO) */
'use strict';

const $ = (sel) => document.querySelector(sel);

const state = {
  slots: new Map(),   // id -> {id, occupied, since, lastSeen, deviceTimeMs, online, seq, reservation?}
  samples: [],        // chart history: {t, occ, total}
  user: null,         // signed-in username (null = guest)
  choosing: null,     // slot id currently showing the duration chooser (survives re-renders)
};

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
      <div class="res-slot"></div>
      <div class="slot-actions"></div>
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

  // reservation badge
  const res = slot.reservation;
  const resEl = card.querySelector('.res-slot');
  if (res) {
    const ends = fmtTime(new Date(res.endsAt).getTime());
    resEl.innerHTML =
      `<span class="res-badge" title="reserved until ${ends}">Reserved by <b>${esc(res.username)}</b> · until ${ends}</span>`;
  } else {
    resEl.innerHTML = '';
  }

  // reserve / release controls (hidden in demo mode — no server behind them).
  // Re-rendered on every slot update, so the chooser state lives in `state`.
  const act = card.querySelector('.slot-actions');
  if (demo.active) {
    act.innerHTML = '';
  } else if (res) {
    if (state.choosing === slot.id) state.choosing = null;
    act.innerHTML =
      state.user && state.user === res.username
        ? '<button class="btn btn-release" data-action="release">Release reservation</button>'
        : '';
  } else if (state.user && state.choosing === slot.id) {
    act.innerHTML =
      [30, 60, 120]
        .map(
          (m) =>
            `<button class="btn btn-reserve" data-action="reserve" data-minutes="${m}">${m < 60 ? m + ' min' : m / 60 + ' h'}</button>`
        )
        .join('') + '<button class="btn" data-action="cancel-choose">✕</button>';
  } else if (state.user) {
    act.innerHTML = '<button class="btn btn-reserve" data-action="choose">Reserve</button>';
  } else {
    act.innerHTML = '<a class="btn btn-signin" href="/login.html">Sign in to reserve</a>';
  }
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
    'reserved':       ['RESERVED', 'b-amber'],
    'reservation-released': ['RESERVATION RELEASED', 'b-gray'],
    'reservation-expired':  ['RESERVATION EXPIRED', 'b-gray'],
  };
  const [label, cls] = map[evt.type] || [evt.type.toUpperCase(), 'b-gray'];

  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td>${fmtTime(evt.ts)}</td>
    <td><b>${esc(evt.slotId)}</b></td>
    <td><span class="badge ${cls}">${label}</span>${evt.username ? `<span class="ev-note">by ${esc(evt.username)}</span>` : ''}</td>
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

/* ---------- demo mode (static hosting, e.g. Vercel) ----------
 * A static deployment can't run server.js / Socket.IO / MQTT. When no live
 * server answers, the dashboard falls back to a clearly-labelled simulation
 * so the page still demonstrates the full UI. */
const demo = { active: false, timers: [] };

function stopDemo() {
  if (!demo.active) return;
  demo.active = false;
  demo.timers.forEach((t) => clearTimeout(t));
  demo.timers = [];
  document.body.classList.remove('demo-mode');
  const b = document.getElementById('demo-banner');
  if (b) b.remove();
}

function startDemo() {
  if (live || demo.active) return;
  demo.active = true;
  document.body.classList.add('demo-mode');
  const banner = document.createElement('div');
  banner.id = 'demo-banner';
  banner.innerHTML =
    '<b>Demo mode</b> — no live server connected, slots below are simulated. ' +
    'Run <code>npm start</code> (or the Arduino + serial bridge) for real-time data.';
  document.querySelector('main').prepend(banner);

  $('#slots').innerHTML = '';
  $('#events-body').innerHTML = '<tr class="placeholder"><td colspan="4">Demo activity…</td></tr>';
  state.slots = new Map();
  state.samples = [];

  const toggle = (s) => {
    const now = Date.now();
    const wasOccupied = s.occupied;
    s.occupied = !wasOccupied;
    s.since = s.occupied ? now : null;
    s.lastSeen = now;
    s.seq = (s.seq || 0) + 1;
    slotCard(s);
    updateStats();
    eventRow(
      {
        ts: now,
        slotId: s.id,
        type: s.occupied ? 'occupied' : 'free',
        durationMs: wasOccupied ? 6000 + Math.floor(Math.random() * 22000) : null,
      },
      true
    );
    sample();
    demo.timers.push(setTimeout(() => toggle(s), 6000 + Math.floor(Math.random() * 14000)));
  };

  for (let i = 1; i <= 6; i++) {
    const s = {
      id: 'S' + i,
      occupied: false,
      since: null,
      lastSeen: Date.now(),
      deviceTimeMs: (i * 37 + 90) * 1000,
      online: true,
      seq: 0,
    };
    state.slots.set(s.id, s);
    slotCard(s);
    demo.timers.push(setTimeout(() => toggle(s), 6000 + Math.floor(Math.random() * 14000)));
  }
  const s1 = state.slots.get('S1');
  demo.timers.push(setTimeout(() => toggle(s1), 1500)); // something happens immediately
  updateStats();
  sample();
}

/* ---------- socket wiring (live mode) ---------- */
let live = false;
let socket = null;

if (typeof io === 'function') {
  socket = io();

  socket.on('connect', () => {
    live = true;
    stopDemo();
    setPill($('#ws-pill'), true, 'Dashboard live', 'Dashboard offline');
  });
  socket.on('disconnect', () => setPill($('#ws-pill'), false, 'Dashboard live', 'Dashboard offline'));

  socket.on('broker', (up) => setPill($('#mqtt-pill'), up, 'MQTT broker', 'MQTT broker down'));

  socket.on('init', (d) => {
    live = true;
    stopDemo();
    $('#site-name').textContent = d.siteName || 'Smart Parking';
    setPill($('#mqtt-pill'), d.brokerConnected, 'MQTT broker', 'MQTT broker down');
    state.slots = new Map(d.slots.map((s) => [s.id, s]));
    const grid = $('#slots');
    grid.innerHTML = '';
    if (!d.slots.length) {
      grid.innerHTML =
        '<div class="empty-note" id="empty-note">No devices yet. Upload the Arduino sketch (or run <code>npm run simulate</code>) and slots appear here automatically.</div>';
    }
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

  // server never answered (static deploy / server down) → fall back to demo
  setTimeout(() => {
    if (!live) startDemo();
  }, 4000);
} else {
  // socket.io client script itself missing (pure static hosting)
  setTimeout(startDemo, 1200);
}

/* ---------- header auth area + session ---------- */
function renderAuthArea() {
  const el = $('#auth-area');
  if (!el) return;
  if (state.user) {
    el.innerHTML = `<span class="user-chip">${esc(state.user)}</span><button class="link-btn" id="logout-btn">Log out</button>`;
    el.querySelector('#logout-btn').onclick = async () => {
      try {
        await fetch('/api/auth/logout', { method: 'POST' });
      } catch {}
      state.user = null;
      renderAuthArea();
      state.slots.forEach((s) => slotCard(s));
    };
  } else {
    el.innerHTML =
      '<a class="link-btn" href="/login.html">Sign in</a><a class="link-btn primary" href="/signup.html">Sign up</a>';
  }
}

(async () => {
  try {
    const r = await fetch('/api/auth/me');
    const d = await r.json();
    state.user = d.username || null;
  } catch {
    state.user = null; // static hosting / server down
  }
  renderAuthArea();
  state.slots.forEach((s) => slotCard(s)); // refresh controls now that the user is known
})();

/* ---------- reserve / release clicks ---------- */
$('#slots').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const card = btn.closest('.slot-card');
  const id = card ? card.id.replace('slot-', '') : '';
  const slot = state.slots.get(id);
  if (!slot) return;

  if (btn.dataset.action === 'cancel-choose') {
    state.choosing = null;
    slotCard(slot);
    return;
  }
  if (btn.dataset.action === 'choose') {
    state.choosing = id;
    slotCard(slot);
    return;
  }
  if (!state.user) {
    location.href = '/login.html';
    return;
  }

  btn.disabled = true;
  try {
    if (btn.dataset.action === 'reserve') {
      const r = await fetch('/api/reservations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slotId: id, minutes: Number(btn.dataset.minutes || 60) }),
      });
      const d = await r.json().catch(() => ({}));
      state.choosing = null;
      if (!r.ok) {
        alert(d.error || 'could not reserve');
        slotCard(slot);
      }
      // success: the server broadcasts the updated slot, which re-renders the card
    } else if (btn.dataset.action === 'release' && slot.reservation) {
      const r = await fetch(`/api/reservations/${encodeURIComponent(slot.reservation.id)}/release`, {
        method: 'POST',
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        alert(d.error || 'could not release');
        slotCard(slot);
      }
    }
  } catch {
    alert('server unreachable — reservations need the live server (npm start)');
    slotCard(slot);
  }
});

/* ---------- clocks ---------- */
setInterval(() => ($('#clock').textContent = new Date().toLocaleTimeString('en-GB')), 1000);
setInterval(sample, 5000); // chart keeps moving even without events
setInterval(() => state.slots.forEach((s) => slotCard(s)), 15000); // refresh "x ago" labels
