"""File-format readers: each turns one source file into a RawDocument (plain text
plus the metadata that must be recorded rather than inferred -- see
pcn.pipeline.models.RawDocument). No model calls and no causal-content parsing happen
here; that split belongs to pcn/pipeline/normalize (structure) and the later
pcn/pipeline/extract (causal content) -- see the design doc's build order.
"""
from __future__ import annotations

from pathlib import Path

from ..models import RawDocument
from . import docx as _docx
from . import md as _md
from . import srt as _srt
from . import txt as _txt
from . import vtt as _vtt

_READERS = {
    "vtt": _vtt.read,
    "srt": _srt.read,
    "txt": _txt.read,
    "md": _md.read,
    "docx": _docx.read,
}


def ingest(path: Path, input_type: str, meeting_id: str, notetaker: str | None = None,
           meeting_date: str | None = None, year: int | None = None,
           quarter: str | None = None, cohort: str | None = None) -> RawDocument:
    if input_type not in ("transcript", "notes"):
        raise ValueError(f"input_type must be 'transcript' or 'notes', got {input_type!r}")
    ext = path.suffix.lower().lstrip(".")
    reader = _READERS.get(ext)
    if reader is None:
        raise ValueError(f"No ingest reader for file extension {ext!r} ({path}).")
    raw_text = reader(path)
    return RawDocument(
        meeting_id=meeting_id,
        input_type=input_type,
        input_format=ext,
        source_filename=path.name,
        raw_text=raw_text,
        meeting_date=meeting_date,
        notetaker=notetaker if input_type == "notes" else None,
        year=year, quarter=quarter, cohort=cohort,
    )
