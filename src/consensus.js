/**
 * Consensus: a mini app for chatbot-style surveys with Claude-generated follow-up
 * questions, mounted under /api/consensus/*.
 *
 * Admin routes (survey builder, analyze) reuse the Mini App Platform's own admin
 * accounts (see src/beta_auth.js's requireBetaAuth) rather than inventing another
 * login system. Respondent-facing routes are public, matching this survey's whole
 * point: anyone with the link answers it, no account needed.
 *
 * Storage:
 *   consensus:survey:<id> -> the survey definition (JSON) -- see buildSurvey() below
 *     for the exact shape. Listed via BOX_KV's list({prefix}), not a separate index
 *     key, so there's nothing to keep in sync.
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

import { requireBetaAuth } from "./beta_auth.js";

const SURVEY_PREFIX = "consensus:survey:";
const PROGRESS_PREFIX = "consensus:progress:";
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

/* ---------- request body helpers ---------- */

function cleanQuestions(raw) {
  return (Array.isArray(raw) ? raw : []).map((q, i) => ({
    id: (q && q.id) || `q${i + 1}-${crypto.randomUUID().slice(0, 8)}`,
    text: String((q && q.text) || "").trim(),
    followUps: Math.max(0, Math.min(MAX_FOLLOW_UPS, Number((q && q.followUps) || 0) | 0)),
    context: String((q && q.context) || "").trim(),
  })).filter((q) => q.text);
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

async function appendResponsesToBox(env, survey, csvChunk) {
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
  if (existing) {
    const contentRes = await fetch(`${BOX_API}/files/${existing.id}/content`, { headers });
    if (!contentRes.ok) throw new Error(`Box download failed (${contentRes.status})`);
    text = await contentRes.text();
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
  const uploadRes = await fetch(uploadUrl, { method: "POST", headers, body: outgoing });
  if (!uploadRes.ok) throw new Error(`Box upload failed (${uploadRes.status})`);
}

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

async function analysisRuns(env) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/consensus_analyze.yml/runs?per_page=3`;
  const response = await fetch(url, { headers: githubHeaders(env) });
  if (!response.ok) return { runs: [] };
  const body = await response.json();
  return {
    runs: (body.workflow_runs || []).map((r) => ({
      status: r.status, conclusion: r.conclusion,
      started_at: r.run_started_at, updated_at: r.updated_at, url: r.html_url,
    })),
  };
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
    // POST relay/survey/<id>/mark-analyzed
    if (parts[1] === "survey" && parts.length === 4 && parts[3] === "mark-analyzed" && method === "POST") {
      const survey = await getSurvey(env, parts[2]);
      if (!survey) return json({ error: "Survey not found" }, 404);
      survey.analyzedAt = new Date().toISOString();
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
      questions: survey.questions.map((q) => ({ id: q.id, text: q.text })),
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

  // POST submit { surveyId, responses: [{questionId, questionText, turns:[{turn,prompt,answer}]}] }
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
    const responseId = crypto.randomUUID();
    const submittedAt = new Date().toISOString();
    const csvChunk = responsesToCsvRows(responseId, submittedAt, responses);
    try {
      await appendResponsesToBox(env, survey, csvChunk);
    } catch (e) {
      return json({ error: e.message || "Could not save your responses." }, 502);
    }
    survey.responseCount = (survey.responseCount || 0) + 1;
    await saveSurvey(env, survey);
    return json({ ok: true });
  }

  // ---- Admin (beta account required) ----------------------------------------------------
  const auth = await requireBetaAuth(request, env);
  if (!auth) return json({ error: "Not signed in" }, 401);

  // GET box/folders?id=0 -- the survey builder's own folder picker. worker.js already
  // has one of these for the Council app, but it's gated by admin.html's
  // CONTROL_PASSWORD session, a different auth system than this mini app's beta
  // accounts -- rather than teach that route two auth schemes, this is its own small
  // copy, gated by requireBetaAuth like everything else admin-side in this file.
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
      responseCount: s.responseCount, boxFolderName: s.boxFolderName,
      createdAt: s.createdAt, analyzedAt: s.analyzedAt,
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
    try {
      await dispatchAnalysis(env, survey.id);
    } catch (e) {
      return json({ error: e.message }, 502);
    }
    return json({ ok: true });
  }

  if (parts[0] === "surveys" && parts.length === 3 && parts[2] === "analyze-status" && method === "GET") {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return json({ runs: [] });
    return json(await analysisRuns(env));
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
