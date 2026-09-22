/**
 * Connector's own admin-account system, mounted under /api/beta/* (the route prefix
 * predates the "Connector"/"/admin" rebrand and was kept as-is to avoid churn -- it's
 * an internal name, never shown to a user).
 *
 * A multi-user account system (each admin has their own email/username/password) that
 * every mini app's control panel signs into via requireBetaAuth -- including Council
 * Themes/Quant's own (see src/council_data.js), which used to have its own separate
 * CONTROL_PASSWORD. There is no per-app password anywhere in this repo any more.
 *
 * Storage: reuses the BOX_KV namespace (no new namespace to create in the Cloudflare
 * dashboard) under a "beta:" key prefix, so it never collides with the Box connection
 * state already living there.
 *   beta:admin-emails         -> JSON [{ email, username }, ...] -- who is ALLOWED to
 *                                 have an account. Adding an admin means appending here.
 *   beta:admin-account:<email> -> JSON { email, username, password_hash, password_salt,
 *                                 created_at } -- only exists once that person has
 *                                 actually set a password. Its absence is exactly what
 *                                 "hasn't set up yet" / "just got reset" means.
 *   beta:session-secret        -> a random signing key, generated once on first use and
 *                                 reused after that.
 *   beta:app-visibility        -> see the module docstring further down, near
 *                                 APP_VISIBILITY_KEY.
 *
 * Passwords are hashed with PBKDF2-SHA256 (a random 16-byte salt per account) via the
 * Workers runtime's own Web Crypto -- no external dependency. The iteration count
 * (PBKDF2_ITERATIONS below) is deliberately much lower than a typical server-side
 * recommendation like OWASP's 210,000+: Workers meters actual CPU time per request
 * (the Free plan's default budget is ~10ms), not wall-clock time, and PBKDF2 is pure
 * CPU work -- 210,000 iterations measured at ~95ms in testing, comfortably over that
 * budget on its own, which is what actually happened the first time this shipped: the
 * Worker was killed mid-request for exceeding its CPU limit, and Cloudflare's own
 * generic HTML error page came back instead of JSON (surfacing in the browser as a
 * "<!DOCTYPE" JSON-parse error, not as anything this code ever returns). 5,000
 * iterations measures at ~3ms, leaving headroom even for the one request that ever
 * does two PBKDF2 calls at once (ensureSeedAdmin() hashing the seed password, then the
 * login handler verifying it, the first time anyone ever hits /api/beta/*).
 *
 * Setup and "forgot password" are deliberately the same endpoint (setup-complete): an
 * email can set a password whenever it's on the allowlist AND has no password on file,
 * which is true both for a brand-new admin and for an existing one another admin just
 * reset. Resetting an existing password is the one action that requires already being
 * signed in (POST /api/beta/admins/reset) -- self-service only ever *sets* a password
 * that isn't there, never *clears* one that is.
 *
 * Also holds the per-app visibility setting every mini app checks (see public/apps.js
 * for the app registry itself, which is static and unrelated to this):
 *   beta:app-visibility -> JSON { [appId]: "public" | "hidden" | "admin-only" }.
 *   GET is deliberately unauthenticated -- the public grid (public/index.html) has no
 *   session and needs to read it to decide which tiles to show. POST requires
 *   requireBetaAuth, same as everything else admin-side.
 *
 * Security note: setup-complete does not verify the requester actually owns that email
 * inbox (no email-sending service is wired up) -- anyone who knows an allowlisted
 * address can claim it, as long as it doesn't already have a password. That is a
 * deliberate, low-stakes tradeoff (see SETUP.md) rather than an oversight; wiring up a
 * real "magic link" flow later would need an email-sending secret (e.g. Resend) and a
 * few more routes here, not a different storage model.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ALLOWLIST_KEY = "beta:admin-emails";
const SESSION_SECRET_KEY = "beta:session-secret";
const APP_VISIBILITY_KEY = "beta:app-visibility";
const SESSION_TTL_SECONDS = 60 * 60 * 8;
const PBKDF2_ITERATIONS = 5000;
const VISIBILITY_TIERS = ["public", "hidden", "admin-only"];
// Mirrors the ids in public/apps.js (kept in sync by hand -- that file is a static
// asset, not part of this Worker's module graph, so it can't be imported here).
// Apps with real, already-public content default to "public"; anything else defaults
// to "admin-only" until an admin explicitly opens it up from Settings.
const KNOWN_APP_IDS = ["council-data", "mcm", "pcn", "consensus", "stars", "artifacts", "job-description"];
const DEFAULT_PUBLIC_APPS = ["council-data", "mcm", "stars"];

const SEED_ADMIN_EMAIL = "poneill@conexusindiana.com";
const SEED_ADMIN_USERNAME = "poneill";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function accountKey(email) {
  return `beta:admin-account:${normalizeEmail(email)}`;
}

/* ---------- bytes / base64 ---------- */

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function bytesToBase64url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64urlToBytes(b64url) {
  let b64 = String(b64url || "").replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return base64ToBytes(b64);
}
function strToBase64url(str) {
  return bytesToBase64url(encoder.encode(str));
}
function base64urlToStr(b64url) {
  return decoder.decode(base64urlToBytes(b64url));
}

/* ---------- crypto ---------- */

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
  return bytesToBase64url(new Uint8Array(sig));
}

async function hashPassword(password, existingSaltB64) {
  // Salts and hashes are both stored with bytesToBase64() (the standard alphabet), so
  // they're decoded the same way here -- no need for the base64url helpers, which exist
  // only for the URL-safe session token.
  const salt = existingSaltB64 ? base64ToBytes(existingSaltB64) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, keyMaterial, 256
  );
  return { hash: bytesToBase64(new Uint8Array(bits)), salt: bytesToBase64(salt) };
}

async function verifyPassword(password, hashB64, saltB64) {
  if (!hashB64 || !saltB64) return false;
  const { hash } = await hashPassword(password, saltB64);
  return timingSafeEqual(hash, hashB64);
}

/* ---------- session tokens ---------- */

async function sessionSecret(env) {
  let secret = await env.BOX_KV.get(SESSION_SECRET_KEY);
  if (!secret) {
    secret = bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
    await env.BOX_KV.put(SESSION_SECRET_KEY, secret);
  }
  return secret;
}

async function issueToken(env, payload) {
  const secret = await sessionSecret(env);
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const body = strToBase64url(JSON.stringify({ ...payload, exp }));
  return `${body}.${await hmac(secret, body)}`;
}

async function verifyToken(env, token) {
  if (!token || token.indexOf(".") < 0) return null;
  const [body, signature] = token.split(".", 2);
  const secret = await sessionSecret(env);
  if (!timingSafeEqual(signature, await hmac(secret, body))) return null;
  let payload;
  try { payload = JSON.parse(base64urlToStr(body)); } catch (e) { return null; }
  if (!payload || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function bearer(request) {
  const header = request.headers.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

async function requireAuth(request, env) {
  const payload = await verifyToken(env, bearer(request));
  if (!payload || !payload.email) return null;
  return payload;
}

/* Exported so other mini apps built on this platform (e.g. src/consensus.js) can gate
   their own admin routes with the same accounts, without each mini app inventing its
   own login system. Returns { email, username } or null -- never throws. */
export async function requireBetaAuth(request, env) {
  return requireAuth(request, env);
}

/* ---------- storage ---------- */

async function getAllowlist(env) {
  const raw = await env.BOX_KV.get(ALLOWLIST_KEY);
  return raw ? JSON.parse(raw) : [];
}
async function saveAllowlist(env, list) {
  await env.BOX_KV.put(ALLOWLIST_KEY, JSON.stringify(list));
}
function findAllowlistEntry(list, email) {
  const target = normalizeEmail(email);
  return list.find((a) => normalizeEmail(a.email) === target) || null;
}

async function getAppVisibility(env) {
  const raw = await env.BOX_KV.get(APP_VISIBILITY_KEY);
  return raw ? JSON.parse(raw) : {};
}
async function saveAppVisibility(env, map) {
  await env.BOX_KV.put(APP_VISIBILITY_KEY, JSON.stringify(map));
}
function tierFor(map, appId) {
  return map[appId] || (DEFAULT_PUBLIC_APPS.includes(appId) ? "public" : "admin-only");
}

async function getAccount(env, email) {
  const raw = await env.BOX_KV.get(accountKey(email));
  return raw ? JSON.parse(raw) : null;
}
async function saveAccount(env, email, record) {
  await env.BOX_KV.put(accountKey(email), JSON.stringify(record));
}
async function deleteAccount(env, email) {
  await env.BOX_KV.delete(accountKey(email));
}

/* One admin, bootstrapped from a repository secret rather than the self-service UI --
   there's no existing admin yet to add poneill@conexusindiana.com to the list, or to
   click "reset" for him. Cheap and idempotent: once his account record exists, every
   later call is a single KV read that short-circuits immediately. Runs even if
   poneill_password was never set as a Cloudflare secret -- it just no-ops. */
async function ensureSeedAdmin(env) {
  if (!env.poneill_password) return;
  if (await getAccount(env, SEED_ADMIN_EMAIL)) return;

  const allowlist = await getAllowlist(env);
  if (!findAllowlistEntry(allowlist, SEED_ADMIN_EMAIL)) {
    allowlist.push({ email: SEED_ADMIN_EMAIL, username: SEED_ADMIN_USERNAME });
    await saveAllowlist(env, allowlist);
  }

  const { hash, salt } = await hashPassword(env.poneill_password);
  await saveAccount(env, SEED_ADMIN_EMAIL, {
    email: SEED_ADMIN_EMAIL, username: SEED_ADMIN_USERNAME,
    password_hash: hash, password_salt: salt, created_at: new Date().toISOString(),
  });
}

/* ---------- routes ---------- */

export async function handleBetaApi(route, request, env) {
  if (!env.BOX_KV) {
    return json({ error: "BOX_KV binding is missing -- see SETUP.md." }, 500);
  }
  await ensureSeedAdmin(env);
  const method = request.method.toUpperCase();

  // ---- POST /api/beta/login -----------------------------------------------------------
  // { identifier, password } -- identifier is an email or a username, either works.
  if (route === "login" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const identifier = normalizeEmail(body.identifier);
    const password = String(body.password || "");
    // Flat delay regardless of which way this fails, same reasoning as admin.html's own
    // login: a wrong guess always costs the same, so timing can't narrow down why.
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!identifier || !password) {
      return json({ error: "Enter your email/username and password." }, 400);
    }

    const allowlist = await getAllowlist(env);
    const entry = allowlist.find((a) =>
      normalizeEmail(a.email) === identifier
      || (a.username && a.username.toLowerCase() === identifier));
    const account = entry ? await getAccount(env, entry.email) : null;
    if (!account || !(await verifyPassword(password, account.password_hash, account.password_salt))) {
      return json({ error: "Incorrect email/username or password." }, 401);
    }
    const token = await issueToken(env, { email: account.email, username: account.username });
    return json({ ok: true, token, email: account.email, username: account.username });
  }

  // ---- POST /api/beta/setup-check ------------------------------------------------------
  // { email } -> { allowed, reason? }. Checked before the password field is even shown,
  // so the UI can explain why rather than just failing silently on submit.
  if (route === "setup-check" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const email = normalizeEmail(body.email);
    if (!email) return json({ allowed: false, reason: "Enter an email address." });
    const allowlist = await getAllowlist(env);
    if (!findAllowlistEntry(allowlist, email)) {
      return json({ allowed: false, reason: "That email isn't on the admin list." });
    }
    if (await getAccount(env, email)) {
      return json({ allowed: false,
        reason: "That account already has a password. Ask another admin to reset it first." });
    }
    return json({ allowed: true });
  }

  // ---- POST /api/beta/setup-complete ---------------------------------------------------
  // { email, username, password } -- the same endpoint for a brand-new admin and for an
  // existing one whose password an admin just reset (see module docstring).
  if (route === "setup-complete" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const email = normalizeEmail(body.email);
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!email) return json({ error: "Enter an email address." }, 400);
    if (!username) return json({ error: "Choose a username." }, 400);
    if (password.length < 8) return json({ error: "Password must be at least 8 characters." }, 400);

    const allowlist = await getAllowlist(env);
    const entry = findAllowlistEntry(allowlist, email);
    if (!entry) return json({ error: "That email isn't on the admin list." }, 403);
    if (await getAccount(env, email)) {
      return json({ error: "That account already has a password. Ask another admin to reset it first." }, 409);
    }
    const usernameTaken = allowlist.some((a) =>
      normalizeEmail(a.email) !== email && a.username && a.username.toLowerCase() === username.toLowerCase());
    if (usernameTaken) return json({ error: "That username is already taken." }, 409);

    entry.username = username;
    await saveAllowlist(env, allowlist);

    const { hash, salt } = await hashPassword(password);
    await saveAccount(env, email, {
      email, username, password_hash: hash, password_salt: salt,
      created_at: new Date().toISOString(),
    });

    const token = await issueToken(env, { email, username });
    return json({ ok: true, token, email, username });
  }

  // ---- GET /api/beta/me -----------------------------------------------------------------
  if (route === "me" && method === "GET") {
    const auth = await requireAuth(request, env);
    if (!auth) return json({ error: "Not signed in" }, 401);
    return json({ email: auth.email, username: auth.username });
  }

  // ---- GET /api/beta/admins --------------------------------------------------------------
  if (route === "admins" && method === "GET") {
    const auth = await requireAuth(request, env);
    if (!auth) return json({ error: "Not signed in" }, 401);
    const allowlist = await getAllowlist(env);
    const admins = await Promise.all(allowlist.map(async (a) => ({
      email: a.email,
      username: a.username || null,
      has_password: Boolean(await getAccount(env, a.email)),
    })));
    return json({ admins });
  }

  // ---- POST /api/beta/admins -------------------------------------------------------------
  // { email } -- adds to the allowlist. That's it; the new admin picks their own
  // username and password the first time they use "Set up new account".
  if (route === "admins" && method === "POST") {
    const auth = await requireAuth(request, env);
    if (!auth) return json({ error: "Not signed in" }, 401);
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const email = normalizeEmail(body.email);
    if (!email || email.indexOf("@") < 0) return json({ error: "Enter a valid email address." }, 400);
    const allowlist = await getAllowlist(env);
    if (findAllowlistEntry(allowlist, email)) return json({ ok: true, already_present: true });
    allowlist.push({ email, username: null });
    await saveAllowlist(env, allowlist);
    return json({ ok: true });
  }

  // ---- POST /api/beta/admins/reset ---------------------------------------------------------
  // { email } -- clears that admin's password (deletes their account record). They stay
  // on the allowlist, so "Set up new account" on the login page sets them a new one.
  if (route === "admins/reset" && method === "POST") {
    const auth = await requireAuth(request, env);
    if (!auth) return json({ error: "Not signed in" }, 401);
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const email = normalizeEmail(body.email);
    const allowlist = await getAllowlist(env);
    if (!findAllowlistEntry(allowlist, email)) {
      return json({ error: "That email isn't on the admin list." }, 404);
    }
    await deleteAccount(env, email);
    return json({ ok: true });
  }

  // ---- GET /api/beta/app-visibility --------------------------------------------------
  // Deliberately unauthenticated -- the public grid (public/index.html) reads this
  // with no session to decide which tiles to show. Returns every known app's
  // resolved tier (defaults filled in via tierFor()/KNOWN_APP_IDS above), plus
  // whatever else is in the stored map (forward-compatible with an app added to
  // public/apps.js before this file's KNOWN_APP_IDS is updated to match).
  if (route === "app-visibility" && method === "GET") {
    const stored = await getAppVisibility(env);
    const visibility = { ...stored };
    for (const id of KNOWN_APP_IDS) visibility[id] = tierFor(stored, id);
    return json({ visibility });
  }

  // ---- POST /api/beta/app-visibility -------------------------------------------------
  // { id, tier } -- tier is one of "public" | "hidden" | "admin-only".
  if (route === "app-visibility" && method === "POST") {
    const auth = await requireAuth(request, env);
    if (!auth) return json({ error: "Not signed in" }, 401);
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const id = String(body.id || "").trim();
    const tier = String(body.tier || "").trim();
    if (!id) return json({ error: "id is required" }, 400);
    if (!VISIBILITY_TIERS.includes(tier)) {
      return json({ error: `tier must be one of: ${VISIBILITY_TIERS.join(", ")}` }, 400);
    }
    const map = await getAppVisibility(env);
    map[id] = tier;
    await saveAppVisibility(env, map);
    return json({ ok: true, visibility: map });
  }

  return json({ error: "Not found" }, 404);
}
