/**
 * Artifact Catalogue: a simple, curated list of Claude artifact links, kept in one
 * nice-looking place on Connector, each with its own public/private toggle. Mounted
 * under /api/artifacts/*.
 *
 * Deliberately NOT a rehosting tool. An earlier version of this tried to export each
 * artifact's HTML and serve it natively from here -- that turned "add an artifact"
 * into a multi-step convert-and-upload chore (and needed a Box folder just to hold
 * the exported files). This version drops all of that: an entry is just a title, the
 * artifact's own claude.ai URL, an optional description, and a visibility tier.
 * Visiting a card takes you straight to the real artifact on claude.ai -- nothing is
 * fetched, converted, or stored on this Worker's behalf beyond that small bit of
 * metadata, so there's nothing to keep in sync and no export step to walk through.
 *
 * Storage: BOX_KV (the shared KV namespace every mini app's small metadata already
 * lives in -- no actual Box file access involved here, same as e.g. src/beta_auth.js's
 * own keys in this namespace) under a single key:
 *   artifacts:manifest -> JSON array of { slug, title, description, url,
 *     visibility ("public"|"private"), addedAt, addedBy, updatedAt }.
 *
 * Visibility only controls whether a card appears on the public gallery
 * (public/artifacts/index.html) -- it has no bearing on who can open the underlying
 * claude.ai link itself; that's governed entirely by however that artifact was shared
 * in claude.ai, outside this app's control.
 */

import { requireBetaAuth } from "./beta_auth.js";

const MANIFEST_KEY = "artifacts:manifest";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function getManifest(env) {
  const raw = await env.BOX_KV.get(MANIFEST_KEY);
  return raw ? JSON.parse(raw) : [];
}

async function saveManifest(env, list) {
  await env.BOX_KV.put(MANIFEST_KEY, JSON.stringify(list));
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
    url: entry.url, addedAt: entry.addedAt,
  };
}

function isHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch (e) {
    return false;
  }
}

/* ---------- routes ---------- */

export async function handleArtifactsApi(route, request, env) {
  const method = request.method.toUpperCase();

  if (!env.BOX_KV) return json({ error: "BOX_KV binding is missing -- see SETUP.md." }, 500);

  // ---- GET list -- public, for the gallery ----------------------------------------
  if (route === "list" && method === "GET") {
    const manifest = await getManifest(env);
    return json({ artifacts: manifest.filter((a) => a.visibility === "public").map(publicView) });
  }

  /* ==================== Everything else is admin-only ==================== */

  const auth = await requireBetaAuth(request, env);
  if (!auth) return json({ error: "Not signed in" }, 401);

  // ---- GET catalogue -- the full list (public + private), for the control panel ---
  if (route === "catalogue" && method === "GET") {
    const manifest = await getManifest(env);
    return json({ artifacts: manifest });
  }

  // ---- POST add { title, url, description?, visibility } --------------------------
  if (route === "add" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const title = String(body.title || "").trim();
    if (!title) return json({ error: "Title is required." }, 400);
    const url = String(body.url || "").trim();
    if (!isHttpUrl(url)) return json({ error: "Enter a valid artifact URL (starting with https://)." }, 400);
    const visibility = String(body.visibility || "");
    if (visibility !== "public" && visibility !== "private") {
      return json({ error: 'visibility must be "public" or "private".' }, 400);
    }

    const manifest = await getManifest(env);
    const slug = uniqueSlug(slugify(title), manifest);
    const now = new Date().toISOString();
    const entry = {
      slug, title, description: String(body.description || "").trim(), url, visibility,
      addedAt: now, addedBy: auth.email, updatedAt: now,
    };
    manifest.push(entry);
    await saveManifest(env, manifest);
    return json({ ok: true, artifact: entry });
  }

  // ---- POST visibility { slug, visibility } -- flips an existing entry's tier -----
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
    await saveManifest(env, manifest);
    return json({ ok: true, artifact: entry });
  }

  // ---- POST delete { slug } --------------------------------------------------------
  if (route === "delete" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const manifest = await getManifest(env);
    const index = manifest.findIndex((a) => a.slug === body.slug);
    if (index === -1) return json({ error: "No artifact with that slug." }, 404);
    manifest.splice(index, 1);
    await saveManifest(env, manifest);
    return json({ ok: true });
  }

  return json({ error: "Not found" }, 404);
}
