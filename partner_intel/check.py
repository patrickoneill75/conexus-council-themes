"""A read-only check of the published data for two known weak spots, written to Box as a CSV.

    python -m partner_intel.check

1. Running documents. A Copilot recap file holds many meetings. Each section the scan cut from
   it is listed with its heading, date, size and the companies its rows name, so a section that
   holds several meetings (no heading, several companies) can be seen.
2. One meeting, two files. The build treats the same company on the same date as one meeting
   and merges what two files say about it. When the two files were dated differently (an
   estimated date on one of them, say), the same statement is counted twice. Each pair of files
   with statements that would have merged, had their dates agreed, is listed.

No Box notes are read and no model is called: the check reads the saved state and the partner
list through the relay, joins them the way build.py does, and saves
partner_intel_duplicate_check.csv to the database folder. The repository is public and so are
its Actions logs, so the log gets counts only, never a company, file or note.
"""
from __future__ import annotations

import csv
import io
import sys
from collections import defaultdict
from datetime import date, datetime, timezone

from . import build, export
from .relay import Api
from .roster import Roster

CHECK_FILE = "partner_intel_duplicate_check.csv"
COLUMNS = ["Check", "Company", "FileA", "DateA", "DateSourceA", "FileB", "DateB", "DateSourceB",
           "DaysApart", "Count", "Detail", "LinkA", "LinkB"]
RUNNING = "Running document section"
TWO_FILES = "Same statements, different dates"
MERGED = "Same meeting, merged"


def _file_label(entry: dict) -> str:
    path = (entry.get("path") or "").strip("/")
    return f"{path}/{entry.get('name', '')}" if path else entry.get("name", "")


def _days(a: str, b: str):
    try:
        return abs((date.fromisoformat(a) - date.fromisoformat(b)).days)
    except ValueError:
        return ""


def running_sections(registry: dict, cache: dict) -> list[dict]:
    """One row per section of every Copilot recap file."""
    out = []
    for file_id, entry in registry.items():
        if (entry.get("event") or {}).get("shape") != "copilot_recap":
            continue
        for unit in entry.get("units") or []:
            cached = cache.get(unit.get("key")) or {}
            rows = cached.get("rows") or []
            named = sorted({" ".join(str(r.get("company") or "").split()) for r in rows} - {""}, key=str.lower)
            part = f" (part {unit.get('part')} of {unit.get('parts')})" if (unit.get("parts") or 1) > 1 else ""
            out.append({
                "Check": RUNNING, "Company": (unit.get("label") or "(no heading)") + part,
                "FileA": _file_label(entry), "DateA": unit.get("date", ""), "DateSourceA": unit.get("date_source", ""),
                "Count": len(named),
                "Detail": f"{cached.get('words', '?')} words; {len(rows)} statements; companies named: {', '.join(named) or 'none'}"
                          + ("" if cached else "; not read yet"),
                "LinkA": export.box_link(file_id),
            })
    return out


def two_file_pairs(dataset: dict, registry: dict, partner_names: dict) -> list[dict]:
    """Pairs of files whose statements about one company would have merged had their dates agreed,
    and, for comparison, pairs the build did merge."""
    by_company: dict[str, list[dict]] = defaultdict(list)
    for insight in dataset["insights"]:
        if insight.get("company_id") and insight.get("scope") != "internal":
            by_company[insight["company_id"]].append(insight)
    names = {**partner_names, **{c["id"]: c["name"] for c in dataset.get("companies", [])}}

    pairs: dict[tuple, dict] = {}

    def pair(cid, fa, fb, check):
        a, b = sorted((fa, fb))
        return pairs.setdefault((check, cid, a, b), {"count": 0, "titles": []})

    for cid, insights in by_company.items():
        for i in insights:
            files = sorted({s["id"] for s in i["sources"]})
            for x in range(len(files)):
                for y in range(x + 1, len(files)):
                    pair(cid, files[x], files[y], MERGED)["count"] += 1
        for x in range(len(insights)):
            a = insights[x]
            for y in range(x + 1, len(insights)):
                b = insights[y]
                if a["date"] == b["date"] or a["kind"] != b["kind"]:
                    continue
                fa, fb = {s["id"] for s in a["sources"]}, {s["id"] for s in b["sources"]}
                if fa & fb:
                    continue  # one file says it twice, on two dates: a running file's own business
                # The build's own test of "the same statement", across two files.
                if build._similarity({**a, "_unit": "a", "_file": "a"}, {**b, "_unit": "b", "_file": "b"}) <= 0:
                    continue
                for f1 in fa:
                    for f2 in fb:
                        got = pair(cid, f1, f2, TWO_FILES)
                        got["count"] += 1
                        if len(got["titles"]) < 3:
                            got["titles"].append(f"{a['title']} / {b['title']}")

    out = []
    for (check, cid, fa, fb), got in pairs.items():
        ea, eb = registry.get(fa) or {}, registry.get(fb) or {}
        da, db = (ea.get("event") or {}), (eb.get("event") or {})
        out.append({
            "Check": check, "Company": names.get(cid, cid),
            "FileA": _file_label(ea) or fa, "DateA": da.get("date", ""), "DateSourceA": da.get("date_source", ""),
            "FileB": _file_label(eb) or fb, "DateB": db.get("date", ""), "DateSourceB": db.get("date_source", ""),
            "DaysApart": _days(da.get("date", ""), db.get("date", "")), "Count": got["count"],
            "Detail": "; ".join(got["titles"]), "LinkA": export.box_link(fa), "LinkB": export.box_link(fb),
        })
    out.sort(key=lambda r: (r["Check"] != TWO_FILES, -r["Count"], r["Company"].lower()))
    return out


def to_csv(rows: list[dict]) -> str:
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\r\n")
    writer.writerow(COLUMNS)
    for r in rows:
        writer.writerow([export._safe(r.get(c, "")) for c in COLUMNS])
    return "﻿" + out.getvalue()


def check(registry: dict, cache: dict, roster: Roster, now: str) -> tuple[list[dict], dict]:
    dataset = build.build_dataset(registry, cache, roster, now)
    running = running_sections(registry, cache)
    pairs = two_file_pairs(dataset, registry, {p["id"]: p["name"] for p in roster.partners})
    counts = {
        "files": len(registry), "insights": len(dataset["insights"]),
        "running_sections": len(running),
        "running_sections_without_heading": sum(1 for r in running if r["Company"].startswith("(no heading)")),
        "running_sections_naming_3_or_more_companies": sum(1 for r in running if r["Count"] >= 3),
        "file_pairs_same_statements_different_dates": sum(1 for r in pairs if r["Check"] == TWO_FILES),
        "statements_counted_twice": sum(r["Count"] for r in pairs if r["Check"] == TWO_FILES),
        "file_pairs_merged": sum(1 for r in pairs if r["Check"] == MERGED),
    }
    return running + pairs, counts


def main(api=None) -> int:
    api = api or Api()
    state = api.get_state()
    registry, cache = state.get("registry") or {}, state.get("cache") or {}
    if not registry:
        restored = export.read_state(api.load_from_box(export.STATE_FILE), api.load_from_box)
        if restored:
            registry, cache = restored
    if not registry:
        print("No saved state to check. Run a scan first.", file=sys.stderr)
        return 1
    roster = Roster.from_payload(api.roster())
    rows, counts = check(registry, cache, roster, datetime.now(timezone.utc).isoformat(timespec="seconds"))
    api.save_to_box(CHECK_FILE, to_csv(rows))
    # Counts only: this log is public.
    print({**counts, "saved": CHECK_FILE})
    return 0


if __name__ == "__main__":
    sys.exit(main())
