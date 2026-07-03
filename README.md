# Aether — Air Instrument Studio 🎶

Play instruments out of thin air. Aether is a client-only, gesture-controlled
music studio: it tracks your hands through the webcam and turns them into a
**theremin**, a set of **air drums**, and an **air harp** — no MIDI controller,
no keyboard, no backend, no audio files. Everything is synthesized live in the
browser with the Web Audio API.

Built as a sibling to [Orb Catcher](../orb-catcher) — same Vite + TypeScript +
MediaPipe hand-tracking core, a different niche.

## Instruments

| Mode | How to play |
| --- | --- |
| 🎶 **Theremin** | Right-most hand sets **pitch** (left→right), left-most hand sets **volume** (raise to get louder). Toggle *snap-to-key* or a *continuous* glide, and pick the oscillator waveform. |
| 🥁 **Air Drums** | Five floating pads (kick, snare, hi-hat, tom, crash). **Strike** a pad with a quick downward motion of either hand. |
| 🎼 **Air Harp** | Eight glowing strings tuned to a pentatonic scale (always in key). **Sweep** a hand across them to pluck — fast sweeps = louder. |

Switch instruments hands-free: **hold a hand over a tab** at the top for ~0.7 s
and a dwell ring fills to confirm. (Keyboard `1` / `2` / `3` also switch; `S`
toggles theremin snap, `W` cycles the waveform.)

## Stack
- **Build:** Vite + vanilla TypeScript (no framework)
- **Rendering:** HTML5 Canvas (`requestAnimationFrame`), synthwave aesthetic
- **Hand tracking:** [`@mediapipe/tasks-vision`](https://www.npmjs.com/package/@mediapipe/tasks-vision)
  `HandLandmarker`, two hands, GPU delegate. WASM + the `hand_landmarker.task`
  model load from the jsDelivr CDN at runtime, so the build stays fully static.
- **Audio:** Web Audio API — oscillators, filters, a convolver reverb and a bus
  compressor, all synthesized at runtime (no asset files).

## Develop
```bash
npm install      # install deps
npm run dev      # dev server (needs webcam + audio permission)
npm run build    # tsc + vite build -> dist/ (static, deployable as-is)
npm run preview  # serve the production build locally
```

> First load downloads the MediaPipe WASM + model from the CDN, so give it a
> moment. Audio only starts after you click **Enter the Studio** (browser
> autoplay policy requires a real click to unlock the AudioContext).

## Deploy
Pushing to `main` builds and publishes to GitHub Pages via
`.github/workflows/deploy.yml`. The Vite `base` is set to `/aether/` for the
project-site sub-path.

## License
MIT
