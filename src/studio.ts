import { AudioEngine, midiToFreq, noteName, pentatonicLadder } from './audioEngine';
import type { Waveform } from './audioEngine';
import { HAND_CONNECTIONS } from './handTracker';
import type { HandState } from './handTracker';

export type Mode = 'theremin' | 'drums' | 'harp';

const C = {
  magenta: '#ff2e97',
  cyan: '#05d9e8',
  amber: '#ffd319',
  violet: '#a45cff',
  kick: '#ff5d8f',
};

const DWELL = 0.65;          // seconds a hand must hover a target to fire it
const STRIKE_VEL = 1.4;      // downward velocity (screen-heights/sec) to hit a drum pad
const PAD_COOLDOWN = 150;    // ms between hits on one pad
const STRING_COOLDOWN = 90;  // ms between plucks of one string

interface DwellButton {
  id: string;
  label: string;
  sub?: string;
  x: number; y: number; w: number; h: number;       // visible rect (px)
  hitY: number; hitH: number;                         // hover hit-zone vertical span (px)
  accent: string;
  dwell: number;
  armed: boolean;
  isActive: () => boolean;
  onActivate: () => void;
}

interface Pad {
  id: string;
  label: string;
  color: string;
  x: number; y: number; w: number; h: number; // top-left + size, px
  flash: number;
  lastHit: number;
  trigger: () => void;
}

interface Strng {
  midi: number;
  x: number;            // normalized 0..1
  phase: number;
  amp: number;          // current vibration amplitude, px
  lastPluck: number;
  flashLabel: number;
  color: string;
}

interface Ripple { x: number; y: number; r: number; max: number; life: number; color: string; }
interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number; }

function hexToRgba(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * The "game" of Aether: a 60 fps canvas render loop plus the three instrument
 * modes. Interaction logic runs in `setHands` (driven by the tracker), animation
 * + drawing run in `update`/`draw` (driven by requestAnimationFrame) — same
 * decoupling as orb-catcher so the visuals stay smooth even if inference dips.
 */
export class Studio {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private audio: AudioEngine;

  private w = 0;
  private h = 0;
  private dpr = 1;

  mode: Mode = 'theremin';
  private started = false;

  private hands: HandState[] = [];
  private prev = new Map<number, { x: number; y: number; t: number }>();   // velocity, keyed by hand id
  private prevHarpX = new Map<number, number>();
  private lastTrackerT: number | null = null;

  private buttons: DwellButton[] = [];
  private pads: Pad[] = [];
  private strings: Strng[] = [];

  // theremin state
  private snap = true;
  private waveform: Waveform = 'sawtooth';
  private thLadder: number[];
  private thFreq = 220;
  private thVol = 0;
  private thT = 0.5;
  private thNoteLabel = '—';

  // fx
  private ripples: Ripple[] = [];
  private particles: Particle[] = [];
  private bgPhase = 0;
  private wavePhase = 0;

  onModeChange: ((m: Mode) => void) | null = null;
  onNote: ((label: string) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, audio: AudioEngine) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.audio = audio;
    this.thLadder = pentatonicLadder(57, 3); // A3 → A6, major pentatonic
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  begin(): void {
    this.started = true;
    this.layout();
    if (this.mode === 'theremin') this.audio.startTheremin(this.waveform);
    this.onModeChange?.(this.mode);
  }

  setMode(m: Mode): void {
    if (m === this.mode && this.started) return;
    if (this.started && this.mode === 'theremin' && m !== 'theremin') this.audio.stopTheremin();
    const was = this.mode;
    this.mode = m;
    this.layout();
    if (this.started && m === 'theremin' && was !== 'theremin') this.audio.startTheremin(this.waveform);
    this.thNoteLabel = '—';
    this.onNote?.('—');
    this.onModeChange?.(m);
  }

  toggleSnap(): void {
    this.snap = !this.snap;
    const b = this.buttons.find(btn => btn.id === 'snap');
    if (b) b.sub = this.snap ? 'SNAP TO KEY' : 'CONTINUOUS';
  }

  cycleWaveform(): void {
    const order: Waveform[] = ['sawtooth', 'sine', 'triangle', 'square'];
    const next = order[(order.indexOf(this.waveform) + 1) % order.length];
    this.waveform = next;
    this.audio.setThereminWaveform(next);
    const b = this.buttons.find(btn => btn.id === 'wave');
    if (b) b.sub = next.toUpperCase();
  }

  // ── layout (recomputed on resize / mode change) ────────────────────────────

  resize(w: number, h: number): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = w;
    this.h = h;
    this.canvas.width = Math.floor(w * this.dpr);
    this.canvas.height = Math.floor(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.layout();
  }

  private layout(): void {
    const mk = (
      id: string, label: string, sub: string | undefined,
      x: number, y: number, w: number, h: number, accent: string,
      hitY: number, hitH: number,
      isActive: () => boolean, onActivate: () => void
    ): DwellButton => ({ id, label, sub, x, y, w, h, hitY, hitH, accent, dwell: 0, armed: true, isActive, onActivate });

    const buttons: DwellButton[] = [];

    // Instrument tabs, centered just below the HUD bar. The visible tab is a
    // slim bar near the top, but the *hover* hit-zone extends well downward
    // (to ~22% of the height) so you only have to raise a hand into the upper
    // area over a tab — not pin it to a pixel-thin strip at the frame edge,
    // where tracking is unreliable.
    const gap = 12;
    // Keep clear of the top corners (logo left, note readout right).
    const totalW = Math.max(320, Math.min(600, this.w - 360));
    const tabW = (totalW - gap * 2) / 3;
    const tabH = 56;
    let x = (this.w - totalW) / 2;
    const y = 78;
    const hitBottom = Math.max(y + tabH, this.h * 0.22);
    const tabs = [
      ['theremin', 'THEREMIN', C.cyan],
      ['drums', 'DRUMS', C.magenta],
      ['harp', 'HARP', C.amber],
    ] as const;
    for (const [id, label, accent] of tabs) {
      const modeVal = id as Mode;
      buttons.push(mk(id, label, undefined, x, y, tabW, tabH, accent, 0, hitBottom,
        () => this.mode === modeVal, () => this.setMode(modeVal)));
      x += tabW + gap;
    }

    // Theremin-only toggles, centered along the bottom. Their hover zone extends
    // upward toward the toggles from the bottom edge for the same reachability.
    if (this.mode === 'theremin') {
      const bw = 168, bh = 56, g = 12;
      const tw = bw * 2 + g;
      let bx = (this.w - tw) / 2;
      const by = this.h - 84;
      const tHitY = this.h * 0.80;
      const tHitH = this.h - tHitY;
      buttons.push(mk('snap', 'SCALE', this.snap ? 'SNAP TO KEY' : 'CONTINUOUS',
        bx, by, bw, bh, C.cyan, tHitY, tHitH, () => this.snap, () => this.toggleSnap()));
      bx += bw + g;
      buttons.push(mk('wave', 'WAVE', this.waveform.toUpperCase(),
        bx, by, bw, bh, C.violet, tHitY, tHitH, () => false, () => this.cycleWaveform()));
    }

    this.buttons = buttons;
    this.layoutPads();
    this.layoutStrings();
  }

  private layoutPads(): void {
    if (this.mode !== 'drums') { this.pads = []; return; }
    const W = this.w, H = this.h;
    const def = [
      { id: 'crash', label: 'CRASH', cx: 0.20, cy: 0.36, w: 0.20, h: 0.22, color: C.amber, trigger: () => this.audio.crash() },
      { id: 'hat', label: 'HI-HAT', cx: 0.80, cy: 0.36, w: 0.20, h: 0.22, color: C.cyan, trigger: () => this.audio.hat(false) },
      { id: 'snare', label: 'SNARE', cx: 0.31, cy: 0.60, w: 0.22, h: 0.22, color: C.magenta, trigger: () => this.audio.snare() },
      { id: 'tom', label: 'TOM', cx: 0.69, cy: 0.60, w: 0.22, h: 0.22, color: C.violet, trigger: () => this.audio.tom(150) },
      { id: 'kick', label: 'KICK', cx: 0.50, cy: 0.82, w: 0.32, h: 0.22, color: C.kick, trigger: () => this.audio.kick() },
    ];
    this.pads = def.map(d => ({
      id: d.id, label: d.label, color: d.color, trigger: d.trigger,
      x: (d.cx - d.w / 2) * W, y: (d.cy - d.h / 2) * H, w: d.w * W, h: d.h * H,
      flash: 0, lastHit: 0,
    }));
  }

  private layoutStrings(): void {
    if (this.mode !== 'harp') { this.strings = []; return; }
    const ladder = pentatonicLadder(57, 2).slice(0, 8); // A3 major pentatonic, 8 strings
    const n = ladder.length;
    const colors = [C.magenta, C.violet, C.cyan, C.amber];
    this.strings = ladder.map((midi, i) => ({
      midi,
      x: 0.10 + (i / (n - 1)) * 0.80,
      phase: 0, amp: 0, lastPluck: 0, flashLabel: 0,
      color: colors[i % colors.length],
    }));
  }

  // ── interaction (driven by the tracker) ─────────────────────────────────────

  setHands(hands: HandState[], timestamp: number): void {
    this.hands = hands;
    const tSec = timestamp / 1000;

    // Per-hand velocity (keyed by stable slot id).
    const vel = new Map<number, { vx: number; vy: number }>();
    for (const hnd of hands) {
      const p = this.prev.get(hnd.id);
      if (p) {
        const dt = Math.max(0.001, tSec - p.t);
        vel.set(hnd.id, { vx: (hnd.x - p.x) / dt, vy: (hnd.y - p.y) / dt });
      } else {
        vel.set(hnd.id, { vx: 0, vy: 0 });
      }
      this.prev.set(hnd.id, { x: hnd.x, y: hnd.y, t: tSec });
    }
    const present = new Set(hands.map(h => h.id));
    for (const id of [...this.prev.keys()]) if (!present.has(id)) this.prev.delete(id);

    // Dwell buttons use wall-clock dt between tracker frames.
    const dwellDt = this.lastTrackerT === null ? 0 : Math.max(0, Math.min(0.1, tSec - this.lastTrackerT));
    this.lastTrackerT = tSec;
    this.updateButtons(dwellDt);

    if (!this.started) return;

    if (this.mode === 'theremin') this.updateTheremin();
    else if (this.mode === 'drums') this.updateDrums(vel, timestamp);
    else this.updateHarp(timestamp);
  }

  private updateButtons(dt: number): void {
    for (const b of this.buttons) {
      let hovered = false;
      for (const hnd of this.hands) {
        const px = hnd.x * this.w, py = hnd.y * this.h;
        if (px >= b.x && px <= b.x + b.w && py >= b.hitY && py <= b.hitY + b.hitH) { hovered = true; break; }
      }
      if (hovered && b.armed) {
        b.dwell += dt;
        if (b.dwell >= DWELL) { b.armed = false; b.dwell = 0; b.onActivate(); }
      } else if (!hovered) {
        b.dwell = Math.max(0, b.dwell - dt * 2);
        if (b.dwell <= 0) b.armed = true;
      }
    }
  }

  private updateTheremin(): void {
    if (this.hands.length === 0) {
      this.thVol = 0;
      this.audio.setTheremin(this.thFreq, 0);
      if (this.thNoteLabel !== '—') { this.thNoteLabel = '—'; this.onNote?.('—'); }
      return;
    }
    const pitchHand = this.hands[this.hands.length - 1]; // right-most
    let vol: number;
    if (this.hands.length >= 2) {
      const volHand = this.hands[0]; // left-most: higher hand = louder
      vol = clamp01((0.95 - volHand.y) / 0.8) * 0.9;
    } else {
      vol = 0.55;
    }

    const t = clamp01((pitchHand.x - 0.08) / 0.84);
    this.thT = t;
    const len = this.thLadder.length;
    let freq: number, label: string;
    if (this.snap) {
      const midi = this.thLadder[Math.round(t * (len - 1))];
      freq = midiToFreq(midi);
      label = noteName(midi);
    } else {
      const lo = this.thLadder[0], hi = this.thLadder[len - 1];
      const midi = lo + t * (hi - lo);
      freq = midiToFreq(midi);
      label = noteName(midi);
    }

    this.thFreq = freq;
    this.thVol = vol;
    if (label !== this.thNoteLabel) { this.thNoteLabel = label; this.onNote?.(label); }
    this.audio.setTheremin(freq, vol);
  }

  private updateDrums(vel: Map<number, { vx: number; vy: number }>, timestamp: number): void {
    for (const hnd of this.hands) {
      const v = vel.get(hnd.id);
      if (!v || v.vy < STRIKE_VEL) continue; // must be a fast downward strike
      const px = hnd.x * this.w, py = hnd.y * this.h;
      for (const pad of this.pads) {
        if (px >= pad.x && px <= pad.x + pad.w && py >= pad.y && py <= pad.y + pad.h) {
          if (timestamp - pad.lastHit > PAD_COOLDOWN) {
            pad.lastHit = timestamp;
            pad.flash = 1;
            pad.trigger();
            this.ripples.push({ x: px, y: py, r: 8, max: pad.w * 0.65, life: 1, color: pad.color });
            this.spawnBurst(px, py, pad.color, Math.min(1.6, v.vy));
          }
          break;
        }
      }
    }
  }

  private updateHarp(timestamp: number): void {
    for (const hnd of this.hands) {
      const prevX = this.prevHarpX.get(hnd.id);
      const x = hnd.x;
      if (prevX !== undefined) {
        for (const s of this.strings) {
          const a = prevX - s.x;
          const b = x - s.x;
          if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) { // crossed this string
            if (timestamp - s.lastPluck > STRING_COOLDOWN) {
              s.lastPluck = timestamp;
              const velocity = Math.min(1, Math.abs(x - prevX) * 12 + 0.3);
              this.audio.pluck(midiToFreq(s.midi), velocity);
              s.amp = 18 * velocity;
              s.phase = 0;
              s.flashLabel = 1;
              this.spawnBurst(s.x * this.w, hnd.y * this.h, s.color, velocity);
            }
          }
        }
      }
      this.prevHarpX.set(hnd.id, x);
    }
    const present = new Set(this.hands.map(h => h.id));
    for (const id of [...this.prevHarpX.keys()]) if (!present.has(id)) this.prevHarpX.delete(id);
  }

  private spawnBurst(x: number, y: number, color: string, intensity: number): void {
    const n = Math.round(8 + intensity * 8);
    for (let i = 0; i < n; i++) {
      const ang = Math.random() * Math.PI * 2;
      const spd = 80 + Math.random() * 220 * intensity;
      this.particles.push({
        x, y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 60,
        life: 0.5 + Math.random() * 0.3,
        max: 0.8,
        color,
        size: 2 + Math.random() * 2.5,
      });
    }
  }

  // ── animation (driven by the render loop) ───────────────────────────────────

  update(dtMs: number): void {
    const s = dtMs / 1000;
    this.bgPhase += s * 0.25;
    this.wavePhase += s * (4 + this.thFreq * 0.02);

    for (const r of this.ripples) { r.r += s * r.max * 2.2; r.life -= s * 1.8; }
    this.ripples = this.ripples.filter(r => r.life > 0);

    for (const p of this.particles) { p.x += p.vx * s; p.y += p.vy * s; p.vy += 900 * s; p.life -= s; }
    this.particles = this.particles.filter(p => p.life > 0);

    for (const pad of this.pads) pad.flash = Math.max(0, pad.flash - s * 3.2);
    for (const st of this.strings) {
      st.phase += s * 42;
      st.amp = Math.max(0, st.amp - s * 36);
      st.flashLabel = Math.max(0, st.flashLabel - s * 1.4);
    }
  }

  // ── drawing ──────────────────────────────────────────────────────────────

  draw(): void {
    const ctx = this.ctx, w = this.w, h = this.h;
    ctx.clearRect(0, 0, w, h);
    this.drawBackground();
    if (this.mode === 'theremin') this.drawTheremin();
    else if (this.mode === 'drums') this.drawDrums();
    else this.drawHarp();
    this.drawRipples();
    this.drawHands();
    this.drawParticles();
    this.drawButtons();
    this.drawInstructions();
  }

  private drawInstructions(): void {
    const ctx = this.ctx, w = this.w, h = this.h;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // How to switch instruments (just below the tabs).
    ctx.font = '12px "Share Tech Mono", monospace';
    ctx.fillStyle = 'rgba(244, 236, 255, 0.5)';
    ctx.fillText('✋ RAISE A HAND OVER A TAB & HOLD TO SWITCH   ·   OR PRESS  1  2  3', w / 2, 158);

    // How to play the current instrument.
    let hint: string;
    if (this.mode === 'theremin') hint = 'RIGHT HAND → PITCH        LEFT HAND → VOLUME (raise to get louder)';
    else if (this.mode === 'drums') hint = 'STRIKE A PAD WITH A QUICK DOWNWARD MOTION OF EITHER HAND';
    else hint = 'SWEEP A HAND ACROSS THE STRINGS TO PLUCK — always in key';
    const hy = this.mode === 'theremin' ? h - 116 : h - 38;
    ctx.font = '600 14px Outfit, sans-serif';
    ctx.fillStyle = 'rgba(244, 236, 255, 0.66)';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 6;
    ctx.fillText(hint, w / 2, hy);
    ctx.restore();
  }

  private drawBackground(): void {
    const ctx = this.ctx, w = this.w, h = this.h;
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, 'rgba(18, 0, 42, 0.30)');
    g.addColorStop(1, 'rgba(8, 0, 20, 0.72)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // synthwave perspective floor
    ctx.save();
    ctx.strokeStyle = hexToRgba(C.violet, 0.14);
    ctx.lineWidth = 1;
    const horizon = h * 0.66;
    const vanish = w / 2;
    for (let i = -12; i <= 12; i++) {
      ctx.beginPath();
      ctx.moveTo(vanish + i * (w * 0.012), horizon);
      ctx.lineTo(vanish + i * (w * 0.095), h);
      ctx.stroke();
    }
    for (let j = 0; j < 12; j++) {
      const t = (j + (this.bgPhase % 1)) / 12;
      const yy = horizon + t * t * (h - horizon);
      ctx.globalAlpha = t;
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(w, yy);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.restore();

    // vignette
    const rg = ctx.createRadialGradient(w / 2, h * 0.45, h * 0.2, w / 2, h * 0.5, h * 0.9);
    rg.addColorStop(0, 'rgba(0, 0, 0, 0)');
    rg.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
    ctx.fillStyle = rg;
    ctx.fillRect(0, 0, w, h);
  }

  private drawTheremin(): void {
    const ctx = this.ctx, w = this.w, h = this.h;
    const len = this.thLadder.length;

    // scale guide ticks
    ctx.save();
    for (let i = 0; i < len; i++) {
      const x = (0.08 + (i / (len - 1)) * 0.84) * w;
      const active = this.snap && Math.round(this.thT * (len - 1)) === i;
      ctx.strokeStyle = active ? hexToRgba(C.amber, 0.9) : hexToRgba(C.cyan, 0.16);
      ctx.lineWidth = active ? 2.5 : 1;
      ctx.beginPath();
      ctx.moveTo(x, h * 0.30);
      ctx.lineTo(x, h * 0.74);
      ctx.stroke();
    }
    ctx.restore();

    // waveform
    const cy = h * 0.52;
    const amp = this.thVol * (h * 0.17) + (this.thVol > 0 ? 4 : 0);
    const cycles = Math.max(3, Math.min(60, this.thFreq / 40));
    ctx.save();
    ctx.strokeStyle = hexToRgba(C.cyan, 0.9);
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    ctx.shadowColor = C.cyan;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    for (let x = 0; x <= w; x += 4) {
      const yv = cy + amp * Math.sin((x / w) * cycles * Math.PI * 2 + this.wavePhase);
      if (x === 0) ctx.moveTo(x, yv); else ctx.lineTo(x, yv);
    }
    ctx.stroke();
    ctx.restore();

    // big note label near the pitch hand
    if (this.hands.length > 0) {
      const x = this.hands[this.hands.length - 1].x * w;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.fillStyle = hexToRgba(C.amber, 0.95);
      ctx.shadowColor = C.amber;
      ctx.shadowBlur = 14;
      ctx.font = '900 46px Orbitron, sans-serif';
      ctx.fillText(this.thNoteLabel, Math.max(70, Math.min(w - 70, x)), h * 0.24);
      ctx.restore();
    }

    // volume meter (left edge)
    const mh = h * 0.5, mx = 26, my = h * 0.25;
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
    this.roundRect(mx, my, 12, mh, 6);
    ctx.fill();
    const vh = mh * Math.min(1, this.thVol / 0.9);
    if (vh > 1) {
      const grad = ctx.createLinearGradient(0, my + mh - vh, 0, my + mh);
      grad.addColorStop(0, C.magenta);
      grad.addColorStop(1, C.violet);
      ctx.fillStyle = grad;
      this.roundRect(mx, my + mh - vh, 12, vh, 6);
      ctx.fill();
    }
    ctx.restore();
  }

  private drawDrums(): void {
    const ctx = this.ctx;
    for (const pad of this.pads) {
      const cx = pad.x + pad.w / 2, cy = pad.y + pad.h / 2;
      const scale = 1 + pad.flash * 0.05;
      const pw = pad.w * scale, ph = pad.h * scale;
      const x = cx - pw / 2, y = cy - ph / 2;

      ctx.save();
      this.roundRect(x, y, pw, ph, 18);
      ctx.fillStyle = hexToRgba(pad.color, 0.08 + pad.flash * 0.45);
      ctx.fill();
      ctx.lineWidth = 2 + pad.flash * 3;
      ctx.strokeStyle = hexToRgba(pad.color, 0.55 + pad.flash * 0.45);
      ctx.shadowColor = pad.color;
      ctx.shadowBlur = 8 + pad.flash * 26;
      ctx.stroke();
      ctx.shadowBlur = 0;

      ctx.fillStyle = hexToRgba('#f4ecff', 0.85 + pad.flash * 0.15);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '700 20px Orbitron, sans-serif';
      ctx.fillText(pad.label, cx, cy);
      ctx.restore();
    }
  }

  private drawHarp(): void {
    const ctx = this.ctx, w = this.w, h = this.h;
    const y0 = h * 0.12, y1 = h * 0.95;
    for (const s of this.strings) {
      const baseX = s.x * w;
      ctx.save();
      ctx.strokeStyle = hexToRgba(s.color, 0.35 + Math.min(0.5, s.amp / 20 * 0.5));
      ctx.lineWidth = 2 + Math.min(3, s.amp / 8);
      ctx.shadowColor = s.color;
      ctx.shadowBlur = 6 + Math.min(20, s.amp);
      ctx.beginPath();
      const steps = 22;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const yy = y0 + (y1 - y0) * t;
        const env = Math.sin(t * Math.PI); // 0 at the anchored ends, 1 in the middle
        const xx = baseX + s.amp * env * Math.sin(s.phase + t * Math.PI * 1.5);
        if (i === 0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
      }
      ctx.stroke();
      ctx.restore();

      if (s.flashLabel > 0) {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.globalAlpha = Math.min(1, s.flashLabel);
        ctx.fillStyle = s.color;
        ctx.shadowColor = s.color;
        ctx.shadowBlur = 12;
        ctx.font = '700 16px Orbitron, sans-serif';
        ctx.fillText(noteName(s.midi), baseX, y0 - 10);
        ctx.restore();
      }
    }
  }

  private drawHands(): void {
    const ctx = this.ctx, w = this.w, h = this.h;
    const total = this.hands.length;
    this.hands.forEach((hnd, i) => {
      const isRight = i === total - 1;
      const color = this.mode === 'theremin'
        ? (isRight ? C.cyan : C.magenta)
        : (i % 2 === 0 ? C.magenta : C.cyan);

      // skeleton
      ctx.save();
      ctx.strokeStyle = hexToRgba(color, 0.3);
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (const [a, b] of HAND_CONNECTIONS) {
        const p1 = hnd.landmarks[a], p2 = hnd.landmarks[b];
        ctx.moveTo(p1.x * w, p1.y * h);
        ctx.lineTo(p2.x * w, p2.y * h);
      }
      ctx.stroke();
      ctx.restore();

      // centroid cursor
      const cx = hnd.x * w, cy = hnd.y * h;
      ctx.save();
      ctx.shadowColor = color;
      ctx.shadowBlur = 24;
      ctx.fillStyle = hexToRgba(color, 0.9);
      ctx.beginPath();
      ctx.arc(cx, cy, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = hexToRgba(color, 0.5);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    });
  }

  private drawRipples(): void {
    const ctx = this.ctx;
    for (const r of this.ripples) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, r.life);
      ctx.strokeStyle = r.color;
      ctx.lineWidth = 2;
      ctx.shadowColor = r.color;
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  private drawParticles(): void {
    const ctx = this.ctx;
    for (const p of this.particles) {
      ctx.save();
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  private drawButtons(): void {
    const ctx = this.ctx;
    for (const b of this.buttons) {
      const active = b.isActive();
      ctx.save();
      this.roundRect(b.x, b.y, b.w, b.h, 12);
      if (active) {
        ctx.fillStyle = hexToRgba(b.accent, 0.9);
        ctx.shadowColor = b.accent;
        ctx.shadowBlur = 20;
        ctx.fill();
        ctx.shadowBlur = 0;
      } else {
        ctx.fillStyle = 'rgba(20, 4, 40, 0.6)';
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = hexToRgba(b.accent, 0.7);
        ctx.stroke();
      }

      const prog = Math.min(1, b.dwell / DWELL);
      if (prog > 0 && !active) {
        // charge-up: fill the button interior with the accent as the dwell grows
        ctx.save();
        this.roundRect(b.x, b.y, b.w, b.h, 12);
        ctx.clip();
        ctx.fillStyle = hexToRgba(prog >= 1 ? C.amber : b.accent, 0.18 + prog * 0.4);
        ctx.fillRect(b.x, b.y + b.h * (1 - prog), b.w, b.h * prog);
        ctx.restore();
        // progress bar along the bottom edge
        ctx.fillStyle = hexToRgba(prog >= 1 ? C.amber : b.accent, 0.9);
        this.roundRect(b.x, b.y + b.h - 5, b.w * prog, 5, 2);
        ctx.fill();
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = active ? '#12002a' : '#f4ecff';
      ctx.font = '700 15px Orbitron, sans-serif';
      ctx.fillText(b.label, b.x + b.w / 2, b.sub ? b.y + b.h * 0.40 : b.y + b.h * 0.5);
      if (b.sub) {
        ctx.font = '11px "Share Tech Mono", monospace';
        ctx.fillStyle = active ? 'rgba(18, 0, 42, 0.8)' : hexToRgba(b.accent, 0.9);
        ctx.fillText(b.sub, b.x + b.w / 2, b.y + b.h * 0.70);
      }
      ctx.restore();
    }
  }

  private roundRect(x: number, y: number, w: number, h: number, r: number): void {
    const ctx = this.ctx;
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }
}
