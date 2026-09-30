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

const SITE_NAME = 'AnimeWit';
const DEFAULT_TITLE = 'AnimeWit — Watch Anime Online in HD';
const DEFAULT_DESCRIPTION = 'AnimeWit — Ultra-fast, clean anime streaming platform. Watch the latest subbed and dubbed anime, movies, and episodes in HD directly from the witanime.site catalog.';

module.exports = {
  PORT, BASE, IMAGE_BASE, UA,
  PUBLIC_DIR, TTL,
  MAX_REQ_PER_MIN, MAX_QUEUE_WAIT, PAGE_SIZE, MAX_SEASON_PAGES,
  VID_RX, TOKEN_RX,
  SITE_NAME, DEFAULT_TITLE, DEFAULT_DESCRIPTION
};
