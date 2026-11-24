import '../styles.css';
import { AudioPlayer } from '../audio/player.ts';
import { MASTERS, STRING_SETS } from '../audio/synthetic.ts';
import type { AcceptanceResult } from '../dsp/acceptance.ts';
import type { AnalysisResult, ProcessingSettings, SegmentSettings } from '../dsp/types.ts';
import { GUQIN_STRINGS } from '../dsp/types.ts';
import { drawEnvelope, drawPitchChart, drawWaveform } from './charts.ts';

type Route = 'import' | 'pitch' | 'process' | 'segments';
type PlaybackSource = 'original' | 'processed';

interface Project {
  fileName: string;
  sampleRate: number;
  duration: number;
  original: Float32Array;
  originalAudioBuffer?: AudioBuffer;
  processed?: Float32Array;
  processedBuffer?: AudioBuffer;
  analysis?: AnalysisResult;
  processedAnalysis?: AnalysisResult;
  densities?: number[];
  masterName?: string;
  setName?: string;
}

interface Toast { id: number; kind: 'info' | 'success' | 'error'; text: string }

interface AppState {
  route: Route;
  project: Project | null;
  settings: ProcessingSettings;
  selectedSegmentId: string | null;
  hiddenStrings: boolean[];
  playbackSource: PlaybackSource;
  isPlaying: boolean;
  busy: string | null;
  acceptance: AcceptanceResult | null;
  liveFrame: { f0: number; noiseLikelihood: number; wrapRate: number; sliding: boolean; scrapeBandRms?: number } | null;
  toasts: Toast[];
  synthMaster: number;
  synthSet: number;
}

const player = new AudioPlayer();
let worker: Worker | null = null;
let workerRequestId = 1;
const pendingWorker = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

const state: AppState = {
  route: 'import',
  project: null,
  settings: { strength: 1.15, harmonicProtection: 0.9, resonance: 0.92, windingTexture: 1, segments: [] },
  selectedSegmentId: null,
  hiddenStrings: [false, false, false, false, false, false, false],
  playbackSource: 'original',
  isPlaying: false,
  busy: null,
  acceptance: null,
  liveFrame: null,
  toasts: [],
  synthMaster: 0,
  synthSet: 0,
};

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('../workers/process-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent) => {
      const { id, type, ...payload } = event.data as { id: number; type: string; [k: string]: unknown };
      const p = pendingWorker.get(id);
      if (!p) return;
      pendingWorker.delete(id);
      if (type === 'error') p.reject(new Error(String(payload.message ?? 'Worker 处理失败')));
      else p.resolve(payload);
    };
    worker.onerror = (e) => {
      for (const [id, p] of pendingWorker) {
        p.reject(new Error(e.message));
        pendingWorker.delete(id);
      }
    };
  }
  return worker;
}

function callWorker<T = Record<string, unknown>>(message: Record<string, unknown>): Promise<T> {
  const id = workerRequestId++;
  const w = getWorker();
  return new Promise<T>((resolve, reject) => {
    pendingWorker.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ ...message, id });
  });
}

function toast(text: string, kind: Toast['kind'] = 'info'): void {
  const id = Date.now() + Math.floor(Math.random() * 1000);
  state.toasts.push({ id, text, kind });
  renderToasts();
  window.setTimeout(() => {
    state.toasts = state.toasts.filter((t) => t.id !== id);
    renderToasts();
  }, 3600);
}

function formatTime(t: number): string {
  if (!Number.isFinite(t)) return '00:00.0';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(1).padStart(4, '0')}`;
}

function makeSegmentsFromAnalysis(analysis: AnalysisResult): SegmentSettings[] {
  const hop = analysis.hopSize / analysis.sampleRate;
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i < analysis.frames.length; i++) {
    const f = analysis.frames[i];
    if (f.sliding && f.f0 > 0) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (i - start >= 7) runs.push([start, i]);
      start = -1;
    }
  }
  if (start >= 0 && analysis.frames.length - start >= 7) runs.push([start, analysis.frames.length]);
  return runs.map(([a, b], i) => {
    const median = analysis.frames.slice(a, b).map((f) => f.f0).filter(Boolean).sort((x, y) => x - y)[Math.floor((b - a) / 2)] ?? 110;
    let stringIndex = 0;
    let best = Infinity;
    GUQIN_STRINGS.forEach((s, idx) => {
      const d = Math.abs(1200 * Math.log2(median / s.openFreq));
      if (d < best) { best = d; stringIndex = idx; }
    });
    return {
      id: `auto-seg-${Date.now()}-${i}`,
      label: `自动走手段 ${i + 1}`,
      start: Math.max(0, a * hop - 0.18),
      end: Math.min(analysis.duration, b * hop + 0.22),
      stringIndex,
      scrapeRetention: 0.12,
      strength: 1.08,
      preserveResonance: 0.92,
      color: GUQIN_STRINGS[stringIndex].color,
    };
  });
}

function setBusy(text: string | null): void {
  state.busy = text;
  render();
}

async function loadSynthetic(): Promise<void> {
  setBusy('正在在 Worker 中合成四位琴家风格测试曲...');
  try {
    const res = await callWorker<{
      samples: Float32Array; sampleRate: number; duration: number; segments: SegmentSettings[];
      densities: number[]; masterName: string; setName: string;
    }>({ type: 'synth', masterIndex: state.synthMaster, setIndex: state.synthSet, durationSec: 28 });
    state.project = {
      fileName: `合成测试 · ${res.masterName} · ${res.setName}`,
      sampleRate: res.sampleRate,
      duration: res.duration,
      original: res.samples,
      densities: res.densities,
      masterName: res.masterName,
      setName: res.setName,
    };
    state.settings.segments = res.segments;
    state.selectedSegmentId = res.segments[0]?.id ?? null;
    state.playbackSource = 'original';
    state.route = 'pitch';
    toast('合成录音已载入，七弦走手曲线已生成', 'success');
    setBusy('正在逐帧跟踪谐波...');
    const analyzed = await callWorker<{ analysis: AnalysisResult }>({
      type: 'analyze', samples: state.project.original, sampleRate: res.sampleRate, segments: res.segments,
    });
    state.project.analysis = analyzed.analysis;
    setBusy(null);
  } catch (e) {
    setBusy(null);
    toast(e instanceof Error ? e.message : '合成失败', 'error');
  }
}

async function loadFile(file: File): Promise<void> {
  setBusy(`正在解码 ${file.name}...`);
  try {
    const audioBuffer = await player.decode(file);
    const samples = player.toMono(audioBuffer);
    const project: Project = {
      fileName: file.name,
      sampleRate: audioBuffer.sampleRate,
      duration: audioBuffer.duration,
      original: samples,
      originalAudioBuffer: audioBuffer,
    };
    state.project = project;
    state.route = 'pitch';
    setBusy('正在跟踪音高并寻找走手段...');
    const initial = await callWorker<{ analysis: AnalysisResult }>({ type: 'analyze', samples, sampleRate: audioBuffer.sampleRate, segments: [] });
    const segments = makeSegmentsFromAnalysis(initial.analysis);
    state.settings.segments = segments;
    state.selectedSegmentId = segments[0]?.id ?? null;
    const analyzed = await callWorker<{ analysis: AnalysisResult }>({ type: 'analyze', samples, sampleRate: audioBuffer.sampleRate, segments });
    project.analysis = analyzed.analysis;
    setBusy(null);
    toast(`导入成功，识别出 ${segments.length} 个走手段`, 'success');
  } catch (e) {
    setBusy(null);
    toast(e instanceof Error ? e.message : '音频解码失败', 'error');
  }
}

async function runProcessing(): Promise<void> {
  const p = state.project;
  if (!p) return;
  setBusy('AudioWorklet 同源 DSP 正在估计缠丝纹理并分离擦弦声...');
  try {
    const res = await callWorker<{ channel: Float32Array; analysis: AnalysisResult }>({
      type: 'process',
      samples: p.original,
      sampleRate: p.sampleRate,
      settings: state.settings,
      densities: p.densities,
    });
    p.processed = res.channel;
    p.processedAnalysis = res.analysis;
    p.processedBuffer = undefined;
    state.playbackSource = 'processed';
    setBusy(null);
    toast('处理完成：谐波核心与琴体共鸣已保护', 'success');
    render();
  } catch (e) {
    setBusy(null);
    toast(e instanceof Error ? e.message : '处理失败', 'error');
  }
}

async function togglePlay(): Promise<void> {
  const p = state.project;
  if (!p) return;
  if (state.isPlaying) {
    player.pause();
    state.isPlaying = false;
    render();
    return;
  }
  try {
    let buffer: AudioBuffer;
    if (state.playbackSource === 'processed' && p.processed) {
      p.processedBuffer ??= await player.prepareBuffer(p.processed, p.sampleRate);
      buffer = p.processedBuffer;
    } else if (p.originalAudioBuffer) {
      buffer = p.originalAudioBuffer;
    } else {
      buffer = await player.prepareBuffer(p.original, p.sampleRate);
    }
    player.onEnded = () => {
      state.isPlaying = false;
      render();
    };
    player.onFrame = (payload) => {
      const data = payload as { frame?: { f0?: number; noiseLikelihood?: number; wrapRate?: number; sliding?: boolean }; scrape?: { bandRms?: number } };
      const f = data.frame;
      if (f) state.liveFrame = {
        f0: f.f0 ?? 0,
        noiseLikelihood: f.noiseLikelihood ?? 0,
        wrapRate: f.wrapRate ?? 0,
        sliding: !!f.sliding,
        scrapeBandRms: data.scrape?.bandRms ?? 0,
      };
    };
    await player.play(buffer);
    state.isPlaying = true;
    render();
  } catch (e) {
    toast(e instanceof Error ? e.message : '播放失败', 'error');
  }
}

function seek(time: number): void {
  player.seek(time);
  updatePlaybackUi();
}

function updatePlaybackUi(): void {
  const fill = document.querySelector<HTMLElement>('[data-progress-fill]');
  const time = document.querySelector<HTMLElement>('[data-time]');
  const t = player.currentTime();
  const d = state.project?.duration ?? 1;
  if (fill) fill.style.width = `${(t / d) * 100}%`;
  if (time) time.textContent = `${formatTime(t)} / ${formatTime(d)}`;
}

function renderToasts(): void {
  let stack = document.querySelector<HTMLElement>('.toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.className = 'toast-stack';
    document.body.appendChild(stack);
  }
  stack.innerHTML = state.toasts.map((t) => `<div class="toast ${t.kind}">${t.text}</div>`).join('');
}

function navHtml(): string {
  const items: Array<[Route, string, string, string]> = [
    ['import', '壹', '录音导入', '文件与合成测试曲'],
    ['pitch', '贰', '音高曲线', '七弦逐帧跟踪'],
    ['process', '叁', '擦弦处理', '谐波/宽带分离'],
    ['segments', '肆', '段落调节', '按段保留擦弦'],
  ];
  return `
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-seal">弦</div>
        <div><div class="brand-title">丝桐分沙</div><div class="brand-sub">GUQIN SCRAPE LAB</div></div>
      </div>
      <nav class="nav">
        ${items.map(([route, idx, title, desc]) => `
          <button class="nav-button ${state.route === route ? 'active' : ''}" data-route="${route}">
            <span class="nav-index">${idx}</span>
            <span class="nav-title">${title}</span>
            <span class="nav-desc">${desc}</span>
            <span class="nav-check">${route === 'process' && state.project?.processed ? '●' : ''}</span>
          </button>`).join('')}
      </nav>
      <div class="side-card">
        <h4>DSP 运行位置</h4>
        <p>FFT=2048，Hop=512。逐帧音高、缠丝周期与噪声可能性在 AudioWorklet 中运行；离线导出使用同一套核心算法。</p>
        <p style="margin-top:8px">Worklet：<span class="badge info">${player.workletStatus}</span></p>
      </div>
    </aside>`;
}

function topbarHtml(title: string, desc: string): string {
  return `<header class="topbar"><div><div class="eyebrow">Qin string scrape separator</div><h1>${title}</h1><p>${desc}</p></div>
  <div class="top-actions">
    ${state.route === 'import'
      ? '<button class="btn" data-action="choose-file">选择音频文件</button>'
      : '<button class="btn" data-route="import">更换录音</button>'}
    ${state.project ? '<button class="btn primary" data-action="quick-process">运行分离</button>' : ''}
  </div></header>`;
}

function importPage(): string {
  const p = state.project;
  return `${topbarHtml('录音导入', '导入近距录制的古琴音频，或载入按虚构琴家风格与缠弦密度合成的测试曲。所有音频仅在本机浏览器和 Worker 中处理。')}
  <div class="grid two">
    <section class="card">
      <h2>① 音频文件</h2>
      <label class="dropzone" data-dropzone>
        <div class="drop-icon">🎼</div>
        <strong>拖拽 WAV / MP3 / FLAC 到这里，或点击选择</strong>
        <p>建议 44.1/48 kHz 单声道或立体声；十分钟琴曲会在 Worker 中处理，不阻塞界面。</p>
        <input class="input-hidden" type="file" accept="audio/*" data-file-input />
        <span class="btn primary">选择音频文件</span>
      </label>
      ${p ? `<div class="meta-list">
        <div class="meta"><label>当前录音</label><value title="${p.fileName}">${p.fileName}</value></div>
        <div class="meta"><label>采样率 / 时长</label><value>${p.sampleRate} Hz · ${formatTime(p.duration)}</value></div>
        <div class="meta"><label>风格</label><value>${p.masterName ?? '用户导入录音'}</value></div>
        <div class="meta"><label>缠弦规格</label><value>${p.setName ?? '待估计'}</value></div>
      </div>
      <div class="canvas-wrap" style="margin-top:16px"><canvas class="waveform" data-wave></canvas></div>` : ''}
    </section>
    <section class="card">
      <h2>② 合成测试录音</h2>
      <div class="field"><label>琴家演奏风格（虚构）</label>
        <select data-synth-master>${MASTERS.map((m, i) => `<option value="${i}" ${i === state.synthMaster ? 'selected' : ''}>${m.name} — ${m.description}</option>`).join('')}</select>
      </div>
      <div class="field"><label>琴弦缠弦密度</label>
        <select data-synth-set>${STRING_SETS.map((s, i) => `<option value="${i}" ${i === state.synthSet ? 'selected' : ''}>${s.name}（${s.windingPerCm.join('/')} 圈/cm）</option>`).join('')}</select>
      </div>
      <div class="choice-grid">
        ${MASTERS.map((m, i) => `<button class="choice ${state.synthMaster === i ? 'active' : ''}" data-pick-master="${i}"><strong>${m.name}</strong><span>${m.description}</span></button>`).join('')}
      </div>
      <button class="btn gold" style="width:100%;margin-top:14px" data-action="load-synth">生成 28 秒验收测试曲</button>
      <button class="btn" style="width:100%;margin-top:9px" data-action="run-acceptance">在浏览器复算三指标</button>
      ${state.acceptance ? acceptanceHtml(state.acceptance) : '<p class="hint" style="margin-top:12px">验收口径：擦弦 RMS 压低 ≥15 dB；已知谐波轨能量损失 ≤1 dB；处理前后显示音高曲线最大偏差 ≤5 cents。</p>'}
    </section>
  </div>`;
}

function acceptanceHtml(r: AcceptanceResult): string {
  return `<div style="margin-top:16px" class="metric-grid">
    <div class="metric ${r.passNoise ? 'pass' : 'warn'}"><div class="value">${r.scrapeReductionDb.toFixed(1)}<small> dB</small></div><div class="label">擦弦压低 ${r.passNoise ? 'PASS' : 'FAIL'} · 目标 15</div></div>
    <div class="metric ${r.passHarmonic ? 'pass' : 'warn'}"><div class="value">${r.harmonicLossDb.toFixed(2)}<small> dB</small></div><div class="label">谐波损失 ${r.passHarmonic ? 'PASS' : 'FAIL'} · ≤1</div></div>
    <div class="metric ${r.passPitch ? 'pass' : 'warn'}"><div class="value">${r.pitch.maxCents.toFixed(2)}<small> ¢</small></div><div class="label">最大音分差 ${r.passPitch ? 'PASS' : 'FAIL'} · ≤5</div></div>
    <div class="metric pass"><div class="value">${r.processSec.toFixed(1)}<small>s</small></div><div class="label">${r.audioSec}s 音频的浏览器处理耗时</div></div>
  </div>`;
}

function pitchPage(): string {
  const p = state.project;
  return `${topbarHtml('音高曲线', 'ACF 周期候选 + 谐波求和 + 弦开放音先验，逐帧跟踪七弦。亮点为单向走手段；处理会直通 680 Hz 以下的基频/低次谐波核心。')}
  <div class="grid two">
    <section class="card">
      <h2>七弦音高与走手段</h2>
      <div class="canvas-wrap"><canvas class="chart tall" data-pitch-chart></canvas><div class="tooltip" data-tooltip></div></div>
      <div class="legend">${GUQIN_STRINGS.map((s, i) => `<label class="legend-item"><input type="checkbox" data-string-toggle="${i}" ${state.hiddenStrings[i] ? '' : 'checked'}><span class="legend-swatch" style="background:${s.color}"></span>${s.label}</label>`).join('')}</div>
    </section>
    <section class="card">
      <h2>跟踪状态</h2>
      ${p?.analysis ? `<div class="metric-grid" style="grid-template-columns:1fr 1fr">
        <div class="metric pass"><div class="value">${p.analysis.frames.filter(f => f.sliding).length}</div><div class="label">走手帧 / 共 ${p.analysis.frames.length}</div></div>
        <div class="metric"><div class="value">${state.settings.segments.length}</div><div class="label">可调节段落</div></div>
      </div>
      <h3>AudioWorklet 实时帧</h3>
      <table class="kv-table"><tr><td>当前 f0</td><td>${state.liveFrame?.f0 ? `${state.liveFrame.f0.toFixed(2)} Hz` : '等待播放/输入'}</td></tr>
      <tr><td>擦弦可能性</td><td>${state.liveFrame ? (state.liveFrame.noiseLikelihood * 100).toFixed(0) + '%' : '—'}</td></tr>
      <tr><td>Worklet 擦弦谱估计</td><td>${state.liveFrame?.scrapeBandRms ? state.liveFrame.scrapeBandRms.toExponential(2) : '等待播放'}</td></tr>
      <tr><td>缠丝周期</td><td>${state.liveFrame?.wrapRate ? state.liveFrame.wrapRate.toFixed(1) + ' Hz' : '非滑动/未检出'}</td></tr>
      <tr><td>Worklet</td><td><span class="badge ${player.workletStatus === '已连接' ? 'pass' : 'warn'}">${player.workletStatus}</span></td></tr></table>
      <h3>虚构缠弦密度</h3>
      <p class="hint">${p.densities ? p.densities.map((d, i) => `${GUQIN_STRINGS[i].label.split(' ')[0]} ${d.toFixed(2)} 圈/cm`).join('；') : '导入音频将通过 1.05–3.15 圈/cm 候选网格自相关估计。'}</p>`
      : '<div class="empty-state"><div><div class="big">🎻</div>请先在“录音导入”页生成或载入音频。</div></div>'}
    </section>
  </div>`;
}

function processPage(): string {
  const p = state.project;
  return `${topbarHtml('擦弦声处理', '宽带噪声 PSD、缠丝 AM 自相关与谐波替换共同工作；谐波核心和持久琴体模态不会被普通降噪压掉。')}
  <div class="grid two">
    <section class="card">
      <h2>全局处理参数</h2>
      ${sliderHtml('strength', '擦弦 subtraction 强度', state.settings.strength, 0, 1.6, 0.01, v => v.toFixed(2))}
      ${sliderHtml('harmonicProtection', '谐波保护宽度', state.settings.harmonicProtection, 0, 1, 0.01, v => `${Math.round(v * 100)}%`)}
      ${sliderHtml('resonance', '余韵 / 琴身共鸣保护', state.settings.resonance, 0, 1, 0.01, v => `${Math.round(v * 100)}%`)}
      ${sliderHtml('windingTexture', '缠丝周期纹理权重', state.settings.windingTexture, 0, 1, 0.01, v => `${Math.round(v * 100)}%`)}
      <button class="btn primary" style="width:100%;margin-top:12px" data-action="run-process" ${!p ? 'disabled' : ''}>开始逐帧分离</button>
      ${p?.processed ? '<p><span class="badge pass">已生成处理轨</span> 可在下方切换原轨/处理轨对比。</p>' : '<p class="hint">处理会在 Worker 中运行；AudioWorklet 源码位于 <span class="code-pill">src/worklet/guqin-worklet.ts</span>。</p>'}
    </section>
    <section class="card">
      <h2>对比试听</h2>
      <div class="player">
        <button class="btn primary" data-action="toggle-play">${state.isPlaying ? '⏸ 暂停' : '▶ 播放'}</button>
        <button class="btn ${state.playbackSource === 'original' ? 'gold' : ''}" data-source="original">原录音</button>
        <button class="btn ${state.playbackSource === 'processed' ? 'gold' : ''}" data-source="processed" ${!p?.processed ? 'disabled' : ''}>处理后</button>
        <span class="timecode" data-time>${formatTime(player.currentTime())} / ${formatTime(p?.duration ?? 0)}</span>
      </div>
      <div class="progress-track" data-seek><div class="progress-fill" data-progress-fill></div></div>
      <h3>擦弦可能性包络</h3>
      <div class="canvas-wrap" style="height:150px">${p?.analysis ? '<canvas data-envelope></canvas>' : '<div class="empty-state">尚无分析</div>'}</div>
      <h3>处理后音高曲线</h3>
      <div class="canvas-wrap" style="height:210px"><canvas data-process-pitch></canvas></div>
    </section>
  </div>`;
}

function sliderHtml(key: keyof ProcessingSettings, label: string, value: number, min: number, max: number, step: number, fmt: (v: number) => string): string {
  return `<div class="field"><div class="field-row"><label>${label}</label><output>${fmt(value)}</output></div>
  <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-setting="${key}" data-output-index /></div>`;
}

function segmentsPage(): string {
  const segments = state.settings.segments;
  const selected = segments.find((s) => s.id === state.selectedSegmentId) ?? segments[0] ?? null;
  return `${topbarHtml('段落调节', '每个走手段可单独决定擦弦声保留比例、局部强度和共鸣保护。0% 为尽量去除，100% 为原样保留；自动化会把参数送入同一组逐帧增益。')}
  <div class="grid" style="grid-template-columns: 360px minmax(0,1fr); align-items:start">
    <section class="card">
      <h2>走手段列表</h2>
      <button class="btn" style="width:100%;margin-bottom:12px" data-action="add-segment">在播放头处新增 2 秒段落</button>
      <div class="segment-list">
        ${segments.map((s) => `<div class="segment-row ${selected?.id === s.id ? 'selected' : ''}" style="--seg-color:${s.color}" data-select-segment="${s.id}">
          <div class="segment-head"><div class="segment-name"><span class="color-dot"></span>${s.label}</div><span class="segment-time">${formatTime(s.start)}–${formatTime(s.end)}</span></div>
          <div class="segment-mini"><i style="width:${s.scrapeRetention * 100}%"></i></div>
        </div>`).join('')}
      </div>
    </section>
    <section class="card">
      <h2>段落参数与曲线</h2>
      <div class="canvas-wrap" style="margin-bottom:16px"><canvas class="chart" data-segment-chart></canvas></div>
      ${selected ? `
        <div class="field"><label>段落名称</label><input type="text" value="${selected.label}" data-seg-field="label" /></div>
        <div class="field"><label>所属弦</label><select data-seg-field="stringIndex">${GUQIN_STRINGS.map((s, i) => `<option value="${i}" ${selected.stringIndex === i ? 'selected' : ''}>${s.label}</option>`).join('')}</select></div>
        <div class="field"><div class="field-row"><label>擦弦声保留</label><output>${Math.round(selected.scrapeRetention * 100)}%</output></div><input type="range" min="0" max="1" step="0.01" value="${selected.scrapeRetention}" data-seg-field="scrapeRetention"></div>
        <div class="field"><div class="field-row"><label>局部强度</label><output>${selected.strength.toFixed(2)}×</output></div><input type="range" min="0.4" max="1.8" step="0.01" value="${selected.strength}" data-seg-field="strength"></div>
        <div class="field"><div class="field-row"><label>共鸣保护</label><output>${Math.round(selected.preserveResonance * 100)}%</output></div><input type="range" min="0" max="1" step="0.01" value="${selected.preserveResonance}" data-seg-field="preserveResonance"></div>
        <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
          <div class="field"><label>开始 ${formatTime(selected.start)}</label><input type="range" min="0" max="${state.project?.duration ?? 1}" step="0.01" value="${selected.start}" data-seg-field="start"></div>
          <div class="field"><label>结束 ${formatTime(selected.end)}</label><input type="range" min="0" max="${state.project?.duration ?? 1}" step="0.01" value="${selected.end}" data-seg-field="end"></div>
        </div>
        <button class="btn danger" data-action="delete-segment">删除此段落</button>
      ` : '<div class="empty-state"><div><div class="big">☯</div>尚未创建段落</div></div>'}
    </section>
  </div>`;
}

function render(): void {
  const app = document.querySelector<HTMLDivElement>('#app');
  if (!app) return;
  let page = '';
  if (state.route === 'import') page = importPage();
  if (state.route === 'pitch') page = pitchPage();
  if (state.route === 'process') page = processPage();
  if (state.route === 'segments') page = segmentsPage();
  app.innerHTML = `<div class="app-shell">${navHtml()}<main class="main">${state.busy ? `<div class="toast" style="position:fixed;top:22px;left:50%;transform:translateX(-50%);z-index:60">${state.busy}</div>` : ''}${page}</main></div>`;
  bindEvents();
  requestAnimationFrame(drawVisibleCharts);
}

function drawVisibleCharts(): void {
  const p = state.project;
  const wave = document.querySelector<HTMLCanvasElement>('[data-wave]');
  if (wave && p) drawWaveform(wave, p.original, player.currentTime(), p.duration);
  const pitch = document.querySelector<HTMLCanvasElement>('[data-pitch-chart]');
  if (pitch) drawPitchChart(pitch, p?.analysis ?? null, { segments: state.settings.segments, selectedId: state.selectedSegmentId, hidden: state.hiddenStrings, playhead: player.currentTime(), onSeek: seek });
  const segChart = document.querySelector<HTMLCanvasElement>('[data-segment-chart]');
  if (segChart) drawPitchChart(segChart, p?.analysis ?? null, { segments: state.settings.segments, selectedId: state.selectedSegmentId, hidden: state.hiddenStrings, playhead: player.currentTime(), onSeek: seek });
  const env = document.querySelector<HTMLCanvasElement>('[data-envelope]');
  if (env && p?.analysis) drawEnvelope(env, p.analysis);
  const pp = document.querySelector<HTMLCanvasElement>('[data-process-pitch]');
  if (pp) drawPitchChart(pp, p?.processedAnalysis ?? p?.analysis ?? null, { segments: state.settings.segments, selectedId: state.selectedSegmentId, hidden: state.hiddenStrings, playhead: player.currentTime(), onSeek: seek });
}

function bindEvents(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-route]').forEach((b) => b.addEventListener('click', () => {
    state.route = b.dataset.route as Route;
    render();
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((b) => b.addEventListener('click', async () => {
    const action = b.dataset.action;
    if (action === 'choose-file') document.querySelector<HTMLInputElement>('[data-file-input]')?.click();
    if (action === 'load-synth') await loadSynthetic();
    if (action === 'run-process' || action === 'quick-process') { state.route = 'process'; render(); await runProcessing(); }
    if (action === 'toggle-play') await togglePlay();
    if (action === 'run-acceptance') {
      setBusy('正在运行合成验收...');
      try {
        const res = await callWorker<{ result: AcceptanceResult }>({ type: 'acceptance' });
        state.acceptance = res.result;
        setBusy(null);
        toast(res.result.pass ? '三项指标全部通过' : '有指标未通过，请看验收卡片', res.result.pass ? 'success' : 'error');
      } catch (e) { setBusy(null); toast(String(e), 'error'); }
    }
    if (action === 'add-segment') addSegmentAtPlayhead();
    if (action === 'delete-segment') deleteSelectedSegment();
  }));

  const file = document.querySelector<HTMLInputElement>('[data-file-input]');
  file?.addEventListener('change', () => { const f = file.files?.[0]; if (f) void loadFile(f); });
  const dz = document.querySelector<HTMLElement>('[data-dropzone]');
  dz?.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz?.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz?.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('drag'); const f = e.dataTransfer?.files?.[0]; if (f) void loadFile(f); });

  document.querySelectorAll<HTMLButtonElement>('[data-pick-master]').forEach((b) => b.addEventListener('click', () => { state.synthMaster = Number(b.dataset.pickMaster); render(); }));
  const masterSel = document.querySelector<HTMLSelectElement>('[data-synth-master]');
  masterSel?.addEventListener('change', () => { state.synthMaster = Number(masterSel.value); render(); });
  const setSel = document.querySelector<HTMLSelectElement>('[data-synth-set]');
  setSel?.addEventListener('change', () => { state.synthSet = Number(setSel.value); render(); });

  document.querySelectorAll<HTMLInputElement>('[data-setting]').forEach((input) => input.addEventListener('input', () => {
    const key = input.dataset.setting as keyof ProcessingSettings;
    const value = Number(input.value);
    (state.settings[key] as number) = value;
    const out = input.parentElement?.querySelector('output');
    if (out) out.textContent = key === 'harmonicProtection' || key === 'resonance' || key === 'windingTexture' ? `${Math.round(value * 100)}%` : value.toFixed(2);
  }));

  document.querySelectorAll<HTMLButtonElement>('[data-source]').forEach((b) => b.addEventListener('click', () => {
    state.playbackSource = b.dataset.source as PlaybackSource;
    if (state.isPlaying) void togglePlay().then(() => togglePlay());
    else render();
  }));
  document.querySelector<HTMLElement>('[data-seek]')?.addEventListener('pointerdown', (e) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    seek(ratio * (state.project?.duration ?? 0));
  });

  document.querySelectorAll<HTMLInputElement>('[data-string-toggle]').forEach((c) => c.addEventListener('change', () => {
    const i = Number(c.dataset.stringToggle);
    state.hiddenStrings[i] = !(c as HTMLInputElement).checked;
    drawVisibleCharts();
  }));
  document.querySelectorAll<HTMLElement>('[data-select-segment]').forEach((row) => row.addEventListener('click', () => {
    state.selectedSegmentId = row.dataset.selectSegment ?? null;
    render();
  }));
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-seg-field]').forEach((el) => {
    const updateModel = (): SegmentSettings | null => {
      const seg = state.settings.segments.find((s) => s.id === state.selectedSegmentId) ?? null;
      if (!seg) return null;
      const key = (el as HTMLElement).dataset.segField as keyof SegmentSettings;
      let value: string | number = el instanceof HTMLSelectElement || el.type === 'range' ? Number(el.value) : el.value;
      if (key === 'start' || key === 'end' || key === 'scrapeRetention' || key === 'strength' || key === 'preserveResonance' || key === 'stringIndex') {
        value = Number(value);
      }
      if (key === 'start' && typeof value === 'number' && value >= seg.end - 0.2) value = seg.end - 0.2;
      if (key === 'end' && typeof value === 'number' && value <= seg.start + 0.2) value = seg.start + 0.2;
      (seg[key] as string | number) = value;
      if (key === 'stringIndex') seg.color = GUQIN_STRINGS[Number(value)].color;
      return seg;
    };
    el.addEventListener('input', () => {
      const seg = updateModel();
      const output = el.parentElement?.querySelector('output');
      if (seg && el.type === 'range' && output) {
        const key = (el as HTMLElement).dataset.segField;
        const v = Number(el.value);
        output.textContent = key === 'scrapeRetention' || key === 'preserveResonance' ? `${Math.round(v * 100)}%` : key === 'strength' ? `${v.toFixed(2)}×` : v.toFixed(2);
      }
    });
    el.addEventListener('change', () => {
      updateModel();
      render();
    });
  });

  if (!(window as unknown as { __guqinResizeBound?: boolean }).__guqinResizeBound) {
    (window as unknown as { __guqinResizeBound?: boolean }).__guqinResizeBound = true;
    let resizeTimer = 0;
    window.addEventListener('resize', () => { window.clearTimeout(resizeTimer); resizeTimer = window.setTimeout(drawVisibleCharts, 120); });
  }
}

function addSegmentAtPlayhead(): void {
  const duration = state.project?.duration ?? 10;
  const t = player.currentTime();
  const seg: SegmentSettings = {
    id: `seg-${Date.now()}`,
    label: `自定义段落 ${state.settings.segments.length + 1}`,
    start: Math.max(0, t - 1),
    end: Math.min(duration, t + 1),
    stringIndex: 0,
    scrapeRetention: 0.12,
    strength: 1.1,
    preserveResonance: 0.92,
    color: GUQIN_STRINGS[0].color,
  };
  state.settings.segments.push(seg);
  state.selectedSegmentId = seg.id;
  toast('已新增段落，可在右侧拖动范围', 'success');
  render();
}

function deleteSelectedSegment(): void {
  state.settings.segments = state.settings.segments.filter((s) => s.id !== state.selectedSegmentId);
  state.selectedSegmentId = state.settings.segments[0]?.id ?? null;
  render();
}

function tick(): void {
  if (state.isPlaying) updatePlaybackUi();
  requestAnimationFrame(tick);
}

document.querySelector<HTMLDivElement>('#app')!.innerHTML = '<div class="empty-state" style="min-height:100vh"><div><div class="big">弦</div><p>正在启动 AudioWorklet 工作台...</p></div></div>';
render();
tick();
