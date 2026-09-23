"""Reading the three fixed-name files a dashboard run finds in the Data Folder:
'Council Meeting Helper.csv', 'Post-Meeting Survey.csv', and 'Content Categories'
(.csv or .xlsx -- see CATEGORIES_FILENAMES).

The Helper and Survey exports are cumulative — every fresh export from the survey
tool contains every meeting/response ever collected, not just the newest — so each
upload replaces the file in Box wholesale rather than merging. Content Categories is
static/slow-changing and admin-maintained directly in Box, so unlike the other two its
name isn't forced by an upload route -- whichever format the admin saves it as is
whatever's actually in the Data Folder.
"""
from __future__ import annotations

import csv
import io
from datetime import date

from . import quant_extract, sheet_io

HELPER_FILENAME = "Council Meeting Helper.csv"
SURVEY_FILENAME = "Post-Meeting Survey.csv"
CATEGORIES_FILENAMES = ("Content Categories.csv", "Content Categories.xlsx")

# quant_extract.as_date() is the one canonical date parser both this module and
# quant_extract's own unpivot() use -- keeping a second, separately-maintained format
# list here is exactly how the Helper file's real "12-Aug-26" (%d-%b-%y) style dates
# went unrecognized even though quant_extract already handled that format.
parse_date = quant_extract.as_date


def _int_or_none(value: str) -> int | None:
    value = (value or "").strip()
    if not value:
        return None
    try:
        return int(float(value))
    except ValueError:
        return None


def _column_lookup(fieldnames) -> dict[str, str]:
    """Normalized column name -> the RAW key csv.DictReader actually puts in each row.

    Both halves matter. Matching on the stripped, lower-cased name is what lets a real
    export whose header reads "Meeting Date " or "YEAR" still resolve. Mapping back to
    the raw key is what makes the subsequent row.get() actually find anything: DictReader
    keys every row by the header text verbatim, so looking a column up by its normalized
    name returned None for every row -- the whole file resolved to zero meetings, with no
    error, purely because of a trailing space in the header.
    """
    lookup: dict[str, str] = {}
    for raw in (fieldnames or []):
        key = (raw or "").strip().lower()
        if key and key not in lookup:
            lookup[key] = raw
    return lookup


def _cell(row: dict, columns: dict[str, str], name: str) -> str:
    """One row's value for a normalized column name, "" when that column isn't present."""
    key = columns.get(name)
    return "" if key is None else (row.get(key) or "")


def read_helper(content: bytes) -> dict[date, dict]:
    """-> { Meeting Date: {year, quarter, region, total_registrants, total_attendees} }.

    A meeting with no attendance numbers recorded yet still gets an entry (Year/Quarter/
    Region are what a survey row needs to resolve; the attendee counts are optional).
    """
    text = content.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    columns = _column_lookup(reader.fieldnames)
    fieldnames = {(f or "").strip() for f in (reader.fieldnames or [])}
    date_col = columns.get("meeting date")
    if date_col is None:
        # Every row's Meeting Date lookup below depends on this exact column existing --
        # its absence alone means the whole file resolves to zero meetings, which (since
        # the quant dashboard is rebuilt from scratch every run -- see quant_publish.py)
        # would silently wipe out everything already published. Almost always means the
        # uploaded file isn't really a Helper export (wrong file picked, a spreadsheet
        # saved in some other format and renamed to .csv on the way in, or a real export
        # whose column got renamed) -- fail loudly instead of silently returning {}.
        raise ValueError(
            f"'{HELPER_FILENAME}' has no 'Meeting Date' column -- nothing in it can "
            f"resolve. Its header reads: {sorted(fieldnames)!r}. Check the uploaded file "
            "is really a .csv export from the Helper form."
        )

    out: dict[date, dict] = {}
    unparseable: list[str] = []
    collisions: list[tuple[date, str, str]] = []
    for row in reader:
        raw_date = row.get(date_col, "")
        meeting_date = parse_date(raw_date)
        if not meeting_date:
            if (raw_date or "").strip():
                unparseable.append(raw_date)
            continue
        previous = out.get(meeting_date)
        out[meeting_date] = {
            "year": _int_or_none(_cell(row, columns, "year")),
            "quarter": _cell(row, columns, "quarter").strip(),
            "region": _cell(row, columns, "region").strip(),
            "total_registrants": _int_or_none(_cell(row, columns, "total registrants")),
            "total_attendees": _int_or_none(_cell(row, columns, "total attendees")),
        }
        if previous and (previous["year"], previous["quarter"], previous["region"]) != (
                out[meeting_date]["year"], out[meeting_date]["quarter"], out[meeting_date]["region"]):
            collisions.append((
                meeting_date,
                f"{previous['year']}-{previous['quarter']} {previous['region']}",
                f"{out[meeting_date]['year']}-{out[meeting_date]['quarter']} "
                f"{out[meeting_date]['region']}",
            ))

    for meeting_date, dropped, kept in collisions:
        # Survey responses carry ONLY a Meeting Date, so two meetings on the same day
        # are genuinely indistinguishable downstream -- this lookup can keep just one,
        # and every response from that date is then attributed to it. That is a real
        # possibility here (Central and Southern both meet most quarters), and it used
        # to happen silently. It still can't be resolved automatically, but an operator
        # can now see it and split the exports by hand.
        print(f"  ! '{HELPER_FILENAME}' has more than one meeting on {meeting_date}: "
              f"{dropped} was replaced by {kept}. Every survey response from that date "
              f"will be attributed to {kept}.")

    if not out and unparseable:
        # The column exists, and rows have real values in it, but none of them matched
        # any known format -- almost certainly a date format this hasn't seen before
        # (parse_date()'s format list is a fixed, known set). Surfacing real examples
        # here is what makes that fixable instead of just "0 meetings" with no clue why.
        raise ValueError(
            f"'{HELPER_FILENAME}' has a '{date_col}' column, but none of its values "
            f"parsed as a date -- e.g. {unparseable[:3]!r}. Recognized formats: "
            f"{quant_extract._DATE_FORMATS!r}."
        )
    return out


def _find_col(header: list[str], name: str) -> int | None:
    return next((i for i, h in enumerate(header) if h.strip().lower() == name), None)


def strip_meetings(helper_content: bytes, survey_content: bytes,
                    targets: set[tuple[int, str, str]]) -> tuple[bytes, bytes, list[date]]:
    """Remove every Helper row whose raw (Year, Quarter, Region) is in `targets`
    (exactly the tuples a Survey ID like "2026-Q4 Northern" parses into), and every
    Survey row whose Meeting Date matches one of those removed rows.
    -> (new Helper .csv bytes, new Survey .csv bytes, the meeting dates removed).

    A target with no matching Helper row is simply a no-op for that target, not an
    error -- its meeting may have already aged out of the cumulative export, or Box
    may never have had it in the first place (e.g. historical data migrated straight
    into the published dashboards, before this pipeline existed).
    """
    helper_header, helper_rows = sheet_io.read_rows(HELPER_FILENAME, helper_content)
    year_col = _find_col(helper_header, "year")
    quarter_col = _find_col(helper_header, "quarter")
    region_col = _find_col(helper_header, "region")
    helper_date_col = _find_col(helper_header, "meeting date")
    if None in (year_col, quarter_col, region_col, helper_date_col):
        raise ValueError(
            f"'{HELPER_FILENAME}' is missing a Year/Quarter/Region/Meeting Date column "
            f"-- cannot identify which rows to remove. Its header reads: {helper_header!r}."
        )

    keep_helper_rows = []
    removed_dates: list[date] = []
    for row in helper_rows:
        if not any(row):
            continue
        key = (_int_or_none(str(row[year_col] or "")),
               str(row[quarter_col] or "").strip(),
               str(row[region_col] or "").strip())
        if key in targets:
            d = parse_date(str(row[helper_date_col] or ""))
            if d:
                removed_dates.append(d)
            continue
        keep_helper_rows.append(row)

    survey_header, survey_rows = sheet_io.read_rows(SURVEY_FILENAME, survey_content)
    survey_date_col = _find_col(survey_header, "meeting date")
    removed_set = set(removed_dates)
    keep_survey_rows = survey_rows if survey_date_col is None or not removed_set else [
        row for row in survey_rows if parse_date(str(row[survey_date_col] or "")) not in removed_set
    ]

    return (sheet_io.write_csv(helper_header, keep_helper_rows),
            sheet_io.write_csv(survey_header, keep_survey_rows),
            removed_dates)


def read_categories(filename: str, content: bytes) -> dict[str, str]:
    """-> { Metric name ("Detailed Category" in the source file): Content Category }.
    `filename` decides whether to read `content` as .csv or .xlsx (see sheet_io).

    A metric with no mapping here (the source file doesn't cover every possible
    "Panel N"/"Workshop N" number) is simply left out of byCategory downstream —
    matching the real model's relationship exactly rather than inventing a group.
    """
    header, rows = sheet_io.read_rows(filename, content)
    try:
        detail_col = header.index("Detailed Category")
        content_col = header.index("Content Category")
    except ValueError:
        raise ValueError(
            f"'{filename}' doesn't have both a 'Detailed Category' and a 'Content "
            f"Category' column. Its header reads: {header!r}."
        ) from None
    out: dict[str, str] = {}
    for raw in rows:
        if not any(raw):
            continue
        detail, content_cat = raw[detail_col], raw[content_col]
        if detail and content_cat:
            out[str(detail).strip()] = str(content_cat).strip()
    return out
