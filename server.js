#!/usr/bin/env node
/* =========================================================================
   AnimeWit Backend — High-Performance Static Server + witanime.site Proxy
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
const BASE = 'https://witanime.site';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const ROOT = __dirname;
const TTL = {
  home: 3 * 60e3,       // 3 min
  search: 5 * 60e3,     // 5 min
  anime: 10 * 60e3,     // 10 min
  session: 12 * 60e3,   // 12 min
  embed: 15 * 60e3      // 15 min
};
const MAX_REQ_PER_MIN = Number(process.env.UPSTREAM_RPM) || 18; // safe rate limit for upstream witanime
const MAX_QUEUE_WAIT = Number(process.env.UPSTREAM_MAX_WAIT_MS) || 5000; // never stall a request past this (serverless timeouts)

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
async function wt(url, { jar, method = 'GET', headers = {}, redirect = 'follow', timeout = 25000 } = {}) {
  await waitForSlot();
  const h = {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'ar,en;q=0.9,en-US;q=0.8',
    ...headers
  };
  if (jar && jar.size) h.cookie = jar.header();
  const res = await fetch(url, { method, headers: h, redirect, signal: AbortSignal.timeout(timeout) });
  if (jar) jar.absorb(res);
  return res;
}

/* ---------------- HTML Parse Helpers ---------------- */
const decodeEnt = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));

const stripTags = (s) => decodeEnt(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function extractCsrf(html) {
  const m = html.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/)
    || html.match(/<meta[^>]+content="([^"]+)"[^>]+name="csrf-token"/);
  return m ? m[1] : null;
}

function absUrl(u) {
  if (!u) return '';
  if (u.startsWith('http')) return u;
  if (u.startsWith('//')) return 'https:' + u;
  return BASE + (u.startsWith('/') ? u : '/' + u);
}

/* Extract anime/episode cards from HTML chunks */
function parseCards(html) {
  const out = [];
  const re = /<a\b([^>]*href="([^"]*witanime\.site\/(watch|anime|movie)\/([^"]+))"[^>]*)>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const openTag = m[1];
    const href = m[2];
    const kind = m[3];
    const seg = m[4];
    const body = m[5];
    if (!/posters\//.test(body) && !/banners\//.test(body)) continue;

    const poster = (body.match(/<img[^>]+src="([^"]*\/posters\/[^"]+)"/) || [])[1];
    const banner = (body.match(/<img[^>]+src="([^"]*\/banners\/[^"]+)"/) || [])[1];
    const alt = (body.match(/<img[^>]+alt="([^"]*)"/) || [])[1];
    const h3 = (body.match(/<h3[^>]*>([\s\S]*?)<\/h3>/) || [])[1];
    const span = (body.match(/<span[^>]*dir="ltr"[^>]*class="[^"]*(?:truncate|block)[^"]*"[^>]*>([\s\S]*?)<\/span>/) || [])[1];
    const openTitle = (openTag.match(/\btitle="([^"]+)"/) || [])[1];
    const rating = (body.match(/<\/svg>\s*([\d]{1,2}\.[\d])\s*<\/span>/) || [])[1];
    const typeBadge = (body.match(/class="[^"]*(?:rounded-md|rounded-lg)[^"]*"[^>]*>\s*([^<>{}\n]{2,18})\s*</) || [])[1];

    const title = stripTags(alt) || stripTags(h3) || stripTags(span) || stripTags(openTitle) || '';
    if (!title) continue;

    const card = {
      kind,
      href: absUrl(href),
      poster: absUrl(poster),
      banner: absUrl(banner),
      title,
      rating: rating || null
    };

    if (kind === 'watch') {
      const parts = seg.split('/');
      card.slug = parts[0];
      card.ep = Number(parts[1]) || null;
      const label = stripTags((body.match(/<div[^>]*>\s*((?:الحلقة|حلقة)[^<]*)<\/div>/) || [])[1]);
      card.label = label || null;
      card.type = 'Episode';
    } else {
      card.slug = seg.split('/')[0];
      card.type = stripTags(typeBadge) || (kind === 'movie' ? 'Movie' : 'TV');
    }
    out.push(card);
  }
  return out;
}

/* Parse Hero slider from homepage */
function parseHero(html) {
  const out = [];
  const re = /<img[^>]+src="([^"]*\/banners\/[^"]+)"[^>]*>/g;
  let bm;
  while ((bm = re.exec(html))) {
    const after = html.slice(bm.index, bm.index + 9500);
    const hIdx = after.indexOf('<h2');
    if (hIdx < 0 || hIdx > 4500) continue;
    const hEnd = after.indexOf('</h2>', hIdx);
    if (hEnd < 0) continue;
    const hTag = after.slice(hIdx, hEnd);
    const titleAttr = (hTag.match(/title="([^"]+)"/) || [])[1];
    const link = hTag.match(/href="(https?:\/\/witanime\.site\/(anime|movie|watch)\/([^"]+))"/);
    if (!titleAttr || !link) continue;
    const tail = after.slice(hEnd + 5, hEnd + 5200);
    const meta = stripTags((tail.match(/<div[^>]*text-neutral-300[^>]*>([\s\S]*?)<\/div>/) || [])[1]);
    const desc = stripTags((tail.match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1]).slice(0, 320);

    const kind = link[2];
    const seg = link[3];
    let ep = null;
    let slug = seg;
    if (kind === 'watch') {
      const parts = seg.split('/');
      slug = parts[0];
      ep = Number(parts[1]) || 1;
    }

    out.push({
      kind,
      slug,
      ep,
      href: absUrl(link[1]),
      title: stripTags(titleAttr),
      banner: absUrl(bm[1]),
      meta,
      description: desc
    });
    if (out.length >= 8) break;
  }
  return out;
}

/* Split page by <h2> into titled sections */
function parseSections(html) {
  const chunks = html.split(/<h2\b/);
  const sections = [];
  const KEY_MAP = [
    [/الأكثر\s+مشاهدة/, 'trending', 'Trending Anime'],
    [/أحدث\s+الحلقات/, 'latest', 'Latest Episodes'],
    [/أحدث\s+الأفلام/, 'movies', 'Latest Movies'],
    [/أنميات\s+قادمة/, 'upcoming', 'Upcoming Anime'],
    [/أكثر\s+الأنميات\s+مشاهدة/, 'top', 'Top Rated Anime'],
    [/أكثر\s+الأفلام\s+مشاهدة/, 'topMovies', 'Top Movies'],
    [/أشهر\s+أنميات\s+الموسم/, 'seasonal', 'Popular This Season'],
    [/تابع\s+المشاهدة/, 'continue', 'Continue Watching']
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
      if (re.test(title)) {
        key = k;
        enTitle = en;
        break;
      }
    }
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

/* Parse episodes from anime detail page */
function parseEpisodes(html, slug) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href="([^"]*witanime\.site\/watch\/([^"/]+)\/(\d+))"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const watchSlug = m[2];
    if (slug && watchSlug !== slug && !watchSlug.includes(slug) && !slug.includes(watchSlug)) continue;
    const ep = Number(m[3]);
    if (seen.has(ep)) continue;
    seen.add(ep);
    const label = stripTags(m[4]);
    out.push({ n: ep, url: absUrl(m[1]), slug: watchSlug, label: label || `Episode ${ep}` });
  }
  out.sort((a, b) => a.n - b.n);
  return out;
}

/* ---------------- Playback Session ---------------- */
const sessions = new Map(); // "slug:ep" -> {jar, csrf, manifest, exp}

async function buildSession(slug, ep) {
  const key = slug + ':' + ep;
  const cached = sessions.get(key);
  if (cached && Date.now() < cached.exp) return cached;

  const watchUrl = `${BASE}/watch/${slug}/${ep}`;
  const jar = new Jar();
  const pageRes = await wt(watchUrl, { jar });
  if (!pageRes.ok) throw Object.assign(new Error('watch page ' + pageRes.status), { code: pageRes.status });
  const html = await pageRes.text();
  const csrf = extractCsrf(html);
  if (!csrf) throw Object.assign(new Error('csrf not found on watch page'), { code: 502 });

  const srcRes = await wt(watchUrl + '/sources', {
    jar, method: 'POST',
    headers: {
      'X-CSRF-TOKEN': csrf,
      accept: 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      referer: watchUrl,
      origin: BASE
    }
  });
  if (!srcRes.ok) throw Object.assign(new Error('sources error ' + srcRes.status), { code: srcRes.status === 429 ? 429 : 502 });
  const manifest = await srcRes.json();

  const rec = { jar, csrf, manifest, watchUrl, exp: Date.now() + TTL.session };
  sessions.set(key, rec);
  if (sessions.size > 80) {
    for (const [k, v] of sessions) if (Date.now() > v.exp) sessions.delete(k);
  }
  return rec;
}

function listServers(manifest) {
  const out = [];
  const push = (group, quality) => {
    const arr = (manifest && manifest[group] && manifest[group][quality]) || [];
    for (const s of arr) {
      out.push({
        quality,
        host: s.label || 'server',
        version: s.version || 'sub',
        lang: s.lang || 'jp',
        token: s.token,
        kind: group
      });
    }
  };
  for (const q of Object.keys((manifest && manifest.players) || {})) push('players', q);
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

  const s = await buildSession(slug, ep);

  const resSrc = await wt(`${BASE}/watch/stream-source/${token}`, {
    jar: s.jar, method: 'POST',
    headers: {
      'X-CSRF-TOKEN': s.csrf,
      accept: 'application/json',
      'x-requested-with': 'XMLHttpRequest',
      referer: s.watchUrl,
      origin: BASE
    }
  });
  if (!resSrc.ok) throw Object.assign(new Error('stream-source ' + resSrc.status), { code: resSrc.status === 429 ? 429 : 502 });
  const cfg = await resSrc.json().catch(() => ({}));

  const resGate = await wt(`${BASE}/watch/stream-gate/${token}`, {
    jar: s.jar, headers: { referer: s.watchUrl }, redirect: 'manual'
  });

  let url = null;
  if (resGate.status >= 300 && resGate.status < 400) {
    url = resGate.headers.get('location');
    await resGate.arrayBuffer().catch(() => null);
  } else if (resGate.ok) {
    const body = await resGate.text();
    const m = body.match(/url=['"]?([^'"\s>]+)/) || body.match(/http[^'"\s<>]+/);
    url = m ? m[1] : null;
  }
  if (!url) throw Object.assign(new Error('no embed url found'), { code: 502 });
  if (!safeEmbedUrl(url, reqHost)) throw Object.assign(new Error('blocked unsafe embed target'), { code: 502 });

  const out = {
    url,
    sandbox: cfg.sandbox || 'allow-scripts allow-same-origin allow-presentation allow-forms allow-orientation-lock',
    referrerPolicy: cfg.referrerPolicy || 'no-referrer'
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
  if (!hero.length) hero = sections.flatMap((s) => s.items).filter((x) => x.banner).slice(0, 6);
  const out = { sections, hero };
  return cacheSet('home', out, TTL.home);
}

async function apiSearch(q) {
  const key = 'search:' + q.toLowerCase();
  const hit = cacheGet(key);
  if (hit) return hit;
  const res = await wt(`${BASE}/search?q=${encodeURIComponent(q)}`);
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

async function apiAnime(slug, kind) {
  const key = 'anime:' + (kind || 'anime') + '/' + slug;
  const hit = cacheGet(key);
  if (hit) return hit;
  const url = `${BASE}/${kind || 'anime'}/${slug}`;
  const res = await wt(url);
  if (!res.ok) throw Object.assign(new Error('anime ' + res.status), { code: res.status === 404 ? 404 : 502 });
  const html = await res.text();
  const ld = parseJsonLd(html) || {};
  const og = (p) => (html.match(new RegExp(`<meta[^>]+property="og:${p}"[^>]+content="([^"]*)"`, 'i')) || [])[1]
    || (html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+property="og:${p}"`, 'i')) || [])[1];

  const episodes = parseEpisodes(html, slug);
  const poster = absUrl(ld.image || og('image') || '');
  const genres = Array.isArray(ld.genre) ? ld.genre : (ld.genre ? [ld.genre] : []);

  const out = {
    slug,
    kind: kind || 'anime',
    url: absUrl(ld.url || og('url') || url),
    title: ld.name || og('title') || slug.replace(/-/g, ' '),
    altTitle: ld.alternateName || null,
    description: ld.description || og('description') || '',
    poster,
    banner: poster,
    genres,
    year: ld.startDate || null,
    episodesCount: ld.numberOfEpisodes || episodes.length || null,
    studio: ld.productionCompany && ld.productionCompany.name ? ld.productionCompany.name : null,
    country: ld.countryOfOrigin && ld.countryOfOrigin.name ? ld.countryOfOrigin.name : null,
    episodes
  };
  return cacheSet(key, out, TTL.anime);
}

async function apiServers(slug, ep) {
  const key = 'srv:' + slug + ':' + ep;
  const hit = cacheGet(key);
  if (hit) return hit;
  const s = await buildSession(slug, ep);
  const servers = listServers(s.manifest);
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

/* ---------------- HTTP Server ---------------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  try {
    /* API Endpoints */
    if (p.startsWith('/api/')) {
      if (p === '/api/health') {
        return sendData(req, res, 200, { ok: true, timestamp: Date.now(), cachedItems: store.size });
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
        if (!/^[a-f0-9]{64}$/.test(token)) return sendData(req, res, 400, { error: 'Invalid server token' });
        return sendData(req, res, 200, await resolveEmbed(decodeURIComponent(m[1]), Number(m[2]), token, req.headers.host), 'application/json; charset=utf-8', 'public, max-age=300');
      }

      if (p === '/api/image') {
        const imgUrl = u.searchParams.get('url') || '';
        if (!imgUrl.startsWith('https://images.witanime.site/')) {
          return sendData(req, res, 400, { error: 'Invalid image URL' });
        }
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
        const imgRes = await fetch(imgUrl, {
          headers: {
            'user-agent': UA,
            'referer': 'https://witanime.site/'
          }
        });
        if (!imgRes.ok) return sendData(req, res, imgRes.status, { error: 'Failed to proxy image' });
        const buf = Buffer.from(await imgRes.arrayBuffer());
        const type = imgRes.headers.get('content-type') || 'image/jpeg';
        cacheSet(cacheKey, { buf, type }, 24 * 60 * 60e3);
        res.writeHead(200, {
          'content-type': type,
          'cache-control': 'public, max-age=604800, immutable',
          'content-length': buf.length
        });
        return res.end(buf);
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

module.exports = { server, apiHome, apiSearch, apiAnime, apiServers, resolveEmbed };
