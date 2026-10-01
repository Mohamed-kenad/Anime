/* =========================================================================
   AnimeWit edge worker — stable public entry in front of the home relay.

   Why this exists: witanime.site challenges every datacenter network
   (Vercel and Cloudflare Workers included), so the actual fetching must
   leave from a residential IP. The home PC runs worker/relay.js behind a
   free quick tunnel whose URL changes on every boot; this worker holds a
   HOME_UPSTREAM secret pointing at the current tunnel URL, so the public
   address Vercel talks to (https://animewit-relay.<account>.workers.dev)
   never changes — a small watcher on the PC rewrites the secret whenever
   the tunnel URL changes.

   Contract with the app (lib/upstream.js): same as relay.js —
     GET <worker>/?url=<encoded target>  + header x-relay-token
   This worker validates the token, then forwards the request untouched to
   HOME_UPSTREAM, which runs the full allow-listed relay. When HOME_UPSTREAM
   is unset or unreachable it answers 503/502 with x-relay-error so the
   app's hop() falls through to its reader/browser legs (catalog keeps
   working, playback reports needsRelay).
   ========================================================================= */

const STRIP = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'content-length', 'accept-encoding',
  'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cf-worker', 'cf-ew-via',
  'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip', 'forwarded'
]);

function err(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-relay-error': String(status)
    }
  });
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const home = String(env.HOME_UPSTREAM || '').trim().replace(/\/+$/, '');

      if (url.pathname === '/' && !url.searchParams.has('url') && !url.pathname.startsWith('/https')) {
        return new Response(JSON.stringify({
          ok: true,
          service: 'animewit-edge',
          home: home || null,
          auth: !!env.RELAY_TOKEN
        }), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
        });
      }

      if (!home) {
        return err(503, { error: 'Home relay not configured — HOME_UPSTREAM is empty (tunnel down)' });
      }
      if (env.RELAY_TOKEN && request.headers.get('x-relay-token') !== env.RELAY_TOKEN) {
        return err(401, { error: 'Missing or wrong x-relay-token' });
      }

      const method = request.method || 'GET';
      const hasBody = !['GET', 'HEAD'].includes(method);
      const headers = new Headers();
      for (const [k, v] of request.headers) {
        if (!STRIP.has(k.toLowerCase())) headers.append(k, v);
      }

      const res = await fetch(home + url.pathname + url.search, {
        method,
        headers,
        body: hasBody ? await request.arrayBuffer() : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(45000)
      });

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers
      });
    } catch (e) {
      return err(502, { error: 'Edge forward failure', message: String((e && e.message) || e) });
    }
  }
};
