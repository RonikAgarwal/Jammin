// Jammin — Main Server
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

loadEnvFile(path.join(__dirname, '..', '.env'));

const {
  createSession,
  joinSession,
  leaveSession,
  finalizeParticipantLeave,
  getSession,
  getSessionByWs,
  broadcast,
  getParticipantList,
  addChatMessage,
  getChatHistory,
  transferHost,
} = require('./session');

const {
  addToQueue,
  playNext,
  addPlaylistToQueue,
  playNextPlaylist,
  replaceQueueWithPlaylist,
  reorderQueue,
  removeFromQueue,
  removePlaylistGroup,
  playSelected,
  playPlaylistGroup,
  getQueueList,
  requeueHistoryItem,
  parseYouTubeUrl,
  parseYouTubePlaylistUrl,
} = require('./queue');

const {
  startPlayback,
  handlePlayerReady,
  handleVideoEnded,
  handleSeek,
  handlePause,
  handleResume,
  handleNewJoin,
  handleAdStart,
  handleAdEnd,
  handleGoLive,
  handleSkipTrack,
  handlePlayerError,
  handlePrevTrack,
} = require('./sync');

const { handleTimeReport } = require('./lag');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '';
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || '';
const CHAT_MESSAGE_LIMIT = 320;
const CHAT_RATE_LIMIT_MS = 400;
const YOUTUBE_SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const YOUTUBE_SUGGESTIONS_CACHE_TTL_MS = 15 * 60 * 1000;
const YOUTUBE_PLAYLIST_CACHE_TTL_MS = 15 * 60 * 1000;
const SPOTIFY_PLAYLIST_CACHE_TTL_MS = 20 * 60 * 1000;
const SPOTIFY_MATCH_CACHE_TTL_MS = 20 * 60 * 1000;
const PLAYLIST_PREVIEW_TRACKS = 5;
const PLAYLIST_IMPORT_MAX_TRACKS = 100;
const SPOTIFY_REVIEW_PAGE_SIZE = 12;
const SPOTIFY_REVIEW_MAX_TRACKS = 80;
const SPOTIFY_TOKEN_EARLY_REFRESH_MS = 60 * 1000;
const SPOTIFY_USER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SPOTIFY_AUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SPOTIFY_TRANSFER_TOKEN_TTL_MS = 5 * 60 * 1000;
const SPOTIFY_OAUTH_SCOPE = 'playlist-read-private playlist-read-collaborative';
const SPOTIFY_SESSION_COOKIE_NAME = 'jammin_spotify_sid';
const youtubeSearchCache = new Map();
const youtubeSuggestionsCache = new Map();
const youtubePlaylistPreviewCache = new Map();
const youtubePlaylistImportCache = new Map();
const youtubeVideoMetaCache = new Map();
const spotifyPlaylistMetaCache = new Map();
const spotifyPlaylistPageCache = new Map();
const spotifyTrackMatchCache = new Map();
const spotifyUserSessionStore = new Map();
const spotifyAuthStateStore = new Map();
const spotifySessionTransferStore = new Map();
let spotifyTokenState = {
  accessToken: '',
  expiresAt: 0,
};

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const raw = fs.readFileSync(filePath, 'utf8');
  raw.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) return;

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || process.env[key]) return;

    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  });
}

function parseCookieHeader(cookieHeader = '') {
  return String(cookieHeader || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((acc, part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex === -1) return acc;
      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      if (!key) return acc;
      acc[key] = decodeURIComponent(value);
      return acc;
    }, {});
}

function appendSetCookieHeader(res, cookieValue) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', cookieValue);
    return;
  }

  if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieValue]);
    return;
  }

  res.setHeader('Set-Cookie', [existing, cookieValue]);
}

function getRequestProtocol(req) {
  return String(req.get('x-forwarded-proto') || req.protocol || 'http')
    .split(',')[0]
    .trim() || 'http';
}

function getRequestOrigin(req) {
  return `${getRequestProtocol(req)}://${req.get('host')}`;
}

function resolveSpotifyRedirectUri(req) {
  if (SPOTIFY_REDIRECT_URI) {
    return SPOTIFY_REDIRECT_URI;
  }
  return `${getRequestOrigin(req)}/api/spotify/callback`;
}

function sanitizeReturnTo(value) {
  const raw = String(value || '/').trim();
  if (!raw) return '/';

  try {
    const parsed = new URL(raw, 'http://jammin.local');
    const next = `${parsed.pathname || '/'}${parsed.search || ''}${parsed.hash || ''}` || '/';
    if (!next.startsWith('/') || next.startsWith('/api/spotify/')) {
      return '/';
    }
    return next;
  } catch (error) {
    return '/';
  }
}

function resolveSafeReturnOrigin(req, fallback = '') {
  const candidate = String(fallback || getRequestOrigin(req) || '').trim();
  if (!candidate) return '';

  try {
    const parsed = new URL(candidate);
    const hostname = parsed.hostname.toLowerCase();
    const currentHost = String(req.get('host') || '').split(':')[0].toLowerCase();
    const isLoopback = hostname === 'localhost' || hostname === '127.0.0.1';
    const isTunnel = hostname.endsWith('.trycloudflare.com');
    const isCurrentHost = hostname === currentHost;

    if (!isLoopback && !isTunnel && !isCurrentHost) {
      return '';
    }

    return `${parsed.protocol}//${parsed.host}`;
  } catch (error) {
    return '';
  }
}

function appendQueryParams(target, params = {}) {
  const parsed = new URL(target || '/', 'http://jammin.local');
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    parsed.searchParams.set(key, String(value));
  });
  if (parsed.origin === 'http://jammin.local') {
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }
  return parsed.toString();
}

function purgeExpiredSpotifyAuthStates() {
  const now = Date.now();
  for (const [state, payload] of spotifyAuthStateStore.entries()) {
    if (!payload || payload.expiresAt <= now) {
      spotifyAuthStateStore.delete(state);
    }
  }
}

function purgeExpiredSpotifyTransferTokens() {
  const now = Date.now();
  for (const [token, payload] of spotifySessionTransferStore.entries()) {
    if (!payload || payload.expiresAt <= now) {
      spotifySessionTransferStore.delete(token);
    }
  }
}

function purgeExpiredSpotifyUserSessions() {
  const now = Date.now();
  for (const [sid, session] of spotifyUserSessionStore.entries()) {
    if (!session) {
      spotifyUserSessionStore.delete(sid);
      continue;
    }

    const lastSeenAt = Number(session.lastSeenAt || 0);
    if (lastSeenAt && lastSeenAt + SPOTIFY_USER_SESSION_TTL_MS <= now) {
      spotifyUserSessionStore.delete(sid);
    }
  }
}

function getSpotifySessionFromRequest(req) {
  const cookies = parseCookieHeader(req.headers.cookie || '');
  const sid = cookies[SPOTIFY_SESSION_COOKIE_NAME] || '';
  if (!sid) return { sid: '', session: null };
  const session = spotifyUserSessionStore.get(sid) || null;
  if (session) {
    session.lastSeenAt = Date.now();
  }
  return { sid, session };
}

function ensureSpotifyBrowserSession(req, res) {
  purgeExpiredSpotifyUserSessions();
  const current = getSpotifySessionFromRequest(req);
  let sid = current.sid;
  let session = current.session;

  if (!sid) {
    sid = crypto.randomBytes(18).toString('hex');
  }

  if (!session) {
    session = {
      accessToken: '',
      refreshToken: '',
      expiresAt: 0,
      displayName: '',
      spotifyUserId: '',
      connectedAt: 0,
      lastSeenAt: Date.now(),
    };
    spotifyUserSessionStore.set(sid, session);
  } else {
    session.lastSeenAt = Date.now();
  }

  appendSetCookieHeader(
    res,
    `${SPOTIFY_SESSION_COOKIE_NAME}=${encodeURIComponent(sid)}; Path=/; Max-Age=${Math.floor(
      SPOTIFY_USER_SESSION_TTL_MS / 1000
    )}; HttpOnly; SameSite=Lax`
  );

  return { sid, session };
}

function buildSpotifyAuthStartPath(returnTo = '/') {
  return appendQueryParams('/api/spotify/auth/start', {
    returnTo: sanitizeReturnTo(returnTo),
  });
}

function buildSpotifyAuthUrl(req, sid, returnTo = '/', returnOrigin = '') {
  purgeExpiredSpotifyAuthStates();
  const state = crypto.randomBytes(18).toString('hex');
  spotifyAuthStateStore.set(state, {
    sid,
    returnTo: sanitizeReturnTo(returnTo),
    returnOrigin: resolveSafeReturnOrigin(req, returnOrigin),
    expiresAt: Date.now() + SPOTIFY_AUTH_STATE_TTL_MS,
  });

  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: 'code',
    redirect_uri: resolveSpotifyRedirectUri(req),
    state,
    scope: SPOTIFY_OAUTH_SCOPE,
    show_dialog: 'false',
  });

  return `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function requestYouTubeSearch(params) {
  const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params.toString()}`);
  const data = await response.json();
  return { response, data };
}

async function readJsonOrText(response) {
  const text = await response.text();
  if (!text) {
    return { data: null, rawText: '' };
  }

  try {
    return {
      data: JSON.parse(text),
      rawText: text,
    };
  } catch {
    return {
      data: null,
      rawText: text,
    };
  }
}

function formatYouTubeSearchItems(data) {
  return (data.items || [])
    .filter((item) => item.id?.videoId)
    .map((item) => ({
      videoId: item.id.videoId,
      title: item.snippet?.title || 'Untitled',
      channelTitle: item.snippet?.channelTitle || '',
      thumbnail:
        item.snippet?.thumbnails?.medium?.url ||
        item.snippet?.thumbnails?.default?.url ||
        `https://img.youtube.com/vi/${item.id.videoId}/mqdefault.jpg`,
    }));
}

function normalizeSuggestionQuery(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(official|video|lyrics?|lyrical|audio|full song|visualizer|topic)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildPreferredMusicSearchQuery(query = '') {
  const raw = String(query || '').trim();
  if (!raw) return '';

  const normalized = normalizeMatchText(raw);
  if (
    /\bofficial\b/.test(normalized) ||
    /\baudio\b/.test(normalized) ||
    /\blyrics?\b/.test(normalized) ||
    /\blyrical\b/.test(normalized) ||
    /\bvideo\b/.test(normalized) ||
    /\blive\b/.test(normalized) ||
    /\bremix\b/.test(normalized) ||
    /\bcover\b/.test(normalized) ||
    /\btopic\b/.test(normalized) ||
    /\bvisualizer\b/.test(normalized)
  ) {
    return raw;
  }

  return `${raw} official audio`;
}

function extractLikelyArtistFromTitle(title = '') {
  const raw = String(title || '')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .trim();
  const parts = raw.split(/\s[-|]\s/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return '';
  const candidate = parts[0];
  const wordCount = splitWords(candidate).length;
  if (!wordCount || wordCount > 6) return '';
  return candidate;
}

function inferPreferredArtistFromSearchResults(query = '', items = []) {
  const normalizedQuery = normalizeMatchText(query);
  const weights = new Map();

  items.forEach((item) => {
    const titleArtist = extractLikelyArtistFromTitle(item.title);
    const topicArtist = isLikelyTopicChannel(item.channelTitle)
      ? String(item.channelTitle || '').replace(/\s*-\s*topic\s*$/i, '').trim()
      : '';

    [
      { name: titleArtist, weight: isLikelyOfficialArtistChannel(item.channelTitle, titleArtist) ? 3 : 1 },
      { name: topicArtist, weight: 4 },
    ].forEach(({ name, weight }) => {
      const normalized = normalizeMatchText(name);
      if (!normalized || normalized === normalizedQuery) return;
      weights.set(normalized, (weights.get(normalized) || 0) + weight);
    });
  });

  const ranked = [...weights.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] < 3) return '';
  return ranked[0][0];
}

function buildSuggestionQuery(title, artist) {
  const cleanTitle = normalizeSuggestionQuery(title);
  const cleanArtist = normalizeSuggestionQuery(artist);
  return [cleanArtist, cleanTitle].filter(Boolean).join(' ').trim();
}

function dedupeSearchItems(items, excludedVideoId = '') {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.videoId || item.videoId === excludedVideoId || seen.has(item.videoId)) {
      return false;
    }
    seen.add(item.videoId);
    return true;
  });
}

async function requestYouTubeVideos(params) {
  const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params.toString()}`);
  const data = await response.json();
  return { response, data };
}

async function fetchYouTubeVideoMeta(videoId) {
  const safeVideoId = String(videoId || '').trim();
  if (!safeVideoId) {
    throw new Error('Video id is missing.');
  }

  const cached = youtubeVideoMetaCache.get(safeVideoId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }
  if (cached) youtubeVideoMetaCache.delete(safeVideoId);

  const details = await fetchVideoDetails(safeVideoId);
  if (!details.allowed) {
    throw new Error(details.reason || 'This video cannot be played inside Jammin');
  }

  const payload = {
    videoId: safeVideoId,
    title: details.title || 'Untitled',
    artist: details.artist || '',
    duration: details.duration || '',
    thumbnail: `https://img.youtube.com/vi/${safeVideoId}/mqdefault.jpg`,
  };

  youtubeVideoMetaCache.set(safeVideoId, {
    expiresAt: Date.now() + YOUTUBE_PLAYLIST_CACHE_TTL_MS,
    payload,
  });

  return payload;
}

async function requestYouTubePlaylists(params) {
  const response = await fetch(`https://www.googleapis.com/youtube/v3/playlists?${params.toString()}`);
  const data = await response.json();
  return { response, data };
}

async function requestYouTubePlaylistItems(params) {
  const response = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?${params.toString()}`);
  const data = await response.json();
  return { response, data };
}

function normalizeMatchText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/&amp;|&#39;|&quot;/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitWords(text) {
  return normalizeMatchText(text).split(' ').filter(Boolean);
}

function countWordOverlap(baseWords, candidateWords) {
  if (!baseWords.length || !candidateWords.length) return 0;
  return baseWords.filter((word) => candidateWords.includes(word)).length;
}

function computeOverlapRatio(baseWords, candidateWords) {
  if (!baseWords.length || !candidateWords.length) return 0;
  const overlap = countWordOverlap(baseWords, candidateWords);
  return overlap / Math.max(1, baseWords.length);
}

function parseIsoDurationToMs(isoDuration) {
  const match = String(isoDuration || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return ((hours * 3600) + (minutes * 60) + seconds) * 1000;
}

function formatDurationMs(durationMs) {
  const safe = Number(durationMs) || 0;
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function titleContainsPhrase(title, phrase) {
  const normalizedTitle = normalizeMatchText(title);
  const normalizedPhrase = normalizeMatchText(phrase);
  if (!normalizedTitle || !normalizedPhrase) return false;
  return new RegExp(`\\b${escapeRegex(normalizedPhrase)}\\b`).test(normalizedTitle);
}

function getPrimaryArtistName(artistText = '') {
  return String(artistText || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)[0] || '';
}

function buildTopicChannelName(artistText = '') {
  const primaryArtist = getPrimaryArtistName(artistText);
  return primaryArtist ? `${primaryArtist} - Topic` : '';
}

function isLikelyTopicChannel(channelTitle = '') {
  return /\btopic\b/i.test(String(channelTitle || '').trim());
}

function isExactTopicChannel(channelTitle = '', artistText = '') {
  const expected = normalizeMatchText(buildTopicChannelName(artistText));
  const normalizedChannel = normalizeMatchText(channelTitle);
  return Boolean(expected && normalizedChannel && expected === normalizedChannel);
}

function isLikelyOfficialArtistChannel(channelTitle = '', artistText = '') {
  const normalizedChannel = normalizeMatchText(channelTitle);
  const primaryArtist = normalizeMatchText(getPrimaryArtistName(artistText));
  if (!normalizedChannel || !primaryArtist) return false;
  return normalizedChannel === primaryArtist || normalizedChannel.includes(primaryArtist);
}

function isLikelyReuploadChannel(channelTitle = '') {
  const normalizedChannel = normalizeMatchText(channelTitle);
  if (!normalizedChannel) return false;

  const reuploadMarkers = [
    'lyrics',
    'lyrical',
    'music hub',
    'popular music',
    'vibes',
    'nation',
    'world',
    'edits',
    'edit',
    'audio paradise',
    'viral',
    'status',
    'slowed',
    'reverb',
    'music',
  ];

  return reuploadMarkers.some((marker) => normalizedChannel.includes(marker));
}

function hasNegativeSongMarker(text = '') {
  const normalizedText = normalizeMatchText(text);
  if (!normalizedText) return false;

  const negativePatterns = [
    /\bremix\b/,
    /\blive\b/,
    /\bcover\b/,
    /\bkaraoke\b/,
    /\binstrumental\b/,
    /\bsped up\b/,
    /\bslowed\b/,
    /\breverb\b/,
    /\blyrics?\b/,
    /\blyrical\b/,
    /\bfan made\b/,
    /\bvisualizer\b/,
  ];

  return negativePatterns.some((pattern) => pattern.test(normalizedText));
}

function scoreGenericSearchCandidate(query, candidate, preferredArtist = '') {
  const queryText = String(query || '').trim();
  const refinedQueryText = normalizeSuggestionQuery(queryText);
  const normalizedQueryText = normalizeMatchText(queryText);
  const queryWords = splitWords(queryText);
  const refinedQueryWords = splitWords(refinedQueryText);
  const candidateTitleWords = splitWords(candidate.title);
  const candidateChannelWords = splitWords(candidate.channelTitle);
  const combinedCandidateWords = [...candidateTitleWords, ...candidateChannelWords];
  const titleText = normalizeMatchText(candidate.title);
  const channelText = normalizeMatchText(candidate.channelTitle);
  const inferredArtistFromTitle = String(candidate.title || '').split(/\s[-|]\s/)[0]?.trim() || '';
  const normalizedPreferredArtist = normalizeMatchText(preferredArtist);
  const wantsLyrics = /\blyrics?\b|\blyrical\b/.test(normalizedQueryText);
  const wantsVideo = /\b(video|mv|music video)\b/.test(normalizedQueryText);
  const wantsRemix = /\b(remix|sped up|slowed|reverb)\b/.test(normalizedQueryText);
  const wantsLive = /\blive\b/.test(normalizedQueryText);
  const wantsCover = /\bcover\b/.test(normalizedQueryText);

  let score = 0;

  const queryOverlap = computeOverlapRatio(queryWords, combinedCandidateWords);
  score += Math.round(queryOverlap * 56);
  score += Math.round(computeOverlapRatio(refinedQueryWords, combinedCandidateWords) * 24);

  if (titleContainsPhrase(candidate.title, queryText)) score += 26;
  if (refinedQueryText && titleContainsPhrase(candidate.title, refinedQueryText)) score += 16;

  if (isExactTopicChannel(candidate.channelTitle, inferredArtistFromTitle)) score += 40;
  else if (isLikelyOfficialArtistChannel(candidate.channelTitle, inferredArtistFromTitle)) score += 26;
  if (isLikelyTopicChannel(candidate.channelTitle)) score += 28;
  if (normalizedPreferredArtist) {
    if (isExactTopicChannel(candidate.channelTitle, normalizedPreferredArtist)) score += 52;
    else if (isLikelyOfficialArtistChannel(candidate.channelTitle, normalizedPreferredArtist)) score += 34;
    else if (normalizeMatchText(inferredArtistFromTitle) === normalizedPreferredArtist) score += 10;
    else if (!isLikelyTopicChannel(candidate.channelTitle) && !isLikelyOfficialArtistChannel(candidate.channelTitle, normalizedPreferredArtist)) score -= 18;
  }
  if (/\bofficial\b/.test(titleText)) score += 8;
  if (/\baudio\b/.test(titleText)) score += 12;
  if (/\bofficial audio\b/.test(titleText)) score += 16;
  if (/\bofficial video\b/.test(titleText)) score += wantsVideo ? 10 : -6;
  if (/\bofficial lyric video\b/.test(titleText)) score += wantsLyrics ? 8 : -18;
  if (/\bmusic video\b/.test(titleText)) score += wantsVideo ? 10 : -12;

  if (candidate.title.length > 95) score -= 4;
  if (candidate.title.length > 130) score -= 6;

  if (hasNegativeSongMarker(candidate.title)) score -= 44;
  if (isLikelyReuploadChannel(candidate.channelTitle)) score -= 28;
  if (!wantsLyrics && (/\blyrics?\b/.test(titleText) || /\blyrical\b/.test(titleText))) score -= 36;
  if (/\blyrics?\b/.test(channelText) || /\blyrical\b/.test(channelText)) score -= 32;
  if (!wantsVideo && /\bmusic video\b/.test(titleText)) score -= 10;
  if (!wantsRemix && /\b(remix|sped up|slowed|reverb)\b/.test(titleText)) score -= 26;
  if (!wantsLive && /\blive\b/.test(titleText)) score -= 26;
  if (!wantsCover && /\bcover\b/.test(titleText)) score -= 26;
  if (inferredArtistFromTitle && !isLikelyOfficialArtistChannel(candidate.channelTitle, inferredArtistFromTitle) && !isLikelyTopicChannel(candidate.channelTitle)) {
    score -= 12;
  }

  return clamp(score, 0, 100);
}

function buildSpotifyPlaylistCacheKey(playlistId, offset, limit) {
  return `${playlistId}:${offset}:${limit}`;
}

function parseSpotifyPlaylistUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;

  const uriMatch = raw.match(/^spotify:playlist:([a-zA-Z0-9]+)$/i);
  if (uriMatch) return uriMatch[1];

  try {
    const parsed = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const pathMatch = parsed.pathname.match(/\/playlist\/([a-zA-Z0-9]+)/i);
    if (pathMatch) return pathMatch[1];
  } catch (error) {
    const match = raw.match(/playlist\/([a-zA-Z0-9]+)/i);
    if (match) return match[1];
  }

  return null;
}

async function getSpotifyAccessToken() {
  if (
    spotifyTokenState.accessToken &&
    spotifyTokenState.expiresAt - SPOTIFY_TOKEN_EARLY_REFRESH_MS > Date.now()
  ) {
    return spotifyTokenState.accessToken;
  }

  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new Error('Spotify import is not configured on the server.');
  }

  const auth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });

  const { data, rawText } = await readJsonOrText(response);
  if (!response.ok || !data.access_token) {
    throw new Error(data?.error_description || data?.error || rawText || 'Unable to authenticate with Spotify right now.');
  }

  spotifyTokenState = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in || 3600) * 1000),
  };

  return spotifyTokenState.accessToken;
}

async function fetchSpotifyCurrentUserProfile(accessToken) {
  const response = await fetch('https://api.spotify.com/v1/me', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const { data, rawText } = await readJsonOrText(response);
  return { response, data, rawText };
}

async function refreshSpotifyUserAccessToken(session) {
  if (!session?.refreshToken) {
    const error = new Error('Connect Spotify to review playlists from your account.');
    error.code = 'spotify_auth_required';
    throw error;
  }

  const auth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const response = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: session.refreshToken,
    }),
  });

  const { data, rawText } = await readJsonOrText(response);
  if (!response.ok || !data.access_token) {
    const error = new Error(rawText || 'Connect Spotify again to keep importing playlists.');
    error.code = 'spotify_auth_required';
    throw error;
  }

  session.accessToken = data.access_token;
  session.expiresAt = Date.now() + (Number(data.expires_in || 3600) * 1000);
  if (data.refresh_token) {
    session.refreshToken = data.refresh_token;
  }
  session.lastSeenAt = Date.now();

  return session.accessToken;
}

async function getSpotifyUserAccessToken(req) {
  const { sid, session } = getSpotifySessionFromRequest(req);
  if (!sid || !session || (!session.accessToken && !session.refreshToken)) {
    const error = new Error('Connect Spotify to review playlists from your account.');
    error.code = 'spotify_auth_required';
    throw error;
  }

  if (session.accessToken && session.expiresAt - SPOTIFY_TOKEN_EARLY_REFRESH_MS > Date.now()) {
    session.lastSeenAt = Date.now();
    return session.accessToken;
  }

  return refreshSpotifyUserAccessToken(session);
}

async function requestSpotify(endpoint, params = {}, accessToken = '') {
  const resolvedAccessToken = accessToken || await getSpotifyAccessToken();
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, String(value));
    }
  });

  const url = `https://api.spotify.com/v1${endpoint}${query.size ? `?${query.toString()}` : ''}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${resolvedAccessToken}`,
    },
  });
  const { data, rawText } = await readJsonOrText(response);
  return { response, data, rawText };
}

function createSpotifyApiError(response, data, fallbackMessage, rawText = '') {
  if (response?.status === 401) {
    const error = new Error('Spotify sign-in expired. Connect Spotify again to continue.');
    error.code = 'spotify_auth_required';
    return error;
  }

  if (response?.status === 403) {
    const lowerText = String(rawText || '').toLowerCase();
    const isDevModeRestriction =
      lowerText.includes('developer dashboard') ||
      lowerText.includes('not registered') ||
      lowerText.includes('allowlist');
    const error = new Error(
      isDevModeRestriction
        ? 'This Spotify account is blocked by your app’s Spotify Development Mode allowlist. To let any user import playlists, the app must move out of Development Mode.'
        : 'Spotify would not let Jammin read that playlist from this account. Make sure it is public or shared with the connected Spotify user.'
    );
    error.code = isDevModeRestriction ? 'spotify_app_dev_mode_restricted' : 'spotify_playlist_forbidden';
    return error;
  }

  const error = new Error(data?.error?.message || rawText || fallbackMessage || 'Spotify request failed.');
  error.code = 'spotify_api_error';
  return error;
}

async function fetchSpotifyPlaylistMeta(playlistId, accessToken = '') {
  const cached = spotifyPlaylistMetaCache.get(playlistId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }
  if (cached) spotifyPlaylistMetaCache.delete(playlistId);

  const { response, data, rawText } = await requestSpotify(`/playlists/${playlistId}`, {
    market: 'IN',
    fields: 'id,name,images,owner(display_name),items(total),tracks(total),external_urls(spotify)',
  }, accessToken);

  if (!response.ok) {
    throw createSpotifyApiError(response, data, 'Unable to read that Spotify playlist.', rawText);
  }

  const payload = {
    playlistId: data.id || playlistId,
    title: data.name || 'Spotify Playlist',
    channelTitle: data.owner?.display_name || 'Spotify',
    thumbnail: data.images?.[0]?.url || '',
    itemCount: Number(data.items?.total ?? data.tracks?.total ?? 0),
    externalUrl: data.external_urls?.spotify || '',
    source: 'spotify',
  };

  spotifyPlaylistMetaCache.set(playlistId, {
    expiresAt: Date.now() + SPOTIFY_PLAYLIST_CACHE_TTL_MS,
    payload,
  });

  return payload;
}

async function fetchSpotifyPlaylistTracksPage(playlistId, offset = 0, limit = SPOTIFY_REVIEW_PAGE_SIZE, accessToken = '') {
  const safeOffset = clamp(Number(offset) || 0, 0, SPOTIFY_REVIEW_MAX_TRACKS);
  const safeLimit = clamp(Number(limit) || SPOTIFY_REVIEW_PAGE_SIZE, 1, SPOTIFY_REVIEW_PAGE_SIZE);
  const cacheKey = buildSpotifyPlaylistCacheKey(playlistId, safeOffset, safeLimit);
  const cached = spotifyPlaylistPageCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }
  if (cached) spotifyPlaylistPageCache.delete(cacheKey);

  const { response, data, rawText } = await requestSpotify(`/playlists/${playlistId}/items`, {
    market: 'IN',
    offset: safeOffset,
    limit: safeLimit,
    fields: 'items(item(id,name,duration_ms,is_local,artists(name),album(images),external_urls(spotify))),total,next',
  }, accessToken);

  if (!response.ok) {
    throw createSpotifyApiError(response, data, 'Unable to load tracks from that Spotify playlist.', rawText);
  }

  const payload = {
    total: Math.min(Number(data.total || 0), SPOTIFY_REVIEW_MAX_TRACKS),
    items: (data.items || [])
      .map((entry) => entry.item || entry.track || null)
      .filter((track) => track && !track.is_local)
      .map((track) => ({
        spotifyTrackId: track.id || '',
        title: track.name || 'Untitled',
        artist: (track.artists || []).map((artist) => artist.name).filter(Boolean).join(', '),
        artists: (track.artists || []).map((artist) => artist.name).filter(Boolean),
        durationMs: Number(track.duration_ms || 0),
        thumbnail: track.album?.images?.[0]?.url || '',
        externalUrl: track.external_urls?.spotify || '',
      })),
  };

  spotifyPlaylistPageCache.set(cacheKey, {
    expiresAt: Date.now() + SPOTIFY_PLAYLIST_CACHE_TTL_MS,
    payload,
  });

  return payload;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const currentIndex = cursor++;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

async function fetchYouTubeSearchCandidates(query, maxResults = 6) {
  if (!YOUTUBE_API_KEY) {
    throw new Error('YouTube search is not configured on the server.');
  }

  const params = new URLSearchParams({
    part: 'snippet',
    type: 'video',
    videoCategoryId: '10',
    videoEmbeddable: 'true',
    videoSyndicated: 'true',
    maxResults: String(maxResults),
    q: query,
    key: YOUTUBE_API_KEY,
  });

  const { response, data } = await requestYouTubeSearch(params);
  if (!response.ok) {
    const reason = data?.error?.errors?.[0]?.reason || '';
    if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
      const error = new Error('YouTube search quota is exhausted for now.');
      error.code = 'youtube_quota_exceeded';
      throw error;
    }
    throw new Error(data?.error?.message || 'Unable to search YouTube right now.');
  }

  const baseItems = formatYouTubeSearchItems(data);
  if (baseItems.length === 0) return [];

  const ids = baseItems.map((item) => item.videoId).join(',');
  const videoParams = new URLSearchParams({
    part: 'snippet,contentDetails,status',
    id: ids,
    key: YOUTUBE_API_KEY,
  });

  const { response: detailsResponse, data: detailsData } = await requestYouTubeVideos(videoParams);
  if (!detailsResponse.ok) {
    throw new Error(detailsData?.error?.message || 'Unable to inspect YouTube results right now.');
  }

  const videoMap = new Map(
    (detailsData.items || []).map((item) => [item.id, item])
  );

  return baseItems
    .map((item) => {
      const detail = videoMap.get(item.videoId);
      if (!detail) return null;
      if (detail.status?.privacyStatus && detail.status.privacyStatus !== 'public') return null;
      if (detail.status?.embeddable === false) return null;

      return {
        videoId: item.videoId,
        title: detail.snippet?.title || item.title,
        channelTitle: detail.snippet?.channelTitle || item.channelTitle || '',
        thumbnail:
          detail.snippet?.thumbnails?.medium?.url ||
          item.thumbnail ||
          `https://img.youtube.com/vi/${item.videoId}/mqdefault.jpg`,
        durationMs: parseIsoDurationToMs(detail.contentDetails?.duration),
      };
    })
    .filter(Boolean);
}

function scoreYouTubeCandidate(track, candidate) {
  const titleWords = splitWords(track.title);
  const artistWords = splitWords(track.artist);
  const candidateTitleWords = splitWords(candidate.title);
  const candidateChannelWords = splitWords(candidate.channelTitle);
  const combinedCandidateWords = [...candidateTitleWords, ...candidateChannelWords];
  const titleText = normalizeMatchText(candidate.title);
  const channelText = normalizeMatchText(candidate.channelTitle);

  let score = 0;

  const titleOverlap = computeOverlapRatio(titleWords, combinedCandidateWords);
  const artistOverlap = computeOverlapRatio(artistWords, combinedCandidateWords);

  score += Math.round(titleOverlap * 48);
  score += Math.round(artistOverlap * 24);

  if (titleContainsPhrase(candidate.title, track.title)) score += 18;
  if (track.artist && (titleContainsPhrase(candidate.title, track.artist) || titleContainsPhrase(candidate.channelTitle, track.artist))) {
    score += 12;
  }

  if (isExactTopicChannel(candidate.channelTitle, track.artist)) score += 32;
  else if (isLikelyTopicChannel(candidate.channelTitle)) score += 22;

  if (isLikelyOfficialArtistChannel(candidate.channelTitle, track.artist)) score += 14;

  const durationDiffMs = Math.abs((track.durationMs || 0) - (candidate.durationMs || 0));
  if (durationDiffMs <= 5000) score += 22;
  else if (durationDiffMs <= 10000) score += 17;
  else if (durationDiffMs <= 15000) score += 12;
  else if (durationDiffMs <= 25000) score += 5;
  else score -= Math.min(24, Math.round(durationDiffMs / 4000));

  const negativePatterns = [
    /\bremix\b/,
    /\blive\b/,
    /\bcover\b/,
    /\bkaraoke\b/,
    /\binstrumental\b/,
    /\bsped up\b/,
    /\bslowed\b/,
    /\breverb\b/,
  ];
  negativePatterns.forEach((pattern) => {
    if (pattern.test(titleText)) score -= 26;
  });

  if (/\bofficial\b/.test(titleText)) score += 10;
  if (/\baudio\b/.test(titleText)) score += 8;
  if (/\bofficial audio\b/.test(titleText)) score += 18;
  if (/\bofficial video\b/.test(titleText)) score -= 4;
  if (/\bofficial lyric video\b/.test(titleText)) score -= 18;
  if (/\bmusic video\b/.test(titleText)) score -= 10;
  if (/\blyrics?\b/.test(titleText) || /\blyrical\b/.test(titleText)) score -= 28;
  if (/\blyrics?\b/.test(channelText) || /\blyrical\b/.test(channelText)) score -= 28;
  if (isLikelyReuploadChannel(candidate.channelTitle)) score -= 22;
  if (candidate.title.length > 110) score -= 4;

  return clamp(score, 0, 100);
}

async function mapSpotifyTrackToYouTube(track) {
  const cacheKey = `${normalizeMatchText(track.title)}::${normalizeMatchText(track.artist)}::${track.durationMs}`;
  const cached = spotifyTrackMatchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }
  if (cached) spotifyTrackMatchCache.delete(cacheKey);

  const query = `${track.title} ${track.artist} official audio`.trim();
  const candidates = await fetchYouTubeSearchCandidates(query, 6);
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score: scoreYouTubeCandidate(track, candidate),
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  const payload = {
    spotify: {
      title: track.title,
      artist: track.artist,
      artists: track.artists || [],
      durationMs: track.durationMs,
      thumbnail: track.thumbnail || '',
      externalUrl: track.externalUrl || '',
    },
    youtube: best ? {
      videoId: best.candidate.videoId,
      title: best.candidate.title,
      durationMs: best.candidate.durationMs,
      thumbnail: best.candidate.thumbnail,
      channelTitle: best.candidate.channelTitle,
    } : null,
    confidence: best ? best.score : 0,
    status: best ? (best.score >= 68 ? 'matched' : 'low-confidence') : 'low-confidence',
    suggestions: ranked.slice(0, 3).map((entry) => ({
      videoId: entry.candidate.videoId,
      title: entry.candidate.title,
      durationMs: entry.candidate.durationMs,
      thumbnail: entry.candidate.thumbnail,
      channelTitle: entry.candidate.channelTitle,
    })),
  };

  spotifyTrackMatchCache.set(cacheKey, {
    expiresAt: Date.now() + SPOTIFY_MATCH_CACHE_TTL_MS,
    payload,
  });

  return payload;
}

async function buildSpotifyReviewPage(playlistId, offset = 0, limit = SPOTIFY_REVIEW_PAGE_SIZE, accessToken = '') {
  const safeOffset = clamp(Number(offset) || 0, 0, SPOTIFY_REVIEW_MAX_TRACKS);
  const meta = await fetchSpotifyPlaylistMeta(playlistId, accessToken);
  const trackPage = await fetchSpotifyPlaylistTracksPage(playlistId, safeOffset, limit, accessToken);
  const mappedItems = await mapWithConcurrency(trackPage.items, 3, async (track) => {
    try {
      return await mapSpotifyTrackToYouTube(track);
    } catch (error) {
      return {
        spotify: {
          title: track.title,
          artist: track.artist,
          artists: track.artists || [],
          durationMs: track.durationMs,
          thumbnail: track.thumbnail || '',
          externalUrl: track.externalUrl || '',
        },
        youtube: null,
        confidence: 0,
        status: error.code === 'youtube_quota_exceeded' ? 'low-confidence' : 'low-confidence',
        error: error.message || 'Unable to match this track right now.',
      };
    }
  });

  const total = Math.min(trackPage.total || 0, SPOTIFY_REVIEW_MAX_TRACKS);
  const nextOffset = safeOffset + trackPage.items.length;

  return {
    ...meta,
    total,
    offset: safeOffset,
    limit: trackPage.items.length,
    hasMore: nextOffset < total,
    nextOffset: nextOffset < total ? nextOffset : null,
    items: mappedItems,
    source: 'spotify',
  };
}

async function searchYouTubeManualMatch(query) {
  const trimmedQuery = String(query || '').trim();
  if (!trimmedQuery) return [];
  const candidates = await fetchYouTubeSearchCandidates(trimmedQuery, 8);
  const preferredArtist = inferPreferredArtistFromSearchResults(trimmedQuery, candidates);
  return candidates
    .map((candidate) => ({
      candidate,
      rank: scoreGenericSearchCandidate(trimmedQuery, candidate, preferredArtist),
    }))
    .sort((a, b) => b.rank - a.rank || a.candidate.title.length - b.candidate.title.length)
    .map(({ candidate }) => ({
      videoId: candidate.videoId,
      title: candidate.title,
      durationMs: candidate.durationMs,
      durationLabel: formatDurationMs(candidate.durationMs),
      thumbnail: candidate.thumbnail,
      channelTitle: candidate.channelTitle,
    }));
}

function normalizeImportedPlaylistPayload(playlist = {}) {
  const source = playlist.source === 'spotify' ? 'spotify' : 'youtube';
  const items = (playlist.items || [])
    .map((item) => {
      const videoId = parseYouTubeUrl(item.videoId || item.videoUrl || '');
      if (!videoId) return null;

      return {
        videoId,
        title: String(item.title || 'Untitled').slice(0, 200),
        artist: String(item.artist || item.channelTitle || '').slice(0, 160),
        thumbnail: String(item.thumbnail || `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`),
        duration: item.duration ? String(item.duration) : '',
      };
    })
    .filter(Boolean);

  return {
    playlistId: String(playlist.playlistId || `import_${Date.now()}`).slice(0, 120),
    title: String(playlist.title || 'Imported Playlist').slice(0, 160),
    channelTitle: String(playlist.channelTitle || (source === 'spotify' ? 'Spotify' : 'YouTube')).slice(0, 160),
    thumbnail: String(playlist.thumbnail || items[0]?.thumbnail || ''),
    source,
    items,
  };
}

async function fetchPlaylistMeta(playlistId) {
  const params = new URLSearchParams({
    part: 'snippet,contentDetails',
    id: playlistId,
    key: YOUTUBE_API_KEY,
  });
  const { response, data } = await requestYouTubePlaylists(params);
  if (!response.ok) {
    const message = data?.error?.message || 'Unable to load that playlist right now.';
    throw new Error(message);
  }

  const playlist = data.items?.[0];
  if (!playlist) {
    throw new Error('Playlist not found');
  }

  return {
    playlistId,
    title: playlist.snippet?.title || 'Untitled Playlist',
    channelTitle: playlist.snippet?.channelTitle || '',
    thumbnail:
      playlist.snippet?.thumbnails?.medium?.url ||
      playlist.snippet?.thumbnails?.default?.url ||
      '',
    itemCount: playlist.contentDetails?.itemCount || 0,
  };
}

async function fetchPlaylistPreview(playlistId) {
  const cached = youtubePlaylistPreviewCache.get(playlistId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }
  if (cached) youtubePlaylistPreviewCache.delete(playlistId);

  const meta = await fetchPlaylistMeta(playlistId);
  const params = new URLSearchParams({
    part: 'snippet,contentDetails',
    playlistId,
    maxResults: String(PLAYLIST_PREVIEW_TRACKS),
    key: YOUTUBE_API_KEY,
  });

  const { response, data } = await requestYouTubePlaylistItems(params);
  if (!response.ok) {
    const message = data?.error?.message || 'Unable to preview that playlist right now.';
    throw new Error(message);
  }

  const previewTracks = (data.items || [])
    .map((item) => ({
      videoId: item.contentDetails?.videoId || '',
      title: item.snippet?.title || 'Untitled',
      artist: item.snippet?.videoOwnerChannelTitle || item.snippet?.channelTitle || '',
      thumbnail:
        item.snippet?.thumbnails?.medium?.url ||
        item.snippet?.thumbnails?.default?.url ||
        '',
    }))
    .filter((item) => item.videoId);

  const payload = {
    ...meta,
    previewTracks,
    importCount: Math.min(meta.itemCount || previewTracks.length, PLAYLIST_IMPORT_MAX_TRACKS),
    isTruncated: (meta.itemCount || 0) > PLAYLIST_IMPORT_MAX_TRACKS,
  };

  youtubePlaylistPreviewCache.set(playlistId, {
    expiresAt: Date.now() + YOUTUBE_PLAYLIST_CACHE_TTL_MS,
    payload,
  });

  return payload;
}

async function fetchPlaylistImport(playlistId) {
  const cached = youtubePlaylistImportCache.get(playlistId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }
  if (cached) youtubePlaylistImportCache.delete(playlistId);

  const meta = await fetchPlaylistMeta(playlistId);
  const playlistItems = [];
  let pageToken = '';

  while (playlistItems.length < PLAYLIST_IMPORT_MAX_TRACKS) {
    const params = new URLSearchParams({
      part: 'snippet,contentDetails',
      playlistId,
      maxResults: '50',
      key: YOUTUBE_API_KEY,
    });
    if (pageToken) params.set('pageToken', pageToken);

    const { response, data } = await requestYouTubePlaylistItems(params);
    if (!response.ok) {
      const message = data?.error?.message || 'Unable to load that playlist right now.';
      throw new Error(message);
    }

    playlistItems.push(...(data.items || []));
    pageToken = data.nextPageToken || '';
    if (!pageToken) break;
  }

  const slicedItems = playlistItems.slice(0, PLAYLIST_IMPORT_MAX_TRACKS);
  const orderedVideoIds = slicedItems
    .map((item) => item.contentDetails?.videoId || '')
    .filter(Boolean);

  const videoMap = new Map();
  for (let index = 0; index < orderedVideoIds.length; index += 50) {
    const chunk = orderedVideoIds.slice(index, index + 50);
    const params = new URLSearchParams({
      part: 'snippet,status,contentDetails',
      id: chunk.join(','),
      key: YOUTUBE_API_KEY,
    });
    const { response, data } = await requestYouTubeVideos(params);
    if (!response.ok) continue;

    (data.items || []).forEach((video) => {
      videoMap.set(video.id, video);
    });
  }

  const items = slicedItems
    .map((item) => {
      const videoId = item.contentDetails?.videoId || '';
      const video = videoMap.get(videoId);
      const embeddable = video?.status?.embeddable !== false;
      const privacyStatus = video?.status?.privacyStatus || 'public';
      if (!videoId || !video || !embeddable || privacyStatus !== 'public') {
        return null;
      }

      return {
        videoId,
        title: video.snippet?.title || item.snippet?.title || 'Untitled',
        artist:
          video.snippet?.channelTitle ||
          item.snippet?.videoOwnerChannelTitle ||
          item.snippet?.channelTitle ||
          '',
        thumbnail:
          video.snippet?.thumbnails?.medium?.url ||
          item.snippet?.thumbnails?.medium?.url ||
          item.snippet?.thumbnails?.default?.url ||
          `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
        duration: formatDurationMs(parseIsoDurationToMs(video.contentDetails?.duration)),
      };
    })
    .filter(Boolean);

  const payload = {
    ...meta,
    items,
    importCount: items.length,
    isTruncated: (meta.itemCount || 0) > PLAYLIST_IMPORT_MAX_TRACKS,
  };

  youtubePlaylistImportCache.set(playlistId, {
    expiresAt: Date.now() + YOUTUBE_PLAYLIST_CACHE_TTL_MS,
    payload,
  });

  return payload;
}

app.get('/api/youtube/search', async (req, res) => {
  const query = String(req.query.q || '').trim();
  const pageToken = String(req.query.pageToken || '').trim();
  const cacheKey = `${query.toLowerCase()}::${pageToken}`;

  if (!YOUTUBE_API_KEY) {
    return res.status(503).json({
      error: 'YouTube search is not configured on the server.',
      code: 'youtube_api_key_missing',
    });
  }

  if (!query) {
    return res.json({ items: [], nextPageToken: null });
  }

  const cached = youtubeSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json(cached.payload);
  }

  if (cached) {
    youtubeSearchCache.delete(cacheKey);
  }

  try {
    const params = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      videoCategoryId: '10',
      videoEmbeddable: 'true',
      videoSyndicated: 'true',
      maxResults: '12',
      q: query,
      key: YOUTUBE_API_KEY,
    });

    if (pageToken) params.set('pageToken', pageToken);

    const { response, data } = await requestYouTubeSearch(params);

    if (!response.ok) {
      const reason = data?.error?.errors?.[0]?.reason || '';
      if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
        return res.status(429).json({
          error: 'YouTube search quota is exhausted for now. It usually resets daily, or you can switch to a fresh API key/project.',
          code: 'youtube_quota_exceeded',
        });
      }

      return res.status(response.status).json({
        error: data?.error?.message || 'Failed to search YouTube.',
        code: 'youtube_search_failed',
      });
    }

    const baseItems = formatYouTubeSearchItems(data);
    const preferredArtist = inferPreferredArtistFromSearchResults(query, baseItems);
    const rankedItems = baseItems
      .map((item) => ({
        item,
        rank: scoreGenericSearchCandidate(query, item, preferredArtist),
      }))
      .sort((a, b) => b.rank - a.rank || a.item.title.length - b.item.title.length)
      .map(({ item }) => item)
      .slice(0, 5);

    const payload = {
      items: rankedItems,
      nextPageToken: data.nextPageToken || null,
    };

    youtubeSearchCache.set(cacheKey, {
      expiresAt: Date.now() + YOUTUBE_SEARCH_CACHE_TTL_MS,
      payload,
    });

    return res.json(payload);
  } catch (error) {
    return res.status(500).json({
      error: 'Unable to reach YouTube search right now.',
      code: 'youtube_search_unavailable',
    });
  }
});

app.get('/api/youtube/suggestions', async (req, res) => {
  const videoId = String(req.query.videoId || '').trim();
  const title = String(req.query.title || '').trim();
  const artist = String(req.query.artist || '').trim();
  const cacheKey = `${videoId}::${title.toLowerCase()}::${artist.toLowerCase()}`;

  if (!YOUTUBE_API_KEY || (!videoId && !title && !artist)) {
    return res.json({ items: [] });
  }

  const cached = youtubeSuggestionsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return res.json(cached.payload);
  }

  if (cached) {
    youtubeSuggestionsCache.delete(cacheKey);
  }

  try {
    const candidateItems = [];

    if (videoId) {
      const relatedParams = new URLSearchParams({
        part: 'snippet',
        type: 'video',
        relatedToVideoId: videoId,
        videoEmbeddable: 'true',
        videoSyndicated: 'true',
        maxResults: '8',
        key: YOUTUBE_API_KEY,
      });
      const { response, data } = await requestYouTubeSearch(relatedParams);
      if (response.ok) {
        candidateItems.push(...formatYouTubeSearchItems(data));
      }
    }

    const fallbackQuery = buildSuggestionQuery(title, artist);
    if (candidateItems.length < 5 && fallbackQuery) {
      const fallbackParams = new URLSearchParams({
        part: 'snippet',
        type: 'video',
        videoEmbeddable: 'true',
        videoSyndicated: 'true',
        maxResults: '8',
        q: fallbackQuery,
        key: YOUTUBE_API_KEY,
      });
      const { response, data } = await requestYouTubeSearch(fallbackParams);
      if (response.ok) {
        candidateItems.push(...formatYouTubeSearchItems(data));
      }
    }

    const payload = {
      items: dedupeSearchItems(candidateItems, videoId).slice(0, 6),
    };

    youtubeSuggestionsCache.set(cacheKey, {
      expiresAt: Date.now() + YOUTUBE_SUGGESTIONS_CACHE_TTL_MS,
      payload,
    });

    return res.json(payload);
  } catch {
    return res.json({ items: [] });
  }
});

app.get('/api/youtube/playlist-preview', async (req, res) => {
  const playlistId = String(req.query.playlistId || '').trim();

  if (!YOUTUBE_API_KEY) {
    return res.status(503).json({
      error: 'Playlist import is not configured on the server.',
      code: 'youtube_api_key_missing',
    });
  }

  if (!playlistId) {
    return res.status(400).json({
      error: 'Playlist link is missing a list id.',
      code: 'playlist_id_missing',
    });
  }

  try {
    const preview = await fetchPlaylistPreview(playlistId);
    return res.json(preview);
  } catch (error) {
    return res.status(400).json({
      error: error.message || 'Unable to preview that playlist right now.',
      code: 'playlist_preview_failed',
    });
  }
});

app.get('/api/youtube/match-search', async (req, res) => {
  const query = String(req.query.q || '').trim();
  if (!query) {
    return res.json({ items: [] });
  }

  try {
    const items = await searchYouTubeManualMatch(query);
    return res.json({ items });
  } catch (error) {
    const status = error.code === 'youtube_quota_exceeded' ? 429 : 400;
    return res.status(status).json({
      error: error.message || 'Unable to search YouTube right now.',
      code: error.code || 'youtube_match_search_failed',
    });
  }
});

app.get('/api/youtube/video-meta', async (req, res) => {
  const videoId = String(req.query.videoId || '').trim();

  if (!videoId) {
    return res.status(400).json({
      error: 'Video id is missing.',
      code: 'video_id_missing',
    });
  }

  try {
    const meta = await fetchYouTubeVideoMeta(videoId);
    return res.json(meta);
  } catch (error) {
    const status = error.code === 'youtube_quota_exceeded' ? 429 : 400;
    return res.status(status).json({
      error: error.message || 'Unable to load that track right now.',
      code: error.code || 'youtube_video_meta_failed',
    });
  }
});

app.get('/api/spotify/session', async (req, res) => {
  const { sid, session } = getSpotifySessionFromRequest(req);
  if (!sid || !session || (!session.accessToken && !session.refreshToken)) {
    return res.json({
      connected: false,
      authUrl: buildSpotifyAuthStartPath(req.get('referer') || '/'),
    });
  }

  try {
    await getSpotifyUserAccessToken(req);
    return res.json({
      connected: true,
      displayName: session.displayName || 'Spotify',
      spotifyUserId: session.spotifyUserId || '',
    });
  } catch (error) {
    return res.json({
      connected: false,
      authUrl: buildSpotifyAuthStartPath(req.get('referer') || '/'),
      error: error.message || 'Connect Spotify to continue.',
    });
  }
});

app.get('/api/spotify/session/claim', (req, res) => {
  purgeExpiredSpotifyTransferTokens();
  const token = String(req.query.token || '').trim();
  if (!token) {
    return res.status(400).json({
      connected: false,
      error: 'Spotify transfer token is missing.',
      code: 'spotify_transfer_token_missing',
    });
  }

  const transfer = spotifySessionTransferStore.get(token);
  if (!transfer || transfer.expiresAt <= Date.now()) {
    spotifySessionTransferStore.delete(token);
    return res.status(400).json({
      connected: false,
      error: 'Spotify sign-in handoff expired. Connect Spotify again.',
      code: 'spotify_transfer_token_expired',
    });
  }

  spotifySessionTransferStore.delete(token);
  const { session } = ensureSpotifyBrowserSession(req, res);
  session.accessToken = transfer.session.accessToken || '';
  session.refreshToken = transfer.session.refreshToken || '';
  session.expiresAt = Number(transfer.session.expiresAt || 0);
  session.displayName = transfer.session.displayName || '';
  session.spotifyUserId = transfer.session.spotifyUserId || '';
  session.connectedAt = Number(transfer.session.connectedAt || Date.now());
  session.lastSeenAt = Date.now();

  return res.json({
    connected: true,
    displayName: session.displayName || 'Spotify',
    spotifyUserId: session.spotifyUserId || '',
  });
});

app.get('/api/spotify/auth/start', (req, res) => {
  const returnTo = sanitizeReturnTo(req.query.returnTo || req.get('referer') || '/');
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    return res.redirect(appendQueryParams(returnTo, {
      spotify: 'error',
      spotify_message: 'Spotify import is not configured on the server yet.',
    }));
  }

  const { sid } = ensureSpotifyBrowserSession(req, res);
  const authUrl = buildSpotifyAuthUrl(req, sid, returnTo, getRequestOrigin(req));
  return res.redirect(authUrl);
});

app.get('/api/spotify/callback', async (req, res) => {
  purgeExpiredSpotifyAuthStates();
  const state = String(req.query.state || '').trim();
  const code = String(req.query.code || '').trim();
  const errorParam = String(req.query.error || '').trim();
  const authState = spotifyAuthStateStore.get(state);
  const fallbackReturnTo = '/';

  if (!authState) {
    return res.redirect(appendQueryParams(fallbackReturnTo, {
      spotify: 'error',
      spotify_message: 'Spotify sign-in expired. Start the connect flow again.',
    }));
  }

  spotifyAuthStateStore.delete(state);
  const returnTo = sanitizeReturnTo(authState.returnTo || fallbackReturnTo);
  const returnOrigin = resolveSafeReturnOrigin(req, authState.returnOrigin || '');
  const returnTarget = returnOrigin ? new URL(returnTo, `${returnOrigin}/`).toString() : returnTo;
  const callbackOrigin = getRequestOrigin(req);
  const { sid, session } = ensureSpotifyBrowserSession(req, res);

  if (sid !== authState.sid && returnOrigin === callbackOrigin) {
    return res.redirect(appendQueryParams(returnTarget, {
      spotify: 'error',
      spotify_message: 'Spotify sign-in session changed. Try connecting again.',
    }));
  }

  if (errorParam) {
    return res.redirect(appendQueryParams(returnTarget, {
      spotify: 'error',
      spotify_message: errorParam === 'access_denied'
        ? 'Spotify access was cancelled before Jammin could import the playlist.'
        : 'Spotify sign-in was interrupted. Try again.',
    }));
  }

  if (!code) {
    return res.redirect(appendQueryParams(returnTarget, {
      spotify: 'error',
      spotify_message: 'Spotify did not return a login code. Try again.',
    }));
  }

  try {
    const auth = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const redirectUri = resolveSpotifyRedirectUri(req);
    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });
    const tokenData = await tokenResponse.json();

    if (!tokenResponse.ok || !tokenData.access_token) {
      throw new Error(tokenData?.error_description || tokenData?.error || 'Spotify did not finish the sign-in flow.');
    }

    session.accessToken = tokenData.access_token;
    session.refreshToken = tokenData.refresh_token || session.refreshToken || '';
    session.expiresAt = Date.now() + (Number(tokenData.expires_in || 3600) * 1000);
    session.connectedAt = Date.now();
    session.lastSeenAt = Date.now();

    try {
      const { response: profileResponse, data: profileData } = await fetchSpotifyCurrentUserProfile(session.accessToken);
      if (profileResponse.ok) {
        session.displayName = profileData.display_name || profileData.id || 'Spotify';
        session.spotifyUserId = profileData.id || '';
      }
    } catch (profileError) {
      // Keep the auth session even if profile lookup fails.
    }

    spotifyUserSessionStore.set(sid, session);

    if (returnOrigin && returnOrigin !== callbackOrigin) {
      purgeExpiredSpotifyTransferTokens();
      const transferToken = crypto.randomBytes(18).toString('hex');
      spotifySessionTransferStore.set(transferToken, {
        expiresAt: Date.now() + SPOTIFY_TRANSFER_TOKEN_TTL_MS,
        session: {
          accessToken: session.accessToken,
          refreshToken: session.refreshToken,
          expiresAt: session.expiresAt,
          displayName: session.displayName,
          spotifyUserId: session.spotifyUserId,
          connectedAt: session.connectedAt,
        },
      });

      return res.redirect(appendQueryParams(returnTarget, {
        spotify: 'connected',
        spotify_transfer: transferToken,
      }));
    }

    return res.redirect(appendQueryParams(returnTarget, {
      spotify: 'connected',
    }));
  } catch (error) {
    return res.redirect(appendQueryParams(returnTarget, {
      spotify: 'error',
      spotify_message: error.message || 'Spotify sign-in failed. Try again.',
    }));
  }
});

app.get('/api/spotify/playlist-review', async (req, res) => {
  const playlistId = String(req.query.playlistId || '').trim();
  const offset = Number(req.query.offset || 0);

  if (!playlistId) {
    return res.status(400).json({
      error: 'Spotify playlist link is missing a playlist id.',
      code: 'spotify_playlist_id_missing',
    });
  }

  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    return res.status(503).json({
      error: 'Spotify playlist import is not configured on the server.',
      code: 'spotify_api_credentials_missing',
    });
  }

  try {
    const spotifyAccessToken = await getSpotifyUserAccessToken(req);
    const review = await buildSpotifyReviewPage(playlistId, offset, SPOTIFY_REVIEW_PAGE_SIZE, spotifyAccessToken);
    return res.json(review);
  } catch (error) {
    if (error.code === 'spotify_auth_required') {
      return res.status(401).json({
        error: error.message || 'Connect Spotify to review playlists from your account.',
        code: 'spotify_auth_required',
        authUrl: buildSpotifyAuthStartPath(req.get('referer') || '/'),
      });
    }

    const lowerMessage = String(error.message || '').toLowerCase();
    const status =
      lowerMessage.includes('quota') ? 429 :
      lowerMessage.includes('spotify') ? 400 :
      500;

    return res.status(status).json({
      error: error.message || 'Unable to prepare that Spotify playlist right now.',
      code: 'spotify_playlist_review_failed',
    });
  }
});

app.use('/api', (req, res) => {
  return res.status(404).json({
    error: 'This Jammin server is missing that API route. Restart the server and refresh the page.',
    code: 'api_route_not_found',
  });
});

// WebSocket connection handler
wss.on('connection', (ws) => {
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    handleMessage(ws, msg);
  });

  ws.on('close', () => {
    const result = leaveSession(ws, (expiredResult) => {
      if (expiredResult && !expiredResult.destroyed) {
        broadcast(expiredResult.session, {
          type: 'PARTICIPANT_UPDATE',
          participants: getParticipantList(expiredResult.session),
        });
        broadcast(expiredResult.session, {
          type: 'USER_LEFT',
          userId: expiredResult.leftUserId,
        });
        if (expiredResult.controlTransfer) {
          broadcast(expiredResult.session, {
            type: 'CONTROL_TRANSFERRED',
            ...expiredResult.controlTransfer,
            reason: 'controller_left',
          });
        }
      }
    });
    if (result && !result.destroyed && !result.deferred) {
      broadcast(result.session, {
        type: 'PARTICIPANT_UPDATE',
        participants: getParticipantList(result.session),
      });
      broadcast(result.session, {
        type: 'USER_LEFT',
        userId: result.leftUserId,
      });
      if (result.controlTransfer) {
        broadcast(result.session, {
          type: 'CONTROL_TRANSFERRED',
          ...result.controlTransfer,
          reason: 'controller_left',
        });
      }
    }
  });
});

// Heartbeat to detect dead connections
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

// Message Router
function handleMessage(ws, msg) {
  const { type } = msg;

  switch (type) {
    case 'CREATE_SESSION':
      return handleCreateSession(ws, msg);
    case 'JOIN_SESSION':
      return handleJoinSession(ws, msg);
    case 'ADD_TO_QUEUE':
      return handleAddToQueue(ws, msg);
    case 'PLAY_NEXT':
      return handlePlayNext(ws, msg);
    case 'ADD_PLAYLIST_TO_QUEUE':
      return handleAddPlaylistToQueue(ws, msg);
    case 'PLAYLIST_PLAY_NEXT':
      return handlePlayNextPlaylistMsg(ws, msg);
    case 'ADD_MAPPED_PLAYLIST_TO_QUEUE':
      return handleAddMappedPlaylistToQueue(ws, msg);
    case 'REPLACE_QUEUE_WITH_MAPPED_PLAYLIST':
      return handleReplaceQueueWithMappedPlaylist(ws, msg);
    case 'REORDER_QUEUE':
      return handleReorderQueue(ws, msg);
    case 'REMOVE_FROM_QUEUE':
      return handleRemoveFromQueue(ws, msg);
    case 'REMOVE_PLAYLIST_GROUP':
      return handleRemovePlaylistGroupMsg(ws, msg);
    case 'PLAY_SELECTED':
      return handlePlaySelected(ws, msg);
    case 'PLAY_PLAYLIST_GROUP':
      return handlePlayPlaylistGroupMsg(ws, msg);
    case 'REQUEUE_HISTORY_ITEM':
      return handleRequeueHistoryItem(ws, msg);
    case 'TRANSFER_HOST':
      return handleTransferHostMsg(ws, msg);
    case 'SEND_CHAT_MESSAGE':
      return handleSendChatMessage(ws, msg);
    case 'TIME_REPORT':
      return handleTimeReportMsg(ws, msg);
    case 'PLAYER_READY':
      return handlePlayerReadyMsg(ws, msg);
    case 'AD_START':
      return handleAdStartMsg(ws, msg);
    case 'AD_END':
      return handleAdEndMsg(ws, msg);
    case 'GO_LIVE':
      return handleGoLiveMsg(ws, msg);
    case 'VIDEO_ENDED':
      return handleVideoEndedMsg(ws, msg);
    case 'SEEK':
      return handleSeekMsg(ws, msg);
    case 'PAUSE':
      return handlePauseMsg(ws, msg);
    case 'RESUME':
      return handleResumeMsg(ws, msg);
    case 'SKIP_TRACK':
      return handleSkipTrackMsg(ws, msg);
    case 'PLAYER_ERROR':
      return handlePlayerErrorMsg(ws, msg);
    case 'PREV_TRACK':
      return handlePrevTrackMsg(ws, msg);
    default:
      send(ws, { type: 'ERROR', message: 'Unknown message type' });
  }
}

// Handler implementations

function handleCreateSession(ws, msg) {
  const username = (msg.username || 'Anonymous').slice(0, 20);
  const { code, userId, session, reconnectToken } = createSession(ws, username);

  send(ws, {
    type: 'SESSION_CREATED',
    code,
    userId,
    username,
    isHost: true,
    playbackMode: 'player',
    reconnectToken,
    participants: getParticipantList(session),
    chat: getChatHistory(session),
  });
}

function handleJoinSession(ws, msg) {
  const code = (msg.code || '').toUpperCase().trim();
  const username = (msg.username || 'Anonymous').slice(0, 20);
  const playbackMode = msg.playbackMode === 'viewer' ? 'viewer' : 'player';
  const reconnectToken = String(msg.reconnectToken || '').trim();

  const result = joinSession(code, ws, username, playbackMode, reconnectToken);

  if (result.error) {
    return send(ws, { type: 'ERROR', message: result.error });
  }

  const { userId, session } = result;

  send(ws, {
    type: 'SESSION_JOINED',
    code,
    userId,
    username,
    isHost: false,
    playbackMode,
    reconnectToken: result.reconnectToken || reconnectToken,
    resumed: Boolean(result.rejoined),
    participants: getParticipantList(session),
    chat: getChatHistory(session),
  });

  // Notify others
  broadcast(session, {
    type: 'PARTICIPANT_UPDATE',
    participants: getParticipantList(session),
  }, userId);

  if (!result.rejoined) {
    broadcast(session, {
      type: 'USER_JOINED',
      userId,
      username,
    }, userId);
  }

  // Send current session state to the new user
  handleNewJoin(session, userId);
}

async function handleAddToQueue(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session) return send(ws, { type: 'ERROR', message: 'Not in a session' });

  const videoId = parseYouTubeUrl(msg.videoUrl || '');
  if (!videoId) return send(ws, { type: 'ERROR', message: 'Invalid YouTube URL' });

  const details = await fetchVideoDetails(videoId);
  if (!details.allowed) {
    return send(ws, {
      type: 'ERROR',
      message: details.reason || 'This video cannot be played inside the embedded player',
    });
  }

  const videoInfo = {
    videoId,
    title: details.title,
    artist: details.artist,
    thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
  };

  const result = addToQueue(session, videoInfo, ws._jammin.username);

  if (result.autoPlay) {
    startPlayback(session, result.item);
  }
}

async function handlePlayNext(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session) return send(ws, { type: 'ERROR', message: 'Not in a session' });
  if (session.host !== ws._jammin.userId) return send(ws, { type: 'ERROR', message: 'Only the controller can play next' });

  const videoId = parseYouTubeUrl(msg.videoUrl || '');
  if (!videoId) return send(ws, { type: 'ERROR', message: 'Invalid YouTube URL' });

  const details = await fetchVideoDetails(videoId);
  if (!details.allowed) {
    return send(ws, {
      type: 'ERROR',
      message: details.reason || 'This video cannot be played inside the embedded player',
    });
  }

  const videoInfo = {
    videoId,
    title: details.title,
    artist: details.artist,
    thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
  };

  const result = playNext(session, videoInfo, ws._jammin.username);

  if (result.autoPlay) {
    startPlayback(session, result.item);
  }
}

async function handleAddPlaylistToQueue(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session) return send(ws, { type: 'ERROR', message: 'Not in a session' });

  const playlistId = String(msg.playlistId || '').trim() || parseYouTubePlaylistUrl(msg.playlistUrl || '');
  if (!playlistId) return send(ws, { type: 'ERROR', message: 'Invalid YouTube playlist link' });

  try {
    const playlist = await fetchPlaylistImport(playlistId);
    if (!playlist.items.length) {
      return send(ws, { type: 'ERROR', message: 'No playable tracks were found in that playlist' });
    }

    const result = addPlaylistToQueue(session, playlist, ws._jammin.username);
    if (result.autoPlay) {
      startPlayback(session, result.item);
    }
  } catch (error) {
    return send(ws, { type: 'ERROR', message: error.message || 'Unable to import that playlist right now' });
  }
}

async function handlePlayNextPlaylistMsg(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session) return send(ws, { type: 'ERROR', message: 'Not in a session' });
  if (session.host !== ws._jammin.userId) return send(ws, { type: 'ERROR', message: 'Only the controller can play next' });

  const playlistId = String(msg.playlistId || '').trim() || parseYouTubePlaylistUrl(msg.playlistUrl || '');
  if (!playlistId) return send(ws, { type: 'ERROR', message: 'Invalid YouTube playlist link' });

  try {
    const playlist = await fetchPlaylistImport(playlistId);
    if (!playlist.items.length) {
      return send(ws, { type: 'ERROR', message: 'No playable tracks were found in that playlist' });
    }

    const result = playNextPlaylist(session, playlist, ws._jammin.username);
    if (result.autoPlay) {
      startPlayback(session, result.item);
    }
  } catch (error) {
    return send(ws, { type: 'ERROR', message: error.message || 'Unable to import that playlist right now' });
  }
}

function handleAddMappedPlaylistToQueue(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin) return send(ws, { type: 'ERROR', message: 'Not in a session' });

  const playlist = normalizeImportedPlaylistPayload(msg.playlist);
  if (!playlist.items.length) {
    return send(ws, { type: 'ERROR', message: 'Choose at least one matched track first' });
  }

  const result = addPlaylistToQueue(session, playlist, ws._jammin.username);
  if (result.autoPlay) {
    startPlayback(session, result.item);
  }
}

function handleReplaceQueueWithMappedPlaylist(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin) return send(ws, { type: 'ERROR', message: 'Not in a session' });
  if (session.host !== ws._jammin.userId) {
    return send(ws, { type: 'ERROR', message: 'Only the controller can replace the queue' });
  }

  const playlist = normalizeImportedPlaylistPayload(msg.playlist);
  if (!playlist.items.length) {
    return send(ws, { type: 'ERROR', message: 'Choose at least one matched track first' });
  }

  const result = replaceQueueWithPlaylist(session, playlist, ws._jammin.username);
  if (result.autoPlay) {
    startPlayback(session, result.item);
  }
}

function handleReorderQueue(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin || session.host !== ws._jammin.userId) return;
  reorderQueue(session, msg.fromIndex, msg.toIndex);
}

function handleRemoveFromQueue(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin || session.host !== ws._jammin.userId) return;
  removeFromQueue(session, msg.itemId);
}

function handleRemovePlaylistGroupMsg(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin || session.host !== ws._jammin.userId) return;
  removePlaylistGroup(session, msg.playlistGroupId);
}

function handlePlaySelected(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin || session.host !== ws._jammin.userId) return;

  const item = playSelected(session, msg.itemId);
  if (item) {
    startPlayback(session, item);
  }
}

function handlePlayPlaylistGroupMsg(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin || session.host !== ws._jammin.userId) return;

  const item = playPlaylistGroup(session, msg.playlistGroupId);
  if (item) {
    startPlayback(session, item);
  }
}

function handleRequeueHistoryItem(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin || session.host !== ws._jammin.userId) return;
  requeueHistoryItem(session, msg.itemId, msg.toIndex);
}

function handleTransferHostMsg(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin) return;
  if (session.host !== ws._jammin.userId) {
    return send(ws, { type: 'ERROR', message: 'Only the controller can pass controls' });
  }

  const targetUserId = String(msg.targetUserId || '').trim();
  if (!targetUserId || targetUserId === session.host) {
    return send(ws, { type: 'ERROR', message: 'Choose someone else to pass controls to' });
  }

  const transfer = transferHost(session, targetUserId);
  if (!transfer) {
    return send(ws, { type: 'ERROR', message: 'That viber is no longer in the room' });
  }

  broadcast(session, {
    type: 'PARTICIPANT_UPDATE',
    participants: getParticipantList(session),
  });

  broadcast(session, {
    type: 'CONTROL_TRANSFERRED',
    ...transfer,
    reason: 'manual',
  });
}

function handleSendChatMessage(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin) return;

  const participant = session.participants.get(ws._jammin.userId);
  if (!participant) return;

  const text = String(msg.text || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return send(ws, { type: 'ERROR', message: 'Write something before sending' });
  }

  if (text.length > CHAT_MESSAGE_LIMIT) {
    return send(ws, {
      type: 'ERROR',
      message: `Keep chat messages under ${CHAT_MESSAGE_LIMIT} characters`,
    });
  }

  const now = Date.now();
  if (participant.lastChatAt && now - participant.lastChatAt < CHAT_RATE_LIMIT_MS) {
    return send(ws, { type: 'ERROR', message: 'Slow down a little on chat' });
  }
  participant.lastChatAt = now;

  const message = addChatMessage(session, {
    userId: ws._jammin.userId,
    username: ws._jammin.username,
    text,
  });

  broadcast(session, {
    type: 'CHAT_MESSAGE',
    message,
  });
}

function handleTimeReportMsg(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin) return;
  handleTimeReport(session, ws._jammin.userId, msg.currentTime);
}

function handlePlayerReadyMsg(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin) return;
  handlePlayerReady(session, ws._jammin.userId);
}

function handleAdStartMsg(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin) return;
  handleAdStart(session, ws._jammin.userId);
}

function handleAdEndMsg(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin) return;
  handleAdEnd(session, ws._jammin.userId);
}

function handleGoLiveMsg(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin) return;
  handleGoLive(session, ws._jammin.userId);
}

function handleVideoEndedMsg(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin) return;
  handleVideoEnded(session, ws._jammin.userId, {
    videoId: msg.videoId,
    currentTime: msg.currentTime,
    duration: msg.duration,
  });
}

function handleSeekMsg(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin) return;
  handleSeek(session, ws._jammin.userId, msg.seekTime);
}

function handlePauseMsg(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin) return;
  handlePause(session, ws._jammin.userId);
}

function handleResumeMsg(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin) return;
  handleResume(session, ws._jammin.userId, msg.currentTime);
}

function handleSkipTrackMsg(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin) return;
  handleSkipTrack(session, ws._jammin.userId);
}

function handlePlayerErrorMsg(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin) return;

  handlePlayerError(session, ws._jammin.userId, {
    videoId: msg.videoId,
    code: msg.code,
  });
}

function handlePrevTrackMsg(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin) return;
  handlePrevTrack(session, ws._jammin.userId);
}

// Utility
function send(ws, data) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

// Fetch video title from YouTube oEmbed API
async function fetchVideoDetails(videoId) {
  if (YOUTUBE_API_KEY) {
    try {
      const params = new URLSearchParams({
        part: 'snippet,status,contentDetails',
        id: videoId,
        key: YOUTUBE_API_KEY,
      });
      const response = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params.toString()}`);
      const data = await response.json();

      if (response.ok) {
        const video = data.items?.[0];
        if (video) {
          const embeddable = video.status?.embeddable !== false;
          const privacyStatus = video.status?.privacyStatus || 'public';

          if (!embeddable || privacyStatus !== 'public') {
            return {
              allowed: false,
              reason: 'This video is not allowed to play inside Jammin',
              title: video.snippet?.title || 'Untitled',
              artist: video.snippet?.channelTitle || '',
            };
          }

          return {
            allowed: true,
            title: video.snippet?.title || 'Untitled',
            artist: video.snippet?.channelTitle || '',
            duration: formatDurationMs(parseIsoDurationToMs(video.contentDetails?.duration)),
          };
        }
      }
    } catch (e) {
      // Fall back to oEmbed below
    }
  }

  try {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      return {
        allowed: true,
        title: data.title || 'Untitled',
        artist: data.author_name || '',
        duration: '',
      };
    }
  } catch (e) {
    // Silently fail
  }
  return {
    allowed: true,
    title: 'Untitled',
    artist: '',
  };
}

server.listen(PORT, () => {
  console.log(`🎵 Jammin server running on http://localhost:${PORT}`);
});
