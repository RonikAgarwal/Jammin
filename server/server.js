// Jammin — Main Server
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

loadEnvFile(path.join(__dirname, '..', '.env'));

const {
  createSession,
  joinSession,
  leaveSession,
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
const youtubeSearchCache = new Map();
const youtubeSuggestionsCache = new Map();
const youtubePlaylistPreviewCache = new Map();
const youtubePlaylistImportCache = new Map();
const spotifyPlaylistMetaCache = new Map();
const spotifyPlaylistPageCache = new Map();
const spotifyTrackMatchCache = new Map();
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

async function requestYouTubeSearch(params) {
  const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params.toString()}`);
  const data = await response.json();
  return { response, data };
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

  const data = await response.json();
  if (!response.ok || !data.access_token) {
    throw new Error(data?.error_description || data?.error || 'Unable to authenticate with Spotify right now.');
  }

  spotifyTokenState = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in || 3600) * 1000),
  };

  return spotifyTokenState.accessToken;
}

async function requestSpotify(endpoint, params = {}) {
  const accessToken = await getSpotifyAccessToken();
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      query.set(key, String(value));
    }
  });

  const url = `https://api.spotify.com/v1${endpoint}${query.size ? `?${query.toString()}` : ''}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const data = await response.json();
  return { response, data };
}

async function fetchSpotifyPlaylistMeta(playlistId) {
  const cached = spotifyPlaylistMetaCache.get(playlistId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }
  if (cached) spotifyPlaylistMetaCache.delete(playlistId);

  const { response, data } = await requestSpotify(`/playlists/${playlistId}`, {
    market: 'IN',
    fields: 'id,name,images,owner(display_name),tracks(total),external_urls(spotify)',
  });

  if (!response.ok) {
    throw new Error(data?.error?.message || 'Unable to read that Spotify playlist.');
  }

  const payload = {
    playlistId: data.id || playlistId,
    title: data.name || 'Spotify Playlist',
    channelTitle: data.owner?.display_name || 'Spotify',
    thumbnail: data.images?.[0]?.url || '',
    itemCount: Number(data.tracks?.total || 0),
    externalUrl: data.external_urls?.spotify || '',
    source: 'spotify',
  };

  spotifyPlaylistMetaCache.set(playlistId, {
    expiresAt: Date.now() + SPOTIFY_PLAYLIST_CACHE_TTL_MS,
    payload,
  });

  return payload;
}

async function fetchSpotifyPlaylistTracksPage(playlistId, offset = 0, limit = SPOTIFY_REVIEW_PAGE_SIZE) {
  const safeOffset = clamp(Number(offset) || 0, 0, SPOTIFY_REVIEW_MAX_TRACKS);
  const safeLimit = clamp(Number(limit) || SPOTIFY_REVIEW_PAGE_SIZE, 1, SPOTIFY_REVIEW_PAGE_SIZE);
  const cacheKey = buildSpotifyPlaylistCacheKey(playlistId, safeOffset, safeLimit);
  const cached = spotifyPlaylistPageCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }
  if (cached) spotifyPlaylistPageCache.delete(cacheKey);

  const { response, data } = await requestSpotify(`/playlists/${playlistId}/tracks`, {
    market: 'IN',
    offset: safeOffset,
    limit: safeLimit,
    fields: 'items(track(id,name,duration_ms,is_local,artists(name),album(images),external_urls(spotify))),total,next',
  });

  if (!response.ok) {
    throw new Error(data?.error?.message || 'Unable to load tracks from that Spotify playlist.');
  }

  const payload = {
    total: Math.min(Number(data.total || 0), SPOTIFY_REVIEW_MAX_TRACKS),
    items: (data.items || [])
      .map((entry) => entry.track)
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

  let score = 0;

  const titleOverlap = computeOverlapRatio(titleWords, combinedCandidateWords);
  const artistOverlap = computeOverlapRatio(artistWords, combinedCandidateWords);

  score += Math.round(titleOverlap * 48);
  score += Math.round(artistOverlap * 24);

  if (titleContainsPhrase(candidate.title, track.title)) score += 18;
  if (track.artist && (titleContainsPhrase(candidate.title, track.artist) || titleContainsPhrase(candidate.channelTitle, track.artist))) {
    score += 12;
  }

  const durationDiffMs = Math.abs((track.durationMs || 0) - (candidate.durationMs || 0));
  if (durationDiffMs <= 5000) score += 22;
  else if (durationDiffMs <= 10000) score += 17;
  else if (durationDiffMs <= 15000) score += 12;
  else if (durationDiffMs <= 25000) score += 5;
  else score -= Math.min(24, Math.round(durationDiffMs / 4000));

  const titleText = normalizeMatchText(candidate.title);
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

  if (/\bofficial\b/.test(titleText)) score += 5;
  if (/\baudio\b/.test(titleText)) score += 4;
  if (/\blyrics?\b/.test(titleText)) score += 2;

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

async function buildSpotifyReviewPage(playlistId, offset = 0, limit = SPOTIFY_REVIEW_PAGE_SIZE) {
  const safeOffset = clamp(Number(offset) || 0, 0, SPOTIFY_REVIEW_MAX_TRACKS);
  const meta = await fetchSpotifyPlaylistMeta(playlistId);
  const trackPage = await fetchSpotifyPlaylistTracksPage(playlistId, safeOffset, limit);
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
  return candidates.map((candidate) => ({
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
      part: 'snippet,status',
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
      videoEmbeddable: 'true',
      videoSyndicated: 'true',
      maxResults: '5',
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

    const payload = {
      items: formatYouTubeSearchItems(data),
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
    const review = await buildSpotifyReviewPage(playlistId, offset, SPOTIFY_REVIEW_PAGE_SIZE);
    return res.json(review);
  } catch (error) {
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
    const result = leaveSession(ws);
    if (result && !result.destroyed) {
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
  const { code, userId, session } = createSession(ws, username);

  send(ws, {
    type: 'SESSION_CREATED',
    code,
    userId,
    username,
    isHost: true,
    participants: getParticipantList(session),
    chat: getChatHistory(session),
  });
}

function handleJoinSession(ws, msg) {
  const code = (msg.code || '').toUpperCase().trim();
  const username = (msg.username || 'Anonymous').slice(0, 20);

  const result = joinSession(code, ws, username);

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
    participants: getParticipantList(session),
    chat: getChatHistory(session),
  });

  // Notify others
  broadcast(session, {
    type: 'PARTICIPANT_UPDATE',
    participants: getParticipantList(session),
  }, userId);

  broadcast(session, {
    type: 'USER_JOINED',
    userId,
    username,
  }, userId);

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
        part: 'snippet,status',
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
