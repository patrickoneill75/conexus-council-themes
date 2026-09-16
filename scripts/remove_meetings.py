#!/usr/bin/env python3
"""Remove one or more meetings' data entirely, then re-synthesize what's left.

Reads SURVEY_IDS (comma-separated Survey IDs, e.g. "2026-Q3 Central,2026-Q3
Southern") from the environment. For each one: strips its rows out of
data/feedback_log.json, and drops its key from public/council-themes.json and
public/quant-dashboard.json. Then re-synthesizes current/QoQ/YoY for every quarter
still left in the Feedback Log -- the same full re-analysis scripts/setup_analysis.py
does -- since a removed meeting can have been part of another quarter's QoQ/YoY pool.

Also strips the matching rows out of the Data Folder's own Council Meeting Helper and
Post-Meeting Survey exports in Box, best-effort: without that, a future Update
Dashboard run would just re-detect the same meeting as new and bring it right back,
since "new" only ever means "not in data/feedback_log.json yet". This step is never
fatal -- Box may not be reachable in every environment this script runs in, and the
Feedback Log / dashboard cleanup above is what actually matters.

Triggered from the control panel's "Remove & refresh" button, next to the meetings
table.
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from themes import (  # noqa: E402
    box_store, claude_client, config, feedback_log, publish, quant_data, quant_publish,
)
from themes.tracker import quarters_before, rows_in  # noqa: E402

_SURVEY_ID_RE = re.compile(r"^(\d{4})-(Q[1-4]) (.+)$")


def _parse_targets(sids: set[str]) -> set[tuple[int, str, str]]:
    """Survey IDs -> the raw (Year, Quarter, Region) tuples they were built from --
    what quant_data.strip_meetings() needs to match against the Helper file's own
    columns, which is where those three values originally came from."""
    parsed = set()
    for sid in sids:
        m = _SURVEY_ID_RE.match(sid)
        if m:
            parsed.add((int(m.group(1)), m.group(2), m.group(3)))
    return parsed


def _strip_from_box(targets: set[str]) -> None:
    if not box_store.enabled():
        print("  Box is not configured (BOX_RELAY_URL/BOX_RELAY_SECRET) -- skipping "
              "Box cleanup. The Feedback Log and dashboards are already clean.")
        return
    folder_id = box_store.data_folder_id()
    if not folder_id:
        print("  No Data Folder has been picked yet -- skipping Box cleanup.")
        return

    files = {f["name"]: f["id"] for f in box_store.list_folder(folder_id)}
    helper_id = files.get(quant_data.HELPER_FILENAME)
    survey_file_id = files.get(quant_data.SURVEY_FILENAME)
    if not helper_id or not survey_file_id:
        print(f"  '{quant_data.HELPER_FILENAME}' or '{quant_data.SURVEY_FILENAME}' not "
              "found in the Data Folder -- skipping Box cleanup.")
        return

    key_targets = _parse_targets(targets)
    if not key_targets:
        print("  No parseable Survey IDs to remove from Box.")
        return

    helper_content = box_store.download(helper_id)
    survey_content = box_store.download(survey_file_id)
    new_helper, new_survey, removed_dates = quant_data.strip_meetings(
        helper_content, survey_content, key_targets)

    if not removed_dates:
        print("  No matching rows found in the Data Folder's current exports -- "
              "nothing to remove there (the meeting may have already aged out of the "
              "export, or never made it into Box in the first place).")
        return

    box_store.upload_new_version(helper_id, quant_data.HELPER_FILENAME, new_helper)
    box_store.upload_new_version(survey_file_id, quant_data.SURVEY_FILENAME, new_survey)
    when = ", ".join(sorted(d.isoformat() for d in removed_dates))
    print(f"  Box: removed {len(removed_dates)} meeting date(s) ({when}) from "
          f"'{quant_data.HELPER_FILENAME}' and '{quant_data.SURVEY_FILENAME}'.")


def main() -> int:
    raw = os.environ.get("SURVEY_IDS", "").strip()
    if not raw:
        print("ERROR: No Survey IDs given -- nothing to remove.", file=sys.stderr)
        return 1
    targets = {sid.strip() for sid in raw.split(",") if sid.strip()}
    print(f"Removing {len(targets)} meeting(s): {', '.join(sorted(targets))}")

    log_rows = feedback_log.load()
    before = len(log_rows)
    log_rows = [r for r in log_rows if r.get("Survey ID") not in targets]
    feedback_log.save(log_rows)
    print(f"  Feedback Log: removed {before - len(log_rows)} item(s), "
          f"{len(log_rows)} remain.")

    themes_data = publish.load()
    removed_themes = [sid for sid in targets if sid in themes_data]
    for sid in removed_themes:
        del themes_data[sid]
    publish.save(themes_data)
    print(f"  council-themes.json: removed {len(removed_themes)} quarter(s).")

    quant_dashboard = quant_publish.load()
    removed_quant = [sid for sid in targets if sid in quant_dashboard]
    for sid in removed_quant:
        del quant_dashboard[sid]
    quant_publish.save(quant_dashboard)
    print(f"  quant-dashboard.json: removed {len(removed_quant)} quarter(s).")

    print("Removing matching rows from Box, if reachable...")
    try:
        _strip_from_box(targets)
    except Exception as e:
        print(f"  ! Could not update Box: {e}", file=sys.stderr)

    if not log_rows:
        print("Feedback Log is now empty -- nothing left to re-synthesize.")
        return 0

    if not config.ANTHROPIC_API_KEY:
        print("ERROR: ANTHROPIC_API_KEY is not set as a repository secret -- cannot "
              "re-synthesize what's left. See SETUP.md.", file=sys.stderr)
        return 1

    groups: dict[str, list[dict]] = {}
    for row in log_rows:
        sid = row.get("Survey ID")
        if sid:
            groups.setdefault(sid, []).append(row)
    print(f"Re-synthesizing {len(groups)} remaining quarter(s)...")
    for sid, items in sorted(groups.items()):
        year, quarter = items[0].get("Year"), items[0].get("Quarter")
        if year is None or not quarter:
            print(f"  ! Skipping {sid}: missing Year/Quarter on its rows.")
            continue
        print(f"  Synthesizing {sid} ({len(items)} item(s))...")
        prev_pool = rows_in(log_rows, quarters_before(year, quarter, 1, 1))
        year_pool = rows_in(log_rows, quarters_before(year, quarter, 1, 4))
        result = claude_client.synthesize_themes(items, prev_pool, year_pool)
        source_file = items[0].get("Source File") or sid
        publish.merge(sid, result["current"], result["qoq"], result["yoy"], source_file)
        print(f"    published: {len(result['current'])} current, "
              f"{len(result['qoq'])} QoQ, {len(result['yoy'])} YoY.")

    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
