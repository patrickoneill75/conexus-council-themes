"""The files written to the Box database folder after each scan.

  partner_intel_database.json   everything the tool serves (insights, events, topics)
  partner_intel_insights.csv    the same insights as a flat table, for Excel
  partner_intel_state.json      which files were read and every stored Claude result. If the
                                Worker's copy is ever lost, the next scan restores from this
                                file instead of paying to read the notes again.

A state larger than STATE_PART_CHARS is written in parts, partner_intel_state.a.001.json and
on, and partner_intel_state.json becomes the list of them, written last. Box takes at most
50 MB in one upload (larger needs its chunked upload API), and a body that size is more than a
Worker can safely hold in memory while it passes the file on, so no single file gets near it.
Saves alternate between the "a" and "b" parts, so a save that stops half-way leaves the last
complete one readable; every part carries its save's time, and a part from another save is
never mixed in.
"""
from __future__ import annotations

import csv
import io
import json
import re

from .dates import dates_in
from .roster import Roster

DATABASE_FILE = "partner_intel_database.json"
INSIGHTS_FILE = "partner_intel_insights.csv"
STATE_FILE = "partner_intel_state.json"
# Every Claude result ever paid for, so none is paid for twice. Not one of FILES: it is
# written only when a result is retired, not after every scan.
ARCHIVE_FILE = "partner_intel_results_archive.json"
ARCHIVE_MAX_CHARS = 40_000_000
# The admin's exact dates for files that have only an estimate (one meeting told in two files, say).
# Written once, when it does not exist, listing the files paired as one meeting; never overwritten.
FILE_DATES_FILE = "partner_intel_file_dates.csv"
FILE_DATES_COLUMNS = ["FileIDs", "Files", "Company", "Date"]
FILES = (DATABASE_FILE, INSIGHTS_FILE, STATE_FILE)
# The most one state file holds before the state is written in parts. About 8 MB: an eighth of
# Box's 50 MB single-upload limit, and small enough for the Worker to relay in its 128 MB.
STATE_PART_CHARS = 8_000_000
STATE_PART_RE = re.compile(r"^partner_intel_state\.[ab]\.\d{3}\.json$")

COLUMNS = ["InsightID", "Date", "DateSource", "SourceFolder", "EventType", "Series", "Meeting", "Company",
           "MemberStatus", "Industry", "Type", "Topic", "Title", "Detail", "Quote", "Urgency",
           "UrgencyReason", "Status", "Addresses", "Tags", "Confidence", "Speaker", "Scope",
           "SourceFiles", "SourceLinks", "ReviewFlags"]

MEMBER_LABEL = {"Active": "Council Member", "Inactive": "Not Council", "Non-member": "Not Council"}
# The app calls a "problem" row an issue; the export says the same. Other kinds read as stored.
TYPE_LABEL = {"problem": "issue"}
# The CIAIC program is now called the Council. Folder names, and the event types the pipeline
# derives from them, still say CIAIC (the database keeps them as they are, and the event type is
# part of what a stored Claude result is keyed on); the export shows the program's current name.
# The same rule as councilText in src/partner_intel.js, so the export and the app read alike.
_CIAIC = re.compile(r"\bCIAIC\b", re.I)


def program_name(name) -> str:
    """Text as the export shows it: "CIAIC" becomes "Council", "CIAIC Council Meeting" becomes
    "Council Meeting", "an CIAIC" becomes "a Council". Used for program, event and meeting names
    and for note titles and details. Quotes and file names are never passed through this: they
    keep what the notes and Box say, so a quote stays exact and a file can be found in Box."""
    text = str(name if name is not None else "")
    text = re.sub(r"\bConexus\s+Indiana\s+Advanced\s+Industr(?:y|ies)\s+Council\b", "Conexus Council", text, flags=re.I)
    text = re.sub(r"\bCIAIC\s+Council\b", "Council", text, flags=re.I)
    text = re.sub(r"\b(an?)\s+CIAIC\b", lambda m: ("A" if m.group(1)[0] == "A" else "a") + " Council", text, flags=re.I)
    return _CIAIC.sub("Council", text)


def _safe(value) -> str:
    """Spreadsheets run a cell that starts with = + - @ as a formula. Notes are untrusted."""
    text = str(value if value is not None else "")
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


def box_link(file_id) -> str:
    """The Box web page for a file, or "" for an id that is not a Box id."""
    file_id = str(file_id or "")
    return f"https://app.box.com/file/{file_id}" if file_id.isdigit() else ""


def insights_csv(dataset: dict, roster: Roster) -> str:
    partners = roster.by_id()
    topics = {t["id"]: t["label"] for t in dataset.get("topics", [])}
    notes = {c["id"]: c for c in dataset.get("companies", [])}
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\r\n")
    writer.writerow(COLUMNS)
    for i in dataset["insights"]:
        partner = partners.get(i["company_id"])
        name = partner["name"] if partner else program_name(notes.get(i["company_id"], {}).get("name") or i["company_raw"] or "Unattributed")
        status = MEMBER_LABEL.get(partner["status"], partner["status"]) if partner else "Not on the partner list"
        writer.writerow([_safe(v) for v in [
            i["id"], i["date"], i["date_source"],
            ", ".join(program_name(f) for f in (i.get("source_folders") or [i.get("source_folder", "")])),
            program_name(i["event_type"]), program_name(i["series"]), _meeting_name(i), name, status, (partner or {}).get("industry") or "Unknown",
            TYPE_LABEL.get(i["kind"], i["kind"]), topics.get(i["topic"], i["topic"]), program_name(i["title"]), program_name(i["detail"]),
            i["quote"], i["urgency"], program_name(i["urgency_reason"]), i["status"], program_name(i["solves"]), "; ".join(i["tags"]), i["confidence"], i["speaker"],
            i["scope"], "; ".join(sorted({s["name"] for s in i["sources"]})),
            " ".join(box_link(s["id"]) for s in i["sources"] if box_link(s["id"])), "; ".join(i["review"]),
        ]])
    return "﻿" + out.getvalue()  # the BOM makes Excel read accents correctly


def _meeting_name(insight: dict) -> str:
    """The Meeting column, named as the app names it: "Q2 2025 CIAIC Notes" is "Q2 2025 Council Notes"."""
    return program_name(insight.get("meeting_label", ""))


def database_json(dataset: dict) -> str:
    return json.dumps(dataset, ensure_ascii=False, separators=(",", ":"))


def state_json(registry: dict, cache: dict, saved_at: str) -> str:
    return json.dumps({"version": 1, "saved_at": saved_at, "registry": registry, "cache": cache},
                      ensure_ascii=False, separators=(",", ":"))


def next_state_set(manifest_text: str | None) -> str:
    """The set of parts the next save writes: the one the current list does not use."""
    try:
        current = json.loads(manifest_text) if manifest_text else None
    except ValueError:
        current = None
    return "b" if isinstance(current, dict) and current.get("set") == "a" else "a"


def state_parts(registry: dict, cache: dict, saved_at: str, set_name: str,
                part_chars: int | None = None) -> list[tuple[str, str]]:
    """The state as (file name, text) pairs in the order to save them: each part, then the list
    (STATE_FILE) last. Each part holds whole entries and stays under part_chars."""
    limit = part_chars or STATE_PART_CHARS
    parts: list[dict] = []
    current: dict = {"registry": {}, "cache": {}}
    size = 0
    for kind, items in (("registry", registry), ("cache", cache)):
        for key, value in items.items():
            n = len(json.dumps({key: value}, ensure_ascii=False, separators=(",", ":"))) + 2
            if size and size + n > limit - 400:  # room for the part's own header
                parts.append(current)
                current, size = {"registry": {}, "cache": {}}, 0
            current[kind][key] = value
            size += n
    parts.append(current)
    names = [f"partner_intel_state.{set_name}.{i:03d}.json" for i in range(1, len(parts) + 1)]
    out = [(name, json.dumps({"version": 2, "saved_at": saved_at, "set": set_name, "part": i, "of": len(parts),
                              "registry": part["registry"], "cache": part["cache"]},
                             ensure_ascii=False, separators=(",", ":")))
           for i, (name, part) in enumerate(zip(names, parts), 1)]
    out.append((STATE_FILE, json.dumps({"version": 2, "saved_at": saved_at, "set": set_name, "parts": names,
                                        "files": len(registry), "units": len(cache)}, separators=(",", ":"))))
    return out


def read_state(text: str | None, load) -> tuple[dict, dict] | None:
    """(registry, cache) from the saved state file, or None. Reads the single file every save
    wrote before parts existed, and the list of parts; load(name) returns a part's text. A part
    that is missing, unreadable, or from another save means no state at all: half of one would
    be written back as if it were whole."""
    saved = json.loads(text) if text else None
    if not isinstance(saved, dict):
        return None
    if isinstance(saved.get("registry"), dict) and isinstance(saved.get("cache"), dict):
        return saved["registry"], saved["cache"]
    names = saved.get("parts")
    if not isinstance(names, list) or not names:
        return None
    registry: dict = {}
    cache: dict = {}
    for i, name in enumerate(names, 1):
        if not isinstance(name, str) or not STATE_PART_RE.match(name):
            return None
        part_text = load(name)
        part = json.loads(part_text) if part_text else None
        if (not isinstance(part, dict) or part.get("saved_at") != saved.get("saved_at") or part.get("set") != saved.get("set")
                or part.get("part") != i or not isinstance(part.get("registry"), dict) or not isinstance(part.get("cache"), dict)):
            return None
        registry.update(part["registry"])
        cache.update(part["cache"])
    if len(registry) != saved.get("files") or len(cache) != saved.get("units"):
        return None
    return registry, cache


def archive_json(results: dict, saved_at: str) -> str:
    return json.dumps({"version": 1, "saved_at": saved_at, "results": results},
                      ensure_ascii=False, separators=(",", ":"))


def read_file_dates(text: str | None) -> dict[str, str]:
    """Box file id -> YYYY-MM-DD from the admin's file dates list. A row may name several files (the
    two files of one meeting); rows with no readable date are skipped."""
    out: dict[str, str] = {}
    if not text:
        return out
    for row in csv.DictReader(io.StringIO(text.lstrip("\ufeff"))):
        raw = str(row.get("Date") or "").strip()
        found = dates_in(raw) if raw else []  # 9/2/2026, 2026-09-02 and Sep 2, 2026 alike
        if not found:
            continue
        for file_id in re.findall(r"\d+", str(row.get("FileIDs") or "")):
            out[file_id] = found[0].isoformat()
    return out


def file_dates_csv(groups: list[dict], registry: dict, roster: Roster) -> str:
    """The admin's file dates list as first written: one row per meeting told in several files."""
    partners = roster.by_id()
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\r\n")
    writer.writerow(FILE_DATES_COLUMNS)
    for g in groups:
        files = [registry.get(i, {}) for i in g["files"]]
        writer.writerow([_safe(v) for v in [
            " ".join(g["files"]),
            " | ".join(f"{f.get('path', '')}/{f.get('name', '')}".strip("/") for f in files),
            (partners.get(g["company_id"]) or {}).get("name") or g["company_id"], ""]])
    return "\ufeff" + out.getvalue()
