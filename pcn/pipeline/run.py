"""The real run: pull every pending meeting plus the current ledger/issues/
resolutions state from Box (via the Worker's relay routes -- this script never
touches Box directly, see pcn/relay.py and src/pcn.js's module docstring), ingest/
normalize/extract each pending meeting, re-resolve the whole ledger against the
issue store, derive the network and timeline, and push everything back. This is what
.github/workflows/pcn_run.yml actually runs; the CLI's per-stage subcommands
(pcn/pipeline/cli.py) exist for debugging and fixture-testing one stage at a time,
not for a real run.

The whole ledger is re-resolved on every run, not just this run's new assertions --
consistent with the design doc's "recompute fresh" discipline derive/timeline already
follow. This is cheap in practice: an assertion whose label was already resolved in
a previous run hits the matching cascade's stage-1 exact/alias match immediately (see
pcn/pipeline/match's within-run cache and pcn/pipeline/issues.add_alias), so re-
resolution only ever does real (and possibly model-calling) work for genuinely new
label text, never for unchanged history.

A meeting that fails ingestion/extraction is marked "failed" (with the error)
rather than staying "pending" -- so it doesn't silently retry, and re-spend model
calls, every future run -- and rather than "processed" -- so it stays visibly
distinct from a meeting that actually made it into the ledger. Every other pending
meeting in the batch still gets processed; one bad file doesn't block the rest.
"""
from __future__ import annotations

import base64
import tempfile
from pathlib import Path

from .. import relay
from .derive import derive_network
from .extract import extract_document
from .ingest import ingest
from .match import resolve_ledger
from .models import Issue
from .normalize import normalize
from .timeline import derive_timeline


def _process_meeting(meeting: dict, tmp_dir: Path) -> list[dict]:
    content = base64.b64decode(meeting["contentBase64"])
    path = tmp_dir / f"{meeting['id']}.{meeting['inputFormat']}"
    path.write_bytes(content)
    raw = ingest(
        path, meeting["inputType"], meeting["id"],
        notetaker=meeting.get("notetaker"), meeting_date=meeting.get("meetingDate"),
    )
    doc = normalize(raw)
    assertions = extract_document(doc)
    return [a.to_dict() for a in assertions]


def run() -> None:
    print("Fetching current ledger/issues/resolutions from Box...")
    state = relay.fetch_state()
    ledger: list[dict] = state.get("ledger", [])
    issues = [Issue(**row) for row in state.get("issues", [])]

    pending = relay.fetch_pending_meetings()
    if not pending:
        print("No pending meetings -- nothing to do.")
        return
    print(f"{len(pending)} pending meeting(s) to process.")

    results = []
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        for meeting in pending:
            label = f"{meeting['id']} ({meeting.get('sourceFilename', '?')})"
            try:
                new_assertions = _process_meeting(meeting, tmp_dir)
                ledger.extend(new_assertions)
                results.append({"id": meeting["id"], "status": "processed"})
                print(f"  {label}: {len(new_assertions)} assertions extracted.")
            except Exception as exc:  # noqa: BLE001 -- one bad meeting must not abort the batch
                results.append({"id": meeting["id"], "status": "failed", "error": str(exc)})
                print(f"  {label}: FAILED -- {exc}")

    print("Resolving issue labels against the full ledger...")
    resolutions = resolve_ledger(ledger, issues)

    print("Deriving the connection network and timeline...")
    network = derive_network(ledger, resolutions, issues)
    timeline = derive_timeline(ledger, resolutions, issues)

    print("Pushing updated state back to Box, and publishing the network/timeline...")
    relay.push_state(ledger, [i.to_dict() for i in issues], resolutions)
    relay.publish_network(network)
    relay.publish_timeline(timeline)
    relay.mark_meetings_processed(results)

    processed = sum(1 for r in results if r["status"] == "processed")
    failed = sum(1 for r in results if r["status"] == "failed")
    print(f"Done: {processed} meeting(s) processed, {failed} failed. "
          f"Ledger now has {len(ledger)} assertions across {len(issues)} issues.")


if __name__ == "__main__":
    run()
