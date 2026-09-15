"""Reading and writing the tracker spreadsheet: Feedback Log, Lists, Summary.

The tracker is the running history of every "area to improve" item ever extracted,
one row per item (see SETUP.md / the tracker's own "How to Use" tab). This module
knows its exact layout — column order, the Item ID / Survey ID formula conventions,
the Summary tab's COUNTIFS pattern — so the rest of the pipeline never has to.

Item ID and Survey ID are plain computed values here, not the live formulas the
original template uses (`="ITEM-"&TEXT(ROW()-1,"000")` / `=B2&"-"&C2&" "&D2`):
openpyxl never evaluates formulas, so a formula cell this script writes would read
back as an empty value on the very next run. Writing the same result as a literal
string keeps the numbering identical while staying readable by Excel *and* by this
script's own next run. The Summary tab's COUNTIFS formulas are left as real formulas
since nothing here ever reads them back — only a human opening the file does.
"""
from __future__ import annotations

import io
from datetime import date

from openpyxl import load_workbook
from openpyxl.utils import range_boundaries, get_column_letter

FEEDBACK_LOG = "Feedback Log"
LISTS = "Lists"
SUMMARY = "Summary"
FEEDBACK_TABLE = "FeedbackLog"

FEEDBACK_HEADER = [
    "Item ID", "Year", "Quarter", "Region", "Survey ID", "Category", "Subcategory",
    "Feedback Item (verbatim)", "Status", "Owner", "Action Taken / Notes",
    "Date Added", "Source File",
]

# The Summary tab's per-category COUNTIFS formulas are pre-sized to this many data
# rows in the Feedback Log (see the template) — comfortably more than any realistic
# amount of growth, and matching it means adding a column never has to touch the
# existing category rows' formulas, only add a new one.
SUMMARY_ROW_CAP = 566

_QUARTER_ORDER = ["Q1", "Q2", "Q3", "Q4"]


def survey_id(year: int, quarter: str, region: str) -> str:
    return f"{year}-{quarter} {region}"


def _quarter_offset(year: int, quarter: str, back: int) -> tuple[int, str]:
    total = year * 4 + _QUARTER_ORDER.index(quarter) - back
    return total // 4, _QUARTER_ORDER[total % 4]


def quarters_before(year: int, quarter: str, start: int, end: int) -> set[tuple[int, str]]:
    """(year, quarter) pairs from `start` to `end` quarters before the given one,
    inclusive. quarters_before(2026, "Q3", 1, 1) is just the immediately prior
    quarter; quarters_before(2026, "Q3", 1, 4) is the trailing four quarters
    before that (the "trailing year", however many meetings that covers)."""
    return {_quarter_offset(year, quarter, back) for back in range(start, end + 1)}


def rows_in(rows: list[dict], periods: set[tuple[int, str]]) -> list[dict]:
    return [r for r in rows if (r.get("Year"), r.get("Quarter")) in periods]


class Tracker:
    def __init__(self, content: bytes):
        self.wb = load_workbook(io.BytesIO(content))

    # ---------- reading ----------

    def taxonomy(self) -> dict[str, list[str]]:
        """Category -> its known subcategories, from the Lists tab's own map
        (columns G/H: "Category" | "Subcategories that belong to it", pipe-separated)."""
        ws = self.wb[LISTS]
        taxonomy: dict[str, list[str]] = {}
        for category, subs in ws.iter_rows(min_row=5, min_col=7, max_col=8, values_only=True):
            if not category:
                continue
            taxonomy[category] = [s.strip() for s in (subs or "").split("|") if s.strip()]
        return taxonomy

    def feedback_rows(self) -> list[dict]:
        """Every existing Feedback Log row, as dicts keyed by the header text.

        Item ID and Survey ID are recomputed from Year/Quarter/Region rather than
        read off the sheet: they're formula cells in the template, and openpyxl
        never evaluates formulas — loading with data_only=True to get a computed
        value would also silently drop every formula (Summary's COUNTIFS included)
        the moment this workbook gets saved back out. Recomputing avoids needing
        that trade-off at all.
        """
        ws = self.wb[FEEDBACK_LOG]
        rows = []
        for cells in ws.iter_rows(min_row=2):
            raw = [c.value for c in cells]
            if not any(raw):
                continue
            row = dict(zip(FEEDBACK_HEADER, raw))
            row["Item ID"] = f"ITEM-{cells[0].row - 1:03d}"
            if row.get("Year") is not None and row.get("Quarter") and row.get("Region"):
                row["Survey ID"] = survey_id(row["Year"], row["Quarter"], row["Region"])
            rows.append(row)
        return rows

    def has_survey(self, sid: str) -> bool:
        return any(r.get("Survey ID") == sid for r in self.feedback_rows())

    # ---------- writing ----------

    def append_items(self, items: list[dict], year: int, quarter: str, region: str,
                      source_file: str) -> str:
        """Append extracted items as new Feedback Log rows. Returns the Survey ID used."""
        ws = self.wb[FEEDBACK_LOG]
        table = ws.tables.get(FEEDBACK_TABLE)
        if table is not None:
            _, _, _, last_row = range_boundaries(table.ref)
        else:
            last_row = ws.max_row

        sid = survey_id(year, quarter, region)
        today = date.today().isoformat()
        row_num = last_row
        for item in items:
            row_num += 1
            values = [
                f"ITEM-{row_num - 1:03d}", year, quarter, region, sid,
                item.get("category", ""), item.get("subcategory", ""), item.get("text", ""),
                "Not Reviewed", None, None, today, source_file,
            ]
            for col, value in enumerate(values, start=1):
                ws.cell(row_num, col, value)

        if table is not None:
            table.ref = f"A1:M{row_num}"
        return sid

    def update_summary(self, sid: str) -> None:
        """Add one Summary column for `sid`, with the same per-category COUNTIFS
        pattern as every other column. Best-effort: the Summary tab is a convenience
        for humans reading the file in Excel, nothing in this pipeline reads it back,
        so a layout surprise here should never fail the run.

        Existing columns are B.."total_col - 1"; Total is always the last column. The
        new column takes Total's old position, and Total moves one column right.
        """
        try:
            ws = self.wb[SUMMARY]
            header_row = 5
            total_col = next(
                c for c in range(2, ws.max_column + 1)
                if str(ws.cell(header_row, c).value).strip().lower() == "total"
            )
            new_col = total_col
            new_total_col = total_col + 1
            new_letter = get_column_letter(new_col)

            last_data_row = next(
                (r for r in range(ws.max_row, header_row, -1) if ws.cell(r, 1).value),
                header_row,
            )

            # Shift Total's header and each row's SUM formula one column right first.
            for r in range(header_row, last_data_row + 1):
                ws.cell(r, new_total_col, ws.cell(r, total_col).value)

            ws.cell(header_row, new_col, sid)
            for r in range(header_row + 1, last_data_row + 1):
                ws.cell(r, new_col,
                        f"=COUNTIFS('{FEEDBACK_LOG}'!$F$2:$F${SUMMARY_ROW_CAP},$A{r},"
                        f"'{FEEDBACK_LOG}'!$E$2:$E${SUMMARY_ROW_CAP},{new_letter}${header_row})")
                ws.cell(r, new_total_col, f"=SUM(B{r}:{new_letter}{r})")
        except Exception as exc:  # noqa: BLE001 - logged, never fatal
            print(f"  ! Summary tab not updated ({exc}) — Feedback Log itself is unaffected.")

    def to_bytes(self) -> bytes:
        buf = io.BytesIO()
        self.wb.save(buf)
        return buf.getvalue()
