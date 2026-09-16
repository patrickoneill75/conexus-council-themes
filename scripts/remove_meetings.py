#!/usr/bin/env python3
"""Remove one or more meetings' data entirely, then re-synthesize what's left.

Reads SURVEY_IDS (comma-separated Survey IDs, e.g. "2026-Q3 Central,2026-Q3
Southern") from the environment. For each one: strips its rows out of
data/feedback_log.json, and drops its key from public/council-themes.json and
public/quant-dashboard.json. Then re-synthesizes current/QoQ/YoY for every quarter
still left in the Feedback Log -- the same full re-analysis scripts/setup_analysis.py
does -- since a removed meeting can have been part of another quarter's QoQ/YoY pool.

This never touches Box: if the same bad row is still in the Data Folder's
Post-Meeting Survey export, a future Update Dashboard run will pick it up again as
new (that's the whole "auto-detect what's not in the Feedback Log yet" mechanism).
Fix or remove it there too if it shouldn't come back.

Triggered from the control panel's "Remove & refresh" button, next to the meetings
table.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from themes import claude_client, config, feedback_log, publish, quant_publish  # noqa: E402
from themes.tracker import quarters_before, rows_in  # noqa: E402


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

    quant_data = quant_publish.load()
    removed_quant = [sid for sid in targets if sid in quant_data]
    for sid in removed_quant:
        del quant_data[sid]
    quant_publish.save(quant_data)
    print(f"  quant-dashboard.json: removed {len(removed_quant)} quarter(s).")

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
