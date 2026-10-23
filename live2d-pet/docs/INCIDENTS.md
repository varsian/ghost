# 运行事故记录（INCIDENTS）

> 记录 Live2D 插件在真实使用中出现的故障、证据与处置，供以后快速定位。
> 本文只记录已观察到的事实；"可能原因"按概率排序，未标注"已确认"的都只是假设。

## 2026-10-21 20:19–21:00｜TTS 在合成，但嘴型不随声音动

### 症状

- 直播中 TTS 仍在合成/说话，但 Live2D 嘴型不动。
- 用户重启了窗口等组件后仍未恢复。
- 期间无人修改插件源码；宿主 DSH 进程（pid 5088，17:32 启动）与 TTS shim/daemon
  （pid 20852 / 23728，17:59 启动）均未重启。

### 观测证据

- `GET /health`（只读）：
  - `plugin: "live2d"`, `version: "0.2.0"`, `windowOpen: true`, `windowClients: 1`
  - `latencyMs: 182`
  - **`lastEnvelopeAt` 停在 2026-10-21 20:19:08，`lastEnvelopeLevel: 0.7017` 不再更新**
  - `speaking` 会在合成事件到来时变 true（注意：host 的 `speaking=true` 只代表"收到合成事件"，
    不代表"播放 PCM 已经到达"）
- 被动监听 `/events`（60 秒，未调用 TTS）：
  - 收到 `speak_request`、`speak_start`、`segment_start`、`emotion`、`sentence_end`、
    `segment_end`、`speak_done`、`speech_end`
  - **收到 0 条 `envelope`，也没有 `playback_start`**
  - 统计：`{"speak_request":2,"speak_start":2,"segment_start":6,"emotion":6,"sentence_end":5,
    "segment_end":5,"speak_done":2,"speech_end":2}`，`envelope` 缺失
- 窗口日志（`packages/plugin/data/live2d-window.log`）：
  - `2026-10-21T12:29:11.725Z`：`[live2d:window] host received fresh audio but no TTS SSE event
    arrived; reconnecting SSE 1`
  - `SSE reconnect: stale-sse-during-audio`
  - 说明窗口 watchdog 也检测到"音频/SSE 不同步"，但 SSE 本身是连着的（`windowClients=1`）。
- 结论：**TTS 协议事件链是通的；断点在"真正播放的 PCM → shim 包络 → POST /ingest"这一段**。

### 处置（有效）

1. 不在说话中操作；
2. 在 DSH 插件页把「Live2D × TTS 联动桥」（`@local/dsh-live2d-tts-bridge`）**关掉再打开**，
   这会重启 TTS daemon / shim，重新初始化播放器与包络 tee；
3. 再说一句短句；
4. 被动复查 `/health`：`lastEnvelopeAt` 从 20:19:08 前进到 **21:00:31**，嘴型恢复。
   （恢复后 TTS 空闲时 12 秒监听没有新 envelope 是正常的——没有播放就没有包络。）

### 可能原因（按概率，均未最终确认）

1. **TTS 播放路径变了：`play:false` 或只输出到虚拟声卡/麦克风路径（如 VB-CABLE）。**
   shim 只把"第一个 `SoundDevicePlayer` 实例"标记为 primary，`mic` 路径是第二个实例（secondary），
   `_callback` 对 secondary 直接 return。如果音频只走 mic/虚拟声卡或只生成不播放，就永远没有 envelope。
   这与"事件全有、envelope 全无、`playback_start` 缺失"的观测最吻合。
2. **输出设备被切换/被独占**（OBS、CABLE、蓝牙等）：`SoundDevicePlayer` 的流没有成功打开或没有回调，
   因此没有 PCM、没有 `playback_start`。事件链（事件写入器 tee）不依赖声卡，所以仍然正常。
3. **TTS daemon 重启后播放器重建，而 shim 的 `_register_player` 只认第一个实例**：
   新实例可能被标记为 secondary，导致 `_callback` 不再向上送包络。
   （本次重启 bridge 后恢复，符合"重新初始化即可恢复"的特征。）
4. stdin tee 失效导致 `_pending` 丢失（概率低）：只影响 `play` 标记，默认仍按 true 处理，通常不会导致
   完全无 envelope。

### 复盘 / 待办

- [ ] shim 增加诊断日志：`speak_start` 时打印 `play`；`register_player` 打印 `primary/secondary`；
      secondary 的 `_callback` 计数（限频），便于下次直接定位。
- [ ] 评估把包络 tee 从"只认第一个 player"改成"实际在播放的 player（含 mic/虚拟声卡路径，
      可选配置 `teeMic`）"，避免 OBS 走虚拟声卡时失去口型。
- [ ] host 增加健康字段：`playbackStartedAt` / `lastPcmAt` / `bridgeRole`，并在
      "speaking=true 但 N 秒无 PCM"时写 warn 日志。
- [ ] 文档写明：用虚拟声卡/OBS 监听时，必须确保 TTS **同时**播放到默认扬声器，或开启 mic tee。
- [ ] 本事故**不是**独立的本地项目 GHOST 的代码变更导致：该项目与运行实例完全隔离，
      原插件源码 18:00 后无改动（可核对文件 mtime 与 git 状态）。

### 快速诊断命令（只读，不触发 TTS）

```powershell
Invoke-RestMethod http://127.0.0.1:34567/health |
  Select-Object speaking, lastEnvelopeAt, lastEnvelopeLevel, windowClients, latencyMs
```

- `lastEnvelopeAt` 不随时间前进 → 包络没到 host；
- 如果同时在说话且窗口日志出现 `fresh audio but no TTS SSE event` → 优先检查 TTS 播放路径/设备；
- 修复：重启 TTS 联动桥，或把 TTS 输出切回默认扬声器后再试。
