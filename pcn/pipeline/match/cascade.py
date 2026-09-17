"""The four-stage issue-resolution cascade: exact normalized-alias match -> rapidfuzz
fuzzy match -> embedding nearest-neighbor -> residual Haiku adjudication. Every branch
returns which stage resolved it, so the thresholds below can be tuned against real
data later rather than guessed at blindly.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

from rapidfuzz import fuzz

from ..models import Issue
from . import embeddings
from .adjudicate import adjudicate

FUZZY_THRESHOLD = 92
EMBEDDING_AUTO_ACCEPT = 0.92
EMBEDDING_AUTO_REJECT = 0.55
ADJUDICATION_CANDIDATE_COUNT = 5


@dataclass
class ResolveResult:
    issue_id: str | None  # None means "create a new issue"
    method: str  # "exact" | "fuzzy" | "embedding" | "adjudicated" | "new"
    matched_label: str | None = None  # which existing label it matched, for alias-recording


def normalize_label(label: str) -> str:
    return re.sub(r"\s+", " ", label.strip().lower())


def _labels(issue: Issue) -> list[str]:
    return [issue.canonical_label, *issue.aliases]


def resolve_issue(label: str, issues: list[Issue]) -> ResolveResult:
    if not issues:
        return ResolveResult(issue_id=None, method="new")

    normalized = normalize_label(label)

    # Stage 1: exact normalized-alias match.
    for issue in issues:
        if any(normalize_label(existing) == normalized for existing in _labels(issue)):
            return ResolveResult(issue_id=issue.id, method="exact", matched_label=label)

    # Stage 2: rapidfuzz fuzzy match.
    best_issue, best_score, best_label = None, -1.0, None
    for issue in issues:
        for existing in _labels(issue):
            score = fuzz.WRatio(normalized, normalize_label(existing))
            if score > best_score:
                best_issue, best_score, best_label = issue, score, existing
    if best_issue is not None and best_score >= FUZZY_THRESHOLD:
        return ResolveResult(issue_id=best_issue.id, method="fuzzy", matched_label=label)

    # Stage 3: embedding nearest-neighbor.
    label_vec = embeddings.embed(label)
    scored: list[tuple[Issue, float]] = []
    for issue in issues:
        issue_vec = issue.embedding if issue.embedding is not None else embeddings.embed(issue.canonical_label)
        scored.append((issue, embeddings.cosine_similarity(label_vec, issue_vec)))
    scored.sort(key=lambda pair: pair[1], reverse=True)
    nearest_issue, nearest_score = scored[0]

    if nearest_score >= EMBEDDING_AUTO_ACCEPT:
        return ResolveResult(issue_id=nearest_issue.id, method="embedding", matched_label=label)
    if nearest_score < EMBEDDING_AUTO_REJECT:
        return ResolveResult(issue_id=None, method="new")

    # Stage 4: residual Haiku adjudication over the 5 nearest candidates only.
    candidates = scored[:ADJUDICATION_CANDIDATE_COUNT]
    chosen_id = adjudicate(label, candidates)
    if chosen_id is None:
        return ResolveResult(issue_id=None, method="new")
    return ResolveResult(issue_id=chosen_id, method="adjudicated", matched_label=label)
