"""Reading and writing data/feedback_log.json: the running history of every "area to
improve" item ever extracted, one entry per item — what tracker.xlsx's Feedback Log
tab used to be, before it moved into the repo (see themes/config.py).

themes/tracker.py's survey_id()/quarters_before()/rows_in() free functions work
unchanged against this module's rows: they only ever read "Year"/"Quarter" keys, not
anything Excel-specific.
"""
from __future__ import annotations

import json
import re
from datetime import date

from . import config
from .tracker import survey_id

FEEDBACK_HEADER = [
    "Item ID", "Year", "Quarter", "Region", "Survey ID", "Category", "Subcategory",
    "Feedback Item (verbatim)", "Status", "Owner", "Action Taken / Notes",
    "Date Added", "Source File",
]


def load() -> list[dict]:
    if not config.FEEDBACK_LOG_JSON.exists():
        return []
    return json.loads(config.FEEDBACK_LOG_JSON.read_text(encoding="utf-8"))


def save(rows: list[dict]) -> None:
    config.FEEDBACK_LOG_JSON.parent.mkdir(parents=True, exist_ok=True)
    config.FEEDBACK_LOG_JSON.write_text(
        json.dumps(rows, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )


def has_survey(rows: list[dict], sid: str) -> bool:
    return any(r.get("Survey ID") == sid for r in rows)


_ITEM_ID_RE = re.compile(r"^ITEM-(\d+)$")


def next_item_number(rows: list[dict]) -> int:
    """One past the highest ITEM-nnn already in `rows`.

    Not len(rows): scripts/remove_meetings.py deletes a meeting's entries in place,
    which leaves gaps in the numbering. Numbering the next append off the row COUNT
    then reissued ids that were still in use -- remove 2 of 4 items and the next
    append was handed ITEM-003 again, colliding with the surviving entry of the
    same name.
    """
    highest = 0
    for row in rows:
        match = _ITEM_ID_RE.match(str(row.get("Item ID") or ""))
        if match:
            highest = max(highest, int(match.group(1)))
    return highest + 1


def append(rows: list[dict], items: list[dict], year: int, quarter: str, region: str,
           source_file: str) -> str:
    """Append extracted items as new Feedback Log entries, in place. Returns the
    Survey ID used."""
    sid = survey_id(year, quarter, region)
    today = date.today().isoformat()
    n = next_item_number(rows) - 1
    for item in items:
        n += 1
        rows.append({
            "Item ID": f"ITEM-{n:03d}", "Year": year, "Quarter": quarter, "Region": region,
            "Survey ID": sid, "Category": item.get("category", ""),
            "Subcategory": item.get("subcategory", ""),
            "Feedback Item (verbatim)": item.get("text", ""),
            "Status": "Not Reviewed", "Owner": None, "Action Taken / Notes": None,
            "Date Added": today, "Source File": source_file,
        })
    return sid
