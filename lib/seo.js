'use strict';
/* SEO layer: server-rendered <head> per route (title/description/canonical/OG/JSON-LD),
   robots.txt and sitemap.xml generation. */
const { PUBLIC_DIR, TTL, SITE_NAME, DEFAULT_TITLE, DEFAULT_DESCRIPTION } = require('./config');
const { cacheGet, cacheSet } = require('./cache');
const { getStaticFile } = require('./http');
const { apiHome, apiAnime } = require('./api');
const { err404 } = require('./util');
const path = require('path');

/* ---------------- helpers ---------------- */
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const clip = (s, n) => {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1).trim() + '…' : s;
};

function siteUrl(req, p) {
  const proto = String((req.headers['x-forwarded-proto'] || 'http').split(',')[0]).trim() || 'http';
  const host = req.headers.host || 'localhost';
  return `${proto}://${host}${p}`;
}

function templateHtml() {
  const entry = getStaticFile(path.join(PUBLIC_DIR, 'index.html'));
  return entry ? entry.raw.toString('utf8') : '';
}

/* Tags injected where the template has <!--seo--> */
function headTags(req, meta) {
  const url = siteUrl(req, meta.path || '/');
  const tags = [];
  tags.push(`<link rel="canonical" href="${esc(url)}">`);
  tags.push(`<meta name="robots" content="${meta.noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large, max-snippet:-1'}">`);
  tags.push(`<meta property="og:site_name" content="${esc(SITE_NAME)}">`);
  tags.push(`<meta property="og:type" content="${meta.type || 'website'}">`);
  tags.push(`<meta property="og:title" content="${esc(meta.title || DEFAULT_TITLE)}">`);
  tags.push(`<meta property="og:description" content="${esc(meta.description || DEFAULT_DESCRIPTION)}">`);
  tags.push(`<meta property="og:url" content="${esc(url)}">`);
  if (meta.image) tags.push(`<meta property="og:image" content="${esc(meta.image)}">`);
  tags.push(`<meta name="twitter:card" content="${meta.image ? 'summary_large_image' : 'summary'}">`);
  tags.push(`<meta name="twitter:title" content="${esc(meta.title || DEFAULT_TITLE)}">`);
  tags.push(`<meta name="twitter:description" content="${esc(meta.description || DEFAULT_DESCRIPTION)}">`);
  if (meta.image) tags.push(`<meta name="twitter:image" content="${esc(meta.image)}">`);
  if (meta.jsonLd) {
    tags.push(`<script type="application/ld+json">${JSON.stringify(meta.jsonLd).replace(/</g, '\\u003c')}</script>`);
  }
  return tags.join('\n  ');
}

/* Build the full HTML shell with the route's head metadata. */
function renderShell(req, meta) {
  let html = templateHtml();
  const title = meta.title || DEFAULT_TITLE;
  const description = clip(meta.description || DEFAULT_DESCRIPTION, 300);
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  html = html.replace(/(<meta\s+name="description"\s+content=")[^"]*(")/, `$1${esc(description)}$2`);
  html = html.replace('<!--seo-->', headTags(req, meta));
  return html;
}

/* ---------------- route meta builders ---------------- */
function homeMeta(req) {
  return {
    title: DEFAULT_TITLE,
    description: DEFAULT_DESCRIPTION,
    path: '/',
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      name: SITE_NAME,
      url: siteUrl(req, '/'),
      description: DEFAULT_DESCRIPTION,
      potentialAction: {
        '@type': 'SearchAction',
        target: { '@type': 'EntryPoint', urlTemplate: siteUrl(req, '/search?q={search_term_string}') },
        'query-input': 'required name=search_term_string'
      }
    }
  };
}

function searchMeta(req, q) {
  return {
    title: q ? `Search “${clip(q, 40)}” — ${SITE_NAME}` : `Search — ${SITE_NAME}`,
    description: q ? `Browse anime results for “${clip(q, 80)}” on ${SITE_NAME}.` : `Search the ${SITE_NAME} anime catalog.`,
    path: '/search' + (q ? `?q=${encodeURIComponent(q)}` : ''),
    noindex: true
  };
}

function detailMeta(req, slug, kind, d) {
  const isMovie = kind === 'movie';
  const year = d.year ? ` (${d.year})` : '';
  const title = `${d.title}${year} — Watch ${isMovie ? 'Movie' : 'Anime'} Online | ${SITE_NAME}`;
  const description = d.description
    ? clip(d.description, 160)
    : `Watch ${d.title} online in HD with Arabic subtitles on ${SITE_NAME}. ${d.episodesCount} episodes available.`;
  const pathName = `/${isMovie ? 'movie' : 'anime'}/${encodeURIComponent(slug)}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': isMovie ? 'Movie' : 'TVSeries',
    name: d.title,
    description,
    url: siteUrl(req, pathName)
  };
  if (d.poster) jsonLd.image = d.poster;
  if (d.year) jsonLd.dateCreated = String(d.year);
  if (d.genres && d.genres.length) jsonLd.genre = d.genres;
  if (!isMovie && d.episodesCount) jsonLd.numberOfEpisodes = d.episodesCount;
  if (d.studio) jsonLd.productionCompany = { '@type': 'Organization', name: d.studio };
  return { title, description, path: pathName, image: d.poster || '', type: isMovie ? 'video.movie' : 'video.tv_show', jsonLd };
}

function watchMeta(req, slug, ep, d) {
  const epEntry = (d.episodes || []).find((e) => Number(e.n) === Number(ep));
  const epLabel = epEntry ? epEntry.label : `الحلقة ${ep}`;
  const title = `${d.title} — ${epLabel} | ${SITE_NAME}`;
  const description = clip(
    `Watch ${d.title} ${epLabel} online in HD on ${SITE_NAME}.` + (d.description ? ' ' + d.description : ''),
    160
  );
  const pathName = `/watch/${encodeURIComponent(slug)}/${Number(ep)}`;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'TVEpisode',
    name: `${d.title} — ${epLabel}`,
    description,
    url: siteUrl(req, pathName),
    episodeNumber: Number(ep),
    partOfSeries: { '@type': 'TVSeries', name: d.title }
  };
  if (d.poster) jsonLd.image = d.poster;
  if (d.genres && d.genres.length) jsonLd.genre = d.genres;
  return { title, description, path: pathName, image: d.poster || '', type: 'video.episode', jsonLd };
}

/* Detail/watch pages need upstream data; returns { meta, status }.
   Upstream 404 → 404 shell; transient upstream failure → default meta with 200. */
async function pageMeta(req, route) {
  try {
    if (route.view === 'anime') {
      const d = await apiAnime(route.slug, route.kind);
      if (!d || !d.title) throw err404('Not found');
      return { meta: detailMeta(req, route.slug, route.kind, d), status: 200 };
    }
    if (route.view === 'watch') {
      const d = await apiAnime(route.slug, 'anime');
      if (!d || !d.title) throw err404('Not found');
      return { meta: watchMeta(req, route.slug, route.ep, d), status: 200 };
    }
  } catch (err) {
    if (Number(err && err.code) === 404) {
      return {
        meta: { title: `Not Found — ${SITE_NAME}`, description: 'The page you requested does not exist.', path: route.path, noindex: true },
        status: 404
      };
    }
    console.error('[SEO] meta fallback:', err && err.message);
  }
  // transient upstream error → serve the shell, the client will render the view
  return {
    meta: { title: DEFAULT_TITLE, description: DEFAULT_DESCRIPTION, path: route.path, noindex: true },
    status: 200
  };
}

/* ---------------- robots + sitemap ---------------- */
function robotsTxt(req) {
  return `User-agent: *\nAllow: /\nDisallow: /api/\n\nSitemap: ${siteUrl(req, '/sitemap.xml')}\n`;
}

async function sitemapXml(req) {
  const host = req.headers.host || 'localhost';
  const key = 'sitemap:' + host;
  const hit = cacheGet(key);
  if (hit) return hit;

  const urls = [{ loc: siteUrl(req, '/'), changefreq: 'daily', priority: '1.0' }];
  try {
    const home = await apiHome();
    const seen = new Set();
    const items = home.sections.flatMap((s) => s.items).concat(home.hero || []);
    for (const it of items) {
      if (!it.slug) continue;
      let loc;
      if (it.kind === 'movie') loc = siteUrl(req, '/movie/' + encodeURIComponent(it.slug));
      else if (it.kind === 'anime') loc = siteUrl(req, '/anime/' + encodeURIComponent(it.slug));
      else continue; // episode links are discovery-only (noindex-adjacent)
      if (seen.has(loc)) continue;
      seen.add(loc);
      urls.push({ loc, changefreq: 'weekly', priority: '0.8' });
      if (urls.length >= 500) break;
    }
  } catch (err) {
    console.error('[SEO] sitemap upstream error:', err && err.message);
  }

  const today = new Date().toISOString().slice(0, 10);
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    + urls.map((u) => `  <url>\n    <loc>${esc(u.loc)}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`).join('\n')
    + '\n</urlset>\n';
  return cacheSet(key, xml, TTL.sitemap);
}

module.exports = { renderShell, homeMeta, searchMeta, pageMeta, robotsTxt, sitemapXml };
