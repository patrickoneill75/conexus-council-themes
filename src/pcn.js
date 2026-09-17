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
 *   pcn:config   -> JSON { folderId, folderName } -- the chosen Box data folder.
 *   pcn:network  -> JSON, the latest connection network pcn/pipeline/derive computed
 *     (see relay/network below) -- what public/pcn/network.html renders.
 *   pcn:timeline -> JSON, the latest change-over-time breakdown
 *     pcn/pipeline/timeline computed (see relay/timeline below) -- what
 *     public/pcn/timeline.html renders.
 *
 * Relay: POST relay/network and POST relay/timeline are how the Python pipeline
 * (running in GitHub Actions, no browser session) publishes its derived output here,
 * authenticated the same shared-secret way (x-pipeline-key: BOX_RELAY_SECRET) as
 * worker.js's own GET /api/box/pipeline-token and src/consensus.js's relay/* routes
 * -- see pcn/relay.py. Checked before requireBetaAuth below, since GitHub Actions has
 * no beta-account session to present.
 */

import { requireBetaAuth } from "./beta_auth.js";

const CONFIG_KEY = "pcn:config";
const NETWORK_KEY = "pcn:network";
const TIMELINE_KEY = "pcn:timeline";
const BOX_API = "https://api.box.com/2.0";
const BOX_UPLOAD_API = "https://upload.box.com/api/2.0";
const TEST_FILE_NAME = "pcn-connection-test.json";

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

/* ---------- routes ---------- */

export async function handlePcnApi(route, request, env) {
  if (!env.BOX_KV) return json({ error: "BOX_KV binding is missing -- see SETUP.md." }, 500);
  const method = request.method.toUpperCase();

  // ---- Relay (GitHub Actions -> Worker, shared-secret auth) -- checked before
  // requireBetaAuth below, since a pipeline run has no beta-account session. ----
  if (route.startsWith("relay/") && method === "POST") {
    const key = request.headers.get("x-pipeline-key") || "";
    if (!env.BOX_RELAY_SECRET || key !== env.BOX_RELAY_SECRET) {
      return json({ error: "Not authorized" }, 401);
    }
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    if (route === "relay/network") {
      await env.BOX_KV.put(NETWORK_KEY, JSON.stringify({ network: body, derivedAt: new Date().toISOString() }));
      return json({ ok: true });
    }
    if (route === "relay/timeline") {
      await env.BOX_KV.put(TIMELINE_KEY, JSON.stringify({ timeline: body, derivedAt: new Date().toISOString() }));
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
