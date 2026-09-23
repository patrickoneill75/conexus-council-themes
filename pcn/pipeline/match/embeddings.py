"""Embedding step of the matching cascade -- lazy-loaded so importing this package
doesn't require sentence-transformers (and the torch install it pulls in) unless the
cascade actually reaches this stage. A small, fast general-purpose model is enough:
this is a nearest-neighbor lookup over a few hundred issue labels at most, not a
retrieval system at scale.
"""
from __future__ import annotations

import math

_MODEL_NAME = "all-MiniLM-L6-v2"
_model = None


def _get_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(_MODEL_NAME)
    return _model


def embed(text: str) -> list[float]:
    return _get_model().encode(text, normalize_embeddings=True).tolist()


def cosine_similarity(a: list[float], b: list[float]) -> float:
    # Vectors of different lengths are not comparable. zip() would silently truncate to
    # the shorter one and return a confident-looking score computed from a prefix --
    # which is exactly what would happen to an Issue whose stored embedding predates a
    # change of _MODEL_NAME. 0.0 sends it down the cascade's "treat as a new issue"
    # branch, the conservative outcome, instead of a wrong match.
    if len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=True))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(y * y for y in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)
