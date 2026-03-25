// Notification System — Non-intrusive, smooth fade messages

const Notifications = (() => {
  const MAX_VISIBLE = 3;
  const DEFAULT_DURATION = 3500;
  let area = null;

  function init() {
    area = document.getElementById('notification-area');
  }

  function show(message, type = 'info', duration = DEFAULT_DURATION) {
    if (!area) init();

    // Remove oldest if at max
    while (area.children.length >= MAX_VISIBLE) {
      const oldest = area.children[0];
      removeNotif(oldest);
    }

    const notif = document.createElement('div');
    notif.className = `notification ${type}`;
    notif.textContent = message;
    area.appendChild(notif);

    // Auto-remove
    if (duration > 0) {
      setTimeout(() => removeNotif(notif), duration);
    }

    return notif;
  }

  function removeNotif(notif) {
    if (!notif || !notif.parentNode) return;
    notif.classList.add('fade-out');
    setTimeout(() => {
      if (notif.parentNode) notif.parentNode.removeChild(notif);
    }, 400);
  }

  function info(message, duration) {
    return show(message, 'info', duration);
  }

  function success(message, duration) {
    return show(message, 'success', duration);
  }

  function warning(message, duration) {
    return show(message, 'warning', duration);
  }

  function error(message, duration) {
    return show(message, 'error', duration);
  }

  return { init, show, info, success, warning, error };
})();
