import { GUQIN_STRINGS, type SegmentSettings } from '../dsp/types.ts';
import { midiToFreq } from '../dsp/fft.ts';

export interface MasterStyle {
  id: string;
  name: string;
  era: string;
  description: string;
  glideSec: number;
  pauseSec: number;
  vibratoRate: number;
  vibratoCents: number;
  pressure: number;
  resonanceTail: number;
  phraseBias: number[];
}

/** 虚构的四位琴家与演奏风格，用于覆盖不同滑速、吟猱和擦弦强度。 */
export const MASTERS: MasterStyle[] = [
  {
    id: 'yunqi',
    name: '云栖老人',
    era: '虚构 · 虞山余韵',
    description: '沉缓迟涩，走手绵长，指压较重，擦弦纹理粗而密。',
    glideSec: 1.75,
    pauseSec: 0.72,
    vibratoRate: 4.7,
    vibratoCents: 18,
    pressure: 1.18,
    resonanceTail: 3.4,
    phraseBias: [4, 7, 5, 9, 4, 7, 5],
  },
  {
    id: 'songxue',
    name: '松雪居士',
    era: '虚构 · 广陵清劲',
    description: '滑音利落，速度较快，颗粒清楚，擦弦声短而亮。',
    glideSec: 0.82,
    pauseSec: 0.38,
    vibratoRate: 6.1,
    vibratoCents: 26,
    pressure: 0.92,
    resonanceTail: 2.2,
    phraseBias: [7, 12, 7, 5, 9, 12, 7],
  },
  {
    id: 'tingquan',
    name: '听泉女史',
    era: '虚构 · 金陵婉润',
    description: '吟猱细腻，滑速中等，起伏柔和，噪音呈连续细沙感。',
    glideSec: 1.28,
    pauseSec: 0.52,
    vibratoRate: 5.4,
    vibratoCents: 34,
    pressure: 0.82,
    resonanceTail: 2.9,
    phraseBias: [5, 7, 9, 7, 12, 9, 5],
  },
  {
    id: 'shimo',
    name: '石墨山人',
    era: '虚构 · 蜀山苍古',
    description: '指压极实，滑动忽快忽慢，缠丝周期明显，余韵很长。',
    glideSec: 1.42,
    pauseSec: 0.86,
    vibratoRate: 4.1,
    vibratoCents: 12,
    pressure: 1.34,
    resonanceTail: 4.2,
    phraseBias: [9, 5, 7, 12, 7, 4, 9],
  },
];

export interface StringSet {
  id: string;
  name: string;
  material: string;
  /** 每厘米缠丝圈数，七根弦由粗到细 */
  windingPerCm: number[];
  inharmonicity: number[];
}

/** 三套虚构缠弦规格；密度会改变擦弦声的周期纹路频率。 */
export const STRING_SETS: StringSet[] = [
  {
    id: 'traditional-silk',
    name: '太古丝缠弦',
    material: '真丝芯 · 蚕丝缠',
    windingPerCm: [3.1, 2.9, 2.65, 2.4, 2.15, 1.9, 1.65],
    inharmonicity: [0.00042, 0.00036, 0.0003, 0.00024, 0.00019, 0.00014, 0.0001],
  },
  {
    id: 'steel-nylon',
    name: '冰钢尼龙缠',
    material: '钢芯 · 尼龙扁平缠',
    windingPerCm: [2.2, 2.05, 1.85, 1.65, 1.45, 1.25, 1.05],
    inharmonicity: [0.00024, 0.00021, 0.00018, 0.00015, 0.00012, 0.00009, 0.00007],
  },
  {
    id: 'ice-string',
    name: '玄冰复合缠',
    material: '复合纤维芯 · 银铜缠丝',
    windingPerCm: [2.65, 2.5, 2.25, 2.0, 1.8, 1.55, 1.35],
    inharmonicity: [0.00031, 0.00028, 0.00023, 0.00019, 0.00016, 0.00012, 0.00009],
  },
];

export interface SynthEvent {
  id: string;
  start: number;
  duration: number;
  stringIndex: number;
  midiA: number;
  midiB: number;
  glideStart: number;
  glideDuration: number;
  masterId: string;
}

export interface SynthRecording {
  name: string;
  sampleRate: number;
  duration: number;
  mix: Float32Array;
  qin: Float32Array;
  harmonic: Float32Array;
  resonance: Float32Array;
  scrape: Float32Array;
  events: SynthEvent[];
  segments: SegmentSettings[];
  master: MasterStyle;
  stringSet: StringSet;
}

export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function smoothstep(u: number): number {
  const x = Math.max(0, Math.min(1, u));
  return x * x * (3 - 2 * x);
}

export function eventMidiAt(e: SynthEvent, t: number, master: MasterStyle): number {
  if (t < 0) return e.midiA;
  const u = (t - e.glideStart) / e.glideDuration;
  const g = smoothstep(u);
  let midi = e.midiA + (e.midiB - e.midiA) * g;
  if (u > 1) {
    const vt = t - e.glideStart - e.glideDuration;
    midi += Math.sin(2 * Math.PI * master.vibratoRate * vt) * master.vibratoCents / 100;
  } else if (u > 0.1) {
    midi += Math.sin(2 * Math.PI * master.vibratoRate * t) * master.vibratoCents / 260;
  }
  return midi;
}

interface BiquadState {
  x1: number; x2: number; y1: number; y2: number;
  b0: number; b1: number; b2: number; a1: number; a2: number;
}

function makeHighpass(sr: number, f: number, q = 0.707): BiquadState {
  const w0 = (2 * Math.PI * f) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    x1: 0, x2: 0, y1: 0, y2: 0,
    b0: ((1 + cos) / 2) / a0,
    b1: (-(1 + cos)) / a0,
    b2: ((1 + cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function makeLowpass(sr: number, f: number, q = 0.707): BiquadState {
  const w0 = (2 * Math.PI * f) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    x1: 0, x2: 0, y1: 0, y2: 0,
    b0: ((1 - cos) / 2) / a0,
    b1: (1 - cos) / a0,
    b2: ((1 - cos) / 2) / a0,
    a1: (-2 * cos) / a0,
    a2: (1 - alpha) / a0,
  };
}

function processBiquad(x: number, s: BiquadState): number {
  const y = s.b0 * x + s.b1 * s.x1 + s.b2 * s.x2 - s.a1 * s.y1 - s.a2 * s.y2;
  s.x2 = s.x1;
  s.x1 = x;
  s.y2 = s.y1;
  s.y1 = y;
  return y;
}

function buildEvents(durationSec: number, master: MasterStyle, seed: number): SynthEvent[] {
  const rand = seededRandom(seed);
  const events: SynthEvent[] = [];
  let t = 0.25;
  let n = 0;
  while (t < durationSec - 2.2) {
    const stringIndex = n % 7;
    const openMidi = 69 + 12 * Math.log2(GUQIN_STRINGS[stringIndex].openFreq / 440);
    const base = openMidi + [0, 2, 3, 5][Math.floor(rand() * 4)] + (stringIndex < 2 ? 0 : 0);
    const direction = n % 3 === 1 ? -1 : 1;
    const interval = master.phraseBias[stringIndex] * (0.55 + rand() * 0.7);
    const midiA = direction > 0 ? base : base + interval;
    const midiB = direction > 0 ? base + interval : base;
    const glideDuration = master.glideSec * (0.75 + rand() * 0.5);
    const noteDuration = Math.min(4.8, glideDuration + 1.55 + rand() * 1.2);
    events.push({
      id: `synth-event-${n + 1}`,
      start: t,
      duration: noteDuration,
      stringIndex,
      midiA,
      midiB,
      glideStart: 0.28 + rand() * 0.18,
      glideDuration,
      masterId: master.id,
    });
    t += noteDuration + master.pauseSec * (0.65 + rand() * 0.7);
    n++;
  }
  return events;
}

function eventsToSegments(events: SynthEvent[]): SegmentSettings[] {
  const colors = ['#8bd3ff', '#7cf0c8', '#d7f07c', '#ffd37c', '#ff9d7c', '#d3a4ff', '#ff9ed8'];
  return events
    .filter((e) => Math.abs(e.midiB - e.midiA) > 0.5)
    .map((e, i) => ({
      id: `seg-synth-${i + 1}`,
      label: `${GUQIN_STRINGS[e.stringIndex].label.split(' ')[0]} · 走手段 ${i + 1}`,
      start: Math.max(0, e.start + e.glideStart - 0.18),
      end: e.start + e.glideStart + e.glideDuration + 0.28,
      stringIndex: e.stringIndex,
      scrapeRetention: 0.12,
      strength: 1.08,
      preserveResonance: 0.9,
      color: colors[e.stringIndex],
    }));
}

/**
 * 生成带全部客观验收分轨的合成录音。
 * 十分钟基准测试可关闭 stems 以减少内存。
 */
export function synthesizeGuqinRecording(options: {
  durationSec?: number;
  sampleRate?: number;
  seed?: number;
  masterIndex?: number;
  setIndex?: number;
  stems?: boolean;
  name?: string;
} = {}): SynthRecording {
  const durationSec = options.durationSec ?? 28;
  const sr = options.sampleRate ?? 48000;
  const seed = options.seed ?? 20261125;
  const master = MASTERS[options.masterIndex ?? 0] ?? MASTERS[0];
  const stringSet = STRING_SETS[options.setIndex ?? 0] ?? STRING_SETS[0];
  const events = buildEvents(durationSec, master, seed);
  const total = Math.floor(durationSec * sr);
  const mix = new Float32Array(total);
  const harmonic = options.stems === false ? new Float32Array(0) : new Float32Array(total);
  const resonance = options.stems === false ? new Float32Array(0) : new Float32Array(total);
  const scrape = options.stems === false ? new Float32Array(0) : new Float32Array(total);
  const writeStems = options.stems !== false;
  const rand = seededRandom(seed + 991);

  const bodyModes = [82.4, 116.5, 164.8, 233.1, 329.6, 466.2, 622.3, 880];

  for (const e of events) {
    const i0 = Math.floor(e.start * sr);
    const i1 = Math.min(total, Math.floor((e.start + e.duration + master.resonanceTail) * sr));
    const B = stringSet.inharmonicity[e.stringIndex];
    const open = GUQIN_STRINGS[e.stringIndex].openFreq;
    const scaleLength = 112;

    // 谐波/弦振动分轨：按谐波外层循环，减少逐样本谐波对象开销。
    for (let h = 1; h <= 15; h++) {
      let phase = rand() * Math.PI * 2;
      const baseAmp = (0.72 / Math.pow(h, 1.08)) * (0.72 + 0.28 * Math.sin(e.stringIndex * 1.7 + h * 0.9));
      const tau = (2.1 + master.resonanceTail * 0.42) / (0.72 + h * 0.18);
      for (let i = i0; i < i1; i++) {
        const t = (i - i0) / sr;
        const midi = eventMidiAt(e, t, master);
        const f0 = midiToFreq(midi);
        const fh = h * f0 * Math.sqrt(1 + B * h * h);
        phase += (2 * Math.PI * fh) / sr;
        const attack = Math.min(1, t / 0.009);
        const pluckBrightness = 0.72 + 0.28 * Math.exp(-t * 1.8);
        const env = attack * Math.exp(-t / tau) * pluckBrightness;
        const sample = baseAmp * env * Math.sin(phase);
        mix[i] += sample;
        if (writeStems) harmonic[i] += sample;
      }
    }

    // 琴体模态与共鸣：落在谐波之间的窄峰和长尾。
    for (let m = 0; m < bodyModes.length; m++) {
      const freq = bodyModes[m] * (1 + (e.stringIndex - 3) * 0.006);
      let phase = rand() * Math.PI * 2;
      const amp = 0.055 * Math.exp(-m * 0.22) * (0.7 + 0.3 * Math.sin(e.stringIndex + m));
      const tau = 0.9 + (m % 3) * 0.8 + master.resonanceTail * 0.35;
      for (let i = i0; i < i1; i++) {
        const t = (i - i0) / sr;
        phase += (2 * Math.PI * freq) / sr;
        const attack = Math.min(1, t / 0.018);
        const sample = amp * attack * Math.exp(-t / tau) * Math.sin(phase);
        mix[i] += sample;
        if (writeStems) resonance[i] += sample;
      }
    }

    // 擦弦噪声：带通白噪 + 速度幅度 + 缠丝周期 AM。
    const hp = makeHighpass(sr, 1050 + e.stringIndex * 55, 0.82);
    const lp = makeLowpass(sr, 7600 - e.stringIndex * 260, 0.72);
    const density = stringSet.windingPerCm[e.stringIndex];
    let wrapPhase = rand() * Math.PI * 2;
    let lastX = 0;
    for (let i = i0; i < i1; i++) {
      const t = (i - i0) / sr;
      if (t > e.glideStart + e.glideDuration + 0.45) break;
      const midi = eventMidiAt(e, t, master);
      const f = midiToFreq(midi);
      const ratio = Math.max(0.8, f / open);
      const x = scaleLength * (1 - 1 / ratio);
      const velocity = t === 0 ? 0 : (x - lastX) * sr; // cm/s，相邻样本差分
      lastX = x;
      const speed = Math.min(1, Math.abs(velocity) / 15);
      const slideWindow = smoothstep((t - e.glideStart + 0.05) / 0.22) * (1 - smoothstep((t - e.glideStart - e.glideDuration) / 0.28));
      const ampEnv = slideWindow * master.pressure * (0.12 + 0.88 * Math.pow(speed, 0.72));
      wrapPhase += (2 * Math.PI * density * Math.abs(velocity)) / sr;
      const bump = Math.pow(0.5 + 0.5 * Math.cos(wrapPhase), 5.5);
      const texture = 1 - 0.48 + 0.48 * (0.3 + 0.7 * bump);
      const white = rand() * 2 - 1;
      const filtered = processBiquad(processBiquad(white, hp), lp);
      const sample = 0.23 * ampEnv * texture * filtered;
      mix[i] += sample;
      if (writeStems) scrape[i] += sample;
    }
  }

  // 统一峰值归一化，所有分轨使用同一增益。
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(mix[i]));
  const gain = peak > 0 ? 0.86 / peak : 1;
  for (let i = 0; i < total; i++) mix[i] *= gain;
  if (writeStems) {
    for (let i = 0; i < total; i++) {
      harmonic[i] *= gain;
      resonance[i] *= gain;
      scrape[i] *= gain;
    }
  }

  return {
    name: options.name ?? `合成测试录音 · ${master.name} · ${stringSet.name}`,
    sampleRate: sr,
    duration: durationSec,
    mix,
    qin: harmonic.map((v, i) => v + resonance[i]),
    harmonic,
    resonance,
    scrape,
    events,
    segments: eventsToSegments(events),
    master,
    stringSet,
  };
}
