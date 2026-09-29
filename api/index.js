/* Vercel serverless entry point for AnimeWit.
   Thin wrapper around the shared request handler in ../server.js — no duplicated logic. */

'use strict';

console.log('[animewit] function cold start');

const { handleRequest } = require('../server.js');

module.exports = (req, res) => {
  return Promise.resolve(handleRequest(req, res)).catch((err) => {
    console.error('[animewit] handler error:', err && (err.stack || err.message));
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'internal_error', message: String((err && err.message) || err) }));
    }
  });
};
