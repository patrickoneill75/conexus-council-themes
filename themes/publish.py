"""Reading and writing public/council-themes.json.

Keyed by Survey ID ("{year}-{quarter} {region}", the tracker's own convention — see
themes/tracker.py). Each analysis run only touches the one key for the quarter it just
processed, leaving every other quarter's already-published result untouched.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from . import config


def load() -> dict:
    if not config.COUNCIL_THEMES_JSON.exists():
        return {}
    return json.loads(config.COUNCIL_THEMES_JSON.read_text(encoding="utf-8"))


def save(data: dict) -> None:
    config.COUNCIL_THEMES_JSON.parent.mkdir(parents=True, exist_ok=True)
    config.COUNCIL_THEMES_JSON.write_text(
        json.dumps(data, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8"
    )


def merge(sid: str, current: list[dict], qoq: list[dict], yoy: list[dict], source_file: str) -> dict:
    data = load()
    data[sid] = {
        "current": current,
        "qoq": qoq,
        "yoy": yoy,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "sourceFile": source_file,
    }
    save(data)
    return data
