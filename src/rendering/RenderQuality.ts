/** Keep high-DPI screens from multiplying the post-processing cost unchecked. */
export function renderPixelRatio(width: number, height: number, density: number, scale = 1): number {
  return Math.min(density, 2, Math.sqrt(3_000_000 / Math.max(1, width * height))) * scale;
}

/** Hysteresis avoids reacting to single hitches or oscillating every frame. */
export class RenderQuality {
  scale = 1;
  private elapsed = 0;
  private frames = 0;
  private fastTime = 0;

  sample(dt: number): boolean {
    if (dt <= 0 || dt > 0.25) return false;
    this.elapsed += dt;
    this.frames++;
    if (this.elapsed < 2) return false;
    const average = this.elapsed / this.frames;
    this.fastTime = average < 0.018 ? this.fastTime + this.elapsed : 0;
    this.elapsed = this.frames = 0;
    if (average > 0.023 && this.scale > 0.65) {
      this.scale = Math.max(0.65, this.scale - 0.1);
      return true;
    }
    if (this.fastTime >= 10 && this.scale < 1) {
      this.scale = Math.min(1, this.scale + 0.05);
      this.fastTime = 0;
      return true;
    }
    return false;
  }
}
