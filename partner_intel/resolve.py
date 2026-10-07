"""Match company and person names to the roster, in code, before any model sees them.

The notes spell the same company many ways ("THG", "Thomas & Skinner", "Murray
Mentor/Mursix", "Hitachi Astemo"). A model asked to normalize names invents matches, so this
module does it deterministically and says how sure it is. A name that fits two partners is
reported as ambiguous, never guessed: "Toyota" is both Toyota Motor Manufacturing Indiana and
Toyota Industrial, and only a person can say which one a note meant.

Order of attempts for a company name:
  1. exact    the same words once legal suffixes and punctuation are removed
  2. subset   every word of the name appears in one partner's name ("Ivy Tech")
  3. superset one partner's name appears whole inside the text ("Hitachi Astemo Americas")
  4. fuzzy    near-identical spelling, with a clear winner
"""
from __future__ import annotations

import re
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass, field

from rapidfuzz import fuzz, process

from .roster import Roster

LEGAL = {"inc", "incorporated", "llc", "ltd", "corp", "corporation", "co", "company", "the",
         "and", "of", "dba", "lp", "llp", "l", "c", "plc"}
# Words that appear in many partner names. A name made only of these cannot identify one.
COMMON = {"indiana", "america", "american", "national", "group", "systems", "solutions",
          "industries", "industrial", "services", "technologies", "technology", "products",
          "manufacturing", "engineering", "university", "college", "state", "international",
          "global", "holdings", "enterprises", "partners", "associates"}
# Abbreviations seen in the notes that no rule can derive. Keyed by what the notes say.
SEED_ALIASES = {"hitachi astemo": "Astemo Indiana", "murray mentor": "Mursix"}

TITLE_WORDS = {"dr", "mr", "ms", "mrs", "prof"}


def fold(text: str) -> str:
    """Lower-case ASCII with accents removed. A damaged character simply disappears."""
    text = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in text if ord(ch) < 128).lower()


def tokens(name: str) -> list[str]:
    name = fold(name).replace("&", " and ")
    name = re.sub(r"[.'’]", "", name)
    return [t for t in re.split(r"[^a-z0-9]+", name) if t and t not in LEGAL]


def core_key(name: str) -> str:
    return " ".join(tokens(name))


def _variants(name: str) -> list[str]:
    out = []
    base = re.sub(r"\([^)]*\)", " ", name)
    out.append(base)
    for inner in re.findall(r"\(([^)]*)\)", name):
        inner = re.sub(r"(?i)^part of\s+", "", inner.strip())
        out.extend(piece for piece in re.split(r"[;,]", inner))
    for part in re.split(r"(?i)\bdba\b", base):
        out.append(part)
    for part in re.split(r"\s*/\s*", base):
        out.append(part)
    seen, result = set(), []
    for v in out:
        key = core_key(v)
        if key and key not in seen:
            seen.add(key)
            result.append(v)
    return result


@dataclass
class Match:
    company_id: str | None
    method: str  # exact | alias | subset | superset | fuzzy | ambiguous | none
    candidates: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.company_id is not None


def person_keys(name: str) -> list[str]:
    """Keys a person's name can be found under: full name, nickname form, last name + initial."""
    nick = re.findall(r"\(([^)]*)\)", name)
    plain = re.sub(r"\([^)]*\)", " ", name)
    forms = [plain] + [f"{n} {' '.join(plain.split()[1:])}" for n in nick]
    keys = []
    for form in forms:
        toks = [t for t in re.split(r"[^a-z0-9]+", fold(form)) if t and t not in TITLE_WORDS]
        if len(toks) >= 2:
            keys.append(" ".join(toks))
            keys.append(f"{toks[0][0]} {toks[-1]}")
    return keys


class Resolver:
    def __init__(self, roster: Roster):
        self.roster = roster
        self.exact: dict[str, set[str]] = defaultdict(set)
        self.variants: list[tuple[str, frozenset[str]]] = []
        initialisms: dict[str, set[str]] = defaultdict(set)
        for p in roster.partners:
            for v in _variants(p["name"]) + list(p["aliases"]):
                toks = tokens(v)
                if not toks:
                    continue
                self.exact[" ".join(toks)].add(p["id"])
                self.variants.append((p["id"], frozenset(toks)))
                if len(toks) >= 3:
                    initialisms["".join(t[0] for t in toks)].add(p["id"])
        for key, ids in initialisms.items():
            if len(ids) == 1 and key not in self.exact:
                self.exact[key] |= ids
        self._recount()
        partner_ids = {p["id"] for p in roster.partners}
        ids_by_name = {core_key(p["name"]): p["id"] for p in roster.partners}
        for alias, target in {**SEED_ALIASES, **roster.aliases}.items():
            target_id = target if target in partner_ids else None
            if target_id is None:
                target_id = self._match_text(target, allow_fuzzy=False).company_id
            if target_id is None:
                target_id = ids_by_name.get(core_key(target))
            if target_id and core_key(alias):
                self.exact[core_key(alias)].add(target_id)
                self.variants.append((target_id, frozenset(tokens(alias))))
        self._recount()

        self.people: dict[str, set[str]] = defaultdict(set)
        for p in roster.partners:
            for contact in p["contacts"]:
                self.learn_person(contact, p["id"])
        self.staff_keys = {k for s in roster.staff for k in person_keys(s)}
        self.staff_names = {" ".join(re.split(r"[^a-z0-9]+", fold(s))).strip() for s in roster.staff}

    def _recount(self) -> None:
        """How many different partners use each word. A word used by one partner identifies it."""
        seen: dict[str, set[str]] = defaultdict(set)
        for cid, toks in self.variants:
            for t in toks:
                seen[t].add(cid)
        self.df = Counter({t: len(ids) for t, ids in seen.items()})

    # ---------------------------------------------------------------- companies
    def _match_text(self, raw: str, allow_fuzzy: bool = True) -> Match:
        toks = tokens(raw)
        if not toks:
            return Match(None, "none")
        key = " ".join(toks)
        ids = self.exact.get(key)
        if ids:
            ids = sorted(ids)
            return Match(ids[0], "exact") if len(ids) == 1 else Match(None, "ambiguous", ids)

        raw_set = frozenset(toks)
        distinctive = [t for t in raw_set if t not in COMMON and len(t) >= 3]
        if distinctive or len(raw_set) >= 2:
            subset_ids = sorted({cid for cid, vt in self.variants if raw_set <= vt})
            if len(subset_ids) == 1:
                return Match(subset_ids[0], "subset")
            if len(subset_ids) > 1:
                return Match(None, "ambiguous", subset_ids)

        super_hits: dict[str, int] = {}
        for cid, vt in self.variants:
            if not vt <= raw_set:
                continue
            if len(vt) == 1:
                (only,) = tuple(vt)
                if len(only) < 5 or only in COMMON or self.df[only] != 1:
                    continue
            super_hits[cid] = max(super_hits.get(cid, 0), len(vt))
        if super_hits:
            best = max(super_hits.values())
            top = sorted(cid for cid, n in super_hits.items() if n == best)
            return Match(top[0], "superset") if len(top) == 1 else Match(None, "ambiguous", top)

        if allow_fuzzy and len(key) >= 6 and self.exact:
            scored = process.extract(key, list(self.exact), scorer=fuzz.ratio, limit=3)
            if scored:
                best_key, best_score, _ = scored[0]
                runner = scored[1][1] if len(scored) > 1 else 0
                best_ids = sorted(self.exact[best_key])
                if best_score >= 88 and best_score - runner >= 4 and len(best_ids) == 1:
                    return Match(best_ids[0], "fuzzy")
                candidates = sorted({i for k, s, _ in scored if s >= 70 for i in self.exact[k]})
                if candidates:
                    return Match(None, "none", candidates[:3])
        return Match(None, "none")

    def company(self, raw: str) -> Match:
        raw = (raw or "").strip()
        if not raw or fold(raw).strip() in ("unknown", "n/a", "none", "group", "various", "multiple"):
            return Match(None, "none")
        direct = self.roster.aliases.get(raw)
        if direct and direct in self.roster.by_id():
            return Match(direct, "alias")
        return self._match_text(raw)

    def affiliation(self, text: str) -> Match:
        """A free-text affiliation such as "President & CEO, MBC Group" or "Murray Mentor/Mursix"."""
        whole = self.company(text)
        if whole.ok:
            return whole
        fragments = [f.strip() for f in re.split(r"[,/;|]|\s[-–—]\s|\bat\b", text) if f.strip()]
        for fragment in reversed(fragments):
            hit = self.company(fragment)
            if hit.ok:
                return hit
        return whole

    # ---------------------------------------------------------------- people
    def learn_person(self, name: str, company_id: str) -> None:
        for key in person_keys(name):
            self.people[key].add(company_id)

    def person(self, name: str) -> str | None:
        """The company a person belongs to, if their name identifies exactly one."""
        keys = person_keys(name or "")
        for key in keys[::2] + keys[1::2]:  # full-name keys before last-name-and-initial keys
            ids = self.people.get(key)
            if ids and len(ids) == 1:
                return next(iter(ids))
        return None

    def is_staff(self, name: str) -> bool:
        if not name:
            return False
        if any(k in self.staff_keys for k in person_keys(name)[::2]):
            return True
        return " ".join(re.split(r"[^a-z0-9]+", fold(name))).strip() in self.staff_names
