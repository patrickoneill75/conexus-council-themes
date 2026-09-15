"""Grouping unpivoted survey rows by meeting and writing public/quant-dashboard.json.

Every run replaces the file wholesale — see quant_extract.py and quant_data.py for why:
the source is "everything currently in the Quant Data Folder," not a running log, so
there is nothing to merge. A meeting with no Council Meeting Helper row is skipped
rather than published half-resolved, since Year/Quarter/Region only ever come from
that lookup (confirmed with the user — the survey export itself never carries them).
"""
from __future__ import annotations

import json
from collections import defaultdict
from datetime import date, datetime, timezone

from . import config
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
        if not info or not info.get("year") or not info.get("quarter"):
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
