# DSH Live2D 插件（@local/dsh-live2d-bundle）

给 DeepSeek Harness 桌面版增加一个**独立的 Live2D 桌面宠物**：默认以**独立透明窗口**
渲染任意 Live2D 模型（Cubism 2/3/4）——无边框、背景完全透明（只有角色）、**按住任意位置
即可拖动、右下角拖动可调整窗口大小、右上角悬停出现关闭按钮（Esc 也可关闭）、系统托盘
提供显示/隐藏/重载/关闭**；窗口像普通程序一样出现在**任务栏**、可以**最小化后点任务栏恢复**、
默认**不置顶**（可被其它窗口盖住，`/live2d window top on` 可显式置顶）；并根据现有
`tts` 插件**真实播放的声音**、**情绪**与**内容**驱动口型、表情和灵动动作。也可以切回
页面内覆盖层模式（`/live2d overlay on`）。

- **两个互相独立的插件**，都出现在侧栏「插件」页、可自由开关：
  - **Live2D 桌宠**（`@local/dsh-live2d-bundle`）：窗口/模型/命令，独立于 TTS 工作；
  - **Live2D × TTS 联动桥**（`@local/dsh-live2d-tts-bridge`，可选）：只把 `tts` 的
    daemonScript 指向镜像 shim，喂真实音频包络/情绪；关掉即恢复原生 TTS，桌宠仍可独立运行。
- 模型随时可替换：把模型目录放进模型根目录（或用 `/live2d model <id>` 切换），无需改代码。
- 显示/隐藏、独立窗口、窗口大小/位置、覆盖层、缩放、换模型、测试情绪都由 `/live2d` 命令控制
  （和 `/tts` 同一套 UI 命令面板）。
- 尽量少用 GPU：包络/RMS 在 Python + Node（CPU）计算；说话时 30fps、idle 12fps、DPR≤1、
  无滤镜后处理；独立窗口在单独的 Electron 进程里（软件 WebGL，不占 GPU、不拖慢主界面）。

> 说明：本文档来自原开发项目，保留了当时的迭代标签（如 `sync-11`、`T2/T8`）作为
> 设计沿革记录；本仓库是打包后的源码快照，不含模型、专有 Cubism Core 和预构建的
> 浏览器 bundle，安装前请先按 `docs/INSTALL.md` 准备 vendor 并构建。

## 由什么驱动

```
TTS daemon（VoxCPM 1.5, Python）
   │  播放的真实 PCM（sounddevice 回调）
   ▼
live2d_tts_shim.py（被配置成 tts 的 daemonScript）
   │  · 逐段情绪/内容、segment 时间线
   │  · 每 ~20ms 的真实 RMS 包络
   ▼ HTTP POST 127.0.0.1:34567/ingest
Live2D 插件 Host 半（Node，DSH 主进程内）
   │  SSE /events
   ▼
Live2D 插件 Browser 半（DSH Web GUI 内的可选覆盖层）
   · 透明覆盖层 + Live2D 渲染
   · 口型 = RMS 包络（真实音量）
   · 表情/动作 = TTS 情绪 + 模型自带 exp3/motion + 程序化 idle
        │ 同一份 SSE 事件
        ▼
独立透明窗口（tools/live2d-window 启动的 Electron 进程，默认展示方式）
   · 无边框 / 背景透明 / 像普通窗口一样进任务栏、可最小化、默认不置顶
   · 可拖动 / 可调整大小
   · 与主界面渲染线程分离（软件 WebGL，低 GPU 占用）
```

技术底座：在 [soullink-emotion-sdk](https://github.com/nanlingyin/soullink-emotion-sdk)
（Apache-2.0）上直接改造——`Live2DRenderer`（PIXI v7 + pixi-live2d-display）负责渲染，
`SoullinkRuntime` 负责 VAD/FACS 表情、idle 呼吸/眨眼/视线、说话手势与口型混合；
`profile-generator` 在 Host 侧为任意模型生成 `soullink.profile.json`（参数映射与原生表情/动作清单）。
渲染器另有一条不依赖 soullink 的直连 pixi-live2d-display 回退路径，两者 API 一致。

## 命令

在聊天输入框输入 `/live2d …`（命令在 UI 命令平面执行，不会发给模型）：

| 命令 | 作用 |
| --- | --- |
| `/live2d status` | 状态：显示/隐藏、独立窗口/覆盖层、端口、模型、窗口几何、TTS 桥接与输出延迟 |
| `/live2d on` / `/live2d off` | 显示 / 隐藏（`mode: window` 时开/关独立窗口） |
| `/live2d window` | 打开独立透明窗口（已打开时恢复显示） |
| `/live2d window show\|hide\|close\|status` | 恢复显示（置前）/ 隐藏（托盘可恢复）/ 关闭 / 查询窗口几何 |
| `/live2d window dedupe` | 清理日志里记录、仍存活的重复独立窗口，只保留 pid/lock 对应的一个 |
| `/live2d window minimize` | 最小化到任务栏（之后点任务栏里的「DSH Live2D」恢复） |
| `/live2d window top on\|off` | 切换窗口置顶（默认 off：像普通窗口一样可被其它窗口盖住） |
| `/live2d window size <宽> <高>` | 调整窗口大小，例：`/live2d window size 500 700` 或 `500x700` |
| `/live2d window move <x> <y>` | 移动窗口到绝对屏幕坐标 |
| `/live2d overlay on\|off` | 显示 / 隐藏页面内覆盖层（覆盖层模式/双模式） |
| `/live2d list` | 列出模型目录里可用的模型（`<模型名>/<模型名>.model3.json`） |
| `/live2d model <id>` | 切换模型（`/live2d model` 不带参数 = 重新扫描并回到第一个） |
| `/live2d size <0.1-8>` | 模型缩放（不改变窗口大小） |
| `/live2d position <anchor> [dx dy]` | 覆盖层位置：`bottom-right/bottom-left/top-right/top-left/center`，可带像素偏移 |
| `/live2d reload` | 重新扫描模型目录并广播状态（不重启插件） |
| `/live2d test [情绪名]` | 不发声地演示情绪（调试用） |

**独立窗口的直接操作**（无需输入命令）：

- **拖动**：按住窗口内任意位置拖动（整个窗口都是拖动区）；
- **调整大小**：鼠标移到窗口右下角，出现斜纹手柄后按住拖动；
- **关闭**：鼠标移到右上角，出现 × 后点击；或按 `Esc`；或右键系统菜单“关闭”；或托盘菜单；
- **最小化 / 恢复**：窗口现在有任务栏图标，点最小化后可以从任务栏恢复（和普通程序一样）；
  托盘图标仍提供“显示窗口 / 隐藏窗口 / 重新加载 / 关闭窗口”菜单；
- **窗口层级**：默认**不置顶**，可被其它窗口正常盖住；需要旧版“永远最上层”时用
  `/live2d window top on`（关闭：`/live2d window top off`）；
- 窗口的位置和大小会自动记住，下次启动恢复；越界（比如拖到屏幕外）会自动拉回工作区。

独立窗口由 `tools/live2d-window/` 下的 Electron 启动器提供（透明、无边框、普通窗口层级、可拖动/缩放），
加载 Host 的 `http://127.0.0.1:34567/window` 页面。若启动器不可用（未安装 Electron），
插件自动回退到页面内覆盖层并在状态里提示。

## 安装（概要）

完整步骤见 [INSTALL.md](INSTALL.md)（本快照的安装需要先准备 vendor、构建浏览器 bundle）。
核心是一个 bundle + 一个插件包：

- `@local/dsh-live2d-bundle`（bundle 层，`dsh.bundle.patch` → 插入 `live2d` 行；TTS 联动
  由独立的 `@local/dsh-live2d-tts-bridge` bundle 覆盖 `tool-tts` 行的 `daemonScript` 实现）
- `@local/dsh-live2d`（插件本体：Host 半 `lib/index.js` + Browser 半 `lib/client.js` +
  `python/live2d_tts_shim.py` + `vendor/`；`lib/client.js` / `lib/window.js` 是构建产物，
  仓库不提交，先 `node scripts/build-all.mjs` 生成）

bundle 出现在侧栏「插件」页；**关掉 bridge bundle = 撤掉 TTS shim 覆盖 = TTS 回到原生行为**，
桌宠 bundle 可独立使用。

## 换模型

本仓库**不附带任何模型**；模型是第三方资产，需自备并遵守作者许可
（见 `live2d-pet/models/README.md`）。模型目录结构（默认模型根为
`packages/plugin/models/`，可用插件行 config 的 `modelsDir` 指到任意目录，例如
`live2d-pet/models/`）：

```
<modelsDir>/
  <模型名>/
    <模型名>.model3.json    # 入口（或 .model.json = Cubism 2）
    <模型名>.moc3
    <模型名>.2048/texture_00.png
    ...                     # 纹理/物理/cdi3
    悲伤.exp3.json  ...      # 可选：表情（文件名即表情名，中文可用）
    motions/idle.motion3.json ...   # 可选：动作
    soullink.profile.json   # 可选：soullink 参数映射（没有则 Host 自动生成）
    live2d.manifest.json    # 可选：{ "hiddenParts": [...], "name": "..." } 默认隐藏的道具 part
```

换模型两种方式：

1. 把新模型目录放进 `modelsDir`，`/live2d reload` 后 `/live2d list` + `/live2d model <新目录名>`；
2. 或者直接改插件行 config 的 `defaultModel`，HMR 重组合后生效。

Host 会扫描 `.model3.json`、`.cdi3.json`、`*.exp3.json`、`*.motion3.json`，为缺少 profile 的模型
生成参数映射；`live2d.manifest.json` 的 `hiddenParts` 用来隐藏模型自带的桌面/道具 part
（默认只显示角色本体，保持背景透明）。模型文件已被 `.gitignore` 排除，不会被提交。

## 配置

插件行 `config`（`packages/bundle/cordis.patch.yml`，HMR 热生效）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `34567` | Host 本地 HTTP/SSE 端口（browser、窗口页与 shim 都连它） |
| `mode` | `window` | 展示方式：`window`（独立透明窗口）/`overlay`（页面内覆盖层）/`both`/`none` |
| `visible` | `true` | 初始是否显示；`/live2d on/off` 可切换 |
| `modelsDir` | `'` | 模型根目录；空 = `<plugin>/models/`（本快照为占位目录） |
| `defaultModel` | `''` | 初始模型 id；空 = 目录里第一个 |
| `scale` | `1.0` | 显示缩放 |
| `anchor` / `offsetX` / `offsetY` | `bottom-right` / `0` / `0` | 覆盖层位置（窗口模式忽略） |
| `opacity` | `1.0` | 覆盖层不透明度 |
| `fps` | `30` | 说话/表情时的渲染帧率上限（1–60） |
| `idleFps` | `24` | 纯 idle 时的**最高**帧率；实际按画布像素预算自适应（见下） |
| `idlePixelBudget` / `activePixelBudget` | `7e6` / `10e6` | idle/说话时允许的“像素/秒”预算，按窗口大小自动下调帧率（大窗口不烧满 CPU） |
| `motionStyle` | lively 调参 | 覆盖 soullink `MotionStyle`（spontaneity/gazeStability/microMotionGain/…） |
| `parameterGain` / `bodyMotionGain` | `1.55` / `1.6` | 表情/头身动作增益（比 SDK 默认更“有精神”） |
| `idleMoods` / `idleMoodMinMs` / `idleMoodMaxMs` / `idleMoodHoldMs` | `亲切/强调/否认` / 11000 / 22000 / 4200 | idle 时每隔一段时间自动来一次“小情绪”（走同一条表情链路），有 TTS 时自动让位 |
| `speechSway` | `{enabled:false, gain:1, headX:1.5, headY:1.0, headZ:2.4, bodyX:1.0, bodyZ:1.6}` | 可选的额外正弦摇摆（默认关）。说话时的动作主要由 SDK 的 `SpeechPerformancePlanner` 规划（点头/歪头/摇摆/强调）；数字仍觉得不够时才开 |
| `speechEmotionMode` | `expression` | 旧 adapter 的后备开关：句内情绪切换用 `expression`（完整意图）还是 `vad`（只混合 VAD）。当前 vendor adapter 自带 `speakSegment()`，两种都会规划手势 |
| `speechGestureGain` | `2.6` | **说话动作幅度主旋钮**（= 适配器 `gestureAmplitudeGain`，SDK 上限 2.6）。想更夸张就顶格，想收敛就降 |
| `speechGestureLimit` / `speechMotionDensity` / `speechGestureRestMs` | `4` / `1.0` / `0` | 每段最多手势数、手势占段时长比例、两次手势之间的最小间隔（ms） |
| `speechGestureConfidence` / `speechIntensity` | `0.95` / `1.0` | 规划器置信度与 TTS 情绪强度（都会提高手势能量） |
| `parameterGain` | `1.8` | 引擎 FACS→参数总增益（idle、表情、说话手势一起放大） |
| `speechPeakAccent` | `{enabled:true, threshold:0.55, minIntervalMs:420, durationMs:520, headY:3.2, headZ:1.6, bodyY:1.2}` | 响度峰值驱动的平滑“强调点头”（升余弦脉冲；这是上游 planner `audioPeaks` 的实时版，见下） |
| `motionStyle.speechAccentGain` | `0.45` | 引擎自带的 LipSync 重音（左右翻头）。这个动作每次重音会翻方向，调大就会变成“动补抖动” |
| `maxWidth` / `maxHeight` | `360` / `520` | 覆盖层画布 CSS 尺寸上限 |
| `devicePixelRatioCap` | `1` | 限制 WebGL 像素填充（GPU 友好） |
| `windowWidth` / `windowHeight` | `360` / `520` | 独立窗口尺寸 |
| `windowX` / `windowY` | `null` | 独立窗口首次位置（空 = 系统默认/屏幕右下） |
| `windowAlwaysOnTop` | `false` | 独立窗口是否置顶（默认 false：像普通窗口一样可被盖住；运行时 `/live2d window top on|off`） |
| `windowDedupe` | `true` | 启动/`/live2d on` 时按窗口日志清理仍存活的重复独立窗口 |
| `sseBackpressureBytes` | `65536` | 窗口 SSE 客户端缓冲超过该字节数就断开，让恢复后的页面重连而不是补放旧事件 |
| `sseBackpressureMs` | `5000` | 写阻塞超过该毫秒数同样断开（与字节阈值任一满足） |
| `idleMotion` / `blink` / `breathe` / `gazeFollow` | `true` | 灵动 idle 各层开关 |
| `lipSync` / `lipSyncGain` / `lipSyncSmoothing` | `true` / `1.0` / `0.55` | 真实音量口型 |
| `idleMoods` | `[]` | 空闲时随机切换的情绪列表；默认空 = 只保留自然摇摆。填 `['亲切','强调','否认']` 可恢复旧的自动换心情 |
| `expressionMap` | `{}` | 情绪名 → `{expression, params}` 覆盖 |
| `dataDir` | `''` | 运行状态/日志目录；空 = 插件包 `data/` |
| `ingestToken` | `dsh-live2d-local` | TTS shim → Host 的本机 ingest 校验串 |

### 灵动性：表情与 TTS 的关系

TTS 的每个语音段带 **情绪名**、**文本** 和 **真实播放 PCM**，它们分别驱动不同层：

| TTS 输出 | 去向 | 表现 |
| --- | --- | --- |
| 情绪名（默认/亲切/强调/否认） | 段首：完整情绪意图（`triggerIntent`）→ 原生 exp3 + VAD；后续段：`speakSegment()` 只更新 VAD 目标 + 原生表情并追加本段动作，**不重置状态机、不重放动作队列** | 亲切→爱心眼、强调→开心兴奋、否认→问号；表情按段平滑切换，动作不重启、不跳姿势 |
| 文本内容 | 段首/每段：`SpeechPerformancePlanner` 按情绪、VAD、段时长规划**语义手势**（点头/歪头/摇摆/强调），逐段 append 到 `runtime.startSpeechPerformance()` | 说话时头/身体一直在做连贯的、有缓动曲线的动作（这就是原项目里“像人在说话”的部分） |
| 真实播放 PCM 包络 | LipSync（`ParamMouthOpenY`）+ 输出延迟 182ms 补偿 + 很轻的说话重音 | 嘴型随真实声音开合；重音只保留很小幅度，不说话时头不乱抖 |
| 无 TTS 的 idle | IdleEngine + IdleActionScheduler（**不**再定时触发情绪） | 只保留呼吸/眨眼/视线游走/头身摆动/自然小动作；`idleMoods` 默认空，显式配置才启用自动换心情 |

所以：**表情 = TTS 情绪驱动**，嘴型 = TTS 真实声音驱动，**说话动作 = SDK 的 speech-performance 规划层驱动**。
一次开口只 `speakStart` 一次、整句时长覆盖整段音频；每个后续语音段调 `speakSegment()`：平滑移动 VAD +
切原生表情 + 追加手势块。`sync-11` 起**不再**在段内调用 `triggerIntent`（它会清空并重放整个动作队列，
造成每句边界抽一下），同情绪连续段还会直接跳过整套情绪流程。没有这一层时，引擎在 SPEAKING
里只有被压低的 idle 和 LipSync 重音，身体几乎不动、头被重音左右拨——就是“背后有个动捕在抖”的来源。

### 灵动性与 CPU 自适应

- idle 的帧率上限按画布大小换算：`fps ≈ idlePixelBudget / (宽×高)`。
  420×620 窗口 ≈ 24fps，500×700 ≈ 20fps，864×655 ≈ 12fps —— 小窗口更顺滑，大窗口不烧 CPU。
- PIXI 自己的渲染 ticker 也被限制到同一帧率（此前它固定 60fps 渲染整块透明画布，
  软件 WebGL 下 idle CPU 高达约 9.8 个核；限制后同尺寸窗口 idle 约 1.0 个核）。
- 说话/表情时用 `activePixelBudget` 提升帧率（小窗口 30fps，大窗口约 17fps）。

TTS 音量包络归一化：shim 报告的 RMS 已乘 `envelopeGain`（默认 3.0）并 clamp 到 0..1；
口型增益/平滑在插件配置里调。**口型对齐**：shim 同时上报播放输出延迟 `latencyMs`
（声卡/蓝牙耳机的实际输出缓冲延迟），渲染层把包络消费推迟这段时间，使嘴型与真正可听的
声音对齐；jitter buffer 默认 ~40ms，兼顾低延迟与抗抖动。

## CPU / GPU

- 包络计算：Python（numpy）逐回调块 RMS，CPU，单声道混合，~50 次/秒，开销可忽略。
- 事件转发/扫描/HTTP/SSE：Node 主进程，CPU；模型目录扫描只在 `reload`/`model` 时执行。
- 独立窗口：单独的 Electron 进程（`tools/live2d-window`，Electron 28 + 软件 WebGL/SwiftShader），
  **不占 GPU、不占主界面渲染线程**；帧率按画布像素预算自适应（小窗口 idle 24fps / 大窗口约 12fps，
  说话时 30fps 或按预算下调）、DPR≤1、无滤镜/后处理，隐藏/关闭时停止渲染。
  透明窗口在部分机器上需要软件渲染才能稳定启动（启动器已默认开启，
  可用 `LIVE2D_WINDOW_GPU=1` 尝试硬件加速）。
- 实测（864×655 窗口、idle）：渲染 ticker 限帧前约 **9.8 个 CPU 核**，限帧后约 **1.05 个核**；
  小窗口（420×620）idle 24fps 时约 1–2 个核。
- **窗口不在焦点也不降频**：启动参数带
  `--disable-background-timer-throttling --disable-backgrounding-occluded-windows
  --disable-renderer-backgrounding --disable-features=CalculateNativeWinOcclusion`，
  并在窗口侧关闭 `backgroundThrottling`。实测未聚焦/被其他窗口遮挡时 `visibilityState`
  仍为 `visible`、帧率保持 ~23/24fps（此前 Chromium 的后台/遮挡节流会让它偶发掉帧）。
- Live2D 渲染本身是画布 WebGL（软件光栅化时走 CPU，开销可控）。
- 不使用 GPU 做任何音频分析、文本推理或图像处理。

## 故障排查

| 现象 | 检查 |
| --- | --- |
| 窗口不在焦点时卡顿 | 已默认关闭 Chromium 后台/遮挡节流（启动参数 + `backgroundThrottling:false`）；确认窗口没有被其他置顶全屏程序盖住，或把窗口调小/降低 `idleFps` |
| 嘴型先动/不同步 | 已改为等第一帧真实音频（`playback_start`/首条 envelope）才表演；仍略超前时把 shim sidecar 的 `latencyExtraMs` 调大（20–50ms 一档） |
| 插件页找不到开关 | 打开 设置 → 插件，**向下滚动到「已安装插件」**，底部有「Live2D 桌宠」「Live2D × TTS 联动桥」两张卡（各带开关）；页面若是热更新前打开的，点右上角刷新或退出设置再进 |
| 窗口里没有形象 / 只有透明空白 | `/live2d window status` 看窗口是否打开；`/live2d on` 重新显示；窗口进程日志 `<plugin>/data/live2d-window.log` 的 `page-diagnostics` 里 `visible` 应为 true |
| 不知道如何调整窗口大小 | 窗口**右下角常显斜纹手柄**，按住拖动即可（首次打开会显示「拖动这里调整大小 ↘」气泡）；精确尺寸用 `/live2d window size 500 700` |
| 窗口找不到了 | 托盘图标 →「显示窗口」；或 `/live2d window show`；任务栏里也有角色窗口，点它恢复；`/live2d window minimize` 可主动最小化 |
| **窗口一直挡在最上层 / 想让它像普通窗口一样被盖住** | 默认已不置顶（`windowAlwaysOnTop: false`，任务栏可见、可最小化恢复）；临时切换：`/live2d window top on` / `/live2d window top off` |
| **自动切换表情时出现重影/叠眼/半透明旧表情** | `sync-9` 已修：soullink 适配器的 exp3 叠加层原来按强度淡入淡出，`ParamCheek*`/`Paramhh2` 这类参数是**整块眼睛/脸部贴图的开关**，半透明时新旧贴图同时可见 = 重影。现在表情叠加层只按 0/1 切换（不再淡入淡出），强度只作用于连续的 FACS 参量。旧窗口需重启：`/live2d window close` → `/live2d window open` |
| **窗口一闪一闪 / 角色窗口反复重启 / 同时出现多个角色窗口** | `sync-10`/`sync-11` 已修，见下：① 旧窗口的“自愈”误信 host 的 `speaking` 标记——TTS 被中止时 `speak_done` 丢失会让它一直为 true，窗口便每几秒重连一次、连续 3 次后 **reload 页面**（画面闪烁）；现在只在 host 真的收到新音频（`lastEnvelopeAt` 前进）时才重连，且**永不自动 reload**；host 也加了 watchdog：连续 12s 没有真实音频就把 `speaking` 清掉。② 窗口重复：`sync-11` 增加 **Electron `requestSingleInstanceLock`**（内核级互斥，pid/lock 文件丢了也生效）、launcher 互斥锁和启动前 `--dedupe` 清理；host 启动/`/live2d on` 时也会去重，`/live2d window dedupe` 可手动清理。旧窗口需重启才会载入新版本 |
| **空闲时自己换表情/情绪（没说话也在变脸）** | `sync-11` 起默认**关闭空闲情绪**：`idleMoods` 默认空数组，`setProactiveRepeatEnabled(false)`；空闲只保留呼吸、眨眼、视线游走、头部/身体轻摆和自然小动作。想恢复自动换心情，显式设置 `idleMoods: ['亲切','强调','否认']`（默认不再启用） |
| **窗口被完全挡住或最小化一段时间后，嘴型/动画停住；切到前台点一下才恢复** | `sync-11` 已修：host 每 2s 广播 `tick`，窗口用帧计数器 watchdog 发现 rAF 停摆后自动 `resume()`；`restore`/`show`/`focus` 时主进程也会主动调用 `resume()`；包络队列有 500ms 上限并在恢复时 flush，host 对暂停的 SSE 连接做背压丢弃/重连，因此不会补放遮挡期间的旧音频，也不需要点击/切前台 |
| **Alt+Tab / 任务栏出现多个 `DSH Live2D` 窗口（其中可能只有一个标题/空白，另一个显示模型）** | 根因有两层：① 插件重载时旧 host 没等独立窗口退出就启动新 host（`sync-11` 已改为 async teardown，`await closeWindow()` 后才 dispose）；② 旧窗口被 `taskkill /F` 强杀时，Windows Explorer 可能把透明 Electron 窗口的缩略图留在 Alt+Tab/Task View 里——它们不是真实窗口，所以 `Get-Process`/`dedupe` 只看到 1 个。`sync-11` 的关闭改为**优先 `WM_CLOSE` 优雅关闭**，仅对卡死的进程才强杀；已有残留缩略图需重启一次 `explorer.exe` 清除。之后 host 启动/`/live2d on`/每 60s 仍会自动清理真实的多余窗口 |
| 右下角没有形象 | 先 `/live2d on`；`/live2d status` 看端口/模型；浏览器控制台看 `127.0.0.1:34567` 连接 |
| 模型黑屏/不显示 | 模型目录是否含 `.moc3` + 纹理；是否 Cubism 2/3/4；`/live2d list` 是否有它 |
| 有形象但说话不动嘴 | TTS 是否走 shim：`<plugin>/data/tts-bridge.enabled` 是否存在；`/tts status` 是否正常；host 端口是否被占 |
| **关闭 DSH 主窗口后模型还在但不再跟 TTS 动**（重开窗口也不恢复） | 这是**窗口 SSE 流静默失联**（旧窗口残留 / 宿主重载竞态 / 半开连接），不是 TTS 坏了。`sync-8` 起自愈，`sync-11` 进一步加强：host 每 10s 广播 `state`、每 2s 广播 `tick`；窗口发现「host 正在说话但自己没收到 TTS 事件」时自动重连 SSE，帧循环停摆时自动 `resume()`；**不会自动 reload 页面**（避免闪烁）。仍不恢复时再 `/live2d window close` → `/live2d on` |
| 安装/重载插件后窗口消失没回来 | `sync-8` 起 host 会重试启动窗口（2.5s × 3），启动后 60s 内发现窗口缺失还会自动重生；也可 `/live2d on` |
| TTS 有声但嘴不动（重启/重新连接后尤其） | 常见根因是窗口页在 TTS 已经开始后才重连，错过了 `speak_request`/`playback_start`/`segment_start`，只剩 envelope，适配器 `voiceActive=false` 就不张嘴。`sync-12` 起：首个新鲜 envelope 会**从音频证据自动启动一次 fallback 表演**；host 心跳 `speaking=true` 而窗口表演已停时也会重启。另检查 tts daemon 命令行是否含 `live2d_tts_shim.py`；工作区 `tts.config.yml` 的 `daemonScript: ""` 会覆盖 bridge bundle 的行配置（`install.ps1` 会自动改成 shim 路径，`uninstall.ps1` 恢复）。改完结束 python tts daemon，下次调用重开即生效 |
| **说话时身体一抽一抽/发僵，或情绪切换一顿** | `sync-11` 起段内情绪切换不再调用 `triggerIntent`（它会把状态机拉回 `LISTENING` 并清空/重放 speech-performance 队列），只平滑移动 VAD + 切原生表情并追加本段动作；同情绪连续段直接跳过整套情绪流程，exp3 在 ready 后预加载。**旧窗口要重启**才会载入新 bundle：`/live2d window close` → `/live2d window open`。量化验收：`node tools/measure-twitch.mjs --label after` |
| 说话时表情/动作比声音**先变**（或表情和句子对不上） | TTS 的 `segment_start` 是合成事件，比可听声音早 1～1.5s；旧窗口按它切表情就会抢拍。`sync-5` 起 host 转发 `segment_end.seconds` / `sentence_end.audioSec` 与逐段文本，窗口按**音频时钟**（playback_start 墙钟 + 输出延迟 + 前序段音频秒数）切段。旧窗口需重启：`/live2d window close` → `/live2d window open` |
| 说话时身体太静/太僵 | 说话动作由 SDK 的 `SpeechPerformancePlanner` 规划（点头/歪头/摇摆/强调）。若仍觉得弱，把 `speechSway.enabled` 打开并调 `gain`，或提高 `bodyMotionGain`；想更安静就把 `motionStyle.speechAccentGain` 再降 |
| 说话时头一直在**左右小幅抖**（像动补） | 这是 LipSync 重音在响度峰值上左右翻头（`accentDirection` 每 0.18s 可翻一次），叠上 30° 的 headZ 参数映射后非常明显。已把 `motionStyle.speechAccentGain` 从 1.15 降到 0.32，并在渲染前对 Angle/BodyAngle 做 0.35s 低通；说话的“活”改由 `speechSway` 的慢正弦提供（0.03–0.11Hz，幅度 ±1.5–3°）。想更明显就把 `speechSway.gain` 调大，想要完全不动就关掉 |
| 动作一顿一顿（不是抽搐，是掉帧） | 独立窗口帧率按像素预算自适应：窗口越大帧率越低（864×655 ≈ 12fps，说话时约 17fps）。把窗口缩到 **≤500×700**（≈20–24fps）或调高 `fps` / `activePixelBudget`（更顺滑，但更吃 CPU） |
| 输入 `/live2d` 报 `handler must return a CommandResult` | 旧版命令 handler 成功分支漏了返回值，已修（`{kind:'success', text}`）。更新后需要插件重载（改一次 profile patch 或重启 DSH）才生效 |
| 觉得整体太晃/太静 | 想更活泼：`motionStyle.spontaneity`/`microMotionGain` ↑、`bodyMotionGain` ↑；想更安静：`speechAccentGain` 0.8↓、`bodyMotionGain` 1.2↓、`idleMoods` 置空 |
| TTS 异常/没声音 | 关掉 bundle 即恢复原生 TTS；检查 shim 旁路 `python/live2d_tts_shim.json` 的 `realDaemon` 路径 |
| 背景不是全透明 | `/live2d reload`；模型目录 `live2d.manifest.json` 的 `hiddenParts` 是否覆盖道具 part；浏览器页面本身不能有遮罩 |

## 许可与致谢

- 本仓库（含本插件代码）：**Apache-2.0**（见根目录 `LICENSE` / `NOTICE` / `docs/LICENSING.md`）。
- 渲染/表演底座：[soullink-emotion-sdk](https://github.com/nanlingyin/soullink-emotion-sdk)
  （Apache-2.0，本仓库仅包含其 DSH adapter 相关子集的源码与构建产物，见
  `third_party/soullink-emotion-sdk/`）。
- Live2D Cubism Core：Live2D Inc. 的专有运行时。仓库**不提交**该文件；由
  `scripts/fetch-vendor.mjs --accept-live2d-eula` 在用户接受 EULA 后下载，使用时须遵守
  Live2D Proprietary Software License / Cubism SDK Release License 条款。
- PIXI.js（MIT）、pixi-live2d-display（MIT）：许可文本见 `packages/plugin/vendor/LICENSE-*.txt`。
- 仓库不附带任何测试模型或参考音频；原项目里用过的第三方测试模型未随本快照分发，
  请使用你有权使用的模型。
