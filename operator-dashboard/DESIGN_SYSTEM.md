# AI Idol Design System — DK Studio Operator Shell

## Direction

A focused desktop operator console for live production, aligned to the visual grammar of DK Studio: near-black macOS surfaces, a compact icon rail, quiet graphite panels, soft 14px geometry, SF system typography, and bright emerald reserved for actions, selection, and ready/live states. The monitor remains the visual anchor; cue and engine rails stay calm and scannable.

## Foundations

- Color: Canvas `#090c09`, chrome `#0d100d`, panel `#151815`, border `#282d28`, primary text `#f3f5f2`, secondary text `#a4aaa3`, and DK emerald `#71ef87`.
- Type: SF Pro/system sans for UI copy; tabular numerals only for clocks, latency, and measurements.
- Spacing: compact 4/8/12/16px rhythm with larger 20px separation between work areas.
- Shape: 10px controls and 14px panels; pills only for status tags and compact state labels.
- Elevation: one quiet border system. Shadows are reserved for drawers and modal focus, not normal panels.
- Icons: Material Symbols Rounded with clean geometry.

## Components

- Buttons: emerald filled primary action for Connect/Save, graphite secondary actions, icon buttons for repeat operator actions.
- Inputs: dark graphite fields with a 1px border and sage focus ring.
- Monitor: studio-grade black 16:9 viewport with a compact header and timeline row.
- Rails: cue stack first, then live control, then engine health. Each row uses a title, supporting state, and one short status/action affordance.

## UX Writing

- Verbs for actions: “Kết nối OBS”, “Lưu”, “Tải lên”, “Gửi”.
- Nouns for destinations: “Live”, “Live Settings”, “AI Director”, “Settings”.
- Direct, friendly Vietnamese tone tailored for livestream operators.

## Audit Contract

- `ui-kit.css` is the final visual authority. Legacy stylesheets remain only for structure and behavior compatibility.
- Action, selection, and ready/live use emerald; warning and error colors are reserved for actual runtime states.
- UI copy uses the Inter/system sans stack. Clocks, latency, IDs, and other measurements use a real monospace stack with tabular numerals.
- Spacing follows a compact `4 / 8 / 12 / 16 / 20px` rhythm. Controls use `32px` desktop density and `40px` mobile touch targets.
- Thumbnail media and operational metadata are separate regions. Format, active, duration, and live badges must never overlay the thumbnail.
- The deprecated Apple theme stylesheet is no longer loaded by the dashboard.
