"""Reading a raw quant survey export and unpivoting its rating columns.

Deterministic, no AI: mirrors the real Power BI model's 'All' table build exactly
(Table.SelectColumns + Table.UnpivotOtherColumns, confirmed from the uploaded
.SemanticModel project). The metric column names are a small, stable, known set —
not free text to interpret — so matching by name is the right tool here, unlike the
themes pipeline's free-response extraction.

Year/Quarter/Region are deliberately not read from this file at all, even though a
real export carries its own Year/Quarter/Region columns: the survey only ever
reliably carries Meeting Date, and Year/Quarter/Region get resolved from that via the
Council Meeting Helper (see quant_data.py) — confirmed with the user as the real
relationship (mirroring the Power BI model's own All -> Council Meeting Helper join).
"""
from __future__ import annotations

from datetime import date, datetime

from . import sheet_io

KNOWN_METRICS = [
    "Meeting logistics", "Prepared", "Overall value",
    "Presentation 1", "Presentation 2", "Presentation 3", "Presentation 4",
    "Panel 1", "Panel 2", "Panel 3", "Panel 4",
    "Workshop 1", "Workshop 2", "Workshop 3", "Workshop 4",
]
_METRIC_BY_LOWER = {m.lower(): m for m in KNOWN_METRICS}


_DATE_FORMATS = ("%d-%b-%y", "%d-%b-%Y", "%m/%d/%Y", "%Y-%m-%d")


def _as_date(value) -> date | None:
    """Excel gives typed date/datetime cells; a real .csv export gives a plain string
    like '12-Aug-26' (%d-%b-%y) — both are meeting dates, just shaped differently."""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        value = value.strip()
        if not value:
            return None
        for fmt in _DATE_FORMATS:
            try:
                return datetime.strptime(value, fmt).date()
            except ValueError:
                continue
    return None


def unpivot(filename: str, survey_bytes: bytes) -> list[dict]:
    """One survey file -> [{meeting_date, organization, metric, value}, ...], one row per
    (respondent, metric) answered. Rows with no Meeting Date, or whose value isn't a
    whole number, are skipped rather than guessed at.
    """
    header, data_rows = sheet_io.read_rows(filename, survey_bytes)

    date_col = next((i for i, h in enumerate(header) if h.lower() == "meeting date"), None)
    org_col = next((i for i, h in enumerate(header) if h.lower() == "organization name"), None)
    metric_cols = [(i, _METRIC_BY_LOWER[h.lower()]) for i, h in enumerate(header)
                   if h.lower() in _METRIC_BY_LOWER]

    if date_col is None:
        raise ValueError("No 'Meeting Date' column found in the survey file.")
    if not metric_cols:
        raise ValueError("No known rating columns found in the survey file.")

    rows = []
    for raw in data_rows:
        if not any(raw):
            continue
        meeting_date = _as_date(raw[date_col])
        if not meeting_date:
            continue
        organization = raw[org_col] if org_col is not None else None
        for col, metric in metric_cols:
            value = raw[col]
            if value in (None, ""):
                continue
            try:
                value = int(value)
            except (TypeError, ValueError):
                continue
            rows.append({
                "meeting_date": meeting_date,
                "organization": organization,
                "metric": metric,
                "value": value,
            })
    return rows
