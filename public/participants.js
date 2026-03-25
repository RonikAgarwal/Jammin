// Participants UI Manager

const Participants = (() => {
  const AVATAR_COLORS = [
    'linear-gradient(135deg, #a855f7, #ec4899)',
    'linear-gradient(135deg, #06b6d4, #3b82f6)',
    'linear-gradient(135deg, #f97316, #ef4444)',
    'linear-gradient(135deg, #10b981, #06b6d4)',
    'linear-gradient(135deg, #8b5cf6, #6366f1)',
    'linear-gradient(135deg, #f472b6, #a855f7)',
    'linear-gradient(135deg, #fbbf24, #f97316)',
    'linear-gradient(135deg, #34d399, #10b981)',
  ];

  let listEl = null;
  let controllerEl = null;
  let currentParticipants = [];

  function init() {
    listEl = document.getElementById('participants-list');
    controllerEl = document.getElementById('controller-text');
  }

  function update(participants, hostId) {
    if (!listEl) init();
    currentParticipants = participants;

    listEl.innerHTML = '';

    participants.forEach((p, index) => {
      const item = document.createElement('div');
      item.className = 'participant-item';

      const initial = (p.username || '?').charAt(0).toUpperCase();
      const colorIndex = index % AVATAR_COLORS.length;

      const statusText = getStatusText(p.status);
      const isHost = p.isHost || p.userId === hostId;

      item.innerHTML = `
        <div class="participant-avatar" style="background: ${AVATAR_COLORS[colorIndex]}">
          <span>${initial}</span>
          <div class="status-ring ${p.status || 'in-sync'}"></div>
        </div>
        <div class="participant-info">
          <div class="participant-name">${escapeHtml(p.username || 'Anonymous')}</div>
          <div class="participant-status">${statusText}</div>
        </div>
        ${isHost ? '<span class="participant-badge">Host</span>' : ''}
      `;

      listEl.appendChild(item);
    });

    // Update vibe controller text
    const host = participants.find(p => p.isHost || p.userId === hostId);
    if (host && controllerEl) {
      controllerEl.textContent = `${host.username} is controlling the vibe`;
    }
  }

  function getStatusText(status) {
    switch (status) {
      case 'in-sync': return 'In sync';
      case 'behind': return 'Slightly behind';
      case 'away': return 'Temporarily away';
      case 'unstable': return 'Connection unstable';
      default: return 'In sync';
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  return { init, update };
})();
