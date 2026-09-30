/**
 * Supabase connection check for Smart Parking.
 * Verifies the credentials are readable and the tables exist.
 *
 *   node supabase-check.js
 *
 * Reads credentials from (same order as store.js):
 *   env SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY  →  secrets.json  →  config.json
 */
'use strict';

const fs = require('fs');
const path = require('path');

const config = require('./config.json');
let secrets = {};
try {
  secrets = JSON.parse(fs.readFileSync(path.join(__dirname, 'secrets.json'), 'utf8'));
} catch {}

const url = String(process.env.SUPABASE_URL || secrets.supabaseUrl || (config.supabase && config.supabase.url) || '').replace(/\/+$/, '');
const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || secrets.serviceKey || (config.supabase && config.supabase.serviceKey) || '');

if (!url || !key) {
  console.log('✗ no Supabase credentials found.');
  console.log('  Create secrets.json next to server.js:');
  console.log('  { "supabaseUrl": "https://xxxx.supabase.co", "serviceKey": "eyJ..." }');
  console.log('  (Project Settings → API in the Supabase dashboard)');
  process.exit(1);
}

console.log('• credentials found for', url);

(async () => {
  const headers = { apikey: key, Authorization: `Bearer ${key}` };
  try {
    const r = await fetch(`${url}/rest/v1/`, { headers });
    if (!r.ok) {
      console.log(`✗ REST API rejected the service key (HTTP ${r.status}) — re-copy the service_role key.`);
      process.exit(1);
    }
    console.log('✓ service key accepted');
  } catch (e) {
    console.log('✗ cannot reach Supabase:', e.message);
    process.exit(1);
  }

  for (const table of ['users', 'reservations']) {
    try {
      const r = await fetch(`${url}/rest/v1/${table}?select=*&limit=1`, { headers });
      if (r.ok) {
        console.log(`✓ table "${table}" exists`);
      } else {
        const body = await r.json().catch(() => ({}));
        if (r.status === 404 || /does not exist/i.test(body.message || '')) {
          console.log(`✗ table "${table}" missing — run supabase-setup.sql in the Supabase SQL Editor`);
        } else {
          console.log(`✗ table "${table}": HTTP ${r.status} ${(body.message || '').slice(0, 120)}`);
        }
      }
    } catch (e) {
      console.log(`✗ table "${table}": ${e.message}`);
    }
  }

  console.log('done — if both tables show ✓, restart server.js and it will use Supabase.');
})();
