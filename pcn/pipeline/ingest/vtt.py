"""WebVTT reader -- strips the WEBVTT header, cue-number lines, and timestamp lines,
keeping only each cue's text (including any inline "Speaker: " prefix or Zoom/Teams
"<v Speaker>" voice tag, which is stripped to plain "Speaker: text"), one cue per line,
in order. pcn/pipeline/normalize/transcript.py is what turns this into speaker turns.
"""
from __future__ import annotations

import re
from pathlib import Path

_TIMESTAMP_LINE = re.compile(r"^\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}")
_OPEN_VOICE_TAG = re.compile(r"<v\s+([^>]+)>")
_CLOSE_VOICE_TAG = re.compile(r"</v>")


def read(path: Path) -> str:
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    cues: list[str] = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped == "WEBVTT" or stripped.isdigit():
            continue
        if _TIMESTAMP_LINE.match(stripped):
            continue
        stripped = _CLOSE_VOICE_TAG.sub("", stripped)
        stripped = _OPEN_VOICE_TAG.sub(lambda m: f"{m.group(1)}: ", stripped)
        cues.append(stripped)
    return "\n".join(cues)
