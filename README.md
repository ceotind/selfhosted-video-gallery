# selfhosted-video-gallery

A very fast, self-hosted video gallery. Point it at a folder of MP4s, open the browser, watch.
No database, no accounts, no queue, no JavaScript framework. One Docker container.

Keywords: self-hosted video gallery, docker video library, lightweight video streaming site,
browse mp4 files in browser, static video gallery, nginx video server, astro video gallery.

## Why it is fast

- The browser downloads about 12 KB of HTML, CSS and JS. There is no framework runtime.
- Folders are indexed once at container start. Opening a folder is one small JSON request.
- Cards render 60 at a time, so a folder with 10,000 videos still opens instantly.
- Posters are 480px WebP, about 11 KB each, and are cached forever.
- Video plays from disk as a plain file with byte ranges. Seeking is instant.
- One shared `<video>` element is created on click and destroyed on close. Phones keep their memory.

## Quick start

```sh
git clone https://github.com/<you>/selfhosted-video-gallery.git
cd selfhosted-video-gallery

# put videos anywhere, then point VIDEOS_DIR at that folder
VIDEOS_DIR=/srv/videos docker compose up -d --build
```

Open http://localhost:8080.

Change the port in `docker-compose.yml` if 8080 is taken.

## How it works

1. `scripts/scan.mjs` walks the video folder at container start and writes:
   - `/m/tree.json` for the top level
   - `/m/f/<id>.json` for each subfolder
   Each video entry is about 45 bytes. 2,000 videos is an 89 KB file.
2. `scripts/posters.mjs` runs in the background. It writes one WebP poster per video and
   records durations. The site is already serving while this runs.
3. nginx serves the static site, the posters, the index and the video files themselves.

## Logins

- Every page, every poster and every video byte is behind the login. There is no public file link.
- Users are read from `seed-users.txt` on the first start, then stored as Argon2id hashes in SQLite.
- Format: one per line, `username password`. Blank lines and lines starting with `#` are skipped.
- Passwords are never stored in plain text in the database, and no password is ever logged.
- Change a password or add a person: edit the file, then run

```sh
docker compose exec gallery node /app/scripts/seed-users.mjs /data/seed-users.txt
```

- `seed-users.txt` is gitignored, dockerignored and mounted read only. Keep it `chmod 600`.
  Delete it from the server once the users exist, if you prefer.
- Sessions last 30 days. Change with `SESSION_DAYS`.
- Signing out deletes the session row, so a copied cookie stops working at once.
- Rate limit: 8 failures per account, or 25 per address, inside 15 minutes.
- Cut a person off immediately:

```sh
docker compose exec gallery node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('/data/db/gallery.db');d.prepare('delete from sessions where user_id=(select id from users where username=?)').run('kevin');console.log('sessions cleared')"
```

- Wrong password and unknown username return the same message. The page does not reveal which accounts exist.
- Behind a TLS proxy, send `X-Forwarded-Proto: https` so the session cookie gets the Secure flag.

## Layout

```
src/pages/index.astro   the whole page shell
src/styles/app.css      light and dark theme in CSS variables
src/scripts/app.js      gallery, search, breadcrumbs, player overlay
scripts/scan.mjs        folder index builder
scripts/posters.mjs     poster and duration worker
docker/nginx.conf       caching, gzip, byte ranges
```

## Notes

- Supported files: mp4, m4v, mov, webm, mkv, ogv.
- Light and dark follow the operating system until someone flips the switch.
- There is no login. Put this behind your own proxy or auth if the library is private.
- The site is `noindex`. Remove the robots meta tag in `index.astro` if you want it crawled.
- Hiding the download button is cosmetic. A browser always receives the video bytes.
- For smoothest seeking, run `ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4` once
  on any file that was not written with the index at the front.

## License

MIT
