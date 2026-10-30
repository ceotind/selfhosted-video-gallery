# selfhosted-video-gallery

A very fast, self-hosted video gallery. Point it at a folder of MP4s, sign in, watch.
No framework, no queue, no external service. One Docker container and one SQLite file.

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

## Development

`pnpm run dev` starts all four pieces on your machine:

1. `scripts/scan.mjs` rebuilds the folder index from `VIDEOS_DIR`.
2. `scripts/auth-server.mjs` serves login, logout, `/account` and `/admin` on port 9000.
3. `scripts/dev-media.mjs` serves videos, posters and the index on port 4322.
4. Astro serves the page with hot reload on port 4321.

Open http://localhost:4321. Astro proxies `/api/`, `/login`, `/account`, `/admin`,
`/v/`, `/p/` and `/m/` to the two local services.

```sh
pnpm install
cp .env.example .env      # set VIDEOS_DIR and DATA_DIR
pnpm run dev
```

- The command reads `.env`. `VIDEOS_DIR` defaults to `./videos` and `DATA_DIR` to `./data`.
- Set `FOLDERS_OPEN=1` while developing. Every person then sees every folder until you hide
  one, so the library is not empty on the first run. Production leaves it unset and starts closed.
- Set `DEV_SKIP_SCAN=1` to start without walking the videos folder. Run `pnpm run scan`
  when the videos change. A folder over the network can take two minutes to walk.
- Log in with a user from `data/db/gallery.db`. A signed-out page sends you to the login.
- Stop the Docker container first. Both want the same ports.
- `pnpm run dev:web` starts Astro alone, without login or media. The gallery stays empty.
- New videos get no poster until `scripts/posters.mjs` runs. Cards fall back to a glyph.

## Deploy

Build on the server and start it. The image is built from the source in that folder.

```sh
git clone https://github.com/<you>/selfhosted-video-gallery.git
cd selfhosted-video-gallery
cp .env.example .env        # set VIDEOS_DIR, GALLERY_PORT, PUID and PGID
docker compose up -d --build
```

- To update: copy or pull the new source, then run the same command. It rebuilds and replaces
  the container in one step. The index is rewritten at start, and missing posters fill in.
- Source only. Do not copy `data/`, `secrets/` or `.env` between machines unless you want that
  machine's logins and folder rules too. Every install keeps its own database.
- The other install is not connected to this one. Two servers hold two separate databases.
- Behind a proxy, send `X-Forwarded-Proto`. See HTTPS below.

## How it works

1. `scripts/scan.mjs` walks the video folder at container start and writes:
   - `/m/tree.json` for the top level
   - `/m/f/<id>.json` for each subfolder
   Each video entry is about 45 bytes. 2,000 videos is an 89 KB file.
   The login service reads these once, then builds a filtered copy per person.
2. `scripts/posters.mjs` runs in the background. It writes one WebP poster per video and
   records durations. The site is already serving while this runs.
3. Folder cards get a picture too, never a blank tile:
   - A folder with videos uses the poster of its first video.
   - A folder with one child borrows that child's picture, so no new file is written.
   - A folder with more than one child gets a 4-up sheet built from four evenly spaced
     children, first, last and two in between. The sheet is `data/posters/f-<folder id>.webp`.
   - An empty folder keeps the plain glyph.
4. nginx serves the static site, the posters and the video files themselves. The login
   service answers the folder list, because that list is different for each person.

## Data folders

- Everything the app writes is a plain folder on the host, under `DATA_DIR` (default `./data`).
- `data/db/gallery.db` is the database, one SQLite file.
- `data/posters/` holds one WebP poster per video. It rebuilds itself if deleted.
- `data/meta/` holds the folder index. It rebuilds itself on every start.
- No Docker volume is involved, so nothing hides inside Docker.
- The container runs its writers as `PUID:PGID`, so every file belongs to you.
  Set those in `.env` from `id -u` and `id -g`.
- SQLite keeps two helper files beside the database. Copy the whole `data/db` folder,
  not only `gallery.db`, or you can miss recent writes.

## Logins

- Every page, every poster and every video byte is behind the login. There is no public file link.
- Every folder list and every video is also checked against that person's folders.
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
- Three admin screens, all rendered by the login service:

| Path | What it shows |
|---|---|
| `/admin` | One row per person, how many folders they see, and the actions |
| `/admin/analytics` | Open sessions with a sign out per browser, plus counts for people, folders and videos |
| `/admin/folders?u=name` | Every folder with Show, Hide and Follow parent, for one person or for everyone |

- Actions on `/admin`: Folders, Password, Disable. Password opens a small box and needs no old
  password. Disable signs the person out everywhere and blocks them until you enable them again.
- Add a person from `/admin`: type a name and a password, then press Add person. The password is
  hashed before it is stored, and the new person can sign in at once. Names use letters, numbers,
  dot, dash or underscore.
- A person you add is not an admin. Admins come from `ADMIN_USERS`.
- A search box filters the people list, and the folder list, as you type.
- An admin cannot disable their own account.
- Everyone else gets a plain "not allowed" page naming the account they are signed in as.
  The check runs on the server, not in the page.
- Every admin form post is rejected when the `Origin` header names another site.

## Folder access

- Each person sees only the folders you grant. With no rule, they get an empty library.
- Admins always see every folder. A rule never hides anything from an admin.
- Open `/admin`, then the Folders link on a person, or "Set it for everyone at once".
- Every folder has three buttons: Show, Hide, Follow parent.
- A rule covers the folder and every subfolder, including subfolders added later.
- The closest rule wins. A person's own rule beats the rule for everyone at the same folder.
- A new top-level folder is hidden until you show it. A new folder inside a granted folder is visible at once.
- A change takes effect on the next page load. No restart, no rebuild.
- A hidden folder leaves the list, leaves the counts, and its videos answer "Not allowed".
- Renaming or moving a folder on disk drops its rule. Set it again after the change.
- Folder tile pictures are built from child folders, so a hidden child can still appear
  inside the tile of a folder it was hidden from. The video itself stays blocked.
- The login service holds the folder list in memory and filters it per request, so a
  click costs a few milliseconds, not a disk read.

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
scripts/auth-server.mjs login, sessions, folder rules, admin screens
scripts/scan.mjs        folder index builder
scripts/posters.mjs     poster and duration worker
scripts/seed-users.mjs  creates or updates logins from a plain text list
scripts/dev.mjs         one command for local development
scripts/dev-media.mjs   local stand-in for the nginx media routes
docker/nginx.conf       caching, gzip, byte ranges
docker-compose.yml      one service, host folders for data
```

## Notes

- Supported files: mp4, m4v, mov, webm, mkv, ogv.
- Light and dark follow the operating system until someone flips the switch.
- Every page sits behind the login. Put a TLS proxy in front if it faces the internet.
- The site is `noindex`. Remove the robots meta tag in `index.astro` if you want it crawled.
- Hiding the download button is cosmetic. A browser always receives the video bytes.
- For smoothest seeking, run `ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4` once
  on any file that was not written with the index at the front.

## License

MIT
