// Jammin — Main Server
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const {
  createSession,
  joinSession,
  leaveSession,
  getSession,
  getSessionByWs,
  broadcast,
  getParticipantList,
} = require('./session');

const {
  addToQueue,
  playNext,
  reorderQueue,
  removeFromQueue,
  playSelected,
  getQueueList,
  parseYouTubeUrl,
} = require('./queue');

const {
  initiatePreload,
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
} = require('./sync');

const { handleTimeReport } = require('./lag');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;

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

  const title = await fetchVideoTitle(videoId);
  const videoInfo = {
    videoId,
    title,
    thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
  };

  const result = addToQueue(session, videoInfo, ws._jammin.username);

  if (result.autoPlay) {
    initiatePreload(session, result.item);
  }
}

async function handlePlayNext(ws, msg) {
  const session = getSessionByWs(ws);
  if (!session) return send(ws, { type: 'ERROR', message: 'Not in a session' });
  if (session.host !== ws._jammin.userId) return send(ws, { type: 'ERROR', message: 'Only the host can play next' });

  const videoId = parseYouTubeUrl(msg.videoUrl || '');
  if (!videoId) return send(ws, { type: 'ERROR', message: 'Invalid YouTube URL' });

  const title = await fetchVideoTitle(videoId);
  const videoInfo = {
    videoId,
    title,
    thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
  };

  const result = playNext(session, videoInfo, ws._jammin.username);

  if (result.autoPlay) {
    initiatePreload(session, result.item);
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
    initiatePreload(session, item);
  }
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
  handleVideoEnded(session, ws._jammin.userId);
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

// Utility
function send(ws, data) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

// Fetch video title from YouTube oEmbed API
async function fetchVideoTitle(videoId) {
  try {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const response = await fetch(url);
    if (response.ok) {
      const data = await response.json();
      return data.title || 'Untitled';
    }
  } catch (e) {
    // Silently fail
  }
  return 'Untitled';
}

server.listen(PORT, () => {
  console.log(`🎵 Jammin server running on http://localhost:${PORT}`);
});
