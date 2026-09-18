"""Build the static site payload from the current store.

The dashboard shows exactly one quarter — the latest complete one — plus its
quarter-over-quarter and year-over-year comparisons. Older quarters stay in the store
(see mcm.store / mcm.box_store) to feed next quarter's comparisons, but nothing about
them is published: that's what keeps this step, and the narrative step that feeds it,
from re-generating output for every quarter that has ever existed.

Every number the dashboard shows is computed in the browser from a compact,
dictionary-encoded facet table scoped to these three quarters, so SIC/state filtering
responds instantly with no server. The narrative and the evidence quotes are pre-built
files fetched on demand.
"""
from __future__ import annotations
import json
import shutil
from datetime import datetime, timezone

import pandas as pd

from . import config, store
from .analytics import top_evidence
from .periods import label, latest_complete_quarter, previous_quarter

# Index into the "r" (role) column of the facet arrays below.
ROLES = ["current", "qoq", "yoy"]


def _role_periods():
    latest_year, latest_q = latest_complete_quarter()
    qoq_year, qoq_q = previous_quarter(latest_year, latest_q)
    return {
        "current": label(latest_year, latest_q),
        "qoq": label(qoq_year, qoq_q),
        "yoy": label(latest_year - 1, latest_q),
    }


def build(output_dir, template_html: str, log=print):
    output_dir.mkdir(parents=True, exist_ok=True)
    evidence_dir = output_dir / "evidence"
    if evidence_dir.exists():
        shutil.rmtree(evidence_dir)
    evidence_dir.mkdir(parents=True, exist_ok=True)

    filings = store.read_filings()
    signals = store.read_signals()
    narratives = store.read_narratives()
    status = store.compute_status()

    role_periods = _role_periods()
    # Reverse map period label -> role. QoQ and YoY happen to coincide only in
    # degenerate cases (e.g. no history at all), and current always wins if they do,
    # since it is inserted last.
    period_role = {role_periods["qoq"]: "qoq", role_periods["yoy"]: "yoy",
                  role_periods["current"]: "current"}
    role_index = {r: i for i, r in enumerate(ROLES)}

    category_index = {c: i for i, c in enumerate(config.CATEGORIES)}
    direction_index = {d: i for i, d in enumerate(config.DIRECTIONS)}
    sic2_codes = list(config.SIC2_TITLES.keys())
    sic2_index = {c: i for i, c in enumerate(sic2_codes)}
    state_codes = sorted(config.STATE_TITLES.keys())
    state_index = {c: i for i, c in enumerate(state_codes)}

    cik_codes, cik_lookup = [], {}

    def cik_code(value):
        key = str(value)
        if key not in cik_lookup:
            cik_lookup[key] = len(cik_codes)
            cik_codes.append(key)
        return cik_lookup[key]

    sig = {"r": [], "c": [], "d": [], "g": [], "t": [], "k": []}
    for row in signals.itertuples():
        role = period_role.get(row.period)
        if role is None or row.category not in category_index or row.direction not in direction_index:
            continue
        sig["r"].append(role_index[role])
        sig["c"].append(category_index[row.category])
        sig["d"].append(direction_index[row.direction])
        sig["g"].append(sic2_index.get(str(row.sic2), -1))
        sig["t"].append(state_index.get(str(row.state), -1))
        sig["k"].append(cik_code(row.cik))

    fil = {"r": [], "g": [], "t": [], "k": []}
    for row in filings.itertuples():
        role = period_role.get(row.period)
        if role is None:
            continue
        fil["r"].append(role_index[role])
        fil["g"].append(sic2_index.get(str(row.sic2), -1))
        fil["t"].append(state_index.get(str(row.state), -1))
        fil["k"].append(cik_code(row.cik))

    # Evidence for the current quarter only, one file per topic that has any signals —
    # replaced every quarter rather than accumulating one set per historic period.
    manifest = []
    current = signals[signals["period"] == role_periods["current"]] if not signals.empty else signals
    if not current.empty:
        for category, group in current.groupby("category"):
            if category not in category_index:
                continue
            rows = top_evidence(group, limit=250)
            name = f"{category_index[category]}.json"
            payload = [{
                "company": r["company"], "ticker": r["ticker"], "form": r["form"],
                "report_date": r["period_ending"], "direction": r["direction"],
                "intensity": r["intensity"], "scope": r["scope"], "summary": r["summary"],
                "quote": r["quote"], "sic2": r["sic2"], "state": r["state"], "url": "",
            } for r in rows]
            (evidence_dir / name).write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
            manifest.append(category_index[category])

    # Only the current quarter's narrative is ever generated (see scripts/run_mcm_analyze.py),
    # so only it is published, even if narratives.json still holds older entries from
    # before this quarter's run.
    published_narratives = {k: v for k, v in narratives.items() if v.get("period") == role_periods["current"]}

    data = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "latest_period": role_periods["current"],
        "comparison_periods": {"qoq": role_periods["qoq"], "yoy": role_periods["yoy"]},
        "dims": {
            "categories": config.CATEGORIES,
            "directions": config.DIRECTIONS,
            "sic2": [[c, config.SIC2_TITLES[c]] for c in sic2_codes],
            "states": [[c, config.STATE_TITLES[c]] for c in state_codes],
        },
        "signals": sig,
        "filings": fil,
        "evidence": manifest,
        "counts": {
            "signals": len(sig["r"]), "filings": len(fil["r"]),
            "companies": len(cik_codes), "narratives": len(published_narratives),
        },
    }

    (output_dir / "data.json").write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (output_dir / "narratives.json").write_text(
        json.dumps(published_narratives, ensure_ascii=False), encoding="utf-8")
    (output_dir / "status.json").write_text(json.dumps(status, indent=2), encoding="utf-8")
    # dashboard.html, not index.html -- public/mcm/index.html is the hand-maintained
    # control panel (see public/mcm/index.html); this generated payload is the public,
    # unauthenticated dashboard page, matching this repo's convention of a hand-
    # maintained admin page that a publish step never overwrites.
    (output_dir / "dashboard.html").write_text(template_html, encoding="utf-8")

    total = sum(f.stat().st_size for f in output_dir.rglob("*") if f.is_file())
    log(f"Site built: {role_periods['current']} (QoQ {role_periods['qoq']}, YoY "
        f"{role_periods['yoy']}) — {len(sig['r'])} signals, {len(manifest)} evidence files, "
        f"{len(published_narratives)} narratives, {round(total / 1_048_576, 2)} MB")
    return data
