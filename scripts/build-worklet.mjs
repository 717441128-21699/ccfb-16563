import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';

mkdirSync('public/worklets', { recursive: true });
await build({
  entryPoints: ['src/worklet/guqin-worklet.ts'],
  outfile: 'public/worklets/guqin-worklet.js',
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: false,
  sourcemap: false,
  logLevel: 'info',
});
console.log('AudioWorklet bundle ready: public/worklets/guqin-worklet.js');
