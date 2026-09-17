"""Storage for pcn/pipeline/match's output: {assertion_id: {from_issue_id,
from_method, to_issue_id, to_method}}. Unlike the ledger and issue store, this is a
full overwrite each run, not an append -- it's a derived artifact recomputed from the
current ledger and issue store each time pcn-pipeline match runs, the same
"recompute fresh, never hand-edit" principle the connection network (a later build
step) also follows.
"""
from __future__ import annotations

import json
from pathlib import Path


def load(path: Path) -> dict:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def save(path: Path, resolutions: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(resolutions, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
