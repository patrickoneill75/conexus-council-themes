/**
 * Credential shortlisting for the Job Description Updater.
 *
 * The Job Description Toolkit's Part 3 asks employers to tie a genuinely necessary
 * requirement to a recognized, portable credential rather than a vague phrase like
 * "technical background preferred". The credential workbook behind this
 * (src/data/credentials.json, built by scripts/build_credentials.py) covers 30
 * recommendable credentials and pathways across MSSC, NIMS, OSHA, Ivy Tech program
 * areas, and the three toolkit pathways with no workbook rows of their own.
 *
 * Thirty is far too many to put in front of an employer, and far too many to hand a
 * model and expect a disciplined answer: asked to choose from thirty, it pads. The
 * toolkit's own advice is the opposite -- name the one or two that actually fit, so a
 * school can teach toward them.
 *
 * So the shortlist is computed HERE, deterministically, with no API call: score every
 * credential against the role's own wording, and pass only the top few to the model,
 * which makes the final 1-5 call with a reason for each. That keeps the expensive step
 * small and the cheap step thorough, and it means the same role always produces the
 * same candidates.
 *
 * SCORING. Cosine-style overlap between the role's term frequencies and each
 * credential's stored term weights (frequency x inverse document frequency, computed
 * across all 30 at build time -- see the build script). The IDF half is what stops
 * "safety", "quality" and "process" deciding every comparison; those appear in nearly
 * every credential AND nearly every job description, so without it MSSC CPT and the
 * OSHA cards would win every time regardless of the role.
 *
 * A duty is weighted above a requirement on purpose. Part 3's whole point is that the
 * requirements as written are the least trustworthy part of the document, so the work
 * actually performed should drive which credential fits, not the requirements someone
 * inherited from a prior hiring era.
 */

import credentialData from "./data/credentials.json";

// Mirrors scripts/build_credentials.py's own tokenizer. The two must agree: a term the
// build script kept but this drops can never match, and vice versa.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into", "is", "it",
  "its", "of", "on", "or", "that", "the", "to", "with", "within", "up", "out", "other",
  "using", "use", "used", "uses", "including", "incl", "per", "via", "not", "all", "any",
  "each", "such", "than", "then", "this", "these", "those", "their", "there", "when",
  "where", "which", "while", "who", "will", "would", "can", "could", "may", "must",
  "should", "shall", "have", "has", "had", "do", "does", "done", "you", "your", "they",
  "them", "we", "our", "if", "but", "also", "more", "most", "one", "two", "three", "min",
  "hour", "hours", "minimum", "topics", "topic", "level", "credential", "credentials",
  "module", "modules", "activity", "activities", "least", "totaling", "trainer",
  "discretion", "select", "selects", "minutes", "time", "times", "total", "expanded",
  "coverage", "additional", "n", "na", "published", "sub", "breakdown", "applicable",
  "appropriate", "required", "requirements", "requirement", "perform", "performs",
  "performing", "performance", "identify", "identifies", "recognize", "recognizes",
  "explain", "explains", "define", "defines", "describe", "describes", "demonstrate",
  "demonstrates", "participate", "participates", "conduct", "conducts", "ensure",
  "ensures", "include", "includes", "work", "working", "workplace", "job", "role", "roles",
  "task", "tasks", "hrs", "choose", "elective", "optional"
]);

const KEEP_SHORT = new Set(["cnc", "plc", "spc", "cmm", "ppe", "sds", "mes", "erp",
                            "tpm", "5s", "lock", "arc", "mig", "tig", "gd&t", "hmi",
                            "iot", "id", "od"]);

const TOKEN_RE = /[a-z0-9&]+/g;

const MAX_PER_FAMILY = 4;

export function tokenize(text) {
  const tokens = String(text || "").toLowerCase().match(TOKEN_RE) || [];
  return tokens.filter((t) => !STOPWORDS.has(t) && (t.length > 3 || KEEP_SHORT.has(t)));
}

/** Term -> weight for the role, from its duties (weighted up) and everything else. */
function roleVector({ duties = [], requirements = [], technology = "", title = "" }) {
  const counts = new Map();
  const add = (text, weight) => {
    for (const term of tokenize(text)) counts.set(term, (counts.get(term) || 0) + weight);
  };
  // Duties carry 2x a requirement: Part 3's premise is that the requirements as written
  // are the least trustworthy part of the document, so what the person actually does
  // should decide which credential fits.
  for (const duty of duties) add(duty, 2);
  for (const requirement of requirements) add(requirement, 1);
  add(technology, 2);
  add(title, 1);
  return counts;
}

// This tool is for Advanced Manufacturing and Logistics roles, and the toolkit's own
// Credential & Pathway Reference names "OSHA 10 / OSHA 30 General Industry" -- not the
// Construction cards. The workbook documents both, and on raw term overlap the
// Construction variants outscored General Industry for a plant floor role (they carry
// more hazard vocabulary overall), which would have had the app recommending the wrong
// OSHA card to a manufacturer. They stay in the data, and can still surface for a role
// that genuinely reads as construction, but they no longer outrank their General
// Industry equivalent on a plant description.
const CONSTRUCTION_PENALTY = 0.55;

function familyPenalty(credential) {
  return /Construction Industry/i.test(credential.name) ? CONSTRUCTION_PENALTY : 1;
}

function magnitude(values) {
  let sum = 0;
  for (const v of values) sum += v * v;
  return Math.sqrt(sum);
}

/**
 * Rank every credential against one role.
 *
 * `limit` is how many reach the model. Eight is deliberate: enough that a genuinely
 * better fit sitting 5th cannot be squeezed out by four near-ties above it, few enough
 * that the model is choosing rather than surveying.
 *
 * Returns [{ id, name, family, signals, modules, score, matchedTerms }], best first,
 * with anything scoring zero dropped -- a credential sharing no vocabulary at all with
 * the role is not a candidate, and showing it would only invite a padded answer.
 */
export function shortlistCredentials(role, limit = 8) {
  const roleTerms = roleVector(role);
  if (!roleTerms.size) return [];
  const roleMagnitude = magnitude(roleTerms.values());

  const scored = credentialData.credentials.map((credential) => {
    const terms = credential.terms || {};
    let dot = 0;
    const matched = [];
    for (const [term, roleWeight] of roleTerms) {
      const credentialWeight = Object.prototype.hasOwnProperty.call(terms, term) ? terms[term] : 0;
      if (credentialWeight) {
        dot += roleWeight * credentialWeight;
        matched.push({ term, weight: roleWeight * credentialWeight });
      }
    }
    const credentialMagnitude = magnitude(Object.values(terms));
    const score = dot && roleMagnitude && credentialMagnitude
      ? (dot / (roleMagnitude * credentialMagnitude)) * familyPenalty(credential)
      : 0;
    matched.sort((a, b) => b.weight - a.weight);
    return {
      id: credential.id,
      name: credential.name,
      family: credential.family,
      signals: credential.signals,
      bestFor: credential.bestFor || "",
      modules: (credential.modules || []).map((m) => m.name),
      score: Number(score.toFixed(4)),
      // The terms that actually drove the match, so the prompt can show WHY this
      // credential is a candidate rather than asserting that it is one.
      matchedTerms: matched.slice(0, 8).map((m) => m.term),
    };
  });

  const ranked = scored.filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  if (!ranked.length) return [];
  // Relative floor, not an absolute one. Absolute scores vary by an order of magnitude
  // between a role whose wording closely mirrors a credential (a welder against the
  // Welding TC) and one that only brushes several (a quality inspector), so a fixed
  // cutoff would either admit noise for the first or return nothing for the second.
  // A tenth of the leader's score drops the tail that matched on one generic verb while
  // keeping every genuine near-tie.
  const floor = ranked[0].score * 0.1;
  const eligible = ranked.filter((c) => c.score >= floor);

  // Cap one family's share of the shortlist. NIMS publishes fourteen separate machining
  // cards, so a machinist's raw top eight was eight NIMS cards -- a monoculture that
  // never showed the model MSSC CPT, an Ivy Tech program area or OSHA, any of which can
  // be the better recommendation for that same role. Taking the best four of a family
  // and letting the rest of the list fill from elsewhere gives the model a real choice
  // while still leading with the closest matches.
  const perFamily = new Map();
  const spread = [];
  const overflow = [];
  for (const candidate of eligible) {
    const seen = perFamily.get(candidate.family) || 0;
    if (seen < MAX_PER_FAMILY) {
      perFamily.set(candidate.family, seen + 1);
      spread.push(candidate);
    } else {
      overflow.push(candidate);
    }
  }
  // If capping left room (few families matched at all), fill it from the overflow in
  // score order rather than returning a short list -- then restore score order overall,
  // so the list the model reads is genuinely best-first rather than family-first.
  return spread.concat(overflow).slice(0, limit).sort((a, b) => b.score - a.score);
}

/** The shortlist rendered for a prompt: compact, and honest about it being a shortlist. */
export function formatShortlist(shortlist) {
  if (!shortlist.length) return "(no credential in the reference matrix matched this role's wording)";
  return shortlist.map((c, i) => {
    const modules = c.modules.length ? `\n   Covers: ${c.modules.join("; ")}` : "";
    const why = c.matchedTerms.length ? `\n   Matched on: ${c.matchedTerms.join(", ")}` : "";
    return `${i + 1}. ${c.name}\n   Signals: ${c.signals}${c.bestFor ? `\n   Best for: ${c.bestFor}` : ""}${modules}${why}`;
  }).join("\n\n");
}

export const CREDENTIAL_COUNT = credentialData.credentials.length;
export const CREDENTIAL_NAMES = credentialData.credentials.map((c) => c.name);
