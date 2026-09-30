'use strict';
/* Upstream HTTP layer: cookie jar + rate-limited fetch wrapper with relay legs.

   Leg order for an upstream page fetch:
     1. Worker relay (lib/config.js RELAY) — carries cookies/CSRF, so it also
        serves the player's POSTs. Used first when configured.
     2. Direct fetch — enough on a normal residential connection, and kept as
        insurance if the relay is down.
     3. Browser-rendering reader (JINA) — GET/HTML only, no cookies: it exists
        so pages still render on hosts the origin challenges (Vercel), where a
        plain HTTP client can never get through.
   Anything the origin really answered with (404, 419, …) is returned
   untouched; only a blocked status (403 challenge, 429, 5xx) advances to the
   next leg, and only a 200 from the reader counts as success — otherwise the
   best direct answer is handed back so the caller's error still reads right. */
const { UA, RELAY, RELAY_TOKEN, RELAY_HOSTS, JINA, JINA_KEY } = require('./config');
const { waitForSlot } = require('./cache');

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

/* Only our own hosts ever ride a relay — never a third-party embed. */
function relayable(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return RELAY_HOSTS.some((x) => h === x || h.endsWith('.' + x));
  } catch { return false; }
}

function stamp(res, via) {
  try { Object.defineProperty(res, 'via', { value: via, configurable: true }); } catch { /* sealed Response */ }
  return res;
}

/* Statuses that mean "blocked here, try another path" rather than a real
   answer. 404/419/400 are genuine origin replies and short-circuit the chain;
   403 (the challenge), 429 and 5xx are the reason the reader leg exists. */
const BLOCKED = new Set([403, 407, 408, 425, 429, 451, 503]);
const isBlocked = (status) => BLOCKED.has(status) || status >= 500;

/* ---------------- Fetch across relay legs ---------------- */
async function hop(url, { method = 'GET', headers = {}, body, redirect = 'follow', timeout = 25000, useRelay = true, htmlFallback = false } = {}) {
  const isGet = method === 'GET' || method === 'HEAD';
  const legs = [];
  if (useRelay && RELAY && relayable(url)) {
    legs.push({
      kind: 'worker',
      url: RELAY + '/?url=' + encodeURIComponent(url),
      headers: RELAY_TOKEN ? { 'x-relay-token': RELAY_TOKEN } : {},
      init: { method, body, redirect }
    });
  }
  legs.push({ kind: 'direct', url, headers: {}, init: { method, body, redirect } });
  /* The reader can only do a plain GET of a page, and it follows redirects
     itself, so it never stands in for an explicit manual-redirect call. */
  if (useRelay && htmlFallback && isGet && redirect === 'follow' && JINA && relayable(url)) {
    legs.push({
      kind: 'reader',
      url: JINA + '/' + url,
      headers: { 'x-respond-with': 'html', accept: 'text/html,application/xhtml+xml', ...(JINA_KEY ? { authorization: 'Bearer ' + JINA_KEY } : {}) },
      init: { method: 'GET', body: undefined, redirect: 'follow' },
      timeout: Math.max(timeout, 30000)
    });
  }

  let keep = null; // best failure to hand back if no leg succeeds
  let lastErr = null;

  for (const leg of legs) {
    /* The reader is a separate client: it gets its own headers only — our
       browser-mimicking ones (notably accept-language) make it answer 403. */
    const h = leg.kind === 'reader' ? { ...leg.headers } : { ...headers, ...leg.headers };
    if (leg.kind === 'worker' && leg.init.redirect === 'manual') h['x-relay-redirect'] = 'manual';
    let res;
    try {
      res = await fetch(leg.url, { ...leg.init, headers: h, signal: AbortSignal.timeout(leg.timeout || timeout) });
    } catch (e) {
      lastErr = e;
      continue;
    }

    /* A response the relay generated itself (bad token, blocked host, relay
       crash) is not an answer from the origin — skip it and keep going. */
    if (leg.kind === 'worker' && res.headers.get('x-relay-error')) {
      await res.arrayBuffer().catch(() => null);
      continue;
    }

    const gotThrough = leg.kind === 'reader' ? res.ok : !isBlocked(res.status);
    if (gotThrough) return stamp(res, leg.kind);

    if (leg.kind === 'reader') {
      await res.arrayBuffer().catch(() => null);
      continue;
    }
    /* Keep the direct answer over a relay's — that is the error worth showing. */
    if (!keep || leg.kind === 'direct') {
      if (keep) await keep.res.arrayBuffer().catch(() => null);
      keep = { res, kind: leg.kind };
    } else {
      await res.arrayBuffer().catch(() => null);
    }
  }

  if (keep) return stamp(keep.res, keep.kind);
  throw lastErr || new Error('upstream fetch failed: ' + url);
}

/* ---------------- Upstream Request Helper ---------------- */
async function wt(url, { jar, method = 'GET', headers = {}, body, redirect = 'follow', timeout = 25000, useRelay = true } = {}) {
  await waitForSlot();
  const h = {
    'user-agent': UA,
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'accept-language': 'ar,en;q=0.9,en-US;q=0.8',
    ...headers
  };
  if (jar && jar.size) h.cookie = jar.header();
  const res = await hop(url, { method, headers: h, body, redirect, timeout, useRelay, htmlFallback: true });
  if (jar) jar.absorb(res);
  return res;
}

module.exports = { Jar, wt, hop, relayable };
