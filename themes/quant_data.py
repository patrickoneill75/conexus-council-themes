"""Reading the three fixed-name files a dashboard run finds in the Data Folder:
'Council Meeting Helper.csv', 'Post-Meeting Survey.csv', and 'Content
Categories.xlsx'.

The Helper and Survey exports are cumulative — every fresh export from the survey
tool contains every meeting/response ever collected, not just the newest — so each
upload replaces the file in Box wholesale rather than merging. Content Categories is
static/slow-changing and admin-maintained directly in Box.
"""
from __future__ import annotations

import csv
import io
from datetime import date, datetime

from openpyxl import load_workbook

HELPER_FILENAME = "Council Meeting Helper.csv"
SURVEY_FILENAME = "Post-Meeting Survey.csv"
CATEGORIES_FILENAME = "Content Categories.xlsx"


def parse_date(value: str) -> date | None:
    value = (value or "").strip()
    if not value:
        return None
    for fmt in ("%b %d, %Y", "%m/%d/%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(value, fmt).date()
        except ValueError:
            continue
    return None


def _int_or_none(value: str) -> int | None:
    value = (value or "").strip()
    if not value:
        return None
    try:
        return int(float(value))
    except ValueError:
        return None


def read_helper(content: bytes) -> dict[date, dict]:
    """-> { Meeting Date: {year, quarter, region, total_registrants, total_attendees} }.

    A meeting with no attendance numbers recorded yet still gets an entry (Year/Quarter/
    Region are what a survey row needs to resolve; the attendee counts are optional).
    """
    text = content.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    fieldnames = {(f or "").strip().lower() for f in (reader.fieldnames or [])}
    if not fieldnames & {"meeting date", "year", "quarter", "region"}:
        # None of the columns this whole function depends on are present at all -- almost
        # always means the uploaded file isn't really a Helper export (wrong file picked,
        # or a spreadsheet saved in some other format and just renamed to .csv on the way
        # in). Silently returning {} here is how that turns into every meeting being
        # skipped downstream with no clue why -- fail loudly instead.
        raise ValueError(
            f"'{HELPER_FILENAME}' doesn't look like a Council Meeting Helper export -- "
            "none of its expected columns (Meeting Date, Year, Quarter, Region) were "
            f"found. Its header reads: {sorted(f for f in (reader.fieldnames or []) if f)!r}. "
            "Check the uploaded file is really a .csv export from the Helper form."
        )
    out: dict[date, dict] = {}
    for row in reader:
        meeting_date = parse_date(row.get("Meeting Date", ""))
        if not meeting_date:
            continue
        out[meeting_date] = {
            "year": _int_or_none(row.get("Year", "")),
            "quarter": (row.get("Quarter") or "").strip(),
            "region": (row.get("Region") or "").strip(),
            "total_registrants": _int_or_none(row.get("Total Registrants", "")),
            "total_attendees": _int_or_none(row.get("Total Attendees", "")),
        }
    return out


def read_categories(content: bytes) -> dict[str, str]:
    """-> { Metric name ("Detailed Category" in the source file): Content Category }.

    A metric with no mapping here (the source file doesn't cover every possible
    "Panel N"/"Workshop N" number) is simply left out of byCategory downstream —
    matching the real model's relationship exactly rather than inventing a group.
    """
    wb = load_workbook(io.BytesIO(content), data_only=True)
    ws = wb.active
    header = [str(c.value).strip() if c.value is not None else ""
              for c in next(ws.iter_rows(max_row=1))]
    detail_col = header.index("Detailed Category")
    content_col = header.index("Content Category")
    out: dict[str, str] = {}
    for raw in ws.iter_rows(min_row=2, values_only=True):
        if not any(raw):
            continue
        detail, content_cat = raw[detail_col], raw[content_col]
        if detail and content_cat:
            out[str(detail).strip()] = str(content_cat).strip()
    return out
