// YouTube Player Manager

const Player = (() => {
  let player = null;
  let isReady = false;
  let isAdPlaying = false;
  let timeReportInterval = null;
  let onReadyCallback = null;
  let onEndedCallback = null;
  let onAdStartCallback = null;
  let onAdEndCallback = null;
  let onPlayStateChangeCallback = null;
  let onSeekCallback = null;
  let currentVideoId = null;
  let lastRecordedTime = 0;
  let seekDetectInterval = null;

  function init(callbacks = {}) {
    onReadyCallback = callbacks.onReady || null;
    onEndedCallback = callbacks.onEnded || null;
    onAdStartCallback = callbacks.onAdStart || null;
    onAdEndCallback = callbacks.onAdEnd || null;
    onPlayStateChangeCallback = callbacks.onPlayStateChange || null;
    onSeekCallback = callbacks.onSeek || null;

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
    player = new YT.Player('youtube-player', {
      height: '100%',
      width: '100%',
      playerVars: {
        autoplay: 0,
        controls: 0,
        modestbranding: 1,
        rel: 0,
        fs: 0,
        playsinline: 1,
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
  }

  function handleStateChange(event) {
    const state = event.data;

    switch (state) {
      case YT.PlayerState.PLAYING:
        // Check if recovering from ad
        if (isAdPlaying) {
          isAdPlaying = false;
          if (onAdEndCallback) onAdEndCallback();
        }
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

      case -1: // Unstarted — could be ad
        // Detect ad: if we have a video loaded and state goes to -1
        if (currentVideoId && !isAdPlaying) {
          // Small delay to confirm it's actually an ad
          setTimeout(() => {
            if (player && player.getPlayerState && player.getPlayerState() === -1) {
              isAdPlaying = true;
              if (onAdStartCallback) onAdStartCallback();
            }
          }, 500);
        }
        break;
    }
  }

  function handleError(event) {
    console.error('YouTube Player Error:', event.data);
    Notifications.error('Video playback error');
  }

  function cueVideo(videoId) {
    if (!player || !isReady) return;
    currentVideoId = videoId;
    player.cueVideoById(videoId);
    hidePlaceholder();
  }

  function playVideo() {
    if (!player || !isReady) return;
    player.playVideo();
  }

  function pauseVideo() {
    if (!player || !isReady) return;
    player.pauseVideo();
  }

  function seekTo(time) {
    if (!player || !isReady) return;
    player.seekTo(time, true);
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
    if (ph) ph.classList.add('hidden');
  }

  function showPlaceholder() {
    const ph = document.getElementById('player-placeholder');
    if (ph) ph.classList.remove('hidden');
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
    playVideo,
    pauseVideo,
    seekTo,
    getCurrentTime,
    getDuration,
    getState,
    playWithDelay,
    showPlaceholder,
    hidePlaceholder,
  };
})();
