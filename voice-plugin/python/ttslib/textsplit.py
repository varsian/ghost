"""Text normalization, punctuation rules, sentence splitting and language units.

Pure stdlib: no torch, no numpy, no sounddevice, so this module is importable and
testable before the GPU runtime exists.

Invariant (PROTOCOL.md §7): every fragment returned by :func:`split_sentences`,
:func:`split_long` or :func:`cap_first_sentence`, and every unit returned by
:func:`plan_units` or :func:`split_units_by_language`, is at most ``max_chars``
characters long whenever ``max_chars > 0``. ``max_chars <= 0`` disables the cap
(no upper bound). The merge bound is clamped to ``max_chars`` when the cap is
positive, so merging can never push a unit past it.
"""

from __future__ import annotations

import re
from typing import Callable, List, Optional, Tuple

# --------------------------------------------------------------------------
# Punctuation rules table (rev 7)
# --------------------------------------------------------------------------

#: Characters that END a sentence; the terminator stays attached to it.
TERMINATORS = "。！？!?…"
#: Half-width full stop: a terminator only when it is not a decimal/version dot
#: (see :func:`_dot_breaks_sentence`).
DOT = "."
#: Characters that end a *clause*: a clause is a language-detection and
#: balanced-split boundary, never a sentence boundary. ``；;`` was demoted from
#: the terminator set in rev 7 so a semicolon-joined sentence stays one unit.
CLAUSE_BREAKS = "，,、：:；;"
#: Candidates for clause breaks that are suppressed when they appear in pairs
#: (an inserted phrase), per the rev-7 rules table.
DASH_MARKS = "——"
#: Alternative name for the comma-like clause breaks; kept for callers that split
#: long text at soft points.
SOFT_BREAKS = "，,、：:"
#: Characters that stay attached to the sentence/clause they *follow* even
#: though they are not terminators themselves (closing quotes/brackets).
CLOSERS = "”’\"'」』）)】》〉"

#: Characters a half-width ``.`` may be followed by to still end a sentence.
_CJK_RANGES = (
    (0x2E80, 0x2EFF),
    (0x3000, 0x303F),
    (0x3040, 0x30FF),
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xAC00, 0xD7A3),
    (0xF900, 0xFAFF),
    (0xFF00, 0xFFEF),
    (0x20000, 0x2FA1F),
)
#: Scripts whose per-character speaking rate the `chars-per-second` baseline
#: describes: ideographs (Chinese), kana (Japanese) and hangul (Korean).
_CJK_SCRIPT_RANGES = (
    (0x3041, 0x30FF),
    (0xFF66, 0xFF9D),
    (0x1100, 0x11FF),
    (0x3130, 0x318F),
    (0xAC00, 0xD7A3),
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xF900, 0xFAFF),
    (0x20000, 0x2FA1F),
)
#: ASCII letters and digits: a cut between two of them may split a word, so the
#: balanced splitter nudges it to the nearest non-alphanumeric boundary.
_ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
#: How far the balanced splitter may move a cut looking for a word boundary.
_WORD_SHIFT_LIMIT = 4

_FENCE_RE = re.compile(r"^\s*(```|~~~)")
_STRONG_RE = re.compile(r"\*\*(.+?)\*\*", re.DOTALL)
_UNDERSCORE_RE = re.compile(r"(?<![\w])__(.+?)__(?![\w])", re.DOTALL)
_CODE_RE = re.compile(r"`([^`]*)`")
_CONTROL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
_SPACE_RE = re.compile(r"[ \t\u3000]+")
_ELLIPSIS_RE = re.compile(r"\.{2,}")
_REPEAT_PUNCT_RE = re.compile(r"([。！？，、：；!?…])\1+")
_MIXED_TERM_RE = re.compile(r"([。！？!?…])(?:[。！？!?…])+")


def is_cjk(ch: str) -> bool:
    """True for a CJK ideograph, kana, hangul or full-width form."""
    if not ch:
        return False
    code = ord(ch)
    return any(low <= code <= high for low, high in _CJK_RANGES)


def _is_alnum(ch: str) -> bool:
    return len(ch) == 1 and ch in _ALNUM


def normalize_text(raw: Optional[str]) -> str:
    """Normalize one segment's text for synthesis.

    Removes Markdown fences/emphasis markers and control characters, collapses
    horizontal whitespace and repeated punctuation, turns ``...`` into ``…``, and
    keeps newlines (they are sentence boundaries). Returns "" for empty input.
    """
    if raw is None:
        return ""
    text = str(raw).replace("\r\n", "\n").replace("\r", "\n")
    text = text.replace("\u200b", "").replace("\ufeff", "")
    text = _CONTROL_RE.sub("", text)

    kept: List[str] = []
    for line in text.split("\n"):
        if _FENCE_RE.match(line.strip()):
            continue
        kept.append(line)
    text = "\n".join(kept)

    text = _STRONG_RE.sub(r"\1", text)
    text = _UNDERSCORE_RE.sub(r"\1", text)
    text = _CODE_RE.sub(r"\1", text)

    text = _SPACE_RE.sub(" ", text)
    text = "\n".join(line.strip() for line in text.split("\n"))
    text = re.sub(r"\n{2,}", "\n", text)

    text = _ELLIPSIS_RE.sub("…", text)
    text = _REPEAT_PUNCT_RE.sub(r"\1", text)
    text = _MIXED_TERM_RE.sub(r"\1", text)
    return text.strip()


def _dot_breaks_sentence(text: str, index: int) -> bool:
    """Whether the ``.`` at ``index`` ends a sentence (rev-7 guard).

    The dot must not follow a digit (``3.5``, ``v1.2``) and must be followed by
    end-of-text, whitespace, a closing quote/bracket, or a CJK character.
    """
    previous = text[index - 1] if index > 0 else ""
    following = text[index + 1] if index + 1 < len(text) else ""
    if previous.isdigit():
        return False
    return following == "" or following.isspace() or following in CLOSERS or is_cjk(following)


def has_cjk_script(text: Optional[str]) -> bool:
    """True when ``text`` contains an ideograph, kana or hangul character.

    The speaking-rate baseline (``--chars-per-second``) is calibrated on those
    scripts; Latin text runs several characters per second faster, so per-character
    rate checks must skip it (F6).
    """
    if not text:
        return False
    for ch in text:
        code = ord(ch)
        if any(low <= code <= high for low, high in _CJK_SCRIPT_RANGES):
            return True
    return False


def detect_language(text: Optional[str]) -> str:
    """Detect Japanese or Korean script in ``text`` ("" when neither).

    Kana (U+3041-U+30FF, halfwidth katakana U+FF66-U+FF9D) means Japanese;
    hangul (U+1100-U+11FF, U+3130-U+318F, U+AC00-U+D7A3) means Korean.
    """
    if not text:
        return ""
    japanese = korean = False
    for ch in text:
        code = ord(ch)
        if (0x3041 <= code <= 0x30FF) or (0xFF66 <= code <= 0xFF9D):
            japanese = True
            break
        if (0x1100 <= code <= 0x11FF) or (0x3130 <= code <= 0x318F) or (0xAC00 <= code <= 0xD7A3):
            korean = True
    if japanese:
        return "Japanese"
    return "Korean" if korean else ""


#: Letter scripts VoxCPM 1.5 cannot speak: it is trained on Chinese and English, so
#: text outside Han and Latin is read out as Chinese or as noise.
_UNSUPPORTED_SCRIPTS = (
    (0x0370, 0x03FF, "Greek"),
    (0x0400, 0x052F, "Cyrillic"),
    (0x0530, 0x058F, "Armenian"),
    (0x0590, 0x05FF, "Hebrew"),
    (0x0600, 0x06FF, "Arabic"),
    (0x0750, 0x077F, "Arabic"),
    (0x0900, 0x097F, "Devanagari"),
    (0x0E00, 0x0E7F, "Thai"),
    (0x0E80, 0x0EFF, "Lao"),
    (0x1000, 0x109F, "Myanmar"),
    (0x10A0, 0x10FF, "Georgian"),
    (0x1100, 0x11FF, "hangul"),
    (0x1780, 0x17FF, "Khmer"),
    (0x3041, 0x30FF, "kana"),
    (0x3130, 0x318F, "hangul"),
    (0xAC00, 0xD7A3, "hangul"),
    (0xFF66, 0xFF9D, "kana"),
)
_HAN_SCRIPT_RANGES = (
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xF900, 0xFAFF),
    (0x20000, 0x2FA1F),
)
_LATIN_EXTRA_RANGES = ((0x0250, 0x02FF), (0x1E00, 0x1EFF), (0xA720, 0xA7FF))


def _letter_script(ch: str) -> str:
    """Script family of one alphabetic character: ``Han``, ``Latin``, a name, or ``other``."""
    code = ord(ch)
    if any(low <= code <= high for low, high in _HAN_SCRIPT_RANGES):
        return "Han"
    if code < 0x0250 or any(low <= code <= high for low, high in _LATIN_EXTRA_RANGES):
        return "Latin"
    for low, high, name in _UNSUPPORTED_SCRIPTS:
        if low <= code <= high:
            return name
    return "other"


def unsupported_script_ratio(text: Optional[str]) -> Tuple[float, str]:
    """Share of letters outside Han/Latin, plus the scripts that carry them.

    VoxCPM 1.5 speaks Chinese and English only and infers the language from the
    text, so anything else is read out as Chinese instead of being refused; the
    caller applies the threshold. The script names come back in first-seen order,
    and text without letters returns ``(0.0, "")``.
    """
    if not text:
        return (0.0, "")
    letters = 0
    unsupported = 0
    names: List[str] = []
    for ch in text:
        if not ch.isalpha():
            continue
        letters += 1
        script = _letter_script(ch)
        if script in ("Han", "Latin"):
            continue
        unsupported += 1
        if script not in names:
            names.append(script)
    if letters == 0:
        return (0.0, "")
    return (unsupported / float(letters), ", ".join(names))


# --------------------------------------------------------------------------
# Sentence splitting
# --------------------------------------------------------------------------


def _balanced_sizes(length: int, cap: int) -> List[int]:
    """Split ``length`` into ``ceil(length / cap)`` nearly equal pieces, each <= cap."""
    pieces = max(1, -(-length // cap))
    base, extra = divmod(length, pieces)
    return [base + (1 if index < extra else 0) for index in range(pieces)]


def _nearest_word_boundary(sentence: str, cut: int, low: int, high: int) -> int:
    """Move a cut that falls between two ``[A-Za-z0-9]`` to the nearest boundary."""
    if not (0 < cut < len(sentence)):
        return cut
    if not (_is_alnum(sentence[cut - 1]) and _is_alnum(sentence[cut])):
        return cut
    for delta in range(1, _WORD_SHIFT_LIMIT + 1):
        for candidate in (cut - delta, cut + delta):
            if candidate < low or candidate > high or not (0 < candidate < len(sentence)):
                continue
            if not (_is_alnum(sentence[candidate - 1]) and _is_alnum(sentence[candidate])):
                return candidate
    return cut


def _shift_cuts(sentence: str, cuts: List[int], cap: int) -> Optional[List[int]]:
    """Nudge every cut to a word boundary; ``None`` when the result violates the cap."""
    length = len(sentence)
    shifted: List[int] = []
    previous = 0
    for index, cut in enumerate(cuts):
        following = cuts[index + 1] if index + 1 < len(cuts) else length
        low = max(previous + 1, following - cap)
        high = min(previous + cap, following - 1)
        if index == len(cuts) - 1:
            high = min(high, length - 2)
        if low > high:
            return None
        candidate = _nearest_word_boundary(sentence, cut, low, high)
        shifted.append(candidate)
        previous = candidate

    positions = [0] + shifted + [length]
    sizes = [positions[i + 1] - positions[i] for i in range(len(positions) - 1)]
    if any(size <= 0 for size in sizes) or any(size > cap for size in sizes):
        return None
    if len(sizes) > 1 and sizes[-1] < 2:
        return None
    return shifted


def _balanced_pieces(fragment: str, cap: int) -> List[str]:
    """Cut one over-long clause into balanced pieces, each <= ``cap``.

    Pieces are nearly equal (61 → 31+30, 121 → 41+40+40, 150 → 50+50+50), and a
    cut that would land between two ASCII alphanumerics moves up to four
    characters to the nearest word boundary. A shift that would break the cap or
    leave a one-character tail is discarded and the balanced cut is kept.
    """
    length = len(fragment)
    sizes = _balanced_sizes(length, cap)
    cuts: List[int] = []
    position = 0
    for size in sizes[:-1]:
        position += size
        cuts.append(position)
    if not cuts:
        return [fragment]
    shifted = _shift_cuts(fragment, cuts, cap)
    chosen = shifted if shifted is not None else cuts

    out: List[str] = []
    previous = 0
    for cut in chosen + [length]:
        out.append(fragment[previous:cut])
        previous = cut
    return [piece for piece in out if piece]


def _pack_clauses(clauses: List[str], cap: int) -> List[str]:
    """Greedy clause packing: keep adding clauses while the pack stays within ``cap``."""
    packs: List[str] = []
    current = ""
    for clause in clauses:
        if not current:
            current = clause
        elif len(current) + len(clause) <= cap:
            current += clause
        else:
            packs.append(current)
            current = clause
    if current:
        packs.append(current)
    return packs


def _split_long(sentence: str, max_chars: int) -> List[str]:
    """Split one over-long fragment, preferring clause boundaries.

    Two stages (rev 7): clauses are packed greedily so every piece ends at a
    punctuation boundary whenever that is possible, and only a clause that is
    itself longer than the cap is cut further with the balanced splitter. Every
    returned piece is at most ``max_chars`` characters.
    """
    if max_chars <= 0 or len(sentence) <= max_chars:
        return [sentence]
    out: List[str] = []
    for pack in _pack_clauses(split_clauses(sentence), max_chars):
        if len(pack) <= max_chars:
            out.append(pack)
        else:
            out.extend(_balanced_pieces(pack, max_chars))
    return [piece for piece in out if piece]


def split_long(sentence: str, max_chars: int) -> List[str]:
    """Public wrapper for splitting one fragment that may be too long for the cap."""
    return _split_long(sentence, max_chars)


def _has_content(sentence: str) -> bool:
    """True when a fragment carries actual text, not just punctuation."""
    return re.search(r"\w", sentence) is not None


def split_sentences(text: str, max_chars: int = 60) -> List[str]:
    """Split normalized text into sentences, punctuation attached.

    Terminators (``。！？!?…`` and a guarded half-width ``.``) and newlines end a
    sentence. ``；;`` is a clause break, not a terminator (rev 7). A sentence
    longer than ``max_chars`` is split into balanced pieces (see
    :func:`_split_long`). ``max_chars <= 0`` disables the cap.
    """
    limit = int(max_chars) if max_chars else 0
    out: List[str] = []
    for paragraph in text.split("\n"):
        paragraph = paragraph.strip()
        if not paragraph:
            continue
        sentences: List[str] = []
        buf = ""
        i = 0
        while i < len(paragraph):
            ch = paragraph[i]
            buf += ch
            i += 1
            if ch in TERMINATORS or (ch == DOT and _dot_breaks_sentence(paragraph, i - 1)):
                while i < len(paragraph) and paragraph[i] in CLOSERS:
                    buf += paragraph[i]
                    i += 1
                fragment = buf.strip()
                buf = ""
                if not fragment:
                    continue
                if not _has_content(fragment) and sentences:
                    # Repeated terminators (unnormalized input) collapse into the
                    # sentence they follow instead of becoming their own one.
                    continue
                sentences.append(fragment)
        if buf.strip():
            sentences.append(buf.strip())

        for sentence in sentences:
            if not sentence:
                continue
            if limit > 0 and len(sentence) > limit:
                out.extend(_split_long(sentence, limit))
            else:
                out.append(sentence)
    return [s for s in out if s]


def plan_sentences(raw: Optional[str], max_chars: int = 60) -> List[str]:
    """Normalize then split one segment's text; the engine's per-segment plan."""
    return split_sentences(normalize_text(raw), max_chars)


def cap_first_sentence(sentences: List[str], max_chars: int) -> List[str]:
    """Strictly split the first sentence at ``max_chars`` (balanced pieces).

    Only the first sentence of a segment is re-split: on a non-streaming backend
    it is the one whose full generation must finish before any audio is audible.
    Streaming deployments pass ``0`` and keep the sentence whole.
    """
    if not sentences or max_chars <= 0 or len(sentences[0]) <= max_chars:
        return sentences
    return _split_long(sentences[0], max_chars) + list(sentences[1:])


# --------------------------------------------------------------------------
# Clause splitting and language units
# --------------------------------------------------------------------------


def _dash_marks(text: str) -> List[Tuple[int, int]]:
    """Maximal runs of dash characters as ``(start, end)`` index pairs."""
    marks: List[Tuple[int, int]] = []
    i = 0
    while i < len(text):
        if text[i] in DASH_MARKS:
            start = i
            while i < len(text) and text[i] in DASH_MARKS:
                i += 1
            marks.append((start, i))
        else:
            i += 1
    return marks


def split_clauses(text: str) -> List[str]:
    """Split one sentence into clauses, punctuation attached.

    A clause ends after a terminator, after a clause break (``，,、：:；;``), or
    after an *unmatched* dash. A dash that belongs to a pair — an inserted phrase
    such as ``他——真的——来了`` — never ends a clause (rev-7 rules table).
    """
    if not text:
        return []
    marks = _dash_marks(text)
    breaking_marks = {marks[-1][1]} if len(marks) % 2 == 1 else set()
    parts: List[str] = []
    buf = ""
    i = 0
    while i < len(text):
        ch = text[i]
        buf += ch
        i += 1
        if ch in TERMINATORS or (ch == DOT and _dot_breaks_sentence(text, i - 1)):
            while i < len(text) and text[i] in CLOSERS:
                buf += text[i]
                i += 1
            parts.append(buf)
            buf = ""
        elif ch in CLAUSE_BREAKS:
            parts.append(buf)
            buf = ""
        elif ch in DASH_MARKS:
            while i < len(text) and text[i] in DASH_MARKS:
                buf += text[i]
                i += 1
            if i in breaking_marks:
                parts.append(buf)
                buf = ""
    if buf:
        parts.append(buf)
    return [part for part in parts if part]


def _join_run(run: List[Tuple[str, int, str]]) -> List[str]:
    """Join clauses of one language run back into parts, preserving sentence bounds."""
    parts: List[str] = []
    buffer: Optional[str] = None
    buffer_sentence: Optional[int] = None
    for text, sentence_index, _language in run:
        if buffer is None or sentence_index == buffer_sentence:
            buffer = (buffer or "") + text
            buffer_sentence = sentence_index
        else:
            parts.append(buffer)
            buffer = text
            buffer_sentence = sentence_index
    if buffer is not None:
        parts.append(buffer)
    return parts


def split_units_by_language(
    units: List[List[str]],
    resolve: Callable[[str], str] = detect_language,
) -> List[Tuple[List[str], str]]:
    """Regroup units into consecutive same-language runs.

    Each unit is cut into clauses; clauses are grouped into runs that share the
    language ``resolve`` reports, and every run becomes one unit with that
    language. Text order is preserved byte for byte — only unit boundaries move,
    and they move at clause boundaries. Clauses coming from the same sentence are
    rejoined, so a single-language unit keeps the display-sentence split the
    planner produced.
    """
    out: List[Tuple[List[str], str]] = []
    for unit in units:
        pieces: List[Tuple[str, int, str]] = []
        for sentence_index, sentence in enumerate(unit):
            for clause in split_clauses(sentence):
                pieces.append((clause, sentence_index, resolve(clause) or ""))
        if not pieces:
            out.append((list(unit), ""))
            continue
        run: List[Tuple[str, int, str]] = [pieces[0]]
        for piece in pieces[1:]:
            if piece[2] == run[0][2]:
                run.append(piece)
            else:
                out.append((_join_run(run), run[0][2]))
                run = [piece]
        out.append((_join_run(run), run[0][2]))
    return out


# --------------------------------------------------------------------------
# Generation units (merge policies)
# --------------------------------------------------------------------------

# Merge policies for combining adjacent short sentences into one generation unit.
MERGE_MODES = ("off", "short", "all")
# Merge bound used when neither --merge-max-chars nor --max-sentence-chars bounds it.
DEFAULT_MERGE_MAX_CHARS = 60


def _merge_bound(max_chars: int, merge_max_chars: int) -> int:
    """Resolve the character bound one merged unit may reach (`<= 0` means unbounded)."""
    if merge_max_chars and merge_max_chars > 0:
        return int(merge_max_chars)
    if max_chars and max_chars > 0:
        return int(max_chars)
    return DEFAULT_MERGE_MAX_CHARS


def plan_units(
    raw: Optional[str],
    max_chars: int = 60,
    first_max_chars: int = 0,
    merge_mode: str = "short",
    merge_max_chars: int = 0,
    short_sentence_chars: int = 20,
) -> List[List[str]]:
    """Plan one segment's generation units: each unit is one model call.

    Sentences are split exactly as :func:`split_sentences` does, the first one is
    capped for first-audio latency, and adjacent sentences are then merged so
    consecutive short sentences share one generation — the model keeps one
    acoustic context instead of drawing an independent sample per sentence, which
    is what makes short consecutive utterances drift apart in timbre.

    Merging never crosses a segment: the caller plans one segment at a time,
    because a segment owns exactly one voice. Within a segment:

    * ``off`` — one unit per sentence (the pre-merge behavior).
    * ``short`` — greedy from the front: append the next sentence while it is at
      most ``short_sentence_chars`` long and the unit stays within the bound.
    * ``all`` — ignore the short-sentence gate and merge while the bound holds.

    The first unit is additionally bounded by ``first_max_chars`` (positive only),
    and the merge bound is clamped to ``max_chars``, so no unit can exceed the
    sentence cap while the cap is positive.
    """
    if merge_mode not in MERGE_MODES:
        raise ValueError(f"unknown merge mode {merge_mode!r}; expected one of {', '.join(MERGE_MODES)}")
    sentences = split_sentences(normalize_text(raw), max_chars)
    if not sentences:
        return []
    if first_max_chars and first_max_chars > 0:
        sentences = cap_first_sentence(sentences, first_max_chars)
    if merge_mode == "off" or len(sentences) == 1:
        return [[sentence] for sentence in sentences]

    bound = _merge_bound(int(max_chars), int(merge_max_chars))
    if max_chars and max_chars > 0:
        bound = min(bound, int(max_chars))
    short = max(0, int(short_sentence_chars))
    units: List[List[str]] = []
    for sentence in sentences:
        if not units:
            units.append([sentence])
            continue
        current = units[-1]
        unit_bound = bound
        if len(units) == 1 and first_max_chars and first_max_chars > 0:
            unit_bound = min(bound, int(first_max_chars)) if bound > 0 else int(first_max_chars)
        merged_len = sum(len(part) for part in current) + len(sentence)
        within = unit_bound <= 0 or merged_len <= unit_bound
        qualifies = merge_mode == "all" or len(sentence) <= short
        if within and qualifies:
            current.append(sentence)
        else:
            units.append([sentence])
    return units
