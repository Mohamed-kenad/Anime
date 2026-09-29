'use strict';
/* Same-origin image proxy with a mirror chain (imgur blocks our IP directly). */
const { BASE, IMAGE_BASE, UA } = require('./config');
const { cacheGet, cacheSet } = require('./cache');
const { sendData } = require('./http');

async function apiImage(req, res, u) {
  let imgUrl = u.searchParams.get('url') || '';
  let pu = null;
  try { pu = new URL(imgUrl); } catch { pu = null; }
  if (!pu || pu.protocol !== 'https:') return sendData(req, res, 400, { error: 'Invalid image URL' });

  /* Unwrap weserv URLs: the client serves resized weserv copies, and its
     error fallback retries through here. Fetching weserv-from-weserv would
     loop/fail, so resolve the inner source instead (same bytes, one hop). */
  if (pu.hostname === 'images.weserv.nl') {
    const inner = String(pu.searchParams.get('url') || '');
    try {
      pu = new URL(inner.includes('://') ? inner : 'https://' + inner);
    } catch { return sendData(req, res, 400, { error: 'Invalid image URL' }); }
    if (pu.protocol !== 'https:') return sendData(req, res, 400, { error: 'Invalid image URL' });
    imgUrl = pu.toString();
  }

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

module.exports = { apiImage };
