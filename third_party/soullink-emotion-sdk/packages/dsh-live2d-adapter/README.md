# @soullink-emotion/dsh-live2d-adapter

DSH (DeepSeek Harness) adapter package for the [`soullink-emotion-sdk`](https://github.com/nanlingyin/soullink-emotion-sdk)
fork. It connects three pieces that already exist in this repo:

| Piece | Package | Role |
| --- | --- | --- |
| Emotion runtime | `@soullink-emotion/engine` (`SoullinkRuntime`) | VAD/FACS emotion state, idle/breathe/blink, procedural + measured lip-sync, native-animation directives |
| Live2D renderer | `@soullink-emotion/live2d-pixi` (`Live2DRenderer`, DSH-forked) | PIXI v7 + `pixi-live2d-display` Cubism 4 rendering, hidden parts, expression overlay |
| Envelope analyzer | `EnvelopeAudioLevelAnalyzer` (this package) | consumes pushed 0..1 RMS frames on the render clock and feeds the engine |

## Integration API

```js
// Script order for the IIFE bundle (all files are vendored, no CDN):
//   pixi.min.js -> pixi-live2d-display.min.js -> live2dcubismcore.min.js -> dsh-live2d-adapter.js
const stage = DSHLive2DAdapter.createSoullinkStage({
  container: document.querySelector("#live2d-stage"),   // sized by the host CSS
  model: {
    baseUrl: "/assets/models/ds-whale-girl",             // served by the DSH host
    modelFile: "c_0120.model3.json",
    hiddenParts: [...],                                  // from live2d.manifest.json
    expressions: [...],                                  // idem
  },
  config: {
    fps: 30,
    maxWidth: 360,
    maxHeight: 520,
    devicePixelRatioCap: 1,
    coreUrl: "/assets/vendor/live2dcubismcore.min.js",   // optional if already loaded
  },
  onStatus: (status) => console.log("[live2d]", status.phase, status.message),
});

await stage.ready;
stage.setEmotion("亲切", 0.8);              // Chinese TTS emotion -> VAD + native exp3
stage.speakStart({ emotion: "亲切", text: "你好呀" });
stage.pushEnvelope(frames, 20);            // RMS frames 0..1, 20ms hop; call per SSE burst
stage.speakEnd();
stage.setVisible(true);
stage.setScale(1.0);
stage.setPosition("bottom-right", 0, 0);
console.log(stage.stats());                // { backend: "soullink", fps, mouth, ... }
stage.dispose();
```

`speakStart` / `pushEnvelope` / `speakEnd` map 1:1 to the TTS bridge events
(`speech_start` + `emotion`, `envelope`, `speech_end`).

## Build

```bash
# from the repo root (third_party/soullink-emotion-sdk)
npm install
npm run build --workspace @soullink-emotion/live2d-pixi   # if renderer sources changed
node packages/dsh-live2d-adapter/scripts/build.mjs        # or: npm run build --workspace @soullink-emotion/dsh-live2d-adapter
```

Artifacts:

- `dist/dsh-live2d-adapter.js` — minified IIFE, global `DSHLive2DAdapter`.
  Expects `window.PIXI`, `window.PIXI.live2d` and (lazily) `window.Live2DCubismCore`.
  This is the artifact to copy into `packages/plugin/vendor/`.
- `dist/index.js` — ESM build with `pixi.js` / `pixi-live2d-display` external
  (for Vite/dev pages).
- `dist/*.d.ts` — TypeScript declarations.

## Notes

- The adapter owns no sockets, audio, DOM layout or commands; the DSH client
  plugin feeds it from the TTS bridge SSE stream and `/live2d` commands.
- `setPosition(anchor, dx, dy)` adjusts the model inside the canvas; the overlay
  anchor placement itself is the client plugin's CSS responsibility.
- Idle motions loop automatically through `pixi-live2d-display` (the model3
  `Idle` motion group). Native expressions are driven by the adapter with an
  intensity weight (Cubism parameter blend), not by the library expression
  queue, so `setEmotion(name, intensity)` is smooth and deterministic.
