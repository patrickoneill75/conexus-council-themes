#!/usr/bin/env python3
"""Update everything from one uploaded survey: extract this quarter's feedback items
into the Synthesis Data File and publish its themes, then rebuild the quant dashboard
from every survey file currently in the New Survey Directory.

Triggered from the control panel's single "Update Dashboard" button — see
update_dashboard.yml for the workflow_dispatch inputs this reads from the environment.
The quant step is best-effort: if no Quant Data Folder has been picked yet, it's
skipped with a warning rather than failing the whole run, since quant setup is a
separate, optional, one-time step.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from themes import box_store, claude_client, config, publish, quant_data, quant_extract  # noqa: E402
from themes import quant_publish, survey_extract  # noqa: E402
from themes.tracker import Tracker, quarters_before, rows_in, survey_id as make_survey_id  # noqa: E402


def update_themes(survey_file_id: str, survey_file_name: str, year: int, quarter: str,
                   region: str) -> None:
    tracker_file_id = box_store.tracker_file_id()
    print(f"Downloading survey {survey_file_id} and tracker {tracker_file_id}...")
    survey_bytes = box_store.download(survey_file_id)
    tracker_bytes = box_store.download(tracker_file_id)

    t = Tracker(tracker_bytes)
    sid = make_survey_id(year, quarter, region)
    source_name = f"{sid} survey"

    if t.has_survey(sid):
        print(f"ERROR: {sid} already has rows in the tracker — this survey looks like it "
              "was already analyzed. Nothing was changed.", file=sys.stderr)
        raise SystemExit(1)

    print("Reading survey responses...")
    rows = survey_extract.response_rows(survey_file_name, survey_bytes)
    print(f"  {len(rows)} response(s).")
    if not rows:
        print("ERROR: No response rows found in the survey file.", file=sys.stderr)
        raise SystemExit(1)

    print("Asking Claude to extract feedback items...")
    items = claude_client.extract_feedback_items(rows, t.taxonomy())
    print(f"  {len(items)} item(s) extracted.")

    t.append_items(items, year, quarter, region, source_name)
    t.update_summary(sid)

    print("Uploading the updated tracker to Box...")
    box_store.upload_new_version(tracker_file_id, "tracker.xlsx", t.to_bytes())

    print("Synthesizing this quarter's themes...")
    all_rows = t.feedback_rows()
    prev_pool = rows_in(all_rows, quarters_before(year, quarter, 1, 1))
    year_pool = rows_in(all_rows, quarters_before(year, quarter, 1, 4))
    result = claude_client.synthesize_themes(items, prev_pool, year_pool)

    publish.merge(sid, result["current"], result["qoq"], result["yoy"], source_name)
    print(f"Published {sid}: {len(result['current'])} current, "
          f"{len(result['qoq'])} QoQ, {len(result['yoy'])} YoY.")


def update_quant() -> None:
    folder_id = box_store.quant_folder_id()
    if not folder_id:
        print("Skipping quant dashboard update: no Quant Data Folder has been picked "
              "yet on the control panel.")
        return

    print(f"Listing the Quant Data Folder ({folder_id}) for reference files...")
    quant_files = {f["name"]: f["id"] for f in box_store.list_folder(folder_id)}
    helper_id = quant_files.get(quant_data.HELPER_FILENAME)
    categories_id = quant_files.get(quant_data.CATEGORIES_FILENAME)
    if not helper_id:
        print(f"ERROR: '{quant_data.HELPER_FILENAME}' not found in the Quant Data "
              "Folder.", file=sys.stderr)
        raise SystemExit(1)
    if not categories_id:
        print(f"ERROR: '{quant_data.CATEGORIES_FILENAME}' not found in the Quant Data "
              "Folder.", file=sys.stderr)
        raise SystemExit(1)

    print(f"Downloading {quant_data.HELPER_FILENAME}...")
    helper = quant_data.read_helper(box_store.download(helper_id))
    print(f"  {len(helper)} meeting(s) in the helper.")

    print(f"Downloading {quant_data.CATEGORIES_FILENAME}...")
    categories = quant_data.read_categories(box_store.download(categories_id))
    print(f"  {len(categories)} metric(s) mapped.")

    print("Listing the New Survey Directory for survey files...")
    survey_files = box_store.list_folder(box_store.upload_folder_id())
    survey_names = [f["name"] for f in survey_files
                    if f["name"].lower().endswith((".xlsx", ".csv"))
                    and not f["name"].startswith("~$")]
    print(f"Found {len(survey_names)} survey file(s): {', '.join(survey_names) or '(none)'}")
    by_name = {f["name"]: f["id"] for f in survey_files}

    all_rows: list[dict] = []
    source_files: dict = {}
    for name in survey_names:
        print(f"  Reading {name}...")
        content = box_store.download(by_name[name])
        rows = quant_extract.unpivot(name, content)
        print(f"    {len(rows)} row(s).")
        all_rows.extend(rows)
        for row in rows:
            source_files[row["meeting_date"]] = name

    print("Building the quant dashboard...")
    data = quant_publish.build(all_rows, helper, categories, source_files)
    quant_publish.save(data)
    print(f"Published {len(data)} meeting(s) to {config.QUANT_DASHBOARD_JSON}.")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--survey-file-id", required=True)
    parser.add_argument("--survey-file-name", required=True)
    parser.add_argument("--year", required=True, type=int)
    parser.add_argument("--quarter", required=True, choices=["Q1", "Q2", "Q3", "Q4"])
    parser.add_argument("--region", required=True)
    args = parser.parse_args()

    if not box_store.enabled():
        print("ERROR: BOX_RELAY_URL and BOX_RELAY_SECRET are not set as repository "
              "secrets, so there is no way to reach Box. See SETUP.md.", file=sys.stderr)
        return 1
    if not config.ANTHROPIC_API_KEY:
        print("ERROR: ANTHROPIC_API_KEY is not set as a repository secret. See SETUP.md.",
              file=sys.stderr)
        return 1

    update_themes(args.survey_file_id, args.survey_file_name, args.year, args.quarter, args.region)
    update_quant()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
