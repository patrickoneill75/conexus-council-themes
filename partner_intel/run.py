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

import json
import os
import sys
import threading
from collections import Counter
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

from . import config, extract, shape as shape_mod, text as text_mod
from .build import build_dataset, source_folder
from . import export
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
        caller=extract.call_claude, model: str | None = None, batch_client=None) -> dict:
    """batch_client is swapped in by tests. Real scans use the Batches API when config.USE_BATCH
    is on and the real caller is in use."""
    api = api or Api()
    model = model or config.MODEL
    report: dict = {"mode": mode, "started_at": now_iso(), "model": model,
                    "prompt_version": extract.PROMPT_VERSION, "trial_limit": limit or None}
    state = api.get_state()
    registry: dict = state.get("registry") or {}
    cache: dict = state.get("cache") or {}
    cfg = api.config()
    if not registry and not cache and cfg.get("dataFolderId"):
        restored = _restore_from_box(api)
        if restored:
            registry, cache = restored
            report["restored_from_box"] = True
    stats = Counter()
    archive = _Archive(api, cfg)

    if mode == "scan":
        if not cfg.get("folderId"):
            report.update(finished_at=now_iso(), error="No Box folder is set. Choose one in the control panel.")
            api.report(report)
            return report
        # The member list is refreshed first so a partner who joined or left is recognized by
        # the scan that follows. A failure here must not stop the notes being read.
        try:
            report["roster_sync"] = api.sync_roster()
        except Exception as e:
            report["roster_sync"] = {"error": str(e)[:200]}
    roster = Roster.from_payload(api.roster())

    if mode == "scan":
        _scan(api, cfg, registry, cache, roster, caller, model, limit, force, stats, report, archive, batch_client)

    dataset = build_dataset(registry, cache, roster, now_iso())
    api.publish(dataset)
    _save_to_box(api, cfg, dataset, registry, cache, roster, report)
    archive.save(report)
    report.update({
        "finished_at": now_iso(), "insights": dataset["stats"].get("insights", 0),
        "merged_duplicates": dataset["stats"].get("merged_duplicates", 0),
        "events": len(dataset["events"]), "not_on_roster": len(dataset["unmatched"]),
        **{k: v for k, v in stats.items()},
    })
    api.report(report)
    return report


def _restore_from_box(api):
    """Bring back the saved registry and results from the Box database folder, if the
    Worker's own copy is empty. Returns (registry, cache) or None."""
    try:
        text = api.load_from_box(export.STATE_FILE)
        if not text:
            return None
        saved = json.loads(text)
        if isinstance(saved.get("registry"), dict) and isinstance(saved.get("cache"), dict):
            return saved["registry"], saved["cache"]
    except Exception:
        return None
    return None


def _save_to_box(api, cfg, dataset, registry, cache, roster, report) -> None:
    """Write the database files to the chosen Box folder. A failure is reported, never fatal:
    the Worker's copy has already been published and the next scan writes the files again."""
    if not cfg.get("dataFolderId"):
        report["box_note"] = "No database folder is chosen, so nothing was saved to Box."
        return
    saved, errors = [], []
    clean = {i: {k: v for k, v in e.items() if k != "_pending"} for i, e in registry.items()}
    files = {
        export.DATABASE_FILE: lambda: export.database_json(dataset),
        export.INSIGHTS_FILE: lambda: export.insights_csv(dataset, roster),
        export.STATE_FILE: lambda: export.state_json(clean, cache, now_iso()),
    }
    for name, make in files.items():
        try:
            api.save_to_box(name, make())
            saved.append(name)
        except Exception as e:
            errors.append(f"{name}: {str(e)[:200]}")
    report["box_saved"] = saved
    if errors:
        report["box_errors"] = errors


class _Archive:
    """Every Claude result ever paid for, kept in the Box database folder.

    The live results shrink to what the current files need, so the Worker's copy stays small.
    A result dropped from it (a file edited, removed, or a model tried and abandoned) is moved
    here instead of being lost, and every scan looks here before paying Claude. Box storage is
    effectively free; a re-read is not. Loaded at most once a run, and only when needed.
    """

    def __init__(self, api, cfg):
        self.api, self.enabled = api, bool(cfg.get("dataFolderId"))
        self.results: dict | None = None
        self.retired: dict = {}
        self.unreadable = False

    def _load(self) -> dict:
        if self.results is None:
            self.results = {}
            try:
                text = self.api.load_from_box(export.ARCHIVE_FILE) if self.enabled else None
                saved = json.loads(text) if text else {}
                if isinstance(saved.get("results"), dict):
                    self.results = saved["results"]
            except Exception:
                # Box did not answer. Saving now would replace the whole archive with this
                # run's few results, so this run will not save it at all.
                self.results, self.unreadable = {}, True
        return self.results

    def find(self, keys) -> dict:
        if not self.enabled or not keys:
            return {}
        results = self._load()
        return {k: results[k] for k in keys if k in results}

    def retire(self, key: str, entry: dict) -> None:
        self.retired[key] = entry

    def save(self, report: dict) -> None:
        if not self.enabled or not self.retired:
            return
        results = self._load()
        if self.unreadable:
            report.setdefault("box_errors", []).append(
                f"{export.ARCHIVE_FILE}: could not be read, so it was left as it was; {len(self.retired)} result(s) were not archived.")
            return
        results.update(self.retired)
        text = export.archive_json(results, now_iso())
        # Box takes 50 MB through the relay. Past the cap the oldest results go first.
        while len(text) > export.ARCHIVE_MAX_CHARS and results:
            oldest = sorted(results, key=lambda k: results[k].get("created_at", ""))
            for k in oldest[:max(1, len(oldest) // 10)]:
                del results[k]
            text = export.archive_json(results, now_iso())
        try:
            self.api.save_to_box(export.ARCHIVE_FILE, text)
            report["archived_results"] = len(self.retired)
        except Exception as e:
            report.setdefault("box_errors", []).append(f"{export.ARCHIVE_FILE}: {str(e)[:200]}")


def _scan(api, cfg, registry, cache, roster, caller, model, limit, force, stats, report, archive=None, batch_client=None):
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
                 "modified_at": f.get("modified_at", ""), "processed_at": now_iso(),
                 "source": source_folder(f["path"])}
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
                to_run.setdefault(key, (unit, s.event_type, f["name"]))
            else:
                stats["units_cached"] += 1
        entry.update(status="done", event={
            "date": file_date, "date_source": file_source, "type": s.event_type, "series": s.series,
            "shape": s.shape, "scope": s.scope}, units=units)
        entry["_pending"] = [u["key"] for u in units if u["key"] in to_run]
        registry[f["id"]] = entry

    # Results paid for in an earlier life of a file come back from the Box archive for free.
    if archive is not None:
        for key, entry in archive.find(list(to_run)).items():
            cache[key] = entry
            del to_run[key]
            stats["units_from_archive"] += 1

    # Phase 2: the only step that costs money. Each unit once, checkpointed.
    stats["units_to_read"] = len(to_run)
    errors: list[str] = []
    lock = threading.Lock()
    done_since_push = 0

    def one(key: str):
        unit, event_type, _ = to_run[key]
        return key, extract.extract_unit(unit, event_type, roster.staff, model, caller=caller)

    if to_run and caller is extract.call_claude and not config.CLAUDE_API_KEY:
        errors.append("PARTNER_INTEL_CLAUDE_API_KEY is not set. Add the repository secret "
                      "partner_intel_claude_api. Nothing new was read.")
        to_run = {}

    def record(key: str, result: dict) -> None:
        nonlocal done_since_push
        with lock:
            cache[key] = result
            how = "batch" if result.get("batch") else "sync"
            calls = 1 + result.get("split_calls", 0)
            stats["claude_calls"] += calls
            stats[f"claude_calls_{how}"] += calls
            stats["sections_split"] += 1 if result.get("split_calls") else 0
            for side in ("in", "out"):
                n = result["usage"].get("input" if side == "in" else "output", 0)
                stats[f"tokens_{side}"] += n
                stats[f"tokens_{side}_{how}"] += n
            stats["rows_kept"] += len(result["rows"])
            stats["rows_rejected"] += result["rejected"]
            if result.get("refused"):
                stats["sections_refused"] += 1
                errors.append(f"{to_run_all[key][2]}: {result['refused']}"[:300])
            done_since_push += 1
            if done_since_push >= CHECKPOINT_EVERY:
                done_since_push = 0
                _store(api, registry, cache)

    to_run_all = dict(to_run)
    use_batch = batch_client is not None or (caller is extract.call_claude and config.USE_BATCH)
    if to_run and use_batch:
        jobs = {k: (unit, event_type) for k, (unit, event_type, _) in to_run.items()}
        try:
            got, leftover, note = extract.extract_batch(jobs, roster.staff, model, client=batch_client,
                                                        wait_minutes=config.BATCH_WAIT_MINUTES)
        except Exception as e:  # a batch that cannot start must not stop the scan
            got, leftover, note = {}, list(jobs), f"The batch could not run ({str(e)[:150]}); every section was read directly."
        for key, result in got.items():
            record(key, result)
        if note:
            report["batch_note"] = note
        to_run = {k: to_run[k] for k in leftover}
        if to_run:
            _store(api, registry, cache)

    if to_run:
        with ThreadPoolExecutor(max_workers=max(1, config.WORKERS)) as pool:
            futures = {pool.submit(one, k): k for k in to_run}
            for fut in as_completed(futures):
                key = futures[fut]
                try:
                    _, result = fut.result()
                except Exception as e:  # one bad unit must not lose the rest
                    unit, _, file_name = to_run[key]
                    errors.append(f"{file_name}, section {unit.label or '(unnamed)'}: {e}"[:300])
                    continue
                record(key, result)

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
            if archive is not None:
                archive.retire(stale, cache[stale])
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
