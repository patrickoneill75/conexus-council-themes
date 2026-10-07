"""Box file bytes to plain text.

Supported: docx, txt, md, vtt, srt, html, htm, and PDFs that carry a text layer. Scanned
PDFs raise NoTextLayer and are reported, never OCR'd. Legacy .doc is recognized and reported
as needing conversion, because reading it correctly takes a library this repo does not carry.

Word tables are kept. Meeting templates put the real content inside table cells, and a
parser that reads only paragraphs would return the headings and none of the discussion.
"""
from __future__ import annotations

import html
import io
import re
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field
from html.parser import HTMLParser

SUPPORTED_EXTENSIONS = ("docx", "txt", "md", "vtt", "srt", "pdf", "html", "htm")
# Text formats we recognize but cannot read. Reported with a clear instruction.
CONVERT_FIRST = ("doc", "rtf", "odt", "pages")

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


class UnreadableFile(Exception):
    """The file could not be turned into text. The message is shown to the admin."""


class NoTextLayer(UnreadableFile):
    """A PDF with no extractable text (a scan). Not OCR'd by design."""


@dataclass
class Document:
    text: str
    kind: str
    speakers: list[str] = field(default_factory=list)
    duration_seconds: int = 0


def extension(name: str) -> str:
    return name.rsplit(".", 1)[-1].lower() if "." in name else ""


def clean_text(text: str) -> str:
    text = unicodedata.normalize("NFC", text)
    text = text.replace(" ", " ").replace("​", "").replace("﻿", "").replace("\x00", "")
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def decode_bytes(data: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


# ------------------------------------------------------------------------------ docx

def _paragraph_text(p: ET.Element) -> str:
    out = []
    for el in p.iter():
        if el.tag == W + "t":
            out.append(el.text or "")
        elif el.tag == W + "tab":
            out.append("\t")
        elif el.tag in (W + "br", W + "cr"):
            out.append("\n")
    return "".join(out)


def _paragraph_line(p: ET.Element) -> str:
    text = _paragraph_text(p).strip()
    if not text:
        return ""
    style = p.find(f"{W}pPr/{W}pStyle")
    style_name = style.get(W + "val", "") if style is not None else ""
    heading = re.match(r"Heading(\d)", style_name)
    if heading:
        return "#" * int(heading.group(1)) + " " + text
    if p.find(f"{W}pPr/{W}numPr") is not None:
        return "- " + text
    return text


def _cell_paragraphs(tc: ET.Element) -> list[str]:
    return [t for t in (_paragraph_text(p).strip() for p in tc.findall(W + "p")) if t]


def _render_row(cells: list[list[str]]) -> list[str]:
    if not any(cells):
        return []
    if all(len(c) <= 1 for c in cells):
        parts = [c[0] if c else "" for c in cells]
        line = " | ".join(parts).rstrip(" |").strip()
        return [line] if line else []
    # A cell holding several paragraphs is where discussion lives: keep one line each.
    lines: list[str] = []
    first, rest = cells[0], cells[1:]
    if first:
        lines.append(" ".join(first) + ":")
    for cell in rest:
        lines.extend(cell)
    return lines


def _walk_block(container: ET.Element, lines: list[str]) -> None:
    for el in container:
        if el.tag == W + "p":
            line = _paragraph_line(el)
            if line:
                lines.append(line)
        elif el.tag == W + "tbl":
            for tr in el.findall(W + "tr"):
                cells = [_cell_paragraphs(tc) for tc in tr.findall(W + "tc")]
                lines.extend(_render_row(cells))
        elif el.tag == W + "sdt":
            content = el.find(W + "sdtContent")
            if content is not None:
                _walk_block(content, lines)


def _docx_text(data: bytes) -> str:
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        root = ET.fromstring(archive.read("word/document.xml"))
    except (zipfile.BadZipFile, KeyError, ET.ParseError) as e:
        raise UnreadableFile(f"Not a readable Word file ({e.__class__.__name__}).") from e
    body = root.find(W + "body")
    lines: list[str] = []
    if body is not None:
        _walk_block(body, lines)
    return "\n".join(lines)


# ------------------------------------------------------------------------------ VTT / SRT

_TIME = re.compile(
    r"(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})\s*-->\s*(?:(\d{1,2}):)?(\d{2}):(\d{2})[.,](\d{3})"
)
_BACKCHANNEL = {
    "yeah", "yes", "yep", "mm", "mhm", "mmhmm", "mm-hmm", "uh-huh", "um", "uh", "hmm", "okay",
    "ok", "right", "sure", "thanks", "thank you", "oh", "mm.", "yeah.", "um...", "okay.",
}


def _to_seconds(h, m, s, ms) -> float:
    return int(h or 0) * 3600 + int(m) * 60 + int(s) + int(ms) / 1000


def _is_backchannel(text: str) -> bool:
    plain = re.sub(r"[^\w\s-]", "", text.lower()).strip()
    return len(plain.split()) <= 2 and (plain in _BACKCHANNEL or not plain)


def _parse_cues(raw: str, allow_prefix_speakers: bool) -> list[tuple[float, float, str, str]]:
    cues = []
    for block in re.split(r"\n\s*\n", raw.replace("\r\n", "\n")):
        lines = [l for l in block.split("\n") if l.strip()]
        for i, line in enumerate(lines):
            match = _TIME.search(line)
            if not match:
                continue
            g = match.groups()
            start, end = _to_seconds(*g[0:4]), _to_seconds(*g[4:8])
            payload = "\n".join(lines[i + 1:])
            speaker = ""
            voice = re.match(r"\s*<v(?:\.[^ >]+)?\s+([^>]+)>", payload)
            if voice:
                speaker = html.unescape(voice.group(1)).strip()
            body = html.unescape(re.sub(r"<[^>]+>", "", payload))
            body = " ".join(body.split())
            if not speaker and allow_prefix_speakers:
                prefixed = re.match(r"^([A-Z][\w.'’-]*(?: [A-Z][\w.'’-]*){0,3}):\s+(.*)$", body)
                if prefixed:
                    speaker, body = prefixed.group(1), prefixed.group(2)
            if body:
                cues.append((start, end, speaker, body))
            break
    return cues


def _transcript(raw: str, kind: str) -> Document:
    cues = _parse_cues(raw, allow_prefix_speakers=(kind == "vtt"))
    cues.sort(key=lambda c: c[0])  # Teams writes cues slightly out of order
    turns: list[list[str]] = []
    speakers: list[str] = []
    for _, _, speaker, body in cues:
        if _is_backchannel(body):
            continue
        if speaker and speaker not in speakers:
            speakers.append(speaker)
        if turns and turns[-1][0] == speaker:
            turns[-1][1] += " " + body
        else:
            turns.append([speaker, body])
    lines = [f"{s}: {t}" if s else t for s, t in turns]
    duration = int(max((c[1] for c in cues), default=0))
    return Document(text="\n".join(lines), kind=kind, speakers=speakers, duration_seconds=duration)


# ------------------------------------------------------------------------------ PDF / HTML

def _pdf_text(data: bytes) -> str:
    try:
        from pypdf import PdfReader
    except ImportError as e:
        raise UnreadableFile("pypdf is not installed on the runner.") from e
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted and not reader.decrypt(""):
            raise UnreadableFile("The PDF is password protected.")
        pages = [(page.extract_text() or "") for page in reader.pages]
    except UnreadableFile:
        raise
    except Exception as e:  # pypdf raises many types on damaged files
        raise UnreadableFile(f"The PDF could not be read ({e.__class__.__name__}).") from e
    text = "\n\n".join(pages)
    if len(re.sub(r"\s+", "", text)) < 40 * max(1, len(pages)):
        raise NoTextLayer("The PDF has no text layer (a scan). Scans are not read.")
    return text


class _Stripper(HTMLParser):
    BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "section"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "head"):
            self.skip += 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style", "head"):
            self.skip = max(0, self.skip - 1)
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def _html_text(data: bytes) -> str:
    stripper = _Stripper()
    stripper.feed(decode_bytes(data))
    return "".join(stripper.parts)


# ------------------------------------------------------------------------------ entry point

def to_document(name: str, data: bytes) -> Document:
    ext = extension(name)
    if ext in CONVERT_FIRST:
        raise UnreadableFile(f".{ext} files cannot be read. Save a copy as .docx and it will be picked up.")
    if ext not in SUPPORTED_EXTENSIONS:
        raise UnreadableFile(f".{ext or '(none)'} is not a supported notes format.")
    if ext == "docx":
        return Document(clean_text(_docx_text(data)), "docx")
    if ext in ("vtt", "srt"):
        doc = _transcript(decode_bytes(data), ext)
        doc.text = clean_text(doc.text)
        return doc
    if ext == "pdf":
        return Document(clean_text(_pdf_text(data)), "pdf")
    if ext in ("html", "htm"):
        return Document(clean_text(_html_text(data)), "html")
    return Document(clean_text(decode_bytes(data)), ext)
