"""Turns a RawDocument's plain text into a NormalizedDocument's ordered Segments --
speaker turns for a transcript, heading/bullet units (with inherited parent-context)
for notes. This stage only establishes structure, never causal content; see
pcn/CODING_PROTOCOL.md for what happens to a Segment's text downstream in
pcn/pipeline/extract.
"""
from __future__ import annotations

from ..models import NormalizedDocument, RawDocument
from . import notes as _notes
from . import transcript as _transcript


def normalize(raw: RawDocument) -> NormalizedDocument:
    if raw.input_type == "transcript":
        segments = _transcript.parse(raw.raw_text)
    elif raw.input_type == "notes":
        segments = _notes.parse(raw.raw_text)
    else:
        raise ValueError(f"Unknown input_type {raw.input_type!r}")
    return NormalizedDocument(
        meeting_id=raw.meeting_id,
        input_type=raw.input_type,
        input_format=raw.input_format,
        source_filename=raw.source_filename,
        notetaker=raw.notetaker,
        segments=segments,
    )
