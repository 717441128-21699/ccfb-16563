"use strict";
(() => {
  // src/dsp/fft.ts
  var FFT = class {
    size;
    bits;
    reversal;
    window;
    constructor(size) {
      if ((size & size - 1) !== 0) throw new Error("FFT \u957F\u5EA6\u5FC5\u987B\u662F 2 \u7684\u5E42");
      this.size = size;
      this.bits = Math.log2(size);
      this.reversal = new Uint32Array(size);
      for (let i = 0; i < size; i++) {
        let x = i;
        let r = 0;
        for (let b = 0; b < this.bits; b++) {
          r = r << 1 | x & 1;
          x >>= 1;
        }
        this.reversal[i] = r;
      }
      this.window = new Float32Array(size);
      for (let i = 0; i < size; i++) {
        this.window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size);
      }
    }
    reorder(re, im) {
      for (let i = 0; i < this.size; i++) {
        const j = this.reversal[i];
        if (j > i) {
          const tr = re[i];
          re[i] = re[j];
          re[j] = tr;
          const ti = im[i];
          im[i] = im[j];
          im[j] = ti;
        }
      }
    }
    forward(re, im) {
      const n = this.size;
      this.reorder(re, im);
      for (let len = 2; len <= n; len <<= 1) {
        const half = len >> 1;
        const angle = -2 * Math.PI / len;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        for (let i = 0; i < n; i += len) {
          let cr = 1;
          let ci = 0;
          for (let j = 0; j < half; j++) {
            const a = i + j;
            const b = a + half;
            const vr = re[b] * cr - im[b] * ci;
            const vi = re[b] * ci + im[b] * cr;
            re[b] = re[a] - vr;
            im[b] = im[a] - vi;
            re[a] += vr;
            im[a] += vi;
            const ncr = cr * wr - ci * wi;
            ci = cr * wi + ci * wr;
            cr = ncr;
          }
        }
      }
    }
    inverse(re, im) {
      const n = this.size;
      this.reorder(re, im);
      for (let len = 2; len <= n; len <<= 1) {
        const half = len >> 1;
        const angle = 2 * Math.PI / len;
        const wr = Math.cos(angle);
        const wi = Math.sin(angle);
        for (let i = 0; i < n; i += len) {
          let cr = 1;
          let ci = 0;
          for (let j = 0; j < half; j++) {
            const a = i + j;
            const b = a + half;
            const vr = re[b] * cr - im[b] * ci;
            const vi = re[b] * ci + im[b] * cr;
            re[b] = re[a] - vr;
            im[b] = im[a] - vi;
            re[a] += vr;
            im[a] += vi;
            const ncr = cr * wr - ci * wi;
            ci = cr * wi + ci * wr;
            cr = ncr;
          }
        }
      }
      const inv = 1 / n;
      for (let i = 0; i < n; i++) {
        re[i] *= inv;
        im[i] *= inv;
      }
    }
    /** 加 Hann 窗并求幅度谱；re/im 同时保留给后续相位处理。 */
    magnitudeSpectrum(frame, re, im) {
      const n = this.size;
      for (let i = 0; i < n; i++) {
        re[i] = frame[i] * this.window[i];
        im[i] = 0;
      }
      this.forward(re, im);
      const mag = new Float32Array((n >> 1) + 1);
      for (let k = 0; k <= n / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
      return mag;
    }
  };
  function centsBetween(f1, f2) {
    if (f1 <= 0 || f2 <= 0) return 0;
    return 1200 * Math.log2(f2 / f1);
  }
  function freqToMidi(f) {
    return 69 + 12 * Math.log2(f / 440);
  }
  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  // src/dsp/core.ts
  var PARTIALS = 16;
  function emptyPartialArray() {
    return new Float32Array(PARTIALS);
  }
  function normalizeAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }
  function parabolicOffset(m0, m1, m2) {
    const denom = m0 - 2 * m1 + m2;
    if (Math.abs(denom) < 1e-12) return 0;
    return clamp(0.5 * (m0 - m2) / denom, -0.9, 0.9);
  }
  var GuqinFrameEngine = class {
    sampleRate;
    fftSize = 2048;
    hopSize = 512;
    bins = this.fftSize / 2 + 1;
    fft;
    re;
    im;
    mag;
    acfRe;
    acfIm;
    windowCorr;
    prevFreq = 0;
    prevPhi = emptyPartialArray();
    phaseValid = false;
    lastStringIndex = -1;
    constructor(sampleRate2) {
      this.sampleRate = sampleRate2;
      this.fft = new FFT(this.fftSize);
      this.re = new Float32Array(this.fftSize);
      this.im = new Float32Array(this.fftSize);
      this.mag = new Float32Array(this.bins);
      this.acfRe = new Float32Array(this.fftSize);
      this.acfIm = new Float32Array(this.fftSize);
      this.windowCorr = new Float32Array(this.fftSize / 2);
      let wEnergy = 0;
      for (let i = 0; i < this.fftSize; i++) wEnergy += this.fft.window[i] ** 2;
      for (let lag = 0; lag < this.windowCorr.length; lag++) {
        let overlap = 0;
        for (let i = 0; i < this.fftSize - lag; i++) overlap += this.fft.window[i] * this.fft.window[i + lag];
        this.windowCorr[lag] = overlap / wEnergy;
      }
    }
    resetTrack() {
      this.prevFreq = 0;
      this.phaseValid = false;
      this.prevPhi.fill(0);
      this.lastStringIndex = -1;
    }
    frameCount(length) {
      if (length <= 0) return 0;
      return Math.max(1, Math.ceil(length / this.hopSize));
    }
    /** AudioWorklet 在 detect() 后复用同一帧幅度谱，避免再做一次 FFT。 */
    getMagnitudes() {
      return this.mag;
    }
    getFrameSamples(samples, frame, target) {
      const out = target ?? new Float32Array(this.fftSize);
      const start = frame * this.hopSize;
      out.fill(0);
      const count = Math.max(0, Math.min(this.fftSize, samples.length - start));
      if (count > 0) out.set(samples.subarray(start, start + count));
      return out;
    }
    peakAround(centerBin, search = 2) {
      const center = Math.round(centerBin);
      let bestK = clamp(center, 1, this.bins - 2);
      let bestMag = -1;
      const lo = Math.max(1, center - search);
      const hi = Math.min(this.bins - 2, center + search);
      for (let k = lo; k <= hi; k++) {
        if (this.mag[k] > bestMag) {
          bestMag = this.mag[k];
          bestK = k;
        }
      }
      const delta = parabolicOffset(this.mag[bestK - 1], this.mag[bestK], this.mag[bestK + 1]);
      return { k: bestK, fractional: bestK + delta, mag: bestMag };
    }
    coarseScore(f0, bInharm) {
      const binHz = this.sampleRate / this.fftSize;
      let sum = 0;
      let wsum = 0;
      for (let h = 1; h <= 12; h++) {
        const stretched = h * f0 * Math.sqrt(1 + bInharm * h * h);
        if (stretched > 620) break;
        const p = this.peakAround(stretched / binHz, 1);
        const w = 1 / Math.pow(h, 0.72);
        sum += Math.log(1 + p.mag) * w;
        wsum += w;
      }
      return sum / wsum;
    }
    detect(frame, frameIndex, openPrior = 0) {
      const n = this.fftSize;
      const sr = this.sampleRate;
      const binHz = sr / n;
      this.fft.magnitudeSpectrum(frame, this.re, this.im);
      for (let k = 0; k < this.bins; k++) this.mag[k] = Math.hypot(this.re[k], this.im[k]);
      let rms = 0;
      for (let i = 0; i < n; i++) rms += frame[i] * frame[i];
      rms = Math.sqrt(rms / n);
      let logSum = 0;
      let arithmetic = 0;
      let count = 0;
      let highEnergy = 0;
      let bandEnergy = 0;
      for (let k = Math.floor(500 / binHz); k < Math.floor(Math.min(9e3, sr / 2) / binHz); k++) {
        const m = this.mag[k] + 1e-8;
        logSum += Math.log(m);
        arithmetic += m;
        count++;
      }
      for (let k = Math.floor(1400 / binHz); k < Math.floor(Math.min(9500, sr / 2) / binHz); k++) highEnergy += this.mag[k] * this.mag[k];
      for (let k = Math.floor(120 / binHz); k < this.bins - 1; k++) bandEnergy += this.mag[k] * this.mag[k];
      const flatness = count > 0 ? Math.exp(logSum / count) / (arithmetic / count + 1e-12) : 0;
      const highRatio = bandEnergy > 0 ? highEnergy / bandEnergy : 0;
      for (let k = 0; k < n; k++) {
        const hz = Math.min(k, n - k) * binHz;
        const lowWeight = hz <= 600 ? 1 : 0;
        this.acfRe[k] = (this.re[k] * this.re[k] + this.im[k] * this.im[k]) * lowWeight;
        this.acfIm[k] = 0;
      }
      this.fft.inverse(this.acfRe, this.acfIm);
      const minLag = Math.max(18, Math.floor(sr / 1180));
      const maxLag = Math.min(Math.floor(sr / 52), n / 2 - 2);
      let bestLag = minLag;
      let bestAcfNorm = -Infinity;
      for (let lag = minLag + 1; lag < maxLag; lag++) {
        if (!(this.acfRe[lag] >= this.acfRe[lag - 1] && this.acfRe[lag] >= this.acfRe[lag + 1])) continue;
        const norm = this.acfRe[lag] / (Math.max(1e-8, this.acfRe[0]) * Math.max(0.08, this.windowCorr[lag]));
        if (norm > bestAcfNorm) {
          bestAcfNorm = norm;
          bestLag = lag;
        }
      }
      if (!Number.isFinite(bestAcfNorm)) {
        for (let lag = minLag; lag <= maxLag; lag++) {
          const norm = this.acfRe[lag] / (Math.max(1e-8, this.acfRe[0]) * Math.max(0.08, this.windowCorr[lag]));
          if (norm > bestAcfNorm) {
            bestAcfNorm = norm;
            bestLag = lag;
          }
        }
      }
      const lagDelta = parabolicOffset(this.acfRe[bestLag - 1], this.acfRe[bestLag], this.acfRe[bestLag + 1]);
      const acfF0 = sr / (bestLag + clamp(lagDelta, -0.9, 0.9));
      const acfConfidence = clamp(bestAcfNorm, 0, 1);
      const minF = Math.max(50, openPrior > 0 ? openPrior * 0.975 : 50);
      const candidates = [acfF0, acfF0 * 2, acfF0 / 2].filter((f) => f >= minF && f <= 1180).sort((a, b) => a - b);
      if (candidates.length === 0) candidates.push(clamp(acfF0, minF, 1180));
      const bChoices = [0, 6e-5, 14e-5, 28e-5, 5e-4];
      let bestF0 = acfF0;
      let bestRefined = -Infinity;
      let bestB = 12e-5;
      for (const candidate of candidates) {
        for (const b of bChoices) {
          for (let c = -50; c <= 50; c += 5) {
            const f0 = candidate * Math.pow(2, c / 1200);
            let score = this.coarseScore(f0, b);
            if (this.prevFreq > 0) {
              const cents = Math.abs(centsBetween(this.prevFreq, f0));
              if (cents > 70) score -= Math.min(0.8, (cents - 70) / 1600);
            }
            if (openPrior > 0 && f0 < openPrior * 0.985) score -= 1.2;
            if (openPrior > 0 && f0 > openPrior * 4.8) score -= 0.35;
            if (score > bestRefined) {
              bestRefined = score;
              bestF0 = f0;
              bestB = b;
            }
          }
        }
      }
      let impliedSum = 0;
      let weightSum = 0;
      const impliedObs = [];
      const harmFreq = emptyPartialArray();
      const harmAmp = emptyPartialArray();
      const harmPhase = emptyPartialArray();
      const preImpliedF0 = bestF0;
      for (let h = 1; h <= PARTIALS; h++) {
        const expected = h * bestF0 * Math.sqrt(1 + bestB * h * h);
        const p = this.peakAround(expected / binHz, 1);
        const freq = p.fractional * binHz;
        harmFreq[h - 1] = freq;
        const km1 = clamp(p.k - 1, 0, this.bins - 1);
        const kp1 = clamp(p.k + 1, 0, this.bins - 1);
        const amp = clamp(2 * (this.mag[km1] + this.mag[p.k] + this.mag[kp1]) / n, 0, 1);
        harmAmp[h - 1] = amp;
        if (h <= 8 && amp > 6e-3 && freq <= 620) {
          const implied = freq / (h * Math.sqrt(1 + bestB * h * h));
          const w = amp * (1.2 - h / 12);
          impliedSum += implied * w;
          weightSum += w;
          impliedObs.push({ f: implied, w });
        }
        let phiCenter = normalizeAngle(Math.atan2(this.im[p.k], this.re[p.k]) + Math.PI * p.k);
        if (this.phaseValid && this.prevPhi[h - 1] !== 0 && h <= 10) {
          const predicted = this.prevPhi[h - 1] + 2 * Math.PI * freq * this.hopSize / sr;
          let measured = phiCenter;
          let delta = normalizeAngle(measured - predicted);
          measured = predicted + delta;
          phiCenter = measured;
        }
        harmPhase[h - 1] = phiCenter;
        this.prevPhi[h - 1] = phiCenter;
      }
      if (impliedObs.length > 0) {
        impliedObs.sort((a, b) => a.f - b.f);
        const totalW = impliedObs.reduce((s, x) => s + x.w, 0);
        let accW = 0;
        let medianF = impliedObs[0].f;
        for (const obs of impliedObs) {
          accW += obs.w;
          if (accW >= totalW * 0.5) {
            medianF = obs.f;
            break;
          }
        }
        let clusterSum = 0;
        let clusterW = 0;
        for (const obs of impliedObs) {
          if (Math.abs(centsBetween(medianF, obs.f)) < 45) {
            clusterSum += obs.f * obs.w;
            clusterW += obs.w;
          }
        }
        if (clusterW > 0) bestF0 = clusterSum / clusterW;
        else if (weightSum > 0) bestF0 = impliedSum / weightSum;
      }
      this.lastPitchDebug = { bestLag, lagDelta, acfF0, acfConfidence, candidates, preImpliedF0, bestF0, bestRefined, bestB, impliedSum, weightSum };
      const confidence = clamp((bestRefined - 2.2) / 5.5 + Math.min(0.25, harmAmp[0] * 4), 0, 1);
      const voiced = bestF0 >= 48 && bestF0 <= 1250 && confidence > 0.08 && rms > 1e-7;
      if (voiced) {
        this.prevFreq = this.prevFreq > 0 ? this.prevFreq * 0.55 + bestF0 * 0.45 : bestF0;
        this.phaseValid = true;
      } else {
        this.prevFreq = 0;
        this.phaseValid = false;
        this.prevPhi.fill(0);
      }
      const midi = voiced ? freqToMidi(bestF0) : 0;
      const analysis = {
        frame: frameIndex,
        time: frameIndex * this.hopSize / sr,
        f0: voiced ? bestF0 : 0,
        midi,
        confidence: voiced ? confidence : 0,
        stringIndex: -1,
        sliding: false,
        centsPerSecond: 0,
        velocity: 0,
        wrapRate: 0,
        wrapDensity: 0,
        wrapClarity: 0,
        noiseLikelihood: clamp(0.25 + flatness * 0.9 + highRatio * 0.55, 0, 1),
        scrapeRms: 0,
        rms,
        flatness,
        highRatio,
        harmFreq,
        harmAmp,
        harmPhase,
        inharmB: bestB
      };
      return analysis;
    }
    /** 用鲁棒化后的 f0 在处理 FFT 上重新对准谐波幅度与相位。 */
    refineHarmonicsFromSpectrum(tf, re, im) {
      const n = this.fftSize;
      const binHz = this.sampleRate / n;
      for (let k = 0; k < this.bins; k++) this.mag[k] = Math.hypot(re[k], im[k]);
      if (tf.f0 <= 0) {
        this.phaseValid = false;
        return;
      }
      for (let h = 1; h <= PARTIALS; h++) {
        const expected = h * tf.f0 * Math.sqrt(1 + tf.inharmB * h * h);
        const p = this.peakAround(expected / binHz, 1);
        const freq = p.fractional * binHz;
        tf.harmFreq[h - 1] = freq;
        const km1 = clamp(p.k - 1, 0, this.bins - 1);
        const kp1 = clamp(p.k + 1, 0, this.bins - 1);
        tf.harmAmp[h - 1] = clamp(2 * (this.mag[km1] + this.mag[p.k] + this.mag[kp1]) / n, 0, 1);
        let phiCenter = normalizeAngle(Math.atan2(im[p.k], re[p.k]) + Math.PI * p.k);
        if (this.phaseValid && this.prevPhi[h - 1] !== 0 && h <= 10) {
          const predicted = this.prevPhi[h - 1] + 2 * Math.PI * freq * this.hopSize / this.sampleRate;
          phiCenter = predicted + normalizeAngle(phiCenter - predicted);
        }
        tf.harmPhase[h - 1] = phiCenter;
        this.prevPhi[h - 1] = phiCenter;
      }
      this.phaseValid = true;
    }
    /** 用中心相位和局部频率斜率合成一帧干净谐波。 */
    synthesizeHarmonics(frameIndex, tracked, all, sRe, sIm, timeOut) {
      const n = this.fftSize;
      const sr = this.sampleRate;
      const time = timeOut ?? new Float32Array(n);
      time.fill(0);
      const prev = all[Math.max(0, frameIndex - 1)];
      const next = all[Math.min(all.length - 1, frameIndex + 1)];
      for (let h = 1; h <= PARTIALS; h++) {
        const amp = tracked.harmAmp[h - 1];
        if (amp < 8e-4) continue;
        const stretch = Math.sqrt(1 + tracked.inharmB * h * h);
        const f = h * tracked.f0 * stretch;
        const fPrev = prev && prev.f0 > 0 ? h * prev.f0 * Math.sqrt(1 + prev.inharmB * h * h) : f;
        const fNext = next && next.f0 > 0 ? h * next.f0 * Math.sqrt(1 + next.inharmB * h * h) : f;
        const slope = clamp((fNext - fPrev) / (2 * this.hopSize / sr), -f * 3, f * 3);
        const phi = tracked.harmPhase[h - 1];
        for (let i = 0; i < n; i++) {
          const tau = (i - n / 2) / sr;
          const phase = phi + 2 * Math.PI * (f * tau + 0.5 * slope * tau * tau);
          time[i] += amp * Math.cos(phase);
        }
      }
      for (let i = 0; i < n; i++) {
        sRe[i] = time[i] * this.fft.window[i];
        sIm[i] = 0;
      }
      this.fft.forward(sRe, sIm);
    }
    estimateWinding(frame, velocity, stringIndex, exactDensities) {
      if (Math.abs(velocity) < 2.5) return { rate: 0, density: 0, clarity: 0 };
      const sr = this.sampleRate;
      const n = this.fftSize;
      const env = new Float32Array(n);
      let mean = 0;
      let last = 0;
      for (let i = 0; i < n; i++) {
        const x = frame[i];
        const d = x - 0.94 * last;
        last = x;
        env[i] = Math.abs(d);
        mean += env[i];
      }
      mean /= n;
      const candidates = exactDensities && exactDensities[stringIndex] ? [exactDensities[stringIndex] * 0.9, exactDensities[stringIndex], exactDensities[stringIndex] * 1.1] : [1.05, 1.3, 1.55, 1.8, 2.05, 2.3, 2.6, 2.9, 3.15];
      let best = { clarity: 0, density: 0, lag: 0 };
      for (const density of candidates) {
        const lag = Math.round(sr / (density * Math.abs(velocity)));
        if (lag < 70 || lag > n - 128) continue;
        for (const testLag of [lag - 2, lag - 1, lag, lag + 1, lag + 2]) {
          let c = 0;
          let e0 = 0;
          let e1 = 0;
          const count = n - testLag;
          for (let i = 0; i < count; i++) {
            const a = env[i] - mean;
            const b = env[i + testLag] - mean;
            c += a * b;
            e0 += a * a;
            e1 += b * b;
          }
          const corr = c / Math.sqrt(e0 * e1 + 1e-12);
          if (corr > best.clarity) best = { clarity: corr, density, lag: testLag };
        }
      }
      if (best.clarity < 0.12) return { rate: 0, density: best.density, clarity: clamp(best.clarity, 0, 1) };
      return { rate: sr / best.lag, density: best.density, clarity: clamp(best.clarity, 0, 1) };
    }
  };

  // src/worklet/guqin-worklet.ts
  var GuqinFrameTrackerProcessor = class extends AudioWorkletProcessor {
    engine = new GuqinFrameEngine(sampleRate);
    frameBuffer = new Float32Array(2048);
    fifo = new Float32Array(4096);
    fifoLength = 0;
    frameIndex = 0;
    openPrior = 0;
    stringIndex = -1;
    ambientPow = new Float32Array(1025);
    scrapeProfile = new Float32Array(1025);
    static get parameterDescriptors() {
      return [
        { name: "strength", defaultValue: 1, minValue: 0, maxValue: 2 },
        { name: "retention", defaultValue: 0.18, minValue: 0, maxValue: 1 }
      ];
    }
    constructor() {
      super();
      this.port.onmessage = (event) => {
        if (event.data.type === "string") {
          this.openPrior = event.data.openFreq ?? 0;
          this.stringIndex = event.data.stringIndex ?? -1;
        }
      };
    }
    process(inputs, outputs) {
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
        if (this.frameIndex % 3 === 0) {
          const plain = {
            time: analysis.time,
            f0: analysis.f0,
            midi: analysis.midi,
            confidence: analysis.confidence,
            sliding: analysis.sliding,
            velocity: analysis.velocity,
            wrapRate: analysis.wrapRate,
            wrapClarity: analysis.wrapClarity,
            noiseLikelihood: analysis.noiseLikelihood,
            stringIndex: analysis.stringIndex
          };
          this.port.postMessage({ type: "frame", frame: plain, scrape });
        }
      }
      return true;
    }
    /**
     * 逐帧擦弦估计：用慢变环境谱作底，滑音时加快更新宽带 scrapeProfile。
     * 返回全频估计能量和 1.1–8 kHz 沙沙主带 RMS，供 UI/实时增益使用。
     */
    estimateScrape(sliding, likelihood) {
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
        clarity: likelihood
      };
    }
  };
  registerProcessor("guqin-frame-tracker", GuqinFrameTrackerProcessor);
})();
