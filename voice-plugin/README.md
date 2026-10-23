# @deepseek-ai/dsh-tool-tts (VoxCPM 1.5 snapshot)

> **Snapshot note (packaging).** This directory is a source/artifact snapshot of the
> upstream `@deepseek-ai/dsh-tool-tts` plugin (version `0.1.5-rc.2`), kept under its
> upstream **MIT license** (see `package.json` and the repository `NOTICE`). It is
> **not** relicensed to Apache-2.0. It contains the built Node plugin (`lib/`), the
> Python engine (`python/`) and this reference doc. The upstream TypeScript sources
> (`src/`), frozen `PROTOCOL.md` and generated catalogs are not included.
> Paths are shown as placeholders (`<PYTHON>`, `<VOICES_DIR>`, `<MODELS_DIR>`,
> `<CACHE_DIR>`, ...) — see the repository [`docs/INSTALL.md`](../docs/INSTALL.md).

## Summary

`dsh-tool-tts` lets the agent speak out loud. One `tts` call carries several segments,
each with an optional emotion label, to a locally resident **VoxCPM 1.5** daemon and
returns only after the audio has finished playing (unless `play: false`), so the agent
can narrate an answer, read a summary aloud, or acknowledge a request.

The engine speaks with **one reference voice**: the `voicesDir` folder holds exactly
one audio file plus a same-stem `.txt` transcript, and every utterance clones that
recording. An `emotion` on a segment is a label forwarded on the protocol events (the
Live2D bridge uses it to pick an expression); it never selects a different recording.
The daemon starts and loads the model on the first call, keeps it resident, and dies
with the plugin.

## Requirements

- Windows/Linux/macOS with **Python 3.10+** in a virtualenv that can run VoxCPM 1.5.
- A **CUDA-capable GPU** is strongly recommended; VoxCPM 1.5 is a ~0.8B model with a
  44.1 kHz AudioVAE. CPU inference is possible but slow.
- **VoxCPM 1.5 weights** on disk (weights + config + tokenizer files). They are not
  shipped; the reference checkpoint is `OpenSound/VoxCPM1.5` (download it yourself and
  point `modelDir` at the directory).
- **One reference voice** in `voicesDir`: a single audio file (`<name>.wav` preferred;
  `.mp3`, `.flac`, `.m4a`, `.ogg` and `.opus` are also accepted) plus a same-stem
  `<name>.txt` holding exactly what that clip says. VoxCPM clones by continuing the
  reference clip, so the clip and its exact transcript are both required.
- A working audio output device (or `play: false` for file-only generation).

### Python environment

The engine is a long-lived daemon. A working setup on Windows (CUDA 12.8 wheels for
RTX 50-series / sm_120) looks like this; adjust the index URL for your GPU:

```powershell
$venv = '<TTS_RUNTIME_ROOT>\.venv-vox'
uv venv $venv --python 3.12
uv pip install --python "$venv\Scripts\python.exe" torch torchaudio --index-url https://download.pytorch.org/whl/cu128
uv pip install --python "$venv\Scripts\python.exe" voxcpm==1.5.0 --no-deps
uv pip install --python "$venv\Scripts\python.exe" -r python/requirements.txt
```

`voxcpm` is installed with `--no-deps` on purpose: its own dependency list pulls the
WebUI/fine-tuning stack (gradio, datasets, spaces, funasr, modelscope) that inference
does not need, and its pins conflict with the model runtime.

## Minimal configuration

`pythonPath`, `voicesDir`, `modelDir` and `cacheDir` are required; every other field
has a default. This is the row used by a DSH profile (see the repository
`tts-bridge/bundle/cordis.patch.yml` for the Live2D-coupled variant):

```yaml
- id: tool-tts
  name: '@deepseek-ai/dsh-tool-tts'
  config:
    pythonPath: '<PYTHON>'
    daemonScript: '<VOICE_PLUGIN_ROOT>\python\tts_daemon.py'
    voicesDir: '<VOICES_DIR>'        # one audio file + its same-stem .txt transcript
    defaultEmotion: 默认
    modelDir: '<MODELS_DIR>'          # VoxCPM 1.5: weights + config + tokenizer
    cacheDir: '<CACHE_DIR>'
    device: 'cuda:0'
    cfgValue: 2.7                     # classifier-free guidance (0.1–10)
    inferenceTimesteps: 10            # diffusion steps (1–100; fewer = faster/coarser)
    preload: false
```

The main fields come from the plugin's `Config` schema (`lib/index.js` /
`lib/types/index.d.ts`):

| Field | Default | Meaning |
| --- | --- | --- |
| `pythonPath` | required | Interpreter that runs the daemon |
| `daemonScript` | packaged `python\tts_daemon.py` | Daemon entry script |
| `voicesDir` | required | Folder holding the one reference voice: one audio file + same-stem `.txt` |
| `defaultEmotion` | `默认` | Default emotion label; the engine reports `默认` and uses it for unlabelled segments |
| `modelDir` | required | VoxCPM 1.5 model directory (weights, config, tokenizer) |
| `cacheDir` | required | Cache for the default WAV output |
| `device` | `cuda:0` | CUDA device made current before the weights load |
| `cfgValue` | `2.7` | CFG guidance scale |
| `inferenceTimesteps` | `10` | LocDiT diffusion steps |
| `optimize` | `false` | Try `torch.compile` (skipped with a warning on Windows/Triton-less hosts) |
| `normalizeText` | `false` | Use the engine's text normalizer (numbers/abbreviations) |
| `saveDir` | `''` | Daemon WAV output dir (empty = `<cacheDir>\wav`) |
| `maxSentenceChars` | `60` | Sentence split threshold (`0` disables the cap) |
| `firstSentenceMaxChars` | `20` | First-sentence cap for low first-audio latency |
| `idleUnloadSec` | `1800` | Unload the model after this idle time; `0` disables |
| `preload` | `false` | Load the model at daemon startup instead of the first call |
| `outputDevice` | `''` | sounddevice output device name (empty = system default) |
| `mergeSentences` | `short` | `off` / `short` / `all` — merge adjacent short sentences per segment |
| `mergeMaxChars` / `shortSentenceChars` | `0` / `20` | Merging bounds |
| `samplingSeed` | `0` | Reseed before each generation when `>0` (debugging aid) |
| `emotionListInResults` | `always` | Repeat the emotion-label list on every result (`onFallback` = only when resolved differently) |
| `toolTimeoutMs` | `600000` | Per-call deadline, including lazy startup and the whole utterance |

The built plugin artifact also passes a few engine-option keys to the daemon at launch;
those are accepted for launch compatibility and do not change the behavior of this
single-reference-voice engine.

## The reference voice folder

`voicesDir` must contain **exactly one** reference voice:

```
<VOICES_DIR>\
  reference.wav      # one audio file: .wav preferred; .mp3/.flac/.m4a/.ogg/.opus accepted
  reference.txt      # same stem; exactly what the recording says
```

- The transcript is read as UTF-8 (UTF-8/UTF-16 BOM aware) with a CP936 fallback; a
  file that is empty/whitespace-only, undecodable, or longer than 2000 characters is
  treated as missing.
- The audio file's stem is matched to the `.txt` stem case-insensitively and
  Unicode-NFC-normalized, so `Reference.WAV` + `Reference.TXT` pair up.
- Zero audio files or more than one audio file fails cleanly at startup with an error
  naming the folder; the folder is rescanned automatically, so fixing it takes effect
  on the next call (or on a `voices`/`reload` request).
- A complete voice needs its transcript. If it is missing, the daemon reports
  `GENERATE_FAILED` at speak time and names the exact `.txt` file to write; it never
  clones with a half-given prompt.
- Editing the transcript in place is picked up on the next call without restarting the
  daemon.

## What each call does

1. Uses the one reference voice for every segment; each segment's `emotion` is carried
   on the events as `requestedEmotion`/`usedEmotion` with `fallback: false`.
2. Splits text into bounded units (first sentence short, then `maxSentenceChars`),
   optionally merging short neighbours.
3. Generates with VoxCPM 1.5 (`cfgValue`, `inferenceTimesteps`) unit by unit, streaming
   audio into the device as it is produced.
4. Blocks until `speak_done` — i.e. the last sample left the output device — then
   returns one line with the totals and the available emotion labels (failures:
   `tts 失败：…`). With `play: false` the result returns once the WAV files are written.

`/tts status`, `/tts reload`, `/tts config`, `/tts doctor` are registered on the DSH
command plane. The workspace `tts.config.yml` (never overwritten once it exists) can
override many fields per project; process-scoped keys (pythonPath / daemonScript /
device / modelDir / cacheDir) restart the engine on the next call when
`autoReloadEngine` is on.

## Testing

`python/tests/` is an offline unit/integration suite that does **not** need a GPU or the
real model: `tests/fake_voxcpm` stands in for the `voxcpm` package. It covers sentence
splitting, the single-reference-voice scan rules (exactly one clip, transcript
resolution, decode rules, rescans), the wire protocol of a real daemon subprocess,
emotion-label pass-through, runaway-audio caps, OOM/unload handling and the streaming
pipeline.

```powershell
<PYTHON> -m unittest discover -s python/tests -v
```

## Known limitations

- VoxCPM 1.5 speaks **Chinese and English only** and infers the language from the text;
  the tool schema has no language parameter by design.
- Long input is the documented instability axis for VoxCPM; the 60-character unit cap
  and the per-unit token cap are not optional.
- The tool is exclusive in the tool scheduler — one utterance at a time. A `tts` call
  holds the agent's turn for as long as playback takes (unless `play: false`).
- Model weights, the reference voice and the Python dependency stack are not shipped
  and carry their own upstream licenses.
