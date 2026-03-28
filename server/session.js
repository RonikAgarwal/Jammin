// Session & Room Management

const sessions = new Map();
const MAX_CHAT_MESSAGES = 100;
const RECONNECT_GRACE_MS = 90 * 1000;

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function sanitizePlaybackMode(playbackMode) {
  return playbackMode === 'viewer' ? 'viewer' : 'player';
}

function createSession(ws, username) {
  let code;
  do {
    code = generateCode();
  } while (sessions.has(code));

  const userId = generateUserId();
  const participant = createParticipant(ws, userId, username, true, 'player');

  const session = {
    code,
    host: userId,
    participants: new Map([[userId, participant]]),
    queue: [],
    chat: [],
    currentVideo: null,
    history: [],
    playbackState: 'idle', // idle | cueing | playing | paused
    referenceTime: 0,
    referenceStartedAt: null, // server timestamp when play started
    vibeSource: null,
    readyUsers: new Set(),
    preloadTimeout: null,
  };

  sessions.set(code, session);
  ws._jammin = {
    sessionCode: code,
    userId,
    username,
    playbackMode: 'player',
    reconnectToken: participant.reconnectToken,
  };

  return { code, userId, session, reconnectToken: participant.reconnectToken };
}

function joinSession(code, ws, username, playbackMode = 'player', reconnectToken = '') {
  const session = sessions.get(code);
  if (!session) return { error: 'Session not found' };

  const requestedReconnectToken = String(reconnectToken || '').trim();
  if (requestedReconnectToken) {
    const existingParticipant = [...session.participants.values()].find(
      (participant) => participant.reconnectToken === requestedReconnectToken
    );

    if (existingParticipant) {
      if (existingParticipant.disconnectTimer) {
        clearTimeout(existingParticipant.disconnectTimer);
        existingParticipant.disconnectTimer = null;
      }

      existingParticipant.ws = ws;
      existingParticipant.username = username || existingParticipant.username;
      existingParticipant.playbackMode = sanitizePlaybackMode(playbackMode || existingParticipant.playbackMode);
      existingParticipant.connected = true;
      existingParticipant.disconnectedAt = null;
      existingParticipant.status = existingParticipant.status === 'away' ? 'in-sync' : existingParticipant.status;

      ws._jammin = {
        sessionCode: code,
        userId: existingParticipant.userId,
        username: existingParticipant.username,
        playbackMode: existingParticipant.playbackMode,
        reconnectToken: existingParticipant.reconnectToken,
      };

      return {
        userId: existingParticipant.userId,
        session,
        reconnectToken: existingParticipant.reconnectToken,
        rejoined: true,
      };
    }
  }

  const userId = generateUserId();
  const participant = createParticipant(ws, userId, username, false, sanitizePlaybackMode(playbackMode));
  session.participants.set(userId, participant);

  ws._jammin = {
    sessionCode: code,
    userId,
    username,
    playbackMode: participant.playbackMode,
    reconnectToken: participant.reconnectToken,
  };

  return { userId, session, reconnectToken: participant.reconnectToken, rejoined: false };
}

function leaveSession(ws, onExpire = null) {
  if (!ws._jammin) return null;

  const { sessionCode, userId } = ws._jammin;
  const session = sessions.get(sessionCode);
  if (!session) return null;
  const leavingParticipant = session.participants.get(userId);
  if (!leavingParticipant) return null;

  leavingParticipant.ws = null;
  leavingParticipant.connected = false;
  leavingParticipant.disconnectedAt = Date.now();
  leavingParticipant.status = 'away';

  if (leavingParticipant.disconnectTimer) {
    clearTimeout(leavingParticipant.disconnectTimer);
  }

  leavingParticipant.disconnectTimer = setTimeout(() => {
    finalizeParticipantLeave(sessionCode, userId, onExpire);
  }, RECONNECT_GRACE_MS);

  return {
    destroyed: false,
    deferred: true,
    session,
    sessionCode,
    leftUserId: userId,
  };
}

function finalizeParticipantLeave(sessionCode, userId, onExpire = null) {
  const session = sessions.get(sessionCode);
  if (!session) return null;

  const leavingParticipant = session.participants.get(userId);
  if (!leavingParticipant || leavingParticipant.connected) return null;
  const leavingUsername = leavingParticipant.username;

  if (leavingParticipant.disconnectTimer) {
    clearTimeout(leavingParticipant.disconnectTimer);
    leavingParticipant.disconnectTimer = null;
  }

  session.participants.delete(userId);
  session.readyUsers.delete(userId);

  let controlTransfer = null;
  if (session.host === userId && session.participants.size > 0) {
    const nextHostParticipant = [...session.participants.entries()].find(([, participant]) => participant.connected)
      || [...session.participants.entries()][0];
    const nextHost = nextHostParticipant ? nextHostParticipant[0] : null;
    if (nextHost) {
      controlTransfer = transferHost(session, nextHost, userId);
      if (controlTransfer) {
        controlTransfer.fromUsername = leavingUsername || 'Someone';
      }
    }
  }

  let result;
  if (session.participants.size === 0) {
    if (session.preloadTimeout) clearTimeout(session.preloadTimeout);
    sessions.delete(sessionCode);
    result = { destroyed: true, sessionCode, leftUserId: userId };
  } else {
    result = { destroyed: false, session, sessionCode, leftUserId: userId, controlTransfer };
  }

  if (typeof onExpire === 'function') {
    onExpire(result);
  }

  return result;
}

function getSession(code) {
  return sessions.get(code);
}

function getSessionByWs(ws) {
  if (!ws._jammin) return null;
  return sessions.get(ws._jammin.sessionCode);
}

function getCurrentReferenceTime(session) {
  if (session.playbackState !== 'playing' || !session.referenceStartedAt) {
    return session.referenceTime;
  }
  const elapsed = (Date.now() - session.referenceStartedAt) / 1000;
  return session.referenceTime + elapsed;
}

function broadcast(session, message, excludeUserId = null) {
  const data = JSON.stringify(message);
  session.participants.forEach((participant, id) => {
    if (id !== excludeUserId && participant.connected !== false && participant.ws && participant.ws.readyState === 1) {
      participant.ws.send(data);
    }
  });
}

function sendTo(session, userId, message) {
  const participant = session.participants.get(userId);
  if (participant && participant.connected !== false && participant.ws && participant.ws.readyState === 1) {
    participant.ws.send(JSON.stringify(message));
  }
}

function getParticipantList(session) {
  const list = [];
  session.participants.forEach((p, id) => {
    list.push({
      userId: id,
      username: p.username,
      isHost: p.isHost,
      playbackMode: p.playbackMode || 'player',
      status: p.status,
      connected: p.connected !== false,
    });
  });
  return list;
}

function addChatMessage(session, { userId, username, text }) {
  const message = {
    id: createMessageId(),
    userId,
    username: (username || 'Anonymous').slice(0, 20),
    text,
    sentAt: Date.now(),
  };

  session.chat.push(message);
  if (session.chat.length > MAX_CHAT_MESSAGES) {
    session.chat.splice(0, session.chat.length - MAX_CHAT_MESSAGES);
  }

  return message;
}

function getChatHistory(session) {
  return Array.isArray(session.chat) ? session.chat.slice() : [];
}

function transferHost(session, nextHostUserId, previousHostId = session.host) {
  const nextHostParticipant = session.participants.get(nextHostUserId);
  if (!nextHostParticipant) return null;
  const previousHostParticipant = previousHostId ? session.participants.get(previousHostId) : null;

  session.participants.forEach((participant, participantId) => {
    participant.isHost = participantId === nextHostUserId;
  });

  session.host = nextHostUserId;

  return {
    fromUserId: previousHostId,
    fromUsername: previousHostParticipant ? previousHostParticipant.username : null,
    toUserId: nextHostUserId,
    toUsername: nextHostParticipant.username,
  };
}

// Helpers

function generateUserId() {
  return 'u_' + Math.random().toString(36).substring(2, 10);
}

function createMessageId() {
  return 'm_' + Math.random().toString(36).substring(2, 10);
}

function createParticipant(ws, userId, username, isHost, playbackMode = 'player') {
  return {
    ws,
    userId,
    username,
    isHost,
    playbackMode: sanitizePlaybackMode(playbackMode),
    reconnectToken: generateReconnectToken(),
    connected: true,
    disconnectedAt: null,
    disconnectTimer: null,
    status: 'in-sync', // in-sync | behind | away | unstable
    lastReportedTime: 0,
    lagHistory: [],
    lastChatAt: 0,
  };
}

function generateReconnectToken() {
  return `r_${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 12)}`;
}

module.exports = {
  createSession,
  joinSession,
  leaveSession,
  finalizeParticipantLeave,
  getSession,
  getSessionByWs,
  getCurrentReferenceTime,
  broadcast,
  sendTo,
  getParticipantList,
  addChatMessage,
  getChatHistory,
  transferHost,
};
