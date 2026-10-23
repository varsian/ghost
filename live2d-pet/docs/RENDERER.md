# Live2D renderer（浏览器渲染/表演模块）

`packages/plugin/src/client/renderer/` 是插件的**渲染核心**：在透明覆盖层里渲染任意 Live2D
模型，并根据宿主转发的事件驱动口型、情绪、idle 与说话手势。它不关心 HTTP/SSE/DOM 覆盖层
（这些由 `src/client/index.js` 负责），只暴露一个稳定的舞台工厂。

- 服务端/宿主：`packages/plugin/lib/index.js`（HTTP + SSE + 命令）
- 浏览器胶水：`packages/plugin/src/client/index.js`（覆盖层 DOM + SSE + 模型加载）
- 渲染核心：`src/client/renderer/**`（本文件）
- 运行时：`vendor/**`（pixi.js 7 + pixi-live2d-display 已提交；Cubism Core 由
  `scripts/fetch-vendor.mjs` 下载，不入库）
- 模型：用户自备（仓库不附带模型二进制，见 `live2d-pet/models/README.md`）
- 构建：`build-client.mjs`（产物 `lib/client.js` / `lib/window.js` 不提交）

---

## 1. 公共 API

ESM 入口：`src/client/renderer/index.js`

```js
import { createLive2DStage } from './renderer/index.js';

const stage = createLive2DStage({
  canvas, // 或者 container: HTMLElement（renderer 自己创建 <canvas>）
  model: {
    id: 'ds-whale-girl',
    baseUrl: 'http://127.0.0.1:34567/assets/ds-whale-girl/', // 目录，带尾斜杠
    modelFile: 'c_0120.model3.json',
    format: 'cubism4', // 'cubism2' | 'cubism4' | 'auto'（按文件名后缀推断）
    // 可选（宿主 GET /model 可提供；也可写在模型的 live2d.manifest.json 里）
    expressions: ['悲伤.exp3.json'], // 或 [{name:'悲伤', file:'悲伤.exp3.json'}]
    motions: [{ group: 'Idle', file: 'motions/idle.motion3.json' }],
    hiddenParts: ['Part35'],
    disableIdleMotion: true,
  },
  config: {
    /* 见 §1.2，全部可省略 */
  },
  onStatus(status) {
    /* {kind:'ready'|'error'|'loading'|'model'|'emotion'|'speak_start'|'speak_end'|'visibility'|'disposed', phase, ...} */
  },
});

await stage.ready; // 模型真正 ready 后 resolve；失败 reject（同时 onStatus kind:'error'）
```

- 工厂**同步**返回舞台对象；异步加载在 `stage.ready` 背后。`ready` 之前调用
  `setEmotion/speakStart/pushEnvelope/speakEnd` 会被缓冲，ready 后按序应用。
- `onStatus` 同时提供 `kind`（DSH 胶水使用）与 `phase`（同值，渲染器内部命名）。
  `kind:'error'` 事件带 `message` 字段。

### 1.1 舞台方法

| 方法 | 说明 |
|---|---|
| `stage.ready: Promise<stage>` | 模型加载完成；失败抛错 |
| `stage.backend` | `'pending'` → `'soullink'` 或 `'direct'`（见 §10；`stats().backend` 同值） |
| `stage.canvas` / `stage.container` | 实际使用的 canvas / 容器 |
| `stage.model` | 底层 `Live2DModel`（pixi-live2d-display），ready 前为 null |
| `setVisible(bool)` | 显示/隐藏；隐藏时停止 RAF（主要 CPU 节省点），重新显示时重新挂载 RAF |
| `resume()` | 遮挡/最小化恢复：重新 `requestAnimationFrame`、重锚时钟并清空旧包络（`sync-11` 新增；主进程 `restore/show/focus` 与窗口 tick watchdog 会调用） |
| `setScale(n)` | 相对缩放（默认按画布 fit） |
| `setPosition(anchor, offsetX?, offsetY?)` | `anchor` 可为 `bottom-right/bottom-left/top-right/top-left/center/…` 或 `{x,y}`（0..1 归一化），`offsetX/offsetY` 为 CSS px；也接受 `{x,y}` 偏移对象 |
| `setEmotion(name, intensity=1, opts?)` | 情绪：表情文件 + 动作 + 程序化参数偏移；`opts.smooth=true` 或当前正在说话时只平滑移动 VAD + 切原生表情，不重置状态机。返回 `{key, matched, expression, motion, params, intensity}` |
| `clearEmotion()` | 清除情绪表情与参数偏移 |
| `speakStart({emotion?, text?, intensity?, durationSeconds?, durationMs?})` | 开始说话：**清空旧包络**、重置时间线；可选情绪；`durationSeconds` = 整句估计时长（保持 SPEAKING），`durationMs` = 首段手势计划时长；`text` 为该段文本 |
| `speakSegment({emotion?, text?, intensity?, durationMs?})` | 同一句话的后续语音段：只更新 VAD 目标 + 原生 exp3，并向 speech-performance 队列 **append** 本段手势；不调用 `triggerIntent`、不重放旧队列；同情绪同强度自动跳过。`durationMs` 用该段真实音频秒数最佳（窗口按音频时钟调用） |
| `pushEnvelope(frames, hopMs=20)` | 追加 RMS 包络帧（`number[]` 0..1）；按设备时钟经 jitter buffer 播放；队列超过 ~500ms 实时预算时丢弃最旧帧，长帧间隔/恢复时 flush |
| `speakEnd()` | 结束说话：平滑 release 到 0，清空 speech-performance 计划；下一次 `speakStart` 会清空剩余包络 |
| `setEnvelopeConfig({gain, hopMs, ...})` | 运行时微调口型 |
| `setAudioLatency(ms)` | 设置 host 上报的音频输出延迟；说话中调用会把包络播放时钟平移，保持嘴型与可听声音对齐 |
| `playMotion(group, index?, priority?)` | 直接播放模型动作组 |
| `setExpression(name, intensity?)` | 直接施加 exp3 表情（旧表情淡出到 0 后才淡入新表情，不叠加） |
| `resize(w, h)` | 调整 CSS 像素画布尺寸并重新 fit |
| `stats()` | 见 §1.3，用于验收/调优 |
| `sampleParams(names?)` | 读取当前参数值（标准逻辑名或原始参数 id） |
| `debugState()` | 完整内部状态（表情权重、情绪目标、手势队列、模型资产清单） |
| `dispose()` | 停止 RAF、解绑 hook、销毁模型与 PIXI 应用 |

### 1.2 config 默认值

```js
{
  width: 360, height: 520,        // CSS px 画布上限（container 模式下可由 model.maxWidth/Height 覆盖）
  fps: 30,                        // 说话/表情时的渲染帧率上限
  idleFps: 15,                    // 纯 idle 时降帧
  devicePixelRatioCap: 1,         // 绝不 >1（GPU 像素填充）
  backgroundAlpha: 0,             // 透明画布
  antialias: false, preserveDrawingBuffer: false,   // MSAA 默认关闭（CPU/GPU 预算）
  autoFit: true, fitRatio: 0.98, scale: 1,
  anchor: {x: 0.5, y: 1}, offsetX: 0, offsetY: 0,
  lipSync: { enabled: true, gain: 1, maxOpen: 1, bufferMs: 40,
             attackTau: 0.03, releaseTau: 0.07, underrunGraceMs: 220, mouthFormBias: 0.12,
             startDelayMs: 0, audioLatencyMs: 0 },   // 延迟语义见 §4
  envelopeMaxBacklogMs: 500,      // 包络实时预算；超过则丢最旧帧（sync-11）
  expressionPreload: true,        // ready 后预取全部 exp3（sync-11）
  idle: { gaze: true, gazeIntervalMs: [2500, 6000], gazeRadius: 0.35, headWobble: true, motion: true },
  gestures: true,                 // 说话内容规则手势
  expressionFadeMs: 220, emotionEaseMs: 260,
  collectStats: true,             // 统计 fps/drawcalls（monkey-patch gl.drawElements）
  expressionMap: {},              // 情绪覆盖表（见 §3.3）
  backend: 'auto',                // 'auto' | 'soullink' | 'direct'（见 §10）
}
// 其他顶层选项：backend（同 config.backend）、debugHandle:false（关闭 window.__DSH_LIVE2D_STATS__）
```

### 1.3 `stats()` 返回

```js
{
  backend: 'direct'|'soullink', phase: 'ready', currentState: 'idle'|'recovering'|'reacting'|'speaking'|'hidden',
  fps: 30, targetFps: 30, frames, drawCalls /*累计*/,
  drawCallsLastFrame, avgRenderMs, visible, speaking, speechSeconds, emotion, mouth,
  width, height, dpr: 1,
  model: { file, format, expressions, motionGroups, hiddenParts, baseWidth, baseHeight },
  envelope: { active, queued, total, hopMs, delayMs, audioLatencyMs,
              droppedFrames, flushCount },   // sync-11：丢弃/重同步计数
  frameGapMs, frameGaps, expressionsPreloaded,   // sync-11：遮挡恢复/预加载诊断
  emotionSwitch: { fullIntent, smooth, skipped }, // sync-11：空闲验收时 fullIntent 不应增长
  lipSync: { enabled, bufferMs, startDelayMs, audioLatencyMs, attackTau, releaseTau },
  params: { mouthOpenY: {id, value}, mouthForm, eyeLOpen, ... }  // 已探测到的标准参数
}
```

---

## 2. 模型资产发现（任意 model3.json / model.json）

加载流程（`assets.js`）：

1. `fetch(baseUrl + modelFile)` 得到 settings JSON；**设置 `json.url = 模型文件 URL`**
   （pixi-live2d-display 用它解析相对资源路径）；
2. 资源清单来源优先级：宿主 `model.expressions/motions/hiddenParts/disableIdleMotion`
   → 模型目录里的 `live2d.manifest.json` → settings JSON 已注册内容；
3. 把发现的 Motions 合并进 `FileReferences.Motions`（保留原有组与顺序），再
   `Live2DModel.from(mergedJSON, {autoUpdate:false, autoHitTest:false, autoFocus:false})`
   由 renderer 自己驱动更新/渲染（实现 FPS 上限与 idle 降帧）；
4. 表情不注册进 settings，而是 renderer 自己混合（`exp3` 的
   `Add/Multiply/Overwrite`），按 `intensity` 缩放权重 —— 因此模型没有 expressions
   段也能用中文表情名。**同一个时间只激活一个表情**：旧表情先淡出到 0，之后新表情才
   淡入；两个表情叠加会把 `ParamCheek*`/`Paramhh2` 这类“整块眼睛/脸部贴图开关”同时
   打开，半透明时看起来就是重影（见 §5）。生产默认的 soullink 适配器则更直接：表情
   叠加层按 0/1 切换，不做淡入淡出。

### 2.1 `live2d.manifest.json`（模型目录内，自包含）

用于 VTube Studio 导出等 **model3.json 未注册表情/动作** 的模型；由原始项目的
Host 侧生成器（`proto/gen-manifest.mjs`，本快照未包含）生成：

```json
{
  "id": "<model-id>",
  "format": "cubism4",
  "model": "c_0120.model3.json",
  "profileFile": "soullink.profile.json",   // Soullink 后端使用（可选）
  "expressions": ["开心兴奋.exp3.json", { "name": "悲伤", "file": "悲伤.exp3.json" }],
  "motions": {
    "Idle": ["motions/idle.motion3.json", "aidale.motion3.json"],
    "TapBody": ["motions/喷水.motion3.json"]
  },
  "hiddenParts": ["Part109", "Part124"],
  "disableIdleMotion": true
}
```

- `hiddenParts`：每帧在 `beforeModelUpdate` 阶段（物理/pose 之后、绘制之前）用
  `setPartOpacityById(id, 0)` 强制透明 —— 用于桌布/道具/背景 part，保证覆盖层上
  **只有角色本体**。
- `disableIdleMotion`：VTube 导出的 idle motion 常常驱动道具/呆眼等自定义参数
  （DS 鲸鱼娘实测如此），置 true 后 renderer 清空 `Idle` 动作组，只保留程序化
  idle（呼吸/眨眼/视线微动），保证默认画面干净。

生成方式：原始项目用 `proto/gen-manifest.mjs <model-id>` 扫描模型目录生成该文件
（本快照未包含 `proto/`；可以按上面的 JSON 结构手写，字段都可由 `assets.js` 直接读取）。

---

## 3. 情绪系统

### 3.1 三层叠加（缺啥跳啥，不报错）

1. **模型表情（exp3）**：按候选名匹配 manifest/settings 里发现的表情文件名
   （大小写不敏感；也支持 `"0"` 这种序号），交叉淡入（`expressionFadeMs`），
   权重乘 `intensity`；
2. **模型动作**：`motions:[{group,index?}]`，组不存在则跳过；
3. **程序化参数偏移**：标准逻辑参数（见 `params.js`）按 `intensity` 缓动叠加
   （additive），参数不存在则静默跳过。这是**没有表情文件也能有情绪**的兜底层。

### 3.2 默认情绪表（`emotions.js DEFAULT_EMOTION_MAP`）

| 情绪 | 别名（节选） | 表情候选 | 程序化参数偏置 |
|---|---|---|---|
| 默认 | default/neutral/平静 | — | — |
| 开心 | 高兴/happy/joy/兴奋 | 开心兴奋/开心/高兴/happy/smile/F01/exp_01 | 嘴角+、眼微闭、眉+、腮红、头微歪 |
| 委屈 | aggrieved/可怜 | 委屈/悲伤/哭 | 嘴角−、眉下垂+角度、头低 |
| 生气 | 愤怒/angry | 生气/愤怒/angry | 眉压低/变形、嘴角−、头歪 |
| 悲伤 | 难过/sad | 悲伤/哭/sad | 眉垂、嘴角−、眼半闭、头低 |
| 惊讶 | 吃惊/surprised | 惊讶/感叹号/问号 | 眉抬、眼睁大、嘴微张 |
| 害羞 | shy/blush | 脸红/害羞 | 腮红+、眼微闭、低头歪头 |
| 温柔 | gentle/tender | 温柔/gentle/smile | 眼微闭、嘴角+、头微歪 |
| 撒娇 | coquettish | 撒娇/爱心眼 | 嘴角+、眼眯、歪头+身体 |
| 傲娇 | tsundere | 傲娇/调皮 | 眉压、嘴角−、头反向歪 |
| 调皮 | playful/naughty | 调皮/吐舌 | 嘴角+、头歪 |
| 晕 | dizzy/晕晕 | 晕晕/晕 | 头大角度歪+眼不对称 |
| 无语 | speechless/流汗 | 流汗/问号 | 眉低、嘴角− |
| 星星眼 | star/starry | 星星眼/star | 眼亮+微笑 |
| 爱心眼 | love/heart | 爱心眼/love | 腮红+微笑 |
| 吐舌 / 问号 / 感叹号 / 哭 … | — | 对应中文名 | 少量参数 |

> 模型没有对应表情文件时，第 3 层参数偏移仍然生效；反之亦然。

### 3.3 覆盖映射（host config 或模型 manifest 均可）

`config.expressionMap`（等价 `createLive2DStage({expressionMap})`）按情绪名**浅合并**：

```js
expressionMap: {
  开心: { expression: '开心兴奋', params: { mouthForm: 0.5, angleZ: 3 }, motion: 'TapBody' },
  // 也支持数组写法的完整 preset：
  自定义: { expressions: ['星星眼'], motions: [{ group: 'TapBody', index: 0 }], params: { ParamCheek15: 1 } },
}
```

- preset 的 `params` 既可用标准逻辑名（`mouthForm`）也可用原始参数 id（`ParamCheek15`）。
- 未知情绪名不会报错：先尝试同名模型表情，失败则完全无效果（不崩）。
- 说话时若没有显式 emotion，会按文本关键词推断（`TEXT_EMOTION_CUES`：哈哈→开心、
  哭→悲伤、！→惊讶、爱你→爱心眼…）。

---

## 4. 口型（RMS 包络 → ParamMouthOpenY）

- 宿主通过 SSE 转发的 `envelope` 帧是 **实际播放 PCM 的 RMS**（0..1，hop 默认 20ms）。
- `EnvelopePlayer` 用**设备时钟**（`performance.now`）播放：`begin()` 时设
  `startedAt = now + bufferMs`（默认 120ms jitter buffer），chunk 陆续
  `push()` 进来，渲染时按时间插值取样本；underrun 时先 hold 后衰减。
- 平滑：非对称 attack（~50ms）/release（~90ms）指数平滑，避免嘴抖。
- 参数：每帧 `beforeModelUpdate` 里**绝对设置** `ParamMouthOpenY`（Cubism4）/
  `PARAM_MOUTH_OPEN_Y`（Cubism2）= `smoothed * maxOpen`，并可选给
  `ParamMouthForm` 加一点说话口型偏置；说话结束/包络耗尽后平滑归零。
- Cubism 2/4 参数缺失时自动跳过（`ParamAdapter` 探测 `getParameterIndex`/
  `getParamIndex`）。
- 该模型 `Groups.LipSync` 为空也没关系：我们不依赖模型 lip-sync 映射，直接驱动参数。

---

### 4.1 延迟语义（TTS 联动）

嘴型滞后的三个来源：jitter buffer、攻击平滑、**音频设备输出延迟**。当前处理：

- jitter buffer 默认 **40ms**（原 120ms），attack τ=30ms / release τ=70ms（原 50/90ms）；
- host 在 SSE `envelope` 事件里带上 shim 上报的输出延迟 `latencyMs`（shim 里
  `sounddevice` 的 `outputBufferDacTime`/块时长等，由 tts-bridge 计算），客户端调用：

```js
stage.pushEnvelope(frames, hopMs, { latencyMs });   // 推荐：每个 chunk 都带上
// 等价：stage.setAudioLatency(latencyMs) 后再 pushEnvelope(frames, hopMs)
```

- 渲染层把这个延迟加到包络播放起点（`bufferMs + startDelayMs + audioLatencyMs`），
  即“延迟 L 毫秒再开始动嘴”，使嘴型落在**用户实际听到**的声音上；说话途中延迟
  变化会平移播放时钟（`setLatency`），不会重置包络。
- 兼容性：`latencyMs` 未提供时行为与旧版一致；`startDelayMs` 默认 0（可配置做整体
  校准）。soullink 后端没有独立的包络时钟，采用“每段语音开头补零帧”等价实现。
- `stats().lipSync` / `stats().envelope.delayMs` 暴露当前生效值，便于验收。
## 5. 灵动 idle 与说话手势（纯 CPU 规则）

- **呼吸**：pixi-live2d-display / Cubism 原生 breath（`ParamBreath`、角度自然摆动），
  模型有 Breath 组时自动。
- **眨眼**：Cubism 原生 `CubismEyeBlink`（`Groups.EyeBlink`）。
- **视线/头部微动**：每 2.5–6s 随机小目标，缓动后作为**小幅度参数偏移**加到
  `ParamEyeBallX/Y`、`ParamAngleX/Y/Z`（不用 `model.focus()`，避免世界坐标换算
  把头部角度打满）。
- **说话动作（Soullink SpeechPerformancePlanner）**：
  - **原项目就是靠这一层让角色“像在说话”**：`SpeechPerformancePlanner` 按情绪/VAD/段时长/能力
    规划语义手势（`softNod`、`doubleNod`、`gentleSway`、`affectionateLean`、`forwardEmphasis`、
    `playfulPeek`、`curiousTilt`…），曲线带缓动（`softPulse`/`holdAndRelease`/`quickAttackSlowRelease`…），
    通过 `runtime.startSpeechPerformance(plan, audioClockSeconds, "replace"|"append")` 进入
    `speechPerformance` 混合层。引擎自己**没有**长语音动作续播，不开这层就只剩被压低的 idle
    和 LipSync 重音（头被重音左右拨 = “动捕抖动”）。
  - 本插件适配器 v3 已接入：`speakStart()` 按第一段规划并 `replace`；每个后续语音段
    `speakSegment()` **只**更新 VAD 目标 + 原生 exp3 并 `append` 一段手势。`sync-11` 起段内
    不再调用 `triggerIntent`（它会清空 plan 并把状态机拉回 LISTENING），所以不需要重放整条
    plan 队列；同情绪同强度还会直接跳过情绪流程，动作时间线保持连续。
  - `startSpeechPerformance()` 会用单段 plan 时长覆盖引擎的 `speechDuration`；适配器在
    `speakStart`/`speakSegment`/恢复分支里把整句预算重新钉回去，`speakEnd` 再降到 0.45s，
    因此不会在每个 plan 到期时出现 SPEAKING→IDLE→SPEAKING 的周期性抖动，音频结束也能很快回 idle。
  - **段切换按音频时钟**：TTS 的 `segment_start` 是合成事件，比可听声音早 1～1.5s；
    host 转发 `segment_end.seconds` / `sentence_end.audioSec`，窗口用
    `playback_start` 墙钟 + 输出延迟 + 前序段音频秒数累计来决定何时 `speakSegment()`，
    表情/手势与听到的句子对齐；没有秒数时按逐段字数估算。
  - 句首段用整句估计时长把引擎留在 SPEAKING；音频仍比计划长时适配器自己 replay 队列/续
    `startSpeechMotion`，直到 `speakEnd`。
  - 手势幅度由 `gestureAmplitudeGain` 控制（SDK 上限 2.6，默认现在用 **2.6**），配合
    `motionDensity=1`、`minRestWindowMs=0`、`confidence=0.95`、段强度 1.0，动作幅度可比
    SDK 默认大约 2–3 倍；`parameterGain` 1.65。
  - `LipSync` 重音只保留很小的 `speechAccentGain`（0.45），并在最终参数上对 Angle/BodyAngle
    做 0.18s 低通，避免原生 exp3/表情切换时头猛地跳一下。
  - 生产后端（soullink 适配器）的 exp3 叠加层**不做淡入淡出**，按 0/1 切换：这些 exp3
    里的 `ParamCheek17`/`Paramhh2`/`ParamCheek74`/`ParamCheek76` 是整块眼睛/脸部贴图的
    开关，按强度半透明会同时露出新旧两层（重影/叠眼，2026-10-19 修复）。表情强度仍然
    作用在连续的 FACS 参量上（眼睑/眉毛/嘴形），所以情绪看起来依旧有轻重。
  - 说话期间的额外慢正弦（`speechSway`）默认关闭：手势层已经提供动作，只有在仍觉得单调时才开。
- 若模型自身动作组可用（如 Hiyori 的 Idle/TapBody），情绪表可映射到动作；
  DS 鲸鱼娘默认 `disableIdleMotion` + 不映射道具动作，保持画面上只有角色。

---

## 6. CPU / GPU 约定（设计文档 §4.9）

| 项 | 做法 |
|---|---|
| 画布 | CSS ≤ 360×520（config / host maxWidth/Height），覆盖层无背景/边框 |
| 分辨率 | `devicePixelRatioCap = 1`，`resolution = min(cap, devicePixelRatio)` |
| 帧率 | requestAnimationFrame + 时间门限：说话/表情 ≤ `fps`(30)，纯 idle / recovering ≤ `idleFps`（direct 默认 15，soullink 强制 ≤12），隐藏时 **0**（direct 停 RAF；soullink 降到 2fps） |
| 上采样/后处理 | 无 —— 不用 Filter、不 resize 纹理、无 bloom/阴影；纹理保持模型原始尺寸 |
| MSAA | `antialias:false`（PIXI 默认关闭；soullink adapter 发布包硬编码 true，vendor 里打补丁改为 false，见 vendor/soullink/patch-adapter.mjs） |
| 背景 | `backgroundAlpha: 0` / `transparent: true`，canvas CSS transparent，覆盖层透明 |
| 更新驱动 | `autoUpdate:false`，renderer 手动 `model.update(dt)` + `app.render()`（可精确限帧） |
| 口型/情绪/手势 | 全部 JS 数值运算（CPU），每帧仅有少量参数写入 |
| 验收指标 | `stats().fps`、`drawCallsLastFrame`、`avgRenderMs`；原型实测 idle 15–16fps / 说话 30fps、单帧 GPU 绘制 ~50 calls、render < 7ms（headless SwiftShader） |

---

## 7. 原型与验收（proto/ — 本快照未包含）

原始项目的原型与 Playwright 验收工具（`proto/`、`tests/artifacts/`、截图证据）依赖
本机 Chromium/Playwright 绝对路径与桌面截图，属于本地证据，**不随本快照发布**。
本快照保留的是渲染器源码、Host 半和协议测试：

```powershell
# 静态渲染器单元测试（node:test）
node --test tests/test_envelope.mjs
# 真实 TTS 协议/包络联调（fake daemon，无需 GPU）
node tests/test_shim_bridge.mjs
```

透明canvas/口型/情绪的像素级验收请在自己的模型与环境中重新执行（渲染器暴露了
`window.__DSH_LIVE2D_STATS__()` 与 `window.__DSH_LIVE2D_WINDOW__` 调试句柄，见 §11/§12）。

---

## 8. 构建（build-client.mjs）

```powershell
node build-client.mjs            # 生产：src/client/index.js -> lib/client.js (+ .map)
node build-client.mjs --proto    # 原型：src/client/renderer/dev-entry.js -> proto/dev-bundle.js
node build-client.mjs --no-minify
```

- esbuild 自动查找（`ESBUILD_MAIN` 环境变量 → 包内 node_modules → 向上逐级
  node_modules/.pnpm/esbuild@*），无需把 esbuild 加进依赖。
- 本快照**不提交** `lib/client.js` / `lib/window.js`：两者都内联了专有 Cubism Core。
  先执行 `node scripts/fetch-vendor.mjs --accept-live2d-eula`，再
  `node scripts/build-all.mjs`（或从 `packages/plugin` 运行 `node build-client.mjs`）。
- 生产产物格式：

```js
window.__ModuleLoader__.load({
  id: "@local/dsh-live2d",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    /* vendor: pixi.min.js（声明 var PIXI → 挂到 globalThis.PIXI） */
    /* vendor: live2d.min.js（Cubism2 core，必须在 UMD 前，装 window.Live2D） */
    /* vendor: live2dcubismcore.min.js（Cubism4 core，装 globalThis.Live2DCubismCore） */
    /* vendor: pixi-live2d-display.min.js（all-in-one UMD 包在 IIFE 内强制走
       browser-global 分支；其发布版引用 process.env.NODE_ENV —— factory 内提供
       var process shim。注意：all-in-one 在 eval 时要求 Cubism2/Cubism4 两个 core
       都已加载，这是为了同时支持 cubism2 模型；顺序见 §8 上文） */
    /* vendor: soullink/dsh-live2d-adapter.js（Apache-2.0 IIFE，全局 DSHLive2DAdapter，
       读取上面已加载的 window.PIXI / PIXI.live2d，不重复打包 pixi） */
    /* 我们的 CJS bundle（含 renderer，无外部 require） */
    return module.exports;
  }
});
```

- **vendor 顺序是硬要求**：`pixi → cubism2 core → cubism4 core → pixi-live2d-display`
  （UMD 在 eval 时检查 `window.Live2D` 与 `window.Live2DCubismCore`）。
- 无外部 `require`、无运行时 CDN；React 不需要。
- source map：vendor 内联在 bundle 上方，`.map` 的 `mappings` 前置 N 个 `;`
  （N = vendor 占用行数）把 renderer 源码行号对齐，便于调试。

---

## 9. 已知限制 / 风险

1. `cld` 发布版 `pixi-live2d-display@0.5.0-beta` 的 UMD 带 `process.env.NODE_ENV`，
   需要 shim（已在 builder/proto 解决）；升级该库时需复核。
2. Cubism 2 core `vendor/live2d.min.js` 仅在渲染 Cubism 2 模型时需要，属 Live2D
   专有“Redistributable Code”；本快照不提交该文件（`--with-cubism2` 才会下载），
   Cubism 2 模型本身也未随插件附带（只保证代码路径可用）。
3. Cubism 4 Core 同属 Live2D Proprietary Software License（允许随应用分发，禁止单独
   再分发/逆向）；本快照不提交该文件，由 `scripts/fetch-vendor.mjs` 在用户接受 EULA
   后下载；商用发布需按 Live2D 的 SDK Release License 条款评估。
4. 模型自带 idle motion 可能内嵌道具/表情（VTube 导出常见），用 manifest 的
   `disableIdleMotion` + `hiddenParts` 处理；换新模型时建议先看
   `debugState().assets` 与截图确认。
5. `intensity` 对 exp3 是权重缩放（Add/Multiply/Overwrite 的线性化），不是 Cubism
   官方的多表情叠加器；对极端 `Overwrite` 表情可能与编辑器内表现略有差异。
6. 口型依赖 host 转发的真实播放包络；若包络延迟/丢失，underrun 会 hold 后衰减到 0
   （不会卡住张嘴）。测试/无 TTS 环境可用 `syntheticEnvelope()`。
7. 单帧 GPU 绘制调用约数十次（取决于模型 drawable 数）；画布和 DPR 已限死，
   `resolution=1` 时 360×520 是主要填充成本。
8. Soullink 后端（§10）对模型有额外要求：需要 `soullink.profile.json`（由
   `@soullink-emotion/profile-generator` 生成）；模型自带的随机表情/idle 动作可能露
   道具，已用 `randomExpressionOnReset:false` + `disableIdleMotion` 处理，但换新模型时
   仍需截图复核。
9. `pixi-live2d-display` 的 `Live2DModel.from()` 在设置 object 时必须带 `url`；
   renderer 已在 `assets.js` 处理，若宿主直接传 URL 字符串也可（自动 fetch）。

---

## 10. 后端切换：Soullink Emotion SDK（优先） / direct（回退）

`createLive2DStage()` 是一个**门面（facade）**，内部按优先级选择渲染后端，对外 API 完全一致：

| 后端 | 实现 | 何时使用 |
|---|---|---|
| `soullink` | `vendor/soullink/dsh-live2d-adapter.js`（全局 `DSHLive2DAdapter.createSoullinkStage`）→ Soullink Emotion SDK：`Live2DRenderer`（PIXI+pixi-live2d-display）+ `SoullinkRuntime`（VAD/FACS、idle、口型）+ `EnvelopeAudioLevelAnalyzer` | 默认（`backend:'auto'` 且 adapter 已加载且模型目录有 `soullink.profile.json`/`profileFile`） |
| `direct` | `renderer/index.js` + `params/emotions/envelope/assets` 自研实现 | adapter 缺失/加载失败/profile 缺失（Cubism2 模型、官方 Hiyori/Haru 等无 profile 的模型），或显式 `backend:'direct'` |

选择逻辑（`createLive2DStage` facade）：

```
backend = options.backend || config.backend || 'auto'
auto:  globalThis.DSHLive2DAdapter 可用 ? 'soullink' : 'direct'
soullink 构造或 ready 失败 -> console.warn + onStatus(kind:'log') -> 自动回退 direct
```

- 选择结果写入 `stage.backend` 与 `stats().backend`（`'soullink' | 'direct'`），可用
  `window.__DSH_LIVE2D_STATS__().backend` 断言。
- 两个后端共享同一套**模型资产发现**（`assets.js`：model3 + `live2d.manifest.json` +
  descriptor），因此 expressions/motions/hiddenParts 语义一致。
- 差异（已在 adapter 包装层抹平）：soullink 的 stats 结构不同（`emotion` 为对象、
  `envelope.pendingFrames`、无 drawCalls），wrapper 统一转换为本文档 §1.3 的形状，
  原始 stats 保留在 `stats().soullink`。
- Soullink 适配层的关键修正（`backend-soullink.js`）：
  1. `baseUrl/profileUrl` 一律转**绝对 URL**（adapter 内部 `new URL()` 会二次解析相对路径）；
  2. `randomExpressionOnReset:false` —— 否则 adapter 启动时随机挑一个模型表情，
     会露出眼镜/泡泡/桌布等道具表情；
  3. `assets.disableIdleMotion` 时过滤掉 `Idle` 动作组（VTube 导出把道具烘焙进 idle）；
  4. `hiddenParts` 继续每帧 opacity=0（adapter 的 `setHiddenPartIds`）。
- **soullink 后端 idle 降帧**：adapter 发布包的 RAF 循环使用固定 fps，渲染层通过
  `vendor/soullink/patch-adapter.mjs` 打两处最小补丁（见 vendor/README.md）：
  `antialias:false`；`window.__DSH_LIVE2D_FPS__` 动态帧率。wrapper 在
  IDLE/RECOVERING 时设 12、SPEAKING/REACTING 时设 30、hidden 时 2，`stats()` 暴露
  `currentState/targetFps`。
- **adapter 版本**：v2（Blend 语义修复，模型 exp3 多为 `Add` 混合；旧版按绝对覆盖
  会把眼睛闭错）。vendor 里为“去 sourceMap + 上述两处补丁”的副本，原始 sha256
  记录在 adapter 文件头（由 `vendor/soullink/patch-adapter.mjs` 写入）。
- 强制指定后端：`createLive2DStage({ backend: ''direct'' | ''soullink'', ... })` 或
  `config.backend`；proto 页面用 `?backend=direct|soullink` 验证两条路径。

## 11. 调试句柄（真实 GUI / Playwright 验收）

stage 创建成功（任一后端 ready）后自动安装，`dispose()` 时删除：

```js
window.__DSH_LIVE2D_STATS__()   // -> 同 stage.stats()（含 backend/fps/mouth/envelope/emotion）
window.__dshLive2D = {
  stats, setEmotion, speakStart, speakEnd, pushEnvelope, resume,
  backend(), stage(), canvas()
}
```

可选关闭：`createLive2DStage({ debugHandle: false })`。
`bundle-test.mjs` 会断言句柄存在且 `backend` 为 `'soullink'`/`'direct'`。
## 12. 独立窗口（standalone window）

用户要求 Live2D 可以脱离 DSH 主 GUI 成为一个独立（Electron 透明）窗口。

| 产物 | 说明 |
|---|---|
| `packages/plugin/window/index.html` | 透明页面：只有 `#stage`(canvas 容器) + 拖拽区 + 极小自动隐藏关闭按钮；`html/body/stage/canvas` 全部 `background: transparent`，无滚动条 |
| `packages/plugin/lib/window.js` | **构建产物（不提交）**：自包含 IIFE bundle，vendor（pixi/pixi-live2d-display/Cubism core/soullink adapter）全部内联 + renderer + SSE 窗口 app；**不依赖** DSH `__ModuleLoader__` |
| `packages/plugin/lib/window.js.map` | 构建产物 source map（vendor 行偏移已对齐） |

构建：

```powershell
# 先按 docs/INSTALL.md 准备 vendor（含专有 Cubism Core），再：
cd live2d-pet/packages/plugin
node build-client.mjs --window      # -> lib/window.js (+ .map)
```

### 12.1 运行参数（query 或 `window.__DSH_LIVE2D_WINDOW_CONFIG__`）

```
?port=34567          DSH host HTTP 端口（EventSource: http://127.0.0.1:<port>/events）
&scale=1             模型缩放
&anchor=bottom-right 画布内锚点
&offsetX=0&offsetY=0 锚点偏移
&visible=1           初始显示
&fps=30&idleFps=12   渲染帧率（idle 降帧）
&debug=1             preserveDrawingBuffer=true + window.__DSH_LIVE2D_WINDOW__.measurePixels()
&width=&height=      0=铺满窗口（默认）
```

页面通过 SSE 接收与主 GUI 相同的事件：`state`（含 model payload → 创建 stage）、
`speech_start/segment_start`、`envelope`（含 `latencyMs`，见 §4.1）、`emotion`、
`speech_end/speak_done`、`model_changed`、`visibility`、`log`；断线自动重连（1s→15s 退避）。
`window.close()` 关闭窗口（可用 `window.__DSH_LIVE2D_WINDOW_CLOSE__` 覆盖，供 Electron 走 IPC）。

### 12.2 验收句柄

```js
window.__DSH_LIVE2D_WINDOW__ = { config, ready(), backend(), stats(), stage(),
  statuses(), errors(), lastEvent(), eventSource(), measurePixels(), setVisible(), setEmotion() }
window.__DSH_LIVE2D_STATS__()   // renderer facade 自动安装，dispose 删除
```

### 12.3 宿主接入要求

- Electron 创建窗口时 `transparent: true, frame: false, hasShadow: false`；
  Windows 下建议 `backgroundColor: '#00000000'`；窗口大小与画布一致或允许缩放。
- DSH host 需 serve：`GET /window`（或 `/window/index.html`）→ `window/index.html`，
  以及 `GET /lib/window.js`（静态插件根目录）。页面脚本加载器会依次尝试
  `../lib/window.js`、`/lib/window.js`、`/window.js`、`./window.js`。
- 拖拽由页面顶部 28px `drag` 区负责（Electron 原生行为），关闭按钮已实现；
  如需“点击穿透”只在下半部模型区域开启，可在 Electron 用 `setIgnoreMouseEvents` +
  forwarding。
## 13. 参考/复用了 soullink-emotion-sdk 的哪些部分

底座是 fork 的 [soullink-emotion-sdk](https://github.com/nanlingyin/soullink-emotion-sdk)
（Apache-2.0，本地子集在 `third_party/soullink-emotion-sdk/`）。实际用到的部分：

| SDK 位置 | 用法 |
| --- | --- |
| `packages/engine/src/runtime/SoullinkRuntime.ts` | 表演编排器：状态机（IDLE/LISTENING/REACTING/SPEAKING/RECOVERING）、VAD→FACS、参数混合、口型、说话表演、idle 合成；提供 `setMotionStyle` / `setParameterGain` / `setBodyMotionGain` / `setIdleEnabled` / `triggerIntent` |
| `packages/engine/src/idle/*` | `IdleEngine` + `BlinkController`/`BreathingController`/`GazeController`/`BodySwayController`/`MicroMotionController`（呼吸/眨眼/视线游走/头身摆动）、`IdleActionScheduler`（7 种小的自发动作：点头/歪头/侧看/重心转移/轻靠/叹气/慢眨眼） |
| `packages/engine/src/emotion/*` | `VADExpressionMapper`（VAD→FACS）、`VADGestureController`、`VADMicroMotionController`、`VADPrivateParameterOverlay`、`EmotionStateController`、`ProactiveController`、`ReflectionPulseController` |
| `packages/engine/src/expression/*` | `RuntimeExpressionGenerator` / `ActionUnitSolver` / `ExpressionTimeline`（FACS 表情组合与时间线） |
| `packages/engine/src/speech/*` | `SpeechPerformancePlanner`（说话时的手势/强调/表情编排）、`LipSyncController`、`AudioLevelAnalyzer`、`VoiceWaitingMotionController` |
| `packages/engine/src/profile/*` | `ModelProfile` schema、`ModelProfileAdapter`（FACS→模型参数）、`CapabilityDetector`、`NativeAnimationResolver`、`deriveProfileDefaults` |
| `packages/live2d-pixi/src/Live2DRenderer.ts` | PIXI v7 + pixi-live2d-display 渲染器：透明 canvas、模型加载、参数应用、原生 expression overlay、DPR 上限、诊断；我们另加了 `hiddenPartIds`（隐藏桌面/道具）、expression blend 修正、`randomExpressionOnReset` 开关 |
| `packages/profile-generator` | 用 Node 启发式生成 `soullink.profile.json`（22 项参数映射、44 个 exp3、7 个 motion、`idleConfig`、`privateEmotionMap`、`expressionMap`） |
| **新增** `packages/dsh-live2d-adapter`（我们写的，在 fork 里） | `createSoullinkStage()`：把 Engine + Live2DRenderer + 包络分析器封成一个透明舞台；中文 TTS 情绪名→引擎预设/原生 exp3 映射、包络延迟补偿、`hiddenParts`、stats/debug 句柄 |

未使用：`api-client` / `planner-openai` / `classifier-embedding` / `runtime-core` / `devtools-vue`
（这些是 SDK 自带的联网/LLM/VAD 输入链路；DSH 里由本地 `tts` 插件提供真实音频包络与情绪，
不需要再联网或额外推理）。
