// Queue Management System

const { broadcast } = require('./session');
const HISTORY_LIMIT = 12;

function createQueueItem(videoInfo, addedBy) {
  return {
    id: 'q_' + Math.random().toString(36).substring(2, 8),
    videoId: videoInfo.videoId,
    title: videoInfo.title || 'Unknown Title',
    thumbnail: videoInfo.thumbnail || '',
    addedBy,
    artist: videoInfo.artist || '',
    duration: videoInfo.duration || '',
    addedAt: Date.now(),
  };
}

function addToQueue(session, videoInfo, addedBy) {
  const item = createQueueItem(videoInfo, addedBy);

  session.vibeSource = videoInfo.videoId;

  // If nothing is playing, start this video immediately and keep the queue
  // reserved for upcoming tracks only.
  if (session.playbackState === 'idle' && !session.currentVideo) {
    return { autoPlay: true, item };
  }

  session.queue.push(item);
  broadcastQueueUpdate(session);

  return { autoPlay: false, item };
}

function playNext(session, videoInfo, addedBy) {
  const item = createQueueItem(videoInfo, addedBy);

  session.vibeSource = videoInfo.videoId;

  // If nothing is playing, start this video
  if (session.playbackState === 'idle' && !session.currentVideo) {
    return { autoPlay: true, item };
  }

  // Insert at position 0 (next up)
  session.queue.unshift(item);
  broadcastQueueUpdate(session);

  return { autoPlay: false, item };
}

function reorderQueue(session, fromIndex, toIndex) {
  if (fromIndex < 0 || fromIndex >= session.queue.length) return false;
  if (toIndex < 0 || toIndex >= session.queue.length) return false;

  const [item] = session.queue.splice(fromIndex, 1);
  session.queue.splice(toIndex, 0, item);

  broadcastQueueUpdate(session);
  return true;
}

function removeFromQueue(session, itemId) {
  const index = session.queue.findIndex(item => item.id === itemId);
  if (index === -1) return false;

  session.queue.splice(index, 1);
  broadcastQueueUpdate(session);
  return true;
}

function playSelected(session, itemId) {
  const index = session.queue.findIndex(item => item.id === itemId);
  if (index === -1) return null;

  const [item] = session.queue.splice(index, 1);
  session.vibeSource = item.videoId;

  broadcastQueueUpdate(session);
  return item;
}

function getNextInQueue(session) {
  if (session.queue.length === 0) return null;

  const item = session.queue.shift();
  session.vibeSource = item.videoId;

  broadcastQueueUpdate(session);
  return item;
}

function getQueueList(session) {
  return session.queue.map(formatQueueItem);
}

function getQueueState(session) {
  return {
    current: session.currentVideo ? formatQueueItem(session.currentVideo) : null,
    upcoming: getQueueList(session),
    history: (session.history || []).map(formatQueueItem),
  };
}

function archiveCurrentVideo(session) {
  if (!session.currentVideo) return;

  session.history = session.history || [];
  session.history.unshift({
    ...session.currentVideo,
    playedAt: Date.now(),
  });
  session.history = session.history.slice(0, HISTORY_LIMIT);
}

function getPreviousTrack(session) {
  if (!session.history || session.history.length === 0) return null;
  return session.history.shift();
}

function requeueHistoryItem(session, itemId, toIndex = 0) {
  if (!session.history || session.history.length === 0) return false;

  const historyIndex = session.history.findIndex(item => item.id === itemId);
  if (historyIndex === -1) return false;

  const [item] = session.history.splice(historyIndex, 1);
  const targetIndex = Math.max(0, Math.min(toIndex, session.queue.length));
  session.queue.splice(targetIndex, 0, item);
  broadcastQueueUpdate(session);
  return true;
}

function formatQueueItem(item) {
  return {
    id: item.id,
    videoId: item.videoId,
    title: item.title,
    thumbnail: item.thumbnail,
    addedBy: item.addedBy,
    artist: item.artist || '',
    duration: item.duration || '',
  };
}

function broadcastQueueUpdate(session) {
  broadcast(session, {
    type: 'QUEUE_UPDATED',
    queue: getQueueState(session),
  });
}

// Extract video ID from YouTube URL
function parseYouTubeUrl(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

module.exports = {
  addToQueue,
  playNext,
  reorderQueue,
  removeFromQueue,
  playSelected,
  getNextInQueue,
  getQueueList,
  getQueueState,
  archiveCurrentVideo,
  getPreviousTrack,
  requeueHistoryItem,
  broadcastQueueUpdate,
  parseYouTubeUrl,
};
