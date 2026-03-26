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
  reorderQueue,
  removeFromQueue,
  playSelected,
  getQueueList,
  requeueHistoryItem,
  parseYouTubeUrl,
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
const CHAT_MESSAGE_LIMIT = 320;
const CHAT_RATE_LIMIT_MS = 400;
const YOUTUBE_SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const youtubeSearchCache = new Map();

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

    const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params.toString()}`);
    const data = await response.json();

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

    const items = (data.items || [])
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

    const payload = {
      items,
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
    case 'REORDER_QUEUE':
      return handleReorderQueue(ws, msg);
    case 'REMOVE_FROM_QUEUE':
      return handleRemoveFromQueue(ws, msg);
    case 'PLAY_SELECTED':
      return handlePlaySelected(ws, msg);
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

function handlePlaySelected(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session || !ws._jammin || session.host !== ws._jammin.userId) return;

  const item = playSelected(session, msg.itemId);
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
