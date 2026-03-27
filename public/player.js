// YouTube Player Manager

const Player = (() => {
  let player = null;
  let isReady = false;
  let timeReportInterval = null;
  let onReadyCallback = null;
  let onEndedCallback = null;
  let onPlayStateChangeCallback = null;
  let onSeekCallback = null;
  let onErrorCallback = null;
  let currentVideoId = null;
  let lastRecordedTime = 0;
  let seekDetectInterval = null;
  let pendingAction = null;

  function init(callbacks = {}) {
    onReadyCallback = callbacks.onReady || null;
    onEndedCallback = callbacks.onEnded || null;
    onPlayStateChangeCallback = callbacks.onPlayStateChange || null;
    onSeekCallback = callbacks.onSeek || null;
    onErrorCallback = callbacks.onError || null;

    // YouTube API ready callback
    window.onYouTubeIframeAPIReady = () => {
      createPlayer();
    };

    // If API already loaded
    if (window.YT && window.YT.Player) {
      createPlayer();
    }
  }

  function createPlayer() {
    const currentOrigin = window.location.origin;
    const widgetReferrer = window.location.href;
    player = new YT.Player('youtube-player', {
      height: '100%',
      width: '100%',
      host: 'https://www.youtube.com',
      playerVars: {
        autoplay: 0,
        controls: 0,
        enablejsapi: 1,
        modestbranding: 1,
        rel: 0,
        fs: 0,
        playsinline: 1,
        origin: currentOrigin,
        widget_referrer: widgetReferrer,
      },
      events: {
        onReady: handleReady,
        onStateChange: handleStateChange,
        onError: handleError,
      },
    });
  }

  function handleReady() {
    isReady = true;
    if (pendingAction) {
      const action = pendingAction;
      pendingAction = null;
      action();
    }
  }

  function runWhenReady(action) {
    if (!player || !isReady) {
      pendingAction = action;
      return false;
    }
    action();
    return true;
  }

  function handleStateChange(event) {
    const state = event.data;

    switch (state) {
      case YT.PlayerState.PLAYING:
        hidePlaceholder();
        if (onPlayStateChangeCallback) onPlayStateChangeCallback('playing');
        startTimeReporting();
        break;

      case YT.PlayerState.PAUSED:
        if (onPlayStateChangeCallback) onPlayStateChangeCallback('paused');
        stopTimeReporting();
        break;

      case YT.PlayerState.ENDED:
        if (onEndedCallback) onEndedCallback();
        stopTimeReporting();
        break;

      case YT.PlayerState.BUFFERING:
        break;

      case YT.PlayerState.CUED:
        // Video cued and ready
        if (onReadyCallback) onReadyCallback();
        break;
    }
  }

  function handleError(event) {
    const errorCode = Number(event.data);
    console.error('YouTube Player Error:', errorCode);
    stopTimeReporting();

    const blockedMessage =
      errorCode === 101 || errorCode === 150
        ? 'This track is blocked from playing inside the embedded player on this device.'
        : 'This track cannot be played in the embedded player right now.';

    showPlaceholder('Track unavailable', blockedMessage);

    if (onErrorCallback) {
      onErrorCallback({
        code: errorCode,
        videoId: currentVideoId,
      });
    }

    if (errorCode === 101 || errorCode === 150) {
      Notifications.error('This video is blocked from playing inside embedded players on this device');
      return;
    }

    if (errorCode === 5) {
      Notifications.error('This video cannot be played in the embedded player right now');
      return;
    }

    Notifications.error('Video playback error');
  }

  function cueVideo(videoId, startTime = 0) {
    runWhenReady(() => {
      currentVideoId = videoId;
      player.cueVideoById({
        videoId,
        startSeconds: startTime,
      });
      hidePlaceholder();
    });
  }

  function loadVideo(videoId, startTime = 0) {
    runWhenReady(() => {
      currentVideoId = videoId;
      player.loadVideoById({
        videoId,
        startSeconds: startTime,
      });
      hidePlaceholder();
    });
  }

  function playVideo() {
    runWhenReady(() => {
      player.playVideo();
    });
  }

  function pauseVideo() {
    runWhenReady(() => {
      player.pauseVideo();
    });
  }

  function seekTo(time) {
    runWhenReady(() => {
      player.seekTo(time, true);
    });
  }

  function getCurrentTime() {
    if (!player || !isReady) return 0;
    return player.getCurrentTime() || 0;
  }

  function getDuration() {
    if (!player || !isReady) return 0;
    return player.getDuration() || 0;
  }

  function getState() {
    if (!player || !isReady) return -1;
    return player.getPlayerState();
  }

  function getCurrentVideoId() {
    return currentVideoId;
  }

  function startTimeReporting() {
    stopTimeReporting();
    timeReportInterval = setInterval(() => {
      if (player && isReady && getState() === YT.PlayerState.PLAYING) {
        const time = getCurrentTime();
        if (window.SyncClient) {
          SyncClient.reportTime(time);
        }
      }
    }, 2500); // Every 2.5 seconds

    lastRecordedTime = getCurrentTime();
    seekDetectInterval = setInterval(() => {
      if (player && isReady && getState() === YT.PlayerState.PLAYING) {
        const time = getCurrentTime();
        // If time jumps by more than 1.5 seconds, it's a seek
        if (Math.abs(time - lastRecordedTime) > 1.5) {
          if (onSeekCallback) onSeekCallback(time);
        }
        lastRecordedTime = time;
      }
    }, 500);
  }

  function stopTimeReporting() {
    if (timeReportInterval) {
      clearInterval(timeReportInterval);
      timeReportInterval = null;
    }
    if (seekDetectInterval) {
      clearInterval(seekDetectInterval);
      seekDetectInterval = null;
    }
  }

  function hidePlaceholder() {
    const ph = document.getElementById('player-placeholder');
    const titleEl = document.getElementById('player-placeholder-title');
    const copyEl = document.getElementById('player-placeholder-copy');
    if (ph) ph.classList.add('hidden');
    if (titleEl) titleEl.textContent = 'Pick a track to begin';
    if (copyEl) {
      copyEl.textContent = '';
      copyEl.classList.add('hidden');
    }
  }

  function showPlaceholder(title = 'Pick a track to begin', detail = '') {
    const ph = document.getElementById('player-placeholder');
    const titleEl = document.getElementById('player-placeholder-title');
    const copyEl = document.getElementById('player-placeholder-copy');
    if (ph) ph.classList.remove('hidden');
    if (titleEl) titleEl.textContent = title;
    if (copyEl) {
      copyEl.textContent = detail;
      copyEl.classList.toggle('hidden', !detail);
    }
  }

  function playWithDelay(startTime, delayMs) {
    if (!player || !isReady) return;
    seekTo(startTime);
    setTimeout(() => {
      playVideo();
    }, delayMs);
  }

  return {
    init,
    cueVideo,
    loadVideo,
    playVideo,
    pauseVideo,
    seekTo,
    getCurrentTime,
    getDuration,
    getState,
    getCurrentVideoId,
    playWithDelay,
    showPlaceholder,
    hidePlaceholder,
  };
})();
