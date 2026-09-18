"""System/user prompts for extraction -- a direct translation of
pcn/CODING_PROTOCOL.md's five rules (see that file's own docstring: a change there
should be followed by a matching change here, not the other way around). Transcript
and notes get separate system-prompt variants because rule 5's hazard (inventing a
causal link between adjacent-but-unrelated items) is specific to notes' bullet-list
structure -- a transcript's speaker turns don't invite the same failure mode.
"""
from __future__ import annotations

from ..models import NormalizedDocument

_SHARED_RULES = """\
You read {source_description} from a manufacturing executive peer group meeting and \
extract causal assertions of the form "X affects Y" -- statements about how one \
business issue influences another.

Rule 1 -- what counts as an issue: an issue has to be something that can meaningfully \
increase or decrease. "Labor availability," "overtime hours," "voluntary turnover," \
"input material costs" qualify. Proper nouns, department names, and static objects do \
not -- "Indiana," "the second shift," "our ERP system" are not issues; if a policy or \
static thing is mentioned, extract the *variable* it actually affects instead \
(e.g. "tariff exposure," not "the tariff policy"). The same rule rules out compound \
cause-and-effect phrases as a single label: "AI's impact on the workforce" is not \
itself a variable, it's a whole causal relationship folded into one noun phrase. When \
a statement takes that shape, extract the two variables it actually names and record \
the link between them the normal way -- from_issue="AI adoption", \
to_issue="headcount needs", not a single issue called "AI's impact on workforce." If \
the same speaker also ties AI to something else (e.g. quality), that is a second \
assertion reusing the SAME from_issue ("AI adoption") with a different to_issue \
("quality oversight workload") -- not a second, differently-worded "AI" node. Reusing \
the same atomic cause across assertions is what lets the map show one thing touching \
several others, instead of every mention of it becoming its own disconnected node.

Rule 2 -- default level of abstraction: default to the more general label (e.g. \
"skilled trades shortage") unless the speaker is drawing a genuinely different \
connection for a more specific case. When in doubt, extract at the specific level the \
speaker actually used -- a later matching step folds it into a general issue if one \
already exists; it is much cheaper to merge later than to un-split a premature \
collapse.

Rule 3 -- hypotheticals and secondhand reports: code them, tagged by modality, rather \
than dropping them. "hypothetical" for a conditional belief ("if X rises, Y will \
follow") that is not a report of something happening. "reported" for a secondhand \
account, attributed to the speaker who reported it, not to whoever they're describing. \
"asserted" (the default) for a direct first-person claim about something actually \
happening.

Rule 4 -- negations: code a negation with a weight near zero (e.g. 0.05, signed per \
the implied direction) and modality "negated" -- never skip it. "Automation has not \
reduced our headcount" is real evidence that a link is absent, which is different from \
no assertion existing at all, and must be recorded as such.

Rule 5 -- skip rather than invent, the single most important rule: if the text does \
not reasonably support a causal connection between two things, skip the pair entirely. \
Do not extract a low-confidence guess to fill a gap.{extra_rule_5}

Every segment below is numbered "[N]"{segment_context_note}. Reference the source \
segment's number in segment_index for every assertion you record. Quote the \
supporting text closely (light cleanup for grammar is fine; don't paraphrase away the \
substance and don't invent anything not actually said).\
"""

_TRANSCRIPT_EXTRA_RULE_5 = ""

_NOTES_EXTRA_RULE_5 = (
    " This applies with special force here: bullets sitting next to each other in a "
    "notes document look like a sequence and will tempt you into inventing a causal "
    "link between adjacent-but-unrelated items. Adjacency is not evidence -- two "
    "bullets under the same heading, or one after another, are not thereby causally "
    "connected unless the text itself actually says so."
)


def build_system_prompt(input_type: str) -> str:
    if input_type == "transcript":
        return _SHARED_RULES.format(
            source_description="a meeting transcript",
            extra_rule_5=_TRANSCRIPT_EXTRA_RULE_5,
            segment_context_note=" and attributed to a speaker",
        )
    if input_type == "notes":
        return _SHARED_RULES.format(
            source_description="a set of meeting notes",
            extra_rule_5=_NOTES_EXTRA_RULE_5,
            segment_context_note=", with the heading(s) it falls under shown for context "
                                  "only -- not as evidence of a causal link to its siblings",
        )
    raise ValueError(f"Unknown input_type {input_type!r}")


def build_user_message(doc: NormalizedDocument) -> str:
    lines = []
    for segment in doc.segments:
        if doc.input_type == "transcript":
            speaker = segment.speaker or "(unattributed)"
            lines.append(f"[{segment.index}] ({speaker}) {segment.text}")
        else:
            context = " > ".join(segment.heading_path) if segment.heading_path else "(no heading)"
            lines.append(f"[{segment.index}] ({context}) {segment.text}")
    return "\n".join(lines)
