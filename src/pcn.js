/**
 * PCN Issue Map: turns PCN meeting notes/transcripts into an accumulating, evidence-
 * traceable map of how members believe their problems connect, mounted under
 * /api/pcn/*. See the design doc for the full build (this file only covers build
 * step 1: Worker + control panel login + a Box round-trip, no extraction yet).
 *
 * Admin routes reuse the Mini App Platform's own admin accounts (see
 * src/beta_auth.js's requireBetaAuth), same as src/consensus.js -- no separate
 * control-panel password.
 *
 * Box: this mini app talks to Box with its OWN service account via Client
 * Credentials Grant (CCG), NOT the existing user-delegated OAuth connection the
 * Council Survey Dashboard and Consensus share. That's a deliberate choice in the
 * design doc -- the IT request for a dedicated folder + CCG service account scoped
 * to file read/write only is far more likely to be approved than broadening the
 * scope of the existing shared, user-delegated Box app. Nothing here reads or
 * writes env.BOX_KV's "box:tokens" key or reuses worker.js's OAuth helpers; it's a
 * fully independent credential, cached under its own KV key.
 *
 * Secrets (Cloudflare Worker secrets AND GitHub Actions secrets -- both sides need
 * them, since the Worker reads finished data directly and GitHub Actions does the
 * actual processing read-modify-write cycle):
 *   PCN_BOX_CLIENT_ID, PCN_BOX_CLIENT_SECRET, PCN_BOX_ENTERPRISE_ID -- the CCG
 *     service account credentials.
 *   PCN_BOX_FOLDER_ID -- the one dedicated Box folder (data file at its root, a
 *     subfolder for raw source documents). Provisioned once via IT request; not
 *     admin-choosable through a folder picker the way Consensus's per-survey
 *     responses folder is, since the design calls for exactly one fixed folder.
 */

import { requireBetaAuth } from "./beta_auth.js";

const BOX_TOKEN_KEY = "pcn:box-token";
const BOX_API = "https://api.box.com/2.0";
const BOX_UPLOAD_API = "https://upload.box.com/api/2.0";
const TEST_FILE_NAME = "pcn-connection-test.json";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function boxCredentialsConfigured(env) {
  return !!(env.PCN_BOX_CLIENT_ID && env.PCN_BOX_CLIENT_SECRET && env.PCN_BOX_ENTERPRISE_ID);
}

/* ---------- Box (Client Credentials Grant -- see module docstring) ---------- */

async function fetchFreshToken(env) {
  const response = await fetch("https://api.box.com/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.PCN_BOX_CLIENT_ID,
      client_secret: env.PCN_BOX_CLIENT_SECRET,
      box_subject_type: "enterprise",
      box_subject_id: env.PCN_BOX_ENTERPRISE_ID,
    }),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Box refused the token request (${response.status}): ${detail.slice(0, 300)}`);
  }
  return response.json();
}

// CCG tokens are fetched fresh (no refresh token involved, unlike the existing
// 3-legged OAuth flow) but still worth caching briefly -- same shape/reasoning as
// consensus.js's boxAccessToken, just a different grant type underneath.
async function pcnBoxAccessToken(env) {
  if (!boxCredentialsConfigured(env)) return null;
  const cached = env.BOX_KV ? await env.BOX_KV.get(BOX_TOKEN_KEY) : null;
  if (cached) {
    const parsed = JSON.parse(cached);
    const age = Math.floor(Date.now() / 1000) - parsed.obtained_at;
    if (parsed.expires_in - age > 120) return parsed.access_token;
  }
  const fresh = await fetchFreshToken(env);
  if (env.BOX_KV) {
    await env.BOX_KV.put(BOX_TOKEN_KEY, JSON.stringify({
      access_token: fresh.access_token,
      obtained_at: Math.floor(Date.now() / 1000),
      expires_in: fresh.expires_in || 3600,
    }));
  }
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

  const auth = await requireBetaAuth(request, env);
  if (!auth) return json({ error: "Not signed in" }, 401);

  // GET box/status -> whether the CCG credentials and folder are configured, and (if
  // so) whether they actually work -- fetches the folder's own name as the check.
  if (route === "box/status" && method === "GET") {
    if (!boxCredentialsConfigured(env) || !env.PCN_BOX_FOLDER_ID) {
      return json({ configured: false });
    }
    try {
      const token = await pcnBoxAccessToken(env);
      const headers = { authorization: `Bearer ${token}` };
      const response = await fetch(`${BOX_API}/folders/${env.PCN_BOX_FOLDER_ID}?fields=name`, { headers });
      if (!response.ok) throw new Error(`Box API error (${response.status})`);
      const folder = await response.json();
      return json({ configured: true, connected: true, folderName: folder.name });
    } catch (e) {
      return json({ configured: true, connected: false, error: e.message });
    }
  }

  // POST box/test -> writes a trivial test file to the dedicated folder, reads it
  // straight back, and confirms the round-trip -- exactly build step 1's bar, nothing
  // about extraction or the real data model yet.
  if (route === "box/test" && method === "POST") {
    if (!boxCredentialsConfigured(env)) {
      return json({ error: "Box credentials aren't set up yet (PCN_BOX_CLIENT_ID / " +
        "PCN_BOX_CLIENT_SECRET / PCN_BOX_ENTERPRISE_ID) -- see SETUP.md." }, 500);
    }
    if (!env.PCN_BOX_FOLDER_ID) {
      return json({ error: "PCN_BOX_FOLDER_ID isn't set yet -- see SETUP.md." }, 500);
    }
    try {
      const token = await pcnBoxAccessToken(env);
      const headers = { authorization: `Bearer ${token}` };
      const payload = { ok: true, writtenAt: new Date().toISOString(), by: auth.email };
      const existing = await findFileInFolder(headers, env.PCN_BOX_FOLDER_ID, TEST_FILE_NAME);
      const uploaded = await uploadTextFile(
        headers, env.PCN_BOX_FOLDER_ID, TEST_FILE_NAME,
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

  return json({ error: "Not found" }, 404);
}
