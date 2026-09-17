"""Markdown reader -- kept verbatim; pcn/pipeline/normalize/notes.py parses the
heading hierarchy from the "#" syntax directly, so no parsing happens here.
"""
from __future__ import annotations

from pathlib import Path


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")
