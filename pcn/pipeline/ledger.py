"""The assertion ledger: every coded causal statement, stored permanently. This is
the design doc's source of truth -- the derived connection network (a later build
step) is always recomputed fresh from this ledger, never hand-edited or incrementally
updated in place, so the aggregation rule can change later without reprocessing
history.

An existing row is only ever appended to this store, or has its `status` field
changed (unreviewed -> confirmed/rejected by a human reviewer in a later build step)
-- never deleted, so prompt-quality regressions or improvements over time stay
measurable. `path` is passed in rather than hardcoded (unlike themes/feedback_log.py's
single committed-to-the-repo file) because the real ledger lives in this app's own
Box data folder, not in this repo -- see pcn/relay.py and pcn/CODING_PROTOCOL.md.
"""
from __future__ import annotations

import json
from pathlib import Path


def load(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def save(path: Path, rows: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rows, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def append(path: Path, new_rows: list[dict]) -> list[dict]:
    rows = load(path)
    rows.extend(new_rows)
    save(path, rows)
    return rows
