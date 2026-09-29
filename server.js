#!/usr/bin/env node
/* =========================================================================
   AnimeWit Backend — High-Performance Static Server + animezid.cam scraper
   - In-memory caching with TTL
   - Native Gzip/Deflate compression for static assets & API responses
   - ETag & HTTP 304 conditional request support
   - Safe token-based stream embed resolver with sandbox protections
   - Automatic SPA routing fallback
   ========================================================================= */

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 3000;
const BASE = (process.env.UPSTREAM_BASE || 'https://animezid.cam').replace(/\/+$/, '');
const IMAGE_BASE = (process.env.UPSTREAM_IMAGES || 'https://animezid.cam').replace(/\/+$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ROOT = fs.existsSync(path.join(__dirname, 'public')) ? path.join(__dirname, 'public') : __dirname;
/* Upstream hostname as a regex-safe fragment, so the HTML scrapers follow UPSTREAM_BASE. */
const HOST_RX = new URL(BASE).hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const TTL = {
  home: 3 * 60e3,         // 3 min
  search: 5 * 60e3,       // 5 min
  anime: 10 * 60e3,       // 10 min
  index: 30 * 60e3,       // full series episode index (expensive to rebuild)
  vid: 24 * 60 * 60e3,    // watch.php metadata for a video id
  session: 12 * 60e3,     // playback session
  embed: 5 * 60e3         // resolved embed target (launch urls expire fast)
};
const MAX_REQ_PER_MIN = Number(process.env.UPSTREAM_RPM) || 120; // safe rate limit for upstream animezid
const MAX_QUEUE_WAIT = Number(process.env.UPSTREAM_MAX_WAIT_MS) || 5000; // never stall a request past this (serverless timeouts)
const PAGE_SIZE = 60;                 // episode cards per season page
const MAX_SEASON_PAGES = 40;          // safety cap per season
/* Video ids on animezid are short lowercase hex (?vid=080a53aa1); series slugs rarely collide. */
const VID_RX = /^[a-f0-9]{7,12}$/;
/* Playback source ids look like src_94r0owuTnPtbS7Y7x1khM0hZrRD4wyuL_1w_WdyhdC8 */
const TOKEN_RX = /^[A-Za-z0-9_\-.|:+/]{4,200}$/;

/* ---------------- In-memory API cache ---------------- */
const store = new Map();
function cacheGet(key) {
  const h = store.get(key);
  if (!h) return null;
  if (Date.now() > h.exp) { store.delete(key); return null; }
  return h.v;
}
function cacheSet(key, v, ttl) {
  store.set(key, { v, exp: Date.now() + ttl });
  if (store.size > 250) {
    const now = Date.now();
    for (const [k, item] of store) {
      if (now > item.exp) store.delete(k);
    }
  }
  return v;
}

/* ---------------- Rate Guard ---------------- */
const hits = [];
function waitForSlot() {
  const now = Date.now();
  while (hits.length && now - hits[0] > 60e3) hits.shift();
  if (hits.length < MAX_REQ_PER_MIN) {
    hits.push(now);
    return Promise.resolve();
  }
  const wait = Math.min(60e3 - (now - hits[0]) + 60, MAX_QUEUE_WAIT);
  return new Promise((r) => setTimeout(r, wait)).then(() => {
    hits.push(Date.now());
  });
}

/* ---------------- Cookie Jar ---------------- */
class Jar {
  constructor() { this.c = new Map(); }
  absorb(res) {
    const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const raw of list) {
      const first = raw.split(';')[0];
      const i = first.indexOf('=');
      if (i > 0) this.c.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
    }
    return this;
  }
  header() {
    return [...this.c.entries()].map(([k, v]) => k + '=' + v).join('; ');
  }
  get size() { return this.c.size; }
}

/* ---------------- Upstream Request Helper ---------------- */
async function wt(url, { jar, method = 'GET', headers = {}, body, redirect = 'follow', timeout = 25000 } = {}) {
  await waitForSlot();
  const h = {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'ar,en;q=0.9,en-US;q=0.8',
    ...headers
  };
  if (jar && jar.size) h.cookie = jar.header();
  const res = await fetch(url, { method, headers: h, body, redirect, signal: AbortSignal.timeout(timeout) });
  if (jar) jar.absorb(res);
  return res;
}

/* ---------------- Typed upstream errors (mapped to HTTP status by fail()) ---------------- */
const errWith = (code, msg) => Object.assign(new Error(msg), { code });
const err404 = (m) => errWith(404, m);
const err429 = (m) => errWith(429, m);
const err502 = (m) => errWith(502, m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- HTML Parse Helpers ---------------- */
const decodeEnt = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));

const stripTags = (s) => decodeEnt(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function absUrl(u) {
  if (!u) return '';
  if (u.startsWith('http')) return u;
  if (u.startsWith('//')) return 'https:' + u;
  return BASE + (u.startsWith('/') ? u : '/' + u);
}

/* First anchor inside a card/hero body (prefers the primary link classes). */
function firstAnchor(body) {
  const link = body.match(/<a\b[^>]*class="[^"]*az-card__link[^"]*"[^>]*>/)
    || body.match(/<a\b[^>]*class="[^"]*az-showcase-card__link[^"]*"[^>]*>/)
    || body.match(/<a\b[^>]*>/);
  if (!link) return null;
  return (link[0].match(/\bhref="([^"]+)"/) || [])[1] || null;
}

/* Map an upstream href to the local route model:
   /series/{slug}/  → series detail        watch.php?vid=… → episode (badge) or movie */
function classifyLink(href) {
  if (!href) return null;
  const series = href.match(/\/series\/([^/"#?]+)\//);
  if (series) return { kind: 'anime', slug: decodeURIComponent(series[1]) };
  const vid = href.match(/[?&]vid=([a-f0-9]+)/i);
  if (vid && VID_RX.test(vid[1].toLowerCase())) return { kind: 'watch', slug: vid[1].toLowerCase() };
  return null;
}

/* Text inside an html window, without tags — used for badge values */
function windowText(body, anchor, span = 220) {
  const i = body.indexOf(anchor);
  return i < 0 ? '' : stripTags(body.slice(i, i + span));
}

/* Extract anime/episode cards from HTML chunks (az-card markup) */
/* Normalize upstream ribbon/title wording into the three audio states:
   بالمصري (Egyptian dub) > مدبلج (dubbed, incl. فصحى) > مترجم (subtitled) */
function pickAudio(s) {
  s = String(s || '');
  if (/مصري/.test(s)) return 'بالمصري';
  if (/فصح/.test(s)) return 'مدبلج';
  if (/مدبلج|دبلج/.test(s)) return 'مدبلج';
  if (/مترجم/.test(s)) return 'مترجم';
  return null;
}

function parseCards(html) {
  const out = [];
  const re = /<article class="az-card\b[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1];
    const href = firstAnchor(body);
    const target = classifyLink(href);
    if (!target) continue;

    const img = body.match(/<img[^>]*\bsrc="([^"]+)"/);
    const fallback = body.match(/<img[^>]*\bdata-fallback="([^"]+)"/);
    const alt = body.match(/<img[^>]*\balt="([^"]*)"/);
    const title = stripTags((body.match(/az-card__title[^>]*>([\s\S]*?)<\//) || [])[1])
      || stripTags((alt || [])[1])
      || '';
    if (!title) continue;

    const epBadge = body.match(/az-badge--episode[\s\S]{0,240}?<strong>\s*(\d+)\s*<\/strong>/);
    const quality = stripTags((body.match(/az-badge--quality[^>]*>([^<]*)</) || [])[1]);
    const rating = (windowText(body, 'az-badge--rating').match(/\d+(?:\.\d+)?/) || [])[0] || null;
    const ribbonM = body.match(/az-badge--ribbon[^>]*>\s*<span>([^<]*)<\/span>/);
    const ribbon = ribbonM ? stripTags(ribbonM[1]) : '';
    const qualityIsAudio = pickAudio(quality);

    const card = {
      kind: target.kind,
      slug: target.slug,
      href: absUrl(href),
      poster: absUrl(img ? img[1] : (fallback ? fallback[1] : '')),
      banner: '',
      title,
      rating,
      audio: pickAudio(ribbon) || pickAudio(quality) || pickAudio(title) || 'مترجم'
    };

    if (target.kind === 'watch') {
      if (epBadge) {
        card.ep = Number(epBadge[1]);
        card.label = 'الحلقة ' + card.ep;
        card.type = 'Episode';
      } else {
        // watch link without an episode badge → a movie / standalone video
        card.kind = 'movie';
        card.ep = null;
        card.type = qualityIsAudio ? 'Movie' : (quality || 'Movie');
      }
    } else {
      card.type = qualityIsAudio ? 'TV' : (quality || 'TV');
    }
    out.push(card);
  }
  return out;
}

/* Parse Hero slider (az-showcase) from homepage */
function parseHero(html) {
  const out = [];
  const re = /<article class="az-showcase-card">([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1];
    const href = firstAnchor(body);
    const target = classifyLink(href);
    if (!target) continue;

    const img = body.match(/<img[^>]*\bsrc="([^"]+)"/);
    const alt = body.match(/<img[^>]*\balt="([^"]*)"/);
    const copy = stripTags((body.match(/az-showcase-card__copy[\s\S]{0,400}?<strong[^>]*>([\s\S]*?)<\/strong>/) || [])[1]);
    const title = copy || stripTags((alt || [])[1]);
    if (!title) continue;

    const rIdx = body.indexOf('az-showcase-card__rating');
    const rating = rIdx < 0 ? null : ((stripTags(body.slice(rIdx, rIdx + 220)).match(/\d+(?:\.\d+)?/) || [])[0] || null);
    const year = (title.match(/\b(?:19|20)\d{2}\b/) || [])[1];
    const epM = title.match(/الحلقة\s*(\d+)/);

    const item = {
      kind: target.kind,
      slug: target.slug,
      ep: null,
      href: absUrl(href),
      title,
      banner: absUrl(img ? img[1] : ''),
      poster: absUrl(img ? img[1] : ''),
      meta: [rating ? '★ ' + rating : null, year].filter(Boolean).join(' · '),
      description: ''
    };
    if (target.kind === 'watch') {
      if (epM) item.ep = Number(epM[1]);
      else item.kind = 'movie';
    }
    out.push(item);
    if (out.length >= 8) break;
  }
  return out;
}

/* Split page by <h2> into titled sections, mapping upstream Arabic titles to nav keys */
function parseSections(html) {
  const chunks = html.split(/<h2\b/);
  const sections = [];
  const used = new Set();
  const KEY_MAP = [
    [/الأكثر\s+مشاهدة/, 'trending', 'Trending Anime'],
    [/أحدث\s+الإضافات/, 'latest', 'Latest Episodes'],
    [/أحدث\s+الافلام|أحدث\s+الأفلام|أفلام\s+جديدة/, 'movies', 'Latest Movies'],
    [/^الأنمي$/, 'top', 'Top Anime'],
    [/أحدث\s+حلقات\s+الأنمي/, 'seasonal', 'Current Season']
  ];
  chunks.forEach((chunk, i) => {
    const end = chunk.indexOf('</h2>');
    if (end < 0) return;
    const headRaw = chunk.slice(0, end);
    const title = stripTags((headRaw.match(/>[\s\S]*$/) || [''])[0].replace(/^>/, ''));
    const body = chunk.slice(end + 5);
    const items = parseCards(body);
    if (!items.length) return;
    let key = 'section' + i;
    let enTitle = title;
    for (const [re, k, en] of KEY_MAP) {
      if (re.test(title) && !used.has(k)) {
        key = k;
        enTitle = en;
        break;
      }
    }
    used.add(key);
    sections.push({ key, title, enTitle, items: items.slice(0, 18) });
  });
  return sections;
}

function parseJsonLd(html) {
  const idx = html.indexOf('application/ld+json');
  if (idx < 0) return null;
  const open = html.indexOf('{', idx);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(open, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/* Parse a series page (title/poster/synopsis/genres + season list) */
function parseSeriesPage(html, slug) {
  const og = (p) => (html.match(new RegExp(`<meta[^>]+property="og:${p}"[^>]+content="([^"]*)"`, 'i')) || [])[1]
    || (html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+property="og:${p}"`, 'i')) || [])[1];
  const ld = parseJsonLd(html) || {};
  const graph = Array.isArray(ld['@graph']) ? ld['@graph'] : [ld];
  const seriesLd = graph.find((x) => x && (x['@type'] === 'TVSeries' || x['@type'] === 'Movie')) || {};

  const h1 = stripTags((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1]);
  const title = h1 || stripTags(og('title') || '').replace(/\s*[|\-–]\s*(?:انمي زد|Anime Z).*/i, '') || slug.replace(/-/g, ' ');

  const genres = Array.isArray(seriesLd.genre) ? seriesLd.genre.slice()
    : (seriesLd.genre ? [seriesLd.genre] : []);
  if (!genres.length) {
    // no genre block on the page → fall back to the breadcrumb category
    const bcNav = (html.match(/<nav[^>]*class="[^"]*breadcrumb[^"]*"[\s\S]*?<\/nav>/) || [])[0] || '';
    const cat = (bcNav.match(/category\.php\?cat=[^"]*"[^>]*>([^<]+)</) || [])[1];
    if (cat) genres.push(stripTags(cat));
  }

  const seasonSet = new Set();
  const seasonRe = /\/series\/[^/"#?]+\/season\/(\d+)\//g;
  let sm;
  while ((sm = seasonRe.exec(html))) seasonSet.add(Number(sm[1]));
  const seasons = [...seasonSet].sort((a, b) => a - b);

  const rawYear = seriesLd.dateCreated || seriesLd.startDate
    || (windowText(html, 'az-series-stats').match(/\b(?:19|20)\d{2}\b/) || [])[0] || null;

  return {
    title,
    poster: absUrl(seriesLd.image || og('image') || ''),
    description: stripTags(seriesLd.description || og('description') || '').slice(0, 600),
    genres,
    year: rawYear ? ((String(rawYear).match(/\b(?:19|20)\d{2}\b/) || [])[0] || null) : null,
    studio: seriesLd.productionCompany && seriesLd.productionCompany.name ? seriesLd.productionCompany.name : null,
    seasons: seasons.length ? seasons : [1]
  };
}

/* Parse one season page → [{slug: vid, badge}] in DOM order */
function parseSeasonPage(html) {
  const out = [];
  const re = /<article class="az-card\b[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1];
    const href = firstAnchor(body);
    const target = classifyLink(href);
    if (!target || target.kind !== 'watch') continue;
    const badge = body.match(/az-badge--episode[\s\S]{0,240}?<strong>\s*(\d+)\s*<\/strong>/);
    out.push({ slug: target.slug, badge: badge ? Number(badge[1]) : null });
  }
  return out;
}

/* Run fn over a list with bounded concurrency */
async function pooled(list, limit, fn) {
  const results = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
    while (next < list.length) {
      const i = next++;
      results[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/* ---------------- Episode index (series page → season pages → flat list) ---------------- */
async function episodeIndex(slug) {
  const key = 'idx:' + slug;
  const hit = cacheGet(key);
  if (hit) return hit;

  const res = await wt(`${BASE}/series/${slug}/`);
  if (res.status === 404) throw err404('Series not found: ' + slug);
  if (!res.ok) throw err502('series page ' + res.status);
  const html = await res.text();
  const meta = parseSeriesPage(html, slug);

  const seasonResults = await pooled(meta.seasons, 6, async (season) => {
    const items = [];
    for (let page = 1; page <= MAX_SEASON_PAGES; page++) {
      const r = await wt(`${BASE}/series/${slug}/season/${season}/?order=asc&page=${page}`);
      if (r.status === 404) break;
      if (!r.ok) throw err502(`season ${season} page ${page}: ` + r.status);
      const h = await r.text();
      const got = parseSeasonPage(h);
      if (!got.length) break;
      const first = got.find((x) => x.badge != null);
      const last = [...got].reverse().find((x) => x.badge != null);
      if (first && last && first.badge > last.badge) got.reverse();
      items.push(...got);
      if (got.length < PAGE_SIZE) break;
    }
    return { season, items };
  });

  const episodes = [];
  const seen = new Set();
  let n = 0;
  for (const sr of seasonResults) {
    for (const it of sr.items) {
      if (seen.has(it.slug)) continue;
      seen.add(it.slug);
      n++;
      episodes.push({ n, slug: it.slug, url: `${BASE}/watch.php?vid=${it.slug}`, label: 'الحلقة ' + n });
    }
  }

  // Fallback: no season pages → use the episode rail rendered on the series page itself
  if (!episodes.length) {
    const byN = new Map();
    for (const it of parseSeasonPage(html)) {
      if (it.badge != null && !byN.has(it.badge)) byN.set(it.badge, it);
    }
    for (const [num, it] of [...byN.entries()].sort((a, b) => a[0] - b[0])) {
      episodes.push({ n: num, slug: it.slug, url: `${BASE}/watch.php?vid=${it.slug}`, label: 'الحلقة ' + num });
    }
  }
  if (!episodes.length) throw err404('No episodes found for: ' + slug);

  const idx = Object.assign({}, meta, {
    url: `${BASE}/series/${slug}/`,
    episodes,
    byN: new Map(episodes.map((e) => [e.n, e]))
  });
  return cacheSet(key, idx, TTL.index);
}

/* ---------------- watch.php metadata (video id → series slug / movie) ---------------- */
async function vidInfo(vid) {
  const key = 'vid:' + vid;
  const hit = cacheGet(key);
  if (hit) return hit;

  const res = await wt(`${BASE}/watch.php?vid=${vid}`);
  if (res.status === 404) return null;
  if (!res.ok) throw err502('watch page ' + res.status);
  const html = await res.text();

  const og = (p) => (html.match(new RegExp(`<meta[^>]+property="og:${p}"[^>]+content="([^"]*)"`, 'i')) || [])[1]
    || (html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+property="og:${p}"`, 'i')) || [])[1];
  const nav = (html.match(/<nav class="az-cinema-breadcrumb"[\s\S]*?<\/nav>/) || [])[0] || '';
  const seriesM = nav.match(/\/series\/([^/"#?]+)\//);
  const epM = (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '';
  const episodeNum = epM.match(/الحلقة\s*(\d+)/);
  const poster = og('image') || (html.match(/az-cinema-poster[\s\S]{0,600}?<img[^>]*\bsrc="([^"]+)"/) || [])[1];

  // JSON-LD on the watch page (Movie / TVEpisode node) carries genre + year
  let genres = [];
  let year = null;
  const ldM = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (ldM) {
    try {
      const parsed = JSON.parse(ldM[1]);
      const nodes = parsed['@graph'] || [parsed];
      const node = nodes.find((n) => ['Movie', 'TVEpisode', 'VideoObject', 'Episode'].includes(n['@type'])) || {};
      if (node.genre) {
        const raw = Array.isArray(node.genre) ? node.genre.join('،') : node.genre;
        genres = String(raw).split(/[،,]/).map((g) => stripTags(g).trim()).filter(Boolean);
      }
      const y = node.dateCreated || node.datePublished;
      if (y) year = ((String(y).match(/\b(?:19|20)\d{2}\b/) || [])[0]) || null;
    } catch { /* not json */ }
  }
  if (!year) {
    const t = (epM ? stripTags(epM) : '') + ' ' + stripTags(og('title') || '');
    year = (t.match(/\b(?:19|20)\d{2}\b/) || [])[0] || null;
  }

  const info = {
    title: stripTags(epM) || stripTags(og('title') || '') || vid,
    poster: absUrl(poster || ''),
    description: stripTags(og('description') || '').slice(0, 600),
    seriesSlug: seriesM ? decodeURIComponent(seriesM[1]) : null,
    ep: episodeNum ? Number(episodeNum[1]) : null,
    genres,
    year,
    url: `${BASE}/watch.php?vid=${vid}`
  };
  return cacheSet(key, info, TTL.vid);
}

/* ---------------- Playback Session (play.php → web-playback → source resolve) ---------------- */
async function buildSession(vid, force = false) {
  const key = 'sess:' + vid;
  if (!force) {
    const cached = cacheGet(key);
    if (cached) return cached;
  }

  const jar = new Jar();
  const playUrl = `${BASE}/play.php?vid=${vid}`;
  const pageRes = await wt(playUrl, { jar });
  if (pageRes.status === 404) throw err404('Video not found: ' + vid);
  if (!pageRes.ok) throw err502('play page ' + pageRes.status);
  const html = await pageRes.text();
  const csrf = (html.match(/data-playback-csrf="([^"]+)"/) || [])[1];
  const createUrl = (html.match(/data-playback-create-url="([^"]+)"/) || [])[1];
  const contentId = (html.match(/data-video-uniq="([^"]+)"/) || [])[1] || vid;
  if (!csrf || !createUrl) throw err502('playback configuration not found');

  const sRes = await wt(createUrl, {
    jar,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-playback-csrf': csrf,
      origin: BASE,
      referer: playUrl,
      accept: 'application/json'
    },
    body: JSON.stringify({ content_id: contentId })
  });
  if (sRes.status === 429) throw err429('Upstream rate limited the playback session');
  if (!sRes.ok) {
    const body = await sRes.text().catch(() => '');
    throw err502('playback session ' + sRes.status + (body ? ': ' + body.slice(0, 200) : ''));
  }
  const sj = await sRes.json().catch(() => ({}));
  if (!sj.session_id) throw err502('playback session payload invalid');

  let ttl = TTL.session;
  const expAt = Date.parse(sj.expires_at || '');
  if (Number.isFinite(expAt)) ttl = Math.max(30e3, Math.min(ttl, expAt - Date.now() - 60e3));

  const rec = {
    vid,
    jar,
    csrf,
    sessionId: sj.session_id,
    sources: Array.isArray(sj.sources) ? sj.sources : [],
    playUrl,
    exp: Date.now() + ttl
  };
  return cacheSet(key, rec, ttl);
}

/* Resolve (slug, ep) → playback session for the correct video id.
   slug is usually a video id (fast path); series slugs go through the episode index. */
async function sessionFor(slug, ep) {
  if (VID_RX.test(slug)) {
    try {
      return await buildSession(slug);
    } catch (e) {
      if (!e || Number(e.code) !== 404) throw e;
      // hex-looking series slug — fall through to the index
    }
  }
  const idx = await episodeIndex(slug);
  const hit = idx.byN.get(Number(ep));
  if (!hit) throw err404('Episode not found: ' + slug + '/' + ep);
  return buildSession(hit.slug);
}

function listServers(sources) {
  const out = [];
  for (const s of sources || []) {
    if (!s || s.type !== 'embedded_web' || !s.id) continue; // download-only hosts can't be framed
    out.push({
      quality: 'HD',
      host: s.provider || 'Server',
      version: 'Web',
      lang: 'ar',
      token: s.id,
      kind: 'embedded_web'
    });
  }
  return out;
}

/* Safe embed target validator */
function safeEmbedUrl(u, reqHost) {
  try {
    if (!/^https?:\/\//i.test(String(u || ''))) return false;
    const x = new URL(u);
    if (x.protocol !== 'https:' && x.protocol !== 'http:') return false;
    const h = x.hostname.toLowerCase();
    if (!h || h.indexOf('.') < 0) return false;
    const own = String(reqHost || '').toLowerCase().split(':')[0];
    if (own && h === own) return false;
    if (h === 'localhost' || h.slice(-10) === '.localhost') return false;
    if (h === '[::1]' || h === '::1') return false;
    if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^0\./.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    return true;
  } catch { return false; }
}

async function resolveEmbed(slug, ep, token, reqHost) {
  const key = 'emb:' + slug + ':' + ep + ':' + token;
  const hit = cacheGet(key);
  if (hit) return hit;

  let s = await sessionFor(slug, ep);
  let src = (s.sources || []).find((x) => x.id === token);
  if (!src && s.vid) {
    // token belongs to a newer/older source list — rebuild the session once
    s = await buildSession(s.vid, true);
    src = (s.sources || []).find((x) => x.id === token);
  }
  if (!src) throw err502('Requested server is unavailable for this episode');

  const resolveOnce = () => wt(`${BASE}/web-playback/sessions/${s.sessionId}/sources/${src.id}/resolve`, {
    jar: s.jar,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-playback-csrf': s.csrf,
      origin: BASE,
      referer: s.playUrl,
      accept: 'application/json'
    },
    body: '{}'
  });

  let r = await resolveOnce();
  if (r.status === 429) {
    await sleep(900);
    r = await resolveOnce();
  }
  if (!r.ok) {
    await r.arrayBuffer().catch(() => null);
    throw r.status === 429 ? err429('Upstream is rate limiting source resolution') : err502('source resolve ' + r.status);
  }
  const j = await r.json().catch(() => ({}));
  if (!j.launch_url) throw err502('launch url missing from resolve response');

  // launch_url 302s straight to the provider player (needs the session cookie jar)
  const launch = await wt(j.launch_url, { jar: s.jar, redirect: 'manual' });
  let url = null;
  if (launch.status >= 300 && launch.status < 400) {
    const loc = launch.headers.get('location');
    if (loc) {
      try { url = new URL(loc, j.launch_url).toString(); } catch { url = null; }
    }
    await launch.arrayBuffer().catch(() => null);
  } else if (launch.ok) {
    const body = await launch.text();
    const m = body.match(/(?:url|location)\s*=\s*['"]?(https?:\/\/[^'"\s>]+)/i)
      || body.match(/http-equiv="refresh"[^>]+url=(https?:\/\/[^'">]+)/i);
    if (m) url = decodeEnt(m[1]);
  }
  if (!url) throw err502('No embeddable URL found for this server');
  if (!safeEmbedUrl(url, reqHost)) throw err502('Blocked unsafe embed target');

  // Verify the player will actually accept being framed (browser sends no referrer,
  // because the player iframe uses referrerpolicy="no-referrer").
  let probe = await wt(url, { redirect: 'manual', timeout: 15000 });
  if (probe.status === 429) {
    await sleep(900);
    probe = await wt(url, { redirect: 'manual', timeout: 15000 });
  }
  await probe.arrayBuffer().catch(() => null);
  if (probe.status >= 400) throw err502(`Server responded ${probe.status} — try another server`);
  const xfo = (probe.headers.get('x-frame-options') || '').toLowerCase();
  if (xfo.includes('sameorigin') || xfo.includes('deny')) {
    throw err502('This server does not allow embedding — try another server');
  }
  const csp = probe.headers.get('content-security-policy') || '';
  const fa = csp.match(/frame-ancestors([^;]*)/i);
  if (fa && !/\*/.test(fa[1] || '')) {
    const own = String(reqHost || '').toLowerCase().split(':')[0];
    if (!own || !(fa[1] || '').toLowerCase().includes(own)) {
      throw err502('This server does not allow embedding — try another server');
    }
  }

  const out = {
    url,
    sandbox: 'allow-scripts allow-same-origin allow-presentation allow-forms allow-orientation-lock',
    referrerPolicy: 'no-referrer'
  };
  return cacheSet(key, out, TTL.embed);
}

/* ---------------- API Handlers ---------------- */
async function apiHome() {
  const hit = cacheGet('home');
  if (hit) return hit;
  const res = await wt(BASE + '/');
  if (!res.ok) throw Object.assign(new Error('home ' + res.status), { code: 502 });
  const html = await res.text();
  const sections = parseSections(html);
  let hero = parseHero(html);
  if (!hero.length) {
    hero = sections.flatMap((s) => s.items).filter((x) => x.poster).slice(0, 6).map((x) => ({
      kind: x.kind,
      slug: x.slug,
      ep: x.ep || null,
      href: x.href,
      title: x.title,
      banner: x.poster,
      poster: x.poster,
      meta: x.rating ? '★ ' + x.rating : '',
      description: ''
    }));
  }
  const out = { sections, hero };
  return cacheSet('home', out, TTL.home);
}

async function apiSearch(q) {
  const key = 'search:' + q.toLowerCase();
  const hit = cacheGet(key);
  if (hit) return hit;
  const res = await wt(`${BASE}/search.php?keywords=${encodeURIComponent(q)}`);
  if (!res.ok) throw Object.assign(new Error('search ' + res.status), { code: 502 });
  const html = await res.text();
  const items = parseCards(html);
  const seen = new Set();
  const uniq = items.filter((x) => {
    const k = x.kind + '/' + (x.slug || x.href);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return cacheSet(key, { items: uniq.slice(0, 30) }, TTL.search);
}

function seriesDetail(idx, slug, kind) {
  return {
    slug,
    kind: kind || 'anime',
    url: idx.url,
    title: idx.title,
    altTitle: null,
    description: idx.description || '',
    poster: idx.poster || '',
    banner: idx.poster || '',
    genres: idx.genres || [],
    year: idx.year || null,
    episodesCount: idx.episodes.length,
    studio: idx.studio || null,
    country: null,
    episodes: idx.episodes
  };
}

async function apiAnime(slug, kind) {
  const key = 'anime:' + (kind || 'anime') + '/' + slug;
  const hit = cacheGet(key);
  if (hit) return hit;

  let out = null;

  if (VID_RX.test(slug)) {
    const info = await vidInfo(slug);
    if (info && info.seriesSlug && kind !== 'movie') {
      // an episode video → serve its series with the full episode index
      const idx = await episodeIndex(info.seriesSlug);
      out = seriesDetail(idx, slug, kind || 'anime');
    } else if (info) {
      // standalone movie / special → single-entry detail
      out = {
        slug,
        kind: kind === 'movie' ? 'movie' : (kind || 'anime'),
        url: info.url,
        title: info.title,
        altTitle: null,
        description: info.description || '',
        poster: info.poster || '',
        banner: info.poster || '',
        genres: info.genres || [],
        year: info.year || null,
        episodesCount: 1,
        studio: null,
        country: null,
        episodes: [{ n: 1, slug, url: info.url, label: 'Full Movie' }]
      };
    }
    // info === null → not a video id (hex-looking series slug) → series path below
  }

  if (!out) {
    const idx = await episodeIndex(slug);
    out = seriesDetail(idx, slug, kind || 'anime');
  }

  return cacheSet(key, out, TTL.anime);
}

async function apiServers(slug, ep) {
  const key = 'srv:' + slug + ':' + ep;
  const hit = cacheGet(key);
  if (hit) return hit;
  const s = await sessionFor(slug, ep);
  const servers = listServers(s.sources);
  return cacheSet(key, { slug, ep, servers }, TTL.session);
}

/* ---------------- Static File & Compression ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon'
};

const staticCache = new Map();

function getStaticFile(fullPath) {
  try {
    const stats = fs.statSync(fullPath);
    const hit = staticCache.get(fullPath);
    if (hit && hit.mtime === stats.mtimeMs) return hit;

    const raw = fs.readFileSync(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const etag = '"' + crypto.createHash('md5').update(raw).digest('hex') + '"';
    const isCompressible = /text|javascript|json|svg/.test(type);
    const gzip = isCompressible && raw.length > 256 ? zlib.gzipSync(raw, { level: 6 }) : null;

    const entry = { raw, gzip, type, etag, mtime: stats.mtimeMs };
    staticCache.set(fullPath, entry);
    return entry;
  } catch {
    return null;
  }
}

function sendData(req, res, code, payload, type = 'application/json; charset=utf-8', cache = 'no-store') {
  const isJson = type.startsWith('application/json');
  const body = isJson ? JSON.stringify(payload) : payload;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const accept = (req.headers && req.headers['accept-encoding']) || '';
  const headers = {
    'content-type': type,
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
    'access-control-allow-origin': '*'
  };

  if (accept.includes('gzip') && buf.length > 380) {
    headers['content-encoding'] = 'gzip';
    const compressed = zlib.gzipSync(buf, { level: 6 });
    headers['content-length'] = compressed.length;
    res.writeHead(code, headers);
    res.end(compressed);
  } else {
    headers['content-length'] = buf.length;
    res.writeHead(code, headers);
    res.end(buf);
  }
}

function fail(res, err) {
  const code = err && err.code && Number(err.code) >= 400 && Number(err.code) < 600 ? Number(err.code) : 502;
  console.error('[API Error]', err && err.message);
  sendData({ headers: {} }, res, code, { error: (err && err.message) || 'Upstream service error' });
}

/* ---------------- Request Handler ---------------- */
async function handleRequest(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  try {
    /* API Endpoints */
    if (p.startsWith('/api/')) {
      if (p === '/api/health') {
        return sendData(req, res, 200, { ok: true, timestamp: Date.now(), cachedItems: store.size, path: p });
      }

      /* Diagnostic: reveals what the upstream actually returns from this platform
         (status, CDN headers, challenge page) plus this function's egress IP. */
      if (p === '/api/probe') {
        const attempts = [
          { name: 'browser UA', headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } },
          { name: 'no UA', headers: {} },
          { name: 'curl UA', headers: { 'user-agent': 'curl/8.4.0' } }
        ];
        const results = [];
        for (const a of attempts) {
          try {
            const r = await fetch(BASE + '/', { headers: a.headers, redirect: 'manual', signal: AbortSignal.timeout(20000) });
            const body = await r.text();
            results.push({
              name: a.name,
              status: r.status,
              server: r.headers.get('server'),
              cfRay: r.headers.get('cf-ray'),
              cfMitigated: r.headers.get('cf-mitigated'),
              contentType: r.headers.get('content-type'),
              title: (body.match(/<title[^>]*>([^<]*)/i) || [])[1] || null,
              bodyHead: body.replace(/\s+/g, ' ').slice(0, 260)
            });
          } catch (e) {
            results.push({ name: a.name, error: e.message });
          }
        }
        let egressIp = null;
        try {
          const ipRes = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(10000) });
          egressIp = (await ipRes.json()).ip;
        } catch { /* non-fatal */ }
        return sendData(req, res, 200, { base: BASE, node: process.version, egressIp, results }, 'application/json; charset=utf-8', 'no-store');
      }

      if (p === '/api/home') {
        return sendData(req, res, 200, await apiHome(), 'application/json; charset=utf-8', 'public, max-age=60');
      }

      if (p === '/api/search') {
        const q = (u.searchParams.get('q') || '').trim();
        if (q.length < 2) return sendData(req, res, 400, { error: 'Search query must be at least 2 characters' });
        return sendData(req, res, 200, await apiSearch(q), 'application/json; charset=utf-8', 'public, max-age=120');
      }

      let m = p.match(/^\/api\/anime\/([^/]+)$/);
      if (m) {
        const slug = decodeURIComponent(m[1]);
        const kind = u.searchParams.get('kind') || 'anime';
        return sendData(req, res, 200, await apiAnime(slug, kind), 'application/json; charset=utf-8', 'public, max-age=180');
      }

      m = p.match(/^\/api\/servers\/([^/]+)\/(\d+)$/);
      if (m) {
        const slug = decodeURIComponent(m[1]);
        const ep = Number(m[2]);
        return sendData(req, res, 200, await apiServers(slug, ep), 'application/json; charset=utf-8', 'public, max-age=180');
      }

      m = p.match(/^\/api\/embed\/([^/]+)\/(\d+)$/);
      if (m) {
        const token = u.searchParams.get('token') || '';
        if (!TOKEN_RX.test(token)) return sendData(req, res, 400, { error: 'Invalid server token' });
        return sendData(req, res, 200, await resolveEmbed(decodeURIComponent(m[1]), Number(m[2]), token, req.headers.host), 'application/json; charset=utf-8', 'public, max-age=300');
      }

      if (p === '/api/image') {
        const imgUrl = u.searchParams.get('url') || '';
        let pu = null;
        try { pu = new URL(imgUrl); } catch { pu = null; }
        if (!pu || pu.protocol !== 'https:') return sendData(req, res, 400, { error: 'Invalid image URL' });
        const isUpstream = imgUrl.startsWith(IMAGE_BASE + '/');

        const cacheKey = 'img:' + imgUrl;
        const hit = cacheGet(cacheKey);
        if (hit) {
          res.writeHead(200, {
            'content-type': hit.type,
            'cache-control': 'public, max-age=604800, immutable',
            'content-length': hit.buf.length
          });
          return res.end(hit.buf);
        }

        // Upstream: fetch directly. Everything else goes through public mirrors
        // (imgur throttles hotlinking from our IP; mirrors serve the same bytes).
        const attempts = isUpstream
          ? [{ url: imgUrl, headers: { 'user-agent': UA, referer: BASE + '/' } }]
          : [
              { url: 'https://images.weserv.nl/?url=' + encodeURIComponent(imgUrl), headers: { accept: 'image/*,*/*' } },
              { url: 'https://web.archive.org/web/0id_/' + imgUrl, headers: { accept: 'image/*,*/*' } },
              { url: 'https://external-content.duckduckgo.com/iu/?u=' + encodeURIComponent(imgUrl), headers: { accept: 'image/*,*/*' } }
            ];

        const grab = async (a) => {
          try {
            const r = await fetch(a.url, { headers: a.headers, redirect: 'follow', signal: AbortSignal.timeout(20000) });
            if (!r.ok) return null;
            const b = Buffer.from(await r.arrayBuffer());
            if (!b.length) return null;
            const ct = (r.headers.get('content-type') || '').split(';')[0].trim();
            if (ct && !/^(image\/|application\/octet-stream)/.test(ct)) return null;
            return { buf: b, type: ct || 'image/jpeg' };
          } catch { return null; }
        };

        let got = null;
        for (const a of attempts) {
          got = await grab(a);
          if (got) break;
        }
        if (!got) return sendData(req, res, 502, { error: 'Image source unavailable' });

        cacheSet(cacheKey, got, 24 * 60 * 60e3);
        res.writeHead(200, {
          'content-type': got.type,
          'cache-control': 'public, max-age=604800, immutable',
          'content-length': got.buf.length
        });
        return res.end(got.buf);
      }

      return sendData(req, res, 404, { error: 'Not found' });
    }

    /* Static files (+ SPA routing fallback) */
    let filePath = p === '/' ? '/index.html' : p;
    filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
    let full = path.join(ROOT, filePath);

    if (!full.startsWith(ROOT)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    let fileEntry = getStaticFile(full);

    // If file doesn't exist and there's no extension, route to index.html (SPA)
    if (!fileEntry) {
      if (!path.extname(p)) {
        full = path.join(ROOT, 'index.html');
        fileEntry = getStaticFile(full);
      }
    }

    if (!fileEntry) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }

    // Conditional ETag check
    const reqEtag = req.headers['if-none-match'];
    if (reqEtag && reqEtag === fileEntry.etag) {
      res.writeHead(304, {
        'etag': fileEntry.etag,
        'cache-control': 'no-cache, must-revalidate'
      });
      return res.end();
    }

    const accept = req.headers['accept-encoding'] || '';
    const headers = {
      'content-type': fileEntry.type,
      'etag': fileEntry.etag,
      'cache-control': 'no-cache, must-revalidate',
      'x-content-type-options': 'nosniff'
    };

    if (fileEntry.gzip && accept.includes('gzip')) {
      headers['content-encoding'] = 'gzip';
      headers['content-length'] = fileEntry.gzip.length;
      res.writeHead(200, headers);
      res.end(fileEntry.gzip);
    } else {
      headers['content-length'] = fileEntry.raw.length;
      res.writeHead(200, headers);
      res.end(fileEntry.raw);
    }
  } catch (err) {
    fail(res, err);
  }
}

/* ---------------- HTTP Server ---------------- */
const server = http.createServer((req, res) => {
  Promise.resolve(handleRequest(req, res)).catch((err) => {
    console.error('[Unhandled]', err && err.stack);
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });
});

if (require.main === module) {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Error] Port ${PORT} is already in use by another process.`);
      console.error(`Please close any existing process on port ${PORT} or run: node server.js ${PORT + 1}`);
      process.exit(1);
    } else {
      console.error('[Server Error]', err);
    }
  });

  server.listen(PORT, () => {
    console.log(`AnimeWit running with high performance → http://localhost:${PORT}`);
  });
}

/* Vercel loads this module as the function entry and requires the default export to be
   a function or an http.Server. Export the handler itself as the default, and hang the
   named exports off it (functions are objects, so both styles keep working). */
module.exports = handleRequest;
module.exports.default = handleRequest;
module.exports.handleRequest = handleRequest;
module.exports.server = server;
module.exports.apiHome = apiHome;
module.exports.apiSearch = apiSearch;
module.exports.apiAnime = apiAnime;
module.exports.apiServers = apiServers;
module.exports.resolveEmbed = resolveEmbed;
/* exposed for offline parsing tests */
module.exports.parseCards = parseCards;
module.exports.parseHero = parseHero;
module.exports.parseSections = parseSections;
module.exports.parseSeriesPage = parseSeriesPage;
module.exports.parseSeasonPage = parseSeasonPage;
