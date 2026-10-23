# TTS 播放桥（`live2d_tts_shim.py`）— 设计 / 协议 / 验收

状态：**T2+T8 完成**，fake/real 测试通过（2026-10-18）。本文档是 shim 的唯一事实来源：
安装方式、旁路配置、事件协议（含 `latencyMs` 口型对齐）、实测证据、回滚与已知限制。

写范围：`packages/plugin/python/live2d_tts_shim.py`、`python/live2d_tts_shim.json.example`、
`tests/test_shim.py`、`tests/test_shim_bridge.mjs`、`docs/TTS-BRIDGE.md`。
**不修改** `@deepseek-ai/dsh-tool-tts` 包内任何文件。

---

## 1. 为什么需要 shim

TTS 插件的 Python daemon（VoxCPM 1.5）直接调用 sounddevice 把音频写到扬声器，host 只看到
JSONL 协议帧，拿不到“真实播放的声音”。Live2D 口型需要：

1. **真实播放的 PCM 包络**（按 ~20 ms 的 RMS，0..1）；
2. **逐段情绪/时间线**（`speak_request`/`speak_start`/`segment_start`/`sentence_end`/`segment_end`/`speak_done`）；
3. **输出延迟 `latencyMs`**：音频交给设备后还要多久才可听，用于把包络消费推迟到可听时刻，消除嘴型滞后。

方案：Live2D 插件自带一个 Python shim，把它配置成 TTS 的 `daemonScript`。host 以
`pythonPath <daemonScript> --voices-dir … --model-dir …` 方式 spawn 它，因此 shim 必须与真实
daemon **在 stdin/stdout/退出码/信号行为上完全一致**，只额外 tee 事件。

```
 host (Node, dsh)                         shim 进程（= 真实 daemon 同进程）
 ┌───────────────────┐   spawn + args    ┌──────────────────────────────────────────┐
 │ DaemonClient       │──────────────────►│ live2d_tts_shim.py                        │
 │ stdin JSONL 请求   │──────────────────►│  ├── tee os.read(fd0)  → speak_request     │
 │ stdout JSONL 帧    │◄──────────────────│  ├── runpy(tts_daemon.py) 原样执行真实 daemon│
 │ stderr 日志        │◄──────────────────│  ├── tee EventWriter.emit → 协议帧         │
 └───────────────────┘                   │  └── patch SoundDevicePlayer._callback      │
                                          │        → outdata RMS 包络 → latency       │
                                          └───────────────┬──────────────────────────┘
                                                          │ POST http://127.0.0.1:34567/ingest
                                                          │ X-Live2D-Token: dsh-live2d-local
                                                          ▼
                                             host /ingest → SSE → 浏览器 Live2D 渲染层
```

关键实现（`main()`）：

1. 用旁路 JSON 解析真实 daemon 路径，`sys.path.insert(0, realDaemonDir)`；
2. `import ttslib.runtime, ttslib.events`（只 import，不加载 torch/模型）；
3. patch 三处 tee：
   - `os.read`：只对 stdin fd 的记录副本（真实 daemon 的 `StdinPoller` 用 `os.read` 读原始 fd，
     所以 `sys.stdin` 包装无效）；
   - `EventWriter.emit`：先调用原始实现（帧**原样写出**），再观察 payload 副本；
   - `runtime.SoundDevicePlayer` 子类：先调用原 `_callback`（outdata 已填充），再对 outdata 计算 RMS。
     只有第一个被实例化的 player（扬声器主路径）会采集；`FanOutPlayer` 的虚拟麦克风路径不采集。
4. `runpy.run_path(real_daemon, run_name="__main__")` 在同一进程执行真实 daemon：
   真实 daemon 自己完成 argparse、ready 帧、stdin 循环、模型加载、生成、播放、shutdown；
   `SystemExit` 的退出码原样保留。**没有子进程 relay，stdout 没有任何包装**。
5. 事件先进入内存队列，由独立 daemon 线程 POST；与音频回调完全解耦。

依赖：标准库 + `numpy`（真实 TTS venv 已有；仅在真正播放时懒加载）。**不 import torch，
不加载模型，不占用 GPU。**

---

## 2. 安装 / 配置

### 2.1 bundle patch 覆盖 tool-tts 行

TTS 行是 `@deepseek-ai/dsh-voice-bundle` 的 `cordis.patch.yml` 插入的。Live2D bundle 的
`cordis.patch.yml` 必须**整块替换**该行（patch 的 `config` 不做 merge），并加 `daemonScript`：

```yaml
- insert:
    - id: tool-tts
      name: '@deepseek-ai/dsh-tool-tts'
      config:
        pythonPath: '<PYTHON>'
        daemonScript: '<PLUGIN_DIR>/packages/plugin/python/live2d_tts_shim.py'
        voicesDir: '<VOICES_DIR>'   # 单参考音色目录：一个音频文件 + 同名 .txt 文本
        defaultEmotion: 默认
        modelDir: '<MODELS_DIR>'
        cacheDir: '<CACHE_DIR>'
        device: 'cuda:0'
        cfgValue: 2.7
        inferenceTimesteps: 10
        preload: false
```

host 的 spawn 参数（由 VoxCPM 1.5 版 `@deepseek-ai/dsh-tool-tts` 配置生成；本仓库组合为
`<pythonPath> <daemonScript> --voices-dir … --model-dir … --device cuda:0 --cfg-value 2.7
--timesteps 10 --cache-dir … --preload false`）。
shim 不解析这些参数，`sys.argv` 原样传给真实 daemon 的 `argparse`。

> **单参考音色**：`voicesDir` 只放一个参考音色——一个音频文件加同名 `.txt` 文本；引擎对
> 所有段落都用这一个音色。`segments` 里的 `emotion` 只是转发给 Live2D 的表情标签，不参与
> 参考音色的选择；daemon 事件里的 `usedEmotion` 原样回显该标签。

### 2.2 旁路配置 `packages/plugin/python/live2d_tts_shim.json`

由 `tools/install.ps1` 生成；模板见 `live2d_tts_shim.json.example`。

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `realDaemon` | string | `""` | 真实 `tts_daemon.py` 绝对路径。空/不存在时自动探测：`DSH_TTS_DAEMON` → `~/.dsh/profiles/*/node_modules/@deepseek-ai/dsh-tool-tts/python/tts_daemon.py`。找不到则 shim 以退出码 3 失败（stderr 说明原因） |
| `ingestUrl` | string | `http://127.0.0.1:34567/ingest` | host ingest 端点 |
| `token` | string | `""` | `X-Live2D-Token` 头；**固定 `dsh-live2d-local`**（loopback，非机密） |
| `enabledFile` | string | `""` | 存在该文件才转发（host row 激活时创建、停用时删除）。空 = 总是转发 |
| `hopMs` | number | `20` | 包络帧 hop（毫秒，5–200）。**每帧时长为 hopMs，与采样率无关** |
| `envelopeGain` | number | `3.0` | 帧值 = `min(1, RMS × gain)` |
| `batchFrames` | int | `4` | 每批 envelope 帧数（4×20ms = 80ms 一次 POST） |
| `latencyExtraMs` | number | `0` | 口型对齐校准量：在播放器自报输出延迟之外**再加**的延迟（0–2000ms）。蓝牙耳机实际可听时刻常比播放器估计晚 50–200ms，嘴型仍略超前时把它调大（例：`80`），直到口型与声音对齐；嘴型略滞后则保持 0 |

环境变量覆盖（测试/诊断用，可选）：`LIVE2D_TTS_SHIM_CONFIG`、`LIVE2D_TTS_REAL_DAEMON`、
`LIVE2D_TTS_INGEST_URL`、`LIVE2D_TTS_TOKEN`、`LIVE2D_TTS_ENABLED_FILE`、`LIVE2D_TTS_HOP_MS`、
`LIVE2D_TTS_ENVELOPE_GAIN`、`LIVE2D_TTS_BATCH_FRAMES`、`LIVE2D_TTS_LATENCY_EXTRA_MS`。

配置缺失/非法时：**bridge 静默禁用**（stderr 一行 warning），TTS 完全正常，
仅真实 daemon 自动探测仍生效。`enabledFile` 不存在时同样零事件、零 ingest 流量
（每 ≤1s 一次 `stat` 的开销）。

> **重要：工作区 `tts.config.yml` 的优先级高于插件行配置。** tool-tts 的配置按
> 「内置默认 ⊕ 插件行 ⊕ 工作区 `tts.config.yml`」三层合并；自动生成的 `tts.config.yml`
> 里带着 `daemonScript: ""`，这个显式空值会**覆盖** bridge bundle 行里的 shim 路径，
> 导致 shim 根本不启动（现象：TTS 正常但 Live2D 不跟嘴）。`tools/install.ps1` 会把
> `~/Documents/*/tts.config.yml` 中现存的 `daemonScript` 改成 shim 路径并保留
> `*.lead-backup`，`tools/uninstall.ps1` 会恢复；也可以手动把 `daemonScript` 那一行
> 指向 `packages/plugin/python/live2d_tts_shim.py`，或删掉该行。改完结束正在运行的
> python tts daemon，下一次 tts 调用会用新的 daemonScript 重启（3–5s）。

### 2.3 回滚（任意一条即可）

1. 把 bundle patch 里 tool-tts 行的 `daemonScript` 恢复为 `''`（或整行恢复 voice-bundle
   原配置）→ 下一次 daemon 重启后 host 直接 spawn 真实 daemon，Live2D 只失去联动，TTS 不受影响；
2. 或从 profile 的 `dsh.profile.bundles` 移除 live2d bundle（HMR 重组合）；
3. 紧急时删除 `packages/plugin/python/live2d_tts_shim.json` → 下次 daemon 启动时
   shim 仍能自动找到真实 daemon 并运行，但 bridge 禁用、不产生任何 ingest 流量。

**不需要**改 `@deepseek-ai/dsh-tool-tts` 包内文件；**不需要**重启桌面应用（HMR 重组合即可）。

---

## 3. 事件协议（shim → host `POST /ingest`）

- Header：`X-Live2D-Token: <token>`，`Content-Type: application/json; charset=utf-8`
- Body：**JSON 数组**（一条 POST 可含 1..N 条事件；host 也接受单对象/JSONL）
- 所有事件带 `ts` = 毫秒 epoch（`time.time()*1000`，墙钟）
- 采样率：VoxCPM 1.5 解码头为 `44100 Hz`（以 `speak_done.sampleRate` / envelope 每批所带字段为准）

### 3.1 事件表

| `type` | 触发 | 字段（除 `type`,`ts`） |
|---|---|---|
| `speak_request` | shim 在 stdin 读到 `op:"speak"`（早于 daemon 处理） | `id`, `segments:[{emotion,content}]`, `play:bool`, `sampleRate`（已知时） |
| `speak_start` | daemon 产出同名帧 | `id`, `segments`, `sentences`, `units`, `modelLoadMs`, `streaming`, `latencyMs`（流已打开时） |
| `segment_start` | 同上 | `id`, `index`, `usedEmotion`, `requestedEmotion`, `fallback`, `text`, `sentences` |
| `sentence_end` | 同上 | `id`, `index`, `sentenceIndex`, `usedEmotion`, `language`, `text`, `chars`, `genMs`, `audioSec` |
| `segment_end` | 同上 | `id`, `index`, `requestedEmotion`, `usedEmotion`, `fallback`, `seconds`, `sentences` |
| `envelope` | 播放回调 | `id`, `seq`, `frames:[0..1]`, `frameMs`, `sampleRate`, `latencyMs`（已知时） |
| `speak_done` | 同上，**尾音包络采集完之后才转发** | `id`, `ok`, `cancelled`, `totalSeconds`, `playedMs`, `genMs`, `firstAudioMs`, `remainingMs`, `early`, `segments`, `notes`, `latencyMs`（已知时） |
| `error` | 同上 | `id`, `code`, `message` |

`id` 即 host 请求的 `id`；同一 utterance 的事件严格按上表顺序发送，`speak_done` 一定在
最后一个 `envelope` 之后。`play:false` 时：协议事件照常（`speak_request…speak_done`），
**没有 envelope**（没有声音就没有包络）。

`segments` 里的 `emotion` 是表情标签：引擎始终使用同一个参考音色，`usedEmotion` 原样回显
请求的标签（空标签为 `默认`），`fallback` 恒为 `false`。渲染层据此选择表情，与参考音色无关。

### 3.2 `envelope` 语义（口型数据）

- `seq`：每个 `id` 从 0 连续递增，每批 +1；批次按固定 `frameMs`（默认 20ms）聚合；
- `frames`：按 hop 的 RMS，`min(1, RMS×envelopeGain)`，保留 4 位小数。
  本机实测语音段 0.1–0.9、静音段 ≈0；批次默认 4 帧（80ms）/POST，25 次 POST/s；
- `sampleRate`：播放流实际采样率（VoxCPM 1.5 为 44100 Hz；以 daemon 上报为准）。**帧时长固定 20ms**，与采样率解耦；
- `latencyMs`：见 §3.3；测得后每批都带；
- `ts`：该批**交给声卡**的墙钟时刻（flush 时刻，不是可听时刻）。

静音与尾音：包络从 `speak_start` 后第一个真实回调开始采集；daemon 若在音频结束前提前返回，
shim 用 `speak_done.remainingMs` 继续采集到音频真正播完（+100ms 余量），
因此尾部实测会有若干 0 帧（静音），是真实“设备已静音”的证据。

### 3.3 `latencyMs`（T8：口型对齐）

含义：**当前写入设备的样本，还要多少毫秒才真正可听**（dac 之前的 output buffer +
设备/驱动延迟）。数据源（按优先级）：

1. 真实 player 的 `in_device_sec` → open 后由 `sounddevice.OutputStream.latency` 赋值；
   若配置了 `inDeviceSecMs` 则用该显式值；
2. player 的 `_stream.latency`；
3. 回调 `time_info.outputBufferDacTime - time_info.currentTime`（同一 PortAudio 时钟域估算）。

拿不到时为 0，**字段省略**（不会报 0 误导）。第一批 envelope 前就会读取，所以第一批即带。
`speak_start` 只在播放流已经打开（上一句仍在/已播过）时才有该字段；**首次 speak 的
`speak_start` 通常没有 `latencyMs`**，渲染层应以 envelope 批次上的值为准（同一流内恒定）。

历史实测：**`latencyMs = 182`**（旧开发后端、24 kHz、默认输出设备、player `latency="high"`；
MME/WASAPI/AirPods 等设备可能 100–300ms 不等，属正常范围）。

**渲染层对齐方式**（推荐，给 renderer 队友）：

- 收到 envelope 批次时，不立即消费，而是把整批推迟 `latencyMs` 再播放口型；
- 更精确：批次内第 i 帧（`len(frames)` 帧）的可听时刻 ≈
  `ts - (len(frames)-1-i)*frameMs + latencyMs`，按渲染帧率插值/平滑（现有 lipSync
  smoothing 保留）；
- 不要用 `ts` 直接当可听时刻；`ts` 是“交给声卡”的墙钟。首次 `speak_start` 无
  `latencyMs` 时按 0 处理，等第一批 envelope 到达后再应用延迟（最多滞后 80ms 修正）。

---

## 4. 安全 / 零影响保证

| 场景 | 行为 |
|---|---|
| sidecar 不存在/JSON 非法 | stderr warning；bridge disabled；真实 daemon 照常（自动探测 realDaemon） |
| `enabledFile` 不存在 | 零事件、零 POST；每 ≤1s 一次 stat |
| ingest 连接拒绝/超时/非 2xx | 事件丢弃；指数退避（1,2,4,8,10s）；仅 stderr 限频 warning；**绝不阻塞音频回调、不抛到 daemon 主路径** |
| 事件队列满（512 组） | 丢最旧；每 100 条 stderr 一行计数 |
| stdout | 帧由真实 `EventWriter` 原样写出，shim 只读副本；**零字节改动** |
| stdin | `os.read` tee 只读副本；daemon 的 `StdinPoller` 行为不变 |
| 退出码/信号 | `runpy` 同进程执行；`SystemExit` 码原样、EOF/`shutdown` 行为一致 |
| GPU/模型 | shim 不 import torch、不加载模型；`numpy` 懒加载（播放时才 import） |
| numpy 缺失 | 包络禁用（stderr 一行），协议事件仍转发，TTS 正常 |

---

## 5. 验收证据（2026-10-18 开发环境记录，仅作协议参考）

> 以下数字来自一次完整的开发环境记录，仅用于说明 shim 的协议与链路行为；采样率、`latencyMs`
> 与生成耗时取决于本机的模型和音频设备，请按 §6 在你的机器上重新实测，并以新数据为准。

环境：Windows / PowerShell 7 / TTS venv `<PYTHON>`（pythonPath 所在 venv）
（Python 3.12.14, numpy 2.5.3, sounddevice 0.5.6）；真实 daemon `tts_daemon.py`（`VERSION 2.0.0`），
模型 `<MODELS_DIR>` @ `cuda:0`（OpenSound/VoxCPM1.5 为 44.1 kHz 解码头；历史记录 24 kHz），默认输出设备，
`SoundDevicePlayer(latency="high")`。测试期桌面/其他 agent 的 TTS daemon 也在 GPU 上
（显存 ~3.4GB 占用），生成时间因此偏慢（genMs ≈ 16.6s），不影响结论。

### 5.1 fake 模式（`node tests/test_shim_bridge.mjs`，无 GPU，约 4s，**PASS**）

fake daemon 与真实 daemon 走同一 stdin/stdout 协议、同一 `os.read` 读取方式、同一
`EventWriter`/`SoundDevicePlayer._callback` tee 面；用同一 fake daemon 直连跑一次作为参照。

```
direct frames: ready speak_start(d1) segment_start(d1) sentence_end(d1) segment_end(d1) speak_done(d1)
relay fidelity: OK          # ready/5 类帧逐字段 deepEqual（requestId/pid 归一化），帧序一致
t1: totalSeconds=1.2 envelopeFrames=64 (1280ms) max=0.749 latencyMs=(none: fake player has no output stream)
ingest protocol: OK         # token、JSON 数组、speak_request 内容、seq 0..n 连续、speak_done 在包络之后
t2 (play:false): ok=true envelopes=0
shim exit=0, ingest requests=6, events=28
robustness: enabledFile missing -> 0 requests；出现后正常转发
robustness: dead ingest endpoint -> speak_done ok in 46–92ms, exit 0
PASS
```

### 5.2 real 模式（`node tests/test_shim_bridge.mjs --real`，真实 VoxCPM 1.5，出声 1 次，**PASS**）

```
ready after 203ms
speak_done after 26825ms: totalSeconds=1.37 playedMs=1063 genMs=16593 modelLoadMs=8657
                          firstAudioMs=16890 sampleRate=24000 remainingMs=512 early=true ok=true
real: reported latencyMs=182 (for 20 envelope batches)
real: frames=84 duration≈1680ms totalSeconds=1.37s samples 24000Hz, near-zero frames=28,
      max=0.865 min=0.0000, latencyMs=182
real: first frames=[0,0.0039,0.048,0.2164,0.527] last frames=[0,0,0,0,0]
real: ingest events=26 requests=24 segments=[{"index":0,...,"usedEmotion":"默认","seconds":1.37,...}]
real shim exit=0
PASS
```

要点：包络共 84 帧（1680ms）≈ `playedMs(=1063) + remainingMs(=512) + 100ms 余量`，
即与“真实播放墙钟”一致（比 `totalSeconds` 长是因为流式生成期间播放等待/欠载也如实计入）；
首帧 0、尾部 5 帧 0、`max 0.865`，无 0..1 越界。

### 5.3 Python 真实 e2e（`python tests/test_shim.py`，venv 运行，约 88s，**PASS**）

场景：① `direct` 直连真实 daemon（参照）；② `shim` + 本地 ingest 监听器（play:true 一句 +
play:false 一句）；③ `bare` 无 sidecar（bridge disabled，自动探测真实 daemon）。

- `direct`: `totalSeconds=1.427`，`playedMs=1125 genMs=16766 modelLoadMs=9328 firstAudioMs=17032
  remainingMs=517`，`sampleRate=24000`，`ok=true`，exit 0；
- `shim`：stdout 与 direct **字段集合/顺序/稳定值一致**（`speak_start/segment_start/
  sentence_end/segment_end` 逐字段；`speak_done` 字段集合一致，`totalSeconds` 差异在
  随机生成噪声范围内，二次独立运行实测 `1.522s`）；ingest 事件顺序：
  `speak_request → speak_start → segment_start → sentence_end → segment_end → envelope×21 → speak_done`；
  envelope 21 批/90 帧/1800ms（audio 1522ms）、`latencyMs=182`、`min=0 max=0.908`、
  近零帧 48（含首尾静音）；`play:false` 段 0 包络；
  `speak_start`(t2，流已开) 带 `latencyMs=182`；退出码 0；
- `bare`：stderr 输出 `config ... not found; live2d bridge disabled`，TTS `speak_done ok`、
  exit 0、无 ingest 连接。

### 5.4 稳定性

| # | 测试 | 结果 |
|---|---|---|
| 1 | fake 全量 | PASS（relay/envelope/play:false/robustness） |
| 2 | fake 全量（T8 回归） | PASS |
| 3 | real `--real` 第 1 次 | PASS（latency=182ms） |
| 4 | real `--real` 第 2 次（T8） | PASS（latency=182ms，包络 84 帧/1680ms） |
| 5 | python real 全场景（direct+shim+bare） | PASS（85–88s） |
| 6 | python real 全场景（T8：latency 断言 + speak_start t2 latency） | PASS（latency=182ms，85.2s） |

（每次 real 都会真实出声 1–2 句“你好呀/安静”，模型加载 ~8.4–9.5s，单次端到端约 27s。）

---

## 6. 测试命令

```powershell
cd live2d-pet

# 1) 快速协议/relay/健壮性（fake daemon，无 GPU，~4s）
node tests/test_shim_bridge.mjs

# 2) 真实 VoxCPM 1.5（GPU、会出声 1 句；--real 约 30s）
node tests/test_shim_bridge.mjs --real

# 3) Python 真实全场景（direct 参照 + shim ingest + bare 无配置；~90s）
<PYTHON> -u -X utf8 tests/test_shim.py
# 可选：--scenario direct|shim|bare、--keep、--python、--real-daemon、--voices-dir
```

测试产物写到 `live2d-pet/.test-cache/`（本机 Python 子进程无 `%TEMP%` 写权限，
所以 Python harness 用包内缓存目录；Node harness 用系统临时目录）。ingest 监听器端口随机，
**不使用** 34567（host 自己的端口）。

---

## 7. 已知限制 / 风险

1. **包络粒度 80ms/批、20ms/帧**：口型渲染需插值/平滑；`batchFrames` 可调小提高实时性（POST 频率上升）。
2. **`latencyMs` 只在播放流打开后可得**：首次 `speak_start` 通常没有；同一流内恒定，
   设备切换/重开流后才会更新（当前实现取首个非零值，若设备热切换可能滞后一句）。
3. **流式生成的欠载会如实计入包络**：`durationMs` 可能大于 `totalSeconds`（生成慢于播放时的
   0 帧），这是“实际听到的”真实数据；口型跟随包络而非文本时长。
4. **上一句尾音与新请求重叠**：若 host 在上一句 `speak_done` 后立刻发起新 `speak`，新
   `speak_start` 会结束上一段包络采集（已收集部分照常发送），不会串 id；daemon 本身串行 speak，
   正常调用下不出现。
5. **依赖真实 daemon 内部结构**（TTS 升级可能破坏）：`tts_daemon.py` 入口、`ttslib.events.EventWriter.emit`、
   `ttslib.runtime.SoundDevicePlayer._callback`/`in_device_sec`、`StdinPoller` 的 `os.read(fd)` 读取方式。
   升级 TTS 后必须重跑 §6 的 fake+real 测试；fake 测试能捕获前两类，real 测试覆盖播放路径。
6. **play:false 无包络**：若 host 未来用 play:false 做“只生成不播放”的旁白，Live2D 无口型数据（符合预期）。
7. **token 非机密**：loopback + `dsh-live2d-local` 固定值；host 的 `/ingest` 必须校验 header，
   并且只监听 127.0.0.1。
8. **shim 不修改协议流**：若真实 daemon 以后往 stdout 打非 JSON 行，shim 也无法修正（只透传）。


---

## 8. 口型同步修复（2026-10-18）

现象：嘴型比声音**先动**（甚至提前十几秒）。原因不是 182ms 的输出延迟，而是**渲染时机**：
TTS 在「生成阶段」就发出 `speak_request` / `speak_start` / `segment_start`，而真实 PCM 要等到
生成完成、开始播放才进入声卡回调；旧实现一收到 `segment_start` 就让角色进入 SPEAKING，
于是生成期间嘴型/手势先动，声音后到。

同步方法（三层）：

1. **shim 新增 `playback_start` 事件**：在播放器第一次真实 PCM 回调时发出
   （`type: playback_start`, `id`, `ts`, `latencyMs`）。它才是“声音开始”的锚点。
2. **渲染端延后表演**：窗口/覆盖层收到 `segment_start` 只记录 pending；
   直到 `playback_start`（或保底：第一条 `envelope`）才调用 `speakStart` 并开始推进包络。
   生成阶段的等待期角色保持 idle，口型只在声音真正开始后才出现。
3. **可听时刻对齐**：包络仍按 `latencyMs`（播放器输出延迟 + `latencyExtraMs` 校准）推迟消费，
   使第一个张嘴帧落在声音真正可听之后，而不是之前。

实测事件时间线（真实 tts 调用，同一句）：

```
speak_request   21:32:32.936   ← 生成开始（旧实现会在这里就开始动嘴）
segment_start   21:32:41.621   ← 段落开始（仍是生成阶段）
playback_start  21:32:58.7xx   ← 第一次真实 PCM 回调（新锚点，声音从此刻起可听）
envelope × N    21:32:58.718 … 21:33:03.7（latencyMs=182）
speak_done      21:33:03.707
```

修复后：生成期间（约 26s）角色保持 idle；`playback_start` / 首条 envelope 到达后才开始口型，
且包络按 182ms 延迟消费 → 用户确认“这次好了”。若蓝牙耳机仍感觉嘴型略超前，
把 sidecar 的 `latencyExtraMs` 每 20–50ms 往上调即可。
