'use strict';

(function installRuntimeClient(global) {
  const TOKEN_KEY = 'idol_runtime_auth_token';
  const nativeFetch = global.fetch.bind(global);

  async function authenticatedFetch(input, init = {}) {
    const requestUrl = new URL(typeof input === 'string' ? input : input.url, global.location.href);
    const isRuntimeApi = requestUrl.origin === global.location.origin && requestUrl.pathname.startsWith('/api/');
    if (!isRuntimeApi) return nativeFetch(input, init);

    const send = (token = '') => {
      const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));
      if (token) headers.set('Authorization', `Bearer ${token}`);
      return nativeFetch(input, { ...init, headers });
    };

    let token = global.sessionStorage.getItem(TOKEN_KEY) || '';
    let response = await send(token);
    if (response.status === 401) {
      token = global.prompt('Enter the Runtime access token for this session:')?.trim() || '';
      if (token) {
        global.sessionStorage.setItem(TOKEN_KEY, token);
        response = await send(token);
      }
    }
    return response;
  }

  async function request(path, init = {}) {
    const response = await authenticatedFetch(path, init);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || payload.msg || `Runtime HTTP ${response.status}`);
    return payload;
  }

  function connectRealtime(onMessage, onStateChange = () => {}) {
    const protocol = global.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const token = global.sessionStorage.getItem(TOKEN_KEY) || '';
    const protocols = ['idol-runtime-v2'];
    if (token) {
      const bytes = new TextEncoder().encode(token);
      let binary = '';
      bytes.forEach(byte => { binary += String.fromCharCode(byte); });
      protocols.push(`auth.${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`);
    }
    const socket = new WebSocket(`${protocol}//${global.location.host}/`, protocols);
    socket.addEventListener('open', () => onStateChange('open'));
    socket.addEventListener('close', () => onStateChange('closed'));
    socket.addEventListener('error', () => onStateChange('error'));
    socket.addEventListener('message', event => {
      try { onMessage(JSON.parse(event.data)); } catch (error) {
        console.warn('[Runtime] Invalid realtime payload:', error.message);
      }
    });
    return socket;
  }

  global.RuntimeApi = Object.freeze({
    fetch: authenticatedFetch,
    request,
    connectRealtime,
    get: (path) => request(path),
    post: (path, body) => request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    }),
    delete: (path) => request(path, { method: 'DELETE' }),
  });
  global.fetch = authenticatedFetch;
})(window);
