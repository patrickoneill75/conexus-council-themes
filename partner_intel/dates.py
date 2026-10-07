"""Meeting date, in the order the admin chose: the text, then the file name, then the date
the file was uploaded to Box. Every answer carries its source, so a date that is only an
estimate can be filtered out later.

Two rules keep the text step honest:
  1. Only the top of the document, or a line labelled "Date", counts. A date deep in the
     body is usually something being discussed ("the next meeting is June 27"), not the
     date of this meeting.
  2. A meeting cannot be dated after the file was uploaded (one day of slack). That
     catches a future date in the text and falls through to the file name.
"""
from __future__ import annotations

import re
from datetime import date, datetime, timedelta

MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}

_MONTH_NAME = re.compile(
    r"\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|"
    r"sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b",
    re.I)
_ISO = re.compile(r"\b(20\d{2})[-._](\d{1,2})[-._](\d{1,2})\b")
_US = re.compile(r"(?<![\d.])(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?![\d])")
_LABELLED = re.compile(r"^\s*(?:meeting\s+)?date\s*[:\-]", re.I)

EARLIEST = date(2015, 1, 1)
TOP_LINES = 25


def _valid(y: int, m: int, d: int) -> date | None:
    try:
        result = date(y, m, d)
    except ValueError:
        return None
    return result if result >= EARLIEST else None


def dates_in(text: str) -> list[date]:
    """Every date in the text, in reading order."""
    found: list[tuple[int, date]] = []
    for m in _MONTH_NAME.finditer(text):
        d = _valid(int(m.group(3)), MONTHS[m.group(1)[:3].lower()], int(m.group(2)))
        if d:
            found.append((m.start(), d))
    for m in _ISO.finditer(text):
        d = _valid(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        if d:
            found.append((m.start(), d))
    for m in _US.finditer(text):
        year = int(m.group(3))
        if year < 100:
            year += 2000
        d = _valid(year, int(m.group(1)), int(m.group(2)))
        if d:
            found.append((m.start(), d))
    return [d for _, d in sorted(found, key=lambda pair: pair[0])]


def _parse_box(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).date()
    except ValueError:
        return None


def date_from_text(text: str, uploaded: date | None) -> date | None:
    lines = [l for l in text.splitlines() if l.strip()]
    candidates: list[date] = []
    for line in lines:
        if _LABELLED.match(line):
            candidates = dates_in(line)
            if candidates:
                break
    if not candidates:
        candidates = dates_in("\n".join(lines[:TOP_LINES]))
    for candidate in candidates:
        if uploaded and candidate > uploaded + timedelta(days=1):
            continue
        return candidate
    return None


def date_from_name(name: str, uploaded: date | None) -> date | None:
    stem = name.rsplit(".", 1)[0]
    for candidate in dates_in(stem):
        if uploaded and candidate > uploaded + timedelta(days=1):
            continue
        return candidate
    return None


def resolve_date(name: str, text: str, created_at: str | None, *, text_allowed: bool = True,
                 fallback_at: str | None = None) -> tuple[str, str]:
    """Return (YYYY-MM-DD, source) where source is "text", "filename" or "box_upload".

    created_at is the Box upload date. fallback_at overrides it as the last resort, which
    is how a section appended to a running document later gets the date it arrived rather
    than the date the document was first created.
    """
    uploaded = _parse_box(created_at)
    if text_allowed:
        found = date_from_text(text, uploaded)
        if found:
            return found.isoformat(), "text"
    found = date_from_name(name, uploaded)
    if found:
        return found.isoformat(), "filename"
    last = _parse_box(fallback_at) or uploaded
    return (last.isoformat() if last else ""), "box_upload"
