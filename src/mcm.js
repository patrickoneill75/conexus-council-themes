/**
 * Manufacturing Conditions Monitor (MCM): turns SEC EDGAR manufacturing filings into a
 * quarterly headwinds/tailwinds dashboard (Claude extraction + narrative), mounted
 * under /api/mcm/*. This file is just the Worker side (control panel auth, the Box
 * round-trip, and the relay route the Python pipeline pulls a token through) -- the
 * actual SEC discovery/extraction/analysis/publish pipeline is Python, in mcm/ (see
 * mcm/config.py and the top-level SETUP.md's "Manufacturing Conditions Monitor"
 * section for the full design).
 *
 * Ported from what was originally a fully standalone repo (its own Cloudflare Worker,
 * KV namespace, Box app registration, and CONTROL_PASSWORD). None of that stands alone
 * any more: this mini app reuses everything the platform already has --
 *
 * Admin routes reuse the Mini App Platform's own admin accounts (see
 * src/beta_auth.js's requireBetaAuth), same as src/pcn.js and src/consensus.js -- no
 * password of MCM's own.
 *
 * Box: this mini app uses the SAME shared, user-delegated Box connection every other
 * tool in this repo uses (see worker.js's box/authorize-url, box/callback, box/status)
 * -- not a separate service account or app registration. Unlike PCN (which walls off a
 * folder per project), MCM has exactly one dataset, so it keeps exactly one destination
 * folder, in its own KV key (mcm:folder) so it never collides with Council Themes/
 * Quant's Data Folder or any PCN project's folder.
 *
 * Storage: BOX_KV under an "mcm:" prefix.
 *   mcm:folder          -> JSON { id, name } -- the Box folder holding MCM's six data
 *     files (filings.csv, paragraphs.csv, signals.csv, companies.csv, narratives.json,
 *     status.json), picked once in the control panel (public/mcm/index.html).
 *   mcm:run-dispatch     -> ISO timestamp of the last POST run dispatch, so run-status
 *     can tell a fresh run apart from a stale already-completed one.
 *
 * Relay (GitHub Actions -> Worker, shared-secret auth, x-pipeline-key:
 * BOX_RELAY_SECRET -- same mechanism as worker.js's own GET /api/box/pipeline-token
 * and src/pcn.js's/src/consensus.js's own relay routes, see mcm/box_store.py): GET
 * relay/pipeline-token returns a short-lived Box access token plus mcm:folder's id, for
 * the length of one download/analyze/publish run. Checked before requireBetaAuth below,
 * since GitHub Actions has no beta-account session.
 *
 * The finished dashboard (public/mcm/dashboard.html, built by mcm/site.py from whatever
 * mcm_download.yml/mcm_analyze.yml/mcm_publish.yml last committed) is plain static JSON
 * fetched straight off the asset layer -- it never calls anything under /api/mcm/*, so
 * it stays fully public with no auth of any kind, exactly like this repo's own root
 * public/index.html. Only the control panel (public/mcm/index.html) and the routes
 * below are gated.
 */

import { requireBetaAuth } from "./beta_auth.js";

const BOX_API = "https://api.box.com/2.0";
const BOX_UPLOAD_API = "https://upload.box.com/api/2.0";
const FOLDER_KEY = "mcm:folder";
const RUN_DISPATCH_KEY = "mcm:run-dispatch";
const TEST_FILE_NAME = "mcm-connection-test.json";

const WORKFLOWS = {
  download: "mcm_download.yml",
  analyze: "mcm_analyze.yml",
  publish: "mcm_publish.yml",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/* ---------- Box (reuses the existing shared connection -- see box/status, box/folders,
   box/pipeline-token in worker.js; this module talks to the Box API directly with the
   same access-token helper shape rather than importing worker.js internals, to keep
   the two files independent -- same pattern src/pcn.js/src/consensus.js already use) --*/

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

async function getFolder(env) {
  const raw = await env.BOX_KV.get(FOLDER_KEY);
  return raw ? JSON.parse(raw) : null;
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

/* ---------- GitHub Actions dispatch (same shape as src/pcn.js's/src/consensus.js's own
   dispatch/status helpers) ---------- */

function githubHeaders(env) {
  return {
    authorization: `Bearer ${env.GITHUB_TOKEN}`,
    accept: "application/vnd.github+json",
    "user-agent": "conexus-themes-control-panel",
    "x-github-api-version": "2022-11-28",
  };
}

async function dispatchRun(env, workflowFile) {
  const response = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflowFile}/dispatches`,
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

async function workflowRuns(env, workflowFile) {
  const url = `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflowFile}/runs?per_page=3`;
  const response = await fetch(url, { headers: githubHeaders(env) });
  if (!response.ok) return { error: `GitHub ${response.status}`, runs: [] };
  const body = await response.json();
  return {
    runs: (body.workflow_runs || []).map((r) => ({
      id: r.id, status: r.status, conclusion: r.conclusion,
      started_at: r.run_started_at, updated_at: r.updated_at, url: r.html_url,
    })),
  };
}

/* ---------- routes ---------- */

export async function handleMcmApi(route, request, env) {
  if (!env.BOX_KV) return json({ error: "BOX_KV binding is missing -- see SETUP.md." }, 500);
  const method = request.method.toUpperCase();

  // ---- GET relay/pipeline-token -- GitHub Actions -> Worker, shared-secret auth.
  // Checked before requireBetaAuth below, since a pipeline run has no beta-account
  // session. Same mechanism as worker.js's own GET /api/box/pipeline-token. ----
  if (route === "relay/pipeline-token" && method === "GET") {
    const key = request.headers.get("x-pipeline-key") || "";
    if (!env.BOX_RELAY_SECRET || key !== env.BOX_RELAY_SECRET) {
      return json({ error: "Not authorized" }, 401);
    }
    const token = await boxAccessToken(env);
    if (!token) {
      return json({ error: "Box is not connected. Open the control panel and log in with Box." }, 409);
    }
    const folder = await getFolder(env);
    if (!folder) {
      return json({ error: "No Box folder has been selected yet for MCM. Open its control panel." }, 409);
    }
    // The real remaining lifetime, not env's own guess -- mcm/box_store.py caches
    // this token for up to the length of a run, same reasoning as worker.js's own
    // box/pipeline-token route.
    const tokens = JSON.parse(await env.BOX_KV.get("box:tokens"));
    const age = Math.floor(Date.now() / 1000) - tokens.obtained_at;
    const expiresIn = Math.max(60, tokens.expires_in - age);
    return json({ access_token: token, folder_id: folder.id, expires_in: expiresIn });
  }

  const auth = await requireBetaAuth(request, env);
  if (!auth) return json({ error: "Not signed in" }, 401);

  // GET box/folders?id=0 -- same folder-picker copy PCN/Consensus already have,
  // gated by requireBetaAuth rather than worker.js's own CONTROL_PASSWORD session.
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

  // GET box/status -> whether the shared Box connection is live, plus MCM's own
  // selected folder (independent of Council Themes/Quant's Data Folder or any PCN
  // project's folder).
  if (route === "box/status" && method === "GET") {
    const token = await boxAccessToken(env);
    const folder = await getFolder(env);
    return json({ connected: !!token, folder: folder || null });
  }

  // POST box/select-folder { folderId, folderName } -> sets MCM's destination folder.
  if (route === "box/select-folder" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    if (!body.folderId) return json({ error: "folderId is required" }, 400);
    await env.BOX_KV.put(FOLDER_KEY, JSON.stringify({
      id: String(body.folderId), name: String(body.folderName || ""),
    }));
    return json({ ok: true });
  }

  // POST box/test -> writes a trivial test file to MCM's data folder, reads it
  // straight back, and confirms the round-trip (same shape as PCN's own box/test).
  if (route === "box/test" && method === "POST") {
    const token = await boxAccessToken(env);
    if (!token) return json({ error: "Box is not connected yet -- open the control panel and log in with Box." }, 409);
    const folder = await getFolder(env);
    if (!folder) return json({ error: "Pick a data folder first." }, 409);
    try {
      const headers = { authorization: `Bearer ${token}` };
      const payload = { ok: true, writtenAt: new Date().toISOString(), by: auth.email };
      const existing = await findFileInFolder(headers, folder.id, TEST_FILE_NAME);
      const uploaded = await uploadTextFile(
        headers, folder.id, TEST_FILE_NAME,
        JSON.stringify(payload, null, 2), existing ? existing.id : null
      );
      const readBack = await downloadFile(headers, uploaded.entries[0].id);
      return json({ ok: true, wrote: payload, readBack: JSON.parse(readBack) });
    } catch (e) {
      return json({ error: e.message || "Box round-trip failed." }, 502);
    }
  }

  // GET status -> the published status.json (one of this Worker's own static assets,
  // at public/mcm/status.json) plus each of the three workflows' recent runs -- same
  // technique worker.js's own GET /api/status uses for council-themes.json.
  if (route === "status" && method === "GET") {
    let pipeline = null;
    try {
      const assetUrl = new URL("/mcm/status.json", request.url);
      const response = await env.ASSETS.fetch(new Request(assetUrl, { method: "GET" }));
      if (response.ok) pipeline = await response.json();
    } catch (e) { /* nothing published yet */ }

    let download = { runs: [] }, analyze = { runs: [] }, publish = { runs: [] };
    if (env.GITHUB_TOKEN && env.GITHUB_REPO) {
      [download, analyze, publish] = await Promise.all([
        workflowRuns(env, WORKFLOWS.download),
        workflowRuns(env, WORKFLOWS.analyze),
        workflowRuns(env, WORKFLOWS.publish),
      ]);
    }
    return json({ pipeline, workflows: { download, analyze, publish } });
  }

  // POST run { job: "download" | "analyze" | "publish" } -> dispatches the matching
  // workflow. Mirrors src/pcn.js's/src/consensus.js's own analyze dispatch.
  if (route === "run" && method === "POST") {
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
      return json({ error: "GitHub is not connected yet (see SETUP.md)." }, 500);
    }
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const workflow = WORKFLOWS[body.job];
    if (!workflow) return json({ error: "Unknown job" }, 400);
    await env.BOX_KV.put(RUN_DISPATCH_KEY, new Date().toISOString());
    try {
      await dispatchRun(env, workflow);
    } catch (e) {
      return json({ error: e.message }, 502);
    }
    return json({ ok: true, job: body.job, workflow });
  }

  return json({ error: "Not found" }, 404);
}
