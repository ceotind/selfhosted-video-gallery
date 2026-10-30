#!/usr/bin/env node
// Local stand-in for the nginx media routes. Development only.
// Astro dev proxies /v, /p and /m here. Production serves the same paths from nginx.

import http from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.MEDIA_PORT || 4322);
const HOST = '127.0.0.1';

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const MOUNTS = new Map([
  ['/v/', path.resolve(process.env.VIDEOS_DIR || './videos')],
  ['/p/', path.join(DATA_DIR, 'posters')],
  ['/m/', path.join(DATA_DIR, 'meta')],
]);

const TYPES = new Map([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.mkv', 'video/x-matroska'],
  ['.ogv', 'video/ogg'],
  ['.webp', 'image/webp'],
  ['.json', 'application/json; charset=utf-8'],
]);

const notFound = (res) => {
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('Not found');
};

// Map a URL path to a file, refusing anything that escapes its mount.
function resolveFile(pathname) {
  const root = MOUNTS.get(pathname.slice(0, 3));
  if (!root) return null;

  let rel;
  try {
    rel = decodeURIComponent(pathname.slice(3));
  } catch {
    return null;
  }

  const file = path.resolve(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return file;
}

// Single byte range only. That is all a browser needs to seek in a video.
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (m[1] === '' && m[2] === '')) return null;

  let start;
  let end;
  if (m[1] === '') {
    const back = Number(m[2]);
    if (!back) return null;
    start = Math.max(0, size - back);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }

  if (start > end || start >= size) return null;
  return { start, end };
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    return res.end();
  }

  const url = new URL(req.url, 'http://local');
  const file = resolveFile(url.pathname);
  if (!file) return notFound(res);

  let stat;
  try {
    stat = await fs.stat(file);
  } catch {
    return notFound(res);
  }
  if (!stat.isFile()) return notFound(res);

  const size = stat.size;
  const headers = {
    'content-type': TYPES.get(path.extname(file).toLowerCase()) || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'last-modified': stat.mtime.toUTCString(),
  };

  const range = req.headers.range;
  if (range) {
    const part = parseRange(range, size);
    if (!part) {
      res.writeHead(416, { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' });
      return res.end();
    }
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${part.start}-${part.end}/${size}`,
      'content-length': part.end - part.start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    return createReadStream(file, { start: part.start, end: part.end }).pipe(res);
  }

  res.writeHead(200, { ...headers, 'content-length': size });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
});

server.listen(PORT, HOST, () => {
  console.log(`[media] videos ${MOUNTS.get('/v/')}`);
  console.log(`[media] listening on http://${HOST}:${PORT}`);
});
