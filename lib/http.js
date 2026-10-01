'use strict';
/* HTTP primitives: static file serving (brotli/gzip precompressed), JSON/data responses. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { PUBLIC_DIR } = require('./config');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon'
};

const staticCache = new Map();

function getStaticFile(fullPath) {
  try {
    const stats = fs.statSync(fullPath);
    const hit = staticCache.get(fullPath);
    if (hit && hit.mtime === stats.mtimeMs) return hit;

    const raw = fs.readFileSync(fullPath);
    const ext = path.extname(fullPath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const etag = '"' + crypto.createHash('md5').update(raw).digest('hex') + '"';
    const isCompressible = /text|javascript|json|svg|xml/.test(type);
    const gzip = isCompressible && raw.length > 256 ? zlib.gzipSync(raw, { level: 6 }) : null;
    const br = isCompressible && raw.length > 512
      ? zlib.brotliCompressSync(raw, {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length
          }
        })
      : null;

    const entry = { raw, gzip, br, type, etag, mtime: stats.mtimeMs };
    staticCache.set(fullPath, entry);
    return entry;
  } catch {
    return null;
  }
}

/* Versioned assets (?v=N) are immutable — everything else revalidates via ETag. */
function staticCacheControl(pathname) {
  return /[?&]v=\w+/.test(pathname) ? 'public, max-age=31536000, immutable' : 'no-cache, must-revalidate';
}

function acceptsEncoding(req, enc) {
  const accept = String((req.headers && req.headers['accept-encoding']) || '');
  if (enc === 'br') return /\bbr\b/.test(accept);
  return accept.includes(enc);
}

/* Pick the best precompressed variant for a static entry. */
function encodeStatic(entry, req) {
  if (entry.br && acceptsEncoding(req, 'br')) return { body: entry.br, encoding: 'br' };
  if (entry.gzip && acceptsEncoding(req, 'gzip')) return { body: entry.gzip, encoding: 'gzip' };
  return { body: entry.raw, encoding: null };
}

function sendData(req, res, code, payload, type = 'application/json; charset=utf-8', cache = 'no-store') {
  const isJson = type.startsWith('application/json');
  const body = isJson ? JSON.stringify(payload) : payload;
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headers = {
    'content-type': type,
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
    'access-control-allow-origin': '*'
  };

  if (buf.length > 380 && acceptsEncoding(req, 'gzip')) {
    headers['content-encoding'] = 'gzip';
    const compressed = zlib.gzipSync(buf, { level: 6 });
    headers['content-length'] = compressed.length;
    res.writeHead(code, headers);
    return res.end(compressed);
  }
  headers['content-length'] = buf.length;
  res.writeHead(code, headers);
  return res.end(buf);
}

function fail(req, res, err) {
  const code = err && err.code && Number(err.code) >= 400 && Number(err.code) < 600 ? Number(err.code) : 502;
  console.error('[API Error]', err && err.message);
  const body = { error: (err && err.message) || 'Upstream service error' };
  /* Deploy-config failures (no relay on a challenged network) ride along so
     the watch view can stop retrying and show the owner the one-command fix. */
  if (err && err.needsRelay) body.needsRelay = true;
  if (err && err.hint) body.hint = err.hint;
  sendData(req, res, code, body);
}

module.exports = { MIME, getStaticFile, staticCacheControl, encodeStatic, sendData, fail, PUBLIC_DIR };
