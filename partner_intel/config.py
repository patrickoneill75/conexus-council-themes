"""Environment for the Partner Intelligence pipeline. Names follow the other pipelines:
the relay pair is shared with every Box-backed tool, and the Claude key is this tool's own.
"""
from __future__ import annotations

import os

BOX_RELAY_URL = os.environ.get("BOX_RELAY_URL", "")
BOX_RELAY_SECRET = os.environ.get("BOX_RELAY_SECRET", "")
CLAUDE_API_KEY = os.environ.get("PARTNER_INTEL_CLAUDE_API_KEY", "")

# Reading notes runs on Claude Sonnet 5.5 (CLAUDE.md: the Sonnet/Haiku split). Override to test
# another model, or to run the comparison against one (PI_MODE=compare).
MODEL = os.environ.get("PARTNER_INTEL_MODEL", "claude-sonnet-5-5")

# Units larger than this are split before they reach the model. About 6,000 tokens of notes.
MAX_UNIT_WORDS = 4500
CHUNK_OVERLAP_WORDS = 120

# Parallel Claude calls. Each is independent and cached, so this only affects wall time.
WORKERS = int(os.environ.get("PARTNER_INTEL_WORKERS", "4"))

# Files bigger than this are reported and skipped rather than loaded into the runner.
MAX_FILE_BYTES = 40 * 1024 * 1024

# Read new notes through the Message Batches API: half the price of direct calls, in exchange
# for minutes of waiting, which a scan can afford. Set to "false" to read directly.
USE_BATCH = os.environ.get("PARTNER_INTEL_BATCH", "true").lower() != "false"
# How long a scan waits for its batch before reading the remainder directly.
BATCH_WAIT_MINUTES = float(os.environ.get("PARTNER_INTEL_BATCH_WAIT_MINUTES") or 60)
