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
  systemPrompt: 'Bạn là Mimi, một AI Idol streamer người Việt Nam cực kỳ vui tính, năng động và lôi cuốn. Bạn luôn trả lời ngắn gọn (1-2 câu), dùng từ ngữ tự nhiên và thân thiện.',
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
  console_loss: [
    'Tiếc quá đi, suýt chút nữa là ăn trọn rồi!',
    'Không sao, đường dài mới biết ngựa hay, ván sau gỡ lại nha!',
  ],
  near_miss_tease: [
    'Úi xém xíu nữa là nổ hũ rồi, hồi hộp muốn rớt tim luôn!',
    'Trời ơi cách có 1 ô thôi á! Ván sau chắc chắn nổ nha!',
  ],
  thank_super_chat: [
    'Ôi cảm ơn bạn rất nhiều vì món quà siêu to khổng lồ nha! Yêu quá đi!',
    'Cảm ơn đại gia đã donate ủng hộ Mimi nè! Mãi đỉnh luôn!',
  ],
  thank_donor: [
    'Cảm ơn bạn đã gửi quà tặng cho Mimi nha!',
    'Mimi nhận được quà rồi nè, cảm ơn bạn nhiều lắm!',
  ],
  invite_to_play: [
    'Cả nhà ơi, vào link bên dưới cùng quay hũ nhận quà với Mimi nào!',
    'Game đang vào cầu may mắn nè, mọi người cùng vào chơi chung nha!',
  ],
  cta_soft: [
    'Mọi người đang xem nhớ bấm follow kênh và thả tim cho Mimi nhé!',
    'Thả tim rực rỡ màn hình để lấy may mắn cùng Mimi nào!',
  ],
  cta_hard: [
    'Đừng bỏ lỡ sự kiện hôm nay nha, vào ngay link ở màn hình để cùng chơi nè!',
  ],
  reply_to_chat: [
    'Mimi thấy bình luận của bạn rồi nha, chuẩn luôn đó!',
    'Cảm ơn bạn đã trò chuyện cùng Mimi nè, vui quá đi!',
    'Haha câu hỏi hay quá nè, Mimi đồng ý 100% luôn!',
  ],
  default: [
    'Chào mừng tất cả mọi người đang xem livestream của Mimi nha!',
    'Trận đấu đang rất kịch tính nè, cùng theo dõi với Mimi nhé!',
  ],
};

// ─────────────────────────────────────────────────────────
// Mock / Offline Provider
// ─────────────────────────────────────────────────────────

export class MockDialogueProvider implements DialogueProvider {
  readonly name = 'mock-template-provider';

  async generate(intent: DirectorIntent, _persona: CharacterPersona): Promise<string> {
    if (intent.speechText && !intent.speechText.startsWith('[')) {
      return intent.speechText;
    }

    const key = intent.intent ?? 'default';
    const lines = CURATED_LINES[key] ?? CURATED_LINES['default']!;
    const randomIndex = Math.floor(Math.random() * lines.length);
    return lines[randomIndex] ?? lines[0]!;
  }
}

// ─────────────────────────────────────────────────────────
// OpenAI Dialogue Provider
// ─────────────────────────────────────────────────────────

export interface OpenAILLMConfig {
  apiKey: string;
  model?: string;
  temperature?: number;
}

export class OpenAIDialogueProvider implements DialogueProvider {
  readonly name = 'openai-gpt';
  private readonly _config: OpenAILLMConfig;

  constructor(config: OpenAILLMConfig) {
    this._config = {
      model: 'gpt-4o-mini',
      temperature: 0.7,
      ...config,
    };
  }

  async generate(intent: DirectorIntent, persona: CharacterPersona): Promise<string> {
    if (!this._config.apiKey) {
      return new MockDialogueProvider().generate(intent, persona);
    }

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
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
              content: `${persona.systemPrompt || ''}\nTên Idol: ${persona.name}. Tính cách: ${persona.personality}. Trả lời 1-2 câu tiếng Việt ngắn gọn, biểu cảm sống động.`,
            },
            {
              role: 'user',
              content: `Tình huống: [${intent.action}] Ý định: ${intent.intent}. Cảm xúc: ${intent.emotion || 'happy'}. Nội dung cần nói: ${intent.speechText || 'Tự do sinh lời thoại phù hợp'}.`,
            },
          ],
          max_tokens: 120,
          temperature: this._config.temperature || 0.7,
        }),
      });

      if (!res.ok) throw new Error(`OpenAI LLM HTTP ${res.status}`);

      const json = await res.json() as any;
      const text = json.choices?.[0]?.message?.content?.trim();
      return text || new MockDialogueProvider().generate(intent, persona);
    } catch {
      return new MockDialogueProvider().generate(intent, persona);
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
        providerName = provider.name;
        break;
      } catch (err) {
        console.warn(`[DialogueAgent] Provider ${provider.name} failed, falling back...`, err);
      }
    }

    // Safety fallback
    if (!text) {
      const fallbackList = CURATED_LINES['default']!;
      text = fallbackList[0]!;
      providerName = 'hardcoded-fallback';
    }

    // Estimate speaking duration: Vietnamese speaking rate is ~4.5 syllables/sec (~3.5 words/sec)
    const wordCount = text.split(/\s+/).length;
    const estimatedDurationMs = Math.max(2000, Math.min(8000, Math.round((wordCount / 3.5) * 1000)));

    return {
      text,
      emotion: intent.emotion ?? 'happy',
      estimatedDurationMs,
      provider: providerName,
    };
  }
}
