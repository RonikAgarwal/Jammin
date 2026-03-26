// Queue UI Manager

const QueueUI = (() => {
  let listEl = null;
  let emptyEl = null;
  let state = {
    current: null,
    upcoming: [],
    history: [],
  };
  let dragState = null;

  function init() {
    listEl = document.getElementById('queue-list');
    emptyEl = document.getElementById('queue-empty');
  }

  function update(nextState) {
    if (!listEl) init();

    if (Array.isArray(nextState)) {
      state = { current: null, upcoming: nextState, history: [] };
    } else {
      state = {
        current: nextState?.current || null,
        upcoming: nextState?.upcoming || [],
        history: nextState?.history || [],
      };
    }

    render();
    updateTransportControls();
  }

  function render() {
    if (!listEl) return;

    listEl.innerHTML = '';

    const hasQueueContent = state.current || state.upcoming.length > 0 || state.history.length > 0;
    if (!hasQueueContent) {
      if (emptyEl) {
        emptyEl.classList.remove('hidden');
        listEl.appendChild(emptyEl);
      }
      return;
    }

    if (emptyEl) emptyEl.classList.add('hidden');

    if (state.history.length > 0 || state.current) {
      listEl.appendChild(createSectionTitle('Queue'));
    }

    state.history.slice().reverse().forEach((item) => {
      listEl.appendChild(createPlayedRow(item));
    });

    if (state.current) {
      listEl.appendChild(createCurrentRow(state.current));
    }

    listEl.appendChild(
      createSectionTitle('Up Next', state.upcoming.length ? `${state.upcoming.length}` : 'Queue end')
    );

    if (state.upcoming.length > 0) {
      state.upcoming.forEach((item, index) => {
        listEl.appendChild(createUpcomingRow(item, index));
      });
    } else {
      listEl.appendChild(
        createHelperCard('No tracks waiting', 'Add another YouTube link to keep the vibe moving.')
      );
    }
  }

  function createSectionTitle(title, meta = '') {
    const el = document.createElement('div');
    el.className = 'queue-section-title';
    el.innerHTML = `
      <span>${escapeHtml(title)}</span>
      ${meta ? `<span class="queue-section-meta">${escapeHtml(meta)}</span>` : ''}
    `;
    return el;
  }

  function createCurrentRow(item) {
    const el = document.createElement('div');
    el.className = 'queue-row queue-row-current';
    el.dataset.dropType = 'current';

    el.innerHTML = `
      <div class="queue-row-marker">
        <span class="queue-row-playing-bars"><span></span><span></span><span></span></span>
      </div>
      ${createThumbnailHtml(item, 'queue-row-thumb')}
      <div class="queue-row-content">
        <div class="queue-row-title-wrap">
          <div class="queue-row-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
          <span class="queue-status-pill">Playing</span>
        </div>
        <div class="queue-row-meta">${escapeHtml(formatMeta(item))}</div>
      </div>
    `;
    return el;
  }

  function createPlayedRow(item) {
    const el = document.createElement('div');
    el.className = 'queue-row queue-row-played';
    el.dataset.dropType = 'current';

    const isHost = window.App && window.App.getIsHost();

    el.innerHTML = `
      <div class="queue-row-marker queue-row-marker-played">${historyIcon()}</div>
      <button class="queue-drag-handle" title="Drag to queue next" ${isHost ? '' : 'disabled'}>${dragHandle()}</button>
      ${createThumbnailHtml(item, 'queue-row-thumb')}
      <div class="queue-row-content">
        <div class="queue-row-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <div class="queue-row-meta">${escapeHtml(formatMeta(item))}</div>
      </div>
      <span class="queue-status-muted">Played</span>
    `;

    bindDraggableRow(el, {
      kind: 'history',
      itemId: item.id,
      isHost,
    });

    return el;
  }

  function createUpcomingRow(item, index) {
    const el = document.createElement('div');
    el.className = 'queue-row queue-row-upnext';
    el.dataset.dropType = 'upcoming';
    el.dataset.dropIndex = String(index);

    const isHost = window.App && window.App.getIsHost();

    el.innerHTML = `
      <div class="queue-row-marker queue-row-marker-index">${index + 1}</div>
      <button class="queue-drag-handle" title="Drag to reorder" ${isHost ? '' : 'disabled'}>${dragHandle()}</button>
      ${createThumbnailHtml(item, 'queue-row-thumb')}
      <div class="queue-row-content">
        <div class="queue-row-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <div class="queue-row-meta">${escapeHtml(formatMeta(item))}</div>
      </div>
      ${isHost ? `
        <div class="queue-row-actions">
          <button class="queue-row-btn play-btn" title="Play now">▶</button>
          <button class="queue-row-btn remove-btn" title="Remove">✕</button>
        </div>
      ` : ''}
    `;

    bindDraggableRow(el, {
      kind: 'upcoming',
      itemId: item.id,
      index,
      isHost,
    });
    bindUpcomingRow(el, item, index, isHost);
    return el;
  }

  function createThumbnailHtml(item, className) {
    const thumbUrl = item.thumbnail || thumbnailFor(item.videoId);
    return `<img class="${className}" src="${thumbUrl}" alt="" loading="lazy">`;
  }

  function bindUpcomingRow(el, item, index, isHost) {
    const playBtn = el.querySelector('.play-btn');
    if (playBtn) {
      playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.App) App.send({ type: 'PLAY_SELECTED', itemId: item.id });
      });
    }

    const removeBtn = el.querySelector('.remove-btn');
    if (removeBtn) {
      removeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (window.App) App.send({ type: 'REMOVE_FROM_QUEUE', itemId: item.id });
      });
    }
  }

  function bindDraggableRow(el, config) {
    if (!config.isHost) return;

    const handle = el.querySelector('.queue-drag-handle');
    if (!handle) return;
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();

      dragState = {
        kind: config.kind,
        itemId: config.itemId,
        index: config.index,
        sourceEl: el,
        handleEl: handle,
        startX: e.clientX,
        startY: e.clientY,
        targetEl: null,
      };

      el.classList.add('dragging');
      handle.classList.add('active');
      document.body.classList.add('queue-dragging-active');
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp, { once: true });
      window.addEventListener('pointercancel', handlePointerCancel, { once: true });
    });
  }

  function handlePointerMove(e) {
    if (!dragState) return;

    const deltaY = e.clientY - dragState.startY;
    dragState.sourceEl.style.transform = `translateY(${deltaY * 0.35}px) scale(1.01)`;

    const row = document.elementFromPoint(e.clientX, e.clientY)?.closest('.queue-row');
    setDropTarget(row && row !== dragState.sourceEl ? row : null);
  }

  function handlePointerUp() {
    if (!dragState) return;

    if (dragState.targetEl) {
      applyDrop(dragState.targetEl);
    }

    finishDrag();
  }

  function handlePointerCancel() {
    finishDrag();
  }

  function applyDrop(targetEl) {
    if (!dragState || !window.App) return;

    const dropType = targetEl?.dataset.dropType;
    const dropIndex = targetEl?.dataset.dropIndex;
    const toIndex = dropType === 'current' ? 0 : Number(dropIndex);

    if (dragState.kind === 'upcoming') {
      if (typeof dragState.index !== 'number' || typeof toIndex !== 'number') return;
      if (dragState.index === toIndex) return;

      App.send({
        type: 'REORDER_QUEUE',
        fromIndex: dragState.index,
        toIndex,
      });
      return;
    }

    if (dragState.kind === 'history') {
      App.send({
        type: 'REQUEUE_HISTORY_ITEM',
        itemId: dragState.itemId,
        toIndex: typeof toIndex === 'number' ? toIndex : 0,
      });
    }
  }

  function clearDropTargets() {
    if (!listEl) return;
    listEl.querySelectorAll('.queue-drop-target').forEach((node) => {
      node.classList.remove('queue-drop-target');
    });
  }

  function setDropTarget(targetEl) {
    if (!dragState) return;
    if (dragState.targetEl === targetEl) return;

    clearDropTargets();
    dragState.targetEl = targetEl;
    if (targetEl) {
      targetEl.classList.add('queue-drop-target');
    }
  }

  function finishDrag() {
    if (!dragState) return;

    dragState.sourceEl.classList.remove('dragging');
    dragState.sourceEl.style.transform = '';
    dragState.handleEl.classList.remove('active');
    dragState = null;
    clearDropTargets();
    document.body.classList.remove('queue-dragging-active');
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointercancel', handlePointerCancel);
  }

  function createHelperCard(title, body) {
    const el = document.createElement('div');
    el.className = 'queue-helper-card';
    el.innerHTML = `
      <div class="queue-helper-title">${escapeHtml(title)}</div>
      <div class="queue-helper-body">${escapeHtml(body)}</div>
    `;
    return el;
  }

  function updateTransportControls() {
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');

    if (prevBtn) prevBtn.disabled = state.history.length === 0;
    if (nextBtn) nextBtn.disabled = !state.current && state.upcoming.length === 0;
  }

  function formatMeta(item) {
    const pieces = [];
    if (item.artist) pieces.push(item.artist);
    if (item.addedBy) pieces.push(`Added by ${item.addedBy}`);
    return pieces.join(' - ') || 'Queued track';
  }

  function thumbnailFor(videoId) {
    return `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
  }

  function dragHandle() {
    return '<span class="queue-drag-lines"><span></span><span></span><span></span></span>';
  }

  function historyIcon() {
    return '&#10003;';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  return { init, update };
})();
