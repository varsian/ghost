# INSTALL — 安装 / 升级 / 回滚

本插件以 **profile bundle + plugin 行** 的形式安装到 DSH 的 profile 目录，不修改 DSH 本体、
不修改 `@deepseek-ai/dsh-tool-tts` 包内文件。TTS 集成通过**独立 bundle**
`@local/dsh-live2d-tts-bridge` 覆盖 `tool-tts` 行的 `daemonScript` 实现；关掉该 bundle
即自动恢复原生 TTS，桌宠 bundle 仍可独立工作。

> 本仓库是打包后的源码快照：**不包含**模型、专有 Live2D Cubism Core、预构建的
> `lib/client.js` / `lib/window.js`。安装前必须完成 §1 的 vendor 准备与构建。

## 0. 目录

```
live2d-pet/                            ← 本目录（安装器把它当作 RepoRoot）
  packages/bundle/                     @local/dsh-live2d-bundle（桌宠本体：窗口/覆盖层/命令）
  packages/plugin/                     @local/dsh-live2d（Host + Browser 源码 + shim + vendor 占位）
  tools/live2d-window/                 独立透明窗口（Electron 启动器；需 npm install）
  tools/install.ps1                    安装/刷新（幂等；junction + link: 依赖 + bundles 选择 + shim 旁路配置）
  tools/verify-install.ps1             只读核对：profile manifest / junction / bundle patch / host / 窗口
  tools/uninstall.ps1                  卸载/回滚
  tools/bridge-daemon-wrapper.ps1      不重组合也要立即生效的 TTS daemon 兜底包装
  tools/dev-start.ps1                  启动/重启开发实例（默认 3097）
  tests/                               协议/包络/背压/窗口单例测试（无 Playwright 截图）
  docs/                                本文档、README、RENDERER、INCIDENTS、DESIGN
  models/README.md                     模型说明（模型二进制不入库）
tts-bridge/bundle/                     @local/dsh-live2d-tts-bridge（安装器从 ../tts-bridge/bundle 链接）
```

安装器会自动把 `live2d-pet/` 作为插件根、把仓库根下的 `tts-bridge/bundle/` 作为 bridge
包，都不需要手工改路径。

## 1. 一次性准备：vendor + 构建（必须）

### 1.1 取专有 Live2D Cubism Core（EULA gate）

```powershell
# 仓库根目录执行；先阅读 Live2D 许可，确认你有权使用后再加 --accept-live2d-eula
node scripts/fetch-vendor.mjs --accept-live2d-eula
```

脚本用 `live2d-pet/packages/plugin/vendor/vendor.lock.json` 校验已提交的
`pixi.min.js` / `pixi-live2d-display.min.js`，然后从官方/文档记录的来源下载
Cubism 4 Core 和（供 Cubism 2 模型使用的）Cubism 2 Core，按 SHA-256 校验后写入
`packages/plugin/vendor/`。这些 Core 文件是专有软件、被 `.gitignore` 排除，**不要提交**。

### 1.2 构建浏览器 bundle

`lib/index.js`（Host 半）已随仓库提交；`lib/client.js` / `lib/window.js` 内联了专有
Core，属于构建产物、不提交。需要 esbuild（装到 `node_modules` 或设置 `ESBUILD_MAIN`）：

```powershell
node scripts/build-all.mjs        # 校验 vendor + 构建 client/window + 静态检查
```

### 1.3 独立窗口运行环境（一次性）

```powershell
cd live2d-pet/tools/live2d-window
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'   # 可选，加速镜像
npm install            # package.json 固定 Electron 28.3.3（~250MB）
```

启动器默认使用 `--no-sandbox --disable-gpu --in-process-gpu --user-data-dir=<live2d-pet>/data/electron-userdata`
+ 软件 WebGL；需要硬件加速时设 `$env:LIVE2D_WINDOW_GPU='1'`。`node_modules` 不进交付物，
缺失时插件自动回退到页面覆盖层。

## 2. 开发实例（推荐先验证）

```powershell
cd live2d-pet
$env:DSH_HOME = '<DSH_HOME>'                 # 例如 <任意目录>/.live2d-home
.\tools\dev-start.ps1 -Restart               # 打印 http://127.0.0.1:3097/?token=...
.\tools\install.ps1 -PythonPath '<PYTHON>' -VoicesDir '<VOICES_DIR>'
```

dev 实例与桌面实例互不影响；dev 使用全局安装的 `dsh` 作为安装 anchor 解析 core 包。

## 3. 桌面实例（正式安装）

桌面版 DSH 的 profile 位于 `<DSH_PROFILE>`（通常 `%USERPROFILE%\.dsh\profiles\desktop`），
由 Electron 进程独占管理（`dsh plugin` CLI 会拒绝操作）。安装步骤：

1. 确认桌面版正在运行（GUI 端口形如 `http://127.0.0.1:<port>/?token=...`）。
2. 执行（`<PYTHON>`、`<VOICES_DIR>` 会被渲染进 `tts-bridge/bundle/cordis.patch.yml`；
   不传也可以，脚本会警告并留下占位符供手工编辑）：

   ```powershell
   cd live2d-pet
   .\tools\install.ps1 -ProfileDir '<DSH_PROFILE>' `
       -PythonPath '<PYTHON>' -VoicesDir '<VOICES_DIR>'
   ```

   脚本只写文件（profile `package.json` 备份为 `package.json.lead-backup`）：
   - `node_modules/@local/dsh-live2d-bundle` → `live2d-pet/packages/bundle`
   - `node_modules/@local/dsh-live2d-tts-bridge` → `tts-bridge/bundle`
   - `node_modules/@local/dsh-live2d` → `live2d-pet/packages/plugin`
   - profile `package.json`：三个 `link:` 依赖 + `dsh.profile.bundles` 追加两个 bundle
   - `packages/plugin/python/live2d_tts_shim.json` 旁路配置（真实 daemon 路径、ingest URL/token）
   - 工作区 `tts.config.yml` 的 `daemonScript` → shim（保留 `*.lead-backup`）
3. 桌面 profile 的 HMR 会在 `package.json` 的 bundles 顺序变化时**热重组合**：
   - 侧栏「插件」页出现两个**互相独立**的条目：
     **Live2D 桌宠**（含 `live2d` 行开关）与 **Live2D × TTS 联动桥**（含 `tool-tts` 行）；
   - `mode: window`（默认）下，重组合后自动打开独立透明窗口；
   - TTS 行会在下一次 `tts` 调用时用新 `daemonScript` 重启 daemon（`autoReloadEngine` 默认开启）。
4. 验收：`/live2d status` 显示窗口与 TTS 桥接状态；用 `tts` 工具说一句话 → 窗口里的模型
   口型/表情跟随；`/live2d window size 500 700`、`/live2d window move 960 240` 可调窗口。
5. 随时用只读脚本核对安装是否落地（会打印插件页开关的位置）：

   ```powershell
   .\tools\verify-install.ps1 -ProfileDir '<DSH_PROFILE>'
   ```

   期望结尾 `RESULT: OK — both Live2D bundles are installed in this profile.`

> 若 HMR 没有出现新 bundle：在「设置 → 插件」查看行状态/错误；必要时重启桌面版 DSH
> （会结束当前会话进程，请在保存工作后进行）。

## 4. 升级 / 改代码后刷新

- 修改插件源码后，在桌面 profile 里触发一次重组合即可：重跑 `tools/install.ps1`
  （文件未变但 bundles 列表不变时不会重组合——可 `-Force` 触碰 profile patch，或在插件页把
  该 bundle 关一次再开）。
- **Browser 半（`lib/client.js`）变化**：重新 `node scripts/build-all.mjs` 后，由 client HMR
  按文件 revision 热替换；
- **Host 半（`lib/index.js`）变化**在重组合时热替换；
- **Python shim 变化**在下次 TTS 调用时随 daemon 重启生效（`autoReloadEngine`）；
- 模型目录变化用 `/lived reload`（`/live2d reload`）即可。

## 5. 卸载 / 回滚（一键）

```powershell
.\tools\uninstall.ps1 -ProfileDir '<DSH_PROFILE>'
```

脚本会：
1. 从 `dsh.profile.bundles` 移除 `@local/dsh-live2d-bundle` 与 `@local/dsh-live2d-tts-bridge`
   → 下次重组合后 **TTS 行回落到原始 voice-bundle 配置**（daemonScript 恢复默认），
   独立窗口关闭、模型覆盖层消失；
2. 删除 profile `node_modules/@local/{dsh-live2d,dsh-live2d-bundle,dsh-live2d-tts-bridge}`
   junction（可选 `-RemoveDependencies` 同步移除 dependencies，`-RestoreBackup` 恢复
   `package.json.lead-backup`）；
3. 恢复 `install.ps1` 改过的工作区 `tts.config.yml`（备份 `*.lead-backup`）。

> 只关掉「live2d 行」而不关 bundle：模型窗口关闭/不接收事件，但 TTS 行仍指向 shim
> （shim 在 enabled 标记缺失时不做任何事，TTS 行为不变）。要彻底回到原生 TTS，请关掉
> **Live2D × TTS 联动桥** bundle；桌宠 bundle 可继续独立使用。

## 6. 已知边界 / 使用提示

- **安装/重组合的时机**：桌面版在 profile 文件变化时会 HMR 重组合。若某次重组合没有发生
  （新包尚未被 pnpm 记录、模块缓存异常），重启桌面版一次即可；已运行会话的插件代码
  不一定热替换。
- **独立窗口**：按住任意位置拖动；右下角常显斜纹手柄拖动调整大小；右上角悬停出现 × 关闭；
  `Esc` 关闭；托盘图标提供“显示/隐藏/重载/关闭”。窗口**像普通程序一样有任务栏图标、可最小化恢复**；
  默认**不置顶**，需要时 `/live2d window top on`。位置/大小自动记忆。
- **只允许一个角色窗口**：Electron `requestSingleInstanceLock` + `<plugin>/data/live2d-window.lock`
  + launcher `launch.lock`；重复启动会记 `duplicate-instance` 并退出。`/live2d window dedupe` 可清理。
- **TTS 桥不生效时**（`tts` 有声但模型不跟嘴）：先检查运行中的 python 命令行是否含
  `live2d_tts_shim.py`；若没有，说明工作区 `tts.config.yml` 的 `daemonScript` 覆盖了 bridge 行配置
  （重跑 `install.ps1` 或运行 `tools/bridge-daemon-wrapper.ps1` 可修；详见
  `tts-bridge/docs/TTS-BRIDGE.md` §2.2）。
- 端口 `34567` 被占用时 Host 启动会失败（日志 `[live2d] cannot start the local server`），
  改 bundle patch 的 `port` 并重新安装/重组合。
- Live2D Cubism Core 为 Live2D Inc. 专有运行时，分发/商用前请确认其许可；仓库不提交该文件。
- 模型/参考音频：仓库不附带，需自备并确认授权（见 `live2d-pet/models/README.md`）。
