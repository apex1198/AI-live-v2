(function materialIconSystem() {
  'use strict';

  const ICONS = new Map([
    ['✨', 'auto_awesome'], ['✦', 'auto_awesome'], ['⚡', 'bolt'], ['🚀', 'bolt'], ['🧪', 'science'],
    ['🎬', 'movie'], ['🎥', 'movie'], ['📹', 'movie'], ['🖼', 'image'],
    ['🎵', 'music_note'], ['🎙', 'mic'], ['🎤', 'mic'], ['🗣', 'record_voice_over'],
    ['🎮', 'sports_esports'], ['🕹', 'sports_esports'], ['🎰', 'casino'],
    ['🎉', 'celebration'], ['💥', 'bolt'], ['😢', 'sentiment_dissatisfied'],
    ['😊', 'sentiment_satisfied'], ['😲', 'mood'], ['😂', 'mood'],
    ['🙏', 'volunteer_activism'], ['💤', 'bed'], ['📣', 'campaign'],
    ['🎯', 'my_location'], ['💬', 'chat'], ['👤', 'person'], ['🌐', 'public'],
    ['📤', 'upload'], ['📥', 'download'], ['📁', 'folder_open'], ['📋', 'content_copy'],
    ['💾', 'save'], ['🗑', 'delete'], ['🔑', 'key'], ['👁', 'visibility'],
    ['🙈', 'visibility_off'], ['🔒', 'lock'], ['🟢', 'check_circle'],
    ['✅', 'check_circle'], ['❌', 'close'], ['⚠', 'warning'], ['⛔', 'block'],
    ['🔄', 'refresh'], ['🔀', 'shuffle'], ['🔁', 'loop'], ['🔊', 'volume_up'],
    ['🔇', 'volume_off'], ['🖥', 'terminal'], ['💻', 'terminal'], ['📡', 'cable'],
    ['🧠', 'memory'], ['🎁', 'featured_seasonal_and_gifts'], ['🌹', 'favorite'],
    ['🦁', 'pets'], ['👄', 'face'], ['➕', 'add'], ['✖', 'close'], ['✕', 'close'],
    ['⚙', 'settings'], ['⌂', 'home'], ['◉', 'monitor_heart'], ['◌', 'forum'], ['⇧', 'upload'],
    ['⌡', 'auto_mode'], ['▣', 'grid_view'], ['■', 'stop'], ['▶', 'play_arrow'], ['⟳', 'refresh'],
    ['➔', 'play_arrow'], ['★', 'workspace_premium'], ['✓', 'check_circle'],
    ['⏸', 'pause'], ['⏹', 'stop'], ['↺', 'restart_alt']
  ]);

  const mappedTokens = Array.from(ICONS.keys())
    .sort((a, b) => b.length - a.length)
    .map(token => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
  const TOKEN_PATTERN = new RegExp(`(?:${mappedTokens}|[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}])\\uFE0F?`, 'gu');

  function icon(name) {
    const span = document.createElement('span');
    span.className = 'material-symbols-rounded app-icon';
    span.setAttribute('aria-hidden', 'true');
    span.textContent = name;
    return span;
  }

  function upgradeTextNode(node) {
    if (!node.nodeValue || !TOKEN_PATTERN.test(node.nodeValue)) return;
    TOKEN_PATTERN.lastIndex = 0;
    const parent = node.parentElement;
    if (!parent || parent.closest('script, style, textarea, code, pre')) return;

    if (parent.matches('option, optgroup')) {
      node.nodeValue = node.nodeValue.replace(TOKEN_PATTERN, '').replace(/^\s+/, '');
      TOKEN_PATTERN.lastIndex = 0;
      return;
    }

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of node.nodeValue.matchAll(TOKEN_PATTERN)) {
      if (match.index > cursor) fragment.append(node.nodeValue.slice(cursor, match.index));
      const raw = match[0].replace(/\uFE0F/g, '');
      fragment.append(icon(ICONS.get(raw) || 'auto_awesome'));
      cursor = match.index + match[0].length;
    }
    if (cursor < node.nodeValue.length) fragment.append(node.nodeValue.slice(cursor));
    node.replaceWith(fragment);
    TOKEN_PATTERN.lastIndex = 0;
  }

  function upgrade(root) {
    if (root.nodeType === Node.TEXT_NODE) return upgradeTextNode(root);
    if (!(root instanceof Element || root instanceof Document || root instanceof DocumentFragment)) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(upgradeTextNode);
  }

  function start() {
    upgrade(document.body);
    new MutationObserver(records => records.forEach(record => record.addedNodes.forEach(upgrade)))
      .observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  window.materialIcon = name => `<span class="material-symbols-rounded app-icon" aria-hidden="true">${name}</span>`;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
