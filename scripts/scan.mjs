#!/usr/bin/env node
// Builds the index the browser reads: a folder list, then one file per folder.
// Runs at container start, never at image build, so new videos need a restart only.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const VIDEO_EXT = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ogv']);
const videosDir = path.resolve(process.argv[2] || process.env.VIDEOS_DIR || './videos');
const metaDir = path.resolve(process.argv[3] || (process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'meta') : './data/meta'));

// Hash the NFC form of the path. macOS hashed names differ from the names Linux
// reports, and posters.mjs hashes the same NFC form, so both must agree.
const id = (rel) => crypto.createHash('sha1').update(rel.normalize('NFC')).digest('hex').slice(0, 10);
const clean = (s) => s.normalize('NFC');

async function walk(dir, rel, trail, out) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const folders = [];
  const videos = [];

  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) {
      const child = await walk(abs, r, [...trail, { id: id(r), name: clean(e.name) }], out);
      if (child.count > 0) folders.push({ id: id(r), name: clean(e.name), count: child.count, p: child.p });
    } else if (e.isFile() && VIDEO_EXT.has(path.extname(e.name).toLowerCase())) {
      const st = await fs.stat(abs);
      videos.push({ id: id(r), n: clean(path.basename(e.name, path.extname(e.name))), f: clean(r), s: st.size });
    }
  }

  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  videos.sort((a, b) => a.n.localeCompare(b.n, undefined, { numeric: true, sensitivity: 'base' }));

  // The picture a card shows. A folder with videos uses its first poster. A folder
  // with one child borrows that child's picture. A folder with several children
  // gets a sheet, built later by scripts/posters.mjs.
  let poster = null;
  if (videos.length) poster = videos[0].id;
  else if (folders.length === 1) poster = folders[0].p;
  else if (folders.length > 1) poster = 'f-' + id(rel);

  const node = {
    id: rel ? id(rel) : 'root',
    name: rel ? clean(path.basename(rel)) : '',
    path: trail,
    parent: trail.length > 1 ? trail[trail.length - 2].id : null,
    folders,
    videos,
    p: poster,
    count: videos.length + folders.reduce((n, f) => n + f.count, 0),
  };
  out.push(node);
  return node;
}

const nodes = [];
await fs.mkdir(path.join(metaDir, 'f'), { recursive: true });
const root = await walk(videosDir, '', [], nodes);

for (const node of nodes) {
  const file = node.id === 'root' ? path.join(metaDir, 'tree.json') : path.join(metaDir, 'f', node.id + '.json');
  const body = { ...node, generated: new Date().toISOString() };
  await fs.writeFile(file, JSON.stringify(body));
}

console.log(`[scan] folders ${nodes.length - 1}, videos ${root.count}`);
