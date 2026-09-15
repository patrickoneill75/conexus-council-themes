"""Reading a raw post-meeting survey export, ready for Claude to pull feedback items
out of.

What counts as a "free response" question versus a rating question is left entirely
to Claude at the extraction step — not decided here by column name, since survey
templates change wording and question order between quarters. This module's only job
is to strip out pure metadata (timestamps, IP address, browser, respondent identity)
and the admin/quant-only columns (Year, Quarter, Region, Meeting Date, Organization
Name, the rating scales) that have no business reaching the API and would just be
noise in the prompt.
"""
from __future__ import annotations

import re

from . import sheet_io
from .quant_extract import KNOWN_METRICS

_DROP = re.compile(
    r"^time$|ip address|unique id|\blocation\b|\bbrowser\b|name \(first\)|name \(last\)|"
    r"^year$|^quarter$|^region$|^meeting date$|^organization name$",
    re.IGNORECASE,
)
_DROP_EXACT = {m.lower() for m in KNOWN_METRICS}


def response_rows(filename: str, survey_bytes: bytes) -> list[dict]:
    """Every response, as {question: answer}, blank answers and metadata/rating columns
    dropped. The first row is taken as the header regardless of source format."""
    header, data_rows = sheet_io.read_rows(filename, survey_bytes)
    keep = [i for i, h in enumerate(header)
            if h and not _DROP.search(h) and h.lower() not in _DROP_EXACT]

    rows = []
    for raw in data_rows:
        if not any(raw):
            continue
        row = {header[i]: raw[i] for i in keep if raw[i] not in (None, "")}
        if row:
            rows.append(row)
    return rows
