// Jammin — Main App (WebSocket + UI Orchestration)

const App = (() => {
  let ws = null;
  let userId = null;
  let sessionCode = null;
  let reconnectToken = '';
  let isHost = false;
  let username = 'Anonymous';
  let playbackMode = 'disabled';
  let pendingJoinPlaybackMode = 'viewer';
  let pendingJoinCode = '';

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
  let openSearchMenuEl = null;
  let openSearchMenuCloseTimer = null;
  let openSearchMenuFadeTimer = null;
  let selectedSearchResult = null;
  let songInputMode = 'search';
  let searchInputDraft = '';
  let linkInputDraft = '';
  let youtubeSearchQuotaExhausted = false;
  let playlistPreviewAbortController = null;
  let pendingPlaylistImport = null;
  let spotifyReviewAbortController = null;
  let spotifyCorrectionAbortController = null;
  let pendingSpotifyImport = null;
  let spotifyPlaylistDraft = '';
  let spotifyCorrectionQuery = '';
  let spotifyLoadMorePending = false;
  let activeSpotifyCorrectionTrackId = null;
  let spotifyAuthState = {
    connected: false,
    displayName: '',
    checked: false,
  };
  let currentQueueState = { current: null, upcoming: [], history: [] };
  let suggestionAbortController = null;
  let pendingControlTransfer = null;
  let roomPlaybackState = 'idle';
  let roomCurrentVideoId = null;
  let roomCurrentTrack = null;
  let roomDurationSeconds = 0;
  let roomReferenceTime = 0;
  let roomReferenceStartedAt = null;
  let playbackUnlockTimer = null;
  let playbackUnlockDismissedVideoId = '';
  let blockedTrackRecoveryTimer = null;
  let blockedTrackRecoveryVideoId = null;
  let trackMetaAbortController = null;
  let trackMetaPendingVideoId = '';
  let hasPlaybackUnlock = false;
  const locallyBlockedVideoIds = new Set();
  let lastHandledPlayerErrorKey = '';
  let themeRequestToken = 0;
  let activeThemeKey = 'default';
  let activeMobileSurface = '';
  const themeCache = new Map();
  const SEARCH_DEBOUNCE_MS = 725;
  const SEARCH_MENU_CLOSE_DELAY_MS = 1500;
  const SEARCH_MENU_FADE_MS = 180;
  const MIN_SEARCH_CHARS = 4;
  const SEARCH_CACHE_VERSION = 'music-rank-v2';
  const SPOTIFY_IMPORT_ENABLED = false;
  const SPOTIFY_REVIEW_CONFIDENCE_THRESHOLD = 68;
  const SPOTIFY_PLAYLIST_DRAFT_STORAGE_KEY = 'jammin_spotify_playlist_draft';
  const SPOTIFY_REVIEW_AFTER_AUTH_STORAGE_KEY = 'jammin_spotify_review_after_auth';
  const ACTIVE_SESSION_STORAGE_KEY = 'jammin_active_session';
  const searchCache = new Map();
  const trackMetaCache = new Map();
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
    applyFeatureFlags();
    bindSessionEvents();
    if (SPOTIFY_IMPORT_ENABLED) {
      restoreSpotifyDraftState();
      const spotifyRedirectState = consumeSpotifyAuthRedirectState();
      refreshSpotifyAuthState({
        autoResumeReview: spotifyRedirectState.status === 'connected',
        transferToken: spotifyRedirectState.transferToken || '',
      });
    }
    attemptSavedSessionResume();

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
      onError: handleLocalPlayerError,
    });
  }

  // ---- Utilities ----

  function startSeekUpdates() {
    if (seekUpdateInterval) return;
    seekUpdateInterval = setInterval(() => {
      if (isDraggingSeek || !seekBarEl) return;

      const currentTime = isLocalPlaybackEnabled() ? Player.getCurrentTime() : getExpectedRoomTime();
      const duration = isLocalPlaybackEnabled() ? Player.getDuration() : roomDurationSeconds;

      if (seekCurrentEl) seekCurrentEl.textContent = formatTime(currentTime);

      if (duration > 0) {
        seekBarEl.max = duration;
        seekBarEl.value = Math.min(currentTime, duration);
        if (seekTotalEl) seekTotalEl.textContent = formatTime(duration);
      } else {
        const fallbackMax = Math.max(1, Math.ceil(currentTime || 1));
        seekBarEl.max = fallbackMax;
        seekBarEl.value = Math.min(currentTime, fallbackMax);
        if (seekTotalEl) seekTotalEl.textContent = roomCurrentTrack?.duration ? roomCurrentTrack.duration : '--:--';
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

  function parseYouTubeInput(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;

    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
      /^([a-zA-Z0-9_-]{11})$/,
    ];

    for (const pattern of patterns) {
      const match = raw.match(pattern);
      if (match) return match[1];
    }
    return null;
  }

  function parseYouTubePlaylistInput(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;

    try {
      const parsed = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
      return parsed.searchParams.get('list');
    } catch (error) {
      const match = raw.match(/[?&]list=([a-zA-Z0-9_-]+)/);
      return match ? match[1] : null;
    }
  }

  function parseSpotifyPlaylistInput(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;

    const uriMatch = raw.match(/^spotify:playlist:([a-zA-Z0-9]+)$/i);
    if (uriMatch) return uriMatch[1];

    try {
      const parsed = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
      const pathMatch = parsed.pathname.match(/\/playlist\/([a-zA-Z0-9]+)/i);
      return pathMatch ? pathMatch[1] : null;
    } catch (error) {
      const match = raw.match(/playlist\/([a-zA-Z0-9]+)/i);
      return match ? match[1] : null;
    }
  }

  async function readApiResponse(response, fallbackMessage) {
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return response.json();
    }

    const text = await response.text();
    const error = new Error(fallbackMessage || 'The server returned an unexpected response.');
    error.code = 'non_json_api_response';
    error.responseText = text;
    throw error;
  }

  function setSearchLoading(loading) {
    searchIsLoading = loading;
    const resultsEl = document.getElementById('song-search-results');
    if (resultsEl) resultsEl.dataset.loading = loading ? 'true' : 'false';
  }

  function isMobileViewport() {
    return window.matchMedia?.('(max-width: 900px)').matches;
  }

  function syncMobileSurfaceState() {
    const mobile = isMobileViewport();
    document.body.dataset.mobileSurface = mobile ? activeMobileSurface || '' : '';
    const backdrop = document.getElementById('mobile-surface-backdrop');
    if (backdrop) {
      backdrop.classList.toggle('hidden', !mobile || !activeMobileSurface);
    }

    const chatBtn = document.getElementById('mobile-chat-btn');
    const searchBtn = document.getElementById('mobile-search-btn');
    const queueBtn = document.getElementById('mobile-queue-btn');
    const dock = document.getElementById('mobile-bottom-dock');
    dock?.classList.toggle('hidden', !mobile);
    chatBtn?.classList.toggle('active', activeMobileSurface === 'chat');
    searchBtn?.classList.toggle('active', activeMobileSurface === 'search');
    queueBtn?.classList.toggle('active', activeMobileSurface === 'queue');
  }

  function setMobileSurface(surface = '') {
    if (!isMobileViewport()) {
      activeMobileSurface = '';
      syncMobileSurfaceState();
      return;
    }

    const nextSurface = activeMobileSurface === surface ? '' : surface;
    activeMobileSurface = nextSurface;

    if (nextSurface === 'search' || nextSurface === 'queue') {
      if (window.Chat?.isOpen?.()) window.Chat.close();
      if (window.Participants?.isOpen?.()) window.Participants.closePanel();
      if (nextSurface === 'search') {
        window.setTimeout(() => {
          document.getElementById('song-search-input')?.focus();
        }, 180);
      }
    }

    if (nextSurface === 'chat') {
      if (window.Participants?.isOpen?.()) window.Participants.closePanel();
      if (!window.Chat?.isOpen?.()) window.Chat?.open?.();
    } else if (activeMobileSurface !== 'chat' && window.Chat?.isOpen?.() && surface !== 'chat') {
      window.Chat.close();
    }

    syncMobileSurfaceState();
  }

  function closeMobileSurface() {
    if (!activeMobileSurface) return;
    const previousSurface = activeMobileSurface;
    activeMobileSurface = '';
    if (previousSurface === 'chat' && window.Chat?.isOpen?.()) {
      window.Chat.close();
      return;
    }
    syncMobileSurfaceState();
  }

  function updateMobileUpNextPreview() {
    const card = document.getElementById('mobile-upnext-card');
    const thumb = document.getElementById('mobile-upnext-thumb');
    const title = document.getElementById('mobile-upnext-title');
    const meta = document.getElementById('mobile-upnext-meta');
    if (!card || !thumb || !title || !meta) return;

    if (!isMobileViewport()) {
      card.classList.add('hidden');
      return;
    }

    const nextItem = currentQueueState?.upcoming?.[0] || null;
    if (!nextItem) {
      card.classList.add('hidden');
      return;
    }

    card.classList.remove('hidden');
    thumb.src = nextItem.thumbnail || thumbnailForVideo(nextItem.videoId);
    thumb.alt = nextItem.title ? `${nextItem.title} artwork` : 'Up next artwork';
    title.textContent = nextItem.title || 'Next track';
    meta.textContent = nextItem.artist || nextItem.channelTitle || 'Ready in the queue';
  }

  function setSpotifyImportStatus(message) {
    const statusEl = document.getElementById('spotify-import-status');
    if (statusEl) statusEl.textContent = message;
  }

  function applyFeatureFlags() {
    document.body.dataset.spotifyImport = SPOTIFY_IMPORT_ENABLED ? 'on' : 'off';

    const spotifyBar = document.querySelector('.spotify-import-bar');
    if (spotifyBar) {
      spotifyBar.hidden = !SPOTIFY_IMPORT_ENABLED;
    }

    const spotifyImportModal = document.getElementById('spotify-import-modal');
    if (spotifyImportModal && !SPOTIFY_IMPORT_ENABLED) {
      spotifyImportModal.classList.add('hidden');
    }

    const spotifyCorrectionModal = document.getElementById('spotify-correction-modal');
    if (spotifyCorrectionModal && !SPOTIFY_IMPORT_ENABLED) {
      spotifyCorrectionModal.classList.add('hidden');
    }
  }

  function saveSpotifyDraftState({ shouldAutoReview = false } = {}) {
    try {
      const rawValue = String(document.getElementById('spotify-playlist-input')?.value || spotifyPlaylistDraft || '').trim();
      if (rawValue) {
        window.localStorage.setItem(SPOTIFY_PLAYLIST_DRAFT_STORAGE_KEY, rawValue);
      }
      if (shouldAutoReview) {
        window.localStorage.setItem(SPOTIFY_REVIEW_AFTER_AUTH_STORAGE_KEY, '1');
      } else {
        window.localStorage.removeItem(SPOTIFY_REVIEW_AFTER_AUTH_STORAGE_KEY);
      }
    } catch (error) {
      // Ignore storage failures and keep the in-memory draft.
    }
  }

  function restoreSpotifyDraftState() {
    try {
      const savedDraft = window.localStorage.getItem(SPOTIFY_PLAYLIST_DRAFT_STORAGE_KEY) || '';
      if (savedDraft && !spotifyPlaylistDraft) {
        spotifyPlaylistDraft = savedDraft;
      }
      const input = document.getElementById('spotify-playlist-input');
      if (input && spotifyPlaylistDraft && !input.value) {
        input.value = spotifyPlaylistDraft;
      }
    } catch (error) {
      // Ignore storage failures and fall back to the in-memory draft.
    }
  }

  function clearSpotifyReviewAfterAuthFlag() {
    try {
      window.localStorage.removeItem(SPOTIFY_REVIEW_AFTER_AUTH_STORAGE_KEY);
    } catch (error) {
      // Ignore storage failures.
    }
  }

  function getSpotifyReviewAfterAuthFlag() {
    try {
      return window.localStorage.getItem(SPOTIFY_REVIEW_AFTER_AUTH_STORAGE_KEY) === '1';
    } catch (error) {
      return false;
    }
  }

  function getSpotifyReturnToPath() {
    const url = new URL(window.location.href);
    url.searchParams.delete('spotify');
    url.searchParams.delete('spotify_message');
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function updateSpotifyAuthButton() {
    const button = document.getElementById('spotify-auth-btn');
    if (!button) return;

    button.classList.toggle('is-connected', spotifyAuthState.connected);
    button.textContent = spotifyAuthState.connected ? 'Connected' : 'Connect';
    button.title = spotifyAuthState.connected
      ? `Spotify connected${spotifyAuthState.displayName ? ` as ${spotifyAuthState.displayName}` : ''}`
      : 'Connect Spotify to import playlists from your account';
  }

  function syncSpotifyImportStatusToState() {
    const playlistId = parseSpotifyPlaylistInput(document.getElementById('spotify-playlist-input')?.value || spotifyPlaylistDraft || '');
    if (!spotifyAuthState.connected) {
      setSpotifyImportStatus(
        playlistId
          ? 'Spotify playlist detected. Connect Spotify once to review it from your account.'
          : 'Connect Spotify to review playlists from your account.'
      );
      return;
    }

    if (playlistId) {
      setSpotifyImportStatus('Spotify playlist detected. Review matches before adding it to Jammin.');
      return;
    }

    setSpotifyImportStatus(
      spotifyAuthState.displayName
        ? `Connected as ${spotifyAuthState.displayName}. Paste a playlist link to review it before import.`
        : 'Spotify connected. Paste a playlist link to review it before import.'
    );
  }

  function beginSpotifyAuth({ autoReview = false, authUrl = '' } = {}) {
    saveSpotifyDraftState({ shouldAutoReview: autoReview });
    const fallbackAuthUrl = `/api/spotify/auth/start?returnTo=${encodeURIComponent(getSpotifyReturnToPath())}`;
    window.location.href = authUrl || fallbackAuthUrl;
  }

  function saveActiveSessionState() {
    if (!sessionCode || !username || !reconnectToken) return;
    try {
      window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, JSON.stringify({
        code: sessionCode,
        username,
        playbackMode: playbackMode === 'viewer' ? 'viewer' : 'player',
        reconnectToken,
      }));
    } catch (error) {
      // Ignore storage issues; in-memory reconnect still works.
    }
  }

  function clearActiveSessionState() {
    try {
      window.localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY);
    } catch (error) {
      // Ignore storage issues.
    }
  }

  function readActiveSessionState() {
    try {
      const raw = window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed?.code || !parsed?.username || !parsed?.reconnectToken) return null;
      return {
        code: String(parsed.code).trim().toUpperCase(),
        username: String(parsed.username).trim() || 'Anonymous',
        playbackMode: parsed.playbackMode === 'viewer' ? 'viewer' : 'player',
        reconnectToken: String(parsed.reconnectToken).trim(),
      };
    } catch (error) {
      return null;
    }
  }

  function attemptSavedSessionResume() {
    if (sessionCode || (ws && ws.readyState === WebSocket.OPEN)) return;
    const saved = readActiveSessionState();
    if (!saved) return;

    username = saved.username;
    pendingJoinPlaybackMode = saved.playbackMode;
    reconnectToken = saved.reconnectToken;

    connect();
    waitForConnection(() => {
      send({
        type: 'JOIN_SESSION',
        code: saved.code,
        username,
        playbackMode: pendingJoinPlaybackMode,
        reconnectToken,
      });
    });
  }

  function consumeSpotifyAuthRedirectState() {
    const url = new URL(window.location.href);
    const status = url.searchParams.get('spotify');
    const message = url.searchParams.get('spotify_message');
    const transferToken = url.searchParams.get('spotify_transfer');
    if (!status && !transferToken) {
      return { status: '', transferToken: '' };
    }

    url.searchParams.delete('spotify');
    url.searchParams.delete('spotify_message');
    url.searchParams.delete('spotify_transfer');
    window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);

    if (status === 'connected') {
      Notifications.success('Spotify connected', 1800);
    } else if (status === 'error') {
      Notifications.error(message || 'Spotify sign-in did not finish cleanly.');
    }

    return {
      status: status || '',
      transferToken: transferToken || '',
    };
  }

  async function refreshSpotifyAuthState({ autoResumeReview = false, transferToken = '' } = {}) {
    updateSpotifyAuthButton();
    restoreSpotifyDraftState();

    try {
      if (transferToken) {
        const claimResponse = await fetch(`/api/spotify/session/claim?token=${encodeURIComponent(transferToken)}`);
        const claimData = await readApiResponse(
          claimResponse,
          'Spotify auth handoff needs a quick server refresh. Restart Jammin and reconnect Spotify.'
        );
        if (!claimResponse.ok) {
          throw new Error(claimData?.error || 'Spotify sign-in handoff expired. Connect Spotify again.');
        }
      }

      const response = await fetch('/api/spotify/session');
      const data = await readApiResponse(
        response,
        'Spotify auth status needs a quick server refresh. Restart Jammin and reconnect Spotify.'
      );

      spotifyAuthState.connected = Boolean(data.connected);
      spotifyAuthState.displayName = data.displayName || '';
      spotifyAuthState.checked = true;
      updateSpotifyAuthButton();
      syncSpotifyImportStatusToState();

      if (spotifyAuthState.connected && autoResumeReview && getSpotifyReviewAfterAuthFlag()) {
        const draft = String(document.getElementById('spotify-playlist-input')?.value || spotifyPlaylistDraft || '').trim();
        const playlistId = parseSpotifyPlaylistInput(draft);
        clearSpotifyReviewAfterAuthFlag();
        if (playlistId) {
          previewSpotifyPlaylistImport(playlistId);
        }
      }
    } catch (error) {
      spotifyAuthState.connected = false;
      spotifyAuthState.displayName = '';
      spotifyAuthState.checked = true;
      updateSpotifyAuthButton();
      syncSpotifyImportStatusToState();
    }
  }

  function isLocalPlaybackEnabled() {
    return playbackMode === 'player';
  }

  function parseDurationToSeconds(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, value);
    }

    const raw = String(value || '').trim();
    if (!raw) return 0;
    const parts = raw.split(':').map((part) => Number(part));
    if (parts.some((part) => Number.isNaN(part))) return 0;

    if (parts.length === 2) {
      return (parts[0] * 60) + parts[1];
    }

    if (parts.length === 3) {
      return (parts[0] * 3600) + (parts[1] * 60) + parts[2];
    }

    return 0;
  }

  function resolveTrackDurationSeconds(item) {
    if (!item) return 0;
    if (typeof item.durationSeconds === 'number') return item.durationSeconds;
    if (typeof item.durationMs === 'number') return Math.round(item.durationMs / 1000);
    return parseDurationToSeconds(item.duration);
  }

  function resolveTrackThumbnail(item) {
    if (!item) return '';
    return item.thumbnail || thumbnailForVideo(item.videoId);
  }

  function updateRoomTrackContext(track) {
    roomCurrentTrack = track ? { ...roomCurrentTrack, ...track } : null;
    roomDurationSeconds = resolveTrackDurationSeconds(roomCurrentTrack);
    if (roomCurrentTrack?.videoId && (!roomDurationSeconds || !roomCurrentTrack.thumbnail || !roomCurrentTrack.artist)) {
      ensureCurrentTrackMetadata(roomCurrentTrack.videoId);
    }
  }

  async function ensureCurrentTrackMetadata(videoId) {
    const safeVideoId = String(videoId || '').trim();
    if (!safeVideoId) return;

    const applyMeta = (meta) => {
      const activeVideoId = currentQueueState?.current?.videoId || roomCurrentVideoId || roomCurrentTrack?.videoId || '';
      if (!meta || (activeVideoId && activeVideoId !== safeVideoId)) return;
      roomCurrentTrack = {
        ...roomCurrentTrack,
        ...meta,
      };
      roomDurationSeconds = resolveTrackDurationSeconds(roomCurrentTrack);
      if (currentQueueState?.current?.videoId === safeVideoId) {
        currentQueueState.current = {
          ...currentQueueState.current,
          ...meta,
        };
      }
      updateNowPlayingDisplay(currentQueueState.current || roomCurrentTrack);
      renderPlaybackSurface();
    };

    if (trackMetaCache.has(safeVideoId)) {
      applyMeta(trackMetaCache.get(safeVideoId));
      return;
    }

    if (trackMetaPendingVideoId === safeVideoId) {
      return;
    }

    if (trackMetaAbortController) {
      trackMetaAbortController.abort();
    }
    trackMetaPendingVideoId = safeVideoId;
    trackMetaAbortController = new AbortController();

    try {
      const params = new URLSearchParams({ videoId: safeVideoId });
      const response = await fetch(`/api/youtube/video-meta?${params.toString()}`, {
        signal: trackMetaAbortController.signal,
      });
      const data = await readApiResponse(response, 'Track details need a quick server refresh right now.');
      if (!response.ok) {
        throw new Error(data?.error || 'Unable to load track details right now');
      }
      trackMetaCache.set(safeVideoId, data);
      applyMeta(data);
    } catch (error) {
      if (error.name === 'AbortError') return;
    } finally {
      if (trackMetaPendingVideoId === safeVideoId) {
        trackMetaPendingVideoId = '';
      }
      trackMetaAbortController = null;
    }
  }

  function resetViewerPlaceholder() {
    const placeholder = document.getElementById('player-placeholder');
    const defaultEl = document.getElementById('player-placeholder-default');
    const viewerCard = document.getElementById('viewer-mode-card');
    if (placeholder) placeholder.classList.remove('viewer-mode');
    if (defaultEl) defaultEl.classList.remove('hidden');
    if (viewerCard) viewerCard.classList.add('hidden');
  }

  function showViewerPlaceholder(track) {
    const placeholder = document.getElementById('player-placeholder');
    const defaultEl = document.getElementById('player-placeholder-default');
    const viewerCard = document.getElementById('viewer-mode-card');
    const thumbEl = document.getElementById('viewer-mode-thumb');
    const titleEl = document.getElementById('viewer-mode-title');
    const metaEl = document.getElementById('viewer-mode-meta');

    if (!placeholder || !viewerCard) return;

    placeholder.classList.remove('hidden');
    placeholder.classList.add('viewer-mode');
    defaultEl?.classList.add('hidden');
    viewerCard.classList.remove('hidden');

    if (thumbEl) {
      const thumb = resolveTrackThumbnail(track);
      thumbEl.src = thumb;
      thumbEl.alt = track?.title ? `${track.title} artwork` : 'Current track artwork';
      thumbEl.classList.toggle('hidden', !thumb);
    }
    if (titleEl) {
      titleEl.textContent = track?.title || 'Waiting for the next track';
    }
    if (metaEl) {
      metaEl.textContent = track?.artist || track?.channelTitle || 'Listening on the shared speaker.';
    }
  }

  function showStandardPlaceholder(title = 'Pick a track to begin', detail = '') {
    resetViewerPlaceholder();
    Player.showPlaceholder(title, detail);
  }

  function renderPlaybackSurface() {
    if (isLocalPlaybackEnabled()) {
      resetViewerPlaceholder();
      if (!roomCurrentVideoId && !currentQueueState.current) {
        showStandardPlaceholder('Pick a track to begin', '');
      }
      return;
    }

    const track = currentQueueState.current || roomCurrentTrack;
    if (track?.videoId || track?.title) {
      showViewerPlaceholder(track);
    } else {
      showStandardPlaceholder(
        'Waiting for the room',
        'This device is following the shared speaker. Once playback starts, the current track will show up here.'
      );
    }
  }

  function setSessionPlaybackMode(nextMode = 'player') {
    playbackMode = nextMode === 'viewer' ? 'viewer' : 'player';
    document.body.dataset.playbackMode = playbackMode;
    Player.setPlaybackMode(playbackMode);
    clearPlaybackUnlockCheck();
    hidePlaybackUnlockPrompt();
    renderPlaybackSurface();
    refreshControllerAccess();
  }

  function getSongInputEl() {
    return document.getElementById('song-search-input');
  }

  function canManageQueue() {
    return Boolean(userId && sessionCode);
  }

  function getSongInputValue() {
    return (getSongInputEl()?.value || '').trim();
  }

  function getSongInputTarget() {
    if (songInputMode === 'link') {
      const raw = getSongInputValue();
      const playlistId = parseYouTubePlaylistInput(raw);
      if (playlistId) {
        return { kind: 'playlist', playlistId, raw };
      }

      const videoId = parseYouTubeInput(raw);
      if (videoId) {
        return { kind: 'video', videoId, raw };
      }
      return null;
    }

    if (!selectedSearchResult?.videoId) return null;
    return { kind: 'video', videoId: selectedSearchResult.videoId, raw: selectedSearchResult.videoId };
  }

  function getSelectedVideoTarget() {
    if (songInputMode === 'link') {
      const target = getSongInputTarget();
      return target?.kind === 'video' ? target.videoId : null;
    }
    return selectedSearchResult?.videoId || null;
  }

  function updateSongInputModeUI() {
    const addSongBar = document.querySelector('.add-song-bar');
    const shell = document.querySelector('.song-search-shell');
    const searchBtn = document.getElementById('song-mode-search-btn');
    const linkBtn = document.getElementById('song-mode-link-btn');
    const input = getSongInputEl();
    if (!input) return;

    if (addSongBar) addSongBar.dataset.mode = songInputMode;
    if (shell) shell.dataset.mode = songInputMode;

    const isSearch = songInputMode === 'search';
    input.type = isSearch ? 'text' : 'url';
    input.placeholder = isSearch
      ? 'Search YouTube songs, artists, or soundtracks...'
      : 'Paste a YouTube video or playlist link...';
    input.autocomplete = 'off';

    if (searchBtn) {
      searchBtn.classList.toggle('active', isSearch);
      searchBtn.setAttribute('aria-selected', isSearch ? 'true' : 'false');
      searchBtn.disabled = youtubeSearchQuotaExhausted;
    }

    if (linkBtn) {
      linkBtn.classList.toggle('active', !isSearch);
      linkBtn.setAttribute('aria-selected', !isSearch ? 'true' : 'false');
    }
  }

  function setSongInputMode(nextMode, { announce = false } = {}) {
    if (!['search', 'link'].includes(nextMode)) return;
    if (nextMode === 'search' && youtubeSearchQuotaExhausted) {
      setSearchStatus('YouTube search is paused for now. Paste a YouTube link instead.');
      if (announce) {
        Notifications.info('Search quota is exhausted for now. Paste a link instead.', 2800);
      }
      return;
    }

    const input = getSongInputEl();
    if (!input) {
      songInputMode = nextMode;
      return;
    }

    const previousValue = input.value;
    if (songInputMode === 'search') {
      searchInputDraft = previousValue;
    } else {
      linkInputDraft = previousValue;
    }

    songInputMode = nextMode;
    updateSongInputModeUI();

    input.value = nextMode === 'search' ? searchInputDraft : linkInputDraft;
    const resultsEl = document.getElementById('song-search-results');
    if (nextMode === 'link') {
      if (searchDebounce) clearTimeout(searchDebounce);
      if (searchAbortController) searchAbortController.abort();
      if (resultsEl) {
        resultsEl.classList.add('hidden');
      }
      setSearchStatus(
        youtubeSearchQuotaExhausted
          ? 'YouTube search is paused for now. Paste a YouTube link instead.'
          : 'Paste a YouTube video or playlist link, then add it to the room.'
      );
    } else {
      if (resultsEl && resultsEl.children.length > 0 && (searchInputDraft || searchQuery).trim().length >= MIN_SEARCH_CHARS) {
        resultsEl.classList.remove('hidden');
      }
      setSearchStatus(
        selectedSearchResult
          ? `Selected: ${selectedSearchResult.title}`
          : 'Start typing to search'
      );
    }

    updateSearchActionButtons();
    syncSmartSuggestions(currentQueueState);
  }

  function normalizeQueueState(queueState) {
    if (Array.isArray(queueState)) {
      return { current: null, upcoming: queueState, history: [] };
    }

    return {
      current: queueState?.current || null,
      upcoming: queueState?.upcoming || [],
      history: queueState?.history || [],
    };
  }

  function clearSmartSuggestions() {
    if (suggestionAbortController) {
      suggestionAbortController.abort();
      suggestionAbortController = null;
    }
  }

  async function syncSmartSuggestions(queueState) {
    currentQueueState = normalizeQueueState(queueState);
    updateMobileUpNextPreview();
    clearSmartSuggestions();
  }

  function updateSearchActionButtons() {
    const addBtn = document.getElementById('add-queue-btn');
    const playNextBtn = document.getElementById('play-next-btn');
    const target = songInputMode === 'link' ? getSongInputTarget() : null;
    if (addBtn) addBtn.disabled = !target;
    if (playNextBtn) playNextBtn.disabled = !target || !canManageQueue();
  }

  function refreshControllerAccess() {
    if (seekBarEl) seekBarEl.disabled = !isHost;

    const playPauseBtn = document.getElementById('play-pause-btn');
    if (playPauseBtn) playPauseBtn.disabled = !isHost;

    const prevBtn = document.getElementById('prev-btn');
    if (prevBtn) prevBtn.disabled = !isHost;

    const nextBtn = document.getElementById('next-btn');
    if (nextBtn) nextBtn.disabled = !isHost;

    const overlayEl = document.getElementById('player-overlay');
    if (overlayEl) {
      overlayEl.classList.toggle('viewer-locked', !isHost || !isLocalPlaybackEnabled());
    }

    const playlistPlayNowBtn = document.getElementById('playlist-import-play-now');
    if (playlistPlayNowBtn) {
      playlistPlayNowBtn.disabled = !isHost;
    }

    const spotifyReplaceBtn = document.getElementById('spotify-import-replace-btn');
    if (spotifyReplaceBtn) {
      spotifyReplaceBtn.disabled = !isHost || getSpotifyImportSelectedItems().length === 0;
    }

    updateSearchActionButtons();
    if (typeof QueueUI !== 'undefined' && typeof QueueUI.refreshPermissions === 'function') {
      QueueUI.refreshPermissions();
    }
    renderPlaybackSurface();
  }

  function deviceNeedsPlaybackUnlock() {
    return Boolean(
      window.matchMedia?.('(pointer: coarse)').matches ||
      navigator.maxTouchPoints > 0 ||
      /iPhone|iPad|iPod|Android|Mobile/i.test(navigator.userAgent)
    );
  }

  function shouldOfferPlaybackUnlock() {
    return isLocalPlaybackEnabled() && deviceNeedsPlaybackUnlock() && !hasPlaybackUnlock;
  }

  function markPlaybackUnlocked() {
    hasPlaybackUnlock = true;
    playbackUnlockDismissedVideoId = '';
    clearPlaybackUnlockCheck();
    hidePlaybackUnlockPrompt();
  }

  function clearBlockedTrackRecovery() {
    if (blockedTrackRecoveryTimer) {
      clearTimeout(blockedTrackRecoveryTimer);
      blockedTrackRecoveryTimer = null;
    }
    blockedTrackRecoveryVideoId = null;
  }

  function scheduleBlockedTrackRecovery(videoId) {
    if (!isHost || !videoId) return;

    clearBlockedTrackRecovery();
    blockedTrackRecoveryVideoId = videoId;
    blockedTrackRecoveryTimer = setTimeout(() => {
      blockedTrackRecoveryTimer = null;

      if (!isHost) return;
      if (roomCurrentVideoId !== videoId) {
        blockedTrackRecoveryVideoId = null;
        return;
      }

      const queueCurrentVideoId = currentQueueState?.current?.videoId || null;
      if (queueCurrentVideoId && queueCurrentVideoId !== videoId) {
        blockedTrackRecoveryVideoId = null;
        return;
      }

      send({ type: 'SKIP_TRACK' });
      blockedTrackRecoveryVideoId = null;
    }, 1600);
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

  function buildNowPlayingSubtitle(item) {
    if (!item) return '';

    if (item.playlistName) {
      const position =
        item.playlistTrackNumber && item.playlistLength
          ? ` · ${item.playlistTrackNumber} of ${item.playlistLength}`
          : '';
      return `From ${item.playlistName}${position}`;
    }

    return item.artist || '';
  }

  function updateNowPlayingDisplay(item) {
    const titleEl = document.getElementById('now-playing-title');
    const subtitleEl = document.getElementById('now-playing-subtitle');
    if (titleEl) titleEl.textContent = item?.title || 'Nothing playing';
    if (subtitleEl) subtitleEl.textContent = buildNowPlayingSubtitle(item);
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
    if (locallyBlockedVideoIds.has(roomCurrentVideoId)) return;
    if (!isHost && playbackUnlockDismissedVideoId === roomCurrentVideoId) return;

    const unlockBtn = document.getElementById('player-unlock-btn');
    const listenModal = document.getElementById('device-listen-modal');
    const overlayEl = document.getElementById('player-overlay');
    if (!isHost && listenModal) {
      listenModal.classList.remove('hidden');
    } else if (unlockBtn) {
      unlockBtn.textContent = isHost ? 'Start playback on this device' : 'Join on this device';
      unlockBtn.classList.remove('hidden');
    }
    if (overlayEl) {
      overlayEl.classList.add('local-unlock-available');
    }
  }

  function hidePlaybackUnlockPrompt() {
    const unlockBtn = document.getElementById('player-unlock-btn');
    const listenModal = document.getElementById('device-listen-modal');
    const overlayEl = document.getElementById('player-overlay');
    if (unlockBtn) unlockBtn.classList.add('hidden');
    if (listenModal) listenModal.classList.add('hidden');
    if (overlayEl) overlayEl.classList.remove('local-unlock-available');
  }

  function dismissPlaybackUnlockPrompt() {
    playbackUnlockDismissedVideoId = roomCurrentVideoId || '';
    hidePlaybackUnlockPrompt();
    clearPlaybackUnlockCheck();
  }

  function schedulePlaybackUnlockCheck(delayMs = 1800) {
    clearPlaybackUnlockCheck();
    if (!shouldOfferPlaybackUnlock() || roomPlaybackState !== 'playing' || !roomCurrentVideoId) {
      hidePlaybackUnlockPrompt();
      return;
    }
    if (locallyBlockedVideoIds.has(roomCurrentVideoId)) {
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
    if (!isLocalPlaybackEnabled()) return;

    if (state === 'playing') {
      if (shouldOfferPlaybackUnlock() && roomCurrentVideoId) {
        markPlaybackUnlocked();
      }
      clearPlaybackUnlockCheck();
      hidePlaybackUnlockPrompt();
      return;
    }

    if (shouldOfferPlaybackUnlock() && roomPlaybackState === 'playing' && roomCurrentVideoId) {
      schedulePlaybackUnlockCheck(isHost ? 1200 : 900);
    }
  }

  function attemptPlaybackUnlock() {
    if (!isLocalPlaybackEnabled()) return;
    if (!shouldOfferPlaybackUnlock()) return;
    if (roomPlaybackState !== 'playing' || !roomCurrentVideoId) return;
    if (locallyBlockedVideoIds.has(roomCurrentVideoId)) return;

    const targetTime = getExpectedRoomTime();
    if (Player.getCurrentVideoId() !== roomCurrentVideoId) {
      Player.loadVideo(roomCurrentVideoId, targetTime);
    } else {
      Player.seekTo(targetTime);
      Player.playVideo();
    }

    Notifications.success(isHost ? 'Playback started on this device' : 'Joined the room playback', 2200);
    playbackUnlockDismissedVideoId = '';
    hidePlaybackUnlockPrompt();
    schedulePlaybackUnlockCheck(2200);
  }

  function handleLocalPlayerError({ code, videoId } = {}) {
    const currentVideoId = videoId || Player.getCurrentVideoId() || roomCurrentVideoId;
    if (currentVideoId) {
      locallyBlockedVideoIds.add(currentVideoId);
    }

    clearPlaybackUnlockCheck();
    hidePlaybackUnlockPrompt();
    SyncClient.updatePlayButton('paused');

    const isHardBlock = code === 101 || code === 150 || code === 5;
    if (!isHardBlock || !currentVideoId || currentVideoId !== roomCurrentVideoId) {
      return;
    }

    send({
      type: 'PLAYER_ERROR',
      videoId: currentVideoId,
      code,
    });

    if (isHost) {
      scheduleBlockedTrackRecovery(currentVideoId);
    }

    const errorKey = `${currentVideoId}:${code}:${isHost ? 'host' : 'guest'}`;
    if (lastHandledPlayerErrorKey === errorKey) return;
    lastHandledPlayerErrorKey = errorKey;

    if (isHost) {
      if (currentQueueState.upcoming?.length) {
        Notifications.info('That track is blocked here. Skipping to the next one.', 2600);
      } else {
        Notifications.warning('That track is blocked here and there is nothing else queued.');
      }
      return;
    }

    Notifications.warning('This track is blocked on this device. The room may continue on other devices.');
  }

  function updateRoomPlaybackContext(type, msg = {}) {
    switch (type) {
      case 'PLAY':
        if (msg.videoId && msg.videoId !== roomCurrentVideoId) {
          lastHandledPlayerErrorKey = '';
          playbackUnlockDismissedVideoId = '';
        }
        if (msg.videoId && blockedTrackRecoveryVideoId && msg.videoId !== blockedTrackRecoveryVideoId) {
          clearBlockedTrackRecovery();
        }
        roomPlaybackState = 'playing';
        roomCurrentVideoId = msg.videoId || roomCurrentVideoId;
        updateRoomTrackContext({
          videoId: msg.videoId || roomCurrentVideoId,
          title: msg.title,
          artist: msg.artist,
          thumbnail: msg.thumbnail,
          duration: msg.duration,
        });
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
        updateRoomTrackContext(null);
        roomReferenceTime = 0;
        roomDurationSeconds = 0;
        roomReferenceStartedAt = null;
        lastHandledPlayerErrorKey = '';
        clearBlockedTrackRecovery();
        clearPlaybackUnlockCheck();
        playbackUnlockDismissedVideoId = '';
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
    closeOpenSearchMenu({ animate: false });
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
      if (input && songInputMode === 'search') input.value = '';
      if (results) {
        results.innerHTML = '';
        results.classList.add('hidden');
      }
      searchQuery = '';
      searchNextPageToken = null;
      searchHasMore = false;
      setSearchStatus('Start typing to search');
    }

    syncSmartSuggestions(currentQueueState);
  }

  function createSearchResultMenuHtml(options) {
    const items = options
      .map((option) => `
        <button class="queue-row-menu-item" type="button" data-action="${escapeHtml(option.action)}">
          ${escapeHtml(option.label)}
        </button>
      `)
      .join('');

    return `
      <div class="queue-row-menu">
        <button class="queue-row-menu-trigger" type="button" aria-haspopup="menu" aria-expanded="false" title="More options">
          <span></span><span></span><span></span>
        </button>
        <div class="queue-row-menu-popover" role="menu">
          ${items}
        </div>
      </div>
    `;
  }

  function scheduleOpenSearchMenuClose() {
    if (!openSearchMenuEl) return;
    if (openSearchMenuCloseTimer || openSearchMenuFadeTimer) return;

    openSearchMenuCloseTimer = setTimeout(() => {
      openSearchMenuCloseTimer = null;
      closeOpenSearchMenu({ animate: true });
    }, SEARCH_MENU_CLOSE_DELAY_MS);
  }

  function cancelOpenSearchMenuClose() {
    if (openSearchMenuCloseTimer) {
      clearTimeout(openSearchMenuCloseTimer);
      openSearchMenuCloseTimer = null;
    }

    if (openSearchMenuFadeTimer) {
      clearTimeout(openSearchMenuFadeTimer);
      openSearchMenuFadeTimer = null;
    }

    if (openSearchMenuEl) {
      openSearchMenuEl.classList.remove('closing');
      openSearchMenuEl.classList.add('open');
    }
  }

  function finalizeOpenSearchMenuClose(menuEl, card, trigger) {
    menuEl.classList.remove('open');
    menuEl.classList.remove('closing');
    menuEl.classList.remove('open-upward');
    if (card) card.classList.remove('menu-open');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (menuEl === openSearchMenuEl) {
      openSearchMenuEl = null;
    }
  }

  function closeOpenSearchMenu({ animate = false } = {}) {
    if (!openSearchMenuEl) return;
    cancelOpenSearchMenuClose();
    const trigger = openSearchMenuEl.querySelector('.queue-row-menu-trigger');
    const card = openSearchMenuEl.closest('.song-search-result');

    if (animate) {
      openSearchMenuEl.classList.add('closing');
      openSearchMenuEl.classList.remove('open');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');

      const menuToClose = openSearchMenuEl;
      openSearchMenuFadeTimer = setTimeout(() => {
        if (menuToClose === openSearchMenuEl) {
          finalizeOpenSearchMenuClose(menuToClose, card, trigger);
        } else {
          menuToClose.classList.remove('closing');
          menuToClose.classList.remove('open-upward');
        }
        openSearchMenuFadeTimer = null;
      }, SEARCH_MENU_FADE_MS);
      return;
    }

    finalizeOpenSearchMenuClose(openSearchMenuEl, card, trigger);
  }

  function positionSearchResultMenu(menuWrap) {
    const popover = menuWrap.querySelector('.queue-row-menu-popover');
    if (!popover) return;

    menuWrap.classList.remove('open-upward');

    const popoverRect = popover.getBoundingClientRect();
    const containerRect = document.getElementById('song-search-results')?.getBoundingClientRect();
    const lowerBoundary = containerRect ? Math.min(containerRect.bottom, window.innerHeight) : window.innerHeight;
    const upperBoundary = containerRect ? Math.max(containerRect.top, 0) : 0;
    const spaceBelow = lowerBoundary - popoverRect.top;
    const spaceAbove = popoverRect.bottom - upperBoundary;

    if (spaceBelow < popoverRect.height + 12 && spaceAbove > spaceBelow) {
      menuWrap.classList.add('open-upward');
    }
  }

  function sendSearchResultAction(type, item) {
    if (!item?.videoId) return;

    send({
      type: type === 'PLAY_NEXT' ? 'PLAY_NEXT' : 'ADD_TO_QUEUE',
      videoUrl: item.videoId,
    });

    Notifications.success(
      type === 'PLAY_NEXT' ? 'Song moved to play next' : 'Song added to queue',
      2200
    );
    setSearchStatus(
      type === 'PLAY_NEXT'
        ? 'Moved to Play Next. Keep browsing for more.'
        : 'Added to queue. Keep browsing for more.'
    );
  }

  function playSearchResultNow(item) {
    if (!isHost || !item?.videoId) return;
    send({ type: 'PLAY_VIDEO_NOW', videoUrl: item.videoId });
    Notifications.success('Playing now', 1800);
    setSearchStatus(`Now playing: ${item.title}`);
  }

  function bindSearchResultMenu(card, item) {
    const menuWrap = card.querySelector('.queue-row-menu');
    const trigger = card.querySelector('.queue-row-menu-trigger');
    if (!menuWrap || !trigger) return;

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openSearchMenuEl && openSearchMenuEl !== menuWrap) {
        closeOpenSearchMenu({ animate: false });
      }

      cancelOpenSearchMenuClose();
      const isOpen = menuWrap.classList.toggle('open');
      card.classList.toggle('menu-open', isOpen);
      if (isOpen) {
        menuWrap.classList.remove('closing');
        positionSearchResultMenu(menuWrap);
      } else {
        menuWrap.classList.remove('open-upward');
      }
      trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      openSearchMenuEl = isOpen ? menuWrap : null;
    });

    menuWrap.querySelectorAll('.queue-row-menu-item').forEach((button) => {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = button.dataset.action;
        closeOpenSearchMenu({ animate: false });
        if (action === 'play-next') {
          sendSearchResultAction('PLAY_NEXT', item);
          return;
        }
        if (action === 'queue') {
          sendSearchResultAction('ADD_TO_QUEUE', item);
        }
      });
    });

    card.addEventListener('pointerenter', () => {
      if (openSearchMenuEl === menuWrap) {
        cancelOpenSearchMenuClose();
      }
    });

    card.addEventListener('pointerleave', () => {
      if (openSearchMenuEl === menuWrap) {
        scheduleOpenSearchMenuClose();
      }
    });
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
      const card = document.createElement('div');
      card.className = 'song-search-result';
      const allowDirectPlay = isHost;
      const allowQueueActions = canManageQueue();
      const directPlayClass = allowDirectPlay ? ' song-search-direct-play' : '';
      card.innerHTML = `
        <img class="song-search-thumb${directPlayClass}" src="${item.thumbnail}" alt="" loading="lazy">
        <div class="song-search-copy">
          <div class="song-search-title${directPlayClass}" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
          <div class="song-search-meta">${escapeHtml(item.channelTitle || 'YouTube')}</div>
        </div>
        ${allowQueueActions ? `
          <div class="song-search-actions">
            ${createSearchResultMenuHtml([
              { action: 'queue', label: 'Add to queue' },
              { action: 'play-next', label: 'Play next' },
            ])}
          </div>
        ` : ''}
      `;

      if (allowDirectPlay) {
        card.querySelectorAll('.song-search-direct-play').forEach((el) => {
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            playSearchResultNow(item);
          });
        });
      }

      if (allowQueueActions) {
        bindSearchResultMenu(card, item);
      }

      resultsEl.appendChild(card);
    });
  }

  async function runSongSearch(query, { append = false } = {}) {
    if (songInputMode !== 'search') return;
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
      syncSmartSuggestions(currentQueueState);
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
      syncSmartSuggestions(currentQueueState);
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
    const cacheKey = `${SEARCH_CACHE_VERSION}::${trimmedQuery.toLowerCase()}::${append ? searchNextPageToken || '' : ''}`;
    if (searchCache.has(cacheKey)) {
      const cached = searchCache.get(cacheKey);
      renderSearchResults(cached.items || [], append);
      searchNextPageToken = cached.nextPageToken || null;
      searchHasMore = Boolean(cached.nextPageToken);
      setSearchStatus(
        cached.items?.length
          ? 'Use the menu to queue results, or tap artwork/title if you have control.'
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
      const data = await readApiResponse(response, 'Search needs a quick server refresh right now.');

      if (!response.ok) {
        const error = new Error(data?.error || 'Search unavailable right now');
        error.code = data?.code || '';
        throw error;
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
          ? 'Use the menu to queue results, or tap artwork/title if you have control.'
          : 'No results found'
      );
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (error.code === 'youtube_quota_exceeded') {
        youtubeSearchQuotaExhausted = true;
        setSongInputMode('link');
        setSearchStatus('YouTube search is paused for now. Paste a YouTube link instead.');
        Notifications.info('Search quota is exhausted for now. Switched to Paste Link.', 3200);
        return;
      }
      setSearchStatus(error.message || 'Search unavailable right now');
    } finally {
      setSearchLoading(false);
      syncSmartSuggestions(currentQueueState);
    }
  }

  function queueSelectedSearchResult(type) {
    const target = getSongInputTarget();
    if (!target) {
      Notifications.info(
        songInputMode === 'link'
          ? 'Paste a valid YouTube link first'
          : 'Select a result first'
      );
      return;
    }
    if (type === 'PLAY_NEXT' && !canManageQueue()) {
      Notifications.info('Join the room first to use Play Next');
      return;
    }

    if (target.kind === 'playlist') {
      previewPlaylistImport(target.playlistId);
      return;
    }

    send({ type, videoUrl: target.videoId });
    Notifications.success(
      type === 'PLAY_NEXT' ? 'Song added to play next' : 'Song added to queue',
      2200
    );
    setSearchStatus(
      songInputMode === 'link'
        ? (type === 'PLAY_NEXT'
          ? 'Link added to Play Next. Paste another YouTube link anytime.'
          : 'Link added to queue. Paste another YouTube link anytime.')
        : (type === 'PLAY_NEXT'
          ? 'Added to Play Next. Search results are still here for your next pick.'
          : 'Added to queue. Search results are still here for your next pick.')
    );
  }

  function formatDurationMs(durationMs) {
    return formatTime((Number(durationMs) || 0) / 1000);
  }

  function createSpotifyReviewId(item, absoluteIndex) {
    return item.spotify?.externalUrl || item.spotify?.title
      ? `${absoluteIndex}:${item.spotify?.title || 'track'}:${item.spotify?.artist || 'artist'}`
      : `spotify-review-${absoluteIndex}`;
  }

  function normalizeSpotifyReviewItems(items, offset = 0) {
    return (items || []).map((item, index) => ({
      reviewId: createSpotifyReviewId(item, offset + index),
      removed: false,
      ...item,
    }));
  }

  function getSpotifyImportSelectedItems() {
    return (pendingSpotifyImport?.items || []).filter((item) => !item.removed && item.youtube?.videoId);
  }

  function getSpotifyNeedsReviewCount() {
    return (pendingSpotifyImport?.items || []).filter((item) => {
      if (item.removed) return false;
      if (!item.youtube?.videoId) return true;
      return Number(item.confidence || 0) < SPOTIFY_REVIEW_CONFIDENCE_THRESHOLD || item.status === 'low-confidence';
    }).length;
  }

  function renderSpotifyImportSheet() {
    const modal = document.getElementById('spotify-import-modal');
    const cover = document.getElementById('spotify-import-cover');
    const title = document.getElementById('spotify-import-title');
    const meta = document.getElementById('spotify-import-meta');
    const count = document.getElementById('spotify-import-count');
    const list = document.getElementById('spotify-review-list');
    const loadMoreBtn = document.getElementById('spotify-import-load-more');
    const addBtn = document.getElementById('spotify-import-add-btn');
    const replaceBtn = document.getElementById('spotify-import-replace-btn');

    if (!modal || !pendingSpotifyImport) return;

    if (cover) {
      cover.src = pendingSpotifyImport.thumbnail || '';
      cover.alt = pendingSpotifyImport.title || 'Spotify playlist artwork';
    }
    if (title) title.textContent = pendingSpotifyImport.title || 'Spotify Playlist';
    if (meta) meta.textContent = pendingSpotifyImport.channelTitle || 'Spotify';
    if (count) {
      const selectedCount = getSpotifyImportSelectedItems().length;
      const needsReview = getSpotifyNeedsReviewCount();
      count.textContent = `${selectedCount} ready • ${needsReview} need review • ${Math.min(pendingSpotifyImport.items.length, pendingSpotifyImport.total || pendingSpotifyImport.items.length)} of ${pendingSpotifyImport.total || pendingSpotifyImport.items.length} loaded`;
    }

    if (list) {
      list.innerHTML = '';
      pendingSpotifyImport.items.forEach((item, index) => {
        const row = document.createElement('div');
        const lowConfidence = !item.youtube?.videoId || Number(item.confidence || 0) < SPOTIFY_REVIEW_CONFIDENCE_THRESHOLD || item.status === 'low-confidence';
        row.className = `spotify-review-item ${lowConfidence ? 'is-low-confidence' : ''} ${item.removed ? 'is-removed' : ''}`.trim();
        row.innerHTML = `
          <div class="spotify-review-source">
            <img class="spotify-review-source-cover" src="${escapeHtml(item.spotify?.thumbnail || pendingSpotifyImport.thumbnail || '')}" alt="" loading="lazy">
            <div class="spotify-review-source-copy">
              <div class="spotify-review-song-title">${escapeHtml(item.spotify?.title || 'Untitled')}</div>
              <div class="spotify-review-song-meta">${escapeHtml(item.spotify?.artist || 'Spotify')} · ${escapeHtml(formatDurationMs(item.spotify?.durationMs))}</div>
            </div>
          </div>
          <div class="spotify-review-match">
            ${
              item.youtube?.videoId
                ? `
                  <img class="spotify-review-match-thumb" src="${escapeHtml(item.youtube.thumbnail || '')}" alt="" loading="lazy">
                  <div class="spotify-review-match-copy">
                    <div class="spotify-review-match-title">${escapeHtml(item.youtube.title || 'Matched video')}</div>
                    <div class="spotify-review-match-meta">${escapeHtml(item.youtube.channelTitle || 'YouTube')} · ${escapeHtml(formatDurationMs(item.youtube.durationMs))}</div>
                  </div>
                `
                : `
                  <div class="spotify-review-match-empty">
                    <div class="spotify-review-match-title">No safe match selected yet</div>
                    <div class="spotify-review-match-meta">${escapeHtml(item.error || 'Pick a manual YouTube result for this track.')}</div>
                  </div>
                `
            }
          </div>
          <div class="spotify-review-side">
            <span class="spotify-review-confidence ${lowConfidence ? 'is-low' : 'is-high'}">${lowConfidence ? 'Low match confidence' : `${Math.round(item.confidence || 0)}% confident`}</span>
            <div class="spotify-review-actions">
              <button class="btn btn-ghost spotify-row-action" type="button" data-action="change" data-review-id="${escapeHtml(item.reviewId)}">${item.youtube?.videoId ? 'Change' : 'Find match'}</button>
              <button class="btn btn-ghost spotify-row-action" type="button" data-action="remove" data-review-id="${escapeHtml(item.reviewId)}">${item.removed ? 'Restore' : 'Remove'}</button>
            </div>
          </div>
        `;
        list.appendChild(row);
      });
    }

    if (loadMoreBtn) {
      loadMoreBtn.classList.toggle('hidden', !pendingSpotifyImport.hasMore);
      loadMoreBtn.disabled = spotifyLoadMorePending;
      loadMoreBtn.textContent = spotifyLoadMorePending ? 'Loading more tracks...' : 'Load more songs';
    }

    if (addBtn) addBtn.disabled = getSpotifyImportSelectedItems().length === 0;
    if (replaceBtn) {
      replaceBtn.disabled = !isHost || getSpotifyImportSelectedItems().length === 0;
    }

    modal.classList.remove('hidden');
  }

  function closeSpotifyImportSheet() {
    pendingSpotifyImport = null;
    spotifyLoadMorePending = false;
    const modal = document.getElementById('spotify-import-modal');
    if (modal) modal.classList.add('hidden');
  }

  async function previewSpotifyPlaylistImport(playlistId, { append = false } = {}) {
    if (!playlistId) return;

    if (spotifyReviewAbortController) {
      spotifyReviewAbortController.abort();
    }

    const offset = append && pendingSpotifyImport?.playlistId === playlistId
      ? (pendingSpotifyImport.nextOffset || 0)
      : 0;

    spotifyLoadMorePending = append;
    if (append) {
      renderSpotifyImportSheet();
    } else {
      setSpotifyImportStatus('Matching Spotify tracks to YouTube...');
    }

    spotifyReviewAbortController = new AbortController();

    try {
      const params = new URLSearchParams({ playlistId, offset: String(offset) });
      const response = await fetch(`/api/spotify/playlist-review?${params.toString()}`, {
        signal: spotifyReviewAbortController.signal,
      });
      const data = await readApiResponse(
        response,
        'Spotify review needs a quick server refresh. Restart Jammin and try that playlist again.'
      );

      if (!response.ok) {
        if (response.status === 401 && data?.code === 'spotify_auth_required') {
          setSpotifyImportStatus(data?.error || 'Connect Spotify to review playlists from your account.');
          beginSpotifyAuth({ autoReview: true, authUrl: data?.authUrl || '' });
          return;
        }
        throw new Error(data?.error || 'Unable to review that Spotify playlist right now');
      }

      const normalizedItems = normalizeSpotifyReviewItems(data.items, data.offset || 0);
      if (append && pendingSpotifyImport?.playlistId === playlistId) {
        pendingSpotifyImport.items.push(...normalizedItems);
        pendingSpotifyImport.hasMore = Boolean(data.hasMore);
        pendingSpotifyImport.nextOffset = data.nextOffset;
        pendingSpotifyImport.total = data.total || pendingSpotifyImport.total;
      } else {
        pendingSpotifyImport = {
          playlistId: data.playlistId,
          title: data.title,
          channelTitle: data.channelTitle,
          thumbnail: data.thumbnail,
          total: data.total || normalizedItems.length,
          nextOffset: data.nextOffset,
          hasMore: Boolean(data.hasMore),
          items: normalizedItems,
        };
      }

      const needsReview = getSpotifyNeedsReviewCount();
      setSpotifyImportStatus(
        needsReview
          ? `${needsReview} tracks need a quick review before import.`
          : 'Spotify playlist matched. Review and send it into the room.'
      );
      renderSpotifyImportSheet();
    } catch (error) {
      if (error.name === 'AbortError') return;
      Notifications.error(error.message || 'Unable to review that Spotify playlist right now');
      setSpotifyImportStatus(error.message || 'Unable to review that Spotify playlist right now.');
    } finally {
      spotifyLoadMorePending = false;
      spotifyReviewAbortController = null;
      if (pendingSpotifyImport) {
        renderSpotifyImportSheet();
      }
    }
  }

  function findSpotifyReviewItem(reviewId) {
    return pendingSpotifyImport?.items?.find((item) => item.reviewId === reviewId) || null;
  }

  function toggleSpotifyReviewItem(reviewId) {
    const item = findSpotifyReviewItem(reviewId);
    if (!item) return;
    item.removed = !item.removed;
    renderSpotifyImportSheet();
  }

  function renderSpotifyCorrectionResults(results = [], { loading = false, error = '' } = {}) {
    const list = document.getElementById('spotify-correction-results');
    const meta = document.getElementById('spotify-correction-meta');
    if (!list) return;

    list.innerHTML = '';
    if (meta) {
      meta.textContent = error
        ? error
        : loading
          ? 'Searching YouTube matches...'
          : results.length
            ? `${results.length} YouTube results`
            : 'Search YouTube to replace this match';
    }

    if (loading || error) return;

    results.forEach((result) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'spotify-correction-result';
      row.innerHTML = `
        <img class="spotify-correction-result-thumb" src="${escapeHtml(result.thumbnail || '')}" alt="" loading="lazy">
        <div class="spotify-correction-result-copy">
          <div class="spotify-correction-result-title">${escapeHtml(result.title || 'YouTube match')}</div>
          <div class="spotify-correction-result-meta">${escapeHtml(result.channelTitle || 'YouTube')} · ${escapeHtml(result.durationLabel || formatDurationMs(result.durationMs))}</div>
        </div>
      `;
      row.addEventListener('click', () => {
        const item = findSpotifyReviewItem(activeSpotifyCorrectionTrackId);
        if (!item) return;
        item.youtube = {
          videoId: result.videoId,
          title: result.title,
          durationMs: result.durationMs,
          thumbnail: result.thumbnail,
          channelTitle: result.channelTitle,
        };
        item.confidence = 96;
        item.status = 'matched';
        item.error = '';
        item.removed = false;
        closeSpotifyCorrectionSheet();
        renderSpotifyImportSheet();
        Notifications.success('Match updated', 1800);
      });
      list.appendChild(row);
    });
  }

  async function runSpotifyCorrectionSearch(query) {
    const trimmedQuery = String(query || '').trim();
    spotifyCorrectionQuery = trimmedQuery;
    if (!trimmedQuery) {
      renderSpotifyCorrectionResults();
      return;
    }

    if (spotifyCorrectionAbortController) {
      spotifyCorrectionAbortController.abort();
    }
    spotifyCorrectionAbortController = new AbortController();
    renderSpotifyCorrectionResults([], { loading: true });

    try {
      const params = new URLSearchParams({ q: trimmedQuery });
      const response = await fetch(`/api/youtube/match-search?${params.toString()}`, {
        signal: spotifyCorrectionAbortController.signal,
      });
      const data = await readApiResponse(
        response,
        'YouTube correction search needs a quick server refresh right now.'
      );
      if (!response.ok) {
        throw new Error(data?.error || 'Unable to search YouTube right now');
      }

      renderSpotifyCorrectionResults(data.items || []);
    } catch (error) {
      if (error.name === 'AbortError') return;
      renderSpotifyCorrectionResults([], {
        error: error.message || 'Unable to search YouTube right now',
      });
    } finally {
      spotifyCorrectionAbortController = null;
    }
  }

  function openSpotifyCorrectionSheet(reviewId) {
    const item = findSpotifyReviewItem(reviewId);
    const modal = document.getElementById('spotify-correction-modal');
    const input = document.getElementById('spotify-correction-search-input');
    const title = document.getElementById('spotify-correction-title');
    if (!item || !modal || !input) return;

    activeSpotifyCorrectionTrackId = reviewId;
    spotifyCorrectionQuery = `${item.spotify?.title || ''} ${item.spotify?.artist || ''}`.trim();
    if (title) {
      title.textContent = item.spotify?.title || 'Find a YouTube match';
    }
    input.value = spotifyCorrectionQuery;
    modal.classList.remove('hidden');
    runSpotifyCorrectionSearch(spotifyCorrectionQuery);
  }

  function closeSpotifyCorrectionSheet() {
    activeSpotifyCorrectionTrackId = null;
    spotifyCorrectionQuery = '';
    if (spotifyCorrectionAbortController) {
      spotifyCorrectionAbortController.abort();
      spotifyCorrectionAbortController = null;
    }
    const modal = document.getElementById('spotify-correction-modal');
    if (modal) modal.classList.add('hidden');
  }

  function buildSpotifyMappedPlaylistPayload() {
    if (!pendingSpotifyImport) return null;

    const items = getSpotifyImportSelectedItems().map((item) => ({
      videoId: item.youtube.videoId,
      title: item.youtube.title,
      artist: item.youtube.channelTitle || item.spotify.artist,
      thumbnail: item.youtube.thumbnail,
      duration: formatDurationMs(item.youtube.durationMs),
    }));

    if (!items.length) return null;

    return {
      playlistId: `spotify:${pendingSpotifyImport.playlistId}`,
      title: pendingSpotifyImport.title,
      channelTitle: pendingSpotifyImport.channelTitle,
      thumbnail: pendingSpotifyImport.thumbnail,
      source: 'spotify',
      items,
    };
  }

  function confirmSpotifyImport(mode) {
    const playlist = buildSpotifyMappedPlaylistPayload();
    if (!playlist) {
      Notifications.info('Pick at least one matched Spotify track first');
      return;
    }

    if (mode === 'replace' && !isHost) {
      Notifications.info('Only the controller can replace the queue');
      return;
    }

    send({
      type: mode === 'replace' ? 'REPLACE_QUEUE_WITH_MAPPED_PLAYLIST' : 'ADD_MAPPED_PLAYLIST_TO_QUEUE',
      playlist,
    });

    Notifications.success(
      mode === 'replace'
        ? `Queue replaced with ${playlist.title}`
        : `${playlist.title} added to the room`,
      2600
    );
    setSpotifyImportStatus(
      mode === 'replace'
        ? 'Spotify playlist replaced the upcoming queue.'
        : 'Spotify playlist added to the room.'
    );
    closeSpotifyCorrectionSheet();
    closeSpotifyImportSheet();
  }

  async function previewPlaylistImport(playlistId) {
    if (!playlistId) return;

    if (playlistPreviewAbortController) {
      playlistPreviewAbortController.abort();
    }
    playlistPreviewAbortController = new AbortController();

    try {
      const params = new URLSearchParams({ playlistId });
      const response = await fetch(`/api/youtube/playlist-preview?${params.toString()}`, {
        signal: playlistPreviewAbortController.signal,
      });
      const data = await readApiResponse(
        response,
        'Playlist import needs a server restart. Restart Jammin, refresh, and paste the playlist again.'
      );
      if (!response.ok) {
        throw new Error(data?.error || 'Unable to preview that playlist right now');
      }

      pendingPlaylistImport = data;
      openPlaylistImportSheet(data);
    } catch (error) {
      if (error.name === 'AbortError') return;
      Notifications.error(error.message || 'Unable to preview that playlist right now');
    } finally {
      playlistPreviewAbortController = null;
    }
  }

  function openPlaylistImportSheet(preview) {
    const modal = document.getElementById('playlist-import-modal');
    const cover = document.getElementById('playlist-import-cover');
    const title = document.getElementById('playlist-import-title');
    const meta = document.getElementById('playlist-import-meta');
    const count = document.getElementById('playlist-import-count');
    const list = document.getElementById('playlist-import-preview-list');
    const playNowBtn = document.getElementById('playlist-import-play-now');

    if (cover) {
      cover.src = preview.thumbnail || '';
      cover.alt = preview.title || 'Playlist artwork';
    }
    if (title) title.textContent = preview.title || 'Playlist';
    if (meta) meta.textContent = preview.channelTitle || 'YouTube';
    if (count) {
      count.textContent = preview.isTruncated
        ? `Importing the first ${preview.importCount} tracks`
        : `${preview.importCount} tracks ready for the room`;
    }
    if (list) {
      list.innerHTML = '';
      (preview.previewTracks || []).slice(0, 4).forEach((track, index) => {
        const row = document.createElement('div');
        row.className = 'playlist-import-track';
        row.innerHTML = `
          <span class="playlist-import-track-index">${index + 1}</span>
          <div class="playlist-import-track-copy">
            <div class="playlist-import-track-title">${escapeHtml(track.title)}</div>
            <div class="playlist-import-track-meta">${escapeHtml(track.artist || 'YouTube')}</div>
          </div>
        `;
        list.appendChild(row);
      });
    }
    if (playNowBtn) playNowBtn.disabled = !isHost;
    if (modal) modal.classList.remove('hidden');
  }

  function closePlaylistImportSheet() {
    pendingPlaylistImport = null;
    const modal = document.getElementById('playlist-import-modal');
    if (modal) modal.classList.add('hidden');
  }

  function confirmPlaylistImport(mode) {
    if (!pendingPlaylistImport?.playlistId) return;
    if (mode === 'play-next' && !isHost) {
      Notifications.info('Only the controller can play a playlist next');
      return;
    }

    send({
      type: mode === 'play-next' ? 'PLAYLIST_PLAY_NEXT' : 'ADD_PLAYLIST_TO_QUEUE',
      playlistId: pendingPlaylistImport.playlistId,
    });

    Notifications.success(
      mode === 'play-next'
        ? `Playlist queued next: ${pendingPlaylistImport.title}`
        : `Playlist added: ${pendingPlaylistImport.title}`,
      2400
    );

    setSearchStatus(
      mode === 'play-next'
        ? 'Playlist is lined up next. Paste another link or search for more.'
        : 'Playlist added to the room. Paste another link or search for more.'
    );
    closePlaylistImportSheet();
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

  function handleViewerPlaybackMessage(msg) {
    renderPlaybackSurface();

    if (msg.type === 'PLAY' || msg.type === 'RESUME' || msg.type === 'SYNC_TO') {
      SyncClient.updatePlayButton('playing');
      return;
    }

    if (msg.type === 'PAUSE') {
      SyncClient.updatePlayButton('paused');
      return;
    }

    if (msg.type === 'QUEUE_EMPTY') {
      SyncClient.updatePlayButton('paused');
    }
  }

  function applyPlaybackMessage(msg) {
    updateRoomPlaybackContext(msg.type, msg);
    updateNowPlayingDisplay(currentQueueState.current || roomCurrentTrack);

    if (isLocalPlaybackEnabled()) {
      SyncClient.handleMessage(msg);
      if (shouldOfferPlaybackUnlock() && roomPlaybackState === 'playing') {
        schedulePlaybackUnlockCheck();
      } else {
        hidePlaybackUnlockPrompt();
      }
      return;
    }

    hidePlaybackUnlockPrompt();
    handleViewerPlaybackMessage(msg);
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
          send({
            type: 'JOIN_SESSION',
            code: sessionCode,
            username,
            playbackMode: playbackMode === 'viewer' ? 'viewer' : 'player',
            reconnectToken,
          });
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
        if (blockedTrackRecoveryVideoId) {
          const queueCurrentVideoId = msg.queue?.current?.videoId || null;
          if (queueCurrentVideoId !== blockedTrackRecoveryVideoId) {
            clearBlockedTrackRecovery();
          }
        }
        currentQueueState = normalizeQueueState(msg.queue);
        roomCurrentVideoId = currentQueueState.current?.videoId || roomCurrentVideoId;
        updateRoomTrackContext(currentQueueState.current || null);
        QueueUI.update(msg.queue);
        syncThemeFromQueue(msg.queue);
        syncSmartSuggestions(msg.queue);
        updateNowPlayingDisplay(msg.queue?.current || null);
        renderPlaybackSurface();
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
        currentQueueState = { current: null, upcoming: [], history: [] };
        updateMobileUpNextPreview();
        clearSmartSuggestions();
        Notifications.info('Queue is empty. Add more tracks to keep going.');
        showStandardPlaceholder();
        SyncClient.updatePlayButton('paused');
        {
          updateNowPlayingDisplay(null);
        }
        renderPlaybackSurface();
        break;
      case 'ERROR':
        if (String(msg.message || '') === 'Session not found') {
          clearActiveSessionState();
          sessionCode = null;
          reconnectToken = '';
        }
        Notifications.error(msg.message);
        break;
      case 'CHAT_MESSAGE':
        Chat.handleMessage(msg);
        break;

      case 'CUE_VIDEO':
        if (msg.videoId) roomCurrentVideoId = msg.videoId;
        if (isLocalPlaybackEnabled()) {
          SyncClient.handleMessage(msg);
        }
        break;
      case 'PLAY':
      case 'SEEK':
      case 'PAUSE':
      case 'RESUME':
      case 'SYNC_TO':
        applyPlaybackMessage(msg);
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
    reconnectToken = msg.reconnectToken || reconnectToken;
    setSessionPlaybackMode(msg.playbackMode || 'player');
    Chat.setSessionContext({ userId, username, sessionCode });
    if (msg.chat) Chat.setHistory(msg.chat);

    switchToSessionView(msg.code, msg.username);
    syncParticipantsState(msg.participants || []);
    saveActiveSessionState();
    Notifications.success('Session ready. Share the code.');
  }

  function handleSessionJoined(msg) {
    userId = msg.userId;
    sessionCode = msg.code;
    username = msg.username;
    reconnectToken = msg.reconnectToken || reconnectToken;
    setSessionPlaybackMode(msg.playbackMode || pendingJoinPlaybackMode || 'viewer');
    Chat.setSessionContext({ userId, username, sessionCode });
    if (msg.chat) Chat.setHistory(msg.chat);

    switchToSessionView(msg.code, msg.username);
    syncParticipantsState(msg.participants || []);
    saveActiveSessionState();
    Notifications.success(msg.resumed ? 'Back in the room' : 'Joined the room');
  }

  function handleSessionState(msg) {
    // Full state from server on join
    roomCurrentVideoId = msg.currentVideo?.videoId || msg.queue?.current?.videoId || roomCurrentVideoId;
    if (msg.queue) {
      currentQueueState = normalizeQueueState(msg.queue);
      QueueUI.update(msg.queue);
      updateRoomTrackContext(currentQueueState.current || msg.currentVideo || null);
    } else if (msg.currentVideo) {
      updateRoomTrackContext(msg.currentVideo);
    }
    if (msg.queue) syncThemeFromQueue(msg.queue);
    if (msg.queue) syncSmartSuggestions(msg.queue);
    updateNowPlayingDisplay(msg.queue?.current || msg.currentVideo || null);
    if (msg.participants) syncParticipantsState(msg.participants);
    if (msg.chat) Chat.setHistory(msg.chat);

    if (msg.currentVideo?.videoId && msg.currentVideo.videoId !== roomCurrentVideoId) {
      lastHandledPlayerErrorKey = '';
    }
    if (blockedTrackRecoveryVideoId && msg.currentVideo?.videoId !== blockedTrackRecoveryVideoId) {
      clearBlockedTrackRecovery();
    }
    roomCurrentVideoId = msg.currentVideo?.videoId || roomCurrentVideoId || null;
    roomPlaybackState = msg.playbackState || 'idle';
    roomReferenceTime = typeof msg.currentTime === 'number' ? msg.currentTime : 0;
    roomReferenceStartedAt = roomPlaybackState === 'playing' ? Date.now() : null;

    // If there's a current video, sync to it
    if (msg.currentVideo && msg.playbackState !== 'idle' && isLocalPlaybackEnabled()) {
      if (msg.playbackState === 'playing') {
        Player.loadVideo(msg.currentVideo.videoId, msg.currentTime || 0);
        SyncClient.updatePlayButton('playing');
      } else if (msg.playbackState === 'paused') {
        Player.cueVideo(msg.currentVideo.videoId, msg.currentTime || 0);
        SyncClient.updatePlayButton('paused');
      }
    } else if (!isLocalPlaybackEnabled()) {
      SyncClient.updatePlayButton(msg.playbackState === 'playing' ? 'playing' : 'paused');
    }

    if (shouldOfferPlaybackUnlock() && roomPlaybackState === 'playing' && roomCurrentVideoId) {
      schedulePlaybackUnlockCheck();
    } else {
      hidePlaybackUnlockPrompt();
    }

    renderPlaybackSurface();
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

  function openJoinModePrompt(code) {
    pendingJoinCode = String(code || '').trim().toUpperCase();
    const modal = document.getElementById('join-mode-modal');
    const options = document.querySelectorAll('.join-mode-option');
    if (!modal || !options.length) return;

    options.forEach((option) => {
      const isActive = option.dataset.mode === pendingJoinPlaybackMode;
      option.classList.toggle('active', isActive);
      option.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });

    modal.classList.remove('hidden');
  }

  function closeJoinModePrompt() {
    const modal = document.getElementById('join-mode-modal');
    if (modal) modal.classList.add('hidden');
    pendingJoinCode = '';
  }

  function confirmJoinModeSelection() {
    if (!pendingJoinCode) return;

    username = document.getElementById('username-input')?.value.trim() || 'Anonymous';
    const code = pendingJoinCode;
    closeJoinModePrompt();
    connect();
    waitForConnection(() => {
      send({ type: 'JOIN_SESSION', code, username, playbackMode: pendingJoinPlaybackMode });
    });
  }

  // ---- Landing Events ----

  function bindLandingEvents() {
    const createBtn = document.getElementById('create-session-btn');
    const joinBtn = document.getElementById('join-session-btn');
    const usernameInput = document.getElementById('username-input');
    const codeInput = document.getElementById('session-code-input');
    const joinModeModal = document.getElementById('join-mode-modal');
    const joinModeOptions = document.getElementById('join-mode-options');
    const joinModeCancelBtn = document.getElementById('join-mode-cancel');
    const joinModeConfirmBtn = document.getElementById('join-mode-confirm');

    createBtn.addEventListener('click', () => {
      username = usernameInput.value.trim() || 'Anonymous';
      connect();
      // Wait for connection then create
      waitForConnection(() => {
        send({ type: 'CREATE_SESSION', username });
      });
    });

    joinBtn.addEventListener('click', () => {
      const code = codeInput.value.trim().toUpperCase();
      if (!code) {
        Notifications.warning('Enter a session code');
        return;
      }
      openJoinModePrompt(code);
    });

    // Enter key on code input
    codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') joinBtn.click();
    });

    if (joinModeOptions) {
      joinModeOptions.addEventListener('click', (e) => {
        const option = e.target.closest('.join-mode-option');
        if (!option) return;
        pendingJoinPlaybackMode = option.dataset.mode === 'player' ? 'player' : 'viewer';
        joinModeOptions.querySelectorAll('.join-mode-option').forEach((button) => {
          const isActive = button === option;
          button.classList.toggle('active', isActive);
          button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
      });
    }

    joinModeCancelBtn?.addEventListener('click', closeJoinModePrompt);
    joinModeConfirmBtn?.addEventListener('click', confirmJoinModeSelection);

    joinModeModal?.addEventListener('click', (e) => {
      if (e.target === joinModeModal) {
        closeJoinModePrompt();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeJoinModePrompt();
      }
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
        if (isLocalPlaybackEnabled()) {
          Player.seekTo(val);
        } else {
          updateRoomPlaybackContext('SEEK', { seekTime: val });
          renderPlaybackSurface();
        }
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
    const modeToggle = document.getElementById('song-input-mode-toggle');
    const transferModal = document.getElementById('control-transfer-modal');
    const transferCancelBtn = document.getElementById('control-transfer-cancel');
    const transferConfirmBtn = document.getElementById('control-transfer-confirm');
    const playlistImportModal = document.getElementById('playlist-import-modal');
    const playlistImportCancelBtn = document.getElementById('playlist-import-cancel');
    const playlistImportQueueBtn = document.getElementById('playlist-import-add-queue');
    const playlistImportPlayNowBtn = document.getElementById('playlist-import-play-now');
    const spotifyPlaylistInput = document.getElementById('spotify-playlist-input');
    const spotifyAuthBtn = document.getElementById('spotify-auth-btn');
    const spotifyReviewBtn = document.getElementById('spotify-review-btn');
    const spotifyImportModal = document.getElementById('spotify-import-modal');
    const spotifyImportCloseBtn = document.getElementById('spotify-import-close');
    const spotifyImportAddBtn = document.getElementById('spotify-import-add-btn');
    const spotifyImportReplaceBtn = document.getElementById('spotify-import-replace-btn');
    const spotifyImportLoadMoreBtn = document.getElementById('spotify-import-load-more');
    const spotifyReviewList = document.getElementById('spotify-review-list');
    const spotifyCorrectionModal = document.getElementById('spotify-correction-modal');
    const spotifyCorrectionCloseBtn = document.getElementById('spotify-correction-close');
    const spotifyCorrectionSearchBtn = document.getElementById('spotify-correction-search-btn');
    const spotifyCorrectionSearchInput = document.getElementById('spotify-correction-search-input');
    const unlockBtn = document.getElementById('player-unlock-btn');
    const deviceListenModal = document.getElementById('device-listen-modal');
    const deviceListenStartBtn = document.getElementById('device-listen-start-btn');
    const deviceListenLaterBtn = document.getElementById('device-listen-later-btn');
    const mobileSearchBtn = document.getElementById('mobile-search-btn');
    const mobileQueueBtn = document.getElementById('mobile-queue-btn');
    const mobileChatBtn = document.getElementById('mobile-chat-btn');
    const mobileSurfaceBackdrop = document.getElementById('mobile-surface-backdrop');
    const mobileUpNextCard = document.getElementById('mobile-upnext-card');

    refreshControllerAccess();
    updateSongInputModeUI();
    syncMobileSurfaceState();
    updateMobileUpNextPreview();
    if (SPOTIFY_IMPORT_ENABLED) {
      syncSpotifyImportStatusToState();
    }

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

    if (playlistImportCancelBtn) {
      playlistImportCancelBtn.addEventListener('click', closePlaylistImportSheet);
    }

    if (playlistImportQueueBtn) {
      playlistImportQueueBtn.addEventListener('click', () => {
        confirmPlaylistImport('queue');
      });
    }

    if (playlistImportPlayNowBtn) {
      playlistImportPlayNowBtn.addEventListener('click', () => {
        confirmPlaylistImport('play-next');
      });
    }

    if (playlistImportModal) {
      playlistImportModal.addEventListener('click', (e) => {
        if (e.target === playlistImportModal) {
          closePlaylistImportSheet();
        }
      });
    }

    if (SPOTIFY_IMPORT_ENABLED && spotifyReviewBtn) {
      spotifyReviewBtn.addEventListener('click', () => {
        const playlistId = parseSpotifyPlaylistInput(spotifyPlaylistInput?.value || '');
        if (!playlistId) {
          Notifications.info('Paste a valid Spotify playlist link first');
          syncSpotifyImportStatusToState();
          return;
        }
        if (!spotifyAuthState.connected) {
          beginSpotifyAuth({ autoReview: true });
          return;
        }
        previewSpotifyPlaylistImport(playlistId);
      });
    }

    if (SPOTIFY_IMPORT_ENABLED && spotifyAuthBtn) {
      spotifyAuthBtn.addEventListener('click', () => {
        beginSpotifyAuth({ autoReview: false });
      });
    }

    if (SPOTIFY_IMPORT_ENABLED && spotifyPlaylistInput) {
      spotifyPlaylistInput.addEventListener('input', () => {
        spotifyPlaylistDraft = spotifyPlaylistInput.value;
        saveSpotifyDraftState({ shouldAutoReview: getSpotifyReviewAfterAuthFlag() });
        const playlistId = parseSpotifyPlaylistInput(spotifyPlaylistInput.value);
        if (playlistId && spotifyAuthState.connected) {
          setSpotifyImportStatus('Spotify playlist detected. Review matches before adding it to Jammin.');
        } else {
          syncSpotifyImportStatusToState();
        }
      });

      spotifyPlaylistInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          spotifyReviewBtn?.click();
        }
      });
    }

    if (SPOTIFY_IMPORT_ENABLED && spotifyImportCloseBtn) {
      spotifyImportCloseBtn.addEventListener('click', closeSpotifyImportSheet);
    }

    if (SPOTIFY_IMPORT_ENABLED && spotifyImportAddBtn) {
      spotifyImportAddBtn.addEventListener('click', () => confirmSpotifyImport('queue'));
    }

    if (SPOTIFY_IMPORT_ENABLED && spotifyImportReplaceBtn) {
      spotifyImportReplaceBtn.addEventListener('click', () => confirmSpotifyImport('replace'));
    }

    if (SPOTIFY_IMPORT_ENABLED && spotifyImportLoadMoreBtn) {
      spotifyImportLoadMoreBtn.addEventListener('click', () => {
        if (pendingSpotifyImport?.hasMore) {
          previewSpotifyPlaylistImport(pendingSpotifyImport.playlistId, { append: true });
        }
      });
    }

    if (SPOTIFY_IMPORT_ENABLED && spotifyReviewList) {
      spotifyReviewList.addEventListener('click', (e) => {
        const button = e.target.closest('.spotify-row-action');
        if (!button) return;
        const reviewId = button.dataset.reviewId;
        const action = button.dataset.action;
        if (!reviewId || !action) return;

        if (action === 'change') {
          openSpotifyCorrectionSheet(reviewId);
          return;
        }

        if (action === 'remove') {
          toggleSpotifyReviewItem(reviewId);
        }
      });
    }

    if (SPOTIFY_IMPORT_ENABLED && spotifyImportModal) {
      spotifyImportModal.addEventListener('click', (e) => {
        if (e.target === spotifyImportModal) {
          closeSpotifyImportSheet();
        }
      });
    }

    if (SPOTIFY_IMPORT_ENABLED && spotifyCorrectionCloseBtn) {
      spotifyCorrectionCloseBtn.addEventListener('click', closeSpotifyCorrectionSheet);
    }

    if (SPOTIFY_IMPORT_ENABLED && spotifyCorrectionSearchBtn) {
      spotifyCorrectionSearchBtn.addEventListener('click', () => {
        runSpotifyCorrectionSearch(spotifyCorrectionSearchInput?.value || '');
      });
    }

    if (SPOTIFY_IMPORT_ENABLED && spotifyCorrectionSearchInput) {
      spotifyCorrectionSearchInput.addEventListener('input', () => {
        spotifyCorrectionQuery = spotifyCorrectionSearchInput.value;
      });

      spotifyCorrectionSearchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          runSpotifyCorrectionSearch(spotifyCorrectionSearchInput.value);
        }
      });
    }

    if (SPOTIFY_IMPORT_ENABLED && spotifyCorrectionModal) {
      spotifyCorrectionModal.addEventListener('click', (e) => {
        if (e.target === spotifyCorrectionModal) {
          closeSpotifyCorrectionSheet();
        }
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeOpenSearchMenu({ animate: false });
        dismissPlaybackUnlockPrompt();
        closeMobileSurface();
        closeTransferControls();
        closePlaylistImportSheet();
        closeSpotifyImportSheet();
        closeSpotifyCorrectionSheet();
      }
    });

    document.addEventListener('click', (e) => {
      if (!openSearchMenuEl) return;
      if (openSearchMenuEl.contains(e.target)) return;
      closeOpenSearchMenu({ animate: false });
    });

    window.addEventListener('resize', () => {
      closeOpenSearchMenu({ animate: false });
      if (!isMobileViewport()) {
        activeMobileSurface = '';
        syncMobileSurfaceState();
      }
      updateMobileUpNextPreview();
    });

    document.addEventListener('jammin:chat-state', (event) => {
      if (!isMobileViewport()) return;
      activeMobileSurface = event.detail?.open ? 'chat' : '';
      syncMobileSurfaceState();
    });

    if (searchInput) {
      searchInput.addEventListener('input', () => {
        if (songInputMode === 'search') {
          searchInputDraft = searchInput.value;
          const query = searchInput.value;
          syncSmartSuggestions(currentQueueState);
          if (searchDebounce) clearTimeout(searchDebounce);
          searchDebounce = setTimeout(() => {
            runSongSearch(query);
          }, SEARCH_DEBOUNCE_MS);
          return;
        }

        linkInputDraft = searchInput.value;
        if (searchDebounce) clearTimeout(searchDebounce);
        updateSearchActionButtons();
        const target = getSongInputTarget();
        setSearchStatus(
          target?.kind === 'playlist'
            ? 'Playlist detected. Review it before adding it to the room.'
            : target?.kind === 'video'
              ? 'Valid YouTube link. Queue it or play it next.'
              : 'Paste a full YouTube link, playlist link, or 11-character video ID.'
        );
      });

      searchInput.addEventListener('keydown', (e) => {
        if (songInputMode === 'link') {
          if (e.key === 'Enter' && getSongInputTarget()) {
            addBtn.click();
          }
          return;
        }

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

    if (modeToggle) {
      modeToggle.addEventListener('click', (e) => {
        const button = e.target.closest('.song-input-mode-btn');
        if (!button) return;
        const nextMode = button.dataset.mode;
        if (!nextMode) return;
        setSongInputMode(nextMode, { announce: true });
      });
    }

    if (searchResults) {
      searchResults.addEventListener('scroll', () => {
        if (openSearchMenuEl) {
          closeOpenSearchMenu({ animate: false });
        }
        if (!searchHasMore || searchIsLoading) return;
        const nearBottom =
          searchResults.scrollTop + searchResults.clientHeight >= searchResults.scrollHeight - 36;

        if (nearBottom) {
          runSongSearch(searchQuery, { append: true });
        }
      });
    }

    if (mobileSearchBtn) {
      mobileSearchBtn.addEventListener('click', () => {
        setMobileSurface('search');
      });
    }

    if (mobileQueueBtn) {
      mobileQueueBtn.addEventListener('click', () => {
        setMobileSurface('queue');
      });
    }

    if (mobileChatBtn) {
      mobileChatBtn.addEventListener('click', () => {
        if (!isMobileViewport()) return;
        if (window.Chat?.isOpen?.()) {
          window.Chat.close();
          return;
        }
        setMobileSurface('chat');
      });
    }

    if (mobileSurfaceBackdrop) {
      mobileSurfaceBackdrop.addEventListener('click', () => {
        closeMobileSurface();
      });
    }

    if (mobileUpNextCard) {
      mobileUpNextCard.addEventListener('click', () => {
        setMobileSurface('queue');
      });
    }

    // Play/pause button (host only)
    const playPauseBtn = document.getElementById('play-pause-btn');
    playPauseBtn.addEventListener('click', () => {
      const playingState = window.YT?.PlayerState?.PLAYING ?? 1;
      if (!isHost) {
        if (shouldOfferPlaybackUnlock() && roomPlaybackState === 'playing' && roomCurrentVideoId && Player.getState() !== playingState) {
          showPlaybackUnlockPrompt();
          return;
        }
        Notifications.info('Only the controller can control playback');
        return;
      }

      if (!isLocalPlaybackEnabled()) {
        if (roomPlaybackState === 'playing') {
          const currentTime = getExpectedRoomTime();
          updateRoomPlaybackContext('PAUSE', { currentTime });
          SyncClient.updatePlayButton('paused');
          renderPlaybackSurface();
          send({ type: 'PAUSE' });
        } else {
          const currentTime = getExpectedRoomTime();
          updateRoomPlaybackContext('RESUME', { currentTime, delay: 0 });
          SyncClient.updatePlayButton('playing');
          renderPlaybackSurface();
          send({ type: 'RESUME', currentTime });
        }
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

    if (deviceListenStartBtn) {
      deviceListenStartBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        attemptPlaybackUnlock();
      });
    }

    if (deviceListenLaterBtn) {
      deviceListenLaterBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        dismissPlaybackUnlockPrompt();
      });
    }

    if (deviceListenModal) {
      deviceListenModal.addEventListener('click', (e) => {
        if (e.target === deviceListenModal) {
          dismissPlaybackUnlockPrompt();
        }
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
    canManageQueue,
    openTransferControls,
    attemptPlaybackUnlock,
  };
})();

window.App = App;
