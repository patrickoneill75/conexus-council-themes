"""Data model for the PCN Issue Map pipeline.

RawDocument is what pcn/pipeline/ingest produces: a source file decoded into plain
text, plus the metadata that has to be recorded rather than inferred (input type,
notetaker identity -- see pcn/CODING_PROTOCOL.md and the design doc's transcript-vs-
notes handling). NormalizedDocument/Segment is what pcn/pipeline/normalize produces
from it: one unit of attributable text per Segment, ready for pcn/pipeline/extract.
No causal content is parsed by either of those stages -- they only establish
structure (who said it, or where it sits in a notes document's heading hierarchy).

Assertion is what pcn/pipeline/extract produces from a NormalizedDocument: one coded
causal statement, still carrying its raw (unresolved) issue labels as free text --
folding those into canonical Issue ids is pcn/pipeline/match's job in a later build
step, deliberately kept separate (see the design doc's four-stage resolution cascade).
Assertions are appended to the assertion ledger (pcn/pipeline/ledger.py) and never
edited in place, only ever gaining a new `status` -- see that module's docstring.
"""
from __future__ import annotations

import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone


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


# Rule 3 of pcn/CODING_PROTOCOL.md.
MODALITIES = ("asserted", "hypothetical", "reported", "negated")


@dataclass
class Assertion:
    id: str
    meeting_id: str
    segment_index: int
    speaker: str | None
    from_issue_label: str
    to_issue_label: str
    weight: float  # signed, in [-1, 1] -- rule 4: a negation gets a near-zero weight, never skipped
    modality: str  # one of MODALITIES
    quote: str  # verbatim source text supporting the assertion
    model_used: str
    agreement: bool | None  # True/False once two-pass reconciled; None if escalated (single-pass tie-break)
    status: str = "unreviewed"  # unreviewed | confirmed | rejected -- see the design doc's review queue
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict:
        return asdict(self)


def new_assertion_id() -> str:
    return uuid.uuid4().hex


@dataclass
class Issue:
    """A canonical issue node -- what pcn/pipeline/match resolves an Assertion's raw
    from_issue_label/to_issue_label strings onto. `definition` starts empty and is
    filled in by a human on first review-queue confirmation (see pcn/pipeline/review.py)
    -- that's the design doc's "reviewing doubles as codebook-building," and is what
    the adjudication stage of the matching cascade shows a model for its 5 nearest
    candidates, rather than a bare label.
    """
    id: str
    canonical_label: str
    aliases: list[str] = field(default_factory=list)
    definition: str | None = None
    embedding: list[float] | None = None
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())

    def to_dict(self) -> dict:
        return asdict(self)


def new_issue_id() -> str:
    return uuid.uuid4().hex
