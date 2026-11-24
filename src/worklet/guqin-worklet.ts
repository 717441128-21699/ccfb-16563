import { GuqinFrameEngine } from '../dsp/core.ts';
import type { FrameAnalysis } from '../dsp/types.ts';

class GuqinFrameTrackerProcessor extends AudioWorkletProcessor {
  private engine = new GuqinFrameEngine(sampleRate);
  private frameBuffer = new Float32Array(2048);
  private fifo = new Float32Array(4096);
  private fifoLength = 0;
  private frameIndex = 0;
  private openPrior = 0;
  private stringIndex = -1;
  private ambientPow = new Float32Array(1025);
  private scrapeProfile = new Float32Array(1025);

  static get parameterDescriptors(): AudioParamDescriptor[] {
    return [
      { name: 'strength', defaultValue: 1, minValue: 0, maxValue: 2 },
      { name: 'retention', defaultValue: 0.18, minValue: 0, maxValue: 1 },
    ];
  }

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<{ type: string; openFreq?: number; stringIndex?: number }>) => {
      if (event.data.type === 'string') {
        this.openPrior = event.data.openFreq ?? 0;
        this.stringIndex = event.data.stringIndex ?? -1;
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (output) {
      if (input && input.length === output.length) output.set(input);
      else output.fill(0);
    }
    if (!input) return true;

    for (let i = 0; i < input.length; i++) {
      if (this.fifoLength < this.fifo.length) this.fifo[this.fifoLength++] = input[i];
    }
    const hop = 512;
    while (this.fifoLength >= this.engine.fftSize) {
      this.frameBuffer.set(this.fifo.subarray(0, this.engine.fftSize));
      const analysis = this.engine.detect(this.frameBuffer, this.frameIndex, this.openPrior);
      analysis.stringIndex = this.stringIndex;
      if (analysis.sliding && this.stringIndex >= 0) {
        const wrap = this.engine.estimateWinding(this.frameBuffer, analysis.velocity || 12, this.stringIndex);
        analysis.wrapRate = wrap.rate;
        analysis.wrapDensity = wrap.density;
        analysis.wrapClarity = wrap.clarity;
      }
      const scrape = this.estimateScrape(analysis.sliding, analysis.noiseLikelihood);
      this.frameIndex++;
      this.fifo.copyWithin(0, hop, this.fifoLength);
      this.fifoLength = Math.max(0, this.fifoLength - hop);
      // AudioWorklet 内逐帧计算；UI 不必接收全部 94 fps 消息，每 3 帧推送一次。
      if (this.frameIndex % 3 === 0) {
        const plain: Partial<FrameAnalysis> = {
          time: analysis.time,
          f0: analysis.f0,
          midi: analysis.midi,
          confidence: analysis.confidence,
          sliding: analysis.sliding,
          velocity: analysis.velocity,
          wrapRate: analysis.wrapRate,
          wrapClarity: analysis.wrapClarity,
          noiseLikelihood: analysis.noiseLikelihood,
          stringIndex: analysis.stringIndex,
        };
        this.port.postMessage({ type: 'frame', frame: plain, scrape });
      }
    }
    return true;
  }

  /**
   * 逐帧擦弦估计：用慢变环境谱作底，滑音时加快更新宽带 scrapeProfile。
   * 返回全频估计能量和 1.1–8 kHz 沙沙主带 RMS，供 UI/实时增益使用。
   */
  private estimateScrape(sliding: boolean, likelihood: number): { level: number; bandRms: number; clarity: number } {
    const mag = this.engine.getMagnitudes();
    const binHz = sampleRate / this.engine.fftSize;
    const ambientAlpha = sliding ? 0.012 : 0.08;
    const profileAlpha = sliding ? 0.12 + likelihood * 0.18 : 0.02;
    let energy = 0;
    let bandEnergy = 0;
    let bandCount = 0;
    for (let k = 1; k < 1025; k++) {
      const p = mag[k] * mag[k];
      this.ambientPow[k] += ambientAlpha * (p - this.ambientPow[k]);
      const candidate = Math.max(0, p - this.ambientPow[k] * 1.7);
      this.scrapeProfile[k] += profileAlpha * (candidate - this.scrapeProfile[k]);
      energy += this.scrapeProfile[k];
      const hz = k * binHz;
      if (hz >= 1100 && hz <= 8200) {
        bandEnergy += this.scrapeProfile[k];
        bandCount++;
      }
    }
    return {
      level: Math.sqrt(energy / 1024),
      bandRms: Math.sqrt(bandEnergy / Math.max(1, bandCount)),
      clarity: likelihood,
    };
  }
}

registerProcessor('guqin-frame-tracker', GuqinFrameTrackerProcessor);
