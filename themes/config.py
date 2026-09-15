"""Settings, all from the environment so nothing secret lives in the repo.

Box login (OAuth 2.0, standard "Log in with Box") happens once, interactively, in the
control panel — see public/admin.html and src/worker.js. The Worker holds the Box app's
client credentials and keeps the resulting token pair in Workers KV; the admin also picks
the upload folder and the tracker file there. This package never talks to Box's OAuth
directly: it calls the Worker's own relay endpoint, GET /api/box/pipeline-token,
authenticated by a shared secret (BOX_RELAY_SECRET) rather than a login, since a GitHub
Actions run has no browser to sign in with.
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Where the published file lands. The Worker serves everything in public/ as static
# assets, so writing here and committing is what makes an analysis run go live.
PUBLIC_DIR = ROOT / "public"
COUNCIL_THEMES_JSON = PUBLIC_DIR / "council-themes.json"
QUANT_DASHBOARD_JSON = PUBLIC_DIR / "quant-dashboard.json"

# The Worker relay. Both are set as GitHub repository secrets; the URL is just the
# Worker's own address with the relay path on the end.
BOX_RELAY_URL = os.environ.get("BOX_RELAY_URL", "").strip()
BOX_RELAY_SECRET = os.environ.get("BOX_RELAY_SECRET", "").strip()

# Read directly by themes/claude_client.py — see SETUP.md.
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
