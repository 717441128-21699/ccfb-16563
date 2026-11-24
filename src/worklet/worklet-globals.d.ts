// AudioWorkletGlobalScope 的最小本地声明；构建时 esbuild 会把处理器打包成 IIFE。
declare const sampleRate: number;
declare function registerProcessor(name: string, processorCtor: new (...args: never[]) => unknown): void;

interface AudioParamDescriptor {
  name: string;
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
  automationRate?: 'a-rate' | 'k-rate';
}

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}
