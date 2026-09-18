"""WebVTT reader -- strips the WEBVTT header, cue-identifier lines, and timestamp
lines, keeping only each cue's text (including any inline "Speaker: " prefix or
Zoom/Teams "<v Speaker>" voice tag, which is stripped to plain "Speaker: text"), one
cue per line, in order. pcn/pipeline/normalize/transcript.py is what turns this into
speaker turns.
"""
from __future__ import annotations

import html
import re
from pathlib import Path

_TIMESTAMP_LINE = re.compile(r"^\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}")
_OPEN_VOICE_TAG = re.compile(r"<v\s+([^>]+)>")
_CLOSE_VOICE_TAG = re.compile(r"</v>")


def read(path: Path) -> str:
    lines = path.read_text(encoding="utf-8-sig").splitlines()
    cues: list[str] = []
    n = len(lines)
    i = 0
    while i < n:
        stripped = lines[i].strip()
        if not stripped or stripped == "WEBVTT":
            i += 1
            continue
        if _TIMESTAMP_LINE.match(stripped):
            i += 1
            continue
        # The cue identifier line is optional per the WebVTT spec and, when present,
        # is NOT always a plain integer -- real-world exports (this Teams/Zoom one
        # included) use opaque ids like "50622ea5-...-9d05.../9-0". Checking .isdigit()
        # alone let ids like that fall through as if they were cue text, corrupting
        # every single speaker turn with a stray id string. An id line is reliably
        # identifiable instead by what always follows it: a timestamp line, with no
        # blank line in between (a real cue's text is never immediately followed by
        # a timestamp line -- there's always a blank line before the next cue's id).
        if i + 1 < n and _TIMESTAMP_LINE.match(lines[i + 1].strip()):
            i += 1
            continue
        stripped = _CLOSE_VOICE_TAG.sub("", stripped)
        stripped = _OPEN_VOICE_TAG.sub(lambda m: f"{m.group(1)}: ", stripped)
        cues.append(html.unescape(stripped))
        i += 1
    return "\n".join(cues)
