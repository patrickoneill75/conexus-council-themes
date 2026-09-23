"""Change-over-time: buckets the ledger's meetings by quarter (using each
Assertion's meeting_date -- assertions with no usable meeting_date are left out of
every bucket, since there's no honest way to place them in time) and derives the network
as of each bucket's cumulative cutoff, via pcn/pipeline/derive.derive_network. Like
every other derived artifact here, this is a pure function over the ledger: rerunning
it after new meetings are processed, or after a threshold changes, just recomputes it.

The map only ever accumulates evidence (an assertion, once extracted, is never
retroactively erased -- rejecting one is the only way it stops counting), so "change
over time" mostly means: which connections are newly evidenced in a given quarter,
and how does an existing connection's mean weight/dispersion shift as more meetings
weigh in on it (e.g. a connection that looked uncontested becomes contested once a
later meeting reports the opposite sign). It does NOT mean edges disappearing the way
a shrinking network would -- that only happens via review rejecting an assertion.
"""
from __future__ import annotations

from datetime import date

from .derive import derive_network


def _quarter_label(meeting_date: str) -> str | None:
    try:
        d = date.fromisoformat(meeting_date)
    except (ValueError, TypeError):
        return None
    q = (d.month - 1) // 3 + 1
    return f"{d.year}-Q{q}"


def _is_contested(edge: dict) -> bool:
    return edge["assertion_count"] > 1 and edge["dispersion"] >= abs(edge["mean_weight"])


def derive_timeline(ledger_rows: list[dict], resolutions: dict, issues: list | None = None) -> dict:
    # An assertion counts as "dated" only if its meeting_date actually PARSES, not just
    # if the field is non-empty. A present-but-unparseable date (e.g. "2026-13-45", which
    # passes the upload route's YYYY-MM-DD regex but is not a real day) made
    # _quarter_label return None, and the cutoff comparison below then raised
    # "TypeError: '<=' not supported between instances of 'NoneType' and 'str'",
    # aborting the whole pipeline run. Bucketing each assertion's label once, here, is
    # also what stops _quarter_label being re-parsed once per period per row.
    dated: list[tuple[str, dict]] = []
    for a in ledger_rows:
        label = _quarter_label(a["meeting_date"]) if a.get("meeting_date") else None
        if label is not None:
            dated.append((label, a))
    undated_count = len(ledger_rows) - len(dated)

    labels = sorted({label for label, _ in dated})
    if not labels:
        return {"periods": [], "undated_assertion_count": undated_count}

    periods = []
    previous_edges: dict[tuple, dict] = {}
    for label in labels:
        cutoff_rows = [a for row_label, a in dated if row_label <= label]
        network = derive_network(cutoff_rows, resolutions, issues)
        current_edges = {(e["from_issue_id"], e["to_issue_id"]): e for e in network["edges"]}

        new_connections = [
            {"from_issue_id": f, "to_issue_id": t, "mean_weight": e["mean_weight"]}
            for (f, t), e in current_edges.items() if (f, t) not in previous_edges
        ]
        newly_contested = [
            {"from_issue_id": f, "to_issue_id": t, "dispersion": e["dispersion"]}
            for (f, t), e in current_edges.items()
            if (f, t) in previous_edges and _is_contested(e) and not _is_contested(previous_edges[(f, t)])
        ]

        periods.append({
            "period": label,
            "node_count": len(network["nodes"]),
            "edge_count": len(network["edges"]),
            "density": network["graph"]["density"],
            "hierarchy_index": network["graph"]["hierarchy_index"],
            "feedback_loop_count": len(network["graph"]["feedback_loops"]),
            "new_connections": new_connections,
            "newly_contested_connections": newly_contested,
        })
        previous_edges = current_edges

    return {"periods": periods, "undated_assertion_count": undated_count}
