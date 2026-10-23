# 安装与使用（中文）— GHOST

> 本仓库：**GHOST Community Edition** — Live2D 桌宠 + Live2D × TTS 联动桥 + VoxCPM 1.5 语音插件（DeepSeek Harness 插件栈）
> 中文 README（快速说明）：[`../README.md`](../README.md)
> 英文安装文档：[`../docs/INSTALL.md`](../docs/INSTALL.md) · 原始详细中文安装文档：[`../live2d-pet/docs/INSTALL.md`](../live2d-pet/docs/INSTALL.md)
> 适用范围：Windows 10/11 + PowerShell 7 + DeepSeek Harness（DSH，桌面版或 dev 实例）

---

## 0. 这个仓库是什么

三个互相配合的 DSH 插件项目，放在一个仓库里：

| # | 目录 | 项目 | 作用 |
|---|---|---|---|
| ① | `live2d-pet/` | Live2D 桌宠 | DSH bundle + plugin：在透明独立窗口（或 GUI 内覆盖层）渲染任意 Live2D 模型，用 TTS 播放音频的包络/情绪/文本驱动口型、表情和动作 |
| ② | `tts-bridge/` | Live2D × TTS 联动桥 | 独立、可单独开关的 bundle：把 `tool-tts` 行的 `daemonScript` 指向镜像 shim，**tee 真实播放 PCM → ~20ms RMS 包络 + 情绪时间线** 给桌宠 |
| ③ | `voice-plugin/` | 语音插件（VoxCPM 1.5） | 上游 `@deepseek-ai/dsh-tool-tts` 0.1.5-rc.2 的独立产物（Node 插件 + Python VoxCPM 1.5 引擎），保留上游 MIT，供没有该包的 DSH 安装 |

关系：`tts` 工具播放声音 → 联动桥 shim 镜像真实 daemon 并 tee 包络/情绪 → Live2D 桌宠口型跟随。
两个 bundle **互相独立**：关掉桥 = TTS 恢复原生行为；关掉桌宠 = 只剩 TTS。

> **本项目仅包含基础框架，直播同款高阶 TTS 及部分插件暂不包含在开源版中。**

---

## 1. 目前 DSH 的插件安装方式（核心机制）

### 1.1 三层结构

DSH 的插件装配是 **profile 级**的，不改 DSH 本体：

1. **Profile 目录**：桌面版为 `%USERPROFILE%\.dsh\profiles\desktop`（dev 实例为 `$env:DSH_HOME\profiles\web`），核心是里面的 `package.json`：
   - `dependencies`：插件包依赖（本仓库用 `link:<绝对路径>` 指向本地源码）；
   - `dsh.profile.bundles`：**有序的 bundle 列表**，决定加载哪些层、以什么顺序叠加。
2. **Bundle 层**：每个 bundle 包在自己的 `package.json` 里声明 `dsh.bundle.patch` → `cordis.patch.yml`。该 patch 文件是「对 profile 的加载器补丁」：可以 `insert` 新行（如 `live2d` 行）或按 `id` **整行覆盖**已有行（如覆盖 `tool-tts` 行，把 `daemonScript` 指到 shim）。
3. **Plugin 行**：真正的实现包（例如 `@local/dsh-live2d` 是 host 半 + browser 半的插件；`@deepseek-ai/dsh-tool-tts` 是 TTS 工具）。

### 1.2 桌面版 profile 由 Electron 独占

桌面版 DSH 的 profile 由应用进程管理，**`dsh plugin` CLI 会拒绝操作**。因此本项目的安装方式是
**文件级安装**：直接写 profile 的 `package.json` / 建 junction / 写 patch → 触发 HMR **热重组合**，不重启应用、不改 DSH 本体。

### 1.3 安装后 profile 的变化（本仓库的做法）

安装器 `live2d-pet/tools/install.ps1` 只做**文件级**修改，不碰 DSH 本体。可核对的变化：

| 位置 | 变化 |
|---|---|
| `node_modules/@local/dsh-live2d` | junction → 本仓库 `live2d-pet/packages/plugin` |
| `node_modules/@local/dsh-live2d-bundle` | junction → 本仓库 `live2d-pet/packages/bundle` |
| `node_modules/@local/dsh-live2d-tts-bridge` | junction → 本仓库 `tts-bridge/bundle` |
| profile `package.json` → `dependencies` | 三个 `link:<绝对路径>` 依赖 |
| profile `package.json` → `dsh.profile.bundles` | 按序追加两个 bundle（HMR 热重组合生效） |
| `live2d-pet/packages/plugin/python/live2d_tts_shim.json` | shim 旁路配置（真实 daemon 路径、ingest URL/token） |
| 工作区 `tts.config.yml` | `daemonScript` 指向 shim（原文件保留 `*.lead-backup`） |

卸载/回滚用 `live2d-pet/tools/uninstall.ps1`；只关掉「Live2D × TTS 联动桥」bundle 即恢复原生 TTS。

---

## 2. 安装前准备（一次性）

### 2.1 取专有 Live2D Cubism Core（EULA 门槛）

Cubism Core 是 Live2D 专有软件，**不在仓库里**，必须在接受 EULA 后由脚本下载：

```powershell
# 仓库根目录
node scripts/fetch-vendor.mjs --accept-live2d-eula
```

脚本会：校验已提交的 MIT 运行库（pixi / pixi-live2d-display）→ 从官方（Cubism 4）与文档记录来源（Cubism 2）下载 Core → 按 `live2d-pet/packages/plugin/vendor/vendor.lock.json` 里的 SHA-256 校验 → 写入 `live2d-pet/packages/plugin/vendor/`。这些文件被 `.gitignore` 排除，**不要提交**。

### 2.2 构建浏览器 bundle

`lib/index.js`（Host 半）已提交；`lib/client.js` / `lib/window.js` 内联了专有 Core，属于构建产物、不提交。需要 esbuild（装到最近的 `node_modules` 或设置 `ESBUILD_MAIN`）：

```powershell
node scripts/build-all.mjs   # 校验 vendor + 构建 client/window + 静态检查
```

### 2.3 独立窗口运行环境（一次性，可选但推荐）

```powershell
cd live2d-pet/tools/live2d-window
npm install            # 安装 package.json 固定的 Electron（约 250MB，不进仓库）
```

不装也能用：插件会自动回退到 GUI 内“页面覆盖层”模式。
（`$env:LIVE2D_WINDOW_GPU='1'` 可启用硬件加速，默认软件 WebGL。）

---

## 3. 安装到桌面版 DSH（正式安装）

### 3.1 一条命令

```powershell
cd live2d-pet
.\tools\install.ps1 -ProfileDir "$env:USERPROFILE\.dsh\profiles\desktop" `
    -PythonPath '<PYTHON>' -VoicesDir '<VOICES_DIR>' `
       -ModelDir '<MODELS_DIR>' -CacheDir '<CACHE_DIR>'
```

参数说明：

| 参数 | 说明 |
|---|---|
| `-ProfileDir` | profile 目录（含 `package.json`）；不传时用 `$env:DSH_HOME/profiles/web` |
| `-RepoRoot` | `live2d-pet/` 目录；默认脚本上一级 |
| `-PythonPath` | TTS python 解释器，渲染进 bridge patch 的 `<PYTHON>` 占位符 |
| `-VoicesDir` | 单一参考音色目录（一个 `<名称>.wav` + 同名 `<名称>.txt`），渲染进 `<VOICES_DIR>` |
| `-ModelDir` | VoxCPM 1.5 模型目录，渲染进 `<MODELS_DIR>` |
| `-CacheDir` | daemon 缓存目录（转写缓存/默认 WAV 输出），渲染进 `<CACHE_DIR>` |
| `-NoVerify` | 跳过安装后的模块解析检查 |

### 3.2 install.ps1 实际做了什么（幂等，可重复执行）

1. 建立/刷新 profile 下的 3 个 junction：
   - `node_modules/@local/dsh-live2d-bundle` → `live2d-pet/packages/bundle`
   - `node_modules/@local/dsh-live2d` → `live2d-pet/packages/plugin`
   - `node_modules/@local/dsh-live2d-tts-bridge` → `tts-bridge/bundle`（仓库根下的兄弟目录）
2. 修改 profile `package.json`：加 3 个 `link:<绝对路径>` 依赖；把两个 bundle 追加进 `dsh.profile.bundles`（首次备份为 `package.json.lead-backup`）。
3. 渲染 bundle patch 里的占位符：`<PLUGIN_DIR>`（自动）、`<PYTHON>`、`<VOICES_DIR>`。
4. 写 shim 旁路配置 `live2d-pet/packages/plugin/python/live2d_tts_shim.json`：真实 daemon 路径（从 profile/全局 npm 自动探测）、`ingestUrl`、token、`enabledFile`、包络参数。
5. 扫描 `Documents\*\tts.config.yml`，把其中的 `daemonScript` 指向 shim（原文件保留 `*.lead-backup`）—— 因为工作区 `tts.config.yml` 的显式覆盖优先级高于 bridge 行配置。
6. 用 Node 从 profile 验证三个包能否 `require.resolve`，失败即报错退出。

### 3.3 生效方式（无需重启应用）

- profile 的 `dsh.profile.bundles` 顺序变化会触发桌面版 **HMR 热重组合**；
- 侧栏「插件」页出现两个独立开关：**Live2D 桌宠** 与 **Live2D × TTS 联动桥**；
- 默认 `mode: window` 会打开独立透明窗口；也可 `/live2d overlay on` 改用 GUI 内覆盖层；
- 下一次 `tts` 调用时，TTS 行会用新 `daemonScript` 重启 daemon（`autoReloadEngine` 默认开启）。
- 若 HMR 没有重组合：重启一次桌面版 DSH（会结束当前会话进程，先保存工作）。

---

## 4. 开发实例（推荐先验证）

不碰桌面 profile，用独立的 `DSH_HOME` 起一个 dev 实例（默认端口 3097）：

```powershell
cd live2d-pet
$env:DSH_HOME = '<例如 <用户目录>\.live2d-home>'
.\tools\dev-start.ps1 -Restart      # 打印 http://127.0.0.1:3097/?token=...
.\tools\install.ps1 -PythonPath '<PYTHON>' -VoicesDir '<VOICES_DIR>'   # 自动装到 $DSH_HOME/profiles/web
```

---

## 5. 语音插件（可选）

只有在目标 DSH **没有**自带 `@deepseek-ai/dsh-tool-tts` 时才需要安装 `voice-plugin/` 快照。
它属于**独立产物安装**（不是 profile bundle），步骤见 [`../voice-plugin/INSTALL.md`](../voice-plugin/INSTALL.md)；
安装后需在 `tool-tts` 行（或工作区 `tts.config.yml`）配置 `pythonPath`、`voicesDir`、`modelDir`、`cacheDir`（VoxCPM 1.5）。

Python 引擎依赖：

```powershell
<PYTHON> -m pip install -r voice-plugin/python/requirements.txt
```

模型权重/音色不入库，需自备（VoxCPM 1.5 权重与参考音频；`modelDir` 指向含 weights/config/tokenizer 的 VoxCPM1.5 目录）。

> 如果你的 DSH 安装已经自带 `@deepseek-ai/dsh-tool-tts`（通常由 voice bundle 提供），就不需要再装该快照。

---

## 6. 验证安装

```powershell
# 1) 静态检查（仓库根目录）
node --check live2d-pet/packages/plugin/lib/index.js
node --check live2d-pet/packages/plugin/build-client.mjs
python -m py_compile live2d-pet/packages/plugin/python/live2d_tts_shim.py

# 2) 只读安装核对（打印插件页开关位置）
cd live2d-pet
.\tools\verify-install.ps1 -ProfileDir "$env:USERPROFILE\.dsh\profiles\desktop"
# 期望结尾：RESULT: OK — both Live2D bundles are installed in this profile.

# 3) 应用运行中的 host 自检
Invoke-RestMethod http://127.0.0.1:34567/health

# 4) 真实联动：用 tts 工具说一句话 → 模型口型/表情跟随
#    命令行里应能看到 ...\live2d_tts_shim.py；GUI 里 /live2d status 可看桥接状态
```

---

## 7. 升级 / 改代码后刷新

| 改动 | 生效方式 |
|---|---|
| `lib/client.js`（浏览器半） | 重新 `node scripts/build-all.mjs` → client HMR 按文件 revision 热替换 |
| `lib/index.js`（Host 半） | 重跑 `install.ps1` 触发重组合（或插件页关一次再开该 bundle） |
| Python shim | 下次 TTS 调用随 daemon 重启生效 |
| 模型目录 | `/live2d reload` |
| 整个 bundle 的启用/禁用 | 侧栏「插件」页开关；或从 `dsh.profile.bundles` 移除后重组合 |

---

## 8. 卸载 / 回滚

```powershell
cd live2d-pet
.\tools\uninstall.ps1 -ProfileDir "$env:USERPROFILE\.dsh\profiles\desktop"
```

- 从 `dsh.profile.bundles` 移除两个 bundle → 下次重组合后 TTS 回到原生 voice-bundle 配置、窗口/覆盖层消失；
- 删除 `node_modules/@local/*` 三个 junction（可选 `-RemoveDependencies` 同时删依赖、`-RestoreBackup` 恢复安装前 `package.json`）；
- 恢复被 `install.ps1` 改过的 `tts.config.yml`（`*.lead-backup`）。

> 只关「Live2D 桌宠」bundle：TTS 行仍指向 shim，但 shim 在 enabled 标记缺失时不做任何事，TTS 行为不变；
> 要彻底回到原生 TTS，请关「Live2D × TTS 联动桥」bundle。

---

## 9. 已知边界与排错

- **TTS 有声但嘴不动**：运行中的 python 命令行是否含 `live2d_tts_shim.py`？没有的话是工作区 `tts.config.yml` 的 `daemonScript` 覆盖了 bridge 行（重跑 `install.ps1`，或运行 `tools/bridge-daemon-wrapper.ps1`）。
- **端口冲突**：默认 `34567`；改 `live2d-pet/packages/bundle/cordis.patch.yml` 的 `port` 后重新安装/重组合。
- **窗口缺失**：`/live2d window status`；日志在插件 `data/` 目录；软件 WebGL 异常时试 `LIVE2D_WINDOW_GPU=1`。
- **只允许一个角色窗口**：Electron 单实例锁 + `data/live2d-window.lock`；重复启动会退出；`/live2d window dedupe` 可清理。
- **模型/音色**：仓库不附带，自备并确认授权（`live2d-pet/models/README.md`）。
- **Cubism Core**：专有软件，不可提交/再分发；商用发布前自行确认 Live2D Cubism SDK Release License。

---

## 10. 本仓库里已有的安装文档（对照）

| 文档 | 语言 | 内容 |
|---|---|---|
| `README.en.md` §Quick start | 英 | 5 步快速开始（fetch vendor → build → install → voice 可选 → 使用） |
| `docs/INSTALL.md` | 英 | 打包版完整安装（占位符约定、前置、构建、安装、语音、验证、卸载、排错） |
| `live2d-pet/docs/INSTALL.md` | **中** | 原始中文安装/升级/回滚（最细节，含 HMR 与边界情况） |
| `voice-plugin/INSTALL.md` | 英 | 语音插件快照的独立安装 |
| **本文 `docs/INSTALL.zh-CN.md`** | **中** | GHOST 仓库视角的机制说明 + 完整安装流程 |
| `live2d-pet/docs/README.md` | 中 | `/live2d` 命令与配置参考 |
| `tts-bridge/docs/TTS-BRIDGE.md` | 中 | shim 协议、延迟对齐、验收与排错 |
