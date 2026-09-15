#!/usr/bin/env python3
"""Rebuild public/quant-dashboard.json from scratch out of the Quant Data Folder.

Triggered from the control panel's "Update Dashboard" button — see update_quant.yml.
No inputs: every run lists the whole folder and recomputes everything it finds, so
there's nothing to pass in beyond Box credentials.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from themes import box_store, quant_data, quant_extract, quant_publish  # noqa: E402


def main() -> int:
    if not box_store.enabled():
        print("ERROR: BOX_RELAY_URL and BOX_RELAY_SECRET are not set as repository "
              "secrets, so there is no way to reach Box. See SETUP.md.", file=sys.stderr)
        return 1

    folder_id = box_store.quant_folder_id()
    if not folder_id:
        print("ERROR: No Quant Data Folder is selected yet — pick one on the control "
              "panel first.", file=sys.stderr)
        return 1

    print(f"Listing folder {folder_id}...")
    files = box_store.list_folder(folder_id)
    by_name = {f["name"]: f["id"] for f in files}
    print(f"  {len(files)} file(s) found.")

    helper_id = by_name.get(quant_data.HELPER_FILENAME)
    categories_id = by_name.get(quant_data.CATEGORIES_FILENAME)
    if not helper_id:
        print(f"ERROR: '{quant_data.HELPER_FILENAME}' not found in the Quant Data "
              "Folder.", file=sys.stderr)
        return 1
    if not categories_id:
        print(f"ERROR: '{quant_data.CATEGORIES_FILENAME}' not found in the Quant Data "
              "Folder.", file=sys.stderr)
        return 1

    print(f"Downloading {quant_data.HELPER_FILENAME}...")
    helper = quant_data.read_helper(box_store.download(helper_id))
    print(f"  {len(helper)} meeting(s) in the helper.")

    print(f"Downloading {quant_data.CATEGORIES_FILENAME}...")
    categories = quant_data.read_categories(box_store.download(categories_id))
    print(f"  {len(categories)} metric(s) mapped.")

    survey_names = [name for name in by_name
                     if name not in (quant_data.HELPER_FILENAME, quant_data.CATEGORIES_FILENAME)
                     and name.lower().endswith(".xlsx")]
    print(f"Found {len(survey_names)} survey file(s): {', '.join(survey_names) or '(none)'}")

    all_rows: list[dict] = []
    source_files: dict = {}
    for name in survey_names:
        print(f"  Reading {name}...")
        content = box_store.download(by_name[name])
        rows = quant_extract.unpivot(content)
        print(f"    {len(rows)} row(s).")
        all_rows.extend(rows)
        for row in rows:
            source_files[row["meeting_date"]] = name

    print("Building the dashboard...")
    data = quant_publish.build(all_rows, helper, categories, source_files)
    quant_publish.save(data)
    print(f"Published {len(data)} meeting(s) to {quant_publish.config.QUANT_DASHBOARD_JSON}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
