"""The single Claude API call extraction makes -- same forced-tool-call pattern as
themes/claude_client.py, retried with tenacity like every other network call in this
repo's Python pipelines. A retry that still fails after all attempts is what
pcn/pipeline/extract/run.py treats as a "repeated schema-validation failure" for the
Sonnet-escalation gate.
"""
from __future__ import annotations

import anthropic
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from ... import config
from .schema import ASSERTION_TOOL

_client = None

_retry = retry(
    retry=retry_if_exception_type((anthropic.APIError, RuntimeError)),
    wait=wait_exponential(multiplier=1, min=2, max=20),
    stop=stop_after_attempt(3),
    reraise=True,
)


def get_client() -> anthropic.Anthropic:
    """Shared Anthropic client, reused by pcn/pipeline/match/adjudicate.py too --
    same API key, no reason for a second client instance."""
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
    return _client


@_retry
def extract(system: str, user: str, model: str) -> list[dict]:
    # No explicit temperature: the installed anthropic SDK's Messages.create() no
    # longer exposes it as a request parameter at all (verified against the
    # installed package -- passing it raises TypeError, which is what broke every
    # extraction call and left the ledger empty). Sampling is still non-deterministic
    # by default without it, which is all run.py's two-pass agreement check actually
    # needs -- see its docstring; it never required temperature to be *tunable*, just
    # nonzero, and "unset" already satisfies that here.
    response = get_client().messages.create(
        model=model,
        max_tokens=8000,
        system=system,
        messages=[{"role": "user", "content": user}],
        tools=[ASSERTION_TOOL],
        tool_choice={"type": "tool", "name": ASSERTION_TOOL["name"]},
    )
    for block in response.content:
        if block.type == "tool_use":
            return block.input.get("assertions", [])
    raise RuntimeError(f"Claude did not call {ASSERTION_TOOL['name']!r} (stop_reason={response.stop_reason!r})")
