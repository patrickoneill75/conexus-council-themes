"""The issue store: canonical issue nodes an Assertion's raw labels resolve onto (see
pcn/pipeline/match). Like the ledger, unresolved growth only ever appends a new Issue
or extends an existing one's aliases/definition -- an issue's `id` and
`canonical_label`, once created, are never renamed or merged here; a genuine merge of
two issues is a deliberate, rare operation for a human to do (design doc section 12),
not something this module does automatically.
"""
from __future__ import annotations

import json
from pathlib import Path

from .models import Issue


def load(path: Path) -> list[Issue]:
    if not path.exists():
        return []
    rows = json.loads(path.read_text(encoding="utf-8"))
    return [Issue(**row) for row in rows]


def save(path: Path, issues: list[Issue]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps([i.to_dict() for i in issues], indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def add_alias(issue: Issue, alias: str) -> None:
    normalized = alias.strip()
    if normalized and normalized != issue.canonical_label and normalized not in issue.aliases:
        issue.aliases.append(normalized)


def set_definition_if_missing(issue: Issue, definition: str) -> bool:
    """The design doc's "reviewing doubles as codebook-building": a human writes an
    issue's one-line definition the first time they confirm an assertion resolved
    onto it, feeding future adjudication-stage prompts. Returns False, changing
    nothing, if the issue already has a definition -- this never overwrites one."""
    if issue.definition:
        return False
    issue.definition = definition.strip()
    return True


def find(issues: list[Issue], issue_id: str) -> Issue | None:
    return next((i for i in issues if i.id == issue_id), None)
