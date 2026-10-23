[English](README.en.md)

# GHOST — 社区版

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Community Edition](https://img.shields.io/badge/edition-Community-5B8DEF)
![Platform: Windows 10/11](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D6)
![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

**本地、实时的 Live2D 数字人，运行在 DeepSeek Harness（DSH）上——口型由你真正听到的 VoxCPM 1.5 语音驱动。**

这是 GHOST 的**社区版**：本地优先、Apache-2.0 的源码快照。一次使用一个参考音色；请自备有授权的 Live2D 模型、VoxCPM 1.5 权重，以及一个参考音色片段和它的转写文本。

> 收到 **B站直播官方邀请**：参与新分区「AI 应用-机器人」试播 —— [查看实测数据](#官方认可与实测数据)。

[高光](#高光) · [官方认可与实测数据](#官方认可与实测数据) · [功能](#功能) · [快速开始](#快速开始) · [文档](#文档)

## 高光

| 亮点 | 带来的能力 |
| --- | --- |
| **真实 PCM 驱动口型** | 嘴型跟随**实际播放**音频的 RMS 包络，并按实测输出延迟对齐——不是按文本长度猜，也不是固定动画。 |
| **完全本地** | VoxCPM 1.5 TTS 与 Live2D 渲染都在本机运行：无云端 TTS、无账号、无遥测。 |
| **情绪驱动 Live2D** | 情绪标签驱动表情混合、待机动作、呼吸和说话手势。 |
| **模块化 DSH bundles** | 桌宠与 TTS 联动桥可独立开关；关掉桥即恢复原生 TTS。 |

## 官方认可与实测数据

[![B站直播官方邀请](https://img.shields.io/badge/Bilibili%20Live-official%20invitation-00A1D6)](https://space.bilibili.com/3494377131346746)
[![试播数据](https://img.shields.io/badge/test%20broadcast-473K%20viewers-00A1D6)](https://space.bilibili.com/3494377131346746)
[![粉丝数据](https://img.shields.io/badge/net%20followers-%2B928%20%C2%B7%20top%201%25-ff69b4)](https://space.bilibili.com/3494377131346746)

**收到 B站直播官方邀请。** 2026 年 10 月，B站直播团队邀请 GHOST 维护者以 AI 虚拟主播形式，参与新上线的 **「AI 应用-机器人」** 分区试播。

**首次公开试播**（B站创作者后台，截至 2026-10-21 的 7 日统计窗口）：

| 指标 | 数据 |
| --- | --- |
| 单场累计观众 | **47.3 万+** |
| 净增粉丝 | **+928** |
| 新增粉丝 vs 同水平主播 | **前 1%** —— 新增 1,255 人，超过 99% 同水平主播 |
| 统计周期内开播时长 | **14.2 小时** |

*以上为创作者后台自报数据，来自一次试播及 7 日统计窗口；用于展示真实使用情况，不构成性能承诺或结果保证。未包含账号、房间或联系方式。*

## 版本范围

本社区版包含且仅包含三个组件：Live2D 桌宠（`live2d-pet/`）、TTS 联动桥（`tts-bridge/`）与 VoxCPM 1.5 语音插件快照（`voice-plugin/`）。

> **本项目仅包含基础框架，直播同款高阶 TTS 及部分插件暂不包含在开源版中。**

| # | 目录 | 项目 | 作用 |
| --- | --- | --- | --- |
| 1 | [`live2d-pet/`](live2d-pet/) | Live2D 桌宠 | DSH bundle + plugin：在透明窗口或 GUI 覆盖层渲染 Live2D 模型，用 TTS 播放包络/情绪/文本驱动口型与表情 |
| 2 | [`tts-bridge/`](tts-bridge/) | TTS 联动桥 | 独立可开关的 DSH bundle：把 `tool-tts` 行的 `daemonScript` 指向镜像 shim，tee 真实播放 PCM 包络与情绪时间线给桌宠 |
| 3 | [`voice-plugin/`](voice-plugin/) | 语音插件（VoxCPM 1.5） | 独立产物快照：Node 插件 + Python VoxCPM 1.5 引擎，保留上游 MIT 许可 |

## 💼 授权与商用说明

> **个人使用完全免费。** 商业版本/商业功能请联系作者授权；CE 不具有的功能见下表。
>
> **如有发现一模一样的套壳售卖程序，皆为盗版，请及时止损。**

| 对比项 | 开源版（CE） | 商业版 |
| --- | --- | --- |
| 个人使用 | ✅ 完全免费 | 按商业授权协议 |
| 商业版功能 | ❌ 不包含 | ✅ 包含 |
| 直播同款高阶 TTS | ❌ 不包含 | ✅ 包含 |
| 部分进阶插件 | ❌ 不包含 | ✅ 包含 |
| 商业使用授权 | CE 代码按 Apache-2.0 使用 | ✅ 需联系作者获取商业授权 |
| 技术支持 | 社区 Issue / 文档 | 作者支持 |
| 定制与部署 | 自助 | 可协商 |
| 更新节奏 | 跟随开源发布 | 商业版同步更新 |

> 说明：本开源仓库（CE）的代码按 **Apache-2.0** 授权；上表「商业版」指作者提供的独立商业发行版、进阶功能与商业支持服务，不等同于对 CE 源码的额外限制。需要商业版功能或商业支持时，请通过作者授权渠道获取。

## 三个组件如何协作

```
 DSH agent 调用 `tts` 工具
        │
        ▼
 @deepseek-ai/dsh-tool-tts  (voice-plugin/)       ← Node 插件 + Python VoxCPM 1.5 引擎
        │  daemonScript 被联动桥覆盖
        ▼
 live2d_tts_shim.py  (live2d-pet/packages/plugin/python/)
        │  · 进程内原样运行真实 tts_daemon.py（byte-for-byte relay）
        │  · tee 真实播放 PCM → ~20ms RMS 包络
        │  · tee 情绪/句子时间线/输出延迟
        ▼  HTTP POST 127.0.0.1:34567/ingest（仅回环，非机密 token）
 Live2D host 半（Node）
        │  SSE /events
        ▼
 Live2D browser 半（pixi.js + pixi-live2d-display + Soullink adapter）
        ├─ 独立透明 Electron 窗口
        └─ GUI 内覆盖层
```

两个 DSH bundle 互相独立：关掉桌宠 = 只剩 TTS；关掉联动桥 = TTS 回到原生 daemon。桌宠单独仍可待机动画、切换模型和执行 `/live2d` 命令。

## 功能

### Live2D（`live2d-pet/`）

- 渲染任意**有合法授权**的 Live2D Cubism 4 模型：透明常驻桌面窗口，或 GUI 内覆盖层。
- 口型由实际送入声卡的 PCM 的 ~20ms RMS 包络驱动，并应用实测输出延迟，使嘴型与听到的声音对齐。
- 情绪标签 → 原生 exp3 + VAD 混合表情；另有待机动作、呼吸、说话手势。
- `/live2d` 命令覆盖状态、开关、模型切换、窗口管理与重载；host 仅监听回环、校验模型资产路径、对停止消费的 SSE 客户端做背压保护。

### TTS（`voice-plugin/` + `tts-bridge/`）

- `tts` 工具通过本地 VoxCPM 1.5 daemon 发声：无云端调用、无账号。
- 一次安装一个参考音色（音频 + 转写文本）；情绪名只是事件流标签，不切换音色。
- 逐句流式生成与播放；工具在播放结束前返回，并给出帧流水账（`early`、`remainingMs`、帧数），让 agent 在播放时继续工作。
- 支持取消、卸载、daemon 缓存；修改配置后下一次调用生效，无需重启应用。
- 开启联动桥时 shim 原样代理真实 daemon 并 tee 包络/情绪/延迟；关闭后恢复原生 TTS。

## 环境要求

- **Windows 10/11** + PowerShell 7（`pwsh`）；安装器与窗口启动器是 Windows 优先，插件代码本身可移植。
- **Node.js ≥ 20**（含 `npm`/`npx`），并且 **esbuild** 可解析（安装在 `live2d-pet/packages/plugin` 上层的 `node_modules`，或设置 `ESBUILD_MAIN`）。
- **Python 3.10+** 运行 TTS 引擎；推荐 CUDA GPU（VoxCPM 1.5 在 CUDA 上运行）。语音克隆需要一个参考音色片段 + 同名转写文本。
- **DeepSeek Harness** 桌面版或 dev 实例（`DSH_HOME`），因为这些是 DSH profile bundle / 插件行。
- 自备**有授权的 Live2D Cubism 4 模型**、**VoxCPM 1.5 权重**、**参考音色**（一个音频片段 + 转写文本）；仓库不附带。
- 独立窗口额外需要：在 `live2d-pet/tools/live2d-window` 里 `npm install`（下载 Electron，约 250MB，不入库）。

## 快速开始

```powershell
# 1) 一次性获取专有运行时（请先阅读 Live2D EULA）
node scripts/fetch-vendor.mjs --accept-live2d-eula

# 2) 构建浏览器端 bundle（会内联专有 Core；不入库）
node scripts/build-all.mjs

# 3) 安装桌宠 + 联动桥到 DSH profile
./live2d-pet/tools/install.ps1 `
    -ProfileDir '<DSH_PROFILE>' `
    -PythonPath '<PYTHON>' `
    -VoicesDir '<VOICES_DIR>' `
    -ModelDir '<MODELS_DIR>' `
    -CacheDir '<CACHE_DIR>'

# 4) 检查安装
./live2d-pet/tools/verify-install.ps1 -ProfileDir '<DSH_PROFILE>'
# 期望：RESULT: OK — both Live2D bundles are installed in this profile.
```

安装器会在 profile 中创建 `node_modules/@local/...` junction、把两个 bundle 追加到 `dsh.profile.bundles`、渲染桥 patch 的占位符（`<PLUGIN_DIR>`、`<PYTHON>`、`<VOICES_DIR>`、`<MODELS_DIR>`、`<CACHE_DIR>`）、写入 TTS shim 旁路配置，并把工作区 `tts.config.yml` 指向 shim。运行中的桌面 profile 通过 HMR 重组合；若没有生效再重启应用。

然后用 `tts` 工具说一句话，角色嘴型会跟随音频。`/live2d status`、`/live2d on|off`、`/live2d model <id>`、`/live2d window <...>` 可在 GUI 命令面板使用。

更详细的中文安装流程见 [`docs/INSTALL.zh-CN.md`](docs/INSTALL.zh-CN.md)。

## 仓库结构

```
README.md  README.en.md  LICENSE  NOTICE  SUPPORT.md  CONTRIBUTING.md
CODE_OF_CONDUCT.md  SECURITY.md  CHANGELOG.md  .gitignore  .editorconfig
.github/                CI workflow + issue/PR templates
docs/
  ARCHITECTURE.md      组件、协议、数据流
  INSTALL.md           构建 + 安装 + 验证 + 卸载（英文）
  INSTALL.zh-CN.md     中文安装指南（机制 + 完整流程）
  LICENSING.md         各产物许可边界
  RELEASING.md         发布流程
live2d-pet/            Live2D 桌宠（bundle + plugin + Electron 窗口 + 测试）
tts-bridge/            TTS 联动桥（bundle + shim 文档）
voice-plugin/          VoxCPM 1.5 TTS 插件快照（Node 插件 + Python 引擎 + 测试）
third_party/soullink-emotion-sdk/   Apache-2.0 子集（渲染适配器）
scripts/               fetch-vendor.mjs（EULA 门槛 + SHA-256）、build-all.mjs
```

## 不包含的内容

- **Live2D 模型与贴图**（`*.moc3`、`*.model3.json`、贴图 PNG）：放入 `live2d-pet/models/`（先确认授权）。
- **Live2D Cubism Core**（`live2dcubismcore.min.js`、旧版 `live2d.min.js`）：专有软件，由 `scripts/fetch-vendor.mjs` 在 EULA 门槛后下载，已被 `.gitignore` 排除。
- **VoxCPM 1.5 权重与参考音色**：用户自备；`modelDir` / `voicesDir` 指向它们（音色目录里是一份 `<name>.wav` + 同名 `<name>.txt`）。
- **预构建浏览器 bundle**（`lib/client.js`、`lib/window.js`）：构建产物，不入库。
- `node_modules/`、`data/`、日志、截图、本地证据文件、测试缓存、`user-models/`。

## 许可证

- **本栈**（根目录、`live2d-pet/`、`tts-bridge/`、`docs/`、`scripts/`）：Apache-2.0，见 [`LICENSE`](LICENSE) 与 [`NOTICE`](NOTICE)。
- `voice-plugin/`：上游 `@deepseek-ai/dsh-tool-tts` 0.1.5-rc.2 快照，保留上游 **MIT**，不改为 Apache-2.0。
- `third_party/soullink-emotion-sdk/`：Apache-2.0；pixi.js / pixi-live2d-display：MIT。
- **Live2D Cubism Core**：Live2D Inc. 专有软件，不在仓库中；使用/分发前请阅读 Live2D Proprietary Software License Agreement，商用发布可能还需 Cubism SDK Release License。
- Live2D 模型、参考音色、VoxCPM 权重分别归其所有者，仓库不附带也不授予相关权利。

完整边界见 [`docs/LICENSING.md`](docs/LICENSING.md)。

## 文档

- [`README.en.md`](README.en.md) — English README。
- [`docs/INSTALL.zh-CN.md`](docs/INSTALL.zh-CN.md) — 中文安装指南（DSH 插件机制 + 完整安装/验证/卸载）。
- [`docs/INSTALL.md`](docs/INSTALL.md) — 英文安装文档。
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 组件、协议、数据流、信任边界。
- [`docs/LICENSING.md`](docs/LICENSING.md) — 许可边界。
- [`docs/RELEASING.md`](docs/RELEASING.md) — 发布流程。
- [`live2d-pet/docs/README.md`](live2d-pet/docs/README.md) — `/live2d` 命令与配置参考（中文）。
- [`tts-bridge/docs/TTS-BRIDGE.md`](tts-bridge/docs/TTS-BRIDGE.md) — shim 协议、延迟对齐、验收说明（中文）。
- [`voice-plugin/README.md`](voice-plugin/README.md) — VoxCPM 1.5 TTS 插件参考。
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — 贡献指南。
- [`SECURITY.md`](SECURITY.md) — 安全模型与私密漏洞报告。
- [`SUPPORT.md`](SUPPORT.md) — 提问渠道与支持范围。
- [`CHANGELOG.md`](CHANGELOG.md) — 变更历史。

## 状态

早期阶段、单人维护的**社区版**快照。Windows 为已测试平台；Linux/macOS 未测试。DSH 插件 API 与 VoxCPM 集成仍可能演进，不做日期或兼容性承诺。
