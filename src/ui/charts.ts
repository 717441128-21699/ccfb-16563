import { GUQIN_STRINGS, type AnalysisResult, type SegmentSettings } from '../dsp/types.ts';
import { smoothedPitches } from '../dsp/metrics.ts';

export interface PitchChartOptions {
  segments?: SegmentSettings[];
  selectedId?: string | null;
  hidden?: boolean[];
  playhead?: number;
  onSeek?: (time: number) => void;
}

export function setupCanvas(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; width: number; height: number } {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(320, rect.width);
  const height = Math.max(180, rect.height);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

export function drawWaveform(canvas: HTMLCanvasElement, samples: Float32Array, playhead = 0, duration = 1): void {
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const mid = height / 2;
  ctx.strokeStyle = 'rgba(190,224,205,.16)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(width, mid);
  ctx.stroke();
  if (!samples.length) return;
  const step = Math.max(1, Math.floor(samples.length / width));
  ctx.lineWidth = 1.1;
  const grad = ctx.createLinearGradient(0, 0, width, 0);
  grad.addColorStop(0, '#43c99a');
  grad.addColorStop(1, '#d8b56d');
  ctx.strokeStyle = grad;
  ctx.beginPath();
  for (let x = 0; x < width; x++) {
    const start = Math.floor((x / width) * samples.length);
    let min = 1;
    let max = -1;
    for (let i = start; i < Math.min(samples.length, start + step); i += 4) {
      const v = samples[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = mid - max * mid * 0.82;
    const y2 = mid - min * mid * 0.82;
    ctx.moveTo(x + 0.5, y1);
    ctx.lineTo(x + 0.5, y2);
  }
  ctx.stroke();
  const px = (playhead / Math.max(0.001, duration)) * width;
  ctx.strokeStyle = 'rgba(255,255,255,.72)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(px, 8);
  ctx.lineTo(px, height - 8);
  ctx.stroke();
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function drawPitchChart(canvas: HTMLCanvasElement, analysis: AnalysisResult | null, options: PitchChartOptions = {}): void {
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const padL = 54;
  const padR = 16;
  const padT = 16;
  const padB = 30;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const duration = analysis?.duration ?? 1;
  const midiMin = 34;
  const midiMax = 82;
  const x = (t: number) => padL + (t / duration) * plotW;
  const y = (m: number) => padT + (1 - (m - midiMin) / (midiMax - midiMin)) * plotH;

  ctx.font = '11px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  for (let m = midiMin; m <= midiMax; m += 3) {
    const yy = y(m);
    ctx.strokeStyle = m % 12 === 0 ? 'rgba(216,181,109,.22)' : 'rgba(190,224,205,.08)';
    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(width - padR, yy);
    ctx.stroke();
    const name = `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
    ctx.fillStyle = 'rgba(157,179,167,.72)';
    ctx.fillText(name, 8, yy);
  }

  if (options.segments) {
    for (const seg of options.segments) {
      const sx = x(seg.start);
      const ex = x(seg.end);
      ctx.fillStyle = seg.color + (seg.id === options.selectedId ? '38' : '1f');
      ctx.strokeStyle = seg.color + (seg.id === options.selectedId ? 'dd' : '66');
      ctx.lineWidth = seg.id === options.selectedId ? 1.6 : 1;
      ctx.fillRect(sx, padT, Math.max(2, ex - sx), plotH);
      ctx.strokeRect(sx, padT, Math.max(2, ex - sx), plotH);
    }
  }

  if (!analysis) {
    ctx.fillStyle = 'rgba(157,179,167,.65)';
    ctx.font = '14px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('导入或生成录音后，这里会显示七弦音高曲线', width / 2, height / 2);
    ctx.textAlign = 'left';
    return;
  }

  // 擦弦可能性底色。
  const env = analysis.scrapeEnvelope;
  const hop = analysis.hopSize / analysis.sampleRate;
  for (let i = 0; i < env.length; i++) {
    if (env[i] < 0.32) continue;
    const alpha = Math.min(0.16, env[i] * 0.13);
    ctx.fillStyle = `rgba(230,118,95,${alpha})`;
    ctx.fillRect(x(i * hop), padT, Math.max(1, hop * plotW / duration + 1), plotH);
  }

  const smooth = smoothedPitches(analysis);
  analysis.strings.forEach((curve, si) => {
    if (options.hidden?.[si]) return;
    const color = GUQIN_STRINGS[si].color;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    ctx.shadowColor = color;
    ctx.shadowBlur = 7;
    ctx.beginPath();
    let started = false;
    for (const p of curve.points) {
      const idx = Math.round(p.time / hop);
      const f = smooth[idx] || p.freq;
      if (f <= 0) continue;
      const px = x(p.time);
      const py = y(69 + 12 * Math.log2(f / 440));
      if (!started) {
        ctx.moveTo(px, py);
        started = true;
      } else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;

    for (const p of curve.points) {
      if (!p.sliding) continue;
      const idx = Math.round(p.time / hop);
      const f = smooth[idx] || p.freq;
      if (f <= 0) continue;
      ctx.fillStyle = '#fff4d6';
      ctx.beginPath();
      ctx.arc(x(p.time), y(69 + 12 * Math.log2(f / 440)), 2.1, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  if (options.playhead !== undefined) {
    const px = x(options.playhead);
    ctx.strokeStyle = 'rgba(255,255,255,.86)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px, padT - 4);
    ctx.lineTo(px, height - padB + 8);
    ctx.stroke();
  }

  ctx.fillStyle = 'rgba(157,179,167,.8)';
  ctx.font = '11px ui-monospace, monospace';
  for (let t = 0; t <= duration; t += duration > 120 ? 60 : duration > 30 ? 10 : 2) {
    const xx = x(t);
    ctx.fillText(`${t.toFixed(0)}s`, xx - 9, height - 12);
  }

  if (options.onSeek) {
    canvas.style.cursor = 'crosshair';
    canvas.onpointerdown = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const t = ((px - padL) / plotW) * duration;
      options.onSeek?.(Math.max(0, Math.min(duration, t)));
    };
  }
}

export function drawEnvelope(canvas: HTMLCanvasElement, analysis: AnalysisResult): void {
  const { ctx, width, height } = setupCanvas(canvas);
  ctx.clearRect(0, 0, width, height);
  const env = analysis.scrapeEnvelope;
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, 'rgba(230,118,95,.55)');
  grad.addColorStop(1, 'rgba(230,118,95,.03)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(0, height);
  for (let i = 0; i < env.length; i++) {
    const px = (i / env.length) * width;
    const py = height - env[i] * height * 0.9;
    ctx.lineTo(px, py);
  }
  ctx.lineTo(width, height);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#e6765f';
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let i = 0; i < env.length; i++) {
    const px = (i / env.length) * width;
    const py = height - env[i] * height * 0.9;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
}
