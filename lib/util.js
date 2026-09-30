'use strict';
/* Shared helpers: typed errors, HTML text extraction, link classification. */
const { BASE } = require('./config');

/* ---------------- Typed upstream errors (mapped to HTTP status by fail()) ---------------- */
const errWith = (code, msg) => Object.assign(new Error(msg), { code });
const err404 = (m) => errWith(404, m);
const err429 = (m) => errWith(429, m);
const err502 = (m) => errWith(502, m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- HTML text helpers ---------------- */
const decodeEnt = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));

const stripTags = (s) => decodeEnt(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function absUrl(u) {
  if (!u) return '';
  if (u.startsWith('http')) return u;
  if (u.startsWith('//')) return 'https:' + u;
  return BASE + (u.startsWith('/') ? u : '/' + u);
}

/* First anchor inside a card/hero body (prefers the primary link classes). */
function firstAnchor(body) {
  const link = body.match(/<a\b[^>]*class="[^"]*az-card__link[^"]*"[^>]*>/)
    || body.match(/<a\b[^>]*class="[^"]*az-showcase-card__link[^"]*"[^>]*>/)
    || body.match(/<a\b[^>]*>/);
  if (!link) return null;
  return (link[0].match(/\bhref="([^"]+)"/) || [])[1] || null;
}

/* Map an upstream href to the local route model (witanime.site):
   /anime/{slug}  series detail       /movie/{slug}  movie detail
   /watch/{slug}/{n}  episode         /watch/movie/{slug}  movie playback */
function classifyLink(href) {
  if (!href) return null;
  if (/^https?:/i.test(href) && !/\/\/([^/]*\.)?witanime\.site(\/|$)/i.test(href)) return null;
  let m;
  if ((m = href.match(/\/watch\/movie\/([^/"#?]+)(?:[/?#]|$)/))) return { kind: 'watch', slug: decodeURIComponent(m[1]), ep: 1, movie: true };
  if ((m = href.match(/\/watch\/([^/"#?]+)\/(\d+)(?:[/?#]|$)/))) return { kind: 'watch', slug: decodeURIComponent(m[1]), ep: Number(m[2]) };
  if ((m = href.match(/\/anime\/([^/"#?]+)(?:[/?#]|$)/))) return { kind: 'anime', slug: decodeURIComponent(m[1]) };
  if ((m = href.match(/\/movie\/([^/"#?]+)(?:[/?#]|$)/))) return { kind: 'movie', slug: decodeURIComponent(m[1]) };
  return null;
}

/* Text inside an html window, without tags — used for badge values */
function windowText(body, anchor, span = 220) {
  const i = body.indexOf(anchor);
  return i < 0 ? '' : stripTags(body.slice(i, i + span));
}

/* Normalize upstream ribbon/title wording into the three audio states:
   بالمصري (Egyptian dub) > مدبلج (dubbed, incl. فصحى) > مترجم (subtitled) */
function pickAudio(s) {
  s = String(s || '');
  if (/مصري/.test(s)) return 'بالمصري';
  if (/فصح/.test(s)) return 'مدبلج';
  if (/مدبلج|دبلج/.test(s)) return 'مدبلج';
  if (/مترجم/.test(s)) return 'مترجم';
  return null;
}

/* Run fn over a list with bounded concurrency */
async function pooled(list, limit, fn) {
  const results = new Array(list.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, list.length)) }, async () => {
    while (next < list.length) {
      const i = next++;
      results[i] = await fn(list[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

module.exports = {
  errWith, err404, err429, err502, sleep,
  decodeEnt, stripTags, absUrl, firstAnchor, classifyLink, windowText,
  pickAudio, pooled
};
