import { analyzePitch, processGuqinAudio } from '../dsp/core.ts';
import { runAcceptanceCase } from '../dsp/acceptance.ts';
import { synthesizeGuqinRecording } from '../audio/synthetic.ts';
import type { ProcessingSettings, SegmentSettings } from '../dsp/types.ts';

export interface WorkerRequest {
  id: number;
  type: 'analyze' | 'process' | 'acceptance' | 'synth';
  samples?: Float32Array;
  sampleRate?: number;
  segments?: SegmentSettings[];
  settings?: ProcessingSettings;
  densities?: number[];
  masterIndex?: number;
  setIndex?: number;
  durationSec?: number;
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const ctx = self as unknown as WorkerScope;

ctx.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  try {
    if (req.type === 'acceptance') {
      const result = runAcceptanceCase(req.masterIndex ?? 0, req.setIndex ?? 0, 24);
      ctx.postMessage({ id: req.id, type: 'acceptance', result });
      return;
    }
    if (req.type === 'synth') {
      const rec = synthesizeGuqinRecording({
        durationSec: req.durationSec ?? 26,
        masterIndex: req.masterIndex ?? 0,
        setIndex: req.setIndex ?? 0,
        stems: false,
      });
      ctx.postMessage({
        id: req.id,
        type: 'synth',
        samples: rec.mix,
        sampleRate: rec.sampleRate,
        duration: rec.duration,
        segments: rec.segments,
        densities: rec.stringSet.windingPerCm,
        masterName: rec.master.name,
        setName: rec.stringSet.name,
      }, [rec.mix.buffer]);
      return;
    }
    if (!req.samples || !req.sampleRate) throw new Error('缺少音频样本');
    if (req.type === 'analyze') {
      const result = analyzePitch(req.samples, req.sampleRate, req.segments ?? []).result;
      ctx.postMessage({ id: req.id, type: 'analyze', analysis: result });
      return;
    }
    if (!req.settings) throw new Error('缺少处理参数');
    const result = processGuqinAudio(req.samples, req.sampleRate, req.settings, {
      stringDensities: req.densities,
    });
    const channel = result.channels[0];
    ctx.postMessage({ id: req.id, type: 'process', channel, analysis: result.analysis }, [channel.buffer]);
  } catch (error) {
    ctx.postMessage({ id: req.id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
