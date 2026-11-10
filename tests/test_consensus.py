"""Tests for the Consensus Analyze step (scripts/consensus_analyze.py and consensus/analyze.py).

The run is exercised end to end with Box, the Worker relay and Claude stubbed, so no network
or API key is needed: what goes to Claude, what is published, and what the control panel is told.
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from consensus import analyze, config  # noqa: E402
from scripts import consensus_analyze as run  # noqa: E402

HEADER = "Response ID,Submitted At,Question ID,Question Text,Turn,Prompt,Answer\n"
SURVEY = {
    "id": "s1", "name": "Hiring with referrals", "objective": "Learn how referrals work", "audience": "HR leads",
    "generalGuidance": "Keep it short", "boxFolderId": "99", "responsesFileName": "hiring-s1-responses.csv",
    "questions": [
        {"id": "q-company", "text": "What is the name of your company?", "claudeAnalyze": False},
        {"id": "q-why", "text": "Why do you prefer referrals?", "context": "Ask about retention"},
        {"id": "q-empty", "text": "Anything else?"},
    ],
}
CSV = (HEADER
       + "r1,2026-11-06T19:41:50Z,q-company,What is the name of your company?,0,What is the name of your company?,Zoeller\n"
       + "r1,2026-11-06T19:41:50Z,q-why,How long do they stay?,1,How long do they stay?,Longer than other hires\n"
       + "r1,2026-11-06T19:41:50Z,q-why,How long do they stay?,0,Why do you prefer referrals?,They come vouched for\n"
       + "r2,2026-11-10T16:12:17Z,q-company,What is the name of your company?,0,What is the name of your company?,Lucas Oil\n"
       + "r2,2026-11-10T16:12:17Z,q-why,Why do you prefer referrals?,0,Why do you prefer referrals?,Faster to fill roles\n")


class AnalyzeRunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        out = Path(self.tmp.name)
        self.calls = {"analyze": [], "progress": [], "marked": []}
        patches = [
            mock.patch.dict(os.environ, {"SURVEY_ID": "s1"}),
            mock.patch.object(config, "CONSENSUS_CLAUDE_API_KEY", "key"),
            mock.patch.object(config, "RESULTS_DIR", out),
            mock.patch.object(config, "results_json", lambda sid: out / f"{sid}.json"),
            mock.patch.object(run.box_store, "enabled", lambda: True),
            mock.patch.object(run.box_store, "list_folder", lambda fid: self.files),
            mock.patch.object(run.box_store, "download", lambda fid: CSV.encode()),
            mock.patch.object(run.relay, "get_survey", lambda sid: json.loads(json.dumps(SURVEY))),
            mock.patch.object(run.relay, "report_progress", lambda *a: self.calls["progress"].append(a)),
            mock.patch.object(run.relay, "mark_analyzed", lambda *a: self.calls["marked"].append(a)),
            mock.patch.object(run.analyze, "analyze_question", self.fake_analyze),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        self.addCleanup(self.tmp.cleanup)
        self.files = [{"name": "hiring-s1-responses.csv", "id": "f1"}]
        self.out = out

    def fake_analyze(self, survey, question, threads):
        self.calls["analyze"].append((question["id"], threads))
        return {"themes": [{"summary": "Trust", "details": [], "deepDive": ""}], "consensus": ["Referrals work"],
                "needsMoreInfo": []}

    def main(self):
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            return run.main()

    def test_only_questions_marked_for_analysis_go_to_claude_in_turn_order(self):
        self.assertEqual(self.main(), 0)
        # q-company is "Claude Analyze: No"; q-empty has no answers, so it costs nothing either.
        self.assertEqual([qid for qid, _ in self.calls["analyze"]], ["q-why"])
        threads = dict(self.calls["analyze"])["q-why"]
        self.assertEqual(threads[0], [{"prompt": "Why do you prefer referrals?", "answer": "They come vouched for"},
                                      {"prompt": "How long do they stay?", "answer": "Longer than other hires"}],
                         "turns are put back in order whatever order the file has them in")
        self.assertEqual(len(threads), 2)

    def test_published_results_carry_themes_empty_questions_and_the_summary_table(self):
        self.main()
        out = json.loads((self.out / "s1.json").read_text())
        self.assertEqual(out["surveyName"], "Hiring with referrals")
        by_id = {q["id"]: q for q in out["questions"]}
        self.assertEqual(by_id["q-why"]["responseCount"], 2)
        self.assertEqual(by_id["q-why"]["themes"][0]["summary"], "Trust")
        self.assertEqual(by_id["q-empty"], {"id": "q-empty", "text": "Anything else?", "responseCount": 0,
                                            "themes": [], "consensus": [], "needsMoreInfo": []})
        self.assertNotIn("q-company", by_id)
        self.assertEqual(out["summary"]["columns"], [{"id": "q-company", "text": "What is the name of your company?"}])
        self.assertEqual(sorted(r["answers"]["q-company"] for r in out["summary"]["rows"]), ["Lucas Oil", "Zoeller"])

    def test_progress_is_reported_per_question_and_the_survey_marked_with_its_count(self):
        self.main()
        self.assertEqual([(c[1], c[2]) for c in self.calls["progress"]], [(1, 2), (2, 2)])
        self.assertEqual(self.calls["marked"], [("s1", 2)])

    def test_no_responses_file_publishes_nothing_and_marks_nothing(self):
        self.files = []
        self.assertEqual(self.main(), 1)
        self.assertFalse((self.out / "s1.json").exists())
        self.assertEqual(self.calls["marked"], [])

    def test_missing_survey_id_or_key_stops_before_reading_anything(self):
        with mock.patch.dict(os.environ, {"SURVEY_ID": ""}):
            self.assertEqual(self.main(), 1)
        with mock.patch.object(config, "CONSENSUS_CLAUDE_API_KEY", ""):
            self.assertEqual(self.main(), 1)
        self.assertEqual(self.calls["analyze"], [])


class GroupingTests(unittest.TestCase):
    def test_rows_without_ids_or_with_a_bad_turn_are_skipped(self):
        header = ["Response ID", "Submitted At", "Question ID", "Question Text", "Turn", "Prompt", "Answer"]
        rows = [["r1", "t", "q1", "Q", "0", "Q", "ok"], ["", "t", "q1", "Q", "0", "Q", "no id"],
                ["r2", "t", "", "Q", "0", "Q", "no question"], ["r3", "t", "q1", "Q", "x", "Q", "bad turn"],
                ["", "", "", "", "", "", ""]]
        grouped = run._group_by_question(header, rows)
        self.assertEqual({q: sorted(r) for q, r in grouped.items()}, {"q1": ["r1"]})
        self.assertEqual(run._count_responses(header, rows), 3, "a response counts once it has an id")


class FakeClient:
    def __init__(self, result=None):
        self.result, self.sent = result, None
        self.messages = SimpleNamespace(create=self.create)

    def create(self, **kwargs):
        self.sent = kwargs
        content = [SimpleNamespace(type="tool_use", input=self.result)] if self.result is not None else []
        return SimpleNamespace(content=content, stop_reason="end_turn")


class AnalyzeQuestionTests(unittest.TestCase):
    SURVEY = {"objective": "Learn how referrals work", "audience": "HR leads", "generalGuidance": "Keep it short"}
    QUESTION = {"text": "Why do you prefer referrals?", "context": "Ask about retention"}
    THREADS = [[{"prompt": "Why do you prefer referrals?", "answer": "Vouched for"},
                {"prompt": "How long do they stay?", "answer": "Longer"}]]

    def analyze(self, result):
        client = FakeClient(result)
        with mock.patch.object(analyze, "_get_client", lambda: client):
            return analyze.analyze_question(self.SURVEY, self.QUESTION, self.THREADS), client

    def test_lists_longer_than_the_limits_are_cut_to_them(self):
        """The limits are asked for in the prompt; the schema cannot carry maxItems, so a model that
        pads its answer is cut back here."""
        theme = {"summary": "s", "details": ["a", "b", "c", "d"], "deepDive": "x"}
        out, _ = self.analyze({"themes": [dict(theme) for _ in range(4)], "consensus": list("abcdefg"),
                               "needsMoreInfo": list("abcdef")})
        self.assertEqual(len(out["themes"]), 3)
        self.assertEqual(out["themes"][0]["details"], ["a", "b", "c"])
        self.assertEqual(len(out["consensus"]), 5)
        self.assertEqual(len(out["needsMoreInfo"]), 5)

    def test_the_prompt_carries_the_survey_context_and_labels_follow_ups(self):
        _, client = self.analyze({"themes": [], "consensus": [], "needsMoreInfo": []})
        system, user = client.sent["system"], client.sent["messages"][0]["content"]
        for text in ("Learn how referrals work", "HR leads", "Keep it short", "Ask about retention"):
            self.assertIn(text, system)
        self.assertIn("Question: Why do you prefer referrals?", user)
        self.assertIn("Follow-up 1: How long do they stay?", user)
        self.assertEqual(client.sent["model"], analyze.MODEL)
        self.assertTrue(client.sent["tools"][0]["strict"])

    def test_no_tool_call_is_an_error_not_an_empty_result(self):
        with self.assertRaises(RuntimeError):
            self.analyze(None)


if __name__ == "__main__":
    unittest.main()
