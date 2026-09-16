"""Turning already-parsed survey rows into what Claude sees, ready to pull feedback
items out of.

What counts as a "free response" question versus a rating question is left entirely
to Claude at the extraction step — not decided here by column name, since survey
templates change wording and question order between quarters. This module's only job
is to strip out pure metadata (timestamps, IP address, browser, respondent identity)
and the admin/quant-only columns (Year, Quarter, Region, Meeting Date, Organization
Name, the rating scales) that have no business reaching the API and would just be
noise in the prompt.

Operates on already-parsed (header, rows) rather than a whole file's bytes: the
orchestrator reads the survey export once (see sheet_io.read_rows), groups its rows
by Meeting Date to resolve one meeting at a time, and calls response_rows() per
meeting group — so this module never needs to know about files or dates at all.
"""
from __future__ import annotations

import re

from .quant_extract import KNOWN_METRICS

_DROP = re.compile(
    r"^time$|ip address|unique id|\blocation\b|\bbrowser\b|name \(first\)|name \(last\)|"
    r"^year$|^quarter$|^region$|^meeting date$|^organization name$",
    re.IGNORECASE,
)
_DROP_EXACT = {m.lower() for m in KNOWN_METRICS}


def response_rows(header: list[str], rows: list[list]) -> list[dict]:
    """Every response, as {question: answer}, blank answers and metadata/rating columns
    dropped."""
    keep = [i for i, h in enumerate(header)
            if h and not _DROP.search(h) and h.lower() not in _DROP_EXACT]

    out = []
    for raw in rows:
        if not any(raw):
            continue
        row = {header[i]: raw[i] for i in keep if raw[i] not in (None, "")}
        if row:
            out.append(row)
    return out
