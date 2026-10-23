# DSH Live2D 插件 — 设计（冻结 v1）
> 说明：本文是原开发项目的设计文档（历史记录），其中的目录树、工具列表与“并行开发写范围”
> 是开发期状态；本仓库是打包后的源码快照，实际布局见 `docs/ARCHITECTURE.md`，安装见
> `docs/INSTALL.md`。模型、专有 Cubism Core、`proto/`/Playwright 验收工具与截图证据均未包含。

目标：为 **DeepSeek Harness Desktop（0.2.0-rc.2，profile `desktop`，GUI http://127.0.0.1:64177）**
增加一个**独立插件**：在 Web GUI 里渲染任意 Live2D 模型，并根据现有 `tts` 插件实际播放的
声音（RMS 包络）、情绪（segment 情绪名）与内容（text）驱动口型、表情和灵动动作；
支持 `/live2d` 命令（开关显示、换模型、调大小/位置等）；作为 bundle 出现在侧栏「插件」页，
可整体/按行实际开关；尽量用 CPU（仅绘制不可避地走 WebGL，且限制画布尺寸/帧率/DPR）。

## 1. 交付物布局

```
live2d-pet/                  # 原项目开发期布局（打包后见 docs/ARCHITECTURE.md）
  packages/bundle/                 # @local/dsh-live2d-bundle  (bundle layer, dsh.bundle.patch)
    package.json                   # dsh.bundle.patch -> cordis.patch.yml；dependencies 指向 plugin
    cordis.patch.yml               # 插入 live2d 行 + 覆盖 tool-tts 行（daemonScript -> shim）
    lib/index.js                   # 空 ESM 导出（bundle 包惯例）
    icon.svg, locale/zh.json, locale/en.json
  packages/plugin/                 # @local/dsh-live2d (host + client)
    package.json                   # main lib/index.js；dsh.client { platform: web }
    lib/index.js                   # host 半（ESM，手写，无构建）
    lib/client.js                  # client 半（构建产物：window.__ModuleLoader__.load(...)）
    src/client/                    # client 源码（esbuild 打包前）
    vendor/                        # 第三方前端运行时（pixi / pixi-live2d-display / cubism core）
    python/live2d_tts_shim.py      # TTS daemon 替身（stub relay + 事件/包络 tee）
    python/live2d_tts_shim.json    # 安装时生成的旁路配置（真实 daemon 路径、ingest URL/token）
    build-client.mjs               # esbuild 打包 src/client -> lib/client.js（包成 loader 格式）
  models/<name>/                   # 默认随插件附带的示例模型（可在设置里指向任意目录）
  tools/
    install.ps1                    # 安装/更新到指定 profile（dev / desktop），写链接+依赖+bundle 选择
    uninstall.ps1
    dev-start.ps1                  # 起 dev web 实例（DSH_HOME=.live2d-home，端口 3097）
    dev-test.mjs                   # Playwright：截图 + 断言插件页/覆盖层/命令/事件
  tests/                           # 单元测试（node --test）：协议、路径、命令解析
  docs/
    README.md                      # 使用说明（命令、配置、换模型、CPU 说明）
    INSTALL.md                     # 安装/卸载/升级回滚
    ACCEPTANCE.md                  # 验收证据（截图/日志）
  DESIGN.md                        # 本文件
```

安装目标 profile：`~/.dsh/profiles/desktop`（Electron 独占管理的 profile，CLI 的 `dsh plugin`
拒绝操作；**用文件级安装 + HMR 热重载**）。dev 测试实例：`DSH_HOME=<repo>/.live2d-home`、
profile `web`、端口 3097。

## 2. 运行时架构

```
 TTS daemon (python, VoxCPM 1.5)                 ┌──────────────── Host (Node, dsh 主进程) ─────────────┐
   ▲ stdin 请求 / stdout 帧                      │ live2d plugin host half:                              │
   │                                             │  - HTTP server 127.0.0.1:34567                        │
 ┌─┴───────────────────────────┐   HTTP POST     │      GET  /health                                     │
 │ live2d_tts_shim.py          │  /ingest  ────► │      GET  /events   (SSE, 浏览器)                     │
 │  (TTS 的 daemonScript)      │  JSON events    │      POST /ingest   (shim, token)                     │
 │  - 原样 relay stdin/stdout  │                 │      GET  /model    (当前模型描述)                    │
 │  - tee speaker PCM 回调     │                 │      GET  /assets/* (模型目录静态文件，防穿越)        │
 │    -> 每 ~40ms RMS 包络     │                 │      POST /command  (浏览器发命令，可选)               │
 └─────────────────────────────┘                 │  - /live2d 命令族（UI 命令平面，经 commands 服务）     │
                                                 │  - 状态文件 dataDir/state.json（visible/model/size…） │
                                                 └───────────────┬──────────────────────────────────────┘
                                                                 │ SSE /events
                                           ┌─────────────────────▼─────────────────────┐
                                           │ 浏览器 client half (Plugins 行启用时加载) │
                                           │  - 覆盖层 DOM：canvas + 控制条            │
                                           │  - pixi-live2d-display 渲染任意模型        │
                                           │  - 口型=RMS 包络；表情=情绪映射；          │
                                           │    动作=idle/说话手势/内容规则；眨眼/呼吸  │
                                           └───────────────────────────────────────────┘
```

### 2.1 事件协议（shim → host，POST /ingest，JSONL/数组）
`X-Live2D-Token: <token>` 头校验。事件形状（全部 `ts` = 毫秒 epoch）：
- `{type:"speak_request", id, segments:[{emotion, content}], sampleRate, play}`
- `{type:"segment_start", id, index, usedEmotion, requestedEmotion, fallback}`
- `{type:"sentence_end", id, index, sentenceIndex, usedEmotion, language}`
- `{type:"segment_end", id, index, usedEmotion}`
- `{type:"speak_done", id, ok, totalSeconds, cancelled}`
- `{type:"envelope", id, seq, frames:[number]}`
  `frames` 按固定 hop（默认 20ms）的 RMS 0..1 序列；一次 POST 可带多条事件。
  host 收到 envelope 后按到达时间排队，通过 SSE 立即转发给浏览器。

host → 浏览器 SSE 事件形状：`{type:"state", visible, model:{...}, size, position}`、
`{type:"speech_start", ...}`、`{type:"emotion", name, intensity}`、`{type:"envelope", frames:[...]}`、
`{type:"speech_end"}`、`{type:"model_changed", model}`、`{type:"log", text}`。

### 2.2 host HTTP/WS API（端口默认 34567，可用配置改）
- `GET /health` → `{ok, version, plugin:"live2d", ttsBridge: bool}`
- `GET /events`（SSE）→ 上述事件流；连接即先发 `state`。
- `POST /ingest`（shim 专用，token）
- `GET /model` → 当前模型描述 `{id, path, url, scale, visible}`
- `GET /assets/<relpath>` → 模型目录内文件（含 .model3.json/.moc3/纹理/动作/表情/json）；
  必须拒绝目录穿越（realpath 前缀校验），支持 CORS `*`。
- `GET /models` → 模型目录扫描结果（id/name/modelFile/格式）。
- `POST /command` → 浏览器侧命令（`set_size`/`set_position`/`reload`）；返回结果。
- 所有响应带 `Access-Control-Allow-Origin: *`；预检 `OPTIONS` 允许 `content-type`。

### 2.3 配置（bundle patch 行 config，Schemastery 风格校验）
```
enabled: true            # 行开关（Loader 级）
port: 34567              # 本地服务端口
modelsDir: ''            # 模型根目录；空 = 插件自带 models/
defaultModel: ''         # 模型 id；空 = 目录里第一个
visible: false           # 初始是否显示（/live2d on 可开）
scale: 1.0               # 显示缩放
anchor: 'bottom-right'   # bottom-right|bottom-left|top-right|top-left|center
offsetX: 0, offsetY: 0
opacity: 1.0
fps: 30                  # 渲染帧率上限（CPU 友好）
maxWidth: 360, maxHeight: 520   # 画布上限（CSS px）
devicePixelRatioCap: 1   # 限制 GPU 像素填充
idleMotion: true, blink: true, breathe: true, gazeFollow: true
lipSync: true, lipSyncGain: 1.0, lipSyncSmoothing: 0.55
expressionMap: {}        # 情绪名 -> {expression: '...', params:{...}} 覆盖
dataDir: ''              # 状态/日志目录；默认 <repo>/data
```

## 3. 文件所有权（历史）

原项目按 role 并行开发（Lead / tts-bridge / live2d-renderer / plugin-runtime / verifier），各自有写范围约定。打包快照把这些工作合并为一个仓库，不再区分写范围；此处不保留开发期分工表。

## 4. 关键集成事实（已核实，2026-10-18）

1. **插件行**：`cordis.patch.yml` `- insert: [{id, name, config}]`；`name` 从 profile 的
   `node_modules` 解析。bundle 包 `package.json` 的 `dsh.bundle.patch` 指向 patch 文件。
2. **profile 开关**：`~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles` 顺序列表
   决定 bundle 层叠放；插件页「关」= 从列表移除。行开/关 = `cordis.patch.yml` 里
   `- id: <row>; disabled: true`。
3. **patch 语义**：`config` 是**整块替换**，不 merge → 覆盖 `tool-tts` 必须重述完整 config。
4. **客户端插件**：`package.json` `dsh.client = { platform: "web" }`，导出 `./client`；
   产物格式 `window.__ModuleLoader__.load({id, factory:(require)=>{...return exports}})`，
   exports 需含 `apply(ctx)`（cordis 插件），可用 `ctx.effect` 清理、`require("react/jsx-runtime")`
   等基线模块。浏览器端变更由 client HMR（mtime/size revision）热替换。
5. **HMR**：desktop profile（有 profileContext）默认启用 HMR（`root: []`）。改
   `~/.dsh/profiles/desktop/package.json`（bundles 顺序变化）或 `cordis.patch.yml` 会触发
   重组合；被链接包（`link:`）的文件变更在下一次重组合时热替换。**禁止重启桌面应用**（会杀掉本
   Agent 会话）。
6. **TTS 行**（profile 当前值，来自 voice-bundle patch）：
   `pythonPath: <PYTHON>`,
   `voicesDir: <VOICES_DIR>`, `modelDir: <MODELS_DIR>`, `cacheDir: <CACHE_DIR>`,
   `device: cuda:0`, `cfgValue: 2.7`, `inferenceTimesteps: 10`,
   `preload: false`。
   daemon 协议帧：`ready/voices/devices/speak_start/segment_start/sentence_end/segment_end/
   speak_done/error/cancelled`；播放由 `ttslib.runtime.SoundDevicePlayer` 的
   sounddevice OutputStream 回调完成。
7. **网页 origin**：Electron 主进程运行 `runProfile` 起本地 web 服务（随机端口，当前 64177），
   页面是 http origin（带 token 认证），因此 http fetch/SSE/WebSocket 到 127.0.0.1:34567 可行
   （服务端加 CORS 头；桌面主进程不限制 renderer）。
8. **命令**：`inject = ["commands"]`，`commands.register({name, description, handler})`；
   参照已安装 `@deepseek-ai/dsh-tool-tts` 的 `registerTtsCommands`（lib/index.js L1584+）。
   命令在 UI 命令平面执行，不发给模型。
9. **CPU 约定**：包络/RMS/事件全部在 Python+Node 侧 CPU 计算；浏览器只做小画布 WebGL 绘制，
   `fps<=30`、`devicePixelRatioCap<=1`、无滤镜/后处理、纹理不超模型原始尺寸；空闲时无 UI 变化
   不重绘（眼睛/呼吸按 30fps 上限）。

## 5. 修订 v2（2026-10-18 用户新指令）：基于 soullink-emotion-sdk 直接改

用户要求「https://github.com/nanlingyin/soullink-emotion-sdk 考虑直接在上面改」+ 提供测试模型
「DS鲸鱼娘」+ 要求背景完全透明（PNG alpha，只有角色、无有色背景/桌面道具）。因此：

- 渲染/表演底座来自 soullink-emotion-sdk（Apache-2.0），本仓库以子集形式放在 `third_party/soullink-emotion-sdk/`，并新增包
  `packages/dsh-live2d-adapter/`：把 `Live2DRenderer`（PIXI v7 + pixi-live2d-display，
  `backgroundAlpha: 0`）+ `SoullinkRuntime`（VAD/FACS/idle/手势/口型/AudioLevelAnalyzer）包装成
  浏览器端 `createSoullinkStage(...)`，API 与我们的 `createLive2DStage` 对齐。
- 表演数据来源：TTS shim 推送的真实 RMS 包络 → `AudioLevelAnalyzer`（真实音量口型）；
  TTS 情绪名（当前 sound 目录：`默认/亲切/强调/否认`）→ 中文情绪映射表 → engine 预设
  （neutral/affectionate/... 可配置覆盖）；内容/标点 → 说话手势 accent。
- 任意模型适配：`profile-generator`（Node，Host 侧）扫描 `.model3.json`+`.cdi3.json`+
  `*.exp3.json`+`*.motion3.json` 生成 `soullink.profile.json`；Host 在模型目录发现/生成
  profile 并通过 `/assets` 提供；client 优先 soullink 后端，缺失则回退 renderer 的直连实现。
- 透明背景：`backgroundAlpha:0` + 覆盖层无背景 + `hiddenParts` 清单（模型 manifest 里的
  `live2d.manifest.json`，或 adapter 默认清单）每帧 `setPartOpacityById(id,0)`；验收用
  Playwright `omitBackground` + 角像素 alpha 断言 + 棋盘格/页面叠加截图。
- 测试模型：开发期使用过第三方测试模型；本快照**不附带**任何模型二进制（见 `live2d-pet/models/README.md`）。


### 5.1 Host `/model` 描述符冻结契约（client 依赖）
```jsonc
{
  "id": "ds-whale-girl", "name": "DS鲸鱼娘", "format": "cubism4",
  "baseUrl": "http://127.0.0.1:34567/assets/ds-whale-girl/",   // 绝对 URL
  "modelFile": "c_0120.model3.json",
  "modelUrl": "http://127.0.0.1:34567/assets/ds-whale-girl/c_0120.model3.json",
  "expressions": [{"name":"悲伤","file":"悲伤.exp3.json"}],      // 目录扫描，中文名保留
  "motions": [{"name":"idle","file":"motions/idle.motion3.json","group":"motions"}],
  "hiddenParts": ["Part109"],                                    // 来自 live2d.manifest.json
  "profileUrl": "http://127.0.0.1:34567/assets/ds-whale-girl/soullink.profile.json", // 可选
  "scale": 1, "opacity": 1, "anchor": "bottom-right", "offsetX": 0, "offsetY": 0,
  "fps": 30, "maxWidth": 360, "maxHeight": 520, "devicePixelRatioCap": 1,
  "idleMotion": true, "blink": true, "breathe": true, "gazeFollow": true,
  "lipSync": true, "lipSyncGain": 1, "lipSyncSmoothing": 0.55, "expressionMap": {}
}
```
`/assets/*` 已支持中文文件名（URL encode/decode）与目录穿越防护；`/ingest` 需要
`X-Live2D-Token`（默认取自 `<plugin>/data/ingest-token.txt`，首次启动生成）。

### 5.2 TTS shim 接线（bundle patch 里）
`@local/dsh-live2d-bundle` 的 patch 覆盖 `tool-tts` 行（patch 的 `config` 是整块替换，必须重述
当前完整 TTS 配置），把 `daemonScript` 指向
`<plugin>/python/live2d_tts_shim.py`；shim 的旁路配置
`<plugin>/python/live2d_tts_shim.json`：`{ "realDaemon": "<...>/tts_daemon.py",
"ingestUrl": "http://127.0.0.1:34567/ingest", "tokenFile": "<plugin>/data/ingest-token.txt",
"enabledFile": "<plugin>/data/bridge-enabled" }`。**bundle 关闭 = 覆盖消失 = TTS 回到原生
daemon**（无需手工回滚）；行关闭时 Host 不写 `bridge-enabled`，shim 不转发。

