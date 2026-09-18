"""Stage B: the quarterly narrative — This Quarter, Looking Ahead, QoQ, YoY.

One narrative per cut (national, Indiana) per quarter, generated once and committed to
narratives.json. Because it is keyed by period + cut, a later run finds it already there
and spends nothing on a section that already succeeded — only a genuinely new quarter, or
a section a prior run couldn't get (see build_narrative's `existing` argument), costs
money.

Each section is a separate Claude call with its own evidence slice, rather than one call
asked to produce four things. That keeps each prompt focused on evidence that is actually
relevant to its question — the QoQ call never sees data it isn't comparing.
"""
from __future__ import annotations
import json

import pandas as pd
from pydantic import BaseModel, ConfigDict

from . import config
from .analytics import aggregate, top_evidence, movement_table
from .claude_client import structured
from .periods import previous_quarter, parse_label, label


class NarrativeSection(BaseModel):
    model_config = ConfigDict(extra="forbid")
    headline: str            # one sentence a reader could quote
    body: str                # 2-4 paragraphs of prose
    bullets: list[str]       # 3-5 concrete takeaways


SYSTEM = """
You write quarterly economic briefs on manufacturing conditions for owners, CEOs, plant
managers and economic-development staff. Your evidence is structured signals extracted
from SEC filings by manufacturers, plus counts computed from them.

STANDARDS
- Lead with what changed and what it means operationally. No throat-clearing.
- Use the counts you are given for any claim about prevalence; never invent a number,
  and never imply precision the counts do not support.
- Quote companies sparingly and only from the verbatim quotes supplied.
- Distinguish what companies REPORTED from what you INFER. Inference is allowed and
  useful; dressing it up as reported fact is not.
- A signal count is how often something was discussed, not its dollar magnitude. Do not
  describe it as a measure of economic size.
- If the evidence is thin or mixed, say so plainly instead of manufacturing a trend.
- Write in plain professional English. No jargon, no filler, no hedging every sentence.
"""

SECTION_BRIEFS = {
    "this_quarter": (
        "THIS QUARTER — What manufacturers actually reported about conditions during this "
        "quarter. Cover the dominant headwinds, the genuine tailwinds, and where the "
        "balance sits overall. Name the two or three topics that define the quarter."
    ),
    "looking_ahead": (
        "LOOKING AHEAD — What manufacturers say they EXPECT. Build this only from "
        "forward-looking signals (timeframe 'Near-term outlook' or 'Longer-term outlook'). "
        "Identify what management is bracing for, what they are planning to do about it, "
        "and where expectations differ from current conditions. Be explicit when companies "
        "expect conditions to diverge from what they just reported."
    ),
    "quarter_over_quarter": (
        "QUARTER OVER QUARTER — What changed versus the immediately preceding quarter. "
        "Focus on direction and momentum: which topics deteriorated, which improved, which "
        "held steady. Distinguish a real shift from normal noise, especially where the "
        "signal counts are small."
    ),
    "year_over_year": (
        "YEAR OVER YEAR — How conditions compare with the same quarter one year earlier. "
        "This is the structural view: which pressures have persisted for a full year, which "
        "have faded, and which are genuinely new. Say whether the year has been one of "
        "deterioration, recovery, or churn."
    ),
}


def _slice(signals: pd.DataFrame, period: str, state: str | None):
    if signals.empty:
        return signals
    out = signals[signals["period"] == period]
    if state:
        out = out[out["state"] == state]
    return out


def _counts_block(signals, period, state, cut_label):
    current = _slice(signals, period, state)
    agg = aggregate(current)
    return {
        "cut": cut_label,
        "period": period,
        "companies": agg["companies"],
        "signals": agg["total"],
        "headwind_signals": agg["head"],
        "tailwind_signals": agg["tail"],
        "mixed_signals": agg["mixed"],
        "signal_balance": round(agg["balance"], 3),
        "by_topic": agg["by_topic"],
    }


def build_section(section: str, period: str, cut: dict, signals: pd.DataFrame) -> dict:
    """Assemble the evidence for one section and ask Claude for that section only."""
    state = cut["state"]
    cut_label = cut["label"]
    current = _slice(signals, period, state)
    if current.empty:
        return None

    context: dict = {"section": section, "period": period,
                     "counts": _counts_block(signals, period, state, cut_label)}

    if section == "looking_ahead":
        forward = current[current["timeframe"].isin(["Near-term outlook", "Longer-term outlook"])]
        if forward.empty:
            return None
        context["forward_looking_signal_count"] = int(len(forward))
        context["evidence"] = top_evidence(forward, limit=28)
    elif section == "quarter_over_quarter":
        year, quarter = parse_label(period)
        prior = label(*previous_quarter(year, quarter))
        context["comparison_period"] = prior
        context["comparison_counts"] = _counts_block(signals, prior, state, cut_label)
        context["movement_by_topic"] = movement_table(
            _slice(signals, prior, state), current)
        context["evidence"] = top_evidence(current, limit=20)
    elif section == "year_over_year":
        year, quarter = parse_label(period)
        prior = label(year - 1, quarter)
        context["comparison_period"] = prior
        context["comparison_counts"] = _counts_block(signals, prior, state, cut_label)
        context["movement_by_topic"] = movement_table(
            _slice(signals, prior, state), current)
        context["evidence"] = top_evidence(current, limit=20)
    else:  # this_quarter
        context["evidence"] = top_evidence(current, limit=30)

    # A comparison section with no comparison period is not a section — say nothing
    # rather than inventing a trend from a single quarter.
    if section in ("quarter_over_quarter", "year_over_year"):
        if not context["comparison_counts"]["signals"]:
            return None

    user_text = (
        f"{SECTION_BRIEFS[section]}\n\n"
        f"CUT: {cut_label}\n"
        f"QUARTER: {period}\n\n"
        f"STRUCTURED CONTEXT (counts are authoritative; evidence quotes are verbatim):\n"
        f"{json.dumps(context, ensure_ascii=False, default=str)}\n\n"
        "Write the section now: a one-sentence headline, 2-4 paragraphs of body, and "
        "3-5 concrete bullets."
    )
    result = structured(config.NARRATIVE_MODEL, SYSTEM, user_text, NarrativeSection,
                        max_tokens=2400, cache_system=True)
    return {
        "headline": result.headline.strip(),
        "body": result.body.strip(),
        "bullets": [b.strip() for b in result.bullets if b.strip()][:5],
    }


def build_narrative(period: str, cut: dict, signals: pd.DataFrame, existing: dict | None = None,
                    log=print) -> dict | None:
    """Build (or fill in) the narrative for one cut.

    `existing` is the previously-saved narrative for this period+cut, if any — sections it
    already has are kept as-is rather than re-asked for, so a prior run that got 3 of 4
    sections (a transient failure, a rate limit, an out-of-schema response) only pays to
    retry the one that's missing, and never overwrites a section that already succeeded.
    """
    sections = dict((existing or {}).get("sections") or {})
    for section in config.NARRATIVE_SECTIONS:
        if section in sections:
            continue
        try:
            built = build_section(section, period, cut, signals)
        except Exception as exc:
            log(f"    ! {section} failed: {str(exc)[:200]}")
            built = None
        if built:
            sections[section] = built
            log(f"    wrote {section}")
        else:
            log(f"    skipped {section} (insufficient evidence)")
    if not sections:
        return None
    counts = _counts_block(signals, period, cut["state"], cut["label"])
    return {"period": period, "cut": cut["key"], "cut_label": cut["label"],
            "counts": counts, "sections": sections}
