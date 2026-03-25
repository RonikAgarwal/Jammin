// Queue Management System

const { broadcast } = require('./session');

function addToQueue(session, videoInfo, addedBy) {
  const item = {
    id: 'q_' + Math.random().toString(36).substring(2, 8),
    videoId: videoInfo.videoId,
    title: videoInfo.title || 'Unknown Title',
    thumbnail: videoInfo.thumbnail || '',
    addedBy: addedBy,
    addedAt: Date.now(),
  };

  session.queue.push(item);
  session.vibeSource = videoInfo.videoId;

  broadcastQueueUpdate(session);

  // If nothing is playing, start this video
  if (session.playbackState === 'idle' && session.queue.length === 1) {
    return { autoPlay: true, item };
  }

  return { autoPlay: false, item };
}

function playNext(session, videoInfo, addedBy) {
  const item = {
    id: 'q_' + Math.random().toString(36).substring(2, 8),
    videoId: videoInfo.videoId,
    title: videoInfo.title || 'Unknown Title',
    thumbnail: videoInfo.thumbnail || '',
    addedBy: addedBy,
    addedAt: Date.now(),
  };

  // Insert at position 0 (next up)
  session.queue.unshift(item);
  session.vibeSource = videoInfo.videoId;

  broadcastQueueUpdate(session);

  // If nothing is playing, start this video
  if (session.playbackState === 'idle') {
    return { autoPlay: true, item };
  }

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
  return session.queue.map(item => ({
    id: item.id,
    videoId: item.videoId,
    title: item.title,
    thumbnail: item.thumbnail,
    addedBy: item.addedBy,
  }));
}

function broadcastQueueUpdate(session) {
  broadcast(session, {
    type: 'QUEUE_UPDATED',
    queue: getQueueList(session),
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
  parseYouTubeUrl,
};
