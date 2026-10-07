"""Turn cached extraction results into the dataset the Worker serves.

Nothing here calls a model. It reads the registry (which files and units exist, and their
dates), the cache (what the model said about each unit) and the roster (who the partners are
now), and joins them. That is why a roster edit or an alias fix can be applied by re-running
this step alone, at no Claude cost.

Meeting rule (from the admin): the same date and the same company is one meeting, however
many files describe it. Rows from different files that say the same thing about the same
company on the same date are merged into one insight carrying every source.
"""
from __future__ import annotations

import hashlib
import re
from collections import Counter, defaultdict

from . import topics
from .extract import normalize
from .resolve import Match, Resolver, core_key
from .roster import Roster

# Bumped when the published dataset gains fields the Worker's pages depend on. The control panel
# offers a one-time rebuild to datasets published before it (no Box, no Claude).
SCHEMA_VERSION = 2

CONFIDENCE_RANK = {"high": 3, "medium": 2, "low": 1}
URGENCY_RANK = {"high": 3, "medium": 2, "low": 1, "none": 0}
_STOP = {"the", "a", "an", "and", "of", "to", "for", "in", "on", "with", "is", "are", "at", "by"}
_CONEXUS = re.compile(r"\bconn?exus\b", re.I)


def _words(text: str) -> set[str]:
    return {w for w in re.split(r"[^a-z0-9]+", normalize(text)) if w and w not in _STOP}


def _jaccard(a: set[str], b: set[str]) -> float:
    return len(a & b) / len(a | b) if a and b else 0.0


def _similar(a: dict, b: dict) -> bool:
    if a["quote"] and normalize(a["quote"]) == normalize(b["quote"]):
        return True
    if _jaccard(_words(a["title"]), _words(b["title"])) >= 0.5:
        return True
    return a["topic"] == b["topic"] and _jaccard(_words(a["detail"]), _words(b["detail"])) >= 0.6


def source_folder(path: str) -> str:
    """The top-level folder under the chosen Box root: "Notes/CIAIC/2025" gives "CIAIC".
    A file sitting directly in the root has no sub-folder and is "(root)"."""
    parts = [p for p in (path or "").split("/") if p]
    return parts[1] if len(parts) > 1 else "(root)"


def _file_stem(name: str) -> str:
    stem = re.sub(r"\.[A-Za-z0-9]{2,5}$", "", name or "")
    return " ".join(stem.replace("_", " ").split()) or "Untitled"


def _meeting(shape: str, series: str, event_type: str, company_name: str, single_company: str, stem: str):
    """Which meeting a row belongs to, so a program's data can be shown as meetings.

    A cohort is one meeting however many companies spoke. A running onboarding file holds one
    call per company. A file about one company is a visit to that company. Anything else (a
    council meeting, a board meeting, a workshop) is one meeting per file.
    Returns (label, kind).
    """
    if series and series != event_type:
        return series, "cohort"
    if shape == "copilot_recap":
        return company_name or "Unattributed", "company"
    if single_company:
        return single_company, "company"
    return stem, "meeting"


def _note_company_id(raw: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", core_key(raw)).strip("-")
    return f"n-{slug}" if slug else ""


def _merge(group: list[dict]) -> list[dict]:
    merged: list[dict] = []
    for row in group:
        for existing in merged:
            if _similar(existing, row):
                _absorb(existing, row)
                break
        else:
            merged.append(row)
    return merged


def _absorb(base: dict, other: dict) -> None:
    if (CONFIDENCE_RANK[other["confidence"]], len(other["detail"])) > (
            CONFIDENCE_RANK[base["confidence"]], len(base["detail"])):
        for field in ("detail", "quote", "title", "confidence", "speaker", "solves"):
            base[field] = other[field]
    if URGENCY_RANK[other["urgency"]] > URGENCY_RANK[base["urgency"]]:
        base["urgency"], base["urgency_reason"] = other["urgency"], other["urgency_reason"]
    if other["status"] == "resolved":
        base["status"] = "resolved"
    base["tags"] = sorted(set(base["tags"]) | set(other["tags"]))[:8]
    base["source_folders"] = sorted(set(base["source_folders"]) | set(other["source_folders"]))
    for src in other["sources"]:
        if src not in base["sources"]:
            base["sources"].append(src)
    base["review"] = sorted(set(base["review"]) | set(other["review"]))


def build_dataset(registry: dict, cache: dict, roster: Roster, generated_at: str) -> dict:
    resolver = Resolver(roster)
    staff_extra: set[str] = set()

    # People learned from attendee tables: the only reliable link between a first name in
    # the discussion and a company.
    for entry in registry.values():
        for unit in entry.get("units", []):
            for name, affiliation in unit.get("attendees") or []:
                if not affiliation:
                    continue
                if _CONEXUS.search(affiliation):
                    staff_extra.add(name)
                    continue
                match = resolver.affiliation(affiliation)
                if match.ok:
                    resolver.learn_person(name, match.company_id)
    staff_names = list(roster.staff) + sorted(staff_extra)
    staff_resolver = Resolver(Roster(roster.partners, roster.aliases, staff_names, roster.updated_at))
    staff_resolver.people = resolver.people

    partners = roster.by_id()
    notes_companies: dict[str, dict] = {}
    unmatched: dict[str, dict] = {}
    events, rows_out = [], []
    stats = Counter()

    for file_id, entry in sorted(registry.items(), key=lambda kv: (kv[1].get("event", {}).get("date", ""), kv[1].get("path", ""))):
        event = entry.get("event") or {}
        used_units = 0
        entry_rows: list[dict] = []
        for unit in entry.get("units", []):
            cached = cache.get(unit["key"])
            if not cached:
                continue
            used_units += 1
            for index, row in enumerate(cached["rows"]):
                stats["rows_read"] += 1
                review: list[str] = []
                by_model = resolver.company(row["company"]) if row["company"] else Match(None, "none")
                by_person = resolver.person(row["speaker"]) if row["speaker"] else None
                by_section = resolver.company(unit.get("default_company", "")) if unit.get("default_company") else Match(None, "none")
                company_id, raw_name = "", row["company"] or unit.get("default_company", "")
                if by_model.ok:
                    company_id = by_model.company_id
                    if by_person and by_person != company_id:
                        review.append("speaker_company_conflict")
                elif by_section.ok:
                    # A section heading names the partner interviewed. When the model's own
                    # spelling of it is not recognized, the heading is the stronger signal.
                    company_id = by_section.company_id
                elif by_person and not row["company"]:
                    company_id = by_person
                elif raw_name:
                    company_id = _note_company_id(raw_name)
                    if company_id:
                        notes_companies.setdefault(company_id, {
                            "id": company_id, "name": raw_name, "industry": "", "status": "Non-member",
                            "source": "notes"})
                        info = unmatched.setdefault(company_id, {
                            "raw": raw_name, "companyId": company_id, "count": 0,
                            "candidates": list(by_model.candidates or by_section.candidates)})
                        info["count"] += 1
                        if by_model.method == "ambiguous" or by_section.method == "ambiguous":
                            review.append("ambiguous_company")
                        if by_person:
                            review.append("speaker_company_conflict")
                        review.append("not_on_roster")
                if not company_id:
                    review.append("no_company")
                scope = entry.get("event", {}).get("scope", "partner")
                if (row["speaker_is_conexus_staff"] or staff_resolver.is_staff(row["speaker"])
                        or _CONEXUS.search(row["company"] or "")):
                    scope = "internal"
                if row["confidence"] == "low":
                    review.append("low_confidence")
                if unit.get("date_source") == "box_upload":
                    review.append("estimated_date")
                date = unit.get("date") or event.get("date") or ""
                meeting_key = f"{date}|{company_id or core_key(raw_name)}"
                row_dict = {
                    "id": hashlib.sha1(f"{unit['key']}:{index}".encode()).hexdigest()[:12],
                    "kind": row["kind"], "company_id": company_id,
                    "company_raw": raw_name, "speaker": row["speaker"],
                    "title": row["title"], "detail": row["detail"], "quote": row["quote"],
                    "topic": row["topic"], "tags": row["tags"], "urgency": row["urgency"],
                    "urgency_reason": row["urgency_reason"], "status": row["status"],
                    "solves": row["solves"], "confidence": row["confidence"], "scope": scope,
                    "date": date, "date_source": unit.get("date_source") or event.get("date_source") or "",
                    "event_type": event.get("type", ""), "series": event.get("series", ""),
                    "meeting_key": meeting_key, "review": sorted(set(review)),
                    "source_folder": entry.get("source") or source_folder(entry.get("path", "")),
                    "source_folders": [entry.get("source") or source_folder(entry.get("path", ""))],
                    "sources": [{"id": file_id, "name": entry.get("name", ""), "path": entry.get("path", "")}],
                }
                entry_rows.append(row_dict)
                rows_out.append(row_dict)
        # Meetings are decided per file, once every row's company is known.
        file_ids = {r["company_id"] for r in entry_rows if r["company_id"]}

        def display(cid: str, raw: str) -> str:
            return (partners.get(cid, {}).get("name") or notes_companies.get(cid, {}).get("name") or raw or "")

        single = display(next(iter(file_ids)), "") if len(file_ids) == 1 else ""
        stem = _file_stem(entry.get("name", ""))
        for r in entry_rows:
            label, kind = _meeting(event.get("shape", ""), event.get("series", ""), event.get("type", ""),
                                   display(r["company_id"], r["company_raw"]), single, stem)
            r["meeting_label"], r["meeting_kind"] = label, kind
            r["meeting_id"] = hashlib.sha1(f"{r['date']}|{core_key(label) or label.lower()}".encode()).hexdigest()[:10]
        if used_units:
            events.append({"id": file_id, "name": entry.get("name", ""), "path": entry.get("path", ""),
                           "date": event.get("date", ""), "date_source": event.get("date_source", ""),
                           "type": event.get("type", ""), "series": event.get("series", ""),
                           "scope": event.get("scope", "partner")})

    groups: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows_out:
        groups[(r["meeting_key"], r["kind"], r["scope"])].append(r)
    insights = []
    for group in groups.values():
        insights.extend(_merge(group))
    insights.sort(key=lambda r: (r["date"], r["id"]), reverse=True)
    stats["insights"] = len(insights)
    stats["merged_duplicates"] = len(rows_out) - len(insights)

    for info in unmatched.values():
        info["candidates"] = [{"id": c, "name": partners[c]["name"]} for c in info["candidates"] if c in partners]
    version = hashlib.sha1((generated_at + "".join(i["id"] for i in insights)).encode()).hexdigest()[:12]
    return {
        "schema": SCHEMA_VERSION, "version": version, "generated_at": generated_at, "roster_updated_at": roster.updated_at,
        "topics": topics.as_dataset(), "events": events, "insights": insights,
        "companies": sorted(notes_companies.values(), key=lambda c: c["name"].lower()),
        "unmatched": sorted(unmatched.values(), key=lambda u: -u["count"]),
        "stats": dict(stats),
    }
