/**
 * Consensus: a mini app for chatbot-style surveys with Claude-generated follow-up
 * questions, mounted under /api/consensus/*.
 *
 * Admin routes (survey builder, analyze) reuse Connector's shared admin accounts
 * (see src/beta_auth.js's requireBetaAuth) rather than inventing another login
 * system, and need a consensus app admin or an overall admin (canAdminApp).
 * Respondent-facing routes are public, matching this survey's whole point:
 * anyone with the link answers it, no account needed.
 *
 * Storage:
 *   consensus:survey:<id> -> the survey definition (JSON) -- see buildSurvey() below
 *     for the exact shape. Listed via BOX_KV's list({prefix}), not a separate index
 *     key, so there's nothing to keep in sync.
 *   consensus:draft:<id>:<token> -> a respondent's unfinished answers, saved after every
 *     question so they can stop and come back (see cleanDraft()). The token is a random
 *     id the respond page keeps in the browser and in its "finish later" link. Kept for
 *     DRAFT_TTL_DAYS, deleted when the survey is submitted.
 *
 * Where things live:
 *   - Survey definitions: Workers KV (BOX_KV, same namespace beta_auth.js and the Box
 *     connection already use, under a "consensus:" prefix) -- small, admin-edited,
 *     mutable config, the same shape of data beta_auth.js's admin list already is.
 *   - Raw responses: one CSV per survey, in the Box folder the admin picked for it,
 *     via the SAME Box connection and relay token the Council Survey Dashboard uses
 *     (GET /api/box/pipeline-token, GET /api/box/folders -- both reused as-is, no
 *     Consensus-specific Box plumbing needed).
 *   - Analysis output: committed to the repo as public/consensus-results/<id>.json by
 *     scripts/consensus_analyze.py (GitHub Actions), the same publish-a-static-JSON
 *     pattern council-themes.json and quant-dashboard.json already use. That script
 *     reaches this Worker's /api/consensus/relay/* routes (shared-secret auth, same
 *     x-pipeline-key mechanism as the Box relay) to read the survey definition and
 *     mark it analyzed once done.
 *
 * The one live (not batch) Claude call is the follow-up question generator
 * (POST /api/consensus/followup) -- it has to run synchronously while a respondent is
 * sitting in the chat waiting, so it can't be deferred to a GitHub Actions run the way
 * the batch analysis is. It's a single small request (Claude Haiku 4.5, no thinking,
 * a forced tool call for one short question), called with fetch() directly rather
 * than the Anthropic SDK -- this Worker has zero npm runtime dependencies today (Box
 * and GitHub are both called the same way), and one more for a single simple call
 * isn't worth the bundle risk. The batch analysis script, in GitHub Actions, uses the
 * real `anthropic` SDK like every other Claude call in this repo already does.
 */

import { requireBetaAuth, canAdminApp, NO_SETTINGS_ACCESS } from "./beta_auth.js";
import { parseCsv } from "./partner_intel.js";

const SURVEY_PREFIX = "consensus:survey:";
const PROGRESS_PREFIX = "consensus:progress:";
const DISPATCH_PREFIX = "consensus:dispatch:";
const DRAFT_PREFIX = "consensus:draft:";
const DRAFT_TTL_DAYS = 60;
const MAX_DRAFT_BYTES = 200_000;
const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_FOLLOW_UPS = 5; // guards against an admin fat-fingering a huge number and
                           // creating a runaway-length, runaway-cost chat.
const FOLLOWUP_MODEL = "claude-haiku-4-5"; // cheapest current model -- generating one
                                            // short follow-up question from a little
                                            // context is exactly the "simple,
                                            // high-volume" workload Haiku is for.

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function slugify(name) {
  return String(name || "").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "survey";
}

function surveyKey(id) {
  return `${SURVEY_PREFIX}${id}`;
}

async function getSurvey(env, id) {
  const raw = await env.BOX_KV.get(surveyKey(id));
  return raw ? JSON.parse(raw) : null;
}
async function saveSurvey(env, survey) {
  await env.BOX_KV.put(surveyKey(survey.id), JSON.stringify(survey));
}

/* ---------- rich question text ---------- */

// A question may carry formatting: bold, italic, underline, bullets and highlight. The
// editor sends HTML; only these tags survive, with no attributes, so nothing an admin
// pastes can run script on a respondent's page. Everything else reads the plain text
// (rich text's words, bullets as "- " lines): Claude's prompts, the CSV, the results.
const MAX_QUESTION_HTML = 20_000;
const RICH_TAG = Object.assign(Object.create(null), {
  b: "b", strong: "b", i: "i", em: "i", u: "u", ul: "ul", ol: "ul", li: "li",
  mark: "mark", br: "br", div: "div", p: "div",
});
const BLOCK = new Set(["div", "ul", "li"]);
const ENTITY = Object.assign(Object.create(null), { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " });

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    }
    return ENTITY[e.toLowerCase()] ?? m;
  });
}
const escapeText = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The editor highlights with <span style="background-color: ...">; a saved highlight is <mark>.
const HIGHLIGHT = /background(?:-color)?\s*:\s*(?!\s*(?:transparent|initial|inherit|unset|none|rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\))\s*[;"'])[^;"']*[^\s;"']/i;

export function richText(input) {
  const src = String(input || "").slice(0, MAX_QUESTION_HTML)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<(script|style|template|iframe|object|embed|head|title|svg|math|noscript|textarea|select)\b[\s\S]*?(?:<\/\1\s*>|$)/gi, "");
  const out = [];
  const open = []; // [{ key, tag }] -- tag is what was written, or "" for a span that is not a highlight
  const close = (i) => { while (open.length > i) { const t = open.pop().tag; if (t) out.push(`</${t}>`); } };
  const token = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)|</g;
  for (const m of src.matchAll(token)) {
    if (m[4] !== undefined) { out.push(escapeText(decodeEntities(m[4]))); continue; }
    if (!m[2]) { out.push("&lt;"); continue; }
    const name = m[2].toLowerCase();
    const key = name === "span" ? "span" : RICH_TAG[name];
    if (!key) continue;
    if (m[1]) {
      for (let i = open.length - 1; i >= 0; i--) if (open[i].key === key) { close(i); break; }
      continue;
    }
    if (key === "br") { out.push("<br>"); continue; }
    const tag = key === "span" ? (HIGHLIGHT.test(m[3]) ? "mark" : "") : key;
    if (tag) out.push(`<${tag}>`);
    open.push({ key, tag });
  }
  close(0);
  let html = out.join("");
  // Formatting with nothing inside it, and blank lines at the end, are noise.
  for (let before = ""; before !== html;) {
    before = html;
    html = html.replace(/<(b|i|u|mark|li|ul)><\/\1>/g, "").replace(/(?:<br>|<div>(?:<br>)?<\/div>|\s)+$/, "");
  }
  return plainText(html) ? html : "";
}

export function plainText(html) {
  const lines = [];
  let line = "";
  const end = () => { if (line.trim()) lines.push(line.replace(/\s+$/, "")); else if (lines.length && lines[lines.length - 1] !== "") lines.push(""); line = ""; };
  for (const m of String(html || "").matchAll(/<(\/?)([a-z]+)[^>]*>|([^<]+)/gi)) {
    if (m[3] !== undefined) { line += decodeEntities(m[3]).replace(/\u00a0/g, " "); continue; }
    const name = m[2].toLowerCase();
    if (name === "br") { if (line.trim()) end(); else lines.push(""); continue; }
    if (!BLOCK.has(name) && name !== "p" && name !== "ol") continue;
    if (line.trim()) end();
    else line = "";
    if (name === "li" && !m[1]) line = "- ";
  }
  if (line.trim() && line.trim() !== "-") lines.push(line.replace(/\s+$/, ""));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/* ---------- request body helpers ---------- */

function cleanQuestions(raw) {
  const cleaned = (Array.isArray(raw) ? raw : []).map((q, i) => {
    // personalizeFrom used to be a single id (string|null) -- accept that shape too so
    // any survey saved before it became multi-select still loads correctly.
    const rawPersonalize = q && q.personalizeFrom;
    const personalizeList = Array.isArray(rawPersonalize) ? rawPersonalize
      : (rawPersonalize ? [rawPersonalize] : []);
    // With formatting, the HTML decides the words, so the two can never disagree.
    const html = richText(q && q.html);
    return {
      id: (q && q.id) || `q${i + 1}-${crypto.randomUUID().slice(0, 8)}`,
      text: html ? plainText(html) : String((q && q.text) || "").trim(),
      html,
      followUps: Math.max(0, Math.min(MAX_FOLLOW_UPS, Number((q && q.followUps) || 0) | 0)),
      context: String((q && q.context) || "").trim(),
      personalizeFrom: [...new Set(personalizeList.map(String).filter(Boolean))],
      // Whether the batch analysis should spend Claude tokens synthesizing themes for
      // this question, or just list its raw answers in the results page's summary
      // table -- defaults to true so a survey saved before this existed keeps
      // analyzing everything, same as it always did.
      claudeAnalyze: !(q && q.claudeAnalyze === false),
    };
  }).filter((q) => q.text);
  // Every id in personalizeFrom must point at a DIFFERENT question that comes strictly
  // earlier in this same (post-filter, final-id) list -- never trust the client's
  // ordering or ids as-is, since ids can be stale from before a reorder/removal and a
  // forward or self-reference would have nothing to personalize from at respond-time.
  cleaned.forEach((q, i) => {
    if (!q.personalizeFrom.length) return;
    const earlierIds = new Set(cleaned.slice(0, i).map((earlier) => earlier.id));
    q.personalizeFrom = q.personalizeFrom.filter((id) => earlierIds.has(id));
  });
  return cleaned;
}

function buildSurvey(id, body, existing) {
  const now = new Date().toISOString();
  const name = String(body.name || "").trim() || "Untitled survey";
  return {
    id,
    name,
    objective: String(body.objective || "").trim(),
    audience: String(body.audience || "").trim(),
    generalGuidance: String(body.generalGuidance || "").trim(),
    questions: cleanQuestions(body.questions),
    boxFolderId: body.boxFolderId ? String(body.boxFolderId) : (existing ? existing.boxFolderId : null),
    boxFolderName: body.boxFolderName ? String(body.boxFolderName) : (existing ? existing.boxFolderName : null),
    responsesFileName: existing ? existing.responsesFileName
      : `${slugify(name)}-${id.slice(0, 8)}-responses.csv`,
    responseCount: existing ? existing.responseCount : 0,
    createdAt: existing ? existing.createdAt : now,
    updatedAt: now,
    analyzedAt: existing ? existing.analyzedAt : null,
    analyzedResponseCount: existing ? (existing.analyzedResponseCount || 0) : 0,
  };
}

/* ---------- CSV writing (append-only, this Worker's own rows only -- see module
   docstring for why a full parse/rewrite isn't needed here) ---------- */

const CSV_HEADER = "Response ID,Submitted At,Question ID,Question Text,Turn,Prompt,Answer\n";

function csvField(value) {
  const s = String(value == null ? "" : value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function responsesToCsvRows(responseId, submittedAt, responses) {
  const lines = [];
  for (const q of responses) {
    for (const t of q.turns || []) {
      lines.push([
        responseId, submittedAt, q.questionId, q.questionText, t.turn, t.prompt, t.answer,
      ].map(csvField).join(","));
    }
  }
  return lines.join("\n") + (lines.length ? "\n" : "");
}

/* ---------- Box (reuses the existing connection -- see box/status, box/folders,
   box/pipeline-token in worker.js; this module talks to the Box API directly with the
   same access-token helper shape rather than importing worker.js internals, to keep
   the two files independent) ---------- */

const BOX_API = "https://api.box.com/2.0";
const BOX_UPLOAD_API = "https://upload.box.com/api/2.0";

async function boxAccessToken(env) {
  const tokens = env.BOX_KV ? await env.BOX_KV.get("box:tokens") : null;
  if (!tokens) return null;
  const parsed = JSON.parse(tokens);
  const age = Math.floor(Date.now() / 1000) - parsed.obtained_at;
  const remaining = parsed.expires_in - age;
  if (remaining > 120) return parsed.access_token;
  const response = await fetch("https://api.box.com/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.BOX_CLIENT_ID, client_secret: env.BOX_CLIENT_SECRET,
      grant_type: "refresh_token", refresh_token: parsed.refresh_token,
    }),
  });
  if (!response.ok) return null;
  const body = await response.json();
  const fresh = {
    access_token: body.access_token, refresh_token: body.refresh_token,
    obtained_at: Math.floor(Date.now() / 1000), expires_in: body.expires_in || 3600,
  };
  await env.BOX_KV.put("box:tokens", JSON.stringify(fresh));
  return fresh.access_token;
}

/**
 * Adds one response's rows to the survey's CSV in Box.
 *
 * Two respondents submitting at once used to lose one response: each downloaded the file,
 * added its rows and uploaded the result, and the second upload replaced the first. Now
 * the upload carries the file's etag read BEFORE the download (If-Match), so Box refuses
 * it with 412 when anyone wrote in between, and the append starts again from the newer
 * file. Two first responses creating the file at once meet the same way: the second
 * create is refused with 409 (the name is taken) and retried as an append.
 *
 * responseId makes the append idempotent: a response already in the file (a retried
 * submit whose first try did reach Box) is not written twice.
 */
async function appendResponsesToBox(env, survey, csvChunk, responseId) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const written = await tryAppend(env, survey, csvChunk, responseId);
    if (written !== null) return written;
    await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt + Math.random() * 150));
  }
  throw new Error("Many people are answering right now. Please try submitting again in a moment.");
}

/** One attempt. The number of responses in the file once the rows are in it; null when someone
 * else wrote first. */
async function tryAppend(env, survey, csvChunk, responseId) {
  const token = await boxAccessToken(env);
  if (!token) throw new Error("Box is not connected.");
  const headers = { authorization: `Bearer ${token}` };

  const itemsRes = await fetch(
    `${BOX_API}/folders/${survey.boxFolderId}/items?fields=name,type&limit=1000`, { headers }
  );
  if (!itemsRes.ok) throw new Error(`Box API error (${itemsRes.status})`);
  const items = await itemsRes.json();
  const existing = (items.entries || []).find(
    (e) => e.type === "file" && e.name === survey.responsesFileName
  );

  let text = CSV_HEADER;
  let etag = null;
  if (existing) {
    // The etag first: read after the download, it could name a newer file than the one read.
    const infoRes = await fetch(`${BOX_API}/files/${existing.id}?fields=etag`, { headers });
    if (!infoRes.ok) throw new Error(`Box API error (${infoRes.status})`);
    etag = (await infoRes.json()).etag;
    const contentRes = await fetch(`${BOX_API}/files/${existing.id}/content`, { headers });
    if (!contentRes.ok) throw new Error(`Box download failed (${contentRes.status})`);
    text = await contentRes.text();
    if (responseId && text.includes(`\n${responseId},`)) return countResponses(text);
    if (text && !text.endsWith("\n")) text += "\n";
  }
  text += csvChunk;

  const outgoing = new FormData();
  const uploadUrl = existing
    ? `${BOX_UPLOAD_API}/files/${existing.id}/content`
    : `${BOX_UPLOAD_API}/files/content`;
  if (!existing) {
    outgoing.append("attributes", JSON.stringify({
      name: survey.responsesFileName, parent: { id: survey.boxFolderId },
    }));
  }
  outgoing.append("file", new Blob([text], { type: "text/csv" }), survey.responsesFileName);
  const uploadHeaders = etag ? { ...headers, "if-match": etag } : headers;
  const uploadRes = await fetch(uploadUrl, { method: "POST", headers: uploadHeaders, body: outgoing });
  if (uploadRes.status === 412 || (!existing && uploadRes.status === 409)) return null;
  if (!uploadRes.ok) throw new Error(`Box upload failed (${uploadRes.status})`);
  return countResponses(text);
}

/* ---------- reading and deleting responses (the control panel's Responses page) ---------- */

/** The responses file as rows: its header and the rest. */
function csvRows(text) {
  const rows = parseCsv(text);
  const header = (rows[0] || []).map((h) => h.trim().toLowerCase());
  const at = (name) => header.indexOf(name);
  return { rows: rows.slice(1), id: at("response id"), when: at("submitted at"), qid: at("question id"),
           qtext: at("question text"), turn: at("turn"), prompt: at("prompt"), answer: at("answer") };
}

/** How many responses the file holds: its distinct Response IDs. The count shown in the
 * control panel is read from the file, so a response deleted there is no longer counted. */
function countResponses(text) {
  const { rows, id } = csvRows(text);
  return id < 0 ? 0 : new Set(rows.map((r) => r[id]).filter(Boolean)).size;
}

const COMPANY_QUESTION = /\b(name of|what is|which) (your |the )?(company|organi[sz]ation|employer|business)\b|\b(company|organi[sz]ation) name\b/i;

/** The file's rows as one response each, newest first, each question with its turns in order. */
function groupResponses(survey, text) {
  const c = csvRows(text);
  if (c.id < 0) return [];
  const byQuestion = new Map(survey.questions.map((q, i) => [q.id, { text: q.text, order: i }]));
  const out = new Map();
  for (const row of c.rows) {
    const id = row[c.id];
    if (!id) continue;
    const r = out.get(id) || { responseId: id, submittedAt: row[c.when] || "", questions: new Map() };
    out.set(id, r);
    const qid = row[c.qid] || "";
    const q = r.questions.get(qid) || { questionId: qid, turns: [] };
    r.questions.set(qid, q);
    q.turns.push({ turn: Number(row[c.turn]) || 0, prompt: row[c.prompt] || "", answer: row[c.answer] || "" });
    q.fallbackText = q.fallbackText || row[c.qtext] || "";
  }
  return [...out.values()].map((r) => {
    const questions = [...r.questions.values()].map((q) => {
      q.turns.sort((a, b) => a.turn - b.turn);
      const known = byQuestion.get(q.questionId);
      return { questionId: q.questionId, order: known ? known.order : 999,
               questionText: known ? known.text : (q.turns[0] && q.turns[0].prompt) || q.fallbackText, turns: q.turns };
    }).sort((a, b) => a.order - b.order).map(({ order, ...q }) => q);
    const company = questions.find((q) => COMPANY_QUESTION.test(q.questionText));
    const firstWords = questions.find((q) => q.turns.some((t) => t.answer));
    return { responseId: r.responseId, submittedAt: r.submittedAt, questions,
             label: company && company.turns[0] ? company.turns[0].answer
               : firstWords ? firstWords.turns.find((t) => t.answer).answer.slice(0, 80) : "" };
  }).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

/** The responses file as it is in Box: { id, etag, text }, or null before the first response. */
async function readResponsesFile(env, survey) {
  const token = await boxAccessToken(env);
  if (!token) throw new Error("Box is not connected.");
  const headers = { authorization: `Bearer ${token}` };
  const itemsRes = await fetch(`${BOX_API}/folders/${survey.boxFolderId}/items?fields=name,type&limit=1000`, { headers });
  if (!itemsRes.ok) throw new Error(`Box API error (${itemsRes.status})`);
  const existing = ((await itemsRes.json()).entries || []).find(
    (e) => e.type === "file" && e.name === survey.responsesFileName);
  if (!existing) return null;
  const infoRes = await fetch(`${BOX_API}/files/${existing.id}?fields=etag`, { headers });
  if (!infoRes.ok) throw new Error(`Box API error (${infoRes.status})`);
  const etag = (await infoRes.json()).etag;
  const contentRes = await fetch(`${BOX_API}/files/${existing.id}/content`, { headers });
  if (!contentRes.ok) throw new Error(`Box download failed (${contentRes.status})`);
  return { id: existing.id, etag, text: await contentRes.text(), headers };
}

/**
 * Removes responses from the file. Like a submit, the upload carries the etag read before the
 * download, so a response that arrives meanwhile is never written over: the delete starts
 * again on the newer file. Returns { removed, count } (responses taken out, responses left).
 */
async function deleteResponses(env, survey, ids) {
  const gone = new Set(ids);
  for (let attempt = 0; attempt < 6; attempt++) {
    const file = await readResponsesFile(env, survey);
    if (!file) return { removed: 0, count: 0 };
    const c = csvRows(file.text);
    if (c.id < 0) throw new Error("The responses file has no Response ID column.");
    const kept = c.rows.filter((r) => !gone.has(r[c.id]));
    const removed = new Set(c.rows.filter((r) => gone.has(r[c.id])).map((r) => r[c.id])).size;
    if (!removed) return { removed: 0, count: countResponses(file.text) };
    const text = CSV_HEADER + kept.map((r) => r.map(csvField).join(",")).join("\n") + (kept.length ? "\n" : "");
    const body = new FormData();
    body.append("file", new Blob([text], { type: "text/csv" }), survey.responsesFileName);
    const res = await fetch(`${BOX_UPLOAD_API}/files/${file.id}/content`,
      { method: "POST", headers: { ...file.headers, "if-match": file.etag }, body });
    if (res.status === 412) {
      await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** attempt + Math.random() * 150));
      continue;
    }
    if (!res.ok) throw new Error(`Box upload failed (${res.status})`);
    return { removed, count: countResponses(text) };
  }
  throw new Error("Responses are being submitted right now. Please try deleting again in a moment.");
}

/* ---------- unfinished responses (finish later) ---------- */

const clip = (v, n) => String(v == null ? "" : v).slice(0, n);

function cleanTurns(raw) {
  return (Array.isArray(raw) ? raw : []).slice(0, MAX_FOLLOW_UPS + 1).map((t, i) => ({
    turn: i, prompt: clip(t && t.prompt, 2000), answer: clip(t && t.answer, 10000),
  }));
}

/**
 * A respondent's unfinished answers as saved: the questions they finished, and where they
 * are in the current one (its wording as shown, its answered turns, and the question or
 * follow-up waiting for an answer). Nothing from the client is kept beyond that shape.
 */
function cleanDraft(raw, survey) {
  const known = new Set(survey.questions.map((q) => q.id));
  const completed = (Array.isArray(raw && raw.completed) ? raw.completed : [])
    .filter((c) => c && known.has(String(c.questionId)))
    .slice(0, survey.questions.length)
    .map((c) => ({ questionId: String(c.questionId), questionText: clip(c.questionText, 2000), turns: cleanTurns(c.turns) }))
    .filter((c) => c.turns.length);
  const cur = raw && raw.current;
  const current = cur && known.has(String(cur.questionId)) ? {
    questionId: String(cur.questionId), displayedText: clip(cur.displayedText, 2000),
    turns: cleanTurns(cur.turns), pendingPrompt: clip(cur.pendingPrompt, 2000),
  } : null;
  return { completed, current };
}

const draftKey = (surveyId, token) => `${DRAFT_PREFIX}${surveyId}:${token}`;

/* ---------- Claude (follow-up question generation) ---------- */

async function generateFollowUp(env, survey, question, priorAnswers, completedQuestions) {
  const transcript = priorAnswers.map((t, i) =>
    `${i === 0 ? "Question" : "Follow-up " + i}: ${t.prompt}\nAnswer: ${t.answer}`
  ).join("\n\n");
  const earlier = (completedQuestions || []).map((q) =>
    `Question: ${q.questionText}\n` + (q.turns || []).map((t) =>
      `${t.turn === 0 ? "Answer" : "Follow-up " + t.turn + " answer"}: ${t.answer}`
    ).join("\n")
  ).join("\n\n");
  const system =
    "You run a survey chatbot's follow-up questioning, one question at a time, up to a " +
    "maximum number of follow-ups the survey author set for the current question. Given " +
    "the survey's objective and audience, any general guidance the survey author gave for " +
    "the whole survey, everything the respondent has already said earlier in this survey, " +
    "the question being explored now, any guidance the author gave for follow-ups on this " +
    "specific question, and the conversation so far on this question, use your judgement " +
    "to decide whether one more follow-up would genuinely add value. Ask one only if the " +
    "respondent's answer leaves real room for a more specific, concrete detail worth " +
    "capturing -- for example, a closed or already-complete answer (a flat \"no\", or a " +
    "\"yes\" that leaves nothing more to explore) needs no follow-up even if the maximum " +
    "hasn't been reached. Never ask about something already covered by an earlier question " +
    "in this survey. When you do ask, keep it conversational, one sentence, no preamble, no " +
    "numbering.";
  const user =
    `Survey objective: ${survey.objective || "(none given)"}\n` +
    `Audience: ${survey.audience || "(none given)"}\n` +
    // Applies across every question, unlike a per-question context box -- this is how
    // guidance like "take earlier answers about X into account for later questions"
    // actually reaches the model, including on questions with 0 follow-ups of their own.
    (survey.generalGuidance ? `General guidance for this whole survey: ${survey.generalGuidance}\n` : "") +
    (earlier ? `Already covered earlier in this survey:\n${earlier}\n\n` : "") +
    `Question being explored now: ${question.text}\n` +
    `Author's guidance for follow-ups on this question: ${question.context || "(none given)"}\n\n` +
    `Conversation so far on this question:\n${transcript}`;
  const tool = {
    name: "ask_follow_up",
    description: "Decide whether to ask one more follow-up question, and if so, what it is.",
    input_schema: {
      type: "object",
      properties: {
        needsFollowUp: {
          type: "boolean",
          description: "True only if one more follow-up would genuinely add value.",
        },
        followUpQuestion: {
          type: "string",
          description: "The follow-up question, if needsFollowUp is true. Empty string otherwise.",
        },
      },
      required: ["needsFollowUp", "followUpQuestion"],
      additionalProperties: false,
    },
  };
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.consensus_claude_api,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: FOLLOWUP_MODEL,
      max_tokens: 300,
      system,
      messages: [{ role: "user", content: user }],
      tools: [tool],
      tool_choice: { type: "tool", name: "ask_follow_up" },
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Claude API error (${response.status}): ${detail.slice(0, 300)}`);
  }
  const body = await response.json();
  const toolUse = (body.content || []).find((b) => b.type === "tool_use");
  if (!toolUse) throw new Error("Claude did not return a follow-up decision.");
  if (!toolUse.input.needsFollowUp) return null;
  return String(toolUse.input.followUpQuestion || "").trim() || null;
}

// Rewrites ONE question's own wording (not a follow-up) so it references specific
// details from one or more DIFFERENT, earlier questions the admin explicitly picked --
// e.g. "Do you know others in the industry leading the way [in reverse logistics]?"
// once an earlier question established the respondent's answer was about reverse
// logistics. `sources` are those earlier questions' full threads as this respondent
// actually answered them, including any follow-up turns (the personalization is meant
// to draw on everything they said on each topic, not just their first answer to it).
async function personalizeQuestion(env, survey, question, sources) {
  const sourcesText = sources.map((source) => {
    const thread = (source.turns || []).map((t) =>
      `${t.turn === 0 ? "Answer" : "Follow-up " + t.turn + " answer"}: ${t.answer}`
    ).join("\n");
    return `Respondent's earlier answer(s) to "${source.questionText}":\n${thread}`;
  }).join("\n\n");
  const system =
    "You lightly rewrite ONE survey question's wording so it naturally references " +
    "specific details the respondent already gave earlier in this survey, instead of " +
    "asking generically. Keep the question's original meaning and intent completely " +
    "intact -- change only enough wording to weave in the specific detail(s). One " +
    "sentence, conversational, no preamble, no quotation marks. If nothing in the " +
    "earlier answer(s) is specific enough to reference naturally, return the original " +
    "question text unchanged rather than forcing it.";
  const user =
    `Survey objective: ${survey.objective || "(none given)"}\n` +
    `Audience: ${survey.audience || "(none given)"}\n` +
    (survey.generalGuidance ? `General guidance for this whole survey: ${survey.generalGuidance}\n` : "") +
    `\nOriginal question to rewrite: ${question.text}\n\n` +
    `${sourcesText}\n\n` +
    "Rewrite the original question above to reference the specific detail(s) from " +
    "those earlier answer(s).";
  const tool = {
    name: "personalize_question",
    description: "Record the personalized rewrite of the question.",
    input_schema: {
      type: "object",
      properties: { personalizedText: { type: "string" } },
      required: ["personalizedText"],
      additionalProperties: false,
    },
  };
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.consensus_claude_api,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: FOLLOWUP_MODEL,
      max_tokens: 300,
      system,
      messages: [{ role: "user", content: user }],
      tools: [tool],
      tool_choice: { type: "tool", name: "personalize_question" },
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Claude API error (${response.status}): ${detail.slice(0, 300)}`);
  }
  const body = await response.json();
  const toolUse = (body.content || []).find((b) => b.type === "tool_use");
  const text = toolUse && String(toolUse.input.personalizedText || "").trim();
  return text || question.text;
}

/* ---------- GitHub Actions dispatch (analysis) -- same shape as worker.js's own
   POST /api/run, kept local here rather than imported since worker.js doesn't export
   its dispatch helper and this is the only other place that needs it. ---------- */

function githubHeaders(env) {
  return {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
    "user-agent": "conexus-themes-control-panel",
    "x-github-api-version": "2022-11-28",
  };
}

async function dispatchAnalysis(env, surveyId) {
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/consensus_analyze.yml/dispatches`,
    {
      method: "POST",
      headers: { ...githubHeaders(env), "content-type": "application/json" },
      body: JSON.stringify({
        ref: env.GITHUB_BRANCH || "main", inputs: { survey_id: surveyId },
      }),
    }
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub refused the trigger (${response.status}): ${detail.slice(0, 300)}`);
  }
}

// consensus_analyze.yml is one shared workflow used to analyze EVERY survey (survey_id
// is just a dispatch input, not part of the workflow's identity), so the most recent run
// of it is not necessarily the one just dispatched for THIS survey -- it could easily be
// an already-completed run from analyzing this survey (or a different one) earlier. Without
// filtering, the status poll would see that stale "completed" run on its very first check
// and immediately report done, before the real new run even registers with GitHub -- which
// is exactly why the progress bar never appeared to do anything. `sinceIso`, stored per
// survey right before dispatch (see the `analyze` route below), lets us ignore every run
// that isn't newer than the dispatch that's actually being polled for.
async function analysisRuns(env, sinceIso) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/consensus_analyze.yml/runs?per_page=10`;
  const response = await fetch(url, { headers: githubHeaders(env) });
  if (!response.ok) return { runs: [] };
  const body = await response.json();
  let runs = (body.workflow_runs || []).map((r) => ({
    status: r.status, conclusion: r.conclusion,
    started_at: r.run_started_at, created_at: r.created_at, updated_at: r.updated_at, url: r.html_url,
  }));
  if (sinceIso) {
    const sinceMs = Date.parse(sinceIso) - 5000; // small buffer for clock skew
    runs = runs.filter((r) => Date.parse(r.created_at) >= sinceMs)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  }
  return { runs };
}

/* ---------- routes ---------- */

export async function handleConsensusApi(route, request, env) {
  if (!env.BOX_KV) return json({ error: "BOX_KV binding is missing -- see SETUP.md." }, 500);
  const method = request.method.toUpperCase();
  const parts = route.split("/").filter(Boolean);

  // ---- Relay (GitHub Actions -> Worker, shared-secret auth) ---------------------------
  if (parts[0] === "relay") {
    const key = request.headers.get("x-pipeline-key") || "";
    if (!env.BOX_RELAY_SECRET || key !== env.BOX_RELAY_SECRET) {
      return json({ error: "Not authorized" }, 401);
    }
    // GET relay/survey/<id>
    if (parts[1] === "survey" && parts.length === 3 && method === "GET") {
      const survey = await getSurvey(env, parts[2]);
      if (!survey) return json({ error: "Survey not found" }, 404);
      return json(survey);
    }
    // POST relay/survey/<id>/mark-analyzed { analyzedResponseCount }
    if (parts[1] === "survey" && parts.length === 4 && parts[3] === "mark-analyzed" && method === "POST") {
      const survey = await getSurvey(env, parts[2]);
      if (!survey) return json({ error: "Survey not found" }, 404);
      let body = {};
      try { body = await request.json(); } catch (e) { /* older caller, no body -- fall back below */ }
      survey.analyzedAt = new Date().toISOString();
      // How many of the survey's responses this run actually analyzed -- lets the admin
      // page show "X of Y analyzed" instead of a stale Analyzed/Not-analyzed toggle that
      // never reflected new responses collected after the last run.
      survey.analyzedResponseCount = Number.isFinite(Number(body.analyzedResponseCount))
        ? Math.max(0, Number(body.analyzedResponseCount) | 0)
        : (survey.responseCount || 0);
      delete survey.deletedSinceAnalysis;
      await saveSurvey(env, survey);
      await env.BOX_KV.delete(`${PROGRESS_PREFIX}${parts[2]}`);
      return json({ ok: true });
    }
    // POST relay/survey/<id>/progress { current, total, label }
    if (parts[1] === "survey" && parts.length === 4 && parts[3] === "progress" && method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
      const progress = {
        current: Math.max(0, Number(body.current) || 0),
        total: Math.max(0, Number(body.total) || 0),
        label: String(body.label || "").trim(),
        updatedAt: new Date().toISOString(),
      };
      await env.BOX_KV.put(`${PROGRESS_PREFIX}${parts[2]}`, JSON.stringify(progress));
      return json({ ok: true });
    }
    return json({ error: "Not found" }, 404);
  }

  // ---- Public (respondent-facing, no auth) ---------------------------------------------
  // GET public/<id> -> {id, name, questions:[{id,text}]}, nothing an admin wrote as
  // private guidance (objective/audience/per-question context/follow-up counts).
  if (parts[0] === "public" && parts.length === 2 && method === "GET") {
    const survey = await getSurvey(env, parts[1]);
    if (!survey) return json({ error: "Survey not found" }, 404);
    return json({
      id: survey.id, name: survey.name,
      questions: survey.questions.map((q) => ({ id: q.id, text: q.text, html: q.html || "" })),
    });
  }

  // POST followup { surveyId, questionId, priorAnswers: [{prompt, answer}, ...],
  //                  completed: [{questionId, questionText, turns}, ...] }
  // -> { done: true } once this question's follow-up ceiling is hit OR Claude judges
  // the topic closed, else { followUp, turn }. Follow-up count and per-question
  // context are read from the stored survey, never trusted from the client; `completed`
  // (this respondent's already-finished questions in the same survey) is client-tracked
  // state used only as extra context, not trusted for anything else.
  if (route === "followup" && method === "POST") {
    if (!env.consensus_claude_api) {
      return json({ error: "The Consensus mini app's Claude key isn't set up yet "
        + "(consensus_claude_api) -- see SETUP.md." }, 500);
    }
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const survey = await getSurvey(env, body.surveyId);
    if (!survey) return json({ error: "Survey not found" }, 404);
    const question = survey.questions.find((q) => q.id === body.questionId);
    if (!question) return json({ error: "Question not found" }, 404);
    const priorAnswers = Array.isArray(body.priorAnswers) ? body.priorAnswers : [];
    const completed = Array.isArray(body.completed) ? body.completed : [];
    const followUpsGivenSoFar = Math.max(0, priorAnswers.length - 1);
    // The admin-configured number is a ceiling, not a target -- below it, Claude's own
    // judgement (in generateFollowUp) decides whether another follow-up is warranted.
    if (followUpsGivenSoFar >= question.followUps) return json({ done: true });
    try {
      const followUp = await generateFollowUp(env, survey, question, priorAnswers, completed);
      if (!followUp) return json({ done: true });
      return json({ followUp, turn: followUpsGivenSoFar + 1 });
    } catch (e) {
      return json({ error: e.message || "Could not generate a follow-up question." }, 502);
    }
  }

  // POST personalize { surveyId, questionId, completed: [{questionId, questionText, turns}, ...] }
  // -> { text } -- the wording to actually show for this question. If the question
  // isn't set up to personalize from anything, or none of its source questions have
  // been answered yet in `completed`, or the Claude key isn't configured, or the
  // rewrite call itself fails, this ALWAYS falls back to the question's own static
  // text rather than erroring -- personalized wording is a nicety, never something
  // that should be able to block a respondent from moving through the survey.
  if (route === "personalize" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const survey = await getSurvey(env, body.surveyId);
    if (!survey) return json({ error: "Survey not found" }, 404);
    const question = survey.questions.find((q) => q.id === body.questionId);
    if (!question) return json({ error: "Question not found" }, 404);
    // personalizeFrom is normalized to an array on every save (see cleanQuestions()),
    // but a survey saved before it became multi-select -- and never re-saved since --
    // could still be sitting in KV with the old single-id shape, so tolerate that here
    // too rather than silently dropping its personalization until someone re-saves it.
    const personalizeFrom = Array.isArray(question.personalizeFrom) ? question.personalizeFrom
      : (question.personalizeFrom ? [question.personalizeFrom] : []);
    if (!personalizeFrom.length || !env.consensus_claude_api) {
      return json({ text: question.text });
    }
    const completed = Array.isArray(body.completed) ? body.completed : [];
    const sources = personalizeFrom
      .map((qid) => completed.find((c) => c.questionId === qid))
      .filter(Boolean);
    if (!sources.length) return json({ text: question.text });
    try {
      const text = await personalizeQuestion(env, survey, question, sources);
      return json({ text });
    } catch (e) {
      return json({ text: question.text });
    }
  }

  // POST progress { surveyId, token?, draft: {completed, current} } -> { token, savedAt }
  // Saves a respondent's unfinished answers so they can stop and come back. A first save
  // gets a new token; the page keeps it in the browser and in its "finish later" link.
  if (route === "progress" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const survey = await getSurvey(env, body.surveyId);
    if (!survey) return json({ error: "Survey not found" }, 404);
    const token = TOKEN.test(String(body.token || "")) ? String(body.token) : crypto.randomUUID();
    const draft = { ...cleanDraft(body.draft, survey), savedAt: new Date().toISOString() };
    const text = JSON.stringify(draft);
    if (text.length > MAX_DRAFT_BYTES) return json({ error: "These answers are too long to save." }, 413);
    await env.BOX_KV.put(draftKey(survey.id, token), text, { expirationTtl: DRAFT_TTL_DAYS * 86400 });
    return json({ token, savedAt: draft.savedAt, keptDays: DRAFT_TTL_DAYS });
  }

  // GET progress/<surveyId>/<token> -> the saved draft, or 404 once it is submitted or expired.
  if (parts[0] === "progress" && parts.length === 3 && method === "GET") {
    if (!TOKEN.test(parts[2])) return json({ error: "Not found" }, 404);
    const raw = await env.BOX_KV.get(draftKey(parts[1], parts[2]));
    if (!raw) return json({ error: "No saved progress for this link." }, 404);
    return json({ draft: JSON.parse(raw), keptDays: DRAFT_TTL_DAYS });
  }

  // POST submit { surveyId, token?, responses: [{questionId, questionText, turns:[{turn,prompt,answer}]}] }
  if (route === "submit" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const survey = await getSurvey(env, body.surveyId);
    if (!survey) return json({ error: "Survey not found" }, 404);
    if (!survey.boxFolderId) {
      return json({ error: "This survey has no responses folder set up yet." }, 409);
    }
    const responses = Array.isArray(body.responses) ? body.responses : [];
    if (!responses.length) return json({ error: "No answers were submitted." }, 400);
    // A respondent who saved progress submits under that token, so a retried submit is the
    // same response, never a second copy of it.
    const draftToken = TOKEN.test(String(body.token || "")) ? String(body.token) : "";
    const responseId = draftToken || crypto.randomUUID();
    const submittedAt = new Date().toISOString();
    const csvChunk = responsesToCsvRows(responseId, submittedAt, responses);
    let count;
    try {
      count = await appendResponsesToBox(env, survey, csvChunk, responseId);
    } catch (e) {
      return json({ error: e.message || "Could not save your responses." }, 502);
    }
    // The count is what the file holds, not a running tally: a response deleted from it (in
    // the control panel or in Box) stops being counted.
    const fresh = (await getSurvey(env, survey.id)) || survey;
    fresh.responseCount = count;
    await saveSurvey(env, fresh);
    if (draftToken) await env.BOX_KV.delete(draftKey(survey.id, draftToken));
    return json({ ok: true });
  }

  // ---- Admin (beta account required) ----------------------------------------------------
  const auth = await requireBetaAuth(request, env);
  if (!auth) return json({ error: "Not signed in" }, 401);
  // Every route below is this app's control panel: its own admins, or an overall admin.
  if (!canAdminApp(auth, "consensus")) return json({ error: NO_SETTINGS_ACCESS }, 403);

  // GET box/folders?id=0 -- the survey builder's own folder picker. src/council_data.js
  // already has one of these for Council Themes/Quant, but rather than share a route
  // across two mini app files, this is its own small copy, gated by requireBetaAuth
  // like everything else admin-side in this file.
  if (route === "box/folders" && method === "GET") {
    const token = await boxAccessToken(env);
    if (!token) return json({ error: "Box is not connected yet." }, 409);
    const id = new URL(request.url).searchParams.get("id") || "0";
    const headers = { authorization: `Bearer ${token}` };
    const [infoRes, itemsRes] = await Promise.all([
      fetch(`${BOX_API}/folders/${id}?fields=name,path_collection`, { headers }),
      fetch(`${BOX_API}/folders/${id}/items?fields=name,type&limit=1000`, { headers }),
    ]);
    if (!infoRes.ok || !itemsRes.ok) {
      return json({ error: `Box API error (${infoRes.status}/${itemsRes.status})` }, 502);
    }
    const info = await infoRes.json();
    const items = await itemsRes.json();
    const breadcrumb = [...((info.path_collection && info.path_collection.entries) || [])
      .map((e) => ({ id: e.id, name: e.name })), { id, name: info.name }];
    const folders = (items.entries || []).filter((e) => e.type === "folder")
      .map((e) => ({ id: e.id, name: e.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return json({ id, name: info.name, breadcrumb, folders });
  }

  if (route === "surveys" && method === "GET") {
    const list = await env.BOX_KV.list({ prefix: SURVEY_PREFIX });
    const surveys = await Promise.all(list.keys.map(async (k) => {
      const raw = await env.BOX_KV.get(k.name);
      return raw ? JSON.parse(raw) : null;
    }));
    const summaries = surveys.filter(Boolean).map((s) => ({
      id: s.id, name: s.name, questionCount: s.questions.length,
      // How many of this survey's questions actually get a Claude call on Analyze --
      // surfaced so the control panel's spend-confirmation dialog can say "N
      // question(s)" instead of a flat warning (a question can be marked
      // "Claude Analyze: No" to skip it entirely).
      claudeAnalyzeQuestionCount: s.questions.filter((q) => q.claudeAnalyze !== false).length,
      responseCount: s.responseCount, boxFolderName: s.boxFolderName,
      createdAt: s.createdAt, analyzedAt: s.analyzedAt,
      analyzedResponseCount: s.analyzedResponseCount || 0,
      deletedSinceAnalysis: s.deletedSinceAnalysis || 0,
    })).sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    return json({ surveys: summaries });
  }

  if (route === "surveys" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    if (!String(body.name || "").trim()) return json({ error: "Give the survey a name." }, 400);
    if (!cleanQuestions(body.questions).length) return json({ error: "Add at least one question." }, 400);
    const id = crypto.randomUUID();
    const survey = buildSurvey(id, body, null);
    await saveSurvey(env, survey);
    return json({ ok: true, survey });
  }

  if (parts[0] === "surveys" && parts.length === 2 && method === "GET") {
    const survey = await getSurvey(env, parts[1]);
    if (!survey) return json({ error: "Survey not found" }, 404);
    return json(survey);
  }

  if (parts[0] === "surveys" && parts.length === 2 && method === "PUT") {
    const existing = await getSurvey(env, parts[1]);
    if (!existing) return json({ error: "Survey not found" }, 404);
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    if (!String(body.name || "").trim()) return json({ error: "Give the survey a name." }, 400);
    if (!cleanQuestions(body.questions).length) return json({ error: "Add at least one question." }, 400);
    const survey = buildSurvey(parts[1], body, existing);
    await saveSurvey(env, survey);
    return json({ ok: true, survey });
  }

  if (parts[0] === "surveys" && parts.length === 3 && parts[2] === "analyze" && method === "POST") {
    const survey = await getSurvey(env, parts[1]);
    if (!survey) return json({ error: "Survey not found" }, 404);
    if (!survey.responseCount) return json({ error: "No responses have been collected yet." }, 409);
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
      return json({ error: "GitHub is not connected yet (see SETUP.md)." }, 500);
    }
    // Stored BEFORE dispatching so analyze-status below can tell this run apart from a
    // stale already-completed run of the shared workflow -- see analysisRuns() above.
    await env.BOX_KV.put(`${DISPATCH_PREFIX}${survey.id}`, new Date().toISOString());
    try {
      await dispatchAnalysis(env, survey.id);
    } catch (e) {
      return json({ error: e.message }, 502);
    }
    return json({ ok: true });
  }

  if (parts[0] === "surveys" && parts.length === 3 && parts[2] === "analyze-status" && method === "GET") {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return json({ runs: [] });
    const since = await env.BOX_KV.get(`${DISPATCH_PREFIX}${parts[1]}`);
    return json(await analysisRuns(env, since));
  }

  // GET surveys/<id>/responses -> { survey: {id, name}, responses: [...], count }. Every
  // submitted response, read from the file in Box. The survey's response count is set from
  // the file here too, so a response deleted straight from Box stops being counted.
  if (parts[0] === "surveys" && parts.length === 3 && parts[2] === "responses" && method === "GET") {
    const survey = await getSurvey(env, parts[1]);
    if (!survey) return json({ error: "Survey not found" }, 404);
    const base = { survey: { id: survey.id, name: survey.name, analyzedAt: survey.analyzedAt || null,
                             deletedSinceAnalysis: survey.deletedSinceAnalysis || 0 } };
    if (!survey.boxFolderId) return json({ ...base, responses: [], count: 0 });
    let file;
    try { file = await readResponsesFile(env, survey); } catch (e) { return json({ error: e.message }, 502); }
    const responses = file ? groupResponses(survey, file.text) : [];
    if ((survey.responseCount || 0) !== responses.length) {
      survey.responseCount = responses.length;
      await saveSurvey(env, survey);
    }
    return json({ ...base, responses, count: responses.length });
  }

  // POST surveys/<id>/responses/delete { responseIds: [...] } -> { removed, count }
  if (parts[0] === "surveys" && parts.length === 4 && parts[2] === "responses" && parts[3] === "delete" && method === "POST") {
    const survey = await getSurvey(env, parts[1]);
    if (!survey) return json({ error: "Survey not found" }, 404);
    if (!survey.boxFolderId) return json({ error: "This survey has no responses folder." }, 409);
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const ids = (Array.isArray(body.responseIds) ? body.responseIds : []).map(String).filter(Boolean).slice(0, 1000);
    if (!ids.length) return json({ error: "Choose at least one response to delete." }, 400);
    let result;
    try { result = await deleteResponses(env, survey, ids); } catch (e) { return json({ error: e.message }, 502); }
    const fresh = (await getSurvey(env, survey.id)) || survey;
    fresh.responseCount = result.count;
    // The published results still include a deleted response until Analyze runs again.
    if (result.removed && fresh.analyzedAt) fresh.deletedSinceAnalysis = (fresh.deletedSinceAnalysis || 0) + result.removed;
    await saveSurvey(env, fresh);
    return json({ ok: true, ...result });
  }

  // GET surveys/<id>/progress -- the actual per-question progress reported by
  // scripts/consensus_analyze.py as it runs, via POST relay/survey/<id>/progress
  // above. Separate from analyze-status (GitHub Actions run-level state) since a run
  // can be "Running" for its whole duration with no visibility into which question
  // it's on -- this is what closes that gap.
  if (parts[0] === "surveys" && parts.length === 3 && parts[2] === "progress" && method === "GET") {
    const raw = await env.BOX_KV.get(`${PROGRESS_PREFIX}${parts[1]}`);
    return json(raw ? JSON.parse(raw) : {});
  }

  return json({ error: "Not found" }, 404);
}
