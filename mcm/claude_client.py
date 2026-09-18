"""Anthropic access. Structured output via a forced tool call, plus prompt caching."""
from __future__ import annotations
import os
import threading

import anthropic
from pydantic import BaseModel

_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
if not _key:
    raise SystemExit("ANTHROPIC_API_KEY is not set. Add it as a repository secret.")

client = anthropic.Anthropic(api_key=_key)

# Rough running total so the workflow log ends with what the run actually cost in tokens.
# Both analyze and narrative steps call structured() from a thread pool, so updates need
# a lock — plain += on a shared dict is not atomic across threads.
USAGE = {"input_tokens": 0, "output_tokens": 0, "cache_read_tokens": 0, "calls": 0}
_usage_lock = threading.Lock()


def structured(model: str, system_text: str, user_text: str,
               response_model: type[BaseModel], max_tokens: int = 3000,
               cache_system: bool = True):
    """Claude has no `responses.parse`, so force one tool call whose schema is the model.

    `cache_control` on the system block means the long, identical instructions across
    hundreds of per-filing calls are billed once per batch instead of once per filing.
    """
    tool_name = "return_" + response_model.__name__.lower()
    system_blocks = [{
        "type": "text",
        "text": system_text,
        **({"cache_control": {"type": "ephemeral"}} if cache_system else {}),
    }]
    response = client.messages.create(
        model=model,
        max_tokens=max_tokens,
        system=system_blocks,
        messages=[{"role": "user", "content": user_text}],
        tools=[{
            "name": tool_name,
            "description": f"Return the result as {response_model.__name__}.",
            "input_schema": response_model.model_json_schema(),
            # Without this, a forced tool call is still just a strong hint: nothing stops
            # Claude from writing a value outside a Literal's allowed set (e.g. "Neutral"
            # for a Headwind/Tailwind/Mixed field), which then fails pydantic validation
            # downstream. strict=True constrains generation to the schema itself, so an
            # invalid value can't be produced in the first place. Requires every model
            # passed here to set model_config = ConfigDict(extra="forbid") -- see
            # mcm.signals.EconomicSignal / FilingSignals and mcm.narrative.NarrativeSection.
            "strict": True,
        }],
        tool_choice={"type": "tool", "name": tool_name},
    )
    usage = getattr(response, "usage", None)
    if usage is not None:
        with _usage_lock:
            USAGE["calls"] += 1
            USAGE["input_tokens"] += getattr(usage, "input_tokens", 0) or 0
            USAGE["output_tokens"] += getattr(usage, "output_tokens", 0) or 0
            USAGE["cache_read_tokens"] += getattr(usage, "cache_read_input_tokens", 0) or 0
    for block in response.content:
        if block.type == "tool_use" and block.name == tool_name:
            return response_model.model_validate(block.input)
    raise RuntimeError("Claude did not return the expected structured tool call.")


def usage_summary() -> str:
    return (f"{USAGE['calls']} Claude calls · {USAGE['input_tokens']:,} input tokens "
            f"({USAGE['cache_read_tokens']:,} served from cache) · "
            f"{USAGE['output_tokens']:,} output tokens")
