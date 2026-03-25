// Queue UI Manager

const QueueUI = (() => {
  let listEl = null;
  let emptyEl = null;
  let queue = [];
  let draggedIndex = null;

  function init() {
    listEl = document.getElementById('queue-list');
    emptyEl = document.getElementById('queue-empty');
  }

  function update(newQueue) {
    if (!listEl) init();
    queue = newQueue || [];
    render();
  }

  function render() {
    if (!listEl) return;

    // Clear existing items (preserve empty state element)
    const items = listEl.querySelectorAll('.queue-item');
    items.forEach(item => item.remove());

    if (queue.length === 0) {
      if (emptyEl) emptyEl.classList.remove('hidden');
      return;
    }

    if (emptyEl) emptyEl.classList.add('hidden');

    queue.forEach((item, index) => {
      const el = createQueueItem(item, index);
      listEl.appendChild(el);
    });
  }

  function createQueueItem(item, index) {
    const el = document.createElement('div');
    el.className = 'queue-item';
    const isHost = window.App && window.App.getIsHost();
    el.draggable = isHost;

    const thumbUrl = item.thumbnail || `https://img.youtube.com/vi/${item.videoId}/mqdefault.jpg`;

    let actionsHtml = '';
    if (isHost) {
      actionsHtml = `
        <div class="queue-item-actions">
          <button class="queue-action-btn play-btn" title="Play now">▶</button>
          <button class="queue-action-btn remove-btn" title="Remove">✕</button>
        </div>
      `;
    }

    el.innerHTML = `
      <img class="queue-thumb" src="${thumbUrl}" alt="" loading="lazy">
      <div class="queue-item-info">
        <div class="queue-item-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <div class="queue-item-added">Added by ${escapeHtml(item.addedBy || 'Someone')}</div>
      </div>
      ${actionsHtml}
    `;

    // Play selected
    const playBtn = el.querySelector('.play-btn');
    if (playBtn) {
      playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.App) App.send({ type: 'PLAY_SELECTED', itemId: item.id });
      });
    }

    // Remove
    const removeBtn = el.querySelector('.remove-btn');
    if (removeBtn) {
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.App) App.send({ type: 'REMOVE_FROM_QUEUE', itemId: item.id });
      });
    }

    // Drag & drop for reorder (Host only)
    if (isHost) {
    el.addEventListener('dragstart', (e) => {
      draggedIndex = index;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    el.addEventListener('dragend', () => {
      el.classList.remove('dragging');
      draggedIndex = null;
    });

    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });

      el.addEventListener('drop', (e) => {
        e.preventDefault();
        const toIndex = index;
        if (draggedIndex !== null && draggedIndex !== toIndex) {
          if (window.App) {
            App.send({
              type: 'REORDER_QUEUE',
              fromIndex: draggedIndex,
              toIndex: toIndex,
            });
          }
        }
      });
    }

    return el;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  return { init, update };
})();
