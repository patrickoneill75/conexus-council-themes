"""Command-line entry point for the PCN Issue Map pipeline -- one subcommand per
build stage (design doc section 15), so a stage's output can be inspected in
isolation without wiring the whole pipeline together end to end. `ingest`,
`normalize`, `extract`, `match`, `review`, and `derive` are built so far. Used
directly by .github/workflows/pcn_fixture_test.yml.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from . import issues as issues_store
from . import ledger, resolutions as resolutions_store, review
from .derive import derive_network
from .extract import extract_document
from .ingest import ingest as run_ingest
from .match import resolve_ledger
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


def _cmd_match(args: argparse.Namespace) -> None:
    ledger_rows = ledger.load(Path(args.ledger))
    issues = issues_store.load(Path(args.issues))
    starting_count = len(issues)
    resolutions = resolve_ledger(ledger_rows, issues)
    issues_store.save(Path(args.issues), issues)
    resolutions_store.save(Path(args.resolutions), resolutions)
    print(
        f"Resolved {len(resolutions)} assertions against {len(issues)} issues "
        f"({len(issues) - starting_count} newly created) -> {args.issues}, {args.resolutions}"
    )


def _cmd_review_list(args: argparse.Namespace) -> None:
    ledger_rows = ledger.load(Path(args.ledger))
    resolutions = resolutions_store.load(Path(args.resolutions))
    queue = review.build_queue(ledger_rows, resolutions)
    print(f"{len(queue)} unreviewed assertions:")
    for a in queue:
        resolution = resolutions.get(a["id"], {})
        print(
            f"  {a['id']}  [{a.get('agreement')!s:>5} agreement]  "
            f"{a['from_issue_label']!r} -({a['weight']:+.2f}, {a['modality']})-> {a['to_issue_label']!r}  "
            f"methods={resolution.get('from_method')}/{resolution.get('to_method')}"
        )
        print(f"      quote: {a['quote']}")


def _cmd_review_confirm(args: argparse.Namespace) -> None:
    ledger_rows = ledger.load(Path(args.ledger))
    review.confirm(ledger_rows, args.assertion_id)
    ledger.save(Path(args.ledger), ledger_rows)
    if args.from_definition or args.to_definition:
        issues = issues_store.load(Path(args.issues))
        resolution = resolutions_store.load(Path(args.resolutions)).get(args.assertion_id, {})
        if args.from_definition and resolution.get("from_issue_id"):
            issue = issues_store.find(issues, resolution["from_issue_id"])
            if issue:
                issues_store.set_definition_if_missing(issue, args.from_definition)
        if args.to_definition and resolution.get("to_issue_id"):
            issue = issues_store.find(issues, resolution["to_issue_id"])
            if issue:
                issues_store.set_definition_if_missing(issue, args.to_definition)
        issues_store.save(Path(args.issues), issues)
    print(f"Confirmed {args.assertion_id}")


def _cmd_review_reject(args: argparse.Namespace) -> None:
    ledger_rows = ledger.load(Path(args.ledger))
    review.reject(ledger_rows, args.assertion_id)
    ledger.save(Path(args.ledger), ledger_rows)
    print(f"Rejected {args.assertion_id}")


def _cmd_derive(args: argparse.Namespace) -> None:
    ledger_rows = ledger.load(Path(args.ledger))
    resolutions = resolutions_store.load(Path(args.resolutions))
    network = derive_network(ledger_rows, resolutions)
    Path(args.output).write_text(json.dumps(network, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        f"Derived {len(network['nodes'])} nodes, {len(network['edges'])} edges, "
        f"{len(network['graph']['feedback_loops'])} feedback loops -> {args.output}"
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

    match_parser = subparsers.add_parser(
        "match", help="Resolve the ledger's raw issue labels onto canonical issue ids."
    )
    match_parser.add_argument("ledger")
    match_parser.add_argument("issues")
    match_parser.add_argument("resolutions")
    match_parser.set_defaults(func=_cmd_match)

    review_parser = subparsers.add_parser("review", help="Work the review queue.")
    review_subparsers = review_parser.add_subparsers(dest="review_command", required=True)

    review_list_parser = review_subparsers.add_parser("list", help="Print the ordered review queue.")
    review_list_parser.add_argument("ledger")
    review_list_parser.add_argument("resolutions")
    review_list_parser.set_defaults(func=_cmd_review_list)

    review_confirm_parser = review_subparsers.add_parser("confirm", help="Confirm one assertion.")
    review_confirm_parser.add_argument("ledger")
    review_confirm_parser.add_argument("assertion_id")
    review_confirm_parser.add_argument("--issues", default=None)
    review_confirm_parser.add_argument("--resolutions", default=None)
    review_confirm_parser.add_argument("--from-definition", dest="from_definition", default=None)
    review_confirm_parser.add_argument("--to-definition", dest="to_definition", default=None)
    review_confirm_parser.set_defaults(func=_cmd_review_confirm)

    review_reject_parser = review_subparsers.add_parser("reject", help="Reject one assertion.")
    review_reject_parser.add_argument("ledger")
    review_reject_parser.add_argument("assertion_id")
    review_reject_parser.set_defaults(func=_cmd_review_reject)

    derive_parser = subparsers.add_parser(
        "derive", help="Recompute the connection network fresh from the ledger + resolutions."
    )
    derive_parser.add_argument("ledger")
    derive_parser.add_argument("resolutions")
    derive_parser.add_argument("output")
    derive_parser.set_defaults(func=_cmd_derive)

    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
