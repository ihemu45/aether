# Aether — Design System

The styling source of truth for this project. Aesthetic: **synthwave / neon
retro-future** — a dark indigo void, a perspective grid horizon, and three neon
accents that glow. Everything is hands-free, so on-screen targets must be large,
high-contrast, and forgiving.

## Palette

| Token | Value | Use |
| --- | --- | --- |
| `--bg` | `#12002a` | Page background (void behind the dimmed webcam) |
| `--bg-tint` | `rgba(18, 0, 42, 0.55)` | Canvas overlay that dims the live webcam |
| `--magenta` | `#ff2e97` | Primary accent — volume hand, string A, headings |
| `--cyan` | `#05d9e8` | Secondary accent — pitch hand, active state |
| `--amber` | `#ffd319` | Tertiary accent — highlights, "now playing" note |
| `--violet` | `#a45cff` | Grid lines, secondary glow |
| `--text` | `#f4ecff` | Primary text |
| `--text-dim` | `#9a86c4` | Labels, secondary text |
| `--panel` | `rgba(28, 8, 54, 0.66)` | Panels / modals (glassy, blurred) |
| `--border` | `rgba(255, 255, 255, 0.10)` | Hairline borders |

Hand → color convention (keep in sync between CSS and canvas):
- **Pitch / right-most hand → cyan.**
- **Volume / left-most hand → magenta.**

## Typography
- Display / headings: **Orbitron** (700/900) — geometric, retro-future.
- Body / UI: **Outfit** (300/400/600).
- Mono (notes, FPS, badges): **Share Tech Mono**.
- Loaded from Google Fonts in `index.html`.

## Glow
Neon comes from layered `box-shadow` / `text-shadow` and canvas `shadowBlur`:
- Text glow: `0 0 12px <color>aa, 0 0 26px <color>55`.
- Border glow: `0 0 18px <color>33, inset 0 0 14px <color>14`.
- Canvas strokes use `shadowColor = <accent>` with `shadowBlur` 14–24.

## Layout
- Full-bleed: the mirrored webcam fills the viewport (`object-fit: cover`,
  `transform: scaleX(-1)`, dimmed). The instrument canvas sits on top.
- Top bar: logo (left), live note + FPS + tracking badge (right).
- Mode tabs and toggles are **drawn on the canvas** as hover-dwell targets, not
  HTML — so the dwell progress ring is part of the scene.
- Modals (start / error) are centered glass cards.

## Hands-free interaction
- **Hover-dwell** is the only "click": hold a hand over a target ~0.75 s; a ring
  fills, then it fires. The target must be re-armed (hand leaves) before it can
  fire again. Minimum target size ≈ 130×56 px.
- Dwell ring color = the target's accent; completed = amber.

## Motion
- 60 fps canvas render loop, decoupled from the ~30 fps tracking loop.
- Hits/plucks spawn short-lived particles + a ripple. String vibration is a
  decaying sine displacement. Keep particle counts modest (≤ 18 per hit).
- Webcam is **mirrored**; all hand coordinates are flipped to screen space
  (`x → 1 - x`) inside `handTracker`, so studio code is already screen-space.
