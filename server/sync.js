// Sync Engine

const {
  getCurrentReferenceTime,
  broadcast,
  sendTo,
  getParticipantList,
} = require('./session');
const { getNextInQueue } = require('./queue');

const PRELOAD_TIMEOUT_MS = 2000; // 1-2 seconds max wait
const MAJORITY_THRESHOLD = 0.6; // 60% of users ready = go
const PLAY_DELAY_MS = 300; // slight delay for coordinated start

function initiatePreload(session, videoItem) {
  // Set session state
  session.currentVideo = {
    videoId: videoItem.videoId,
    title: videoItem.title,
    thumbnail: videoItem.thumbnail,
  };
  session.playbackState = 'cueing';
  session.readyUsers.clear();
  session.referenceTime = 0;
  session.referenceStartedAt = null;

  // Tell all clients to cue the video
  broadcast(session, {
    type: 'CUE_VIDEO',
    videoId: videoItem.videoId,
    title: videoItem.title,
  });

  // Set timeout — don't wait forever
  if (session.preloadTimeout) clearTimeout(session.preloadTimeout);
  session.preloadTimeout = setTimeout(() => {
    triggerSynchronizedPlay(session);
  }, PRELOAD_TIMEOUT_MS);
}

function handlePlayerReady(session, userId) {
  session.readyUsers.add(userId);

  const totalUsers = session.participants.size;
  const readyCount = session.readyUsers.size;

  // Check majority
  if (readyCount >= Math.ceil(totalUsers * MAJORITY_THRESHOLD)) {
    if (session.preloadTimeout) {
      clearTimeout(session.preloadTimeout);
      session.preloadTimeout = null;
    }
    triggerSynchronizedPlay(session);
  }
}

function triggerSynchronizedPlay(session) {
  if (session.playbackState !== 'cueing') return;

  session.playbackState = 'playing';
  session.referenceTime = 0;
  session.referenceStartedAt = Date.now() + PLAY_DELAY_MS;

  // Send play signal with a slight future timestamp
  broadcast(session, {
    type: 'PLAY',
    startTime: 0,
    delay: PLAY_DELAY_MS,
  });
}

function handleVideoEnded(session, userId) {
  // Only process from host or first reporter
  if (session.playbackState !== 'playing') return;

  session.playbackState = 'idle';
  session.referenceStartedAt = null;

  // Try next in queue
  const nextItem = getNextInQueue(session);
  if (nextItem) {
    initiatePreload(session, nextItem);
  } else {
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

  const currentRef = getCurrentReferenceTime(session);
  session.referenceTime = currentRef;
  session.referenceStartedAt = null;
  session.playbackState = 'paused';

  broadcast(session, { type: 'PAUSE', currentTime: currentRef }, userId);
}

function handleResume(session, userId, clientCurrentTime) {
  if (session.host !== userId) return;
  if (session.playbackState === 'playing') return;

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
    delay: PLAY_DELAY_MS,
  }, userId);
}

function handleNewJoin(session, userId) {
  const currentRef = getCurrentReferenceTime(session);

  sendTo(session, userId, {
    type: 'SESSION_STATE',
    currentVideo: session.currentVideo,
    playbackState: session.playbackState,
    currentTime: currentRef,
    queue: session.queue.map(q => ({
      id: q.id,
      videoId: q.videoId,
      title: q.title,
      thumbnail: q.thumbnail,
      addedBy: q.addedBy,
    })),
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
  session.referenceStartedAt = null;

  const nextItem = getNextInQueue(session);
  if (nextItem) {
    initiatePreload(session, nextItem);
  } else {
    broadcast(session, {
      type: 'QUEUE_EMPTY',
      vibeSource: session.vibeSource,
    });
  }
}

module.exports = {
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
};
