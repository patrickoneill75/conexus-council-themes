#!/usr/bin/env python3
"""Turn the credential/competency workbook into src/data/credentials.json.

Run this whenever credential_competency_matrix.xlsx changes:

    python3 scripts/build_credentials.py path/to/credential_competency_matrix.xlsx

The workbook is the authority for what each credential actually covers (modules, key
activities, weightings, performance indicators). This script reduces it to what the
Worker needs at request time, which is a much smaller thing: for each recommendable
credential, a weighted bag of terms that a job description's own wording can be scored
against, plus enough human-readable detail to justify a recommendation.

WHY A TERM VECTOR AND NOT THE WHOLE WORKBOOK. The Competency Matrix sheet is ~450 rows.
Handing all of it to Claude on every run would cost real tokens per session and produce
a worse answer than a short list does -- the toolkit's own guidance is to name one or
two credentials precisely, not to survey the field. So src/credentials.js scores every
credential here against the role deterministically (no API call), and only the top
handful ever reach the model, which then picks 1-5. See src/credentials.js.

SCORING WEIGHTS. A term's weight in a credential is its frequency there times an
inverse-document-frequency factor across all credentials. Without the IDF half,
"safety", "quality" and "process" appear in nearly every credential and every job
description, so MSSC CPT and the OSHA cards would win every single comparison
regardless of the role. IDF is what lets "lathe", "hydraulic" or "calibration" outrank
them when the duties actually call for those.

Three toolkit pathways have no workbook rows at all (Polymechanic/AMT, Registered
Apprenticeship, Indiana CTE completion). They are recommendable and are defined by hand
below, from the toolkit's own Credential & Pathway Reference wording, so the shortlist
covers everything the toolkit offers rather than only what the workbook happens to
document.
"""
from __future__ import annotations

import json
import math
import re
import sys
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path

from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "src" / "data" / "credentials.json"

# Terms carried by every manufacturing document, or by the workbook's own boilerplate.
# Dropping them here rather than relying on IDF alone keeps the stored vectors small.
STOPWORDS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into", "is",
    "it", "its", "of", "on", "or", "that", "the", "to", "with", "within", "up", "out",
    "other", "using", "use", "used", "uses", "including", "incl", "per", "via", "not",
    "all", "any", "each", "such", "than", "then", "this", "these", "those", "their",
    "there", "when", "where", "which", "while", "who", "will", "would", "can", "could",
    "may", "must", "should", "shall", "have", "has", "had", "do", "does", "done",
    "you", "your", "they", "them", "we", "our", "if", "but", "also", "more", "most",
    "one", "two", "three", "min", "hour", "hours", "minimum", "topics", "topic",
    "level", "credential", "credentials", "module", "modules", "activity", "activities",
    "least", "totaling", "trainer", "discretion", "select", "selects", "minutes",
    "time", "times", "total", "expanded", "coverage", "additional",
    "n", "na", "published", "sub", "breakdown", "applicable", "appropriate", "required",
    "requirements", "requirement", "perform", "performs", "performing", "performance",
    "identify", "identifies", "recognize", "recognizes", "explain", "explains",
    "define", "defines", "describe", "describes", "demonstrate", "demonstrates",
    "participate", "participates", "conduct", "conducts", "ensure", "ensures",
    "include", "includes", "work", "working", "workplace", "job", "role", "roles",
    "task", "tasks", "hrs", "choose", "elective", "optional",
}

# Short tokens worth keeping even though the length filter would drop them: these are
# the ones that actually discriminate between credentials.
KEEP_SHORT = {"cnc", "plc", "spc", "cmm", "ppe", "sds", "mes", "erp", "tpm", "5s",
              "lock", "arc", "mig", "tig", "gd&t", "hmi", "iot", "id", "od"}

TOKEN_RE = re.compile(r"[a-z0-9&]+")

# The OSHA cards' performance indicators are almost entirely SCHEDULING metadata --
# "Minimum time: >= 30 min (elective -- trainer must select at least 2 elective topics
# totaling at least 2 hours)." -- repeated on nearly every row. Tokenized as-is, "least",
# "time", "trainer", "totaling" and "select" became the highest-weighted terms in every
# OSHA vector, an order of magnitude above "lockout", "ppe" and "hazard", and the
# resulting noise buried OSHA below every NIMS machining card for every role. The real
# OSHA competency content is in the Key Activity column (the topic names); these
# patterns strip the administrative wrapper and keep whatever genuine content trails it
# ("Worker rights, employer responsibilities...", "e.g., noise, respiratory hazards").
_ADMIN_PATTERNS = [
    re.compile(r"minimum time:\s*[^.]*\.?", re.I),
    re.compile(r"\(elective[^)]*\)", re.I),
    re.compile(r"at the trainer's discretion[^.]*", re.I),
    re.compile(r"additional hazards/topics, or expanded coverage of [^.]*", re.I),
    re.compile(r"[\u2265>=]+\s*[\d.]+\s*(?:min|minutes|hour|hours)", re.I),
]


def clean_indicator(text: str) -> str:
    """A performance indicator with its scheduling boilerplate removed."""
    out = str(text or "")
    for pattern in _ADMIN_PATTERNS:
        out = pattern.sub(" ", out)
    return re.sub(r"\s+", " ", out).strip(" .-\u2014")


def tokenize(text: str) -> list[str]:
    """Lower-cased word tokens, minus stopwords and one/two-letter noise."""
    tokens = TOKEN_RE.findall(str(text or "").lower())
    return [t for t in tokens
            if t not in STOPWORDS and (len(t) > 3 or t in KEEP_SHORT)]


# ---------------------------------------------------------------------------- families
def family_of(name: str) -> str:
    if name.startswith("MSSC"):
        return "MSSC"
    if name.startswith("NIMS"):
        return "NIMS"
    if name.startswith("OSHA"):
        return "OSHA"
    return "Other"


def slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return re.sub(r"-+", "-", slug)[:60]


# What each family signals, in the toolkit's own Credential & Pathway Reference words.
# This is the sentence a recommendation is justified with, so it is quoted rather than
# paraphrased.
FAMILY_SIGNALS = {
    "MSSC": ("Foundational production competency across safety, quality practices, "
             "manufacturing processes, and maintenance awareness. A good baseline for "
             "entry-level roles; not a substitute for role-specific technical depth."),
    "NIMS": ("Verified hands-on precision capability in a defined area (measurement, "
             "materials and safety, turning, milling, or maintenance). Useful when you "
             "need to name a specific skill instead of a general \"machining "
             "background.\""),
    "OSHA": ("Baseline hazard recognition and safety literacy. Inexpensive and widely "
             "available, which makes it a reasonable \"preferred, or we provide it\" "
             "item rather than a screen."),
}

# The three toolkit pathways the workbook does not document. Terms come from the
# toolkit's own description of each, so they compete on the same footing as the
# workbook-backed entries rather than never surfacing.
HAND_AUTHORED = [
    {
        "id": "polymechanic-amt",
        "name": "Polymechanic / Advanced Manufacturing Technician",
        "family": "Pathway",
        "signals": ("Broad, multi-domain technician capability across mechanical, "
                    "electrical, controls, quality, and digital systems, validated "
                    "against employer-defined competencies rather than seat time. The "
                    "strongest single signal for a modern multi-skilled technician role."),
        "bestFor": ("A role that has converged several formerly separate jobs, or that "
                    "spans mechanical, electrical, controls and quality work at once."),
        "text": ("multi-skilled technician mechanical electrical controls automation "
                 "robotics quality digital systems troubleshooting diagnostics "
                 "preventive maintenance instrumentation sensors drives motors "
                 "programmable logic controllers cross-training convergence "
                 "employer-defined competencies polymechanic advanced manufacturing "
                 "technician mechatronics"),
    },
    {
        "id": "registered-apprenticeship",
        "name": "Registered Apprenticeship (INCAP or another sponsor)",
        "family": "Pathway",
        "signals": ("Structured on-the-job learning plus related technical instruction, "
                    "ending in a nationally recognized credential. The right answer "
                    "whenever a requirement is real but a candidate could reasonably "
                    "earn it while employed."),
        "bestFor": ("A requirement that is genuinely necessary but that a motivated "
                    "hire could earn on the job rather than arrive with."),
        "text": ("registered apprenticeship sponsor incap on-the-job learning related "
                 "technical instruction journeyworker work process schedule earn while "
                 "you learn nationally recognized progression wage schedule mentor "
                 "structured training"),
    },
    {
        "id": "indiana-cte-pathway",
        "name": "Indiana CTE pathway completion (advanced manufacturing, engineering, logistics)",
        "family": "Pathway",
        "signals": ("Secondary-level technical exposure with documented coursework and "
                    "often work-based learning hours. Signals readiness to learn "
                    "quickly, not job-ready mastery -- calibrate expectations "
                    "accordingly."),
        "bestFor": ("An entry-level opening where you are recruiting straight out of "
                    "high school and will train the technical depth yourself."),
        "text": ("indiana cte career technical education pathway completion secondary "
                 "high school advanced manufacturing engineering logistics work-based "
                 "learning coursework entry level readiness graduate diploma"),
    },
]


def build() -> dict:
    source = Path(sys.argv[1] if len(sys.argv) > 1 else "")
    if not source.exists():
        raise SystemExit(f"Usage: {sys.argv[0]} <credential_competency_matrix.xlsx>")

    workbook = load_workbook(source, data_only=True)
    matrix = [r for r in workbook["Competency Matrix"].iter_rows(values_only=True)][1:]
    summary = [r for r in workbook["Modules Summary"].iter_rows(values_only=True)][1:]
    courses = [r for r in workbook["Ivy Tech Credit Courses"].iter_rows(values_only=True)][1:]
    notes = {r[0]: r[1] for r in list(workbook["Data Notes"].iter_rows(values_only=True))[1:] if r[0]}

    # ---- workbook-backed credentials -------------------------------------------------
    raw_text: dict[str, list[str]] = defaultdict(list)
    modules: dict[str, dict[str, dict]] = defaultdict(dict)

    for row in matrix:
        credential, module, activity, weight, indicator = row[0], row[1], row[2], row[3], row[4]
        if not credential:
            continue
        # A placeholder activity carries no information; its performance indicator does.
        if activity and not str(activity).startswith("N/A"):
            raw_text[credential].append(str(activity))
        cleaned = clean_indicator(indicator)
        if cleaned:
            raw_text[credential].append(cleaned)
        if module:
            raw_text[credential].append(str(module))

    for row in summary:
        credential, module, activity, weight = row[0], row[1], row[2], row[3]
        if not credential or not module:
            continue
        entry = modules[credential].setdefault(module, {"name": module, "weight": 0.0,
                                                        "activities": []})
        entry["weight"] += float(weight or 0)
        if activity and not str(activity).startswith("N/A"):
            entry["activities"].append({"name": str(activity), "weight": float(weight or 0)})

    credentials = []
    for name in dict.fromkeys(r[0] for r in matrix if r[0]):
        family = family_of(name)
        module_list = list(modules.get(name, {}).values())
        for m in module_list:
            # Highest-weighted first, so the prompt shows what the credential is mostly
            # about when it has to be truncated.
            m["activities"].sort(key=lambda a: -a["weight"])
        credentials.append({
            "id": slugify(name),
            "name": name,
            "family": family,
            "signals": FAMILY_SIGNALS.get(family, ""),
            "note": notes.get(name, ""),
            "modules": [{"name": m["name"],
                         "activities": [a["name"] for a in m["activities"][:6]]}
                        for m in module_list],
            "_text": " ".join(raw_text[name]),
        })

    # ---- Ivy Tech: the recommendable unit is the PROGRAM AREA, not one course ---------
    # The toolkit is explicit: "Specify the program area and level; 'associate degree
    # preferred' with no field named screens broadly while signaling almost nothing."
    by_area: dict[str, list[dict]] = defaultdict(list)
    for row in courses:
        institution, code, title, area, description = row[0], row[1], row[2], row[3], row[4]
        if not institution or not area:
            continue
        by_area[area].append({"code": code, "title": title,
                              "description": (description or "").strip()})

    for area, area_courses in by_area.items():
        credentials.append({
            "id": slugify(f"ivy-tech-{area}"),
            "name": f"Ivy Tech certificate or degree — {area}",
            "family": "IvyTech",
            "signals": ("Postsecondary technical coursework in a named discipline. "
                        "Specify the program area and level; \"associate degree "
                        "preferred\" with no field named screens broadly while "
                        "signaling almost nothing."),
            "note": notes.get("Ivy Tech Community College — Credit Courses", ""),
            "modules": [{"name": area,
                         "activities": [f"{c['code']} {c['title']}" for c in area_courses[:8]]}],
            "courses": [{"code": c["code"], "title": c["title"]} for c in area_courses],
            "_text": " ".join(f"{c['code']} {c['title']} {c['description']}" for c in area_courses),
        })

    for entry in HAND_AUTHORED:
        credentials.append({**entry, "note": "", "modules": [], "_text": entry.pop("text")})

    # ---- term vectors: frequency x inverse document frequency -------------------------
    documents = {c["id"]: Counter(tokenize(c["_text"])) for c in credentials}
    appears_in = Counter()
    for counts in documents.values():
        appears_in.update(counts.keys())
    total = len(documents)

    for credential in credentials:
        counts = documents[credential["id"]]
        longest = max(counts.values()) if counts else 1
        scored = {}
        for term, count in counts.items():
            # Smoothed IDF, so a term in every credential contributes ~0 rather than a
            # negative number.
            idf = math.log((total + 1) / (appears_in[term] + 1)) + 1.0
            scored[term] = round((count / longest) * idf, 4)
        top = sorted(scored.items(), key=lambda kv: -kv[1])[:70]
        credential["terms"] = {t: w for t, w in top if w > 0}
        credential.pop("_text", None)

    credentials.sort(key=lambda c: (c["family"], c["name"]))
    return {
        "generatedAt": date.today().isoformat(),
        "source": source.name,
        "credentialCount": len(credentials),
        "credentials": credentials,
    }


if __name__ == "__main__":
    data = build()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(data, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {OUTPUT} -- {data['credentialCount']} recommendable credentials "
          f"({OUTPUT.stat().st_size // 1024} KB).")
