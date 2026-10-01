'use strict';
/* Catalog + playback for witanime.site (Laravel blade + Alpine player):
   session (cookies/CSRF) → episode index → source manifest → embed resolution. */
const { BASE, TTL, UA } = require('./config');
const { cacheGet, cacheSet } = require('./cache');
const { wt, Jar } = require('./upstream');
const { err404, err429, err502, sleep, decodeEnt } = require('./util');
const { parseSeriesPage, parseEpisodes, parseRelated } = require('./parsers');

/* ---------------- Upstream session (session cookie + CSRF token) ----------------
   Every state call on witanime needs the session pair: the 64-hex source tokens
   are minted and redeemed inside one session, and the gate only answers to it. */
let sess = null;
let sessP = null;

async function ensureSession(force = false) {
  if (!force && sess && Date.now() - sess.at < 45 * 60e3) return sess;
  if (sessP && !force) return sessP;
  sessP = (async () => {
    try {
      const jar = new Jar();
      const res = await wt(BASE + '/', { jar });
      const html = await res.text().catch(() => '');
      const m = html.match(/name="csrf-token"\s+content="([^"]+)"/);
      if (!res.ok || !m) throw err502('Upstream session could not be established');
      /* HTML that arrived without a session cookie (the cookie-less reader
         fallback, or a browser leg that could not clear the challenge) can
         never back the player's CSRF POSTs — say so instead of letting every
         one of them come back 419. */
      if (!jar.size) throw err502('Streaming needs the browser leg: this network is challenged and no session cookie was issued — the in-function headless browser could not clear the Cloudflare challenge (check UPSTREAM_BROWSER / function logs)');
      sess = { jar, csrf: m[1], at: Date.now(), visited: new Set() };
      return sess;
    } finally {
      sessP = null;
    }
  })();
  return sessP;
}

/* The source manifest only populates for episodes this session has opened:
   GET the watch page once per path, then POST is allowed to list players. */
async function ensureVisited(s, wpath) {
  if (s.visited.has(wpath)) return;
  const page = await wt(BASE + wpath, { jar: s.jar, headers: { accept: 'text/html,application/xhtml+xml' } });
  if (page.ok) s.visited.add(wpath);
  await page.arrayBuffer().catch(() => null);
}

function postWith(s, url, referer) {
  return wt(url, {
    jar: s.jar,
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'x-csrf-token': s.csrf,
      origin: BASE,
      referer: referer || BASE + '/',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin'
    }
  });
}

/* ---------------- Episode index (/anime/{slug} → flat episode list) ---------------- */
async function episodeIndex(slug, kind) {
  const key = 'idx:' + slug;
  const hit = cacheGet(key);
  if (hit) return hit;

  const tries = kind === 'movie' ? ['/movie/', '/anime/'] : ['/anime/', '/movie/'];
  let html = null;
  let pageUrl = null;
  let status = 0;
  for (const p of tries) {
    const res = await wt(BASE + p + slug);
    status = res.status;
    if (res.ok) {
      html = await res.text();
      pageUrl = BASE + p + slug;
      break;
    }
    await res.arrayBuffer().catch(() => null);
    if (res.status !== 404) break; // only fall through on "not found"
  }
  if (!html) throw status === 404 ? err404('Series not found: ' + slug) : err502('series page ' + status);

  const meta = parseSeriesPage(html, slug);
  const raw = parseEpisodes(html, slug);
  if (!raw.length) throw err404('No episodes found for: ' + slug);
  const related = parseRelated(html, slug);

  const isMovie = raw.length === 1 && !!raw[0].movie;
  const episodes = raw.map((e) => ({
    n: e.n,
    slug,
    url: BASE + e.wpath,
    label: isMovie ? 'Full Movie' : 'الحلقة ' + e.n
  }));

  const idx = Object.assign({}, meta, {
    url: pageUrl,
    kind: isMovie ? 'movie' : 'anime',
    related,
    episodes,
    byN: new Map(raw.map((e) => [e.n, e.wpath]))
  });
  return cacheSet(key, idx, TTL.index);
}

/* ---------------- Source manifest (visit watch page → POST {path}/sources) ---------------- */
async function sourcesManifest(wpath) {
  const visitPost = async (s) => {
    await ensureVisited(s, wpath);
    return postWith(s, BASE + wpath + '/sources', BASE + wpath);
  };
  let s = await ensureSession();
  let res = await visitPost(s);
  if (res.status === 419 || res.status === 403) {
    await res.arrayBuffer().catch(() => null);
    s = await ensureSession(true);
    res = await visitPost(s);
  }
  if (res.status === 404) {
    await res.arrayBuffer().catch(() => null);
    throw err404('Episode not found: ' + wpath);
  }
  if (res.status === 429) throw err429('Upstream is rate limiting source resolution');
  if (!res.ok) throw err502('sources manifest ' + res.status);
  const j = await res.json().catch(() => null);
  if (!j || typeof j !== 'object') throw err502('sources manifest payload invalid');
  return j;
}

/* Manifest → our server list. Groups are quality tiers (FHD/HD/…); the same
   host can appear under several tiers, which the client renders as its
   quality switch + per-quality server rows. */
function listServers(manifest) {
  const out = [];
  const players = (manifest && manifest.players) || {};
  for (const [quality, arr] of Object.entries(players)) {
    for (const s of arr || []) {
      if (!s || !s.token) continue;
      out.push({
        quality,
        host: s.label || 'Server',
        version: s.version === 'dub' ? 'Dub' : 'Sub',
        lang: s.lang || 'jp',
        token: s.token,
        kind: 'embedded_web'
      });
    }
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

/* ---------------- Embed resolution ----------------
   token → POST /watch/stream-source/{token}  → {sandbox, referrerPolicy}
         → GET  /watch/stream-gate/{token}    → 302 to the real provider player */
async function resolveEmbed(slug, ep, token, reqHost, force = false) {
  const key = 'emb:' + slug + ':' + ep + ':' + token;
  if (!force) {
    const hit = cacheGet(key);
    if (hit) return hit;
  }

  const idx = await episodeIndex(slug);
  const wpath = idx.byN.get(Number(ep));
  if (!wpath) throw err404('Episode not found: ' + slug + '/' + ep);

  const s = await ensureSession();
  await ensureVisited(s, wpath); // token redemption needs the page in-session
  const watchUrl = BASE + wpath;

  // 1) redeem the source token (marks it ready for the gate)
  let r = await postWith(s, BASE + '/watch/stream-source/' + token, watchUrl);
  if (r.status === 419 || r.status === 403) {
    await r.arrayBuffer().catch(() => null);
    throw err502('Server session expired — pick the server again');
  }
  if (r.status === 404) {
    await r.arrayBuffer().catch(() => null);
    throw err502('Server list expired — pick the server again');
  }
  if (r.status === 429) {
    await r.arrayBuffer().catch(() => null);
    await sleep(900);
    r = await postWith(s, BASE + '/watch/stream-source/' + token, watchUrl);
    if (!r.ok) throw err429('Upstream is rate limiting source resolution');
  }
  if (!r.ok) throw err502('source resolve ' + r.status);
  const j = await r.json().catch(() => ({}));

  // 2) gate redirects to the provider player (Location keeps the #fragment).
  //    The gate 404s anything whose Sec-Fetch-Dest isn't iframe, and a page's
  //    fetch() can only send empty — so the browser leg loads it in an iframe.
  const gateUrl = BASE + '/watch/stream-gate/' + token;
  let g = await wt(gateUrl, {
    jar: s.jar,
    redirect: 'manual',
    fetchDest: 'iframe',
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      referer: watchUrl,
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-dest': 'iframe',
      'upgrade-insecure-requests': '1'
    }
  });
  let url = null;
  if (g.status >= 300 && g.status < 400) {
    const loc = g.headers.get('location');
    if (loc) {
      try { url = new URL(loc, gateUrl).toString(); } catch { url = null; }
    }
    await g.arrayBuffer().catch(() => null);
  } else if (g.ok) {
    const body = await g.text();
    const mm = body.match(/url=(https?:\/\/[^"'>]+)/i)
      || body.match(/location(?:\.href)?\s*=\s*['"](https?:\/\/[^'"]+)['"]/i);
    if (mm) url = decodeEnt(mm[1]);
  } else if (g.status === 429) {
    await g.arrayBuffer().catch(() => null);
    throw err429('Upstream is rate limiting source resolution');
  } else {
    await g.arrayBuffer().catch(() => null);
  }
  if (!url) throw err502('No embeddable URL found for this server');
  if (!safeEmbedUrl(url, reqHost)) throw err502('Blocked unsafe embed target');

  // 3) verify the provider will actually accept being framed (no cookie jar —
  //    mirrors the anonymous browser load; follow redirects so bad sessions
  //    that bounce to unframeable pages are caught here, not by the user)
  const UNFRAMEABLE_HOST = /(^|\.)google\.[a-z.]+$/i;
  let probe = await wt(url, { redirect: 'follow', timeout: 15000 });
  if (probe.status === 429) {
    await sleep(900);
    probe = await wt(url, { redirect: 'follow', timeout: 15000 });
  }
  const probeBody = await probe.text().catch(() => '');
  if (probe.status >= 400) throw err502(`Server responded ${probe.status} — try another server`);
  let finalUrl = String(probe.url || url);
  // fetch's response.url drops URL fragments, but hash-based players encode the
  // video id in location.hash (#abc) — restore it or the player boots with an
  // undefined config and requests https://undefined/...
  try {
    const origHash = new URL(url).hash;
    if (origHash && !new URL(finalUrl).hash) finalUrl += origHash;
  } catch { /* keep finalUrl as-is */ }
  let finalHost = '';
  try { finalHost = new URL(finalUrl).hostname.toLowerCase(); } catch { finalHost = ''; }
  if (!safeEmbedUrl(finalUrl, reqHost) || UNFRAMEABLE_HOST.test(finalHost)) {
    throw err502('This server redirects to a page that cannot be embedded — try another server');
  }
  url = finalUrl;
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
    // Invisible Cloudflare Turnstile walls the player: no checkbox to click,
    // so no user activation ever arrives and the challenge can never pass
    // inside a frame. Don't fail here (cookies from a past visit can still
    // let it through) — flag it so the client points at "Open in Tab" early.
    ...(probeBody && /turnstile/i.test(probeBody) ? { warning: 'challenge' } : {}),
    // Popups stay granted server-side as an escape hatch; the client strips
    // them by default (blockPopups default-on → strictSandbox) because the
    // only things players window.open are popunder ads (rtmark/luugy/llvpn/
    // adsco chains) — video plays inline, which working PiP confirms. Users
    // can opt popups back on via the "No popups" toggle for stubborn hosts.
    // allow-downloads permits the host's download button (user gesture only).
    // allow-storage-access-by-user-activation is kept for the *outer* frame's
    // own requestStorageAccess() calls. The sandbox attribute is additive
    // down the tree, never subtractive.
    sandbox: 'allow-scripts allow-same-origin allow-presentation allow-forms allow-orientation-lock allow-popups allow-popups-to-escape-sandbox allow-downloads allow-storage-access-by-user-activation',
    referrerPolicy: (j && j.referrerPolicy) || 'no-referrer'
  };
  return cacheSet(key, out, TTL.embed);
}

/* A candidate is only a stream when the URL's *path* ends in a media
   extension. Testing the whole URL as a substring is wrong: the host
   "www.mp4upload.com" contains ".mp4", so every asset on that host (the
   player's videojs.min.css, favicon.png, …) passed the old check and got
   handed to <video>, which requested it with Range: bytes=0- and received a
   206 instead of a video. */
function isMediaUrl(u) {
  try {
    return /\.(m3u8|mp4)$/i.test(new URL(u).pathname.replace(/\/+$/, ''));
  } catch { return false; }
}
function isHlsUrl(u) {
  try {
    return /\.m3u8$/i.test(new URL(u).pathname.replace(/\/+$/, ''));
  } catch { return false; }
}

/* Extract direct stream URL (m3u8/mp4) from embed page HTML */
async function extractStreamUrl(embedUrl, jar) {
  const res = await wt(embedUrl, { jar, redirect: 'follow', timeout: 20000 });
  if (!res.ok) throw new Error(`Embed fetch failed: ${res.status}`);
  const html = await res.text();

  const patterns = [
    /["'](https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)["']/i,
    /["'](https?:\/\/[^"'\s]+\.mp4[^"'\s]*)["']/i,
    /source:\s*["'](https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)["']/i,
    /file:\s*["'](https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)["']/i,
    /src:\s*["'](https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)["']/i,
    /hls:\s*["'](https?:\/\/[^"'\s]+\.m3u8[^"'\s]*)["']/i,
    /"hls"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/i,
    /"src"\s*:\s*"(https?:\/\/[^"]+\.m3u8[^"]*)"/i
  ];

  /* Every match of every pattern is a candidate, not just the first: on
     mp4upload the first `.mp4` hit in the page is the player's own CSS/JS
     asset, which isMediaUrl() rejects — a first-match-only scan would then
     give up before reaching the real source tag. */
  const scan = (text) => {
    for (const pattern of patterns) {
      const rx = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      let m;
      while ((m = rx.exec(text))) {
        if (!m[1]) continue;
        const url = decodeEnt(m[1]);
        if (isMediaUrl(url)) return url;
      }
    }
    return null;
  };

  const found = scan(html);
  if (found) return found;

  throw new Error('No direct stream URL found in embed page');
}

/* Does the file host refuse a browser-shaped request? Probed exactly the way
   the player would ask — no Referer (our document is no-referrer), no Origin,
   one ranged byte — so a "no" here means the client can fetch it directly and
   a "yes" means it needs lib/media.js: hosts like mp4upload answer 403 to
   anything without their own Referer, which a browser can never send. */
async function hotlinkBlocked(url) {
  try {
    const r = await fetch(url, {
      headers: { 'user-agent': UA, accept: '*/*', range: 'bytes=0-1' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000)
    });
    if (r.body) await r.body.cancel().catch(() => {});
    return r.status === 401 || r.status === 403;
  } catch {
    return true; // unreachable from here → let the proxy (or embed) decide
  }
}

/* Resolve embed and extract direct stream URL.
   via: 'direct' → the browser may fetch streamUrl itself
        'proxy'  → hotlink wall; play proxyUrl (same-origin, see lib/media.js)
        'embed'  → no direct path (a hotlink-walled HLS playlist would leave
                   its segments unproxied) → the provider player instead */
async function resolveStream(slug, ep, token, reqHost, force = false) {
  const key = 'str:' + slug + ':' + ep + ':' + token;
  if (!force) {
    const hit = cacheGet(key);
    if (hit) return hit;
  }

  const embed = await resolveEmbed(slug, ep, token, reqHost, force);
  const streamUrl = await extractStreamUrl(embed.url, null);
  if (!isMediaUrl(streamUrl)) throw new Error('Extracted URL is not a media file');
  const type = isHlsUrl(streamUrl) ? 'hls' : 'mp4';
  const blocked = await hotlinkBlocked(streamUrl);
  const via = !blocked ? 'direct' : type === 'mp4' ? 'proxy' : 'embed';
  const out = {
    streamUrl,
    type,
    referrer: embed.url,
    via,
    ...(via === 'proxy'
      ? { proxyUrl: `/api/media/${encodeURIComponent(slug)}/${ep}/${type === 'hls' ? 'master.m3u8' : 'video.mp4'}?token=${encodeURIComponent(token)}` }
      : {})
  };
  return cacheSet(key, out, TTL.stream);
}

module.exports = { ensureSession, episodeIndex, sourcesManifest, listServers, safeEmbedUrl, isMediaUrl, isHlsUrl, resolveEmbed, resolveStream, extractStreamUrl };
