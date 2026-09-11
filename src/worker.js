/**
 * Worker entry point: serves the public dashboard and the control-panel API.
 *
 * Same shape as conexus-mcm: everything under public/ is served by Cloudflare's asset
 * layer, and anything under /api/ runs here, on Cloudflare's servers. That is what keeps
 * the control password, the GitHub token and the Box credentials out of the browser.
 *
 * Routes:
 *   GET  /api/config-check                  -> which variables are set (unauthenticated)
 *   POST /api/login      { password }       -> { ok, token }
 *   GET  /api/status                        -> published themes + workflow run info
 *   POST /api/run        { job: refresh }   -> triggers the GitHub Actions workflow
 *   GET  /api/box/authorize-url             -> where to send the browser to log in
 *   GET  /api/box/callback                  -> Box redirects here after consent
 *   GET  /api/box/status                    -> { connected, folder }
 *   POST /api/box/disconnect
 *   GET  /api/box/folders?id=0              -> folder browser for the panel
 *   POST /api/box/select-folder
 *   GET  /api/box/pipeline-token            -> short-lived token for the Actions run
 *
 * CONFIGURATION
 *   CONTROL_PASSWORD   (secret)  the control-panel password. Needed to sign in.
 *   GITHUB_TOKEN       (secret)  fine-grained PAT, Actions: read+write on this repo.
 *   BOX_CLIENT_ID      (secret)  the Box app's client ID.
 *   BOX_CLIENT_SECRET  (secret)  the Box app's client secret.
 *   BOX_RELAY_SECRET   (secret)  shared with GitHub Actions, so a run can fetch a token.
 *   GITHUB_REPO        (var)     owner/name, set in wrangler.jsonc rather than a dashboard.
 *
 * The session signing key is derived from CONTROL_PASSWORD: anyone who knows the password
 * can already sign in, so a separate signing secret buys nothing and is one more thing to
 * get wrong. Changing the password invalidates existing sessions, which is what you want.
 */

const SESSION_TTL_SECONDS = 60 * 60 * 8;
const encoder = new TextEncoder();

async function sessionKey(env) {
  return `themes-session-v1:${env.CONTROL_PASSWORD}`;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Compare without leaking length or position through timing. */
function timingSafeEqual(a, b) {
  const abuf = encoder.encode(a || "");
  const bbuf = encoder.encode(b || "");
  if (abuf.length !== bbuf.length) return false;
  let diff = 0;
  for (let i = 0; i < abuf.length; i++) diff |= abuf[i] ^ bbuf[i];
  return diff === 0;
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function issueToken(secret) {
  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  return `${expires}.${await hmac(secret, String(expires))}`;
}

async function verifyToken(secret, token) {
  if (!token || token.indexOf(".") < 0) return false;
  const [expires, signature] = token.split(".", 2);
  if (!/^\d+$/.test(expires)) return false;
  if (Number(expires) < Math.floor(Date.now() / 1000)) return false;
  return timingSafeEqual(signature, await hmac(secret, expires));
}

function bearer(request) {
  const header = request.headers.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

async function requireAuth(request, env) {
  if (!env.CONTROL_PASSWORD) return json({ error: "Control panel is not configured." }, 500);
  if (!(await verifyToken(await sessionKey(env), bearer(request)))) {
    return json({ error: "Not signed in" }, 401);
  }
  return null;
}

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

/* ------------------------------------------------------------------- Box (source) ----
 * Box connection state lives in Workers KV (binding BOX_KV), not in a Worker secret,
 * because it changes at runtime: the refresh token rotates every time it's used, and the
 * source folder changes whenever the admin picks a new one in the control panel.
 * BOX_CLIENT_ID / BOX_CLIENT_SECRET are the app's own credentials and stay in env.
 */
const BOX_TOKEN_KEY = "box:tokens";
const BOX_FOLDER_KEY = "box:folder";
const BOX_TOKEN_URL = "https://api.box.com/oauth2/token";
const BOX_AUTHORIZE_URL = "https://account.box.com/api/oauth2/authorize";
const BOX_API = "https://api.box.com/2.0";

async function boxTokens(env) {
  const raw = await env.BOX_KV.get(BOX_TOKEN_KEY);
  return raw ? JSON.parse(raw) : null;
}
async function saveBoxTokens(env, tokens) {
  await env.BOX_KV.put(BOX_TOKEN_KEY, JSON.stringify(tokens));
}
async function boxFolder(env) {
  const raw = await env.BOX_KV.get(BOX_FOLDER_KEY);
  return raw ? JSON.parse(raw) : null;
}

/** Exchange an authorization code, or refresh an existing pair. Box rotates the refresh
 * token on every use, so the full new pair is always saved back to KV — never reuse a
 * refresh token you have already sent once. */
async function boxTokenRequest(env, params) {
  const response = await fetch(BOX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.BOX_CLIENT_ID, client_secret: env.BOX_CLIENT_SECRET, ...params,
    }),
  });
  if (!response.ok) {
    throw new Error(`Box token request failed (${response.status}): `
                    + (await response.text()).slice(0, 300));
  }
  const body = await response.json();
  const tokens = {
    access_token: body.access_token, refresh_token: body.refresh_token,
    obtained_at: Math.floor(Date.now() / 1000), expires_in: body.expires_in || 3600,
  };
  await saveBoxTokens(env, tokens);
  return tokens;
}

/** A currently-valid access token, refreshing first if the cached one is close to
 * expiring, plus how many seconds of real life it has left — the pipeline caches this
 * token for the length of a run, so an optimistic number here is how a long-expired
 * token ends up being sent to Box. Returns null if Box has never been connected. */
async function validBoxAccessToken(env) {
  const tokens = await boxTokens(env);
  if (!tokens) return null;
  const age = Math.floor(Date.now() / 1000) - tokens.obtained_at;
  const remaining = tokens.expires_in - age;
  if (remaining > 120) return { token: tokens.access_token, expiresIn: remaining };
  const refreshed = await boxTokenRequest(env, {
    grant_type: "refresh_token", refresh_token: tokens.refresh_token,
  });
  return { token: refreshed.access_token, expiresIn: refreshed.expires_in };
}

const REQUIRED_VARS = ["CONTROL_PASSWORD"];
const BUTTON_VARS = ["GITHUB_TOKEN", "GITHUB_REPO"];
const BOX_VARS = ["BOX_CLIENT_ID", "BOX_CLIENT_SECRET", "BOX_RELAY_SECRET"];

async function handleApi(route, request, env) {
  const method = request.method.toUpperCase();

  // ---- GET /api/config-check ---------------------------------------------------------
  // Deliberately unauthenticated: you cannot sign in to diagnose a broken sign-in. It
  // reports only WHETHER each variable is set — never a value, never a length.
  if (route === "config-check" && method === "GET") {
    const present = {};
    for (const name of [...REQUIRED_VARS, ...BUTTON_VARS, ...BOX_VARS]) present[name] = Boolean(env[name]);
    return json({
      configured: REQUIRED_VARS.every((n) => present[n]),
      buttons_configured: BUTTON_VARS.every((n) => present[n]),
      box_kv_bound: Boolean(env.BOX_KV),
      present,
      missing: REQUIRED_VARS.filter((n) => !present[n]),
      missing_for_buttons: BUTTON_VARS.filter((n) => !present[n]),
      worker: env.WORKER_NAME || "(WORKER_NAME not set in wrangler.jsonc)",
      hostname: new URL(request.url).hostname,
    });
  }

  // ---- POST /api/login ---------------------------------------------------------------
  if (route === "login" && method === "POST") {
    if (!env.CONTROL_PASSWORD) {
      return json({ error: "Control panel is not configured (missing secrets)." }, 500);
    }
    let password = "";
    try { password = (await request.json()).password || ""; }
    catch (e) { return json({ error: "Bad request" }, 400); }
    // Blunt brute-force damping: a wrong password always costs ~400ms.
    if (!timingSafeEqual(password, env.CONTROL_PASSWORD)) {
      await new Promise((r) => setTimeout(r, 400));
      return json({ error: "Incorrect password" }, 401);
    }
    return json({ ok: true, token: await issueToken(await sessionKey(env)) });
  }

  // ---- GET /api/status ---------------------------------------------------------------
  if (route === "status" && method === "GET") {
    const denied = await requireAuth(request, env);
    if (denied) return denied;

    let themes = null;
    try {
      // themes.json is one of this Worker's own static assets.
      const assetUrl = new URL("/themes.json", request.url);
      const response = await env.ASSETS.fetch(new Request(assetUrl, { method: "GET" }));
      if (response.ok) themes = await response.json();
    } catch (e) { /* nothing published yet */ }

    let refresh = { runs: [] };
    if (env.GITHUB_TOKEN && env.GITHUB_REPO) refresh = await workflowRuns(env, "refresh.yml");
    return json({ themes, workflows: { refresh } });
  }

  // ---- POST /api/run -----------------------------------------------------------------
  if (route === "run" && method === "POST") {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
      return json({ error: "GitHub is not connected yet: add the GITHUB_TOKEN secret "
                           + "(and set GITHUB_REPO in wrangler.jsonc)." }, 500);
    }
    let job = "";
    try { job = (await request.json()).job || ""; }
    catch (e) { return json({ error: "Bad request" }, 400); }
    // Allowlist: never interpolate caller input into the workflow path.
    const workflow = { refresh: "refresh.yml" }[job];
    if (!workflow) return json({ error: "Unknown job" }, 400);

    const response = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`,
      {
        method: "POST",
        headers: { ...githubHeaders(env), "content-type": "application/json" },
        body: JSON.stringify({ ref: env.GITHUB_BRANCH || "main" }),
      }
    );
    if (!response.ok) {
      const detail = await response.text();
      return json({ error: `GitHub refused the trigger (${response.status})`,
                    detail: detail.slice(0, 400) }, 502);
    }
    return json({ ok: true, job, workflow });
  }

  // ---- GET /api/box/authorize-url -----------------------------------------------------
  if (route === "box/authorize-url" && method === "GET") {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    if (!env.BOX_CLIENT_ID || !env.BOX_KV) {
      return json({ error: "Box is not set up yet on this Worker (BOX_CLIENT_ID or the "
                          + "BOX_KV binding is missing). See SETUP.md." }, 500);
    }
    const state = crypto.randomUUID();
    await env.BOX_KV.put(`box:state:${state}`, "1", { expirationTtl: 600 });
    const redirectUri = `${new URL(request.url).origin}/api/box/callback`;
    const url = `${BOX_AUTHORIZE_URL}?` + new URLSearchParams({
      response_type: "code", client_id: env.BOX_CLIENT_ID, redirect_uri: redirectUri, state,
    });
    return json({ url });
  }

  // ---- GET /api/box/callback ----------------------------------------------------------
  // Box redirects the browser here directly after login/consent — no bearer token is
  // available on this hop, so the one-time `state` value proves this callback belongs to
  // a session that actually clicked "Log in with Box".
  if (route === "box/callback" && method === "GET") {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const stateKey = state ? `box:state:${state}` : null;
    const stateOk = stateKey && env.BOX_KV ? await env.BOX_KV.get(stateKey) : null;
    if (stateKey && env.BOX_KV) await env.BOX_KV.delete(stateKey);
    if (!code || !state || !stateOk) {
      return Response.redirect(`${url.origin}/admin.html?box=error&msg=`
        + encodeURIComponent("Login link expired or was already used — try again."), 302);
    }
    try {
      const redirectUri = `${url.origin}/api/box/callback`;
      await boxTokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
    } catch (e) {
      return Response.redirect(`${url.origin}/admin.html?box=error&msg=`
        + encodeURIComponent(String((e && e.message) || e).slice(0, 200)), 302);
    }
    return Response.redirect(`${url.origin}/admin.html?box=connected`, 302);
  }

  // ---- GET /api/box/status -------------------------------------------------------------
  if (route === "box/status" && method === "GET") {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const tokens = env.BOX_KV ? await boxTokens(env) : null;
    const folder = env.BOX_KV ? await boxFolder(env) : null;
    return json({ connected: Boolean(tokens), folder: folder || null });
  }

  // ---- POST /api/box/disconnect --------------------------------------------------------
  if (route === "box/disconnect" && method === "POST") {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    if (env.BOX_KV) {
      await env.BOX_KV.delete(BOX_TOKEN_KEY);
      await env.BOX_KV.delete(BOX_FOLDER_KEY);
    }
    return json({ ok: true });
  }

  // ---- GET /api/box/folders?id=0 --------------------------------------------------------
  // Powers the control panel's own folder browser. Deliberately not one of Box's pre-built
  // picker widgets — this has no dependency beyond Box's core folders API, the same one
  // themes/box_store.py already uses for the refresh itself.
  if (route === "box/folders" && method === "GET") {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    const auth = await validBoxAccessToken(env);
    if (!auth) return json({ error: "Box is not connected yet." }, 409);
    const id = new URL(request.url).searchParams.get("id") || "0";
    const headers = { authorization: `Bearer ${auth.token}` };
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
    // How many Word documents sit here, so the panel can say "12 documents" next to
    // "Use this folder" rather than making you guess whether you picked the right one.
    const docCount = entries.filter(
      (e) => e.type === "file" && /\.docx$/i.test(e.name) && !/^~\$/.test(e.name)
    ).length;
    return json({ id, name: info.name, breadcrumb, folders, doc_count: docCount });
  }

  // ---- POST /api/box/select-folder ------------------------------------------------------
  if (route === "box/select-folder" && method === "POST") {
    const denied = await requireAuth(request, env);
    if (denied) return denied;
    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    if (!body.folder_id) return json({ error: "folder_id is required" }, 400);
    await env.BOX_KV.put(BOX_FOLDER_KEY, JSON.stringify({
      id: String(body.folder_id), name: String(body.folder_name || ""),
    }));
    return json({ ok: true });
  }

  // ---- GET /api/box/pipeline-token -------------------------------------------------------
  // Called by themes/box_store.py during a refresh run, authenticated by a shared secret
  // rather than the admin session — GitHub Actions has no browser to sign in with. This is
  // the only way to reach a Box access token from outside this Worker.
  if (route === "box/pipeline-token" && method === "GET") {
    const key = request.headers.get("x-pipeline-key") || "";
    if (!env.BOX_RELAY_SECRET || !timingSafeEqual(key, env.BOX_RELAY_SECRET)) {
      return json({ error: "Not authorized" }, 401);
    }
    const auth = await validBoxAccessToken(env);
    if (!auth) {
      return json({ error: "Box is not connected. Open the control panel and log in with Box." }, 409);
    }
    const folder = await boxFolder(env);
    if (!folder) {
      return json({ error: "No Box folder has been selected yet. Open the control panel." }, 409);
    }
    return json({ access_token: auth.token, folder_id: folder.id, expires_in: auth.expiresIn });
  }

  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const route = url.pathname.slice("/api/".length).replace(/\/+$/, "");
      return handleApi(route, request, env);
    }
    return env.ASSETS.fetch(request);
  },
};
