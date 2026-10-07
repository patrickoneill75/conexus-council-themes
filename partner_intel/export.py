"""The files written to the Box database folder after each scan.

  partner_intel_database.json   everything the tool serves (insights, events, topics)
  partner_intel_insights.csv    the same insights as a flat table, for Excel
  partner_intel_state.json      which files were read and every stored Claude result. If the
                                Worker's copy is ever lost, the next scan restores from this
                                file instead of paying to read the notes again.
"""
from __future__ import annotations

import csv
import io
import json

from .roster import Roster

DATABASE_FILE = "partner_intel_database.json"
INSIGHTS_FILE = "partner_intel_insights.csv"
STATE_FILE = "partner_intel_state.json"
FILES = (DATABASE_FILE, INSIGHTS_FILE, STATE_FILE)

COLUMNS = ["InsightID", "Date", "DateSource", "SourceFolder", "EventType", "Series", "Company",
           "MemberStatus", "Industry", "Type", "Topic", "Title", "Detail", "Quote", "Urgency",
           "UrgencyReason", "Status", "Addresses", "Tags", "Confidence", "Speaker", "Scope",
           "SourceFiles", "ReviewFlags"]

MEMBER_LABEL = {"Active": "Member", "Inactive": "Former member", "Non-member": "Not a member"}


def _safe(value) -> str:
    """Spreadsheets run a cell that starts with = + - @ as a formula. Notes are untrusted."""
    text = str(value if value is not None else "")
    return "'" + text if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


def insights_csv(dataset: dict, roster: Roster) -> str:
    partners = roster.by_id()
    topics = {t["id"]: t["label"] for t in dataset.get("topics", [])}
    notes = {c["id"]: c for c in dataset.get("companies", [])}
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\r\n")
    writer.writerow(COLUMNS)
    for i in dataset["insights"]:
        partner = partners.get(i["company_id"])
        name = partner["name"] if partner else (notes.get(i["company_id"], {}).get("name") or i["company_raw"] or "Unattributed")
        status = MEMBER_LABEL.get(partner["status"], partner["status"]) if partner else "Not on the partner list"
        writer.writerow([_safe(v) for v in [
            i["id"], i["date"], i["date_source"], ", ".join(i.get("source_folders") or [i.get("source_folder", "")]),
            i["event_type"], i["series"], name, status, (partner or {}).get("industry") or "Unknown",
            i["kind"], topics.get(i["topic"], i["topic"]), i["title"], i["detail"], i["quote"], i["urgency"],
            i["urgency_reason"], i["status"], i["solves"], "; ".join(i["tags"]), i["confidence"], i["speaker"],
            i["scope"], "; ".join(sorted({s["name"] for s in i["sources"]})), "; ".join(i["review"]),
        ]])
    return "﻿" + out.getvalue()  # the BOM makes Excel read accents correctly


def database_json(dataset: dict) -> str:
    return json.dumps(dataset, ensure_ascii=False, separators=(",", ":"))


def state_json(registry: dict, cache: dict, saved_at: str) -> str:
    return json.dumps({"version": 1, "saved_at": saved_at, "registry": registry, "cache": cache},
                      ensure_ascii=False, separators=(",", ":"))
