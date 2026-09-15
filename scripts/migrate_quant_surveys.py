#!/usr/bin/env python3
"""ONE-OFF: copy every survey file out of the (old) Quant Data Folder into the New
Survey Directory, now that quant reads its survey files from there instead.

Leaves the Quant Data Folder's two reference files (Council Meeting Helper.csv,
Content Categories.xlsx) and everything already in the New Survey Directory alone;
copies rather than moves, so the originals stay put and this is safe to re-run. This
script and its workflow are meant to be deleted once the migration is confirmed done.
"""
from __future__ import annotations

import sys
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from themes import box_store, quant_data  # noqa: E402


def main() -> int:
    if not box_store.enabled():
        print("ERROR: BOX_RELAY_URL and BOX_RELAY_SECRET are not set.", file=sys.stderr)
        return 1

    quant_folder_id = box_store.quant_folder_id()
    upload_folder_id = box_store.upload_folder_id()
    if not quant_folder_id:
        print("ERROR: No Quant Data Folder is selected — nothing to migrate.", file=sys.stderr)
        return 1
    if not upload_folder_id:
        print("ERROR: No New Survey Directory is selected.", file=sys.stderr)
        return 1

    print(f"Listing the Quant Data Folder ({quant_folder_id})...")
    quant_files = box_store.list_folder(quant_folder_id)
    skip = {quant_data.HELPER_FILENAME, quant_data.CATEGORIES_FILENAME}
    to_copy = [f for f in quant_files if f["name"] not in skip]
    print(f"  {len(quant_files)} file(s) total, {len(to_copy)} survey file(s) to copy "
          f"(skipping {', '.join(sorted(skip))}).")

    print(f"Listing the New Survey Directory ({upload_folder_id}) to avoid duplicates...")
    existing_names = {f["name"] for f in box_store.list_folder(upload_folder_id)}

    copied, skipped_existing = [], []
    for f in to_copy:
        if f["name"] in existing_names:
            skipped_existing.append(f["name"])
            continue
        response = requests.post(
            f"{box_store.API}/files/{f['id']}/copy",
            headers=box_store._headers(),
            json={"parent": {"id": upload_folder_id}},
            timeout=30,
        )
        response.raise_for_status()
        copied.append(f["name"])
        print(f"  copied {f['name']}")

    print(f"\nDone. Copied {len(copied)} file(s): {', '.join(copied) or '(none)'}")
    if skipped_existing:
        print(f"Skipped {len(skipped_existing)} already present in the New Survey "
              f"Directory: {', '.join(skipped_existing)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
