/* Vercel serverless entry point for AnimeWit.
   Thin wrapper around the shared request handler in ../server.js — no duplicated logic.

   Vercel returns a bare FUNCTION_INVOCATION_FAILED (no detail) whenever this
   module throws, so every failure mode below is caught and reported as JSON.
   That way the actual cause is readable at /api/health instead of hidden in logs. */

'use strict';

let handleRequest = null;
let loadError = null;

try {
  const mod = require('../server.js');
  handleRequest = typeof mod.handleRequest === 'function' ? mod.handleRequest : null;
  if (!handleRequest) loadError = new Error('server.js did not export handleRequest');
} catch (err) {
  loadError = err;
}

console.log('[animewit] cold start', loadError ? 'LOAD_ERROR' : 'ok');

function report(req, res, code, payload) {
  let body;
  try {
    body = JSON.stringify(payload, null, 2);
  } catch {
    body = String(payload);
  }
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

module.exports = (req, res) => {
  if (loadError) {
    console.error('[animewit] load error:', loadError && (loadError.stack || loadError.message));
    return report(req, res, 500, {
      ok: false,
      stage: 'module_load',
      error: loadError.name,
      message: loadError.message,
      code: loadError.code || null,
      stack: String(loadError.stack || '').split('\n').slice(0, 8)
    });
  }

  return Promise.resolve()
    .then(() => handleRequest(req, res))
    .catch((err) => {
      console.error('[animewit] handler error:', err && (err.stack || err.message));
      if (!res.writableEnded) {
        report(req, res, 500, {
          ok: false,
          stage: 'handler',
          path: req.url,
          error: err.name,
          message: err.message,
          stack: String(err.stack || '').split('\n').slice(0, 8)
        });
      }
    });
};
