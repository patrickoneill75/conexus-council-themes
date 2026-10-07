"""Scan the Box folder, read what is new, and publish.

Run from GitHub Actions (daily, and from the admin panel's Scan button):

    python -m partner_intel.run

Environment: PI_MODE ("scan" or "rebuild"), PI_LIMIT (stop after N changed files, for a cheap
trial), PI_FORCE ("true" re-reads every file; cached units are still free).

scan     walk Box, read files whose Box checksum changed, call Claude only for units whose
         text has never been seen, then rebuild and publish.
rebuild  skip Box and Claude entirely; re-join the stored results with the current roster.
         This is what "Re-link" in the admin panel runs.
"""
from __future__ import annotations

import os
import sys
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from . import config, extract, shape as shape_mod, text as text_mod
from .build import build_dataset
from .dates import resolve_date
from .relay import Api
from .roster import Roster

IGNORED_NAMES = {".ds_store", "thumbs.db"}
CHECKPOINT_EVERY = 40


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def walk(api, root_id: str, root_name: str):
    stack = [(root_id, root_name)]
    while stack:
        folder_id, path = stack.pop()
        for entry in api.list_folder(folder_id):
            name = entry.get("name", "")
            if entry.get("type") == "folder":
                stack.append((entry["id"], f"{path}/{name}"))
            elif entry.get("type") == "file":
                if name.startswith("~$") or name.lower() in IGNORED_NAMES:
                    continue
                yield {**entry, "path": path}


def _unit_record(unit, key: str, date: str, source: str) -> dict:
    return {"key": key, "label": unit.label, "default_company": unit.default_company,
            "attendees": [list(a) for a in unit.attendees], "part": unit.part, "parts": unit.parts,
            "date": date, "date_source": source}


def run(mode: str = "scan", limit: int = 0, force: bool = False, api=None,
        caller=extract.call_claude, model: str | None = None) -> dict:
    api = api or Api()
    model = model or config.MODEL
    report: dict = {"mode": mode, "started_at": now_iso(), "model": model,
                    "prompt_version": extract.PROMPT_VERSION, "trial_limit": limit or None}
    state = api.get_state()
    registry: dict = state.get("registry") or {}
    cache: dict = state.get("cache") or {}
    roster = Roster.from_payload(api.roster())
    stats = Counter()

    if mode == "scan":
        cfg = api.config()
        if not cfg.get("folderId"):
            report.update(finished_at=now_iso(), error="No Box folder is set. Choose one in the control panel.")
            api.report(report)
            return report
        _scan(api, cfg, registry, cache, roster, caller, model, limit, force, stats, report)

    dataset = build_dataset(registry, cache, roster, now_iso())
    api.publish(dataset)
    report.update({
        "finished_at": now_iso(), "insights": dataset["stats"].get("insights", 0),
        "merged_duplicates": dataset["stats"].get("merged_duplicates", 0),
        "events": len(dataset["events"]), "not_on_roster": len(dataset["unmatched"]),
        **{k: v for k, v in stats.items()},
    })
    api.report(report)
    return report


def _scan(api, cfg, registry, cache, roster, caller, model, limit, force, stats, report):
    seen_ids: set[str] = set()
    pending: list[dict] = []
    ignored: Counter = Counter()
    needs_conversion, unreadable, no_text, too_large = [], [], [], []

    for f in walk(api, cfg["folderId"], cfg.get("folderName") or "Notes"):
        seen_ids.add(f["id"])
        stats["files_seen"] += 1
        ext = text_mod.extension(f["name"])
        if ext in text_mod.CONVERT_FIRST:
            needs_conversion.append(f["path"] + "/" + f["name"])
            continue
        if ext not in text_mod.SUPPORTED_EXTENSIONS:
            ignored[ext or "(none)"] += 1
            continue
        prior = registry.get(f["id"])
        if prior and prior.get("sha1") == f.get("sha1") and prior.get("status") in ("done", "unreadable", "no_text", "too_large") and not force:
            stats["files_unchanged"] += 1
            continue
        pending.append(f)
    report["ignored"] = dict(ignored)

    if limit:
        pending = pending[:limit]
    stats["files_to_read"] = len(pending)

    # Phase 1: download, convert, cut into units. Cheap, sequential.
    work: list[tuple[dict, dict, shape_mod.Shape, list]] = []
    for f in pending:
        entry = {"id": f["id"], "name": f["name"], "path": f["path"], "ext": text_mod.extension(f["name"]),
                 "sha1": f.get("sha1", ""), "size": f.get("size", 0), "created_at": f.get("created_at", ""),
                 "modified_at": f.get("modified_at", ""), "processed_at": now_iso()}
        if (f.get("size") or 0) > config.MAX_FILE_BYTES:
            entry.update(status="too_large", error="Larger than the 40 MB read limit.")
            registry[f["id"]] = entry
            too_large.append(f["name"])
            continue
        try:
            doc = text_mod.to_document(f["name"], api.download(f["id"]))
        except text_mod.NoTextLayer as e:
            entry.update(status="no_text", error=str(e))
            registry[f["id"]] = entry
            no_text.append(f["path"] + "/" + f["name"])
            continue
        except text_mod.UnreadableFile as e:
            entry.update(status="unreadable", error=str(e))
            registry[f["id"]] = entry
            unreadable.append({"file": f["path"] + "/" + f["name"], "error": str(e)})
            continue
        s = shape_mod.classify(f["name"], f["path"], doc)
        if not s.units:
            entry.update(status="done", error=s.skipped_reason, units=[],
                         event={"date": "", "date_source": "", "type": s.event_type, "series": s.series,
                                "shape": s.shape, "scope": s.scope})
            registry[f["id"]] = entry
            stats["files_without_content"] += 1
            continue
        work.append((f, entry, s, [text_mod.clean_text(doc.text)]))

    # Dates and unit records, then the list of units that have never been read.
    to_run: dict[str, tuple] = {}
    for f, entry, s, (full_text,) in work:
        prior_units = {u["key"]: u for u in (registry.get(f["id"], {}).get("units") or [])}
        file_date, file_source = resolve_date(
            f["name"], full_text, f.get("created_at"), text_allowed=s.text_date_allowed)
        units = []
        for unit in s.units:
            key = extract.cache_key(unit, s.event_type, model)
            if key in prior_units:
                date, source = prior_units[key]["date"], prior_units[key]["date_source"]
            elif file_source == "box_upload":
                fallback = f.get("modified_at") if f["id"] in registry else f.get("created_at")
                date, source = resolve_date(f["name"], "", f.get("created_at"), text_allowed=False,
                                            fallback_at=fallback)
            else:
                date, source = file_date, file_source
            units.append(_unit_record(unit, key, date, source))
            if key not in cache:
                to_run[key] = (unit, s.event_type)
            else:
                stats["units_cached"] += 1
        entry.update(status="done", event={
            "date": file_date, "date_source": file_source, "type": s.event_type, "series": s.series,
            "shape": s.shape, "scope": s.scope}, units=units)
        entry["_pending"] = [u["key"] for u in units if u["key"] in to_run]
        registry[f["id"]] = entry

    # Phase 2: the only step that costs money. Each unit once, in parallel, checkpointed.
    stats["units_to_read"] = len(to_run)
    errors: list[str] = []
    lock = threading.Lock()
    done_since_push = 0

    def one(key: str):
        unit, event_type = to_run[key]
        return key, extract.extract_unit(unit, event_type, roster.staff, model, caller=caller)

    if to_run and caller is extract.call_claude and not config.CLAUDE_API_KEY:
        errors.append("PARTNER_INTEL_CLAUDE_API_KEY is not set. Add the repository secret "
                      "partner_intel_claude_api. Nothing new was read.")
        to_run = {}
    if to_run:
        with ThreadPoolExecutor(max_workers=max(1, config.WORKERS)) as pool:
            futures = {pool.submit(one, k): k for k in to_run}
            for fut in as_completed(futures):
                key = futures[fut]
                try:
                    _, result = fut.result()
                except Exception as e:  # one bad unit must not lose the rest
                    errors.append(f"{to_run[key][0].label or 'unit'}: {e}"[:300])
                    continue
                with lock:
                    cache[key] = result
                    stats["claude_calls"] += 1
                    stats["tokens_in"] += result["usage"].get("input", 0)
                    stats["tokens_out"] += result["usage"].get("output", 0)
                    stats["rows_kept"] += len(result["rows"])
                    stats["rows_rejected"] += result["rejected"]
                    done_since_push += 1
                    if done_since_push >= CHECKPOINT_EVERY:
                        done_since_push = 0
                        _store(api, registry, cache)

    for entry in registry.values():
        pending_keys = entry.pop("_pending", [])
        missing = [k for k in pending_keys if k not in cache]
        if missing:
            entry["status"] = "partial"
            entry["error"] = f"{len(missing)} section(s) could not be read yet; they retry on the next scan."

    # Files removed from Box leave the tool, but only after a complete walk.
    if not limit:
        for gone in [i for i in registry if i not in seen_ids]:
            del registry[gone]
            stats["files_removed"] += 1
        live = {u["key"] for e in registry.values() for u in e.get("units", [])}
        for stale in [k for k in cache if k not in live]:
            del cache[stale]

    _store(api, registry, cache)
    report.update({"needs_conversion": needs_conversion, "unreadable": unreadable, "no_text": no_text,
                   "too_large": too_large, "errors": errors[:20]})


def _store(api, registry: dict, cache: dict) -> None:
    clean = {i: {k: v for k, v in e.items() if k != "_pending"} for i, e in registry.items()}
    api.put_state(clean, cache)


def main() -> int:
    mode = os.environ.get("PI_MODE", "scan")
    if mode not in ("scan", "rebuild"):
        print(f"Unknown PI_MODE {mode!r}", file=sys.stderr)
        return 2
    limit = int(os.environ.get("PI_LIMIT") or 0)
    force = os.environ.get("PI_FORCE", "").lower() == "true"
    report = run(mode=mode, limit=limit, force=force)
    print({k: v for k, v in report.items() if k not in ("unreadable", "needs_conversion", "no_text")})
    return 1 if report.get("error") else 0


if __name__ == "__main__":
    sys.exit(main())
