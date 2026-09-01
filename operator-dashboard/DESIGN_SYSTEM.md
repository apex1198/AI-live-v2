# AI Idol Design System

## Direction

Material 3 structure with a CapCut-inspired workspace: medium graphite surfaces, restrained borders, white primary actions, a compact top toolbar, and one clear action per section.

## Foundations

- Color: black, graphite, white, and semantic error only. Use semantic roles (`primary`, `surface`, `on-surface`, `outline`, `error`) instead of component-specific colors.
- Type: 12px minimum supporting text; 14px body; 16–20px section titles; 24–32px page headings.
- Spacing: 4px base unit with an 8px rhythm. Main values: 8, 12, 16, 24, 32px.
- Shape: 8px controls, 12px buttons/navigation, 16px cards, 24px dialogs.
- Elevation: borders define normal surfaces; shadow is reserved for cards and dialogs.
- Icons: Material Symbols Rounded only. No emoji as UI decoration.

## Components

- Buttons: 36–40px desktop height; icon buttons at least 34px. One filled primary action per action group.
- Inputs: minimum 38px height, visible label, short placeholder, clear focus ring.
- Cards: concise title, optional one-line support text, actions aligned consistently.
- Navigation: no persistent sidebar in the core workspace. Put Avatar and Settings in the top toolbar; keep task controls next to their working surface.
- Dialogs: direct title, grouped fields, Cancel/Save actions. Avoid instructional paragraphs inside titles.
- Status: color never acts alone; pair the dot/color with a short text label.

## UX writing

- Use verbs for actions: “Phát live”, “Lưu”, “Tải lên”, “Thử giọng”.
- Use nouns for destinations: “Tổng quan”, “Avatar”, “Thư viện”, “Cài đặt”.
- Remove repeated technical detail when the surrounding section already provides context.
- Prefer one line, sentence case, and Vietnamese for operator-facing content.
- Keep technical model names only where the user makes a technical choice.
