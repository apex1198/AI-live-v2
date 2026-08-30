/**
 * @idol/dialogue-agent
 *
 * Natural Language Dialogue Generator for Hybrid AI Idol.
 * Supports OpenAI GPT, Google Gemini, and Curated Offline Templates.
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
  text: string;
  emotion: Emotion;
  estimatedDurationMs: number;
  provider: string;
}

export interface DialogueProvider {
  name: string;
  generate(intent: DirectorIntent, persona: CharacterPersona): Promise<string>;
}

// ─────────────────────────────────────────────────────────
// Curated Instant Dialogue Templates (Zero-latency fallback)
// ─────────────────────────────────────────────────────────

const CURATED_LINES: Record<string, string[]> = {
  celebrate_big_win: [
    'Trời ơi, trúng lớn thật rồi mọi người ơi! Đã quá đi mất!',
    'Pha này nổ to đỉnh chóp luôn! Mimi bảo rồi mà không ai tin!',
    'Úi giồi ôi, thắng đậm rồi cả nhà ơi, lộc tới lộc tới!',
  ],
  react_small_win: [
    'Có thêm điểm rồi nè, tích tiểu thành đại nha!',
    'Khởi sắc rồi đó, trận này tự tin lên nhé cả nhà!',
  ],
  react_loss: [
    'Hơi xui một chút thôi, ván sau Mimi gỡ lại liền!',
    'Suýt chút nữa là ăn rồi, không sao ván sau làm lại nha!',
  ],
  console_loss: [
    'Tiếc quá đi, suýt chút nữa là ăn trọn rồi!',
    'Không sao, ván sau mình gỡ lại nha!',
  ],
  near_miss_tease: [
    'Úi xém chút nữa là nổ hũ rồi, hồi hộp muốn rớt tim luôn!',
    'Trời ơi cách có một ô thôi! Ván sau chắc chắn nổ nha!',
  ],
  thank_super_chat: [
    'Cảm ơn bạn rất nhiều vì món quà siêu to nha!',
    'Cảm ơn bạn đã donate ủng hộ Mimi nè!',
  ],
  thank_donor: [
    'Cảm ơn bạn đã gửi quà tặng cho Mimi nha!',
    'Mimi nhận được quà rồi nè, cảm ơn bạn nhiều lắm!',
  ],
  thank_donation: [
    'Cảm ơn món quà siêu đáng yêu của bạn nha!',
    'Mimi cảm ơn bạn rất nhiều vì đã ủng hộ buổi live!',
  ],
  invite_to_play: [
    'Cả nhà vào link bên dưới chơi cùng Mimi nha!',
    'Game đang vào cầu may mắn nè, mọi người cùng vào chơi chung nhé!',
  ],
  goal_invite_play: [
    'Mọi người vào game chơi chung với Mimi cho vui nè!',
    'Bấm link vào phòng chơi cùng Mimi một ván nha!',
  ],
  goal_follow: [
    'Cả nhà đừng quên bấm follow và thả tim cho Mimi nhé!',
    'Thả cho Mimi một tim để lấy may mắn trúng hũ nào!',
  ],
  goal_explain_game: [
    'Game này luật chơi đơn giản lắm, để Mimi chỉ cho nha!',
  ],
  goal_ask_chat_question: [
    'Mọi người đang xem live ở đâu, điểm danh với Mimi nha!',
    'Dự đoán ván này Mimi thắng hay thua nào mọi người ơi?',
  ],
  goal_cta: [
    'Quà tân thủ đang mở, mọi người nhấp link dưới để nhận nhé!',
    'Đừng bỏ lỡ sự kiện hôm nay, vào link trên màn hình để tham gia nha!',
  ],
  cta_soft: [
    'Mọi người nhớ bấm follow và thả tim cho Mimi nhé!',
    'Thả tim rực rỡ màn hình để lấy may mắn cùng Mimi nào!',
  ],
  cta_hard: [
    'Đừng bỏ lỡ sự kiện hôm nay nha, vào link trên màn hình để tham gia nhé!',
  ],
  reply_to_chat: [
    'Mimi thấy bình luận của bạn rồi nha, chuẩn luôn đó!',
    'Cảm ơn bạn đã trò chuyện cùng Mimi nè!',
    'Câu hỏi hay quá, Mimi đồng ý luôn!',
  ],
  default: [
    'Chào mừng mọi người đến với livestream của Mimi nha!',
    'Ván này đang rất kịch tính, cùng theo dõi với Mimi nhé!',
  ],
};

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

// ─────────────────────────────────────────────────────────
// Mock / Offline Provider
// ─────────────────────────────────────────────────────────

export class MockDialogueProvider implements DialogueProvider {
  readonly name = 'mock-fallback';

  async generate(intent: DirectorIntent, persona: CharacterPersona): Promise<string> {
    if (intent.intent === 'reply_to_chat_batch' && intent.speechText) {
      const entries = intent.speechText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (entries.length) {
        return entries.map((entry, index) => index === 0
          ? `${persona.name} thấy ${entry} rồi nha.`
          : `Còn ${entry} thì ${persona.name} trả lời là mình cùng theo dõi tiếp nha.`).join(' ');
      }
    }
    if (intent.speechText && !intent.speechText.startsWith('[')) {
      return personalizePersonaName(intent.speechText, persona);
    }

    const key = intent.intent ?? 'default';
    const lines = CURATED_LINES[key] ?? CURATED_LINES['default']!;
    const randomIndex = Math.floor(Math.random() * lines.length);
    return personalizePersonaName(lines[randomIndex] ?? lines[0]!, persona);
  }
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
              content: `${persona.systemPrompt || ''}\n${persona.sessionSkillMarkdown || ''}\nTên Idol: ${persona.name}. Tính cách: ${persona.personality}. ${intent.intent === 'reply_to_chat_batch' ? 'Hãy trả lời lần lượt nhiều bình luận trong cùng một đoạn nói tự nhiên, đủ nội dung cho khoảng 15 đến 20 giây.' : 'Bắt buộc trả lời bằng tiếng Việt tự nhiên, ngắn gọn trong 1 đến 2 câu.'} Có biểu cảm phù hợp. Chỉ viết lời để đọc thành tiếng, không dùng emoji, icon, Markdown hoặc ký hiệu trang trí. Viết chữ viết tắt và mã bằng phiên âm tiếng Việt.`,
            },
            {
              role: 'user',
              content: `Tình huống: [${intent.action}]. Ý định: ${intent.intent}. Cảm xúc: ${intent.emotion || 'happy'}. Nội dung cần phản hồi: ${intent.speechText || 'Tự sinh lời thoại phù hợp bằng tiếng Việt'}.`,
            },
          ],
          max_tokens: intent.intent === 'reply_to_chat_batch' ? 280 : 120,
          temperature: this._config.temperature || 0.7,
        }),
      });

      if (!res.ok) throw new Error(`OpenAI LLM HTTP ${res.status}`);

      const json = await res.json() as any;
      const text = json.choices?.[0]?.message?.content?.trim();
      return text || new MockDialogueProvider().generate(intent, persona);
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
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
              content: `${persona.systemPrompt || ''}\n${persona.sessionSkillMarkdown || ''}\nTên Idol: ${persona.name}. ${intent.intent === 'reply_to_chat_batch' ? 'Hãy trả lời lần lượt nhiều bình luận trong cùng một đoạn nói tự nhiên, đủ nội dung cho khoảng 15 đến 20 giây.' : 'Chỉ trả lời bằng tiếng Việt tự nhiên, ngắn gọn 1 đến 2 câu.'} Không giải thích suy luận. Chỉ viết lời để đọc thành tiếng, không dùng emoji, icon, Markdown hoặc ký hiệu trang trí. Viết chữ viết tắt và mã bằng phiên âm tiếng Việt.`,
            },
            {
              role: 'user',
              content: `Sự kiện: ${intent.action}. Ý định: ${intent.intent || 'reply_to_chat'}. Cảm xúc: ${intent.emotion || 'happy'}. Tin nhắn: ${intent.speechText || 'Hãy phản hồi phù hợp với livestream.'}`,
            },
          ],
          options: { temperature: 0.7, num_predict: intent.intent === 'reply_to_chat_batch' ? 280 : 120 },
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
    this._providers = options.providers ?? [new MockDialogueProvider()];
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
    let providerName = 'mock-fallback';

    for (let i = 0; i < this._providers.length; i++) {
      const provider = this._providers[(this._activeProviderIndex + i) % this._providers.length]!;
      try {
        text = await provider.generate(intent, this._persona);
        if (this._persona.language.toLowerCase() === 'vietnamese' && !isLikelyVietnamese(text)) {
          const { speechText: _ignoredSpeechText, ...fallbackIntent } = intent;
          text = await new MockDialogueProvider().generate(fallbackIntent, this._persona);
          providerName = 'mock-fallback';
          break;
        }
        providerName = provider.name;
        break;
      } catch (err) {
        console.warn(`[DialogueAgent] Provider ${provider.name} failed, falling back...`, err);
      }
    }

    // Safety fallback
    if (!text) {
      const fallbackList = CURATED_LINES['default']!;
      text = personalizePersonaName(fallbackList[0]!, this._persona);
      providerName = 'hardcoded-fallback';
    }

    // Estimate speaking duration: Vietnamese speaking rate is ~4.5 syllables/sec (~3.5 words/sec)
    text = normalizeVietnameseSpokenText(personalizePersonaName(text, this._persona));
    if (intent.intent === 'reply_to_chat_batch') {
      const batchWords = text.split(/\s+/).filter(Boolean);
      if (batchWords.length < 48) {
        text = `${text} ${this._persona.name} đã đọc hết các câu hỏi rồi nha, mọi người cứ nhắn tiếp, ${this._persona.name} sẽ lần lượt trả lời để không bỏ sót ai.`;
      }
      const boundedWords = text.split(/\s+/).filter(Boolean);
      if (boundedWords.length > 70) text = `${boundedWords.slice(0, 70).join(' ').replace(/[,.!?;:]+$/, '')}.`;
    }
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const estimatedDurationMs = Math.max(2000, Math.min(20_000, Math.round((wordCount / 3.5) * 1000)));

    return {
      text,
      emotion: intent.emotion ?? 'happy',
      estimatedDurationMs,
      provider: providerName,
    };
  }
}
