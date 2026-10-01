'use strict';
/* Same-origin media proxy.

   Some file hosts (mp4upload's a1.mp4upload.com:183 among them) answer 403 to
   every request that does not carry *their* Referer. A browser can neither
   forge that header (forbidden header name) nor send ours — the document is
   no-referrer — and the host sends no Access-Control-Allow-Origin, so a
   crossorigin <video> is refused as well. Our server can present the right
   Referer, so it fetches the bytes and pipes them back same-origin: no CORS,
   no hotlink wall, Range passed through so seeking still works.

   The target URL never comes from the client: it is re-resolved from the
   episode's server token (lib/catalog.js), which keeps this from being an
   open proxy. */
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { UA, TOKEN_RX } = require('./config');
const { resolveStream } = require('./catalog');
const { sendData } = require('./http');

/* Headers that must not cross a proxy:
   - hop-by-hop (connection/te/…) belongs to the hop we just left;
   - content-encoding would be a lie — fetch() already decoded the body;
   - set-cookie must not be replayed: the answer carries *our* origin, so an
     upstream cookie would stick to us;
   - content-disposition: the file hosts answer `attachment`, and Chrome then
     refuses to play the bytes in <video> at all — the proxy exists for inline
     playback, so that header must not cross either. */
const DROP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'content-encoding', 'set-cookie', 'set-cookie2', 'content-disposition'
]);

function contentTypeFor(up, streamUrl) {
  const raw = (up.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (raw && raw !== 'application/octet-stream' && raw !== 'binary/octet-stream') return null;
  try {
    const p = new URL(streamUrl).pathname.toLowerCase();
    if (p.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
    if (p.endsWith('.mp4')) return 'video/mp4';
  } catch { /* fall through */ }
  return raw || null;
}

async function apiMedia(req, res, u, slug, ep) {
  const token = u.searchParams.get('token') || '';
  if (!TOKEN_RX.test(token)) return sendData(req, res, 400, { error: 'Invalid server token' });

  let stream;
  try {
    stream = await resolveStream(slug, ep, token, req.headers.host);
  } catch (e) {
    return sendData(req, res, 502, { error: e.message || 'Stream resolution failed' }, 'application/json; charset=utf-8', 'no-store');
  }

  /* Two timeouts, not one: the 20s cap only guards the handshake — a long
     AbortSignal.timeout() would kill a healthy stream mid-playback. File
     hosts on odd ports (…:183) also drop fresh connections now and then, so
     a connect failure gets one more try before we give up. */
  let ctl = null;
  let up = null;
  let failure = null;
  for (let attempt = 0; attempt < 2 && !up; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 700));
    ctl = new AbortController();
    const boot = setTimeout(() => ctl.abort(), 20000);
    try {
      up = await fetch(stream.streamUrl, {
        headers: {
          'user-agent': UA,
          accept: 'video/*,*/*;q=0.8',
          ...(stream.referrer ? { referer: stream.referrer } : {}),
          ...(req.headers.range ? { range: req.headers.range } : {}),
          ...(req.headers['if-range'] ? { 'if-range': req.headers['if-range'] } : {})
        },
        redirect: 'follow',
        signal: ctl.signal
      });
    } catch (e) {
      failure = e;
      up = null;
    } finally {
      clearTimeout(boot);
    }
  }
  if (!up) {
    console.error('[Media] upstream unreachable:', failure && (failure.cause ? failure.cause.message : failure.message));
    return sendData(req, res, 502, { error: 'Upstream stream unreachable' }, 'application/json; charset=utf-8', 'no-store');
  }

  const headers = {};
  for (const [k, v] of up.headers) {
    if (DROP.has(k)) continue;
    /* Some file servers ship values like `cache-control: : no-cache`; a value
       that starts with ':' parses as garbage in every client. */
    const val = typeof v === 'string' && /^\s*:/.test(v) ? v.replace(/^\s*:\s*/, '') : v;
    if (val) headers[k] = val;
  }
  /* Undici decodes the body for us, so a stale content-length would truncate
     or hang the response — drop it and let Node chunk instead. */
  if (up.headers.get('content-encoding') && 'content-length' in headers) delete headers['content-length'];
  const ct = contentTypeFor(up, stream.streamUrl);
  if (ct) headers['content-type'] = ct;
  if (!headers['cache-control']) headers['cache-control'] = 'private, max-age=3600';

  /* The frontend lives on another origin (GitHub Pages), so hls.js/XHR reads
     these responses under CORS: pin ACAO to * (overriding anything an upstream
     copied through above) and expose the byte-range headers the player asks
     for. A plain <video> needs no CORS, but the playlist fetch does. */
  headers['access-control-allow-origin'] = '*';
  headers['access-control-expose-headers'] = 'accept-ranges, content-length, content-range, x-content-duration';

  res.writeHead(up.status, headers);

  const noBody = req.method === 'HEAD' || !up.body || up.status === 204 || up.status === 304;
  if (noBody) {
    if (up.body) await up.body.cancel().catch(() => {});
    return res.end();
  }

  /* Stop fetching the moment the viewer goes away (seek/switch/close). A
     response that merely *finished* must not abort — that tears down the
     upstream socket mid-teardown and poisons the next connection. */
  const abort = () => {
    if (res.writableFinished) return;
    try { ctl.abort(); } catch { /* already settled */ }
  };
  res.on('close', abort);
  try {
    /* fetch() hands back a web ReadableStream; pipeline() wants a Node one. */
    await pipeline(Readable.fromWeb(up.body), res);
  } catch { /* client aborted, or the upstream died — nothing left to do */ }
  res.removeListener('close', abort);
  if (!res.writableEnded) res.end();
}

module.exports = { apiMedia };
