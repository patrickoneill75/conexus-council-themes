"""SRT reader -- same cue-stripping approach as vtt.py (drop cue-number lines and
timestamp lines, keep cue text in order); see that module's docstring. SRT has no
voice-tag convention, so speaker attribution depends entirely on an inline
"Speaker: text" prefix, same as vtt.py after its tag-stripping.
"""
from __future__ import annotations

import re
from pathlib import Path

_TIMESTAMP_LINE = re.compile(r"^\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}")


def read(path: Path) -> str:
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    cues: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.isdigit():
            continue
        if _TIMESTAMP_LINE.match(stripped):
            continue
        cues.append(stripped)
    return "\n".join(cues)
