#!/usr/bin/env python3
"""One-time (or re-run-able) bootstrap: synthesize current/QoQ/YoY themes for every
quarter already sitting in data/feedback_log.json -- no new survey involved.

Triggered from the control panel's "Run full re-analysis" button.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from themes import claude_client, config, feedback_log, publish  # noqa: E402
from themes.tracker import quarters_before, rows_in  # noqa: E402


def main() -> int:
    if not config.ANTHROPIC_API_KEY:
        print("ERROR: ANTHROPIC_API_KEY is not set as a repository secret. See SETUP.md.",
              file=sys.stderr)
        return 1

    all_rows = feedback_log.load()
    if not all_rows:
        print(f"ERROR: {config.FEEDBACK_LOG_JSON} is empty or missing -- nothing to "
              "re-analyze.", file=sys.stderr)
        return 1

    groups: dict[str, list[dict]] = {}
    for row in all_rows:
        sid = row.get("Survey ID")
        if sid:
            groups.setdefault(sid, []).append(row)
    print(f"Found {len(groups)} quarter(s) in the Feedback Log: {', '.join(sorted(groups))}")

    for sid, items in sorted(groups.items()):
        year, quarter = items[0].get("Year"), items[0].get("Quarter")
        if year is None or not quarter:
            print(f"  ! Skipping {sid}: missing Year/Quarter on its rows.")
            continue
        print(f"Synthesizing {sid} ({len(items)} item(s))...")
        prev_pool = rows_in(all_rows, quarters_before(year, quarter, 1, 1))
        year_pool = rows_in(all_rows, quarters_before(year, quarter, 1, 4))
        result = claude_client.synthesize_themes(items, prev_pool, year_pool)
        source_file = items[0].get("Source File") or sid
        publish.merge(sid, result["current"], result["qoq"], result["yoy"], source_file)
        print(f"  published: {len(result['current'])} current, "
              f"{len(result['qoq'])} QoQ, {len(result['yoy'])} YoY.")

    print(f"Done. {len(groups)} quarter(s) published.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
