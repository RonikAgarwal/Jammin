// Sync Engine

const {
  getCurrentReferenceTime,
  broadcast,
  sendTo,
  getParticipantList,
} = require('./session');
const {
  getNextInQueue,
  getQueueState,
  archiveCurrentVideo,
  getPreviousTrack,
  broadcastQueueUpdate,
} = require('./queue');

const RESUME_DELAY_MS = 120;

function startPlayback(session, videoItem, startTime = 0) {
  if (!videoItem) return;
  if (session.currentVideo && session.currentVideo.id !== videoItem.id) {
    archiveCurrentVideo(session);
  }

  session.currentVideo = {
    ...videoItem,
  };
  session.playbackState = 'playing';
  session.readyUsers.clear();
  session.referenceTime = startTime;
  session.referenceStartedAt = Date.now();
  session.vibeSource = videoItem.videoId;

  broadcast(session, {
    type: 'PLAY',
    videoId: videoItem.videoId,
    title: videoItem.title,
    startTime,
  });

  broadcastQueueUpdate(session);
}

function handlePlayerReady(session, userId) {
  // No-op. Playback now starts immediately instead of waiting for preload
  // coordination, but we keep the message wired for compatibility.
  return { session, userId };
}

function handleVideoEnded(session, userId) {
  if (session.host !== userId) return;
  if (session.playbackState !== 'playing') return;

  session.playbackState = 'idle';
  session.referenceTime = 0;
  session.referenceStartedAt = null;

  // Try next in queue
  const nextItem = getNextInQueue(session);
  if (nextItem) {
    startPlayback(session, nextItem);
  } else {
    archiveCurrentVideo(session);
    session.currentVideo = null;
    broadcastQueueUpdate(session);
    // Queue empty — notify clients
    broadcast(session, {
      type: 'QUEUE_EMPTY',
      vibeSource: session.vibeSource,
    });
  }
}

function handleSeek(session, userId, seekTime) {
  // Host can seek; update reference for everyone
  const participant = session.participants.get(userId);
  if (!participant) return;

  if (session.host === userId) {
    session.referenceTime = seekTime;
    session.referenceStartedAt = Date.now();

    broadcast(session, {
      type: 'SEEK',
      seekTime,
    }, userId);
  }
}

function handlePause(session, userId) {
  if (session.host !== userId) return;
  if (session.playbackState === 'paused') return;
  if (!session.currentVideo) return;

  const currentRef = getCurrentReferenceTime(session);
  session.referenceTime = currentRef;
  session.referenceStartedAt = null;
  session.playbackState = 'paused';

  broadcast(session, { type: 'PAUSE', currentTime: currentRef }, userId);
}

function handleResume(session, userId, clientCurrentTime) {
  if (session.host !== userId) return;
  if (session.playbackState === 'playing') return;
  if (!session.currentVideo) return;

  session.playbackState = 'playing';
  // Use the client's reported time if available, otherwise fallback to our reference
  // Make sure we only use valid numbers
  if (typeof clientCurrentTime === 'number' && !isNaN(clientCurrentTime)) {
    session.referenceTime = clientCurrentTime;
  }
  session.referenceStartedAt = Date.now();

  broadcast(session, {
    type: 'RESUME',
    currentTime: session.referenceTime,
    delay: RESUME_DELAY_MS,
  }, userId);
}

function handleNewJoin(session, userId) {
  const currentRef = getCurrentReferenceTime(session);

  sendTo(session, userId, {
    type: 'SESSION_STATE',
    currentVideo: session.currentVideo,
    playbackState: session.playbackState,
    currentTime: currentRef,
    queue: getQueueState(session),
    participants: getParticipantList(session),
    vibeSource: session.vibeSource,
  });
}

function handleAdStart(session, userId) {
  const participant = session.participants.get(userId);
  if (participant) {
    participant.status = 'away';
    broadcast(session, {
      type: 'PARTICIPANT_UPDATE',
      participants: getParticipantList(session),
    });
  }
}

function handleAdEnd(session, userId) {
  const participant = session.participants.get(userId);
  if (!participant) return;

  participant.status = 'in-sync';
  const currentRef = getCurrentReferenceTime(session);

  // Auto-sync: send current time to the user
  sendTo(session, userId, {
    type: 'SYNC_TO',
    currentTime: currentRef,
    reason: 'ad_recovery',
  });

  broadcast(session, {
    type: 'PARTICIPANT_UPDATE',
    participants: getParticipantList(session),
  });
}

function handleGoLive(session, userId) {
  const currentRef = getCurrentReferenceTime(session);
  const participant = session.participants.get(userId);

  if (participant) {
    participant.status = 'in-sync';
    participant.lagHistory = [];
  }

  sendTo(session, userId, {
    type: 'SYNC_TO',
    currentTime: currentRef,
    reason: 'go_live',
  });

  broadcast(session, {
    type: 'PARTICIPANT_UPDATE',
    participants: getParticipantList(session),
  });
}

function handleSkipTrack(session, userId) {
  if (session.host !== userId) return;

  session.playbackState = 'idle';
  session.referenceTime = 0;
  session.referenceStartedAt = null;
  const nextItem = getNextInQueue(session);
  if (nextItem) {
    startPlayback(session, nextItem);
    return;
  }

  archiveCurrentVideo(session);
  session.currentVideo = null;
  broadcastQueueUpdate(session);
  broadcast(session, {
    type: 'QUEUE_EMPTY',
    vibeSource: session.vibeSource,
  });
}

function handlePrevTrack(session, userId) {
  if (session.host !== userId) return;

  const previousTrack = getPreviousTrack(session);
  if (!previousTrack) return;

  if (session.currentVideo) {
    session.queue.unshift(session.currentVideo);
  }

  session.playbackState = 'idle';
  session.referenceTime = 0;
  session.referenceStartedAt = null;
  session.currentVideo = null;

  startPlayback(session, previousTrack);
}

module.exports = {
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
};
