#!/usr/bin/env python3
"""Read the council meeting documents from Box and write public/themes.json.

Triggered from the control panel (Refresh and publish), or by hand from the Actions tab.
The workflow commits the result; the Worker serves it as a static asset.
"""
from __future__ import annotations

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from themes import box_store, config, extract  # noqa: E402

NAME_RE = re.compile(config.FILENAME_PATTERN, re.IGNORECASE)


def main() -> int:
    if not box_store.enabled():
        print("ERROR: BOX_RELAY_URL and BOX_RELAY_SECRET are not set as repository "
              "secrets, so there is no way to reach Box. See SETUP.md.", file=sys.stderr)
        return 1

    try:
        files = box_store.list_documents()
        folder = box_store.folder_id()
    except box_store.NotConnected as exc:
        print(f"ERROR: {exc}\n"
              "Open the control panel, click 'Log in with Box', and choose a folder.",
              file=sys.stderr)
        return 1

    print(f"Folder {folder} holds {len(files)} file(s).")

    documents: list[dict] = []
    skipped: list[dict] = []

    for entry in files:
        name = entry.get("name", "")
        if name.startswith("~$"):
            continue                              # Word's own lock files, not a document
        if not name.lower().endswith(".docx"):
            skipped.append({"name": name, "reason": "not a .docx file"})
            continue

        match = NAME_RE.match(os.path.splitext(name)[0].strip())
        if not match:
            skipped.append({"name": name,
                            "reason": "name is not Year-Quarter-Council, e.g. 2026-Q2-Central"})
            continue

        year, quarter = match.group(1), match.group(2).upper()
        council = match.group(3).strip() or "All"

        try:
            sections = extract.sections(box_store.download(entry["id"]))
        except Exception as exc:                  # noqa: BLE001 - reported, not raised
            skipped.append({"name": name, "reason": str(exc)[:200]})
            print(f"  ! {name} - {exc}")
            continue

        documents.append({
            "year": year,
            "quarter": quarter,
            "region": council,
            "title": config.meeting_title(year, quarter, council),
            "sourceFile": name,
            "modified": entry.get("modified_at"),
            "sections": sections,
        })
        titled = len([s for s in sections if s.get("title")])
        print(f"  ok {name:<30} {titled} heading(s), {extract.count_bullets(sections)} bullet(s)")

    if not documents:
        # Publishing an empty file would take the dashboard down over what is almost
        # always a naming mistake. Leave the last good version in place instead.
        print("\nERROR: no documents matched the naming convention, so nothing was "
              "written. themes.json has been left exactly as it was.", file=sys.stderr)
        for item in skipped:
            print(f"  skipped {item['name']} ({item['reason']})", file=sys.stderr)
        return 1

    documents.sort(key=lambda d: (d["year"], d["quarter"], d["region"]), reverse=True)

    payload = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": {"folderId": folder, "documentCount": len(documents)},
        "documents": documents,
        "skipped": skipped,
    }

    config.THEMES_JSON.parent.mkdir(parents=True, exist_ok=True)
    with open(config.THEMES_JSON, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

    print(f"\nWrote {config.THEMES_JSON.name} - {len(documents)} meeting(s), "
          f"{len(skipped)} skipped.")
    for item in skipped:
        print(f"  skipped {item['name']} ({item['reason']})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
