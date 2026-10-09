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
# First words of partner names that are ordinary words in a file or meeting title.
GENERIC_FIRST = {"midwest", "central", "southern", "northern", "western", "eastern", "advanced", "precision",
                 "applied", "general", "united", "premier", "quality", "custom", "great", "first", "major",
                 "flexible", "progressive", "superior", "summit", "pioneer", "heritage"}


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


def name_tokens(name: str) -> list[str]:
    plain = re.sub(r"\([^)]*\)", " ", name or "")
    return [t for t in re.split(r"[^a-z0-9]+", fold(plain)) if t and t not in TITLE_WORDS]


@dataclass
class Speaker:
    """Who a speaker is, as far as the contact lists can say.

    company_id is set when exactly one company fits. how says why: "contact" (the full name is
    on a contact list, at one company), "contact in context" (the full name is at several
    companies, one of them the file's), or "first name in context" (only a first name, and
    exactly one contact with it works for a company the file is about). candidates lists the
    companies when more than one fits."""
    company_id: str | None = None
    how: str = ""
    full_name: str = ""
    candidates: list[str] = field(default_factory=list)


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
        self.brand_words = [(p["id"], tokens(p["name"])[0]) for p in roster.partners if tokens(p["name"])]
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
        self.first_names: dict[str, set[tuple[str, str]]] = defaultdict(set)  # first name -> {(company, full name)}
        self.full_names: dict[str, tuple[str, set[str]]] = {}  # "ben larson" -> (display name, companies)
        self.by_last: dict[str, set[tuple[str, str, str]]] = defaultdict(set)  # last -> {(first, company, display)}
        for p in roster.partners:
            for contact in p["contacts"]:
                self.learn_person(contact, p["id"])
        # The uploaded contact list. 151 accounts carry 5,000 people, so each account name is
        # matched once.
        account_ids: dict[str, str | None] = {}
        for c in roster.contacts:
            if c["account"] not in account_ids:
                hit = self._match_text(c["account"], allow_fuzzy=False)
                account_ids[c["account"]] = hit.company_id
            if account_ids[c["account"]]:
                self.learn_person(c["name"], account_ids[c["account"]])
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

    def companies_named(self, raw: str) -> set[str]:
        """Every partner whose name appears whole in the text, by the superset rule, without
        picking one: "Lucas Oil and Zoeller joint call" names two. A name that is part of a
        longer matched name ("Lucas Oil" inside "Lucas Oil Products") counts once, as the longer."""
        raw_set = frozenset(tokens(raw))
        hits: list[tuple[str, frozenset]] = []
        for cid, vt in self.variants:
            if not vt or not vt <= raw_set:
                continue
            if len(vt) == 1:
                (only,) = tuple(vt)
                if len(only) < 5 or only in COMMON or self.df[only] != 1:
                    continue
            hits.append((cid, vt))
        named = {cid for cid, vt in hits if not any(vt < other for _, other in hits)}
        # A partner's brand word ("zoeller", "evonik", "lippert": the first word of its name, used
        # by no other partner) names it too. Only the first word: "Development" in "Conexus
        # Workforce Development" must not name the Indiana Economic Development Corporation.
        for t in raw_set:
            if len(t) >= 5 and t not in COMMON and t not in GENERIC_FIRST and self.df[t] == 1:
                named |= {cid for cid, first in self.brand_words if first == t}
        return named

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
        toks = name_tokens(name)
        if len(toks) >= 2:
            display = " ".join(re.sub(r"\([^)]*\)", " ", name).split())
            self.first_names[toks[0]].add((company_id, display))
            self.by_last[toks[-1]].add((toks[0], company_id, display))
            known = self.full_names.get(" ".join(toks))
            self.full_names[" ".join(toks)] = (known[0] if known else display, (known[1] if known else set()) | {company_id})

    def speaker(self, name: str, context: set[str] | frozenset = frozenset()) -> Speaker:
        """Who said it. context is the companies the file is about (named in its file name, its
        section heading or its attendee list); it is what lets a first name, or a full name held
        by two people at different companies, point to one company. Never a guess: when more
        than one company still fits, the answer is the candidates, not a pick."""
        if not name or self.is_staff(name):
            return Speaker()
        toks = name_tokens(name)
        if len(toks) >= 2:
            exact = self.full_names.get(" ".join(toks))
            if exact:
                display, ids = exact[0], exact[1]
            else:
                # "B. Larson", or "Michael Miller" for the contact Mike Miller. Never "Brian Larson"
                # for Ben Larson: the first two letters must agree.
                near = self._same_person(toks)
                if not near:
                    return Speaker()
                ids = set().union(*near.values())
                display = next(iter(near)) if len(near) == 1 else name
            if len(ids) == 1:
                return Speaker(next(iter(ids)), "contact", display)
            inside = ids & set(context)
            if len(inside) == 1:
                return Speaker(next(iter(inside)), "contact in context", display)
            return Speaker(None, "ambiguous", display, sorted(ids))
        if len(toks) == 1 and context:
            fits = {(cid, full) for cid, full in self.first_names.get(toks[0], ()) if cid in context}
            companies = sorted({cid for cid, _ in fits})
            if len(fits) == 1:
                cid, full = next(iter(fits))
                return Speaker(cid, "first name in context", full)
            if len(companies) > 1:
                return Speaker(None, "ambiguous", name, companies)
        return Speaker()

    def people_in_text(self, text: str, context: set[str] | frozenset = frozenset(), limit: int = 25) -> list[str]:
        """Contacts named in a piece of notes, as "Ben Larson (Evonik Industries)", for the model
        to tell whose statement is whose. Full names are found anywhere in the text; a first name
        counts only as a speaker label ("[Ben]", "Ben:") and only when exactly one contact with it
        works for a company the file is about. A name at several companies is left out."""
        names = self.roster.by_id()
        words = [w for w in re.split(r"[^a-z0-9]+", fold(text or "")) if w]
        grams = {" ".join(words[i:i + n]) for n in (2, 3) for i in range(len(words) - n + 1)}
        found: dict[str, str] = {}
        for key in sorted(grams & self.full_names.keys()):
            display, ids = self.full_names[key]
            if self.is_staff(display):
                continue
            if len(ids) == 1 or len(ids & set(context)) == 1:
                cid = next(iter(ids)) if len(ids) == 1 else next(iter(ids & set(context)))
                found[display] = names[cid]["name"]
        for label in re.findall(r"(?m)^\s*(?:\[([A-Za-z][\w'.-]*)\]|([A-Z][a-z]+):)", text or ""):
            hit = self.speaker(label[0] or label[1], context)
            if hit.company_id and hit.how == "first name in context":
                found.setdefault(hit.full_name, names[hit.company_id]["name"])
        return [f"{n} ({c})" for n, c in sorted(found.items())][:limit]

    def _same_person(self, toks: list[str]) -> dict[str, set[str]]:
        """Contacts with this last name whose first name could be this one: "B" fits any B,
        "Michael" fits "Mike" (the first two letters agree), "Brian" does not fit "Ben".
        Returns {display name: companies}."""
        first = toks[0]
        out: dict[str, set[str]] = defaultdict(set)
        for f, cid, display in self.by_last.get(toks[-1], ()):
            if (f[0] == first if len(first) == 1 else f[:2] == first[:2]):
                out[display].add(cid)
        return out

    def person(self, name: str) -> str | None:
        """The company a person belongs to, if their name identifies exactly one."""
        keys = person_keys(name or "")
        for key in keys[::2]:
            ids = self.people.get(key)
            if ids and len(ids) == 1:
                return next(iter(ids))
        toks = name_tokens(name or "")
        if len(toks) >= 2:
            near = self._same_person(toks)
            ids = set().union(*near.values()) if near else set()
            if len(ids) == 1:
                return next(iter(ids))
        return None

    def is_staff(self, name: str) -> bool:
        if not name:
            return False
        if any(k in self.staff_keys for k in person_keys(name)[::2]):
            return True
        return " ".join(re.split(r"[^a-z0-9]+", fold(name))).strip() in self.staff_names
