// Login service for the gallery.
// Runs next to nginx in the same container. nginx asks it about every request.
// Users and sessions live in one SQLite file. Passwords are Argon2id hashes.

import http from 'node:http';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';

const PORT = Number(process.env.AUTH_PORT || 9000);
const DB_PATH = process.env.AUTH_DB || '/data/db/gallery.db';
const LOGIN_HTML = process.env.LOGIN_HTML || '/app/auth/login.html';
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const COOKIE = 'vg_session';

const FAIL_WINDOW_MIN = 15;
const FAIL_PER_USER = 8;
const FAIL_PER_IP = 25;

const ARGON = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 };
const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$3g2n0Z0m0k6z1sJt5f0nOZr7Q8bJp1cK0xGq7cU0m0A';

await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    ip TEXT,
    ua TEXT
  );
  CREATE INDEX IF NOT EXISTS sessions_token ON sessions(token_hash);
  CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    ip TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS attempts_at ON attempts(at);
`);

// Older databases predate the admin flag.
const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userColumns.includes('is_admin')) {
  db.exec('ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0');
}

// The configured admins are always admins, whatever a seed file says.
const ADMINS = String(process.env.ADMIN_USERS || 'dilshad')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
for (const name of ADMINS) db.prepare('UPDATE users SET is_admin = 1 WHERE username = ?').run(name);

const q = {
  user: db.prepare('SELECT id, username, password_hash, active FROM users WHERE username = ?'),
  userById: db.prepare('SELECT id, username, active FROM users WHERE id = ?'),
  touch: db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?'),
  extend: db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?'),
  session: db.prepare(
    'SELECT s.id, s.user_id, s.expires_at, s.last_seen, u.active FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'
  ),
  addSession: db.prepare(
    'INSERT INTO sessions (user_id, token_hash, created_at, expires_at, last_seen, ip, ua) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ),
  delSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  delUserSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
  addAttempt: db.prepare('INSERT INTO attempts (username, ip, at) VALUES (?, ?, ?)'),
  countUserAttempts: db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE username = ? AND at > ?'),
  countIpAttempts: db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE ip = ? AND at > ?'),
  pruneAttempts: db.prepare('DELETE FROM attempts WHERE at < ?'),
  me: db.prepare('SELECT id, username, active, is_admin FROM users WHERE id = ?'),
  adminUsers: db.prepare(
    `SELECT u.id, u.username, u.active, u.is_admin, u.created_at,
            (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS live
       FROM users u ORDER BY u.is_admin DESC, u.username`
  ),
  adminSessions: db.prepare(
    `SELECT s.id, s.user_id, u.username, s.created_at, s.expires_at, s.last_seen, s.ip, s.ua
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.expires_at > ?
      ORDER BY s.last_seen DESC LIMIT 200`
  ),
  delSessionById: db.prepare('DELETE FROM sessions WHERE id = ?'),
  setActive: db.prepare('UPDATE users SET active = ? WHERE username = ?'),
  delSessionsFor: db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)'),
  setPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  setPasswordByName: db.prepare('UPDATE users SET password_hash = ? WHERE username = ?'),
  delOtherSessions: db.prepare('DELETE FROM sessions WHERE user_id = ? AND id <> ?'),
  delAllSessions: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const now = () => Date.now();
const DAY = 86400000;

function cookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function clientIp(req) {
  return (req.headers['x-real-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function isHttps(req) {
  return (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function setCookie(req, value, maxAge) {
  const bits = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (isHttps(req)) bits.push('Secure');
  return bits.join('; ');
}

function readBody(req, limit = 8192) {
  return new Promise((resolve) => {
    let body = '';
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      body += c;
      if (body.length > limit) {
        over = true;
        req.destroy();
      }
    });
    req.on('end', () => resolve(over ? '' : body));
    req.on('error', () => resolve(''));
  });
}

function parseForm(body, type) {
  const out = {};
  if (!body) return out;
  if ((type || '').includes('application/json')) {
    try {
      return JSON.parse(body);
    } catch {
      return out;
    }
  }
  for (const [k, v] of new URLSearchParams(body)) out[k] = v;
  return out;
}

function safeNext(next) {
  if (!next || typeof next !== 'string') return '/';
  if (!next.startsWith('/') || next.startsWith('//')) return '/';
  return next;
}

// Auth results are cached for a few seconds. A single video playback makes hundreds
// of segment requests, and each one needs the same answer.
const cache = new Map();
const CACHE_MS = 20000;
const CACHE_MAX = 5000;

function cacheGet(token) {
  const hit = cache.get(token);
  if (!hit) return null;
  if (hit.until < now()) {
    cache.delete(token);
    return null;
  }
  return hit;
}

let writes = 0;
function checkSession(token) {
  if (!token) return null;
  const hit = cacheGet(token);
  if (hit) return hit.value;

  const t = now();
  const row = q.session.get(sha256(token));
  if (!row || !row.active || row.expires_at <= t) {
    cache.set(token, { value: null, until: t + CACHE_MS });
    return null;
  }

  if (row.expires_at - t < 5 * DAY) {
    q.extend.run(t + SESSION_DAYS * DAY, row.id);
  }
  if (t - row.last_seen > 3600000) q.touch.run(t, row.id);

  const value = { userId: row.user_id, sessionId: row.id };
  if (cache.size > CACHE_MAX) cache.clear();
  cache.set(token, { value, until: t + CACHE_MS });
  return value;
}

function tooMany(username, ip) {
  const since = now() - FAIL_WINDOW_MIN * 60000;
  const byUser = q.countUserAttempts.get(username, since).n;
  const byIp = q.countIpAttempts.get(ip, since).n;
  return byUser >= FAIL_PER_USER || byIp >= FAIL_PER_IP;
}

function page(status, body, headers = {}) {
  return { status, body, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers } };
}

function json(status, obj, headers = {}) {
  return {
    status,
    body: JSON.stringify(obj),
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  };
}

let loginTemplate = null;
async function loginPage(err) {
  if (loginTemplate == null) loginTemplate = await fs.readFile(LOGIN_HTML, 'utf8').catch(() => '<h1>Login template missing</h1>');
  return loginTemplate.replace('{{ERROR}}', err ? '<p class="err">' + err + '</p>' : '');
}

const messages = {
  bad: 'Wrong username or password.',
  rate: 'Too many attempts. Wait 15 minutes.',
  empty: 'Enter your username and password.',
  off: 'That account is not active.',
};

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const when = (ms) => {
  if (!ms) return '-';
  const d = new Date(Number(ms));
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
};

const LOGIN_CSS = `
:root{--bg:#fff;--fg:#14161a;--muted:#5f6672;--card:#f4f5f7;--line:#e3e5e9;--accent:#1f6feb}
@media (prefers-color-scheme:dark){:root{--bg:#0e1014;--fg:#eef0f4;--muted:#97a0ad;--card:#171a20;--line:#242a33;--accent:#7aa7ff}}
*{box-sizing:border-box}
body{display:grid;place-items:center;min-height:100vh;margin:0;padding:20px;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
h1{margin:0 0 14px;font-size:19px;font-weight:650}
label{display:block;margin:0 0 6px;font-size:12px;color:var(--muted)}
input{width:100%;margin:0 0 14px;padding:11px 12px;font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:9px;outline:none}
input:focus{border-color:var(--accent)}
button{width:100%;padding:11px 14px;font:inherit;font-weight:600;color:#fff;background:var(--accent);border:0;border-radius:9px;cursor:pointer}
`;

const ADMIN_CSS = `
:root{--bg:#fff;--fg:#14161a;--muted:#5f6672;--card:#f4f5f7;--line:#e3e5e9;--accent:#1f6feb;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0e1014;--fg:#eef0f4;--muted:#97a0ad;--card:#171a20;--line:#242a33;--accent:#7aa7ff;--bad:#ffb4ab}}
*{box-sizing:border-box}
body{margin:0;padding:22px;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
h1{font-size:18px;margin:0 0 4px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:26px 0 10px}
p.sub{margin:0 0 18px;color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-size:13px;vertical-align:middle}
th{font-weight:600;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.03em}
tr:last-child td{border-bottom:0}
button{font:inherit;font-size:12px;padding:5px 10px;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:7px;cursor:pointer}
button:hover{border-color:var(--accent)}
button.danger{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 45%,var(--line))}
td form{display:inline;margin:0}
input.pw{width:120px;padding:5px 7px;font:inherit;font-size:12px;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:7px}
input.pw:focus{outline:none;border-color:var(--accent)}
.tag{font-size:11px;padding:2px 6px;border-radius:5px;background:var(--line);color:var(--muted)}
.note{margin:14px 0 0;padding:9px 11px;font-size:13px;border-radius:8px;background:var(--card);border:1px solid var(--line)}
a{color:var(--accent);text-decoration:none}
@media(max-width:640px){td.hide,th.hide{display:none}}
`;

function adminPage(me, users, sessions, msg) {
  const notes = {
    revoked: 'Session killed. That browser is signed out now.',
    disabled: 'Account disabled and all its sessions removed.',
    enabled: 'Account enabled again.',
    self: 'You cannot disable your own account.',
    pw: 'Password set. Their other sessions are signed out.',
    pwshort: `Passwords need ${MIN_PASSWORD} characters or more.`,
    nouser: 'That person does not exist.',
  };
  const userRows = users
    .map(
      (u) => `<tr>
        <td><strong>${esc(u.username)}</strong>${u.is_admin ? ' <span class="tag">admin</span>' : ''}</td>
        <td>${u.active ? 'active' : '<span class="tag">disabled</span>'}</td>
        <td>${u.live}</td>
        <td class="hide">${when(u.created_at)}</td>
        <td><form method="post" action="/admin/password"><input type="hidden" name="username" value="${esc(u.username)}"><input class="pw" name="password" type="password" placeholder="new password" minlength="${MIN_PASSWORD}" autocomplete="new-password"><button type="submit">Set</button></form></td>
        <td>${
          u.username === me.username
            ? '<span class="tag">you</span>'
            : `<form method="post" action="/admin/user"><input type="hidden" name="username" value="${esc(u.username)}"><input type="hidden" name="action" value="${u.active ? 'off' : 'on'}"><button class="${u.active ? 'danger' : ''}" type="submit">${u.active ? 'Disable' : 'Enable'}</button></form>`
        }</td>
      </tr>`
    )
    .join('');

  const sessionRows = sessions
    .map(
      (s) => `<tr>
        <td><strong>${esc(s.username)}</strong></td>
        <td class="hide">${esc(s.ip || '-')}</td>
        <td>${when(s.last_seen)}</td>
        <td class="hide">${when(s.expires_at)}</td>
        <td><form method="post" action="/admin/revoke"><input type="hidden" name="id" value="${s.id}"><button class="danger" type="submit">Sign out</button></form></td>
      </tr>`
    )
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin</title><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark">
<style>${ADMIN_CSS}</style></head><body>
<h1>Access</h1>
<p class="sub">Signed in as ${esc(me.username)}. <a href="/">Back to the videos</a></p>
${msg && notes[msg] ? `<p class="note">${notes[msg]}</p>` : ''}
<h2>People (${users.length})</h2>
<table><thead><tr><th>Name</th><th>Status</th><th>Open sessions</th><th class="hide">Added</th><th>Password</th><th></th></tr></thead><tbody>${userRows}</tbody></table>
<h2>Signed in now (${sessions.length})</h2>
<table><thead><tr><th>Name</th><th class="hide">Address</th><th>Last seen</th><th class="hide">Expires</th><th></th></tr></thead><tbody>${
    sessionRows || '<tr><td colspan="5">Nobody is signed in.</td></tr>'
  }</tbody></table>
<p class="note">Disabling a person removes every session they have, at once.</p>
</body></html>`;
}

function blockedPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not allowed</title>
<style>body{font:15px system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0e1014;color:#eef0f4}</style>
</head><body><div><h1>Not allowed</h1><p>This area is for the admin.</p><p><a style="color:#7aa7ff" href="/">Back</a></p></div></body></html>`;
}

const MIN_PASSWORD = 10;

const q2 = {
  byName: db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?'),
  byId: db.prepare('SELECT id, username, password_hash FROM users WHERE id = ?'),
};

function accountPage(user, msg, isError) {
  const notes = {
    ok: 'Password changed. Other browsers were signed out.',
    bad: 'That is not your current password.',
    short: `Use at least ${MIN_PASSWORD} characters.`,
    mismatch: 'The two new passwords do not match.',
    same: 'The new password is the same as the old one.',
  };
  const note = msg && notes[msg] ? `<p class="err${isError ? '' : ' ok'}">${notes[msg]}</p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Account</title>
<meta name="robots" content="noindex"><meta name="color-scheme" content="light dark">
<style>${LOGIN_CSS}
.card{width:100%;max-width:360px}
.row{margin:0 0 12px}
.err{margin:0 0 14px;padding:9px 11px;font-size:13px;border-radius:8px;color:#b42318;background:#fee4e2}
.err.ok{color:#067647;background:#d1fadf}
@media (prefers-color-scheme:dark){.err{color:#ffb4ab;background:#3b1512}.err.ok{color:#a6f4c5;background:#0b2e1d}}
.back{font-size:13px;margin:0 0 18px}
a{color:var(--accent);text-decoration:none}
</style></head><body>
<form class="card" method="post" action="/api/password">
  <h1>Password</h1>
  <p class="back">Signed in as ${esc(user.username)}. <a href="/">Back to the videos</a></p>
  ${note}
  <label for="current">Current password</label>
  <input id="current" name="current" type="password" autocomplete="current-password" required>
  <label for="next">New password</label>
  <input id="next" name="next" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
  <label for="again">New password again</label>
  <input id="again" name="again" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD}" required>
  <button type="submit">Change password</button>
</form>
</body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (r) => {
    res.writeHead(r.status, r.headers);
    res.end(r.body);
  };

  try {
    // nginx subrequest: 204 means allowed, 401 means send the person to the login page.
    if (url.pathname === '/__auth') {
      const token = cookies(req)[COOKIE];
      const ok = checkSession(token);
      if (!ok) return send({ status: 401, body: '', headers: { 'cache-control': 'no-store' } });
      if (++writes % 200 === 0) q.pruneAttempts.run(now() - DAY);
      return send({ status: 204, body: '', headers: { 'cache-control': 'no-store' } });
    }

    if (url.pathname === '/login' && req.method === 'GET') {
      const token = cookies(req)[COOKIE];
      if (checkSession(token)) {
        const next = safeNext(url.searchParams.get('next'));
        return send({ status: 303, body: '', headers: { location: next, 'cache-control': 'no-store' } });
      }
      const code = url.searchParams.get('e');
      return send(page(200, await loginPage(messages[code] || '')));
    }

    if (url.pathname === '/api/login' && req.method === 'POST') {
      const ip = clientIp(req);
      const body = parseForm(await readBody(req), req.headers['content-type']);
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      const next = safeNext(body.next);

      if (!username || !password) {
        return send({ status: 303, body: '', headers: { location: '/login?e=empty', 'cache-control': 'no-store' } });
      }
      if (tooMany(username, ip)) {
        return send({ status: 303, body: '', headers: { location: '/login?e=rate', 'cache-control': 'no-store' } });
      }

      const user = q.user.get(username);
      let ok = false;
      try {
        ok = user ? await argonVerify(user.password_hash, password, ARGON) : (await argonVerify(DUMMY_HASH, password, ARGON), false);
      } catch {
        ok = false;
      }

      if (!user || !ok) {
        q.addAttempt.run(username, ip, now());
        return send({ status: 303, body: '', headers: { location: '/login?e=bad', 'cache-control': 'no-store' } });
      }
      if (!user.active) {
        return send({ status: 303, body: '', headers: { location: '/login?e=off', 'cache-control': 'no-store' } });
      }

      const token = crypto.randomBytes(32).toString('hex');
      const t = now();
      q.addSession.run(user.id, sha256(token), t, t + SESSION_DAYS * DAY, t, ip, String(req.headers['user-agent'] || '').slice(0, 300));
      cache.clear();
      return send({
        status: 303,
        body: '',
        headers: { location: next, 'set-cookie': setCookie(req, token, SESSION_DAYS * 86400), 'cache-control': 'no-store' },
      });
    }

    if (url.pathname === '/api/logout' && (req.method === 'POST' || req.method === 'GET')) {
      const token = cookies(req)[COOKIE];
      if (token) {
        q.delSession.run(sha256(token));
        cache.delete(token);
      }
      return send({
        status: 303,
        body: '',
        headers: { location: '/login', 'set-cookie': setCookie(req, '', 0), 'cache-control': 'no-store' },
      });
    }

    if (url.pathname === '/api/me') {
      const s = checkSession(cookies(req)[COOKIE]);
      if (!s) return send(json(401, { error: 'not signed in' }));
      const u = q.me.get(s.userId);
      if (!u || !u.active) return send(json(401, { error: 'not signed in' }));
      return send(json(200, { username: u.username, admin: !!u.is_admin }));
    }

    if (url.pathname === '/account' && req.method === 'GET') {
      const s = checkSession(cookies(req)[COOKIE]);
      if (!s) return send({ status: 302, body: '', headers: { location: '/login?next=/account', 'cache-control': 'no-store' } });
      const u = q2.byId.get(s.userId);
      if (!u) return send({ status: 302, body: '', headers: { location: '/login', 'cache-control': 'no-store' } });
      const code = url.searchParams.get('m') || '';
      return send(page(200, accountPage(u, code, code === 'bad' || code === 'short' || code === 'mismatch' || code === 'same')));
    }

    if (url.pathname === '/api/password' && req.method === 'POST') {
      const s = checkSession(cookies(req)[COOKIE]);
      if (!s) return send({ status: 302, body: '', headers: { location: '/login?next=/account', 'cache-control': 'no-store' } });

      const body = parseForm(await readBody(req), req.headers['content-type']);
      const current = String(body.current || '');
      const next = String(body.next || '');
      const again = String(body.again || '');
      const u = q2.byId.get(s.userId);

      const back = (m) => send({ status: 303, body: '', headers: { location: '/account?m=' + m, 'cache-control': 'no-store' } });

      if (!u || !current) return back('bad');
      if (next.length < MIN_PASSWORD) return back('short');
      if (next !== again) return back('mismatch');
      if (next === current) return back('same');

      let ok = false;
      try {
        ok = await argonVerify(u.password_hash, current, ARGON);
      } catch {
        ok = false;
      }
      if (!ok) return back('bad');

      q.setPassword.run(await argonHash(next, ARGON), u.id);
      // Keep this browser, drop every other session for this person.
      q.delOtherSessions.run(u.id, s.sessionId);
      cache.clear();
      return back('ok');
    }

    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      const s = checkSession(cookies(req)[COOKIE]);
      if (!s) return send({ status: 302, body: '', headers: { location: '/login?next=/admin', 'cache-control': 'no-store' } });
      const u = q.me.get(s.userId);
      if (!u || !u.is_admin || !u.active) return send(page(403, blockedPage()));

      // Browsers always send Origin on a cross-site POST, so this stops forged forms.
      if (req.method === 'POST') {
        const origin = req.headers.origin || '';
        const host = req.headers['x-forwarded-host'] || req.headers.host || '';
        if (origin && host && !origin.endsWith('//' + host)) {
          return send(page(403, blockedPage()));
        }
        const body = parseForm(await readBody(req), req.headers['content-type']);

        if (url.pathname === '/admin/revoke' && body.id) {
          q.delSessionById.run(Number(body.id));
          cache.clear();
          return send({ status: 303, body: '', headers: { location: '/admin?m=revoked', 'cache-control': 'no-store' } });
        }
        if (url.pathname === '/admin/user' && body.username) {
          const target = String(body.username).toLowerCase();
          if (target === u.username) {
            return send({ status: 303, body: '', headers: { location: '/admin?m=self', 'cache-control': 'no-store' } });
          }
          const off = body.action === 'off';
          q.setActive.run(off ? 0 : 1, target);
          if (off) q.delSessionsFor.run(target);
          cache.clear();
          return send({ status: 303, body: '', headers: { location: '/admin?m=' + (off ? 'disabled' : 'enabled'), 'cache-control': 'no-store' } });
        }

        if (url.pathname === '/admin/password' && body.username && body.password) {
          const target = String(body.username).toLowerCase();
          const pw = String(body.password);
          if (pw.length < MIN_PASSWORD) {
            return send({ status: 303, body: '', headers: { location: '/admin?m=pwshort', 'cache-control': 'no-store' } });
          }
          const hit = q2.byName.get(target);
          if (!hit) return send({ status: 303, body: '', headers: { location: '/admin?m=nouser', 'cache-control': 'no-store' } });
          q.setPasswordByName.run(await argonHash(pw, ARGON), target);
          if (target === u.username) q.delOtherSessions.run(hit.id, s.sessionId);
          else q.delAllSessions.run(hit.id);
          cache.clear();
          return send({ status: 303, body: '', headers: { location: '/admin?m=pw', 'cache-control': 'no-store' } });
        }
      }

      const t = now();
      const users = q.adminUsers.all(t);
      const sessions = q.adminSessions.all(t);
      return send(page(200, adminPage(u, users, sessions, url.searchParams.get('m'))));
    }

    if (url.pathname === '/__health') {
      return send(json(200, { ok: true }));
    }

    return send(page(404, '<h1>Not found</h1>'));
  } catch (e) {
    console.error('[auth]', e && e.message);
    return send(page(500, '<h1>Server error</h1>'));
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`[auth] listening on 127.0.0.1:${PORT}`));