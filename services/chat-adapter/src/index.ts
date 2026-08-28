/**
 * @idol/chat-adapter
 *
 * Phase 5: Multi-Platform Live Chat Adapters & Smart Moderation
 * Handles live chat ingestion from YouTube, TikTok, Twitch with smart filtering,
 * spam prevention, sentiment detection, and priority scoring.
 */

import {
  ChatMessage,
  GiftEvent,
  DonationEvent,
  type ChatPlatform,
  type ViewerTier,
  type ChatSentiment,
  type ChatClassification,
} from '@idol/event-schema';

export interface FilterResult {
  allowed: boolean;
  classification: ChatClassification;
  sentiment: ChatSentiment;
  isQuestion: boolean;
  priorityScore: number; // 0 to 100
  reason?: string | undefined;
}

export class SmartChatFilter {
  private readonly _recentMessages: Array<{ text: string; sender: string; at: number }> = [];
  private readonly _bannedKeywords = [
    'scam', 'lua dao', 'hack', 'cheat', 'chui', 'dit', 'dm', 'cl', 'lon',
    'fuck', 'shit', 'bot', 'admin ngu', 'cho chet',
  ];
  private readonly _questionKeywords = [
    '?', 'sao', 'gì', 'gi', 'the nao', 'thế nào', 'bao gio', 'bao giờ',
    'link', 'o dau', 'ở đâu', 'huong dan', 'hướng dẫn', 'choi sao', 'chơi sao',
    'mimi oi', 'mimi ơi', 'em oi', 'em ơi', 'ten gi', 'tên gì',
  ];
  private readonly _positiveKeywords = [
    'hay', 'gioi', 'giỏi', 'xinh', 'de thuong', 'dễ thương', 'vui', 'chuc mung',
    'chúc mừng', 'dinh', 'đỉnh', 'pro', 'dep', 'đẹp', 'top 1', 'thang to', 'thắng to',
  ];

  /**
   * Evaluates a chat message and computes its classification, sentiment, and priority score.
   */
  filter(msg: { text: string; viewerName: string; isSuperChat?: boolean | undefined; isSubscriber?: boolean | undefined; viewerTier?: ViewerTier | undefined }): FilterResult {
    const textLower = msg.text.toLowerCase().trim();
    const now = Date.now();

    // Clean up history older than 30s
    while (this._recentMessages.length > 0 && (now - this._recentMessages[0]!.at) > 30_000) {
      this._recentMessages.shift();
    }

    // 1. Spam & Duplicate Check
    const duplicate = this._recentMessages.find(
      (m) => (m.text === textLower || m.sender === msg.viewerName) && (now - m.at) < 4000
    );
    if (duplicate && !msg.isSuperChat) {
      return {
        allowed: false,
        classification: 'IGNORE',
        sentiment: 'neutral',
        isQuestion: false,
        priorityScore: 0,
        reason: 'Rate limit / duplicate spam',
      };
    }

    // 2. Profanity / Moderation Check
    const hasBanned = this._bannedKeywords.some((k) => textLower.includes(k));
    if (hasBanned) {
      return {
        allowed: false,
        classification: 'MODERATION',
        sentiment: 'negative',
        isQuestion: false,
        priorityScore: 0,
        reason: 'Flagged inappropriate content',
      };
    }

    // Record valid message
    this._recentMessages.push({ text: textLower, sender: msg.viewerName, at: now });

    // 3. Question Detection
    const isQuestion = this._questionKeywords.some((k) => textLower.includes(k)) || textLower.includes('?');

    // 4. Sentiment Analysis
    let sentiment: ChatSentiment = 'neutral';
    if (isQuestion) {
      sentiment = 'question';
    } else if (this._positiveKeywords.some((k) => textLower.includes(k))) {
      sentiment = 'positive';
    }

    // 5. Compute Priority Score (0-100)
    let score = 40; // baseline for regular chat
    let classification: ChatClassification = 'ANSWER';

    if (msg.viewerTier === 'top_donor' || msg.viewerTier === 'vip') {
      score = 85;
      classification = 'PRIORITY_ANSWER';
    } else if (msg.isSubscriber || msg.viewerTier === 'subscriber') {
      score = 70;
    }

    if (isQuestion) {
      score = Math.min(95, score + 20);
    } else if (sentiment === 'positive') {
      score = Math.min(90, score + 10);
    }

    // SuperChat guaranteed max priority
    if (msg.isSuperChat) {
      score = 100;
      classification = 'PRIORITY_ANSWER';
    }

    // If message is too short or just emojis
    if (textLower.length <= 2 && !msg.isSuperChat) {
      classification = 'ACKNOWLEDGE';
      score = 25;
    }

    return {
      allowed: true,
      classification,
      sentiment,
      isQuestion,
      priorityScore: score,
    };
  }
}

export interface IChatPlatformAdapter {
  platform: ChatPlatform;
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(callback: (msg: ChatMessage) => void): void;
  onGift?(callback: (gift: GiftEvent) => void): void;
}

export class MockChatGenerator implements IChatPlatformAdapter {
  readonly platform: ChatPlatform = 'mock';
  readonly liveSessionId: string;
  private _interval: ReturnType<typeof setInterval> | null = null;
  private _listeners: Array<(msg: ChatMessage) => void> = [];
  private _giftListeners: Array<(gift: GiftEvent) => void> = [];

  constructor(liveSessionId = `mock_live_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`) {
    this.liveSessionId = liveSessionId;
  }

  private readonly _sampleViewers = [
    { name: 'Hoàng Anh', tier: 'vip' as ViewerTier, sub: true },
    { name: 'Ngọc Mai', tier: 'subscriber' as ViewerTier, sub: true },
    { name: 'Minh Tuấn', tier: 'regular' as ViewerTier, sub: false },
    { name: 'Quốc Bảo', tier: 'top_donor' as ViewerTier, sub: true },
    { name: 'Thanh Trúc', tier: 'regular' as ViewerTier, sub: false },
    { name: 'Duy Khánh', tier: 'regular' as ViewerTier, sub: false },
  ];

  private readonly _sampleMessages = [
    'Mimi ơi hôm nay xinh thế!',
    'Game này nổ hũ to không idol?',
    'Đánh vòng nữa đi Mimi ơi, cầu đang đẹp!',
    'Chào idol nha, chúc buổi stream vui vẻ!',
    'Link nhận quà ở đâu vậy Mimi?',
    'Vừa vào đã thấy nổ hũ rồi, đỉnh quá!',
    'Mimi chơi game này bao lâu rồi thế?',
    'Cố lên idol, sắp chạm mốc jackpot rồi!',
  ];

  async start(): Promise<void> {
    if (this._interval) return;
    this._interval = setInterval(() => {
      this.generateRandomChat();
    }, 4500);
  }

  async stop(): Promise<void> {
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  onMessage(callback: (msg: ChatMessage) => void): void {
    this._listeners.push(callback);
  }

  onGift(callback: (gift: GiftEvent) => void): void {
    this._giftListeners.push(callback);
  }

  generateRandomChat(): ChatMessage {
    const viewer = this._sampleViewers[Math.floor(Math.random() * this._sampleViewers.length)]!;
    const text = this._sampleMessages[Math.floor(Math.random() * this._sampleMessages.length)]!;
    const isSuperChat = Math.random() < 0.08;

    const msg: ChatMessage = {
      type: 'chat.message',
      platform: 'youtube',
      liveSessionId: this.liveSessionId,
      viewerId: `mock_${viewer.name.toLowerCase().replace(/\s+/g, '_')}`,
      viewerName: viewer.name,
      message: text,
      viewerTier: viewer.tier,
      isSuperChat,
      isSubscriber: viewer.sub,
      priorityScore: isSuperChat ? 100 : 50,
      isQuestion: text.includes('?'),
      timestamp: Date.now(),
    };

    for (const cb of this._listeners) cb(msg);
    return msg;
  }

  triggerGift(giftName: string = 'Rose', count: number = 1): GiftEvent {
    const viewer = this._sampleViewers[Math.floor(Math.random() * this._sampleViewers.length)]!;
    const gift: GiftEvent = {
      type: 'chat.gift',
      platform: 'tiktok',
      viewerId: `mock_${viewer.name.toLowerCase().replace(/\s+/g, '_')}`,
      viewerName: viewer.name,
      giftName,
      giftCount: count,
      diamondValue: count * 10,
      timestamp: Date.now(),
    };

    for (const cb of this._giftListeners) cb(gift);
    return gift;
  }
}

export class ChatManager {
  private readonly _filter: SmartChatFilter;
  private readonly _adapters: Map<ChatPlatform, IChatPlatformAdapter> = new Map();
  private readonly _messageListeners: Array<(msg: ChatMessage) => void> = [];
  private readonly _giftListeners: Array<(gift: GiftEvent) => void> = [];
  private readonly _donationListeners: Array<(donation: DonationEvent) => void> = [];

  constructor(filter = new SmartChatFilter()) {
    this._filter = filter;
  }

  registerAdapter(adapter: IChatPlatformAdapter): void {
    this._adapters.set(adapter.platform, adapter);
    adapter.onMessage((msg) => this.ingest(msg));
    if (adapter.onGift) {
      adapter.onGift((gift) => this.ingestGift(gift));
    }
  }

  onProcessedMessage(listener: (msg: ChatMessage) => void): () => void {
    this._messageListeners.push(listener);
    return () => {
      const idx = this._messageListeners.indexOf(listener);
      if (idx >= 0) this._messageListeners.splice(idx, 1);
    };
  }

  onGift(listener: (gift: GiftEvent) => void): () => void {
    this._giftListeners.push(listener);
    return () => {
      const idx = this._giftListeners.indexOf(listener);
      if (idx >= 0) this._giftListeners.splice(idx, 1);
    };
  }

  onDonation(listener: (donation: DonationEvent) => void): () => void {
    this._donationListeners.push(listener);
    return () => {
      const idx = this._donationListeners.indexOf(listener);
      if (idx >= 0) this._donationListeners.splice(idx, 1);
    };
  }

  /**
   * Ingests a raw chat message, runs smart filter, assigns score & sentiment, and emits.
   */
  ingest(rawMsg: Partial<ChatMessage> & { message: string; viewerName: string }): ChatMessage | null {
    const filterResult = this._filter.filter({
      text: rawMsg.message,
      viewerName: rawMsg.viewerName,
      isSuperChat: rawMsg.isSuperChat,
      isSubscriber: rawMsg.isSubscriber,
      viewerTier: rawMsg.viewerTier,
    });

    if (!filterResult.allowed) {
      return null;
    }

    const processed: ChatMessage = {
      type: 'chat.message',
      platform: rawMsg.platform || 'youtube',
      liveSessionId: rawMsg.liveSessionId,
      viewerId: rawMsg.viewerId || `user_${Date.now()}`,
      viewerName: rawMsg.viewerName,
      avatarUrl: rawMsg.avatarUrl,
      message: rawMsg.message,
      viewerTier: rawMsg.viewerTier || 'regular',
      isSuperChat: !!rawMsg.isSuperChat,
      isSubscriber: !!rawMsg.isSubscriber,
      sentiment: filterResult.sentiment,
      priorityScore: filterResult.priorityScore,
      isQuestion: filterResult.isQuestion,
      timestamp: rawMsg.timestamp || Date.now(),
    };

    for (const listener of this._messageListeners) {
      try {
        listener(processed);
      } catch (err) {
        console.error('[ChatManager] Error in listener:', err);
      }
    }

    return processed;
  }

  ingestGift(gift: GiftEvent): void {
    for (const listener of this._giftListeners) {
      try {
        listener(gift);
      } catch (err) {
        console.error('[ChatManager] Error in gift listener:', err);
      }
    }
  }

  ingestDonation(donation: DonationEvent): void {
    for (const listener of this._donationListeners) {
      try {
        listener(donation);
      } catch (err) {
        console.error('[ChatManager] Error in donation listener:', err);
      }
    }
  }

  async startAll(): Promise<void> {
    for (const adapter of this._adapters.values()) {
      await adapter.start();
    }
  }

  async stopAll(): Promise<void> {
    for (const adapter of this._adapters.values()) {
      await adapter.stop();
    }
  }
}
