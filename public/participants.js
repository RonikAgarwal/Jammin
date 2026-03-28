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
  let triggerBtnEl = null;
  let triggerCountEl = null;
  let triggerSubtitleEl = null;
  let sheetEl = null;
  let backdropEl = null;
  let closeBtnEl = null;
  let currentParticipants = [];
  let currentOptions = {
    currentUserId: null,
    canPassControls: false,
  };
  let isOpen = false;

  function init() {
    listEl = document.getElementById('participants-list');
    controllerEl = document.getElementById('controller-text');
    triggerBtnEl = document.getElementById('room-people-btn');
    triggerCountEl = document.getElementById('room-people-count');
    triggerSubtitleEl = document.getElementById('room-people-subtitle');
    sheetEl = document.getElementById('participants-sheet');
    backdropEl = document.getElementById('participants-backdrop');
    closeBtnEl = document.getElementById('participants-sheet-close');

    if (sheetEl) sheetEl.classList.remove('hidden');
    if (backdropEl) backdropEl.classList.remove('hidden');

    if (triggerBtnEl) {
      triggerBtnEl.addEventListener('click', togglePanel);
    }

    if (closeBtnEl) {
      closeBtnEl.addEventListener('click', closePanel);
    }

    if (backdropEl) {
      backdropEl.addEventListener('click', closePanel);
    }

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isOpen) {
        closePanel();
      }
    });
  }

  function update(participants, options = {}) {
    if (!listEl) init();
    currentParticipants = Array.isArray(participants) ? participants : [];
    currentOptions = {
      currentUserId: options.currentUserId || null,
      canPassControls: Boolean(options.canPassControls),
    };

    updateTriggerSummary();
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

      const statusText = getStatusText(p.status, p.playbackMode);

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

    // Update playback controller text
    const controller = currentParticipants.find((participant) => participant.isHost);
    if (controller && controllerEl) {
      controllerEl.textContent = controller.userId === currentOptions.currentUserId
        ? 'You currently have playback controls'
        : `${controller.username} currently has playback controls`;
    } else if (controllerEl) {
      controllerEl.textContent = 'Playback controls are currently unassigned';
    }
  }

  function updateTriggerSummary() {
    const count = currentParticipants.length;
    const controller = currentParticipants.find((participant) => participant.isHost);

    if (triggerCountEl) {
      triggerCountEl.textContent = String(count || 0);
    }

    if (!triggerSubtitleEl) return;

    if (controller) {
      triggerSubtitleEl.textContent = controller.userId === currentOptions.currentUserId
        ? `You + ${Math.max(count - 1, 0)} others`
        : `${controller.username} has control`;
      return;
    }

    triggerSubtitleEl.textContent = count ? `${count} in the room` : 'Room presence';
  }

  function togglePanel() {
    if (isOpen) {
      closePanel();
    } else {
      openPanel();
    }
  }

  function openPanel() {
    if (!sheetEl || !triggerBtnEl) return;

    if (window.Chat && typeof window.Chat.close === 'function') {
      window.Chat.close();
    }

    isOpen = true;
    sheetEl.classList.add('open');
    backdropEl?.classList.add('visible');
    triggerBtnEl.setAttribute('aria-expanded', 'true');
  }

  function closePanel() {
    if (!sheetEl || !triggerBtnEl) return;
    isOpen = false;
    sheetEl.classList.remove('open');
    backdropEl?.classList.remove('visible');
    triggerBtnEl.setAttribute('aria-expanded', 'false');
  }

  function getStatusText(status, playbackMode = 'player') {
    const modeLabel = playbackMode === 'viewer' ? 'Host speaker' : 'On this device';
    switch (status) {
      case 'in-sync': return modeLabel;
      case 'behind': return `${modeLabel} · Slightly behind`;
      case 'away': return `${modeLabel} · Temporarily away`;
      case 'unstable': return `${modeLabel} · Connection unstable`;
      default: return modeLabel;
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  return { init, update, openPanel, closePanel, isOpen: () => isOpen };
})();

window.Participants = Participants;
