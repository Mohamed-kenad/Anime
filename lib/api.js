'use strict';
/* Public JSON API builders (home / search / detail / servers). */
const { BASE, TTL, VID_RX } = require('./config');
const { cacheGet, cacheSet } = require('./cache');
const { wt } = require('./upstream');
const { parseCards, parseHero, parseSections } = require('./parsers');
const { episodeIndex, vidInfo, sessionFor, listServers } = require('./catalog');

async function apiHome() {
  const hit = cacheGet('home');
  if (hit) return hit;
  const res = await wt(BASE + '/');
  if (!res.ok) throw Object.assign(new Error('home ' + res.status), { code: 502 });
  const html = await res.text();
  const sections = parseSections(html);
  let hero = parseHero(html);
  if (!hero.length) {
    hero = sections.flatMap((s) => s.items).filter((x) => x.poster).slice(0, 6).map((x) => ({
      kind: x.kind,
      slug: x.slug,
      ep: x.ep || null,
      href: x.href,
      title: x.title,
      banner: x.poster,
      poster: x.poster,
      meta: x.rating ? '★ ' + x.rating : '',
      description: ''
    }));
  }
  const out = { sections, hero };
  return cacheSet('home', out, TTL.home);
}

async function apiSearch(q) {
  const key = 'search:' + q.toLowerCase();
  const hit = cacheGet(key);
  if (hit) return hit;
  const res = await wt(`${BASE}/search.php?keywords=${encodeURIComponent(q)}`);
  if (!res.ok) throw Object.assign(new Error('search ' + res.status), { code: 502 });
  const html = await res.text();
  const items = parseCards(html);
  const seen = new Set();
  const uniq = items.filter((x) => {
    const k = x.kind + '/' + (x.slug || x.href);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return cacheSet(key, { items: uniq.slice(0, 30) }, TTL.search);
}

function seriesDetail(idx, slug, kind) {
  return {
    slug,
    kind: kind || 'anime',
    url: idx.url,
    title: idx.title,
    altTitle: null,
    description: idx.description || '',
    poster: idx.poster || '',
    banner: idx.poster || '',
    genres: idx.genres || [],
    year: idx.year || null,
    episodesCount: idx.episodes.length,
    studio: idx.studio || null,
    country: null,
    episodes: idx.episodes
  };
}

async function apiAnime(slug, kind) {
  const key = 'anime:' + (kind || 'anime') + '/' + slug;
  const hit = cacheGet(key);
  if (hit) return hit;

  let out = null;

  if (VID_RX.test(slug)) {
    const info = await vidInfo(slug);
    if (info && info.seriesSlug && kind !== 'movie') {
      // an episode video → serve its series with the full episode index
      const idx = await episodeIndex(info.seriesSlug);
      out = seriesDetail(idx, slug, kind || 'anime');
    } else if (info) {
      // standalone movie / special → single-entry detail
      out = {
        slug,
        kind: kind === 'movie' ? 'movie' : (kind || 'anime'),
        url: info.url,
        title: info.title,
        altTitle: null,
        description: info.description || '',
        poster: info.poster || '',
        banner: info.poster || '',
        genres: info.genres || [],
        year: info.year || null,
        episodesCount: 1,
        studio: null,
        country: null,
        episodes: [{ n: 1, slug, url: info.url, label: 'Full Movie' }]
      };
    }
    // info === null → not a video id (hex-looking series slug) → series path below
  }

  if (!out) {
    const idx = await episodeIndex(slug);
    out = seriesDetail(idx, slug, kind || 'anime');
  }

  return cacheSet(key, out, TTL.anime);
}

async function apiServers(slug, ep) {
  const key = 'srv:' + slug + ':' + ep;
  const hit = cacheGet(key);
  if (hit) return hit;
  const s = await sessionFor(slug, ep);
  const servers = listServers(s.sources);
  return cacheSet(key, { slug, ep, servers }, TTL.session);
}

module.exports = { apiHome, apiSearch, apiAnime, apiServers, seriesDetail };
