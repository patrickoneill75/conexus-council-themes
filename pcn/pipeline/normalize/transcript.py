"""Speaker-turn parsing for transcripts: groups consecutive "Speaker: text" lines
from the same speaker into one Segment, carrying that speaker identifier along.
See the design doc's speaker-level-coding rationale: a stable speaker identifier
attached at this stage is what makes distinct-speaker-count a later, honest signal of
real vs. anecdotal support, rather than a raw mention-count.
"""
from __future__ import annotations

import re

from ..models import Segment

_SPEAKER_LINE = re.compile(r"^([A-Za-z][\w .'\-]{0,60}?):\s*(.+)$")


def parse(raw_text: str) -> list[Segment]:
    segments: list[Segment] = []
    speaker: str | None = None
    buffer: list[str] = []

    def flush() -> None:
        if buffer:
            segments.append(Segment(index=len(segments), text=" ".join(buffer), speaker=speaker))

    for line in raw_text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        match = _SPEAKER_LINE.match(stripped)
        if match:
            new_speaker, text = match.group(1).strip(), match.group(2).strip()
            if buffer and new_speaker != speaker:
                flush()
                buffer = []
            speaker = new_speaker
            buffer.append(text)
        elif buffer:
            # A cue that wrapped onto a second line without repeating "Name:" --
            # attribute it to whoever is already speaking.
            buffer.append(stripped)
        else:
            # Text before any "Speaker:" line has been seen -- keep it, unattributed,
            # rather than dropping it (see CODING_PROTOCOL.md rule 5: don't invent, but
            # also don't discard real source text just because it lacks a label).
            speaker = None
            buffer = [stripped]
    flush()
    return segments
