"""Reporting-period arithmetic. A quarter is only 'complete' once its filing window closes."""
from __future__ import annotations
from datetime import date, timedelta

from .config import MIN_YEAR, QUARTERLY_COMPLETENESS_DAYS, ANNUAL_COMPLETENESS_DAYS


def quarter_dates(year: int, q: int):
    start_month = 1 + (q - 1) * 3
    start = date(year, start_month, 1)
    end = date(year, 12, 31) if q == 4 else date(year, start_month + 3, 1) - timedelta(days=1)
    return start, end


def quarter_ready_date(year: int, quarter: int) -> date:
    """When enough filers have reported that the quarter can be considered complete."""
    _, quarter_end = quarter_dates(int(year), int(quarter))
    lag = ANNUAL_COMPLETENESS_DAYS if int(quarter) == 4 else QUARTERLY_COMPLETENESS_DAYS
    return quarter_end + timedelta(days=lag)


def complete_quarters(as_of: date | None = None, min_year: int = MIN_YEAR):
    as_of = as_of or date.today()
    out = []
    for year in range(min_year, as_of.year + 1):
        for quarter in range(1, 5):
            if quarter_ready_date(year, quarter) <= as_of:
                out.append((year, quarter))
    return out


def latest_complete_quarter(as_of: date | None = None):
    quarters = complete_quarters(as_of)
    return quarters[-1] if quarters else (MIN_YEAR - 1, 4)


def required_quarters(as_of: date | None = None):
    """The quarters needed to run the dashboard right now: the latest complete quarter,
    plus its quarter-over-quarter and year-over-year comparison quarters.

    Downloading and analyzing only these three keeps each run's cost bounded regardless
    of how far back the archive goes. The store (see mcm.store) never discards a quarter
    once fetched, so the comparison quarters are usually already on hand from an earlier
    run — a quarter this run fetches as "latest" becomes next quarter's QoQ comparison
    for free, and a quarter fetched as this year's YoY comparison becomes "latest" itself
    four quarters from now. After a year of runs, only the new latest quarter is ever
    missing.
    """
    latest = latest_complete_quarter(as_of)
    qoq = previous_quarter(*latest)
    yoy = (latest[0] - 1, latest[1])
    return sorted({latest, qoq, yoy})


def next_quarter(year: int, quarter: int):
    return (int(year) + 1, 1) if int(quarter) == 4 else (int(year), int(quarter) + 1)


def previous_quarter(year: int, quarter: int):
    return (int(year) - 1, 4) if int(quarter) == 1 else (int(year), int(quarter) - 1)


def label(year: int, quarter: int) -> str:
    return f"{int(year)}Q{int(quarter)}"


def parse_label(text: str):
    year, quarter = str(text).split("Q")
    return int(year), int(quarter)


def previous_calendar_quarter_end(value: date) -> date:
    quarter = (value.month - 1) // 3 + 1
    return date(value.year, 1 + (quarter - 1) * 3, 1) - timedelta(days=1)


def reporting_date_for_filing(form: str, period_ending, filed_date: date) -> date:
    """Periodic reports use EDGAR's period end; earnings 8-Ks fall to the prior quarter."""
    if form in {"10-Q", "10-K"} and period_ending:
        try:
            import pandas as pd
            period_date = pd.Timestamp(period_ending).date()
            if date(MIN_YEAR - 1, 1, 1) <= period_date <= filed_date:
                return period_date
        except Exception:
            pass
    return previous_calendar_quarter_end(filed_date)
