'use strict';
/* Upstream HTTP layer: cookie jar + rate-limited fetch wrapper with an
   optional relay hop (see lib/config.js RELAY — a Cloudflare Worker that the
   origin does not challenge, used automatically whenever it is configured). */
const { UA, RELAY, RELAY_TOKEN, RELAY_HOSTS } = require('./config');
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

/* Only our own hosts ever ride the relay — never a third-party embed. */
function relayable(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return RELAY_HOSTS.some((x) => h === x || h.endsWith('.' + x));
  } catch { return false; }
}

function relayLeg(url) {
  const headers = {};
  if (RELAY_TOKEN) headers['x-relay-token'] = RELAY_TOKEN;
  return { url: RELAY + '/?url=' + encodeURIComponent(url), relayed: true, headers };
}

/* ---------------- Fetch with relay fallback ----------------
   Order: relay first when one is configured (that is the whole point of
   configuring it), then a direct attempt as insurance. A relay answer below
   500 is the origin's real answer and is returned untouched; 5xx/transport
   failures fall through to the direct leg. */
async function hop(url, { method = 'GET', headers = {}, body, redirect = 'follow', timeout = 25000, useRelay = true } = {}) {
  const legs = [];
  if (useRelay && RELAY && relayable(url)) legs.push(relayLeg(url));
  legs.push({ url, relayed: false, headers: {} });

  let lastErr = null;
  for (const leg of legs) {
    const h = { ...headers, ...leg.headers };
    if (leg.relayed && redirect === 'manual') h['x-relay-redirect'] = 'manual';
    try {
      const res = await fetch(leg.url, { method, headers: h, body, redirect, signal: AbortSignal.timeout(timeout) });
      if (leg.relayed && res.status >= 500) {
        await res.arrayBuffer().catch(() => null);
        lastErr = new Error('relay ' + res.status);
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
    }
  }
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
  const res = await hop(url, { method, headers: h, body, redirect, timeout, useRelay });
  if (jar) jar.absorb(res);
  return res;
}

module.exports = { Jar, wt, hop, relayable };
