'use strict';
/* Central request router: JSON API → SEO files (robots/sitemap) → static assets
   → server-rendered SPA shell (per-route meta) → 404s. */
const path = require('path');
const { BASE, UA, PUBLIC_DIR, SITE_NAME, TOKEN_RX, RELAY } = require('./config');
const { cacheSize } = require('./cache');
const { apiHome, apiSearch, apiAnime, apiServers } = require('./api');
const { resolveEmbed, resolveStream } = require('./catalog');
const { hop } = require('./upstream');
const { apiImage } = require('./image');
const { getStaticFile, staticCacheControl, encodeStatic, sendData, fail } = require('./http');
const { renderShell, homeMeta, searchMeta, pageMeta, robotsTxt, sitemapXml } = require('./seo');

/* ---------------- API routes ---------------- */
async function apiRoutes(req, res, u, p) {
  if (p === '/api/health') {
    return sendData(req, res, 200, { ok: true, timestamp: Date.now(), cachedItems: cacheSize(), path: p });
  }

  /* Diagnostic: reveals what the upstream actually returns from this platform
     (status, CDN headers, challenge page) plus this function's egress IP.
     The 'direct' legs bypass every relay to prove which path is broken; the
     final leg runs the same chain the app itself uses, so its `via` shows
     whether the Worker relay or the cookie-less reader got through. */
  if (p === '/api/probe') {
    /* Origin-scoped one-off fetch: answers "which upstream routes does this
       platform's egress actually reach?" Managed challenges are usually scoped
       to HTML/navigation, so API/asset routes may be exempt — that decides
       whether playback can work without the relay. Locked to BASE's origin. */
    const probePath = u.searchParams.get('path');
    if (probePath) {
      let target = null;
      try {
        const t = new URL(probePath, BASE);
        if (t.origin !== new URL(BASE).origin) throw new Error('off origin');
        target = t;
      } catch { /* fall through */ }
      if (!target) return sendData(req, res, 400, { error: 'path must stay on the upstream origin' });
      const method = (u.searchParams.get('method') || 'GET').toUpperCase();
      if (!['GET', 'POST', 'HEAD'].includes(method)) return sendData(req, res, 400, { error: 'method must be GET, POST or HEAD' });
      const headers = { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
      if (u.searchParams.get('cookie')) headers.cookie = u.searchParams.get('cookie');
      if (u.searchParams.get('xsrf')) headers['x-xsrf-token'] = u.searchParams.get('xsrf');
      try {
        const r = await hop(target.toString(), { method, headers, redirect: 'manual', timeout: 20000, useRelay: false });
        const body = method === 'HEAD' ? '' : await r.text().catch(() => '');
        return sendData(req, res, 200, {
          target: target.toString(),
          method,
          status: r.status,
          via: r.via || 'direct',
          server: r.headers.get('server'),
          cfRay: r.headers.get('cf-ray'),
          cfMitigated: r.headers.get('cf-mitigated'),
          location: r.headers.get('location'),
          contentType: r.headers.get('content-type'),
          setCookie: typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [],
          bodyHead: body.replace(/\s+/g, ' ').slice(0, 400)
        }, 'application/json; charset=utf-8', 'no-store');
      } catch (e) {
        return sendData(req, res, 200, { target: target.toString(), method, error: e.message }, 'application/json; charset=utf-8', 'no-store');
      }
    }
    const browserHeaders = { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
    const attempts = [
      { name: 'browser UA', useRelay: false, headers: browserHeaders },
      { name: 'no UA', useRelay: false, headers: {} },
      { name: 'curl UA', useRelay: false, headers: { 'user-agent': 'curl/8.4.0' } },
      { name: RELAY ? 'app chain (relay first)' : 'app chain (reader fallback)', useRelay: true, htmlFallback: true, follow: true, headers: browserHeaders }
    ];
    const results = [];
    for (const a of attempts) {
      try {
        const r = await hop(BASE + '/', {
          headers: a.headers,
          redirect: a.follow ? 'follow' : 'manual',
          timeout: 20000,
          useRelay: a.useRelay,
          htmlFallback: !!a.htmlFallback
        });
        const body = await r.text();
        results.push({
          name: a.name,
          status: r.status,
          via: r.via || 'direct',
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
    return sendData(req, res, 200, { base: BASE, relay: RELAY || null, node: process.version, egressIp, results }, 'application/json; charset=utf-8', 'no-store');
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
    const force = u.searchParams.get('fresh') === '1';
    return sendData(req, res, 200, await resolveEmbed(decodeURIComponent(m[1]), Number(m[2]), token, req.headers.host, force), 'application/json; charset=utf-8', 'public, max-age=300');
  }

  m = p.match(/^\/api\/stream\/([^/]+)\/(\d+)$/);
  if (m) {
    const token = u.searchParams.get('token') || '';
    if (!TOKEN_RX.test(token)) return sendData(req, res, 400, { error: 'Invalid server token' });
    const force = u.searchParams.get('fresh') === '1';
    try {
      const stream = await resolveStream(decodeURIComponent(m[1]), Number(m[2]), token, req.headers.host, force);
      return sendData(req, res, 200, stream, 'application/json; charset=utf-8', 'no-store');
    } catch (e) {
      return sendData(req, res, 502, { error: e.message || 'Stream extraction failed' }, 'application/json; charset=utf-8', 'no-store');
    }
  }

  if (p === '/api/image') return apiImage(req, res, u);

  return sendData(req, res, 404, { error: 'Not found' });
}

/* ---------------- SPA route matcher (mirrors public/app.js parseRoute) ---------------- */
function matchRoute(p, u) {
  let m;
  if (p === '/' || p === '/index.html') return { view: 'home', path: '/' };
  if (p === '/search') return { view: 'browse', q: (u.searchParams.get('q') || '').trim(), path: '/search' };
  if ((m = p.match(/^\/watch\/([^/]+)\/(\d+)\/?$/))) {
    return { view: 'watch', slug: decodeURIComponent(m[1]), ep: Number(m[2]), path: p };
  }
  if ((m = p.match(/^\/(anime|movie)\/([^/]+)\/?$/))) {
    return { view: 'anime', kind: m[1], slug: decodeURIComponent(m[2]), path: p };
  }
  return null;
}

function serveStatic(req, res, entry, requestPath) {
  const reqEtag = req.headers['if-none-match'];
  const cache = staticCacheControl(requestPath);
  if (reqEtag && reqEtag === entry.etag) {
    res.writeHead(304, { etag: entry.etag, 'cache-control': cache });
    return res.end();
  }
  const { body, encoding } = encodeStatic(entry, req);
  const headers = {
    'content-type': entry.type,
    'etag': entry.etag,
    'cache-control': cache,
    'x-content-type-options': 'nosniff'
  };
  if (encoding) headers['content-encoding'] = encoding;
  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  return res.end(body);
}

/* ---------------- Request Handler ---------------- */
async function handleRequest(req, res) {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  try {
    if (p.startsWith('/api/')) return await apiRoutes(req, res, u, p);

    /* Static assets first: public/robots.txt, llms.txt, versioned bundles.
       (On Vercel these are served straight from public/; locally the static
       file wins over the dynamic SEO fallback below.) */
    if (p !== '/' && p !== '/index.html') {
      let filePath = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
      const full = path.join(PUBLIC_DIR, filePath);
      if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + path.sep)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      const fileEntry = getStaticFile(full);
      if (fileEntry) return serveStatic(req, res, fileEntry, req.url);
    }

    /* SEO files (dynamic fallback when no static file exists) */
    if (p === '/robots.txt') {
      return sendData(req, res, 200, robotsTxt(req), 'text/plain; charset=utf-8', 'public, max-age=3600');
    }
    if (p === '/sitemap.xml') {
      return sendData(req, res, 200, await sitemapXml(req), 'application/xml; charset=utf-8', 'public, max-age=3600');
    }

    /* App routes → server-rendered shell with per-route head metadata */
    const route = matchRoute(p, u);
    if (route) {
      let meta;
      let status = 200;
      if (route.view === 'home') meta = homeMeta(req);
      else if (route.view === 'browse') meta = searchMeta(req, route.q);
      else ({ meta, status } = await pageMeta(req, route));
      return sendData(req, res, status, renderShell(req, meta), 'text/html; charset=utf-8', 'no-cache');
    }

    /* Unknown paths */
    if (path.extname(p)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('Not found');
    }
    return sendData(req, res, 404, renderShell(req, {
      title: `Not Found — ${SITE_NAME}`,
      description: 'The page you requested does not exist.',
      path: p,
      noindex: true
    }), 'text/html; charset=utf-8', 'no-cache');
  } catch (err) {
    fail(req, res, err);
  }
}

module.exports = { handleRequest, matchRoute };
