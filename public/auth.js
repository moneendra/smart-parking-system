/* Smart Parking — signup/signin form handler (shared by both pages) */
'use strict';

const form = document.getElementById('f');
const err = document.getElementById('err');
const isSignup = location.pathname.indexOf('/signup') === 0;

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  err.textContent = '';

  const fd = new FormData(form);
  const body = {
    username: String(fd.get('username') || '').trim(),
    password: String(fd.get('password') || ''),
  };

  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const r = await fetch(isSignup ? '/api/auth/signup' : '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      err.textContent = d.error || 'request failed';
      btn.disabled = false;
      return;
    }
    location.href = '/';
  } catch {
    err.textContent =
      'server unreachable — run "npm start" and open this page from http://localhost:3000 (static hosting like Vercel cannot sign you in)';
    btn.disabled = false;
  }
});
