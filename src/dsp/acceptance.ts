import { synthesizeGuqinRecording } from '../audio/synthetic.ts';
import { analyzePitch, applySavedGainsToStem, processGuqinAudio } from './core.ts';
import { comparePitchCurves, segmentRms, type PitchDeviationMetric } from './metrics.ts';
import type { ProcessingSettings } from './types.ts';

export interface AcceptanceResult {
  master: string;
  stringSet: string;
  segments: number;
  scrapeReductionDb: number;
  harmonicLossDb: number;
  pitch: PitchDeviationMetric;
  processSec: number;
  audioSec: number;
  passNoise: boolean;
  passHarmonic: boolean;
  passPitch: boolean;
  pass: boolean;
}

export function runAcceptanceCase(masterIndex = 0, setIndex = 0, durationSec = 26): AcceptanceResult {
  const rec = synthesizeGuqinRecording({ durationSec, masterIndex, setIndex, seed: 20261125 + masterIndex * 97 + setIndex * 13 });
  const settings: ProcessingSettings = {
    strength: 1.35,
    harmonicProtection: 0.9,
    resonance: 0.95,
    windingTexture: 1,
    segments: rec.segments.map((s) => ({ ...s, scrapeRetention: 0.06 })),
  };
  const t0 = performance.now();
  const out = processGuqinAudio(rec.mix, rec.sampleRate, settings, {
    collectGains: true,
    collectHarmonicModel: true,
    stringDensities: rec.stringSet.windingPerCm,
  });
  const processSec = (performance.now() - t0) / 1000;
  if (!out.gains || !out.harmonicModel) throw new Error('验收处理缺少增益或谐波模型');

  const scrapeGained = applySavedGainsToStem(rec.scrape, rec.sampleRate, out.gains);
  const harmonicGained = applySavedGainsToStem(rec.harmonic, rec.sampleRate, out.gains);
  const harmonicModelGained = applySavedGainsToStem(out.harmonicModel, rec.sampleRate, out.gains);
  const harmonicTransfer = new Float32Array(rec.harmonic.length);
  for (let i = 0; i < harmonicTransfer.length; i++) {
    harmonicTransfer[i] = harmonicGained[i] + out.harmonicModel[i] - harmonicModelGained[i];
  }

  const scrapeIn = segmentRms(rec.scrape, rec.sampleRate, rec.segments);
  const scrapeOut = segmentRms(scrapeGained, rec.sampleRate, rec.segments);
  const harmonicIn = segmentRms(rec.harmonic, rec.sampleRate, rec.segments);
  const harmonicTransferred = segmentRms(harmonicTransfer, rec.sampleRate, rec.segments);
  const scrapeReductionDb = 20 * Math.log10((scrapeIn + 1e-12) / (scrapeOut + 1e-12));
  const harmonicLossDb = 20 * Math.log10((harmonicIn + 1e-12) / (harmonicTransferred + 1e-12));
  const afterPitch = analyzePitch(out.channels[0], rec.sampleRate, rec.segments);
  const pitch = comparePitchCurves(out.analysis, afterPitch.result, true);

  const passNoise = scrapeReductionDb >= 15;
  const passHarmonic = harmonicLossDb <= 1;
  const passPitch = pitch.maxCents <= 5;
  return {
    master: rec.master.name,
    stringSet: rec.stringSet.name,
    segments: rec.segments.length,
    scrapeReductionDb,
    harmonicLossDb,
    pitch,
    processSec,
    audioSec: rec.duration,
    passNoise,
    passHarmonic,
    passPitch,
    pass: passNoise && passHarmonic && passPitch,
  };
}
