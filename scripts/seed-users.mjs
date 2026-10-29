// Creates or updates logins from a plain text list.
// File format, one per line:  username password
// Blank lines and lines starting with # are ignored.
// Run it manually to update passwords: node scripts/seed-users.mjs /data/seed-users.txt
// It never prints passwords.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hash as argonHash } from '@node-rs/argon2';

const file = process.argv[2] || '/data/seed-users.txt';
const dbPath = process.env.AUTH_DB || '/data/db/gallery.db';
const ARGON = { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 };

let text;
try {
  text = await fs.readFile(file, 'utf8');
} catch {
  console.log(`[seed] no seed file at ${file}, nothing to do`);
  process.exit(0);
}

const rows = [];
for (const line of text.split(/\r?\n/)) {
  const s = line.trim();
  if (!s || s.startsWith('#')) continue;
  const m = s.match(/^([^\s:]+)[\s:]+(.+)$/);
  if (!m) continue;
  rows.push({ username: m[1].toLowerCase(), password: m[2].trim() });
}

if (!rows.length) {
  console.log('[seed] no usable lines');
  process.exit(0);
}

await fs.mkdir(path.dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
`);

const find = db.prepare('SELECT id FROM users WHERE username = ?');
const insert = db.prepare('INSERT INTO users (username, password_hash, active, created_at) VALUES (?, ?, 1, ?)');
const update = db.prepare('UPDATE users SET password_hash = ?, active = 1 WHERE id = ?');

let added = 0;
let changed = 0;
for (const r of rows) {
  const hash = await argonHash(r.password, ARGON);
  const hit = find.get(r.username);
  if (hit) {
    update.run(hash, hit.id);
    changed++;
  } else {
    insert.run(r.username, hash, Date.now());
    added++;
  }
}

console.log(`[seed] users added ${added}, updated ${changed}, total ${rows.length}`);