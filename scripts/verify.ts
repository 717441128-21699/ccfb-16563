#!/usr/bin/env node
import { MASTERS, STRING_SETS } from '../src/audio/synthetic.ts';
import { runAcceptanceCase } from '../src/dsp/acceptance.ts';

const all = process.argv.includes('--all');
const cases = all ? MASTERS.map((_, m) => [m, m % STRING_SETS.length] as const) : [[0, 0] as const];
console.log('古琴擦弦分离 · 合成测试验收');
let failed = false;
for (const [m, s] of cases) {
  const r = runAcceptanceCase(m, s);
  failed ||= !r.pass;
  console.log(`\n[${r.master} / ${r.stringSet}] segments=${r.segments} process=${r.processSec.toFixed(2)}s for ${r.audioSec}s`);
  console.log(`  擦弦压低: ${r.scrapeReductionDb.toFixed(2)} dB ${r.passNoise ? 'PASS' : 'FAIL'} (>=15)`);
  console.log(`  谐波能量损失: ${r.harmonicLossDb.toFixed(2)} dB ${r.passHarmonic ? 'PASS' : 'FAIL'} (<=1)`);
  console.log(`  音分偏差 max/p95/median: ${r.pitch.maxCents.toFixed(2)}/${r.pitch.p95Cents.toFixed(2)}/${r.pitch.medianCents.toFixed(2)} cents, n=${r.pitch.matchedFrames} ${r.passPitch ? 'PASS' : 'FAIL'} (<=5)`);
}
if (failed) process.exitCode = 1;
