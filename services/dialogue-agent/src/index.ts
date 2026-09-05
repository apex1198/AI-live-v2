/**
 * @idol/dialogue-agent
 *
 * Natural Language Dialogue Generator for Hybrid AI Idol.
 * Supports local Qwen and OpenAI-compatible dialogue providers.
 */

import type { DirectorIntent, Emotion } from '@idol/event-schema';

export interface CharacterPersona {
  name: string;
  streamName: string;
  personality: string;
  language: string;
  catchphrases: string[];
  systemPrompt?: string;
  sessionSkillMarkdown?: string;
}

export const DEFAULT_IDOL_PERSONA: CharacterPersona = {
  name: 'Mimi',
  streamName: 'Mimi Live Gaming',
  personality: 'Dễ thương, năng động, hài hước, thích tương tác và hay trêu người xem',
  language: 'Vietnamese',
  catchphrases: [
    'U là trời!',
    'Pha này đỉnh chóp nha!',
    'Mọi người thả tim cho Mimi với nè!',
    'Trúng đậm rồi anh em ơi!',
  ],
  systemPrompt: 'Bạn là Mimi, một AI Idol streamer người Việt Nam cực kỳ vui tính, năng động và lôi cuốn. Luôn trả lời bằng tiếng Việt tự nhiên, ngắn gọn trong 1-2 câu. Không tự chuyển sang tiếng Anh.',
  sessionSkillMarkdown: '',
};

export interface DialogueGenerationResult {
  /** Backwards-compatible alias for speechText. */
  text: string;
  /** Natural text intended for YouTube/Facebook chat and visual subtitles. */
  replyText: string;
  /** Speech-safe text intended exclusively for TTS. */
  speechText: string;
  emotion: Emotion;
  estimatedDurationMs: number;
  provider: string;
}

export interface DialogueProvider {
  name: string;
  generate(intent: DirectorIntent, persona: CharacterPersona): Promise<string>;
}

function personalizePersonaName(text: string, persona: CharacterPersona): string {
  const personaName = persona.name.trim() || DEFAULT_IDOL_PERSONA.name;
  return text.replace(/\bMimi\b/gi, personaName);
}

function isLikelyVietnamese(text: string): boolean {
  const normalized = ` ${text.toLowerCase()} `;
  return /[ăâđêôơưáàảãạấầẩẫậắằẳẵặéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i.test(text)
    || [' mình ', ' bạn ', ' mọi người ', ' cảm ơn ', ' chào ', ' nha ', ' nhé ', ' rồi ', ' ván ', ' game này ']
      .some(token => normalized.includes(token));
}

const VIETNAMESE_LETTER_NAMES: Record<string, string> = {
  A: 'a', B: 'bê', C: 'xê', D: 'đê', E: 'e', F: 'ép', G: 'giê', H: 'hát', I: 'i',
  J: 'giây', K: 'ca', L: 'eo', M: 'em', N: 'en', O: 'ô', P: 'pê', Q: 'quy', R: 'a-rờ',
  S: 'ét', T: 'tê', U: 'u', V: 'vê', W: 'vê kép', X: 'ích', Y: 'i dài', Z: 'dét',
};
const VIETNAMESE_DIGIT_NAMES: Record<string, string> = {
  '0': 'không', '1': 'một', '2': 'hai', '3': 'ba', '4': 'bốn',
  '5': 'năm', '6': 'sáu', '7': 'bảy', '8': 'tám', '9': 'chín',
};

/** Converts display-oriented LLM output into clean Vietnamese speech text for TTS. */
export function normalizeVietnameseSpokenText(input: string): string {
  return input
    .replace(/[`*_~#>|]/g, ' ')
    .replace(/[\p{Extended_Pictographic}\p{Symbol}]/gu, ' ')
    .replace(/\b[A-Z0-9-]{2,}\b/g, token => Array.from(token)
      .filter(char => char !== '-')
      .map(char => VIETNAMESE_LETTER_NAMES[char] || VIETNAMESE_DIGIT_NAMES[char] || char)
      .join(' '))
    .replace(/\b\d+\b/g, token => Array.from(token).map(char => VIETNAMESE_DIGIT_NAMES[char] || char).join(' '))
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const LIVE_REPLY_MAX_WORDS = 40;
const LIVE_REPLY_META_SENTENCE = /[^.!?]*(?:đã đọc hết\s+(?:các\s+)?(?:câu hỏi|bình luận)|sẽ lần lượt trả lời|không bỏ sót ai)[^.!?]*[.!?]?/giu;

function trimToWordBudget(input: string, maxWords = LIVE_REPLY_MAX_WORDS): string {
  const words = input.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) return input.trim();

  const sentences = input.match(/[^.!?]+[.!?]?/g)?.map(sentence => sentence.trim()).filter(Boolean) || [];
  const kept: string[] = [];
  let usedWords = 0;
  for (const sentence of sentences) {
    const sentenceWords = sentence.split(/\s+/).filter(Boolean).length;
    if (usedWords + sentenceWords > maxWords) break;
    kept.push(sentence);
    usedWords += sentenceWords;
  }
  if (kept.length) return kept.join(' ');
  return `${words.slice(0, maxWords).join(' ').replace(/[,.!?;:]+$/, '')}.`;
}

/** Removes non-spoken metadata and caps length without inventing extra dialogue. */
export function constrainLiveReply(input: string): string {
  const withoutMeta = input.replace(LIVE_REPLY_META_SENTENCE, ' ').replace(/\s+/g, ' ').trim();
  return trimToWordBudget(withoutMeta, LIVE_REPLY_MAX_WORDS);
}

// ─────────────────────────────────────────────────────────
// OpenAI Dialogue Provider
// ─────────────────────────────────────────────────────────

export interface OpenAILLMConfig {
  apiKey: string;
  model?: string;
  temperature?: number;
  baseUrl?: string;
  providerName?: string;
}

export class OpenAIDialogueProvider implements DialogueProvider {
  readonly name: string;
  private readonly _config: OpenAILLMConfig;

  constructor(config: OpenAILLMConfig) {
    this._config = {
      model: 'gpt-4o-mini',
      temperature: 0.7,
      ...config,
    };
    this.name = config.providerName || 'openai-gpt';
  }

  async generate(intent: DirectorIntent, persona: CharacterPersona): Promise<string> {
    if (!this._config.apiKey) {
      throw new Error('OpenAI dialogue provider is not configured');
    }

    try {
      const baseUrl = (this._config.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this._config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this._config.model || 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: `${persona.systemPrompt || ''}\n${persona.sessionSkillMarkdown || ''}\nTên Idol: ${persona.name}. Tính cách: ${persona.personality}. ${intent.intent === 'reply_to_chat_batch' ? 'Các bình luận đầu vào đã được tổng hợp theo đúng một người xem. Trả lời trực tiếp người đó bằng đúng 1 câu tự nhiên, không quá 40 từ, bao quát các ý quan trọng và không lặp lại từng bình luận. Không thêm câu xã giao để kéo dài. Không nói rằng bạn đã đọc bình luận, sẽ trả lời lần lượt hoặc sợ bỏ sót ai.' : 'Bắt buộc trả lời bằng tiếng Việt tự nhiên, ngắn gọn trong 1 đến 2 câu và không quá 40 từ.'} Giữ đúng cách xưng hô và cá tính của Idol. Đây là nội dung reply dạng chữ: giữ nguyên tên riêng, chữ viết tắt và mã; có thể dùng tối đa một emoji phù hợp. Chỉ trả về câu trả lời, không giải thích suy luận và không dùng Markdown.`,
            },
            {
              role: 'user',
              content: `Tình huống: [${intent.action}]. Ý định: ${intent.intent}. Cảm xúc: ${intent.emotion || 'happy'}. Nội dung cần phản hồi: ${intent.speechText || 'Tự sinh lời thoại phù hợp bằng tiếng Việt'}.`,
            },
          ],
          max_tokens: intent.intent === 'reply_to_chat_batch' ? 88 : 72,
          temperature: this._config.temperature || 0.7,
        }),
      });

      if (!res.ok) throw new Error(`OpenAI LLM HTTP ${res.status}`);

      const json = await res.json() as any;
      const text = json.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error(`${this.name} returned an empty response`);
      return text;
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}

// ─────────────────────────────────────────────────────────
// Gemini Dialogue Provider (Vertex AI + Google OAuth/ADC)
// ─────────────────────────────────────────────────────────

export interface GeminiLLMConfig {
  accessToken: () => Promise<string>;
  projectId: string;
  location?: string;
  model?: string;
  temperature?: number;
}

export class GeminiDialogueProvider implements DialogueProvider {
  readonly name = 'gemini-google';
  private readonly _config: Required<Omit<GeminiLLMConfig, 'accessToken'>> & Pick<GeminiLLMConfig, 'accessToken'>;

  constructor(config: GeminiLLMConfig) {
    this._config = {
      location: 'us-central1',
      model: 'gemini-2.5-pro',
      temperature: 0.7,
      ...config,
    };
  }

  async generate(intent: DirectorIntent, persona: CharacterPersona): Promise<string> {
    if (!this._config.projectId) throw new Error('Gemini needs a Google Cloud project ID');
    const accessToken = await this._config.accessToken();
    if (!accessToken) throw new Error('Google account is not connected for Gemini');

    const systemInstruction = `${persona.systemPrompt || ''}\n${persona.sessionSkillMarkdown || ''}\nTên Idol: ${persona.name}. ${intent.intent === 'reply_to_chat_batch' ? 'Các bình luận đầu vào đã được tổng hợp theo đúng một người xem. Trả lời trực tiếp người đó bằng đúng 1 câu tự nhiên, không quá 40 từ, bao quát các ý quan trọng và không lặp lại từng bình luận. Không thêm câu xã giao để kéo dài. Không nói rằng bạn đã đọc bình luận, sẽ trả lời lần lượt hoặc sợ bỏ sót ai.' : 'Chỉ trả lời bằng tiếng Việt tự nhiên, ngắn gọn 1 đến 2 câu và không quá 40 từ.'} Giữ đúng cách xưng hô và cá tính của Idol. Đây là nội dung reply dạng chữ: giữ nguyên tên riêng, chữ viết tắt và mã; có thể dùng tối đa một emoji phù hợp. Chỉ trả về câu trả lời, không giải thích suy luận và không dùng Markdown.`;
    const endpoint = `https://${this._config.location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(this._config.projectId)}/locations/${encodeURIComponent(this._config.location)}/publishers/google/models/${encodeURIComponent(this._config.model)}:generateContent`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{
          role: 'user',
          parts: [{ text: `Tình huống: [${intent.action}]. Ý định: ${intent.intent}. Cảm xúc: ${intent.emotion || 'happy'}. Nội dung cần phản hồi: ${intent.speechText || 'Tự sinh lời thoại phù hợp bằng tiếng Việt'}.` }],
        }],
        generationConfig: {
          maxOutputTokens: intent.intent === 'reply_to_chat_batch' ? 88 : 72,
          temperature: this._config.temperature,
        },
      }),
    });
    const payload = await response.json().catch(() => ({})) as any;
    if (!response.ok) {
      throw new Error(payload.error?.message || `Gemini HTTP ${response.status}`);
    }
    const text = payload.candidates?.[0]?.content?.parts
      ?.map((part: { text?: unknown }) => String(part?.text || ''))
      .join('')
      .trim();
    if (!text) throw new Error('Gemini returned an empty response');
    return text;
  }
}

export interface OllamaLLMConfig {
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
}

export class OllamaDialogueProvider implements DialogueProvider {
  readonly name = 'qwen';
  private readonly _config: Required<OllamaLLMConfig>;

  constructor(config: OllamaLLMConfig = {}) {
    this._config = {
      endpoint: config.endpoint || 'http://127.0.0.1:11434',
      model: config.model || 'qwen3:8b',
      timeoutMs: config.timeoutMs || 60_000,
    };
  }

  async generate(intent: DirectorIntent, persona: CharacterPersona): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this._config.timeoutMs);
    try {
      const response = await fetch(`${this._config.endpoint.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this._config.model,
          stream: false,
          think: false,
          messages: [
            {
              role: 'system',
              content: `${persona.systemPrompt || ''}\n${persona.sessionSkillMarkdown || ''}\nTên Idol: ${persona.name}. ${intent.intent === 'reply_to_chat_batch' ? 'Các bình luận đầu vào đã được tổng hợp theo đúng một người xem. Trả lời trực tiếp người đó bằng đúng 1 câu tự nhiên, không quá 40 từ, bao quát các ý quan trọng và không lặp lại từng bình luận. Không thêm câu xã giao để kéo dài. Không nói rằng bạn đã đọc bình luận, sẽ trả lời lần lượt hoặc sợ bỏ sót ai.' : 'Chỉ trả lời bằng tiếng Việt tự nhiên, ngắn gọn 1 đến 2 câu và không quá 40 từ.'} Giữ đúng cách xưng hô và cá tính của Idol. Đây là nội dung reply dạng chữ: giữ nguyên tên riêng, chữ viết tắt và mã; có thể dùng tối đa một emoji phù hợp. Chỉ trả về câu trả lời, không giải thích suy luận và không dùng Markdown.`,
            },
            {
              role: 'user',
              content: `Sự kiện: ${intent.action}. Ý định: ${intent.intent || 'reply_to_chat'}. Cảm xúc: ${intent.emotion || 'happy'}. Tin nhắn: ${intent.speechText || 'Hãy phản hồi phù hợp với livestream.'}`,
            },
          ],
          options: { temperature: 0.7, num_predict: intent.intent === 'reply_to_chat_batch' ? 88 : 72 },
        }),
      });
      if (!response.ok) throw new Error(`Ollama HTTP ${response.status}`);
      const payload = await response.json() as any;
      const text = String(payload.message?.content || '').trim();
      if (!text) throw new Error('Ollama returned an empty response');
      return text;
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ─────────────────────────────────────────────────────────
// Dialogue Agent Service
// ─────────────────────────────────────────────────────────

export class DialogueAgent {
  private _persona: CharacterPersona;
  private _providers: DialogueProvider[];
  private _activeProviderIndex = 0;

  constructor(options: {
    persona?: CharacterPersona;
    providers?: DialogueProvider[];
  } = {}) {
    this._persona = { ...DEFAULT_IDOL_PERSONA, ...(options.persona || {}) };
    this._providers = options.providers ?? [];
  }

  get persona(): CharacterPersona {
    return this._persona;
  }

  updatePersona(persona: Partial<CharacterPersona>): void {
    this._persona = { ...this._persona, ...persona };
  }

  setProviders(providers: DialogueProvider[]): void {
    this._providers = providers;
  }

  async generateDialogue(intent: DirectorIntent): Promise<DialogueGenerationResult> {
    let text = '';
    let providerName = '';

    for (let i = 0; i < this._providers.length; i++) {
      const provider = this._providers[(this._activeProviderIndex + i) % this._providers.length]!;
      try {
        text = (await provider.generate(intent, this._persona)).trim();
        if (!text) {
          console.warn(`[DialogueAgent] Provider ${provider.name} returned empty dialogue, falling back...`);
          continue;
        }
        if (this._persona.language.toLowerCase() === 'vietnamese' && !isLikelyVietnamese(text)) {
          console.warn(`[DialogueAgent] Provider ${provider.name} returned non-Vietnamese dialogue, falling back...`);
          text = '';
          continue;
        }
        providerName = provider.name;
        break;
      } catch (err) {
        console.warn(`[DialogueAgent] Provider ${provider.name} failed, falling back...`, err);
      }
    }

    if (!text) {
      throw new Error('AI Director returned no usable dialogue; TTS was skipped');
    }

    // Keep the platform reply and spoken reply as separate representations.
    // Chat keeps natural spelling and optional emoji; TTS receives a phonetic,
    // symbol-free version so display-oriented rules never leak into speech.
    let replyText = personalizePersonaName(text, this._persona).replace(/[`*_~#>|]/g, ' ').replace(/\s+/g, ' ').trim();
    if (intent.intent === 'reply_to_chat_batch') {
      replyText = constrainLiveReply(replyText);
    } else {
      replyText = trimToWordBudget(replyText);
    }
    if (!replyText) {
      throw new Error('AI Director reply was empty after text cleanup');
    }

    let speechText = normalizeVietnameseSpokenText(replyText);
    speechText = intent.intent === 'reply_to_chat_batch'
      ? constrainLiveReply(speechText)
      : trimToWordBudget(speechText);
    if (!speechText) {
      throw new Error('AI Director reply was empty after TTS cleanup; TTS was skipped');
    }

    // Estimate speaking duration: Vietnamese speaking rate is ~4.5 syllables/sec (~3.5 words/sec)
    const wordCount = speechText.split(/\s+/).filter(Boolean).length;
    const estimatedDurationMs = Math.max(2000, Math.min(12_000, Math.round((wordCount / 3.5) * 1000)));

    return {
      text: speechText,
      replyText,
      speechText,
      emotion: intent.emotion ?? 'happy',
      estimatedDurationMs,
      provider: providerName,
    };
  }
}
