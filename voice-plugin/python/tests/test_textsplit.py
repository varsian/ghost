"""Sentence normalization/splitting tests (PROTOCOL.md §7)."""

from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from ttslib.textsplit import (  # noqa: E402
    MERGE_MODES,
    detect_language,
    normalize_text,
    plan_sentences,
    plan_units,
    split_clauses,
    split_long,
    split_sentences,
    split_units_by_language,
)


class NormalizeTests(unittest.TestCase):
    def test_strips_fences_and_emphasis(self) -> None:
        raw = "```markdown\n**你好**，世界。\n```"
        self.assertEqual(normalize_text(raw), "你好，世界。")

    def test_collapses_whitespace(self) -> None:
        self.assertEqual(normalize_text("  你好    世界  \n\n  第二行 "), "你好 世界\n第二行")

    def test_collapses_repeated_punctuation(self) -> None:
        self.assertEqual(normalize_text("你好！！！真的吗？？？"), "你好！真的吗？")
        self.assertEqual(normalize_text("第一，，第二。。"), "第一，第二。")

    def test_empty_and_none(self) -> None:
        self.assertEqual(normalize_text(None), "")
        self.assertEqual(normalize_text("   \n  "), "")
        self.assertEqual(plan_sentences("```\n```", 60), [])

    def test_code_and_underscores(self) -> None:
        self.assertEqual(normalize_text("`tts` 工具 __重要__"), "tts 工具 重要")


class SplitTests(unittest.TestCase):
    def test_splits_at_terminators_with_punctuation_attached(self) -> None:
        self.assertEqual(
            split_sentences("你好。世界！第三句？", 60),
            ["你好。", "世界！", "第三句？"],
        )

    def test_newline_is_a_boundary(self) -> None:
        self.assertEqual(split_sentences("第一条\n第二条", 60), ["第一条", "第二条"])

    def test_closing_quote_stays_attached(self) -> None:
        self.assertEqual(split_sentences('他说：“走吧。”然后走了。', 60), ['他说：“走吧。”', "然后走了。"])

    def test_semicolon_is_a_clause_break_not_a_terminator(self) -> None:
        """Rev 7: ``；`` does not end a sentence, so a semicolon-joined text stays one unit."""
        self.assertEqual(split_sentences("其一；其二", 60), ["其一；其二"])
        self.assertEqual(len(plan_units("一" * 20 + "；" + "二" * 30, max_chars=60)), 1)

    def test_over_cap_text_is_packed_at_clause_boundaries(self) -> None:
        """Rev 7 stage 1: clauses are packed greedily, so pieces end at punctuation."""
        text = "一二三四五，六七八九十，十一十二，十三十四。"
        parts = split_sentences(text, 8)
        self.assertEqual(parts, ["一二三四五，", "六七八九十，", "十一十二，", "十三十四。"])
        self.assertTrue(all(len(part) <= 8 for part in parts))
        self.assertEqual("".join(parts), text)
        self.assertTrue(all(part.endswith(("，", "。")) for part in parts))

    def test_over_long_clause_is_balanced_inside_the_pack(self) -> None:
        """Rev 7 stage 2: only a clause longer than the cap is split further."""
        text = "短，" + "字" * 61
        parts = split_sentences(text, 60)
        self.assertEqual([len(part) for part in parts], [2, 31, 30])
        self.assertEqual("".join(parts), text)

    def test_hard_split_when_no_soft_break(self) -> None:
        text = "一二三四五六七八九十"
        parts = split_sentences(text, 4)
        self.assertEqual(parts, ["一二三四", "五六七", "八九十"])
        self.assertTrue(all(len(part) <= 4 for part in parts))
        self.assertEqual("".join(parts), text)

    def test_cap_zero_disables_limit(self) -> None:
        long_sentence = "一" * 200 + "。"
        self.assertEqual(split_sentences(long_sentence, 0), [long_sentence])

    def test_plan_sentences_normalizes_first(self) -> None:
        self.assertEqual(plan_sentences("**欢迎！！**  请坐。", 60), ["欢迎！", "请坐。"])

    def test_unclosed_tail_is_kept(self) -> None:
        self.assertEqual(split_sentences("没有标点结尾", 60), ["没有标点结尾"])

    def test_mixed_terminators_collapse(self) -> None:
        self.assertEqual(split_sentences("真的吗？！好吧。", 60), ["真的吗？", "好吧。"])


class PlanUnitsTests(unittest.TestCase):
    """Merging adjacent short sentences into one generation unit (rev 5)."""

    SHORT = "今天天气不错。我们开始吧。明天见。"

    def test_short_merging_joins_consecutive_short_sentences(self) -> None:
        units = plan_units(self.SHORT, max_chars=60, first_max_chars=20, merge_mode="short")
        self.assertEqual(len(units), 1)
        self.assertEqual(units[0], ["今天天气不错。", "我们开始吧。", "明天见。"])

    def test_off_mode_reproduces_the_pre_merge_behavior(self) -> None:
        units = plan_units(self.SHORT, max_chars=60, first_max_chars=20, merge_mode="off")
        self.assertEqual(len(units), 3)
        self.assertTrue(all(len(unit) == 1 for unit in units))

    def test_first_unit_is_bounded_by_the_first_sentence_cap(self) -> None:
        units = plan_units(self.SHORT, max_chars=60, first_max_chars=10, merge_mode="short")
        # 今天天气不错。(7) cannot absorb 我们开始吧。(6) inside a 10-char first unit.
        self.assertEqual(units[0], ["今天天气不错。"])
        self.assertGreater(len(units), 1)

    def test_long_sentence_starts_its_own_unit_under_short_mode(self) -> None:
        text = "短句。这是一个相当长的句子它不应该和别的句子合并在一起。尾巴。"
        units = plan_units(text, max_chars=60, first_max_chars=0, merge_mode="short")
        # The long sentence begins a unit of its own; a short tail may still join it.
        self.assertTrue(any(unit and unit[0].startswith("这是一个相当长") for unit in units))
        self.assertTrue(all(sum(len(part) for part in unit) <= 60 for unit in units))

    def test_all_mode_merges_while_the_bound_holds(self) -> None:
        units = plan_units(self.SHORT, max_chars=60, first_max_chars=0, merge_mode="all")
        self.assertEqual(len(units), 1)

    def test_merge_bound_is_respected(self) -> None:
        units = plan_units(self.SHORT, max_chars=60, first_max_chars=0, merge_mode="all", merge_max_chars=12)
        self.assertTrue(all(sum(len(part) for part in unit) <= 12 for unit in units))
        self.assertGreater(len(units), 1)

    def test_merge_bound_defaults_to_the_sentence_cap_when_unbounded(self) -> None:
        # max_chars=0 (no cap) must not merge an entire document into one unit.
        units = plan_units("一。二。三。四。五。六。七。八。九。十。", max_chars=0, merge_mode="all")
        self.assertTrue(all(sum(len(part) for part in unit) <= 60 for unit in units))

    def test_whitespace_yields_no_units_and_punctuation_only_keeps_its_old_behavior(self) -> None:
        self.assertEqual(plan_units("   ", merge_mode="short"), [])
        # Unchanged from the pre-merge splitter: a punctuation-only fragment is still one
        # unit, so the engine reports the segment rather than silently dropping it.
        self.assertEqual(plan_units("。。。", merge_mode="short"), [["。"]])

    def test_unknown_mode_raises(self) -> None:
        with self.assertRaises(ValueError):
            plan_units("你好。", merge_mode="sometimes")


class PunctuationRulesTests(unittest.TestCase):
    """Rev-7 punctuation rules table, one test per row."""

    def test_cjk_terminators_end_sentences(self) -> None:
        self.assertEqual(split_sentences("你好。世界！好吗？", 60), ["你好。", "世界！", "好吗？"])

    def test_ascii_bang_and_question_end_sentences(self) -> None:
        self.assertEqual(split_sentences("Hi! Are you there? Yes", 60), ["Hi!", "Are you there?", "Yes"])

    def test_ellipsis_ends_a_sentence(self) -> None:
        self.assertEqual(split_sentences("他走了…真的？", 60), ["他走了…", "真的？"])

    def test_semicolon_is_a_clause_break_not_a_terminator(self) -> None:
        self.assertEqual(split_sentences("其一；其二", 60), ["其一；其二"])
        # `；` still delimits clauses, which is what a language switch is detected on.
        self.assertEqual(split_clauses("其一；其二"), ["其一；", "其二"])

    def test_comma_like_clause_breaks_do_not_end_sentences(self) -> None:
        self.assertEqual(split_sentences("你好，世界、再见：好的", 60), ["你好，世界、再见：好的"])

    def test_halfwidth_dot_after_a_space_ends_a_sentence(self) -> None:
        self.assertEqual(split_sentences("A. B. C.", 60), ["A.", "B.", "C."])

    def test_halfwidth_dot_after_a_digit_does_not_split(self) -> None:
        self.assertEqual(split_sentences("3.5+4.2", 60), ["3.5+4.2"])
        self.assertEqual(split_sentences("版本 v1.2 已发布", 60), ["版本 v1.2 已发布"])

    def test_halfwidth_dot_before_cjk_ends_a_sentence(self) -> None:
        self.assertEqual(split_sentences("Hello.你好。", 60), ["Hello.", "你好。"])

    def test_halfwidth_dot_at_end_of_text_ends_a_sentence(self) -> None:
        self.assertEqual(split_sentences("Done.", 60), ["Done."])

    def test_paired_dashes_do_not_break_a_clause(self) -> None:
        self.assertEqual(split_clauses("他——真的——来了。"), ["他——真的——来了。"])

    def test_single_dash_breaks_a_clause(self) -> None:
        self.assertEqual(split_clauses("他走了——再没回来。"), ["他走了——", "再没回来。"])

    def test_closing_quote_stays_attached(self) -> None:
        self.assertEqual(split_sentences('他说：“走吧。”然后走了。', 60), ['他说：“走吧。”', "然后走了。"])

    def test_three_dots_normalize_to_an_ellipsis(self) -> None:
        self.assertEqual(normalize_text("他走了...真的"), "他走了…真的")
        self.assertEqual(normalize_text("等等......"), "等等…")

    def test_repeated_punctuation_still_collapses(self) -> None:
        self.assertEqual(normalize_text("你好！！！"), "你好！")
        self.assertEqual(normalize_text("第一，，第二。。"), "第一，第二。")


class BalancedSplitTests(unittest.TestCase):
    """Rev-7 balanced splitting with the word-boundary adjustment."""

    def test_sixty_one_chars_without_punctuation_is_split_evenly(self) -> None:
        parts = split_sentences("一" * 61, 60)
        self.assertEqual([len(part) for part in parts], [31, 30])

    def test_sixty_one_chars_with_a_comma_is_split_evenly(self) -> None:
        parts = split_sentences("一" * 30 + "，" + "二" * 30, 60)
        self.assertEqual([len(part) for part in parts], [31, 30])
        self.assertEqual("".join(parts), "一" * 30 + "，" + "二" * 30)

    def test_hundred_and_fifty_chars_become_three_equal_pieces(self) -> None:
        self.assertEqual([len(part) for part in split_long("三" * 150, 60)], [50, 50, 50])

    def test_hundred_and_twenty_one_chars_put_the_remainder_first(self) -> None:
        self.assertEqual([len(part) for part in split_long("四" * 121, 60)], [41, 40, 40])

    def test_every_piece_respects_the_cap(self) -> None:
        for length in (1, 2, 59, 60, 61, 62, 119, 120, 121, 150, 301, 1000):
            for cap in (1, 2, 7, 20, 60):
                parts = split_long("五" * length, cap)
                self.assertTrue(parts, (length, cap))
                self.assertLessEqual(max(len(part) for part in parts), cap, (length, cap))
                self.assertEqual("".join(parts), "五" * length, (length, cap))
                self.assertLessEqual(len(parts), -(-length // cap) + 1, (length, cap))

    def test_cap_zero_or_negative_disables_splitting(self) -> None:
        self.assertEqual(split_long("六" * 500, 0), ["六" * 500])
        self.assertEqual(split_long("六" * 500, -5), ["六" * 500])

    def test_cut_between_ascii_alphanumerics_moves_to_a_boundary(self) -> None:
        sentence = "a" * 17 + " " + "b" * 44
        parts = split_long(sentence, 30)
        self.assertEqual("".join(parts), sentence)
        self.assertTrue(all(len(part) <= 30 for part in parts), [len(p) for p in parts])
        self.assertTrue(parts[0].endswith(" "), f"cut did not move to the space: {parts[0]!r}")

    def test_shift_is_dropped_when_it_would_break_the_cap(self) -> None:
        sentence = "a" * 28 + " " + "b" * 31
        parts = split_long(sentence, 30)
        self.assertEqual([len(part) for part in parts], [30, 30], "balanced cut must be kept")
        self.assertTrue(parts[0].endswith("b") and parts[1].startswith("b"))


class Rev7SplitRegressionTests(unittest.TestCase):
    """S7 acceptance inputs: clause packing first, balanced splitting only when needed."""

    def test_one_hundred_and_fifty_four_chars_pack_at_punctuation(self) -> None:
        text = "，".join(["字" * 30] * 5)
        self.assertEqual(len(text), 154)
        parts = split_sentences(text, 60)
        self.assertEqual([len(part) for part in parts], [31, 31, 31, 31, 30])
        self.assertEqual([part[-1] for part in parts[:-1]], ["，", "，", "，", "，"])
        self.assertEqual("".join(parts), text)
        self.assertTrue(all(len(part) <= 60 for part in parts))
        units = plan_units(text, max_chars=60, first_max_chars=0, merge_mode="short")
        self.assertEqual([len(unit[0]) for unit in units], [31, 31, 31, 31, 30])
        self.assertTrue(all(len(part) <= 60 for unit in units for part in unit))

    def test_sixty_one_chars_without_punctuation(self) -> None:
        self.assertEqual([len(part) for part in split_sentences("字" * 61, 60)], [31, 30])

    def test_one_hundred_and_twenty_one_chars(self) -> None:
        self.assertEqual([len(part) for part in split_sentences("字" * 121, 60)], [41, 40, 40])

    def test_one_hundred_and_fifty_chars(self) -> None:
        self.assertEqual([len(part) for part in split_sentences("字" * 150, 60)], [50, 50, 50])

    def test_two_over_long_clauses_never_cross_the_comma(self) -> None:
        text = "字" * 70 + "，" + "字" * 70
        self.assertEqual(len(text), 141)
        parts = split_sentences(text, 60)
        self.assertTrue(all(len(part) <= 60 for part in parts), [len(p) for p in parts])
        self.assertEqual("".join(parts), text)
        boundaries: List[int] = []
        position = 0
        for part in parts:
            position += len(part)
            boundaries.append(position)
        self.assertIn(text.index("，") + 1, boundaries, "no piece may span the comma")
        self.assertEqual([len(part) for part in parts], [36, 35, 35, 35])

    def test_clause_pieces_stay_within_the_cap(self) -> None:
        for cap in (1, 5, 20, 60):
            for text in ("字" * 61, "，".join(["字" * 30] * 5), "字" * 70 + "，" + "字" * 70):
                parts = split_sentences(text, cap)
                self.assertTrue(all(len(part) <= cap for part in parts), (cap, [len(p) for p in parts]))
                self.assertEqual("".join(parts), text)


class UnitLengthInvariantTests(unittest.TestCase):
    """Module invariant: units and fragments never exceed ``max_chars`` while it is positive."""

    TEXTS = (
        "一" * 61,
        "一" * 150,
        "短。也很短。这一句明显很长很长很长很长很长很长很长很长很长很长！尾巴。",
        "こんにちは。これはテストです。",
        "Hello world. This is a test.",
        "一。二。三。四。五。六。七。八。九。十。",
    )

    def test_plan_units_never_exceeds_the_sentence_cap(self) -> None:
        for text in self.TEXTS:
            for cap in (10, 20, 60):
                for mode in MERGE_MODES:
                    for merge_cap in (0, 5, 500):
                        units = plan_units(
                            text,
                            max_chars=cap,
                            first_max_chars=0,
                            merge_mode=mode,
                            merge_max_chars=merge_cap,
                        )
                        longest = max((len(part) for unit in units for part in unit), default=0)
                        self.assertLessEqual(
                            longest,
                            cap,
                            f"cap={cap} mode={mode} merge_cap={merge_cap} text={text[:8]}… -> {longest}",
                        )

    def test_merge_max_chars_cannot_exceed_the_sentence_cap(self) -> None:
        units = plan_units("一" * 20 + "。" + "二" * 20 + "。", max_chars=25, merge_mode="all", merge_max_chars=500)
        self.assertTrue(all(sum(len(part) for part in unit) <= 25 for unit in units), units)

    def test_split_sentences_never_exceeds_the_cap(self) -> None:
        for text in self.TEXTS:
            for cap in (1, 5, 20, 60):
                parts = split_sentences(text, cap)
                self.assertTrue(all(len(part) <= cap for part in parts), (text[:8], cap, [len(p) for p in parts]))


class LanguageDetectionTests(unittest.TestCase):
    """`detect_language` recognizes kana and hangul, and nothing else."""

    def test_kana_is_japanese(self) -> None:
        self.assertEqual(detect_language("これはテストです。"), "Japanese")
        self.assertEqual(detect_language("カタカナ"), "Japanese")
        self.assertEqual(detect_language("ｱｲｳｴｵ"), "Japanese")
        self.assertEqual(detect_language("ひらがな"), "Japanese")

    def test_hangul_is_korean(self) -> None:
        self.assertEqual(detect_language("한국어입니다"), "Korean")
        self.assertEqual(detect_language("ㄱㄴㄷ"), "Korean")
        self.assertEqual(detect_language("\u1100\u1101"), "Korean")

    def test_other_scripts_are_empty(self) -> None:
        self.assertEqual(detect_language("你好，世界。"), "")
        self.assertEqual(detect_language("Hello world."), "")
        self.assertEqual(detect_language(""), "")
        self.assertEqual(detect_language(None), "")

    def test_japanese_wins_when_both_scripts_appear(self) -> None:
        self.assertEqual(detect_language("これはテスト。한국어"), "Japanese")


class SplitUnitsByLanguageTests(unittest.TestCase):
    """`split_units_by_language` regroups units on consecutive same-language runs."""

    def test_single_language_unit_keeps_its_parts(self) -> None:
        result = split_units_by_language([["甲一。", "甲二。"]])
        self.assertEqual(result, [(["甲一。", "甲二。"], "")])

    def test_clauses_of_one_sentence_are_rejoined(self) -> None:
        result = split_units_by_language([["这是，一句。"]])
        self.assertEqual(result, [(["这是，一句。"], "")])

    def test_language_switch_splits_a_unit(self) -> None:
        result = split_units_by_language([["これは日本語です。", "한국어입니다。"]])
        self.assertEqual(
            result,
            [(["これは日本語です。"], "Japanese"), (["한국어입니다。"], "Korean")],
        )

    def test_language_switch_inside_one_sentence_splits_at_the_clause(self) -> None:
        result = split_units_by_language([["これは日本語、한국어"]])
        self.assertEqual(
            result,
            [(["これは日本語、"], "Japanese"), (["한국어"], "Korean")],
        )

    def test_same_language_across_sentences_is_merged_back(self) -> None:
        result = split_units_by_language([["これは一つ。", "これは二つ。"]])
        self.assertEqual(result, [(["これは一つ。", "これは二つ。"], "Japanese")])

    def test_text_order_is_preserved(self) -> None:
        units = [["これは一。", "한국어二。"], ["これは三。"]]
        result = split_units_by_language(units)
        original = "".join(part for unit in units for part in unit)
        self.assertEqual("".join(part for parts, _language in result for part in parts), original)

    def test_resolve_is_injectable(self) -> None:
        result = split_units_by_language([["aa。", "bb。"]], resolve=lambda text: "X" if text.startswith("bb") else "")
        self.assertEqual(result, [(["aa。"], ""), (["bb。"], "X")])

    def test_empty_input(self) -> None:
        self.assertEqual(split_units_by_language([]), [])


if __name__ == "__main__":
    unittest.main()
