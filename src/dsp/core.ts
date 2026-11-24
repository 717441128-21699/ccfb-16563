import { FFT, centsBetween, clamp, freqToMidi } from './fft.ts';
import { GUQIN_STRINGS, type AnalysisResult, type FrameAnalysis, type ProcessResult, type ProcessingSettings, type SegmentSettings, type StringPitchCurve } from './types.ts';

const PARTIALS = 16;

interface TrackedFrame extends FrameAnalysis {
  flatness: number;
  highRatio: number;
  harmFreq: Float32Array;
  harmAmp: Float32Array;
  harmPhase: Float32Array;
  inharmB: number;
}

export interface PitchTrackResult {
  result: AnalysisResult;
  tracked: TrackedFrame[];
}

export interface ProcessOptions {
  collectGains?: boolean;
  collectHarmonicModel?: boolean;
  stringDensities?: number[];
  onProgress?: (ratio: number) => void;
}

function emptyPartialArray(): Float32Array {
  return new Float32Array(PARTIALS);
}

function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function parabolicOffset(m0: number, m1: number, m2: number): number {
  const denom = m0 - 2 * m1 + m2;
  if (Math.abs(denom) < 1e-12) return 0;
  return clamp(0.5 * (m0 - m2) / denom, -0.9, 0.9);
}

export class GuqinFrameEngine {
  readonly sampleRate: number;
  readonly fftSize = 2048;
  readonly hopSize = 512;
  readonly bins = this.fftSize / 2 + 1;
  readonly fft: FFT;
  private re: Float32Array;
  private im: Float32Array;
  private mag: Float32Array;
  private acfRe: Float32Array;
  private acfIm: Float32Array;
  private windowCorr: Float32Array;
  private prevFreq = 0;
  private prevPhi = emptyPartialArray();
  private phaseValid = false;
  lastStringIndex = -1;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.fft = new FFT(this.fftSize);
    this.re = new Float32Array(this.fftSize);
    this.im = new Float32Array(this.fftSize);
    this.mag = new Float32Array(this.bins);
    this.acfRe = new Float32Array(this.fftSize);
    this.acfIm = new Float32Array(this.fftSize);
    this.windowCorr = new Float32Array(this.fftSize / 2);
    let wEnergy = 0;
    for (let i = 0; i < this.fftSize; i++) wEnergy += this.fft.window[i] ** 2;
    for (let lag = 0; lag < this.windowCorr.length; lag++) {
      let overlap = 0;
      for (let i = 0; i < this.fftSize - lag; i++) overlap += this.fft.window[i] * this.fft.window[i + lag];
      this.windowCorr[lag] = overlap / wEnergy;
    }
  }

  resetTrack(): void {
    this.prevFreq = 0;
    this.phaseValid = false;
    this.prevPhi.fill(0);
    this.lastStringIndex = -1;
  }

  frameCount(length: number): number {
    if (length <= 0) return 0;
    return Math.max(1, Math.ceil(length / this.hopSize));
  }

  /** AudioWorklet 在 detect() 后复用同一帧幅度谱，避免再做一次 FFT。 */
  getMagnitudes(): Float32Array {
    return this.mag;
  }

  getFrameSamples(samples: Float32Array, frame: number, target?: Float32Array): Float32Array {
    const out = target ?? new Float32Array(this.fftSize);
    const start = frame * this.hopSize;
    out.fill(0);
    const count = Math.max(0, Math.min(this.fftSize, samples.length - start));
    if (count > 0) out.set(samples.subarray(start, start + count));
    return out;
  }

  private peakAround(centerBin: number, search = 2): { k: number; fractional: number; mag: number } {
    const center = Math.round(centerBin);
    let bestK = clamp(center, 1, this.bins - 2);
    let bestMag = -1;
    const lo = Math.max(1, center - search);
    const hi = Math.min(this.bins - 2, center + search);
    for (let k = lo; k <= hi; k++) {
      if (this.mag[k] > bestMag) {
        bestMag = this.mag[k];
        bestK = k;
      }
    }
    const delta = parabolicOffset(this.mag[bestK - 1], this.mag[bestK], this.mag[bestK + 1]);
    return { k: bestK, fractional: bestK + delta, mag: bestMag };
  }

  private coarseScore(f0: number, bInharm: number): number {
    const binHz = this.sampleRate / this.fftSize;
    let sum = 0;
    let wsum = 0;
    for (let h = 1; h <= 12; h++) {
      const stretched = h * f0 * Math.sqrt(1 + bInharm * h * h);
      if (stretched > 620) break;
      const p = this.peakAround(stretched / binHz, 1);
      const w = 1 / Math.pow(h, 0.72);
      sum += Math.log(1 + p.mag) * w;
      wsum += w;
    }
    return sum / wsum;
  }

  detect(frame: Float32Array, frameIndex: number, openPrior = 0): TrackedFrame {
    const n = this.fftSize;
    const sr = this.sampleRate;
    const binHz = sr / n;
    this.fft.magnitudeSpectrum(frame, this.re, this.im);
    for (let k = 0; k < this.bins; k++) this.mag[k] = Math.hypot(this.re[k], this.im[k]);

    let rms = 0;
    for (let i = 0; i < n; i++) rms += frame[i] * frame[i];
    rms = Math.sqrt(rms / n);

    // 频谱平坦度与高频能量比，用于识别宽带擦弦。
    let logSum = 0;
    let arithmetic = 0;
    let count = 0;
    let highEnergy = 0;
    let bandEnergy = 0;
    for (let k = Math.floor(500 / binHz); k < Math.floor(Math.min(9000, sr / 2) / binHz); k++) {
      const m = this.mag[k] + 1e-8;
      logSum += Math.log(m);
      arithmetic += m;
      count++;
    }
    for (let k = Math.floor(1400 / binHz); k < Math.floor(Math.min(9500, sr / 2) / binHz); k++) highEnergy += this.mag[k] * this.mag[k];
    for (let k = Math.floor(120 / binHz); k < this.bins - 1; k++) bandEnergy += this.mag[k] * this.mag[k];
    const flatness = count > 0 ? Math.exp(logSum / count) / (arithmetic / count + 1e-12) : 0;
    const highRatio = bandEnergy > 0 ? highEnergy / bandEnergy : 0;

    // 由功率谱做一帧自相关，避免低频时 FFT bin 过疏和纯频谱候选的八度误差。
    for (let k = 0; k < n; k++) {
      const hz = Math.min(k, n - k) * binHz;
      // 音高自相关只使用被直通保护的低次谐波区，确保处理前后周期判断一致。
      const lowWeight = hz <= 600 ? 1 : 0;
      this.acfRe[k] = (this.re[k] * this.re[k] + this.im[k] * this.im[k]) * lowWeight;
      this.acfIm[k] = 0;
    }
    this.fft.inverse(this.acfRe, this.acfIm);
    const minLag = Math.max(18, Math.floor(sr / 1180));
    const maxLag = Math.min(Math.floor(sr / 52), n / 2 - 2);
    let bestLag = minLag;
    let bestAcfNorm = -Infinity;
    for (let lag = minLag + 1; lag < maxLag; lag++) {
      if (!(this.acfRe[lag] >= this.acfRe[lag - 1] && this.acfRe[lag] >= this.acfRe[lag + 1])) continue;
      const norm = this.acfRe[lag] / (Math.max(1e-8, this.acfRe[0]) * Math.max(0.08, this.windowCorr[lag]));
      if (norm > bestAcfNorm) {
        bestAcfNorm = norm;
        bestLag = lag;
      }
    }
    if (!Number.isFinite(bestAcfNorm)) {
      for (let lag = minLag; lag <= maxLag; lag++) {
        const norm = this.acfRe[lag] / (Math.max(1e-8, this.acfRe[0]) * Math.max(0.08, this.windowCorr[lag]));
        if (norm > bestAcfNorm) {
          bestAcfNorm = norm;
          bestLag = lag;
        }
      }
    }
    const lagDelta = parabolicOffset(this.acfRe[bestLag - 1], this.acfRe[bestLag], this.acfRe[bestLag + 1]);
    const acfF0 = sr / (bestLag + clamp(lagDelta, -0.9, 0.9));
    const acfConfidence = clamp(bestAcfNorm, 0, 1);

    const minF = Math.max(50, openPrior > 0 ? openPrior * 0.975 : 50);
    const candidates = [acfF0, acfF0 * 2, acfF0 / 2]
      .filter((f) => f >= minF && f <= 1180)
      .sort((a, b) => a - b);
    if (candidates.length === 0) candidates.push(clamp(acfF0, minF, 1180));
    const bChoices = [0, 0.00006, 0.00014, 0.00028, 0.0005];
    let bestF0 = acfF0;
    let bestRefined = -Infinity;
    let bestB = 0.00012;
    for (const candidate of candidates) {
      for (const b of bChoices) {
        for (let c = -50; c <= 50; c += 5) {
          const f0 = candidate * Math.pow(2, c / 1200);
          let score = this.coarseScore(f0, b);
          if (this.prevFreq > 0) {
            const cents = Math.abs(centsBetween(this.prevFreq, f0));
            if (cents > 70) score -= Math.min(0.8, (cents - 70) / 1600);
          }
          if (openPrior > 0 && f0 < openPrior * 0.985) score -= 1.2;
          if (openPrior > 0 && f0 > openPrior * 4.8) score -= 0.35;
          if (score > bestRefined) {
            bestRefined = score;
            bestF0 = f0;
            bestB = b;
          }
        }
      }
    }

    // 用各次谐波的亚 bin 峰值反推 f0，显著提高音分精度。
    let impliedSum = 0;
    let weightSum = 0;
    const impliedObs: Array<{ f: number; w: number }> = [];
    const harmFreq = emptyPartialArray();
    const harmAmp = emptyPartialArray();
    const harmPhase = emptyPartialArray();
    const preImpliedF0 = bestF0;
    for (let h = 1; h <= PARTIALS; h++) {
      const expected = h * bestF0 * Math.sqrt(1 + bestB * h * h);
      const p = this.peakAround(expected / binHz, 1);
      const freq = p.fractional * binHz;
      harmFreq[h - 1] = freq;
      const km1 = clamp(p.k - 1, 0, this.bins - 1);
      const kp1 = clamp(p.k + 1, 0, this.bins - 1);
      const amp = clamp((2 * (this.mag[km1] + this.mag[p.k] + this.mag[kp1])) / n, 0, 1);
      harmAmp[h - 1] = amp;
      if (h <= 8 && amp > 0.006 && freq <= 620) {
        const implied = freq / (h * Math.sqrt(1 + bestB * h * h));
        const w = amp * (1.2 - h / 12);
        impliedSum += implied * w;
        weightSum += w;
        impliedObs.push({ f: implied, w });
      }
      let phiCenter = normalizeAngle(Math.atan2(this.im[p.k], this.re[p.k]) + Math.PI * p.k);
      if (this.phaseValid && this.prevPhi[h - 1] !== 0 && h <= 10) {
        const predicted = this.prevPhi[h - 1] + 2 * Math.PI * freq * this.hopSize / sr;
        let measured = phiCenter;
        let delta = normalizeAngle(measured - predicted);
        measured = predicted + delta;
        phiCenter = measured;
      }
      harmPhase[h - 1] = phiCenter;
      this.prevPhi[h - 1] = phiCenter;
    }
    if (impliedObs.length > 0) {
      impliedObs.sort((a, b) => a.f - b.f);
      const totalW = impliedObs.reduce((s, x) => s + x.w, 0);
      let accW = 0;
      let medianF = impliedObs[0].f;
      for (const obs of impliedObs) {
        accW += obs.w;
        if (accW >= totalW * 0.5) {
          medianF = obs.f;
          break;
        }
      }
      let clusterSum = 0;
      let clusterW = 0;
      for (const obs of impliedObs) {
        if (Math.abs(centsBetween(medianF, obs.f)) < 45) {
          clusterSum += obs.f * obs.w;
          clusterW += obs.w;
        }
      }
      if (clusterW > 0) bestF0 = clusterSum / clusterW;
      else if (weightSum > 0) bestF0 = impliedSum / weightSum;
    }
    (this as unknown as { lastPitchDebug?: unknown }).lastPitchDebug = { bestLag, lagDelta, acfF0, acfConfidence, candidates, preImpliedF0, bestF0, bestRefined, bestB, impliedSum, weightSum };

    const confidence = clamp((bestRefined - 2.2) / 5.5 + Math.min(0.25, harmAmp[0] * 4), 0, 1);
    const voiced = bestF0 >= 48 && bestF0 <= 1250 && confidence > 0.08 && rms > 1e-7;
    if (voiced) {
      this.prevFreq = this.prevFreq > 0 ? this.prevFreq * 0.55 + bestF0 * 0.45 : bestF0;
      this.phaseValid = true;
    } else {
      this.prevFreq = 0;
      this.phaseValid = false;
      this.prevPhi.fill(0);
    }

    const midi = voiced ? freqToMidi(bestF0) : 0;
    const analysis: TrackedFrame = {
      frame: frameIndex,
      time: frameIndex * this.hopSize / sr,
      f0: voiced ? bestF0 : 0,
      midi,
      confidence: voiced ? confidence : 0,
      stringIndex: -1,
      sliding: false,
      centsPerSecond: 0,
      velocity: 0,
      wrapRate: 0,
      wrapDensity: 0,
      wrapClarity: 0,
      noiseLikelihood: clamp(0.25 + flatness * 0.9 + highRatio * 0.55, 0, 1),
      scrapeRms: 0,
      rms,
      flatness,
      highRatio,
      harmFreq,
      harmAmp,
      harmPhase,
      inharmB: bestB,
    };
    return analysis;
  }

  /** 用鲁棒化后的 f0 在处理 FFT 上重新对准谐波幅度与相位。 */
  refineHarmonicsFromSpectrum(tf: TrackedFrame, re: Float32Array, im: Float32Array): void {
    const n = this.fftSize;
    const binHz = this.sampleRate / n;
    for (let k = 0; k < this.bins; k++) this.mag[k] = Math.hypot(re[k], im[k]);
    if (tf.f0 <= 0) {
      this.phaseValid = false;
      return;
    }
    for (let h = 1; h <= PARTIALS; h++) {
      const expected = h * tf.f0 * Math.sqrt(1 + tf.inharmB * h * h);
      const p = this.peakAround(expected / binHz, 1);
      const freq = p.fractional * binHz;
      tf.harmFreq[h - 1] = freq;
      const km1 = clamp(p.k - 1, 0, this.bins - 1);
      const kp1 = clamp(p.k + 1, 0, this.bins - 1);
      tf.harmAmp[h - 1] = clamp((2 * (this.mag[km1] + this.mag[p.k] + this.mag[kp1])) / n, 0, 1);
      let phiCenter = normalizeAngle(Math.atan2(im[p.k], re[p.k]) + Math.PI * p.k);
      if (this.phaseValid && this.prevPhi[h - 1] !== 0 && h <= 10) {
        const predicted = this.prevPhi[h - 1] + 2 * Math.PI * freq * this.hopSize / this.sampleRate;
        phiCenter = predicted + normalizeAngle(phiCenter - predicted);
      }
      tf.harmPhase[h - 1] = phiCenter;
      this.prevPhi[h - 1] = phiCenter;
    }
    this.phaseValid = true;
  }

  /** 用中心相位和局部频率斜率合成一帧干净谐波。 */
  synthesizeHarmonics(frameIndex: number, tracked: TrackedFrame, all: TrackedFrame[], sRe: Float32Array, sIm: Float32Array, timeOut?: Float32Array): void {
    const n = this.fftSize;
    const sr = this.sampleRate;
    const time = timeOut ?? new Float32Array(n);
    time.fill(0);
    const prev = all[Math.max(0, frameIndex - 1)];
    const next = all[Math.min(all.length - 1, frameIndex + 1)];
    for (let h = 1; h <= PARTIALS; h++) {
      const amp = tracked.harmAmp[h - 1];
      if (amp < 0.0008) continue;
      const stretch = Math.sqrt(1 + tracked.inharmB * h * h);
      const f = h * tracked.f0 * stretch;
      const fPrev = prev && prev.f0 > 0 ? h * prev.f0 * Math.sqrt(1 + prev.inharmB * h * h) : f;
      const fNext = next && next.f0 > 0 ? h * next.f0 * Math.sqrt(1 + next.inharmB * h * h) : f;
      const slope = clamp((fNext - fPrev) / (2 * this.hopSize / sr), -f * 3, f * 3);
      const phi = tracked.harmPhase[h - 1];
      for (let i = 0; i < n; i++) {
        const tau = (i - n / 2) / sr;
        const phase = phi + 2 * Math.PI * (f * tau + 0.5 * slope * tau * tau);
        time[i] += amp * Math.cos(phase);
      }
    }
    for (let i = 0; i < n; i++) {
      sRe[i] = time[i] * this.fft.window[i];
      sIm[i] = 0;
    }
    this.fft.forward(sRe, sIm);
  }

  estimateWinding(frame: Float32Array, velocity: number, stringIndex: number, exactDensities?: number[]): { rate: number; density: number; clarity: number } {
    if (Math.abs(velocity) < 2.5) return { rate: 0, density: 0, clarity: 0 };
    const sr = this.sampleRate;
    const n = this.fftSize;
    const env = new Float32Array(n);
    let mean = 0;
    let last = 0;
    for (let i = 0; i < n; i++) {
      const x = frame[i];
      const d = x - 0.94 * last;
      last = x;
      env[i] = Math.abs(d);
      mean += env[i];
    }
    mean /= n;
    const candidates = exactDensities && exactDensities[stringIndex]
      ? [exactDensities[stringIndex] * 0.9, exactDensities[stringIndex], exactDensities[stringIndex] * 1.1]
      : [1.05, 1.3, 1.55, 1.8, 2.05, 2.3, 2.6, 2.9, 3.15];
    let best = { clarity: 0, density: 0, lag: 0 };
    for (const density of candidates) {
      const lag = Math.round(sr / (density * Math.abs(velocity)));
      if (lag < 70 || lag > n - 128) continue;
      for (const testLag of [lag - 2, lag - 1, lag, lag + 1, lag + 2]) {
        let c = 0;
        let e0 = 0;
        let e1 = 0;
        const count = n - testLag;
        for (let i = 0; i < count; i++) {
          const a = env[i] - mean;
          const b = env[i + testLag] - mean;
          c += a * b;
          e0 += a * a;
          e1 += b * b;
        }
        const corr = c / Math.sqrt(e0 * e1 + 1e-12);
        if (corr > best.clarity) best = { clarity: corr, density, lag: testLag };
      }
    }
    if (best.clarity < 0.12) return { rate: 0, density: best.density, clarity: clamp(best.clarity, 0, 1) };
    return { rate: sr / best.lag, density: best.density, clarity: clamp(best.clarity, 0, 1) };
  }
}

/**
 * 音高曲线鲁棒化：局部中值识别八度/五度跳点，短缺口插值，再做线性滑音友好的三角平滑。
 * 处理前后跑同一套跟踪，因此显示曲线不会被个别坏帧拉出 5 音分以上差异。
 */
export function robustCorrectPitchTrack(tracked: TrackedFrame[]): void {
  const n = tracked.length;
  const raw = tracked.map((f) => f.f0);
  const localMedian = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const vals: number[] = [];
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) if (raw[j] > 0) vals.push(raw[j]);
    vals.sort((a, b) => a - b);
    localMedian[i] = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
  }

  const corrected = new Float32Array(n);
  const ratios = [0.5, 2, 2 / 3, 1.5, 1 / 3, 3];
  for (let i = 0; i < n; i++) {
    const f = raw[i];
    const m = localMedian[i];
    if (f <= 0) continue;
    if (m <= 0 || Math.abs(centsBetween(m, f)) <= 115) {
      corrected[i] = f;
      continue;
    }
    let best = f;
    let bestCents = Math.abs(centsBetween(m, f));
    for (const r of ratios) {
      const candidate = f * r;
      const d = Math.abs(centsBetween(m, candidate));
      if (d < bestCents) {
        bestCents = d;
        best = candidate;
      }
    }
    if (bestCents < 35) corrected[i] = best;
    else if (Math.abs(centsBetween(m, f)) > 220 && tracked[i].confidence < 0.45) corrected[i] = m;
    else corrected[i] = f;
  }

  // 填补最多 12 帧（约 130ms）的短缺口。
  let lastVoiced = -1;
  for (let i = 0; i < n; i++) {
    if (corrected[i] > 0) {
      if (lastVoiced >= 0 && i - lastVoiced > 1 && i - lastVoiced <= 8) {
        const f0 = corrected[lastVoiced];
        const f1 = corrected[i];
        for (let j = lastVoiced + 1; j < i; j++) {
          const u = (j - lastVoiced) / (i - lastVoiced);
          corrected[j] = f0 * Math.pow(f1 / f0, u);
        }
      }
      lastVoiced = i;
    }
  }

  const smoothed = new Float32Array(n);
  const weights = [1, 2, 1];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let wsum = 0;
    for (let d = -1; d <= 1; d++) {
      const j = i + d;
      if (j >= 0 && j < n && corrected[j] > 0) {
        const w = weights[d + 1];
        sum += corrected[j] * w;
        wsum += w;
      }
    }
    smoothed[i] = wsum > 0 ? sum / wsum : 0;
  }

  for (let i = 0; i < n; i++) {
    if (smoothed[i] > 0) {
      tracked[i].f0 = smoothed[i];
      tracked[i].midi = freqToMidi(smoothed[i]);
    }
  }
}

/** 第一遍：音高/谐波跟踪，并把音高帧分配到具体弦和段落。 */
export function analyzePitch(
  samples: Float32Array,
  sampleRate: number,
  segments: SegmentSettings[] = [],
  onProgress?: (ratio: number) => void,
): PitchTrackResult {
  const engine = new GuqinFrameEngine(sampleRate);
  const frameCount = engine.frameCount(samples.length);
  const tracked: TrackedFrame[] = [];
  const frame = new Float32Array(engine.fftSize);

  for (let fi = 0; fi < frameCount; fi++) {
    engine.getFrameSamples(samples, fi, frame);
    const previewTime = (fi * engine.hopSize) / sampleRate;
    const previewSeg = segments.find((s) => previewTime >= s.start && previewTime < s.end);
    const stringIndex = previewSeg?.stringIndex ?? -1;
    if (stringIndex >= 0 && engine.lastStringIndex !== stringIndex) engine.resetTrack();
    engine.lastStringIndex = stringIndex;
    const openPrior = stringIndex >= 0 ? GUQIN_STRINGS[stringIndex]?.openFreq ?? 0 : 0;
    const tf = engine.detect(frame, fi, openPrior);
    const t = tf.time;
    const seg = previewSeg ?? segments.find((s) => t >= s.start && t < s.end);
    if (seg) tf.stringIndex = seg.stringIndex;
    tracked.push(tf);
    if (onProgress && (fi & 2047) === 0) onProgress((fi / frameCount) * 0.45);
  }

  // 先做八度/五度坏点纠正和短缺口插值，再计算滑音斜率。
  robustCorrectPitchTrack(tracked);

  // 3 点中值 + 居中线性回归，区分持续单向走手和往复吟猱。
  const rawF0 = tracked.map((f) => f.f0);
  const median = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    const vals = [rawF0[Math.max(0, i - 1)], rawF0[i], rawF0[Math.min(frameCount - 1, i + 1)]].filter((v) => v > 0).sort((a, b) => a - b);
    median[i] = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
  }
  const smooth = new Float32Array(frameCount);
  let run = 0;
  for (let i = 0; i < frameCount; i++) {
    if (median[i] <= 0) {
      smooth[i] = 0;
      run = 0;
    } else {
      run = run === 0 ? median[i] : run * 0.72 + median[i] * 0.28;
      smooth[i] = run;
    }
  }

  const scaleLengthCm = 112;
  for (let i = 0; i < frameCount; i++) {
    const f = tracked[i];
    const a = tracked[Math.max(0, i - 7)];
    const b = tracked[Math.min(frameCount - 1, i + 7)];
    if (smooth[i] > 0 && smooth[a.frame] > 0 && smooth[b.frame] > 0 && b.time > a.time) {
      f.centsPerSecond = centsBetween(smooth[a.frame], smooth[b.frame]) / (b.time - a.time);
    }
    const net = Math.abs(f.centsPerSecond);
    f.sliding = f.f0 > 0 && net > 58 && f.confidence > 0.2;
    if (f.sliding && f.stringIndex >= 0) {
      const open = GUQIN_STRINGS[f.stringIndex]?.openFreq ?? GUQIN_STRINGS[0].openFreq;
      const ratio = Math.max(0.72, f.f0 / open);
      f.velocity = Math.abs((scaleLengthCm / ratio) * (Math.log(2) / 1200) * f.centsPerSecond);
    } else if (f.sliding) {
      f.velocity = Math.abs((scaleLengthCm / 1.1) * (Math.log(2) / 1200) * f.centsPerSecond);
    }
  }

  // 滑音布尔值做少量滞后扩展，避免帧边界抖动。
  for (let i = 0; i < frameCount; i++) {
    if (!tracked[i].sliding) {
      const near = tracked.slice(Math.max(0, i - 2), Math.min(frameCount, i + 3)).some((x) => x.sliding);
      if (near && Math.abs(tracked[i].centsPerSecond) > 32) tracked[i].sliding = true;
    }
  }

  const strings = buildStringCurves(tracked);
  const scrapeEnvelope = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) scrapeEnvelope[i] = tracked[i].noiseLikelihood * (tracked[i].sliding ? 1 : 0.25);

  const plainFrames: FrameAnalysis[] = tracked.map(({ flatness: _flatness, highRatio: _high, harmFreq: _hf, harmAmp: _ha, harmPhase: _hp, ...rest }) => rest);
  const result: AnalysisResult = {
    sampleRate,
    fftSize: engine.fftSize,
    hopSize: engine.hopSize,
    duration: samples.length / sampleRate,
    frames: plainFrames,
    strings,
    scrapeEnvelope,
  };
  if (onProgress) onProgress(0.5);
  return { result, tracked };
}

export function buildStringCurves(frames: TrackedFrame[] | FrameAnalysis[]): StringPitchCurve[] {
  const curves: StringPitchCurve[] = GUQIN_STRINGS.map((s) => ({
    stringIndex: s.index,
    openFreq: s.openFreq,
    label: s.label,
    points: [],
  }));
  for (const f of frames) {
    if (f.f0 <= 0 || f.stringIndex < 0) continue;
    const idx = clamp(f.stringIndex, 0, 6);
    curves[idx].points.push({
      time: f.time,
      freq: f.f0,
      midi: f.midi,
      confidence: f.confidence,
      sliding: f.sliding,
      velocity: f.velocity,
      wrapRate: f.wrapRate,
      wrapClarity: f.wrapClarity,
    });
  }
  return curves;
}

function segmentAtTime(settings: ProcessingSettings, time: number): SegmentSettings | null {
  for (const s of settings.segments) {
    if (time >= s.start && time < s.end) return s;
  }
  return null;
}

function retentionToCeiling(retention: number): number {
  const r = clamp(retention, 0, 1);
  return clamp(0.025 + 0.975 * Math.pow(r, 1.35), 0.025, 1);
}

/**
 * 离线/验收主处理。AudioWorklet 中使用同一套逐帧引擎和增益规则。
 */
export function processGuqinAudio(
  samples: Float32Array,
  sampleRate: number,
  settings: ProcessingSettings,
  options: ProcessOptions = {},
): ProcessResult {
  const analysisPack = analyzePitch(samples, sampleRate, settings.segments);
  const tracked = analysisPack.tracked;
  const frameCount = tracked.length;
  const N = analysisPack.result.fftSize;
  const H = analysisPack.result.hopSize;
  const bins = N / 2 + 1;
  const engine = new GuqinFrameEngine(sampleRate);

  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const sRe = new Float32Array(N);
  const sIm = new Float32Array(N);
  const frameSamples = new Float32Array(N);
  const noisePow = new Float32Array(bins);
  const smoothNoise = new Float32Array(bins);
  const resPow = new Float32Array(bins);
  const smoothGain = new Float32Array(bins).fill(1);
  const tonal = new Float32Array(bins);
  const gains: Float32Array[] | undefined = options.collectGains ? [] : undefined;

  const output = new Float32Array(samples.length + N);
  const norm = new Float32Array(samples.length + N);
  const harmonicRaw = options.collectHarmonicModel ? new Float32Array(samples.length + N) : null;
  const harmonicNorm = options.collectHarmonicModel ? new Float32Array(samples.length + N) : null;
  const harmTime = options.collectHarmonicModel ? new Float32Array(N) : undefined;
  let activity = 0;

  for (let fi = 0; fi < frameCount; fi++) {
    const tf = tracked[fi];
    const start = fi * H;
    engine.getFrameSamples(samples, fi, frameSamples);
    engine.fft.magnitudeSpectrum(frameSamples, re, im);
    engine.refineHarmonicsFromSpectrum(tf, re, im);
    for (let k = 0; k < bins; k++) {
      const m = Math.hypot(re[k], im[k]);
      // magnitudeSpectrum 已经算过 mag，但为了保持引擎数组私有，这里复用局部平方。
      smoothNoise[k] = m;
    }

    // 缠丝周期纹路：由音高斜率估算物理速度，再在候选缠弦密度中找自相关峰。
    if (tf.sliding && tf.stringIndex >= 0) {
      const wrap = engine.estimateWinding(frameSamples, tf.velocity, tf.stringIndex, options.stringDensities);
      tf.wrapClarity = wrap.clarity;
      tf.wrapDensity = wrap.density;
      tf.wrapRate = wrap.rate;
      const plain = analysisPack.result.frames[fi];
      if (plain) {
        plain.wrapClarity = wrap.clarity;
        plain.wrapDensity = wrap.density;
        plain.wrapRate = wrap.rate;
      }
      for (const p of analysisPack.result.strings[tf.stringIndex]?.points ?? []) {
        if (Math.abs(p.time - tf.time) < H / sampleRate) {
          p.wrapClarity = wrap.clarity;
          p.wrapRate = wrap.rate;
        }
      }
    }

    const seg = segmentAtTime(settings, tf.time);
    const retention = seg?.scrapeRetention ?? 0.18;
    const segStrength = seg?.strength ?? 1;
    const preserve = seg?.preserveResonance ?? settings.resonance;
    const targetActivity = tf.sliding ? clamp(0.65 + tf.noiseLikelihood * 0.45 + tf.wrapClarity * 0.2, 0, 1) : 0;
    activity += (targetActivity - activity) * (targetActivity > activity ? 0.42 : 0.16);

    tonal.fill(0);
    if (tf.f0 > 0) {
      const binHz = sampleRate / N;
      for (let h = 1; h <= PARTIALS; h++) {
        const fc = tf.harmFreq[h - 1] || h * tf.f0;
        const kc = fc / binHz;
        const radius = 1.7 + settings.harmonicProtection * 2.4;
        const lo = Math.max(1, Math.floor(kc - radius));
        const hi = Math.min(bins - 2, Math.ceil(kc + radius));
        for (let k = lo; k <= hi; k++) {
          const d = Math.abs(k - kc) / radius;
          tonal[k] = Math.max(tonal[k], d < 1 ? 0.5 + 0.5 * Math.cos(Math.PI * d) : 0);
        }
      }
    }

    const beta = (1.15 + 2.35 * settings.strength) * segStrength;
    for (let k = 1; k < bins - 1; k++) {
      const mag = smoothNoise[k];
      const p = mag * mag;
      const noiseAlpha = 0.018 + activity * 0.22 * (1 - 0.92 * tonal[k]);
      noisePow[k] += noiseAlpha * (p - noisePow[k]);
      if (noisePow[k] < 1e-10) noisePow[k] = 1e-10;

      const resAlpha = p > resPow[k] ? 0.055 * (1 - activity * 0.72) : 0;
      resPow[k] += resAlpha * (p - resPow[k]);
      resPow[k] *= 0.9962;
      if (resPow[k] < 1e-10) resPow[k] = 1e-10;
    }
    // 频域平滑噪声 PSD，并用邻域填补谐波 bin，避免把谐波误当噪声模板。
    const oldNoise = noisePow.slice();
    for (let k = 2; k < bins - 2; k++) {
      noisePow[k] = oldNoise[k] * 0.52 + (oldNoise[k - 2] + oldNoise[k - 1] + oldNoise[k + 1] + oldNoise[k + 2]) * 0.12;
    }

    const ceilingBase = retentionToCeiling(retention);
    for (let k = 1; k < bins - 1; k++) {
      const hz = (k * sampleRate) / N;
      const p = smoothNoise[k] * smoothNoise[k];
      const np = noisePow[k];
      const clean = Math.max(0, p - beta * np);
      let g = clamp(Math.sqrt(clean / (p + 1e-12)), 0.025, 1);
      // 擦弦能量主要在 1 kHz 以上；低频基频区不做整体封项，避免音高跟踪跳到琴体模态。
      const highWeight = clamp((hz - 650) / 650, 0, 1);
      const frequencyCeiling = 1 - activity * highWeight * (1 - ceilingBase);
      g = Math.min(g, frequencyCeiling);
      // 琴身共鸣/稳定余韵保护：持久谱能量越高，增益下限越高。
      const resConf = clamp(resPow[k] / (np * 2.4 + p * 0.18 + 1e-10), 0, 1);
      const resFloor = preserve * 0.16 * resConf * (1 - tonal[k] * 0.35);
      g = Math.max(g, resFloor);
      // 极低频琴体共鸣与基频额外保护。
      if (hz < 240) g = Math.max(g, preserve * 0.72);
      else if (hz < 700) g = Math.max(g, preserve * 0.48);
      // 谐波核心 bin 近乎直通，保证处理前后音高曲线一致。
      if (tonal[k] > 0.82) g = Math.max(g, 0.96);

      const target = g;
      const a = target < smoothGain[k] ? 0.48 : 0.16;
      smoothGain[k] += a * (target - smoothGain[k]);
    }
    smoothGain[0] = 1;
    smoothGain[bins - 1] = clamp(smoothGain[bins - 1], 0.05, 1);

    // 轻微频率平滑，抑制音乐噪声。
    const finalGain = smoothGain.slice();
    for (let k = 2; k < bins - 2; k++) {
      finalGain[k] = smoothGain[k] * 0.62 + (smoothGain[k - 1] + smoothGain[k + 1]) * 0.19;
    }
    // 基频/低次谐波区逐 bin 直通。该区域几乎没有缠弦沙沙能量，却能保证处理前后音高曲线一致。
    for (let k = 0; k < bins; k++) {
      if ((k * sampleRate) / N <= 680) finalGain[k] = 1;
    }
    if (gains) gains.push(finalGain.slice());

    engine.synthesizeHarmonics(fi, tf, tracked, sRe, sIm, harmTime);
    for (let k = 0; k < bins; k++) {
      const g = finalGain[k];
      re[k] = g * re[k] + (1 - g) * sRe[k];
      im[k] = g * im[k] + (1 - g) * sIm[k];
    }
    // 由正频率重建共轭负频率；否则未修改的负频率会把一半原信号混回输出。
    for (let k = bins; k < N; k++) {
      const j = N - k;
      re[k] = re[j];
      im[k] = -im[j];
    }
    engine.fft.inverse(re, im);
    for (let n = 0; n < N; n++) {
      const idx = start + n;
      if (idx >= output.length) break;
      const w = engine.fft.window[n];
      output[idx] += re[n] * w;
      norm[idx] += w * w;
      if (harmonicRaw && harmonicNorm && harmTime) {
        harmonicRaw[idx] += harmTime[n] * w;
        harmonicNorm[idx] += w * w;
      }
    }

    if (options.onProgress && (fi & 1023) === 0) options.onProgress(0.5 + 0.5 * (fi / frameCount));
  }

  const channel = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) channel[i] = output[i] / Math.max(norm[i], 1e-6);
  let harmonicModel: Float32Array | undefined;
  if (harmonicRaw && harmonicNorm) {
    harmonicModel = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) harmonicModel[i] = harmonicRaw[i] / Math.max(harmonicNorm[i], 1e-6);
  }
  if (options.onProgress) options.onProgress(1);
  return { channels: [channel], sampleRate, analysis: analysisPack.result, gains, harmonicModel };
}

/** 将离线处理时保存的同一组 STFT 增益施加到已知分轨，供客观验收。 */
export function applySavedGainsToStem(stem: Float32Array, _sampleRate: number, gains: Float32Array[]): Float32Array {
  const N = 2048;
  const H = 512;
  const bins = N / 2 + 1;
  const fft = new FFT(N);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const output = new Float32Array(stem.length + N);
  const norm = new Float32Array(stem.length + N);
  const frame = new Float32Array(N);
  const frameCount = Math.max(1, Math.ceil(stem.length / H));
  for (let fi = 0; fi < frameCount; fi++) {
    const start = fi * H;
    frame.fill(0);
    const count = Math.min(N, stem.length - start);
    if (count > 0) frame.set(stem.subarray(start, start + count));
    fft.magnitudeSpectrum(frame, re, im);
    const g = gains[Math.min(fi, gains.length - 1)] ?? new Float32Array(bins).fill(1);
    for (let k = 0; k < bins; k++) {
      re[k] *= g[k];
      im[k] *= g[k];
    }
    for (let k = bins; k < N; k++) {
      const j = N - k;
      re[k] = re[j];
      im[k] = -im[j];
    }
    fft.inverse(re, im);
    for (let n = 0; n < N; n++) {
      const idx = start + n;
      if (idx >= output.length) break;
      const w = fft.window[n];
      output[idx] += re[n] * w;
      norm[idx] += w * w;
    }
  }
  const out = new Float32Array(stem.length);
  for (let i = 0; i < stem.length; i++) out[i] = output[i] / Math.max(norm[i], 1e-6);
  return out;
}
