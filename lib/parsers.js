'use strict';
/* HTML scrapers for animezid.cam markup (az-card / az-showcase / series pages). */
const { firstAnchor, classifyLink, windowText, stripTags, absUrl, pickAudio } = require('./util');

/* Upstream hero art is portrait-only (520x760) and some items arrive as TMDB
   w300 (300px wide). The desktop hero shows them full-bleed, so upgrade the
   known low-res TMDB sizes to w1280 (true HD) on the way in. */
function upscaleTmdb(u) {
  if (!u) return u;
  return String(u).replace(/image\.tmdb\.org\/t\/p\/w(?:200|300|342|500|780)\//, 'image.tmdb.org/t/p/w1280/');
}

/* Extract anime/episode cards from HTML chunks (az-card markup) */
function parseCards(html) {
  const out = [];
  const re = /<article class="az-card\b[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1];
    const href = firstAnchor(body);
    const target = classifyLink(href);
    if (!target) continue;

    const img = body.match(/<img[^>]*\bsrc="([^"]+)"/);
    const fallback = body.match(/<img[^>]*\bdata-fallback="([^"]+)"/);
    const alt = body.match(/<img[^>]*\balt="([^"]*)"/);
    const title = stripTags((body.match(/az-card__title[^>]*>([\s\S]*?)<\//) || [])[1])
      || stripTags((alt || [])[1])
      || '';
    if (!title) continue;

    const epBadge = body.match(/az-badge--episode[\s\S]{0,240}?<strong>\s*(\d+)\s*<\/strong>/);
    const quality = stripTags((body.match(/az-badge--quality[^>]*>([^<]*)</) || [])[1]);
    const rating = (windowText(body, 'az-badge--rating').match(/\d+(?:\.\d+)?/) || [])[0] || null;
    const ribbonM = body.match(/az-badge--ribbon[^>]*>\s*<span>([^<]*)<\/span>/);
    const ribbon = ribbonM ? stripTags(ribbonM[1]) : '';
    const qualityIsAudio = pickAudio(quality);

    const card = {
      kind: target.kind,
      slug: target.slug,
      href: absUrl(href),
      poster: upscaleTmdb(absUrl(img ? img[1] : (fallback ? fallback[1] : ''))),
      banner: '',
      title,
      rating,
      audio: pickAudio(ribbon) || pickAudio(quality) || pickAudio(title) || 'مترجم'
    };

    if (target.kind === 'watch') {
      if (epBadge) {
        card.ep = Number(epBadge[1]);
        card.label = 'الحلقة ' + card.ep;
        card.type = 'Episode';
      } else {
        // watch link without an episode badge → a movie / standalone video
        card.kind = 'movie';
        card.ep = null;
        card.type = qualityIsAudio ? 'Movie' : (quality || 'Movie');
      }
    } else {
      card.type = qualityIsAudio ? 'TV' : (quality || 'TV');
    }
    out.push(card);
  }
  return out;
}

/* Parse Hero slider (az-showcase) from homepage */
function parseHero(html) {
  const out = [];
  const re = /<article class="az-showcase-card">([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1];
    const href = firstAnchor(body);
    const target = classifyLink(href);
    if (!target) continue;

    const img = body.match(/<img[^>]*\bsrc="([^"]+)"/);
    const alt = body.match(/<img[^>]*\balt="([^"]*)"/);
    const copy = stripTags((body.match(/az-showcase-card__copy[\s\S]{0,400}?<strong[^>]*>([\s\S]*?)<\/strong>/) || [])[1]);
    const title = copy || stripTags((alt || [])[1]);
    if (!title) continue;

    const rIdx = body.indexOf('az-showcase-card__rating');
    const rating = rIdx < 0 ? null : ((stripTags(body.slice(rIdx, rIdx + 220)).match(/\d+(?:\.\d+)?/) || [])[0] || null);
    const year = (title.match(/\b(?:19|20)\d{2}\b/) || [])[1];
    const epM = title.match(/الحلقة\s*(\d+)/);

    const item = {
      kind: target.kind,
      slug: target.slug,
      ep: null,
      href: absUrl(href),
      title,
      banner: upscaleTmdb(absUrl(img ? img[1] : '')),
      poster: upscaleTmdb(absUrl(img ? img[1] : '')),
      meta: [rating ? '★ ' + rating : null, year].filter(Boolean).join(' · '),
      description: ''
    };
    if (target.kind === 'watch') {
      if (epM) item.ep = Number(epM[1]);
      else item.kind = 'movie';
    }
    out.push(item);
    if (out.length >= 8) break;
  }
  return out;
}

/* Split page by <h2> into titled sections, mapping upstream Arabic titles to nav keys */
function parseSections(html) {
  const chunks = html.split(/<h2\b/);
  const sections = [];
  const used = new Set();
  const KEY_MAP = [
    [/الأكثر\s+مشاهدة/, 'trending', 'Trending Anime'],
    [/أحدث\s+الإضافات/, 'latest', 'Latest Episodes'],
    [/أحدث\s+الافلام|أحدث\s+الأفلام|أفلام\s+جديدة/, 'movies', 'Latest Movies'],
    [/^الأنمي$/, 'top', 'Top Anime'],
    [/أحدث\s+حلقات\s+الأنمي/, 'seasonal', 'Current Season']
  ];
  chunks.forEach((chunk, i) => {
    const end = chunk.indexOf('</h2>');
    if (end < 0) return;
    const headRaw = chunk.slice(0, end);
    const title = stripTags((headRaw.match(/>[\s\S]*$/) || [''])[0].replace(/^>/, ''));
    const body = chunk.slice(end + 5);
    const items = parseCards(body);
    if (!items.length) return;
    let key = 'section' + i;
    let enTitle = title;
    for (const [re, k, en] of KEY_MAP) {
      if (re.test(title) && !used.has(k)) {
        key = k;
        enTitle = en;
        break;
      }
    }
    used.add(key);
    sections.push({ key, title, enTitle, items: items.slice(0, 18) });
  });
  return sections;
}

/* Balanced-brace extraction of the first JSON-LD block */
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

/* Parse a series page (title/poster/synopsis/genres + season list) */
function parseSeriesPage(html, slug) {
  const og = (p) => (html.match(new RegExp(`<meta[^>]+property="og:${p}"[^>]+content="([^"]*)"`, 'i')) || [])[1]
    || (html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+property="og:${p}"`, 'i')) || [])[1];
  const ld = parseJsonLd(html) || {};
  const graph = Array.isArray(ld['@graph']) ? ld['@graph'] : [ld];
  const seriesLd = graph.find((x) => x && (x['@type'] === 'TVSeries' || x['@type'] === 'Movie')) || {};

  const h1 = stripTags((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1]);
  const title = h1 || stripTags(og('title') || '').replace(/\s*[|\-–]\s*(?:انمي زد|Anime Z).*/i, '') || slug.replace(/-/g, ' ');

  const genres = Array.isArray(seriesLd.genre) ? seriesLd.genre.slice()
    : (seriesLd.genre ? [seriesLd.genre] : []);
  if (!genres.length) {
    // no genre block on the page → fall back to the breadcrumb category
    const bcNav = (html.match(/<nav[^>]*class="[^"]*breadcrumb[^"]*"[\s\S]*?<\/nav>/) || [])[0] || '';
    const cat = (bcNav.match(/category\.php\?cat=[^"]*"[^>]*>([^<]+)</) || [])[1];
    if (cat) genres.push(stripTags(cat));
  }

  const seasonSet = new Set();
  const seasonRe = /\/series\/[^/"#?]+\/season\/(\d+)\//g;
  let sm;
  while ((sm = seasonRe.exec(html))) seasonSet.add(Number(sm[1]));
  const seasons = [...seasonSet].sort((a, b) => a - b);

  const rawYear = seriesLd.dateCreated || seriesLd.startDate
    || (windowText(html, 'az-series-stats').match(/\b(?:19|20)\d{2}\b/) || [])[0] || null;

  return {
    title,
    poster: upscaleTmdb(absUrl(seriesLd.image || og('image') || '')),
    description: stripTags(seriesLd.description || og('description') || '').slice(0, 600),
    genres,
    year: rawYear ? ((String(rawYear).match(/\b(?:19|20)\d{2}\b/) || [])[0] || null) : null,
    studio: seriesLd.productionCompany && seriesLd.productionCompany.name ? seriesLd.productionCompany.name : null,
    seasons: seasons.length ? seasons : [1]
  };
}

/* Parse one season page → [{slug: vid, badge}] in DOM order */
function parseSeasonPage(html) {
  const out = [];
  const re = /<article class="az-card\b[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1];
    const href = firstAnchor(body);
    const target = classifyLink(href);
    if (!target || target.kind !== 'watch') continue;
    const badge = body.match(/az-badge--episode[\s\S]{0,240}?<strong>\s*(\d+)\s*<\/strong>/);
    out.push({ slug: target.slug, badge: badge ? Number(badge[1]) : null });
  }
  return out;
}

module.exports = { parseCards, parseHero, parseSections, parseJsonLd, parseSeriesPage, parseSeasonPage };
