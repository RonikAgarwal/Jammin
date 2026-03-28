// Queue UI Manager

const QueueUI = (() => {
  let listEl = null;
  let emptyEl = null;
  let state = {
    current: null,
    upcoming: [],
    history: [],
  };
  let expandedPlaylistGroups = new Set();
  let dragState = null;
  let openMenuEl = null;
  let openMenuCloseTimer = null;
  let openMenuFadeTimer = null;
  let hasBoundGlobalMenuListeners = false;
  const MENU_CLOSE_DELAY_MS = 1500;
  const MENU_FADE_MS = 180;

  function init() {
    listEl = document.getElementById('queue-list');
    emptyEl = document.getElementById('queue-empty');
    bindGlobalMenuListeners();
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
    closeOpenMenu();
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
      let queuePosition = 0;
      groupUpcomingItems(state.upcoming).forEach((group) => {
        if (group.type === 'playlist') {
          listEl.appendChild(createPlaylistGroupCard(group, queuePosition));
          if (expandedPlaylistGroups.has(group.groupId)) {
            group.items.forEach((item, playlistIndex) => {
              listEl.appendChild(
                createUpcomingRow(item, queuePosition + playlistIndex, {
                  rowClass: 'queue-row-playlist-track',
                  metaOverride: formatPlaylistTrackMeta(item),
                  hideMenuLabel: true,
                })
              );
            });
          }
          queuePosition += group.items.length;
          return;
        }

        listEl.appendChild(createUpcomingRow(group.item, queuePosition));
        queuePosition += 1;
      });
    } else {
      listEl.appendChild(
        createHelperCard('No tracks waiting', 'Search for another song to keep the queue moving.')
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
    const canManageQueue = window.App && window.App.canManageQueue && window.App.canManageQueue();

    el.innerHTML = `
      <div class="queue-row-marker queue-row-marker-played">${historyIcon()}</div>
      <button class="queue-drag-handle" title="Drag to queue next" ${canManageQueue ? '' : 'disabled'}>${dragHandle()}</button>
      ${createThumbnailHtml(item, 'queue-row-thumb')}
      <div class="queue-row-content">
        <div class="queue-row-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <div class="queue-row-meta">${escapeHtml(formatMeta(item))}</div>
      </div>
      <span class="queue-status-muted">Played</span>
      ${canManageQueue ? createRowMenuHtml([
        { action: 'requeue', label: 'Queue next' },
      ]) : ''}
    `;

    bindDraggableRow(el, {
      kind: 'history',
      itemId: item.id,
      canManageQueue,
    });
    bindRowMenu(el, {
      requeue: () => {
        if (window.App) {
          App.send({ type: 'REQUEUE_HISTORY_ITEM', itemId: item.id, toIndex: 0 });
        }
      },
    });

    return el;
  }

  function createUpcomingRow(item, index, options = {}) {
    const el = document.createElement('div');
    el.className = `queue-row queue-row-upnext ${options.rowClass || ''}`.trim();
    el.dataset.dropType = 'upcoming';
    el.dataset.dropIndex = String(index);

    const isHost = window.App && window.App.getIsHost();
    const canManageQueue = window.App && window.App.canManageQueue && window.App.canManageQueue();
    const metaText = options.metaOverride || formatMeta(item);

    el.innerHTML = `
      <div class="queue-row-marker queue-row-marker-index">${index + 1}</div>
      <button class="queue-drag-handle" title="Drag to reorder" ${canManageQueue ? '' : 'disabled'}>${dragHandle()}</button>
      ${createThumbnailHtml(item, 'queue-row-thumb')}
      <div class="queue-row-content">
        <div class="queue-row-title" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</div>
        <div class="queue-row-meta">${escapeHtml(metaText)}</div>
      </div>
      ${canManageQueue ? `
        <div class="queue-row-actions">
          ${createRowMenuHtml([
            { action: 'play-next', label: options.hideMenuLabel ? 'Play this track next' : 'Play next' },
            { action: 'remove', label: 'Remove' },
          ])}
        </div>
      ` : ''}
    `;

    bindDraggableRow(el, {
      kind: 'upcoming',
      itemId: item.id,
      index,
      canManageQueue,
    });
    bindUpcomingRow(el, item, index, { isHost, canManageQueue });
    return el;
  }

  function createPlaylistGroupCard(group, startIndex) {
    const el = document.createElement('div');
    const firstItem = group.items[0];
    const isHost = window.App && window.App.getIsHost();
    const canManageQueue = window.App && window.App.canManageQueue && window.App.canManageQueue();
    const isExpanded = expandedPlaylistGroups.has(group.groupId);
    const badgeLabel = firstItem.playlistSource === 'spotify' ? 'Spotify' : 'Playlist';
    const previewTitles = group.items
      .slice(0, 3)
      .map((item) => item.title)
      .join(' • ');

    el.className = 'queue-row queue-row-upnext queue-playlist-card';
    el.dataset.dropType = 'upcoming';
    el.dataset.dropIndex = String(startIndex);
    el.innerHTML = `
      <div class="queue-row-marker queue-row-marker-index">${startIndex + 1}</div>
      <div class="queue-playlist-thumb-wrap">
        ${createThumbnailHtml({
          thumbnail: firstItem.playlistThumbnail || firstItem.thumbnail,
          videoId: firstItem.videoId,
        }, 'queue-row-thumb')}
        <span class="queue-playlist-badge ${firstItem.playlistSource === 'spotify' ? 'queue-playlist-badge-spotify' : ''}">${escapeHtml(badgeLabel)}</span>
      </div>
      <div class="queue-row-content">
        <div class="queue-row-title-wrap">
          <div class="queue-row-title" title="${escapeHtml(firstItem.playlistName || 'Playlist')}">${escapeHtml(firstItem.playlistName || 'Playlist')}</div>
          <span class="queue-status-muted queue-status-playlist-count">${group.items.length} tracks</span>
        </div>
        <div class="queue-row-meta">${escapeHtml(formatPlaylistMeta(firstItem, group.items.length))}</div>
        <div class="queue-playlist-preview" title="${escapeHtml(previewTitles)}">${escapeHtml(previewTitles)}</div>
      </div>
      <button class="queue-playlist-toggle" type="button" aria-expanded="${isExpanded ? 'true' : 'false'}" title="${isExpanded ? 'Hide playlist tracks' : 'Show playlist tracks'}">
        <span class="queue-playlist-toggle-label">${isExpanded ? 'Hide tracks' : 'Show tracks'}</span>
        <span class="queue-playlist-toggle-chevron">${isExpanded ? '−' : '+'}</span>
      </button>
      ${canManageQueue ? `
        <div class="queue-row-actions">
          ${createRowMenuHtml([
            { action: isExpanded ? 'collapse-group' : 'expand-group', label: isExpanded ? 'Hide tracks' : 'Show tracks' },
            ...(isHost ? [{ action: 'play-group-now', label: 'Play playlist now' }] : []),
            { action: 'remove-group', label: 'Remove playlist' },
          ])}
        </div>
      ` : ''}
    `;

    const toggleBtn = el.querySelector('.queue-playlist-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePlaylistGroup(group.groupId);
      });
    }

    if (canManageQueue) {
      bindRowMenu(el, {
        'expand-group': () => togglePlaylistGroup(group.groupId, true),
        'collapse-group': () => togglePlaylistGroup(group.groupId, false),
        ...(isHost ? {
          'play-group-now': () => {
            if (window.App) App.send({ type: 'PLAY_PLAYLIST_GROUP', playlistGroupId: group.groupId });
          },
        } : {}),
        'remove-group': () => {
          if (window.App) App.send({ type: 'REMOVE_PLAYLIST_GROUP', playlistGroupId: group.groupId });
        },
      });
    }

    return el;
  }

  function togglePlaylistGroup(groupId, forceValue = null) {
    if (!groupId) return;

    const shouldExpand = forceValue === null
      ? !expandedPlaylistGroups.has(groupId)
      : Boolean(forceValue);

    if (shouldExpand) {
      expandedPlaylistGroups.add(groupId);
    } else {
      expandedPlaylistGroups.delete(groupId);
    }

    render();
    updateTransportControls();
  }

  function createThumbnailHtml(item, className) {
    const thumbUrl = item.thumbnail || thumbnailFor(item.videoId);
    return `<img class="${className}" src="${thumbUrl}" alt="" loading="lazy">`;
  }

  function bindUpcomingRow(el, item, index, permissions = {}) {
    const isHost = Boolean(permissions.isHost);
    const canManageQueue = Boolean(permissions.canManageQueue);
    if (isHost) {
      const directPlayTargets = el.querySelectorAll('.queue-row-thumb, .queue-row-title');
      directPlayTargets.forEach((target) => {
        target.classList.add('queue-row-direct-play');
        target.addEventListener('click', (e) => {
          e.stopPropagation();
          if (window.App) {
            App.send({ type: 'PLAY_SELECTED', itemId: item.id });
          }
        });
      });
    } else {
      el.querySelectorAll('.queue-row-direct-play').forEach((target) => {
        target.classList.remove('queue-row-direct-play');
      });
    }

    if (!canManageQueue) return;
    bindRowMenu(el, {
      'play-next': () => {
        if (!window.App) return;
        if (typeof index !== 'number' || index <= 0) return;

        App.send({
          type: 'REORDER_QUEUE',
          fromIndex: index,
          toIndex: 0,
        });
      },
      remove: () => {
        if (window.App) App.send({ type: 'REMOVE_FROM_QUEUE', itemId: item.id });
      },
    });
  }

  function bindDraggableRow(el, config) {
    if (!config.canManageQueue) return;

    const handle = el.querySelector('.queue-drag-handle');
    if (!handle) return;
    handle.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();

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

  function bindGlobalMenuListeners() {
    if (hasBoundGlobalMenuListeners) return;
    hasBoundGlobalMenuListeners = true;

    if (listEl) {
      listEl.addEventListener('scroll', () => {
        closeOpenMenu({ animate: false });
      });
    }

    document.addEventListener('click', (e) => {
      if (!openMenuEl) return;
      if (openMenuEl.contains(e.target)) return;
      closeOpenMenu({ animate: false });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeOpenMenu({ animate: false });
      }
    });

    window.addEventListener('resize', () => closeOpenMenu({ animate: false }));
  }

  function bindRowMenu(el, actions) {
    const menuWrap = el.querySelector('.queue-row-menu');
    const trigger = el.querySelector('.queue-row-menu-trigger');
    if (!menuWrap || !trigger) return;

    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      if (openMenuEl && openMenuEl !== menuWrap) {
        closeOpenMenu({ animate: false });
      }

      cancelOpenMenuClose();
      const isOpen = menuWrap.classList.toggle('open');
      el.classList.toggle('menu-open', isOpen);
      if (isOpen) {
        menuWrap.classList.remove('closing');
        positionRowMenu(menuWrap);
      } else {
        menuWrap.classList.remove('open-upward');
      }
      trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      openMenuEl = isOpen ? menuWrap : null;
    });

    menuWrap.querySelectorAll('.queue-row-menu-item').forEach((button) => {
      button.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = button.dataset.action;
        closeOpenMenu({ animate: false });
        if (action && typeof actions[action] === 'function') {
          actions[action]();
        }
      });
    });

    el.addEventListener('pointerenter', () => {
      if (openMenuEl === menuWrap) {
        cancelOpenMenuClose();
      }
    });

    el.addEventListener('pointerleave', () => {
      if (openMenuEl === menuWrap) {
        scheduleOpenMenuClose();
      }
    });
  }

  function scheduleOpenMenuClose() {
    if (!openMenuEl) return;
    if (openMenuCloseTimer || openMenuFadeTimer) return;

    openMenuCloseTimer = setTimeout(() => {
      openMenuCloseTimer = null;
      closeOpenMenu({ animate: true });
    }, MENU_CLOSE_DELAY_MS);
  }

  function cancelOpenMenuClose() {
    if (openMenuCloseTimer) {
      clearTimeout(openMenuCloseTimer);
      openMenuCloseTimer = null;
    }

    if (openMenuFadeTimer) {
      clearTimeout(openMenuFadeTimer);
      openMenuFadeTimer = null;
    }

    if (openMenuEl) {
      openMenuEl.classList.remove('closing');
      openMenuEl.classList.add('open');
    }
  }

  function closeOpenMenu({ animate = false } = {}) {
    if (!openMenuEl) return;
    cancelOpenMenuClose();
    const trigger = openMenuEl.querySelector('.queue-row-menu-trigger');
    const row = openMenuEl.closest('.queue-row');

    if (animate) {
      openMenuEl.classList.add('closing');
      openMenuEl.classList.remove('open');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');

      const menuToClose = openMenuEl;
      openMenuFadeTimer = setTimeout(() => {
        if (menuToClose === openMenuEl) {
          finalizeOpenMenuClose(menuToClose, row, trigger);
        } else {
          menuToClose.classList.remove('closing');
          menuToClose.classList.remove('open-upward');
        }
        openMenuFadeTimer = null;
      }, MENU_FADE_MS);
      return;
    }

    finalizeOpenMenuClose(openMenuEl, row, trigger);
  }

  function finalizeOpenMenuClose(menuEl, row, trigger) {
    menuEl.classList.remove('open');
    menuEl.classList.remove('closing');
    menuEl.classList.remove('open-upward');
    if (row) row.classList.remove('menu-open');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (menuEl === openMenuEl) {
      openMenuEl = null;
    }
  }

  function positionRowMenu(menuWrap) {
    const popover = menuWrap.querySelector('.queue-row-menu-popover');
    if (!popover) return;

    menuWrap.classList.remove('open-upward');

    const popoverRect = popover.getBoundingClientRect();
    const containerRect = listEl?.getBoundingClientRect();
    const lowerBoundary = containerRect ? Math.min(containerRect.bottom, window.innerHeight) : window.innerHeight;
    const upperBoundary = containerRect ? Math.max(containerRect.top, 0) : 0;
    const spaceBelow = lowerBoundary - popoverRect.top;
    const spaceAbove = popoverRect.bottom - upperBoundary;

    if (spaceBelow < popoverRect.height + 12 && spaceAbove > spaceBelow) {
      menuWrap.classList.add('open-upward');
    }
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
    const isHost = Boolean(window.App && window.App.getIsHost());

    if (prevBtn) prevBtn.disabled = !isHost || state.history.length === 0;
    if (nextBtn) nextBtn.disabled = !isHost || (!state.current && state.upcoming.length === 0);
  }

  function refreshPermissions() {
    render();
    updateTransportControls();
  }

  function formatMeta(item) {
    const pieces = [];
    if (item.artist) pieces.push(item.artist);
    if (item.playlistName) {
      const position =
        item.playlistTrackNumber && item.playlistLength
          ? `${item.playlistTrackNumber}/${item.playlistLength}`
          : 'Playlist';
      pieces.push(`${item.playlistName} · ${position}`);
    }
    if (item.addedBy) pieces.push(`Added by ${item.addedBy}`);
    return pieces.join(' - ') || 'Queued track';
  }

  function formatPlaylistMeta(item, trackCount) {
    const pieces = [];
    if (item.playlistChannelTitle) pieces.push(item.playlistChannelTitle);
    else if (item.artist) pieces.push(item.artist);
    pieces.push(`${trackCount} tracks`);
    if (item.addedBy) pieces.push(`Added by ${item.addedBy}`);
    return pieces.join(' - ');
  }

  function formatPlaylistTrackMeta(item) {
    const pieces = [];
    if (item.playlistTrackNumber && item.playlistLength) {
      pieces.push(`Track ${item.playlistTrackNumber} of ${item.playlistLength}`);
    }
    if (item.artist) pieces.push(item.artist);
    if (item.addedBy) pieces.push(`Added by ${item.addedBy}`);
    return pieces.join(' - ');
  }

  function groupUpcomingItems(items) {
    const groups = [];

    items.forEach((item) => {
      if (!item.playlistGroupId) {
        groups.push({ type: 'track', item });
        return;
      }

      const previous = groups[groups.length - 1];
      if (previous?.type === 'playlist' && previous.groupId === item.playlistGroupId) {
        previous.items.push(item);
        return;
      }

      groups.push({
        type: 'playlist',
        groupId: item.playlistGroupId,
        items: [item],
      });
    });

    return groups;
  }

  function thumbnailFor(videoId) {
    return `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`;
  }

  function dragHandle() {
    return '<span class="queue-drag-lines"><span></span><span></span><span></span></span>';
  }

  function createRowMenuHtml(options) {
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

  function historyIcon() {
    return '&#10003;';
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  return { init, update, refreshPermissions };
})();
