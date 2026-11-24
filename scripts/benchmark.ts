#!/usr/bin/env node
import { synthesizeGuqinRecording } from '../src/audio/synthetic.ts';
import { processGuqinAudio } from '../src/dsp/core.ts';
import type { ProcessingSettings } from '../src/dsp/types.ts';

const durationSec = Number(process.argv.find((a) => a.startsWith('--seconds='))?.split('=')[1] ?? 600);
console.log(`生成 ${durationSec} 秒十分钟级合成琴曲（不保留分轨以节省内存）...`);
const tSynth0 = performance.now();
const rec = synthesizeGuqinRecording({ durationSec, stems: false, masterIndex: 3, setIndex: 0, seed: 8888 });
const synthSec = (performance.now() - tSynth0) / 1000;

const settings: ProcessingSettings = {
  strength: 1.15,
  harmonicProtection: 0.9,
  resonance: 0.95,
  windingTexture: 1,
  segments: rec.segments,
};

console.log(`合成完成：${synthSec.toFixed(1)}s，段落 ${rec.segments.length} 个；开始处理...`);
const t0 = performance.now();
const out = processGuqinAudio(rec.mix, rec.sampleRate, settings, {
  stringDensities: rec.stringSet.windingPerCm,
  onProgress: (p) => {
    if (Math.round(p * 100) % 10 === 0) process.stdout.write(`\r处理进度 ${(p * 100).toFixed(0)}%`);
  },
});
const processSec = (performance.now() - t0) / 1000;
process.stdout.write('\n');
const limit = durationSec / 2;
const pass = processSec <= limit;
console.log(JSON.stringify({
  durationSec,
  sampleRate: rec.sampleRate,
  processSec: Number(processSec.toFixed(2)),
  realtimeRatio: Number((processSec / durationSec).toFixed(3)),
  limitSec: limit,
  synthSec: Number(synthSec.toFixed(2)),
  outputSamples: out.channels[0].length,
  pass,
}, null, 2));
if (!pass) process.exitCode = 1;
