# `tts` engine (Python)

The generation side of the DSH `tts` tool: a long-lived daemon that speaks text through a local VoxCPM 1.5 voice-cloning model, streams audio unit by unit while it plays, and reports timings back to the TypeScript plugin as JSON Lines events.

The engine clones **one reference voice**: the `--voices-dir` folder holds one audio file plus a same-stem `.txt` transcript, and every utterance continues from that recording. Emotion values on a request are labels forwarded on the protocol events (the Live2D bridge uses them to pick an expression); they never select a different recording.

The interface is frozen in `PROTOCOL.md` (rev 9; not included in this snapshot). This README documents the engine's operations, flags, timing semantics, and how to verify it.

## Layout

| File | Role |
| --- | --- |
| `tts_daemon.py` | Entry point: argument parsing, JSONL request loop, all protocol ops |
| `ttslib/events.py` | Atomic JSONL event writer (stdout) + stderr logger |
| `ttslib/textsplit.py` | Text normalization, sentence splitting and script classification (PROTOCOL.md §7) |
| `ttslib/hygiene.py` | Silence gate trimming, trailing-silence cap, runaway-tail token cap |
| `ttslib/voices.py` | The single reference voice: folder scan, transcript resolution, emotion-label resolution (PROTOCOL.md §5) |
| `ttslib/pipeline.py` | Sentence pipeline: generation worker + continuous playback loop (chunked items) |
| `ttslib/runtime.py` | The VoxCPM backend, the torchaudio/soundfile fallback, the model host, the sounddevice player, audio IO |
| `tests/` | `unittest`/`pytest` suite; only `tests/e2e_speak.py` needs the GPU |
| `requirements.txt` | Runtime dependencies of `--model-dir`'s interpreter and the cu128 install note |

## Interpreter and model

```
engine venv     <TTS_RUNTIME_ROOT>\.venv-vox\Scripts\python.exe
                voxcpm 1.5.0 (installed --no-deps) + transformers, einops, soundfile,
                sounddevice, numpy, wetext, tqdm, inflect, regex, addict, simplejson,
                sortedcontainers, torch 2.11.0+cu128, torchaudio 2.11.0+cu128
model           <MODELS_DIR>\VoxCPM1.5
reference voice <VOICES_DIR>   (one audio file + its same-stem .txt transcript)
```

VoxCPM 1.5 is a 0.8B `voxcpm`-architecture checkpoint: a 6.25 Hz language-model backbone (patch size 4) driving a 44.1 kHz AudioVAE, loaded in bfloat16 on CUDA. `VoxCPM(voxcpm_model_path=…, enable_denoiser=False, zipenhancer_model_path=None, optimize=…)` is the whole constructor:

- it has **no `device` argument**; `--device cuda:N` is applied as the process's current CUDA device (`torch.cuda.set_device(N)`) before the weights load, and any other value is refused with `MODEL_LOAD_FAILED`;
- the constructor always runs one throwaway warmup generation, so it is included in `modelLoadMs`; `--warmup` therefore does nothing and `warmupMs` is always 0;
- `--optimize true` enables `torch.compile`, which needs `triton` on Windows (absent here, so it degrades to a warning) and whose CUDA graphs cannot run on the daemon's generation thread; the default is `false`;
- the denoiser is never enabled: it needs a ModelScope download and caps cloning at 16 kHz, while VoxCPM 1.5 decodes at 44.1 kHz.

VoxCPM 1.5 reads the reference clip with `torchaudio.load`, and torchaudio ≥ 2.9 delegates that to TorchCodec, which is not installed (it also needs FFmpeg shared libraries on Windows). `ttslib.runtime.install_torchaudio_soundfile_fallback()` therefore patches `torchaudio.load` to `soundfile.read` when `torchcodec` cannot be imported, and raises if neither backend is available. The choice is logged at load time.

## Invocation

```powershell
& "<TTS_RUNTIME_ROOT>\.venv-vox\Scripts\python.exe" `
  "<VOICE_PLUGIN_ROOT>\python\tts_daemon.py" `
  --voices-dir "<VOICES_DIR>" --default-emotion "默认" `
  --model-dir "<MODELS_DIR>\VoxCPM1.5" `
  --device cuda:0 --cfg-value 2.7 --timesteps 10 --optimize false --normalize false `
  --cache-dir "<CACHE_DIR>" --save-dir "" `
  --max-sentence-chars 60 --idle-unload-sec 1800 --preload false `
  --output-device ""
```

stdout carries only JSON Lines events; every human-readable record goes to stderr.

### Flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--voices-dir` | required | Folder holding the one reference voice: one audio file + its same-stem `.txt` transcript |
| `--default-emotion` | `默认` | Accepted for config compatibility; the engine reports `默认` as the default label |
| `--model-dir` | `""` | VoxCPM 1.5 model directory (weights, config and tokenizer) |
| `--device` | `cuda:0` | CUDA device made current before loading; `cuda:N` only |
| `--cfg-value` | `2.7` | VoxCPM CFG guidance scale (1.0-3.0 recommended) |
| `--timesteps` | `10` | LocDiT inference timesteps (4-30 recommended) |
| `--optimize` | `false` | `torch.compile` the model (needs triton; CUDA graphs block threaded generation) |
| `--normalize` | `false` | Run VoxCPM's own text normalization (numbers, abbreviations) before generation |
| `--cache-dir` | `""` | Default WAV output root (`<cache-dir>\wav` when no `--save-dir`) |
| `--save-dir` | `""` | Default WAV output directory when a request sets `save` but no `saveDir` |
| `--max-sentence-chars` | `60` | Sentence cap; `0` disables further splitting |
| `--first-sentence-max-chars` | `20` | Re-split each segment's first sentence shorter; only the non-streaming branch applies it |
| `--merge-sentences` | `short` | `off` \| `short` \| `all` — adjacent short sentences inside one segment become one generation |
| `--merge-max-chars` | `0` | Character bound one merged unit may reach; `0` uses `--max-sentence-chars` |
| `--short-sentence-chars` | `20` | Under `short`, the longest sentence that may join the previous unit |
| `--seed` | `0` | `>0` reseeds torch before every generation (reproducibility aid) |
| `--stream` | `true` | Play chunks as the model produces them instead of waiting for a whole unit |
| `--silence-gate-db` | `-45` | Noise gate for leading/trailing silence |
| `--silence-pad-ms` | `40` | Silence kept on each side of the speech |
| `--max-trailing-silence-ms` | `400` | Cap on a trailing silence run while streaming |
| `--max-frames-per-char` | `3.2` | Runaway-tail cap: 6.25 Hz LM tokens allowed per character |
| `--max-audio-multiple` | `3.0` | Abort streaming once produced audio exceeds this multiple of the expected duration |
| `--max-audio-floor-sec` | `6.0` | Absolute floor for that abort, so short sentences are never clipped |
| `--max-generation-sec` | `90` | Wall-clock guard on one streaming generation |
| `--chars-per-second` | `3.3` | Expected speaking rate used by the runaway guard |
| `--idle-unload-sec` | `1800` | Release the model after this much idle time; `0` disables |
| `--preload` | `false` | Load the model during startup instead of on the first `speak` |
| `--warmup` | `true` | Accepted for compatibility: VoxCPM warms up inside its constructor, so this runs nothing |
| `--output-device` | `""` | sounddevice output device; empty = system default |

The built Node plugin also passes a few additional engine-option flags at spawn time;
the daemon accepts them for launch compatibility and they do not change the behavior
of the single-reference-voice engine.

## Operations

Requests are one JSON object per line on stdin; `id` is echoed verbatim in every reply.

| `op` | Reply events | Notes |
| --- | --- | --- |
| `ping` | `pong` | Liveness + pid |
| `voices` | `voices` | Forces a rescan of the reference-voice folder |
| `reload` | `voices` | Same payload as `voices` (PROTOCOL.md §6 rule) |
| `stats` | `stats` | pid, `modelLoaded`, `modelLoadMs`, `warmupMs`, `calls`, `generations`, `device`, `engine`, `streaming`, `sampleRate`, `optimize`, `allocatedMb`, `reservedMb`, `peakMb`, `freeMb`, `totalMb` |
| `unload` | `unloaded` | Releases the model; reports `freedMb` and `reason:"explicit"` |
| `speak` | `speak_start` → `segment_start`/`sentence_end`/`segment_end`* → `speak_done` | Blocking; one utterance at a time |
| `shutdown` | `shutdown` | Frees VRAM and exits 0 |
| (stdin EOF) | — | Silent exit 0 |
| unknown `op` | `error` `BAD_REQUEST` | Daemon keeps serving |
| malformed JSON | `error` `BAD_JSON` | Daemon keeps serving |

Unsolicited `unloaded` events carry `id:null` and report why the model left VRAM: `reason:"idle"` after the idle timer, `reason:"oom"` after the engine recovered from a CUDA OOM.

`speak` request fields: `segments` (required; objects `{emotion?,content,speed?}` — a bare string is tolerated as `content` with the default label), `play` (default `true`), `save` (default `false`), `saveDir`, `gapMs` (default `120`), `speed` (default `1.0`). `gapMs` inserts silence on the PLAYER between a non-final segment and the next one only: it is not written into the saved WAV chunks and not counted in `segments[].seconds`/`totalSeconds`, so `play:false` makes it a no-op.

`speed` is accepted, ignored (`supports_speed()` is always false) and reported in `notes`.

Event fields are exactly those in PROTOCOL.md §6 plus these additive fields:

- `sentence_end.chars` / `sentence_end.maxLen` — the unit's character count and the LM-token cap passed to the engine for it;
- `speak_done.firstAudioMs`, `speak_done.notes[]`, `speak_done.modelWasLoaded`, `speak_done.sampleRate`;
- `ready.ok` / `ready.startupError` — whether the reference voice folder is usable and, when it is not, the user-facing reason;
- `ready.engine`/`sampleRate`/`optimize`/`cfgValue`/`timesteps`/`asrAvailable` (the last is always `false`: the engine clones the one voice directly from its transcript);
- `ready`/`voices.defaultEmotionSource` (`voice` | `none`), `emotionNames[]`;
- `voices.startupError` — present when the folder is unusable;
- `segment_start.sentences`; `segment_start` is emitted when that segment's first unit starts generating.

### Timing semantics

| Field | Meaning |
| --- | --- |
| `genMs` (sentence) | Wall time of that unit's generation call, including `torch.cuda.synchronize()` |
| `genMs` (`speak_done`) | Sum of the per-unit generation times (model time only, excludes playback/load) |
| `audioSec` / `totalSeconds` | Samples ÷ sample rate, i.e. audible seconds |
| `rtf` | `genMs ÷ (totalSeconds × 1000)`; `< 1` is faster than real time |
| `firstAudioMs` (sentence) | Wall time from `speak_start` to the moment that unit started playing |
| `firstAudioMs` (`speak_done`) | Wall time from `speak_start` to the first audible sample of the call |
| `playedMs` | Playback phase wall time: first write through device drain |
| `modelLoadMs` | Cold-start cost of the call that loaded the model (weights + the constructor's warmup generation); 0 thereafter |
| `warmupMs` | Always 0: the engine has no separate warmup step |

`speak_done` is emitted only after the output stream has drained (or, with `play:false`, after every sample was written). Failures emit a single `error` and then nothing else for that id.

### stdout purity

`stdout` is the JSONL protocol stream, and the model package prints notices (the fake package used by the tests prints a banner on purpose), so:

- at startup the daemon captures the real stdout byte stream for the event writer and points `sys.stdout` at `sys.stderr` — every later library `print()` lands in the stderr log;
- `ttslib.runtime.quiet_stdout()` additionally wraps the `voxcpm` import, the constructor call and each generation with `contextlib.redirect_stdout(sys.stderr)`.

`tests/test_model_path.py` proves that the very first stdout line parses as JSON and that no non-JSON line appears across import, load and two speaks.

## Language contract (rev 9)

VoxCPM 1.5 speaks **Chinese and English only** and infers the language from the text. **There is no request-side language parameter**: the tool schema offers no such field, a `language` key left in a raw segment object is ignored rather than validated, and the daemon never passes a language to the model.

- A segment whose letters are more than 20% outside Han/Latin (kana, hangul, Cyrillic, Greek, Arabic, Thai, …) fails the whole call with `GENERATE_FAILED`, naming the script and the two supported languages, before anything is loaded: the engine would otherwise read those characters as Chinese and speak something the text does not say.
- Up to 20% of such letters the segment is synthesized with one note — `segment i: text contains kana; VoxCPM 1.5 speaks Chinese and English only, so those characters are read as Chinese` — because the note is the caller's only signal that part of the text will be mispronounced.
- Units are still split at clause boundaries where the script changes, so one generation never has to switch language mid-unit.
- `sentence_end.language` is reporting only and always `Auto`: the language is inferred from the text.

## The single reference voice (PROTOCOL.md §5)

`--voices-dir` names the folder holding the one recording the engine clones:

```
<VOICES_DIR>\
  reference.wav      # exactly one audio file; .wav preferred, .mp3/.flac/.m4a/.ogg/.opus accepted
  reference.txt      # the same stem; exactly what the recording says
```

- **Exactly one audio file.** Zero audio files, or more than one, fails cleanly at startup: the daemon emits one `error` (`NO_VOICES`) with a clear message, keeps serving, and answers every `speak` with the same reason instead of loading a model without a reference. `ready.ok` is `false` and `ready.startupError` carries the message; `ready.emotions`/`emotionNames` are empty.
- **The transcript is required.** It is the same-stem `.txt` file beside the audio (matched case-insensitively and NFC-normalized). A missing, empty, undecodable or over-long (> 2000 characters) transcript leaves the voice without reference text: `ready` reports `refText:false`/`via:"none"`, and a `speak` fails with `GENERATE_FAILED` naming the exact `.txt` path to write. VoxCPM clones by **continuing the reference clip**, so the clip and its exact text are both mandatory; the engine never clones with a half-given prompt.
- Decoding: UTF-16 LE/BE or UTF-8 with BOM when the BOM says so, otherwise strict UTF-8, then CP936 (GBK). The reference text is the decoded content with surrounding whitespace stripped and the inner content verbatim.
- Discovery is part of the rescan signature: creating, editing, emptying or deleting the transcript, or changing the audio file, changes the reported voice on the next scan without restarting the daemon.
- `voices[].via` is `text` (the transcript file was read) or `none`.

### Emotion labels

A requested `emotion` is a label, not a voice selector:

- `usedEmotion` and `requestedEmotion` both carry the requested label; `fallback` is always `false`. An empty/omitted label becomes `默认` (the default label, `defaultEmotion`), and any other string is passed through verbatim. The Live2D bridge reads these labels to pick an expression.
- The reference voice never changes: `ready.emotions` reports exactly one entry (`{"name":"默认", …}`) and `ready.emotionNames` is `["默认"]`.
- The daemon accepts `--default-emotion` for config compatibility; it reports `默认` as the
  default label (the engine still clones the one reference voice).

## Text preparation (PROTOCOL.md §7)

1. Normalize: drop Markdown fences, `**`/`__`/backticks, control characters; collapse horizontal whitespace and repeated punctuation.
2. Split at `。！？!?…；;`, at newlines, and after closing quotes. A sentence over `--max-sentence-chars` splits at `，,、：:`, then hard-splits at the cap. Punctuation stays attached to the sentence it closes.
3. Empty segments are skipped, reported as `seconds: 0` with a note, and load no model.

Long input is the documented instability axis for VoxCPM (gradual speed-up, buzzing, KV-cache growth, generations that never stop), which is why the 60-character unit cap plus a per-unit token cap are not optional: every unit is generated with `max_len = min(512, max(96, round(3.2 × characters) + 36))` LM tokens.

## Engine

One backend, `VoxCPMBackend` (`ttslib/runtime.py`):

- `load()` applies `--device`, installs the torchaudio/soundfile fallback, constructs `VoxCPM(...)`, reads `model.tts_model.sample_rate` (44.1 kHz; never hardcoded) and reports `MODEL_LOAD_FAILED` on any failure;
- every generation passes `text`, `prompt_wav_path=<reference clip>`, `prompt_text=<its transcript>`, `cfg_value`, `inference_timesteps`, `max_len`, `normalize` and `retry_badcase=True`;
- `synthesize_stream()` iterates `generate_streaming()`, whose chunks are 7056 samples (0.16 s) each, and closes the generator in a `finally` — early break, cancellation and exceptions all release the GPU buffers the generator holds;
- `supports_speed()` is `False`, so `speed` is ignored and reported;
- the engine rebuilds its prompt cache inside every `generate*` call, so the engine keeps no clone-prompt cache and reports no `promptsCached`/`voicesCached` count;
- the engine's own bad-case retry is disabled while streaming (it logs `Retry on bad cases is not supported in streaming mode`), so the caps below are the runaway protection on that path.

### Silence hygiene and runaway guard

- Leading and trailing silence below `--silence-gate-db` is removed before `audioSec`/`seconds`/`totalSeconds` are computed; `--silence-pad-ms` of natural breath is kept on each side. While streaming, the first chunks are trimmed in place and a trailing silence run is capped at `--max-trailing-silence-ms`, so no unit has to be buffered to trim it.
- The streaming consumer aborts mid-generation when produced audio exceeds `max(--max-audio-floor-sec, expected × --max-audio-multiple)` or when one unit takes longer than `--max-generation-sec` of wall time; the generator is closed, and what was already produced is played.
- A unit is judged as capped on the length the model **generated**, not on what survived trimming, so a capped unit always reports `N sentence(s) reached the runaway-tail cap` — and never also the `suspiciously fast` note, which would contradict it (that note is reserved for genuinely short, uncapped units).
- Trimming, cap hits and aborts all appear in `notes`; `trimmedSeconds` is an additive field on `speak_done`.

## Streaming model

- the daemon splits the whole utterance up front (all segments) and counts display sentences;
- a worker thread generates while the calling thread writes into one open `sounddevice` output stream (queue depth 4 while streaming, 1 otherwise);
- with `--stream true` (default) the first 0.16 s chunk is audible as soon as the model produces it, so the first-sentence cap is not applied; with `--stream false` a whole unit is generated before playback and `--first-sentence-max-chars` applies;
- the stream opens at the **model's reported** sample rate (44.1 kHz) and falls back to the device's default rate with linear resampling only if the host API refuses it;
- `speak_done` waits for the device buffer to drain; `sentence_end` is emitted per unit once all of that unit's samples have been written, in both modes.

## Model lifecycle and VRAM

- The model is loaded once, lazily (or with `--preload true`), and stays resident across calls; `modelLoadMs` is non-zero only on the load call and `speak_start.modelWasLoaded` is `true` after.
- After **every** unit the backend drops the waveform and runs `torch.cuda.synchronize()` + `torch.cuda.empty_cache()`; every tenth unit it also runs `gc.collect()` and `torch.cuda.reset_peak_memory_stats()`.
- A CUDA OOM (`torch.cuda.OutOfMemoryError`, or any `RuntimeError` whose message says "out of memory") clears the cache, unloads the model so the next call starts on a clean device, and fails that call as `GENERATE_FAILED` with the CUDA text; the recovery emits `unloaded` with `reason:"oom"` and `id:null`.
- `unload`, `--idle-unload-sec`, and process exit release the model with `del` + `gc.collect()` + `torch.cuda.synchronize()` + `torch.cuda.empty_cache()` + `torch.cuda.ipc_collect()`, and report the freed MB. The idle timer emits `unloaded` with `reason:"idle"`.
- `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True` is set before torch is imported.

## Tests

```powershell
Set-Location <workspace root>
uv run --no-project --python "<PYTHON>" `
  --with pytest python -m pytest voice-plugin\python\tests -q
```

The suite needs no GPU and no `voxcpm` install: `tests/fake_voxcpm` stands in for the model package (load-once, streaming chunks, runaway tail, OOM, bad response, slow load, import failure). Coverage: normalization/sentence splitting/script classification, the single-reference-voice rules (exactly one clip required, transcript discovery/decoding/cap, empty and missing transcripts, stale rescans), emotion-label pass-through on the protocol events, pipeline overlap and error paths with synthetic audio, silence trimming and the runaway caps, the script contract (mostly-unsupported text refused, minority script noted, ignored `language` keys), the wire protocol of a real daemon subprocess (ready including the unusable-folder failure, ping, voices, reload, stats, unload, malformed JSON, unknown op, validation errors, empty segments, NO_VOICES, MODEL_LOAD_FAILED, `shutdown`, stdin EOF), the whole model path with the fake engine (load once, per-unit generation, save, unload, idle unload, OOM), and the engine guards (audio limit, wall-clock limit, generator close).

GPU end-to-end (plays audio, loads the real model once, prints every event):

```powershell
cd voice-plugin\python
& "<TTS_RUNTIME_ROOT>\.venv-vox\Scripts\python.exe" tests\e2e_speak.py
```

`--no-play` verifies the protocol without touching the speakers, `--save` writes one WAV per segment into the cache dir, and `--gate-db`/`--max-trailing-ms` override the hygiene settings for a stricter run.

## Measured on this box (RTX 5060 Laptop 8 GB)

| Metric | Value |
| --- | --- |
| cold load (`modelLoadMs`, includes the constructor's warmup generation) | 6.4-7.7 s |
| first streaming chunk | 128-249 ms |
| streaming chunk | 7056 samples = 0.16 s @ 44.1 kHz |
| RTF (cfg 2.7, timesteps 10 — the shipped default) | 0.79-0.80 while streaming |
| RTF (earlier probe with more timesteps, before the default was calibrated) | 1.07-1.54 |
| VRAM after load | 2193 MB allocated / 2374 MB reserved |
| VRAM peak during generation | 2732 MB allocated / 3464 MB reserved |
| after `unload` | 9 MB allocated / 22 MB reserved |

At the shipped default (cfg 2.7, timesteps 10) the engine runs slightly faster than real time (RTF ~0.8); the earlier probe with more timesteps measured 1.07-1.54. Either way units stay short (60-character cap) and the streaming path matters: the first chunk plays long before a whole unit exists.

## Known limitations

- VoxCPM 1.5 speaks Chinese and English only, has no language/style/rate control, and takes its timbre only from the reference clip; there is no instruction-prefix control (that is VoxCPM2).
- The transcript of the reference clip is required — VoxCPM clones by continuing the clip, so the engine cannot speak without the exact text.
- No prompt-cache reuse: the engine re-encodes the reference clip inside every `generate*` call, and the A/B measured only a ~1.5% RTF gain for caching it.
- The engine's own bad-case retry does not run while streaming, so `max_len` plus the audio and wall-clock guards are the only runaway protection there.
- Non-WAV reference files need `soundfile`/`torchaudio` for duration probing; WAV uses the stdlib.
- One utterance at a time: requests arriving during a `speak` are answered after it finishes.
