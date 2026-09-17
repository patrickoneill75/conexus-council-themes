"""Header/bullet hierarchy parsing for notes: each bullet or paragraph becomes one
Segment carrying heading_path -- the list of ancestor headings above it, so a later
extraction prompt sees "Staffing > Overtime: ..." rather than a bare bullet stripped
of the context that made it interpretable.

heading_path is structural context for interpreting a segment, not evidence of a
causal link to whatever else shares that heading -- CODING_PROTOCOL.md rule 5 (skip
rather than invent) applies here specifically because adjacent bullets under the same
heading are exactly the shape that tempts a model into inventing a connection that
isn't actually in the text.
"""
from __future__ import annotations

import re

from ..models import Segment

_HEADING = re.compile(r"^(#{1,6})\s+(.+)$")
_BULLET = re.compile(r"^[-*•]\s+(.+)$")


def parse(raw_text: str) -> list[Segment]:
    segments: list[Segment] = []
    heading_stack: list[tuple[int, str]] = []  # (level, text), shallow-to-deep

    for line in raw_text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue

        heading_match = _HEADING.match(stripped)
        if heading_match:
            level = len(heading_match.group(1))
            text = heading_match.group(2).strip()
            heading_stack = [h for h in heading_stack if h[0] < level]
            heading_stack.append((level, text))
            continue

        bullet_match = _BULLET.match(stripped)
        text = bullet_match.group(1).strip() if bullet_match else stripped
        segments.append(Segment(
            index=len(segments), text=text,
            heading_path=[h[1] for h in heading_stack],
        ))
    return segments
