"""Survey results saved to the notes folder (.csv, .xlsx, .xls) as one unit per response.

Two layouts arrive:

  long   One row per answer, grouped by a response id. The Consensus survey export is this
         shape: Response ID, Submitted At, Question ID, Question Text, Turn, Prompt, Answer. A
         follow-up turn's own question is in Prompt; Question Text holds the thread's last one.
  wide   One row per respondent, one column per question: Microsoft Forms, Google Forms,
         SurveyMonkey (a second header row of sub-answers) and Qualtrics (three header rows).

Each response is read on its own: its company (from a company question or column), who answered,
when it was submitted, and its questions and answers as "Q:" and "A:" lines. Claude is told to take
statements only from the answers, as written, and never to infer what a respondent did not say.

A spreadsheet that is not survey answers (a tracker, an attendee list) has no free-text answers and
is skipped without a Claude call.
"""
from __future__ import annotations

import csv
import io
import re
from dataclasses import dataclass, field
from datetime import date, datetime

HINT = ("One respondent's answers to a survey. Lines read 'Q: question' then 'A: their answer'. The "
        "Company line names the respondent's organization. Questions are the survey's words, not the "
        "respondent's: a follow-up question may restate an earlier answer, so quote only the 'A:' lines. "
        "Record only what the respondent wrote. Do not infer challenges, needs or views they did not state.")

# Headers, lower-cased, of columns that say nothing about the partner.
_META = re.compile(
    r"^(response ?id|respondent ?id|submission ?id|collector ?id|id|#|question ?id|turn|ip ?address|"
    r"start ?(date|time)|end ?(date|time)|recorded ?date|submitted ?at|submitted|submission ?(date|time)|"
    r"date ?(created|modified|submitted)|completion ?time|last modified time|timestamp|duration.*|progress|"
    r"finished|status|distribution ?channel|user ?language|location ?(latitude|longitude)|"
    r"recipient ?(first|last) ?name|recipient ?email|external ?(data )?reference|total points|quiz feedback|"
    r"points - .*|feedback - .*|e-?mail( address)?|your e-?mail( address)?|custom data.*)$")
_DATE = re.compile(r"^(submitted ?at|submitted|submission ?(date|time)|completion ?time|end ?(date|time)|"
                   r"recorded ?date|date ?submitted|timestamp|date ?modified|last modified time|date ?created|"
                   r"start ?(date|time))$")
_COMPANY = re.compile(r"(\b(name of|what is|which) (your |the )?(company|organi[sz]ation|employer|business)\b|"
                      r"^(company|organi[sz]ation|employer|business)( name)?\??$|\b(company|organi[sz]ation) name\b|"
                      r"\bwhere do you work\b)")
_PERSON = re.compile(r"(^(full )?name\??$|\byour (full )?name\b|^respondent( name)?$|\bname of (the )?(person|respondent)\b)")
_FIRST = re.compile(r"^first ?name\??$")
_LAST = re.compile(r"^last ?name\??$")
# SurveyMonkey's second header row labels each column with one of these.
_SUB_HEADER = {"response", "open-ended response", "other (please specify)"}


@dataclass
class Response:
    submitted: str = ""             # YYYY-MM-DD, or "" when the sheet has no date for it
    company: str = ""
    person: str = ""
    answers: list[tuple[str, str]] = field(default_factory=list)  # (question, answer), in order


def _key(header: str) -> str:
    return re.sub(r"\s+", " ", header.strip().lower())


def _day(value: str) -> str:
    """A submitted timestamp as YYYY-MM-DD: ISO ("2026-11-06T19:41:50Z"), US ("11/6/2026 2:41 PM")."""
    v = value.strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", v)
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{2,4})\b", v)
    if m:
        year = int(m.group(3))
        year += 2000 if year < 100 else 0
        try:
            return date(year, int(m.group(1)), int(m.group(2))).isoformat()
        except ValueError:
            return ""
    return ""


def _blank(row: list[str]) -> bool:
    return not any(c.strip() for c in row)


def title(name: str) -> str:
    """A survey's title from its file name: "hiring-with-internal-referrals-9873a1a2-responses.csv"
    is "Hiring with internal referrals"."""
    stem = name.rsplit(".", 1)[0]
    stem = re.sub(r"[-_ ]+(responses?|results?|export)$", "", stem, flags=re.I)
    stem = re.sub(r"[-_ ][0-9a-f]{6,}$", "", stem, flags=re.I)
    stem = re.sub(r"[-_]+", " ", stem).strip()
    return stem[:1].upper() + stem[1:] if stem else "Survey"


# ------------------------------------------------------------------------------ reading the sheet

def rows_from_csv(data: str) -> list[list[str]]:
    sample = data[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    return [[c.strip() for c in row] for row in csv.reader(io.StringIO(data), dialect)]


def _cell(value) -> str:
    if value is None:
        return ""
    if isinstance(value, datetime):
        return value.isoformat(sep=" ", timespec="seconds")
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    return str(value).strip()


def _first_sheet_with_rows(sheets) -> list[list[str]]:
    """The first sheet holding a header and at least one row: an export's answers, not its cover sheet."""
    for rows in sheets:
        rows = [r for r in rows if not _blank(r)]
        if len(rows) >= 2:
            return rows
    return []


def rows_from_xlsx(data: bytes) -> list[list[str]]:
    import openpyxl  # the pipelines' requirements carry it; imported here so text-only runs need not
    book = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    try:
        return _first_sheet_with_rows(([_cell(v) for v in row] for row in ws.iter_rows(values_only=True))
                                      for ws in book.worksheets)
    finally:
        book.close()


def rows_from_xls(data: bytes) -> list[list[str]]:
    import xlrd  # .xls (Excel 97-2003) only; xlrd 2 reads nothing else
    book = xlrd.open_workbook(file_contents=data)

    def value(sheet, r, c):
        cell = sheet.cell(r, c)
        if cell.ctype == xlrd.XL_CELL_DATE:
            return _cell(xlrd.xldate_as_datetime(cell.value, book.datemode))
        if cell.ctype == xlrd.XL_CELL_BOOLEAN:
            return _cell(bool(cell.value))
        return _cell(cell.value)

    return _first_sheet_with_rows(
        [[value(s, r, c) for c in range(s.ncols)] for r in range(s.nrows)] for s in book.sheets())


# ------------------------------------------------------------------------------ the two layouts

def _header_at(rows: list[list[str]]) -> int:
    for i, row in enumerate(rows):
        if sum(1 for c in row if c.strip()) >= 2:
            return i
    return -1


def _col(headers: list[str], pattern: re.Pattern) -> int:
    for i, h in enumerate(headers):
        if pattern.search(_key(h)):
            return i
    return -1


def _long_columns(headers: list[str]):
    """(response id, answer, question, prompt, date) column indexes when one row is one answer."""
    keys = [_key(h) for h in headers]
    find = lambda *names: next((keys.index(n) for n in names if n in keys), -1)
    rid = find("response id", "respondent id", "submission id", "responseid")
    answer = find("answer", "response text", "answer text")
    question = find("question text", "question")
    prompt = find("prompt", "asked")
    if rid < 0 or answer < 0 or (question < 0 and prompt < 0):
        return None
    return rid, answer, question, prompt, find("submitted at", "submitted", "timestamp", "date", "completed at")


def _read_long(headers, data, cols) -> list[Response]:
    rid, answer, question, prompt, when = cols
    out: dict[str, Response] = {}
    at = lambda row, i: row[i].strip() if 0 <= i < len(row) else ""
    for row in data:
        key = at(row, rid)
        if not key:
            continue
        r = out.setdefault(key, Response())
        r.submitted = r.submitted or _day(at(row, when))
        asked = at(row, prompt) or at(row, question)
        said = at(row, answer)
        if not said:
            continue
        if _COMPANY.search(_key(asked)) and not r.company:
            r.company = said
        elif _PERSON.search(_key(asked)) and not r.person:
            r.person = said
        else:
            r.answers.append((asked, said))
    return list(out.values())


def _read_wide(headers, data) -> list[Response]:
    keys = [_key(h) for h in headers]
    company, person = _col(headers, _COMPANY), _col(headers, _PERSON)
    first, last = _col(headers, _FIRST), _col(headers, _LAST)
    when = _col(headers, _DATE)
    skip = {i for i, k in enumerate(keys) if _META.match(k)} | {company, person, first, last, when}
    out = []
    at = lambda row, i: row[i].strip() if 0 <= i < len(row) else ""
    for row in data:
        if _blank(row):
            continue
        r = Response(submitted=_day(at(row, when)), company=at(row, company),
                     person=at(row, person) or " ".join(x for x in (at(row, first), at(row, last)) if x))
        for i, h in enumerate(headers):
            said = at(row, i)
            if i in skip or not said or not h.strip():
                continue
            r.answers.append((h.strip(), said))
        out.append(r)
    return out


def responses(rows: list[list[str]]) -> tuple[list[Response], str]:
    """The responses in a sheet, and why there are none when it is not survey answers."""
    h = _header_at(rows)
    if h < 0:
        return [], "an empty spreadsheet"
    headers, data = rows[h], rows[h + 1:]
    # Qualtrics: question ids, then question text, then a row of {"ImportId": ...}.
    if len(data) >= 2 and any(c.startswith('{"ImportId"') for c in data[1]):
        headers, data = data[0], data[2:]
    # SurveyMonkey: a second header row naming each column's sub-answer under a spanning question.
    elif data and sum(1 for c in data[0] if _key(c) in _SUB_HEADER) >= 2:
        merged, current = [], ""
        for i, top in enumerate(headers):
            current = top.strip() or current
            sub = data[0][i].strip() if i < len(data[0]) else ""
            merged.append(current if not sub or _key(sub) in _SUB_HEADER else f"{current} - {sub}")
        headers, data = merged, data[1:]
    cols = _long_columns(headers)
    found = _read_long(headers, data, cols) if cols else _read_wide(headers, data)
    found = [r for r in found if r.answers]
    # Survey answers include writing. A sheet of names, numbers and choices is not one.
    if not any(len(a.split()) >= 4 for r in found for _, a in r.answers):
        return [], "a spreadsheet with no written answers"
    return found, ""


def render(r: Response, survey: str) -> str:
    lines = [f"Survey: {survey}"]
    if r.company:
        lines.append(f"Company: {r.company}")
    if r.person:
        lines.append(f"Respondent: {r.person}")
    if r.submitted:
        lines.append(f"Submitted: {r.submitted}")
    lines.append("")
    for q, a in r.answers:
        lines += [f"Q: {q}", f"A: {a}", ""]
    return "\n".join(lines).strip()
