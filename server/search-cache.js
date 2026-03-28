const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const SEARCH_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'jammin-cache.sqlite');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;

  CREATE TABLE IF NOT EXISTS search_cache (
    query TEXT NOT NULL,
    results TEXT NOT NULL,
    nextPageToken TEXT,
    createdAt INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_search_cache_query
    ON search_cache(query);
`);

const selectSearchCacheStmt = db.prepare(`
  SELECT query, results, nextPageToken, createdAt
  FROM search_cache
  WHERE query = ?
  LIMIT 1
`);

const upsertSearchCacheStmt = db.prepare(`
  INSERT INTO search_cache (query, results, nextPageToken, createdAt)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(query) DO UPDATE SET
    results = excluded.results,
    nextPageToken = excluded.nextPageToken,
    createdAt = excluded.createdAt
`);

const deleteSearchCacheStmt = db.prepare(`
  DELETE FROM search_cache
  WHERE query = ?
`);

const purgeExpiredSearchCacheStmt = db.prepare(`
  DELETE FROM search_cache
  WHERE createdAt <= ?
`);

function normalizeSearchQuery(query) {
  return String(query || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function buildSearchCacheKey(query, pageToken = '') {
  const normalizedQuery = normalizeSearchQuery(query);
  if (!normalizedQuery) return '';

  const safePageToken = String(pageToken || '').trim();
  return safePageToken
    ? `${normalizedQuery}::page:${safePageToken}`
    : normalizedQuery;
}

function purgeExpiredSearchCache(now = Date.now()) {
  purgeExpiredSearchCacheStmt.run(now - SEARCH_CACHE_TTL_MS);
}

function getSearchCache(query, pageToken = '') {
  const cacheKey = buildSearchCacheKey(query, pageToken);
  if (!cacheKey) return null;

  purgeExpiredSearchCache();

  const row = selectSearchCacheStmt.get(cacheKey);
  if (!row) return null;

  try {
    const results = JSON.parse(row.results);
    if (!Array.isArray(results)) {
      deleteSearchCacheStmt.run(cacheKey);
      return null;
    }

    return {
      query: row.query,
      results,
      nextPageToken: row.nextPageToken || null,
      createdAt: Number(row.createdAt || 0),
    };
  } catch (error) {
    deleteSearchCacheStmt.run(cacheKey);
    return null;
  }
}

function setSearchCache(query, pageToken = '', payload = {}) {
  const cacheKey = buildSearchCacheKey(query, pageToken);
  if (!cacheKey || !Array.isArray(payload.items)) return null;

  const createdAt = Date.now();
  upsertSearchCacheStmt.run(
    cacheKey,
    JSON.stringify(payload.items),
    payload.nextPageToken || null,
    createdAt
  );

  return {
    query: cacheKey,
    results: payload.items,
    nextPageToken: payload.nextPageToken || null,
    createdAt,
  };
}

module.exports = {
  SEARCH_CACHE_TTL_MS,
  buildSearchCacheKey,
  getSearchCache,
  normalizeSearchQuery,
  purgeExpiredSearchCache,
  setSearchCache,
};
