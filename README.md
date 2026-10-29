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

## Database

- It is one SQLite file, and it lives in a normal folder on the host: `./data/db/gallery.db`.
- The folder is mounted into the container. Nothing is hidden inside a Docker volume.
- The folder is chowned to `PUID:PGID` at start, so you can copy it without sudo.
- Copy the whole `data/db` folder. Copying only `gallery.db` can miss the last few writes,
  because SQLite keeps a write-ahead file next to it.
- Stop the container before copying if you want a guaranteed clean set.

## Logins

- Every page, every poster and every video byte is behind the login. There is no public file link.
- Users are read from `secrets/seed-users.txt` on the first start, then stored as Argon2id hashes in SQLite.
- Format: one per line, `username password`. Blank lines and lines starting with `#` are skipped.
- Passwords are never stored in plain text in the database, and no password is ever logged.
- Change a password or add a person: edit the file, then run

```sh
docker compose exec gallery node /app/scripts/seed-users.mjs /data/seed/seed-users.txt
```

- `secrets/` is gitignored, dockerignored and mounted read only. Keep the file `chmod 600`.
  Once the users exist, delete `secrets/seed-users.txt` from the server. The container does not need it again.
- Sessions last 30 days. Change with `SESSION_DAYS`.
- Signing out deletes the session row, so a copied cookie stops working at once.
- Rate limit: 8 failures per account, or 25 per address, inside 15 minutes.
- Wrong password and unknown username return the same message. The page does not reveal which accounts exist.

## Passwords

- Everyone changes their own password at `/account`, from the key icon in the header.
- They must type the current password first. Minimum 10 characters.
- Changing a password signs out every other browser for that person, and keeps the current one.
- Admins set anyone's password from the Password column on `/admin`. No old password needed.
- Setting someone's password signs that person out everywhere.

## Admin

- Set `ADMIN_USERS` in `docker-compose.yml`. Default is `dilshad`. Comma separate several names.
- A template for the seed file sits at `seed-users.example.txt`. Copy it to `secrets/seed-users.txt`.
- Admins see a gear in the header that opens `/admin`.
- The admin page lists every person, their open sessions, the address and the last time seen.
- It can sign one browser out, or disable a person. Disabling removes all their sessions at once.
- An admin cannot disable their own account.
- Everyone else gets a plain "not allowed" page. The check runs on the server, not in the page.
- Every admin form post is rejected when the `Origin` header is another site.

## HTTPS

- Put the container behind a TLS proxy and send `X-Forwarded-Proto`.
- With `https`, the session cookie gets the `Secure` flag and responses carry HSTS.
- With `http`, nginx answers 301 to the same URL on `https`.
- With no header at all, nothing is forced, so local access over plain http still works.

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
