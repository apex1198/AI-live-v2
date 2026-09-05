'use strict';

(function initializeUnifyChatEmbed() {
  const params = new URLSearchParams(location.search);
  const root = document.documentElement;
  const chat = document.getElementById('unify-chat');
  const list = document.getElementById('chat-list');
  const status = document.getElementById('connection-status');
  const form = document.getElementById('form-chat-send');
  const userInput = document.getElementById('input-chat-user');
  const messageInput = document.getElementById('input-chat-msg');
  const sendButton = document.getElementById('btn-chat-submit');
  const maxMessages = Math.max(1, Math.min(100, Number(params.get('max')) || 30));
  const renderedKeys = new Set();

  root.dataset.theme = params.get('theme') === 'light' ? 'light' : 'dark';
  root.dataset.header = params.get('header') === '0' ? 'false' : 'true';
  root.dataset.transparent = params.get('transparent') === '1' ? 'true' : 'false';
  const requestedHeight = Math.max(190, Math.min(1200, Number(params.get('height')) || 420));
  root.style.setProperty('--embed-height', `${requestedHeight}px`);

  const savedViewerName = localStorage.getItem('idol_mock_chat_user');
  if (savedViewerName) userInput.value = savedViewerName;

  function platformLabel(platform) {
    if (platform === 'youtube') return '[YT]';
    if (platform === 'facebook') return '[FB]';
    return '';
  }

  function messageKey(message) {
    return [message.platform, message.viewerId || message.viewerName, message.message, message.timestamp].join('\u0000');
  }

  function renderMessage(message) {
    if (!message?.message) return;
    const key = messageKey(message);
    if (renderedKeys.has(key)) return;
    renderedKeys.add(key);
    if (renderedKeys.size > 200) renderedKeys.delete(renderedKeys.values().next().value);
    document.getElementById('chat-empty')?.remove();

    const platform = String(message.platform || 'mock');
    const item = document.createElement('li');
    item.className = 'chat-item';
    item.dataset.platform = platform;

    const viewer = document.createElement('div');
    viewer.className = 'chat-viewer';
    const badge = document.createElement('span');
    badge.className = 'platform-badge';
    badge.dataset.platform = platform;
    badge.textContent = platformLabel(platform);
    const name = document.createElement('span');
    name.className = 'viewer-name';
    name.textContent = String(message.viewerName || 'Viewer');
    if (badge.textContent) viewer.append(badge);
    viewer.append(name);

    const body = document.createElement('div');
    body.className = 'chat-message';
    body.textContent = String(message.message);
    const time = document.createElement('div');
    time.className = 'chat-time';
    time.textContent = new Date(Number(message.timestamp || Date.now())).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    item.append(viewer, body, time);

    list.prepend(item);
    while (list.children.length > maxMessages) list.lastElementChild?.remove();
    list.scrollTop = 0;
  }

  function updateStatus(state) {
    status.dataset.state = state;
    status.textContent = state === 'open' ? 'Online' : state === 'error' ? 'Offline' : 'Connecting';
  }

  function handleRealtime(payload) {
    if (payload.type === 'INITIAL_STATE') {
      const messages = Array.isArray(payload.chatMessages) ? payload.chatMessages.slice(-maxMessages) : [];
      messages.forEach(renderMessage);
      return;
    }
    if (payload.type === 'CHAT_MESSAGE' && payload.message) renderMessage(payload.message);
  }

  async function sendMessage(viewerName, message, isSuperChat = false) {
    const payload = await window.RuntimeApi.post('/api/chat/send', {
      platform: 'mock',
      viewerId: `usr_${viewerName.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
      viewerName,
      message,
      isSuperChat,
      timestamp: Date.now(),
    });
    if (payload.message) renderMessage(payload.message);
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const viewerName = userInput.value.trim().slice(0, 40) || 'Viewer';
    const message = messageInput.value.trim();
    if (!message || sendButton.disabled) return;
    userInput.value = viewerName;
    localStorage.setItem('idol_mock_chat_user', viewerName);
    messageInput.value = '';
    sendButton.disabled = true;
    try {
      await sendMessage(viewerName, message);
    } catch (error) {
      messageInput.value = message;
      updateStatus('error');
      console.error('Unify Chat send failed:', error);
    } finally {
      sendButton.disabled = false;
      messageInput.focus();
    }
  });

  document.getElementById('btn-gift-rose').addEventListener('click', () => sendMessage('Fan_Cung_99', 'sent 10 Roses 🌹!', true).catch(console.error));
  document.getElementById('btn-gift-lion').addEventListener('click', () => sendMessage('DaiGia_VN', 'sent a Royal Lion 🦁!', true).catch(console.error));
  document.getElementById('btn-clear-chat').addEventListener('click', () => {
    renderedKeys.clear();
    list.replaceChildren();
    const empty = document.createElement('li');
    empty.id = 'chat-empty';
    empty.className = 'chat-empty';
    empty.textContent = 'Chưa có tin nhắn';
    list.append(empty);
  });

  if (window.RuntimeApi?.connectRealtime) window.RuntimeApi.connectRealtime(handleRealtime, updateStatus);
  else updateStatus('error');

  const resizeObserver = new ResizeObserver(() => {
    window.parent.postMessage({
      type: 'AI_IDOL_CHAT_RESIZE',
      height: Math.ceil(chat.getBoundingClientRect().height),
    }, '*');
  });
  resizeObserver.observe(chat);
})();
