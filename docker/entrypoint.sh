#!/bin/sh
set -e

UID_RUN="${PUID:-1000}"
GID_RUN="${PGID:-1000}"

mkdir -p /data/meta/f /data/posters /data/db

# The data folders are real host folders. Give them back to the host user and run
# the writers as that user, so every file they create belongs to you.
for d in /data/db /data/posters /data/meta; do
  chown -R "$UID_RUN:$GID_RUN" "$d" 2>/dev/null || true
done

as_user() {
  su-exec "$UID_RUN:$GID_RUN" "$@"
}

# nginx workers must be able to read the videos. Give them the group that owns
# the video folder, without touching the folder itself.
if ! getent group "$GID_RUN" >/dev/null 2>&1; then
  addgroup -g "$GID_RUN" -S videogrp 2>/dev/null || true
fi
VIDEO_GROUP=$(getent group "$GID_RUN" | cut -d: -f1)
if [ -n "$VIDEO_GROUP" ]; then
  addgroup nginx "$VIDEO_GROUP" 2>/dev/null || true
fi

export AUTH_DB="${AUTH_DB:-/data/db/gallery.db}"

echo "[entrypoint] scanning videos"
if ! as_user node /app/scripts/scan.mjs /data/videos /data/meta; then
  echo "[entrypoint] scan failed, serving an empty library"
  printf '{"id":"root","name":"","path":[],"folders":[],"videos":[],"count":0}' > /data/meta/tree.json
fi

# First run only: if no user exists yet and a seed file is mounted, create the logins.
SEED=/data/seed/seed-users.txt
if [ -f "$SEED" ]; then
  COUNT=$(as_user node -e "const {DatabaseSync}=require('node:sqlite');try{const d=new DatabaseSync(process.env.AUTH_DB);console.log(d.prepare('select count(*) as n from users').get().n)}catch(e){console.log(0)}" 2>/dev/null || echo 0)
  if [ "$COUNT" = "0" ]; then
    echo "[entrypoint] no users yet, seeding from $SEED"
    as_user node /app/scripts/seed-users.mjs "$SEED" || echo "[entrypoint] seed failed"
    echo "[entrypoint] seeded. Delete secrets/seed-users.txt now that the users exist."
  fi
fi

echo "[entrypoint] starting login service"
as_user node /app/scripts/auth-server.mjs &
AUTH_PID=$!

# Do not take traffic until the login service answers. Fail closed, not open.
i=0
while [ $i -lt 60 ]; do
  if node -e "fetch('http://127.0.0.1:'+(process.env.AUTH_PORT||9000)+'/__health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    echo "[entrypoint] login service ready"
    break
  fi
  i=$((i + 1))
  sleep 0.5
done
if [ $i -ge 60 ]; then
  echo "[entrypoint] login service did not start"
  kill $AUTH_PID 2>/dev/null || true
  exit 1
fi

# Posters and durations fill in after the site is already answering requests.
as_user node /app/scripts/posters.mjs /data/videos /data/posters /data/meta &

exec nginx -g 'daemon off;'
