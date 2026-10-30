<p align="center">
  <img src="public/logo.png" alt="Self-hosted video gallery logo" width="190" />
</p>

<h1 align="center">selfhosted-video-gallery</h1>

<p align="center">Point it at a folder of videos. Sign in. Watch.<br>
One Docker container, one SQLite file, your own disk.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2ea44f" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/docker-one%20container-1a56ff" alt="Runs as one Docker container">
  <img src="https://img.shields.io/badge/page%20weight-12%20KB-111315" alt="About 12 KB per page">
  <img src="https://img.shields.io/badge/folders-per%20person-1a56ff" alt="Folder rules per person">
</p>

## What this is

A private video library that you host yourself. It reads a folder of videos from your disk and serves it as a fast website. People sign in, open folders, and watch in the browser.

There is no upload step, no transcoding queue and no outside service. One Docker container, one SQLite file, and the video folder you already have.

It suits dance studios, coaches, course sellers, gyms and clubs. Anywhere a library of lessons should only reach the people you invite.

## Why it is fast

- The browser downloads about 12 KB of HTML, CSS and JS. There is no framework runtime.
- Folders are indexed once at container start. Opening a folder is one small JSON request.
- Cards render 60 at a time, so a folder with 10,000 videos still opens instantly.
- Posters are 480px WebP, about 11 KB each, and are cached forever.
- Video plays from disk as a plain file with byte ranges. Seeking is instant.
- One shared `<video>` element is created on click and destroyed on close. Phones keep their memory.

## What you can do

- Sign in with a name and a password. Passwords are stored as Argon2id hashes and never logged.
- Show or hide any folder for any person, at any time, with no restart.
- Add people from the admin page, set their password, or disable them.
- See who is signed in right now, and sign one browser out.
- Let people change their own password from the account page.
- Keep every byte private. There is no public file link and no way to guess a URL.

## Quick start

You need Docker and a folder of videos.

```sh
git clone https://github.com/ceotind/selfhosted-video-gallery.git
cd selfhosted-video-gallery
VIDEOS_DIR=/srv/videos docker compose up -d --build
```

Open http://localhost:8080. Change the port in `docker-compose.yml` if 8080 is taken.

The first start walks the folder and builds posters in the background. The site already serves while that runs.

## First sign in

1. Copy the template: `cp seed-users.example.txt secrets/seed-users.txt`
2. Edit it, one person per line: `username password`
3. Set `ADMIN_USERS` in `docker-compose.yml` to your own name.
4. Start the stack. The file is read once, hashed, and never needed again.

Add people later from the admin page.

## Folder access

Every person starts with nothing. You grant folders.

- Open `/admin`, press Folders on a person, or open "everyone" for a rule that covers all people.
- Every folder has three buttons: Show, Hide, Follow parent.
- A rule covers the folder and every subfolder, including subfolders you add later.
- The closest rule wins. A person's own rule beats the everyone rule at the same folder.
- A new top-level folder stays hidden until you show it. A new folder inside a granted folder shows at once.
- Admins always see every folder. A rule never hides anything from an admin.
- A change takes effect on the next page load.
- A hidden folder leaves the list, leaves the counts, and its videos answer "Not allowed".
- Renaming or moving a folder on disk drops its rule. Set it again.
- The buttons name the person they act on. "Show everything for kevin" changes kevin only.

## Admin pages

| Page | What it shows |
|---|---|
| `/admin` | One row per person, how many folders they see, and the actions |
| `/admin/analytics` | Open sessions with a sign out per browser, plus counts for people, folders and videos |
| `/admin/folders?u=name` | Every folder with Show, Hide and Follow parent, for one person or for everyone |

- Add a person: type a name and a password on `/admin`, then press Add person.
- Password: opens a small box, needs no old password, and signs that person out everywhere.
- Disable: blocks the person and removes every session at once. You cannot disable yourself.
- A person you add is not an admin. Admins come from `ADMIN_USERS`.
- A search box filters the people list, and the folder list, as you type.

## Configuration

Set these in `.env` or in your compose file. Every one is optional.

| Variable | Default | What it does |
|---|---|---|
| `VIDEOS_DIR` | `./videos` | The folder that holds your videos |
| `DATA_DIR` | `./data` | Database, folder index and posters |
| `GALLERY_PORT` | `8080` | Port on the host |
| `PUID` / `PGID` | `1000` | Owner of the files the app writes |
| `ADMIN_USERS` | `dilshad` | Comma separated admin names |
| `SESSION_DAYS` | `30` | How long a sign in lasts |
| `POSTER_WORKERS` | `2` | Posters built at the same time |
| `FOLDERS_OPEN` | unset | `1` shows every folder to everyone, for development |
| `DEV_SKIP_SCAN` | unset | `1` skips the folder walk at start |

## Development

`pnpm run dev` starts all four pieces on your machine:

1. `scripts/scan.mjs` rebuilds the folder index from `VIDEOS_DIR`.
2. `scripts/auth-server.mjs` serves login, logout, `/account` and `/admin` on port 9000.
3. `scripts/dev-media.mjs` serves videos, posters and the index on port 4322.
4. Astro serves the page with hot reload on port 4321.

```sh
pnpm install
cp .env.example .env      # set VIDEOS_DIR and DATA_DIR
pnpm run dev
```

Open http://localhost:4321. Astro proxies `/api/`, `/login`, `/account`, `/admin`, `/v/`, `/p/` and `/m/` to the two local services.

- Stop the Docker container first. Both want the same ports.
- Set `FOLDERS_OPEN=1` while developing, so the library is not empty on the first run.
- Set `DEV_SKIP_SCAN=1` to start without walking the videos folder. Run `pnpm run scan` when videos change.
- A folder over the network can take two minutes to walk.
- `pnpm run dev:web` starts Astro alone, without login or media. The gallery stays empty.
- New videos get no poster until `scripts/posters.mjs` runs. Cards fall back to a glyph.

## How it works

1. `scripts/scan.mjs` walks the video folder at container start and writes `/m/tree.json` for the top level and `/m/f/<id>.json` for each subfolder. Each entry is about 45 bytes, so 2,000 videos make an 89 KB file.
2. `scripts/posters.mjs` runs in the background. It writes one WebP poster per video and records the duration. The site serves while it works.
3. A folder card never shows a blank tile. A folder with videos uses the poster of its first video. A folder with one child borrows that child's picture. A folder with several children gets a 4-up sheet at `data/posters/f-<folder id>.webp`. An empty folder keeps the glyph.
4. nginx serves the site, the posters and the video bytes. The login service answers the folder list, because that list differs per person.
5. The login service holds the folder list in memory and filters it per request, so a click costs a few milliseconds, not a disk read.

## Data and backup

- Everything the app writes sits in plain host folders under `DATA_DIR` (default `./data`). No Docker volume hides it.
- `data/db/gallery.db` is the whole database: people, sessions, folder rules.
- `data/posters/` holds one WebP per video. It rebuilds itself if you delete it.
- `data/meta/` holds the folder index. It rebuilds on every start.
- The container writes as `PUID:PGID`, so every file belongs to you. Set those from `id -u` and `id -g`.
- SQLite keeps helper files beside the database. Copy the whole `data/db` folder, not only `gallery.db`.

## Security

- Every page, every poster and every video byte sits behind the login.
- Sessions are random tokens, stored as hashes. Signing out deletes the row, so a copied cookie stops at once.
- Rate limit: 8 failures per account, or 25 per address, inside 15 minutes.
- A wrong password and an unknown name give the same message. The page never reveals which accounts exist.
- Admin form posts are refused when the browser sends another site as the origin.
- The site sends `noindex`, so search engines stay out.
- Put a TLS proxy in front and send `X-Forwarded-Proto`. With `https`, the cookie gets the Secure flag and responses carry HSTS.

## Deploy and update

```sh
git clone https://github.com/ceotind/selfhosted-video-gallery.git
cd selfhosted-video-gallery
cp .env.example .env        # set VIDEOS_DIR, GALLERY_PORT, PUID and PGID
docker compose up -d --build
```

- To update: pull the new source, then run the same command. It rebuilds and replaces the container in one step.
- Copy source only. Do not copy `data/`, `secrets/` or `.env` between machines unless you want that machine's logins and folder rules too.
- Two installs hold two separate databases. Nothing syncs between them.

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
- Hiding the download button is cosmetic. A browser always receives the video bytes.
- For smoothest seeking, run `ffmpeg -i in.mp4 -c copy -movflags +faststart out.mp4` once on a file that was not written with the index at the front.

## Search terms

People find this project looking for a self-hosted video gallery, a Docker video library, or a private video streaming server. Others want an MP4 browser player, a lightweight media server, or a simple Netflix-style library for their own files. It also suits dance studio video libraries, online course videos, and gym or club lesson archives that need per-person folder access. The stack is nginx, Node and SQLite, built with Astro. It runs on a small VPS, a home server or a Raspberry Pi.

## License

MIT
