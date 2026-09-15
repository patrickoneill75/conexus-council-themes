"""The two Claude API calls this pipeline makes.

Both use a single forced tool call with a strict schema (see the Anthropic docs on
structured outputs) rather than asking for free text and hoping it parses as JSON.
Volume here is a few dozen survey rows and a few hundred tracker rows at most per
run — nowhere near enough for model choice or prompt caching to matter for cost.
"""
from __future__ import annotations

import anthropic

from . import config

MODEL = "claude-opus-5"

_client = None


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
    return _client


def _tool_call(system: str, user: str, tool: dict) -> dict:
    response = _get_client().messages.create(
        model=MODEL,
        max_tokens=16000,
        system=system,
        messages=[{"role": "user", "content": user}],
        tools=[tool],
        tool_choice={"type": "tool", "name": tool["name"]},
    )
    for block in response.content:
        if block.type == "tool_use":
            return block.input
    raise RuntimeError(f"Claude did not call {tool['name']!r} (stop_reason={response.stop_reason!r})")


def extract_feedback_items(survey_rows: list[dict], taxonomy: dict[str, list[str]]) -> list[dict]:
    """Raw survey responses -> [{category, subcategory, text}, ...]."""
    taxonomy_text = "\n".join(
        f"- {cat}: {', '.join(subs) if subs else '(no subcategories yet)'}"
        for cat, subs in taxonomy.items()
    )
    survey_text = "\n\n".join(
        f"Response {i + 1}:\n" + "\n".join(f"  {q}: {a}" for q, a in row.items())
        for i, row in enumerate(survey_rows)
    )
    tool = {
        "name": "record_feedback_items",
        "description": "Record each distinct 'area to improve' feedback item found in the survey.",
        "input_schema": {
            "type": "object",
            "properties": {
                "items": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "category": {"type": "string"},
                            "subcategory": {"type": "string"},
                            "text": {"type": "string"},
                        },
                        "required": ["category", "subcategory", "text"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["items"],
            "additionalProperties": False,
        },
        "strict": True,
    }
    system = (
        "You read post-meeting survey responses for a manufacturing council and pull out "
        "genuine 'areas to improve' feedback: constructive criticism and suggestions, not "
        "praise. Each item is one specific, actionable point, quoted close to verbatim from "
        "the response — light cleanup for grammar is fine, but don't paraphrase away the "
        "substance and don't invent anything not actually said. Skip blank, praise-only, or "
        "purely factual answers (and skip rating-scale numbers entirely; they aren't "
        "feedback text).\n\n"
        "Assign each item the closest-fitting Category and Subcategory from this existing "
        "list — reuse an existing pair whenever it reasonably fits, even if imperfectly. "
        "Only write a new Subcategory (under one of the existing Categories) if nothing "
        "listed fits at all, and do this rarely: the tracker's value comes from reusing the "
        "same labels across quarters.\n\n" + taxonomy_text
    )
    result = _tool_call(system, survey_text, tool)
    return result.get("items", [])


_THEME_LIST_SCHEMA = {
    "type": "array",
    # No maxItems: Claude's tool input_schema validation rejects it ("property
    # 'maxItems' is not supported" — a real, confirmed API 400, not a documentation
    # gap). The system prompt instructs "cap every list at 5" instead, backed up by
    # the defensive [:5] slice in synthesize_themes() below.
    "items": {
        "type": "object",
        "properties": {
            "category": {"type": "string"},
            "subcategory": {"type": "string"},
            "summary": {"type": "string", "description": "Short plain-English theme label."},
            "example": {"type": "string", "description": "One representative quote."},
            "count": {"type": "integer", "description": "How many source items support this theme."},
        },
        "required": ["category", "subcategory", "summary", "example", "count"],
        "additionalProperties": False,
    },
}


def _format_items(items: list[dict]) -> str:
    lines = []
    for it in items:
        category = it.get("category") or it.get("Category") or ""
        subcategory = it.get("subcategory") or it.get("Subcategory") or ""
        text = it.get("text") or it.get("Feedback Item (verbatim)") or ""
        lines.append(f"- [{category} / {subcategory}] {text}")
    return "\n".join(lines) if lines else "(none)"


def synthesize_themes(current_items: list[dict], prev_quarter_items: list[dict],
                       trailing_year_items: list[dict]) -> dict:
    """This quarter's own items, plus the historical comparison pools, -> capped-at-5
    {current, qoq, yoy} theme lists."""
    tool = {
        "name": "record_theme_analysis",
        "description": "Record this quarter's top issues, and which recurred QoQ / YoY.",
        "input_schema": {
            "type": "object",
            "properties": {"current": _THEME_LIST_SCHEMA, "qoq": _THEME_LIST_SCHEMA, "yoy": _THEME_LIST_SCHEMA},
            "required": ["current", "qoq", "yoy"],
            "additionalProperties": False,
        },
        "strict": True,
    }
    system = (
        "You synthesize council-meeting survey feedback into themes for a dashboard. Given "
        "raw 'areas to improve' items, each already tagged with a Category/Subcategory, "
        "group related items into a small number of clear themes — never just list items "
        "one-for-one. For each theme write a short plain-English summary, one representative "
        "example quote (lightly trimmed, not fabricated), and how many source items support "
        "it. Cap every list at 5 themes, most important/most-supported first. An empty list "
        "is a correct answer when nothing qualifies — don't pad to reach 5.\n\n"
        "'current': this quarter's own top issues, from \"This quarter's items\" below.\n"
        "'qoq': of this quarter's themes, which also showed up in \"Previous quarter's "
        "items\" (pooled across every region that met that quarter) — issues that persisted "
        "quarter over quarter.\n"
        "'yoy': of this quarter's themes, which also showed up in \"Trailing year's items\" "
        "(pooled across every region over roughly the last four quarters) — issues "
        "recurring over the last year."
    )
    user = (
        f"This quarter's items:\n{_format_items(current_items)}\n\n"
        f"Previous quarter's items (any region):\n{_format_items(prev_quarter_items)}\n\n"
        f"Trailing year's items (any region):\n{_format_items(trailing_year_items)}"
    )
    result = _tool_call(system, user, tool)
    return {
        "current": (result.get("current") or [])[:5],
        "qoq": (result.get("qoq") or [])[:5],
        "yoy": (result.get("yoy") or [])[:5],
    }
