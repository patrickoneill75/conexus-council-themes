"""Two-pass extraction: run extraction twice per source relying on the model's default
(nonzero) sampling for independent variation between the two calls -- see client.py's
extract() -- then reconcile the two passes per segment. Agreement between passes is a
free, automatic reliability signal without a second human coder -- an assertion both
passes independently produced for the same segment is kept once, marked
agreement=True; one only one pass produced is kept too (never silently dropped -- rule
5 is about not inventing new content, not about discarding what a pass actually
found), marked agreement=False, and is the review queue's top priority in a later
build step.

Escalation to Sonnet is per segment, not per document: a segment where the two Haiku
passes disagreed, or where a Haiku pass failed extraction outright after its own
retries, gets one additional Sonnet call as a tie-breaker, and that Sonnet result
replaces (not supplements) the Haiku assertions for that segment. This keeps the
common case cheap (Haiku only, cents per meeting) while spending a stronger model
exactly where the code-driven signal says it's warranted.
"""
from __future__ import annotations

import logging

from ... import config
from ..models import Assertion, NormalizedDocument, new_assertion_id
from . import client
from .prompts import build_system_prompt, build_user_message

log = logging.getLogger(__name__)


def _agreement_key(raw: dict) -> tuple:
    return (
        raw.get("segment_index"),
        str(raw.get("from_issue", "")).strip().lower(),
        str(raw.get("to_issue", "")).strip().lower(),
        str(raw.get("modality", "")).strip().lower(),
    )


def _run_pass(system: str, user: str, model: str) -> list[dict] | None:
    try:
        return client.extract(system, user, model)
    except Exception as exc:  # noqa: BLE001 -- any failure here means "this pass produced nothing usable"
        log.warning("Extraction pass failed after retries (model=%s): %s", model, exc)
        return None


def _to_assertions(meeting_id: str, doc: NormalizedDocument, raw_list: list[dict],
                    model_used: str, agreement: bool | None) -> list[Assertion]:
    segments_by_index = {s.index: s for s in doc.segments}
    out = []
    for raw in raw_list:
        segment = segments_by_index.get(raw.get("segment_index"))
        out.append(Assertion(
            id=new_assertion_id(),
            meeting_id=meeting_id,
            input_type=doc.input_type,
            segment_index=raw.get("segment_index"),
            speaker=segment.speaker if segment else None,
            notetaker=doc.notetaker,
            meeting_date=doc.meeting_date,
            year=doc.year, quarter=doc.quarter, cohort=doc.cohort,
            from_issue_label=str(raw.get("from_issue", "")).strip(),
            to_issue_label=str(raw.get("to_issue", "")).strip(),
            weight=float(raw.get("weight", 0.0)),
            modality=str(raw.get("modality", "asserted")),
            quote=str(raw.get("quote", "")).strip(),
            model_used=model_used,
            agreement=agreement,
        ))
    return out


def extract_document(doc: NormalizedDocument) -> list[Assertion]:
    """Run the full two-pass-plus-escalation extraction for one NormalizedDocument."""
    system = build_system_prompt(doc.input_type)
    user = build_user_message(doc)

    pass_1 = _run_pass(system, user, config.HAIKU_MODEL)
    pass_2 = _run_pass(system, user, config.HAIKU_MODEL)

    # A pass that failed outright escalates every segment it covers -- there's no
    # partial result to reconcile, so treat it the same as a disagreement everywhere.
    if pass_1 is None or pass_2 is None:
        escalate_segments = {s.index for s in doc.segments}
        agreed_raw: list[dict] = []
        disagreed_raw: list[dict] = pass_1 or pass_2 or []
    else:
        by_key_1 = {_agreement_key(r): r for r in pass_1}
        by_key_2 = {_agreement_key(r): r for r in pass_2}
        agreed_keys = set(by_key_1) & set(by_key_2)
        agreed_raw = [by_key_1[k] for k in agreed_keys]
        disagreed_raw = [r for k, r in by_key_1.items() if k not in agreed_keys] + \
                        [r for k, r in by_key_2.items() if k not in agreed_keys]
        escalate_segments = {r.get("segment_index") for r in disagreed_raw}

    assertions = _to_assertions(doc.meeting_id, doc, agreed_raw, config.HAIKU_MODEL, True)

    if escalate_segments:
        escalated_doc = NormalizedDocument(
            meeting_id=doc.meeting_id, input_type=doc.input_type, input_format=doc.input_format,
            source_filename=doc.source_filename, notetaker=doc.notetaker,
            segments=[s for s in doc.segments if s.index in escalate_segments],
        )
        escalated_user = build_user_message(escalated_doc)
        sonnet_raw = _run_pass(system, escalated_user, config.SONNET_MODEL) or []
        assertions.extend(_to_assertions(doc.meeting_id, doc, sonnet_raw, config.SONNET_MODEL, None))

    return assertions
