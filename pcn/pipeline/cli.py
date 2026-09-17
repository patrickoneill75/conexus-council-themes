"""Command-line entry point for the PCN Issue Map pipeline -- one subcommand per
build stage (design doc section 15), so a stage's output can be inspected in
isolation without wiring the whole pipeline together end to end. `ingest`,
`normalize`, and `extract` are built so far; later steps add `match`, `derive`. Used
directly by .github/workflows/pcn_fixture_test.yml.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from . import ledger
from .extract import extract_document
from .ingest import ingest as run_ingest
from .models import NormalizedDocument, RawDocument, Segment
from .normalize import normalize as run_normalize


def _cmd_ingest(args: argparse.Namespace) -> None:
    doc = run_ingest(Path(args.input), args.input_type, args.meeting_id, args.notetaker)
    Path(args.output).write_text(json.dumps(doc.to_dict(), indent=2), encoding="utf-8")
    print(f"Ingested {args.input} -> {args.output} ({doc.input_type}/{doc.input_format})")


def _cmd_normalize(args: argparse.Namespace) -> None:
    raw = RawDocument(**json.loads(Path(args.input).read_text(encoding="utf-8")))
    normalized = run_normalize(raw)
    Path(args.output).write_text(json.dumps(normalized.to_dict(), indent=2), encoding="utf-8")
    print(f"Normalized {args.input} -> {args.output} ({len(normalized.segments)} segments)")


def _cmd_extract(args: argparse.Namespace) -> None:
    payload = json.loads(Path(args.input).read_text(encoding="utf-8"))
    doc = NormalizedDocument(**{**payload, "segments": [Segment(**s) for s in payload["segments"]]})
    assertions = extract_document(doc)
    rows = ledger.append(Path(args.ledger), [a.to_dict() for a in assertions])
    agreed = sum(1 for a in assertions if a.agreement is True)
    disagreed = sum(1 for a in assertions if a.agreement is False)
    escalated = sum(1 for a in assertions if a.agreement is None)
    print(
        f"Extracted {len(assertions)} assertions from {args.input} -> {args.ledger} "
        f"({agreed} agreed, {disagreed} disagreed-but-kept, {escalated} escalated to Sonnet; "
        f"ledger now has {len(rows)} assertions total)"
    )


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="pcn-pipeline")
    subparsers = parser.add_subparsers(dest="command", required=True)

    ingest_parser = subparsers.add_parser("ingest", help="Read a source file into a RawDocument.")
    ingest_parser.add_argument("input")
    ingest_parser.add_argument("output")
    ingest_parser.add_argument("--input-type", dest="input_type", required=True, choices=["transcript", "notes"])
    ingest_parser.add_argument("--meeting-id", dest="meeting_id", required=True)
    ingest_parser.add_argument("--notetaker", dest="notetaker", default=None)
    ingest_parser.set_defaults(func=_cmd_ingest)

    normalize_parser = subparsers.add_parser("normalize", help="Turn a RawDocument into a NormalizedDocument.")
    normalize_parser.add_argument("input")
    normalize_parser.add_argument("output")
    normalize_parser.set_defaults(func=_cmd_normalize)

    extract_parser = subparsers.add_parser(
        "extract", help="Extract Assertions from a NormalizedDocument and append them to the ledger."
    )
    extract_parser.add_argument("input")
    extract_parser.add_argument("ledger")
    extract_parser.set_defaults(func=_cmd_extract)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
