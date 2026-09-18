"""Deterministic HTML -> paragraph rows. No LLM is involved in this step.

Locating "Item 7. Management's Discussion and Analysis" is reliable pattern matching,
not a judgment call, so it costs nothing and is fully reproducible. The output is a
flat table with one row per economically relevant paragraph — the thing a human can
open in Excel and the only thing Claude is ever shown.
"""
from __future__ import annotations
import re

import lxml.html

from . import config

# Tags that end a line of text. Needed because lxml's text_content() concatenates without
# separators, which would run every paragraph together and defeat paragraph splitting.
BLOCK_TAGS = {
    "p", "div", "br", "tr", "td", "th", "li", "ul", "ol", "table", "tbody", "thead",
    "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "header", "footer",
    "blockquote", "pre", "hr", "figure", "figcaption", "dd", "dt", "dl",
}


class NonManufacturingDataError(RuntimeError):
    """Raised when rows outside SIC 2000-3999 reach a stage that must be manufacturing-only."""


def assert_manufacturing_only(df, stage: str, log=print):
    """Hard gate. Called before extraction and again before any Claude call.

    Point 3 of the spec: narrow to manufacturing BEFORE the analysis happens. Rather
    than trusting that discovery filtered correctly, this re-checks the actual rows and
    stops the run if anything slipped through, so a bad row can never reach a paid call.
    """
    if df.empty:
        log(f"  [gate] {stage}: 0 rows, nothing to check")
        return df
    sic = df["sic"].astype(str).str.extract(r"(\d+)")[0]
    numeric = sic.astype(float)
    ok = numeric.between(config.MANUFACTURING_SIC_MIN, config.MANUFACTURING_SIC_MAX)
    bad = df[~ok.fillna(False)]
    if len(bad):
        examples = ", ".join(
            f"{r.company} (SIC {r.sic})" for r in bad.head(5).itertuples()
        )
        raise NonManufacturingDataError(
            f"{stage}: {len(bad)} of {len(df)} rows are outside SIC "
            f"{config.MANUFACTURING_SIC_MIN}-{config.MANUFACTURING_SIC_MAX}. Examples: {examples}"
        )
    log(f"  [gate] {stage}: all {len(df)} rows confirmed manufacturing "
        f"(SIC {config.MANUFACTURING_SIC_MIN}-{config.MANUFACTURING_SIC_MAX})")
    return df


def html_to_text(content: bytes) -> str:
    """Flatten a filing to plain text.

    Uses lxml directly rather than BeautifulSoup. Real 10-Qs run to several megabytes,
    mostly financial tables we discard, and building a BeautifulSoup tree over all of that
    measured 10-20x slower than lxml's own text extraction — the difference between a
    first backfill taking most of a day and taking an afternoon.
    """
    if not content:
        return ""
    try:
        root = lxml.html.fromstring(content)
    except Exception:
        return ""
    for element in root.xpath("//script|//style|//noscript"):
        parent = element.getparent()
        if parent is not None:
            parent.remove(element)
    # text_content() has no separators, so give every block element a trailing newline;
    # otherwise adjacent paragraphs merge into one and paragraph splitting fails.
    for element in root.iter():
        if isinstance(element.tag, str) and element.tag.lower() in BLOCK_TAGS:
            element.tail = "\n" + (element.tail or "")
    text = root.text_content().replace("\xa0", " ")
    text = re.sub(r"[ \t]+", " ", text)
    return re.sub(r"\n\s*\n\s*\n+", "\n\n", text).strip()


def _best_section(text, start_patterns, end_patterns):
    starts = []
    for pattern in start_patterns:
        starts.extend(m.start() for m in re.finditer(pattern, text, flags=re.I | re.S))
    if not starts:
        return ""
    candidates = []
    for start in sorted(set(starts)):
        ends = []
        for pattern in end_patterns:
            match = re.search(pattern, text[start + 100:], flags=re.I | re.S)
            if match:
                ends.append(start + 100 + match.start())
        end = min(ends) if ends else min(len(text), start + 180_000)
        candidate = text[start:end].strip()
        if len(candidate) >= 600:
            candidates.append(candidate)
    return max(candidates, key=len) if candidates else ""


def sections_for_form(form: str, raw_text: str) -> dict:
    if form == "10-K":
        return {
            "MD&A": _best_section(
                raw_text,
                [r"ITEM\s+7\.?\s+MANAGEMENT[’'`S\s]+DISCUSSION\s+AND\s+ANALYSIS"],
                [r"ITEM\s+7A\.?", r"ITEM\s+8\.?\s+FINANCIAL"]),
            "Risk Factors": _best_section(
                raw_text, [r"ITEM\s+1A\.?\s+RISK\s+FACTORS"],
                [r"ITEM\s+1B\.?", r"ITEM\s+1C\.?", r"ITEM\s+2\."]),
        }
    if form == "10-Q":
        return {
            "MD&A": _best_section(
                raw_text,
                [r"ITEM\s+2\.?\s+MANAGEMENT[’'`S\s]+DISCUSSION\s+AND\s+ANALYSIS"],
                [r"ITEM\s+3\.?", r"ITEM\s+4\."]),
            "Risk Factors": _best_section(
                raw_text, [r"ITEM\s+1A\.?\s+RISK\s+FACTORS"],
                [r"ITEM\s+1B\.?", r"ITEM\s+2\."]),
        }
    return {"Earnings Release": raw_text[:180_000]}


def _keyword_paragraphs(section_text, cap):
    paragraphs = [p.strip() for p in re.split(r"\n{2,}", section_text) if p.strip()]
    if len(paragraphs) < 5:
        paragraphs = [p.strip() for p in section_text.split("\n") if len(p.strip()) > 40]
    rows = []
    for index, paragraph in enumerate(paragraphs):
        if len(paragraph) < 40:
            continue
        lowered = paragraph.lower()
        matched = sorted({k for k in config.ECONOMIC_KEYWORDS if k in lowered})
        if not matched:
            continue
        forward = sorted({k for k in config.FORWARD_LOOKING_KEYWORDS if k in lowered})
        rows.append({
            "paragraph_index": index,
            "paragraph_text": paragraph[:2000],
            "matched_keywords": ", ".join(matched),
            # Flagged here so the "Looking Ahead" section can be built from language
            # that is genuinely about the future, not from the whole filing.
            "forward_looking": "1" if forward else "0",
        })
    rows.sort(key=lambda r: r["matched_keywords"].count(",") , reverse=True)
    return rows[:cap]


def extract_filing(filing: dict, raw_bytes: bytes) -> list[dict]:
    raw_text = html_to_text(raw_bytes)
    rows = []
    for section_name, section_text in sections_for_form(filing["form"], raw_text).items():
        if not section_text:
            continue
        for row in _keyword_paragraphs(section_text, config.MAX_PARAGRAPHS_PER_FILING):
            row["section"] = section_name
            rows.append(row)
    if not rows and raw_text:
        for row in _keyword_paragraphs(raw_text, config.MAX_PARAGRAPHS_PER_FILING):
            row["section"] = "Full Document (no Item headers matched)"
            rows.append(row)
    for row in rows:
        row["accession"] = filing["accession"]
        row["period"] = filing["period"]
        row["paragraph_id"] = f"{filing['accession']}_{row['section'][:3]}_{row['paragraph_index']}"
        row["char_count"] = str(len(row["paragraph_text"]))
    return rows
