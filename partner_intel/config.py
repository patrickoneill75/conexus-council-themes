"""Environment for the Partner Intelligence pipeline. Names follow the other pipelines:
the relay pair is shared with every Box-backed tool, and the Claude key is this tool's own.
"""
from __future__ import annotations

import os

BOX_RELAY_URL = os.environ.get("BOX_RELAY_URL", "")
BOX_RELAY_SECRET = os.environ.get("BOX_RELAY_SECRET", "")
CLAUDE_API_KEY = os.environ.get("PARTNER_INTEL_CLAUDE_API_KEY", "")

# claude-opus-5 is the standing default (CLAUDE.md). Override only to test.
MODEL = os.environ.get("PARTNER_INTEL_MODEL", "claude-opus-5")

# Units larger than this are split before they reach the model. About 6,000 tokens of notes.
MAX_UNIT_WORDS = 4500
CHUNK_OVERLAP_WORDS = 120

# Parallel Claude calls. Each is independent and cached, so this only affects wall time.
WORKERS = int(os.environ.get("PARTNER_INTEL_WORKERS", "4"))

# Files bigger than this are reported and skipped rather than loaded into the runner.
MAX_FILE_BYTES = 40 * 1024 * 1024
