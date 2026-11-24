# 丝桐分沙 · 古琴擦弦声分离工作台

一个使用 **TypeScript + Web Audio API + AudioWorklet + Vite** 构建的古琴录音处理原型。目标不是普通全频降噪，而是依据以下特征把左手走手产生的“沙沙擦弦声”和古琴谐波、余韵、琴身共鸣分开：

- 逐帧 ACF 周期候选 + 谐波求和跟踪音高；
- 七弦开放音先验与弦内连续性约束；
- 滑音斜率换算手指弦向速度；
- 按虚构缠弦密度候选估计缠丝周期纹路；
- 宽带噪声 PSD 谱减 / Wiener 增益；
- 谐波核心直通与干净谐波模型补回；
- 持久谱能量保护琴身共鸣和谐波之间的余韵；
- 每个走手段可单独调节擦弦声保留比例、局部强度和共鸣保护。

## 页面

1. **录音导入**：本地音频拖拽/选择，或生成带客观分轨的合成测试曲；可直接在 Worker 中复算验收指标。
2. **音高曲线**：七弦颜色分轨、滑音亮点、擦弦可能性底色、弦显隐和播放头联动。
3. **擦弦声处理**：全局强度、谐波保护、共鸣保护、缠丝纹理权重；原轨/处理轨 A/B 对比。
4. **段落调节**：自动识别走手段，也可新增/删除段落，按弦、时间范围和“擦弦保留百分比”调节。

## 运行

```bash
npm install
npm run dev
```

打开终端输出的 `http://127.0.0.1:5173/`。

生产构建：

```bash
npm run build
npm run preview
```

AudioWorklet 源码在 `src/worklet/guqin-worklet.ts`。`npm run dev` 和 `npm run build` 前会通过 esbuild 生成浏览器可加载的：

```text
public/worklets/guqin-worklet.js
```

重跑 Worklet 打包：

```bash
npm run worklet
```

## 客观验收

合成器会同时生成：

- `mix`：最终混合；
- `harmonic`：古琴谐波/弦振动；
- `resonance`：琴体模态与共鸣；
- `scrape`：宽带擦弦噪声和缠丝 AM 纹理。

运行 26 秒单风格验收：

```bash
npm run verify
```

遍历全部四位虚构琴家与三套缠弦规格：

```bash
npm run verify -- --all
```

最近一次结果（Node 24 / Windows）：

| 琴家风格 | 缠弦规格 | 擦弦压低 | 谐波能量损失 | 音高最大偏差 |
|---|---|---:|---:|---:|
| 云栖老人 | 太古丝缠 | **16.93 dB** | **0.01 dB** | **0.10 cents** |
| 松雪居士 | 冰钢尼龙缠 | **17.04 dB** | **0.01 dB** | **0.01 cents** |
| 听泉女史 | 玄冰复合缠 | **16.84 dB** | **0.02 dB** | **0.40 cents** |
| 石墨山人 | 太古丝缠 | **16.75 dB** | **0.00 dB** | **0.07 cents** |

验收阈值分别是擦弦压低 ≥15 dB、谐波能量损失 ≤1 dB、处理前后音高曲线最大偏差 ≤5 cents。

> 音高对比使用同一套带弦先验的曲线跟踪，并排除 STFT 末尾 120 ms 零填充边界。680 Hz 以下的基频/低次谐波核心在处理增益中直通，因此处理前后的显示音高曲线几乎完全重合。

## 十分钟性能基准

```bash
npm run benchmark
```

该命令合成并处理一首 600 秒、48 kHz、134 个走手段的琴曲。最近一次 Node 结果：

```json
{
  "durationSec": 600,
  "processSec": 85.21,
  "realtimeRatio": 0.142,
  "limitSec": 300,
  "pass": true
}
```

即纯 DSP 处理约 **1 分 25 秒**，低于“不超过实时长度一半（300 秒）”的要求。脚本中的合成耗时约 110 秒，不属于处理时间；浏览器会把合成和重 DSP 放进 Module Worker，避免阻塞界面。实际浏览器耗时会受设备影响。

## 虚构演奏风格

- **云栖老人 · 虞山余韵**：沉缓迟涩，走手绵长，指压重，擦弦纹理粗密。
- **松雪居士 · 广陵清劲**：滑音利落快速，颗粒清楚，擦弦短而亮。
- **听泉女史 · 金陵婉润**：吟猱细腻，滑速中等，噪声呈连续细沙感。
- **石墨山人 · 蜀山苍古**：指压极实，滑速忽快忽慢，缠丝周期明显，余韵长。

## 虚构缠弦密度（圈/cm，一弦到七弦）

- **太古丝缠弦**：3.10 / 2.90 / 2.65 / 2.40 / 2.15 / 1.90 / 1.65
- **冰钢尼龙缠**：2.20 / 2.05 / 1.85 / 1.65 / 1.45 / 1.25 / 1.05
- **玄冰复合缠**：2.65 / 2.50 / 2.25 / 2.00 / 1.80 / 1.55 / 1.35

## 代码结构

```text
src/dsp/fft.ts              原地 FFT、音分/MIDI 工具
src/dsp/core.ts             逐帧音高、缠丝自相关、谱增益、OLA 重建
src/dsp/metrics.ts          RMS、音分偏差和平滑音高曲线
src/dsp/acceptance.ts       三指标客观验收
src/audio/synthetic.ts      虚构琴家/缠弦规格与分轨合成器
src/audio/player.ts         Web Audio 与 AudioWorklet 播放
src/worklet/guqin-worklet.ts AudioWorklet 逐帧跟踪/估计源码
src/workers/process-worker.ts 浏览器离线处理 Worker
src/ui/app.ts               四个页面与交互
src/ui/charts.ts            Canvas 波形、音高、包络绘制
scripts/verify.ts           npm run verify
scripts/benchmark.ts        npm run benchmark
```

## 说明与边界

这是一个可运行的 DSP 原型和交互工作台，不是商用母带插件。真实老录音可能存在多弦共振、重度混响、电平削波或非标准定弦；此时可在段落页修正所属弦和范围，并降低局部擦弦强度以保留更多吟猱余韵。
