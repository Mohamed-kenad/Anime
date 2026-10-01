/* Home relay server: runs worker/relay.js (the allow-listed, token-checked
   upstream proxy) on this machine, so requests to witanime leave from the
   home IP — the only network class the origin does not challenge.

   Started by run.ps1 together with cloudflared, which exposes this port
   through a free quick tunnel; the tunnel URL is pushed to the Worker's
   HOME_UPSTREAM secret on every change, so Vercel never needs touching. */
import http from 'node:http';
import relay from '../worker/relay.js';

const PORT = Number(process.env.PORT) || 8787;
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host']);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const method = (req.method || 'GET').toUpperCase();
    const hasBody = !['GET', 'HEAD'].includes(method);
    const body = hasBody ? await readBody(req) : undefined;
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
    }
    const r = await relay.fetch(
      new Request('http://127.0.0.1:' + PORT + req.url, { method, headers, body, redirect: 'manual' }),
      { RELAY_TOKEN: process.env.RELAY_TOKEN || '' }
    );
    const out = {};
    let setCookie = [];
    for (const [k, v] of r.headers) {
      if (k.toLowerCase() === 'set-cookie') continue;
      out[k] = v;
    }
    if (typeof r.headers.getSetCookie === 'function') setCookie = r.headers.getSetCookie();
    if (setCookie.length) out['set-cookie'] = setCookie;
    res.writeHead(r.status, out);
    const buf = Buffer.from(await r.arrayBuffer());
    res.end(buf.length ? buf : undefined);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'home relay failure', message: String((e && e.message) || e) }));
  }
});

server.listen(PORT, () => {
  console.log('[home-relay] listening on http://127.0.0.1:' + PORT);
});
