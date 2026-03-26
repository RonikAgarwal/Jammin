// Session & Room Management

const sessions = new Map();
const MAX_CHAT_MESSAGES = 100;

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

function createSession(ws, username) {
  let code;
  do {
    code = generateCode();
  } while (sessions.has(code));

  const userId = generateUserId();
  const participant = createParticipant(ws, userId, username, true);

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
  ws._jammin = { sessionCode: code, userId, username };

  return { code, userId, session };
}

function joinSession(code, ws, username) {
  const session = sessions.get(code);
  if (!session) return { error: 'Session not found' };

  const userId = generateUserId();
  const participant = createParticipant(ws, userId, username, false);
  session.participants.set(userId, participant);

  ws._jammin = { sessionCode: code, userId, username };

  return { userId, session };
}

function leaveSession(ws) {
  if (!ws._jammin) return null;

  const { sessionCode, userId } = ws._jammin;
  const session = sessions.get(sessionCode);
  if (!session) return null;
  const leavingParticipant = session.participants.get(userId);
  const leavingUsername = leavingParticipant ? leavingParticipant.username : null;

  session.participants.delete(userId);
  session.readyUsers.delete(userId);

  // Transfer host if host left
  let controlTransfer = null;
  if (session.host === userId && session.participants.size > 0) {
    const nextHost = session.participants.keys().next().value;
    controlTransfer = transferHost(session, nextHost, userId);
    if (controlTransfer) {
      controlTransfer.fromUsername = leavingUsername || 'Someone';
    }
  }

  // Destroy session if empty
  if (session.participants.size === 0) {
    if (session.preloadTimeout) clearTimeout(session.preloadTimeout);
    sessions.delete(sessionCode);
    return { destroyed: true, sessionCode };
  }

  return { destroyed: false, session, sessionCode, leftUserId: userId, controlTransfer };
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
    if (id !== excludeUserId && participant.ws.readyState === 1) {
      participant.ws.send(data);
    }
  });
}

function sendTo(session, userId, message) {
  const participant = session.participants.get(userId);
  if (participant && participant.ws.readyState === 1) {
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
      status: p.status,
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

function createParticipant(ws, userId, username, isHost) {
  return {
    ws,
    userId,
    username,
    isHost,
    status: 'in-sync', // in-sync | behind | away | unstable
    lastReportedTime: 0,
    lagHistory: [],
    lastChatAt: 0,
  };
}

module.exports = {
  createSession,
  joinSession,
  leaveSession,
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
