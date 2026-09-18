"""Pure-pandas aggregation. No LLM calls, no network — just counting."""
from __future__ import annotations

import pandas as pd

from . import config


def _numeric(series, default=0.0):
    return pd.to_numeric(series, errors="coerce").fillna(default)


def aggregate(signals: pd.DataFrame) -> dict:
    if signals.empty:
        return {"total": 0, "head": 0, "tail": 0, "mixed": 0, "balance": 0.0,
                "companies": 0, "by_topic": []}
    head = int((signals["direction"] == "Headwind").sum())
    tail = int((signals["direction"] == "Tailwind").sum())
    mixed = int((signals["direction"] == "Mixed").sum())
    total = int(len(signals))
    by_topic = []
    for category, group in signals.groupby("category"):
        g_total = int(len(group))
        g_head = int((group["direction"] == "Headwind").sum())
        g_tail = int((group["direction"] == "Tailwind").sum())
        by_topic.append({
            "topic": str(category),
            "signals": g_total,
            "companies": int(group["cik"].nunique()),
            "headwind": g_head,
            "tailwind": g_tail,
            "mixed": int((group["direction"] == "Mixed").sum()),
            "balance": round((g_tail - g_head) / g_total, 3) if g_total else 0.0,
        })
    by_topic.sort(key=lambda r: r["balance"])
    return {
        "total": total, "head": head, "tail": tail, "mixed": mixed,
        "balance": (tail - head) / total if total else 0.0,
        "companies": int(signals["cik"].nunique()),
        "by_topic": by_topic,
    }


def movement_table(prior: pd.DataFrame, current: pd.DataFrame) -> list[dict]:
    """Per-topic balance change between two periods, with the sample sizes behind it.

    Sample sizes travel with the number deliberately: a 60-point swing built on three
    signals is noise, and the model needs to be able to see that.
    """
    prior_map = {r["topic"]: r for r in aggregate(prior)["by_topic"]}
    rows = []
    for row in aggregate(current)["by_topic"]:
        before = prior_map.get(row["topic"])
        if not before:
            continue
        rows.append({
            "topic": row["topic"],
            "balance_now": row["balance"],
            "balance_before": before["balance"],
            "change_points": round((row["balance"] - before["balance"]) * 100, 1),
            "signals_now": row["signals"],
            "signals_before": before["signals"],
            "small_sample": bool(row["signals"] < 5 or before["signals"] < 5),
        })
    rows.sort(key=lambda r: r["change_points"])
    return rows


def top_evidence(signals: pd.DataFrame, limit: int = 25) -> list[dict]:
    """The strongest, most diverse evidence: ranked, then capped to one row per company."""
    if signals.empty:
        return []
    ranked = signals.copy()
    ranked["_rank"] = (
        _numeric(ranked["intensity"]) * _numeric(ranked["confidence"])
        * ranked["scope"].map(config.SCOPE_WEIGHT).fillna(0.5)
    )
    picks = []
    per_direction = max(4, limit // 3)
    for direction in ["Headwind", "Tailwind", "Mixed"]:
        subset = ranked[ranked["direction"] == direction].sort_values("_rank", ascending=False)
        if not subset.empty:
            picks.append(subset.drop_duplicates("cik", keep="first").head(per_direction))
    if not picks:
        return []
    chosen = pd.concat(picks).sort_values("_rank", ascending=False).head(limit)
    return [{
        "company": r.company, "ticker": r.ticker, "state": r.state, "sic2": r.sic2,
        "form": r.form, "period_ending": r.report_date, "topic": r.category,
        "direction": r.direction, "intensity": int(float(r.intensity or 0)),
        "scope": r.scope, "timeframe": r.timeframe,
        "summary": r.summary, "quote": r.evidence_quote,
    } for r in chosen.itertuples()]
