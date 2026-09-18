# Issue Network Mapper: coding protocol

One page, five decisions, settled before any extraction prompt is drafted. Per
Carley (1993): the quality of a map is determined mostly by decisions made before
any coding begins, and leaving those decisions implicit is how two coders (or two
runs of the same model) produce incompatible maps from the same text. This document
*is* the coding protocol — `pcn/pipeline/extract`'s system prompt is a direct
translation of the five rules below, and any change to this file should be followed
by the corresponding prompt change, not the other way around.

## 1. What counts as an issue

An issue has to be something that can meaningfully **increase or decrease**.

- Qualifies: "labor availability," "overtime hours," "voluntary turnover," "input
  material costs," "on-time delivery rate."
- Does not qualify: "Indiana," "the second shift," "our ERP system," "the tariff
  policy" (the *policy itself* isn't a variable — "tariff-driven cost" or "tariff
  exposure" is; strip the noun down to the thing that actually moves).

This single rule prevents most of the junk nodes that make maps of this kind
unreadable — proper nouns, department names, and static objects are not issues.

The same rule also rules out **compound cause-and-effect phrases as a single
label** — "AI's impact on the workforce" is not itself a variable that increases or
decreases; it's already a whole causal relationship described in one noun phrase.
When a statement takes that shape, extract the two variables it names and record the
causal link between them the normal way, instead of writing the whole phrase into
one `from_issue`/`to_issue` field:

- "AI is changing how much oversight quality work needs" → `from_issue: "AI
  adoption"`, `to_issue: "quality oversight workload"` — **not** a single issue
  called "AI's impact on quality."
- If the same speaker also says AI affects staffing levels, that's a *second*
  assertion with the *same* `from_issue: "AI adoption"` and a *different*
  `to_issue`, e.g. `"headcount needs"` — not a second, unrelated "AI's impact on
  workforce" node. Reusing the same atomic cause across multiple assertions is what
  lets the map actually show that one thing (AI) touches several others (quality,
  staffing, ...), rather than each mention of AI becoming its own disconnected node.

## 2. Default level of abstraction

"Welder shortage," "machinist shortage," and "skilled trades shortage" are three
labels for what may be one issue or three. Pick the level deliberately and hold it
across the whole map, not per meeting:

- **Default to the more general label** ("skilled trades shortage") unless the
  distinction is doing real work in the conversation — i.e., unless members are
  drawing *different* connections for welders versus machinists specifically.
- When in doubt, extract at the specific level the speaker used, and let the
  matching cascade (`pcn/pipeline/match`) fold it into the general issue if one
  already exists close enough in the embedding space. It is much cheaper to merge
  two issues later than to split one that was prematurely collapsed.
- Discovering an inconsistency after twenty meetings is expensive — this is the
  single most valuable thing to get right early, and the reason the review queue's
  "created a new issue" bucket gets reviewed first (see the design doc, section 12).

## 3. Hypotheticals and secondhand reports

Code them — they are real information about how a member models the system — but
tag the `modality` field so the analyst can filter rather than having that decision
made silently at ingestion:

- `hypothetical`: "If tariffs rise, our costs will follow." A real belief about the
  system, not a report of something happening.
- `reported`: "Another member told me their turnover doubled after cutting
  overtime." Secondhand — attribute the belief to the speaker who reported it, not
  to the company they're describing.
- `asserted`: the default. A direct first-person claim about something that is
  actually happening.

## 4. Negations

Code a negation with a weight near zero (e.g. `0.05` in the direction implied),
**never skip it**. "Automation has not reduced our headcount" is an assertion that a
link is *absent* — that is a different, and just as real, piece of evidence as no
assertion existing at all. Tag it `modality: negated`. Losing this distinction is
exactly the failure mode section 6 of the design doc warns about: a null result and
a genuine absence of evidence must never render identically in the stored data.

## 5. Skip rather than invent

**This is the most important rule in the protocol.** If the text does not
reasonably support a causal connection between two things, skip the pair entirely —
do not extract a low-confidence guess to fill in a gap.

The specific hazard this guards against: bullets sitting next to each other in a
notes document look like a sequence to a language model and will reliably produce
invented causal links between adjacent-but-unrelated items. **Adjacency is not
evidence.** The notes extraction prompt variant carries this instruction explicitly
and separately from the transcript variant, because the failure mode is specific to
notes' bullet-list structure.

---

Everything above governs `pcn/pipeline/extract` (assertion extraction) directly.
Rule 2 also governs `pcn/pipeline/match` (issue resolution) indirectly, since the
default abstraction level is what the embedding/adjudication cascade is trying to
converge on when it decides whether two labels are "the same issue."
