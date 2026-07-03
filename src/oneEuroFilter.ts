class LowPassFilter {
  private y: number | null = null;

  filter(value: number, alpha: number): number {
    if (this.y === null) {
      this.y = value;
    } else {
      this.y = this.y + alpha * (value - this.y);
    }
    return this.y;
  }

  lastValue(): number | null {
    return this.y;
  }

  reset(): void {
    this.y = null;
  }
}

export class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  private xFilter: LowPassFilter;
  private dxFilter: LowPassFilter;
  private lastTime: number | null = null;

  constructor(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xFilter = new LowPassFilter();
    this.dxFilter = new LowPassFilter();
  }

  filter(value: number, timestamp: number): number {
    if (this.lastTime === null) {
      this.lastTime = timestamp;
      return this.xFilter.filter(value, 1.0);
    }

    const dt = (timestamp - this.lastTime) / 1000.0;
    this.lastTime = timestamp;

    if (dt <= 0) {
      return this.xFilter.lastValue() ?? value;
    }

    const lastX = this.xFilter.lastValue();
    const dx = lastX === null ? 0 : (value - lastX) / dt;
    const edx = this.dxFilter.filter(dx, this.alpha(dt, this.dCutoff));
    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.xFilter.filter(value, this.alpha(dt, cutoff));
  }

  reset(): void {
    this.lastTime = null;
    this.xFilter.reset();
    this.dxFilter.reset();
  }

  private alpha(dt: number, cutoff: number): number {
    const tau = 1.0 / (2.0 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / dt);
  }
}

export class OneEuroFilter2D {
  private xFilter: OneEuroFilter;
  private yFilter: OneEuroFilter;

  constructor(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.xFilter = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.yFilter = new OneEuroFilter(minCutoff, beta, dCutoff);
  }

  filter(x: number, y: number, timestamp: number): { x: number; y: number } {
    const filteredX = this.xFilter.filter(x, timestamp);
    const filteredY = this.yFilter.filter(y, timestamp);
    return { x: filteredX, y: filteredY };
  }

  reset(): void {
    this.xFilter.reset();
    this.yFilter.reset();
  }
}
