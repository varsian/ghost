"""``VoxCPMBackend`` behaviour against a faked ``voxcpm`` package (no GPU).

Covers the engine seam the daemon depends on: load-once with the real constructor
keywords, the continuation-clone arguments (prompt clip + its transcript), the
per-unit token cap, incremental streaming with the generator closed on every path,
the missing-reference-text refusal, CUDA OOM recovery, unload, and the device
contract (voxcpm 1.5.0's constructor takes no ``device``).
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
PYTHON_DIR = os.path.dirname(HERE)
FAKE_VOX = os.path.join(HERE, "fake_voxcpm")
sys.path.insert(0, FAKE_VOX)
sys.path.insert(0, PYTHON_DIR)

from ttslib import runtime  # noqa: E402

FAKE_ENV_KEYS = (
    "FAKE_VOX_MARKER",
    "FAKE_VOX_LOAD_SEC",
    "FAKE_VOX_RUNAWAY",
    "FAKE_VOX_LONG_TAIL",
    "FAKE_VOX_OOM",
    "FAKE_VOX_BAD_RESPONSE",
    "FAKE_VOX_IMPORT_FAIL",
    "FAKE_VOX_SAMPLE_RATE",
)


class FakeVoice:
    """Stand-in for ``ttslib.voices.Voice`` with just the fields the engine reads."""

    def __init__(self, path: str, name: str = "默认", ref_text: str = "你好呀", mtime: float = 1.0) -> None:
        self.path = path
        self.name = name
        self.ref_text = ref_text
        self.mtime = mtime
        self.language = ""


class BackendCase(unittest.TestCase):
    """Base case wiring the fake package, its marker file, and a voice clip."""

    def setUp(self) -> None:
        self._saved_env = {key: os.environ.get(key) for key in FAKE_ENV_KEYS}
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name
        self.marker = os.path.join(self.dir, "marker.json")
        self.voice_path = os.path.join(self.dir, "默认.wav")
        with open(self.voice_path, "wb") as handle:
            handle.write(b"RIFF0000WAVEfmt ")
        self.set_fake(FAKE_VOX_MARKER=self.marker)

    def tearDown(self) -> None:
        for key, value in self._saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        sys.modules.pop("voxcpm", None)
        self.tmp.cleanup()

    def set_fake(self, **env: object) -> None:
        """Set fake-package environment knobs and force the next import to see them."""
        for key in FAKE_ENV_KEYS:
            os.environ.pop(key, None)
        for key, value in env.items():
            os.environ[key] = str(value)
        sys.modules.pop("voxcpm", None)

    def host(self, **kwargs: object) -> runtime.ModelHost:
        options = {
            "model_dir": os.path.join(self.dir, "model"),
            "device": "auto",
            "cfg_value": 2.7,
            "timesteps": 15,
            "normalize": True,
            "optimize": False,
        }
        options.update(kwargs)
        return runtime.ModelHost(**options)

    def calls(self) -> dict:
        if not os.path.exists(self.marker):
            return {}
        with open(self.marker, "r", encoding="utf-8") as handle:
            return json.load(handle)

    def voice(self, ref_text: str = "你好呀") -> FakeVoice:
        return FakeVoice(self.voice_path, ref_text=ref_text)


class LoadTests(BackendCase):
    def test_load_once_uses_the_real_constructor_keywords(self) -> None:
        host = self.host()
        load_ms, was_loaded = host.ensure_loaded()
        self.assertFalse(was_loaded)
        self.assertGreaterEqual(load_ms, 0)
        self.assertEqual(host.engine, "voxcpm")
        self.assertEqual(host.sample_rate, 44100)
        calls = self.calls()
        self.assertEqual(calls.get("init"), 1)
        self.assertEqual(calls.get("init.voxcpm_model_path"), os.path.join(self.dir, "model"))
        self.assertFalse(calls.get("init.enable_denoiser"))
        self.assertIsNone(calls.get("init.zipenhancer_model_path"))
        self.assertFalse(calls.get("init.optimize"))

    def test_second_load_reports_already_loaded_and_never_reloads(self) -> None:
        host = self.host()
        host.ensure_loaded()
        again = host.ensure_loaded()
        self.assertEqual(again, (0, True))
        self.assertEqual(self.calls().get("init"), 1)

    def test_unload_then_reload_is_a_fresh_load(self) -> None:
        host = self.host()
        host.ensure_loaded()
        host.unload()
        self.assertFalse(host.is_loaded)
        self.assertEqual(host.sample_rate, 0)
        host.ensure_loaded()
        self.assertEqual(self.calls().get("init"), 2)

    def test_import_failure_is_reported(self) -> None:
        self.set_fake(FAKE_VOX_IMPORT_FAIL=1)
        host = self.host()
        with self.assertRaises(ImportError):
            host.ensure_loaded()
        self.assertFalse(host.is_loaded)

    def test_missing_sample_rate_is_refused(self) -> None:
        self.set_fake(FAKE_VOX_MARKER=self.marker, FAKE_VOX_SAMPLE_RATE=0)
        host = self.host()
        with self.assertRaises(RuntimeError):
            host.ensure_loaded()

    def test_non_cuda_device_is_refused(self) -> None:
        host = self.host(device="cpu")
        with self.assertRaises(RuntimeError) as caught:
            host.ensure_loaded()
        self.assertIn("cuda", str(caught.exception))


class GenerateTests(BackendCase):
    def test_generate_passes_prompt_pair_parameters_and_cap(self) -> None:
        host = self.host()
        host.ensure_loaded()
        voice = self.voice()
        audio, sample_rate = host.generate("你好，世界。", voice)
        self.assertEqual(sample_rate, 44100)
        self.assertGreater(len(audio), 0)
        calls = self.calls()
        self.assertEqual(calls.get("generate"), 1)
        self.assertEqual(calls.get("generate.prompt_wav_path"), self.voice_path)
        self.assertEqual(calls.get("generate.prompt_text"), "你好呀")
        self.assertEqual(calls.get("generate.cfg_value"), 2.7)
        self.assertEqual(calls.get("generate.inference_timesteps"), 15)
        self.assertTrue(calls.get("generate.normalize"))
        self.assertTrue(calls.get("generate.retry_badcase"))
        expected_cap = max(96, int(round(len("你好，世界。") * 3.2)) + 36)
        self.assertEqual(calls.get("generate.max_len"), min(512, expected_cap))

    def test_missing_reference_text_is_refused_before_any_generation(self) -> None:
        host = self.host()
        host.ensure_loaded()
        with self.assertRaises(RuntimeError) as caught:
            host.generate("你好。", self.voice(ref_text=""))
        message = str(caught.exception)
        self.assertIn(runtime.reference_text_path(self.voice()), message)
        self.assertNotIn("generate", self.calls())

    def test_stream_yields_model_chunks_and_closes_the_generator(self) -> None:
        host = self.host()
        host.ensure_loaded()
        chunks = list(host.stream("你好。", self.voice()))
        self.assertTrue(chunks)
        for chunk, rate in chunks:
            self.assertEqual(rate, 44100)
            self.assertGreater(len(chunk), 0)
        self.assertEqual(self.calls().get("stream_closed"), 1)

    def test_stream_guard_stops_a_runaway_tail(self) -> None:
        self.set_fake(FAKE_VOX_MARKER=self.marker, FAKE_VOX_RUNAWAY=1)
        host = self.host(audio_multiple=1.0, audio_floor_sec=0.5)
        host.ensure_loaded()
        seconds = sum(len(chunk) / float(rate) for chunk, rate in host.stream("你好。", self.voice()))
        self.assertLess(seconds, 60.0)
        self.assertIn("aborted", host.take_stream_note())

    def test_wall_clock_guard_stops_a_long_stream(self) -> None:
        self.set_fake(FAKE_VOX_MARKER=self.marker, FAKE_VOX_LONG_TAIL=1)
        # The audio cap is pushed out of the way so only the wall-clock guard can fire.
        host = self.host(max_generation_sec=0.05, audio_floor_sec=10000.0, audio_multiple=1000.0)
        host.ensure_loaded()
        seconds = sum(len(chunk) / float(rate) for chunk, rate in host.stream("你好。", self.voice()))
        self.assertLess(seconds, 40.0)
        self.assertIn("wall time", host.take_stream_note())

    def test_bad_response_becomes_a_generate_failure(self) -> None:
        self.set_fake(FAKE_VOX_MARKER=self.marker, FAKE_VOX_BAD_RESPONSE=1)
        host = self.host()
        host.ensure_loaded()
        with self.assertRaises(Exception):
            host.generate("你好。", self.voice())


class VramTests(BackendCase):
    def test_oom_unloads_the_model_once_and_reports_freed_mb(self) -> None:
        self.set_fake(FAKE_VOX_MARKER=self.marker, FAKE_VOX_OOM=1)
        host = self.host()
        host.ensure_loaded()
        self.assertTrue(host.is_loaded)
        with self.assertRaises(runtime.ModelOutOfMemory) as caught:
            host.generate("你好。", self.voice())
        self.assertIn("out of memory", str(caught.exception).lower())
        self.assertFalse(host.is_loaded)
        freed = host.take_oom_freed()
        self.assertIsInstance(freed, float)
        self.assertIsNone(host.take_oom_freed())

    def test_stats_report_engine_sample_rate_and_vram_keys(self) -> None:
        host = self.host()
        host.ensure_loaded()
        stats = host.stats()
        for key in (
            "modelLoaded",
            "modelLoadMs",
            "warmupMs",
            "generations",
            "device",
            "engine",
            "streaming",
            "sampleRate",
            "optimize",
            "allocatedMb",
            "reservedMb",
            "peakMb",
            "freeMb",
        ):
            self.assertIn(key, stats)
        self.assertEqual(stats["engine"], "voxcpm")
        self.assertEqual(stats["sampleRate"], 44100)
        self.assertNotIn("voicesCached", stats)

    def test_every_tenth_generation_runs_the_deep_cleanup(self) -> None:
        host = self.host()
        host.ensure_loaded()
        backend = host._backend
        self.assertIsNotNone(backend)
        deep_calls: list[bool] = []
        backend._release_device_cache = lambda deep=False: deep_calls.append(deep)
        for _ in range(host._backend.DEEP_CLEANUP_EVERY):
            host.generate("你好。", self.voice())
        self.assertEqual(deep_calls[-1], True)
        self.assertEqual(deep_calls.count(True), 1)


if __name__ == "__main__":
    unittest.main()
