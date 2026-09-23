/**
 * Step 2 of the Apprenticeship Readiness Toolbox: the Manufacturing Workforce Needs
 * Assessment.
 *
 * Step 1 is a chat that asks yes/no questions and scores them. This is not that. The
 * employer enters their roles -- headcount, experience, skills gaps, who can retire,
 * what vacancies they carry -- and the tool works out the gap they are facing now, in
 * three years and in five, then shows how many apprentices it would take to close part
 * of it. The whole point is the last screen: a gap they can see, and apprentices sized
 * against it.
 *
 * WHY IT IS STILL A "SURVEY". It slots into the same step machinery as step 1 rather
 * than inventing a parallel one: a survey record with kind "workforce" carries the step
 * number, the unlock threshold, the Box folder and the account index keys, so locking,
 * the dashboard tab and "which step am I on" all keep working untouched. What differs is
 * the page the respondent is sent to and the shape of what comes back.
 *
 * SCORING. There is nothing to score -- this is a planning exercise, not a test. A
 * finished workforce step reports 100%, which is what lets an admin put a threshold on
 * it and have "finished" mean "passed". The dashboard shows it as Complete rather than
 * as a percentage, because a percentage here would be meaningless.
 *
 * STORAGE
 *   apprenticeship:workforce:<accountId>:<surveyId>   the working document, saved as
 *     they go so they can add roles over several sittings. On submit the computed
 *     summary is written into the ordinary response record (see src/apprenticeship.js),
 *     so the dashboard reads it exactly as it reads a chat step's results.
 *   Box, when the admin has picked a folder: one CSV per assessment, upserted by name,
 *     the same read-then-PUT-a-new-version pattern the rest of the repo uses (creating
 *     blindly 409s on the second run).
 *
 * NO CLAUDE CALL ANYWHERE IN HERE. Every number is arithmetic over what they typed, and
 * every list is a frequency count. A model would only add a way for the totals to be
 * wrong.
 */

const WORKFORCE_PREFIX = "apprenticeship:workforce:";

const MAX_ROLES = 60;
const MAX_LIST_ITEMS = 25;
const MAX_TEXT = 200;
const PLAN_YEARS = 5;

// An apprentice is in training for two years and counts as a full-time employee from the
// year after that -- start one in year 1 and they are staff in year 3, which is the shape
// the guidance on the page describes.
const TRAINING_YEARS = 2;

const DIFFICULTY = ["low", "medium", "high"];

const str = (v) => String(v == null ? "" : v).trim();

/** A whole, non-negative headcount. Anything else is zero rather than NaN downstream. */
function count(value, max = 100000) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(max, Math.round(n));
}

function years(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(60, Math.round(n * 10) / 10);
}

/** A free-text list (skills gaps, at-risk knowledge), cleaned and capped. */
function cleanList(raw) {
  const items = Array.isArray(raw) ? raw : String(raw || "").split("\n");
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const text = str(item).slice(0, MAX_TEXT);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= MAX_LIST_ITEMS) break;
  }
  return out;
}

export function cleanRole(raw, index = 0) {
  const role = raw && typeof raw === "object" ? raw : {};
  return {
    id: str(role.id) || `role-${index + 1}-${crypto.randomUUID().slice(0, 8)}`,
    name: str(role.name).slice(0, MAX_TEXT),
    // Section two: current employment.
    headcount: count(role.headcount),
    avgYearsExperience: years(role.avgYearsExperience),
    skillsGaps: cleanList(role.skillsGaps),
    // Section three: retirement risk.
    retirementEligible5y: count(role.retirementEligible5y),
    atRiskSkills: cleanList(role.atRiskSkills),
    // Section four: current vacancies.
    vacancies: count(role.vacancies),
    anticipatedNewRoles3y: count(role.anticipatedNewRoles3y),
    hiringDifficulty: DIFFICULTY.includes(str(role.hiringDifficulty))
      ? str(role.hiringDifficulty) : "medium",
  };
}

/** The apprentice plan: a non-negative whole number per role per year 1..5. */
export function cleanPlan(raw, roles) {
  const plan = Object.create(null);
  const source = raw && typeof raw === "object" ? raw : {};
  for (const role of roles) {
    const given = Object.prototype.hasOwnProperty.call(source, role.id) ? source[role.id] : null;
    const list = Array.isArray(given) ? given : [];
    plan[role.id] = Array.from({ length: PLAN_YEARS }, (_, i) => count(list[i], 500));
  }
  return plan;
}

/* ---------------------------------------------------------------- the maths ---- */

/**
 * How often each item was named across roles, most common first.
 *
 * Counted case-insensitively so "Blueprint reading" and "blueprint reading" are the same
 * gap. It is reported with whichever spelling was used most; on a tie, the one written
 * first, because a Map keeps insertion order and locale collation does not agree with
 * itself about whether a capital sorts before a lower case letter.
 */
function topMentions(entries, limit) {
  const byKey = new Map();
  for (const { text, role } of entries) {
    const key = text.toLowerCase();
    const at = byKey.get(key) || { spellings: new Map(), roles: new Set() };
    at.spellings.set(text, (at.spellings.get(text) || 0) + 1);
    at.roles.add(role);
    byKey.set(key, at);
  }
  return [...byKey.values()]
    .map((at) => {
      const best = [...at.spellings.entries()].sort((a, b) => b[1] - a[1])[0];
      return { text: best[0], count: at.roles.size, roles: [...at.roles].sort() };
    })
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, limit);
}

const round = (n) => Math.round(n);

/**
 * Everything the summary screens show, computed from the roles alone.
 *
 * The three-year retirement figure is three fifths of the five-year one, rounded PER ROLE
 * rather than on the total: every row of the by-role table then reads as a whole person,
 * and the total is the sum of those rows, so the table adds up to the headline. Rounding
 * the total instead would leave the rows not summing to it.
 */
export function summarise(roles) {
  const byRole = roles.map((role) => {
    const retire3y = round((role.retirementEligible5y * 3) / PLAN_YEARS);
    return {
      id: role.id,
      name: role.name,
      headcount: role.headcount,
      avgYearsExperience: role.avgYearsExperience,
      skillsGaps: role.skillsGaps,
      retirementEligible5y: role.retirementEligible5y,
      atRiskSkills: role.atRiskSkills,
      vacancies: role.vacancies,
      anticipatedNewRoles3y: role.anticipatedNewRoles3y,
      hiringDifficulty: role.hiringDifficulty,
      retire3y,
      // The gap this one role is carrying, on the same three horizons as the totals.
      gapNow: role.vacancies,
      gap3y: role.vacancies + retire3y,
      gap5y: role.vacancies + role.retirementEligible5y,
    };
  });

  const sum = (key) => byRole.reduce((n, r) => n + r[key], 0);
  const headcount = sum("headcount");
  // Weighted by headcount: a 40-person role with 12 years' experience and a 2-person role
  // with 1 year do not average to 6.5 for the workforce.
  const weightedYears = byRole.reduce((n, r) => n + r.avgYearsExperience * r.headcount, 0);

  return {
    roles: byRole,
    workforce: {
      roleCount: byRole.length,
      headcount,
      avgYearsExperience: headcount ? Math.round((weightedYears / headcount) * 10) / 10 : 0,
      topSkillsGaps: topMentions(
        byRole.flatMap((r) => r.skillsGaps.map((text) => ({ text, role: r.name }))), 3),
    },
    retirement: {
      eligible5y: sum("retirementEligible5y"),
      eligible3y: sum("retire3y"),
      byRole: byRole.filter((r) => r.retirementEligible5y > 0)
        .map((r) => ({ name: r.name, eligible5y: r.retirementEligible5y, retire3y: r.retire3y }))
        .sort((a, b) => b.eligible5y - a.eligible5y || a.name.localeCompare(b.name)),
      topAtRisk: topMentions(
        byRole.flatMap((r) => r.atRiskSkills.map((text) => ({ text, role: r.name }))), 5),
    },
    gap: {
      now: sum("vacancies"),
      // The employer's own formula: vacancies plus three fifths of the retirement risk.
      // Anticipated new roles are reported beside it rather than folded in, because they
      // were not in that formula and quietly adding them would change the number the
      // employer expects to see.
      threeYear: sum("vacancies") + sum("retire3y"),
      fiveYear: sum("vacancies") + sum("retirementEligible5y"),
      anticipatedNewRoles3y: sum("anticipatedNewRoles3y"),
      hardToFillRoles: byRole.filter((r) => r.hiringDifficulty === "high").map((r) => r.name),
    },
  };
}

/**
 * The apprentice plan against the gap.
 *
 * A cohort started in year Y is in training through year Y + 1 and counts as a full-time
 * employee from year Y + 2 -- so year one's apprentices are staff by year three. That is
 * the only assumption here, and it is stated on the page.
 *
 * Apprentices still in training are reported separately from those who have qualified,
 * and never added into the filled figure: someone two years off qualifying is not filling
 * a vacancy, and showing them as though they were would be the one number in this tool an
 * employer could be misled by.
 */
export function projectApprentices(summary, plan) {
  const roles = summary.roles;
  const startedIn = Array.from({ length: PLAN_YEARS }, (_, i) =>
    roles.reduce((n, role) => n + ((plan[role.id] || [])[i] || 0), 0));

  const timeline = Array.from({ length: PLAN_YEARS }, (_, i) => {
    const year = i + 1;
    let inTraining = 0;
    let qualified = 0;
    for (let started = 1; started <= year; started++) {
      const cohort = startedIn[started - 1];
      if (year - started >= TRAINING_YEARS) qualified += cohort;
      else inTraining += cohort;
    }
    return { year, started: startedIn[i], inTraining, qualified };
  });

  const at = (year) => timeline[year - 1];
  const total = startedIn.reduce((n, x) => n + x, 0);

  return {
    perRole: roles.map((role) => ({
      id: role.id,
      name: role.name,
      byYear: (plan[role.id] || []).slice(),
      total: (plan[role.id] || []).reduce((n, x) => n + x, 0),
      gap5y: role.gap5y,
    })),
    timeline,
    total,
    // One active mentor per one to two apprentices, per the guidance on the page. The
    // ceiling is what an employer has to staff, so it is the number shown.
    mentorsNeeded: Math.ceil(timeline.reduce((n, y) => Math.max(n, y.inTraining), 0) / 2),
    peakInTraining: timeline.reduce((n, y) => Math.max(n, y.inTraining), 0),
    coverage: {
      threeYear: cover(summary.gap.threeYear, at(3)),
      fiveYear: cover(summary.gap.fiveYear, at(5)),
    },
  };
}

function cover(gap, year) {
  const filled = Math.min(gap, year.qualified);
  return {
    gap,
    qualified: year.qualified,
    // Counted toward the gap only as far as the gap goes -- more qualified apprentices
    // than vacancies is growth, not coverage, and showing 140% filled would be nonsense.
    filled,
    inTraining: year.inTraining,
    remaining: Math.max(0, gap - filled),
    percent: gap ? Math.round((filled / gap) * 1000) / 10 : 0,
  };
}

/* ---------------------------------------------------------------- storage ---- */

export const workforceKey = (accountId, surveyId) =>
  `${WORKFORCE_PREFIX}${accountId}:${surveyId}`;

export async function getWorkforce(env, accountId, surveyId) {
  const raw = await env.BOX_KV.get(workforceKey(accountId, surveyId));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

export function emptyWorkforce(accountId, survey) {
  return {
    accountId,
    surveyId: survey.id,
    projectId: survey.projectId,
    surveyName: survey.name,
    roles: [],
    plan: Object.create(null),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    submittedAt: null,
  };
}

export async function saveWorkforce(env, doc) {
  doc.updatedAt = new Date().toISOString();
  await env.BOX_KV.put(workforceKey(doc.accountId, doc.surveyId), JSON.stringify(doc));
  return doc;
}

/** Roles capped: the form is per-role and a runaway list is a mistake, not a workforce. */
export function cleanRoles(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, MAX_ROLES)
    .map((role, i) => cleanRole(role, i))
    .filter((role) => role.name);
}

/* ---------------------------------------------------------------- CSV for Box ---- */

function csvField(value) {
  const s = String(value == null ? "" : value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** One row per role, plus the apprentice plan, flat enough to open in a spreadsheet. */
export function workforceCsv(doc, summary, projection) {
  const header = ["Role", "Headcount", "Avg years experience", "Skills gaps",
    "Eligible to retire (5y)", "At-risk skills/knowledge", "Vacancies",
    "Anticipated new roles (3y)", "Hiring difficulty",
    "Gap now", "Gap 3y", "Gap 5y",
    "Apprentices Y1", "Y2", "Y3", "Y4", "Y5"];
  const rows = [header.map(csvField).join(",")];
  for (const role of summary.roles) {
    const planned = (doc.plan && doc.plan[role.id]) || [];
    rows.push([
      role.name, role.headcount, role.avgYearsExperience, role.skillsGaps.join("; "),
      role.retirementEligible5y, role.atRiskSkills.join("; "), role.vacancies,
      role.anticipatedNewRoles3y, role.hiringDifficulty,
      role.gapNow, role.gap3y, role.gap5y,
      planned[0] || 0, planned[1] || 0, planned[2] || 0, planned[3] || 0, planned[4] || 0,
    ].map(csvField).join(","));
  }
  rows.push("");
  rows.push(["TOTAL", summary.workforce.headcount, summary.workforce.avgYearsExperience, "",
    summary.retirement.eligible5y, "", summary.gap.now, summary.gap.anticipatedNewRoles3y, "",
    summary.gap.now, summary.gap.threeYear, summary.gap.fiveYear,
    ...projection.timeline.map((y) => y.started)].map(csvField).join(","));
  return rows.join("\n") + "\n";
}
