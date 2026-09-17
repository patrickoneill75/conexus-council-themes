"""The one Claude call the batch analysis makes: given every respondent's full
transcript for a single survey question (their initial answer plus any follow-up
Q&A), synthesize it into the exact shape results.html renders.

Model: Claude Sonnet 5, not Opus -- this is real synthesis work (grouping many
respondents' answers into a handful of genuine themes), not a simple extraction, so it
earns a stronger model than the live follow-up generator's Haiku 4.5. Sonnet is still
a fraction of Opus's cost per token, which is what "most cost effective" asks for here
without trading away the judgment this step actually needs. No prompt caching: each
question's respondent pool is different, so there's nothing stable to cache across
calls in a single run.

Like themes/claude_client.py, this uses a single forced tool call with a strict
schema instead of free text -- and, like that module, the schema has no `maxItems`
(Claude's tool input_schema validation rejects that keyword with a real 400, not a
documentation gap -- see themes/claude_client.py's own note). The "at most N, fewer if
that's genuinely all there is" limits are enforced by the system prompt, backed up by
a defensive slice in analyze_question() below.
"""
from __future__ import annotations

import anthropic

from . import config

MODEL = "claude-sonnet-5"

_client = None


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=config.CONSENSUS_CLAUDE_API_KEY)
    return _client


_THEME_SCHEMA = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "summary": {"type": "string",
                        "description": "One bold, plain-English sentence naming the theme."},
            "details": {
                "type": "array", "items": {"type": "string"},
                "description": "Up to 3 short sentences of specific supporting detail -- "
                                "add to the summary, don't restate it.",
            },
            "deepDive": {"type": "string",
                         "description": "Up to 5 sentences: nuance, tensions, or specific "
                                        "examples that didn't fit above, for a reader who "
                                        "expands this theme."},
        },
        "required": ["summary", "details", "deepDive"],
        "additionalProperties": False,
    },
}

_BULLET_SCHEMA = {"type": "array", "items": {"type": "string"}}


def _format_transcripts(threads: list[list[dict]]) -> str:
    """Each thread is one respondent's ordered [{prompt, answer}, ...] for this
    question (turn 0 = the question itself, turn 1+ = follow-ups)."""
    blocks = []
    for i, thread in enumerate(threads):
        lines = [f"  {'Question' if t == 0 else f'Follow-up {t}'}: {turn['prompt']}\n"
                 f"  Answer: {turn['answer']}" for t, turn in enumerate(thread)]
        blocks.append(f"Respondent {i + 1}:\n" + "\n".join(lines))
    return "\n\n".join(blocks) if blocks else "(no responses)"


def analyze_question(survey: dict, question: dict, threads: list[list[dict]]) -> dict:
    """-> {themes: [...], consensus: [...], needsMoreInfo: [...]}, each list capped per
    the limits below."""
    tool = {
        "name": "record_question_analysis",
        "description": "Record the theme analysis for one survey question.",
        "input_schema": {
            "type": "object",
            "properties": {
                "themes": _THEME_SCHEMA,
                "consensus": _BULLET_SCHEMA,
                "needsMoreInfo": _BULLET_SCHEMA,
            },
            "required": ["themes", "consensus", "needsMoreInfo"],
            "additionalProperties": False,
        },
        "strict": True,
    }
    system = (
        "You analyze every respondent's answer to one survey question -- including any "
        "follow-up Q&A that came from it -- and pull out the big themes for a results "
        "dashboard.\n\n"
        f"Survey objective: {survey.get('objective') or '(none given)'}\n"
        f"Audience: {survey.get('audience') or '(none given)'}\n"
        f"Question: {question.get('text', '')}\n"
        f"Author's guidance for this question: {question.get('context') or '(none given)'}\n\n"
        "Identify at most 3 themes, ranked most important / most-supported first. For "
        "each theme:\n"
        "  - summary: one bold-worthy sentence capturing the theme in a single clear line.\n"
        "  - details: at most 3 short sentences of specific supporting detail -- add to "
        "the summary, don't restate it.\n"
        "  - deepDive: at most 5 sentences going one level deeper -- nuance, tension "
        "between respondents, or specific examples that didn't fit above.\n\n"
        "Then, once for the whole question (not per theme), also record:\n"
        "  - consensus: at most 5 short bullets naming genuine areas of agreement across "
        "respondents.\n"
        "  - needsMoreInfo: at most 5 short bullets naming genuine open questions or gaps "
        "-- places the responses don't give enough to draw a conclusion.\n\n"
        "'At most' means exactly that, never a target. A shorter, tighter list beats a "
        "padded one -- if there are only 2 real themes, return 2; if there's only 1 "
        "genuine area of consensus, return 1. Never invent a theme, a detail sentence, or "
        "a bullet just to round out a count. Only include something that reflects a "
        "genuinely present, distinct point in the actual responses below."
    )
    user = f"Responses to this question ({len(threads)} respondent(s)):\n\n{_format_transcripts(threads)}"

    response = _get_client().messages.create(
        model=MODEL,
        max_tokens=4096,
        system=system,
        messages=[{"role": "user", "content": user}],
        tools=[tool],
        tool_choice={"type": "tool", "name": tool["name"]},
    )
    result = None
    for block in response.content:
        if block.type == "tool_use":
            result = block.input
            break
    if result is None:
        raise RuntimeError(
            f"Claude did not call {tool['name']!r} (stop_reason={response.stop_reason!r})"
        )

    themes = (result.get("themes") or [])[:3]
    for theme in themes:
        theme["details"] = (theme.get("details") or [])[:3]
    return {
        "themes": themes,
        "consensus": (result.get("consensus") or [])[:5],
        "needsMoreInfo": (result.get("needsMoreInfo") or [])[:5],
    }
