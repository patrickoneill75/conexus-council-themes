"""Reading and writing data/taxonomy.json: the Category -> Subcategory vocabulary
Claude is given on every extraction run and told to reuse whenever a pair reasonably
fits (see themes/claude_client.py's system prompt) — what tracker.xlsx's Lists tab
used to hold, before it moved into the repo (see themes/config.py).

Seeded once from the tracker's Lists tab during the one-time migration, then extended
in place here whenever Claude legitimately introduces a new Subcategory under an
existing Category (rare, by design — the tracker's whole value is reusing the same
labels across quarters).
"""
from __future__ import annotations

import json

from . import config


def load() -> dict[str, list[str]]:
    if not config.TAXONOMY_JSON.exists():
        return {}
    return json.loads(config.TAXONOMY_JSON.read_text(encoding="utf-8"))


def save(taxonomy: dict[str, list[str]]) -> None:
    config.TAXONOMY_JSON.parent.mkdir(parents=True, exist_ok=True)
    config.TAXONOMY_JSON.write_text(
        json.dumps(taxonomy, indent=2, ensure_ascii=False, sort_keys=True) + "\n", encoding="utf-8"
    )


def merge_new(taxonomy: dict[str, list[str]], items: list[dict]) -> bool:
    """Extend `taxonomy` in place with any (category, subcategory) pair from `items`
    that isn't in it yet. Returns whether anything changed."""
    changed = False
    for item in items:
        category, subcategory = item.get("category"), item.get("subcategory")
        if not category or not subcategory:
            continue
        subs = taxonomy.setdefault(category, [])
        if subcategory not in subs:
            subs.append(subcategory)
            changed = True
    return changed
