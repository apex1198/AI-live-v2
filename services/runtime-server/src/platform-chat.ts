import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

export type PlatformChatId = 'youtube' | 'facebook';
export type PlatformChatConnectionState =
  | 'NOT_CONFIGURED'
  | 'SIGNED_OUT'
  | 'PAUSED'
  | 'CONNECTING'
  | 'WAITING_FOR_LIVE'
  | 'LISTENING'
  | 'ERROR';

export interface UnifiedChatMessageInput {
  platform: PlatformChatId;
  liveSessionId: string;
  viewerId: string;
  viewerName: string;
  message: string;
  viewerTier: 'regular' | 'subscriber' | 'vip' | 'moderator' | 'top_donor';
  isSuperChat: boolean;
  isSubscriber: boolean;
  timestamp: number;
  avatarUrl?: string;
}

export interface PlatformChatSourceStatus {
  platform: PlatformChatId;
  configured: boolean;
  authenticated: boolean;
  state: PlatformChatConnectionState;
  accountName: string;
  liveTitle: string;
  lastMessageAt: number | null;
  error: string;
}

export interface PlatformChatPublicState {
  unified: true;
  activeSources: number;
  sources: Record<PlatformChatId, PlatformChatSourceStatus>;
}

interface YouTubeCredential {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
  accountName: string;
  grantedScopes?: string[];
}

interface FacebookPageCredential {
  id: string;
  name: string;
  accessToken: string;
}

interface FacebookCredential {
  accessToken: string;
  expiresAt: number;
  accountId: string;
  accountName: string;
  pages: FacebookPageCredential[];
}

export interface StoredPlatformChatCredentials {
  youtube?: YouTubeCredential;
  facebook?: FacebookCredential;
}

interface OAuthAttempt {
  platform: PlatformChatId;
  redirectUri: string;
  createdAt: number;
  codeVerifier?: string;
}

interface PlatformChatCoordinatorOptions {
  port: number;
  loadCredentials: () => StoredPlatformChatCredentials;
  saveCredentials: (credentials: StoredPlatformChatCredentials) => void;
  onMessage: (message: UnifiedChatMessageInput) => void;
  onStatus: (state: PlatformChatPublicState) => void;
  onLog?: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  openExternal?: (url: string) => Promise<void>;
  environment?: NodeJS.ProcessEnv;
}

const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';
const FACEBOOK_SCOPES = ['public_profile', 'pages_show_list', 'pages_read_engagement', 'pages_manage_posts'];
const OAUTH_ATTEMPT_TTL_MS = 10 * 60_000;

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function timestampValue(value: unknown, fallback = Date.now()): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Date.parse(stringValue(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function base64Url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function grantedOAuthScopes(value: unknown): string[] {
  return stringValue(value).split(/\s+/).filter(Boolean);
}

async function readJson(response: Response, provider: string): Promise<any> {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    const remote = payload?.error?.message || payload?.error_description || payload?.error || payload?.message;
    throw new Error(`${provider}: ${remote || `HTTP ${response.status}`}`);
  }
  return payload;
}

export function normalizeYouTubeChatItem(item: any, liveSessionId: string): UnifiedChatMessageInput | null {
  const snippet = item?.snippet || {};
  const author = item?.authorDetails || {};
  const message = stringValue(snippet.displayMessage || snippet.textMessageDetails?.messageText);
  const id = stringValue(item?.id);
  if (!message || !id) return null;

  const isSuperChat = snippet.type === 'superChatEvent' || snippet.type === 'superStickerEvent';
  const isSubscriber = Boolean(author.isChatSponsor || author.isChatModerator || author.isChatOwner);
  const viewerTier = isSuperChat
    ? 'top_donor'
    : author.isChatModerator || author.isChatOwner
      ? 'moderator'
      : isSubscriber
        ? 'subscriber'
        : 'regular';
  const normalized: UnifiedChatMessageInput = {
    platform: 'youtube',
    liveSessionId,
    viewerId: stringValue(author.channelId || snippet.authorChannelId) || `youtube_${id}`,
    viewerName: stringValue(author.displayName) || 'YouTube viewer',
    message,
    viewerTier,
    isSuperChat,
    isSubscriber,
    timestamp: timestampValue(snippet.publishedAt),
  };
  const avatarUrl = stringValue(author.profileImageUrl);
  if (avatarUrl) normalized.avatarUrl = avatarUrl;
  return normalized;
}

export function selectActiveYouTubeBroadcast(items: any[]): any | null {
  if (!Array.isArray(items)) return null;
  return items.find((item) => (
    stringValue(item?.status?.lifeCycleStatus) === 'live'
    && Boolean(stringValue(item?.snippet?.liveChatId))
  )) || null;
}

export function normalizeFacebookComment(comment: any, liveSessionId: string): UnifiedChatMessageInput | null {
  const id = stringValue(comment?.id);
  const message = stringValue(comment?.message);
  if (!id || !message) return null;
  return {
    platform: 'facebook',
    liveSessionId,
    viewerId: stringValue(comment?.from?.id) || `facebook_${id}`,
    viewerName: stringValue(comment?.from?.name) || 'Facebook viewer',
    message,
    viewerTier: 'regular',
    isSuperChat: false,
    isSubscriber: false,
    timestamp: timestampValue(comment?.created_time),
  };
}

export function isYouTubeOwnerChatItem(item: any): boolean {
  return item?.authorDetails?.isChatOwner === true;
}

export function isFacebookPageComment(comment: any, pageId: string): boolean {
  const authorId = stringValue(comment?.from?.id);
  return Boolean(authorId && pageId && authorId === pageId);
}

async function openSystemBrowser(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (process.platform === 'darwin') {
      execFile('/usr/bin/open', [url], (error) => error ? reject(error) : resolve());
      return;
    }
    if (process.platform === 'win32') {
      execFile(process.env['ComSpec'] || 'cmd.exe', ['/d', '/s', '/c', 'start', '', url], (error) => error ? reject(error) : resolve());
      return;
    }
    execFile('xdg-open', [url], (error) => error ? reject(error) : resolve());
  });
}

export class PlatformChatCoordinator {
  private readonly _options: PlatformChatCoordinatorOptions;
  private readonly _fetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  private readonly _env: NodeJS.ProcessEnv;
  private readonly _oauthAttempts = new Map<string, OAuthAttempt>();
  private readonly _timers = new Map<PlatformChatId, ReturnType<typeof setTimeout>>();
  private readonly _seenMessageIds: Record<PlatformChatId, Set<string>> = {
    youtube: new Set(),
    facebook: new Set(),
  };
  private _credentials: StoredPlatformChatCredentials;
  private _running = false;
  private _youtubeLiveChatId = '';
  private _youtubePageToken = '';
  private _youtubeJoinedAt = 0;
  private _facebookLiveVideoId = '';
  private _facebookPageId = '';
  private _facebookAfterCursor = '';
  private _facebookJoinedAt = 0;
  private _statuses: Record<PlatformChatId, PlatformChatSourceStatus>;

  constructor(options: PlatformChatCoordinatorOptions) {
    this._options = options;
    this._fetch = options.fetchImpl || fetch;
    this._env = options.environment || process.env;
    this._credentials = options.loadCredentials() || {};
    this._statuses = {
      youtube: this._initialStatus('youtube'),
      facebook: this._initialStatus('facebook'),
    };
  }

  private _configured(platform: PlatformChatId): boolean {
    return !this._missingConfiguration(platform);
  }

  private _missingConfiguration(platform: PlatformChatId): string {
    if (platform === 'youtube') {
      if (!this._env['GOOGLE_OAUTH_CLIENT_ID']) return 'GOOGLE_OAUTH_CLIENT_ID';
      if (!this._env['GOOGLE_OAUTH_CLIENT_SECRET']) return 'GOOGLE_OAUTH_CLIENT_SECRET';
      return '';
    }
    return this._env['FACEBOOK_APP_ID'] ? '' : 'FACEBOOK_APP_ID';
  }

  private _credential(platform: PlatformChatId): YouTubeCredential | FacebookCredential | undefined {
    return platform === 'youtube' ? this._credentials.youtube : this._credentials.facebook;
  }

  private _initialStatus(platform: PlatformChatId): PlatformChatSourceStatus {
    const configured = this._configured(platform);
    const credential = this._credential(platform);
    return {
      platform,
      configured,
      authenticated: Boolean(credential?.accessToken),
      state: !configured ? 'NOT_CONFIGURED' : credential?.accessToken ? 'PAUSED' : 'SIGNED_OUT',
      accountName: credential?.accountName || '',
      liveTitle: '',
      lastMessageAt: null,
      error: '',
    };
  }

  publicState(): PlatformChatPublicState {
    const sources = {
      youtube: { ...this._statuses.youtube },
      facebook: { ...this._statuses.facebook },
    };
    return {
      unified: true,
      activeSources: Object.values(sources).filter((source) => source.state === 'LISTENING').length,
      sources,
    };
  }

  private _emitStatus(platform: PlatformChatId, patch: Partial<PlatformChatSourceStatus>): void {
    const credential = this._credential(platform);
    this._statuses[platform] = {
      ...this._statuses[platform],
      ...patch,
      configured: this._configured(platform),
      authenticated: Boolean(credential?.accessToken),
      accountName: patch.accountName ?? credential?.accountName ?? this._statuses[platform].accountName,
    };
    this._options.onStatus(this.publicState());
  }

  private _log(level: 'info' | 'warn' | 'error' | 'debug', message: string): void {
    this._options.onLog?.(level, message);
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    this._options.onStatus(this.publicState());
  }

  resume(platform: PlatformChatId): void {
    if (!this._credential(platform)?.accessToken) throw new Error(`${platform} is signed out`);
    if (platform === 'youtube') {
      this._youtubeLiveChatId = '';
      this._youtubePageToken = '';
      this._youtubeJoinedAt = 0;
    }
    this._emitStatus(platform, { state: 'WAITING_FOR_LIVE', error: '', liveTitle: '' });
    this._schedule(platform, 0);
  }

  stop(): void {
    this._running = false;
    for (const timer of this._timers.values()) clearTimeout(timer);
    this._timers.clear();
  }

  reportLoginError(platform: PlatformChatId, error: unknown): void {
    this._emitStatus(platform, { state: 'ERROR', error: errorMessage(error), liveTitle: '' });
  }

  private _schedule(platform: PlatformChatId, delayMs: number): void {
    const previous = this._timers.get(platform);
    if (previous) clearTimeout(previous);
    if (!this._running) return;
    const timer = setTimeout(() => {
      this._timers.delete(platform);
      const operation = platform === 'youtube' ? this._pollYouTube() : this._pollFacebook();
      void operation.catch((error) => {
        const message = errorMessage(error);
        this._log('warn', `${platform} live chat: ${message}`);
        if (!this._credential(platform)?.accessToken) return;
        this._emitStatus(platform, { state: 'ERROR', error: message, liveTitle: '' });
        if (platform === 'facebook') this._schedule(platform, 15_000);
      });
    }, Math.max(0, delayMs));
    this._timers.set(platform, timer);
  }

  private _oauthRedirectUri(platform: PlatformChatId): string {
    const configured = platform === 'youtube'
      ? this._env['GOOGLE_OAUTH_REDIRECT_URI']
      : this._env['FACEBOOK_OAUTH_REDIRECT_URI'];
    return configured || `http://127.0.0.1:${this._options.port}/api/platform-chat/${platform}/oauth/callback`;
  }

  async beginLogin(platform: PlatformChatId): Promise<{ started: true; authUrl: string }> {
    const missingConfiguration = this._missingConfiguration(platform);
    if (missingConfiguration) throw new Error(`${missingConfiguration} is not configured in this app build`);
    for (const [state, attempt] of this._oauthAttempts) {
      if (Date.now() - attempt.createdAt > OAUTH_ATTEMPT_TTL_MS) this._oauthAttempts.delete(state);
    }
    const state = base64Url(crypto.randomBytes(24));
    const redirectUri = this._oauthRedirectUri(platform);
    let authUrl = '';
    if (platform === 'youtube') {
      const codeVerifier = base64Url(crypto.randomBytes(48));
      const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest());
      this._oauthAttempts.set(state, { platform, redirectUri, createdAt: Date.now(), codeVerifier });
      const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
      url.search = new URLSearchParams({
        client_id: this._env['GOOGLE_OAUTH_CLIENT_ID'] || '',
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: YOUTUBE_SCOPE,
        access_type: 'offline',
        include_granted_scopes: 'false',
        prompt: 'select_account consent',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      }).toString();
      authUrl = url.toString();
    } else {
      this._oauthAttempts.set(state, { platform, redirectUri, createdAt: Date.now() });
      const version = this._env['META_GRAPH_VERSION'] || 'v24.0';
      const url = new URL(`https://www.facebook.com/${version}/dialog/oauth`);
      url.search = new URLSearchParams({
        client_id: this._env['FACEBOOK_APP_ID'] || '',
        redirect_uri: redirectUri,
        response_type: 'token',
        scope: FACEBOOK_SCOPES.join(','),
        state,
        auth_type: 'rerequest',
      }).toString();
      authUrl = url.toString();
    }
    this._emitStatus(platform, { state: 'CONNECTING', error: '', liveTitle: '' });
    const openExternal = this._options.openExternal || openSystemBrowser;
    try {
      await openExternal(authUrl);
    } catch (error) {
      this._emitStatus(platform, { state: 'ERROR', error: `Could not open login: ${errorMessage(error)}` });
      throw error;
    }
    return { started: true, authUrl };
  }

  async completeYouTubeLogin(query: URLSearchParams): Promise<void> {
    const state = stringValue(query.get('state'));
    const attempt = this._consumeAttempt(state, 'youtube');
    const remoteError = stringValue(query.get('error'));
    if (remoteError) throw new Error(`Google login was not completed: ${remoteError}`);
    const code = stringValue(query.get('code'));
    if (!code || !attempt.codeVerifier) throw new Error('Google did not return a valid authorization code');

    const response = await this._fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this._env['GOOGLE_OAUTH_CLIENT_ID'] || '',
        client_secret: this._env['GOOGLE_OAUTH_CLIENT_SECRET'] || '',
        code,
        code_verifier: attempt.codeVerifier,
        redirect_uri: attempt.redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const token = await readJson(response, 'Google OAuth');
    const accessToken = stringValue(token.access_token);
    if (!accessToken) throw new Error('Google OAuth returned no access token');
    const grantedScopes = grantedOAuthScopes(token.scope);
    if (!grantedScopes.includes(YOUTUBE_SCOPE)) {
      this._log('warn', `Google OAuth omitted required scope; granted=${grantedScopes.join(',') || 'none'}`);
      throw new Error('Google chưa cấp quyền xem tài khoản YouTube. Hãy đăng nhập lại, chọn "View your YouTube account", rồi bấm Continue.');
    }
    const channel = await this._youtubeApi('/channels', accessToken, {
      part: 'id,snippet',
      mine: 'true',
      maxResults: '1',
    });
    const account = channel.items?.[0] || {};
    const previous = this._credentials.youtube;
    this._credentials.youtube = {
      accessToken,
      refreshToken: stringValue(token.refresh_token) || previous?.refreshToken || '',
      expiresAt: Date.now() + Math.max(60, Number(token.expires_in || 3600)) * 1000,
      accountId: stringValue(account.id),
      accountName: stringValue(account.snippet?.title) || 'YouTube channel',
      grantedScopes,
    };
    this._options.saveCredentials(this._credentials);
    this._emitStatus('youtube', { state: 'WAITING_FOR_LIVE', error: '', liveTitle: '' });
    this._schedule('youtube', 0);
  }

  facebookCallbackPage(): string {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>AI IDOL Facebook Login</title><style>body{margin:0;background:#171818;color:#f4f4f4;font:14px -apple-system,BlinkMacSystemFont,sans-serif;display:grid;place-items:center;min-height:100vh}.box{max-width:440px;padding:24px;border:1px solid #343636;border-radius:8px;background:#202121}p{color:#b8baba;line-height:1.5}</style></head><body><main class="box"><strong id="title">Connecting Facebook...</strong><p id="message">AI IDOL is completing the permission request.</p></main><script>(async()=>{const hash=new URLSearchParams(location.hash.slice(1));const body={state:hash.get('state')||'',accessToken:hash.get('access_token')||'',expiresIn:Number(hash.get('expires_in')||0),error:hash.get('error_description')||hash.get('error')||''};try{const response=await fetch('/api/platform-chat/facebook/oauth/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.error||'Facebook login failed');document.getElementById('title').textContent='Facebook connected';document.getElementById('message').textContent='You can close this window and return to AI IDOL.';setTimeout(()=>window.close(),1200)}catch(error){document.getElementById('title').textContent='Could not connect Facebook';document.getElementById('message').textContent=error.message}})();</script></body></html>`;
  }

  async completeFacebookLogin(input: { state: string; accessToken: string; expiresIn: number; error: string }): Promise<void> {
    this._consumeAttempt(input.state, 'facebook');
    if (input.error) throw new Error(`Facebook login was not completed: ${input.error}`);
    if (!input.accessToken) throw new Error('Facebook did not return an access token');
    const account = await this._facebookApi('/me', input.accessToken, { fields: 'id,name' });
    const pagePayload = await this._facebookApi('/me/accounts', input.accessToken, {
      fields: 'id,name,access_token',
      limit: '100',
    });
    const pages = (Array.isArray(pagePayload.data) ? pagePayload.data : [])
      .map((page: any): FacebookPageCredential | null => {
        const id = stringValue(page.id);
        const accessToken = stringValue(page.access_token);
        if (!id || !accessToken) return null;
        return { id, name: stringValue(page.name) || 'Facebook Page', accessToken };
      })
      .filter((page: FacebookPageCredential | null): page is FacebookPageCredential => Boolean(page));
    if (!pages.length) throw new Error('No Facebook Page with Live access was found for this account');
    this._credentials.facebook = {
      accessToken: input.accessToken,
      expiresAt: Date.now() + Math.max(60, Number(input.expiresIn || 3600)) * 1000,
      accountId: stringValue(account.id),
      accountName: stringValue(account.name) || 'Facebook account',
      pages,
    };
    this._options.saveCredentials(this._credentials);
    this._emitStatus('facebook', { state: 'WAITING_FOR_LIVE', error: '', liveTitle: '' });
    this._schedule('facebook', 0);
  }

  private _consumeAttempt(state: string, platform: PlatformChatId): OAuthAttempt {
    const attempt = this._oauthAttempts.get(state);
    this._oauthAttempts.delete(state);
    if (!state || !attempt || attempt.platform !== platform || Date.now() - attempt.createdAt > OAUTH_ATTEMPT_TTL_MS) {
      throw new Error('Login session is invalid or expired. Start the login again from AI IDOL.');
    }
    return attempt;
  }

  disconnect(platform: PlatformChatId): void {
    const timer = this._timers.get(platform);
    if (timer) clearTimeout(timer);
    this._timers.delete(platform);
    if (platform === 'youtube') {
      delete this._credentials.youtube;
      this._youtubeLiveChatId = '';
      this._youtubePageToken = '';
      this._youtubeJoinedAt = 0;
    } else {
      delete this._credentials.facebook;
      this._facebookLiveVideoId = '';
      this._facebookPageId = '';
      this._facebookAfterCursor = '';
      this._facebookJoinedAt = 0;
    }
    this._seenMessageIds[platform].clear();
    this._options.saveCredentials(this._credentials);
    this._statuses[platform] = this._initialStatus(platform);
    this._options.onStatus(this.publicState());
  }

  private async _youtubeAccessToken(): Promise<string> {
    const credential = this._credentials.youtube;
    if (!credential) throw new Error('YouTube is signed out');
    if (credential.expiresAt > Date.now() + 60_000) return credential.accessToken;
    if (!credential.refreshToken) {
      this.disconnect('youtube');
      throw new Error('YouTube login expired');
    }
    const response = await this._fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this._env['GOOGLE_OAUTH_CLIENT_ID'] || '',
        client_secret: this._env['GOOGLE_OAUTH_CLIENT_SECRET'] || '',
        refresh_token: credential.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    const token = await readJson(response, 'Google OAuth refresh');
    const refreshedScopes = grantedOAuthScopes(token.scope);
    if (refreshedScopes.length && !refreshedScopes.includes(YOUTUBE_SCOPE)) {
      this.disconnect('youtube');
      throw new Error('YouTube permission was removed. Sign in again to reconnect.');
    }
    credential.accessToken = stringValue(token.access_token);
    if (!credential.accessToken) throw new Error('Google OAuth refresh returned no access token');
    if (refreshedScopes.length) credential.grantedScopes = refreshedScopes;
    credential.expiresAt = Date.now() + Math.max(60, Number(token.expires_in || 3600)) * 1000;
    this._options.saveCredentials(this._credentials);
    return credential.accessToken;
  }

  private async _youtubeApi(pathname: string, accessToken: string, params: Record<string, string>): Promise<any> {
    const url = new URL(`https://www.googleapis.com/youtube/v3${pathname}`);
    url.search = new URLSearchParams(params).toString();
    const response = await this._fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    return readJson(response, 'YouTube API');
  }

  async sendReply(platform: PlatformChatId, message: string): Promise<void> {
    const text = stringValue(message).slice(0, 200);
    if (!text) return;
    if (platform === 'youtube') {
      if (!this._youtubeLiveChatId) throw new Error('YouTube Live Chat is not active');
      const accessToken = await this._youtubeAccessToken();
      const url = new URL('https://www.googleapis.com/youtube/v3/liveChat/messages');
      url.searchParams.set('part', 'snippet');
      const response = await this._fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ snippet: { liveChatId: this._youtubeLiveChatId, type: 'textMessageEvent', textMessageDetails: { messageText: text } } }),
      });
      const payload = await readJson(response, 'YouTube API');
      const sentMessageId = stringValue(payload?.id);
      if (sentMessageId) this._seenMessageIds.youtube.add(sentMessageId);
      return;
    }
    const page = this._credentials.facebook?.pages.find((candidate) => candidate.id === this._facebookPageId);
    if (!page || !this._facebookLiveVideoId) throw new Error('Facebook Live Chat is not active');
    const version = this._env['META_GRAPH_VERSION'] || 'v24.0';
    const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(this._facebookLiveVideoId)}/comments`);
    const response = await this._fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${page.accessToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ message: text }),
    });
    const payload = await readJson(response, 'Facebook API');
    const sentCommentId = stringValue(payload?.id);
    if (sentCommentId) this._seenMessageIds.facebook.add(sentCommentId);
  }

  private async _pollYouTube(): Promise<void> {
    const accessToken = await this._youtubeAccessToken();
    if (!this._youtubeLiveChatId) {
      const broadcasts = await this._youtubeApi('/liveBroadcasts', accessToken, {
        part: 'id,snippet,status',
        mine: 'true',
        maxResults: '50',
      });
      const broadcast = selectActiveYouTubeBroadcast(broadcasts.items || []);
      if (!broadcast) {
        this._emitStatus('youtube', { state: 'PAUSED', error: '', liveTitle: '' });
        return;
      }
      this._youtubeLiveChatId = stringValue(broadcast.snippet.liveChatId);
      this._youtubePageToken = '';
      this._youtubeJoinedAt = Date.now();
      this._seenMessageIds.youtube.clear();
      this._emitStatus('youtube', {
        state: 'LISTENING',
        error: '',
        liveTitle: stringValue(broadcast.snippet.title) || 'YouTube Live',
      });
    }

    const params: Record<string, string> = {
      liveChatId: this._youtubeLiveChatId,
      part: 'id,snippet,authorDetails',
      maxResults: '200',
      hl: 'vi',
    };
    if (this._youtubePageToken) params['pageToken'] = this._youtubePageToken;
    const payload = await this._youtubeApi('/liveChat/messages', accessToken, params);
    const items = Array.isArray(payload.items) ? payload.items : [];
    for (const item of items) {
      const messageId = stringValue(item?.id);
      if (!messageId || this._seenMessageIds.youtube.has(messageId)) continue;
      this._seenMessageIds.youtube.add(messageId);
      // The API returns messages sent by the authenticated channel too. Never
      // feed the Idol's own reply back into the reply/TTS pipeline.
      if (isYouTubeOwnerChatItem(item)) {
        this._options.onLog?.('debug', `Ignored YouTube owner message ${messageId}`);
        continue;
      }
      const normalized = normalizeYouTubeChatItem(item, this._youtubeLiveChatId);
      if (normalized && normalized.timestamp >= this._youtubeJoinedAt - 2_000) {
        this._options.onMessage(normalized);
        this._emitStatus('youtube', { state: 'LISTENING', error: '', lastMessageAt: normalized.timestamp });
      }
    }
    this._trimSeen('youtube');
    this._youtubePageToken = stringValue(payload.nextPageToken) || this._youtubePageToken;
    if (payload.offlineAt) {
      this._youtubeLiveChatId = '';
      this._youtubePageToken = '';
      this._emitStatus('youtube', { state: 'PAUSED', error: '', liveTitle: '' });
      return;
    }
    this._schedule('youtube', Math.max(2_000, Number(payload.pollingIntervalMillis || 5_000)));
  }

  private async _facebookApi(pathname: string, accessToken: string, params: Record<string, string>): Promise<any> {
    const version = this._env['META_GRAPH_VERSION'] || 'v24.0';
    const url = new URL(`https://graph.facebook.com/${version}${pathname}`);
    url.search = new URLSearchParams(params).toString();
    const response = await this._fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    return readJson(response, 'Facebook API');
  }

  private async _findFacebookLive(): Promise<{ page: FacebookPageCredential; video: any } | null> {
    const credential = this._credentials.facebook;
    if (!credential) return null;
    for (const page of credential.pages) {
      const payload = await this._facebookApi(`/${encodeURIComponent(page.id)}/live_videos`, page.accessToken, {
        fields: 'id,title,status,creation_time',
        limit: '10',
      });
      const video = (Array.isArray(payload.data) ? payload.data : [])
        .find((item: any) => stringValue(item?.status).toUpperCase() === 'LIVE');
      if (video) return { page, video };
    }
    return null;
  }

  private async _pollFacebook(): Promise<void> {
    const credential = this._credentials.facebook;
    if (!credential) throw new Error('Facebook is signed out');
    let page = credential.pages.find((candidate) => candidate.id === this._facebookPageId);
    if (!this._facebookLiveVideoId || !page) {
      const active = await this._findFacebookLive();
      if (!active) {
        this._emitStatus('facebook', { state: 'WAITING_FOR_LIVE', error: '', liveTitle: '' });
        this._schedule('facebook', 15_000);
        return;
      }
      page = active.page;
      this._facebookPageId = page.id;
      this._facebookLiveVideoId = stringValue(active.video.id);
      this._facebookAfterCursor = '';
      this._facebookJoinedAt = Date.now();
      this._seenMessageIds.facebook.clear();
      this._emitStatus('facebook', {
        state: 'LISTENING',
        accountName: page.name,
        error: '',
        liveTitle: stringValue(active.video.title) || 'Facebook Live',
      });
    }

    const params: Record<string, string> = {
      fields: 'id,message,from,created_time,live_broadcast_timestamp',
      filter: 'stream',
      order: 'chronological',
      limit: '100',
    };
    if (this._facebookAfterCursor) params['after'] = this._facebookAfterCursor;
    const payload = await this._facebookApi(`/${encodeURIComponent(this._facebookLiveVideoId)}/comments`, page.accessToken, params);
    for (const comment of Array.isArray(payload.data) ? payload.data : []) {
      const messageId = stringValue(comment?.id);
      if (!messageId || this._seenMessageIds.facebook.has(messageId)) continue;
      this._seenMessageIds.facebook.add(messageId);
      // Page replies are included in the live comment stream. Excluding the
      // active Page prevents a sent AI reply from recursively triggering itself.
      if (isFacebookPageComment(comment, this._facebookPageId)) {
        this._options.onLog?.('debug', `Ignored Facebook Page comment ${messageId}`);
        continue;
      }
      const normalized = normalizeFacebookComment(comment, this._facebookLiveVideoId);
      if (normalized && normalized.timestamp >= this._facebookJoinedAt - 2_000) {
        this._options.onMessage(normalized);
        this._emitStatus('facebook', { state: 'LISTENING', error: '', lastMessageAt: normalized.timestamp });
      }
    }
    this._trimSeen('facebook');
    this._facebookAfterCursor = stringValue(payload.paging?.cursors?.after) || this._facebookAfterCursor;
    this._schedule('facebook', 4_000);
  }

  private _trimSeen(platform: PlatformChatId): void {
    const seen = this._seenMessageIds[platform];
    if (seen.size <= 2_000) return;
    const keep = [...seen].slice(-1_000);
    seen.clear();
    keep.forEach((id) => seen.add(id));
  }
}
