"""DOCX reader -- flattens paragraphs to plain text, one per line, translating Word's
built-in Heading styles ("Heading 1", "Heading 2", ...) into markdown-style "#"
prefixes so pcn/pipeline/normalize/notes.py can parse a docx notes document with the
exact same heading-hierarchy logic it uses for a native markdown file. List-style
paragraphs keep a leading "- " so that rule applies too. A docx transcript (no
headings, no lists -- just "Speaker: text" paragraphs) round-trips as plain lines,
which normalize/transcript.py already handles.
"""
from __future__ import annotations

from pathlib import Path

from docx import Document

_HEADING_PREFIX = {f"Heading {i}": "#" * i for i in range(1, 7)}


def read(path: Path) -> str:
    document = Document(str(path))
    lines: list[str] = []
    for paragraph in document.paragraphs:
        text = paragraph.text.strip()
        if not text:
            continue
        style_name = paragraph.style.name if paragraph.style else ""
        heading_prefix = _HEADING_PREFIX.get(style_name)
        if heading_prefix:
            lines.append(f"{heading_prefix} {text}")
        elif style_name.startswith("List") or text.startswith(("-", "*", "•")):
            lines.append(f"- {text.lstrip('-*• ').strip()}")
        else:
            lines.append(text)
    return "\n".join(lines)
