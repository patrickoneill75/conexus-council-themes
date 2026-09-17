"""Resolves every raw issue label in the assertion ledger onto canonical Issue ids via
the four-stage cascade (cascade.py), mutating the issue store in place: a "new" result
appends a fresh Issue, and any other successful match records the original label as
an alias if it wasn't already known verbatim -- so the same label seen again this run
(or a future run) hits stage 1 instead of re-running the cascade.

Resolutions are returned as a separate mapping (assertion id -> {from_issue_id,
from_method, to_issue_id, to_method}), not written onto the Assertion itself: the
ledger stays exactly what pcn/pipeline/extract wrote, immutable, while resolutions
are a derived, recomputable artifact -- consistent with the design doc's "never
hand-edit the derived state" principle applied one step earlier than the connection
network itself.
"""
from __future__ import annotations

from ..issues import add_alias
from ..models import Issue, new_issue_id
from .cascade import normalize_label, resolve_issue

__all__ = ["resolve_ledger"]


def resolve_ledger(assertions: list[dict], issues: list[Issue]) -> dict[str, dict]:
    resolutions: dict[str, dict] = {}
    cache: dict[str, str] = {}  # normalized label -> issue_id, for repeats within this run

    def resolve_label(label: str) -> tuple[str, str]:
        key = normalize_label(label)
        if key in cache:
            # An exact repeat (mod case/whitespace) of a label already resolved this
            # run -- trivially the same issue, reported as "exact" rather than
            # whatever stage first resolved it, so that stage's own hit rate isn't
            # inflated by counting the same label over and over.
            return cache[key], "exact"
        result = resolve_issue(label, issues)
        if result.issue_id is None:
            issue = Issue(id=new_issue_id(), canonical_label=label.strip())
            issues.append(issue)
            resolved = (issue.id, "new")
        else:
            issue = next(i for i in issues if i.id == result.issue_id)
            if result.matched_label:
                add_alias(issue, result.matched_label)
            resolved = (issue.id, result.method)
        cache[key] = resolved[0]
        return resolved

    for row in assertions:
        from_id, from_method = resolve_label(row["from_issue_label"])
        to_id, to_method = resolve_label(row["to_issue_label"])
        resolutions[row["id"]] = {
            "from_issue_id": from_id, "from_method": from_method,
            "to_issue_id": to_id, "to_method": to_method,
        }
    return resolutions
