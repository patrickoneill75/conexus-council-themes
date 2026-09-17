"""Data model for the PCN Issue Map ingestion/normalization pipeline.

RawDocument is what pcn/pipeline/ingest produces: a source file decoded into plain
text, plus the metadata that has to be recorded rather than inferred (input type,
notetaker identity -- see pcn/CODING_PROTOCOL.md and the design doc's transcript-vs-
notes handling). NormalizedDocument/Segment is what pcn/pipeline/normalize produces
from it: one unit of attributable text per Segment, ready for pcn/pipeline/extract in
a later build step. No causal content is parsed here -- this stage only establishes
structure (who said it, or where it sits in a notes document's heading hierarchy).
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass
class RawDocument:
    meeting_id: str
    input_type: str  # "transcript" | "notes" -- stored, never inferred
    input_format: str  # "vtt" | "srt" | "txt" | "docx" | "md"
    source_filename: str
    raw_text: str
    notetaker: str | None = None  # notes only; always None for a transcript

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class Segment:
    index: int
    text: str
    speaker: str | None = None  # transcript segments only
    heading_path: list[str] = field(default_factory=list)  # notes segments only

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class NormalizedDocument:
    meeting_id: str
    input_type: str
    input_format: str
    source_filename: str
    notetaker: str | None
    segments: list[Segment]

    def to_dict(self) -> dict:
        return {
            "meeting_id": self.meeting_id,
            "input_type": self.input_type,
            "input_format": self.input_format,
            "source_filename": self.source_filename,
            "notetaker": self.notetaker,
            "segments": [s.to_dict() for s in self.segments],
        }
