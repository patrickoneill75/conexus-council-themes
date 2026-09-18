/**
 * PCN Issue Map: turns PCN meeting notes/transcripts into an accumulating, evidence-
 * traceable map of how members believe their problems connect, mounted under
 * /api/pcn/*. This file is just the Worker side (control panel login, Box round-trip,
 * and the relay + read routes the pipeline's derived output flows through) -- the
 * actual extraction/matching/derivation pipeline is Python, in pcn/pipeline/ (see
 * the design doc and pcn/CODING_PROTOCOL.md for the full build).
 *
 * Admin routes reuse the Mini App Platform's own admin accounts (see
 * src/beta_auth.js's requireBetaAuth), same as src/consensus.js -- no separate
 * control-panel password.
 *
 * Box: this mini app uses the SAME shared, user-delegated Box connection every other
 * tool in this repo uses (see worker.js's box/authorize-url, box/callback, box/status)
 * -- not a separate service account. An earlier draft of this file used its own
 * Client Credentials Grant credentials; that was a mistake (needless duplicate setup
 * for something the existing connection already covers fine) and has been reverted.
 * Like Consensus's per-survey responses folder, PCN Issue Map has the admin pick ONE
 * data folder through a folder browser -- stored in KV, not a hardcoded secret --
 * except here there's exactly one such folder for the whole app, not one per record.
 *
 * Storage: BOX_KV under a "pcn:" prefix.
 *   pcn:config       -> JSON { folderId, folderName } -- the chosen Box data folder.
 *   pcn:network      -> JSON, the latest connection network pcn/pipeline/derive
 *     computed (see relay/network below) -- what public/pcn/network.html renders.
 *   pcn:timeline     -> JSON, the latest change-over-time breakdown
 *     pcn/pipeline/timeline computed (see relay/timeline below) -- what
 *     public/pcn/timeline.html renders.
 *   pcn:run-dispatch -> ISO timestamp of the last POST run dispatch, so run-status
 *     below can tell a fresh run apart from a stale already-completed one -- same
 *     purpose as src/consensus.js's DISPATCH_PREFIX.
 *
 * The chosen Box data folder itself holds the durable, evidence-traceable state (the
 * whole point of the design doc's assertion ledger): ledger.json, issues.json,
 * resolutions.json, meetings.json at its root, plus a "raw" subfolder holding every
 * uploaded meeting file verbatim, kept for audit. This Worker is the only thing that
 * ever touches those Box files directly -- the Python pipeline reads and writes them
 * through the relay/state and relay/meetings/* routes below as plain JSON, the same
 * way src/consensus.js hands its Python pipeline a survey's data as JSON rather than
 * a Box token, so no Box credential ever has to leave this Worker.
 *
 * Admin flow: POST upload (multipart) saves a meeting file to Box and appends a
 * "pending" entry to meetings.json; POST run dispatches pcn_run.yml (GitHub Actions,
 * no inputs -- it processes every pending meeting itself, same "auto-detect what's
 * new" convention update_dashboard.yml already established here) via GITHUB_TOKEN/
 * GITHUB_REPO, same as src/consensus.js's own analyze dispatch; GET run-status polls
 * it. pcn_run.yml runs pcn/pipeline/run.py, which pulls pending meetings + existing
 * state via the relay routes below, runs the full pipeline, and pushes the updated
 * state/network/timeline back.
 *
 * Relay (GitHub Actions -> Worker, shared-secret auth, x-pipeline-key:
 * BOX_RELAY_SECRET -- same mechanism as worker.js's own GET /api/box/pipeline-token
 * and src/consensus.js's relay/* routes, see pcn/relay.py): GET relay/state / POST
 * relay/state read/write the three JSON files above; GET relay/meetings/pending
 * returns every pending meeting's metadata plus its raw file content (base64); POST
 * relay/meetings/mark-processed flips a meeting's status once it's been folded into
 * the ledger (or records why it failed); POST relay/network and POST relay/timeline
 * publish the freshly derived output for the two view pages to render. Checked
 * before requireBetaAuth below, since GitHub Actions has no beta-account session.
 */

import { requireBetaAuth } from "./beta_auth.js";

const CONFIG_KEY = "pcn:config";
const NETWORK_KEY = "pcn:network";
const TIMELINE_KEY = "pcn:timeline";
const RUN_DISPATCH_KEY = "pcn:run-dispatch";
const BOX_API = "https://api.box.com/2.0";
const BOX_UPLOAD_API = "https://upload.box.com/api/2.0";
const TEST_FILE_NAME = "pcn-connection-test.json";
const RAW_FOLDER_NAME = "raw";
const LEDGER_FILE = "ledger.json";
const ISSUES_FILE = "issues.json";
const RESOLUTIONS_FILE = "resolutions.json";
const MEETINGS_FILE = "meetings.json";
const ALLOWED_EXTENSIONS = ["vtt", "srt", "txt", "md", "docx"];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function getConfig(env) {
  const raw = await env.BOX_KV.get(CONFIG_KEY);
  return raw ? JSON.parse(raw) : { folderId: null, folderName: null };
}
async function saveConfig(env, config) {
  await env.BOX_KV.put(CONFIG_KEY, JSON.stringify(config));
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

// The one subfolder this app writes into, alongside the JSON state files at the data
// folder's own root -- holds every uploaded meeting file verbatim, kept for audit
// (see this file's module docstring).
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
   dispatchAnalysis/analysisRuns -- pcn_run.yml is one shared workflow, dispatched
   with no inputs since it auto-detects every pending meeting itself, same
   "auto-detect what's new" convention update_dashboard.yml already established in
   this repo) ---------- */

function githubHeaders(env) {
  return {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
    "user-agent": "conexus-themes-control-panel",
    "x-github-api-version": "2022-11-28",
  };
}

async function dispatchRun(env) {
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/pcn_run.yml/dispatches`,
    {
      method: "POST",
      headers: { ...githubHeaders(env), "content-type": "application/json" },
      body: JSON.stringify({ ref: env.GITHUB_BRANCH || "main" }),
    }
  );
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub refused the trigger (${response.status}): ${detail.slice(0, 300)}`);
  }
}

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

    if (route === "relay/network" && method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
      await env.BOX_KV.put(NETWORK_KEY, JSON.stringify({ network: body, derivedAt: new Date().toISOString() }));
      return json({ ok: true });
    }
    if (route === "relay/timeline" && method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
      await env.BOX_KV.put(TIMELINE_KEY, JSON.stringify({ timeline: body, derivedAt: new Date().toISOString() }));
      return json({ ok: true });
    }

    // An unrecognized relay path 404s here, before touching Box at all -- otherwise
    // it would surface as a misleading "Box is not connected" (409) below whenever
    // the connection happens to be down, instead of the simple "no such route".
    const KNOWN_STATE_ROUTES = ["relay/state", "relay/meetings/pending", "relay/meetings/mark-processed"];
    if (!KNOWN_STATE_ROUTES.includes(route)) return json({ error: "Not found" }, 404);

    // Everything below reads/writes the durable state living in the Box data folder
    // itself -- see this file's module docstring.
    const token = await boxAccessToken(env);
    if (!token) return json({ error: "Box is not connected yet." }, 409);
    const config = await getConfig(env);
    if (!config.folderId) return json({ error: "No PCN data folder has been chosen yet." }, 409);
    const headers = { authorization: `Bearer ${token}` };

    // GET relay/state -> { ledger, issues, resolutions } -- the ledger/pipeline.run.py
    // downloads at the start of every run.
    if (route === "relay/state" && method === "GET") {
      const [ledger, issues, resolutions] = await Promise.all([
        readJsonFile(headers, config.folderId, LEDGER_FILE, []),
        readJsonFile(headers, config.folderId, ISSUES_FILE, []),
        readJsonFile(headers, config.folderId, RESOLUTIONS_FILE, {}),
      ]);
      return json({ ledger, issues, resolutions });
    }

    // POST relay/state { ledger, issues, resolutions } -- the updated state, written
    // back wholesale once a run finishes processing every pending meeting.
    if (route === "relay/state" && method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
      await Promise.all([
        writeJsonFile(headers, config.folderId, LEDGER_FILE, body.ledger || []),
        writeJsonFile(headers, config.folderId, ISSUES_FILE, body.issues || []),
        writeJsonFile(headers, config.folderId, RESOLUTIONS_FILE, body.resolutions || {}),
      ]);
      return json({ ok: true });
    }

    // GET relay/meetings/pending -> every "pending" meeting's metadata plus its raw
    // file content (base64) -- what pcn/pipeline/run.py actually ingests each run.
    if (route === "relay/meetings/pending" && method === "GET") {
      const meetings = await getMeetings(headers, config.folderId);
      const pending = meetings.filter((m) => m.status === "pending");
      const withContent = await Promise.all(pending.map(async (m) => ({
        ...m, contentBase64: await downloadFileBase64(headers, m.fileId),
      })));
      return json({ meetings: withContent });
    }

    // POST relay/meetings/mark-processed { results: [{id, status, error?}] } -- run.py
    // reports what happened to each meeting it attempted this run.
    if (route === "relay/meetings/mark-processed" && method === "POST") {
      let body = {};
      try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
      const results = Array.isArray(body.results) ? body.results : [];
      const meetings = await getMeetings(headers, config.folderId);
      const byId = new Map(meetings.map((m) => [m.id, m]));
      for (const r of results) {
        const m = byId.get(r.id);
        if (!m) continue;
        m.status = r.status === "failed" ? "failed" : "processed";
        m.processedAt = new Date().toISOString();
        if (r.error) m.error = String(r.error).slice(0, 500);
        else delete m.error;
      }
      await saveMeetings(headers, config.folderId, meetings);
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  }

  const auth = await requireBetaAuth(request, env);
  if (!auth) return json({ error: "Not signed in" }, 401);

  // GET box/folders?id=0 -- same folder-picker copy Consensus's survey builder has,
  // gated by requireBetaAuth like everything else admin-side in this file rather than
  // worker.js's own CONTROL_PASSWORD session.
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

  // GET config -> { folderId, folderName }
  if (route === "config" && method === "GET") {
    return json(await getConfig(env));
  }

  // POST config { folderId, folderName }
  if (route === "config" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    if (!body.folderId) return json({ error: "Pick a folder first." }, 400);
    const config = { folderId: String(body.folderId), folderName: String(body.folderName || "") };
    await saveConfig(env, config);
    return json({ ok: true, ...config });
  }

  // GET box/status -> whether the shared Box connection is live, and whether a PCN
  // data folder has been chosen yet.
  if (route === "box/status" && method === "GET") {
    const token = await boxAccessToken(env);
    if (!token) return json({ connected: false });
    const config = await getConfig(env);
    return json({ connected: true, folderId: config.folderId, folderName: config.folderName });
  }

  // POST box/test -> writes a trivial test file to the chosen data folder, reads it
  // straight back, and confirms the round-trip -- exactly build step 1's bar, nothing
  // about extraction or the real data model yet.
  if (route === "box/test" && method === "POST") {
    const token = await boxAccessToken(env);
    if (!token) return json({ error: "Box is not connected yet -- open the control panel and log in with Box." }, 409);
    const config = await getConfig(env);
    if (!config.folderId) return json({ error: "Pick a PCN data folder first." }, 409);
    try {
      const headers = { authorization: `Bearer ${token}` };
      const payload = { ok: true, writtenAt: new Date().toISOString(), by: auth.email };
      const existing = await findFileInFolder(headers, config.folderId, TEST_FILE_NAME);
      const uploaded = await uploadTextFile(
        headers, config.folderId, TEST_FILE_NAME,
        JSON.stringify(payload, null, 2), existing ? existing.id : null
      );
      // Box's upload API returns the same {entries: [...]} shape whether this created
      // a new file or a new version of an existing one -- no need to branch on `existing`.
      const readBack = await downloadFile(headers, uploaded.entries[0].id);
      return json({ ok: true, wrote: payload, readBack: JSON.parse(readBack) });
    } catch (e) {
      return json({ error: e.message || "Box round-trip failed." }, 502);
    }
  }

  // POST upload (multipart/form-data: file, inputType, meetingDate, notetaker) --
  // saves the raw meeting file to Box's "raw" subfolder and appends a "pending"
  // entry to meetings.json for pcn_run.yml to pick up on the next POST run.
  if (route === "upload" && method === "POST") {
    const token = await boxAccessToken(env);
    if (!token) return json({ error: "Box is not connected yet -- open the control panel and log in with Box." }, 409);
    const config = await getConfig(env);
    if (!config.folderId) return json({ error: "Pick a PCN data folder first." }, 409);

    let incoming;
    try { incoming = await request.formData(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const file = incoming.get("file");
    if (!(file instanceof File)) return json({ error: "No file in the request." }, 400);

    const inputType = String(incoming.get("inputType") || "");
    if (inputType !== "transcript" && inputType !== "notes") {
      return json({ error: "inputType must be 'transcript' or 'notes'." }, 400);
    }
    const meetingDate = String(incoming.get("meetingDate") || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(meetingDate)) {
      return json({ error: "Meeting date must be an ISO date (YYYY-MM-DD)." }, 400);
    }
    const notetaker = String(incoming.get("notetaker") || "").trim();
    if (inputType === "notes" && !notetaker) {
      return json({ error: "Notetaker is required for notes." }, 400);
    }
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      return json({ error: `Unsupported file type ".${ext}" -- use one of: ${ALLOWED_EXTENSIONS.join(", ")}.` }, 400);
    }

    try {
      const headers = { authorization: `Bearer ${token}` };
      const rawFolderId = await ensureRawFolder(headers, config.folderId);
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

      const meetings = await getMeetings(headers, config.folderId);
      const entry = {
        id: meetingId, inputType, inputFormat: ext, meetingDate,
        notetaker: inputType === "notes" ? notetaker : null,
        sourceFilename: file.name, fileId: uploaded.id, status: "pending",
        uploadedAt: new Date().toISOString(), uploadedBy: auth.email,
      };
      meetings.unshift(entry);
      await saveMeetings(headers, config.folderId, meetings);
      return json({ ok: true, meeting: entry });
    } catch (e) {
      return json({ error: e.message || "Upload failed." }, 502);
    }
  }

  // GET meetings -> every uploaded meeting's metadata (not its content -- see
  // relay/meetings/pending above for that), newest first, for the admin table.
  if (route === "meetings" && method === "GET") {
    const token = await boxAccessToken(env);
    if (!token) return json({ meetings: [] });
    const config = await getConfig(env);
    if (!config.folderId) return json({ meetings: [] });
    const headers = { authorization: `Bearer ${token}` };
    return json({ meetings: await getMeetings(headers, config.folderId) });
  }

  // POST run -> dispatches pcn_run.yml (no inputs; it processes every "pending"
  // meeting itself). Mirrors src/consensus.js's own analyze dispatch.
  if (route === "run" && method === "POST") {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
      return json({ error: "GitHub is not connected yet (see SETUP.md)." }, 500);
    }
    await env.BOX_KV.put(RUN_DISPATCH_KEY, new Date().toISOString());
    try {
      await dispatchRun(env);
    } catch (e) {
      return json({ error: e.message }, 502);
    }
    return json({ ok: true });
  }

  // GET run-status -> recent pcn_run.yml runs, filtered to ones newer than the last
  // POST run dispatch -- same reasoning as src/consensus.js's analyze-status route.
  if (route === "run-status" && method === "GET") {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) return json({ runs: [] });
    const since = await env.BOX_KV.get(RUN_DISPATCH_KEY);
    return json(await pcnRunRuns(env, since));
  }

  // GET network -> { network, derivedAt } | { network: null, derivedAt: null } --
  // what public/pcn/network.html renders. Published only by relay/network above
  // (the pipeline run), never computed on the fly here -- deriving it is real work
  // (a fresh pass over the whole ledger), not something to redo on every page load.
  if (route === "network" && method === "GET") {
    const raw = await env.BOX_KV.get(NETWORK_KEY);
    return json(raw ? JSON.parse(raw) : { network: null, derivedAt: null });
  }

  // GET timeline -> { timeline, derivedAt } | { timeline: null, derivedAt: null } --
  // what public/pcn/timeline.html renders. Same publish-only-via-relay shape as
  // GET network above.
  if (route === "timeline" && method === "GET") {
    const raw = await env.BOX_KV.get(TIMELINE_KEY);
    return json(raw ? JSON.parse(raw) : { timeline: null, derivedAt: null });
  }

  return json({ error: "Not found" }, 404);
}
