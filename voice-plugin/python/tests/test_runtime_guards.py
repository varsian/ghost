"""Runtime guards that keep the protocol stream clean and VRAM bookkeeping sane.

No GPU required: these cover ``quiet_stdout``, output splitting, allocator config
and the WAV writer's interface with ``ttslib.pipeline``.
"""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ttslib import runtime  # noqa: E402
from ttslib.events import EventWriter  # noqa: E402


def _has_numpy() -> bool:
    try:
        import numpy  # type: ignore  # noqa: F401
    except Exception:  # noqa: BLE001 - optional dependency
        return False
    return True


class QuietStdoutTests(unittest.TestCase):
    def test_library_prints_are_diverted_to_stderr(self) -> None:
        out, err = io.StringIO(), io.StringIO()
        stdout, stderr = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = out, err
        try:
            with runtime.quiet_stdout():
                print("********\nWarning: flash-attn is not installed.")
            print("after", file=sys.stdout)
        finally:
            sys.stdout, sys.stderr = stdout, stderr
        self.assertEqual(out.getvalue(), "after\n")
        self.assertIn("flash-attn", err.getvalue())


class EventWriterPurityTests(unittest.TestCase):
    def test_events_go_to_the_captured_stream_even_after_stdout_is_replaced(self) -> None:
        """The daemon points sys.stdout at stderr; events must still use real stdout."""
        buffer = io.BytesIO()
        stdout, stderr = sys.stdout, sys.stderr
        sys.stdout, sys.stderr = stdout, io.StringIO()
        try:
            writer = EventWriter(stdout=buffer)
            sys.stdout = sys.stderr  # daemon's import-time protection
            writer.event("ready", None, ok=True, defaultEmotion="默认")
            print("library chatter")
        finally:
            sys.stdout, sys.stderr = stdout, stderr
        lines = buffer.getvalue().decode("utf-8").splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0])["event"], "ready")
        self.assertEqual(json.loads(lines[0])["defaultEmotion"], "默认")


class OutOfMemoryDetectionTests(unittest.TestCase):
    def test_detects_allocator_failures_however_they_are_reported(self) -> None:
        class OutOfMemoryError(RuntimeError):
            pass

        self.assertTrue(runtime.is_out_of_memory(RuntimeError("CUDA out of memory. Tried to allocate 2.00 GiB")))
        self.assertTrue(runtime.is_out_of_memory(RuntimeError("CUDA error: out of memory")))
        self.assertTrue(runtime.is_out_of_memory(OutOfMemoryError("boom")))
        self.assertFalse(runtime.is_out_of_memory(RuntimeError("voxcpm returned no audio")))


class ReferenceTextPathTests(unittest.TestCase):
    def test_maps_a_reference_clip_to_its_transcript(self) -> None:
        class Voice:
            path = r"C:\voices\reference.wav"

        self.assertEqual(runtime.reference_text_path(Voice()), r"C:\voices\reference.txt")


class AudioLoadFallbackTests(unittest.TestCase):
    def test_patches_torchaudio_when_torchcodec_is_missing(self) -> None:
        import importlib.util

        if importlib.util.find_spec("torchaudio") is None:
            self.skipTest("torchaudio is not installed")
        if importlib.util.find_spec("torchcodec") is not None:
            self.skipTest("torchcodec is installed, so no fallback is needed")
        import soundfile  # type: ignore  # noqa: F401 - the fallback decodes through it
        import torchaudio

        original = torchaudio.load
        try:
            status = runtime.install_torchaudio_soundfile_fallback()
            self.assertIn("soundfile", status)
            self.assertIsNot(torchaudio.load, original)
        finally:
            torchaudio.load = original


class CudaAllocConfigTests(unittest.TestCase):
    def test_sets_expandable_segments_once(self) -> None:
        saved = os.environ.pop("PYTORCH_CUDA_ALLOC_CONF", None)
        try:
            value = runtime.configure_cuda_alloc()
            self.assertEqual(value, "expandable_segments:True")
            os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "max_split_size_mb:64"
            value = runtime.configure_cuda_alloc()
            self.assertEqual(value, "max_split_size_mb:64,expandable_segments:True")
            self.assertEqual(runtime.configure_cuda_alloc(), value)
        finally:
            if saved is None:
                os.environ.pop("PYTORCH_CUDA_ALLOC_CONF", None)
            else:
                os.environ["PYTORCH_CUDA_ALLOC_CONF"] = saved


class SaveWavTests(unittest.TestCase):
    @unittest.skipUnless(_has_numpy(), "numpy is not installed")
    def test_writes_pcm16_mono(self) -> None:
        import numpy as np  # type: ignore

        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "nested", "out.wav")
            samples = np.zeros(int(0.25 * 24000), dtype=np.float32)
            saved = runtime.save_wav(path, samples, 24000)
            self.assertTrue(os.path.isfile(saved))
            import wave

            with wave.open(saved, "rb") as handle:
                self.assertEqual(handle.getnchannels(), 1)
                self.assertEqual(handle.getsampwidth(), 2)
                self.assertEqual(handle.getframerate(), 24000)
                self.assertEqual(handle.getnframes(), int(0.25 * 24000))


class ResampleTests(unittest.TestCase):
    @unittest.skipUnless(_has_numpy(), "numpy is not installed")
    def test_doubles_the_sample_count(self) -> None:
        import numpy as np  # type: ignore

        source = np.linspace(0.0, 1.0, 240, dtype=np.float32)
        doubled = runtime.resample_linear(source, 24000, 48000)
        self.assertEqual(doubled.shape[0], 480)
        same = runtime.resample_linear(source, 24000, 24000)
        self.assertTrue(np.array_equal(same, source))


if __name__ == "__main__":
    unittest.main()
