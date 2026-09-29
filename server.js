#!/usr/bin/env node
/* =========================================================================
   AnimeWit — entry point.
   All logic lives in lib/:
     lib/config.js    tunables           lib/cache.js     TTL cache + rate guard
     lib/upstream.js  rate-limited fetch lib/util.js      parsing helpers
     lib/parsers.js   HTML scrapers      lib/catalog.js   episodes + playback
     lib/api.js       JSON API           lib/image.js     image proxy
     lib/seo.js       head/robots/sitemap lib/http.js     compression + responses
     lib/router.js    request router
   This file only wires the HTTP server and the exports used by
   api/[...path].js (Vercel) and offline parser tests.
   ========================================================================= */
'use strict';
const http = require('http');
const { PORT } = require('./lib/config');
const { handleRequest } = require('./lib/router');
const { apiHome, apiSearch, apiAnime } = require('./lib/api');
const { apiServers } = require('./lib/api');
const { resolveEmbed } = require('./lib/catalog');
const { parseCards, parseHero, parseSections, parseSeriesPage, parseSeasonPage } = require('./lib/parsers');

const server = http.createServer((req, res) => {
  Promise.resolve(handleRequest(req, res)).catch((err) => {
    console.error('[Unhandled]', err && err.stack);
    if (!res.writableEnded) {
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });
});
/* Reuse sockets for bursty asset/JSON loads (Node defaults to 5s). */
server.keepAliveTimeout = 65e3;
server.headersTimeout = 70e3;

/* Warm the catalog cache in the background so the first visitor is fast. */
function warmCaches() {
  apiHome().catch(() => {});
}

if (require.main === module) {
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[Error] Port ${PORT} is already in use by another process.`);
      console.error(`Please close any existing process on port ${PORT} or run: node server.js ${PORT + 1}`);
      process.exit(1);
    } else {
      console.error('[Server Error]', err);
    }
  });

  server.listen(PORT, () => {
    console.log(`AnimeWit running with high performance → http://localhost:${PORT}`);
    warmCaches();
  });
}

/* Vercel loads this module as the function entry and requires the default export to be
   a function or an http.Server. Export the handler itself as the default, and hang the
   named exports off it (functions are objects, so both styles keep working). */
module.exports = handleRequest;
module.exports.default = handleRequest;
module.exports.handleRequest = handleRequest;
module.exports.server = server;
module.exports.apiHome = apiHome;
module.exports.apiSearch = apiSearch;
module.exports.apiAnime = apiAnime;
module.exports.apiServers = apiServers;
module.exports.resolveEmbed = resolveEmbed;
/* exposed for offline parsing tests */
module.exports.parseCards = parseCards;
module.exports.parseHero = parseHero;
module.exports.parseSections = parseSections;
module.exports.parseSeriesPage = parseSeriesPage;
module.exports.parseSeasonPage = parseSeasonPage;
