import { handleBetaApi } from "./beta_auth.js";
import { handleConsensusApi } from "./consensus.js";
import { handlePcnApi } from "./pcn.js";
import { handleMcmApi } from "./mcm.js";
import { handleCouncilDataApi } from "./council_data.js";
import { handleStarsApi } from "./stars.js";
import { handleArtifactsApi } from "./artifacts.js";

/**
 * Worker entry point: serves every mini app's public/ pages and delegates /api/*.
 *
 * Everything under public/ is served by Cloudflare's asset layer; anything under
 * /api/ runs here, on Cloudflare's servers, which is what keeps every secret out of
 * the browser. This file itself only holds what's genuinely shared platform-wide:
 *
 *   /api/beta/*         -- the admin-account system (see src/beta_auth.js) -- sign-in,
 *                          settings, and the per-app visibility tiers every mini app's
 *                          own page reads.
 *   /api/council-data/* -- Council Themes/Quant dashboard (see src/council_data.js).
 *   /api/consensus/*    -- Consensus (see src/consensus.js).
 *   /api/pcn/*          -- Issue Network Mapper (see src/pcn.js).
 *   /api/mcm/*          -- Manufacturing Conditions Monitor (see src/mcm.js).
 *   /api/stars/*        -- STARs Talent Transfer Explorer (see src/stars.js).
 *   /api/artifacts/*    -- Artifact Catalogue (see src/artifacts.js).
 *   /api/config-check   -- which Worker secrets are set (unauthenticated diagnostic).
 *   /api/box/authorize-url, /api/box/callback -- the ONE shared Box OAuth login flow.
 *     Every mini app reads the resulting box:tokens KV entry itself (each duplicates
 *     a small read/refresh helper -- see e.g. src/pcn.js's own boxAccessToken()); this
 *     is the only place that flow's initial code exchange happens, since there's one
 *     registered callback URL for the whole app. The actual "Log in with Box" button
 *     lives only in Council Data's own control panel -- see src/council_data.js.
 *
 * CONFIGURATION
 *   GITHUB_TOKEN       (secret)  fine-grained PAT, Actions: read+write on this repo.
 *   BOX_CLIENT_ID      (secret)  the shared Box app's client ID.
 *   BOX_CLIENT_SECRET  (secret)  the shared Box app's client secret.
 *   BOX_RELAY_SECRET   (secret)  shared with GitHub Actions, so a pipeline run can
 *                                fetch a token from its own mini app's relay route.
 *   GITHUB_REPO        (var)     owner/name, set in wrangler.jsonc rather than a dashboard.
 *
 * There is no CONTROL_PASSWORD any more -- every mini app, including Council Data,
 * signs in through the one beta-account system in src/beta_auth.js.
 */

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/* ------------------------------------------------------------------- Box (shared) ----
 * Box connection state lives in Workers KV (binding BOX_KV), not in a Worker secret,
 * because it changes at runtime: the refresh token rotates every time it's used. Only
 * the initial OAuth code exchange lives here -- every mini app reads the resulting
 * box:tokens entry itself. BOX_CLIENT_ID / BOX_CLIENT_SECRET are the app's own
 * credentials and stay in env.
 */
const BOX_TOKEN_KEY = "box:tokens";
const BOX_TOKEN_URL = "https://api.box.com/oauth2/token";
const BOX_AUTHORIZE_URL = "https://account.box.com/api/oauth2/authorize";

async function saveBoxTokens(env, tokens) {
  await env.BOX_KV.put(BOX_TOKEN_KEY, JSON.stringify(tokens));
}

/** Exchange an authorization code for the token pair, saving it to KV. Box rotates the
 * refresh token on every use, so every mini app's own read/refresh helper saves the
 * full new pair back too -- never reuse a refresh token already sent once. */
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

const BUTTON_VARS = ["GITHUB_TOKEN", "GITHUB_REPO"];
const BOX_VARS = ["BOX_CLIENT_ID", "BOX_CLIENT_SECRET", "BOX_RELAY_SECRET"];

async function handleApi(route, request, env) {
  const method = request.method.toUpperCase();

  // ---- /api/beta/* -----------------------------------------------------------------
  if (route === "beta" || route.startsWith("beta/")) {
    return handleBetaApi(route.slice("beta".length).replace(/^\/+/, ""), request, env);
  }

  // ---- /api/council-data/* ----------------------------------------------------------
  if (route === "council-data" || route.startsWith("council-data/")) {
    return handleCouncilDataApi(route.slice("council-data".length).replace(/^\/+/, ""), request, env);
  }

  // ---- /api/consensus/* ----------------------------------------------------------------
  if (route === "consensus" || route.startsWith("consensus/")) {
    return handleConsensusApi(route.slice("consensus".length).replace(/^\/+/, ""), request, env);
  }

  // ---- /api/pcn/* ----------------------------------------------------------------------
  if (route === "pcn" || route.startsWith("pcn/")) {
    return handlePcnApi(route.slice("pcn".length).replace(/^\/+/, ""), request, env);
  }

  // ---- /api/mcm/* ----------------------------------------------------------------------
  if (route === "mcm" || route.startsWith("mcm/")) {
    return handleMcmApi(route.slice("mcm".length).replace(/^\/+/, ""), request, env);
  }

  // ---- /api/stars/* --------------------------------------------------------------------
  if (route === "stars" || route.startsWith("stars/")) {
    return handleStarsApi(route.slice("stars".length).replace(/^\/+/, ""), request, env);
  }

  // ---- /api/artifacts/* ------------------------------------------------------------------
  if (route === "artifacts" || route.startsWith("artifacts/")) {
    return handleArtifactsApi(route.slice("artifacts".length).replace(/^\/+/, ""), request, env);
  }

  // ---- GET /api/config-check ---------------------------------------------------------
  // Deliberately unauthenticated: you cannot sign in to diagnose a broken sign-in. It
  // reports only WHETHER each variable is set — never a value, never a length.
  if (route === "config-check" && method === "GET") {
    const present = {};
    for (const name of [...BUTTON_VARS, ...BOX_VARS]) present[name] = Boolean(env[name]);
    return json({
      buttons_configured: BUTTON_VARS.every((n) => present[n]),
      box_kv_bound: Boolean(env.BOX_KV),
      present,
      missing_for_buttons: BUTTON_VARS.filter((n) => !present[n]),
      worker: env.WORKER_NAME || "(WORKER_NAME not set in wrangler.jsonc)",
      hostname: new URL(request.url).hostname,
    });
  }

  // ---- GET /api/box/authorize-url -----------------------------------------------------
  if (route === "box/authorize-url" && method === "GET") {
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
  // a session that actually clicked "Log in with Box" (from Council Data's own control
  // panel -- see src/council_data.js's module docstring on why it's the only one).
  if (route === "box/callback" && method === "GET") {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const stateKey = state ? `box:state:${state}` : null;
    const stateOk = stateKey && env.BOX_KV ? await env.BOX_KV.get(stateKey) : null;
    if (stateKey && env.BOX_KV) await env.BOX_KV.delete(stateKey);
    const returnTo = `${url.origin}/council-data/control-panel/index.html`;
    if (!code || !state || !stateOk) {
      return Response.redirect(`${returnTo}?box=error&msg=`
        + encodeURIComponent("Login link expired or was already used — try again."), 302);
    }
    try {
      const redirectUri = `${url.origin}/api/box/callback`;
      await boxTokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
    } catch (e) {
      return Response.redirect(`${returnTo}?box=error&msg=`
        + encodeURIComponent(String((e && e.message) || e).slice(0, 200)), 302);
    }
    return Response.redirect(`${returnTo}?box=connected`, 302);
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
