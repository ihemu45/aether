import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { OneEuroFilter2D } from './oneEuroFilter';

export interface Landmark {
  x: number;
  y: number;
  z: number;
}

/**
 * One tracked hand, in **screen space** — the x coordinate is already flipped
 * (`1 - rawX`) to match the mirrored webcam the user sees, so all downstream
 * studio code works in the same coordinate system it draws in.
 */
export interface HandState {
  id: number;             // stable slot (0 or 1) for velocity / per-hand tracking
  x: number;              // filtered centroid x, 0..1 (left → right on screen)
  y: number;              // filtered centroid y, 0..1 (top → bottom)
  indexX: number;         // index fingertip x (screen space)
  indexY: number;         // index fingertip y
  handedness: string;     // best-effort 'Left' | 'Right' from MediaPipe
  landmarks: Landmark[];  // all 21 landmarks, screen space (x flipped)
}

export interface FrameData {
  hands: HandState[];     // sorted left → right by screen x
  timestamp: number;
}

interface Slot {
  filter: OneEuroFilter2D;
  active: boolean;
}

/**
 * getUserMedia webcam capture + MediaPipe `HandLandmarker` (two hands).
 * Runs on its own loop, decoupled from the render loop, and reports filtered
 * screen-space hand data via `onFrame` every processed video frame (even when
 * no hands are visible — so the studio can silence audio and decay dwell).
 */
export class HandTracker {
  private video: HTMLVideoElement;
  private landmarker: HandLandmarker | null = null;
  private active = false;
  private lastVideoTime = -1;

  // One persistent smoothing filter per hand slot. Slots are assigned by the
  // hands' left-to-right order in the raw image, which keeps a given physical
  // hand on the same filter except during a brief crossover (One-Euro reconverges
  // in a few frames, so that is acceptable).
  private slots: Slot[] = [
    { filter: new OneEuroFilter2D(1.6, 0.012, 1.0), active: false },
    { filter: new OneEuroFilter2D(1.6, 0.012, 1.0), active: false },
  ];

  public onLoaded: (() => void) | null = null;
  public onError: ((err: Error) => void) | null = null;
  public onFrame: ((data: FrameData) => void) | null = null;
  public onFPS: ((fps: number) => void) | null = null;

  private frameCount = 0;
  private lastFpsUpdate = 0;
  private readonly fpsInterval = 1000;

  constructor(video: HTMLVideoElement) {
    this.video = video;
  }

  async start(): Promise<void> {
    try {
      const vision = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm"
      );
      this.landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
          delegate: "GPU"
        },
        runningMode: "VIDEO",
        numHands: 2
      });

      this.onLoaded?.();

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
        audio: false
      });
      this.video.srcObject = stream;
      this.video.play();

      this.active = true;
      this.video.addEventListener('loadeddata', () => this.runLoop());
    } catch (err) {
      this.onError?.(err as Error);
    }
  }

  private runLoop(): void {
    if (!this.active) return;

    const detectFrame = () => {
      if (!this.active) return;

      if (this.video.currentTime !== this.lastVideoTime && this.video.readyState >= 2) {
        this.lastVideoTime = this.video.currentTime;
        const timestamp = performance.now();

        try {
          const results = this.landmarker!.detectForVideo(this.video, timestamp);

          this.frameCount++;
          if (timestamp - this.lastFpsUpdate >= this.fpsInterval) {
            const fps = (this.frameCount * 1000) / (timestamp - this.lastFpsUpdate);
            this.onFPS?.(Math.round(fps));
            this.frameCount = 0;
            this.lastFpsUpdate = timestamp;
          }

          const hands = this.buildHands(results, timestamp);
          this.onFrame?.({ hands, timestamp });
        } catch (e) {
          console.error("Error in HandLandmarker inference:", e);
        }
      }

      if ('requestVideoFrameCallback' in this.video) {
        (this.video as any).requestVideoFrameCallback(detectFrame);
      } else {
        requestAnimationFrame(detectFrame);
      }
    };

    if ('requestVideoFrameCallback' in this.video) {
      (this.video as any).requestVideoFrameCallback(detectFrame);
    } else {
      requestAnimationFrame(detectFrame);
    }
  }

  private buildHands(results: any, timestamp: number): HandState[] {
    const raw: Array<{ lms: Landmark[]; rawX: number; rawY: number; handed: string }> = [];

    if (results.landmarks && results.landmarks.length > 0) {
      for (let idx = 0; idx < results.landmarks.length; idx++) {
        const lms = results.landmarks[idx] as Landmark[];
        let sx = 0, sy = 0;
        for (const lm of lms) { sx += lm.x; sy += lm.y; }
        raw.push({
          lms,
          rawX: sx / lms.length,
          rawY: sy / lms.length,
          handed: results.handednesses?.[idx]?.[0]?.categoryName
            ?? results.handedness?.[idx]?.[0]?.categoryName
            ?? ''
        });
      }
    }

    // Assign slots by left-to-right order in the raw image (stable identity).
    raw.sort((a, b) => a.rawX - b.rawX);

    const hands: HandState[] = [];
    for (let i = 0; i < raw.length && i < this.slots.length; i++) {
      const det = raw[i];
      const slot = this.slots[i];
      const f = slot.filter.filter(det.rawX, det.rawY, timestamp);
      slot.active = true;

      hands.push({
        id: i,
        x: 1 - f.x,                       // flip to mirrored screen space
        y: f.y,
        indexX: 1 - det.lms[8].x,
        indexY: det.lms[8].y,
        handedness: det.handed,
        landmarks: det.lms.map(l => ({ x: 1 - l.x, y: l.y, z: l.z }))
      });
    }

    // Reset filters for any slot that lost its hand, so re-entry doesn't snap.
    for (let i = raw.length; i < this.slots.length; i++) {
      if (this.slots[i].active) {
        this.slots[i].active = false;
        this.slots[i].filter.reset();
      }
    }

    // Hand off sorted left → right on screen for convenient role assignment.
    hands.sort((a, b) => a.x - b.x);
    return hands;
  }

  stop(): void {
    this.active = false;
    const stream = this.video.srcObject as MediaStream | null;
    if (stream) stream.getTracks().forEach(t => t.stop());
    this.video.srcObject = null;
  }
}

/** MediaPipe hand-skeleton bone connections (landmark index pairs). */
export const HAND_CONNECTIONS: ReadonlyArray<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17]
];
