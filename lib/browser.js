'use strict';
/* In-function headless-browser leg for the upstream fetch chain.

   The origin (witanime.site) answers every datacenter client — pages and the
   player's cookie-bound POSTs alike — with a Cloudflare managed challenge that
   no plain HTTP client can clear: a Worker relay sits on the same kind of
   network and is challenged too, and the cookie-less reader can only hand back
   rendered HTML. What does clear it is a real browser running the challenge
   script from this function's own egress IP, which then holds cf_clearance and
   the Laravel session cookie. So this module keeps one warm page on the
   origin, waits the challenge out, and performs upstream requests with fetch()
   inside that page — same origin, credentials included — which is exactly the
   traffic the origin answers.

   Only same-host-as-BASE requests come through here (hop() gates that): the
   page's origin is BASE, so anything else would trip CORS, and third-party
   hosts are not challenged in the first place.

   The leg engages when an earlier leg was blocked (direct 403s on challenged
   networks), so a residential/local run never launches a browser unless
   UPSTREAM_BROWSER=force is set for testing. */
const fs = require('fs');
const { BASE, UA } = require('./config');

let browserP = null; // singleton launch promise
let browser = null;
let page = null;
let cdp = null;
let lock = Promise.resolve(); // one operation on the shared page at a time

const CHALLENGE_RX = /just a moment|attention required|cf-chl|challenge-platform/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Client hints that match the faked UA: the challenge script cross-checks
   navigator.userAgentData brands against the UA string, and headless shell
   otherwise reports its real Chromium version — a mismatch loops the
   interstitial forever. */
function uaMetadata(u) {
  const full = (u.match(/Chrome\/([\d.]+)/) || [, '120.0.0.0'])[1];
  const major = full.split('.')[0];
  const win = /Windows NT/.test(u);
  return {
    brands: [
      { brand: 'Not A(Brand', version: '99' },
      { brand: 'Google Chrome', version: major },
      { brand: 'Chromium', version: major }
    ],
    fullVersionList: [
      { brand: 'Not A(Brand', version: '99.0.0.0' },
      { brand: 'Google Chrome', version: full },
      { brand: 'Chromium', version: full }
    ],
    platform: win ? 'Windows' : 'Linux',
    platformVersion: win ? '10.0.0' : '0.0.0',
    architecture: 'x86',
    model: '',
    mobile: false,
    bitness: '64',
    wow64: false
  };
}

/* Serialize every browser operation: the page and its cookie jar are shared. */
function serialize(fn) {
  const run = lock.then(() => fn(), () => fn());
  lock = run.then(() => undefined, () => undefined);
  return run;
}

function systemChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = process.platform === 'win32'
    ? [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
      ]
    : process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Chromium.app/Contents/MacOS/Chromium'
        ]
      : [];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch { /* keep looking */ }
  }
  return null;
}

let extraP = null; // puppeteer-extra instance with stealth configured once

async function launch() {
  /* puppeteer-core ≥24 is ESM-only: require() throws ERR_REQUIRE_ESM.
     puppeteer-extra stays CJS; addExtra() wraps the imported core. Stealth
     supplies the fingerprint evasions (plugins, chrome runtime, webdriver …)
     that a bare headless shell fails on — except user-agent-override, which
     would replace the app UA (+ matching client hints) cf_clearance binds to. */
  if (!extraP) {
    const { addExtra } = require('puppeteer-extra');
    const coreMod = await import('puppeteer-core');
    const inst = addExtra(coreMod.default || coreMod);
    /* Literal standalone-evasion requires: the umbrella plugin loads them via
       a dynamic `evasions/${name}` template that Vercel's bundler cannot
       trace, so the modules would be missing from the function bundle. Full
       set minus user-agent-override — it would replace the UA + matching
       client hints that cf_clearance binds to. */
    inst.use(require('puppeteer-extra-plugin-stealth/evasions/chrome.app')());
    inst.use(require('puppeteer-extra-plugin-stealth/evasions/chrome.csi')());
    inst.use(require('puppeteer-extra-plugin-stealth/evasions/chrome.loadTimes')());
    inst.use(require('puppeteer-extra-plugin-stealth/evasions/chrome.runtime')());
    inst.use(require('puppeteer-extra-plugin-stealth/evasions/defaultArgs')());
    inst.use(require('puppeteer-extra-plugin-stealth/evasions/iframe.contentWindow')());
    inst.use(require('puppeteer-extra-plugin-stealth/evasions/media.codecs')());
    inst.use(require('puppeteer-extra-plugin-stealth/evasions/navigator.hardwareConcurrency')());
    inst.use(require('puppeteer-extra-plugin-stealth/evasions/navigator.languages')());
    inst.use(require('puppeteer-extra-plugin-stealth/evasions/navigator.permissions')());
    inst.use(require('puppeteer-extra-plugin-stealth/evasions/navigator.plugins')());
    inst.use(require('puppeteer-extra-plugin-stealth/evasions/navigator.webdriver')());
    inst.use(require('puppeteer-extra-plugin-stealth/evasions/sourceurl')());
    inst.use(require('puppeteer-extra-plugin-stealth/evasions/webgl.vendor')());
    inst.use(require('puppeteer-extra-plugin-stealth/evasions/window.outerdimensions')());
    extraP = inst;
  }
  const puppeteer = extraP;
  let exe = null;
  let args;
  let headless;
  let stageErr = null; // where a Linux bundle launch died, for diagnostics
  if (process.platform === 'linux') {
    /* Serverless build: bundled brotli Chromium (@sparticuz/chromium is ESM,
       so import() — require() of it throws ERR_REQUIRE_ESM). */
    try {
      const mod = await import('@sparticuz/chromium');
      const chromium = mod.default || mod;
      /* The challenge page needs no WebGL — skipping the swiftshader extract
         cuts cold-start time and memory on 1024MB functions. */
      try { chromium.setGraphicsMode = false; } catch { /* older bundle */ }
      exe = await chromium.executablePath();
      args = await puppeteer.defaultArgs({ args: [...chromium.args, '--disable-blink-features=AutomationControlled'], headless: 'shell' });
      headless = 'shell';
    } catch (e) {
      stageErr = 'chromium bundle (' + ((e && e.message) || e) + ')';
      exe = systemChrome();
      args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'];
      headless = true;
    }
  } else {
    exe = systemChrome();
    args = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'];
    headless = true;
  }
  if (!exe) throw new Error('no chromium executable found' + (stageErr ? ' — ' + stageErr : '') + ' (set CHROME_PATH)');
  let b;
  try {
    b = await puppeteer.launch({
      executablePath: exe,
      args,
      headless,
      defaultViewport: { width: 1366, height: 768 }
    });
  } catch (e) {
    throw new Error('puppeteer.launch failed (' + exe + '): ' + ((e && e.message) || e));
  }
  b.on('disconnected', () => { if (b === browser) { browser = null; browserP = null; page = null; cdp = null; } });
  return b;
}

async function launchOnce() {
  if (!browserP) browserP = launch().catch((e) => { browserP = null; throw e; });
  const b = await browserP;
  if (b.connected === false) { browserP = null; browser = null; return launchOnce(); }
  browser = b;
  return b;
}

/* A healthy page sits on the origin and is not showing a challenge. */
async function pageHealthy() {
  if (!page || page.isClosed()) return false;
  try {
    const t = await page.title();
    if (t && CHALLENGE_RX.test(t)) return false;
    return page.url().startsWith(BASE);
  } catch { return false; }
}

async function freshPage(hooks) {
  if (page) { await page.close().catch(() => {}); page = null; cdp = null; }
  const b = await launchOnce();
  page = await b.newPage();
  cdp = await page.createCDPSession();
  if (hooks) {
    page.on('pageerror', (e) => { try { hooks.errors.push(String((e && e.message) || e).slice(0, 250)); } catch { /* torn down */ } });
    page.on('console', (m) => { try { if (hooks.console.length < 25) hooks.console.push(m.type() + ': ' + m.text().slice(0, 200)); } catch { /* torn down */ } });
  }
  /* Present the app's own UA so cf_clearance (bound to IP + UA) matches every
     other leg, and look unlike automation to the challenge script — UA string
     AND client hints AND accept-language, all consistent. */
  await page.setUserAgent(UA).catch(() => {});
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent: UA,
    acceptLanguage: 'en-US,en;q=0.9',
    userAgentMetadata: uaMetadata(UA)
  }).catch(() => {});
  /* webdriver/languages/etc. evasions come from the stealth plugin — don't
     redefine the same navigator properties here (duplicate defineProperty
     can throw inside their injected scripts). */
  if (hooks) {
    page.on('response', (r) => {
      try {
        const s = r.status();
        if (s >= 400 && hooks.bad.length < 20) hooks.bad.push(s + ' ' + r.url().slice(0, 150));
        if (r.url().indexOf('cdn-cgi/challenge-platform') !== -1 && hooks.chl && hooks.chl.length < 15) hooks.chl.push(s + ' ' + r.url().slice(0, 160));
      } catch { /* response torn down */ }
    });
    page.on('requestfailed', (rq) => {
      try {
        if (hooks.bad.length < 20) hooks.bad.push('FAIL ' + ((rq.failure() && rq.failure().errorText) || '') + ' ' + rq.url().slice(0, 150));
      } catch { /* request torn down */ }
    });
  }
  await cdp.send('Network.enable');
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  /* Managed challenges solve themselves and reload — wait it out. On Vercel
     Hobby the function itself times out at ~10s, so a 20s wait there only
     turns a solvable challenge into a platform timeout with no JSON body:
     cap the wait and let the caller fall through to the actionable
     needs-relay error instead. */
  const t0 = Date.now();
  const budget = process.env.VERCEL ? 11000 : 20000;
  const deadline = t0 + budget;
  let cleared = false;
  while (Date.now() < deadline) {
    const t = await page.title().catch(() => '');
    if (hooks && hooks.onTick) await hooks.onTick(t).catch(() => {});
    if (!t || !CHALLENGE_RX.test(t)) { cleared = true; break; }
    await sleep(400);
  }
  if (!cleared) console.log('[animewit] browser challenge not cleared in ' + (Date.now() - t0) + 'ms');
  return { page, cdp };
}

async function ensurePage() {
  if (await pageHealthy()) return { page, cdp };
  return freshPage();
}

/* Run the request as the page itself: same origin, its cookie jar, its
   fingerprint. Redirect hops are captured from puppeteer's response events —
   the JS fetch only ever sees the followed result (and cross-origin redirect
   targets answer without CORS headers, which would make fetch throw before
   the Location became visible). */
async function fetchInPage(p, url, method, headers, body, timeout) {
  const hops = [];
  const onResp = (r) => {
    try {
      const s = r.status();
      if (s >= 300 && s < 400) hops.push({ status: s, url: r.url(), location: r.headers().location || null });
    } catch { /* response torn down */ }
  };
  p.on('response', onResp);
  const work = p.evaluate(async (u, m, h, b) => {
    try {
      const res = await fetch(u, { method: m, headers: h, body: b, redirect: 'follow', credentials: 'include' });
      const ct = res.headers.get('content-type') || '';
      const isText = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded)|[^;]+\+(json|xml))/i.test(ct);
      const hdrs = {};
      res.headers.forEach((v, k) => { hdrs[k] = v; });
      if (isText) return { status: res.status, url: res.url, redirected: res.redirected, headers: hdrs, body: await res.text() };
      const bytes = new Uint8Array(await res.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return { status: res.status, url: res.url, redirected: res.redirected, headers: hdrs, b64: btoa(bin) };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }, url, method, headers, body);
  let timer;
  const timeoutP = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('browser fetch timeout')), timeout); });
  try {
    const out = await Promise.race([work, timeoutP]);
    out.hops = hops;
    return out;
  } finally {
    clearTimeout(timer);
    p.off('response', onResp);
  }
}

/* Load the URL in a hidden iframe — the only way a real browser sends
   Sec-Fetch-Dest: iframe. Some upstream routes (the stream gate) 404 on every
   other dest (empty from fetch(), document from navigation), and no CDP layer
   can override the header: Chrome regenerates sec-fetch-* after interception,
   so Fetch.continueRequest and setExtraHTTPHeaders both lose to it. The page
   JS only creates the frame and waits; the response, its status and redirect
   hops all come from puppeteer's response events (cross-origin frames are
   readable there even though page JS is not). */
async function iframeFetchInPage(p, url, timeout) {
  const bare = url.split('#')[0];
  const hops = [];
  const matched = [];
  const onResp = (r) => {
    try {
      const s = r.status();
      if (r.url().split('#')[0] === bare) matched.push(r);
      if (s >= 300 && s < 400) hops.push({ status: s, url: r.url(), location: r.headers().location || null });
    } catch { /* response torn down */ }
  };
  p.on('response', onResp);
  const work = p.evaluate((u, ms) => new Promise((resolve) => {
    let done = false;
    const f = document.createElement('iframe');
    const finish = () => { if (done) return; done = true; try { f.remove(); } catch {} resolve(true); };
    f.onload = finish;
    f.onerror = finish;
    f.style.cssText = 'position:fixed;left:-9999px;top:0;width:800px;height:600px;';
    f.src = u;
    document.documentElement.appendChild(f);
    setTimeout(finish, ms);
  }), url, Math.max(3000, timeout - 1000));
  let timer;
  const timeoutP = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('browser iframe timeout')), timeout + 5000); });
  try {
    await Promise.race([work, timeoutP]);
  } finally {
    clearTimeout(timer);
    p.off('response', onResp);
  }
  const resp = matched[0];
  if (!resp) return { error: 'iframe produced no response for ' + url, hops };
  let body = '';
  try { body = await resp.buffer(); } catch { /* redirects don't need it */ }
  return { status: resp.status(), url, redirected: hops.length > 0, headers: resp.headers(), body, hops };
}

/* Build the Response hop() hands back. For redirect:'manual' the caller wants
   the 302 itself — synthesize it from the captured first hop, keeping the
   requested hash (hash-based players encode their video id in it). */
function buildResponse(out, reqUrl, redirect) {
  const headers = { ...out.headers };
  delete headers['content-encoding'];
  delete headers['transfer-encoding'];
  delete headers['content-length'];
  let status = out.status;
  let body = out.b64 ? Buffer.from(out.b64, 'base64') : (out.body || '');
  if (redirect === 'manual' && out.hops && out.hops.length) {
    /* Match our own request's hop: response URLs carry no fragment, and the
       page may emit unrelated 3xx responses (analytics) we must not pick up. */
    const bare = reqUrl.split('#')[0];
    const first = out.hops.find((h) => h.url === bare || h.url === reqUrl);
    if (first) {
      status = first.status;
      let loc = first.location || '';
      try {
        const want = new URL(reqUrl).hash;
        if (want && loc && !new URL(loc).hash) loc += want;
      } catch { /* keep loc */ }
      if (loc) headers.location = loc;
      body = '';
    }
  }
  if (!(status >= 200 && status <= 599)) throw new Error('browser fetch: no usable response for ' + reqUrl);
  return new Response(body, { status, headers });
}

async function browserFetch(url, { method = 'GET', headers = {}, body, redirect = 'follow', jar, timeout = 25000, fetchDest } = {}) {
  /* fetchDest: 'iframe' — reach the target through a hidden iframe so the
     request carries Sec-Fetch-Dest: iframe (dest-sensitive upstream routes). */
  const useIframe = fetchDest === 'iframe' && method === 'GET';
  return serialize(async () => {
    let lastErr = null;
    /* One retry after a 403: the challenge body never executes inside fetch(),
       so reopen the page on the origin to re-solve before retrying. */
    for (let attempt = 0; attempt < 2; attempt++) {
      const s = await ensurePage();
      const p = s.page;
      const session = s.cdp;
      if (jar && jar.size && session) {
        const cookies = [...jar.c.entries()].map(([name, value]) => ({ name, value, url: new URL(url).origin + '/' }));
        if (cookies.length) await session.send('Network.setCookies', { cookies }).catch(() => {});
      }
      /* fetch() refuses to set Referer itself; CDP extra headers can, and the
         origin sees the watch page it expects on player POSTs. Navigations
         (iframe path) carry their own referer and don't need the override. */
      if (!useIframe && headers.referer) await p.setExtraHTTPHeaders({ referer: headers.referer }).catch(() => {});
      let out;
      try {
        out = useIframe
          ? await iframeFetchInPage(p, url, Math.max(5000, timeout - 1000))
          : await fetchInPage(p, url, method, headers, body, Math.max(5000, timeout - 1000));
      } catch (e) {
        lastErr = e;
        await p.setExtraHTTPHeaders({}).catch(() => {});
        await freshPage().catch(() => {}); // a hung page poisons the next call too
        continue;
      }
      await p.setExtraHTTPHeaders({}).catch(() => {});
      if (out.error) {
        lastErr = new Error('browser fetch: ' + out.error);
        if (!(redirect === 'manual' && out.hops && out.hops.length)) continue;
        out.status = out.status || 0;
      }
      if (out.status === 403 && attempt === 0 && !(out.hops && out.hops.length)) {
        await freshPage().catch(() => {}); // re-solve, then retry once
        continue;
      }
      if (session && jar) {
        const got = await session.send('Network.getCookies', { urls: [url] }).catch(() => null);
        if (got && got.cookies) jar.absorbPairs(got.cookies);
      }
      return buildResponse(out, url, redirect);
    }
    throw lastErr || new Error('browser fetch failed: ' + url);
  });
}

/* Diagnostic: watch the challenge page evolve — a timeline of title/url/
   cookie state, the widget DOM, console output and page errors — until it
   clears or the budget runs out. Distinguishes "script never runs", "solves
   but clearance withheld" and "needs interaction". */
async function browserDiag() {
  const out = { timeline: [], console: [], errors: [], bad: [], chl: [] };
  const t0 = Date.now();
  let lastSnap = 0;
  const hooks = { console: out.console, errors: out.errors, bad: out.bad, chl: out.chl };
  hooks.onTick = async (title) => {
    if (Date.now() - lastSnap < 1500) return;
    lastSnap = Date.now();
    const snap = { ms: Date.now() - t0, title: String(title || '').slice(0, 70), url: (page ? page.url() : '').slice(0, 100) };
    try {
      const c = await cdp.send('Network.getCookies', { urls: [BASE] });
      snap.cookies = c.cookies.map((x) => x.name + '=' + (x.name === 'cf_clearance' ? x.value.slice(0, 10) : ''));
    } catch { snap.cookies = null; }
    try {
      const dom = await page.evaluate(() => ({
        turnstile: !!document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"]'),
        checkboxes: document.querySelectorAll('input[type=checkbox]').length,
        cfOpt: !!window._cf_chl_opt,
        uad: navigator.userAgentData ? navigator.userAgentData.brands.map((b) => b.brand + '/' + b.version).join(',') : null,
        ua: navigator.userAgent.slice(0, 90),
        webdriver: navigator.webdriver,
        plugins: navigator.plugins ? navigator.plugins.length : 0
      }));
      Object.assign(snap, dom);
    } catch { /* navigation race */ }
    out.timeline.push(snap);
    /* One-shot deep inspection on the first tick: the challenge mode and the
       rendered widget decide whether this is an auto-solve or a click. */
    if (!out.opt) {
      try {
        out.opt = await page.evaluate(() => {
          const o = window._cf_chl_opt || {};
          const sel = ['#challenge-stage', '#challenge-form', '.ctp-checkbox-container', '[id^=cf-chl]', '#turnstile-wrapper'];
          let widget = null;
          for (const s of sel) { const el = document.querySelector(s); if (el) { widget = { sel: s, html: el.outerHTML.slice(0, 400) }; break; } }
          return {
            cType: o.cType, cRay: o.cRay, sUrl: o.sUrl, cZone: o.cZone,
            widget,
            iframes: [...document.querySelectorAll('iframe')].map((f) => (f.src || '(nosrc)').slice(0, 110)),
            bodyLen: (document.body && document.body.innerHTML || '').length
          };
        });
        out.frames = page.frames().map((f) => f.url().slice(0, 110));
      } catch { /* navigation race */ }
    }
  };
  try {
    await freshPage(hooks);
    /* freshPage stops at 20s — keep watching past the first reload. */
    const extra = Date.now() + 15000;
    while (Date.now() < extra) {
      const t = await page.title().catch(() => '');
      await hooks.onTick(t).catch(() => {});
      if (t && !CHALLENGE_RX.test(t)) break;
      await sleep(800);
    }
    out.solved = await pageHealthy();
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  out.ms = Date.now() - t0;
  return out;
}

module.exports = { browserFetch, buildResponse, browserDiag };
