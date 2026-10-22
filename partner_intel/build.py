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
from .dates import ESTIMATED_SOURCES
from .extract import normalize
from .resolve import Match, Resolver, Speaker, core_key, name_tokens
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


def _similarity(a: dict, b: dict) -> float:
    """How surely two rows are one statement recorded twice, 0 when they are two statements.

    Copies of one meeting (a Word file and a text summary) word the same statement differently, so
    across files a similar title is enough. Within one file the pieces only overlap by a few lines,
    so the same statement twice has the same words: the title and the detail must both agree. Two
    rows from one reading of one piece need the closest agreement: the model was told to record each
    statement once, and "Steel price increases squeezing margins" and "Resin price increases
    squeezing margins" from one call are two problems unless their details agree as well."""
    if a["quote"] and normalize(a["quote"]) == normalize(b["quote"]):
        return 2.0
    title = _jaccard(_words(a["title"]), _words(b["title"]))
    detail = _jaccard(_words(a["detail"]), _words(b["detail"]))
    if a["_unit"] == b["_unit"]:
        # One reading of one piece restating a point says it in the same words, title and detail.
        return title if title >= 0.5 and detail >= 0.5 else 0.0
    if a["_file"] == b["_file"]:
        return title if title >= 0.5 and detail >= 0.3 else (detail if a["topic"] == b["topic"] and detail >= 0.6 else 0.0)
    if title >= 0.5:
        return title
    return detail if a["topic"] == b["topic"] and detail >= 0.6 else 0.0


def source_folder(path: str, name: str = "") -> str:
    """The top-level folder under the chosen Box root: "Notes/CIAIC/2025/x.docx" gives "CIAIC".
    A file sitting directly in the root has no sub-folder and is "(root)". The file's own name is
    taken off first: a web link's name is its address, and "Notes/https://www.wfyi.org/..." must not
    make a program called "https:"."""
    path = path or ""
    if name and path.endswith("/" + name):
        path = path[: -len(name) - 1]
    elif name and path == name:
        path = ""
    parts = [p for p in path.split("/") if p]
    # A folder name never ends in ":"; "https:" is a web address (a link with no name of its own).
    return parts[1] if len(parts) > 1 and not parts[1].endswith(":") else "(root)"


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


def _person_named_as_company(resolver: Resolver, staff_resolver: Resolver, raw: str, speaker_name: str,
                             speaker: Speaker, attendees, context: set[str]):
    """When the company a row gives is really a person, who: (full name, company id or None,
    candidate companies). None when raw is not known to be a person.

    A person is the row's own speaker, an attendee, Conexus staff, someone on the contact list,
    or a name the speaker resolver recognizes. A lone first name counts only as the first name
    of the row's speaker or of an attendee ("Allison" said by Allison Clay is not Allison
    Transmission), or of the one contact with it at a company the file is about. Nothing else
    is guessed: an unknown two-word company stays a company."""
    toks = name_tokens(raw)
    if not toks:
        return None
    # A speaker label or attendee entry that is itself a partner's name ("Lucas Oil: ..." in a
    # text transcript) is a company, not a person.
    is_partner = lambda n: resolver.company(n, guess=True).ok
    spoken = name_tokens(speaker_name or "") if speaker_name and not is_partner(speaker_name) else []
    names = [n for n, _ in attendees or [] if n and not is_partner(n)]
    if len(toks) == 1:
        if len(spoken) >= 2 and spoken[0] == toks[0]:
            return speaker.full_name or speaker_name, speaker.company_id, list(speaker.candidates)
        matching = [n for n in names if len(name_tokens(n)) >= 2 and name_tokens(n)[0] == toks[0]]
        by_first = resolver.speaker(raw, context)
        if matching:
            if len(matching) == 1:
                one = resolver.speaker(matching[0], context)
                return matching[0], one.company_id, list(one.candidates)
            return raw, by_first.company_id, list(by_first.candidates)
        if by_first.how == "first name in context":
            return by_first.full_name, by_first.company_id, []
        return None
    key = " ".join(toks)
    if spoken and key == " ".join(spoken):
        return speaker.full_name or speaker_name, speaker.company_id, list(speaker.candidates)
    for n in names:
        if key == " ".join(name_tokens(n)):
            hit = resolver.speaker(n, context)
            return n, hit.company_id, list(hit.candidates)
    if staff_resolver.is_staff(raw):
        return raw, None, []
    hit = resolver.speaker(raw, context)
    if hit.how in ("contact", "contact in context", "ambiguous"):
        return hit.full_name or raw, hit.company_id, list(hit.candidates)
    cid = resolver.person(raw)
    if cid:
        return raw, cid, []
    return None


def _note_company_id(raw: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", core_key(raw)).strip("-")
    return f"n-{slug}" if slug else ""


def _merge(group: list[dict]) -> list[dict]:
    """Rows recorded twice become one; each row joins the existing row it is MOST like, so the resin
    row in a text copy joins the resin row, not the steel row its title also resembles."""
    merged: list[dict] = []
    for row in group:
        best, score = None, 0.0
        for existing in merged:
            s = _similarity(existing, row)
            if s > score:
                best, score = existing, s
        if best is not None:
            _absorb(best, row)
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


def _name(partners: dict, company_id: str) -> str:
    return (partners.get(company_id) or {}).get("name") or company_id


def unit_context(resolver: Resolver, unit) -> set[str]:
    """The companies a piece of notes is about, from its structure rather than its content: the
    partner the file is named for, its section heading, its attendee list. This is what lets a
    first name ("Ben") point to one person. Companies merely mentioned in the text are not
    included: Ben mentioning Eli Lilly must not make every Ben at Lilly a candidate. unit is a
    shape.Unit or the stored record of one."""
    get = (lambda k: getattr(unit, k, "")) if not isinstance(unit, dict) else (lambda k: unit.get(k) or "")
    ids = set()
    for name in (get("file_company"), get("default_company")):
        if name:
            hit = resolver.company(name)
            if hit.ok:
                ids.add(hit.company_id)
    for _, affiliation in get("attendees") or []:
        if affiliation:
            hit = resolver.affiliation(affiliation)
            if hit.ok:
                ids.add(hit.company_id)
    return ids


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
            context = unit_context(resolver, unit)
            file_cid = resolver.company(unit["file_company"]).company_id if unit.get("file_company") else None
            for index, row in enumerate(cached["rows"]):
                stats["rows_read"] += 1
                review: list[str] = []
                options: list[dict] = []  # other companies a person checking this row should consider
                by_model = resolver.company(row["company"]) if row["company"] else Match(None, "none")
                speaker = resolver.speaker(row["speaker"], context) if row["speaker"] else Speaker()
                by_person = speaker.company_id
                by_section = resolver.company(unit.get("default_company", "")) if unit.get("default_company") else Match(None, "none")
                company_id, raw_name = "", row["company"] or unit.get("default_company", "")
                attendees = unit.get("attendees") or []
                # The company the notes give can be a person: Claude copied the speaker ("Chad
                # Smith"), or wrote a first name that is also a partner's brand ("Allison" for
                # Allison Clay). A person is never made a company, and a name that only partly
                # matches a partner does not make them that partner. An exact partner name or an
                # admin's alias is trusted as written.
                person = None
                if row["company"] and by_model.method not in ("exact", "alias"):
                    person = _person_named_as_company(resolver, staff_resolver, row["company"], row["speaker"],
                                                      speaker, attendees, context)
                if person and by_model.ok:
                    options.append({"id": by_model.company_id,
                                    "why": f"\"{row['company']}\" is how the notes name {person[0]}, and also part of {_name(partners, by_model.company_id)}"})
                    by_model = Match(None, "none")
                if not person and not row["company"] and raw_name and not by_section.ok and not by_person:
                    # A section heading that is a person's name.
                    person = _person_named_as_company(resolver, staff_resolver, raw_name, row["speaker"],
                                                      speaker, attendees, context)
                if person:
                    raw_name = ""
                    review.append("company_is_person")
                if by_model.ok:
                    # Claude named the company. A statement can be about another company than the
                    # speaker's (a customer, a supplier), so the speaker does not overrule it; a
                    # disagreement is put in front of a person with the speaker's company offered.
                    company_id = by_model.company_id
                    if by_person and by_person != company_id:
                        review.append("speaker_company_conflict")
                        options.append({"id": by_person, "why": f"{speaker.full_name} works at {_name(partners, by_person)}"})
                elif by_section.ok:
                    # A section heading names the partner interviewed. When the model's own
                    # spelling of it is not recognized, the heading is the stronger signal.
                    company_id = by_section.company_id
                elif person:
                    # The person's own company when it is known, put up for checking; otherwise
                    # no company (flagged no_company below), with what is known offered.
                    full, person_cid, candidates = person
                    company_id = person_cid or ""
                    if company_id:
                        options.append({"id": company_id, "why": f"the notes gave {full}, a person, as the company; {full} works at {_name(partners, company_id)}"})
                        if by_person and by_person != company_id:
                            review.append("speaker_company_conflict")
                            options.append({"id": by_person, "why": f"{speaker.full_name} works at {_name(partners, by_person)}"})
                    else:
                        if candidates:
                            review.append("speaker_ambiguous")
                            options.extend({"id": cid, "why": f"a {full} works at {_name(partners, cid)}"} for cid in candidates[:4])
                        if by_person:
                            review.append("speaker_company_conflict")
                            options.append({"id": by_person, "why": f"{speaker.full_name} works at {_name(partners, by_person)}"})
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
                            options.append({"id": by_person, "why": f"{speaker.full_name} works at {_name(partners, by_person)}"})
                        review.append("not_on_roster")
                if not company_id and speaker.how == "ambiguous" and speaker.candidates:
                    # "Ben" in a file about two companies, each with a Ben: list them, never pick.
                    review.append("speaker_ambiguous")
                    options.extend({"id": cid, "why": f"a {row['speaker']} works at {_name(partners, cid)}"}
                                   for cid in speaker.candidates[:4])
                if not company_id:
                    review.append("no_company")
                elif file_cid and file_cid != company_id:
                    # The file is named for one partner and the row names another. Often right (a
                    # supplier or customer mentioned in the call), sometimes a misreading, so it
                    # is flagged for a person to check rather than changed.
                    review.append("company_differs_from_file")
                    if not any(o["id"] == file_cid for o in options):
                        options.append({"id": file_cid, "why": f"the file is named for {_name(partners, file_cid)}"})
                if speaker.how == "first name in context":
                    row = {**row, "speaker": speaker.full_name}  # "Ben" in the Evonik file is Ben Larson
                scope = entry.get("event", {}).get("scope", "partner")
                if (row["speaker_is_conexus_staff"] or staff_resolver.is_staff(row["speaker"])
                        or _CONEXUS.search(row["company"] or "")):
                    scope = "internal"
                if row["confidence"] == "low":
                    review.append("low_confidence")
                if unit.get("date_source") in ESTIMATED_SOURCES:
                    review.append("estimated_date")
                date = unit.get("date") or event.get("date") or ""
                # Rows with no company are one meeting's only within one kind of meeting: a CIAIC
                # council meeting and a workshop on the same day are two meetings.
                meeting_key = f"{date}|{company_id or core_key(raw_name) or 'event:' + (event.get('series') or event.get('type') or file_id)}"
                seen_options: set[str] = set()
                options = [o for o in options if not (o["id"] in seen_options or seen_options.add(o["id"]))]
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
                    "meeting_key": meeting_key, "review": sorted(set(review)), "company_options": options,
                    "_unit": unit["key"], "_file": file_id,
                    # Worked out again from the path, not the "source" stored when the file was read: files
                    # read before the web-link fix stored "https:".
                    "source_folder": source_folder(entry.get("path", ""), entry.get("name", "")),
                    "source_folders": [source_folder(entry.get("path", ""), entry.get("name", ""))],
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
    for r in insights:
        r.pop("_unit", None)
        r.pop("_file", None)
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
