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

  global.RuntimeApi = Object.freeze({
    fetch: authenticatedFetch,
    request,
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
