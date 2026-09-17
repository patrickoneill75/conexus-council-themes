#!/usr/bin/env python3
"""Analyze one Consensus survey's collected responses and publish the results.

Reads SURVEY_ID from the environment. Fetches the survey's definition from this
Worker's relay (name, objective, audience, questions), downloads and parses its
responses CSV out of Box, groups rows into one ordered transcript per respondent per
question, asks Claude to synthesize each question's themes, and publishes
public/consensus-results/<id>.json -- the same "commit a static JSON, GitHub Actions
does the work" shape scripts/update_dashboard.py already uses for the Council app.

Triggered from the Consensus admin page's "Analyze" button.
"""
from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from consensus import analyze, config, relay  # noqa: E402
from themes import box_store, sheet_io  # noqa: E402


def _count_responses(header: list[str], rows: list[list]) -> int:
    # Distinct Response IDs across the whole CSV, survey-wide -- not per-question -- so
    # the admin page can show "X of Y responses analyzed" against survey["responseCount"].
    col = {name.strip().lower(): i for i, name in enumerate(header)}
    idx = col.get("response id")
    if idx is None:
        return 0
    return len({str(row[idx]) for row in rows if any(row) and row[idx]})


def _group_by_question(header: list[str], rows: list[list]) -> dict[str, dict[str, list[tuple]]]:
    col = {name.strip().lower(): i for i, name in enumerate(header)}
    needed = ["response id", "question id", "turn", "prompt", "answer"]
    missing = [n for n in needed if n not in col]
    if missing:
        raise ValueError(f"Responses file is missing column(s): {missing!r}. "
                          f"Its header reads: {header!r}.")

    by_question: dict[str, dict[str, list[tuple]]] = defaultdict(lambda: defaultdict(list))
    for row in rows:
        if not any(row):
            continue
        qid = str(row[col["question id"]] or "")
        rid = str(row[col["response id"]] or "")
        if not qid or not rid:
            continue
        try:
            turn = int(row[col["turn"]])
        except (TypeError, ValueError):
            continue
        prompt = str(row[col["prompt"]] or "")
        answer = str(row[col["answer"]] or "")
        by_question[qid][rid].append((turn, prompt, answer))
    return by_question


def main() -> int:
    survey_id = os.environ.get("SURVEY_ID", "").strip()
    if not survey_id:
        print("ERROR: No SURVEY_ID given.", file=sys.stderr)
        return 1
    if not config.CONSENSUS_CLAUDE_API_KEY:
        print("ERROR: CONSENSUS_CLAUDE_API_KEY is not set (repository secret "
              "consensus_claude_api). See SETUP.md.", file=sys.stderr)
        return 1
    if not box_store.enabled():
        print("ERROR: BOX_RELAY_URL and BOX_RELAY_SECRET are not set as repository "
              "secrets, so there is no way to reach Box. See SETUP.md.", file=sys.stderr)
        return 1

    print(f"Fetching survey {survey_id}...")
    survey = relay.get_survey(survey_id)
    print(f"  {survey['name']!r}, {len(survey['questions'])} question(s).")
    if not survey.get("boxFolderId"):
        print("ERROR: This survey has no responses folder set up yet.", file=sys.stderr)
        return 1

    print(f"Looking for {survey['responsesFileName']!r} in the responses folder...")
    files = {f["name"]: f["id"] for f in box_store.list_folder(survey["boxFolderId"])}
    file_id = files.get(survey["responsesFileName"])
    if not file_id:
        print("ERROR: No responses have been collected yet -- the responses file "
              "doesn't exist in Box.", file=sys.stderr)
        return 1

    print("Downloading and parsing responses...")
    content = box_store.download(file_id)
    header, rows = sheet_io.read_rows(survey["responsesFileName"], content)
    analyzed_response_count = _count_responses(header, rows)
    by_question = _group_by_question(header, rows)

    total_questions = len(survey["questions"])
    questions_out = []
    for i, question in enumerate(survey["questions"]):
        relay.report_progress(survey_id, i + 1, total_questions, question["text"])
        respondents = by_question.get(question["id"], {})
        threads = []
        for rid, turns in respondents.items():
            turns.sort(key=lambda t: t[0])
            threads.append([{"prompt": p, "answer": a} for (_turn, p, a) in turns])

        print(f"Analyzing {question['text']!r} ({len(threads)} respondent(s))...")
        if not threads:
            questions_out.append({
                "id": question["id"], "text": question["text"], "responseCount": 0,
                "themes": [], "consensus": [], "needsMoreInfo": [],
            })
            print("  No responses yet -- skipping.")
            continue

        result = analyze.analyze_question(survey, question, threads)
        questions_out.append({
            "id": question["id"], "text": question["text"], "responseCount": len(threads),
            **result,
        })
        print(f"  {len(result['themes'])} theme(s), {len(result['consensus'])} consensus "
              f"bullet(s), {len(result['needsMoreInfo'])} needs-more-info bullet(s).")

    output = {
        "surveyId": survey_id,
        "surveyName": survey["name"],
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "questions": questions_out,
    }
    config.RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    config.results_json(survey_id).write_text(
        json.dumps(output, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    print(f"Published {config.results_json(survey_id)}.")

    relay.mark_analyzed(survey_id, analyzed_response_count)
    print(f"Marked the survey analyzed ({analyzed_response_count} response(s)).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
