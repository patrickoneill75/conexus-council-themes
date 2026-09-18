"""The data store: a CSV/JSON mirror of Box (see mcm.box_store), plus the status file
that drives the control panel's indicators.

There is no database server. A quarter that has already been analyzed can never be
silently re-analyzed because its rows are already in signals.csv, which travels to and
from Box with everything else.
"""
from __future__ import annotations
import json
from datetime import datetime, timezone

import pandas as pd

from . import box_store, config
from .periods import (label, latest_complete_quarter, previous_quarter,
                      quarter_ready_date, required_quarters)

FILING_COLUMNS = [
    "accession", "cik", "ticker", "company", "sic", "sic2", "sic2_title", "state",
    "form", "filed_date", "report_date", "report_year", "report_quarter", "period",
    "url", "document_type", "downloaded", "extracted", "analyzed", "error",
]
PARAGRAPH_COLUMNS = [
    "paragraph_id", "accession", "period", "section", "paragraph_index",
    "paragraph_text", "matched_keywords", "forward_looking", "char_count",
]
SIGNAL_COLUMNS = [
    "signal_id", "accession", "cik", "company", "ticker", "sic2", "state", "period",
    "report_date", "form", "category", "topic", "direction", "intensity", "scope",
    "timeframe", "summary", "evidence_quote", "confidence", "url", "source_paragraph_id",
]


def _read(path, columns):
    if not path.exists() or path.stat().st_size == 0:
        return pd.DataFrame(columns=columns)
    df = pd.read_csv(path, dtype=str, keep_default_na=False)
    for col in columns:
        if col not in df.columns:
            df[col] = ""
    return df[columns]


def read_filings():
    return _read(config.FILINGS_CSV, FILING_COLUMNS)


def read_paragraphs():
    return _read(config.PARAGRAPHS_CSV, PARAGRAPH_COLUMNS)


def read_signals():
    return _read(config.SIGNALS_CSV, SIGNAL_COLUMNS)


def read_companies():
    return _read(config.COMPANIES_CSV, ["cik", "company", "state", "state_title", "city", "fetched_at"])


def write_filings(df):
    _write_sorted(df, FILING_COLUMNS, config.FILINGS_CSV, ["period", "company", "accession"])


def write_paragraphs(df):
    _write_sorted(df, PARAGRAPH_COLUMNS, config.PARAGRAPHS_CSV, ["accession", "paragraph_index"])


def write_signals(df):
    _write_sorted(df, SIGNAL_COLUMNS, config.SIGNALS_CSV, ["period", "company", "signal_id"])


def write_companies(df):
    _write_sorted(df, ["cik", "company", "state", "state_title", "city", "fetched_at"],
                  config.COMPANIES_CSV, ["cik"])


def _write_sorted(df, columns, path, sort_by):
    """Stable column order and row order, so git diffs stay small and reviewable."""
    out = df.copy()
    for col in columns:
        if col not in out.columns:
            out[col] = ""
    out = out[columns]
    present = [c for c in sort_by if c in out.columns]
    if present:
        out = out.sort_values(present, kind="stable")
    path.parent.mkdir(parents=True, exist_ok=True)
    out.to_csv(path, index=False)


def read_narratives():
    if config.NARRATIVES_JSON.exists() and config.NARRATIVES_JSON.stat().st_size:
        return json.loads(config.NARRATIVES_JSON.read_text(encoding="utf-8"))
    return {}


def write_narratives(data):
    config.NARRATIVES_JSON.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def narrative_key(period: str, cut_key: str) -> str:
    return f"{period}|{cut_key}"


# ------------------------------------------------------------------ status
def compute_status():
    """The single source of truth for the control panel's indicators.

    Scoped to mcm.periods.required_quarters() — the latest complete quarter plus its QoQ
    and YoY comparisons — rather than every quarter ever downloaded, since those three
    are the only ones the pipeline still has work to do on. Older quarters stay in the
    store to feed future comparisons, but the panel has nothing to report about them.
    """
    filings = read_filings()
    signals = read_signals()
    narratives = read_narratives()

    latest_year, latest_q = latest_complete_quarter()
    latest_label = label(latest_year, latest_q)
    qoq_period = label(*previous_quarter(latest_year, latest_q))
    role_of = {latest_label: "current", qoq_period: "quarter_over_quarter"}

    quarters = []
    for (year, quarter) in required_quarters():
        key = label(year, quarter)
        role = role_of.get(key, "year_over_year")
        q_filings = filings[filings["period"] == key] if not filings.empty else filings
        downloaded = int((q_filings["downloaded"] == "1").sum()) if not q_filings.empty else 0
        extracted = int((q_filings["extracted"] == "1").sum()) if not q_filings.empty else 0
        analyzed = int((q_filings["analyzed"] == "1").sum()) if not q_filings.empty else 0
        n_signals = int((signals["period"] == key).sum()) if not signals.empty else 0
        # The narrative is only ever written for the latest ("current") quarter; the two
        # comparison quarters feed its QoQ/YoY sections as data, never get one of their own.
        cuts_done = ([c["key"] for c in config.NARRATIVE_CUTS
                      if narrative_key(key, c["key"]) in narratives] if role == "current" else [])
        quarters.append({
            "period": key,
            "year": year,
            "quarter": quarter,
            "role": role,
            "filings": int(len(q_filings)),
            "downloaded": downloaded,
            "extracted": extracted,
            "analyzed": analyzed,
            "signals": n_signals,
            "narratives": cuts_done,
            "narratives_complete": role != "current" or len(cuts_done) == len(config.NARRATIVE_CUTS),
            # A quarter counts as pending analysis if we have extracted text for it
            # that has not been through Claude, or (for the current quarter only) its
            # narratives are missing.
            "needs_analysis": bool(
                (extracted > analyzed)
                or (role == "current" and extracted > 0 and len(cuts_done) < len(config.NARRATIVE_CUTS))
            ),
            "has_data": downloaded > 0,
        })

    pending = [q["period"] for q in quarters if q["needs_analysis"]]
    no_data = [q["period"] for q in quarters if not q["has_data"]]

    return {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "latest_complete_quarter": latest_label,
        "next_quarter_available": _next_available(),
        "box_configured": box_store.enabled(),
        "download_up_to_date": not no_data,
        "analysis_up_to_date": not pending,
        "quarters_missing_data": no_data,
        "quarters_pending_analysis": pending,
        "totals": {
            "filings": int(len(filings)),
            "paragraphs": int(len(read_paragraphs())),
            "signals": int(len(signals)),
            "companies": int(filings["cik"].nunique()) if not filings.empty else 0,
            "narratives": len(narratives),
        },
        "quarters": quarters,
    }


def _next_available():
    from .periods import next_quarter
    year, quarter = latest_complete_quarter()
    ny, nq = next_quarter(year, quarter)
    return {"period": label(ny, nq), "available_on": quarter_ready_date(ny, nq).isoformat()}


def write_status():
    status = compute_status()
    config.STATUS_JSON.write_text(json.dumps(status, indent=2), encoding="utf-8")
    return status
