#!/usr/bin/env python3
"""Rebuild the quant dashboard from whatever's currently in Box -- no new survey
upload needed.

Triggered from the control panel's "Refresh Dashboard" button, for when a file in the
Data Folder changed directly in Box (edited or deleted) rather than through an upload
here.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from themes import box_store, quant_publish  # noqa: E402


def main() -> int:
    if not box_store.enabled():
        print("ERROR: BOX_RELAY_URL and BOX_RELAY_SECRET are not set as repository "
              "secrets, so there is no way to reach Box. See SETUP.md.", file=sys.stderr)
        return 1

    quant_publish.refresh()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
