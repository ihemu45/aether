export type Waveform = OscillatorType; // 'sine' | 'square' | 'sawtooth' | 'triangle'

const A4 = 440;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** MIDI note number → frequency in Hz. */
export function midiToFreq(midi: number): number {
  return A4 * Math.pow(2, (midi - 69) / 12);
}

/** MIDI note number → human note name, e.g. 69 → "A4". */
export function noteName(midi: number): string {
  const n = Math.round(midi);
  return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}

// Major-pentatonic scale-degree offsets within one octave.
const PENTATONIC = [0, 2, 4, 7, 9];

/**
 * Build a ladder of MIDI notes following the major pentatonic scale, starting
 * at `rootMidi` and spanning `octaves` octaves (inclusive of the top root).
 */
export function pentatonicLadder(rootMidi: number, octaves: number): number[] {
  const out: number[] = [];
  for (let o = 0; o < octaves; o++) {
    for (const off of PENTATONIC) out.push(rootMidi + o * 12 + off);
  }
  out.push(rootMidi + octaves * 12);
  return out;
}

/**
 * The whole audio side of the studio. Built lazily on the first user gesture
 * (the browser autoplay policy requires a real click to unlock audio).
 *
 * Signal flow:
 *   voices ──┬─► masterGain ─► compressor ─► destination
 *            └─► reverbSend ─► convolver ─► reverbReturn ─► masterGain
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private comp!: DynamicsCompressorNode;
  private reverb!: ConvolverNode;
  private reverbReturn!: GainNode;

  // Persistent theremin voice (continuous oscillator + vibrato LFO).
  private thOsc: OscillatorNode | null = null;
  private thGain!: GainNode;
  private thFilter!: BiquadFilterNode;
  private vibrato: OscillatorNode | null = null;
  private thereminRunning = false;

  get ready(): boolean {
    return this.ctx !== null;
  }

  /** Create (or resume) the AudioContext. Must be called from a user gesture. */
  async init(): Promise<void> {
    if (this.ctx) {
      await this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    const ctx = new Ctor();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.85;

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14;
    this.comp.knee.value = 24;
    this.comp.ratio.value = 3;
    this.comp.attack.value = 0.003;
    this.comp.release.value = 0.25;

    this.master.connect(this.comp);
    this.comp.connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(2.4, 2.6);
    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 0.32;
    this.reverb.connect(this.reverbReturn);
    this.reverbReturn.connect(this.master);

    await ctx.resume();
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const rate = ctx.sampleRate;
    const len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  private noiseBuffer(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /** Route a voice's output node to the dry master bus + a wet reverb send. */
  private route(node: AudioNode, wet: number): void {
    node.connect(this.master);
    if (wet > 0) {
      const send = this.ctx!.createGain();
      send.gain.value = wet;
      node.connect(send);
      send.connect(this.reverb);
    }
  }

  // ── theremin ────────────────────────────────────────────────────────────

  startTheremin(waveform: Waveform): void {
    if (!this.ctx || this.thereminRunning) return;
    const ctx = this.ctx;

    this.thFilter = ctx.createBiquadFilter();
    this.thFilter.type = 'lowpass';
    this.thFilter.frequency.value = 3500;
    this.thFilter.Q.value = 1;

    this.thGain = ctx.createGain();
    this.thGain.gain.value = 0;

    this.thOsc = ctx.createOscillator();
    this.thOsc.type = waveform;
    this.thOsc.frequency.value = 220;

    this.vibrato = ctx.createOscillator();
    this.vibrato.frequency.value = 5.5;
    const vibAmt = ctx.createGain();
    vibAmt.gain.value = 3.2; // vibrato depth, in Hz
    this.vibrato.connect(vibAmt);
    vibAmt.connect(this.thOsc.frequency);

    this.thOsc.connect(this.thFilter);
    this.thFilter.connect(this.thGain);
    this.route(this.thGain, 0.45);

    this.thOsc.start();
    this.vibrato.start();
    this.thereminRunning = true;
  }

  stopTheremin(): void {
    if (!this.ctx || !this.thereminRunning) return;
    const now = this.ctx.currentTime;
    this.thGain.gain.cancelScheduledValues(now);
    this.thGain.gain.setTargetAtTime(0, now, 0.02);
    const osc = this.thOsc;
    const vib = this.vibrato;
    window.setTimeout(() => {
      try { osc?.stop(); vib?.stop(); } catch { /* already stopped */ }
    }, 140);
    this.thOsc = null;
    this.vibrato = null;
    this.thereminRunning = false;
  }

  setThereminWaveform(w: Waveform): void {
    if (this.thOsc) this.thOsc.type = w;
  }

  /** Continuously drive the theremin. `volume` 0..1, `freq` in Hz. */
  setTheremin(freq: number, volume: number): void {
    if (!this.ctx || !this.thOsc) return;
    const now = this.ctx.currentTime;
    this.thOsc.frequency.setTargetAtTime(freq, now, 0.04);
    this.thFilter.frequency.setTargetAtTime(Math.min(8500, freq * 6 + 700), now, 0.05);
    this.thGain.gain.setTargetAtTime(Math.max(0, Math.min(0.9, volume)), now, 0.05);
  }

  // ── drums (one-shot synthesized voices) ───────────────────────────────────

  kick(): void {
    if (!this.ctx) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(165, now);
    osc.frequency.exponentialRampToValueAtTime(45, now + 0.12);
    g.gain.setValueAtTime(1.0, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.33);
    osc.connect(g);
    this.route(g, 0.12);
    osc.start(now);
    osc.stop(now + 0.35);
  }

  snare(): void {
    if (!this.ctx) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuffer(0.22);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 1200;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.7, now);
    ng.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
    n.connect(hp); hp.connect(ng);
    this.route(ng, 0.25);

    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(180, now);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.5, now);
    og.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
    o.connect(og);
    this.route(og, 0.2);

    n.start(now); n.stop(now + 0.22);
    o.start(now); o.stop(now + 0.14);
  }

  hat(open = false): void {
    if (!this.ctx) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const dur = open ? 0.34 : 0.06;
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuffer(dur + 0.02);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + dur);
    n.connect(hp); hp.connect(g);
    this.route(g, 0.12);
    n.start(now); n.stop(now + dur + 0.02);
  }

  crash(): void {
    if (!this.ctx) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const n = ctx.createBufferSource();
    n.buffer = this.noiseBuffer(0.9);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 4000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.55, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.85);
    n.connect(hp); hp.connect(g);
    this.route(g, 0.5);
    n.start(now); n.stop(now + 0.9);
  }

  tom(freq = 160): void {
    if (!this.ctx) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(freq, now);
    o.frequency.exponentialRampToValueAtTime(freq * 0.5, now + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.8, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    o.connect(g);
    this.route(g, 0.22);
    o.start(now); o.stop(now + 0.32);
  }

  // ── harp / plucked string ─────────────────────────────────────────────────

  pluck(freq: number, velocity = 1): void {
    if (!this.ctx) return;
    const ctx = this.ctx, now = ctx.currentTime;
    const dur = 1.4;
    const peak = 0.55 * Math.max(0.25, Math.min(1, velocity));

    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(peak, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    lp.frequency.setValueAtTime(Math.min(9000, freq * 8), now);
    lp.frequency.exponentialRampToValueAtTime(Math.max(450, freq * 2), now + dur * 0.6);

    const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = freq;
    const o2 = ctx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = freq; o2.detune.value = 7;
    const o3 = ctx.createOscillator(); o3.type = 'sine'; o3.frequency.value = freq * 2;
    const o3g = ctx.createGain(); o3g.gain.value = 0.25;

    o1.connect(lp);
    o2.connect(lp);
    o3.connect(o3g); o3g.connect(lp);
    lp.connect(g);
    this.route(g, 0.5);

    o1.start(now); o2.start(now); o3.start(now);
    o1.stop(now + dur); o2.stop(now + dur); o3.stop(now + dur);
  }
}
