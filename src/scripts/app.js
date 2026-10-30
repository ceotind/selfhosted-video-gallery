// Gallery shell. No framework, no dependencies, one request per folder opened.

const PAGE = 60;
const grid = document.getElementById('grid');
const count = document.getElementById('count');
const empty = document.getElementById('empty');
const crumbs = document.getElementById('crumbs');
const search = document.getElementById('q');
const sentinel = document.getElementById('sentinel');
const more = document.getElementById('more');
const dialog = document.getElementById('player-dialog');
const player = document.getElementById('player');
const dialogTitle = document.getElementById('dialog-title');

const state = {
  folder: null,
  folders: [],
  videos: [],
  path: [],
  q: '',
  shown: PAGE,
  durations: {},
  note: '',
};

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmt = (sec) => {
  if (!sec) return '';
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
};

const fileUrl = (p) => '/v/' + p.split('/').map(encodeURIComponent).join('/');

// The session can end while the page is open. Behind the web server that shows as
// a redirect, which the browser hides; in dev it shows as a plain 401.
function goLogin() {
  const here = location.pathname + location.search;
  location.href = '/login?next=' + encodeURIComponent(here);
  throw new Error('not signed in');
}

async function getJSON(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'manual' });
  if (res.status === 401 || res.type === 'opaqueredirect') return goLogin();
  if (!res.ok) throw new Error(url + ' ' + res.status);
  return res.json();
}

// A folder someone is no longer allowed to open reads as an empty folder.
async function folderData(id) {
  const url = id === 'root' || !id ? '/m/tree.json' : `/m/f/${id}.json`;
  try {
    return await getJSON(url);
  } catch (e) {
    if (/\s403$/.test(String(e.message))) {
      state.note = 'That folder is not available.';
      return { folders: [], videos: [], path: [] };
    }
    throw e;
  }
}

function matches(name) {
  return !state.q || name.toLowerCase().includes(state.q);
}

function cardFolder(f, i) {
  const eager = i < 8;
  const pic = f.p
    ? `<img src="/p/${esc(f.p)}.webp" alt="" loading="${eager ? 'eager' : 'lazy'}" ${eager ? 'fetchpriority="high"' : ''} decoding="async" width="480" height="270" onerror="this.remove()">`
    : '';
  // A folder is marked at a glance: a folder icon and a count, top left.
  return `<a class="card" href="?f=${f.id}" data-folder="${f.id}">
    <div class="thumb">
      <div class="glyph" aria-hidden="true">▣</div>
      ${pic}
      <span class="count-badge"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.6 4.2h4.1l1.3 1.7h7.4v6.5a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1z"/></svg>${f.count}</span>
    </div>
    <span class="name" title="${esc(f.name)}">${esc(f.name)}</span>
  </a>`;
}

function cardVideo(v, i) {
  const d = state.durations[v.id];
  const eager = i < 8;
  return `<a class="card" href="${fileUrl(v.f)}" data-video="${esc(v.f)}" data-name="${esc(v.n)}">
    <div class="thumb">
      <div class="glyph" aria-hidden="true">▶</div>
      <img src="/p/${v.id}.webp" alt="" loading="${eager ? 'eager' : 'lazy'}" ${eager ? 'fetchpriority="high"' : ''} decoding="async" width="480" height="270" onerror="this.remove()">
      ${d ? `<span class="badge" data-badge="${v.id}">${fmt(d)}</span>` : `<span class="badge" data-badge="${v.id}" hidden></span>`}
    </div>
    <span class="name" title="${esc(v.n)}">${esc(v.n)}</span>
  </a>`;
}

function renderCrumbs() {
  if (!state.path.length) {
    crumbs.hidden = true;
    crumbs.innerHTML = '';
    return;
  }
  const parts = [`<button type="button" data-goto="root">Home</button>`];
  state.path.forEach((p, i) => {
    parts.push('<span class="sep">/</span>');
    parts.push(
      i === state.path.length - 1
        ? `<span class="here">${esc(p.name)}</span>`
        : `<button type="button" data-goto="${p.id}">${esc(p.name)}</button>`
    );
  });
  crumbs.innerHTML = parts.join('');
  crumbs.hidden = false;
}

function render() {
  const folders = state.folders.filter((f) => matches(f.name.toLowerCase()));
  const videos = state.videos.filter((v) => matches(v.n.toLowerCase()));
  const items = [...folders.map(cardFolder), ...videos.slice(0, state.shown).map(cardVideo)];

  grid.innerHTML = items.join('');

  const total = folders.length + videos.length;
  count.textContent = state.q
    ? `${total} match${total === 1 ? '' : 'es'}`
    : `${folders.length} folder${folders.length === 1 ? '' : 's'} · ${videos.length} video${videos.length === 1 ? '' : 's'}`;
  empty.textContent = state.note || 'Nothing here.';
  empty.hidden = total > 0;
  const hasMore = videos.length > state.shown;
  more.hidden = !hasMore;
  sentinel.hidden = !hasMore;
  renderCrumbs();
}

async function openFolder(id) {
  state.folder = id;
  state.q = '';
  state.note = '';
  search.value = '';
  state.shown = PAGE;

  const data = await folderData(id);
  state.folders = data.folders || [];
  state.videos = data.videos || [];
  state.path = data.path || [];

  const url = id && id !== 'root' ? `?f=${id}` : location.pathname;
  history.pushState({ id }, '', url);
  render();
  window.scrollTo(0, 0);
}

function openVideo(v) {
  dialogTitle.textContent = v.n;
  player.src = fileUrl(v.f);
  player.play().catch(() => {});
  dialog.showModal();
}

function closeVideo() {
  player.pause();
  player.removeAttribute('src');
  player.load();
  if (dialog.open) dialog.close();
}

// events
grid.addEventListener('click', (e) => {
  const a = e.target.closest('a.card');
  if (!a) return;
  e.preventDefault();
  if (a.dataset.folder) return openFolder(a.dataset.folder);
  openVideo({ f: a.dataset.video, n: a.dataset.name });
});

crumbs.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-goto]');
  if (b) openFolder(b.dataset.goto);
});

document.getElementById('home').addEventListener('click', (e) => {
  e.preventDefault();
  openFolder('root');
});

search.addEventListener('input', () => {
  state.q = search.value.trim().toLowerCase();
  state.shown = PAGE;
  render();
});

document.getElementById('close').addEventListener('click', closeVideo);
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) closeVideo();
});
dialog.addEventListener('close', closeVideo);
player.addEventListener('loadedmetadata', () => {
  if (!Number.isFinite(player.duration)) return;
  const f = player.src.replace(location.origin, '').split('/').slice(2).map(decodeURIComponent).join('/');
  const card = grid.querySelector(`a[data-video="${CSS.escape(f)}"] [data-badge]`);
  if (card) {
    card.textContent = fmt(player.duration);
    card.hidden = false;
  }
});

document.getElementById('theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('theme', next);
  } catch {}
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== search) {
    e.preventDefault();
    search.focus();
  }
});

function showMore() {
  if (state.videos.length <= state.shown) return;
  state.shown += PAGE;
  render();
}

more.addEventListener('click', showMore);

// Belt and braces: the observer covers normal scrolling, the scroll check covers
// browsers where the observer does not fire (hidden tabs, some embedded webviews).
// A timer throttle is used instead of requestAnimationFrame, because rAF is paused
// in background tabs and the check would then never run.
let tick = false;
window.addEventListener(
  'scroll',
  () => {
    if (tick) return;
    tick = true;
    setTimeout(() => {
      tick = false;
      const rect = sentinel.getBoundingClientRect();
      if (!sentinel.hidden && rect.top < window.innerHeight + 800) showMore();
    }, 80);
  },
  { passive: true }
);

new IntersectionObserver(
  (entries) => {
    if (entries.some((x) => x.isIntersecting)) showMore();
  },
  { rootMargin: '800px' }
).observe(sentinel);

window.addEventListener('popstate', () => {
  const id = new URLSearchParams(location.search).get('f') || 'root';
  openFolderSilent(id).catch(() => {});
});

async function openFolderSilent(id) {
  const data = await folderData(id);
  state.folder = id;
  state.folders = data.folders || [];
  state.videos = data.videos || [];
  state.path = data.path || [];
  state.shown = PAGE;
  render();
}

// boot
(async () => {
  try {
    state.durations = await getJSON('/m/durations.json');
  } catch {}

  const id = new URLSearchParams(location.search).get('f') || 'root';
  // A signed-out visitor is sent to the login page from inside getJSON.
  try {
    await openFolderSilent(id);
  } catch (e) {
    empty.textContent = 'The library could not be read. Reload the page.';
    empty.hidden = false;
  }

  // Show the admin link only for admins.
  try {
    const me = await getJSON('/api/me');
    if (me && me.admin) document.getElementById('admin').hidden = false;
  } catch {}
})();
