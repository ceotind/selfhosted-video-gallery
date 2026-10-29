#!/usr/bin/env node
// Makes one WebP poster per video and records durations. Runs in the background
// after the site is already serving, so the first visitor never waits for it.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ogv']);
const videosDir = path.resolve(process.argv[2] || './videos');
const posterDir = path.resolve(process.argv[3] || './data/posters');
const metaDir = path.resolve(process.argv[4] || './data/meta');
const CONCURRENCY = Number(process.env.POSTER_WORKERS || 2);

const id = (rel) => crypto.createHash('sha1').update(rel).digest('hex').slice(0, 10);

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(null));
    p.on('close', (code) => resolve(code === 0 ? out.trim() || '1' : null));
  });
}

async function listVideos(dir, rel = '', acc = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) await listVideos(abs, r, acc);
    else if (VIDEO_EXT.has(path.extname(e.name).toLowerCase())) acc.push({ abs, rel: r, id: id(r.normalize('NFC')) });
  }
  return acc;
}

async function probeDuration(file) {
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const n = Number.parseFloat(out || '');
  return Number.isFinite(n) ? Math.round(n) : null;
}

async function makePoster(file, out) {
  const tmp = out + '.part.webp';
  // -q:v is a JPEG scale; WebP needs -quality, where 75 is visually clean at 480 wide.
  const args = (seek) => [
    '-y', '-loglevel', 'error',
    ...(seek ? ['-ss', '2'] : []),
    '-i', file,
    '-frames:v', '1', '-vf', 'scale=480:-2',
    '-c:v', 'libwebp', '-quality', '75', '-compression_level', '4',
    tmp,
  ];
  if (await run('ffmpeg', args(true))) {
    await fs.rename(tmp, out);
    return true;
  }
  if (await run('ffmpeg', args(false))) {
    await fs.rename(tmp, out);
    return true;
  }
  await fs.rm(tmp, { force: true });
  return false;
}

let durations = {};
try {
  durations = JSON.parse(await fs.readFile(path.join(metaDir, 'durations.json'), 'utf8'));
} catch {}

let writes = 0;
async function saveDurations(force = false) {
  if (!force && writes++ % 25 !== 0) return;
  const file = path.join(metaDir, 'durations.json');
  await fs.writeFile(file + '.tmp', JSON.stringify(durations));
  await fs.rename(file + '.tmp', file);
}

await fs.mkdir(posterDir, { recursive: true });
const videos = await listVideos(videosDir);
console.log(`[posters] ${videos.length} videos queued`);

let done = 0;
const queue = [...videos];

async function worker() {
  while (queue.length) {
    const v = queue.shift();
    const out = path.join(posterDir, v.id + '.webp');
    let has = true;
    try {
      await fs.access(out);
    } catch {
      has = false;
    }
    if (!has) await makePoster(v.abs, out);
    if (durations[v.id] == null) {
      const d = await probeDuration(v.abs);
      if (d != null) durations[v.id] = d;
    }
    if (++done % 50 === 0) {
      console.log(`[posters] ${done}/${videos.length}`);
      await saveDurations();
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
await saveDurations(true);
console.log(`[posters] done, ${done} processed`);
