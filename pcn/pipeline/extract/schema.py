"""The forced tool-call schema extraction uses -- same pattern as
themes/claude_client.py and consensus/analyze.py: a single strict-schema tool call
instead of free text, so the model's output is structurally guaranteed rather than
hopefully-parseable.
"""
from __future__ import annotations

from ..models import MODALITIES

ASSERTION_TOOL = {
    "name": "record_assertions",
    "description": (
        "Record every causal assertion (X affects Y) found in this source, one entry "
        "per assertion. Call this even if the list is empty -- an empty list is a "
        "correct answer when nothing in the source supports a causal assertion."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "assertions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "segment_index": {
                            "type": "integer",
                            "description": "The [N] number of the segment this assertion is drawn from.",
                        },
                        "from_issue": {
                            "type": "string",
                            "description": "The cause -- something that can meaningfully increase or decrease.",
                        },
                        "to_issue": {
                            "type": "string",
                            "description": "The effect -- something that can meaningfully increase or decrease.",
                        },
                        "weight": {
                            "type": "number",
                            "description": (
                                "Signed strength/direction in [-1, 1]: positive if more "
                                "from_issue means more to_issue, negative if more from_issue "
                                "means less to_issue. Near zero (e.g. 0.05, signed per the "
                                "implied direction) for a negation, never omitted."
                            ),
                        },
                        "modality": {
                            "type": "string",
                            "enum": list(MODALITIES),
                            "description": (
                                "asserted: direct first-person claim about something actually "
                                "happening (the default). hypothetical: a conditional belief "
                                "about the system, not a report of it happening. reported: "
                                "secondhand, attributed to the speaker who reported it. "
                                "negated: an assertion that the link is absent."
                            ),
                        },
                        "quote": {
                            "type": "string",
                            "description": "The verbatim (or lightly trimmed) source text supporting this assertion.",
                        },
                    },
                    "required": ["segment_index", "from_issue", "to_issue", "weight", "modality", "quote"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["assertions"],
        "additionalProperties": False,
    },
    "strict": True,
}
