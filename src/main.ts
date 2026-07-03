import './style.css';
import { AudioEngine } from './audioEngine';
import { HandTracker } from './handTracker';
import { Studio } from './studio';

document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  const video = document.getElementById('webcam') as HTMLVideoElement;
  if (!canvas || !video) {
    console.error('Required DOM elements not found.');
    return;
  }

  const audio = new AudioEngine();
  const studio = new Studio(canvas, audio);
  const tracker = new HandTracker(video);

  // Dev-only handle for manual inspection without a physical webcam. Stripped
  // from production builds by Vite's dead-code elimination on import.meta.env.DEV.
  if (import.meta.env.DEV) (window as any).__aether = { studio, audio, tracker };

  const noteEl = document.getElementById('hud-note')!;
  const badge = document.getElementById('tracking-badge')!;
  const hud = document.getElementById('hud')!;

  // 1. Canvas sizing
  function resize() {
    studio.resize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener('resize', resize);
  resize();

  // 2. Studio → HUD
  studio.onNote = (label) => { noteEl.textContent = label; };

  // 3. Tracker → studio / HUD
  tracker.onLoaded = () => {
    badge.textContent = 'CAMERA ACTIVE';
    badge.className = 'badge badge-active';
  };

  tracker.onError = (err) => {
    console.error('Webcam / hand-tracker error:', err);
    badge.textContent = 'ERROR';
    badge.className = 'badge badge-error';
    const fallback = document.getElementById('error-fallback')!;
    fallback.classList.add('active');
    const msg = document.getElementById('error-message')!;
    msg.textContent = `Camera / hand-tracker initialization failed: ${err.message || err}.`;
  };

  tracker.onFPS = (fps) => {
    const el = document.getElementById('hud-track-fps')!;
    el.textContent = fps.toString().padStart(2, '0');
  };

  tracker.onFrame = (data) => {
    studio.setHands(data.hands, data.timestamp);
    if (data.hands.length > 0) {
      badge.textContent = 'TRACKING';
      badge.className = 'badge badge-active';
    } else {
      badge.textContent = 'NO HAND';
      badge.className = 'badge badge-loading';
    }
  };

  // 4. Render loop (runs immediately so the backdrop is live behind the modal)
  let last = performance.now();
  let frames = 0;
  let lastFpsUpdate = 0;
  function loop(timestamp: number) {
    const dt = timestamp - last;
    last = timestamp;
    studio.update(Math.min(100, dt));
    studio.draw();

    frames++;
    if (timestamp - lastFpsUpdate >= 1000) {
      const el = document.getElementById('hud-fps')!;
      el.textContent = Math.round((frames * 1000) / (timestamp - lastFpsUpdate)).toString().padStart(2, '0');
      frames = 0;
      lastFpsUpdate = timestamp;
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  // 5. Enter the studio (a real click unlocks the AudioContext)
  let started = false;
  const enterBtn = document.getElementById('enter-btn') as HTMLButtonElement;
  const startScreen = document.getElementById('start-screen')!;

  async function enter() {
    if (started) return;
    started = true;
    enterBtn.textContent = 'STARTING…';
    enterBtn.disabled = true;
    try {
      await audio.init();
    } catch (e) {
      console.error('Audio init failed:', e);
    }
    startScreen.classList.remove('active');
    hud.classList.remove('hidden');
    document.getElementById('status-bar')?.classList.remove('hidden');
    studio.begin();
    tracker.start();
  }
  enterBtn.addEventListener('click', enter);

  // 6. Keyboard convenience (hands-free is primary; these just mirror the tabs)
  window.addEventListener('keydown', (e) => {
    if (!started) return;
    switch (e.key.toLowerCase()) {
      case '1': studio.setMode('theremin'); break;
      case '2': studio.setMode('drums'); break;
      case '3': studio.setMode('harp'); break;
      case 's': studio.toggleSnap(); break;
      case 'w': studio.cycleWaveform(); break;
    }
  });
});
