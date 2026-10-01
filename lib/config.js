'use strict';
/* Static configuration for AnimeWit — every tunable in one place. */
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || Number(process.argv[2]) || 3000;
const BASE = (process.env.UPSTREAM_BASE || 'https://witanime.site').replace(/\/+$/, '');
const IMAGE_BASE = (process.env.UPSTREAM_IMAGES || 'https://images.witanime.site').replace(/\/+$/, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/* public/ lives next to server.js (repo root); fall back to the repo root itself. */
const REPO_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = fs.existsSync(path.join(REPO_ROOT, 'public')) ? path.join(REPO_ROOT, 'public') : REPO_ROOT;

const TTL = {
  home: 3 * 60e3,         // 3 min
  search: 5 * 60e3,       // 5 min
  anime: 10 * 60e3,       // 10 min
  index: 30 * 60e3,       // full series episode index (expensive to rebuild)
  vid: 24 * 60 * 60e3,    // watch.php metadata for a video id
  session: 12 * 60e3,     // playback session
  embed: 5 * 60e3,        // resolved embed target (launch urls expire fast)
  stream: 5 * 60e3,       // extracted direct stream + its hotlink probe result
  sitemap: 60 * 60e3      // generated sitemap
};

const MAX_REQ_PER_MIN = Number(process.env.UPSTREAM_RPM) || 120;      // safe rate limit for upstream witanime
const MAX_QUEUE_WAIT = Number(process.env.UPSTREAM_MAX_WAIT_MS) || 5000; // never stall a request past this (serverless timeouts)
const PAGE_SIZE = 60;      // episode cards per season page
const MAX_SEASON_PAGES = 40; // safety cap per season

/* Video ids on witanime are short lowercase hex (?vid=080a53aa1); series slugs rarely collide. */
const VID_RX = /^[a-f0-9]{7,12}$/;
/* Playback source ids look like src_94r0owuTnPtbS7Y7x1khM0hZrRD4wyuL_1w_WdyhdC8 */
const TOKEN_RX = /^[A-Za-z0-9_\-.|:+/]{4,200}$/;

/* Optional Cloudflare Worker that reaches the upstream from a network the
   origin does not challenge (Vercel egress is answered with a JS challenge, so
   every fetch there — pages and player POSTs alike — would otherwise 403).
   Empty means "fetch directly", which is what a normal residential machine does. */
const RELAY = (process.env.UPSTREAM_RELAY || '').trim().replace(/\/+$/, '');
const RELAY_TOKEN = (process.env.UPSTREAM_RELAY_TOKEN || '').trim();
const relayHost = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return null; } };
const RELAY_HOSTS = [...new Set([
  ...String(process.env.UPSTREAM_RELAY_HOSTS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  relayHost(BASE),
  relayHost(IMAGE_BASE)
].filter(Boolean))];

/* Last-resort page relay: a browser-rendering reader, used only when neither a
   direct fetch nor the Worker above can get past the origin's JS challenge.
   It returns the rendered HTML (no cookies), so it unblocks browsing but never
   the cookie-bound player POSTs — those need RELAY. Empty disables it. */
const JINA = ('UPSTREAM_JINA' in process.env ? process.env.UPSTREAM_JINA : 'https://r.jina.ai').trim().replace(/\/+$/, '');
const JINA_KEY = (process.env.UPSTREAM_JINA_KEY || '').trim();

/* In-function headless-browser leg (lib/browser.js): the only path that clears
   the origin's managed challenge from a challenged network, because the
   challenge script runs for real, on this function's own egress IP. Vercel's
   egress has repeatedly failed this challenge, so avoid spending request time
   on it there unless explicitly enabled.
     auto  — run it only when an earlier leg came back blocked (local default)
     force — put it first in the chain (exercises the leg on a healthy network)
     off   — never launch a browser (keeps function size/startup down) */
const defaultBrowserMode = process.env.VERCEL ? 'off' : 'auto';
const BROWSER_MODE = (process.env.UPSTREAM_BROWSER || defaultBrowserMode).trim().toLowerCase();

const SITE_NAME = 'AnimeWit';
const DEFAULT_TITLE = 'AnimeWit — Watch Anime Online in HD';
const DEFAULT_DESCRIPTION = 'AnimeWit — Ultra-fast, clean anime streaming platform. Watch the latest subbed and dubbed anime, movies, and episodes in HD directly from the witanime.site catalog.';

module.exports = {
  PORT, BASE, IMAGE_BASE, UA,
  PUBLIC_DIR, TTL,
  MAX_REQ_PER_MIN, MAX_QUEUE_WAIT, PAGE_SIZE, MAX_SEASON_PAGES,
  VID_RX, TOKEN_RX,
  RELAY, RELAY_TOKEN, RELAY_HOSTS, JINA, JINA_KEY, BROWSER_MODE,
  SITE_NAME, DEFAULT_TITLE, DEFAULT_DESCRIPTION
};
