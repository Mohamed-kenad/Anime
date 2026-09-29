'use strict';
/* In-memory TTL cache + upstream rate guard. */
const { MAX_REQ_PER_MIN, MAX_QUEUE_WAIT } = require('./config');

/* ---------------- In-memory API cache ---------------- */
const store = new Map();

function cacheGet(key) {
  const h = store.get(key);
  if (!h) return null;
  if (Date.now() > h.exp) { store.delete(key); return null; }
  return h.v;
}

function cacheSet(key, v, ttl) {
  store.set(key, { v, exp: Date.now() + ttl });
  if (store.size > 250) {
    const now = Date.now();
    for (const [k, item] of store) {
      if (now > item.exp) store.delete(k);
    }
  }
  return v;
}

const cacheSize = () => store.size;

/* ---------------- Rate Guard ---------------- */
const hits = [];
function waitForSlot() {
  const now = Date.now();
  while (hits.length && now - hits[0] > 60e3) hits.shift();
  if (hits.length < MAX_REQ_PER_MIN) {
    hits.push(now);
    return Promise.resolve();
  }
  const wait = Math.min(60e3 - (now - hits[0]) + 60, MAX_QUEUE_WAIT);
  return new Promise((r) => setTimeout(r, wait)).then(() => {
    hits.push(Date.now());
  });
}

module.exports = { cacheGet, cacheSet, cacheSize, waitForSlot };
