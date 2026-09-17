"""Plain-text reader -- used for both transcript and notes input, kept verbatim.
Structure parsing (speaker turns or heading hierarchy) happens in
pcn/pipeline/normalize, not here.
"""
from __future__ import annotations

from pathlib import Path


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")
