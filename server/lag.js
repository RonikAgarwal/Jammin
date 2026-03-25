// Lag Detection System

const { getCurrentReferenceTime, sendTo } = require('./session');

const SYNC_CHECK_INTERVAL_MS = 2500; // Check every 2.5 seconds
const LAG_IGNORE_THRESHOLD = 1.0; // < 1s: ignore
const LAG_SUBTLE_THRESHOLD = 3.0; // 1-3s: subtle message
const LAG_GOLIVE_THRESHOLD = 3.0; // > 3s: show Go Live
const LAG_UNSTABLE_THRESHOLD = 5.0; // > 5s: unstable territory
const LAG_DISPLAY_CHANGE_MIN = 2.0; // Only update display if change > 2s
const UNSTABLE_WINDOW_MS = 30000; // 30 second window for instability detection
const UNSTABLE_COUNT_THRESHOLD = 3; // 3+ high-lag reports in window = unstable

function handleTimeReport(session, userId, reportedTime) {
  const participant = session.participants.get(userId);
  if (!participant) return;
  if (session.playbackState !== 'playing') return;

  const referenceTime = getCurrentReferenceTime(session);
  const lag = referenceTime - reportedTime;

  // Detect host seeking
  if (session.host === userId && Math.abs(lag) > 3.0) {
    session.referenceTime = reportedTime;
    session.referenceStartedAt = Date.now();
    const { broadcast } = require('./session');
    broadcast(session, { type: 'SEEK', seekTime: reportedTime }, userId);
    return;
  }

  participant.lastReportedTime = reportedTime;

  // Track lag history for instability detection
  const now = Date.now();
  participant.lagHistory.push({ time: now, lag });
  // Keep only recent history
  participant.lagHistory = participant.lagHistory.filter(
    entry => now - entry.time < UNSTABLE_WINDOW_MS
  );

  // Determine lag level
  const absLag = Math.abs(lag);
  const lagInfo = computeLagInfo(absLag, participant);

  if (lagInfo) {
    // Update participant status
    participant.status = lagInfo.status;

    // Only send update if meaningful change
    if (shouldSendUpdate(participant, lagInfo)) {
      participant._lastSentLag = lagInfo.displayLag;
      participant._lastSentLevel = lagInfo.level;

      sendTo(session, userId, {
        type: 'LAG_INFO',
        lag: lagInfo.displayLag,
        message: lagInfo.message,
        showGoLive: lagInfo.showGoLive,
        level: lagInfo.level,
      });
    }
  }
}

function computeLagInfo(absLag, participant) {
  // Check for instability pattern
  const highLagCount = participant.lagHistory.filter(
    entry => Math.abs(entry.lag) > LAG_UNSTABLE_THRESHOLD
  ).length;
  const isUnstable = highLagCount >= UNSTABLE_COUNT_THRESHOLD;

  if (isUnstable) {
    // Check if persistent (every recent report is high)
    const recentReports = participant.lagHistory.slice(-5);
    const allHigh = recentReports.every(
      entry => Math.abs(entry.lag) > LAG_UNSTABLE_THRESHOLD
    );

    if (allHigh && recentReports.length >= 5) {
      return {
        level: 'reconnect',
        status: 'unstable',
        displayLag: Math.round(absLag),
        message: 'Reconnect to live session',
        showGoLive: false,
        showReconnect: true,
      };
    }

    return {
      level: 'unstable',
      status: 'unstable',
      displayLag: Math.round(absLag),
      message: 'Connection unstable',
      showGoLive: true,
      showReconnect: false,
    };
  }

  if (absLag < LAG_IGNORE_THRESHOLD) {
    return {
      level: 'ok',
      status: 'in-sync',
      displayLag: 0,
      message: null,
      showGoLive: false,
      showReconnect: false,
    };
  }

  if (absLag < LAG_SUBTLE_THRESHOLD) {
    const displayLag = Math.round(absLag);
    return {
      level: 'subtle',
      status: 'behind',
      displayLag,
      message: `Slightly behind (~${displayLag}s)`,
      showGoLive: false,
      showReconnect: false,
    };
  }

  // > 3s
  const displayLag = Math.round(absLag);
  return {
    level: 'behind',
    status: 'behind',
    displayLag,
    message: `You're behind (~${displayLag}s)`,
    showGoLive: true,
    showReconnect: false,
  };
}

function shouldSendUpdate(participant, lagInfo) {
  // Always send if level changed
  if (participant._lastSentLevel !== lagInfo.level) return true;

  // If OK level, only send once to clear previous message
  if (lagInfo.level === 'ok') {
    return participant._lastSentLevel !== 'ok';
  }

  // Only send if lag display changed by more than threshold
  const lastLag = participant._lastSentLag || 0;
  return Math.abs(lagInfo.displayLag - lastLag) >= LAG_DISPLAY_CHANGE_MIN;
}

module.exports = {
  handleTimeReport,
};
