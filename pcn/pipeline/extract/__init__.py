"""Assertion extraction: turns a NormalizedDocument into Assertions, per
pcn/CODING_PROTOCOL.md and the design doc's two-pass-plus-escalation reliability
design -- see run.py for the algorithm.
"""
from __future__ import annotations

from .run import extract_document

__all__ = ["extract_document"]
