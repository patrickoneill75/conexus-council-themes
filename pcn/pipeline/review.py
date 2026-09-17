"""The review queue: which unreviewed assertions to show a human next, and how
confirming or rejecting one updates the ledger. Ranked cross-run disagreement (the
two extraction passes didn't agree) -> low confidence (escalated to Sonnet as a
tie-break, so there was never a second opinion to agree with in the first place) ->
new-issue-creating (a wrong new-issue split is the design doc's single most expensive
mistake to leave unreviewed) -> everything else, oldest first within each bucket.

Confirming/rejecting is the one legitimate mutation of an existing ledger row (its
`status` field only -- see pcn/pipeline/ledger.py's docstring); nothing else about a
row ever changes.
"""
from __future__ import annotations

_DISAGREEMENT, _LOW_CONFIDENCE, _NEW_ISSUE, _ROUTINE = range(4)


def _bucket(assertion: dict, resolution: dict | None) -> int:
    if assertion.get("agreement") is False:
        return _DISAGREEMENT
    if assertion.get("agreement") is None:
        return _LOW_CONFIDENCE
    if resolution and (resolution.get("from_method") == "new" or resolution.get("to_method") == "new"):
        return _NEW_ISSUE
    return _ROUTINE


def build_queue(assertions: list[dict], resolutions: dict[str, dict]) -> list[dict]:
    pending = [a for a in assertions if a.get("status", "unreviewed") == "unreviewed"]
    pending.sort(key=lambda a: (_bucket(a, resolutions.get(a["id"])), a.get("created_at", "")))
    return pending


def confirm(rows: list[dict], assertion_id: str) -> dict:
    for row in rows:
        if row["id"] == assertion_id:
            row["status"] = "confirmed"
            return row
    raise ValueError(f"No assertion with id {assertion_id!r} in this ledger.")


def reject(rows: list[dict], assertion_id: str) -> dict:
    for row in rows:
        if row["id"] == assertion_id:
            row["status"] = "rejected"
            return row
    raise ValueError(f"No assertion with id {assertion_id!r} in this ledger.")
