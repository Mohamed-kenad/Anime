'use strict';
/* Catalog + playback: episode indexes, watch metadata, embed resolution. */
const { BASE, TTL, PAGE_SIZE, MAX_SEASON_PAGES, VID_RX } = require('./config');
const { cacheGet, cacheSet } = require('./cache');
const { wt, Jar } = require('./upstream');
const { err404, err429, err502, sleep, decodeEnt, stripTags, absUrl, pooled } = require('./util');
const { parseSeriesPage, parseSeasonPage } = require('./parsers');

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
async function sessionFor(slug, ep, force = false) {
  if (VID_RX.test(slug)) {
    try {
      return await buildSession(slug, force);
    } catch (e) {
      if (!e || Number(e.code) !== 404) throw e;
      // hex-looking series slug — fall through to the index
    }
  }
  const idx = await episodeIndex(slug);
  const hit = idx.byN.get(Number(ep));
  if (!hit) throw err404('Episode not found: ' + slug + '/' + ep);
  return buildSession(hit.slug, force);
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

async function resolveEmbed(slug, ep, token, reqHost, force = false) {
  const key = 'emb:' + slug + ':' + ep + ':' + token;
  // Signed player URLs expire: a cached resolve can hand the browser a dead
  // link that the host bounces to google.com. `force` (Reload button) skips
  // the cache and rebuilds the session so the URL is minted fresh.
  if (!force) {
    const hit = cacheGet(key);
    if (hit) return hit;
  }

  let s = await sessionFor(slug, ep, force);
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
  // because the player iframe uses referrerpolicy="no-referrer"). No cookie jar
  // on purpose: this mirrors the anonymous browser load. Redirects are followed
  // because some hosts bounce bad sessions to an unframeable page (google.com),
  // which manual mode would miss and hand the browser a dead frame.
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
    // allow-popups: video hosts open the stream / player controls in a new
    // tab; without it playback is blocked ("allow-popups permission is not
    // set"). ...-to-escape-sandbox keeps those tabs outside the sandbox, and
    // allow-downloads permits the host's download button (user gesture only).
    // allow-storage-access-by-user-activation is kept for the *outer* frame's
    // own requestStorageAccess() calls. It does NOT rescue hosts fronted by
    // reCAPTCHA/Turnstile: those run the challenge in a nested iframe that
    // Google/Cloudflare create with their own sandbox attribute, and an
    // embedder cannot add tokens to a frame it does not own. The sandbox
    // attribute is additive down the tree, never subtractive.
    sandbox: 'allow-scripts allow-same-origin allow-presentation allow-forms allow-orientation-lock allow-popups allow-popups-to-escape-sandbox allow-downloads allow-storage-access-by-user-activation',
    referrerPolicy: 'no-referrer'
  };
  return cacheSet(key, out, TTL.embed);
}

module.exports = { episodeIndex, vidInfo, buildSession, sessionFor, listServers, safeEmbedUrl, resolveEmbed };
