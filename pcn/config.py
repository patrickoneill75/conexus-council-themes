"""Settings for the PCN Issue Map pipeline, all from the environment -- same shape as
consensus/config.py and themes/config.py.

Deliberately reuses the Council Survey Dashboard's own ANTHROPIC_API_KEY rather than
provisioning a separate key for this app (unlike Consensus, which has its own
CONSENSUS_CLAUDE_API_KEY): extraction runs at Haiku-first, cents-per-meeting volume,
which doesn't warrant a dedicated key and its own repository-secret setup step.
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# The Worker relay -- same shared-secret mechanism (x-pipeline-key: BOX_RELAY_SECRET)
# themes/box_store.py and consensus/relay.py already use, targeting this app's own
# GET /api/pcn/relay/config route (src/pcn.js) rather than the Council-specific
# /api/box/pipeline-token, since that route's response shape is hardwired to fields
# (data_folder_id, tracker_file_id) this app doesn't have. Same repository secrets as
# every other pipeline here; nothing PCN-specific to add.
BOX_RELAY_URL = os.environ.get("BOX_RELAY_URL", "").strip()
BOX_RELAY_SECRET = os.environ.get("BOX_RELAY_SECRET", "").strip()

# Read directly by pcn/pipeline/extract -- reused from the Council Survey Dashboard,
# see this module's docstring.
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()

# Haiku by default for extraction (cost target: cents per meeting); a code-driven gate
# (two-pass disagreement on a segment, or repeated extraction failure) escalates just
# that segment to Sonnet as a tie-breaker -- see pcn/pipeline/extract/run.py.
HAIKU_MODEL = "claude-haiku-4-5-20251001"
SONNET_MODEL = "claude-sonnet-5"
