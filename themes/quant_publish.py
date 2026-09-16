"""Grouping unpivoted survey rows by meeting and writing public/quant-dashboard.json.

Every run replaces the file wholesale — see quant_extract.py and quant_data.py for why:
the source is "everything currently in Box," not a running log, so there is nothing to
merge. A meeting with no Council Meeting Helper row is skipped rather than published
half-resolved, since Year/Quarter/Region only ever come from that lookup (confirmed
with the user — the survey export itself never carries them).
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import date, datetime, timezone

from . import box_store, config, quant_data, quant_extract
from .tracker import survey_id


def build(long_rows: list[dict], helper: dict[date, dict], categories: dict[str, str],
          source_files: dict[date, str]) -> dict:
    """long_rows: quant_extract.unpivot() output from every survey file, concatenated.
    helper: quant_data.read_helper() output. categories: quant_data.read_categories()
    output. source_files: meeting_date -> the filename its rows came from (for display
    only; when a meeting's rows span more than one file, the last one wins).
    """
    by_meeting: dict[date, list[dict]] = defaultdict(list)
    for row in long_rows:
        by_meeting[row["meeting_date"]].append(row)

    data: dict[str, dict] = {}
    generated = datetime.now(timezone.utc).isoformat(timespec="seconds")

    for meeting_date, rows in by_meeting.items():
        info = helper.get(meeting_date)
        if not info or not info.get("year") or not info.get("quarter") or not info.get("region"):
            continue

        # "Survey Responses": no single row carries a respondent id, so this takes the
        # most-answered metric's count as the respondent count — almost every respondent
        # answers at least the most commonly-answered question, and a few skipped
        # questions elsewhere shouldn't undercount the meeting's actual response total.
        per_metric_counts: dict[str, int] = defaultdict(int)
        category_totals: dict[str, list[int]] = defaultdict(list)
        for row in rows:
            per_metric_counts[row["metric"]] += 1
            category = categories.get(row["metric"])
            if category:
                category_totals[category].append(row["value"])
        responses = max(per_metric_counts.values(), default=0)

        attendees = info.get("total_attendees")
        response_rate = (responses / attendees) if attendees else None

        by_category = {
            category: round(sum(values) / len(values), 2)
            for category, values in category_totals.items()
        }

        sid = survey_id(info["year"], info["quarter"], info["region"])
        data[sid] = {
            "avgAttendees": attendees,
            "responses": responses,
            "responseRate": response_rate,
            "byCategory": by_category,
            "generated": generated,
            "sourceFile": source_files.get(meeting_date, ""),
        }

    return data


def save(data: dict) -> None:
    config.QUANT_DASHBOARD_JSON.parent.mkdir(parents=True, exist_ok=True)
    config.QUANT_DASHBOARD_JSON.write_text(
        json.dumps(data, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8"
    )


def refresh() -> None:
    """Rebuild the whole quant dashboard from the Data Folder's three fixed-name files.
    No new upload needed -- used both as the second half of a normal Update Dashboard
    run, and on its own from the control panel's "Refresh Dashboard" button, e.g. after
    editing or deleting something directly in Box.

    A no-op (prints why, returns) if no Data Folder has been picked yet -- that's a
    normal, not-yet-configured state, not an error.
    """
    folder_id = box_store.data_folder_id()
    if not folder_id:
        print("Skipping quant dashboard update: no Data Folder has been picked yet on "
              "the control panel.")
        return

    print(f"Listing the Data Folder ({folder_id})...")
    files = {f["name"]: f["id"] for f in box_store.list_folder(folder_id)}
    helper_id = files.get(quant_data.HELPER_FILENAME)
    survey_id_ = files.get(quant_data.SURVEY_FILENAME)
    categories_id = files.get(quant_data.CATEGORIES_FILENAME)
    if not helper_id:
        print(f"ERROR: '{quant_data.HELPER_FILENAME}' not found in the Data Folder.",
              file=sys.stderr)
        raise SystemExit(1)
    if not survey_id_:
        print(f"ERROR: '{quant_data.SURVEY_FILENAME}' not found in the Data Folder.",
              file=sys.stderr)
        raise SystemExit(1)
    if not categories_id:
        print(f"ERROR: '{quant_data.CATEGORIES_FILENAME}' not found in the Data "
              "Folder.", file=sys.stderr)
        raise SystemExit(1)

    print(f"Downloading {quant_data.HELPER_FILENAME}...")
    helper = quant_data.read_helper(box_store.download(helper_id))
    print(f"  {len(helper)} meeting(s) in the helper.")

    print(f"Downloading {quant_data.CATEGORIES_FILENAME}...")
    categories = quant_data.read_categories(box_store.download(categories_id))
    print(f"  {len(categories)} metric(s) mapped.")

    print(f"Downloading {quant_data.SURVEY_FILENAME}...")
    content = box_store.download(survey_id_)
    rows = quant_extract.unpivot(quant_data.SURVEY_FILENAME, content)
    print(f"  {len(rows)} row(s).")
    source_files = {row["meeting_date"]: quant_data.SURVEY_FILENAME for row in rows}

    print("Building the quant dashboard...")
    data = build(rows, helper, categories, source_files)
    save(data)
    print(f"Published {len(data)} meeting(s) to {config.QUANT_DASHBOARD_JSON}.")
