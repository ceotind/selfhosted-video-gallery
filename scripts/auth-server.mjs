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