// Jammin — Main App (WebSocket + UI Orchestration)

const App = (() => {
  let ws = null;
  let userId = null;
  let sessionCode = null;
  let isHost = false;
  let username = 'Anonymous';

  // Seek bar variables
  let seekBarEl = null;
  let seekCurrentEl = null;
  let seekTotalEl = null;
  let isDraggingSeek = false;
  let seekUpdateInterval = null;

  // ---- Init ----

  function init() {
    // Init sub-modules
    Notifications.init();
    Participants.init();
    QueueUI.init();
    SyncClient.init();

    // Init particles
    initParticles();

    let reconnectAttempts = 0;
    const MAX_RECONNECT = 5;

    // Bind UI events
    bindLandingEvents();
    bindSessionEvents();
    bindPanelTabs();

    // Init player with callbacks
    Player.init({
      onReady: () => {
        send({ type: 'PLAYER_READY' });
      },
      onEnded: () => {
        send({ type: 'VIDEO_ENDED' });
      },
      onAdStart: () => {
        send({ type: 'AD_START' });
        Notifications.info('Ad playing — will sync back after');
      },
      onAdEnd: () => {
        send({ type: 'AD_END' });
      },
      onPlayStateChange: (state) => {
        SyncClient.updatePlayButton(state);
        if (state === 'paused' && isHost) {
          send({ type: 'PAUSE' });
        } else if (state === 'playing' && isHost) {
          const time = Player.getCurrentTime();
          send({ type: 'RESUME', currentTime: time });
        }
      },
    });
  }

  // ---- Utilities ----

  function startSeekUpdates() {
    if (seekUpdateInterval) return;
    seekUpdateInterval = setInterval(() => {
      if (isDraggingSeek || !seekBarEl) return;
      
      const currentTime = Player.getCurrentTime();
      const duration = Player.getDuration();
      
      if (duration > 0) {
        seekBarEl.max = duration;
        seekBarEl.value = currentTime;
        if (seekCurrentEl) seekCurrentEl.textContent = formatTime(currentTime);
        if (seekTotalEl) seekTotalEl.textContent = formatTime(duration);
      }
    }, 500);
  }

  function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '0:00';
    const s = Math.floor(seconds);
    const m = Math.floor(s / 60);
    const remS = s % 60;
    return `${m}:${remS.toString().padStart(2, '0')}`;
  }

  // ---- WebSocket Connection ----

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = () => {
      reconnectAttempts = 0;
      updateConnectionStatus(true);
    };

    ws.onclose = () => {
      updateConnectionStatus(false);
      attemptReconnect();
    };

    ws.onerror = () => {
      updateConnectionStatus(false);
    };

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handleMessage(msg);
    };
  }

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  function attemptReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT) {
      Notifications.error('Connection lost. Please refresh the page.');
      return;
    }

    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 10000);

    setTimeout(() => {
      connect();
      // Re-join session if we were in one
      if (sessionCode && username) {
        setTimeout(() => {
          send({ type: 'JOIN_SESSION', code: sessionCode, username });
        }, 500);
      }
    }, delay);
  }

  function updateConnectionStatus(connected) {
    const dot = document.querySelector('.status-dot');
    const text = document.querySelector('.status-text');
    if (dot) dot.className = `status-dot ${connected ? '' : 'disconnected'}`;
    if (text) text.textContent = connected ? 'Connected' : 'Reconnecting...';
  }

  // ---- Message Handler ----

  function handleMessage(msg) {
    switch (msg.type) {
      case 'SESSION_CREATED':
        handleSessionCreated(msg);
        break;
      case 'SESSION_JOINED':
        handleSessionJoined(msg);
        break;
      case 'SESSION_STATE':
        handleSessionState(msg);
        break;
      case 'QUEUE_UPDATED':
        QueueUI.update(msg.queue);
        break;
      case 'PARTICIPANT_UPDATE':
        Participants.update(msg.participants);
        break;
      case 'USER_JOINED':
        Notifications.info(`${msg.username} joined the session`);
        break;
      case 'USER_LEFT':
        Notifications.info('Someone left the session');
        break;
      case 'QUEUE_EMPTY':
        Notifications.info('Queue is empty — add more songs!');
        Player.showPlaceholder();
        SyncClient.updatePlayButton('paused');
        break;
      case 'ERROR':
        Notifications.error(msg.message);
        break;

      // Sync messages → delegate to SyncClient
      case 'CUE_VIDEO':
      case 'PLAY':
      case 'SEEK':
      case 'PAUSE':
      case 'RESUME':
      case 'SYNC_TO':
      case 'LAG_INFO':
        SyncClient.handleMessage(msg);
        break;
    }
  }

  function handleSessionCreated(msg) {
    userId = msg.userId;
    sessionCode = msg.code;
    isHost = true;
    username = msg.username;
    SyncClient.setHost(true);

    switchToSessionView(msg.code, msg.username);
    Participants.update(msg.participants, userId);
    Notifications.success('Session created — share the code!');
  }

  function handleSessionJoined(msg) {
    userId = msg.userId;
    sessionCode = msg.code;
    isHost = msg.isHost || false;
    username = msg.username;
    SyncClient.setHost(isHost);

    switchToSessionView(msg.code, msg.username);
    Participants.update(msg.participants, userId);
    Notifications.success('Joined live session');
  }

  function handleSessionState(msg) {
    // Full state from server on join
    if (msg.queue) QueueUI.update(msg.queue);
    if (msg.participants) Participants.update(msg.participants);

    // If there's a current video, sync to it
    if (msg.currentVideo && msg.playbackState !== 'idle') {
      Player.cueVideo(msg.currentVideo.videoId);

      const titleEl = document.getElementById('now-playing-title');
      if (titleEl) titleEl.textContent = msg.currentVideo.title || 'Playing';

      // After a brief delay for cue, seek and play
      setTimeout(() => {
        if (msg.playbackState === 'playing') {
          Player.seekTo(msg.currentTime || 0);
          Player.playVideo();
          SyncClient.updatePlayButton('playing');
        } else if (msg.playbackState === 'paused') {
          Player.seekTo(msg.currentTime || 0);
          SyncClient.updatePlayButton('paused');
        }
      }, 1000);
    }
  }

  // ---- UI Switching ----

  function switchToSessionView(code, displayUsername) {
    document.getElementById('landing-view').classList.remove('active');
    document.getElementById('session-view').classList.add('active');

    const codeEl = document.getElementById('session-code-value');
    if (codeEl) codeEl.textContent = code;
    
    // Add username next to the logo
    const logoEl = document.querySelector('.logo-small');
    if (logoEl && displayUsername) {
      logoEl.innerHTML = `🎵 Jammin <span style="opacity:0.5; font-size: 0.8em; margin-left: 8px;">| ${displayUsername}</span>`;
    }

    // Enable host controls
    const skipBtn = document.getElementById('next-btn');
    if (skipBtn) skipBtn.disabled = false; // Never physically disable so we can show toast

    if (seekBarEl) seekBarEl.disabled = !isHost;
  }

  // ---- Landing Events ----

  function bindLandingEvents() {
    const createBtn = document.getElementById('create-session-btn');
    const joinBtn = document.getElementById('join-session-btn');
    const usernameInput = document.getElementById('username-input');
    const codeInput = document.getElementById('session-code-input');

    createBtn.addEventListener('click', () => {
      username = usernameInput.value.trim() || 'Anonymous';
      connect();
      // Wait for connection then create
      waitForConnection(() => {
        send({ type: 'CREATE_SESSION', username });
      });
    });

    joinBtn.addEventListener('click', () => {
      username = usernameInput.value.trim() || 'Anonymous';
      const code = codeInput.value.trim().toUpperCase();
      if (!code) {
        Notifications.warning('Enter a session code');
        return;
      }
      connect();
      waitForConnection(() => {
        send({ type: 'JOIN_SESSION', code, username });
      });
    });

    // Enter key on code input
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinBtn.click();
    });
  }

  function waitForConnection(cb) {
    const check = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        clearInterval(check);
        cb();
      }
    }, 100);

    // Timeout after 5s
    setTimeout(() => clearInterval(check), 5000);
  }

  // ---- Session Events ----

  function bindSessionEvents() {
    seekBarEl = document.getElementById('seek-bar');
    seekCurrentEl = document.getElementById('seek-current');
    seekTotalEl = document.getElementById('seek-total');

    if (seekBarEl) {
      seekBarEl.addEventListener('input', () => {
        isDraggingSeek = true;
        const val = parseFloat(seekBarEl.value);
        if (seekCurrentEl) seekCurrentEl.textContent = formatTime(val);
      });

      seekBarEl.addEventListener('change', () => {
        if (!isHost) {
          isDraggingSeek = false;
          return;
        }
        const val = parseFloat(seekBarEl.value);
        Player.seekTo(val);
        // Player's internal seek detector will catch this and send SEEK automatically
        isDraggingSeek = false;
      });
    }

    startSeekUpdates();

    // Copy session code
    const codeDisplay = document.getElementById('session-code-display');
    codeDisplay.addEventListener('click', () => {
      const code = document.getElementById('session-code-value').textContent;
      navigator.clipboard.writeText(code).then(() => {
        Notifications.info('Code copied!', 2000);
      }).catch(() => {
        Notifications.info(`Code: ${code}`, 3000);
      });
    });

    // Add to queue
    const addBtn = document.getElementById('add-queue-btn');
    const playNextBtn = document.getElementById('play-next-btn');
    const urlInput = document.getElementById('song-url-input');

    addBtn.addEventListener('click', () => {
      const url = urlInput.value.trim();
      if (!url) return;
      send({ type: 'ADD_TO_QUEUE', videoUrl: url });
      urlInput.value = '';
    });

    playNextBtn.addEventListener('click', () => {
      if (!isHost) {
        Notifications.info('Only the host can Play Next');
        return;
      }
      const url = urlInput.value.trim();
      if (!url) return;
      send({ type: 'PLAY_NEXT', videoUrl: url });
      urlInput.value = '';
    });

    // Enter key on URL input
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addBtn.click();
    });

    // Play/pause button (host only)
    const playPauseBtn = document.getElementById('play-pause-btn');
    playPauseBtn.addEventListener('click', () => {
      if (!isHost) {
        Notifications.info('Only the host can control playback');
        return;
      }
      const state = Player.getState();
      if (state === YT.PlayerState.PLAYING) {
        Player.pauseVideo();
        // The onPlayStateChange callback will handle sending the PAUSE event
      } else {
        Player.playVideo();
        // The onPlayStateChange callback will handle sending the RESUME event
      }
    });

    // Skip track (host only)
    const skipBtn = document.getElementById('next-btn');
    skipBtn.addEventListener('click', () => {
      if (!isHost) {
        Notifications.info('Only the host can control playback');
        return;
      }
      send({ type: 'SKIP_TRACK' });
    });

    // Previous track (host only)
    const prevBtn = document.getElementById('prev-btn');
    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        if (!isHost) {
          Notifications.info('Only the host can control playback');
          return;
        }
        send({ type: 'PREV_TRACK' });
      });
    }


    // Player Overlay (blocks iframe clicks)
    const playerOverlay = document.getElementById('player-overlay');
    if (playerOverlay) {
      playerOverlay.addEventListener('click', () => {
        if (!isHost) {
          Notifications.info('Only the host can control playback');
          return;
        }
        const state = Player.getState();
        if (state === YT.PlayerState.PLAYING) {
          Player.pauseVideo();
        } else {
          Player.playWithDelay(0);
        }
      });
    }
  }

  // ---- Panel Tabs ----

  function bindPanelTabs() {
    const tabs = document.querySelectorAll('.panel-tab');
    const queuePanel = document.getElementById('queue-panel');
    const participantsPanel = document.getElementById('participants-panel');

    tabs.forEach(tab => {
      tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        const target = tab.dataset.tab;
        if (target === 'queue') {
          queuePanel.classList.remove('hidden');
          participantsPanel.classList.add('hidden');
        } else {
          queuePanel.classList.add('hidden');
          participantsPanel.classList.remove('hidden');
        }
      });
    });
  }

  // ---- Particle Background ----

  function initParticles() {
    const canvas = document.getElementById('particles-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    let particles = [];
    const PARTICLE_COUNT = 50;

    function resize() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    // Create particles
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.3,
        vy: (Math.random() - 0.5) * 0.3,
        radius: Math.random() * 2 + 0.5,
        opacity: Math.random() * 0.4 + 0.1,
      });
    }

    function animate() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      particles.forEach(p => {
        p.x += p.vx;
        p.y += p.vy;

        // Wrap around
        if (p.x < 0) p.x = canvas.width;
        if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height;
        if (p.y > canvas.height) p.y = 0;

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(168, 130, 255, ${p.opacity})`;
        ctx.fill();
      });

      // Draw subtle connections
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);

          if (dist < 120) {
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = `rgba(168, 130, 255, ${0.06 * (1 - dist / 120)})`;
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      }

      requestAnimationFrame(animate);
    }

    animate();
  }

  // ---- Init on DOM ready ----
  document.addEventListener('DOMContentLoaded', () => {
    init();
  });

  return { send, init, getIsHost: () => isHost };
})();
