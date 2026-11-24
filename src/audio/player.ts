export type PlaybackSource = 'original' | 'processed';

export class AudioPlayer {
  ctx: AudioContext | null = null;
  worklet: AudioWorkletNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private startedAt = 0;
  private offset = 0;
  private playing = false;
  private currentBuffer: AudioBuffer | null = null;
  workletStatus: '未加载' | '已连接' | '加载失败' = '未加载';
  onFrame: ((frame: unknown) => void) | null = null;
  onEnded: (() => void) | null = null;

  private async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    if (!this.worklet) {
      try {
        const url = `${import.meta.env.BASE_URL}worklets/guqin-worklet.js`;
        await this.ctx.audioWorklet.addModule(url);
        this.worklet = new AudioWorkletNode(this.ctx, 'guqin-frame-tracker');
        this.worklet.port.onmessage = (e) => {
          if (e.data?.type === 'frame') this.onFrame?.({ frame: e.data.frame, scrape: e.data.scrape });
        };
        this.gain = this.ctx.createGain();
        this.worklet.connect(this.gain);
        this.gain.connect(this.ctx.destination);
        this.workletStatus = '已连接';
      } catch (err) {
        console.warn('AudioWorklet 加载失败，退回直接输出', err);
        this.workletStatus = '加载失败';
        this.gain = this.ctx.createGain();
        this.gain.connect(this.ctx.destination);
      }
    }
    return this.ctx;
  }

  async decode(file: File): Promise<AudioBuffer> {
    const ctx = await this.ensureContext();
    const arr = await file.arrayBuffer();
    return ctx.decodeAudioData(arr);
  }

  toMono(buffer: AudioBuffer): Float32Array {
    const out = new Float32Array(buffer.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < out.length; i++) out[i] += data[i] / buffer.numberOfChannels;
    }
    return out;
  }

  createBuffer(samples: Float32Array, sampleRate: number): AudioBuffer {
    if (!this.ctx) throw new Error('AudioContext not ready');
    const buf = this.ctx.createBuffer(1, samples.length, sampleRate);
    buf.getChannelData(0).set(samples);
    return buf;
  }

  async prepareBuffer(samples: Float32Array, sampleRate: number): Promise<AudioBuffer> {
    await this.ensureContext();
    return this.createBuffer(samples, sampleRate);
  }

  setBuffer(buffer: AudioBuffer): void {
    this.currentBuffer = buffer;
    this.offset = 0;
  }

  async play(buffer: AudioBuffer, time = this.offset): Promise<void> {
    const ctx = await this.ensureContext();
    this.stopSource();
    this.currentBuffer = buffer;
    this.offset = time;
    const node = ctx.createBufferSource();
    node.buffer = buffer;
    if (this.worklet) node.connect(this.worklet);
    else if (this.gain) node.connect(this.gain);
    else node.connect(ctx.destination);
    node.onended = () => {
      if (this.source === node && this.playing) {
        this.playing = false;
        this.offset = 0;
        this.onEnded?.();
      }
    };
    node.start(0, Math.max(0, Math.min(time, buffer.duration - 0.02)));
    this.source = node;
    this.startedAt = ctx.currentTime;
    this.playing = true;
  }

  pause(): number {
    if (this.playing && this.ctx) {
      this.offset = this.currentTime();
      this.playing = false;
      this.stopSource();
    }
    return this.offset;
  }

  seek(time: number): void {
    const wasPlaying = this.playing;
    this.offset = time;
    if (wasPlaying && this.currentBuffer) void this.play(this.currentBuffer, time);
  }

  currentTime(): number {
    if (!this.ctx || !this.playing) return this.offset;
    return Math.min(this.currentBuffer?.duration ?? 0, this.offset + (this.ctx.currentTime - this.startedAt));
  }

  isPlaying(): boolean {
    return this.playing;
  }

  sendWorklet(message: unknown): void {
    this.worklet?.port.postMessage(message);
  }

  private stopSource(): void {
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch {
        // 已停止的节点无需处理。
      }
      this.source.disconnect();
      this.source = null;
    }
  }
}
