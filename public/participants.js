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
  let currentOptions = {
    currentUserId: null,
    canPassControls: false,
  };

  function init() {
    listEl = document.getElementById('participants-list');
    controllerEl = document.getElementById('controller-text');
  }

  function update(participants, options = {}) {
    if (!listEl) init();
    currentParticipants = Array.isArray(participants) ? participants : [];
    currentOptions = {
      currentUserId: options.currentUserId || null,
      canPassControls: Boolean(options.canPassControls),
    };

    listEl.innerHTML = '';

    const displayParticipants = currentParticipants
      .slice()
      .sort((a, b) => Number(Boolean(b.isHost)) - Number(Boolean(a.isHost)));

    displayParticipants.forEach((p, index) => {
      const item = document.createElement('div');
      const isController = Boolean(p.isHost);
      const isSelf = p.userId === currentOptions.currentUserId;
      item.className = `participant-item${isController ? ' participant-item-controller' : ''}`;

      const initial = (p.username || '?').charAt(0).toUpperCase();
      const colorIndex = index % AVATAR_COLORS.length;

      const statusText = getStatusText(p.status);

      item.innerHTML = `
        <div class="participant-avatar" style="background: ${AVATAR_COLORS[colorIndex]}">
          <span>${initial}</span>
          <div class="status-ring ${p.status || 'in-sync'}"></div>
        </div>
        <div class="participant-info">
          <div class="participant-name-row">
            <div class="participant-name">${escapeHtml(p.username || 'Anonymous')}</div>
            ${isSelf ? '<span class="participant-you">You</span>' : ''}
          </div>
          <div class="participant-status">${statusText}</div>
        </div>
        <div class="participant-actions">
          ${isController ? '<span class="participant-badge">Controller</span>' : ''}
          ${currentOptions.canPassControls && !isController ? '<button class="participant-pass-btn" type="button">Pass controls</button>' : ''}
        </div>
      `;

      const passBtn = item.querySelector('.participant-pass-btn');
      if (passBtn) {
        passBtn.addEventListener('click', () => {
          if (window.App && typeof window.App.openTransferControls === 'function') {
            window.App.openTransferControls(p.userId, p.username || 'Anonymous');
          }
        });
      }

      listEl.appendChild(item);
    });

    // Update vibe controller text
    const controller = currentParticipants.find((participant) => participant.isHost);
    if (controller && controllerEl) {
      controllerEl.textContent = controller.userId === currentOptions.currentUserId
        ? 'You are controlling the vibe right now'
        : `${controller.username} is controlling the vibe right now`;
    } else if (controllerEl) {
      controllerEl.textContent = 'No one is controlling the vibe';
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
    div.textContent = str || '';
    return div.innerHTML;
  }

  return { init, update };
})();
