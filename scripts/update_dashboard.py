#!/usr/bin/env python3
"""Update everything from the Data Folder's two cumulative exports.

No inputs: Year/Quarter/Region are resolved per meeting from the Council Meeting
Helper export by Meeting Date (see themes/quant_data.py), and "new" means "not
already in the Feedback Log" (see themes/feedback_log.py) -- so a run here catches up
on every meeting added since the last run, however many that is, in one pass. Ends by
rebuilding the quant dashboard the same way scripts/refresh_dashboard.py does, since
that's always correct to redo (the survey export is cumulative, not incremental).

Triggered from the control panel's single "Update Dashboard" button.
"""
from __future__ import annotations

import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from themes import (  # noqa: E402
    box_store, claude_client, config, feedback_log, quant_data, quant_publish,
    sheet_io, survey_extract, taxonomy,
)
from themes.tracker import quarters_before, rows_in, survey_id as make_survey_id  # noqa: E402
from themes import publish  # noqa: E402


def _find_col(header: list[str], name: str) -> int | None:
    return next((i for i, h in enumerate(header) if h.strip().lower() == name), None)


def process_new_meetings() -> int:
    """Extract and synthesize themes for every meeting in the Data Folder's survey
    export that isn't in the Feedback Log yet. Returns how many were processed."""
    folder_id = box_store.data_folder_id()
    if not folder_id:
        print("ERROR: No Data Folder has been picked yet. Open the control panel and "
              "choose one under Developer.", file=sys.stderr)
        raise SystemExit(1)

    print(f"Listing the Data Folder ({folder_id})...")
    files = {f["name"]: f["id"] for f in box_store.list_folder(folder_id)}
    helper_id = files.get(quant_data.HELPER_FILENAME)
    survey_file_id = files.get(quant_data.SURVEY_FILENAME)
    if not helper_id:
        print(f"ERROR: '{quant_data.HELPER_FILENAME}' not found in the Data Folder.",
              file=sys.stderr)
        raise SystemExit(1)
    if not survey_file_id:
        print(f"ERROR: '{quant_data.SURVEY_FILENAME}' not found in the Data Folder.",
              file=sys.stderr)
        raise SystemExit(1)

    print(f"Downloading {quant_data.HELPER_FILENAME}...")
    helper = quant_data.read_helper(box_store.download(helper_id))
    print(f"  {len(helper)} meeting(s) in the helper.")

    print(f"Downloading {quant_data.SURVEY_FILENAME}...")
    header, rows = sheet_io.read_rows(quant_data.SURVEY_FILENAME,
                                       box_store.download(survey_file_id))
    date_col = _find_col(header, "meeting date")
    if date_col is None:
        print("ERROR: No 'Meeting Date' column found in the survey export.",
              file=sys.stderr)
        raise SystemExit(1)

    by_date = defaultdict(list)
    for raw in rows:
        if not any(raw):
            continue
        d = quant_data.parse_date(str(raw[date_col] or ""))
        if d:
            by_date[d].append(raw)
    print(f"  {sum(len(v) for v in by_date.values())} response(s) across "
          f"{len(by_date)} meeting date(s).")

    log_rows = feedback_log.load()
    taxo = taxonomy.load()
    log_changed = False
    processed = 0

    for meeting_date in sorted(by_date):
        info = helper.get(meeting_date)
        if not info or not info.get("year") or not info.get("quarter") or not info.get("region"):
            print(f"  ! Skipping {meeting_date}: no matching Council Meeting Helper "
                  "row (or it's missing Year/Quarter/Region).")
            continue

        year, quarter, region = info["year"], info["quarter"], info["region"]
        sid = make_survey_id(year, quarter, region)
        if feedback_log.has_survey(log_rows, sid):
            continue

        print(f"New meeting: {sid} ({meeting_date})")
        meeting_rows = survey_extract.response_rows(header, by_date[meeting_date])
        print(f"  {len(meeting_rows)} response(s) with free-text answers.")
        if not meeting_rows:
            print(f"  ! No free-response rows for {sid} -- skipping extraction.")
            continue

        print("  Asking Claude to extract feedback items...")
        items = claude_client.extract_feedback_items(meeting_rows, taxo)
        print(f"    {len(items)} item(s) extracted.")

        source_name = f"{sid} ({quant_data.SURVEY_FILENAME})"
        feedback_log.append(log_rows, items, year, quarter, region, source_name)
        if taxonomy.merge_new(taxo, items):
            print("    Taxonomy extended with a new category/subcategory.")
        log_changed = True

        print("  Synthesizing this quarter's themes...")
        prev_pool = rows_in(log_rows, quarters_before(year, quarter, 1, 1))
        year_pool = rows_in(log_rows, quarters_before(year, quarter, 1, 4))
        result = claude_client.synthesize_themes(items, prev_pool, year_pool)
        publish.merge(sid, result["current"], result["qoq"], result["yoy"], source_name)
        print(f"  Published {sid}: {len(result['current'])} current, "
              f"{len(result['qoq'])} QoQ, {len(result['yoy'])} YoY.")
        processed += 1

    if log_changed:
        feedback_log.save(log_rows)
        taxonomy.save(taxo)
        print(f"Saved {config.FEEDBACK_LOG_JSON} and {config.TAXONOMY_JSON}.")

    return processed


def main() -> int:
    if not box_store.enabled():
        print("ERROR: BOX_RELAY_URL and BOX_RELAY_SECRET are not set as repository "
              "secrets, so there is no way to reach Box. See SETUP.md.", file=sys.stderr)
        return 1
    if not config.ANTHROPIC_API_KEY:
        print("ERROR: ANTHROPIC_API_KEY is not set as a repository secret. See SETUP.md.",
              file=sys.stderr)
        return 1

    processed = process_new_meetings()
    print(f"{processed} new meeting(s) processed." if processed
          else "No new meetings found -- Feedback Log is already up to date.")

    quant_publish.refresh()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
