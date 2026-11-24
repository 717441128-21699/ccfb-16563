export interface PitchPoint {
  time: number;
  freq: number;
  midi: number;
  confidence: number;
  sliding: boolean;
  /** 估算的手指弦向速度，cm/s */
  velocity: number;
  /** 相邻缠丝峰的频率，Hz */
  wrapRate: number;
  wrapClarity: number;
}

export interface StringPitchCurve {
  stringIndex: number;
  openFreq: number;
  label: string;
  points: PitchPoint[];
}

export interface FrameAnalysis {
  frame: number;
  time: number;
  f0: number;
  midi: number;
  confidence: number;
  stringIndex: number;
  sliding: boolean;
  centsPerSecond: number;
  velocity: number;
  wrapRate: number;
  wrapDensity: number;
  wrapClarity: number;
  noiseLikelihood: number;
  scrapeRms: number;
  rms: number;
}

export interface SegmentSettings {
  id: string;
  label: string;
  start: number;
  end: number;
  stringIndex: number;
  /** 0 = 擦弦声全部去除，1 = 原样保留 */
  scrapeRetention: number;
  /** 0..2，局部额外强度 */
  strength: number;
  preserveResonance: number;
  color: string;
}

export interface ProcessingSettings {
  /** 全局擦弦去除强度 0..1.5 */
  strength: number;
  /** 谐波替换/保护宽度 */
  harmonicProtection: number;
  /** 余韵/琴身共鸣保护 0..1 */
  resonance: number;
  /** 缠丝周期纹理利用量 0..1 */
  windingTexture: number;
  segments: SegmentSettings[];
}

export interface AnalysisResult {
  sampleRate: number;
  fftSize: number;
  hopSize: number;
  duration: number;
  frames: FrameAnalysis[];
  strings: StringPitchCurve[];
  /** 每帧一个 0..1 的擦弦可能性，供总览图使用 */
  scrapeEnvelope: Float32Array;
}

export interface ProcessResult {
  channels: Float32Array[];
  sampleRate: number;
  analysis: AnalysisResult;
  /** 验收时用于把同一组时变增益施加到已知噪声轨 */
  gains?: Float32Array[];
  /** 可选导出的干净谐波替换模型 */
  harmonicModel?: Float32Array;
}

export const GUQIN_STRINGS = [
  { index: 0, label: '一弦 · C2', openFreq: 65.406, color: '#8bd3ff' },
  { index: 1, label: '二弦 · D2', openFreq: 73.416, color: '#7cf0c8' },
  { index: 2, label: '三弦 · F2', openFreq: 87.307, color: '#d7f07c' },
  { index: 3, label: '四弦 · G2', openFreq: 97.999, color: '#ffd37c' },
  { index: 4, label: '五弦 · A2', openFreq: 110.0, color: '#ff9d7c' },
  { index: 5, label: '六弦 · c3', openFreq: 130.813, color: '#d3a4ff' },
  { index: 6, label: '七弦 · d3', openFreq: 146.832, color: '#ff9ed8' },
] as const;
