"""The single reference voice: one reference clip plus the transcript it says.

PROTOCOL.md §5. The engine clones exactly one recording, so ``--voices-dir`` names
the folder that holds it: one audio file (``<stem>.wav`` preferred, also
``.mp3/.flac/.m4a/.ogg/.opus``) together with a same-stem ``<stem>.txt`` holding
exactly what that clip says. The engine always speaks with this one voice.

Per-segment ``emotion`` values are labels: they are carried on the protocol events
for the Live2D renderer to pick an expression, and they never select a different
reference recording. ``默认`` is the label used when a request names none.

Pure stdlib (``wave`` for WAV duration); optional ``soundfile`` / ``torchaudio``
are used only when installed, to probe non-WAV references.
"""

from __future__ import annotations

import os
import sys
import unicodedata
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Tuple

#: Reference audio formats, in the order the docs recommend them.
AUDIO_EXTS = (".wav", ".mp3", ".flac", ".m4a", ".ogg", ".opus")

#: The transcript lives beside the audio with the same stem.
TEXT_EXTS = (".txt",)

#: The label used when a request names no emotion.
DEFAULT_EMOTION = "默认"

#: A transcript longer than this many characters is ignored.
REF_TEXT_MAX_CHARS = 2000

#: A transcript file is read whole; anything past this is far larger than any
#: encodable 2000-character text and is ignored without being buffered.
TEXT_READ_LIMIT_BYTES = 256 * 1024

BOM_UTF8 = b"\xef\xbb\xbf"
BOM_UTF16 = (b"\xff\xfe", b"\xfe\xff")


def nfc(value: str) -> str:
    """Unicode NFC normalization for file names and labels."""
    return unicodedata.normalize("NFC", value)


def probe_audio(path: str) -> Tuple[Optional[float], Optional[int]]:
    """Return ``(duration_seconds, sample_rate)`` for the reference audio file.

    Uses the stdlib ``wave`` module for PCM WAV and falls back to soundfile /
    torchaudio when importable. Unknown formats yield ``(None, None)`` rather than
    failing the scan: the duration is reporting only, the engine probes the clip
    itself when it loads it.
    """
    lower = path.lower()
    if lower.endswith(".wav"):
        try:
            import wave

            with wave.open(path, "rb") as handle:
                rate = handle.getframerate()
                frames = handle.getnframes()
                if rate:
                    return (frames / float(rate), rate)
        except Exception:  # noqa: BLE001 - fall through to the optional probes
            pass
    for probe in (_probe_soundfile, _probe_torchaudio):
        try:
            result = probe(path)
        except Exception:  # noqa: BLE001 - a missing/broken decoder is not fatal
            result = None
        if result:
            return result
    return (None, None)


def _probe_soundfile(path: str) -> Optional[Tuple[float, int]]:
    import soundfile  # type: ignore

    info = soundfile.info(path)
    rate = int(info.samplerate)
    return (float(info.frames) / rate, rate)


def _probe_torchaudio(path: str) -> Optional[Tuple[float, int]]:
    import torchaudio  # type: ignore

    info = torchaudio.info(path)
    rate = int(info.sample_rate)
    return (float(info.num_frames) / rate, rate)


@dataclass(frozen=True)
class Voice:
    """The reference voice: one audio clip with its resolved transcript (if any)."""

    name: str
    path: str
    duration_sec: Optional[float]
    sample_rate: Optional[int]
    ref_text: Optional[str]
    ref_text_source: Optional[str]  # "text" | None
    mtime: float
    ref_text_path: Optional[str] = None

    @property
    def via(self) -> str:
        """``text`` when the transcript was read from the file, else ``none``."""
        return self.ref_text_source or "none"

    def to_event(self) -> Dict[str, Any]:
        """The ``voices`` event entry for this voice (PROTOCOL.md §6)."""
        return {
            "name": self.name,
            "file": self.path,
            "durationSec": round(self.duration_sec, 3) if self.duration_sec is not None else None,
            "sampleRate": self.sample_rate,
            "refText": bool(self.ref_text),
            "via": self.via,
        }


@dataclass(frozen=True)
class Resolution:
    """The label a request asked for, resolved to the one reference voice."""

    voice: Optional[Voice]
    requested: str
    fallback: bool
    via: str  # "reference" | "none"


class VoiceLibrary:
    """Reads the reference-voice folder and resolves requested labels to that voice.

    The folder must contain exactly one audio file plus its same-stem ``.txt``
    transcript. Anything else leaves :attr:`error` set with a user-facing message
    (0 or more than 1 audio file, or a missing folder); :meth:`scan` never raises,
    so the daemon can report the problem on the protocol instead of crashing.
    Labels never change the voice: :meth:`resolve` always returns the one voice and
    echoes the requested label.
    """

    def __init__(
        self,
        voices_dir: str,
        default_emotion: str = DEFAULT_EMOTION,
        log: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.voices_dir = voices_dir
        self.requested_default = nfc(str(default_emotion or DEFAULT_EMOTION).strip())
        self._log = log or _stderr_warn
        if self.requested_default != DEFAULT_EMOTION:
            self._log(
                f"--default-emotion {self.requested_default!r} accepted; the one reference voice "
                f"is reported with the default label {DEFAULT_EMOTION!r}"
            )

        self._voice: Optional[Voice] = None
        self._error: str = ""
        self._scanned = False
        self._scanning = False
        self._signature: Any = _UNSET

    # ------------------------------------------------------------------ scan

    @property
    def error(self) -> str:
        """Why the folder does not hold a usable reference voice; empty when it does."""
        self.scan()
        return self._error

    @property
    def voice(self) -> Optional[Voice]:
        """The single reference voice, or None when the folder is not usable."""
        self.scan()
        return self._voice

    def scan(self, force: bool = False) -> bool:
        """Re-read the folder when its contents changed.

        Returns True when the resolved voice (or the failure) changed. The
        directory listing, every audio file's size/mtime and every transcript's
        size/mtime form the signature, so adding a second audio file, deleting the
        transcript or editing it in place is picked up on the next scan without a
        daemon restart.
        """
        if self._scanning:
            return False
        self._scanning = True
        try:
            entries = _list_files(self.voices_dir)
            signature = _signature(entries)
            if not force and self._scanned and signature == self._signature:
                return False
            self._signature = signature
            self._scanned = True
            self._rebuild(entries)
            return True
        finally:
            self._scanning = False

    def _rebuild(self, entries: List[Tuple[str, os.stat_result]]) -> None:
        self._voice = None
        self._error = ""
        if not os.path.isdir(self.voices_dir):
            self._error = (
                f"the reference voice folder {self.voices_dir!r} does not exist; "
                f"--voices-dir must name a folder holding exactly one reference voice"
            )
            self._log(f"reference voice unusable: {self._error}")
            return

        audio = [entry for entry, _stat in entries if os.path.splitext(entry)[1].lower() in AUDIO_EXTS]
        audio.sort(key=lambda name: (name.casefold(), name))
        if not audio:
            self._error = (
                f"no reference voice in {self.voices_dir!r}: exactly one reference voice is "
                f"required — put exactly one audio file (<name>.wav preferred) plus its "
                f"same-stem .txt transcript there"
            )
            self._log(f"reference voice unusable: {self._error}")
            return
        if len(audio) > 1:
            shown = ", ".join(audio[:5])
            if len(audio) > 5:
                shown += ", …"
            self._error = (
                f"exactly one reference voice is required: {self.voices_dir!r} contains "
                f"{len(audio)} audio files ({shown}); keep one audio file and its same-stem "
                f".txt transcript"
            )
            self._log(f"reference voice unusable: {self._error}")
            return

        entry = audio[0]
        stats = dict(entries)
        path = os.path.join(self.voices_dir, entry)
        stem = os.path.splitext(entry)[0]
        text_entry = _match_text_entry(entries, stem)
        if text_entry is not None:
            ref_text_path = os.path.join(self.voices_dir, text_entry)
            ref_text = self._read_reference_text(ref_text_path)
            source = "text" if ref_text else None
        else:
            ref_text_path = os.path.join(self.voices_dir, stem + ".txt")
            ref_text = None
            source = None
        duration, rate = probe_audio(path)
        self._voice = Voice(
            name=DEFAULT_EMOTION,
            path=path,
            duration_sec=duration,
            sample_rate=rate,
            ref_text=ref_text,
            ref_text_source=source,
            mtime=stats[entry].st_mtime,
            ref_text_path=ref_text_path,
        )
        duration_text = f"{duration:.2f}s" if duration is not None else "duration unknown"
        self._log(
            f"reference voice: {entry} in {self.voices_dir} ({duration_text}); "
            f"transcript {'loaded' if ref_text else 'missing'}"
        )

    def _read_reference_text(self, path: str) -> Optional[str]:
        """Read the transcript, or None when it carries no usable text.

        A missing, empty, undecodable or over-long transcript all leave the voice
        without reference text; the engine refuses to clone without it, naming this
        path, rather than continuing the clip with the wrong text.
        """
        try:
            with open(path, "rb") as handle:
                raw = handle.read(TEXT_READ_LIMIT_BYTES + 1)
        except OSError as exc:
            self._log(f"reference transcript {path} is not readable: {exc!r}")
            return None
        if len(raw) > TEXT_READ_LIMIT_BYTES:
            self._log(f"reference transcript {path} is larger than {TEXT_READ_LIMIT_BYTES} bytes")
            return None
        decoded = _decode_reference_text(raw)
        if decoded is None:
            self._log(f"reference transcript {path} is not decodable as UTF-8/UTF-16/CP936")
            return None
        text = decoded.strip()
        if not text:
            self._log(f"reference transcript {path} is empty; its text is required")
            return None
        if len(text) > REF_TEXT_MAX_CHARS:
            self._log(f"reference transcript {path} exceeds {REF_TEXT_MAX_CHARS} characters")
            return None
        return text

    # --------------------------------------------------------------- queries

    @property
    def effective_default(self) -> Optional[str]:
        """The default label, or None when the folder holds no reference voice."""
        self.scan()
        return DEFAULT_EMOTION if self._voice is not None else None

    @property
    def default_source(self) -> str:
        """``voice`` when the single reference voice is usable, else ``none``."""
        self.scan()
        return "voice" if self._voice is not None else "none"

    def names(self) -> List[str]:
        """The available emotion labels: exactly the one default label."""
        self.scan()
        return [DEFAULT_EMOTION] if self._voice is not None else []

    def all(self) -> List[Voice]:
        self.scan()
        return [self._voice] if self._voice is not None else []

    def emotions_event(self) -> List[Dict[str, Any]]:
        return [voice.to_event() for voice in self.all()]

    def label(self, requested: Optional[str]) -> str:
        """Normalize one requested emotion to its label; blank means ``默认``."""
        raw = "" if requested is None else str(requested).strip()
        return nfc(raw) if raw else DEFAULT_EMOTION

    def resolve(self, requested: Optional[str]) -> Resolution:
        """Resolve a requested emotion label; the reference voice never changes."""
        self.scan()
        return Resolution(
            voice=self._voice,
            requested=self.label(requested),
            fallback=False,
            via="reference" if self._voice is not None else "none",
        )


_UNSET = object()


def _list_files(directory: str) -> List[Tuple[str, os.stat_result]]:
    """Regular files directly inside *directory*, sorted by name (empty on error)."""
    try:
        names = sorted(os.listdir(directory))
    except OSError:
        return []
    files: List[Tuple[str, os.stat_result]] = []
    for name in names:
        path = os.path.join(directory, name)
        try:
            info = os.stat(path)
        except OSError:
            continue
        if os.path.isfile(path):
            files.append((name, info))
    return files


def _signature(entries: List[Tuple[str, os.stat_result]]) -> Any:
    """What a scan depends on: every file's name, size and modification time."""
    return tuple((name, info.st_mtime_ns, info.st_size) for name, info in entries)


def _match_text_entry(entries: List[Tuple[str, os.stat_result]], stem: str) -> Optional[str]:
    """The ``<stem>.txt`` entry beside the audio, matched case-insensitively and NFC-normalized."""
    wanted = nfc(stem).casefold()
    for entry, _info in entries:
        candidate_stem, ext = os.path.splitext(entry)
        if ext.lower() in TEXT_EXTS and nfc(candidate_stem).casefold() == wanted:
            return entry
    return None


def _decode_reference_text(raw: bytes) -> Optional[str]:
    """Decode transcript bytes: a BOM selects its encoding, then UTF-8, then CP936.

    Returns None when the bytes decode as neither.
    """
    if raw.startswith(BOM_UTF8):
        try:
            return raw[len(BOM_UTF8) :].decode("utf-8")
        except UnicodeDecodeError:
            return None
    if raw.startswith(BOM_UTF16):
        try:
            return raw.decode("utf-16")
        except UnicodeDecodeError:
            return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        pass
    try:
        return raw.decode("cp936")
    except UnicodeDecodeError:
        return None


def _stderr_warn(message: str) -> None:
    """Default log sink: without a hook, diagnostics still reach stderr."""
    print(f"tts voices: {message}", file=sys.stderr)
