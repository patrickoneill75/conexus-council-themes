"""Settings, all from the environment so nothing secret lives in the repo.

Box login (OAuth 2.0, standard "Log in with Box") happens once, interactively, in the
control panel — see public/admin.html and src/worker.js. The Worker holds the Box app's
client credentials and keeps the resulting token pair in Workers KV; the admin also picks
the source folder there. This package never talks to Box's OAuth directly: it calls the
Worker's own relay endpoint, GET /api/box/pipeline-token, authenticated by a shared
secret (BOX_RELAY_SECRET) rather than a login, since a GitHub Actions run has no browser
to sign in with.
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Where the published file lands. The Worker serves everything in public/ as static
# assets, so writing here and committing is what makes a refresh go live.
PUBLIC_DIR = ROOT / "public"
THEMES_JSON = PUBLIC_DIR / "themes.json"

# The Worker relay. Both are set as GitHub repository secrets; the URL is just the
# Worker's own address with the relay path on the end.
BOX_RELAY_URL = os.environ.get("BOX_RELAY_URL", "").strip()
BOX_RELAY_SECRET = os.environ.get("BOX_RELAY_SECRET", "").strip()

# 2026-Q2-Central.docx -> the Q2 2026 Central Council meeting. The council name is
# whatever sits after the second hyphen, so adding a council needs no code change.
FILENAME_PATTERN = r"^(\d{4})-(Q[1-4])-(.+)$"

# How a meeting is labelled on the page. Kept here rather than in the page so the
# wording is decided once, in the same place the filename is interpreted.
def meeting_title(year: str, quarter: str, council: str) -> str:
    return f"{council} Council — {quarter} {year}"
