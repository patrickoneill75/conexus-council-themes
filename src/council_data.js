/**
 * Council Meeting Survey Dashboard + Quant benchmarking: the original tool this repo
 * was built around, mounted under /api/council-data/* like every other mini app.
 *
 * Historically this WAS src/worker.js's own core, gated by a single shared
 * CONTROL_PASSWORD rather than the beta-account system every later mini app used.
 * That password is retired -- this file's routes are gated by requireBetaAuth, same
 * as pcn.js/consensus.js/mcm.js, so every mini app on Connector now shares exactly one
 * sign-in system.
 *
 * Box: uses the SAME shared, user-delegated Box connection every other tool in this
 * repo uses. Unlike the newer mini apps, this one is where the *login* itself is
 * exposed in its own control panel (public/council-data/control-panel/index.html,
 * "Log in with Box" / "Disconnect") -- see worker.js's box/authorize-url,
 * box/callback for the actual OAuth exchange, which stays centralized there since
 * there is only one shared credential and one registered callback URL. This file
 * duplicates the small `boxAccessToken()` read/refresh helper other mini apps also
 * duplicate, rather than importing worker.js internals, to keep every mini app file
 * independent of the others.
 *
 * Storage: BOX_KV under a "box:" prefix (shared with worker.js's own box:tokens):
 *   box:data_folder -> JSON { id, name } -- the one Data Folder this app's CSV
 *     exports live in (Council Meeting Helper.csv / Post-Meeting Survey.csv).
 *   box:tracker      -> JSON { id, name } -- leftover, kept only for the one-time
 *     Feedback Log migration script (see scripts/migrate_feedback_log.py).
 *
 * Relay (GitHub Actions -> Worker, shared-secret auth, x-pipeline-key:
 * BOX_RELAY_SECRET -- same mechanism as worker.js's own box/callback flow and every
 * other mini app's own relay route, see themes/box_store.py): GET relay/pipeline-token
 * returns a short-lived Box access token plus this app's data_folder_id/
 * tracker_file_id, for the length of one Actions run.
 */

import { requireBetaAuth } from "./beta_auth.js";

const BOX_TOKEN_KEY = "box:tokens";
const BOX_DATA_FOLDER_KEY = "box:data_folder";
const BOX_TRACKER_KEY = "box:tracker";
const BOX_API = "https://api.box.com/2.0";
const BOX_UPLOAD_API = "https://upload.box.com/api/2.0";

// The fixed names each upload target replaces in the Data Folder, wholesale, regardless
// of the uploaded file's own name -- must match themes/quant_data.py's HELPER_FILENAME /
// SURVEY_FILENAME exactly, since the Python side finds these files by name.
const UPLOAD_TARGETS = {
  helper: "Council Meeting Helper.csv",
  survey: "Post-Meeting Survey.csv",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/* ---------- Box (reuses the existing shared connection -- see worker.js's
   box/authorize-url, box/callback; this module talks to the Box API directly with the
   same access-token helper shape rather than importing worker.js internals, same
   pattern src/pcn.js/src/consensus.js/src/mcm.js already use) ---------- */

async function boxAccessToken(env) {
  const tokens = env.BOX_KV ? await env.BOX_KV.get(BOX_TOKEN_KEY) : null;
  if (!tokens) return null;
  const parsed = JSON.parse(tokens);
  const age = Math.floor(Date.now() / 1000) - parsed.obtained_at;
  const remaining = parsed.expires_in - age;
  if (remaining > 120) return { token: parsed.access_token, expiresIn: remaining };
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
  await env.BOX_KV.put(BOX_TOKEN_KEY, JSON.stringify(fresh));
  return { token: fresh.access_token, expiresIn: fresh.expires_in };
}

async function boxDataFolder(env) {
  const raw = await env.BOX_KV.get(BOX_DATA_FOLDER_KEY);
  return raw ? JSON.parse(raw) : null;
}
async function boxTracker(env) {
  const raw = await env.BOX_KV.get(BOX_TRACKER_KEY);
  return raw ? JSON.parse(raw) : null;
}

/* ---------- GitHub Actions dispatch (same shape as src/pcn.js's/src/mcm.js's own
   dispatch/status helpers) ---------- */

function githubHeaders(env) {
  return {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
    "user-agent": "conexus-themes-control-panel",
    "x-github-api-version": "2022-11-28",
  };
}

async function workflowRuns(env, workflowFile) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflowFile}/runs?per_page=3`;
  const response = await fetch(url, { headers: githubHeaders(env) });
  if (!response.ok) return { error: `GitHub ${response.status}`, runs: [] };
  const body = await response.json();
  return {
    runs: (body.workflow_runs || []).map((r) => ({
      id: r.id,
      status: r.status,             // queued | in_progress | completed
      conclusion: r.conclusion,     // success | failure | cancelled | null
      started_at: r.run_started_at,
      updated_at: r.updated_at,
      url: r.html_url,
    })),
  };
}

/* ---------- routes ---------- */

export async function handleCouncilDataApi(route, request, env) {
  if (!env.BOX_KV) return json({ error: "BOX_KV binding is missing -- see SETUP.md." }, 500);
  const method = request.method.toUpperCase();

  // ---- GET relay/pipeline-token -- GitHub Actions -> Worker, shared-secret auth.
  // Checked before requireBetaAuth below, since a pipeline run has no beta-account
  // session. Same mechanism as worker.js's own box/callback flow. ----
  if (route === "relay/pipeline-token" && method === "GET") {
    const key = request.headers.get("x-pipeline-key") || "";
    if (!env.BOX_RELAY_SECRET || key !== env.BOX_RELAY_SECRET) {
      return json({ error: "Not authorized" }, 401);
    }
    const auth = await boxAccessToken(env);
    if (!auth) {
      return json({ error: "Box is not connected. Open the control panel and log in with Box." }, 409);
    }
    // data_folder_id and tracker_file_id are both nullable here on purpose, not a
    // 409: Box being connected but no Data Folder picked yet is a normal pre-setup
    // state, and the Python side (themes/box_store.py, themes/quant_publish.py) has
    // its own graceful handling for "not configured yet" that this route shouldn't
    // short-circuit by raising an error before the caller ever gets to check.
    // tracker_file_id is only needed by the one-time Feedback Log migration script.
    const folder = await boxDataFolder(env);
    const tracker = await boxTracker(env);
    return json({
      access_token: auth.token,
      expires_in: auth.expiresIn,
      data_folder_id: folder ? folder.id : null,
      tracker_file_id: tracker ? tracker.id : null,
    });
  }

  const auth = await requireBetaAuth(request, env);
  if (!auth) return json({ error: "Not signed in" }, 401);

  // ---- GET status -----------------------------------------------------------------
  if (route === "status" && method === "GET") {
    let themes = null;
    try {
      // council-themes.json is one of this Worker's own static assets.
      const assetUrl = new URL("/council-themes.json", request.url);
      const response = await env.ASSETS.fetch(new Request(assetUrl, { method: "GET" }));
      if (response.ok) themes = await response.json();
    } catch (e) { /* nothing published yet */ }

    let quant = null;
    try {
      const assetUrl = new URL("/quant-dashboard.json", request.url);
      const response = await env.ASSETS.fetch(new Request(assetUrl, { method: "GET" }));
      if (response.ok) quant = await response.json();
    } catch (e) { /* nothing published yet */ }

    let updateDashboard = { runs: [] }, setupRun = { runs: [] }, refreshRun = { runs: [] },
        removeRun = { runs: [] };
    if (env.GITHUB_TOKEN && env.GITHUB_REPO) {
      [updateDashboard, setupRun, refreshRun, removeRun] = await Promise.all([
        workflowRuns(env, "update_dashboard.yml"),
        workflowRuns(env, "setup_analysis.yml"),
        workflowRuns(env, "refresh_dashboard.yml"),
        workflowRuns(env, "remove_meetings.yml"),
      ]);
    }
    return json({
      themes, quant,
      workflows: { update_dashboard: updateDashboard, setup: setupRun,
                   refresh_dashboard: refreshRun, remove_meetings: removeRun },
    });
  }

  // ---- POST run { job } -------------------------------------------------------------
  // job: "update_dashboard" | "setup" | "refresh_dashboard" | "remove_meetings" --
  // every job except remove_meetings takes no inputs.
  if (route === "run" && method === "POST") {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
      return json({ error: "GitHub is not connected yet: add the GITHUB_TOKEN secret "
                           + "(and set GITHUB_REPO in wrangler.jsonc)." }, 500);
    }
    let body = {};
    try { body = await request.json(); }
    catch (e) { return json({ error: "Bad request" }, 400); }
    const job = body.job || "";
    // Allowlist: never interpolate caller input into the workflow path.
    const workflow = {
      update_dashboard: "update_dashboard.yml", setup: "setup_analysis.yml",
      refresh_dashboard: "refresh_dashboard.yml", remove_meetings: "remove_meetings.yml",
    }[job];
    if (!workflow) return json({ error: "Unknown job" }, 400);

    const dispatchBody = { ref: env.GITHUB_BRANCH || "main" };
    if (job === "remove_meetings") {
      const ids = Array.isArray(body.survey_ids)
        ? body.survey_ids.map((s) => String(s).trim()).filter(Boolean) : [];
      if (!ids.length) return json({ error: "survey_ids is required" }, 400);
      dispatchBody.inputs = { survey_ids: ids.join(",") };
    }

    const response = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`,
      {
        method: "POST",
        headers: { ...githubHeaders(env), "content-type": "application/json" },
        body: JSON.stringify(dispatchBody),
      }
    );
    if (!response.ok) {
      const detail = await response.text();
      return json({ error: `GitHub refused the trigger (${response.status})`,
                    detail: detail.slice(0, 400) }, 502);
    }
    return json({ ok: true, job, workflow });
  }

  // ---- GET box/status ---------------------------------------------------------------
  if (route === "box/status" && method === "GET") {
    const auth = await boxAccessToken(env);
    const dataFolder = await boxDataFolder(env);
    return json({ connected: Boolean(auth), data_folder: dataFolder || null });
  }

  // ---- POST box/disconnect ------------------------------------------------------------
  // Forgets the ONE shared Box login (every mini app's own box/status will report
  // "not connected" after this, not just this one) plus this app's own Data Folder/
  // tracker selections. Exposed only from this app's control panel, since it's the
  // only one with a "Disconnect" button -- every other mini app just points back here.
  if (route === "box/disconnect" && method === "POST") {
    await env.BOX_KV.delete(BOX_TOKEN_KEY);
    await env.BOX_KV.delete(BOX_DATA_FOLDER_KEY);
    await env.BOX_KV.delete(BOX_TRACKER_KEY);
    return json({ ok: true });
  }

  // ---- GET box/folders?id=0 --------------------------------------------------------
  // Powers the control panel's Data Folder picker. Deliberately not one of Box's
  // pre-built picker widgets -- this has no dependency beyond Box's core folders API.
  if (route === "box/folders" && method === "GET") {
    const boxAuth = await boxAccessToken(env);
    if (!boxAuth) return json({ error: "Box is not connected yet." }, 409);
    const id = new URL(request.url).searchParams.get("id") || "0";
    const headers = { authorization: `Bearer ${boxAuth.token}` };
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
    const entries = items.entries || [];
    const folders = entries.filter((e) => e.type === "folder")
      .map((e) => ({ id: e.id, name: e.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const fileCount = entries.filter(
      (e) => e.type === "file" && !/^~\$/.test(e.name)
    ).length;
    return json({ id, name: info.name, breadcrumb, folders, file_count: fileCount });
  }

  // ---- POST box/select-data-folder ---------------------------------------------------
  if (route === "box/select-data-folder" && method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    if (!body.folder_id) return json({ error: "folder_id is required" }, 400);
    await env.BOX_KV.put(BOX_DATA_FOLDER_KEY, JSON.stringify({
      id: String(body.folder_id), name: String(body.folder_name || ""),
    }));
    return json({ ok: true });
  }

  // ---- GET box/files?id=0 ------------------------------------------------------------
  // Same folder-browsing shape as box/folders, but the panel picks a FILE (the running
  // tracker spreadsheet) rather than a folder to descend into. Lists both, since you
  // often need to navigate through subfolders to find the file. Unused by the current
  // control panel UI -- kept only for the one-time Feedback Log migration script (see
  // scripts/migrate_feedback_log.py). Removed once that migration has run.
  if (route === "box/files" && method === "GET") {
    const boxAuth = await boxAccessToken(env);
    if (!boxAuth) return json({ error: "Box is not connected yet." }, 409);
    const id = new URL(request.url).searchParams.get("id") || "0";
    const headers = { authorization: `Bearer ${boxAuth.token}` };
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
    const entries = items.entries || [];
    const folders = entries.filter((e) => e.type === "folder")
      .map((e) => ({ id: e.id, name: e.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const files = entries.filter(
      (e) => e.type === "file" && /\.xlsx$/i.test(e.name) && !/^~\$/.test(e.name)
    ).map((e) => ({ id: e.id, name: e.name })).sort((a, b) => a.name.localeCompare(b.name));
    return json({ id, name: info.name, breadcrumb, folders, files });
  }

  // ---- POST box/select-tracker --------------------------------------------------------
  if (route === "box/select-tracker" && method === "POST") {
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    if (!body.file_id) return json({ error: "file_id is required" }, 400);
    await env.BOX_KV.put(BOX_TRACKER_KEY, JSON.stringify({
      id: String(body.file_id), name: String(body.file_name || ""),
    }));
    return json({ ok: true });
  }

  // ---- POST box/upload ---------------------------------------------------------------
  // Multipart proxy: the browser posts a file here (multipart/form-data, fields "file"
  // and "target"), authenticated by the normal admin session -- never a Box token in the
  // browser. This Worker re-packages it as Box's own multipart upload request and sends
  // it to the Data Folder, under the fixed name UPLOAD_TARGETS[target] rather than
  // whatever the uploaded file happens to be called locally. Upserts by that fixed name:
  // if it already exists in the Data Folder, this uploads a new version of it instead of
  // creating a duplicate -- both exports are cumulative (each fresh export already
  // contains all previous data plus new data), so replacing wholesale is correct.
  if (route === "box/upload" && method === "POST") {
    const boxAuth = await boxAccessToken(env);
    if (!boxAuth) return json({ error: "Box is not connected yet." }, 409);
    const target = await boxDataFolder(env);
    if (!target) return json({ error: "No Data Folder has been selected yet (see Developer)." }, 409);

    const incoming = await request.formData();
    const file = incoming.get("file");
    if (!(file instanceof File)) return json({ error: "No file in the request." }, 400);
    const filename = UPLOAD_TARGETS[incoming.get("target")];
    if (!filename) return json({ error: "Unknown upload target." }, 400);

    const headers = { authorization: `Bearer ${boxAuth.token}` };
    const itemsRes = await fetch(
      `${BOX_API}/folders/${target.id}/items?fields=name,type&limit=1000`, { headers }
    );
    let existingId = null;
    if (itemsRes.ok) {
      const items = await itemsRes.json();
      const match = (items.entries || []).find((e) => e.type === "file" && e.name === filename);
      if (match) existingId = match.id;
    }

    const outgoing = new FormData();
    if (!existingId) {
      outgoing.append("attributes", JSON.stringify({ name: filename, parent: { id: target.id } }));
    }
    outgoing.append("file", file, filename);
    const uploadUrl = existingId
      ? `${BOX_UPLOAD_API}/files/${existingId}/content`
      : `${BOX_UPLOAD_API}/files/content`;

    const response = await fetch(uploadUrl, { method: "POST", headers, body: outgoing });
    if (!response.ok) {
      const detail = await response.text();
      return json({ error: `Box upload failed (${response.status})`,
                    detail: detail.slice(0, 400) }, 502);
    }
    const body = await response.json();
    const uploaded = (body.entries || [])[0];
    if (!uploaded) return json({ error: "Box did not return the uploaded file." }, 502);
    return json({ ok: true, file_id: uploaded.id, file_name: uploaded.name });
  }

  return json({ error: "Not found" }, 404);
}
