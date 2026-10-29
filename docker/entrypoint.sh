#!/bin/sh
set -e

mkdir -p /data/meta/f /data/posters /data/db

export AUTH_DB="${AUTH_DB:-/data/db/gallery.db}"

echo "[entrypoint] scanning videos"
if ! node /app/scripts/scan.mjs /data/videos /data/meta; then
  echo "[entrypoint] scan failed, serving an empty library"
  printf '{"id":"root","name":"","path":[],"folders":[],"videos":[],"count":0}' > /data/meta/tree.json
fi

# First run only: if no user exists yet and a seed file is mounted, create the logins.
if [ -f /data/seed-users.txt ]; then
  COUNT=$(node -e "const {DatabaseSync}=require('node:sqlite');try{const d=new DatabaseSync(process.env.AUTH_DB);console.log(d.prepare('select count(*) as n from users').get().n)}catch(e){console.log(0)}" 2>/dev/null || echo 0)
  if [ "$COUNT" = "0" ]; then
    echo "[entrypoint] no users yet, seeding from /data/seed-users.txt"
    node /app/scripts/seed-users.mjs /data/seed-users.txt || echo "[entrypoint] seed failed"
  fi
fi

echo "[entrypoint] starting login service"
node /app/scripts/auth-server.mjs &
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
node /app/scripts/posters.mjs /data/videos /data/posters /data/meta &

exec nginx -g 'daemon off;'