#!/usr/bin/env python3
"""One-time: seed data/feedback_log.json and data/taxonomy.json from the old
tracker.xlsx in Box.

Merges into whatever's already in data/feedback_log.json rather than overwriting it --
by the time this runs, the new auto-detect pipeline may already have processed
meetings the old tracker never saw (or, the other way around, still has stale rows in
it from testing done before the cutover to the new pipeline). A tracker row whose
Survey ID is already present in the Feedback Log is skipped; everything else is
historical data this repo doesn't have anywhere else, since council-themes.json only
ever held the already-synthesized theme summaries, never the raw feedback items
QoQ/YoY comparisons are computed from.

Triggered once via the GitHub Actions API, not from the control panel -- there's no
button for this, it's meant to run once and then be deleted (see themes/box_store.py's
tracker_file_id() docstring).
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from themes import box_store, config, feedback_log, taxonomy  # noqa: E402
from themes.tracker import Tracker  # noqa: E402


def main() -> int:
    if not box_store.enabled():
        print("ERROR: BOX_RELAY_URL and BOX_RELAY_SECRET are not set as repository "
              "secrets, so there is no way to reach Box. See SETUP.md.", file=sys.stderr)
        return 1

    tracker_id = box_store.tracker_file_id()
    if not tracker_id:
        print("ERROR: No tracker file is on record. This migration needs the "
              "tracker.xlsx that was selected under the control panel's old Developer "
              "picker -- if it was never picked, or Box has been disconnected since, "
              "there's nothing for this to read.", file=sys.stderr)
        return 1

    print(f"Downloading tracker {tracker_id}...")
    t = Tracker(box_store.download(tracker_id))

    old_taxonomy = t.taxonomy()
    old_rows = t.feedback_rows()
    print(f"  {len(old_rows)} feedback item(s) across the tracker's history.")

    log_rows = feedback_log.load()
    print(f"  {len(log_rows)} item(s) already in {config.FEEDBACK_LOG_JSON}.")
    existing_sids = {r.get("Survey ID") for r in log_rows}

    added = 0
    for row in old_rows:
        sid = row.get("Survey ID")
        if not sid or sid in existing_sids:
            continue
        log_rows.append(row)
        added += 1
    print(f"  Adding {added} historical item(s) not already present.")

    taxo = taxonomy.load()
    for category, subs in old_taxonomy.items():
        current = taxo.setdefault(category, [])
        for sub in subs:
            if sub not in current:
                current.append(sub)

    feedback_log.save(log_rows)
    taxonomy.save(taxo)
    print(f"Saved {len(log_rows)} total item(s) to {config.FEEDBACK_LOG_JSON}, "
          f"{len(taxo)} categor(ies) to {config.TAXONOMY_JSON}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
