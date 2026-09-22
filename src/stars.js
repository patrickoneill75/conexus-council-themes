/**
 * STARs Talent Transfer Explorer: ranks occupations by skill-profile similarity
 * (Euclidean distance across 35 O*NET skill-importance scores) plus Indiana wage
 * data, for two audiences -- an employer looking for transferable talent pools, and
 * a worker looking for higher-wage career pathways -- with a directional skill-gap
 * breakdown for whichever pair is being compared. Mounted under /api/stars/*.
 *
 * Ported from what was originally a fully standalone pair of repos (a private
 * Cloudflare Worker holding the O*NET/wage data, and a public GitHub Pages
 * frontend calling it over CORS). None of that stands alone any more: this mini
 * app reuses everything the platform already has -- admin routes go through
 * Connector's shared admin accounts (see src/beta_auth.js's requireBetaAuth), and
 * Box access is the same shared, user-delegated connection every other mini app
 * here uses. The ranking/matching/skill-gap methodology itself is UNCHANGED --
 * see src/stars_logic.js, a verbatim port of the original repo's logic.js (itself
 * verified identical to the original Python app's output across all 873
 * occupations before that port ever shipped).
 *
 * IMPORTANT -- nothing here calls Claude, ever. The "skill gap" text a request
 * returns is pure deterministic math (a percentage gap per skill) plus a static,
 * hand-written lookup table (src/stars_logic.js's SKILL_ACTIONS, one entry per
 * O*NET skill) -- there is no live model call to "rerun" by porting this over, and
 * no risk of losing anything Claude-generated: SKILL_ACTIONS is checked into this
 * file's source the same way it always was in the original repo.
 *
 * Data: the underlying model is src/data/stars-occupations.json (873 occupations *
 * 35 skill scores + Indiana wage, ~250KB) -- committed to this repo as a durable
 * fallback default, exactly as it already was in the original private repo (so
 * porting this over changes nothing about how safely that data is stored). On top
 * of that fallback, this mini app adds what every other mini app here already has:
 * a real Box folder the admin picks in the control panel
 * (public/stars/control-panel/index.html) to hold the live copy of that data --
 * inspectable and replaceable independent of a code deploy, and (unlike the
 * bundled fallback) where uploading a freshly regenerated occupations.json
 * actually takes effect without waiting on a git push. Once a folder is chosen and
 * a file uploaded there, the Worker reads from a KV cache kept in sync with that
 * Box file (see getOccupationData() below); until then, it serves the bundled
 * fallback so the tool works immediately after a fresh deploy.
 *
 * Regenerating occupations.json (only needed when Indiana wage data or the
 * underlying O*NET skill model changes -- see this repo's stars/README.md) still
 * requires running generate_data.py locally with Python; there is no Claude call
 * and no GitHub Actions workflow in that path, matching the original repo exactly.
 * The regenerated file is uploaded here through the control panel's upload card,
 * same as any other mini app's data folder.
 *
 * Storage: BOX_KV under a "stars:" prefix.
 *   stars:folder       -> JSON { id, name } -- the Box folder holding the live
 *     occupations.json (and, optionally, the source xlsx/wages csv for
 *     provenance), picked once in the control panel.
 *   stars:occupations  -> JSON, the parsed { skills, occupations } payload last
 *     uploaded or refreshed from that folder -- what every public route below
 *     actually reads. Falls back to the bundled src/data/stars-occupations.json
 *     when this key is empty (no folder chosen yet, or nothing uploaded yet).
 *   stars:occupations-meta -> JSON { source: "box" | "bundled-fallback",
 *     occupationCount, skillCount, uploadedAt, uploadedBy } -- what the control
 *     panel's status card reads.
 */

import { requireBetaAuth } from "./beta_auth.js";
import bundledOccupationData from "./data/stars-occupations.json";
import {
  findTransfers,
  findHigherWageTransfers,
  skillGapForEmployerClick,
  skillGapForWorkerClick,
} from "./stars_logic.js";

const BOX_API = "https://api.box.com/2.0";
const BOX_UPLOAD_API = "https://upload.box.com/api/2.0";
const FOLDER_KEY = "stars:folder";
const OCCUPATIONS_KEY = "stars:occupations";
const OCCUPATIONS_META_KEY = "stars:occupations-meta";
const TEST_FILE_NAME = "stars-connection-test.json";
const DATA_FILE_NAME = "occupations.json";
const SOURCE_MODEL_FILE_NAME = "STARs_Model_Data_no_Macros.xlsx";
const SOURCE_WAGES_FILE_NAME = "indiana_median_wages.csv";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/* ---------- Box (reuses the existing shared connection -- see box/status,
   box/folders, box/pipeline-token in worker.js; this module talks to the Box API
   directly with the same access-token helper shape rather than importing
   worker.js internals, to keep the two files independent -- same pattern every
   other mini app here already uses) ---------- */

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

// Generalized over uploadTextFile's shape in every other mini app here -- takes
// a Blob directly instead of assuming text/JSON, since the source workbook
// upload is a raw binary xlsx, not something to stringify.
async function uploadFile(headers, folderId, name, blob, existingFileId) {
  const outgoing = new FormData();
  const uploadUrl = existingFileId
    ? `${BOX_UPLOAD_API}/files/${existingFileId}/content`
    : `${BOX_UPLOAD_API}/files/content`;
  if (!existingFileId) {
    outgoing.append("attributes", JSON.stringify({ name, parent: { id: folderId } }));
  }
  outgoing.append("file", blob, name);
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
  return response;
}

/* ---------- Occupation data: KV cache, falling back to the bundled default ---- */

async function getOccupationData(env) {
  const raw = env.BOX_KV ? await env.BOX_KV.get(OCCUPATIONS_KEY) : null;
  const data = raw ? JSON.parse(raw) : bundledOccupationData;
  // Object.create(null), NOT {}: the public search routes below look titles up in here
  // straight from the request body, and a plain object inherits Object.prototype -- so
  // targetTitle "constructor"/"toString"/"valueOf" would return a function instead of
  // undefined, sail past every `if (!target)` guard, and then throw on target.vector,
  // turning an unauthenticated POST into a 500. A null-prototype map has no inherited
  // keys to hit. It also lets a genuine occupation titled "__proto__" be stored at all.
  const occByTitle = Object.create(null);
  for (const o of data.occupations) occByTitle[o.title] = o;
  return { skills: data.skills, occupations: data.occupations, occByTitle };
}

/* ---------- routes ---------- */

export async function handleStarsApi(route, request, env) {
  const method = request.method.toUpperCase();

  /* ==================== Public routes -- no admin session needed, matching the
     original repo's design exactly (the whole point was a public API a static
     GitHub Pages site could call directly). Checked before requireBetaAuth
     below. ==================== */

  if (route === "occupations" && method === "GET") {
    const { occupations } = await getOccupationData(env);
    return json({ titles: occupations.map((o) => o.title) });
  }

  if (route === "employer/search" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const { skills, occupations, occByTitle } = await getOccupationData(env);
    const result = findTransfers(
      { targetTitle: body.targetTitle, lowerWageOnly: body.lowerWageOnly, resultCount: body.resultCount },
      occByTitle, occupations, skills
    );
    return json(result);
  }

  if (route === "employer/skill-gap" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const { skills, occByTitle } = await getOccupationData(env);
    const result = skillGapForEmployerClick(
      { resultTitles: body.resultTitles, targetTitle: body.targetTitle, rowIndex: body.rowIndex },
      occByTitle, skills
    );
    return json(result);
  }

  if (route === "worker/search" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const { skills, occupations, occByTitle } = await getOccupationData(env);
    const result = findHigherWageTransfers(
      { currentTitle: body.currentTitle, higherWageOnly: body.higherWageOnly, resultCount: body.resultCount },
      occByTitle, occupations, skills
    );
    return json(result);
  }

  if (route === "worker/skill-gap" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const { skills, occByTitle } = await getOccupationData(env);
    const result = skillGapForWorkerClick(
      { resultTitles: body.resultTitles, currentTitle: body.currentTitle, rowIndex: body.rowIndex },
      occByTitle, skills
    );
    return json(result);
  }

  /* ==================== Admin routes ==================== */

  if (!env.BOX_KV) return json({ error: "BOX_KV binding is missing -- see SETUP.md." }, 500);
  const auth = await requireBetaAuth(request, env);
  if (!auth) return json({ error: "Not signed in" }, 401);

  // GET box/folders?id=0 -- same folder-picker copy every other mini app here has.
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

  // GET box/status -> whether the shared Box connection is live, plus this app's
  // own selected folder (independent of every other mini app's own folder).
  if (route === "box/status" && method === "GET") {
    const token = await boxAccessToken(env);
    const folder = await getFolder(env);
    return json({ connected: !!token, folder: folder || null });
  }

  // POST box/select-folder { folderId, folderName } -> sets this app's data folder.
  if (route === "box/select-folder" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    if (!body.folderId) return json({ error: "folderId is required" }, 400);
    await env.BOX_KV.put(FOLDER_KEY, JSON.stringify({
      id: String(body.folderId), name: String(body.folderName || ""),
    }));
    return json({ ok: true });
  }

  // POST box/test -> writes a trivial test file to this app's data folder, reads
  // it straight back, and confirms the round-trip (same shape every other mini
  // app's own box/test uses).
  if (route === "box/test" && method === "POST") {
    const token = await boxAccessToken(env);
    if (!token) return json({ error: "Box is not connected yet -- open the control panel and log in with Box." }, 409);
    const folder = await getFolder(env);
    if (!folder) return json({ error: "Pick a data folder first." }, 409);
    try {
      const headers = { authorization: `Bearer ${token}` };
      const payload = { ok: true, writtenAt: new Date().toISOString(), by: auth.email };
      const existing = await findFileInFolder(headers, folder.id, TEST_FILE_NAME);
      const uploaded = await uploadFile(
        headers, folder.id, TEST_FILE_NAME,
        new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }),
        existing ? existing.id : null
      );
      const readBackRes = await downloadFile(headers, uploaded.entries[0].id);
      return json({ ok: true, wrote: payload, readBack: await readBackRes.json() });
    } catch (e) {
      return json({ error: e.message || "Box round-trip failed." }, 502);
    }
  }

  // GET status -> what's currently loaded (bundled fallback vs. a Box-sourced
  // upload) and whether the source files are present in the data folder, for the
  // control panel's status card.
  if (route === "status" && method === "GET") {
    const folder = await getFolder(env);
    const metaRaw = await env.BOX_KV.get(OCCUPATIONS_META_KEY);
    const meta = metaRaw ? JSON.parse(metaRaw) : {
      source: "bundled-fallback",
      occupationCount: bundledOccupationData.occupations.length,
      skillCount: bundledOccupationData.skills.length,
      uploadedAt: null, uploadedBy: null,
    };

    let sourceFiles = null;
    const token = await boxAccessToken(env);
    if (token && folder) {
      try {
        const headers = { authorization: `Bearer ${token}` };
        const [dataFile, modelFile, wagesFile] = await Promise.all([
          findFileInFolder(headers, folder.id, DATA_FILE_NAME),
          findFileInFolder(headers, folder.id, SOURCE_MODEL_FILE_NAME),
          findFileInFolder(headers, folder.id, SOURCE_WAGES_FILE_NAME),
        ]);
        sourceFiles = { dataFile: !!dataFile, modelFile: !!modelFile, wagesFile: !!wagesFile };
      } catch (e) { /* Box unreachable -- leave sourceFiles null, not fatal for this status view */ }
    }

    return json({ folder: folder || null, meta, sourceFiles });
  }

  // POST upload (multipart: occupationsFile required, modelFile/wagesFile
  // optional) -> uploads occupations.json (and, if given, the source workbook and
  // wage CSV, kept purely for provenance/future regeneration -- never read by any
  // route at request time) to the data folder, and refreshes the KV cache the
  // public routes above read from immediately, no separate "refresh" step needed.
  if (route === "upload" && method === "POST") {
    const token = await boxAccessToken(env);
    if (!token) return json({ error: "Box is not connected yet -- open the control panel and log in with Box." }, 409);
    const folder = await getFolder(env);
    if (!folder) return json({ error: "Pick a data folder first." }, 409);

    let incoming;
    try { incoming = await request.formData(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const occupationsFile = incoming.get("occupationsFile");
    if (!(occupationsFile instanceof File)) return json({ error: "occupations.json file is required." }, 400);

    let parsed;
    try {
      parsed = JSON.parse(await occupationsFile.text());
      if (!Array.isArray(parsed.skills) || !Array.isArray(parsed.occupations)) {
        throw new Error("missing skills/occupations arrays");
      }
    } catch (e) {
      return json({ error: "That file isn't a valid occupations.json (expected { skills: [...], occupations: [...] })." }, 400);
    }

    try {
      const headers = { authorization: `Bearer ${token}` };

      const existingData = await findFileInFolder(headers, folder.id, DATA_FILE_NAME);
      await uploadFile(
        headers, folder.id, DATA_FILE_NAME,
        new Blob([JSON.stringify(parsed)], { type: "application/json" }),
        existingData ? existingData.id : null
      );

      const modelFile = incoming.get("modelFile");
      if (modelFile instanceof File) {
        const existingModel = await findFileInFolder(headers, folder.id, SOURCE_MODEL_FILE_NAME);
        await uploadFile(headers, folder.id, SOURCE_MODEL_FILE_NAME, modelFile, existingModel ? existingModel.id : null);
      }
      const wagesFile = incoming.get("wagesFile");
      if (wagesFile instanceof File) {
        const existingWages = await findFileInFolder(headers, folder.id, SOURCE_WAGES_FILE_NAME);
        await uploadFile(headers, folder.id, SOURCE_WAGES_FILE_NAME, wagesFile, existingWages ? existingWages.id : null);
      }

      await env.BOX_KV.put(OCCUPATIONS_KEY, JSON.stringify(parsed));
      const meta = {
        source: "box", occupationCount: parsed.occupations.length, skillCount: parsed.skills.length,
        uploadedAt: new Date().toISOString(), uploadedBy: auth.email,
      };
      await env.BOX_KV.put(OCCUPATIONS_META_KEY, JSON.stringify(meta));

      return json({ ok: true, meta });
    } catch (e) {
      return json({ error: e.message || "Upload failed." }, 502);
    }
  }

  // POST refresh -> re-reads occupations.json from the data folder (e.g. it was
  // edited or replaced directly in Box, outside this tool's own upload flow) and
  // updates the KV cache the public routes read from.
  if (route === "refresh" && method === "POST") {
    const token = await boxAccessToken(env);
    if (!token) return json({ error: "Box is not connected yet -- open the control panel and log in with Box." }, 409);
    const folder = await getFolder(env);
    if (!folder) return json({ error: "Pick a data folder first." }, 409);

    try {
      const headers = { authorization: `Bearer ${token}` };
      const dataFile = await findFileInFolder(headers, folder.id, DATA_FILE_NAME);
      if (!dataFile) return json({ error: `No ${DATA_FILE_NAME} found in the data folder yet -- upload one first.` }, 409);

      const response = await downloadFile(headers, dataFile.id);
      const parsed = JSON.parse(await response.text());
      if (!Array.isArray(parsed.skills) || !Array.isArray(parsed.occupations)) {
        return json({ error: `${DATA_FILE_NAME} in Box isn't a valid occupations file.` }, 502);
      }

      await env.BOX_KV.put(OCCUPATIONS_KEY, JSON.stringify(parsed));
      const meta = {
        source: "box", occupationCount: parsed.occupations.length, skillCount: parsed.skills.length,
        uploadedAt: new Date().toISOString(), uploadedBy: auth.email,
      };
      await env.BOX_KV.put(OCCUPATIONS_META_KEY, JSON.stringify(meta));
      return json({ ok: true, meta });
    } catch (e) {
      return json({ error: e.message || "Refresh failed." }, 502);
    }
  }

  return json({ error: "Not found" }, 404);
}
