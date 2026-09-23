#!/usr/bin/env python3
"""Regression tests for the Python pipelines.

Every test names the defect it pins down. Nothing here makes a network call or a
Claude call: the one test that reaches the extraction stage stubs the API client.

Run from the repo root:  python3 -m unittest discover -s tests -p 'test_*.py' -t .
"""
from __future__ import annotations

import sys
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


# ---------------------------------------------------------------- themes/quant_data
class ReadHelperTests(unittest.TestCase):
    """quant_data.read_helper() resolves Year/Quarter/Region for every survey row, so a
    column it fails to find silently costs a whole meeting."""

    def setUp(self):
        from themes import quant_data
        self.quant_data = quant_data

    def test_clean_header(self):
        csv = b'Meeting Date,Year,Quarter,Region,Total Attendees\n"Aug 12, 2026",2026,Q3,Central,40\n'
        out = self.quant_data.read_helper(csv)
        self.assertEqual(out[date(2026, 8, 12)]["year"], 2026)
        self.assertEqual(out[date(2026, 8, 12)]["region"], "Central")
        self.assertEqual(out[date(2026, 8, 12)]["total_attendees"], 40)

    def test_header_with_surrounding_whitespace(self):
        """BUG: the Meeting Date column was matched on its STRIPPED name but read back
        with that stripped name, while csv.DictReader keys rows by the raw header. A
        single trailing space made the whole file resolve to zero meetings, silently."""
        csv = b'Meeting Date ,Year,Quarter,Region\n"Aug 12, 2026",2026,Q3,Central\n'
        out = self.quant_data.read_helper(csv)
        self.assertEqual(len(out), 1, "a padded header must still resolve")
        self.assertEqual(out[date(2026, 8, 12)]["year"], 2026)

    def test_header_case_insensitive(self):
        """BUG: Meeting Date was matched case-insensitively but Year/Quarter/Region were
        read with exact-case keys, so a differently-cased export resolved a date and then
        dropped the meeting for having no Year."""
        csv = b'MEETING DATE,YEAR,QUARTER,REGION\n"Aug 12, 2026",2026,Q3,Central\n'
        out = self.quant_data.read_helper(csv)
        info = out[date(2026, 8, 12)]
        self.assertEqual((info["year"], info["quarter"], info["region"]), (2026, "Q3", "Central"))

    def test_two_meetings_on_one_date_are_reported_not_silently_dropped(self):
        """Survey responses carry only a Meeting Date, so two meetings the same day are
        indistinguishable downstream -- one wins and the other's responses are
        misattributed. It cannot be resolved automatically, but it must not be silent."""
        import io, contextlib
        csv = (b"Meeting Date,Year,Quarter,Region\n"
               b'"Aug 12, 2026",2026,Q3,Central\n'
               b'"Aug 12, 2026",2026,Q3,Southern\n')
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            out = self.quant_data.read_helper(csv)
        self.assertEqual(len(out), 1)
        self.assertIn("more than one meeting on 2026-08-12", buffer.getvalue())
        self.assertIn("Southern", buffer.getvalue())

    def test_a_repeated_date_for_the_same_meeting_is_not_reported(self):
        import io, contextlib
        csv = (b"Meeting Date,Year,Quarter,Region\n"
               b'"Aug 12, 2026",2026,Q3,Central\n'
               b'"Aug 12, 2026",2026,Q3,Central\n')
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            self.quant_data.read_helper(csv)
        self.assertEqual(buffer.getvalue(), "", "a duplicate of the same meeting is not a collision")

    def test_missing_date_column_raises(self):
        with self.assertRaises(ValueError):
            self.quant_data.read_helper(b"Year,Quarter,Region\n2026,Q3,Central\n")

    def test_unparseable_dates_raise_with_examples(self):
        csv = b"Meeting Date,Year,Quarter,Region\nnot-a-date,2026,Q3,Central\n"
        with self.assertRaises(ValueError) as ctx:
            self.quant_data.read_helper(csv)
        self.assertIn("not-a-date", str(ctx.exception))


# ------------------------------------------------------------- themes/feedback_log
class FeedbackLogTests(unittest.TestCase):
    def setUp(self):
        from themes import feedback_log
        self.feedback_log = feedback_log

    def test_item_ids_are_sequential_from_empty(self):
        rows = []
        self.feedback_log.append(rows, [{"text": "a"}, {"text": "b"}], 2026, "Q1", "Central", "src")
        self.assertEqual([r["Item ID"] for r in rows], ["ITEM-001", "ITEM-002"])

    def test_item_ids_do_not_collide_after_a_removal(self):
        """BUG: the next id was numbered off len(rows), but remove_meetings.py deletes
        entries in place and leaves gaps -- so an append after a removal reissued ids
        that were still in use."""
        rows = [{"Item ID": f"ITEM-{i:03d}", "Survey ID": "2026-Q1 Central"} for i in range(1, 5)]
        del rows[0:2]                       # ITEM-003 and ITEM-004 survive
        self.feedback_log.append(rows, [{"text": "new"}], 2026, "Q2", "Central", "src")
        ids = [r["Item ID"] for r in rows]
        self.assertEqual(ids, ["ITEM-003", "ITEM-004", "ITEM-005"])
        self.assertEqual(len(ids), len(set(ids)), "Item IDs must stay unique")

    def test_next_item_number_ignores_malformed_ids(self):
        rows = [{"Item ID": "ITEM-007"}, {"Item ID": None}, {"Item ID": "whatever"}]
        self.assertEqual(self.feedback_log.next_item_number(rows), 8)

    def test_survey_id_round_trip(self):
        rows = []
        sid = self.feedback_log.append(rows, [{"text": "x"}], 2026, "Q3", "Southern", "src")
        self.assertEqual(sid, "2026-Q3 Southern")
        self.assertTrue(self.feedback_log.has_survey(rows, sid))


# ----------------------------------------------------------------- themes/tracker
class QuarterArithmeticTests(unittest.TestCase):
    def setUp(self):
        from themes.tracker import quarters_before, rows_in
        self.quarters_before, self.rows_in = quarters_before, rows_in

    def test_previous_quarter(self):
        self.assertEqual(self.quarters_before(2026, "Q3", 1, 1), {(2026, "Q2")})

    def test_wraps_across_the_year_boundary(self):
        self.assertEqual(self.quarters_before(2026, "Q1", 1, 1), {(2025, "Q4")})

    def test_trailing_year(self):
        self.assertEqual(
            self.quarters_before(2026, "Q2", 1, 4),
            {(2026, "Q1"), (2025, "Q4"), (2025, "Q3"), (2025, "Q2")},
        )

    def test_rows_in_filters_by_period(self):
        rows = [{"Year": 2026, "Quarter": "Q1"}, {"Year": 2025, "Quarter": "Q4"}]
        self.assertEqual(self.rows_in(rows, {(2025, "Q4")}), [rows[1]])


# ------------------------------------------------------------------ themes/sheet_io
class SheetIoTests(unittest.TestCase):
    def setUp(self):
        from themes import sheet_io
        self.sheet_io = sheet_io

    def test_short_rows_are_padded_to_the_header(self):
        header, rows = self.sheet_io.read_rows("x.csv", b"a,b,c\n1,2\n")
        self.assertEqual(header, ["a", "b", "c"])
        self.assertEqual(rows, [["1", "2", None]])

    def test_csv_round_trip_preserves_embedded_commas(self):
        header, rows = self.sheet_io.read_rows("x.csv", b'a,b\n"has, comma",2\n')
        again_header, again_rows = self.sheet_io.read_rows("x.csv", self.sheet_io.write_csv(header, rows))
        self.assertEqual((again_header, again_rows), (header, rows))

    def test_empty_file(self):
        self.assertEqual(self.sheet_io.read_rows("x.csv", b""), ([], []))


# ----------------------------------------------------------------- themes/quant_extract
class QuantExtractTests(unittest.TestCase):
    def setUp(self):
        from themes import quant_extract
        self.quant_extract = quant_extract

    def test_every_documented_date_format_parses(self):
        for text in ("Aug 12, 2026", "12-Aug-26", "12-Aug-2026", "08/12/2026", "2026-08-12"):
            self.assertEqual(self.quant_extract.as_date(text), date(2026, 8, 12), text)

    def test_zero_ratings_are_treated_as_unanswered(self):
        csv = b"Meeting Date,Overall value,Panel 1\n2026-08-12,4,0\n"
        rows = self.quant_extract.unpivot("s.csv", csv)
        self.assertEqual([(r["metric"], r["value"]) for r in rows], [("Overall value", 4)])

    def test_rows_without_a_date_are_skipped(self):
        csv = b"Meeting Date,Overall value\n,4\n2026-08-12,5\n"
        self.assertEqual(len(self.quant_extract.unpivot("s.csv", csv)), 1)


# ------------------------------------------------------------- themes/survey_extract
class SurveyExtractTests(unittest.TestCase):
    def test_metadata_and_rating_columns_never_reach_the_prompt(self):
        from themes import survey_extract
        header = ["Year", "Quarter", "Region", "Meeting Date", "IP Address",
                  "Overall value", "What could be improved?"]
        rows = [[2026, "Q3", "Central", "2026-08-12", "1.2.3.4", 5, "More time for Q&A"]]
        self.assertEqual(
            survey_extract.response_rows(header, rows),
            [{"What could be improved?": "More time for Q&A"}],
        )

    def test_a_free_response_question_containing_a_dropped_word_survives(self):
        from themes import survey_extract
        header = ["Location", "What location would you prefer?"]
        rows = [["Indianapolis", "Somewhere central"]]
        kept = survey_extract.response_rows(header, rows)
        self.assertEqual(kept, [{"What location would you prefer?": "Somewhere central"}])


# --------------------------------------------------------------------- pcn/timeline
class TimelineTests(unittest.TestCase):
    @staticmethod
    def _assertion(aid, meeting_date, meeting_id="m1", weight=0.5):
        return {"id": aid, "meeting_id": meeting_id, "meeting_date": meeting_date,
                "weight": weight, "modality": "asserted", "input_type": "notes",
                "speaker": None, "from_issue_label": "x", "to_issue_label": "y"}

    @staticmethod
    def _resolutions(*ids):
        return {i: {"from_issue_id": "i1", "to_issue_id": "i2"} for i in ids}

    def test_unparseable_meeting_date_is_counted_as_undated_not_a_crash(self):
        """BUG: a present-but-unparseable meeting_date (e.g. "2026-13-45", which passes
        the upload route's YYYY-MM-DD regex) made _quarter_label return None, and the
        cumulative-cutoff comparison then raised TypeError, aborting the whole run."""
        from pcn.pipeline.timeline import derive_timeline
        ledger = [self._assertion("a1", "2026-06-15"), self._assertion("a2", "2026-13-45", "m2")]
        result = derive_timeline(ledger, self._resolutions("a1", "a2"), [])
        self.assertEqual(result["undated_assertion_count"], 1)
        self.assertEqual([p["period"] for p in result["periods"]], ["2026-Q2"])

    def test_missing_meeting_date_is_undated(self):
        from pcn.pipeline.timeline import derive_timeline
        ledger = [self._assertion("a1", None), self._assertion("a2", "")]
        result = derive_timeline(ledger, self._resolutions("a1", "a2"), [])
        self.assertEqual(result, {"periods": [], "undated_assertion_count": 2})

    def test_periods_accumulate_and_report_new_connections_once(self):
        from pcn.pipeline.timeline import derive_timeline
        ledger = [self._assertion("a1", "2026-02-01"), self._assertion("a2", "2026-05-01", "m2")]
        result = derive_timeline(ledger, self._resolutions("a1", "a2"), [])
        self.assertEqual([p["period"] for p in result["periods"]], ["2026-Q1", "2026-Q2"])
        self.assertEqual(len(result["periods"][0]["new_connections"]), 1)
        self.assertEqual(result["periods"][1]["new_connections"], [],
                         "an edge already present must not be re-reported as new")

    def test_quarter_label_boundaries(self):
        from pcn.pipeline.timeline import _quarter_label
        for iso, expected in (("2026-01-01", "2026-Q1"), ("2026-03-31", "2026-Q1"),
                              ("2026-04-01", "2026-Q2"), ("2026-12-31", "2026-Q4")):
            self.assertEqual(_quarter_label(iso), expected, iso)


# ----------------------------------------------------------------------- pcn/derive
class DeriveNetworkTests(unittest.TestCase):
    @staticmethod
    def _assertion(aid, weight, meeting_id="m1", speaker=None):
        return {"id": aid, "meeting_id": meeting_id, "weight": weight,
                "modality": "asserted", "input_type": "transcript", "speaker": speaker}

    def test_rejected_assertions_are_excluded_but_unreviewed_ones_count(self):
        from pcn.pipeline.derive import derive_network
        ledger = [self._assertion("a1", 0.8), dict(self._assertion("a2", 0.8), status="rejected")]
        resolutions = {"a1": {"from_issue_id": "i1", "to_issue_id": "i2"},
                       "a2": {"from_issue_id": "i1", "to_issue_id": "i2"}}
        network = derive_network(ledger, resolutions, [])
        self.assertEqual(network["edges"][0]["assertion_count"], 1)

    def test_opposing_evidence_shows_as_dispersion_not_a_vanished_edge(self):
        from pcn.pipeline.derive import derive_network
        ledger = [self._assertion("a1", 0.8, "m1"), self._assertion("a2", -0.8, "m2")]
        resolutions = {i: {"from_issue_id": "i1", "to_issue_id": "i2"} for i in ("a1", "a2")}
        edge = derive_network(ledger, resolutions, [])["edges"][0]
        self.assertAlmostEqual(edge["mean_weight"], 0.0)
        self.assertGreater(edge["dispersion"], 0.0, "a contested edge must not read as absent")
        self.assertEqual(edge["distinct_meeting_count"], 2)

    def test_node_roles(self):
        from pcn.pipeline.derive import derive_network
        ledger = [self._assertion("a1", 0.5), self._assertion("a2", 0.5)]
        resolutions = {"a1": {"from_issue_id": "driver", "to_issue_id": "middle"},
                       "a2": {"from_issue_id": "middle", "to_issue_id": "outcome"}}
        roles = {n["issue_id"]: n["role"] for n in derive_network(ledger, resolutions, [])["nodes"]}
        self.assertEqual(roles, {"driver": "driver", "middle": "ordinary", "outcome": "outcome"})

    def test_assertions_with_an_unresolved_side_make_no_edge(self):
        from pcn.pipeline.derive import derive_network
        ledger = [self._assertion("a1", 0.5)]
        network = derive_network(ledger, {"a1": {"from_issue_id": "i1", "to_issue_id": None}}, [])
        self.assertEqual(network["edges"], [])


# --------------------------------------------------------------------- pcn/extract
class ExtractEscalationTests(unittest.TestCase):
    """run.py's contract: for a segment escalated to Sonnet, the Sonnet result REPLACES
    that segment's Haiku assertions rather than supplementing them."""

    @staticmethod
    def _doc():
        from pcn.pipeline.models import NormalizedDocument, Segment
        return NormalizedDocument(
            meeting_id="m1", input_type="notes", input_format="md", source_filename="f.md",
            notetaker="N", meeting_date="2026-06-15",
            segments=[Segment(index=0, text="zero"), Segment(index=1, text="one")],
        )

    @staticmethod
    def _raw(segment_index, frm, to):
        return {"segment_index": segment_index, "from_issue": frm, "to_issue": to,
                "modality": "asserted", "weight": 0.5, "quote": "q"}

    def _run(self, passes):
        import pcn.pipeline.extract.run as run_module
        calls = iter(passes)
        with patch.object(run_module.client, "extract", side_effect=lambda *_a, **_k: next(calls)):
            return run_module.extract_document(self._doc())

    def test_escalated_segment_is_not_double_counted(self):
        """BUG: an agreed Haiku assertion on a segment that ALSO had a disagreement was
        kept alongside the Sonnet re-extraction, putting the same causal link in the
        ledger twice and inflating assertion_count / mean_weight / dispersion."""
        agreed = self._raw(0, "a", "b")
        out = self._run([
            [agreed],                                   # Haiku pass 1
            [agreed, self._raw(0, "c", "d")],           # Haiku pass 2 -- segment 0 disagrees
            [self._raw(0, "a", "b")],                   # Sonnet tie-break
        ])
        pairs = [(a.from_issue_label, a.to_issue_label) for a in out]
        self.assertEqual(pairs.count(("a", "b")), 1, "the escalated segment was double-counted")
        self.assertEqual([a.model_used for a in out], ["claude-sonnet-5"])

    def test_agreement_on_an_unescalated_segment_survives_untouched(self):
        agreed_zero = self._raw(0, "a", "b")
        out = self._run([
            [agreed_zero, self._raw(1, "e", "f")],
            [agreed_zero, self._raw(1, "g", "h")],      # only segment 1 disagrees
            [self._raw(1, "e", "f")],
        ])
        by_segment = {a.segment_index: a for a in out}
        self.assertEqual(by_segment[0].from_issue_label, "a")
        self.assertTrue(by_segment[0].agreement)
        self.assertEqual(by_segment[0].model_used, "claude-haiku-4-5-20251001")

    def test_metadata_is_copied_onto_every_assertion(self):
        agreed = self._raw(0, "a", "b")
        out = self._run([[agreed], [agreed]])           # full agreement, no escalation
        self.assertEqual(out[0].meeting_date, "2026-06-15")
        self.assertEqual(out[0].notetaker, "N")
        self.assertEqual(out[0].status, "unreviewed")


# --------------------------------------------------------------------- pcn/normalize
class NormalizeTests(unittest.TestCase):
    def test_consecutive_lines_from_one_speaker_become_one_segment(self):
        from pcn.pipeline.normalize.transcript import parse
        segments = parse("Ann: first line\nAnn: still Ann\nBob: now Bob\n")
        self.assertEqual([(s.speaker, s.text) for s in segments],
                         [("Ann", "first line still Ann"), ("Bob", "now Bob")])

    def test_text_before_any_speaker_label_is_kept_unattributed(self):
        from pcn.pipeline.normalize.transcript import parse
        segments = parse("some preamble\nAnn: hello\n")
        self.assertEqual(segments[0].speaker, None)
        self.assertEqual(segments[0].text, "some preamble")

    def test_notes_inherit_their_heading_path(self):
        from pcn.pipeline.normalize.notes import parse
        segments = parse("# Staffing\n## Overtime\n- too much of it\n# Quality\n- scrap is up\n")
        self.assertEqual([(s.heading_path, s.text) for s in segments], [
            (["Staffing", "Overtime"], "too much of it"),
            (["Quality"], "scrap is up"),
        ])


# ------------------------------------------------------------------------ pcn/ingest
class IngestTests(unittest.TestCase):
    def test_vtt_timestamps_without_an_hours_field_are_stripped(self):
        """BUG: the timestamp pattern required HH:MM:SS.mmm, but the hours field is
        optional in WebVTT -- so an export written as MM:SS.mmm had every timestamp line
        survive as if it were cue text."""
        from pcn.pipeline.ingest.vtt import read
        import tempfile
        vtt = "WEBVTT\n\n1\n00:05.000 --> 00:08.000\nAnn: we are short staffed\n"
        with tempfile.NamedTemporaryFile("w", suffix=".vtt", delete=False) as fh:
            fh.write(vtt)
            path = Path(fh.name)
        self.assertEqual(read(path), "Ann: we are short staffed")

    def test_vtt_strips_voice_tags_and_opaque_cue_ids(self):
        from pcn.pipeline.ingest.vtt import read
        import tempfile
        vtt = ("WEBVTT\n\n50622ea5-9d05/9-0\n00:00:05.000 --> 00:00:08.000\n"
               "<v Ann Smith>we are short staffed</v>\n")
        with tempfile.NamedTemporaryFile("w", suffix=".vtt", delete=False) as fh:
            fh.write(vtt)
            path = Path(fh.name)
        self.assertEqual(read(path), "Ann Smith: we are short staffed")

    def test_docx_bullet_marker_strips_one_marker_not_a_leading_minus(self):
        """BUG: lstrip("-*• ") ate every leading character in that set, turning
        "- -20% margin" into "20% margin" and dropping the sign."""
        from pcn.pipeline.ingest.docx import _BULLET_MARKER
        self.assertEqual(_BULLET_MARKER.sub("", "- -20% margin", count=1), "-20% margin")
        self.assertEqual(_BULLET_MARKER.sub("", "• plain bullet", count=1), "plain bullet")


# -------------------------------------------------------------------------- pcn/match
class CascadeTests(unittest.TestCase):
    def test_label_normalization(self):
        from pcn.pipeline.match.cascade import normalize_label
        self.assertEqual(normalize_label("  Labor   Shortage \n"), "labor shortage")

    def test_an_empty_issue_store_always_means_a_new_issue(self):
        from pcn.pipeline.match.cascade import resolve_issue
        self.assertEqual(resolve_issue("labor shortage", []).method, "new")

    def test_exact_match_ignores_case_and_whitespace(self):
        from pcn.pipeline.match.cascade import resolve_issue
        from pcn.pipeline.models import Issue
        issues = [Issue(id="i1", canonical_label="Labor shortage")]
        result = resolve_issue("  LABOR   SHORTAGE ", issues)
        self.assertEqual((result.issue_id, result.method), ("i1", "exact"))

    def test_mismatched_embedding_dimensions_score_zero_rather_than_truncating(self):
        """BUG: zip() silently truncated to the shorter vector and returned a
        confident-looking similarity computed from a prefix -- which is what an Issue
        whose stored embedding predates a model change would have produced."""
        from pcn.pipeline.match.embeddings import cosine_similarity
        self.assertEqual(cosine_similarity([1.0, 0.0, 0.0], [1.0, 0.0]), 0.0)
        self.assertAlmostEqual(cosine_similarity([1.0, 0.0], [1.0, 0.0]), 1.0)


# ------------------------------------------------------------------------ mcm/periods
class PeriodsTests(unittest.TestCase):
    def setUp(self):
        from mcm import periods
        self.periods = periods

    def test_quarter_end_dates(self):
        for q, expected in ((1, date(2026, 3, 31)), (2, date(2026, 6, 30)),
                            (3, date(2026, 9, 30)), (4, date(2026, 12, 31))):
            self.assertEqual(self.periods.quarter_dates(2026, q)[1], expected, q)

    def test_a_quarter_is_incomplete_until_its_filing_window_closes(self):
        as_of = date(2026, 5, 1)            # Q1 2026 ended Mar 31; +50 days = May 20
        self.assertNotIn((2026, 1), self.periods.complete_quarters(as_of))
        self.assertIn((2026, 1), self.periods.complete_quarters(date(2026, 5, 21)))

    def test_required_quarters_are_latest_plus_its_two_comparisons(self):
        with patch.object(self.periods, "latest_complete_quarter", return_value=(2026, 2)):
            self.assertEqual(self.periods.required_quarters(),
                             [(2025, 2), (2026, 1), (2026, 2)])

    def test_quarter_navigation_wraps(self):
        self.assertEqual(self.periods.next_quarter(2026, 4), (2027, 1))
        self.assertEqual(self.periods.previous_quarter(2026, 1), (2025, 4))
        self.assertEqual(self.periods.parse_label(self.periods.label(2026, 3)), (2026, 3))


# ---------------------------------------------------------------------- mcm/analytics
class AnalyticsTests(unittest.TestCase):
    @staticmethod
    def _frame(rows):
        import pandas as pd
        return pd.DataFrame(rows, columns=["cik", "category", "direction"])

    def test_balance_runs_from_all_headwind_to_all_tailwind(self):
        from mcm.analytics import aggregate
        self.assertEqual(aggregate(self._frame([("1", "Labor", "Headwind")] * 2))["balance"], -1.0)
        self.assertEqual(aggregate(self._frame([("1", "Labor", "Tailwind")] * 2))["balance"], 1.0)

    def test_empty_input_is_zeroed_not_an_error(self):
        from mcm.analytics import aggregate
        self.assertEqual(aggregate(self._frame([]))["total"], 0)

    def test_movement_flags_a_small_sample(self):
        from mcm.analytics import movement_table
        prior = self._frame([("1", "Labor", "Headwind")] * 2)
        current = self._frame([("1", "Labor", "Tailwind")] * 2)
        row = movement_table(prior, current)[0]
        self.assertEqual(row["change_points"], 200.0)
        self.assertTrue(row["small_sample"], "a 200-point swing on 2 signals is noise")


# ---------------------------------------------------------------------- mcm/extract
class HtmlExtractTests(unittest.TestCase):
    def test_block_tags_do_not_run_paragraphs_together(self):
        from mcm.extract import html_to_text
        text = html_to_text(b"<html><body><p>First para.</p><p>Second para.</p></body></html>")
        self.assertIn("First para.", text)
        self.assertNotIn("First para.Second", text)

    def test_script_and_style_content_is_dropped(self):
        from mcm.extract import html_to_text
        text = html_to_text(b"<html><body><script>var x=1;</script><p>Real text.</p></body></html>")
        self.assertNotIn("var x", text)
        self.assertIn("Real text.", text)

    def test_non_manufacturing_rows_are_rejected_before_any_paid_call(self):
        import pandas as pd
        from mcm.extract import assert_manufacturing_only, NonManufacturingDataError
        ok = pd.DataFrame([{"company": "A", "sic": "3559"}])
        assert_manufacturing_only(ok, "test", log=lambda *_: None)
        bad = pd.DataFrame([{"company": "B", "sic": "6021"}])
        with self.assertRaises(NonManufacturingDataError):
            assert_manufacturing_only(bad, "test", log=lambda *_: None)


# ------------------------------------------------------------- consensus/analyze CSV
class ConsensusGroupingTests(unittest.TestCase):
    def test_rows_group_into_one_ordered_thread_per_respondent(self):
        from scripts.consensus_analyze import _group_by_question, _count_responses
        header = ["Response ID", "Submitted At", "Question ID", "Question Text",
                  "Turn", "Prompt", "Answer"]
        rows = [
            ["r1", "t", "q1", "Q one", "1", "follow up", "second"],
            ["r1", "t", "q1", "Q one", "0", "Q one", "first"],
            ["r2", "t", "q1", "Q one", "0", "Q one", "other"],
        ]
        grouped = _group_by_question(header, rows)
        self.assertEqual(sorted(grouped["q1"]), ["r1", "r2"])
        self.assertEqual(sorted(t[0] for t in grouped["q1"]["r1"]), [0, 1])
        self.assertEqual(_count_responses(header, rows), 2)

    def test_a_missing_column_fails_loudly(self):
        from scripts.consensus_analyze import _group_by_question
        with self.assertRaises(ValueError):
            _group_by_question(["Response ID"], [["r1"]])


if __name__ == "__main__":
    unittest.main(verbosity=2)
