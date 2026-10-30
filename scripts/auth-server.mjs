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
  CREATE TABLE IF NOT EXISTS folder_rules (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL DEFAULT 0,
    path TEXT NOT NULL,
    allow INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS folder_rules_key ON folder_rules(user_id, path);
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

// ---------------------------------------------------------------------------
// Folders: who sees what.
// A rule shows or hides one folder and everything under it.
// No rule means hidden, except for admins, who always see every folder.
// user_id 0 is the rule for everyone. A person's own rule beats that one.
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.DATA_DIR || '';
// Docker passes no DATA_DIR, and the folder list lives at /data/meta there.
const META_DIR = process.env.META_DIR || (DATA_DIR ? path.join(DATA_DIR, 'meta') : '/data/meta');
const EVERYONE = 0;
const ALLOW_ALL = [{ path: '', allow: 1 }];
// Local development switch. Everyone signed in sees every folder until a rule
// hides one. Off by default, so a plain install starts closed.
const FOLDERS_OPEN = /^(1|true|yes|open)$/i.test(String(process.env.FOLDERS_OPEN || ''));

const meta = { ready: false, nodes: new Map(), folderPath: new Map(), videoPath: new Map(), paths: new Set() };

async function readNode(id) {
  const file = id === 'root' ? path.join(META_DIR, 'tree.json') : path.join(META_DIR, 'f', id + '.json');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

// Reads the whole folder list once and keeps it. A person's view is built from
// this, so no disk read happens per click.
async function loadMeta() {
  const tree = await readNode('root');
  const nodes = new Map([['root', tree]]);
  const folderPath = new Map();
  const videoPath = new Map();
  for (const v of tree.videos || []) videoPath.set(v.id, v.f);

  const queue = (tree.folders || []).map((f) => ({ id: f.id, rel: f.name }));
  const seen = new Set();
  while (queue.length) {
    const { id, rel } = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    let node;
    try {
      node = await readNode(id);
    } catch {
      continue;
    }
    nodes.set(id, node);
    folderPath.set(id, rel);
    for (const v of node.videos || []) videoPath.set(v.id, v.f);
    for (const f of node.folders || []) queue.push({ id: f.id, rel: rel + '/' + f.name });
  }

  meta.nodes = nodes;
  meta.folderPath = folderPath;
  meta.videoPath = videoPath;
  meta.paths = new Set(folderPath.values());
  meta.ready = true;
  console.log(`[auth] folders ${folderPath.size}, videos ${videoPath.size}`);
}

async function ensureMeta() {
  if (meta.ready) return true;
  try {
    await loadMeta();
    return true;
  } catch (e) {
    console.error('[auth] folder index not readable:', e && e.message);
    return false;
  }
}

let rulesVersion = 1;
const rulesCache = new Map();

const qRules = {
  forUser: db.prepare('SELECT user_id, path, allow FROM folder_rules WHERE user_id = ? OR user_id = 0'),
  own: db.prepare('SELECT path, allow FROM folder_rules WHERE user_id = ?'),
  set: db.prepare(
    `INSERT INTO folder_rules (user_id, path, allow, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, path) DO UPDATE SET allow = excluded.allow, created_at = excluded.created_at`
  ),
  clear: db.prepare('DELETE FROM folder_rules WHERE user_id = ? AND path = ?'),
  clearAll: db.prepare('DELETE FROM folder_rules WHERE user_id = ?'),
};

function noteRulesChanged() {
  rulesVersion++;
  rulesCache.clear();
}

function rulesFor(userId) {
  const hit = rulesCache.get(userId);
  if (hit && hit.version === rulesVersion) return hit.rules;
  const rules = qRules
    .forUser.all(userId)
    .map((r) => ({ path: r.path, allow: r.allow, own: r.user_id === userId ? 1 : 0 }))
    // The deepest rule wins. The person's own rule wins a tie with everyone's.
    .sort((a, b) => b.path.length - a.path.length || b.own - a.own);
  // The answer when no rule covers a folder.
  rules.push({ path: '', allow: FOLDERS_OPEN ? 1 : 0, own: 0 });
  rulesCache.set(userId, { version: rulesVersion, rules });
  return rules;
}

function covers(rulePath, folderPath) {
  if (rulePath === '') return true;
  return folderPath === rulePath || folderPath.startsWith(rulePath + '/');
}

function visibleTo(folderPath, rules) {
  for (const r of rules) if (covers(r.path, folderPath)) return r.allow === 1;
  return false;
}

// One folder's card picture. If the picture belongs to a video the person cannot
// see, fall back to another video in that folder, or to no picture at all.
function posterFor(child, rules) {
  const p = child.p;
  if (!p) return null;
  if (String(p).startsWith('f-')) return p;
  const file = meta.videoPath.get(p);
  if (!file) return p;
  if (visibleTo(file, rules)) return p;
  const first = (child.videos || []).find((v) => visibleTo(v.f, rules));
  return first ? first.id : null;
}

// Builds one person's copy of a folder: only the folders and videos they may see,
// with counts that match what they actually get.
function viewBuilder(rules) {
  const counts = new Map();

  function count(node, rel) {
    if (counts.has(rel)) return counts.get(rel);
    let n = 0;
    for (const v of node.videos || []) if (visibleTo(v.f, rules)) n++;
    for (const f of node.folders || []) {
      const childRel = rel ? rel + '/' + f.name : f.name;
      if (!visibleTo(childRel, rules)) continue;
      const child = meta.nodes.get(f.id);
      if (!child) continue;
      const c = count(child, childRel);
      if (c > 0) n += c;
    }
    counts.set(rel, n);
    return n;
  }

  return function view(node, rel) {
    const videos = (node.videos || []).filter((v) => visibleTo(v.f, rules));
    const folders = [];
    for (const f of node.folders || []) {
      const childRel = rel ? rel + '/' + f.name : f.name;
      if (!visibleTo(childRel, rules)) continue;
      const child = meta.nodes.get(f.id);
      if (!child) continue;
      const c = count(child, childRel);
      if (c === 0) continue;
      folders.push({ ...f, count: c, p: posterFor(child, rules) });
    }
    const total = videos.length + folders.reduce((n, f) => n + f.count, 0);
    return { ...node, folders, videos, count: total };
  };
}

// Reads the path a video request is aimed at. The web server hands us the raw
// address, so decode it and resolve it the same way nginx does before comparing.
function videoPathFromUri(rawUri) {
  const raw = String(rawUri || '').split('?')[0];
  let p;
  try {
    p = decodeURIComponent(raw);
  } catch {
    return null;
  }
  p = p.normalize('NFC');
  if (!p.startsWith('/v/')) return null;
  let rel = p.slice(3);
  if (!rel || rel.endsWith('/')) return null;
  rel = path.posix.normalize('/' + rel).slice(1);
  if (!rel || rel === '.') return null;
  return rel;
}

const q = {
  user: db.prepare('SELECT id, username, password_hash, active FROM users WHERE username = ?'),
  userById: db.prepare('SELECT id, username, active FROM users WHERE id = ?'),
  touch: db.prepare('UPDATE sessions SET last_seen = ? WHERE id = ?'),
  extend: db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?'),
  session: db.prepare(
    'SELECT s.id, s.user_id, s.expires_at, s.last_seen, u.username, u.active, u.is_admin FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'
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
  userByName: db.prepare('SELECT id, username, active, is_admin FROM users WHERE username = ?'),
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
  lastSeen: db.prepare('SELECT user_id, MAX(last_seen) AS seen, COUNT(*) AS n FROM sessions GROUP BY user_id'),
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

  const value = { userId: row.user_id, sessionId: row.id, username: row.username, isAdmin: !!row.is_admin };
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
:root{--bg:#fff;--panel:#f3f4f6;--panel-2:#e9ebef;--fg:#0a0b0d;--muted:#5c6470;--line:#e4e6ea;--hot:#1a56ff;--hot-soft:rgba(26,86,255,.14);--cta:#1a56ff;--cta-fg:#fff;--radius:18px;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#08090b;--panel:#111318;--panel-2:#171a21;--fg:#f4f6f9;--muted:#98a1af;--line:#22262e;--hot:#5b9cff;--hot-soft:rgba(91,156,255,.2);--cta:#2f6bff;--cta-fg:#fff;--bad:#ffb4ab}}
*{box-sizing:border-box}
html,body{height:100%}
body{display:grid;place-items:center;min-height:100dvh;margin:0;padding:clamp(18px,4vw,56px);background:radial-gradient(120% 90% at 50% 0%,var(--hot-soft),transparent 55%),var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
h1{margin:0 0 8px;font-size:clamp(26px,4vw,42px);font-weight:850;letter-spacing:-.035em;text-transform:uppercase}
label{display:block;margin:0 0 7px;font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
input{width:100%;height:clamp(46px,3.8vw,54px);margin:0 0 16px;padding:0 16px;font:inherit;color:var(--fg);background:var(--panel);border:1px solid transparent;border-radius:var(--radius);outline:none}
input:focus{background:var(--bg);border-color:var(--hot);box-shadow:0 0 0 4px var(--hot-soft)}
button{width:100%;height:clamp(48px,4vw,56px);font:inherit;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--cta-fg);background:var(--cta);border:0;border-radius:var(--radius);cursor:pointer}
button:hover{filter:brightness(1.08)}
a{color:var(--fg);text-decoration:none;border-bottom:1px solid var(--hot)}
`;

const ADMIN_CSS = `
:root{--bg:#fbfbfa;--panel:#f4f4f1;--panel-2:#ededea;--fg:#111315;--muted:#545c68;--line:#e3e3de;--line-2:#c6c7c1;--hot:#1a56ff;--hot-soft:rgba(26,86,255,.16);--cta:#1a56ff;--cta-fg:#fff;--bad:#a4231b;--bad-soft:#fbecea;--r:7px}
@media (prefers-color-scheme:dark){:root{--bg:#0b0c0e;--panel:#141619;--panel-2:#1a1d21;--fg:#f1f2f4;--muted:#a2aab6;--line:#23262b;--line-2:#3a3e45;--hot:#7fb0ff;--hot-soft:rgba(127,176,255,.18);--cta:#7fb0ff;--cta-fg:#08101c;--bad:#ff8f85;--bad-soft:#2a1613}}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;min-height:100dvh;padding:clamp(18px,2.4vw,34px) clamp(16px,3vw,40px) 72px;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
h1{font-size:clamp(26px,3vw,36px);font-weight:650;letter-spacing:-.03em;line-height:1.05;margin:0 0 8px}
h2{font-size:13px;font-weight:650;color:var(--fg);margin:clamp(26px,2.4vw,40px) 0 12px;padding-top:14px;border-top:1px solid var(--line)}
p.sub{margin:0 0 22px;color:var(--muted);font-size:13.5px}
a{color:var(--fg);text-decoration:none;border-bottom:1px solid var(--line-2)}
a:hover{border-bottom-color:var(--hot)}
:focus-visible{outline:2px solid var(--hot);outline-offset:2px;border-radius:4px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:11px 14px 11px 0;border-bottom:1px solid var(--line);font-size:14px;vertical-align:middle}
th{font-weight:600;color:var(--muted);font-size:12px;padding-bottom:9px;border-bottom:1px solid var(--line-2)}
tbody tr:hover{background:var(--panel)}
th:last-child,td:last-child{padding-right:0}
tr:last-child td{border-bottom:0}
.btn,button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:0 13px;font:inherit;font-size:13px;font-weight:600;color:var(--fg);background:transparent;border:1px solid var(--line-2);border-radius:var(--r);cursor:pointer;text-decoration:none;white-space:nowrap}
.btn:hover,button:hover{border-color:var(--fg);background:var(--panel)}
.btn.primary{color:var(--cta-fg);background:var(--cta);border-color:var(--cta)}
.btn.primary:hover{background:var(--cta);border-color:var(--cta);filter:brightness(.93)}
.btn.danger,button.danger{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 32%,var(--line-2))}
.btn.danger:hover,button.danger:hover{color:var(--bad);background:var(--bad-soft);border-color:var(--bad)}
td form{display:inline;margin:0}
.actions form{display:inline-block;margin:0 6px 0 0}
.actions>*{vertical-align:middle}
.whoswitch{display:flex;flex-wrap:wrap;gap:2px 6px;margin:0 0 22px;font-size:13.5px}
.whoswitch a{padding:5px 10px;color:var(--muted);border:1px solid transparent;border-radius:6px}
.whoswitch a:hover{color:var(--fg);border-color:var(--line-2);background:var(--panel)}
.whoswitch a.on{color:var(--fg);font-weight:650;background:var(--panel);border-color:var(--line)}
input.pw{width:180px;min-height:36px;padding:0 12px;font:inherit;font-size:13.5px;color:var(--fg);background:var(--bg);border:1px solid var(--line-2);border-radius:var(--r)}
.tag{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;padding:2px 8px;border-radius:5px;background:var(--panel-2);border:1px solid var(--line);color:var(--muted)}
.tag::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.7}
.tag.t-hot{color:var(--hot);background:transparent;border-color:color-mix(in srgb,var(--hot) 28%,transparent)}
.tag.t-no{color:var(--bad);background:var(--bad-soft);border-color:color-mix(in srgb,var(--bad) 22%,transparent)}
.tag.t-mute{color:var(--muted);background:var(--panel-2)}
.note{margin:0 0 18px;padding:11px 14px;font-size:13.5px;border-radius:8px;background:var(--panel);border:1px solid var(--line)}
.hint{margin:0 0 14px;font-size:13px;color:var(--muted);max-width:72ch}
.chips{display:flex;flex-wrap:wrap;align-items:center;gap:0 16px;margin:0 0 20px;font-size:13px;color:var(--muted)}
.chip{display:inline-flex;align-items:center;gap:6px;padding:0;font-size:13px;color:var(--muted);background:none;border:0;border-radius:0}
.chip+.chip::before{content:"·";margin-right:16px;color:var(--line-2)}
.chip b{color:var(--fg);font-weight:650;font-variant-numeric:tabular-nums}
.chip a{color:var(--fg);font-weight:600;border-bottom:1px solid var(--line-2)}
.sticky{position:sticky;top:0;z-index:6;display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:12px 0;margin:0 0 6px;background:var(--bg);border-bottom:1px solid var(--line)}
.search{flex:1 1 260px;min-height:44px;padding:0 14px;font:inherit;font-size:14px;color:var(--fg);background:var(--bg);border:1px solid var(--line-2);border-radius:var(--r);outline:none}
.search:focus{border-color:var(--hot);box-shadow:0 0 0 3px var(--hot-soft)}
.who{display:flex;align-items:center;gap:10px}
.av{display:grid;place-items:center;width:26px;height:26px;flex:0 0 auto;font-size:10.5px;font-weight:650;letter-spacing:.02em;color:var(--muted);background:var(--panel);border:1px solid var(--line);border-radius:6px}
.nm{font-weight:600}
.num{width:1%;font-variant-numeric:tabular-nums;color:var(--muted)}
.folder{font-weight:600}
.pop{display:inline-block}
.pop summary{list-style:none;cursor:pointer}
.pop summary::-webkit-details-marker{display:none}
.pwpop{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 0;padding:10px;background:var(--bg);border:1px solid var(--line-2);border-radius:8px}
.quick{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px}
.help{margin:0;padding-left:18px;font-size:13px;color:var(--muted);max-width:72ch}
.help li{margin:0 0 7px}
tr[hidden]{display:none}
.figure{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin:26px 0 10px}
.figure b{font-size:clamp(46px,9vw,78px);font-weight:600;letter-spacing:-.05em;line-height:.85;font-variant-numeric:tabular-nums}
.figure span{font-size:14px;color:var(--muted)}
.census{display:flex;flex-wrap:wrap;gap:4px 24px;margin:0 0 8px;padding:0;list-style:none;font-size:13px;color:var(--muted)}
.census b{color:var(--fg);font-weight:650;font-variant-numeric:tabular-nums}
@media(max-width:700px){td.hide,th.hide{display:none}body{padding:16px 14px 56px}th,td{padding:10px 10px 10px 0;font-size:13px}.btn,button{min-height:44px}.actions form{margin:0 4px 4px 0}}
`;

// How many folders a person can see, in plain words, for the people list.
function accessText(u) {
  if (u.is_admin) return 'Every folder';
  if (!meta.ready) return '-';
  const rules = rulesFor(u.id);
  const total = meta.folderPath.size;
  let shown = 0;
  for (const p of meta.folderPath.values()) if (visibleTo(p, rules)) shown++;
  if (shown === total) return `All ${total} folders`;
  if (shown === 0) return 'No folders';
  return `${shown} of ${total} folders`;
}

function adminPage(me, users, sessions, msg) {
  const notes = {
    revoked: 'Session killed. That browser is signed out now.',
    disabled: 'Account disabled and every session removed.',
    enabled: 'Account enabled again.',
    signout: 'Signed out everywhere. They must sign in again.',
    self: 'You cannot do that to your own account.',
    pw: 'Password set. Their other sessions are signed out.',
    pwshort: `Passwords need ${MIN_PASSWORD} characters or more.`,
    nouser: 'That person does not exist.',
  };

  const userRows = users
    .map((u) => {
      const isMe = u.username === me.username;
      const tags = [
        u.is_admin ? '<span class="tag t-hot">admin</span>' : '',
        u.active ? '' : '<span class="tag t-no">off</span>',
        isMe ? '<span class="tag t-mute">you</span>' : '',
      ].join(' ');

      const pw = isMe
        ? ''
        : `<details class="pop"><summary class="btn">Password</summary>
        <form class="pwpop" method="post" action="/admin/password">
          <input type="hidden" name="username" value="${esc(u.username)}">
          <input class="pw" name="password" type="password" placeholder="New password" minlength="${MIN_PASSWORD}" autocomplete="new-password" required>
          <button class="btn primary" type="submit">Save</button>
        </form></details>`;

      const toggle = isMe
        ? ''
        : `<form method="post" action="/admin/user"><input type="hidden" name="username" value="${esc(u.username)}"><input type="hidden" name="action" value="${u.active ? 'off' : 'on'}"><button class="btn${u.active ? ' danger' : ''}" type="submit">${u.active ? 'Disable' : 'Enable'}</button></form>`;

      return `<tr data-name="${esc(u.username)}">
        <td class="who"><span class="av">${esc(u.username.slice(0, 2).toUpperCase())}</span><span class="nm">${esc(u.username)} ${tags}</span></td>
        <td class="hide">${esc(accessText(u))}</td>
        <td class="actions">
          <a class="btn" href="/admin/folders?u=${encodeURIComponent(u.username)}">Folders</a>
          ${pw}${toggle}
        </td>
      </tr>`;
    })
    .join('');

  const active = users.filter((u) => u.active).length;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Admin</title><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark">
<link rel="icon" href="/favicon.ico" sizes="any">
<style>${ADMIN_CSS}</style></head><body>
<h1>Admin</h1>
<p class="sub">Signed in as ${esc(me.username)}. <a href="/">Back to the videos</a></p>
${msg && notes[msg] ? `<p class="note">${notes[msg]}</p>` : ''}

<div class="chips">
  <span class="chip"><b>${users.length}</b> people</span>
  <span class="chip"><b>${active}</b> enabled</span>
  <span class="chip"><b>${sessions.length}</b> signed in</span>
  <span class="chip"><a href="/admin/folders?u=*">Folders for everyone</a></span>
  <a class="chip" href="/admin/analytics"><b>Analytics</b></a>
</div>

<div class="sticky">
  <input class="search" id="people-q" type="search" placeholder="Find a person" autocomplete="off" spellcheck="false">
</div>

<h2>People</h2>
<p class="hint">Folders opens the list where you show or hide each folder for that person.</p>
<table><thead><tr><th>Person</th><th class="hide">Sees</th><th>Actions</th></tr></thead><tbody>${
    userRows || '<tr><td colspan="3">Nobody here yet. Run node scripts/seed-users.mjs to add the first accounts.</td></tr>'
  }</tbody></table>

<h2>How folders work</h2>
<ul class="help">
  <li>Showing a folder shows everything inside it, including subfolders you add later.</li>
  <li>A rule on a subfolder beats the rule on the folder above it.</li>
  <li>${FOLDERS_OPEN ? 'Local development is open: everyone sees every folder until you hide one.' : 'A folder with no rule stays hidden. Admins always see everything.'}</li>
  <li>Disabling a person signs them out everywhere and blocks them until you enable them.</li>
</ul>

<script>
  const box = document.getElementById('people-q');
  box.addEventListener('input', () => {
    const s = box.value.trim().toLowerCase();
    for (const tr of document.querySelectorAll('tr[data-name]')) {
      tr.hidden = !!s && !tr.dataset.name.includes(s);
    }
  });
</script>
</body></html>`;
}

// Signs, sessions and library size in one place. Management stays on /admin.
function analyticsPage(me, users, sessions, seenByUser, stats) {
  const live = sessions.length;
  const census = [
    ['people', users.length],
    ['enabled', users.filter((u) => u.active).length],
    ['folders indexed', stats.folders],
    ['videos indexed', stats.videos],
  ]
    .map(([k, v]) => `<li><b>${v}</b> ${k}</li>`)
    .join('');

  const sessionRows = sessions
    .map(
      (s) => `<tr>
        <td class="who"><span class="av">${esc(s.username.slice(0, 2).toUpperCase())}</span><span class="nm">${esc(s.username)}</span></td>
        <td class="hide">${esc(s.ip || '-')}</td>
        <td>${when(s.last_seen)}</td>
        <td class="hide">${when(s.expires_at)}</td>
        <td class="actions"><form method="post" action="/admin/revoke"><input type="hidden" name="id" value="${s.id}"><button class="btn danger" type="submit">Sign out</button></form></td>
      </tr>`
    )
    .join('');

  const peopleRows = users
    .map((u) => {
      const seen = seenByUser.get(u.id);
      const tags = [u.is_admin ? '<span class="tag t-hot">admin</span>' : '', u.active ? '' : '<span class="tag t-no">off</span>']
        .join(' ')
        .trim();
      return `<tr>
        <td class="who"><span class="av">${esc(u.username.slice(0, 2).toUpperCase())}</span><span class="nm">${esc(u.username)} ${tags}</span></td>
        <td class="num">${u.live || 0}</td>
        <td class="num hide">${seen ? seen.n : 0}</td>
        <td>${seen ? when(seen.seen) : 'never'}</td>
        <td class="hide">${esc(accessText(u))}</td>
      </tr>`;
    })
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Analytics</title><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark">
<link rel="icon" href="/favicon.ico" sizes="any">
<style>${ADMIN_CSS}</style></head><body>
<h1>Analytics</h1>
<p class="sub">Signed in as ${esc(me.username)}. <a href="/admin">Back to people</a> · <a href="/">Back to the videos</a></p>

<div class="figure"><b>${live}</b><span>${live === 1 ? 'session open' : 'sessions open'}</span></div>
<ul class="census">${census}</ul>

<h2>Signed in now</h2>
<p class="hint">One row per open session. Sign out closes that browser only.</p>
<table><thead><tr><th>Person</th><th class="hide">Address</th><th>Last seen</th><th class="hide">Expires</th><th></th></tr></thead><tbody>${
    sessionRows || '<tr><td colspan="5">Nobody is signed in. A row appears here while someone has the gallery open.</td></tr>'
  }</tbody></table>

<h2>People</h2>
<p class="hint">Sessions on record counts the sign-ins still stored. Signing out removes the row.</p>
<table><thead><tr><th>Person</th><th>Signed in</th><th class="hide">On record</th><th>Last seen</th><th class="hide">Sees</th></tr></thead><tbody>${
    peopleRows || '<tr><td colspan="5">Nobody here yet.</td></tr>'
  }</tbody></table>
</body></html>`;
}

// One row per folder, with its state for the person being edited.
function folderRows(target) {
  const userId = target ? target.id : EVERYONE;
  const own = new Map(qRules.own.all(userId).map((r) => [r.path, r.allow]));
  const rules = rulesFor(userId);
  const stateOf = (p) => {
    if (own.has(p)) return own.get(p) ? { text: 'Shown', cls: 't-hot' } : { text: 'Hidden', cls: 't-no' };
    if (p === '') return { text: 'No rule', cls: 't-mute' };
    return visibleTo(p, rules)
      ? { text: 'Shown from parent', cls: 't-mute' }
      : { text: 'Hidden from parent', cls: 't-mute' };
  };

  const rows = [];
  const add = (p, name, depth, count) =>
    rows.push({ path: p, name, depth, count, own: own.has(p), state: stateOf(p), shown: visibleTo(p, rules) });
  const tree = meta.nodes.get('root');
  add('', 'All folders', 0, tree.count);

  const walk = (node, rel, depth) => {
    for (const f of node.folders || []) {
      const childRel = rel ? rel + '/' + f.name : f.name;
      add(childRel, f.name, depth, f.count);
      const child = meta.nodes.get(f.id);
      if (child) walk(child, childRel, depth + 1);
    }
  };
  walk(tree, '', 1);
  return rows;
}

function foldersPage(me, target, people, rows, msg) {
  const notes = {
    show: 'Shown. That person sees this folder from now on.',
    hide: 'Hidden. That person no longer sees this folder.',
    clear: 'Rule removed. The folder follows the one above it again.',
    reset: 'Every rule removed for this person.',
    nosuch: 'That folder does not exist any more. Reload the page.',
    nouser: 'That person does not exist.',
    bad: 'That change was not understood.',
  };

  const who = target ? target.username : '*';
  const label = target ? esc(target.username) : 'everyone';
  const pick = document_links(target, people);

  const total = Math.max(rows.length - 1, 0);
  const shown = rows.filter((r) => r.path !== '' && r.shown).length;
  const setHere = rows.filter((r) => r.own).length;

  const post = (path, action, text, cls) => `<form method="post" action="/admin/folders">
      <input type="hidden" name="u" value="${esc(who)}">
      <input type="hidden" name="path" value="${esc(path)}">
      <input type="hidden" name="action" value="${action}">
      <button class="btn${cls ? ' ' + cls : ''}" type="submit">${text}</button></form>`;

  const body = rows
    .map(
      (r) => `<tr data-name="${esc(r.name.toLowerCase())}">
        <td class="folder" style="padding-left:${10 + r.depth * 22}px">${esc(r.name)}${
        r.own ? ' <span class="tag t-hot">set here</span>' : ''
      }</td>
        <td class="num hide">${r.count}</td>
        <td><span class="tag ${r.state.cls}">${r.state.text}</span></td>
        <td class="actions">${post(r.path, 'show', 'Show')}${post(r.path, 'hide', 'Hide', 'danger')}${
        r.own ? post(r.path, 'clear', 'Follow parent') : ''
      }</td>
      </tr>`
    )
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Folders</title><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark">
<link rel="icon" href="/favicon.ico" sizes="any">
<style>${ADMIN_CSS}</style></head><body>
<h1>Folders for ${label}</h1>
<p class="sub">Signed in as ${esc(me.username)}. <a href="/admin">Back to people</a> · <a href="/">Back to the videos</a></p>
<div class="whoswitch">${pick}</div>
${msg && notes[msg] ? `<p class="note">${notes[msg]}</p>` : ''}

<div class="chips">
  <span class="chip"><b>${shown}</b> of ${total} folders visible</span>
  <span class="chip"><b>${setHere}</b> rules set here</span>
</div>

${
  target && target.is_admin
    ? '<p class="note">Admins see every folder. A rule here changes nothing for this person.</p>'
    : ''
}
${
  FOLDERS_OPEN
    ? '<p class="note">Local development is open: everyone sees every folder until a rule hides one.</p>'
    : ''
}

<div class="quick">
  ${post('', 'show', 'Show everything', 'primary')}
  ${post('', 'hide', 'Hide everything')}
  ${setHere ? post('', 'reset', 'Remove all rules', 'danger') : ''}
</div>

<div class="sticky">
  <input class="search" id="folder-q" type="search" placeholder="Find a folder" autocomplete="off" spellcheck="false">
  <span class="hint" id="matches"></span>
</div>

<table><thead><tr><th>Folder</th><th class="hide">Videos</th><th>State</th><th>Change</th></tr></thead><tbody>${
    body || '<tr><td colspan="4">No folders indexed yet.</td></tr>'
  }</tbody></table>

<p class="hint">A rule covers the folder and everything inside it, including subfolders you add later. The closest rule wins, and a person's own rule beats the rule for everyone.</p>

<script>
  const q = document.getElementById('folder-q');
  const m = document.getElementById('matches');
  q.addEventListener('input', () => {
    const s = q.value.trim().toLowerCase();
    let hits = 0;
    for (const tr of document.querySelectorAll('tr[data-name]')) {
      const hit = !s || tr.dataset.name.includes(s);
      tr.hidden = !hit;
      if (hit) hits++;
    }
    m.textContent = s ? hits + (hits === 1 ? ' match' : ' matches') : '';
  });
</script>
</body></html>`;
}

function document_links(target, people) {
  const one = (name, text, on) =>
    `<a href="/admin/folders?u=${encodeURIComponent(name)}"${on ? ' class="on"' : ''}>${text}</a>`;
  const links = [one('*', 'Everyone', !target)];
  for (const p of people) links.push(one(p.username, esc(p.username), target && p.username === target.username));
  return links.join('');
}

// True when a browser request comes from the same site. Ignores the port, and
// treats localhost and 127.0.0.1 as the same machine.
function sameSite(origin, host) {
  const name = (h) => String(h || '').split(':')[0].replace(/^\[|\]$/g, '').toLowerCase();
  const local = (n) => n === 'localhost' || n === '127.0.0.1' || n === '::1';
  let originHost = '';
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  const a = name(originHost);
  const b = name(host);
  if (!a || !b) return false;
  return a === b || (local(a) && local(b));
}

function blockedPage(name) {
  const who = name ? `Signed in as <b>${esc(name)}</b>. That account is not an admin.` : 'You are not signed in.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not allowed</title>
<meta name="color-scheme" content="light dark">
<style>:root{--bg:#fff;--fg:#0a0b0d;--muted:#5c6470;--hot:#1a56ff;--cta:#1a56ff}
@media(prefers-color-scheme:dark){:root{--bg:#08090b;--fg:#f4f6f9;--muted:#98a1af;--hot:#5b9cff;--cta:#2f6bff}}
body{display:grid;place-items:center;min-height:100dvh;margin:0;padding:24px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif;text-align:center}
h1{margin:0 0 10px;font-size:clamp(28px,5vw,54px);font-weight:850;letter-spacing:-.04em;text-transform:uppercase}
p{margin:0 0 22px;color:var(--muted)}
p b{color:var(--fg)}
form{display:inline;margin:0 6px}
a.btn,button{display:inline-block;padding:12px 24px;font:inherit;font-size:13px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;text-decoration:none;cursor:pointer;border-radius:999px}
a.btn{color:var(--fg);background:var(--bg);border:1px solid var(--hot)}
button{color:#fff;background:var(--cta);border:0}
</style>
</head><body><div><h1>Not allowed</h1><p>${who}<br>This area is for the admin.</p><a class="btn" href="/">Back to the videos</a><form method="post" action="/api/logout"><button type="submit">Sign out</button></form></div></body></html>`;
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
.card{width:100%;max-width:420px}
.row{margin:0 0 12px}
.err{margin:0 0 18px;padding:12px 15px;font-size:14px;font-weight:600;border-radius:14px;color:#b42318;background:#fee4e2}
.err.ok{color:#067647;background:#d1fadf}
@media (prefers-color-scheme:dark){.err{color:#ffb4ab;background:#3b1512}.err.ok{color:#a6f4c5;background:#0b2e1d}}
.back{font-size:14px;margin:0 0 22px;color:var(--muted)}
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
    // nginx subrequest: 204 means allowed, 401 means send the person to the login
    // page, 403 means signed in but this folder is not theirs.
    if (url.pathname === '/__auth') {
      const token = cookies(req)[COOKIE];
      const ok = checkSession(token);
      if (!ok) return send({ status: 401, body: '', headers: { 'cache-control': 'no-store' } });
      if (++writes % 200 === 0) q.pruneAttempts.run(now() - DAY);

      // Video files sit at their real path, so the check is on that path.
      const original = String(req.headers['x-original-uri'] || '');
      if (original.startsWith('/v/') && !ok.isAdmin) {
        const rel = videoPathFromUri(original);
        if (!rel) return send({ status: 403, body: '', headers: { 'cache-control': 'no-store' } });
        if (!(await ensureMeta())) return send({ status: 503, body: '', headers: { 'cache-control': 'no-store' } });
        if (!visibleTo(rel, rulesFor(ok.userId))) {
          return send({ status: 403, body: '', headers: { 'cache-control': 'no-store' } });
        }
      }

      return send({ status: 204, body: '', headers: { 'cache-control': 'no-store' } });
    }

    // The folder list is built per person, so it is served from here, not as a
    // plain file. Nobody can ask for a folder they were not shown.
    if (url.pathname === '/m/tree.json' || url.pathname.startsWith('/m/f/') || url.pathname === '/m/durations.json') {
      const s = checkSession(cookies(req)[COOKIE]);
      if (!s) return send({ status: 401, body: '', headers: { 'cache-control': 'no-store' } });
      if (!(await ensureMeta())) {
        return send({
          status: 503,
          body: 'The library index is still being built. Try again in a moment.',
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
        });
      }

      const rules = s.isAdmin ? ALLOW_ALL : rulesFor(s.userId);

      if (url.pathname === '/m/durations.json') {
        let all = {};
        try {
          all = JSON.parse(await fs.readFile(path.join(META_DIR, 'durations.json'), 'utf8'));
        } catch {
          all = {};
        }
        const out = {};
        for (const [id, secs] of Object.entries(all || {})) {
          const file = meta.videoPath.get(id);
          if (file && visibleTo(file, rules)) out[id] = secs;
        }
        return send({
          status: 200,
          body: JSON.stringify(out),
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, max-age=300' },
        });
      }

      let id = 'root';
      if (url.pathname.startsWith('/m/f/')) id = url.pathname.slice(5).replace(/\.json$/, '');
      const node = meta.nodes.get(id);
      if (!node) return send(json(404, { error: 'no such folder' }));

      const rel = id === 'root' ? '' : meta.folderPath.get(id) || '';
      // Root is the container. Its contents are filtered, so it is always sent.
      // Any other folder id is a hash of the name, so a guesser can work it out.
      if (id !== 'root' && !visibleTo(rel, rules)) return send(json(403, { error: 'not allowed' }));

      const view = viewBuilder(rules)(node, rel);
      return send({
        status: 200,
        body: JSON.stringify({ ...view, generated: new Date().toISOString() }),
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
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
      if (!u || !u.is_admin || !u.active) return send(page(403, blockedPage(u && u.username)));

      // The cookie is SameSite=Lax, so a cross-site form cannot carry it. This
      // check is a second lock, and it compares names only: a dev proxy may
      // change the port, and localhost and 127.0.0.1 are the same machine.
      if (req.method === 'POST') {
        const origin = String(req.headers.origin || '');
        const host = String(req.headers['x-forwarded-host'] || req.headers.host || '')
          .split(',')[0]
          .trim()
          .toLowerCase();
        if (origin && !sameSite(origin, host)) {
          return send(page(403, blockedPage(s.username)));
        }
        const body = parseForm(await readBody(req), req.headers['content-type']);

        if (url.pathname === '/admin/revoke' && body.id) {
          q.delSessionById.run(Number(body.id));
          cache.clear();
          return send({ status: 303, body: '', headers: { location: '/admin?m=revoked', 'cache-control': 'no-store' } });
        }
        if (url.pathname === '/admin/user' && body.username) {
          const target = String(body.username).toLowerCase();
          const act = String(body.action || '');
          if (target === u.username) {
            return send({ status: 303, body: '', headers: { location: '/admin?m=self', 'cache-control': 'no-store' } });
          }
          if (!q.userByName.get(target)) {
            return send({ status: 303, body: '', headers: { location: '/admin?m=nouser', 'cache-control': 'no-store' } });
          }

          // Sign out everywhere, without touching the account.
          if (act === 'signout') {
            q.delSessionsFor.run(target);
            cache.clear();
            return send({ status: 303, body: '', headers: { location: '/admin?m=signout', 'cache-control': 'no-store' } });
          }

          const off = act === 'off';
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

        // Show or hide one folder for one person, or for everyone.
        if (url.pathname === '/admin/folders') {
          await ensureMeta();
          const who = String(body.u || '*').toLowerCase();
          const targetPath = String(body.path || '');
          const action = String(body.action || '');
          const back = (m) => send({ status: 303, body: '', headers: { location: `/admin/folders?u=${encodeURIComponent(who)}&m=${m}`, 'cache-control': 'no-store' } });

          const person = who === '*' ? null : q.userByName.get(who);
          if (who !== '*' && !person) return back('nouser');
          if (targetPath !== '' && !meta.paths.has(targetPath)) return back('nosuch');

          const userId = person ? person.id : EVERYONE;
          if (action === 'show' || action === 'hide') qRules.set.run(userId, targetPath, action === 'show' ? 1 : 0, now());
          else if (action === 'clear') qRules.clear.run(userId, targetPath);
          else if (action === 'reset') qRules.clearAll.run(userId);
          else return back('bad');

          noteRulesChanged();
          return back(action);
        }
      }

      if (url.pathname === '/admin/analytics') {
        await ensureMeta();
        const t = now();
        const users = q.adminUsers.all(t);
        const sessions = q.adminSessions.all(t);
        const seen = new Map(q.lastSeen.all().map((r) => [r.user_id, r]));
        const stats = {
          folders: meta.ready ? meta.folderPath.size : 0,
          videos: meta.ready ? meta.nodes.get('root').count : 0,
        };
        return send(page(200, analyticsPage(u, users, sessions, seen, stats)));
      }

      if (url.pathname === '/admin/folders') {
        await ensureMeta();
        const who = String(url.searchParams.get('u') || '*').toLowerCase();
        const person = who === '*' ? null : q.userByName.get(who);
        if (who !== '*' && !person) {
          return send({ status: 303, body: '', headers: { location: '/admin?m=nouser', 'cache-control': 'no-store' } });
        }
        // Admins always see everything, so they are not worth a rule.
        const people = q.adminUsers.all(now()).filter((p) => !p.is_admin);
        const rows = meta.ready ? folderRows(person) : [];
        return send(page(200, foldersPage(u, person, people, rows, url.searchParams.get('m'))));
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

// The folder list is read at start, so the first click is already fast.
ensureMeta();

server.listen(PORT, '127.0.0.1', () => console.log(`[auth] listening on 127.0.0.1:${PORT}`));