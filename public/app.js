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
  let lastSentSeekTime = null;
  let lastSentSeekAt = 0;
  let stopParticlesAnimation = null;
  let searchAbortController = null;
  let searchDebounce = null;
  let searchQuery = '';
  let searchNextPageToken = null;
  let searchHasMore = false;
  let searchIsLoading = false;
  let selectedSearchResult = null;
  let pendingControlTransfer = null;
  let roomPlaybackState = 'idle';
  let roomCurrentVideoId = null;
  let roomReferenceTime = 0;
  let roomReferenceStartedAt = null;
  let playbackUnlockTimer = null;
  let hasPlaybackUnlock = false;
  let themeRequestToken = 0;
  let activeThemeKey = 'default';
  const themeCache = new Map();
  const SEARCH_DEBOUNCE_MS = 550;
  const MIN_SEARCH_CHARS = 3;
  const searchCache = new Map();
  const DEFAULT_THEME_VARS = {
    '--bg-deep': '#0b0f17',
    '--bg-mid': '#151b29',
    '--bg-surface': 'rgba(16, 22, 35, 0.68)',
    '--accent-pink': '#e6a06f',
    '--accent-cyan': '#8ec5ff',
    '--accent-purple': '#7c8cff',
    '--accent-violet': '#5363c7',
    '--glow-pink': 'rgba(230, 160, 111, 0.32)',
    '--glow-cyan': 'rgba(142, 197, 255, 0.28)',
    '--glow-purple': 'rgba(124, 140, 255, 0.26)',
    '--theme-wash-1': 'rgba(126, 90, 255, 0.12)',
    '--theme-wash-2': 'rgba(224, 141, 92, 0.08)',
    '--theme-wash-3': 'rgba(97, 153, 255, 0.08)',
    '--glass-bg': 'rgba(255, 255, 255, 0.04)',
    '--glass-border': 'rgba(255, 255, 255, 0.08)',
    '--glass-hover': 'rgba(255, 255, 255, 0.08)',
  };

  // ---- Init ----

  function init() {
    // Init sub-modules
    Notifications.init();
    Participants.init();
    QueueUI.init();
    SyncClient.init();
    Chat.init();

    // Init particles
    initParticles();

    let reconnectAttempts = 0;
    const MAX_RECONNECT = 5;

    // Bind UI events
    bindLandingEvents();
    bindSessionEvents();

    // Init player with callbacks
    Player.init({
      onReady: () => {
        send({ type: 'PLAYER_READY' });
      },
      onEnded: () => {
        const reportedVideoId = Player.getCurrentVideoId() || roomCurrentVideoId;
        if (!reportedVideoId) return;

        send({
          type: 'VIDEO_ENDED',
          videoId: reportedVideoId,
          currentTime: Player.getCurrentTime(),
          duration: Player.getDuration(),
        });
      },
      onPlayStateChange: (state) => {
        SyncClient.updatePlayButton(state);
        handleLocalPlayerStateChange(state);
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

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function setSearchStatus(message) {
    const statusEl = document.getElementById('song-search-status');
    if (statusEl) statusEl.textContent = message;
  }

  function setSearchLoading(loading) {
    searchIsLoading = loading;
    const resultsEl = document.getElementById('song-search-results');
    if (resultsEl) resultsEl.dataset.loading = loading ? 'true' : 'false';
  }

  function updateSearchActionButtons() {
    const addBtn = document.getElementById('add-queue-btn');
    const playNextBtn = document.getElementById('play-next-btn');
    if (addBtn) addBtn.disabled = !selectedSearchResult;
    if (playNextBtn) playNextBtn.disabled = !selectedSearchResult || !isHost;
  }

  function refreshControllerAccess() {
    if (seekBarEl) seekBarEl.disabled = !isHost;

    const playPauseBtn = document.getElementById('play-pause-btn');
    if (playPauseBtn) playPauseBtn.disabled = !isHost;

    const overlayEl = document.getElementById('player-overlay');
    if (overlayEl) {
      overlayEl.classList.toggle('viewer-locked', !isHost);
    }

    updateSearchActionButtons();
    if (typeof QueueUI !== 'undefined' && typeof QueueUI.refreshPermissions === 'function') {
      QueueUI.refreshPermissions();
    }
  }

  function deviceNeedsPlaybackUnlock() {
    return Boolean(
      window.matchMedia?.('(pointer: coarse)').matches ||
      navigator.maxTouchPoints > 0 ||
      /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent)
    );
  }

  function shouldOfferPlaybackUnlock() {
    return deviceNeedsPlaybackUnlock() && !hasPlaybackUnlock;
  }

  function markPlaybackUnlocked() {
    hasPlaybackUnlock = true;
    clearPlaybackUnlockCheck();
    hidePlaybackUnlockPrompt();
  }

  function setThemeVars(vars) {
    const root = document.documentElement;
    Object.entries(vars).forEach(([name, value]) => {
      root.style.setProperty(name, value);
    });
  }

  function resetReactiveTheme() {
    activeThemeKey = 'default';
    themeRequestToken += 1;
    setThemeVars(DEFAULT_THEME_VARS);
  }

  function thumbnailForVideo(videoId) {
    return videoId ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg` : '';
  }

  function syncThemeFromQueue(queueState) {
    const currentItem = Array.isArray(queueState) ? null : queueState?.current || null;
    if (!currentItem?.videoId && !currentItem?.thumbnail) {
      resetReactiveTheme();
      return;
    }

    const artworkUrl = currentItem.thumbnail || thumbnailForVideo(currentItem.videoId);
    applyReactiveTheme(artworkUrl, currentItem.videoId || artworkUrl);
  }

  async function applyReactiveTheme(artworkUrl, cacheKey) {
    const themeKey = cacheKey || artworkUrl || 'default';
    if (!artworkUrl) {
      resetReactiveTheme();
      return;
    }
    if (themeKey === activeThemeKey) return;

    if (themeCache.has(themeKey)) {
      activeThemeKey = themeKey;
      setThemeVars(themeCache.get(themeKey));
      return;
    }

    const requestToken = ++themeRequestToken;

    try {
      const themeVars = await buildThemeFromArtwork(artworkUrl, cacheKey || artworkUrl);
      if (requestToken !== themeRequestToken) return;
      themeCache.set(themeKey, themeVars);
      activeThemeKey = themeKey;
      setThemeVars(themeVars);
    } catch {
      if (requestToken !== themeRequestToken) return;
      const fallbackTheme = buildThemeFromSeed(cacheKey || artworkUrl);
      themeCache.set(themeKey, fallbackTheme);
      activeThemeKey = themeKey;
      setThemeVars(fallbackTheme);
    }
  }

  function buildThemeFromArtwork(artworkUrl, seed) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.referrerPolicy = 'no-referrer';
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) {
            reject(new Error('canvas_unavailable'));
            return;
          }

          canvas.width = 28;
          canvas.height = 28;
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          const swatch = deriveThemeSwatch(imageData, seed);
          resolve(themeVarsFromSwatch(swatch));
        } catch (error) {
          reject(error);
        }
      };
      img.onerror = reject;
      img.src = artworkUrl;
    });
  }

  function deriveThemeSwatch(imageData, seed) {
    let totalWeight = 0;
    let avgR = 0;
    let avgG = 0;
    let avgB = 0;
    let vibrant = null;
    let secondary = null;

    for (let i = 0; i < imageData.length; i += 4) {
      const alpha = imageData[i + 3];
      if (alpha < 160) continue;
      const rgb = { r: imageData[i], g: imageData[i + 1], b: imageData[i + 2] };
      const hsl = rgbToHsl(rgb);
      const luminance = relativeLuminance(rgb);
      const weight = 0.65 + luminance;

      totalWeight += weight;
      avgR += rgb.r * weight;
      avgG += rgb.g * weight;
      avgB += rgb.b * weight;

      const vibrantScore = hsl.s * 1.35 + Math.abs(hsl.l - 0.52) * 0.32;
      if (!vibrant || vibrantScore > vibrant.score) {
        secondary = vibrant;
        vibrant = { rgb, hsl, score: vibrantScore };
      } else if (!secondary || vibrantScore > secondary.score) {
        secondary = { rgb, hsl, score: vibrantScore };
      }
    }

    if (!totalWeight) {
      return seedSwatchFromString(seed || 'jammin');
    }

    const average = {
      r: Math.round(avgR / totalWeight),
      g: Math.round(avgG / totalWeight),
      b: Math.round(avgB / totalWeight),
    };

    return {
      average,
      vibrant: vibrant?.rgb || average,
      secondary: secondary?.rgb || average,
    };
  }

  function seedSwatchFromString(seed) {
    const fallback = buildThemeFromSeed(seed);
    return {
      average: cssColorToRgb(fallback['--bg-mid']),
      vibrant: cssColorToRgb(fallback['--accent-purple']),
      secondary: cssColorToRgb(fallback['--accent-cyan']),
    };
  }

  function buildThemeFromSeed(seed) {
    let hash = 0;
    const source = String(seed || 'jammin');
    for (let i = 0; i < source.length; i += 1) {
      hash = (hash << 5) - hash + source.charCodeAt(i);
      hash |= 0;
    }

    const primary = hslToRgb({
      h: normalizeHue((Math.abs(hash) % 360) / 360),
      s: 0.62,
      l: 0.62,
    });
    const secondary = hslToRgb({
      h: normalizeHue(((Math.abs(hash) + 76) % 360) / 360),
      s: 0.58,
      l: 0.64,
    });
    const average = hslToRgb({
      h: normalizeHue(((Math.abs(hash) + 22) % 360) / 360),
      s: 0.34,
      l: 0.34,
    });

    return themeVarsFromSwatch({ average, vibrant: primary, secondary });
  }

  function themeVarsFromSwatch({ average, vibrant, secondary }) {
    const base = setHsl(rgbToHsl(average), {
      s: 0.34,
      l: 0.08,
    });
    const mid = setHsl(rgbToHsl(average), {
      s: 0.28,
      l: 0.14,
    });
    const accentPrimary = setHsl(rgbToHsl(vibrant), {
      s: clamp(rgbToHsl(vibrant).s * 1.04, 0.42, 0.82),
      l: clamp(Math.max(rgbToHsl(vibrant).l, 0.58), 0.56, 0.7),
    });
    const accentSecondary = setHsl(rgbToHsl(secondary), {
      s: clamp(rgbToHsl(secondary).s * 0.96, 0.34, 0.74),
      l: clamp(Math.max(rgbToHsl(secondary).l, 0.6), 0.56, 0.72),
    });
    const accentWarm = setHsl(rgbToHsl(average), {
      h: normalizeHue(rgbToHsl(vibrant).h + 0.08),
      s: 0.58,
      l: 0.66,
    });
    const violet = setHsl(rgbToHsl(accentPrimary), {
      s: clamp(rgbToHsl(accentPrimary).s * 0.88, 0.34, 0.74),
      l: clamp(rgbToHsl(accentPrimary).l - 0.12, 0.34, 0.56),
    });

    return {
      '--bg-deep': rgbToCss(base),
      '--bg-mid': rgbToCss(mid),
      '--bg-surface': rgbaString(mid, 0.68),
      '--accent-pink': rgbToCss(accentWarm),
      '--accent-cyan': rgbToCss(accentSecondary),
      '--accent-purple': rgbToCss(accentPrimary),
      '--accent-violet': rgbToCss(violet),
      '--glow-pink': rgbaString(accentWarm, 0.3),
      '--glow-cyan': rgbaString(accentSecondary, 0.28),
      '--glow-purple': rgbaString(accentPrimary, 0.26),
      '--theme-wash-1': rgbaString(accentPrimary, 0.14),
      '--theme-wash-2': rgbaString(accentWarm, 0.1),
      '--theme-wash-3': rgbaString(accentSecondary, 0.1),
      '--glass-bg': rgbaString(mid, 0.44),
      '--glass-border': rgbaString(accentPrimary, 0.16),
      '--glass-hover': rgbaString(accentPrimary, 0.12),
    };
  }

  function rgbToHsl({ r, g, b }) {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const lightness = (max + min) / 2;
    const delta = max - min;

    if (!delta) return { h: 0, s: 0, l: lightness };

    const saturation = lightness > 0.5
      ? delta / (2 - max - min)
      : delta / (max + min);

    let hue = 0;
    switch (max) {
      case rn:
        hue = (gn - bn) / delta + (gn < bn ? 6 : 0);
        break;
      case gn:
        hue = (bn - rn) / delta + 2;
        break;
      default:
        hue = (rn - gn) / delta + 4;
        break;
    }

    return { h: hue / 6, s: saturation, l: lightness };
  }

  function hslToRgb({ h, s, l }) {
    if (s === 0) {
      const value = Math.round(l * 255);
      return { r: value, g: value, b: value };
    }

    const hue2rgb = (p, q, t) => {
      let temp = t;
      if (temp < 0) temp += 1;
      if (temp > 1) temp -= 1;
      if (temp < 1 / 6) return p + (q - p) * 6 * temp;
      if (temp < 1 / 2) return q;
      if (temp < 2 / 3) return p + (q - p) * (2 / 3 - temp) * 6;
      return p;
    };

    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
      r: Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
      g: Math.round(hue2rgb(p, q, h) * 255),
      b: Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
    };
  }

  function setHsl(hsl, overrides) {
    return hslToRgb({
      h: overrides.h ?? hsl.h,
      s: overrides.s ?? hsl.s,
      l: overrides.l ?? hsl.l,
    });
  }

  function normalizeHue(value) {
    if (value < 0) return value + 1;
    if (value > 1) return value - 1;
    return value;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function rgbaString({ r, g, b }, alpha) {
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function rgbToCss({ r, g, b }) {
    return `rgb(${r}, ${g}, ${b})`;
  }

  function cssColorToRgb(color) {
    const match = String(color).match(/\d+/g) || [0, 0, 0];
    return {
      r: Number(match[0] || 0),
      g: Number(match[1] || 0),
      b: Number(match[2] || 0),
    };
  }

  function relativeLuminance({ r, g, b }) {
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  }

  function clearPlaybackUnlockCheck() {
    if (playbackUnlockTimer) {
      clearTimeout(playbackUnlockTimer);
      playbackUnlockTimer = null;
    }
  }

  function getExpectedRoomTime() {
    if (roomPlaybackState !== 'playing') return roomReferenceTime || 0;
    if (!roomReferenceStartedAt) return roomReferenceTime || 0;
    const elapsed = Math.max(0, (Date.now() - roomReferenceStartedAt) / 1000);
    return (roomReferenceTime || 0) + elapsed;
  }

  function showPlaybackUnlockPrompt() {
    if (!shouldOfferPlaybackUnlock()) return;
    if (roomPlaybackState !== 'playing' || !roomCurrentVideoId) return;

    const unlockBtn = document.getElementById('player-unlock-btn');
    const overlayEl = document.getElementById('player-overlay');
    if (unlockBtn) {
      unlockBtn.textContent = isHost ? 'Start playback on this device' : 'Join on this device';
      unlockBtn.classList.remove('hidden');
    }
    if (overlayEl) {
      overlayEl.classList.add('local-unlock-available');
    }
  }

  function hidePlaybackUnlockPrompt() {
    const unlockBtn = document.getElementById('player-unlock-btn');
    const overlayEl = document.getElementById('player-overlay');
    if (unlockBtn) unlockBtn.classList.add('hidden');
    if (overlayEl) overlayEl.classList.remove('local-unlock-available');
  }

  function schedulePlaybackUnlockCheck(delayMs = 1800) {
    clearPlaybackUnlockCheck();
    if (!shouldOfferPlaybackUnlock() || roomPlaybackState !== 'playing' || !roomCurrentVideoId) {
      hidePlaybackUnlockPrompt();
      return;
    }

    playbackUnlockTimer = setTimeout(() => {
      const state = Player.getState();
      const playingState = window.YT?.PlayerState?.PLAYING ?? 1;
      if (roomPlaybackState === 'playing' && roomCurrentVideoId && state !== playingState) {
        showPlaybackUnlockPrompt();
      }
    }, delayMs);
  }

  function handleLocalPlayerStateChange(state) {
    if (state === 'playing') {
      if (shouldOfferPlaybackUnlock() && roomCurrentVideoId) {
        markPlaybackUnlocked();
      }
      clearPlaybackUnlockCheck();
      hidePlaybackUnlockPrompt();
      return;
    }

    if (shouldOfferPlaybackUnlock() && roomPlaybackState === 'playing' && roomCurrentVideoId) {
      schedulePlaybackUnlockCheck(1200);
    }
  }

  function attemptPlaybackUnlock() {
    if (!shouldOfferPlaybackUnlock()) return;
    if (roomPlaybackState !== 'playing' || !roomCurrentVideoId) return;

    const targetTime = getExpectedRoomTime();
    if (Player.getCurrentVideoId() !== roomCurrentVideoId) {
      Player.loadVideo(roomCurrentVideoId, targetTime);
    } else {
      Player.seekTo(targetTime);
      Player.playVideo();
    }

    Notifications.success(isHost ? 'Playback started on this device' : 'Joined the room playback', 2200);
    hidePlaybackUnlockPrompt();
    schedulePlaybackUnlockCheck(2200);
  }

  function updateRoomPlaybackContext(type, msg = {}) {
    switch (type) {
      case 'PLAY':
        roomPlaybackState = 'playing';
        roomCurrentVideoId = msg.videoId || roomCurrentVideoId;
        roomReferenceTime = typeof msg.startTime === 'number' ? msg.startTime : 0;
        roomReferenceStartedAt = Date.now();
        break;
      case 'RESUME':
        roomPlaybackState = 'playing';
        roomReferenceTime = typeof msg.currentTime === 'number' ? msg.currentTime : roomReferenceTime;
        roomReferenceStartedAt = Date.now() + (msg.delay || 0);
        break;
      case 'SEEK':
        roomReferenceTime = typeof msg.seekTime === 'number' ? msg.seekTime : roomReferenceTime;
        if (roomPlaybackState === 'playing') {
          roomReferenceStartedAt = Date.now();
        }
        break;
      case 'PAUSE':
        roomPlaybackState = 'paused';
        roomReferenceTime = typeof msg.currentTime === 'number' ? msg.currentTime : roomReferenceTime;
        roomReferenceStartedAt = null;
        break;
      case 'SYNC_TO':
        roomPlaybackState = 'playing';
        roomReferenceTime = typeof msg.currentTime === 'number' ? msg.currentTime : roomReferenceTime;
        roomReferenceStartedAt = Date.now();
        break;
      case 'QUEUE_EMPTY':
        roomPlaybackState = 'idle';
        roomCurrentVideoId = null;
        roomReferenceTime = 0;
        roomReferenceStartedAt = null;
        clearPlaybackUnlockCheck();
        hidePlaybackUnlockPrompt();
        break;
      default:
        break;
    }
  }

  function syncParticipantsState(participants) {
    if (!Array.isArray(participants)) return;

    const self = userId
      ? participants.find((participant) => participant.userId === userId)
      : null;

    isHost = Boolean(self && self.isHost);
    SyncClient.setHost(isHost);
    refreshControllerAccess();

    Participants.update(participants, {
      currentUserId: userId,
      canPassControls: isHost,
    });

    if (!isHost) {
      closeTransferControls();
    }
  }

  function resetSearchSelection({ preserveQuery = false } = {}) {
    selectedSearchResult = null;
    updateSearchActionButtons();

    const resultsEl = document.getElementById('song-search-results');
    if (resultsEl) {
      resultsEl.querySelectorAll('.song-search-result.selected').forEach((el) => {
        el.classList.remove('selected');
      });
    }

    if (!preserveQuery) {
      const input = document.getElementById('song-search-input');
      const results = document.getElementById('song-search-results');
      if (input) input.value = '';
      if (results) {
        results.innerHTML = '';
        results.classList.add('hidden');
      }
      searchQuery = '';
      searchNextPageToken = null;
      searchHasMore = false;
      setSearchStatus('Start typing to search');
    }
  }

  function renderSearchResults(items, append = false) {
    const resultsEl = document.getElementById('song-search-results');
    if (!resultsEl) return;

    if (!append) {
      resultsEl.innerHTML = '';
    }

    if (!append && items.length === 0) {
      resultsEl.classList.add('hidden');
      return;
    }

    resultsEl.classList.remove('hidden');

    items.forEach((item) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'song-search-result';
      if (selectedSearchResult?.videoId === item.videoId) {
        card.classList.add('selected');
      }
      card.innerHTML = `
        <img class="song-search-thumb" src="${item.thumbnail}" alt="" loading="lazy">
        <div class="song-search-copy">
          <div class="song-search-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
          <div class="song-search-meta">${escapeHtml(item.channelTitle || 'YouTube')}</div>
        </div>
      `;

      card.addEventListener('click', () => {
        selectedSearchResult = item;
        updateSearchActionButtons();
        resultsEl.querySelectorAll('.song-search-result.selected').forEach((el) => {
          el.classList.remove('selected');
        });
        card.classList.add('selected');
        setSearchStatus(`Selected: ${item.title}`);
      });

      resultsEl.appendChild(card);
    });
  }

  async function runSongSearch(query, { append = false } = {}) {
    const trimmedQuery = query.trim();
    const resultsEl = document.getElementById('song-search-results');

    if (!trimmedQuery) {
      if (searchAbortController) searchAbortController.abort();
      searchQuery = '';
      searchNextPageToken = null;
      searchHasMore = false;
      resetSearchSelection({ preserveQuery: true });
      if (resultsEl) {
        resultsEl.innerHTML = '';
        resultsEl.classList.add('hidden');
      }
      setSearchStatus('Start typing to search');
      return;
    }

    if (trimmedQuery.length < MIN_SEARCH_CHARS) {
      if (!append) {
        searchQuery = trimmedQuery;
        searchNextPageToken = null;
        searchHasMore = false;
        selectedSearchResult = null;
        updateSearchActionButtons();
        if (resultsEl) {
          resultsEl.innerHTML = '';
          resultsEl.classList.add('hidden');
        }
      }
      setSearchStatus(`Type at least ${MIN_SEARCH_CHARS} characters to search`);
      return;
    }

    if (searchIsLoading) return;
    if (!append) {
      if (searchAbortController) searchAbortController.abort();
      searchNextPageToken = null;
      searchHasMore = false;
      selectedSearchResult = null;
      updateSearchActionButtons();
    }

    searchQuery = trimmedQuery;
    const cacheKey = `${trimmedQuery.toLowerCase()}::${append ? searchNextPageToken || '' : ''}`;
    if (searchCache.has(cacheKey)) {
      const cached = searchCache.get(cacheKey);
      renderSearchResults(cached.items || [], append);
      searchNextPageToken = cached.nextPageToken || null;
      searchHasMore = Boolean(cached.nextPageToken);
      setSearchStatus(
        cached.items?.length
          ? 'Select a result to queue it or play it next'
          : 'No results found'
      );
      return;
    }

    searchAbortController = new AbortController();
    setSearchLoading(true);
    setSearchStatus(append ? 'Loading more results...' : 'Searching YouTube...');

    try {
      const params = new URLSearchParams({ q: trimmedQuery });
      if (append && searchNextPageToken) {
        params.set('pageToken', searchNextPageToken);
      }

      const response = await fetch(`/api/youtube/search?${params.toString()}`, {
        signal: searchAbortController.signal,
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || 'Search unavailable right now');
      }

      searchCache.set(cacheKey, {
        items: data.items || [],
        nextPageToken: data.nextPageToken || null,
      });
      renderSearchResults(data.items || [], append);
      searchNextPageToken = data.nextPageToken || null;
      searchHasMore = Boolean(data.nextPageToken);
      setSearchStatus(
        data.items?.length
          ? 'Select a result to queue it or play it next'
          : 'No results found'
      );
    } catch (error) {
      if (error.name === 'AbortError') return;
      setSearchStatus(error.message || 'Search unavailable right now');
    } finally {
      setSearchLoading(false);
    }
  }

  function queueSelectedSearchResult(type) {
    if (!selectedSearchResult) return;
    if (type === 'PLAY_NEXT' && !isHost) {
      Notifications.info('Only the controller can Play Next');
      return;
    }

    send({ type, videoUrl: selectedSearchResult.videoId });
    Notifications.success(
      type === 'PLAY_NEXT' ? 'Song added to play next' : 'Song added to queue',
      2200
    );
    setSearchStatus(
      type === 'PLAY_NEXT'
        ? 'Added to Play Next. Search results are still here for your next pick.'
        : 'Added to queue. Search results are still here for your next pick.'
    );
  }

  function openTransferControls(targetUserId, targetUsername) {
    if (!isHost || !targetUserId || targetUserId === userId) return;

    pendingControlTransfer = {
      userId: targetUserId,
      username: targetUsername || 'this listener',
    };

    const modal = document.getElementById('control-transfer-modal');
    const title = document.getElementById('control-transfer-title');
    const body = document.getElementById('control-transfer-body');
    const confirmBtn = document.getElementById('control-transfer-confirm');

    if (title) title.textContent = `Pass controls to ${pendingControlTransfer.username}?`;
    if (body) {
      body.textContent = `${pendingControlTransfer.username} will control play, pause, seek, skip, and Play Next until they pass it on again.`;
    }
    if (confirmBtn) confirmBtn.textContent = `Pass to ${pendingControlTransfer.username}`;
    if (modal) modal.classList.remove('hidden');
  }

  function closeTransferControls() {
    pendingControlTransfer = null;
    const modal = document.getElementById('control-transfer-modal');
    if (modal) modal.classList.add('hidden');
  }

  function confirmTransferControls() {
    if (!pendingControlTransfer) return;

    send({
      type: 'TRANSFER_HOST',
      targetUserId: pendingControlTransfer.userId,
    });

    Notifications.info(`Passing controls to ${pendingControlTransfer.username}...`, 1800);
    closeTransferControls();
  }

  function handleControlTransferred(msg) {
    if (msg.toUserId === userId) {
      Notifications.success(
        msg.reason === 'controller_left'
          ? 'You picked up the controls'
          : 'You have the controls now'
      );
      return;
    }

    if (msg.fromUserId === userId) {
      Notifications.info(`You passed controls to ${msg.toUsername || 'someone'}`);
      return;
    }

    Notifications.info(`${msg.toUsername || 'Someone'} now has playback controls`);
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

  function broadcastHostSeek(time) {
    if (!isHost || typeof time !== 'number' || isNaN(time)) return;

    // The seek bar sends immediately for responsiveness; the player's own
    // seek detector may also fire shortly after. Collapse both into one event.
    const now = Date.now();
    if (
      lastSentSeekTime !== null &&
      Math.abs(lastSentSeekTime - time) < 0.5 &&
      now - lastSentSeekAt < 1200
    ) {
      return;
    }

    lastSentSeekTime = time;
    lastSentSeekAt = now;
    send({ type: 'SEEK', seekTime: time });
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
        syncThemeFromQueue(msg.queue);
        break;
      case 'PARTICIPANT_UPDATE':
        syncParticipantsState(msg.participants);
        break;
      case 'CONTROL_TRANSFERRED':
        handleControlTransferred(msg);
        break;
      case 'USER_JOINED':
        Notifications.info(`${msg.username} joined the session`);
        break;
      case 'USER_LEFT':
        Notifications.info('Someone left the session');
        break;
      case 'QUEUE_EMPTY':
        updateRoomPlaybackContext('QUEUE_EMPTY');
        resetReactiveTheme();
        Notifications.info('Queue is empty. Add more tracks to keep going.');
        Player.showPlaceholder();
        SyncClient.updatePlayButton('paused');
        {
          const titleEl = document.getElementById('now-playing-title');
          if (titleEl) titleEl.textContent = 'Nothing playing';
        }
        break;
      case 'ERROR':
        Notifications.error(msg.message);
        break;
      case 'CHAT_MESSAGE':
        Chat.handleMessage(msg);
        break;

      case 'CUE_VIDEO':
        if (msg.videoId) roomCurrentVideoId = msg.videoId;
        SyncClient.handleMessage(msg);
        break;
      case 'PLAY':
      case 'SEEK':
      case 'PAUSE':
      case 'RESUME':
      case 'SYNC_TO':
        updateRoomPlaybackContext(msg.type, msg);
        SyncClient.handleMessage(msg);
        if (shouldOfferPlaybackUnlock() && roomPlaybackState === 'playing') {
          schedulePlaybackUnlockCheck();
        } else {
          hidePlaybackUnlockPrompt();
        }
        break;
      case 'LAG_INFO':
        SyncClient.handleMessage(msg);
        break;
    }
  }

  function handleSessionCreated(msg) {
    userId = msg.userId;
    sessionCode = msg.code;
    username = msg.username;
    Chat.setSessionContext({ userId, username, sessionCode });
    if (msg.chat) Chat.setHistory(msg.chat);

    switchToSessionView(msg.code, msg.username);
    syncParticipantsState(msg.participants || []);
    Notifications.success('Session ready. Share the code.');
  }

  function handleSessionJoined(msg) {
    userId = msg.userId;
    sessionCode = msg.code;
    username = msg.username;
    Chat.setSessionContext({ userId, username, sessionCode });
    if (msg.chat) Chat.setHistory(msg.chat);

    switchToSessionView(msg.code, msg.username);
    syncParticipantsState(msg.participants || []);
    Notifications.success('Joined the room');
  }

  function handleSessionState(msg) {
    // Full state from server on join
    if (msg.queue) QueueUI.update(msg.queue);
    if (msg.queue) syncThemeFromQueue(msg.queue);
    if (msg.participants) syncParticipantsState(msg.participants);
    if (msg.chat) Chat.setHistory(msg.chat);

    roomCurrentVideoId = msg.currentVideo?.videoId || null;
    roomPlaybackState = msg.playbackState || 'idle';
    roomReferenceTime = typeof msg.currentTime === 'number' ? msg.currentTime : 0;
    roomReferenceStartedAt = roomPlaybackState === 'playing' ? Date.now() : null;

    // If there's a current video, sync to it
    if (msg.currentVideo && msg.playbackState !== 'idle') {
      const titleEl = document.getElementById('now-playing-title');
      if (titleEl) titleEl.textContent = msg.currentVideo.title || 'Playing';

      if (msg.playbackState === 'playing') {
        Player.loadVideo(msg.currentVideo.videoId, msg.currentTime || 0);
        SyncClient.updatePlayButton('playing');
      } else if (msg.playbackState === 'paused') {
        Player.cueVideo(msg.currentVideo.videoId, msg.currentTime || 0);
        SyncClient.updatePlayButton('paused');
      }
    }

    if (shouldOfferPlaybackUnlock() && roomPlaybackState === 'playing' && roomCurrentVideoId) {
      schedulePlaybackUnlockCheck();
    } else {
      hidePlaybackUnlockPrompt();
    }
  }

  // ---- UI Switching ----

  function switchToSessionView(code, displayUsername) {
    document.getElementById('landing-view').classList.remove('active');
    document.getElementById('session-view').classList.add('active');
    if (stopParticlesAnimation) {
      stopParticlesAnimation();
      stopParticlesAnimation = null;
    }

    const codeEl = document.getElementById('session-code-value');
    if (codeEl) codeEl.textContent = code;
    
    // Add username next to the logo
    const headerUsernameEl = document.getElementById('header-username');
    if (headerUsernameEl) {
      headerUsernameEl.textContent = displayUsername || 'Anonymous';
    }

    refreshControllerAccess();
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
          Notifications.info('Only the controller can scrub the track');
          return;
        }
        const val = parseFloat(seekBarEl.value);
        Player.seekTo(val);
        broadcastHostSeek(val);
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

    // Search and add songs
    const addBtn = document.getElementById('add-queue-btn');
    const playNextBtn = document.getElementById('play-next-btn');
    const searchInput = document.getElementById('song-search-input');
    const searchResults = document.getElementById('song-search-results');
    const transferModal = document.getElementById('control-transfer-modal');
    const transferCancelBtn = document.getElementById('control-transfer-cancel');
    const transferConfirmBtn = document.getElementById('control-transfer-confirm');
    const unlockBtn = document.getElementById('player-unlock-btn');

    refreshControllerAccess();

    addBtn.addEventListener('click', () => {
      queueSelectedSearchResult('ADD_TO_QUEUE');
    });

    playNextBtn.addEventListener('click', () => {
      queueSelectedSearchResult('PLAY_NEXT');
    });

    if (transferCancelBtn) {
      transferCancelBtn.addEventListener('click', closeTransferControls);
    }

    if (transferConfirmBtn) {
      transferConfirmBtn.addEventListener('click', confirmTransferControls);
    }

    if (transferModal) {
      transferModal.addEventListener('click', (e) => {
        if (e.target === transferModal) {
          closeTransferControls();
        }
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeTransferControls();
      }
    });

    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const query = searchInput.value;
        if (searchDebounce) clearTimeout(searchDebounce);
        searchDebounce = setTimeout(() => {
          runSongSearch(query);
        }, SEARCH_DEBOUNCE_MS);
      });

      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          if (selectedSearchResult) {
            addBtn.click();
            return;
          }

          if (searchDebounce) clearTimeout(searchDebounce);
          runSongSearch(searchInput.value);
        }
      });
    }

    if (searchResults) {
      searchResults.addEventListener('scroll', () => {
        if (!searchHasMore || searchIsLoading) return;
        const nearBottom =
          searchResults.scrollTop + searchResults.clientHeight >= searchResults.scrollHeight - 36;

        if (nearBottom) {
          runSongSearch(searchQuery, { append: true });
        }
      });
    }

    // Play/pause button (host only)
    const playPauseBtn = document.getElementById('play-pause-btn');
    playPauseBtn.addEventListener('click', () => {
      const playingState = window.YT?.PlayerState?.PLAYING ?? 1;
      if (!isHost) {
        if (shouldOfferPlaybackUnlock() && roomPlaybackState === 'playing' && roomCurrentVideoId && Player.getState() !== playingState) {
          attemptPlaybackUnlock();
          return;
        }
        Notifications.info('Only the controller can control playback');
        return;
      }
      const state = Player.getState();
      if (state === playingState) {
        Player.pauseVideo();
        send({ type: 'PAUSE' });
      } else {
        const time = Player.getCurrentTime();
        Player.playVideo();
        send({ type: 'RESUME', currentTime: time });
      }
    });

    // Skip track (host only)
    const skipBtn = document.getElementById('next-btn');
    skipBtn.addEventListener('click', () => {
      if (!isHost) {
        Notifications.info('Only the controller can control playback');
        return;
      }
      send({ type: 'SKIP_TRACK' });
    });

    // Previous track (host only)
    const prevBtn = document.getElementById('prev-btn');
    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        if (!isHost) {
          Notifications.info('Only the controller can control playback');
          return;
        }
        send({ type: 'PREV_TRACK' });
      });
    }


    if (unlockBtn) {
      unlockBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        attemptPlaybackUnlock();
      });
    }
  }

  // ---- Particle Background ----

  function initParticles() {
    const canvas = document.getElementById('particles-canvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let particles = [];
    const PARTICLE_COUNT = 50;
    let isActive = true;
    let animationFrameId = null;

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
      if (!isActive) return;
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

      animationFrameId = requestAnimationFrame(animate);
    }

    stopParticlesAnimation = () => {
      isActive = false;
      if (animationFrameId !== null) {
        cancelAnimationFrame(animationFrameId);
      }
      window.removeEventListener('resize', resize);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      canvas.style.display = 'none';
    };

    animate();
  }

  // ---- Init on DOM ready ----
  document.addEventListener('DOMContentLoaded', () => {
    init();
  });

  return {
    send,
    init,
    getIsHost: () => isHost,
    openTransferControls,
    attemptPlaybackUnlock,
  };
})();

window.App = App;
