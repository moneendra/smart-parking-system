/**
 * Smart Parking System — data store (users + reservations)
 * --------------------------------------------------------
 * Two interchangeable backends, chosen automatically:
 *
 *  1. "supabase" — the free Supabase Postgres, via its REST (PostgREST) API.
 *     Enabled when a project URL + service_role key are found (checked in
 *     this order):  env SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
 *                    → secrets.json  { "supabaseUrl": "...", "serviceKey": "..." }
 *                    → config.json   { "supabase": { "url": "...", "serviceKey": "..." } }
 *     IMPORTANT: the service_role key must never be exposed to the browser or
 *     committed to git. All queries happen server-side here.
 *
 *  2. "local" — plain JSON file at data/db.json (default until Supabase is
 *     configured, so the system always works out of the box).
 *
 * Both expose the exact same async interface.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config.json');

function loadSecrets() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'secrets.json'), 'utf8'));
  } catch {
    return {};
  }
}

const secrets = loadSecrets();
const SUPA_URL = String(
  process.env.SUPABASE_URL ||
    secrets.supabaseUrl ||
    (config.supabase && config.supabase.url) ||
    ''
).replace(/\/+$/, '');
const SUPA_KEY = String(
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
    secrets.serviceKey ||
    (config.supabase && config.supabase.serviceKey) ||
    ''
);

const mode = SUPA_URL && SUPA_KEY ? 'supabase' : 'local';
const LOCAL_DB = path.join(__dirname, 'data', 'db.json');

const log = (...a) => console.log('[' + new Date().toLocaleTimeString() + ']', '[store]', ...a);

/* ------------------------------------------------------------------ */
/* Supabase backend (PostgREST)                                        */
/* ------------------------------------------------------------------ */
async function sb(table, opts = {}) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${table}`, {
    method: opts.method || 'GET',
    headers: Object.assign(
      {
        apikey: SUPA_KEY,
        Authorization: `Bearer ${SUPA_KEY}`,
        'Content-Type': 'application/json',
      },
      opts.headers || {}
    ),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const err = new Error((body && body.message) || `Supabase request failed (${res.status})`);
    err.status = res.status;
    err.code = body && body.code;
    throw err;
  }
  return body;
}

function rowToUser(r) {
  return r ? { id: r.id, username: r.username, passwordHash: r.password_hash, createdAt: r.created_at } : null;
}
function rowToReservation(r) {
  return r
    ? {
        id: r.id,
        slotId: r.slot_id,
        username: r.username,
        startsAt: r.starts_at,
        endsAt: r.ends_at,
        status: r.status,
        createdAt: r.created_at,
      }
    : null;
}

const supabaseImpl = {
  async createUser({ username, passwordHash }) {
    const row = {
      id: crypto.randomUUID(),
      username,
      password_hash: passwordHash,
      created_at: new Date().toISOString(),
    };
    try {
      await sb('users', { method: 'POST', body: row });
    } catch (e) {
      if (e.code === '23505' || e.status === 409) {
        const dup = new Error('username already taken');
        dup.code = 'duplicate';
        throw dup;
      }
      throw e;
    }
    return rowToUser(row);
  },

  async getUserByUsername(username) {
    const rows = await sb(
      `users?username=eq.${encodeURIComponent(username)}&select=id,username,password_hash,created_at`
    );
    return rowToUser(rows && rows[0]);
  },

  async createReservation({ id, slotId, username, startsAt, endsAt }) {
    const row = {
      id,
      slot_id: slotId,
      username,
      starts_at: startsAt,
      ends_at: endsAt,
      status: 'active',
      created_at: new Date().toISOString(),
    };
    await sb('reservations', { method: 'POST', body: row });
    return rowToReservation(row);
  },

  async getReservation(id) {
    const rows = await sb(`reservations?id=eq.${encodeURIComponent(id)}&select=*`);
    return rowToReservation(rows && rows[0]);
  },

  async getActiveReservationForSlot(slotId) {
    const rows = await sb(
      `reservations?slot_id=eq.${encodeURIComponent(slotId)}&status=eq.active&select=*`
    );
    const now = Date.now();
    const live = (rows || []).find((r) => new Date(r.ends_at).getTime() > now);
    return rowToReservation(live || null);
  },

  async listReservations(limit = 50) {
    const rows = await sb(`reservations?order=created_at.desc&limit=${limit}`);
    return (rows || []).map(rowToReservation);
  },

  async updateReservationStatus(id, status) {
    const rows = await sb(`reservations?id=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: { status },
    });
    return rowToReservation(rows && rows[0]);
  },

  async expireDueReservations() {
    const due = await sb(
      `reservations?status=eq.active&ends_at=lte.${new Date().toISOString()}&select=*`
    );
    const out = [];
    for (const r of due || []) {
      const updated = await this.updateReservationStatus(r.id, 'expired');
      if (updated) out.push(updated);
    }
    return out;
  },
};

/* ------------------------------------------------------------------ */
/* Local JSON backend                                                  */
/* ------------------------------------------------------------------ */
function readLocal() {
  try {
    const db = JSON.parse(fs.readFileSync(LOCAL_DB, 'utf8'));
    return { users: db.users || [], reservations: db.reservations || [] };
  } catch {
    return { users: [], reservations: [] };
  }
}
function writeLocal(db) {
  fs.mkdirSync(path.dirname(LOCAL_DB), { recursive: true });
  fs.writeFileSync(LOCAL_DB, JSON.stringify(db, null, 2));
}

const localImpl = {
  async createUser({ username, passwordHash }) {
    const db = readLocal();
    if (db.users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
      const e = new Error('username already taken');
      e.code = 'duplicate';
      throw e;
    }
    const user = {
      id: crypto.randomUUID(),
      username,
      passwordHash,
      createdAt: new Date().toISOString(),
    };
    db.users.push(user);
    writeLocal(db);
    return user;
  },

  async getUserByUsername(username) {
    const db = readLocal();
    return (
      db.users.find((u) => u.username.toLowerCase() === String(username).toLowerCase()) || null
    );
  },

  async createReservation({ id, slotId, username, startsAt, endsAt }) {
    const db = readLocal();
    const res = { id, slotId, username, startsAt, endsAt, status: 'active', createdAt: new Date().toISOString() };
    db.reservations.push(res);
    writeLocal(db);
    return res;
  },

  async getReservation(id) {
    return readLocal().reservations.find((r) => r.id === id) || null;
  },

  async getActiveReservationForSlot(slotId) {
    const now = Date.now();
    return (
      readLocal().reservations.find(
        (r) => r.slotId === slotId && r.status === 'active' && new Date(r.endsAt).getTime() > now
      ) || null
    );
  },

  async listReservations(limit = 50) {
    return readLocal().reservations.slice(-limit).reverse();
  },

  async updateReservationStatus(id, status) {
    const db = readLocal();
    const r = db.reservations.find((x) => x.id === id);
    if (r) {
      r.status = status;
      writeLocal(db);
    }
    return r || null;
  },

  async expireDueReservations() {
    const db = readLocal();
    const now = Date.now();
    const out = [];
    for (const r of db.reservations) {
      if (r.status === 'active' && new Date(r.endsAt).getTime() <= now) {
        r.status = 'expired';
        out.push(r);
      }
    }
    if (out.length) writeLocal(db);
    return out;
  },
};

/* ------------------------------------------------------------------ */
const impl = mode === 'supabase' ? supabaseImpl : localImpl;

log(`user/reservation store: ${mode === 'supabase' ? `Supabase (${SUPA_URL})` : `local JSON (${LOCAL_DB})`}`);
if (mode === 'local') {
  log('tip: connect the free Supabase database — see README §10 (supabase-setup.sql)');
}

module.exports = Object.assign({ mode }, impl);
