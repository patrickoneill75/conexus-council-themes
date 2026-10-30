/**
 * Salary Allocation, mounted under /api/salary-allocation/*.
 *
 * Operations keeps the lists: projects (each funded c3 or c6), positions, teams, people (name, email,
 * position, team, and who they report to, which draws the org chart) and holidays. A project or position can be made inactive: it stays on anyone who has it, and is no
 * longer offered for a new allocation or a new person. Each person's allocation says what percent of their salary each project pays, and when
 * it starts: a person has a list of { from: "YYYY-MM", lines }, and a month uses the latest entry that
 * starts on or before it. So an allocation can be planned for a future month, and a month already past
 * keeps the split it had when the allocation changes later.
 *
 * Staff see only their own allocation, matched by the email they sign in with (the same sign-in as
 * Partner Intelligence; see src/beta_auth.js). They enter the month's hours (worked, PTO, holiday or
 * other) on a calendar, and the page splits the worked hours across their projects and suggests a
 * possible schedule (public/salary-allocation/sa-calc.js). Their month is saved as they go. Staff do not
 * submit time here: that is another tool.
 *
 * Who can do what: anyone signed in whose email is on the people list reaches their own month. The
 * control panel and every "admin/..." route need admin of "salary-allocation", given in Connector
 * Settings (overall admins have it).
 *
 * Storage (BOX_KV):
 *   sa:data                     -> { projects, positions, teams, people, holidays }. people[].allocations holds
 *                                  the dated entries. Small enough to read and write whole.
 *   sa:month:<personId>:<YYYY-MM> -> { days: { "<day>": [worked, pto, other] }, hours: { <projectId>: n } | null,
 *                                  savedAt }. Weekdays only; hours is null until the person edits the split.
 */
import { requireBetaAuth, canAdminApp, NO_SETTINGS_ACCESS } from "./beta_auth.js";
import { xlsxRows, parseCsv } from "./partner_intel.js";

export const APP_ID = "salary-allocation";
const DATA_KEY = "sa:data";
const monthKey = (personId, month) => `sa:month:${personId}:${month}`;
const NOT_LISTED = "You aren't on the Salary Allocation list yet. Ask Operations to add you.";
const SIGN_IN = "Sign in first.";
// An import with no start month applies from the beginning, so every month already entered keeps it.
const FROM_ALWAYS = "0000-01";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
const text = (v) => (v == null ? "" : String(v)).trim();
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 12);
export const isMonth = (m) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(m));
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)) && !isNaN(Date.parse(String(d) + "T00:00:00Z"));
const normalizeEmail = (v) => text(v).toLowerCase();
const round2 = (n) => Math.round(n * 100) / 100;

async function readBody(request) {
  try { const b = await request.json(); return b && typeof b === "object" && !Array.isArray(b) ? b : {}; } catch { return {}; }
}

/* ---------------------------------------------------------------------------- holidays */

/**
 * The U.S. federal holidays for a year, on the days the government observes them: one on a Saturday
 * moves to the Friday before, one on a Sunday to the Monday after (5 U.S.C. 6103).
 */
export function federalHolidays(year) {
  const at = (m, day) => new Date(Date.UTC(year, m, day));
  const nth = (m, weekday, n) => at(m, 1 + ((weekday - at(m, 1).getUTCDay() + 7) % 7) + 7 * (n - 1));
  const lastOf = (m, weekday) => { const end = at(m + 1, 0); return at(m, end.getUTCDate() - ((end.getUTCDay() - weekday + 7) % 7)); };
  const iso = (d) => d.toISOString().slice(0, 10);
  const fixed = (date, name) => {
    const w = date.getUTCDay();
    if (w === 6) return { name: `${name} (observed)`, date: iso(new Date(date.getTime() - 86400000)) };
    if (w === 0) return { name: `${name} (observed)`, date: iso(new Date(date.getTime() + 86400000)) };
    return { name, date: iso(date) };
  };
  return [
    fixed(at(0, 1), "New Year's Day"),
    { name: "Martin Luther King Jr. Day", date: iso(nth(0, 1, 3)) },
    { name: "Washington's Birthday", date: iso(nth(1, 1, 3)) },
    { name: "Memorial Day", date: iso(lastOf(4, 1)) },
    fixed(at(5, 19), "Juneteenth"),
    fixed(at(6, 4), "Independence Day"),
    { name: "Labor Day", date: iso(nth(8, 1, 1)) },
    { name: "Columbus Day", date: iso(nth(9, 1, 2)) },
    fixed(at(10, 11), "Veterans Day"),
    { name: "Thanksgiving Day", date: iso(nth(10, 4, 4)) },
    fixed(at(11, 25), "Christmas Day"),
  ];
}

/**
 * Last year's holidays carried into a year. A federal holiday moves by its rule (Thanksgiving is the fourth
 * Thursday, a Saturday holiday is observed the Friday before). A day next to a federal holiday stays next
 * to it, so the day after Thanksgiving is still a Friday. Any other keeps its month and day. A range keeps
 * its length. A date that already has a holiday is left alone. Returns the holidays to add.
 */
export function copyHolidays(holidays, year) {
  const DAY = 86400000;
  const base = (name) => name.replace(/ \(observed\)$/, "");
  const iso = (t) => new Date(t).toISOString().slice(0, 10);
  const at = (date) => Date.parse(date + "T00:00:00Z");
  const lastFed = new Map(federalHolidays(year - 1).map((h) => [h.date, base(h.name)]));
  const nextFed = new Map(federalHolidays(year).map((h) => [base(h.name), h]));
  const taken = new Set(holidays.map((h) => h.start));
  const out = [];
  for (const h of holidays.filter((x) => x.start.slice(0, 4) === String(year - 1))) {
    let start, name = h.name;
    const fed = lastFed.get(h.start) && nextFed.get(lastFed.get(h.start));
    const off = [1, -1].find((d) => lastFed.has(iso(at(h.start) - d * DAY)) && nextFed.get(lastFed.get(iso(at(h.start) - d * DAY))));
    if (fed) { start = fed.date; if (base(h.name) === base(fed.name)) name = fed.name; }
    else if (off) start = iso(at(nextFed.get(lastFed.get(iso(at(h.start) - off * DAY))).date) + off * DAY);
    else {
      start = `${year}${h.start.slice(4)}`;
      if (iso(at(start)).slice(5) !== h.start.slice(5)) continue; // February 29 in a year without one
    }
    if (taken.has(start)) continue;
    const end = h.end ? iso(at(start) + (at(h.end) - at(h.start))) : "";
    taken.add(start);
    out.push({ name, start, end });
  }
  return out;
}

/** The weekday holidays falling in a month, one per date: [{ date: "YYYY-MM-DD", name }]. */
export function holidaysInMonth(holidays, month) {
  const out = [], seen = new Set();
  for (const h of holidays) {
    const end = h.end && h.end > h.start ? h.end : h.start;
    for (let t = new Date(h.start + "T00:00:00Z"); t <= new Date(end + "T00:00:00Z"); t = new Date(t.getTime() + 86400000)) {
      const date = t.toISOString().slice(0, 10), w = t.getUTCDay();
      if (date.slice(0, 7) !== month || w === 0 || w === 6 || seen.has(date)) continue;
      seen.add(date);
      out.push({ date, name: h.name });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/* ---------------------------------------------------------------------------- the lists */

export const STARTING_TEAMS = ["Talent", "Tech Adoption", "Thought Leadership", "Operations"];
const startingTeams = () => STARTING_TEAMS.map((name) => ({ id: newId(), name }));

/** Why someone can't report to managerId, or "" when they can. Nobody reports to themselves, or to someone
 * who reports up to them. */
function managerProblem(data, id, managerId) {
  if (!managerId) return "";
  if (!data.people.some((p) => p.id === managerId)) return "The person they report to is no longer on the list.";
  for (let at = managerId, steps = 0; at && steps <= data.people.length; steps++) {
    if (at === id) return "They can't report to themselves or to someone who reports to them.";
    at = (data.people.find((p) => p.id === at) || {}).managerId;
  }
  return "";
}

async function loadData(env) {
  const raw = await env.BOX_KV.get(DATA_KEY);
  if (raw) {
    let data = null;
    try { data = JSON.parse(raw); } catch { /* a damaged record is replaced below */ }
    if (data) {
      // Lists kept before teams existed get the starting teams.
      if (!Array.isArray(data.teams)) { data.teams = startingTeams(); await saveData(env, data); }
      return data;
    }
  }
  // First use: the federal holidays for this year and next, so the calendar is right from the start.
  const year = new Date().getUTCFullYear();
  const holidays = [...federalHolidays(year), ...federalHolidays(year + 1)].map((h) => ({ id: newId(), name: h.name, start: h.date, end: "" }));
  const data = { projects: [], positions: [], teams: startingTeams(), people: [], holidays };
  await saveData(env, data);
  return data;
}
const saveData = (env, data) => env.BOX_KV.put(DATA_KEY, JSON.stringify(data));

/** The allocation entry in force for a month: the latest that starts on or before it, or null. */
export function allocationFor(person, month) {
  let best = null;
  for (const a of person.allocations || []) if (a.from <= month && (!best || a.from > best.from)) best = a;
  return best;
}

const personName = (p) => `${p.first} ${p.last}`.trim() || "Open position";

/** First initial and last name, letters only, at conexusindiana.com: Kelsey O'Shaughnessy is koshaughnessy@... */
export function guessEmail(first, last) {
  const f = text(first).toLowerCase().replace(/[^a-z]/g, ""), l = text(last).toLowerCase().replace(/[^a-z]/g, "");
  return f && l ? `${f[0]}${l}@conexusindiana.com` : "";
}

function cleanLines(data, lines, had = new Set()) {
  if (!Array.isArray(lines)) return { error: "The allocation must be a list of projects and percents." };
  const known = new Set(data.projects.filter((p) => p.active !== false || had.has(p.id)).map((p) => p.id));
  const out = [], seen = new Set();
  for (const l of lines) {
    if (!l || typeof l !== "object") return { error: "Each allocation line needs a project and a percent." };
    const projectId = text(l.projectId), pct = Number(l.pct);
    if (!known.has(projectId)) return { error: "One of the projects is inactive or no longer on the list." };
    if (!isFinite(pct) || pct < 0 || pct > 100) return { error: "A percent must be between 0 and 100." };
    if (seen.has(projectId)) return { error: "A project is listed twice." };
    seen.add(projectId);
    if (pct > 0) out.push({ projectId, pct: round2(pct) });
  }
  return { lines: out };
}

/** Set a person's allocation from a month on. An entry starting that month is replaced; later ones stay. */
function setAllocation(person, from, lines) {
  person.allocations = (person.allocations || []).filter((a) => a.from !== from).concat([{ from, lines }])
    .sort((a, b) => a.from.localeCompare(b.from));
}

/* ---------------------------------------------------------------------------- import */

const HEADERS = { position: ["position", "title"], first: ["first"], last: ["last"], project: ["project"],
  pct: ["allocation", "percent", "%"], type: ["funding", "type"] };

/**
 * Rows from the allocation spreadsheet (Position, First, Last, Project, Allocation, Funding Type) into the
 * lists. Allocation is a fraction (0.5) or a percent (50). A row with no name is an open position. Each
 * person found gets the imported split from the beginning; anyone not in the file is left alone.
 */
export function applyImport(data, rows) {
  const head = (rows[0] || []).map((h) => text(h).toLowerCase());
  const col = {};
  for (const [key, names] of Object.entries(HEADERS)) col[key] = head.findIndex((h) => names.some((n) => h.includes(n)));
  if (col.project < 0 || col.pct < 0 || (col.first < 0 && col.last < 0)) {
    return { error: "The first row needs headings: Position, First, Last, Project, Allocation and Funding Type." };
  }
  const cell = (r, k) => (col[k] >= 0 ? text(r[col[k]]) : "");
  const fractions = rows.slice(1).every((r) => !cell(r, "pct") || Number(cell(r, "pct")) <= 1);
  const found = new Map();
  const counts = { people: 0, projects: 0, positions: 0, skipped: 0 };
  for (const r of rows.slice(1)) {
    const project = cell(r, "project"), raw = Number(cell(r, "pct"));
    if (!project || !isFinite(raw)) { counts.skipped++; continue; }
    let proj = data.projects.find((p) => p.name.toLowerCase() === project.toLowerCase());
    const type = /c6/i.test(cell(r, "type")) ? "c6" : "c3";
    if (!proj) { proj = { id: newId(), name: project, type, active: true }; data.projects.push(proj); counts.projects++; }
    const title = cell(r, "position") || "No title";
    let pos = data.positions.find((p) => p.title.toLowerCase() === title.toLowerCase());
    if (!pos) { pos = { id: newId(), title, active: true }; data.positions.push(pos); counts.positions++; }
    let first = cell(r, "first"), last = cell(r, "last");
    if (/^open$/i.test(first) && !last) first = ""; // the spreadsheet marks a vacancy "Open"
    const key = first || last ? `${first}|${last}`.toLowerCase() : `open|${pos.id}`;
    let person = found.get(key);
    if (!person) {
      person = data.people.find((p) => (first || last ? `${p.first}|${p.last}`.toLowerCase() === key : !p.first && !p.last && p.positionId === pos.id));
      if (!person) {
        person = { id: newId(), first, last, email: guessEmail(first, last), positionId: pos.id, allocations: [] };
        data.people.push(person);
      }
      person.positionId = pos.id;
      found.set(key, { person, lines: [] });
      counts.people++;
    }
    const pct = fractions ? raw * 100 : raw;
    if (pct > 0) found.get(key).lines.push({ projectId: proj.id, pct: round2(pct) });
  }
  for (const { person, lines } of found.values()) setAllocation(person, FROM_ALWAYS, lines);
  return { counts };
}

/* ---------------------------------------------------------------------------- staff month */

const weekday = (month, day) => { const w = new Date(`${month}-${String(day).padStart(2, "0")}T00:00:00Z`).getUTCDay(); return w > 0 && w < 6; };
const daysIn = (month) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate();
const hours = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 && n <= 24 ? n : null; };

/** A month as the person entered it: weekdays only, whole hours, at most 24 in a day. */
function cleanMonth(month, body, lines) {
  const days = {};
  const given = body.days && typeof body.days === "object" ? body.days : {};
  for (let d = 1; d <= daysIn(month); d++) {
    if (!weekday(month, d) || !hasOwn(given, String(d))) continue;
    const v = given[String(d)];
    const [w, p, o] = Array.isArray(v) ? v.map(hours) : [null];
    if (w === null || p === null || o === null || w + p + o > 24) return { error: `Day ${d} needs whole hours, 24 at most.` };
    days[String(d)] = [w, p, o];
  }
  let split = null;
  if (body.hours && typeof body.hours === "object") {
    split = {};
    for (const l of lines) {
      if (!hasOwn(body.hours, l.projectId)) continue;
      const h = Number(body.hours[l.projectId]);
      if (!Number.isInteger(h) || h < 0 || h > 744) return { error: "Project hours must be whole numbers." };
      split[l.projectId] = h;
    }
  }
  return { record: { days, hours: split, savedAt: new Date().toISOString() } };
}

function myView(data, person, month, saved, isAdmin) {
  const byId = new Map(data.projects.map((p) => [p.id, p]));
  const entry = allocationFor(person, month);
  const allocation = (entry ? entry.lines : []).filter((l) => byId.has(l.projectId))
    .map((l) => ({ projectId: l.projectId, name: byId.get(l.projectId).name, type: byId.get(l.projectId).type, pct: l.pct }));
  const position = data.positions.find((p) => p.id === person.positionId);
  return {
    person: { name: personName(person), email: person.email, position: position ? position.title : "" },
    month, allocation, holidays: holidaysInMonth(data.holidays, month), saved, isAdmin,
  };
}

/* ---------------------------------------------------------------------------- the router */

export async function handleSalaryAllocationApi(route, request, env) {
  const auth = await requireBetaAuth(request, env);
  if (!auth) return json({ error: SIGN_IN }, 401);
  const isAdmin = canAdminApp(auth, APP_ID);
  const method = request.method;
  const url = new URL(request.url);

  if (route === "me" && method === "GET") {
    const data = await loadData(env);
    const month = isMonth(url.searchParams.get("month")) ? url.searchParams.get("month") : new Date().toISOString().slice(0, 7);
    const person = data.people.find((p) => p.email && p.email === normalizeEmail(auth.email));
    if (!person) return json({ error: NOT_LISTED, isAdmin }, 403);
    const saved = await env.BOX_KV.get(monthKey(person.id, month));
    return json(myView(data, person, month, saved ? JSON.parse(saved) : null, isAdmin));
  }

  if (route === "month" && method === "POST") {
    const body = await readBody(request);
    const month = text(body.month);
    if (!isMonth(month)) return json({ error: "Pick a month." }, 400);
    const data = await loadData(env);
    const person = data.people.find((p) => p.email && p.email === normalizeEmail(auth.email));
    if (!person) return json({ error: NOT_LISTED }, 403);
    const entry = allocationFor(person, month);
    const cleaned = cleanMonth(month, body, entry ? entry.lines : []);
    if (cleaned.error) return json({ error: cleaned.error }, 400);
    await env.BOX_KV.put(monthKey(person.id, month), JSON.stringify(cleaned.record));
    return json({ ok: true, savedAt: cleaned.record.savedAt });
  }

  if (!route.startsWith("admin/")) return json({ error: "Not found." }, 404);
  if (!isAdmin) return json({ error: NO_SETTINGS_ACCESS }, 403);
  const data = await loadData(env);
  const done = async () => { await saveData(env, data); return json({ ok: true, data }); };

  if (route === "admin/data" && method === "GET") return json({ data });
  if (method !== "POST") return json({ error: "Not found." }, 404);

  if (route === "admin/import") {
    const name = text(url.searchParams.get("name")).toLowerCase();
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length) return json({ error: "Choose a .xlsx or .csv file." }, 400);
    let rows;
    try { rows = name.endsWith(".csv") ? parseCsv(new TextDecoder().decode(bytes)) : await xlsxRows(bytes); } catch (e) { return json({ error: e.message }, 400); }
    const result = applyImport(data, rows);
    if (result.error) return json({ error: result.error }, 400);
    await saveData(env, data);
    return json({ ok: true, counts: result.counts, data });
  }

  const body = await readBody(request);
  const id = text(body.id);
  const find = (list) => list.find((x) => x.id === id);

  if (route === "admin/project") {
    const name = text(body.name), type = text(body.type), active = body.active !== false;
    if (!name || name.length > 120) return json({ error: "Give the project a name." }, 400);
    if (type !== "c3" && type !== "c6") return json({ error: "Choose c3 or c6." }, 400);
    if (data.projects.some((p) => p.id !== id && p.name.toLowerCase() === name.toLowerCase())) return json({ error: "There is already a project with that name." }, 409);
    const p = id ? find(data.projects) : null;
    if (id && !p) return json({ error: "That project is no longer on the list." }, 404);
    if (p) Object.assign(p, { name, type, active }); else data.projects.push({ id: newId(), name, type, active });
    return done();
  }
  if (route === "admin/project/delete") {
    const used = data.people.filter((p) => (p.allocations || []).some((a) => a.lines.some((l) => l.projectId === id)));
    if (used.length) return json({ error: `${used.length === 1 ? "1 person has" : used.length + " people have"} this project in an allocation, now or in an earlier month. Take it off their allocations first.` }, 409);
    data.projects = data.projects.filter((p) => p.id !== id);
    return done();
  }
  if (route === "admin/position") {
    const title = text(body.title), active = body.active !== false;
    if (!title || title.length > 120) return json({ error: "Give the position a title." }, 400);
    if (data.positions.some((p) => p.id !== id && p.title.toLowerCase() === title.toLowerCase())) return json({ error: "That title is already on the list." }, 409);
    const p = id ? find(data.positions) : null;
    if (id && !p) return json({ error: "That position is no longer on the list." }, 404);
    if (p) Object.assign(p, { title, active }); else data.positions.push({ id: newId(), title, active });
    return done();
  }
  if (route === "admin/position/delete") {
    if (data.people.some((p) => p.positionId === id)) return json({ error: "Someone holds this title. Give them another title first." }, 409);
    data.positions = data.positions.filter((p) => p.id !== id);
    return done();
  }
  if (route === "admin/person") {
    const first = text(body.first), last = text(body.last), positionId = text(body.positionId);
    const teamId = text(body.teamId), managerId = text(body.managerId);
    if (teamId && !data.teams.some((t) => t.id === teamId)) return json({ error: "That team is no longer on the list." }, 400);
    const bad = managerProblem(data, id, managerId);
    if (bad) return json({ error: bad }, 400);
    let email = normalizeEmail(body.email);
    if (first.length > 60 || last.length > 60) return json({ error: "That name is too long." }, 400);
    const pos = data.positions.find((p) => p.id === positionId);
    const before = id ? data.people.find((p) => p.id === id) : null;
    if (!pos) return json({ error: "Choose a position." }, 400);
    if (pos.active === false && !(before && before.positionId === positionId)) return json({ error: "That position is inactive. Make it active first, or choose another." }, 400);
    if (!first && !last) email = ""; // an open position signs in as no one
    else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "Enter an email they can sign in with." }, 400);
    if (email && data.people.some((p) => p.id !== id && p.email === email)) return json({ error: "Someone else already has that email." }, 409);
    const p = id ? find(data.people) : null;
    if (id && !p) return json({ error: "That person is no longer on the list." }, 404);
    if (p) Object.assign(p, { first, last, email, positionId, teamId, managerId });
    else data.people.push({ id: newId(), first, last, email, positionId, teamId, managerId, allocations: [] });
    return done();
  }
  if (route === "admin/reports-to") {
    // Dragging a card on the org chart: only who they report to changes.
    const p = id ? find(data.people) : null;
    if (!p) return json({ error: "That person is no longer on the list." }, 404);
    const managerId = text(body.managerId), bad = managerProblem(data, id, managerId);
    if (bad) return json({ error: bad }, 400);
    p.managerId = managerId;
    return done();
  }
  if (route === "admin/person/delete") {
    const gone = data.people.find((p) => p.id === id);
    data.people = data.people.filter((p) => p.id !== id);
    // Whoever reported to them now reports to their manager.
    for (const p of data.people) if (p.managerId === id) p.managerId = gone ? gone.managerId || "" : "";
    return done();
  }
  if (route === "admin/allocation") {
    const person = data.people.find((p) => p.id === text(body.personId));
    if (!person) return json({ error: "That person is no longer on the list." }, 404);
    const from = text(body.from);
    if (!isMonth(from)) return json({ error: "Choose the month it starts." }, 400);
    const had = new Set((person.allocations || []).flatMap((a) => a.lines.map((l) => l.projectId)));
    const cleaned = cleanLines(data, body.lines, had);
    if (cleaned.error) return json({ error: cleaned.error }, 400);
    setAllocation(person, from, cleaned.lines);
    return done();
  }
  if (route === "admin/holiday") {
    const name = text(body.name), start = text(body.start), end = text(body.end);
    if (!name || name.length > 80) return json({ error: "Give the holiday a name." }, 400);
    if (!isDate(start)) return json({ error: "Choose the date." }, 400);
    if (end && (!isDate(end) || end < start)) return json({ error: "The Through date must be on or after the date." }, 400);
    if (end && (Date.parse(end) - Date.parse(start)) / 86400000 > 31) return json({ error: "A holiday can span a month at most." }, 400);
    const h = id ? find(data.holidays) : null;
    if (id && !h) return json({ error: "That holiday is no longer on the list." }, 404);
    const rec = { name, start, end: end && end > start ? end : "" };
    if (h) Object.assign(h, rec); else data.holidays.push({ id: newId(), ...rec });
    return done();
  }
  if (route === "admin/holiday/delete") {
    data.holidays = data.holidays.filter((h) => h.id !== id);
    return done();
  }
  if (route === "admin/holidays/copy") {
    const year = Number(body.year);
    if (!Number.isInteger(year) || year < 2001 || year > 2100) return json({ error: "Choose a year." }, 400);
    const add = copyHolidays(data.holidays, year);
    data.holidays.push(...add.map((h) => ({ id: newId(), ...h })));
    await saveData(env, data);
    return json({ ok: true, added: add.length, data });
  }
  if (route === "admin/team") {
    const name = text(body.name);
    if (!name || name.length > 80) return json({ error: "Give the team a name." }, 400);
    if (data.teams.some((t) => t.id !== id && t.name.toLowerCase() === name.toLowerCase())) return json({ error: "There is already a team with that name." }, 409);
    const t = id ? find(data.teams) : null;
    if (id && !t) return json({ error: "That team is no longer on the list." }, 404);
    if (t) t.name = name; else data.teams.push({ id: newId(), name });
    return done();
  }
  if (route === "admin/team/delete") {
    if (data.people.some((p) => p.teamId === id)) return json({ error: "People are on this team. Move them to another team first." }, 409);
    data.teams = data.teams.filter((t) => t.id !== id);
    return done();
  }
  return json({ error: "Not found." }, 404);
}
