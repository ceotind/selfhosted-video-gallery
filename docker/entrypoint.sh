#!/bin/sh
set -e

mkdir -p /data/meta/f /data/posters

echo "[entrypoint] scanning videos"
if ! node /app/scripts/scan.mjs /data/videos /data/meta; then
  echo "[entrypoint] scan failed, serving an empty library"
  printf '{"id":"root","name":"","path":[],"folders":[],"videos":[],"count":0}' > /data/meta/tree.json
fi

# Posters and durations fill in after the site is already answering requests.
node /app/scripts/posters.mjs /data/videos /data/posters /data/meta &

exec nginx -g 'daemon off;'
