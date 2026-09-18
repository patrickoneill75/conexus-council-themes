"""Stage A: classify each filing's extracted paragraphs into headwind/tailwind signals."""
from __future__ import annotations
from typing import Literal

from pydantic import BaseModel, ConfigDict

from . import config
from .claude_client import structured

CategoryLiteral = Literal[
    "Demand & Orders", "Customer / End-Market Conditions", "Tariffs & Trade",
    "Pricing Power", "Input Costs & Raw Materials", "Labor & Workforce",
    "Supply Chain & Logistics", "Inventories & Destocking", "Interest Rates & Financing",
    "Capital Investment", "Energy & Utilities", "Regulation & Policy",
    "FX & Global Markets", "Capacity & Utilization", "Technology & Automation",
    "Productivity", "Other Economic Condition",
]


class EconomicSignal(BaseModel):
    # extra="forbid" is what makes model_json_schema() emit additionalProperties: false,
    # which strict tool use (see mcm.claude_client.structured) requires at every object
    # level in the schema.
    model_config = ConfigDict(extra="forbid")

    category: CategoryLiteral
    topic: str
    direction: Literal["Headwind", "Tailwind", "Mixed"]
    # A Literal (-> JSON schema "enum") rather than int + ge/le: strict tool use rejects
    # "minimum"/"maximum" on an integer-typed property ("For 'integer' type, properties
    # maximum, minimum are not supported"). An explicit enum of the five valid values is
    # the pattern Anthropic's own strict-tool-use docs use for a bounded integer.
    intensity: Literal[1, 2, 3, 4, 5]
    scope: Literal["Economy-wide", "Manufacturing-wide", "Industry-specific", "Company-specific"]
    timeframe: Literal["Current", "Near-term outlook", "Longer-term outlook"]
    summary: str
    evidence_quote: str
    # No ge/le here either -- confidence is continuous, so there's no enum equivalent.
    # Clamped defensively in analyze_filing() below instead of relying on the schema.
    confidence: float
    source_paragraph_id: str


class FilingSignals(BaseModel):
    model_config = ConfigDict(extra="forbid")
    signals: list[EconomicSignal]


SYSTEM = f"""
You are building a manufacturing-conditions indicator from SEC disclosures.
You will receive a JSON array of paragraphs from ONE manufacturer's filing, already
filtered to those containing economic-condition keywords.
The audience is manufacturing owners, CEOs, operators, and plant managers.

RULES
1. Extract only external or sector conditions: demand, orders, end markets, tariffs,
   pricing, input costs, labor, supply chains, inventories, rates, capex, energy,
   regulation, FX, capacity, automation, productivity.
2. Do NOT treat the company's own revenue or profit movement as a macro signal unless
   management explicitly ties it to an external condition.
3. Direction is from the manufacturer's perspective: Headwind worsens operating
   conditions, Tailwind improves them, Mixed is genuinely offsetting.
4. Intensity: 1 = passing mention, 3 = material condition, 5 = dominant/acute.
5. timeframe must be "Near-term outlook" or "Longer-term outlook" when the paragraph is
   about what management expects rather than what already happened. This drives the
   forward-looking analysis downstream, so be accurate about it.
6. evidence_quote must be verbatim from the paragraph, 35 words or fewer. Never invent one.
7. source_paragraph_id must be copied exactly from the paragraph you used.
8. Return at most {config.MAX_SIGNALS_PER_FILING} distinct, strongest signals. No duplicates.
9. Return an empty list if the filing contains no useful economic signal.
"""


def analyze_filing(filing: dict, paragraphs: list[dict]) -> list[dict]:
    payload = [
        {"source_paragraph_id": p["paragraph_id"], "section": p["section"],
         "forward_looking": p.get("forward_looking", "0") == "1", "text": p["paragraph_text"]}
        for p in paragraphs
    ]
    user_text = (
        f"Company: {filing['company']} ({filing['ticker']})\n"
        f"SIC {filing['sic']} — {filing['sic2_title']}"
        f"{' · headquartered in ' + filing['state'] if filing.get('state') else ''}\n"
        f"Filing: {filing['form']} for the period ending {filing['report_date']}\n\n"
        f"PARAGRAPHS (JSON):\n{__import__('json').dumps(payload, ensure_ascii=False)}\n"
    )
    parsed = structured(config.EXTRACTION_MODEL, SYSTEM, user_text, FilingSignals, max_tokens=3000)
    rows = []
    for index, signal in enumerate(parsed.signals[:config.MAX_SIGNALS_PER_FILING]):
        rows.append({
            "signal_id": f"{filing['accession']}_{index}",
            "accession": filing["accession"], "cik": filing["cik"],
            "company": filing["company"], "ticker": filing["ticker"],
            "sic2": filing["sic2"], "state": filing.get("state", ""),
            "period": filing["period"], "report_date": filing["report_date"],
            "form": filing["form"], "category": signal.category,
            "topic": signal.topic[:120], "direction": signal.direction,
            "intensity": str(int(signal.intensity)), "scope": signal.scope,
            "timeframe": signal.timeframe, "summary": signal.summary[:900],
            "evidence_quote": signal.evidence_quote[:500],
            "confidence": f"{max(0.0, min(1.0, float(signal.confidence))):.3f}",
            "url": filing["url"], "source_paragraph_id": signal.source_paragraph_id,
        })
    return rows
