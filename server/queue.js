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
    playlistGroupId: videoInfo.playlistGroupId || null,
    playlistId: videoInfo.playlistId || null,
    playlistName: videoInfo.playlistName || '',
    playlistThumbnail: videoInfo.playlistThumbnail || '',
    playlistChannelTitle: videoInfo.playlistChannelTitle || '',
    playlistTrackNumber: videoInfo.playlistTrackNumber || null,
    playlistLength: videoInfo.playlistLength || null,
    addedAt: Date.now(),
  };
}

function createPlaylistItems(playlistInfo, addedBy) {
  const groupId = 'plg_' + Math.random().toString(36).substring(2, 10);
  const totalTracks = playlistInfo.items.length;

  return playlistInfo.items.map((videoInfo, index) =>
    createQueueItem({
      ...videoInfo,
      playlistGroupId: groupId,
      playlistId: playlistInfo.playlistId,
      playlistName: playlistInfo.title || 'Playlist',
      playlistThumbnail: playlistInfo.thumbnail || videoInfo.thumbnail || '',
      playlistChannelTitle: playlistInfo.channelTitle || '',
      playlistTrackNumber: index + 1,
      playlistLength: totalTracks,
    }, addedBy)
  );
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

function addPlaylistToQueue(session, playlistInfo, addedBy) {
  const items = createPlaylistItems(playlistInfo, addedBy);
  if (items.length === 0) return { autoPlay: false, item: null };

  session.vibeSource = items[0].videoId;

  if (session.playbackState === 'idle' && !session.currentVideo) {
    const [firstItem, ...rest] = items;
    if (rest.length) session.queue.push(...rest);
    return { autoPlay: true, item: firstItem };
  }

  session.queue.push(...items);
  broadcastQueueUpdate(session);
  return { autoPlay: false, item: null };
}

function playNextPlaylist(session, playlistInfo, addedBy) {
  const items = createPlaylistItems(playlistInfo, addedBy);
  if (items.length === 0) return { autoPlay: false, item: null };

  session.vibeSource = items[0].videoId;

  if (session.playbackState === 'idle' && !session.currentVideo) {
    const [firstItem, ...rest] = items;
    if (rest.length) session.queue.push(...rest);
    return { autoPlay: true, item: firstItem };
  }

  session.queue.unshift(...items);
  broadcastQueueUpdate(session);
  return { autoPlay: false, item: null };
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

function removePlaylistGroup(session, playlistGroupId) {
  if (!playlistGroupId) return false;

  const originalLength = session.queue.length;
  session.queue = session.queue.filter((item) => item.playlistGroupId !== playlistGroupId);
  if (session.queue.length === originalLength) return false;

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

function playPlaylistGroup(session, playlistGroupId) {
  if (!playlistGroupId) return null;

  const groupItems = session.queue.filter((item) => item.playlistGroupId === playlistGroupId);
  if (groupItems.length === 0) return null;

  const remainingGroupItems = groupItems.slice(1);
  const otherItems = session.queue.filter((item) => item.playlistGroupId !== playlistGroupId);
  session.queue = [...remainingGroupItems, ...otherItems];
  session.vibeSource = groupItems[0].videoId;

  broadcastQueueUpdate(session);
  return groupItems[0];
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
    playlistGroupId: item.playlistGroupId || null,
    playlistId: item.playlistId || null,
    playlistName: item.playlistName || '',
    playlistThumbnail: item.playlistThumbnail || '',
    playlistChannelTitle: item.playlistChannelTitle || '',
    playlistTrackNumber: item.playlistTrackNumber || null,
    playlistLength: item.playlistLength || null,
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

function parseYouTubePlaylistUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;

  try {
    const parsed = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
    const list = parsed.searchParams.get('list');
    if (list) return list;
  } catch (error) {
    const match = raw.match(/[?&]list=([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
  }

  return null;
}

module.exports = {
  addToQueue,
  playNext,
  addPlaylistToQueue,
  playNextPlaylist,
  reorderQueue,
  removeFromQueue,
  removePlaylistGroup,
  playSelected,
  playPlaylistGroup,
  getNextInQueue,
  getQueueList,
  getQueueState,
  archiveCurrentVideo,
  getPreviousTrack,
  requeueHistoryItem,
  broadcastQueueUpdate,
  parseYouTubeUrl,
  parseYouTubePlaylistUrl,
};
