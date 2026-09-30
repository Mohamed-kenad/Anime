'use strict';
/* HTML scrapers for witanime.site markup (Laravel blade + Tailwind cards). */
const { classifyLink, stripTags, absUrl } = require('./util');

/* ---------------- Cards ---------------- */
/* Uniform card shape on home rails, search grids and rankings:
   <a ... href="https://witanime.site/{anime|movie|watch}/...">
     <div ...><img src="https://images.witanime.site/posters/..." alt="Title"></div>
     <h3 ...>Title</h3> <div ...><span>1999</span> ...</div>
   </a>
   The h2 title links in rankings carry no <img> → skipped by the img guard. */
/* Score sits right after the star <svg class="ic"> in every card / header. */
const RATING_RE = /M9\.049[\s\S]{0,900}?<\/svg>\s*(\d+(?:\.\d+)?)/;

function extractRating(html) {
  const m = html.match(RATING_RE);
  return m ? m[1] : null;
}

function scanCards(html) {
  const out = [];
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const target = classifyLink(m[1]);
    if (!target) continue;
    const body = m[2];
    const img = body.match(/<img[^>]*\bsrc="([^"]+)"/);
    if (!img) continue; // nav/heading anchors without art
    const alt = (body.match(/<img[^>]*\balt="([^"]*)"/) || [])[1] || '';
    const h3 = (body.match(/<h3[^>]*>([\s\S]*?)<\/h3>/) || [])[1];
    const trunc = body.match(/<span[^>]*class="[^"]*truncate[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    const title = stripTags(h3) || stripTags(alt) || (trunc ? stripTags(trunc[1]) : '') || '';
    if (!title) continue;

    const text = stripTags(body);
    const year = (text.match(/\b(?:19|20)\d{2}\b/) || [])[0] || null;

    const card = {
      kind: target.kind,
      slug: target.slug,
      href: absUrl(m[1]),
      poster: absUrl(img[1]),
      banner: '',
      title,
      rating: extractRating(body),
      year,
      audio: 'مترجم',
      i: m.index
    };

    if (target.kind === 'watch') {
      card.ep = target.ep || null;
      if (target.movie || target.ep == null) {
        card.kind = 'movie';
        card.type = 'Movie';
        card.ep = null;
      } else {
        card.label = 'الحلقة ' + card.ep;
        card.type = 'Episode';
      }
    } else {
      card.type = target.kind === 'movie' ? 'Movie' : 'TV';
    }
    out.push(card);
  }
  return out;
}

function parseCards(html) {
  return scanCards(html).map((c) => { const { i, year, ...rest } = c; return rest; });
}

/* Hero: the only banner art on the page (og:image + spotlight slides). */
function parseHero(html) {
  const out = [];
  const seen = new Set();
  for (const c of scanCards(html)) {
    if (seen.has(c.kind + '/' + c.slug)) continue;
    seen.add(c.kind + '/' + c.slug);
    out.push({
      kind: c.kind, slug: c.slug, ep: c.ep || null, href: c.href,
      title: c.title, banner: c.poster, poster: c.poster,
      meta: [c.rating ? '★ ' + c.rating : '', c.year].filter(Boolean).join(' · '),
      rating: c.rating, description: ''
    });
    if (out.length >= 8) break;
  }
  return out;
}

/* ---------------- Sections ---------------- */
const SECTION_KEYS = [
  { re: /الأكثر\s+مشاهدة/, key: 'trending', en: 'Trending Anime' },
  { re: /أحدث\s+الحلقات/, key: 'latest', en: 'Latest Episodes' },
  { re: /أحدث\s+(?:الأفلام|افلام)/, key: 'movies', en: 'Latest Movies' },
  { re: /أنميات\s+قادمة/, key: 'upcoming', en: 'Upcoming Anime' },
  { re: /أكثر\s+الأنميات\s+مشاهدة/, key: 'top', en: 'Top Anime' },
  { re: /أكثر\s+(?:الأفلام|افلام)\s+مشاهدة/, key: 'topMovies', en: 'Top Movies' },
  { re: /أشهر\s+أنميات\s+الموسم/, key: 'seasonal', en: 'Current Season' },
  { re: /تابع\s+المشاهدة/, key: 'continue', en: 'Continue Watching' },
  /* legacy animezid headings kept for cached fixtures */
  { re: /أحدث\s+الإضافات/, key: 'latest', en: 'Latest Episodes' },
  { re: /أحدث\s+حلقات\s+الأنمي/, key: 'seasonal', en: 'Current Season' }
];

function sectionMark(text) {
  for (const s of SECTION_KEYS) if (s.re.test(text)) return s;
  return null;
}

/* Split the page into titled sections. Item-h2 titles (spotlight grids) are
   not section headings — cards are assigned to the nearest *known* heading
   above them; cards above the first heading become a synthetic "Top" section. */
function parseSections(html) {
  const heads = [];
  const hre = /<h2\b[^>]*>([\s\S]*?)<\/h2>/g;
  let hm;
  while ((hm = hre.exec(html))) {
    const text = stripTags(hm[1]);
    const mark = sectionMark(text);
    if (mark) heads.push({ i: hm.index, text, ...mark });
  }

  const cards = scanCards(html);
  const sections = [];
  const byKey = new Map();
  const ensure = (key, title, en) => {
    if (!byKey.has(key)) {
      const s = { key, title, enTitle: en, items: [] };
      byKey.set(key, s);
      sections.push(s);
    }
    return byKey.get(key);
  };

  const top = { key: 'top', title: 'الأكثر مشاهدة', enTitle: 'Top Anime', items: [] };
  let active = null;
  let hi = 0;
  for (const c of cards) {
    while (hi < heads.length && heads[hi].i < c.i) {
      active = ensure(heads[hi].key, heads[hi].text, heads[hi].en);
      hi++;
    }
    const target = active || top;
    if (target.items.length < 24) {
      const { i, year, ...rest } = c;
      target.items.push(rest);
    }
  }
  if (!active && !sections.length && top.items.length) sections.push(top);
  else if (top.items.length) sections.unshift(top);

  return sections.filter((s) => s.items.length);
}

/* ---------------- JSON-LD ---------------- */
function parseJsonLdNodes(html) {
  const out = [];
  const re = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const j = JSON.parse(m[1]);
      if (Array.isArray(j)) out.push(...j);
      else if (j && Array.isArray(j['@graph'])) out.push(...j['@graph']);
      else if (j) out.push(j);
    } catch { /* skip malformed */ }
  }
  return out;
}

/* Balanced-brace extraction of the first JSON-LD block (kept for tests) */
function parseJsonLd(html) {
  const idx = html.indexOf('application/ld+json');
  if (idx < 0) return null;
  const open = html.indexOf('{', idx);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    const c = html[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(open, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

/* ---------------- Series / movie detail ---------------- */
function ogMeta(html, p) {
  return (html.match(new RegExp(`<meta[^>]+property="og:${p}"[^>]+content="([^"]*)"`, 'i')) || [])[1]
    || (html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+property="og:${p}"`, 'i')) || [])[1];
}

function parseSeriesPage(html, slug) {
  const nodes = parseJsonLdNodes(html);
  const main = nodes.find((x) => x && (x['@type'] === 'TVSeries' || x['@type'] === 'Movie')) || {};

  const h1 = stripTags((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1]);
  const ogTitle = stripTags(ogMeta(html, 'title') || '');
  const title = h1
    || ogTitle.replace(/^جميع حلقات\s+(?:انمي\s+)?/, '').replace(/\s+(?:مترجمة?\s+)?أون لاين.*$/, '').replace(/\s*[|\-–].*$/, '')
    || slug.replace(/-/g, ' ');

  const genres = (Array.isArray(main.genre) ? main.genre : (main.genre ? [main.genre] : []))
    .map((g) => stripTags(String(g)).trim()).filter(Boolean);
  if (!genres.length) {
    const re = /<a[^>]+href="[^"]*\/genres?\/[^"?#]+[^"]*"[^>]*>([^<]{2,40})<\/a>/g;
    let g;
    while ((g = re.exec(html))) {
      const name = stripTags(g[1]).trim();
      if (name && !genres.includes(name)) genres.push(name);
      if (genres.length >= 8) break;
    }
  }

  const rawDate = main.dateCreated || main.startDate || ogMeta(html, 'updated_time') || '';
  const year = ((String(rawDate).match(/\b(?:19|20)\d{2}\b/) || [])[0]) || null;
  const posterOg = ogMeta(html, 'image') || '';
  const posterM = html.match(/https?:\/\/images\.witanime\.site\/posters\/[^"'\s)]+/);
  const poster = posterM ? posterM[0] : posterOg;
  const description = stripTags(main.description || ogMeta(html, 'description') || '')
    .replace(/\s*على موقع\s+WitAnime\.?\s*$/, '').replace(/\s{2,}/g, ' ').slice(0, 600);

  return {
    title,
    poster: absUrl(poster),
    banner: absUrl(posterOg),
    description,
    genres,
    year,
    rating: extractRating(html),
    studio: main.productionCompany && main.productionCompany.name ? main.productionCompany.name : null,
    seasons: [1]
  };
}

/* ---------------- Episodes ---------------- */
/* Flat episode list rendered on the anime page (all seasons in one grid);
   movies expose a single /watch/movie/{slug} playback link. */
function parseEpisodes(html, slug) {
  const out = [];
  const seen = new Set();
  const re = /href="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const t = classifyLink(m[1]);
    if (!t || t.kind !== 'watch' || t.slug !== slug) continue;
    if (t.movie) {
      if (!out.length) out.push({ n: 1, wpath: `/watch/movie/${slug}`, movie: true });
      continue;
    }
    const n = t.ep;
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push({ n, wpath: `/watch/${slug}/${n}` });
  }
  out.sort((a, b) => a.n - b.n);
  return out;
}

/* ---------------- Related / recommended ---------------- */
/* The detail page carries two card rails after the episode grid:
   <h2>ذات صلة</h2> (related) and <h2>قد يعجبك أيضًا</h2> (you may also like).
   Both use the standard card markup, so slice from the first of those
   headings and reuse scanCards(); fall back to the whole page (detail pages
   only wrap cards in anchors inside these rails). */
function parseRelated(html, slug) {
  const hre = /<h2\b[^>]*>([\s\S]*?)<\/h2>/g;
  let start = 0;
  let hm;
  while ((hm = hre.exec(html))) {
    const text = stripTags(hm[1]);
    if (/ذات\s*صلة|قد\s*يعجبك/.test(text)) { start = hm.index; break; }
  }

  const out = [];
  const seen = new Set();
  for (const c of scanCards(html.slice(start))) {
    if (c.kind !== 'anime' && c.kind !== 'movie') continue;
    if (!c.slug || c.slug === slug) continue;
    const key = c.kind + '/' + c.slug;
    if (seen.has(key)) continue;
    seen.add(key);
    const { i, ...rest } = c;
    out.push(rest);
    if (out.length >= 16) break;
  }
  return out;
}

/* Legacy name kept so server.js exports stay stable (az-card era is gone). */
function parseSeasonPage() { return []; }

module.exports = { parseCards, parseHero, parseSections, parseJsonLd, parseJsonLdNodes, parseSeriesPage, parseEpisodes, parseRelated, parseSeasonPage };
