// Sync Client — Client-side sync logic

const SyncClient = (() => {
  let isHost = false;
  let syncBarEl = null;
  let syncMessageEl = null;
  let goLiveBtnEl = null;

  function init() {
    syncBarEl = document.getElementById('sync-bar');
    syncMessageEl = document.getElementById('sync-message');
    goLiveBtnEl = document.getElementById('go-live-btn');

    goLiveBtnEl.addEventListener('click', handleGoLive);
  }

  function setHost(val) {
    isHost = val;
  }

  // Handle incoming sync messages from server
  function handleMessage(msg) {
    switch (msg.type) {
      case 'CUE_VIDEO':
        handleCueVideo(msg);
        break;
      case 'PLAY':
        handlePlay(msg);
        break;
      case 'SEEK':
        handleSeek(msg);
        break;
      case 'PAUSE':
        handlePause(msg);
        break;
      case 'RESUME':
        handleResume(msg);
        break;
      case 'SYNC_TO':
        handleSyncTo(msg);
        break;
      case 'LAG_INFO':
        handleLagInfo(msg);
        break;
    }
  }

  function handleCueVideo(msg) {
    Player.cueVideo(msg.videoId);

    // Update now playing title
    const titleEl = document.getElementById('now-playing-title');
    if (titleEl) titleEl.textContent = msg.title || 'Loading...';

    // Player will fire onStateChange CUED → which calls onReady → reports PLAYER_READY
  }

  function handlePlay(msg) {
    const delay = msg.delay || 0;
    Player.playWithDelay(msg.startTime || 0, delay);

    updatePlayButton('playing');
    Notifications.success("You're live");
  }

  function handleSeek(msg) {
    Player.seekTo(msg.seekTime);
  }

  function handlePause(msg) {
    Player.pauseVideo();
    if (msg.currentTime !== undefined) {
      Player.seekTo(msg.currentTime);
    }
    updatePlayButton('paused');
  }

  function handleResume(msg) {
    const delay = msg.delay || 0;
    Player.playWithDelay(msg.currentTime || 0, delay);
    updatePlayButton('playing');
  }

  function handleSyncTo(msg) {
    Player.seekTo(msg.currentTime);
    Player.playVideo();

    if (msg.reason === 'ad_recovery') {
      Notifications.info('Synced back after ad');
    } else if (msg.reason === 'go_live') {
      Notifications.success("You're live");
    }

    hideSyncBar();
    updatePlayButton('playing');
  }

  function handleLagInfo(msg) {
    if (msg.level === 'ok') {
      hideSyncBar();
      return;
    }

    if (msg.level === 'subtle') {
      // Just show notification, no sync bar
      Notifications.info(msg.message, 4000);
      return;
    }

    if (msg.level === 'behind' || msg.level === 'unstable' || msg.level === 'reconnect') {
      showSyncBar(msg.message, msg.level === 'reconnect');
    }
  }

  function showSyncBar(message, isReconnect = false) {
    if (!syncBarEl) return;
    syncBarEl.classList.remove('hidden');
    syncMessageEl.textContent = message;
    goLiveBtnEl.textContent = isReconnect ? 'Reconnect' : 'Go Live';
  }

  function hideSyncBar() {
    if (!syncBarEl) return;
    syncBarEl.classList.add('hidden');
  }

  function handleGoLive() {
    if (window.App) {
      App.send({ type: 'GO_LIVE' });
    }
    hideSyncBar();
  }

  function reportTime(currentTime) {
    if (window.App) {
      App.send({ type: 'TIME_REPORT', currentTime });
    }
  }

  function updatePlayButton(state) {
    const btn = document.getElementById('play-pause-btn');
    const indicator = document.querySelector('.playing-indicator');
    if (!btn) return;

    if (state === 'playing') {
      btn.textContent = '⏸';
      btn.classList.add('playing');
      if (indicator) indicator.classList.remove('paused');
    } else {
      btn.textContent = '▶';
      btn.classList.remove('playing');
      if (indicator) indicator.classList.add('paused');
    }
  }

  return { init, setHost, handleMessage, reportTime, hideSyncBar, updatePlayButton };
})();
