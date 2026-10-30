#!/usr/bin/env node
// One command for local development: index, login service, media routes and Astro.
// Production runs the same pieces behind nginx. This file only wires them together.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || 'data');
const VIDEOS_DIR = path.resolve(ROOT, process.env.VIDEOS_DIR || 'videos');

const WEB_PORT = String(process.env.DEV_PORT || 4321);
const AUTH_PORT = String(process.env.AUTH_PORT || 9000);
const MEDIA_PORT = String(process.env.MEDIA_PORT || 4322);

const env = {
  ...process.env,
  DATA_DIR,
  VIDEOS_DIR,
  AUTH_PORT,
  MEDIA_PORT,
  AUTH_DB: path.join(DATA_DIR, 'db', 'gallery.db'),
  LOGIN_HTML: path.join(ROOT, 'auth', 'login.html'),
};

const children = [];
let shuttingDown = false;

function start(name, args) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: 'inherit' });
  child.on('exit', (code) => {
    if (shuttingDown || code === 0) return;
    console.error(`[dev] ${name} stopped with code ${code}`);
    stop(code ?? 1);
  });
  children.push(child);
  return child;
}

function stop(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300).unref();
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

console.log(`[dev] videos ${VIDEOS_DIR}`);

// A folder over the network can take a minute to walk. Skip it while developing
// and run `pnpm run scan` when the videos change.
if (process.env.DEV_SKIP_SCAN === '1') {
  console.log('[dev] skipping the scan, using the index already in data/meta');
} else {
  console.log(`[dev] scanning ${VIDEOS_DIR}`);
  const scan = spawnSync(
    process.execPath,
    [path.join(ROOT, 'scripts', 'scan.mjs'), VIDEOS_DIR, path.join(DATA_DIR, 'meta')],
    { cwd: ROOT, env, stdio: 'inherit' }
  );
  if (scan.status !== 0) console.warn('[dev] scan failed, keeping the existing index');
}

start('auth', [path.join(ROOT, 'scripts', 'auth-server.mjs')]);
start('media', [path.join(ROOT, 'scripts', 'dev-media.mjs')]);

const web = start('astro', [
  path.join(ROOT, 'node_modules', 'astro', 'astro.js'),
  'dev',
  '--port',
  WEB_PORT,
]);

web.on('exit', (code) => {
  if (!shuttingDown) stop(code ?? 1);
});
