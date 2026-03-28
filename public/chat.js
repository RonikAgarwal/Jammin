// Room Chat Drawer

const Chat = (() => {
  const AVATAR_BACKGROUNDS = [
    'linear-gradient(135deg, rgba(255, 110, 180, 0.9), rgba(168, 85, 247, 0.92))',
    'linear-gradient(135deg, rgba(0, 229, 255, 0.92), rgba(59, 130, 246, 0.92))',
    'linear-gradient(135deg, rgba(251, 191, 36, 0.92), rgba(249, 115, 22, 0.92))',
    'linear-gradient(135deg, rgba(52, 211, 153, 0.92), rgba(6, 182, 212, 0.92))',
    'linear-gradient(135deg, rgba(244, 114, 182, 0.92), rgba(236, 72, 153, 0.92))',
  ];

  let launcherEl = null;
  let launcherBadgeEl = null;
  let launcherSubtitleEl = null;
  let drawerEl = null;
  let closeBtnEl = null;
  let messageListEl = null;
  let emptyStateEl = null;
  let composeFormEl = null;
  let inputEl = null;
  let sendBtnEl = null;
  let hintEl = null;
  let characterCountEl = null;

  let currentUserId = null;
  let currentUsername = 'Anonymous';
  let currentSessionCode = '';
  let isOpen = false;
  let unreadCount = 0;
  let messages = [];
  let hasInit = false;

  const timeFormatter = new Intl.DateTimeFormat([], {
    hour: 'numeric',
    minute: '2-digit',
  });

  function init() {
    if (hasInit) return;

    launcherEl = document.getElementById('chat-launcher');
    launcherBadgeEl = document.getElementById('chat-launcher-badge');
    launcherSubtitleEl = document.getElementById('chat-launcher-subtitle');
    drawerEl = document.getElementById('chat-drawer');
    closeBtnEl = document.getElementById('chat-close-btn');
    messageListEl = document.getElementById('chat-message-list');
    emptyStateEl = document.getElementById('chat-empty-state');
    composeFormEl = document.getElementById('chat-compose-form');
    inputEl = document.getElementById('chat-input');
    sendBtnEl = document.getElementById('chat-send-btn');
    hintEl = document.getElementById('chat-compose-hint');
    characterCountEl = document.getElementById('chat-character-count');

    if (!launcherEl || !drawerEl || !messageListEl || !composeFormEl || !inputEl) {
      return;
    }

    drawerEl.classList.remove('hidden');

    launcherEl.addEventListener('click', toggleDrawer);
    if (closeBtnEl) closeBtnEl.addEventListener('click', closeDrawer);

    composeFormEl.addEventListener('submit', (event) => {
      event.preventDefault();
      sendMessage();
    });

    inputEl.addEventListener('input', updateCharacterCount);
    inputEl.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isOpen) {
        closeDrawer();
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isOpen) {
        closeDrawer();
      }
    });

    updateCharacterCount();
    updateUnreadBadge();
    updateLauncherSubtitle();
    render();
    hasInit = true;
  }

  function setSessionContext({ userId, username, sessionCode }) {
    if (!hasInit) init();
    if (!launcherEl) return;

    const sessionChanged = currentSessionCode && currentSessionCode !== sessionCode;
    currentUserId = userId || null;
    currentUsername = username || 'Anonymous';
    currentSessionCode = sessionCode || '';

    if (sessionChanged) {
      messages = [];
      unreadCount = 0;
      closeDrawer();
      render();
    }

    launcherEl.classList.remove('hidden');
    updateUnreadBadge();
    updateLauncherSubtitle();
    updateComposeHint();
  }

  function setHistory(nextMessages) {
    if (!hasInit) init();
    if (!Array.isArray(nextMessages)) return;

    const seen = new Set();
    messages = nextMessages
      .map(normalizeMessage)
      .filter((message) => {
        if (!message || !message.id || seen.has(message.id)) return false;
        seen.add(message.id);
        return true;
      })
      .sort((a, b) => a.sentAt - b.sentAt);

    render();
    if (isOpen) {
      queueScrollToBottom();
    }
  }

  function handleMessage(msg) {
    if (msg.type !== 'CHAT_MESSAGE') return;
    receiveMessage(msg.message);
  }

  function toggleDrawer() {
    if (isOpen) {
      closeDrawer();
    } else {
      openDrawer();
    }
  }

  function openDrawer() {
    if (!drawerEl || !launcherEl) return;

    if (window.Participants && typeof window.Participants.closePanel === 'function') {
      window.Participants.closePanel();
    }

    isOpen = true;
    drawerEl.classList.add('open');
    launcherEl.classList.add('open');
    launcherEl.setAttribute('aria-expanded', 'true');
    unreadCount = 0;
    updateUnreadBadge();
    updateLauncherSubtitle();
    queueScrollToBottom();
    document.dispatchEvent(new CustomEvent('jammin:chat-state', {
      detail: { open: true },
    }));

    window.setTimeout(() => {
      if (inputEl) inputEl.focus();
    }, 120);
  }

  function closeDrawer() {
    if (!drawerEl || !launcherEl) return;
    isOpen = false;
    drawerEl.classList.remove('open');
    launcherEl.classList.remove('open');
    launcherEl.setAttribute('aria-expanded', 'false');
    updateLauncherSubtitle();
    document.dispatchEvent(new CustomEvent('jammin:chat-state', {
      detail: { open: false },
    }));
  }

  function receiveMessage(rawMessage) {
    const message = normalizeMessage(rawMessage);
    if (!message || messages.some((entry) => entry.id === message.id)) {
      return;
    }

    messages.push(message);
    if (messages.length > 100) {
      messages.splice(0, messages.length - 100);
    }

    render();

    if (isOpen) {
      unreadCount = 0;
      updateUnreadBadge();
      queueScrollToBottom();
      return;
    }

    if (message.userId !== currentUserId) {
      unreadCount += 1;
      updateUnreadBadge();
      updateLauncherSubtitle(message);
      pulseLauncher();
    }
  }

  function sendMessage() {
    const text = String(inputEl?.value || '').trim();
    if (!text) return;

    if (!window.App || typeof window.App.send !== 'function') {
      Notifications.warning('Chat is not ready just yet');
      return;
    }

    window.App.send({
      type: 'SEND_CHAT_MESSAGE',
      text,
    });

    inputEl.value = '';
    updateCharacterCount();
    updateComposeHint();
    inputEl.focus();
  }

  function render() {
    if (!messageListEl) return;

    messageListEl.innerHTML = '';

    if (!messages.length) {
      if (emptyStateEl) {
        emptyStateEl.classList.remove('hidden');
        messageListEl.appendChild(emptyStateEl);
      }
      return;
    }

    if (emptyStateEl) emptyStateEl.classList.add('hidden');

    const fragment = document.createDocumentFragment();
    messages.forEach((message) => {
      fragment.appendChild(createMessageEl(message));
    });
    messageListEl.appendChild(fragment);
  }

  function createMessageEl(message) {
    const row = document.createElement('article');
    const isSelf = message.userId === currentUserId;
    row.className = `chat-message${isSelf ? ' self' : ''}`;

    const avatar = document.createElement('div');
    avatar.className = 'chat-avatar';
    avatar.style.background = getAvatarBackground(message.username);
    avatar.textContent = (message.username || '?').charAt(0).toUpperCase();

    const body = document.createElement('div');
    body.className = 'chat-bubble-wrap';

    const meta = document.createElement('div');
    meta.className = 'chat-message-meta';

    const author = document.createElement('span');
    author.className = 'chat-message-author';
    author.textContent = isSelf ? 'You' : message.username;

    const time = document.createElement('span');
    time.className = 'chat-message-time';
    time.textContent = timeFormatter.format(new Date(message.sentAt));

    meta.appendChild(author);
    meta.appendChild(time);

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';
    bubble.textContent = message.text;

    body.appendChild(meta);
    body.appendChild(bubble);

    if (isSelf) {
      row.appendChild(body);
      row.appendChild(avatar);
    } else {
      row.appendChild(avatar);
      row.appendChild(body);
    }

    return row;
  }

  function normalizeMessage(rawMessage) {
    if (!rawMessage || typeof rawMessage !== 'object') return null;
    const text = String(rawMessage.text || '').trim();
    if (!text) return null;

    return {
      id: String(rawMessage.id || ''),
      userId: String(rawMessage.userId || ''),
      username: String(rawMessage.username || 'Anonymous').slice(0, 20) || 'Anonymous',
      text,
      sentAt: Number(rawMessage.sentAt) || Date.now(),
    };
  }

  function getAvatarBackground(username) {
    const seed = String(username || 'Anonymous')
      .split('')
      .reduce((sum, char) => sum + char.charCodeAt(0), 0);
    return AVATAR_BACKGROUNDS[seed % AVATAR_BACKGROUNDS.length];
  }

  function updateUnreadBadge() {
    if (!launcherBadgeEl) return;

    if (unreadCount > 0) {
      launcherBadgeEl.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
      launcherBadgeEl.classList.remove('hidden');
      launcherEl?.classList.add('has-unread');
    } else {
      launcherBadgeEl.textContent = '0';
      launcherBadgeEl.classList.add('hidden');
      launcherEl?.classList.remove('has-unread');
    }
  }

  function updateLauncherSubtitle(latestMessage = null) {
    if (!launcherSubtitleEl) return;

    if (isOpen) {
      launcherSubtitleEl.textContent = 'Chat is open right now';
      return;
    }

    if (latestMessage && latestMessage.userId !== currentUserId) {
      launcherSubtitleEl.textContent = `${latestMessage.username}: ${truncate(latestMessage.text, 30)}`;
      return;
    }

    if (unreadCount > 0) {
      launcherSubtitleEl.textContent = `${unreadCount} new ${unreadCount === 1 ? 'message' : 'messages'}`;
      return;
    }

    if (currentSessionCode) {
      launcherSubtitleEl.textContent = `Session ${currentSessionCode}`;
      return;
    }

    launcherSubtitleEl.textContent = 'Say something to the room';
  }

  function updateCharacterCount() {
    if (!inputEl || !characterCountEl) return;
    const count = inputEl.value.length;
    characterCountEl.textContent = `${count} / 320`;
    characterCountEl.classList.toggle('near-limit', count >= 260);
  }

  function updateComposeHint() {
    if (!hintEl) return;
    hintEl.textContent = currentSessionCode
      ? `${currentUsername} in ${currentSessionCode}`
      : 'Everyone in the room can see this.';
  }

  function pulseLauncher() {
    if (!launcherEl) return;
    launcherEl.classList.remove('pulse');
    void launcherEl.offsetWidth;
    launcherEl.classList.add('pulse');
    window.setTimeout(() => {
      launcherEl.classList.remove('pulse');
    }, 900);
  }

  function queueScrollToBottom() {
    window.requestAnimationFrame(() => {
      if (!messageListEl) return;
      messageListEl.scrollTop = messageListEl.scrollHeight;
    });
  }

  function truncate(text, maxLength) {
    if (text.length <= maxLength) return text;
    return `${text.slice(0, maxLength - 1)}…`;
  }

  return {
    init,
    setSessionContext,
    setHistory,
    handleMessage,
    open: openDrawer,
    close: closeDrawer,
    isOpen: () => isOpen,
  };
})();

window.Chat = Chat;
