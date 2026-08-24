/**
 * @idol/dialogue-agent
 *
 * Natural Language Dialogue Generator for Hybrid AI Idol.
 *
 * Rules (from PLAN.md):
 * - Generates natural language based on structured DirectorIntent.
 * - Keeps spoken responses concise (3-6 seconds speech length).
 * - Multi-provider (Mock / Gemini / OpenAI) with automatic offline fallback.
 * - Stream continues even if LLM service fails.
 */
export const DEFAULT_IDOL_PERSONA = {
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
};
// ─────────────────────────────────────────────────────────
// Curated Instant Dialogue Templates (Zero-latency fallback)
// ─────────────────────────────────────────────────────────
const CURATED_LINES = {
    celebrate_big_win: [
        'Trời ơi, trúng lớn thật rồi mọi người ơi! Đã quá đi mất!',
        'Pha này nổ to đỉnh chóp luôn! Mimi bảo rồi mà không ai tin!',
        'Úi giồi ôi, thắng đậm rồi cả nhà ơi, lộc tới lộc tới!',
    ],
    react_small_win: [
        'Có thêm điểm rồi nè, tích tiểu thành đại nha!',
        'Khởi sắc rồi đó, trận này tự tin lên nhé cả nhà!',
        'Hay quá, tiếp tục đà này thôi nào!',
    ],
    react_loss: [
        'Huhu xui xẻo một chút thôi, ván sau Mimi gỡ lại liền!',
        'Ái chà, suýt chút nữa là ăn rồi, không sao ván sau làm lại!',
        'Cay cú thật sự, mọi người buff may mắn cho Mimi đi!',
    ],
    thank_donation: [
        'Cảm ơn món quà siêu đáng yêu của bạn nha, yêu thương nhiều!',
        'Woa, Mimi cảm ơn bạn rất nhiều vì đã ủng hộ buổi live!',
        'Nhận được quà Mimi có thêm 200% năng lượng chiến tiếp luôn nè!',
    ],
    goal_invite_play: [
        'Mọi người ơi, vào game chơi chung với Mimi cho vui nè, phòng còn chỗ đó!',
        'Ai đang xem thì bấm link vào phòng quẩy cùng Mimi một ván nha!',
    ],
    goal_follow: [
        'Cả nhà đừng quên bấm follow và thả tim để nhận thông báo live của Mimi nhé!',
        'Thả cho Mimi một tim để lấy may mắn trúng hũ trận này nào!',
    ],
    goal_explain_game: [
        'Game này luật chơi siêu đơn giản mà thưởng thì cực to luôn, để Mimi chỉ cho nha!',
    ],
    goal_ask_chat_question: [
        'Mọi người hôm nay ăn tối chưa nè? Đang xem live ở đâu điểm danh Mimi xem!',
        'Dự đoán trận này Mimi ăn hay thua đây mọi người ơi, bình luận xem nào!',
    ],
    goal_cta: [
        'Cơ hội nhận quà tân thủ đang mở, anh em nhấp link dưới để nhận ngay nhé!',
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
export class MockDialogueProvider {
    name = 'mock-template-provider';
    async generate(intent, _persona) {
        if (intent.speechText && !intent.speechText.startsWith('[')) {
            return intent.speechText;
        }
        const key = intent.intent ?? 'default';
        const lines = CURATED_LINES[key] ?? CURATED_LINES['default'];
        const randomIndex = Math.floor(Math.random() * lines.length);
        return lines[randomIndex] ?? lines[0];
    }
}
// ─────────────────────────────────────────────────────────
// Dialogue Agent Service
// ─────────────────────────────────────────────────────────
export class DialogueAgent {
    _persona;
    _providers;
    _activeProviderIndex = 0;
    constructor(options = {}) {
        this._persona = options.persona ?? DEFAULT_IDOL_PERSONA;
        this._providers = options.providers ?? [new MockDialogueProvider()];
    }
    get persona() {
        return this._persona;
    }
    async generateDialogue(intent) {
        let text = '';
        let providerName = 'mock-fallback';
        for (let i = 0; i < this._providers.length; i++) {
            const provider = this._providers[(this._activeProviderIndex + i) % this._providers.length];
            try {
                text = await provider.generate(intent, this._persona);
                providerName = provider.name;
                break;
            }
            catch (err) {
                console.warn(`[DialogueAgent] Provider ${provider.name} failed, falling back...`, err);
            }
        }
        // Safety fallback
        if (!text) {
            const fallbackList = CURATED_LINES['default'];
            text = fallbackList[0];
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
//# sourceMappingURL=index.js.map