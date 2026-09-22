/**
 * Artifact Catalogue: rehosts lightweight, self-contained Claude artifacts (dashboards,
 * one-off tools, visualizations) as native pages on Connector, each with its own
 * public/private visibility toggle. Mounted under /api/artifacts/*.
 *
 * IMPORTANT LIMITATION -- read before assuming this "just pulls in a claude.ai link":
 * a Cloudflare Worker has no API it can call to reach into claude.ai and fetch an
 * artifact's content on its own; there is no public endpoint for that. Getting an
 * artifact INTO this catalogue is a two-step, partly-manual process:
 *   1. Ask Claude (in a Claude Code / claude.ai session, using the Artifact tool's
 *      "read" action) to export the artifact's raw HTML to a file -- this only works
 *      for an artifact you own; a shared/duplicated-in one only yields a text summary,
 *      not the full page, and can't be imported this way without first "remixing" it
 *      into your own account in claude.ai.
 *   2. Upload that HTML file through this app's control panel
 *      (public/artifacts/control-panel/index.html), where the title/description/source
 *      URL/visibility are set.
 * The "source URL" field an admin can set on an artifact is stored purely as
 * attribution/a "view original" link -- it is never fetched by this Worker.
 *
 * A second real limitation: an artifact that uses Claude's "runtime capabilities"
 * (live data reads, shared storage, window.claude.* calls) depends on being served
 * from claude.ai's own backend. Once exported as a static HTML file and rehosted here,
 * those calls simply fail (window.claude won't exist) -- this catalogue only works
 * well for artifacts that are truly self-contained, matching the "lightweight" ones
 * this was built for.
 *
 * Storage: BOX_KV under an "artifacts:" prefix, same shared, user-delegated Box
 * connection every other mini app here uses.
 *   artifacts:folder         -> JSON { id, name } -- the Box folder holding
 *     manifest.json plus one <slug>.html file per catalogued artifact.
 *   artifacts:manifest       -> JSON array of { slug, title, description, sourceUrl,
 *     visibility ("public"|"private"), addedAt, addedBy, updatedAt } -- mirrors
 *     manifest.json in the Box folder (the durable copy); this is the fast-read cache
 *     every route below actually reads.
 *   artifacts:html:<slug>    -> the raw HTML text for that artifact -- mirrors
 *     <slug>.html in the Box folder the same way.
 *
 * Rendering: an artifact's HTML is served as JSON (not a bare text/html response) so
 * the viewer page (public/artifacts/view.html) can set it via `iframe.srcdoc` inside a
 * sandboxed, allow-same-origin-less iframe -- this keeps a catalogued artifact's own
 * script from ever touching Connector's cookies/localStorage/DOM even though it's
 * served from the same origin, and sidesteps the problem of an <iframe src="..."> not
 * being able to carry an Authorization header for a private artifact.
 */

import { requireBetaAuth } from "./beta_auth.js";

const BOX_API = "https://api.box.com/2.0";
const BOX_UPLOAD_API = "https://upload.box.com/api/2.0";
const FOLDER_KEY = "artifacts:folder";
const MANIFEST_KEY = "artifacts:manifest";
const HTML_KEY_PREFIX = "artifacts:html:";
const TEST_FILE_NAME = "artifacts-connection-test.json";
const MANIFEST_FILE_NAME = "manifest.json";
const MAX_HTML_BYTES = 16 * 1024 * 1024; // matches the Artifact tool's own page-size cap

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/* ---------- Box (same shape every other mini app here duplicates) ---------- */

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

async function deleteFile(headers, fileId) {
  // Best-effort -- a manifest/KV update is what actually controls what this app
  // serves, so a Box-side delete failure (e.g. the file was already removed by hand)
  // is logged-and-ignored rather than failing the whole delete request.
  try { await fetch(`${BOX_API}/files/${fileId}`, { method: "DELETE", headers }); }
  catch (e) { /* not fatal */ }
}

/* ---------- Manifest: KV cache, mirrored to manifest.json in the Box folder ---------- */

async function getManifest(env) {
  const raw = await env.BOX_KV.get(MANIFEST_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function saveManifest(env, list, headers, folder) {
  await env.BOX_KV.put(MANIFEST_KEY, JSON.stringify(list));
  if (headers && folder) {
    const existing = await findFileInFolder(headers, folder.id, MANIFEST_FILE_NAME);
    await uploadFile(
      headers, folder.id, MANIFEST_FILE_NAME,
      new Blob([JSON.stringify(list, null, 2)], { type: "application/json" }),
      existing ? existing.id : null
    );
  }
}

function slugify(title) {
  const base = String(title || "").toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return base || "artifact";
}

function uniqueSlug(base, manifest) {
  const taken = new Set(manifest.map((a) => a.slug));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

function publicView(entry) {
  return {
    slug: entry.slug, title: entry.title, description: entry.description || "",
    sourceUrl: entry.sourceUrl || "", addedAt: entry.addedAt,
  };
}

/* ---------- routes ---------- */

export async function handleArtifactsApi(route, request, env) {
  const method = request.method.toUpperCase();

  /* ==================== Public routes -- checked before requireBetaAuth below;
     "artifact/<slug>" does its own conditional auth check for private entries. ==== */

  if (route === "list" && method === "GET") {
    const manifest = await getManifest(env);
    return json({ artifacts: manifest.filter((a) => a.visibility === "public").map(publicView) });
  }

  if (route.startsWith("artifact/") && method === "GET") {
    const slug = route.slice("artifact/".length);
    const manifest = await getManifest(env);
    const entry = manifest.find((a) => a.slug === slug);
    if (!entry) return json({ error: "No artifact with that slug." }, 404);
    if (entry.visibility === "private") {
      const auth = await requireBetaAuth(request, env);
      if (!auth) return json({ error: "This artifact is private." }, 401);
    }
    const html = (await env.BOX_KV.get(HTML_KEY_PREFIX + slug)) || "";
    return json({
      slug: entry.slug, title: entry.title, description: entry.description || "",
      sourceUrl: entry.sourceUrl || "", visibility: entry.visibility, html,
    });
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

  // GET catalogue -> the full manifest (public + private) plus the chosen folder,
  // for the control panel's table.
  if (route === "catalogue" && method === "GET") {
    const folder = await getFolder(env);
    const manifest = await getManifest(env);
    return json({ folder: folder || null, artifacts: manifest });
  }

  // POST upload (multipart: title + visibility + htmlFile required; slug/description/
  // sourceUrl optional) -> uploads <slug>.html to the data folder, updates
  // manifest.json there, and refreshes the KV cache every route above reads from.
  if (route === "upload" && method === "POST") {
    const token = await boxAccessToken(env);
    if (!token) return json({ error: "Box is not connected yet -- open the control panel and log in with Box." }, 409);
    const folder = await getFolder(env);
    if (!folder) return json({ error: "Pick a data folder first." }, 409);

    let incoming;
    try { incoming = await request.formData(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const title = String(incoming.get("title") || "").trim();
    if (!title) return json({ error: "Title is required." }, 400);
    const visibility = String(incoming.get("visibility") || "");
    if (visibility !== "public" && visibility !== "private") {
      return json({ error: 'visibility must be "public" or "private".' }, 400);
    }
    const htmlFile = incoming.get("htmlFile");
    if (!(htmlFile instanceof File)) return json({ error: "An exported HTML file is required." }, 400);
    if (htmlFile.size > MAX_HTML_BYTES) {
      return json({ error: `That file is too large (max ${Math.floor(MAX_HTML_BYTES / 1024 / 1024)}MB).` }, 400);
    }
    const html = await htmlFile.text();
    if (!/<html[\s>]/i.test(html) && !/^\s*<!doctype html/i.test(html)) {
      return json({ error: "That doesn't look like an exported artifact HTML file (no <html> tag found)." }, 400);
    }

    const manifest = await getManifest(env);
    const requestedSlug = slugify(String(incoming.get("slug") || "") || title);
    const slug = uniqueSlug(requestedSlug, manifest);
    const now = new Date().toISOString();
    const entry = {
      slug, title, description: String(incoming.get("description") || "").trim(),
      sourceUrl: String(incoming.get("sourceUrl") || "").trim(), visibility,
      addedAt: now, addedBy: auth.email, updatedAt: now,
    };

    try {
      const headers = { authorization: `Bearer ${token}` };
      const fileName = `${slug}.html`;
      const existingFile = await findFileInFolder(headers, folder.id, fileName);
      await uploadFile(
        headers, folder.id, fileName,
        new Blob([html], { type: "text/html" }),
        existingFile ? existingFile.id : null
      );
      manifest.push(entry);
      await saveManifest(env, manifest, headers, folder);
      await env.BOX_KV.put(HTML_KEY_PREFIX + slug, html);
      return json({ ok: true, artifact: entry });
    } catch (e) {
      return json({ error: e.message || "Upload failed." }, 502);
    }
  }

  // POST visibility { slug, visibility } -> flips an existing artifact's tier.
  if (route === "visibility" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const visibility = String(body.visibility || "");
    if (visibility !== "public" && visibility !== "private") {
      return json({ error: 'visibility must be "public" or "private".' }, 400);
    }
    const manifest = await getManifest(env);
    const entry = manifest.find((a) => a.slug === body.slug);
    if (!entry) return json({ error: "No artifact with that slug." }, 404);
    entry.visibility = visibility;
    entry.updatedAt = new Date().toISOString();

    const token = await boxAccessToken(env);
    const folder = await getFolder(env);
    const headers = token ? { authorization: `Bearer ${token}` } : null;
    try {
      await saveManifest(env, manifest, headers, folder);
      return json({ ok: true, artifact: entry });
    } catch (e) {
      return json({ error: e.message || "Could not update the manifest in Box." }, 502);
    }
  }

  // POST delete { slug } -> removes the artifact from the manifest and KV, and
  // best-effort deletes its HTML file from the Box folder.
  if (route === "delete" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const manifest = await getManifest(env);
    const index = manifest.findIndex((a) => a.slug === body.slug);
    if (index === -1) return json({ error: "No artifact with that slug." }, 404);
    const [removed] = manifest.splice(index, 1);

    const token = await boxAccessToken(env);
    const folder = await getFolder(env);
    const headers = token ? { authorization: `Bearer ${token}` } : null;
    try {
      if (headers && folder) {
        const file = await findFileInFolder(headers, folder.id, `${removed.slug}.html`);
        if (file) await deleteFile(headers, file.id);
      }
      await saveManifest(env, manifest, headers, folder);
      await env.BOX_KV.delete(HTML_KEY_PREFIX + removed.slug);
      return json({ ok: true });
    } catch (e) {
      return json({ error: e.message || "Could not update the manifest in Box." }, 502);
    }
  }

  return json({ error: "Not found" }, 404);
}
