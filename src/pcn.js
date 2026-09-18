/**
 * Issue Network Mapper (still internally "pcn" -- see the id/route note below): turns
 * meeting notes/transcripts into an accumulating, evidence-traceable map of how
 * members believe their problems connect, mounted under /api/pcn/*. This file is
 * just the Worker side (control panel login, Box round-trip,
 * and the relay + read routes the pipeline's derived output flows through) -- the
 * actual extraction/matching/derivation pipeline is Python, in pcn/pipeline/ (see
 * the design doc and pcn/CODING_PROTOCOL.md for the full build).
 *
 * Admin routes reuse Connector's shared admin accounts (see
 * src/beta_auth.js's requireBetaAuth), same as src/consensus.js -- no separate
 * control-panel password.
 *
 * Box: this mini app uses the SAME shared, user-delegated Box connection every other
 * tool in this repo uses (see worker.js's box/authorize-url, box/callback, box/status)
 * -- not a separate service account.
 *
 * Projects: this app isn't just one project -- an admin can wall off a whole separate
 * project (its own Box folder, ledger, issues, network, timeline, GitHub Actions
 * run) for a different meeting series entirely, so running one project's pipeline
 * never touches another's data even transiently. The default project (id "pcn") is
 * just the one seeded automatically; see PROJECTS_KEY below and the "Add new
 * project" flow in public/inm/control-panel/index.html.
 *
 * Storage: BOX_KV under a "pcn:" prefix.
 *   pcn:projects                 -> JSON array of { id, name, folderId, folderName,
 *     createdAt } -- the project registry. Seeded with the default "pcn" project the
 *     first time it's read, so GET projects always has at least one entry.
 *   pcn:project:<id>:network      -> JSON, the latest connection network
 *     pcn/pipeline/derive computed for that project (see relay/projects/<id>/network
 *     below) -- what public/inm/index.html's Network tab renders.
 *   pcn:project:<id>:timeline     -> JSON, the latest change-over-time breakdown
 *     pcn/pipeline/timeline computed for that project (see relay/projects/<id>/
 *     timeline below) -- what public/inm/index.html's Change-over-time tab renders.
 *   pcn:project:<id>:run-dispatch -> ISO timestamp of the last POST run dispatch for
 *     that project, so run-status below can tell a fresh run apart from a stale
 *     already-completed one -- same purpose as src/consensus.js's DISPATCH_PREFIX.
 *
 * Each project's own chosen Box data folder holds ITS durable, evidence-traceable
 * state (the whole point of the design doc's assertion ledger): ledger.json,
 * issues.json, resolutions.json, meetings.json at its root, plus a "raw" subfolder
 * holding every uploaded meeting file verbatim, kept for audit. This Worker is the
 * only thing that ever touches those Box files directly -- the Python pipeline reads
 * and writes them through the relay/projects/<id>/state and
 * relay/projects/<id>/meetings/* routes below as plain JSON, the same way
 * src/consensus.js hands its Python pipeline a survey's data as JSON rather than a
 * Box token, so no Box credential ever has to leave this Worker.
 *
 * Admin flow (all under projects/<id>/*): POST upload (multipart) saves a meeting
 * file to that project's Box folder and appends a "pending" entry to meetings.json;
 * POST run dispatches pcn_run.yml with a project_id input (GitHub Actions -- it
 * processes every pending meeting for THAT project, same "auto-detect what's new"
 * convention update_dashboard.yml already established here) via GITHUB_TOKEN/
 * GITHUB_REPO, same as src/consensus.js's own analyze dispatch (survey_id input);
 * GET run-status polls it. pcn_run.yml runs pcn/pipeline/run.py, which pulls that
 * project's pending meetings + existing state via the relay routes below, runs the
 * full pipeline, and pushes the updated state/network/timeline back.
 *
 * Relay (GitHub Actions -> Worker, shared-secret auth, x-pipeline-key:
 * BOX_RELAY_SECRET -- same mechanism as worker.js's own GET /api/box/pipeline-token
 * and src/consensus.js's relay/* routes, see pcn/relay.py): GET/POST
 * relay/projects/<id>/state read/write the three JSON files above for that project;
 * GET relay/projects/<id>/meetings/pending returns every pending meeting's metadata
 * plus its raw file content (base64); POST relay/projects/<id>/meetings/mark-
 * processed flips a meeting's status once it's been folded into the ledger (or
 * records why it failed); POST relay/projects/<id>/network and .../timeline publish
 * the freshly derived output for the two view pages to render -- these two don't
 * require the project to be registered (see KNOWN_STATE_ROUTES below), so the
 * fixture-test workflow can keep publishing under its own ad-hoc project id without
 * ever needing to register through the admin UI. Checked before requireBetaAuth
 * below, since GitHub Actions has no beta-account session.
 */

import { requireBetaAuth } from "./beta_auth.js";

const PROJECTS_KEY = "pcn:projects";
const DEFAULT_PROJECT_ID = "pcn";
const BOX_API = "https://api.box.com/2.0";
const BOX_UPLOAD_API = "https://upload.box.com/api/2.0";
const TEST_FILE_NAME = "pcn-connection-test.json";
const RAW_FOLDER_NAME = "raw";
const LEDGER_FILE = "ledger.json";
const ISSUES_FILE = "issues.json";
const RESOLUTIONS_FILE = "resolutions.json";
const MEETINGS_FILE = "meetings.json";
const ALLOWED_EXTENSIONS = ["vtt", "srt", "txt", "md", "docx"];
const QUARTERS = ["Q1", "Q2", "Q3", "Q4"];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// Shared by the upload route (fields come off a FormData) and the meeting-edit route
// (fields come off a JSON body) -- both just hand in plain string/number values.
// inputType isn't cosmetic: pcn/pipeline/normalize's segmentation and
// pcn/pipeline/extract's system prompt both branch on it, so a mis-coded meeting is a
// real extraction-quality bug, which is exactly what the edit route exists to correct.
function validateMeetingFields({ inputType, meetingDate, year, quarter, cohort, notetaker }) {
  inputType = String(inputType || "");
  if (inputType !== "transcript" && inputType !== "notes") {
    return { error: "inputType must be 'transcript' or 'notes'." };
  }
  meetingDate = String(meetingDate || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(meetingDate)) {
    return { error: "Meeting date must be an ISO date (YYYY-MM-DD)." };
  }
  const yearRaw = String(year || "").trim();
  const yearNum = Number(yearRaw);
  if (!yearRaw || !Number.isInteger(yearNum) || yearNum < 2000 || yearNum > 2100) {
    return { error: "Year must be a 4-digit year." };
  }
  quarter = String(quarter || "").trim().toUpperCase();
  if (!QUARTERS.includes(quarter)) {
    return { error: "Quarter must be one of Q1, Q2, Q3, Q4." };
  }
  cohort = String(cohort || "").trim();
  notetaker = String(notetaker || "").trim();
  if (inputType === "notes" && !notetaker) {
    return { error: "Notetaker is required for notes." };
  }
  return { fields: { inputType, meetingDate, year: yearNum, quarter, cohort, notetaker } };
}

function networkKey(projectId) { return `pcn:project:${projectId}:network`; }
function timelineKey(projectId) { return `pcn:project:${projectId}:timeline`; }
function runDispatchKey(projectId) { return `pcn:project:${projectId}:run-dispatch`; }

/* ---------- Project registry ---------- */

function slugify(name) {
  const slug = String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug || "project";
}

async function getProjects(env) {
  const raw = await env.BOX_KV.get(PROJECTS_KEY);
  if (raw) return JSON.parse(raw);
  // Seeded once, on first read, so GET projects always has at least the default
  // project even before anyone has picked its Box folder.
  const seeded = [{
    id: DEFAULT_PROJECT_ID, name: "Issue Network Mapper", folderId: null, folderName: null,
    createdAt: new Date().toISOString(),
  }];
  await env.BOX_KV.put(PROJECTS_KEY, JSON.stringify(seeded));
  return seeded;
}

async function saveProjects(env, projects) {
  await env.BOX_KV.put(PROJECTS_KEY, JSON.stringify(projects));
}

async function findProject(env, id) {
  const projects = await getProjects(env);
  return projects.find((p) => p.id === id) || null;
}

async function updateProject(env, id, patch) {
  const projects = await getProjects(env);
  const idx = projects.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  projects[idx] = { ...projects[idx], ...patch };
  await saveProjects(env, projects);
  return projects[idx];
}

async function createProject(env, name) {
  const projects = await getProjects(env);
  let id = slugify(name);
  if (projects.some((p) => p.id === id)) {
    let n = 2;
    while (projects.some((p) => p.id === `${id}-${n}`)) n += 1;
    id = `${id}-${n}`;
  }
  const project = { id, name, folderId: null, folderName: null, createdAt: new Date().toISOString() };
  projects.push(project);
  await saveProjects(env, projects);
  return project;
}

/* ---------- Box (reuses the existing shared connection -- see box/status, box/folders,
   box/pipeline-token in worker.js; this module talks to the Box API directly with the
   same access-token helper shape rather than importing worker.js internals, to keep
   the two files independent -- same pattern src/consensus.js already uses) ---------- */

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

async function findFileInFolder(headers, folderId, name) {
  const response = await fetch(
    `${BOX_API}/folders/${folderId}/items?fields=name,type&limit=1000`, { headers }
  );
  if (!response.ok) throw new Error(`Box API error (${response.status})`);
  const items = await response.json();
  return (items.entries || []).find((e) => e.type === "file" && e.name === name) || null;
}

async function uploadTextFile(headers, folderId, name, text, existingFileId) {
  const outgoing = new FormData();
  const uploadUrl = existingFileId
    ? `${BOX_UPLOAD_API}/files/${existingFileId}/content`
    : `${BOX_UPLOAD_API}/files/content`;
  if (!existingFileId) {
    outgoing.append("attributes", JSON.stringify({ name, parent: { id: folderId } }));
  }
  outgoing.append("file", new Blob([text], { type: "application/json" }), name);
  const response = await fetch(uploadUrl, { method: "POST", headers, body: outgoing });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Box upload failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return response.json();
}

async function downloadFile(headers, fileId) {
  const response = await fetch(`${BOX_API}/files/${fileId}/content`, { headers });
  if (!response.ok) throw new Error(`Box download failed (${response.status})`);
  return response.text();
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000; // String.fromCharCode.apply chokes on very large arrays at once
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function downloadFileBase64(headers, fileId) {
  const response = await fetch(`${BOX_API}/files/${fileId}/content`, { headers });
  if (!response.ok) throw new Error(`Box download failed (${response.status})`);
  return arrayBufferToBase64(await response.arrayBuffer());
}

async function readJsonFile(headers, folderId, name, fallback) {
  const existing = await findFileInFolder(headers, folderId, name);
  if (!existing) return fallback;
  return JSON.parse(await downloadFile(headers, existing.id));
}

async function writeJsonFile(headers, folderId, name, data) {
  const existing = await findFileInFolder(headers, folderId, name);
  await uploadTextFile(headers, folderId, name, JSON.stringify(data, null, 2), existing ? existing.id : null);
}

// The one subfolder this app writes into, alongside the JSON state files at a
// project's data folder root -- holds every uploaded meeting file verbatim, kept for
// audit (see this file's module docstring).
async function ensureRawFolder(headers, parentFolderId) {
  const response = await fetch(
    `${BOX_API}/folders/${parentFolderId}/items?fields=name,type&limit=1000`, { headers }
  );
  if (!response.ok) throw new Error(`Box API error (${response.status})`);
  const items = await response.json();
  const existing = (items.entries || []).find((e) => e.type === "folder" && e.name === RAW_FOLDER_NAME);
  if (existing) return existing.id;
  const createRes = await fetch(`${BOX_API}/folders`, {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ name: RAW_FOLDER_NAME, parent: { id: parentFolderId } }),
  });
  if (!createRes.ok) {
    const detail = await createRes.text();
    throw new Error(`Could not create the "raw" subfolder (${createRes.status}): ${detail.slice(0, 300)}`);
  }
  const created = await createRes.json();
  return created.id;
}

async function getMeetings(headers, folderId) {
  return readJsonFile(headers, folderId, MEETINGS_FILE, []);
}
async function saveMeetings(headers, folderId, meetings) {
  await writeJsonFile(headers, folderId, MEETINGS_FILE, meetings);
}

function newMeetingId() {
  return "meeting-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/* ---------- GitHub Actions dispatch (same shape as src/consensus.js's own
   dispatchAnalysis/analysisRuns -- pcn_run.yml is one shared workflow used by every
   project, dispatched with a project_id input so it knows which one to auto-detect
   pending meetings for, same "auto-detect what's new" convention
   update_dashboard.yml already established in this repo) ---------- */

function githubHeaders(env) {
  return {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
    "user-agent": "conexus-themes-control-panel",
    "x-github-api-version": "2022-11-28",
  };
}

async function dispatchRun(env, projectId) {
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/pcn_run.yml/dispatches`,
    {
      method: "POST",
      headers: { ...githubHeaders(env), "content-type": "application/json" },
      body: JSON.stringify({ ref: env.GITHUB_BRANCH || "main", inputs: { project_id: projectId } }),
    }
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub refused the trigger (${response.status}): ${detail.slice(0, 300)}`);
  }
}

// Note: like src/consensus.js's own analysisRuns, this filters purely by dispatch
// timestamp, not by which project's run_id it actually is -- GitHub's run-list API
// doesn't cheaply expose per-run inputs. Two different projects' runs dispatched
// within moments of each other could momentarily cross-report; an acceptable
// tradeoff for a low-traffic internal tool, same one Consensus already lives with
// across concurrent surveys.
async function pcnRunRuns(env, sinceIso) {
  const url = "https://api.github.com/repos/" + env.GITHUB_REPO + "/actions/workflows/pcn_run.yml/runs?per_page=10";
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

export async function handlePcnApi(route, request, env) {
  if (!env.BOX_KV) return json({ error: "BOX_KV binding is missing -- see SETUP.md." }, 500);
  const method = request.method.toUpperCase();

  // ---- Relay (GitHub Actions -> Worker, shared-secret auth) -- checked before
  // requireBetaAuth below, since a pipeline run has no beta-account session. ----
  if (route.startsWith("relay/")) {
    const key = request.headers.get("x-pipeline-key") || "";
    if (!env.BOX_RELAY_SECRET || key !== env.BOX_RELAY_SECRET) {
      return json({ error: "Not authorized" }, 401);
    }

    const relayParts = route.split("/").filter(Boolean); // ["relay","projects","<id>", ...]
    if (relayParts[1] !== "projects" || relayParts.length < 4) return json({ error: "Not found" }, 404);
    const projectId = decodeURIComponent(relayParts[2]);
    const relaySub = relayParts.slice(3).join("/");

    // These two don't require the project to be registered -- see this file's
    // module docstring on why the fixture-test workflow relies on that.
    if (relaySub === "network" && method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
      await env.BOX_KV.put(networkKey(projectId), JSON.stringify({ network: body, derivedAt: new Date().toISOString() }));
      return json({ ok: true });
    }
    if (relaySub === "timeline" && method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
      await env.BOX_KV.put(timelineKey(projectId), JSON.stringify({ timeline: body, derivedAt: new Date().toISOString() }));
      return json({ ok: true });
    }

    // An unrecognized relay path 404s here, before touching Box at all -- otherwise
    // it would surface as a misleading "Box is not connected" (409) below whenever
    // the connection happens to be down, instead of the simple "no such route".
    const KNOWN_STATE_ROUTES = ["state", "meetings/pending", "meetings/mark-processed"];
    if (!KNOWN_STATE_ROUTES.includes(relaySub)) return json({ error: "Not found" }, 404);

    // Everything below reads/writes the durable state living in that project's own
    // Box data folder -- see this file's module docstring. Unlike network/timeline
    // above, these DO require the project to already be registered with a folder,
    // since there's nowhere else the data could live.
    const project = await findProject(env, projectId);
    if (!project) return json({ error: "Project not found" }, 404);
    const token = await boxAccessToken(env);
    if (!token) return json({ error: "Box is not connected yet." }, 409);
    if (!project.folderId) return json({ error: "No data folder has been chosen for this project yet." }, 409);
    const headers = { authorization: `Bearer ${token}` };

    // GET relay/projects/<id>/state -> { ledger, issues, resolutions } -- what
    // pcn/pipeline/run.py downloads at the start of every run.
    if (relaySub === "state" && method === "GET") {
      const [ledger, issues, resolutions] = await Promise.all([
        readJsonFile(headers, project.folderId, LEDGER_FILE, []),
        readJsonFile(headers, project.folderId, ISSUES_FILE, []),
        readJsonFile(headers, project.folderId, RESOLUTIONS_FILE, {}),
      ]);
      return json({ ledger, issues, resolutions });
    }

    // POST relay/projects/<id>/state { ledger, issues, resolutions } -- the updated
    // state, written back wholesale once a run finishes processing every pending
    // meeting for this project.
    if (relaySub === "state" && method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
      await Promise.all([
        writeJsonFile(headers, project.folderId, LEDGER_FILE, body.ledger || []),
        writeJsonFile(headers, project.folderId, ISSUES_FILE, body.issues || []),
        writeJsonFile(headers, project.folderId, RESOLUTIONS_FILE, body.resolutions || {}),
      ]);
      return json({ ok: true });
    }

    // GET relay/projects/<id>/meetings/pending -> every "pending" meeting's
    // metadata plus its raw file content (base64) -- what pcn/pipeline/run.py
    // actually ingests each run.
    if (relaySub === "meetings/pending" && method === "GET") {
      const meetings = await getMeetings(headers, project.folderId);
      const pending = meetings.filter((m) => m.status === "pending");
      const withContent = await Promise.all(pending.map(async (m) => ({
        ...m, contentBase64: await downloadFileBase64(headers, m.fileId),
      })));
      return json({ meetings: withContent });
    }

    // POST relay/projects/<id>/meetings/mark-processed { results: [{id, status,
    // error?}] } -- run.py reports what happened to each meeting it attempted.
    if (relaySub === "meetings/mark-processed" && method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
      const results = Array.isArray(body.results) ? body.results : [];
      const meetings = await getMeetings(headers, project.folderId);
      const byId = new Map(meetings.map((m) => [m.id, m]));
      for (const r of results) {
        const m = byId.get(r.id);
        if (!m) continue;
        m.status = r.status === "failed" ? "failed" : "processed";
        m.processedAt = new Date().toISOString();
        if (r.error) m.error = String(r.error).slice(0, 500);
        else delete m.error;
      }
      await saveMeetings(headers, project.folderId, meetings);
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  }

  const auth = await requireBetaAuth(request, env);
  if (!auth) return json({ error: "Not signed in" }, 401);

  // GET box/folders?id=0 -- same folder-picker copy Consensus's survey builder has,
  // gated by requireBetaAuth like everything else admin-side in this file. Not
  // project-scoped: browsing Box itself isn't project data, only the folder a
  // project ends up pointed at is.
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

  // GET box/status -> whether the shared Box connection itself is live, independent
  // of any one project's folder.
  if (route === "box/status" && method === "GET") {
    const token = await boxAccessToken(env);
    return json({ connected: !!token });
  }

  // GET projects -> every project in the registry (seeded with the default "pcn"
  // project on first call -- see getProjects above).
  if (route === "projects" && method === "GET") {
    return json({ projects: await getProjects(env) });
  }

  // POST projects { name } -> creates a new walled-off project (its own Box folder
  // to be chosen next, its own ledger/issues/network/timeline, its own pipeline
  // runs) -- the "Add new project" flow.
  if (route === "projects" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const name = String(body.name || "").trim();
    if (!name) return json({ error: "Give the project a name." }, 400);
    const project = await createProject(env, name);
    return json({ ok: true, project });
  }

  // Everything else lives under projects/<id>/* -- look the project up once and
  // reuse it for every sub-route below, same pattern src/consensus.js's own
  // getSurvey-then-branch-on-sub-route uses for surveys/<id>/*.
  const parts = route.split("/").filter(Boolean);
  if (parts[0] === "projects" && parts.length >= 2) {
    const projectId = decodeURIComponent(parts[1]);
    const sub = parts.slice(2).join("/");
    const project = await findProject(env, projectId);
    if (!project) return json({ error: "Project not found" }, 404);

    // GET projects/<id> -> the project itself (id, name, folderId, folderName).
    if (!sub && method === "GET") return json(project);

    // POST projects/<id>/config { folderId, folderName } -> sets this project's Box
    // data folder.
    if (sub === "config" && method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
      if (!body.folderId) return json({ error: "Pick a folder first." }, 400);
      const updated = await updateProject(env, projectId, {
        folderId: String(body.folderId), folderName: String(body.folderName || ""),
      });
      return json({ ok: true, project: updated });
    }

    // POST projects/<id>/box/test -> writes a trivial test file to this project's
    // data folder, reads it straight back, and confirms the round-trip.
    if (sub === "box/test" && method === "POST") {
      const token = await boxAccessToken(env);
      if (!token) return json({ error: "Box is not connected yet -- open the control panel and log in with Box." }, 409);
      if (!project.folderId) return json({ error: "Pick a data folder for this project first." }, 409);
      try {
        const headers = { authorization: `Bearer ${token}` };
        const payload = { ok: true, writtenAt: new Date().toISOString(), by: auth.email };
        const existing = await findFileInFolder(headers, project.folderId, TEST_FILE_NAME);
        const uploaded = await uploadTextFile(
          headers, project.folderId, TEST_FILE_NAME,
          JSON.stringify(payload, null, 2), existing ? existing.id : null
        );
        const readBack = await downloadFile(headers, uploaded.entries[0].id);
        return json({ ok: true, wrote: payload, readBack: JSON.parse(readBack) });
      } catch (e) {
        return json({ error: e.message || "Box round-trip failed." }, 502);
      }
    }

    // POST projects/<id>/upload (multipart/form-data: file, inputType, meetingDate,
    // year, quarter, cohort, notetaker) -- saves the raw meeting file to this
    // project's Box "raw" subfolder and appends a "pending" entry to meetings.json
    // for pcn_run.yml to pick up on the next POST run.
    if (sub === "upload" && method === "POST") {
      const token = await boxAccessToken(env);
      if (!token) return json({ error: "Box is not connected yet -- open the control panel and log in with Box." }, 409);
      if (!project.folderId) return json({ error: "Pick a data folder for this project first." }, 409);

      let incoming;
      try { incoming = await request.formData(); } catch (e) { return json({ error: "Bad request" }, 400); }
      const file = incoming.get("file");
      if (!(file instanceof File)) return json({ error: "No file in the request." }, 400);

      const validated = validateMeetingFields({
        inputType: incoming.get("inputType"), meetingDate: incoming.get("meetingDate"),
        year: incoming.get("year"), quarter: incoming.get("quarter"),
        cohort: incoming.get("cohort"), notetaker: incoming.get("notetaker"),
      });
      if (validated.error) return json({ error: validated.error }, 400);
      const { inputType, meetingDate, year, quarter, cohort, notetaker } = validated.fields;

      const ext = (file.name.split(".").pop() || "").toLowerCase();
      if (!ALLOWED_EXTENSIONS.includes(ext)) {
        return json({ error: `Unsupported file type ".${ext}" -- use one of: ${ALLOWED_EXTENSIONS.join(", ")}.` }, 400);
      }

      try {
        const headers = { authorization: `Bearer ${token}` };
        const rawFolderId = await ensureRawFolder(headers, project.folderId);
        const meetingId = newMeetingId();
        const storedName = `${meetingId}.${ext}`;

        const outgoing = new FormData();
        outgoing.append("attributes", JSON.stringify({ name: storedName, parent: { id: rawFolderId } }));
        outgoing.append("file", file, storedName);
        const uploadRes = await fetch(`${BOX_UPLOAD_API}/files/content`, { method: "POST", headers, body: outgoing });
        if (!uploadRes.ok) {
          const detail = await uploadRes.text();
          return json({ error: `Box upload failed (${uploadRes.status})`, detail: detail.slice(0, 300) }, 502);
        }
        const uploadedBody = await uploadRes.json();
        const uploaded = (uploadedBody.entries || [])[0];
        if (!uploaded) return json({ error: "Box did not return the uploaded file." }, 502);

        const meetings = await getMeetings(headers, project.folderId);
        const entry = {
          id: meetingId, inputType, inputFormat: ext, meetingDate, year, quarter,
          cohort: cohort || null, notetaker: inputType === "notes" ? notetaker : null,
          sourceFilename: file.name, fileId: uploaded.id, status: "pending",
          uploadedAt: new Date().toISOString(), uploadedBy: auth.email,
        };
        meetings.unshift(entry);
        await saveMeetings(headers, project.folderId, meetings);
        return json({ ok: true, meeting: entry });
      } catch (e) {
        return json({ error: e.message || "Upload failed." }, 502);
      }
    }

    // GET projects/<id>/meetings -> every uploaded meeting's metadata for this
    // project (not its content -- see relay/projects/<id>/meetings/pending above for
    // that), newest first, for the admin table.
    if (sub === "meetings" && method === "GET") {
      const token = await boxAccessToken(env);
      if (!token || !project.folderId) return json({ meetings: [] });
      const headers = { authorization: `Bearer ${token}` };
      return json({ meetings: await getMeetings(headers, project.folderId) });
    }

    // POST projects/<id>/meetings/reprocess-all -> resets EVERY meeting in this
    // project back to "pending" (clearing error/processedAt), regardless of its
    // current status -- so an admin can force the whole project through the
    // pipeline again after tuning the extraction prompt or matching thresholds,
    // without opening the edit form on every already-processed meeting just to
    // flip its status. pcn/pipeline/run.py's per-meeting ledger replace (not
    // append) is what makes reprocessing safe to do more than once.
    if (sub === "meetings/reprocess-all" && method === "POST") {
      const token = await boxAccessToken(env);
      if (!token) return json({ error: "Box is not connected yet -- open the control panel and log in with Box." }, 409);
      if (!project.folderId) return json({ error: "Pick a data folder for this project first." }, 409);

      const headers = { authorization: `Bearer ${token}` };
      const meetings = await getMeetings(headers, project.folderId);
      for (const meeting of meetings) {
        meeting.status = "pending";
        delete meeting.error;
        delete meeting.processedAt;
      }
      await saveMeetings(headers, project.folderId, meetings);
      return json({ ok: true, meetings });
    }

    // POST projects/<id>/meetings/<meetingId> { inputType, meetingDate, year, quarter,
    // cohort, notetaker } -- corrects a meeting's metadata after upload (e.g. a
    // "notes" file mis-coded as "transcript"). Resets it to "pending" so pcn_run.yml
    // reprocesses it with the corrected metadata on the next run, instead of leaving
    // the original (wrong) extraction results in place.
    if (sub.startsWith("meetings/") && method === "POST") {
      const meetingId = sub.slice("meetings/".length);
      const token = await boxAccessToken(env);
      if (!token) return json({ error: "Box is not connected yet -- open the control panel and log in with Box." }, 409);
      if (!project.folderId) return json({ error: "Pick a data folder for this project first." }, 409);

      let body = {};
      try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
      const validated = validateMeetingFields(body);
      if (validated.error) return json({ error: validated.error }, 400);
      const { inputType, meetingDate, year, quarter, cohort, notetaker } = validated.fields;

      const headers = { authorization: `Bearer ${token}` };
      const meetings = await getMeetings(headers, project.folderId);
      const meeting = meetings.find((m) => m.id === meetingId);
      if (!meeting) return json({ error: "Meeting not found" }, 404);

      meeting.inputType = inputType;
      meeting.meetingDate = meetingDate;
      meeting.year = year;
      meeting.quarter = quarter;
      meeting.cohort = cohort || null;
      meeting.notetaker = inputType === "notes" ? notetaker : null;
      meeting.status = "pending";
      meeting.editedAt = new Date().toISOString();
      meeting.editedBy = auth.email;
      delete meeting.error;
      delete meeting.processedAt;

      await saveMeetings(headers, project.folderId, meetings);
      return json({ ok: true, meeting });
    }

    // POST projects/<id>/run -> dispatches pcn_run.yml with project_id=<id> (it
    // processes every "pending" meeting for this project). Mirrors src/consensus.js's
    // own analyze dispatch.
    if (sub === "run" && method === "POST") {
      if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
        return json({ error: "GitHub is not connected yet (see SETUP.md)." }, 500);
      }
      await env.BOX_KV.put(runDispatchKey(projectId), new Date().toISOString());
      try {
        await dispatchRun(env, projectId);
      } catch (e) {
        return json({ error: e.message }, 502);
      }
      return json({ ok: true });
    }

    // GET projects/<id>/run-status -> recent pcn_run.yml runs, filtered to ones
    // newer than this project's last POST run dispatch -- same reasoning as
    // src/consensus.js's analyze-status route.
    if (sub === "run-status" && method === "GET") {
      if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return json({ runs: [] });
      const since = await env.BOX_KV.get(runDispatchKey(projectId));
      return json(await pcnRunRuns(env, since));
    }

    // GET projects/<id>/network -> { network, derivedAt } | { network: null,
    // derivedAt: null } -- what public/inm/index.html's Network tab renders for this
    // project. Published only by relay/projects/<id>/network above (the pipeline
    // run), never computed on the fly here.
    if (sub === "network" && method === "GET") {
      const raw = await env.BOX_KV.get(networkKey(projectId));
      return json(raw ? JSON.parse(raw) : { network: null, derivedAt: null });
    }

    // GET projects/<id>/timeline -> same publish-only-via-relay shape as network
    // above, for public/inm/index.html's Change-over-time tab.
    if (sub === "timeline" && method === "GET") {
      const raw = await env.BOX_KV.get(timelineKey(projectId));
      return json(raw ? JSON.parse(raw) : { timeline: null, derivedAt: null });
    }

    return json({ error: "Not found" }, 404);
  }

  return json({ error: "Not found" }, 404);
}
