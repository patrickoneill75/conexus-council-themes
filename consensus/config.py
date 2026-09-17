"""Settings for the Consensus mini app, all from the environment -- same shape as
themes/config.py. This package reuses themes.box_store and themes.sheet_io directly
(both are already generic, not Council-specific) rather than duplicating them; it
keeps its own config module because its published output and its own Claude key are
its own concern, not the Council Survey Dashboard's.
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Where a run's published analysis lands -- one file per survey, matching how
# public/council-themes.json and public/quant-dashboard.json are published: a static
# asset in the repo, committed by the workflow, read directly by results.html.
PUBLIC_DIR = ROOT / "public"
RESULTS_DIR = PUBLIC_DIR / "consensus-results"


def results_json(survey_id: str) -> Path:
    return RESULTS_DIR / f"{survey_id}.json"


# The Worker relay, same mechanism themes/box_store.py already uses for a Box access
# token (GET /api/box/pipeline-token, shared-secret auth) -- see consensus/relay.py.
# Same repository secrets as the Council app; nothing Consensus-specific to add here.
BOX_RELAY_URL = os.environ.get("BOX_RELAY_URL", "").strip()
BOX_RELAY_SECRET = os.environ.get("BOX_RELAY_SECRET", "").strip()

# This mini app's own Claude key -- deliberately separate from the Council Survey
# Dashboard's ANTHROPIC_API_KEY (repository secret name: consensus_claude_api; mapped
# to this env var name in .github/workflows/consensus_analyze.yml).
CONSENSUS_CLAUDE_API_KEY = os.environ.get("CONSENSUS_CLAUDE_API_KEY", "").strip()
