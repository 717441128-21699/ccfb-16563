/**
 * 轻量原地基-2 FFT。AudioWorklet 与离线验收脚本共用，不能依赖 DOM。
 */
export class FFT {
  readonly size: number;
  readonly bits: number;
  private readonly reversal: Uint32Array;
  readonly window: Float32Array;

  constructor(size: number) {
    if ((size & (size - 1)) !== 0) throw new Error('FFT 长度必须是 2 的幂');
    this.size = size;
    this.bits = Math.log2(size);
    this.reversal = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let x = i;
      let r = 0;
      for (let b = 0; b < this.bits; b++) {
        r = (r << 1) | (x & 1);
        x >>= 1;
      }
      this.reversal[i] = r;
    }
    // 周期 Hann 窗，满足 75% 重叠时的完全重建。
    this.window = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    }
  }

  private reorder(re: Float32Array, im: Float32Array): void {
    for (let i = 0; i < this.size; i++) {
      const j = this.reversal[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
  }

  forward(re: Float32Array, im: Float32Array): void {
    const n = this.size;
    this.reorder(re, im);
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const angle = (-2 * Math.PI) / len;
      const wr = Math.cos(angle);
      const wi = Math.sin(angle);
      for (let i = 0; i < n; i += len) {
        let cr = 1;
        let ci = 0;
        for (let j = 0; j < half; j++) {
          const a = i + j;
          const b = a + half;
          const vr = re[b] * cr - im[b] * ci;
          const vi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - vr;
          im[b] = im[a] - vi;
          re[a] += vr;
          im[a] += vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  inverse(re: Float32Array, im: Float32Array): void {
    const n = this.size;
    this.reorder(re, im);
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const angle = (2 * Math.PI) / len;
      const wr = Math.cos(angle);
      const wi = Math.sin(angle);
      for (let i = 0; i < n; i += len) {
        let cr = 1;
        let ci = 0;
        for (let j = 0; j < half; j++) {
          const a = i + j;
          const b = a + half;
          const vr = re[b] * cr - im[b] * ci;
          const vi = re[b] * ci + im[b] * cr;
          re[b] = re[a] - vr;
          im[b] = im[a] - vi;
          re[a] += vr;
          im[a] += vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
    const inv = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] *= inv;
      im[i] *= inv;
    }
  }

  /** 加 Hann 窗并求幅度谱；re/im 同时保留给后续相位处理。 */
  magnitudeSpectrum(frame: Float32Array, re: Float32Array, im: Float32Array): Float32Array {
    const n = this.size;
    for (let i = 0; i < n; i++) {
      re[i] = frame[i] * this.window[i];
      im[i] = 0;
    }
    this.forward(re, im);
    const mag = new Float32Array((n >> 1) + 1);
    for (let k = 0; k <= n / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    return mag;
  }
}

export function centsBetween(f1: number, f2: number): number {
  if (f1 <= 0 || f2 <= 0) return 0;
  return 1200 * Math.log2(f2 / f1);
}

export function midiToFreq(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

export function freqToMidi(f: number): number {
  return 69 + 12 * Math.log2(f / 440);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothed(current: number, target: number, attack: number, release: number): number {
  const a = target > current ? attack : release;
  return current + a * (target - current);
}
