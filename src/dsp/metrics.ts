import { centsBetween } from './fft.ts';
import type { AnalysisResult } from './types.ts';

export function rmsRange(x: ArrayLike<number>, sampleRate: number, start: number, end: number): number {
  const i0 = Math.max(0, Math.floor(start * sampleRate));
  const i1 = Math.min(x.length, Math.floor(end * sampleRate));
  if (i1 <= i0) return 0;
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += x[i] * x[i];
  return Math.sqrt(sum / (i1 - i0));
}

export function segmentRms(x: ArrayLike<number>, sampleRate: number, ranges: Array<{ start: number; end: number }>): number {
  let sum = 0;
  let count = 0;
  for (const r of ranges) {
    const i0 = Math.max(0, Math.floor(r.start * sampleRate));
    const i1 = Math.min(x.length, Math.floor(r.end * sampleRate));
    for (let i = i0; i < i1; i++) sum += x[i] * x[i];
    count += Math.max(0, i1 - i0);
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

export function levelDb(rms: number): number {
  return 20 * Math.log10(Math.max(1e-10, rms));
}

export interface PitchDeviationMetric {
  maxCents: number;
  p95Cents: number;
  medianCents: number;
  matchedFrames: number;
  worstTime: number;
}

function median3(values: number[], i: number): number {
  const arr = [values[Math.max(0, i - 1)], values[i], values[Math.min(values.length - 1, i + 1)]].filter((v) => v > 0).sort((a, b) => a - b);
  return arr.length ? arr[Math.floor(arr.length / 2)] : 0;
}

/** 对显示用音高曲线做与主分析一致的中值，并做保持线性滑音的居中三角平滑。 */
export function smoothedPitches(analysis: AnalysisResult): Float32Array {
  const raw = analysis.frames.map((f) => f.f0);
  const med = raw.map((_, i) => median3(raw, i));
  const out = new Float32Array(raw.length);
  const weights = [1, 2, 3, 2, 1];
  for (let i = 0; i < raw.length; i++) {
    let sum = 0;
    let wsum = 0;
    for (let d = -2; d <= 2; d++) {
      const j = i + d;
      if (j >= 0 && j < raw.length && med[j] > 0) {
        const w = weights[d + 2];
        sum += med[j] * w;
        wsum += w;
      }
    }
    out[i] = wsum > 0 ? sum / wsum : 0;
  }
  return out;
}

export function comparePitchCurves(before: AnalysisResult, after: AnalysisResult, smooth = true): PitchDeviationMetric {
  const a = smooth ? smoothedPitches(before) : before.frames.map((f) => f.f0);
  const b = smooth ? smoothedPitches(after) : after.frames.map((f) => f.f0);
  const deviations: number[] = [];
  let worstTime = 0;
  let worst = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const frame = before.frames[i];
    if (!frame || !frame.sliding || a[i] <= 0 || b[i] <= 0) continue;
    // 末尾 120 ms 是 STFT 零填充边界，居中曲线没有完整邻帧，不作为音高偏差验收点。
    if (before.duration - frame.time < 0.12 || after.duration - after.frames[i].time < 0.12) continue;
    const d = Math.abs(centsBetween(a[i], b[i]));
    deviations.push(d);
    if (d > worst) {
      worst = d;
      worstTime = frame.time;
    }
  }
  deviations.sort((x, y) => x - y);
  const p95 = deviations.length ? deviations[Math.min(deviations.length - 1, Math.floor(deviations.length * 0.95))] : 0;
  const median = deviations.length ? deviations[Math.floor(deviations.length / 2)] : 0;
  return { maxCents: worst, p95Cents: p95, medianCents: median, matchedFrames: deviations.length, worstTime };
}
