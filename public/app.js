/**
 * AnimeWit — High-Performance Anime Streaming Client Application
 * Backed by the witanime.site catalog proxy
 */

'use strict';

/* =========================================================================
   1. Core Utilities & Storage
   ========================================================================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[c]));

// Upstream images load directly (its own CDN has no hotlink protection), except
// hosts that block hotlinking (imgur 429s direct requests) which go through the
// backend mirror chain; other failures are retried there too (setupGlobalEvents).
const PROXY_HOSTS = ['i.imgur.com', 'imgur.com'];
const imgProxy = (url) => {
  const s = String(url || '');
  if (s.startsWith('https://')) {
    try {
      if (PROXY_HOSTS.includes(new URL(s).hostname)) return '/api/image?url=' + encodeURIComponent(s);
    } catch { /* relative / data: urls pass through */ }
  }
  return s;
};

// Placeholder SVG for broken or missing anime posters
const POSTER_PLACEHOLDER = "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 300 420%22 fill=%22%23131420%22%3E%3Crect width=%22300%22 height=%22420%22/%3E%3Ctext x=%2250%25%22 y=%2250%25%22 dominant-baseline=%22middle%22 text-anchor=%22middle%22 fill=%22%23646782%22 font-family=%22sans-serif%22 font-size=%2218%22%3EAnimeWit%3C/text%3E%3C/svg%3E";

// Image sizing: upstream posters are 520px+ (some TMDB w1280) but cards show
// at ~210-261px and tiny thumbs at <=92px, so ship resized copies. Weserv
// resizes server-side and serves 1y cache headers; `output=webp` is added
// only when the browser proves WebP support (canvas probe), so old browsers
// keep JPEG. <img> failures fall back to the backend mirror via the global
// error handler; CSS backgrounds fall back inline at each call site.
let WEBP_OK = false;
try {
  WEBP_OK = document.createElement('canvas').toDataURL('image/webp').indexOf('data:image/webp') === 0;
} catch { WEBP_OK = false; }

const isTmdb = (s) => String(s || '').includes('image.tmdb.org');
const tmdbSize = (url, size) => String(url || '').replace(
  /image\.tmdb\.org\/t\/p\/w(?:92|154|185|342|500|780|1280|original)\//,
  `image.tmdb.org/t/p/${size}/`
);
const weservUrl = (url, w, q) => {
  try {
    const u = new URL(String(url));
    if (u.protocol !== 'https:') return String(url);
    // witanime art: weserv can't reach that origin (404) and the image CDN
    // 403s localhost referers — serve same-origin through our proxy instead
    // (fetches direct with a witanime referer, immutable cache).
    if (u.hostname === 'images.witanime.site') return '/api/image?url=' + encodeURIComponent(u.href);
    return 'https://images.weserv.nl/?url=' + encodeURIComponent(u.host + u.pathname)
      + `&w=${w}&q=${q}` + (WEBP_OK ? '&output=webp' : '');
  } catch { return String(url); }
};
const heroHiRes = (url) => (isTmdb(url) ? tmdbSize(url, 'w1280') : String(url || ''));

// Image quality first: serve near-native resolution at high quality.
// Weserv still fronts non-TMDB art (1y cache headers), but with no effective
// downscale: w=520 matches the upstream native width, q=85 keeps detail.
// TMDB maps to large buckets. Tiny thumbs stay small (nothing visible lost).
const heroBgUrl = (url, small) => {
  const hi = heroHiRes(url);
  if (!hi) return hi;
  if (hi.includes('image.tmdb.org')) return hi;
  return small ? weservUrl(hi, 1024, 82) : weservUrl(hi, 1600, 88);
};
const isSmallViewport = () => {
  try { return window.matchMedia('(max-width: 768px)').matches; } catch { return false; }
};

// Cards show at ~210px: 520px file = full retina-or-better fidelity.
const cardImg = (url) => {
  const s = String(url || '');
  if (!s) return s;
  return isTmdb(s) ? tmdbSize(s, 'w500') : weservUrl(s, 520, 85);
};
const thumbImg = (url) => {
  const s = String(url || '');
  if (!s) return s;
  return isTmdb(s) ? tmdbSize(s, 'w342') : weservUrl(s, 320, 80);
};

/* Client-side memory cache for zero-latency page transitions */
const apiCache = new Map();

async function api(path, { useCache = true } = {}) {
  if (useCache && apiCache.has(path)) {
    return apiCache.get(path);
  }
  /* One retry: upstream hiccups (relay hop, cold function) come back as 5xx or
     a dropped socket, and a single failure used to blank the whole page. */
  let res = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      res = await fetch(path, { headers: { accept: 'application/json' } });
      if (res.ok || res.status < 500) break;
    } catch { res = null; }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));
  }
  if (!res) throw new Error('Network error — could not reach the server');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const raw = (data && data.error) || data;
    const msg = (raw && typeof raw === 'object' ? (raw.message || raw.error || JSON.stringify(raw)) : raw) || `Request failed (${res.status})`;
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  if (useCache) {
    apiCache.set(path, data);
    if (apiCache.size > 100) {
      const first = apiCache.keys().next().value;
      apiCache.delete(first);
    }
  }
  return data;
}

/* Toast Notifications */
let toastTimer = null;
function toast(msg, type = '') {
  const el = $('#toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `toast show ${type}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = 'toast';
  }, 3500);
}

/* LocalStorage: Bookmarks & Watch History */
const STORAGE_KEYS = {
  BOOKMARKS: 'animewit_bookmarks_v1',
  HISTORY: 'animewit_history_v1',
  AUTO_NEXT: 'animewit_autonext',
  BLOCK_POPUPS: 'animewit_blockpopups_v1'
};

const Storage = {
  getBookmarks() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEYS.BOOKMARKS) || '[]');
    } catch { return []; }
  },
  isBookmarked(slug) {
    return this.getBookmarks().some((x) => x.slug === slug);
  },
  toggleBookmark(item) {
    let list = this.getBookmarks();
    const idx = list.findIndex((x) => x.slug === item.slug);
    let added = false;
    if (idx >= 0) {
      list.splice(idx, 1);
    } else {
      list.unshift({
        slug: item.slug,
        title: item.title,
        poster: item.poster || item.banner || '',
        kind: item.kind || 'anime',
        rating: item.rating || null,
        type: item.type || 'TV',
        savedAt: Date.now()
      });
      added = true;
    }
    localStorage.setItem(STORAGE_KEYS.BOOKMARKS, JSON.stringify(list.slice(0, 80)));
    updateBookmarkBadge();
    return added;
  },
  getHistory() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEYS.HISTORY) || '[]');
    } catch { return []; }
  },
  addHistory(entry) {
    let list = this.getHistory();
    list = list.filter((x) => !(x.slug === entry.slug && x.ep === entry.ep));
    list.unshift({
      slug: entry.slug,
      ep: entry.ep,
      title: entry.title,
      poster: entry.poster || '',
      label: entry.label || `Episode ${entry.ep}`,
      watchedAt: Date.now()
    });
    localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(list.slice(0, 30)));
    renderContinueWatching();
  },
  removeHistory(slug, ep) {
    let list = this.getHistory().filter((x) => !(x.slug === slug && x.ep === ep));
    localStorage.setItem(STORAGE_KEYS.HISTORY, JSON.stringify(list));
    renderContinueWatching();
  },
  clearHistory() {
    localStorage.removeItem(STORAGE_KEYS.HISTORY);
    renderContinueWatching();
  }
};

function updateBookmarkBadge() {
  const count = Storage.getBookmarks().length;
  const b = $('#bookmarkBadge');
  if (b) {
    b.textContent = count;
    b.hidden = count === 0;
  }
  const countSpan = $('#bookmarksCount');
  if (countSpan) countSpan.textContent = count;
}

/* =========================================================================
   2. Application State
   ========================================================================= */
const state = {
  home: null,
  anime: null,              // current detailed anime
  watch: null,              // current watching session
  heroIndex: 0,
  heroTimer: null,
  searchTimer: null,
  theaterMode: false,
  cinemaMode: false,
  currentBrowseFilter: 'all',
  searchResults: []
};

/* View Switcher */
const VIEWS = ['home', 'browse', 'anime', 'watch'];
function showView(targetView) {
  if (targetView !== 'watch') {
    destroyHls();
  }
  VIEWS.forEach((v) => {
    const el = $('#' + v + (v === 'home' ? 'View' : 'Section'));
    if (el) el.hidden = v !== targetView;
  });
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/* =========================================================================
   3. Router
   ========================================================================= */
function parseRoute() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  let m;
  if ((m = path.match(/^\/watch\/([^/]+)\/(\d+)$/))) {
    return { view: 'watch', slug: decodeURIComponent(m[1]), ep: Number(m[2]) };
  }
  if ((m = path.match(/^\/(anime|movie)\/([^/]+)$/))) {
    return { view: 'anime', slug: decodeURIComponent(m[2]), kind: m[1] };
  }
  if (path === '/search') {
    return { view: 'browse', q: new URLSearchParams(location.search).get('q') || '' };
  }
  return { view: 'home', hash: location.hash };
}

function go(url, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
  return handleRoute();
}

async function handleRoute() {
  const r = parseRoute();
  stopHeroSlider();
  document.title = 'AnimeWit — Watch Anime Online in HD';

  // Highlight desktop nav
  if (r.view === 'home') setActiveNav(r.hash ? r.hash.replace('#', '') : 'home');
  else $$('.nav-link').forEach((a) => a.classList.remove('active'));

  try {
    if (r.view === 'watch') {
      showView('watch');
      await openWatch(r.slug, r.ep);
    } else if (r.view === 'anime') {
      showView('anime');
      await openDetail(r.slug, r.kind);
    } else if (r.view === 'browse') {
      showView('browse');
      await openSearch(r.q);
    } else {
      showView('home');
      await ensureHome();
      renderContinueWatching();
      if (r.hash && r.hash.length > 1) {
        scrollToSection(r.hash.slice(1));
      }
    }
  } catch (err) {
    console.error('Route error:', err);
    toast(err.message || 'Failed to load page', 'error');
  }
}

/* Single source of truth for the navbar active underline */
function setActiveNav(key) {
  $$('.nav-link').forEach((a) => a.classList.toggle('active', a.dataset.nav === key));
}

function scrollToSection(key) {
  if (key === 'bookmarks') {
    openBookmarksView();
    return;
  }
  if (key === 'continue') {
    const sec = $('#continueSection');
    if (sec && !sec.hidden) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const el = document.getElementById('sec-' + key);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* =========================================================================
   4. Cards & Grid Rendering
   ========================================================================= */
// Mirror of the server's audio-state rule (for cached/bookmarked items without audio)
function pickAudio(s) {
  const t = String(s || '');
  if (/مصري/.test(t)) return 'بالمصري';
  if (/فصح/.test(t)) return 'مدبلج';
  if (/مدبلج|دبلج/.test(t)) return 'مدبلج';
  if (/مترجم/.test(t)) return 'مترجم';
  return null;
}

function cardHtml(item) {
  const raw = item.poster || item.banner || '';
  const img = imgProxy(cardImg(raw) || POSTER_PLACEHOLDER);
  const isEp = item.kind === 'watch';
  const href = isEp ? `/watch/${item.slug}/${item.ep}` : `/${item.kind || 'anime'}/${item.slug}`;
  const badgeText = isEp ? (item.label || `Ep ${item.ep}`) : (item.type || (item.kind === 'movie' ? 'Movie' : 'TV'));
  const badgeClass = isEp ? 'badge-episode' : (String(item.type || '').toLowerCase().includes('movie') || item.kind === 'movie' ? 'badge-movie' : 'badge-tv');
  const audio = item.audio || pickAudio(item.title) || 'مترجم';
  const isSaved = Storage.isBookmarked(item.slug);

  return `
    <article class="anime-card" data-slug="${esc(item.slug)}" data-kind="${esc(item.kind)}" ${item.ep ? `data-ep="${item.ep}"` : ''}>
      <span class="card-ribbon">${esc(audio)}</span>
      <a class="card-poster" href="${href}" title="${esc(item.title)}">
        <img src="${esc(img)}" alt="${esc(item.title)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">
        <span class="card-badge ${badgeClass}">${esc(badgeText)}</span>
        <div class="card-play-overlay">
          <div class="play-btn-circle">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          </div>
        </div>
        <div class="card-overlay">
          <span class="card-title">${esc(item.title)}</span>
          ${item.rating ? `<span class="card-rating">★ ${esc(item.rating)}</span>` : ''}
        </div>
      </a>
      <button class="card-bookmark-btn ${isSaved ? 'saved' : ''}" data-slug="${esc(item.slug)}" title="${isSaved ? 'Remove from My List' : 'Add to My List'}" type="button" aria-label="Bookmark">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="${isSaved ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>
      </button>
    </article>
  `;
}

/* Related-rail card — clone of the ristoanime.me MovieItem markup */
function relatedCardHtml(item) {
  const raw = item.poster || item.banner || '';
  const img = imgProxy(cardImg(raw) || POSTER_PLACEHOLDER);
  const href = `/${item.kind || 'anime'}/${item.slug}`;
  const category = item.type || (item.kind === 'movie' ? 'Movie' : 'TV Series');
  const title = item.title || '';
  const starSvg = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2 5.9 20.6l1.4-6.8L2.2 9.1l6.9-.8z"/></svg>';
  const playSvg = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>';

  return `
    <div class="MovieItem">
      <a class="mi-link" href="${esc(href)}" title="${esc(title)}">
        <span class="mi-poster" style="background-image:url('${esc(img)}')"></span>
        <span class="mi-over"></span>
        <span class="mi-category">${esc(category)}</span>
        ${item.rating ? `<span class="mi-release">${starSvg} ${esc(String(item.rating))}</span>` : ''}
        ${item.audio ? `<span class="mi-ribbon">${esc(item.audio)}</span>` : ''}
        ${item.year ? `<div class="mi-episode"><span>Year</span><em>${esc(String(item.year))}</em></div>` : ''}
        <span class="mi-play">${playSvg}</span>
        <div class="mi-title"><h4>${esc(title)}</h4></div>
      </a>
    </div>
  `;
}

function renderSkeletonGrid(count = 12) {
  let html = '';
  for (let i = 0; i < count; i++) {
    html += `<div class="anime-card skeleton-card"><div class="card-poster skeleton"></div></div>`;
  }
  return html;
}

/* =========================================================================
   5. Homepage & Hero Slider
   ========================================================================= */
async function ensureHome() {
  if (state.home) {
    startHeroSlider();
    return state.home;
  }

  const container = $('#homeSections');
  if (container) {
    container.innerHTML = `
      <section class="section">
        <div class="section-header"><div class="skeleton" style="height:28px;width:200px"></div></div>
        <div class="rail-track">${renderSkeletonGrid(8)}</div>
      </section>
    `;
  }

  const data = await api('/api/home');
  state.home = data;
  renderHomeSections(data);
  startHeroSlider();
  return data;
}

/* Horizontal rail: edge arrows + disabled state */
function initRail(wrap) {
  const track = wrap.querySelector('.rail-track');
  if (!track) return;
  const prev = wrap.querySelector('.rail-nav.prev');
  const next = wrap.querySelector('.rail-nav.next');

  const sync = () => {
    const max = track.scrollWidth - track.clientWidth - 2;
    if (prev) prev.disabled = track.scrollLeft <= 2;
    if (next) next.disabled = track.scrollLeft >= max;
  };

  wrap.querySelectorAll('[data-rail-dir]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const step = Math.max(260, Math.round(track.clientWidth * 0.82));
      track.scrollBy({ left: step * Number(btn.dataset.railDir), behavior: 'smooth' });
    });
  });

  track.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('resize', sync);
  sync();
}

const CHEVRON_RIGHT = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
const CHEVRON_UP = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';

function sectionRailHtml(sec) {
  const key = esc(sec.key);
  return `
    <section class="section" id="sec-${key}">
      <div class="section-header">
        <div class="section-title-wrap">
          <h2 class="section-title">${esc(sec.enTitle || sec.title)}</h2>
        </div>
        <a href="/#${key}" class="section-link" data-viewall="${key}">
          <span class="section-link-label">View All</span>
          <span class="section-link-icon">${CHEVRON_RIGHT}</span>
        </a>
      </div>
      <div class="rail-wrap" data-rail>
        <button class="rail-nav prev" type="button" data-rail-dir="-1" aria-label="Scroll left">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div class="rail-track">
          ${sec.items.map(cardHtml).join('')}
        </div>
        <button class="rail-nav next" type="button" data-rail-dir="1" aria-label="Scroll right">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>
    </section>
  `;
}

/* Toggle a section between the scrollable rail and the full wrapped grid */
function toggleSectionExpand(section) {
  if (!section) return false;
  const link = section.querySelector('[data-viewall]');
  const icon = section.querySelector('.section-link-icon');
  const label = section.querySelector('.section-link-label');
  const track = section.querySelector('.rail-track');
  const nowOpen = !section.classList.contains('expanded');

  section.classList.toggle('expanded', nowOpen);
  if (link) link.classList.toggle('is-open', nowOpen);
  if (label) label.textContent = nowOpen ? 'Show Less' : 'View All';
  if (icon) icon.innerHTML = nowOpen ? CHEVRON_UP : CHEVRON_RIGHT;
  if (track) track.scrollLeft = 0;
  return nowOpen;
}

function renderHomeSections(data) {
  const container = $('#homeSections');
  if (!container || !data.sections) return;

  container.innerHTML = data.sections.map(sectionRailHtml).join('');
  $$('[data-rail]').forEach(initRail);
}

/* Hero Carousel */
function startHeroSlider() {
  if (!state.home || !state.home.hero || !state.home.hero.length) return;
  renderHeroSlide(state.heroIndex);
  stopHeroSlider();
  state.heroTimer = setInterval(() => {
    state.heroIndex = (state.heroIndex + 1) % state.home.hero.length;
    renderHeroSlide(state.heroIndex);
  }, 7000);
}

function stopHeroSlider() {
  if (state.heroTimer) {
    clearInterval(state.heroTimer);
    state.heroTimer = null;
  }
}

function renderHeroSlide(idx) {
  const list = state.home && state.home.hero;
  if (!list || !list[idx]) return;
  state.heroIndex = idx;
  const item = list[idx];

  const bg = $('#heroBg');
  const raw = item.banner || item.poster || '';
  if (bg && raw) {
    const hd = heroBgUrl(raw, isSmallViewport());
    const finalUrl = imgProxy(hd);
    // Preload the HD file, then swap — avoids flashing a half-decoded image.
    // First paint sets it instantly; later slides swap on load.
    if (!bg.style.getPropertyValue('--hero-img')) {
      bg.style.setProperty('--hero-img', `url('${finalUrl}')`);
    }
    const pre = new Image();
    pre.decoding = 'async';
    try { pre.referrerPolicy = 'no-referrer'; } catch { /* older browsers */ }
    pre.onload = () => bg.style.setProperty('--hero-img', `url('${finalUrl}')`);
    pre.onerror = () => bg.style.setProperty('--hero-img', `url('${imgProxy(raw)}')`);
    pre.src = finalUrl;
    // Warm the next slide so auto-advance never shows a blurry progressive frame.
    const next = list[(idx + 1) % list.length];
    if (next && next.banner) {
      const warm = new Image();
      try { warm.referrerPolicy = 'no-referrer'; } catch { /* older browsers */ }
      warm.src = imgProxy(heroBgUrl(next.banner || next.poster || '', isSmallViewport()));
    }
  }

  if ($('#heroEyebrow')) $('#heroEyebrow').textContent = item.kind === 'watch' ? 'NEW EPISODE RELEASE' : 'FEATURED ANIME';
  if ($('#heroTitle')) $('#heroTitle').innerHTML = twoToneTitle(item.title);
  if ($('#heroSubtitle')) $('#heroSubtitle').textContent = item.description || 'Watch now in high quality on AnimeWit.';

  // Meta parsing
  if ($('#heroRating')) {
    const rMatch = (item.meta || '').match(/★\s*(\d+(?:\.\d+)?)/);
    const el = $('#heroRating');
    if (rMatch) { el.textContent = `★ ${rMatch[1]}`; el.style.display = ''; }
    else el.style.display = 'none';
  }
  if ($('#heroType')) $('#heroType').textContent = item.kind === 'movie' ? 'Movie' : 'TV Series';
  if ($('#heroYear')) {
    const yMatch = (item.meta || '').match(/\b(202\d|201\d)\b/);
    $('#heroYear').textContent = yMatch ? yMatch[1] : '2026';
  }

  // Button actions
  const watchBtn = $('#heroWatch');
  if (watchBtn) {
    watchBtn.onclick = () => {
      if (item.kind === 'watch' && item.ep) go(`/watch/${item.slug}/${item.ep}`);
      else go(`/${item.kind || 'anime'}/${item.slug}`);
    };
  }

  const detailBtn = $('#heroDetails');
  if (detailBtn) {
    detailBtn.onclick = () => {
      go(`/${item.kind === 'movie' ? 'movie' : 'anime'}/${item.slug}`);
    };
  }

  const bmBtn = $('#heroBookmark');
  if (bmBtn) {
    const isSaved = Storage.isBookmarked(item.slug);
    bmBtn.classList.toggle('active', isSaved);
    bmBtn.onclick = () => {
      const added = Storage.toggleBookmark(item);
      bmBtn.classList.toggle('active', added);
      toast(added ? 'Saved to My List' : 'Removed from My List', 'success');
    };
  }

  // Thumbnail rail — built once, then only the active class flips.
  // (Rebuilding innerHTML on every 7s tick recreates all <img> nodes.)
  const thumbsBox = $('#heroThumbs');
  if (thumbsBox) {
    if (thumbsBox.childElementCount !== list.length) {
      thumbsBox.innerHTML = list.map((it, i) => `
        <button class="hero-thumb" type="button" data-idx="${i}" title="${esc(it.title)}" aria-label="Show ${esc(it.title)}">
          <img src="${esc(imgProxy(thumbImg(it.banner || it.poster) || POSTER_PLACEHOLDER))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">
        </button>
      `).join('');
    }
    $$('.hero-thumb', thumbsBox).forEach((b, i) => b.classList.toggle('active', i === idx));
  }
}

/* Split a title so the last word carries the accent colour */
function twoToneTitle(title) {
  const clean = String(title || '').trim();
  if (!clean) return '';
  const maxLength = 36;
  let truncated = clean.length > maxLength ? clean.substring(0, maxLength).trim() : clean;
  // Truncate at last space to avoid cutting words
  if (clean.length > maxLength) {
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > 0) truncated = truncated.substring(0, lastSpace).trim();
  }
  const words = truncated.split(/\s+/);
  if (words.length < 2) return esc(truncated);
  const last = words.pop();
  return esc(words.join(' ')) + ' <span class="accent-word">' + esc(last) + '</span>';
}

/* Continue Watching Row */
function renderContinueWatching() {
  const section = $('#continueSection');
  const grid = $('#continueGrid');
  if (!section || !grid) return;

  const history = Storage.getHistory();
  if (!history.length) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  grid.innerHTML = history.map((item) => `
    <div class="continue-card" data-slug="${esc(item.slug)}" data-ep="${item.ep}">
      <div class="continue-thumb-wrap">
        <img class="continue-thumb" src="${esc(imgProxy(thumbImg(item.poster) || POSTER_PLACEHOLDER))}" alt="" loading="lazy" referrerpolicy="no-referrer">
        <div class="continue-progress-bar"><div class="continue-progress-fill"></div></div>
      </div>
      <button class="continue-remove" data-slug="${esc(item.slug)}" data-ep="${item.ep}" title="Remove">✕</button>
      <div class="continue-info">
        <div class="continue-title">${esc(item.title)}</div>
        <div class="continue-ep">${esc(item.label || `Episode ${item.ep}`)}</div>
      </div>
    </div>
  `).join('');
}

/* Bookmarks View */
function openBookmarksView() {
  const sec = $('#bookmarksSection');
  const grid = $('#bookmarksGrid');
  if (!sec || !grid) return;

  const bookmarks = Storage.getBookmarks();
  sec.hidden = false;
  sec.scrollIntoView({ behavior: 'smooth', block: 'start' });

  if (!bookmarks.length) {
    grid.innerHTML = '<p class="empty-state" style="grid-column:1/-1">You have no saved anime yet. Click the bookmark icon on any anime card to save it here!</p>';
    return;
  }
  grid.innerHTML = bookmarks.map(cardHtml).join('');
}

/* =========================================================================
   6. Live Search
   ========================================================================= */
function setupSearch() {
  const input = $('#searchInput');
  const box = $('#searchBox');
  const dd = $('#searchResults');
  const clearBtn = $('#searchClear');
  if (!input || !dd) return;

  // The "/" hint and the "x" button share the same corner, so they must
  // always be toggled together or they render on top of each other.
  const syncSearchBox = () => {
    const hasValue = input.value.trim().length > 0;
    if (clearBtn) clearBtn.hidden = !hasValue;
    if (box) box.classList.toggle('has-value', hasValue);
  };

  input.addEventListener('input', () => {
    const q = input.value.trim();
    syncSearchBox();
    clearTimeout(state.searchTimer);
    if (q.length < 2) {
      dd.classList.remove('active');
      return;
    }
    dd.innerHTML = '<div class="dd-empty">Searching AnimeWit catalog…</div>';
    dd.classList.add('active');

    state.searchTimer = setTimeout(async () => {
      try {
        const res = await api(`/api/search?q=${encodeURIComponent(q)}`);
        if (input.value.trim() !== q) return;
        const items = res.items || [];
        if (!items.length) {
          dd.innerHTML = `<div class="dd-empty">No results found for "${esc(q)}"</div>`;
          return;
        }
        dd.innerHTML = items.slice(0, 8).map((it) => `
          <button class="search-item" data-kind="${esc(it.kind)}" data-slug="${esc(it.slug)}" ${it.ep ? `data-ep="${it.ep}"` : ''} type="button">
            <img class="search-thumb" src="${esc(imgProxy(thumbImg(it.poster) || POSTER_PLACEHOLDER))}" alt="" loading="lazy" referrerpolicy="no-referrer">
            <div class="search-item-info">
              <div class="search-item-title">${esc(it.title)}</div>
              <div class="search-item-meta">
                <span class="search-item-badge">${esc(it.kind === 'watch' ? (it.label || 'Episode') : (it.type || 'Anime'))}</span>
                ${it.rating ? `<span>★ ${esc(it.rating)}</span>` : ''}
              </div>
            </div>
          </button>
        `).join('');
      } catch (err) {
        dd.innerHTML = '<div class="dd-empty">Search unavailable right now. Try again.</div>';
      }
    }, 280);
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      input.value = '';
      syncSearchBox();
      dd.classList.remove('active');
      input.focus();
    });
  }

  dd.addEventListener('click', (e) => {
    const item = e.target.closest('.search-item');
    if (!item) return;
    const { kind, slug, ep } = item.dataset;
    input.value = '';
    input.blur();
    syncSearchBox();
    dd.classList.remove('active');
    if (kind === 'watch' && ep) go(`/watch/${slug}/${ep}`);
    else go(`/${kind || 'anime'}/${slug}`);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = input.value.trim();
      if (q.length < 2) return;
      e.preventDefault();
      dd.classList.remove('active');
      go(`/search?q=${encodeURIComponent(q)}`);
    } else if (e.key === 'Escape') {
      dd.classList.remove('active');
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-box')) {
      dd.classList.remove('active');
    }
  });
}

async function openSearch(q) {
  const title = $('#browseTitle');
  const grid = $('#browseGrid');
  if (title) title.textContent = q ? `Results for "${q}"` : 'Catalog Search';
  document.title = q ? `${q} — Search · AnimeWit` : 'Search · AnimeWit';
  if (!grid) return;

  grid.innerHTML = renderSkeletonGrid(8);
  if (!q) {
    grid.innerHTML = '<p class="empty-state" style="grid-column:1/-1">Please enter a keyword in the search bar above.</p>';
    return;
  }

  try {
    const res = await api(`/api/search?q=${encodeURIComponent(q)}`);
    state.searchResults = res.items || [];
    filterAndRenderSearchResults();
  } catch (err) {
    grid.innerHTML = `<p class="empty-state" style="grid-column:1/-1">Failed to load search: ${esc(err.message)}</p>`;
  }
}

function filterAndRenderSearchResults() {
  const grid = $('#browseGrid');
  if (!grid) return;
  let items = state.searchResults || [];
  if (state.currentBrowseFilter === 'anime') {
    items = items.filter((x) => x.kind !== 'movie');
  } else if (state.currentBrowseFilter === 'movie') {
    items = items.filter((x) => x.kind === 'movie' || (x.type && x.type.toLowerCase().includes('movie')));
  }

  if (!items.length) {
    grid.innerHTML = '<p class="empty-state" style="grid-column:1/-1">No matches found for this filter.</p>';
    return;
  }
  grid.innerHTML = items.map(cardHtml).join('');
}

/* =========================================================================
   7. Anime Detail View
   ========================================================================= */
async function openDetail(slug, kind) {
  const preview = $('#animeEpisodePreview');
  if (preview) preview.innerHTML = '<p class="empty-state">Loading anime episodes…</p>';
  $('#animeEpisodesMore').hidden = true;
  $('#animeRangeTabs').hidden = true;

  const data = await api(`/api/anime/${encodeURIComponent(slug)}?kind=${encodeURIComponent(kind || 'anime')}`);
  state.anime = data;
  state.watch = null;

  document.title = `${data.title} · AnimeWit`;

  if ($('#animeBreadcrumbTitle')) $('#animeBreadcrumbTitle').textContent = data.title;
  if ($('#animeBreadcrumbKind')) $('#animeBreadcrumbKind').textContent = data.kind === 'movie' ? 'Movie' : 'Anime';
  if ($('#animePageTitle')) $('#animePageTitle').textContent = data.title;
  if ($('#animePageAltTitle')) $('#animePageAltTitle').textContent = data.altTitle || '';

  const poster = $('#animePagePoster');
  if (poster) {
    poster.src = imgProxy(cardImg(data.poster) || POSTER_PLACEHOLDER);
    poster.removeAttribute('srcset');
    poster.alt = data.title;
  }

  const banner = $('#animePageBanner');
  if (banner && data.banner) {
    // Same portrait-source problem as the hero: serve the HD background URL
    // with a direct fallback so a CDN miss never leaves a broken backdrop.
    const rawBanner = data.banner;
    const hdBanner = imgProxy(heroBgUrl(rawBanner, isSmallViewport()));
    const preBanner = new Image();
    try { preBanner.referrerPolicy = 'no-referrer'; } catch { /* older browsers */ }
    preBanner.onload = () => { banner.style.backgroundImage = `url('${hdBanner}')`; };
    preBanner.onerror = () => { banner.style.backgroundImage = `url('${imgProxy(rawBanner)}')`; };
    preBanner.src = hdBanner;
    if (!banner.style.backgroundImage) banner.style.backgroundImage = `url('${hdBanner}')`;
  }

  if ($('#animePageType')) $('#animePageType').textContent = data.kind === 'movie' ? 'Movie' : 'TV Series';
  if ($('#animePageRating')) {
    const badge = $('#animePageRating');
    if (data.rating) { badge.textContent = `★ ${data.rating}`; badge.style.display = ''; }
    else badge.style.display = 'none';
  }

  const metaBits = [data.year, data.studio, data.country, data.episodes ? `${data.episodes.length} episodes` : null].filter(Boolean);
  if ($('#animePageMeta')) $('#animePageMeta').textContent = metaBits.join(' · ');

  if ($('#animePageTags')) {
    $('#animePageTags').innerHTML = (data.genres || []).map((g) => `<span class="genre-tag">${esc(g)}</span>`).join('');
  }

  if ($('#animePageSynopsis')) {
    $('#animePageSynopsis').textContent = data.description || 'No synopsis available for this title.';
  }

  if ($('#animePageSource')) {
    $('#animePageSource').href = data.url || 'https://witanime.site';
  }

  // Detail Bookmark button
  const bmBtn = $('#detailBookmarkBtn');
  if (bmBtn) {
    const isSaved = Storage.isBookmarked(data.slug);
    bmBtn.classList.toggle('saved', isSaved);
    bmBtn.querySelector('span').textContent = isSaved ? 'Bookmarked' : 'Bookmark';
    bmBtn.onclick = () => {
      const added = Storage.toggleBookmark(data);
      bmBtn.classList.toggle('saved', added);
      bmBtn.querySelector('span').textContent = added ? 'Bookmarked' : 'Bookmark';
      toast(added ? 'Added to My List' : 'Removed from My List', 'success');
    };
  }

  // Episodes
  const eps = data.episodes || [];
  if ($('#animeEpisodeCount')) $('#animeEpisodeCount').textContent = `${eps.length} episodes`;

  const btnFirst = $('#animePageWatchFirst');
  const btnLatest = $('#animePageWatchLatest');

  if (eps.length) {
    const firstEp = eps[0];
    const latestEp = eps[eps.length - 1];

    if (btnFirst) {
      btnFirst.disabled = false;
      btnFirst.querySelector('span').textContent = `Watch Episode ${firstEp.n}`;
      btnFirst.onclick = () => go(`/watch/${firstEp.slug || data.slug}/${firstEp.n}`);
    }
    if (btnLatest) {
      btnLatest.disabled = false;
      btnLatest.querySelector('span').textContent = `Watch Latest (Ep ${latestEp.n})`;
      btnLatest.onclick = () => go(`/watch/${latestEp.slug || data.slug}/${latestEp.n}`);
    }
  } else {
    if (btnFirst) btnFirst.disabled = true;
    if (btnLatest) btnLatest.disabled = true;
  }

  // Related / recommended (parsed from the upstream detail page rails)
  const related = data.related || [];
  const relSection = $('#animeRelatedSection');
  if (relSection) {
    if (related.length) {
      const grid = $('#relatedGrid');
      if (grid) grid.innerHTML = related.map(relatedCardHtml).join('');
      const pill = $('#relatedCountPill');
      if (pill) pill.textContent = `${related.length} titles`;
      relSection.hidden = false;
    } else {
      relSection.hidden = true;
    }
  }

  renderEpisodeExplorer(preview, eps, null, $('#animeRangeTabs'), $('#animeEpisodesMore'));

  // Staggered entrance reveal (CSS: .anime-detail-view.is-entered)
  const view = $('#animeSection');
  if (view) {
    view.classList.remove('is-entered');
    void view.offsetWidth; // reflow so the animation replays every visit
    view.classList.add('is-entered');
  }
}

/* Episode Explorer with Range Chunks (e.g. 976-1025, 1026-1075) */
function renderEpisodeExplorer(container, eps, currentEp, tabsContainer, moreBtn) {
  if (!eps || !eps.length) {
    container.innerHTML = '<p class="empty-state">No episodes listed yet.</p>';
    if (tabsContainer) tabsContainer.hidden = true;
    if (moreBtn) moreBtn.hidden = true;
    return;
  }

  const counter = container.closest('.episode-sidebar') ? $('#episodeCount') : null;
  if (counter) counter.textContent = eps.length;

  // Restore the default (non-searched) view; used when the search box is cleared.
  const renderDefault = () => {
    const CHUNK_SIZE = 50;
    if (eps.length > CHUNK_SIZE && tabsContainer) {
      tabsContainer.hidden = false;
      const chunkCount = Math.ceil(eps.length / CHUNK_SIZE);
      let activeChunk = 0;
      if (currentEp) {
        const idx = eps.findIndex((x) => x.n === currentEp);
        if (idx >= 0) activeChunk = Math.floor(idx / CHUNK_SIZE);
      }

      // Label tabs with the real episode numbers, not array positions —
      // long-running series may only expose a window (e.g. 976-1214).
      tabsContainer.innerHTML = Array.from({ length: chunkCount }, (_, i) => {
        const startEp = eps[i * CHUNK_SIZE].n;
        const endEp = eps[Math.min((i + 1) * CHUNK_SIZE, eps.length) - 1].n;
        return `<button class="range-tab ${i === activeChunk ? 'active' : ''}" data-chunk="${i}" type="button">${startEp} - ${endEp}</button>`;
      }).join('');

      const renderChunk = (cIdx) => {
        const slice = eps.slice(cIdx * CHUNK_SIZE, (cIdx + 1) * CHUNK_SIZE);
        container.innerHTML = slice.map((ep) => episodeItemHtml(ep, currentEp)).join('');
      };

      renderChunk(activeChunk);

      tabsContainer.onclick = (e) => {
        const tab = e.target.closest('.range-tab');
        if (!tab) return;
        $$('.range-tab', tabsContainer).forEach((t) => t.classList.toggle('active', t === tab));
        renderChunk(Number(tab.dataset.chunk));
      };

      if (moreBtn) moreBtn.hidden = true;
    } else {
      if (tabsContainer) {
        tabsContainer.hidden = true;
        tabsContainer.innerHTML = '';
        tabsContainer.onclick = null;
      }
      container.innerHTML = eps.slice(0, 60).map((ep) => episodeItemHtml(ep, currentEp)).join('');
      if (moreBtn) {
        moreBtn.hidden = eps.length <= 60;
        moreBtn.onclick = () => {
          container.innerHTML = eps.map((ep) => episodeItemHtml(ep, currentEp)).join('');
          moreBtn.hidden = true;
        };
      }
    }
  };

  renderDefault();

  // Expose the full list so the sidebar search can span every episode,
  // not just the 50 currently shown in the active chunk.
  container.episodeExplorer = {
    eps,
    currentEp,
    renderDefault,
    renderMatches(val) {
      const q = val.trim().toLowerCase();
      if (!q) {
        renderDefault();
        return;
      }
      if (tabsContainer) tabsContainer.hidden = true;
      const hits = eps.filter((ep) =>
        String(ep.n).includes(q) || String(ep.label || '').toLowerCase().includes(q));
      container.innerHTML = hits.length
        ? hits.slice(0, 200).map((ep) => episodeItemHtml(ep, currentEp)).join('')
        : '<p class="empty-state">No episodes match your search.</p>';
    }
  };
}

function episodeItemHtml(ep, currentEp) {
  const isCurrent = ep.n === currentEp;
  return `
    <button class="episode-item ${isCurrent ? 'is-current' : ''}" data-ep="${ep.n}" data-slug="${esc(ep.slug || '')}" type="button" style="
    margin-top: 5px;">
      <span class="episode-number">${ep.n}</span>
      <span class="episode-copy">
        <span class="episode-title">${esc(ep.label || `Episode ${ep.n}`)}</span>
        <span class="episode-airdate">Play Episode</span>
      </span>
    </button>
  `;
}

/* =========================================================================
   8. Watch / Video Player View
   ========================================================================= */
async function openWatch(slug, ep) {
  document.title = `Episode ${ep} · ${slug.replace(/-/g, ' ')} · AnimeWit`;

  if ($('#watchAnimeTitle')) $('#watchAnimeTitle').textContent = slug.replace(/-/g, ' ');
  if ($('#watchBreadcrumbLink')) $('#watchBreadcrumbLink').textContent = slug.replace(/-/g, ' ');
  if ($('#watchBreadcrumbEpisode')) $('#watchBreadcrumbEpisode').textContent = `Episode ${ep}`;
  if ($('#watchEpisodeLabel')) $('#watchEpisodeLabel').textContent = `Episode ${ep}`;

  const stateEl = $('#playerState');
  if (stateEl) stateEl.hidden = false;
  if ($('#playerStateHeading')) $('#playerStateHeading').textContent = 'Loading Stream Player';
    if ($('#playerStateText')) $('#playerStateText').textContent = 'Connecting to witanime streaming proxy…';
  if ($('#playerRetryBtn')) $('#playerRetryBtn').hidden = true;

  resetPlayerFrame();
  if ($('#serverQualities')) $('#serverQualities').innerHTML = '';
  if ($('#serverList')) $('#serverList').innerHTML = '';

  state.watch = { slug, ep, servers: [], quality: null, activeToken: null };

  // Fetch anime detail (for episode list) & servers concurrently
  const detailP = (state.anime && state.anime.slug === slug)
    ? Promise.resolve(state.anime)
    : api(`/api/anime/${encodeURIComponent(slug)}?kind=anime`).catch(() => null);

  const serversP = api(`/api/servers/${encodeURIComponent(slug)}/${ep}`);

  let serversData;
  try {
    [state.anime, serversData] = await Promise.all([detailP, serversP]);
  } catch (err) {
    if ($('#playerStateHeading')) $('#playerStateHeading').textContent = 'Failed to load servers';
    if ($('#playerStateText')) $('#playerStateText').textContent = err.message || 'Stream servers temporarily unavailable.';
    if ($('#playerRetryBtn')) {
      $('#playerRetryBtn').hidden = false;
      $('#playerRetryBtn').onclick = () => openWatch(slug, ep);
    }
    toast(err.message, 'error');
    return;
  }

  if (state.anime) {
    state.anime.slug = slug;
    if ($('#watchAnimeTitle')) $('#watchAnimeTitle').textContent = state.anime.title;
    if ($('#watchBreadcrumbLink')) {
      $('#watchBreadcrumbLink').textContent = state.anime.title;
      $('#watchBreadcrumbLink').href = `/${state.anime.kind || 'anime'}/${slug}`;
    }

    // The route episode number can differ from the episode index (upstream numbers
    // some series per-season) → resolve the canonical entry by number, then by video id.
    const list = state.anime.episodes || [];
    let canonIdx = list.findIndex((x) => x.n === ep);
    if (canonIdx < 0) canonIdx = list.findIndex((x) => x.slug === slug);
    if (canonIdx >= 0 && list[canonIdx].n !== ep) {
      ep = list[canonIdx].n;
      if (state.watch) state.watch.ep = ep;
      history.replaceState(null, '', `/watch/${encodeURIComponent(slug)}/${ep}`);
      if ($('#watchBreadcrumbEpisode')) $('#watchBreadcrumbEpisode').textContent = `Episode ${ep}`;
      if ($('#watchEpisodeLabel')) $('#watchEpisodeLabel').textContent = `Episode ${ep}`;
    }

    document.title = `Episode ${ep} · ${state.anime.title} · AnimeWit`;

    // Record in watch history
    Storage.addHistory({
      slug,
      ep,
      title: state.anime.title,
      poster: state.anime.poster,
      label: `Episode ${ep}`
    });
  }

  const eps = (state.anime && state.anime.episodes) || [];
  const curEpObj = eps.find((x) => x.n === ep);
  if (curEpObj && curEpObj.label && $('#watchEpisodeLabel')) {
    $('#watchEpisodeLabel').textContent = curEpObj.label;
  }

  // Prev / Next episode buttons
  const epIdx = eps.findIndex((x) => x.n === ep);
  const prevBtn = $('#previousEpisode');
  const nextBtn = $('#nextEpisode');

  if (prevBtn) {
    prevBtn.disabled = !(epIdx > 0);
    prevBtn.onclick = () => {
      if (epIdx > 0) go(`/watch/${eps[epIdx - 1].slug || slug}/${eps[epIdx - 1].n}`);
    };
  }

  if (nextBtn) {
    nextBtn.disabled = !(epIdx >= 0 && epIdx < eps.length - 1);
    nextBtn.onclick = () => {
      if (epIdx >= 0 && epIdx < eps.length - 1) go(`/watch/${eps[epIdx + 1].slug || slug}/${eps[epIdx + 1].n}`);
    };
  }

  // Sidebar episode navigation
  const sidebarList = $('#episodeList');
  if (sidebarList) {
    renderEpisodeExplorer(sidebarList, eps, ep, $('#sidebarRangeTabs'), null);
  }

  // Server management
  state.watch.servers = serversData.servers || [];
  renderServerSelector();

  const servers = state.watch.servers;
  if (!servers.length) {
    if ($('#playerStateHeading')) $('#playerStateHeading').textContent = 'No Servers Online';
    if ($('#playerStateText')) $('#playerStateText').textContent = 'Upstream did not return any streaming servers for this episode.';
    return;
  }

  // Load first stream server
  loadStreamEmbed(servers[0].token, servers[0]);
}

function renderServerSelector() {
  const servers = (state.watch && state.watch.servers) || [];
  const qualities = [];
  servers.forEach((s) => {
    if (!qualities.includes(s.quality)) qualities.push(s.quality);
  });

  const qContainer = $('#serverQualities');
  if (qContainer) {
    qContainer.innerHTML = qualities.map((q) => `
      <button class="server-quality ${q === (state.watch.quality || qualities[0]) ? 'active' : ''}" data-quality="${esc(q)}" type="button">
        ${esc(q)}
      </button>
    `).join('');
  }

  state.watch.quality = state.watch.quality || qualities[0];
  renderServerChips();
}

function renderServerChips() {
  const listEl = $('#serverList');
  if (!listEl || !state.watch) return;

  const currentQ = state.watch.quality;
  const filtered = (state.watch.servers || []).filter((s) => s.quality === currentQ);

  listEl.innerHTML = filtered.map((s, i) => `
    <button class="server-chip ${s.token === state.watch.activeToken || (i === 0 && !state.watch.activeToken) ? 'active' : ''}" data-token="${esc(s.token)}" type="button">
      <b>${esc(s.host)}</b>
      <span>${esc(s.version)} · ${esc(s.lang || 'jp')}</span>
    </button>
  `).join('');
}

/* HLS.js instance for direct stream playback */
let hlsInstance = null;

function destroyHls() {
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }
}

function setupVideoPlayer(streamUrl, type, referrer) {
  const video = $('#videoPlayer');
  const frame = $('#playerFrame');
  const stateEl = $('#playerState');
  const pipBtn = $('#pipBtn');
  if (!video) return false;

  destroyHls();

  // Hide iframe, show video
  if (frame) frame.hidden = true;
  video.hidden = false;
  if (pipBtn && 'pictureInPictureEnabled' in document) pipBtn.hidden = false;

  if (type === 'hls' || streamUrl.includes('.m3u8')) {
    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      hlsInstance = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        xhrSetup: (xhr, url) => {
          if (referrer) xhr.setRequestHeader('Referer', referrer);
        }
      });
      hlsInstance.loadSource(streamUrl);
      hlsInstance.attachMedia(video);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
      });
      hlsInstance.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          console.error('HLS error:', data);
          if (stateEl) stateEl.hidden = false;
          if ($('#playerStateHeading')) $('#playerStateHeading').textContent = 'Stream Error';
          if ($('#playerStateText')) $('#playerStateText').textContent = 'HLS stream failed. Trying fallback…';
          fallbackToIframe(streamUrl, referrer);
        }
      });
      return true;
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari native HLS
      video.src = streamUrl;
      video.addEventListener('loadedmetadata', () => video.play().catch(() => {}), { once: true });
      return true;
    }
  } else if (type === 'mp4' || streamUrl.includes('.mp4')) {
    video.src = streamUrl;
    video.play().catch(() => {});
    return true;
  }
  return false;
}

function fallbackToIframe(embedUrl, referrer) {
  const video = $('#videoPlayer');
  const frame = $('#playerFrame');
  const pipBtn = $('#pipBtn');
  if (video) video.hidden = true;
  if (pipBtn) pipBtn.hidden = true;
  if (frame) {
    frame.src = embedUrl;
    frame.hidden = false;
  }
  destroyHls();
}

function resetPlayerFrame() {
  const old = $('#playerFrame');
  const frame = document.createElement('iframe');
  frame.id = 'playerFrame';
  frame.title = 'AnimeWit Player';
  frame.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture; storage-access');
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation allow-forms allow-orientation-lock allow-popups allow-popups-to-escape-sandbox allow-downloads allow-storage-access-by-user-activation');
  frame.allowFullscreen = true;
  frame.hidden = true;
  if (old) old.replaceWith(frame);
  else if ($('#watchPlayer')) $('#watchPlayer').appendChild(frame);
  return frame;
}

/* Providers fronted by reCAPTCHA / Cloudflare Turnstile cannot finish their
   challenge in a cross-origin frame: the challenge runs in a nested iframe that
   Google/Cloudflare sandbox themselves, and the embedder cannot add
   allow-storage-access-by-user-activation to a frame it does not own. The
   provider then falls back to a top-level google.com interstitial, which
   Chrome refuses to frame (X-Frame-Options: sameorigin) and the player dies
   silently — no load event, no error, just a blank box.

   Note that granting storage access (the storage-access permissions policy plus
   the sandbox token) is necessary but NOT sufficient: Turnstile still refuses
   to solve inside a third-party frame even once cookies are unblocked, which
   is why the challenge frame carries sec-fetch-storage-access: active and
   still fails.

   A cross-origin frame that loaded fine also reports a null contentDocument, so
   null alone proves nothing. We only flag the player when no load event has
   arrived within the window, which is what a refused frame looks like. */
function watchPlayerFrame(frame) {
  let settled = false;
  const done = () => { settled = true; };
  const timer = setTimeout(() => {
    if (settled || !frame.isConnected) return;
    if (frame.contentDocument) return;
    const stateEl = $('#playerState');
    if (stateEl) stateEl.hidden = false;
    if ($('#playerStateHeading')) $('#playerStateHeading').textContent = 'Player Blocked';
    if ($('#playerStateText')) {
      $('#playerStateText').textContent =
        'This server sits behind a bot check that cannot complete inside a page frame. Use "Open in Tab", or pick another server above.';
    }
    if ($('#playerRetryBtn')) $('#playerRetryBtn').hidden = true;
    toast('Player blocked by anti-bot check — try another server', 'error');
  }, 9000);

  frame.addEventListener('load', done, { once: true });
  frame.addEventListener('error', done, { once: true });
  return () => clearTimeout(timer);
}

/* Popup blocker: strips popup permissions from the player sandbox so host
   popunders (the ad tabs you find after PiP) can never open. Takes effect on
   stream (re)load, since sandbox tokens apply at navigation time. */
const strictSandbox = (sb) => String(sb || '')
  .replace(/\s*allow-popups-to-escape-sandbox/g, '')
  .replace(/\s*allow-popups(?=\s|$)/g, '')
  .replace(/\s+/g, ' ').trim();
const isBlockPopups = () => {
  // Default ON: first-time visitors get popunder ads blocked without having
  // to find the toggle. Only an explicit opt-out ('0') re-enables popups.
  try { return localStorage.getItem(STORAGE_KEYS.BLOCK_POPUPS) !== '0'; } catch { return true; }
};
const syncBlockPopupsBtn = () => {
  const b = $('#blockPopupsBtn');
  if (b) b.classList.toggle('active', isBlockPopups());
};

function isSafeEmbed(u) {
  try {
    const x = new URL(u, location.href);
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return false;
    const h = x.hostname.toLowerCase();
    if (!h || h.indexOf('.') < 0) return false;
    if (h === location.hostname.toLowerCase() || h === 'localhost') return false;
    if (/^127\.|^10\.|^192\.168\./.test(h)) return false;
    return true;
  } catch { return false; }
}

async function loadStreamEmbed(token, serverMeta, { fresh = false } = {}) {
  if (!state.watch) return;
  const { slug, ep } = state.watch;
  const stateEl = $('#playerState');
  if (stateEl) stateEl.hidden = false;

  if ($('#playerStateHeading')) $('#playerStateHeading').textContent = `Loading ${serverMeta ? serverMeta.host : 'Server'}`;
  if ($('#playerStateText')) $('#playerStateText').textContent = 'Resolving direct stream…';

  state.watch.activeToken = token;
  $$('.server-chip').forEach((c) => c.classList.toggle('active', c.dataset.token === token));

  const frame = resetPlayerFrame();

  try {
    // Try to extract direct stream URL (ad-free)
    const res = await api(`/api/stream/${encodeURIComponent(slug)}/${ep}?token=${encodeURIComponent(token)}${fresh ? '&fresh=1' : ''}`, { useCache: false });
    if (res.streamUrl && setupVideoPlayer(res.streamUrl, res.type, res.referrer)) {
      state.watch.embedUrl = res.streamUrl;
      if ($('#openInTabBtn')) $('#openInTabBtn').hidden = false;
      if (stateEl) stateEl.hidden = true;
      if ($('#watchEpisodeHint')) {
        $('#watchEpisodeHint').textContent = `Direct stream via ${serverMeta.host} (${serverMeta.quality} · ${serverMeta.version}) — no ads.`;
      }
      return;
    }
  } catch (streamErr) {
    console.warn('Direct stream extraction failed, falling back to embed:', streamErr);
  }

  // Fallback to iframe embed
  try {
    if ($('#playerStateText')) $('#playerStateText').textContent = 'Loading embed player…';
    const res = await api(`/api/embed/${encodeURIComponent(slug)}/${ep}?token=${encodeURIComponent(token)}${fresh ? '&fresh=1' : ''}`, { useCache: false });
    if (!isSafeEmbed(res.url)) throw new Error('Unsafe stream target blocked by security guard.');

    const sb = isBlockPopups() ? strictSandbox(res.sandbox) : res.sandbox;
    frame.setAttribute('sandbox', sb || 'allow-scripts allow-same-origin allow-presentation allow-forms allow-orientation-lock allow-downloads allow-storage-access-by-user-activation');
    watchPlayerFrame(frame);
    state.watch.embedUrl = res.url;
    if ($('#openInTabBtn')) $('#openInTabBtn').hidden = false;
    frame.src = res.url;
    frame.hidden = false;
    const video = $('#videoPlayer');
    const pipBtn = $('#pipBtn');
    if (video) video.hidden = true;
    if (pipBtn) pipBtn.hidden = true;
    if (stateEl) stateEl.hidden = true;

    if ($('#watchEpisodeHint')) {
      $('#watchEpisodeHint').textContent = res.warning === 'challenge'
        ? `This server (${serverMeta.host}) shows an automatic bot check that usually stalls inside the player — use "Open in Tab ↗" above, or pick another server.`
        : `Streaming via ${serverMeta.host} (${serverMeta.quality} · ${serverMeta.version}). Enjoy the episode!`;
    }
  } catch (err) {
    if (stateEl) stateEl.hidden = false;
    if ($('#playerStateHeading')) $('#playerStateHeading').textContent = 'Server Unavailable';
    if ($('#playerStateText')) $('#playerStateText').textContent = `Stream failed (${err.message}). Please click an alternate server above.`;
    toast('Server stream failed — please select another server', 'error');
  }
}

/* =========================================================================
   9. Global Event Listeners & Bootstrapping
   ========================================================================= */
function setupGlobalEvents() {
  // Global image error fallback handler (capturing phase)
  window.addEventListener('error', (e) => {
    if (e.target && e.target.tagName === 'IMG') {
      const img = e.target;
      const src = img.src || '';
      // If the image failed, retry once through the backend proxy, then placeholder
      if (src.startsWith('https://') && !img.dataset.proxied) {
        img.dataset.proxied = '1';
        img.src = '/api/image?url=' + encodeURIComponent(src);
      } else if (!img.dataset.fallback) {
        img.dataset.fallback = '1';
        img.src = POSTER_PLACEHOLDER;
      }
    }
  }, true);

  // Global clicks
  document.addEventListener('click', (e) => {
    // Section "View All" / "Show Less" toggle
    const viewAll = e.target.closest('[data-viewall]');
    if (viewAll) {
      e.preventDefault();
      e.stopPropagation();
      const section = document.getElementById('sec-' + viewAll.dataset.viewall);
      const opened = toggleSectionExpand(section);
      if (opened && section) {
        section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }

    // Related-rail MovieItem navigation (SPA, no full reload)
    const relLink = e.target.closest('.related-grid .mi-link');
    if (relLink && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      go(relLink.getAttribute('href'));
      return;
    }

    // Anime card navigation
    const cardLink = e.target.closest('.card-poster, .card-title');
    if (cardLink && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      const card = cardLink.closest('.anime-card');
      if (card) {
        const { kind, slug, ep } = card.dataset;
        if (kind === 'watch' && ep) go(`/watch/${slug}/${ep}`);
        else go(`/${kind || 'anime'}/${slug}`);
      }
      return;
    }

    // Card bookmark button
    const bmBtn = e.target.closest('.card-bookmark-btn');
    if (bmBtn) {
      e.preventDefault();
      e.stopPropagation();
      const card = bmBtn.closest('.anime-card');
      if (card) {
        const slug = card.dataset.slug;
        const title = card.querySelector('.card-title') ? card.querySelector('.card-title').textContent : slug;
        const poster = card.querySelector('img') ? card.querySelector('img').src : '';
        const kind = card.dataset.kind || 'anime';
        const added = Storage.toggleBookmark({ slug, title, poster, kind });
        bmBtn.classList.toggle('saved', added);
        bmBtn.querySelector('svg').setAttribute('fill', added ? 'currentColor' : 'none');
        toast(added ? 'Saved to My List' : 'Removed from My List', 'success');
      }
      return;
    }

    // Navigation links
    const navEl = e.target.closest('[data-nav]');
    if (navEl) {
      e.preventDefault();
      const to = navEl.dataset.nav;
      closeDrawer();
      if (to === 'home') {
        go('/');
      } else if (to === 'bookmarks') {
        openBookmarksView();
      } else {
        if (location.pathname !== '/' || parseRoute().view !== 'home') {
          go('/#' + to).then(() => setTimeout(() => scrollToSection(to), 80));
        } else {
          history.replaceState(null, '', '/#' + to);
          setActiveNav(to);
          scrollToSection(to);
        }
      }
      return;
    }

    // Continue watching resume / remove
    const contCard = e.target.closest('.continue-card');
    const contRemove = e.target.closest('.continue-remove');
    if (contRemove) {
      e.stopPropagation();
      Storage.removeHistory(contRemove.dataset.slug, Number(contRemove.dataset.ep));
      return;
    }
    if (contCard) {
      go(`/watch/${contCard.dataset.slug}/${contCard.dataset.ep}`);
      return;
    }

    // Episode item button (details & sidebar)
    const epBtn = e.target.closest('.episode-item');
    if (epBtn && epBtn.dataset.ep) {
      const epNum = Number(epBtn.dataset.ep);
      const slug = epBtn.dataset.slug || (state.anime && state.anime.slug) || (state.watch && state.watch.slug);
      if (slug) go(`/watch/${slug}/${epNum}`);
      return;
    }

    // Hero thumbnail click
    const thumb = e.target.closest('.hero-thumb');
    if (thumb && thumb.dataset.idx !== undefined) {
      renderHeroSlide(Number(thumb.dataset.idx));
      return;
    }
  });

  // Hero Prev / Next controls
  const heroPrev = $('#heroPrev');
  const heroNext = $('#heroNext');
  if (heroPrev) {
    heroPrev.addEventListener('click', () => {
      if (!state.home || !state.home.hero) return;
      const len = state.home.hero.length;
      state.heroIndex = (state.heroIndex - 1 + len) % len;
      renderHeroSlide(state.heroIndex);
    });
  }
  if (heroNext) {
    heroNext.addEventListener('click', () => {
      if (!state.home || !state.home.hero) return;
      const len = state.home.hero.length;
      state.heroIndex = (state.heroIndex + 1) % len;
      renderHeroSlide(state.heroIndex);
    });
  }

  // Hero pause on hover
  const heroEl = $('#hero');
  if (heroEl) {
    heroEl.addEventListener('mouseenter', stopHeroSlider);
    heroEl.addEventListener('mouseleave', startHeroSlider);
  }

  // Server quality switch
  const qBar = $('#serverQualities');
  if (qBar) {
    qBar.addEventListener('click', (e) => {
      const b = e.target.closest('.server-quality');
      if (!b || !state.watch) return;
      state.watch.quality = b.dataset.quality;
      $$('.server-quality', qBar).forEach((x) => x.classList.toggle('active', x === b));
      renderServerChips();
      const first = (state.watch.servers || []).find((s) => s.quality === state.watch.quality);
      if (first) loadStreamEmbed(first.token, first);
    });
  }

  // Server chip click
  const sList = $('#serverList');
  if (sList) {
    sList.addEventListener('click', (e) => {
      const chip = e.target.closest('.server-chip');
      if (!chip || !state.watch) return;
      const token = chip.dataset.token;
      const meta = (state.watch.servers || []).find((s) => s.token === token);
      loadStreamEmbed(token, meta);
    });
  }

  // Fullscreen player — the reliable escape hatch on phones, where a
  // cross-origin player with a fixed intrinsic size can't scale down.
  const fsBtn = $('#btnFullscreen');
  if (fsBtn) {
    const fsTarget = () => {
      const frame = $('#playerFrame');
      // Fullscreen the iframe itself: the embedded page then gets the whole
      // screen as its viewport, which is the most room it will ever get.
      if (frame && !frame.hidden) return frame;
      return $('#watchPlayer');
    };

    fsBtn.addEventListener('click', async () => {
      const target = fsTarget();
      if (!target) return;
      try {
        const active = document.fullscreenElement || document.webkitFullscreenElement;
        if (active) {
          await (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen());
        } else if (target.requestFullscreen) {
          await target.requestFullscreen();
        } else if (target.webkitRequestFullscreen) {
          target.webkitRequestFullscreen();
        } else {
          toast('Fullscreen is not supported on this browser', 'error');
        }
      } catch {
        toast('Fullscreen was blocked by the browser', 'error');
      }
    });

    const onFsChange = () => {
      const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
      const label = fsBtn.querySelector('span');
      if (label) label.textContent = on ? 'Exit' : 'Fullscreen';
      fsBtn.classList.toggle('btn-glass', !on);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);
  }

  // Fullscreen hotkey
  document.addEventListener('keydown', (e) => {
    if (e.key === 'k' || e.key === 'K') {
      if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
      if ($('#btnFullscreen')) $('#btnFullscreen').click();
    }
  });

  // Reload server button
  const reloadBtn = $('#reloadServerBtn');
  if (reloadBtn) {
    reloadBtn.addEventListener('click', () => {
      if (!state.watch || !state.watch.activeToken) return;
      const meta = (state.watch.servers || []).find((s) => s.token === state.watch.activeToken);
      loadStreamEmbed(state.watch.activeToken, meta, { fresh: true });
      toast('Reloading player stream…');
    });
  }

  // Open in new tab — the reliable path for hosts behind an anti-bot check,
  // since a top-level document is not cross-origin-framed and the challenge
  // can complete normally.
  const openTabBtn = $('#openInTabBtn');
  if (openTabBtn) {
    openTabBtn.addEventListener('click', () => {
      const u = state.watch && state.watch.embedUrl;
      if (!u || !isSafeEmbed(u)) return;
      window.open(u, '_blank', 'noopener,noreferrer');
    });
  }

  // Popup blocker toggle — persists, then reloads the stream fresh so the new
  // sandbox tokens apply (they only take effect at navigation time).
  syncBlockPopupsBtn();
  const blockBtn = $('#blockPopupsBtn');
  if (blockBtn) {
    blockBtn.addEventListener('click', () => {
      let on = false;
      try {
        on = !isBlockPopups();
        localStorage.setItem(STORAGE_KEYS.BLOCK_POPUPS, on ? '1' : '0');
      } catch { /* private mode: apply for this session only */ on = !isBlockPopups(); }
      syncBlockPopupsBtn();
      toast(on ? 'Popup tabs blocked — reloading stream…' : 'Popup tabs allowed — reloading stream…');
      if (state.watch && state.watch.activeToken) {
        const meta = (state.watch.servers || []).find((s) => s.token === state.watch.activeToken);
        loadStreamEmbed(state.watch.activeToken, meta, { fresh: true });
      }
    });
  }

  // Theater Mode toggle
  const theaterBtn = $('#btnTheaterMode');
  if (theaterBtn) {
    theaterBtn.addEventListener('click', () => {
      state.theaterMode = !state.theaterMode;
      const watchSec = $('#watchSection');
      if (watchSec) watchSec.classList.toggle('theater-mode', state.theaterMode);
      theaterBtn.querySelector('span').textContent = state.theaterMode ? '⛶ Normal' : '⛶ Theater';
    });
  }

  // Picture-in-Picture button (for video player)
  const pipBtn = $('#pipBtn');
  if (pipBtn) {
    pipBtn.addEventListener('click', async () => {
      const video = $('#videoPlayer');
      if (!video || video.hidden) return;
      try {
        if (document.pictureInPictureElement === video) {
          await document.exitPictureInPicture();
        } else {
          await video.requestPictureInPicture();
        }
      } catch (e) {
        console.warn('PiP failed:', e);
      }
    });
    // Show/hide PiP button based on video player visibility and PiP support
    const video = $('#videoPlayer');
    if (video && 'pictureInPictureEnabled' in document) {
      pipBtn.hidden = false;
    }
  }

  // Cinema Mode (Lights Off) toggle
  const cinemaBtn = $('#btnCinemaMode');
  const cinemaOverlay = $('#cinemaOverlay');
  if (cinemaBtn) {
    cinemaBtn.addEventListener('click', () => {
      state.cinemaMode = !state.cinemaMode;
      document.body.classList.toggle('cinema-active', state.cinemaMode);
      if (cinemaOverlay) {
        cinemaOverlay.hidden = !state.cinemaMode;
        cinemaOverlay.classList.toggle('active', state.cinemaMode);
      }
      cinemaBtn.querySelector('span').textContent = state.cinemaMode ? '💡 Lights On' : '💡 Lights Off';
    });
  }
  if (cinemaOverlay) {
    cinemaOverlay.addEventListener('click', () => {
      state.cinemaMode = false;
      document.body.classList.remove('cinema-active');
      cinemaOverlay.hidden = true;
      cinemaOverlay.classList.remove('active');
      if (cinemaBtn) cinemaBtn.querySelector('span').textContent = '💡 Lights Off';
    });
  }

  // Back to anime detail button
  const backBtn = $('#backToAnime');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      const slug = state.watch && state.watch.slug;
      const kind = (state.anime && state.anime.kind) || 'anime';
      if (slug) go(`/${kind}/${slug}`);
      else go('/');
    });
  }

  // Clear history button
  const clearHistBtn = $('#clearHistoryBtn');
  if (clearHistBtn) {
    clearHistBtn.addEventListener('click', () => {
      if (confirm('Clear your continue watching history?')) {
        Storage.clearHistory();
        toast('History cleared', 'success');
      }
    });
  }

  // Close bookmarks button
  const closeBmBtn = $('#closeBookmarksBtn');
  if (closeBmBtn) {
    closeBmBtn.addEventListener('click', () => {
      const sec = $('#bookmarksSection');
      if (sec) sec.hidden = true;
    });
  }

  // Nav bell → jump to latest episodes
  const bellBtn = $('#navBellBtn');
  if (bellBtn) {
    bellBtn.addEventListener('click', () => {
      if (location.pathname !== '/' || parseRoute().view !== 'home') {
        go('/#latest').then(() => setTimeout(() => scrollToSection('latest'), 80));
      } else {
        history.replaceState(null, '', '/#latest');
        scrollToSection('latest');
      }
    });
  }

  // Nav avatar → My List
  const avatarBtn = $('#navAvatarBtn');
  if (avatarBtn) {
    avatarBtn.addEventListener('click', () => openBookmarksView());
  }

  // Jump to episode input (Detail page)
  const jumpBtn = $('#episodeJumpBtn');
  const jumpInput = $('#episodeJumpInput');
  if (jumpBtn && jumpInput) {
    const doJump = () => {
      const val = Number(jumpInput.value);
      if (!val || val < 1) return;
      const eps = (state.anime && state.anime.episodes) || [];
      const target = eps.find((x) => x.n === val);
      const routeSlug = (state.anime && state.anime.slug) || (state.watch && state.watch.slug);
      const slug = (target && target.slug) || routeSlug;
      if (slug) go(`/watch/${slug}/${val}`);
    };
    jumpBtn.addEventListener('click', doJump);
    jumpInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJump(); });
  }

  // Sidebar episode search — spans every episode, not just the active chunk
  const sideSearch = $('#sidebarEpisodeSearch');
  if (sideSearch) {
    sideSearch.addEventListener('input', () => {
      const list = $('#episodeList');
      const explorer = list && list.episodeExplorer;
      if (explorer) {
        explorer.renderMatches(sideSearch.value);
        return;
      }
      const val = sideSearch.value.trim().toLowerCase();
      $$('.episode-item', list).forEach((item) => {
        const num = item.dataset.ep;
        const text = item.textContent.toLowerCase();
        item.hidden = val ? (!num.includes(val) && !text.includes(val)) : false;
      });
    });
  }

  // Browse filter tabs
  const browseFilters = $('#browseFilters');
  if (browseFilters) {
    browseFilters.addEventListener('click', (e) => {
      const pill = e.target.closest('.filter-pill');
      if (!pill) return;
      state.currentBrowseFilter = pill.dataset.filter;
      $$('.filter-pill', browseFilters).forEach((p) => p.classList.toggle('active', p === pill));
      filterAndRenderSearchResults();
    });
  }

  // Mobile Drawer
  const openDrawerBtn = $('#openDrawer');
  const closeDrawerBtn = $('#closeDrawer');
  const drawer = $('#mobileDrawer');
  const drawerBackdrop = $('#drawerBackdrop');

  function openDrawer() {
    if (drawer) {
      drawer.hidden = false;
      setTimeout(() => drawer.classList.add('open'), 10);
    }
  }
  function closeDrawer() {
    if (drawer) {
      drawer.classList.remove('open');
      setTimeout(() => { drawer.hidden = true; }, 300);
    }
  }

  if (openDrawerBtn) openDrawerBtn.addEventListener('click', openDrawer);
  if (closeDrawerBtn) closeDrawerBtn.addEventListener('click', closeDrawer);
  if (drawerBackdrop) drawerBackdrop.addEventListener('click', closeDrawer);

  // Navbar background on scroll
  const nav = $('#navbar');
  const onScroll = () => {
    if (nav) nav.classList.toggle('scrolled', window.scrollY > 20);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    // Focus search on '/'
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT' && document.activeElement.tagName !== 'TEXTAREA') {
      e.preventDefault();
      const input = $('#searchInput');
      if (input) {
        input.focus();
        input.select();
      }
      return;
    }
    // Toggle Theater on 'F' while watching
    if (e.key.toLowerCase() === 'f' && parseRoute().view === 'watch' && document.activeElement.tagName !== 'INPUT') {
      const tBtn = $('#btnTheaterMode');
      if (tBtn) tBtn.click();
      return;
    }
    // Toggle Lights on 'L' while watching
    if (e.key.toLowerCase() === 'l' && parseRoute().view === 'watch' && document.activeElement.tagName !== 'INPUT') {
      const cBtn = $('#btnCinemaMode');
      if (cBtn) cBtn.click();
      return;
    }
    // Next episode on 'N'
    if (e.key.toLowerCase() === 'n' && parseRoute().view === 'watch' && document.activeElement.tagName !== 'INPUT') {
      const nBtn = $('#nextEpisode');
      if (nBtn && !nBtn.disabled) nBtn.click();
      return;
    }
    // Prev episode on 'P'
    if (e.key.toLowerCase() === 'p' && parseRoute().view === 'watch' && document.activeElement.tagName !== 'INPUT') {
      const pBtn = $('#previousEpisode');
      if (pBtn && !pBtn.disabled) pBtn.click();
      return;
    }
  });

  // Browser navigation events
  window.addEventListener('popstate', handleRoute);
  window.addEventListener('hashchange', () => {
    const r = parseRoute();
    if (r.view === 'home' && r.hash) scrollToSection(r.hash.slice(1));
  });
}

/* =========================================================================
   10. App Initialization
   ========================================================================= */
document.addEventListener('DOMContentLoaded', () => {
  setupSearch();
  setupGlobalEvents();
  updateBookmarkBadge();

  handleRoute().finally(() => {
    setTimeout(() => {
      const loader = $('#loader');
      if (loader) loader.classList.add('hidden');
    }, 200);
  });
});
