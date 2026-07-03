# Aether

A client-only, gesture-controlled **air instrument studio** played with hand
tracking via the webcam. No keyboard (primary), no mouse, no backend. Sibling to
`../orb-catcher`, reusing its Vite + TS + MediaPipe core. **`design.md` is the
styling source of truth.**

## Stack
- **Build:** Vite + vanilla TypeScript (no framework)
- **Rendering:** HTML5 Canvas (`requestAnimationFrame`)
- **Hand tracking:** `@mediapipe/tasks-vision` (`HandLandmarker`, **two hands**,
  GPU delegate). WASM + the `hand_landmarker.task` model load from the jsDelivr
  CDN at runtime, so the build stays static.
- **Audio:** Web Audio API, fully synthesized at runtime (no asset files).

## Commands
```bash
npm install
npm run dev      # dev server on port 5181 (see .claude/launch.json); needs webcam + audio
npm run build    # tsc + vite build -> dist/
npm run preview  # serve the production build
```

## Architecture (`src/`)
- `main.ts` — entry point; wires the HUD, tracker, audio, and render loop. The
  **Enter the Studio** button click is what unlocks the AudioContext (autoplay
  policy) and starts the camera.
- `studio.ts` — the bulk of the logic. Render loop, the three instrument modes,
  hover-dwell UI buttons, drum hit-detection, harp string-cross detection, and
  all canvas drawing (synthwave background, hands, instruments, particles).
- `audioEngine.ts` — Web Audio graph: master gain → bus compressor → destination,
  a shared convolver reverb, the persistent theremin voice, and one-shot drum /
  pluck voices. Plus scale helpers (`midiToFreq`, `noteName`, `pentatonicLadder`).
- `handTracker.ts` — `getUserMedia` + MediaPipe inference loop for **two** hands.
  Emits screen-space, One-Euro-filtered hand data via `onFrame` every processed
  frame (including empty frames). Runs decoupled from the render loop.
- `oneEuroFilter.ts` — One-Euro adaptive smoothing (verbatim from orb-catcher).

## Interaction model
- **Pitch/role by screen position, not handedness label.** Hands are sorted
  left→right; right-most = theremin pitch, left-most = volume. MediaPipe
  handedness labels are unreliable under mirroring, so they're not used for roles
  (only `id` slots, for stable per-hand velocity).
- **Hover-dwell** is the only "click": hold a hand over a canvas button ~0.72 s
  (`DWELL`). A button must re-arm (hand leaves) before firing again.
- **Drums:** a pad fires when a hand is inside it *and* moving downward faster
  than `STRIKE_VEL`, throttled by `PAD_COOLDOWN`.
- **Harp:** a string plucks when a hand's x crosses the string's x, throttled by
  `STRING_COOLDOWN`. Pentatonic tuning means any sweep sounds musical.

## Conventions / gotchas
- The webcam is **mirrored** (CSS `transform: scaleX(-1)` on `#webcam`).
  `handTracker` flips landmark x (`1 - x`) so **all studio code is already in
  screen space** — do not flip again when drawing.
- Theme: synthwave. bg `#12002a`, magenta `#ff2e97`, cyan `#05d9e8`, amber
  `#ffd319`, violet `#a45cff`. Fonts (Orbitron, Outfit, Share Tech Mono) load
  from Google Fonts in `index.html`. Keep canvas font strings in sync with these.
- TS config is strict (`noUnusedLocals/Parameters`, `erasableSyntaxOnly`,
  `verbatimModuleSyntax`): use `import type` for types, no enums/namespaces/
  parameter-properties, prefix intentionally-unused params with `_`.
- Audio requires a user gesture — never try to start it from a webcam gesture.
- Verifying real playback needs a webcam + hands in frame; `npm run build` plus
  loading the dev server confirms it compiles and renders the start screen, but
  tracking/audio must be tested interactively.
```
