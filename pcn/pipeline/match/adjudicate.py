"""Stage 4 of the matching cascade: residual adjudication by Haiku, shown only the 5
nearest candidates (with their definitions) rather than the full issue list -- this
keeps the prompt small regardless of how large the issue list grows. Reached only
when the embedding stage's similarity falls in the ambiguous middle band (neither
confidently the same issue nor confidently a new one) -- see cascade.py.
"""
from __future__ import annotations

from ... import config
from ..extract import client as extract_client
from ..models import Issue

_NEW_ISSUE = "NEW"


def _tool(candidate_ids: list[str]) -> dict:
    return {
        "name": "resolve_issue",
        "description": (
            "Decide whether a newly extracted issue label refers to one of the listed "
            "existing candidate issues, or is genuinely a new issue."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "chosen_issue_id": {
                    "type": "string",
                    "enum": candidate_ids + [_NEW_ISSUE],
                    "description": (
                        f"One of the candidate issue ids if the label refers to the same "
                        f"underlying issue (favor the more general label per "
                        f"pcn/CODING_PROTOCOL.md rule 2), or {_NEW_ISSUE!r} if none of them do."
                    ),
                },
            },
            "required": ["chosen_issue_id"],
            "additionalProperties": False,
        },
        "strict": True,
    }


def adjudicate(label: str, candidates: list[tuple[Issue, float]]) -> str | None:
    """candidates: (Issue, embedding_similarity) pairs, nearest first. Returns the
    chosen Issue id, or None if the label is a new issue."""
    candidate_ids = [issue.id for issue, _ in candidates]
    lines = [
        f"- id {issue.id}: \"{issue.canonical_label}\""
        + (f" -- {issue.definition}" if issue.definition else " (no definition written yet)")
        for issue, _ in candidates
    ]
    system = (
        "You resolve issue labels for a causal map of manufacturing executives' business "
        "problems. A new label was extracted from a meeting; decide whether it refers to "
        "one of the candidate issues below (already in the map) or is genuinely new. "
        "Favor matching an existing candidate over creating a near-duplicate -- but do not "
        "force a match that isn't real; a genuinely new issue should be marked new."
    )
    user = f"New label: \"{label}\"\n\nCandidates (nearest first):\n" + "\n".join(lines)

    result = extract_client.get_client().messages.create(
        model=config.HAIKU_MODEL,
        max_tokens=200,
        system=system,
        messages=[{"role": "user", "content": user}],
        tools=[_tool(candidate_ids)],
        tool_choice={"type": "tool", "name": "resolve_issue"},
    )
    for block in result.content:
        if block.type == "tool_use":
            chosen = block.input.get("chosen_issue_id")
            return None if chosen == _NEW_ISSUE else chosen
    raise RuntimeError(f"Claude did not call resolve_issue (stop_reason={result.stop_reason!r})")
