/**
 * Connector's own staff-account system, mounted under /api/beta/* (the route prefix
 * predates the "Connector"/"/admin" rebrand and was kept as-is to avoid churn -- it's
 * an internal name, never shown to a user).
 *
 * A multi-user account system (each person signs in with their email and a password; an admin enters
 * their first and last name when adding them; there are no usernames) that
 * every mini app's control panel and staff pages sign into via requireBetaAuth --
 * including Council Themes/Quant's own (see src/council_data.js), which used to have its
 * own separate CONTROL_PASSWORD. There is no per-app password anywhere in this repo any
 * more.
 *
 * WHO CAN DO WHAT
 *   Every person on the list is either an overall "admin" or a "user".
 *   - An overall admin reaches everything: every app, every control panel, Settings. Only
 *     overall admins manage people (add, remove, set role, assign apps), change app
 *     visibility, connect Box, and open /admin/settings.html.
 *   - A user reaches only the apps they are given, one by one, by app id ("apps"). Use
 *     access opens that app's staff pages: its base page when its visibility tier is
 *     "admin-only", and Partner Intelligence, which is always staff-only.
 *   - A user can also be made admin of particular apps ("appAdmin"), e.g. Brooke is a user
 *     who admins "council-data". App admin implies use access, and adds that app's control
 *     panel and the API routes behind it. Plain users never reach a control panel.
 *   Each mini app checks its own routes with canUseApp / canAdminApp on the identity
 *   requireBetaAuth returns. Permissions are read fresh from storage on every request,
 *   never baked into the token, so a change applies without anyone signing out.
 *
 * Storage: reuses the BOX_KV namespace (no new namespace to create in the Cloudflare
 * dashboard) under a "beta:" key prefix, so it never collides with the Box connection
 * state already living there.
 *   beta:admin-emails         -> JSON [{ email, firstName, lastName, role, apps, appAdmin }, ...] --
 *                                 who is ALLOWED to have an account (the key name predates
 *                                 roles: it holds users as well as admins). An entry
 *                                 written before roles existed has no role and counts as
 *                                 an overall admin, so nobody lost access when roles
 *                                 shipped. A newly added person is a user with no apps.
 *   beta:admin-account:<email> -> JSON { email, password_hash, password_salt,
 *                                 session_version, created_at } -- only exists once that
 *                                 person has actually set a password. Its absence is
 *                                 exactly what "hasn't set up yet" / "just got reset" means.
 *   beta:session-secret        -> a random signing key, generated once on first use and
 *                                 reused after that.
 *   beta:login-fail:account:<email or identifier>, beta:login-fail:ip:<address>
 *                              -> the login rate limit's counters (see LOGIN_WINDOW_SECONDS).
 *   beta:app-visibility        -> see the module docstring further down, near
 *                                 APP_VISIBILITY_KEY.
 *
 * Sessions: an HMAC-signed token { email, sv, exp } that lasts 8 hours. "sv" is
 * the account's session_version at sign-in. Every authenticated request re-reads the list
 * and the account record and refuses the token when the person is off the list, the
 * record is gone (a password reset deletes it), or the version moved on ("Sign out
 * everywhere" writes a new one). The version is random rather than a counter, because a
 * reset deletes the record a counter would live in: a fresh record starting again at 1
 * would revive every token issued before the reset.
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
 * login handler verifying it, the first time anyone ever hits /api/beta/*). The low count
 * is why login is rate limited: five wrong passwords for one account in 15 minutes locks
 * that account's sign-in for 15 minutes, and about twenty from one address locks that
 * address. KV is eventually consistent, so the limit is best effort (see loginLimits).
 *
 * Setup and "forgot password" are deliberately the same endpoint (setup-complete): an
 * email can set a password whenever it's on the list AND has no password on file,
 * which is true both for a brand-new person and for an existing one an admin just
 * reset. Resetting an existing password is an overall admin's action
 * (POST /api/beta/admins/reset) -- self-service only ever *sets* a password that isn't
 * there, never *clears* one that is.
 *
 * Also holds the per-app visibility setting every mini app checks (see public/apps.js
 * for the app registry itself, which is static and unrelated to this):
 *   beta:app-visibility -> JSON { [appId]: "public" | "hidden" | "admin-only" }.
 *   GET is deliberately unauthenticated -- the public grid (public/index.html) has no
 *   session and needs to read it to decide which tiles to show. POST requires an
 *   overall admin. Settings shows the stored "admin-only" tier as "Staff with access".
 *
 * Security note: setup-complete does not verify the requester actually owns that email
 * inbox (no email-sending service is wired up) -- anyone who knows a listed address can
 * claim it, as long as it doesn't already have a password. That is a deliberate,
 * low-stakes tradeoff (see SETUP.md) rather than an oversight; wiring up a real
 * "magic link" flow later would need an email-sending secret (e.g. Resend) and a few
 * more routes here, not a different storage model.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ALLOWLIST_KEY = "beta:admin-emails";
const SESSION_SECRET_KEY = "beta:session-secret";
const APP_VISIBILITY_KEY = "beta:app-visibility";
const SESSION_TTL_SECONDS = 60 * 60 * 8;
// A reset link from an admin works once, for two days.
const RESET_TTL_SECONDS = 60 * 60 * 48;
const RESET_USED_PREFIX = "beta:reset-used:";
const PBKDF2_ITERATIONS = 5000;
const VISIBILITY_TIERS = ["public", "hidden", "admin-only"];
const ROLES = ["admin", "user"];
// Mirrors the ids in public/apps.js (kept in sync by hand -- that file is a static
// asset, not part of this Worker's module graph, so it can't be imported here).
// Apps with real, already-public content default to "public"; anything else defaults
// to "admin-only" until an admin explicitly opens it up from Settings.
const KNOWN_APP_IDS = ["council-data", "mcm", "pcn", "consensus", "stars", "artifacts", "job-description",
                       "apprenticeship", "partner-intel"];
// App ids arrive in request bodies: a Set, so "constructor" or "__proto__" is just an unknown name.
const KNOWN_APPS = new Set(KNOWN_APP_IDS);
const DEFAULT_PUBLIC_APPS = ["council-data", "mcm", "stars"];

/* Login rate limit. Five wrong passwords for one account within 15 minutes lock that account's
   sign-in for 15 minutes; twenty from one client address lock that address, so one person cannot
   spray a guess or two at every account. Best effort: KV is eventually consistent, so attempts that
   land on different Cloudflare locations within a few seconds can each read an older count. It holds
   guessing to a handful of tries per window rather than exactly five. */
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_LOCK_SECONDS = 15 * 60;
const LOGIN_MAX_FAILURES_PER_ACCOUNT = 5;
const LOGIN_MAX_FAILURES_PER_IP = 20;
const LOGIN_FAIL_PREFIX = "beta:login-fail:";
const LOGIN_LOCKED_MESSAGE = "Too many wrong passwords. Wait 15 minutes, then try again.";

export const NO_APP_ACCESS = "You don't have access to this app. Ask an admin.";
export const NO_SETTINGS_ACCESS = "You don't have access to this app's settings. Ask an admin.";
const ADMINS_ONLY = "Only an admin can do that.";
const LAST_ADMIN = "Connector needs at least one admin. Make someone else an admin first.";
const NOT_LISTED = "That email isn't on the Connector list. Ask an admin to add you.";

const SEED_ADMIN_EMAIL = "poneill@conexusindiana.com";
// Set once, the first time the seed admin is provisioned -- see ensureSeedAdmin().
const SEED_ADMIN_DONE_KEY = "beta:seed-admin-provisioned";

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

/* A session for this account record, carrying its current session version. */
function issueSession(env, account) {
  return issueToken(env, { email: account.email, sv: account.session_version || "" });
}

/* A new random session version. Writing one to an account record ends every session issued before it. */
function newSessionVersion() {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(12)));
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

/* The signed-in person, with their role and apps read fresh from storage, or null. A valid signature
   is not enough: the person must still be on the list, still have an account record (a password reset
   deletes it), and the token's session version must match the record's (Sign out everywhere changes
   it). KV is eventually consistent, so a revocation can take up to about a minute to reach every
   Cloudflare location. */
async function requireAuth(request, env) {
  const payload = await verifyToken(env, bearer(request));
  // A reset link is signed the same way but is never a session: it carries no email and is marked.
  if (!payload || !payload.email || payload.purpose) return null;
  const [allowlist, account] = await Promise.all([getAllowlist(env), getAccount(env, payload.email)]);
  const entry = findAllowlistEntry(allowlist, payload.email);
  if (!entry || !account) return null;
  if (!timingSafeEqual(String(account.session_version || ""), String(payload.sv || ""))) return null;
  return identity(entry, account);
}

/* Admin password resets. KV is eventually consistent: after Reset deleted an account record, the next
   reads (the admin list, then "Forgot password") could still return the old record for a minute or
   more, so Reset looked as if it had done nothing. Reset now also issues a signed, single-use link for
   that person. Setting a password through it is checked against the signature, not against a read of
   whether the old record is gone. The link names the account in resetFor, never email, so it can
   never pass requireAuth as a session. */
async function issueResetToken(env, email) {
  const secret = await sessionSecret(env);
  const nonce = bytesToBase64url(crypto.getRandomValues(new Uint8Array(12)));
  const exp = Math.floor(Date.now() / 1000) + RESET_TTL_SECONDS;
  const body = strToBase64url(JSON.stringify({ purpose: "reset", resetFor: email, nonce, exp }));
  return `${body}.${await hmac(secret, body)}`;
}

async function verifyResetToken(env, token, email) {
  const payload = await verifyToken(env, String(token || ""));
  if (!payload || payload.purpose !== "reset" || normalizeEmail(payload.resetFor) !== email || !payload.nonce) return null;
  if (await env.BOX_KV.get(RESET_USED_PREFIX + payload.nonce)) return null;
  return payload;
}

/* Exported so every mini app on this platform (e.g. src/consensus.js) gates its own routes with
   the same accounts, without each mini app inventing its own login system. Returns
   { email, firstName, lastName, name, role, apps, appAdmin } or null -- never throws. Being signed in is not
   being allowed: pair it with canUseApp or canAdminApp for the app's own id. */
export async function requireBetaAuth(request, env) {
  return requireAuth(request, env);
}

/* ---------- roles and app access ---------- */

/* An entry written before roles existed has no role. Everyone was an admin of everything then, and
   stays one, so nobody lost access when roles shipped. Any other value than "admin" is a user. */
function roleOf(entry) {
  if (entry.role === undefined || entry.role === null || entry.role === "") return "admin";
  return entry.role === "admin" ? "admin" : "user";
}

/* App ids from storage, kept only when they name a known app, without repeats. */
function appList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((v) => String(v)).filter((v) => KNOWN_APPS.has(v)))];
}

/* What a signed-in person may reach. "apps" already includes every app they admin. */
function identity(entry, account) {
  const role = roleOf(entry);
  const appAdmin = role === "admin" ? [...KNOWN_APP_IDS] : appList(entry.appAdmin);
  const apps = role === "admin" ? [...KNOWN_APP_IDS] : appList([...appList(entry.apps), ...appAdmin]);
  return { email: account.email, ...namesOf(entry), role, apps, appAdmin };
}

/* The pure checks every mini app applies to requireBetaAuth's result. An overall admin passes both for
   any app id, including one added to public/apps.js before KNOWN_APP_IDS above. */
export function canUseApp(auth, appId) {
  return Boolean(auth) && (auth.role === "admin" || (Array.isArray(auth.apps) && auth.apps.includes(appId)));
}
export function canAdminApp(auth, appId) {
  return Boolean(auth) && (auth.role === "admin" || (Array.isArray(auth.appAdmin) && auth.appAdmin.includes(appId)));
}
export function isOverallAdmin(auth) {
  return Boolean(auth) && auth.role === "admin";
}

/* A person's name as an admin entered it. Entries made before names were asked for have none: they show
   by email until an admin adds it. */
function cleanName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 60);
}
function namesOf(entry) {
  const firstName = cleanName(entry.firstName), lastName = cleanName(entry.lastName);
  return { firstName, lastName, name: [firstName, lastName].filter(Boolean).join(" ") };
}

/* ---------- storage ---------- */

async function getAllowlist(env) {
  const raw = await env.BOX_KV.get(ALLOWLIST_KEY);
  const list = raw ? JSON.parse(raw) : [];
  return Array.isArray(list) ? list.filter((a) => a && a.email) : [];
}
/* Every entry is written back with an explicit role, so a pre-roles entry's "admin" is recorded the
   first time the list is saved. */
async function saveAllowlist(env, list) {
  await env.BOX_KV.put(ALLOWLIST_KEY, JSON.stringify(list.map((a) => ({
    email: normalizeEmail(a.email), firstName: cleanName(a.firstName), lastName: cleanName(a.lastName), role: roleOf(a),
    apps: appList(a.apps), appAdmin: appList(a.appAdmin),
  }))));
}
function findAllowlistEntry(list, email) {
  const target = normalizeEmail(email);
  return list.find((a) => normalizeEmail(a.email) === target) || null;
}
function adminCount(list) {
  return list.filter((a) => roleOf(a) === "admin").length;
}
/* One person as Settings shows them: what was assigned, not the effective lists. */
function personView(entry) {
  return {
    email: normalizeEmail(entry.email), ...namesOf(entry), role: roleOf(entry),
    apps: appList(entry.apps), appAdmin: appList(entry.appAdmin),
  };
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

/* ---------- login rate limit ---------- */

/* The counters one sign-in attempt is held against: the account (keyed on its email; an unknown
   email is counted under itself, so a lockout says nothing about whether an account exists), and the client
   address Cloudflare reports. With no address header (local tests), only the account is counted. */
function loginLimits(request, accountId) {
  const limits = [{ key: `${LOGIN_FAIL_PREFIX}account:${accountId}`, max: LOGIN_MAX_FAILURES_PER_ACCOUNT }];
  const ip = (request.headers.get("cf-connecting-ip") || "").trim().slice(0, 64);
  if (ip) limits.push({ key: `${LOGIN_FAIL_PREFIX}ip:${ip}`, max: LOGIN_MAX_FAILURES_PER_IP });
  return limits;
}

async function readFailures(env, key) {
  try { return JSON.parse(await env.BOX_KV.get(key)) || null; } catch (e) { return null; }
}

async function loginLocked(env, limits) {
  const now = Date.now();
  const records = await Promise.all(limits.map((l) => readFailures(env, l.key)));
  return records.some((r) => r && Number(r.lockedUntil) > now);
}

/* One more wrong password against every counter. A window starts at the first failure and lasts
   LOGIN_WINDOW_SECONDS; reaching the counter's max inside it locks it for LOGIN_LOCK_SECONDS. */
async function recordLoginFailure(env, limits) {
  const now = Date.now();
  await Promise.all(limits.map(async ({ key, max }) => {
    let r = await readFailures(env, key);
    if (!r || !(now - Number(r.first) <= LOGIN_WINDOW_SECONDS * 1000)) r = { count: 0, first: now };
    r.count = (Number(r.count) || 0) + 1;
    if (r.count >= max) r.lockedUntil = now + LOGIN_LOCK_SECONDS * 1000;
    const until = Math.max(r.first + LOGIN_WINDOW_SECONDS * 1000, Number(r.lockedUntil) || 0);
    // KV's shortest expiry is 60 seconds.
    await env.BOX_KV.put(key, JSON.stringify(r), { expirationTtl: Math.max(60, Math.ceil((until - now) / 1000) + 60) });
  }));
}

/* One admin, bootstrapped from a repository secret rather than the self-service UI --
   there's no existing admin yet to add poneill@conexusindiana.com to the list, or to
   click "reset" for him. Cheap and idempotent: once seeding has happened, every later
   call is a single KV read that short-circuits immediately. Runs even if
   poneill_password was never set as a Cloudflare secret -- it just no-ops.

   The "have I seeded yet" flag is its own key rather than "does the account record
   exist", because POST admins/reset works by DELETING the account record. Keyed on the
   record, this function re-created the seed account from poneill_password on the very
   next /api/beta/* request -- so resetting the seed admin silently did nothing (the old
   password kept working, and "Set up new account" reported the account already had a
   password). The flag lives in the same namespace, so a genuinely empty KV still
   bootstraps exactly as before. */
async function ensureSeedAdmin(env) {
  if (!env.poneill_password) return;
  if (await env.BOX_KV.get(SEED_ADMIN_DONE_KEY)) return;
  if (await getAccount(env, SEED_ADMIN_EMAIL)) {
    // Already seeded before this flag existed -- record it and stop.
    await env.BOX_KV.put(SEED_ADMIN_DONE_KEY, new Date().toISOString());
    return;
  }

  const allowlist = await getAllowlist(env);
  if (!findAllowlistEntry(allowlist, SEED_ADMIN_EMAIL)) {
    allowlist.push({ email: SEED_ADMIN_EMAIL, role: "admin" });
    await saveAllowlist(env, allowlist);
  }

  const { hash, salt } = await hashPassword(env.poneill_password);
  await saveAccount(env, SEED_ADMIN_EMAIL, {
    email: SEED_ADMIN_EMAIL,
    password_hash: hash, password_salt: salt, session_version: newSessionVersion(),
    created_at: new Date().toISOString(),
  });
  await env.BOX_KV.put(SEED_ADMIN_DONE_KEY, new Date().toISOString());
}

async function readJsonBody(request) {
  try { return (await request.json()) || {}; } catch (e) { return null; }
}

/* ---------- routes ---------- */

export async function handleBetaApi(route, request, env) {
  if (!env.BOX_KV) {
    return json({ error: "BOX_KV binding is missing -- see SETUP.md." }, 500);
  }
  await ensureSeedAdmin(env);
  const method = request.method.toUpperCase();

  // ---- POST /api/beta/login -----------------------------------------------------------
  // { email, password }. Sign-in is by email only; "identifier" is the field's older name.
  if (route === "login" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const identifier = normalizeEmail(body && (body.email || body.identifier)).slice(0, 200);
    const password = String((body && body.password) || "");
    // Flat delay regardless of which way this fails, same reasoning as admin.html's own
    // login: a wrong guess always costs the same, so timing can't narrow down why.
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (!identifier || !password) {
      return json({ error: "Enter your email and password." }, 400);
    }

    const allowlist = await getAllowlist(env);
    const entry = findAllowlistEntry(allowlist, identifier);
    const limits = loginLimits(request, entry ? normalizeEmail(entry.email) : identifier);
    // Checked before the password, so a locked account stays locked even for the right one.
    if (await loginLocked(env, limits)) return json({ error: LOGIN_LOCKED_MESSAGE }, 429);
    const account = entry ? await getAccount(env, entry.email) : null;
    if (!account || !(await verifyPassword(password, account.password_hash, account.password_salt))) {
      await recordLoginFailure(env, limits);
      return json({ error: "Incorrect email or password." }, 401);
    }
    // Success clears the account's counter. The address counter stays, so one valid account does
    // not reset the limit for guesses at everyone else's.
    await env.BOX_KV.delete(limits[0].key);
    const token = await issueSession(env, account);
    return json({ ok: true, token, email: account.email, ...namesOf(entry) });
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
      return json({ allowed: false, reason: NOT_LISTED });
    }
    if (body.reset) {
      if (await verifyResetToken(env, body.reset, email)) return json({ allowed: true });
      return json({ allowed: false, reason: "That reset link has expired or was already used. Ask an admin for a new one." });
    }
    if (await getAccount(env, email)) {
      return json({ allowed: false,
        reason: "That account already has a password. Ask an admin to reset it and send you the link." });
    }
    return json({ allowed: true });
  }

  // ---- POST /api/beta/setup-complete ---------------------------------------------------
  // { email, password } -- the same endpoint for a brand-new person and for an
  // existing one whose password an admin just reset (see module docstring).
  if (route === "setup-complete" && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    if (!email) return json({ error: "Enter an email address." }, 400);
    if (password.length < 8) return json({ error: "Password must be at least 8 characters." }, 400);

    const allowlist = await getAllowlist(env);
    const entry = findAllowlistEntry(allowlist, email);
    if (!entry) return json({ error: NOT_LISTED }, 403);
    // With a valid reset link the old record is replaced, whatever a possibly stale read says about it.
    const reset = body.reset ? await verifyResetToken(env, body.reset, email) : null;
    if (body.reset && !reset) return json({ error: "That reset link has expired or was already used. Ask an admin for a new one." }, 410);
    if (!reset && await getAccount(env, email)) {
      return json({ error: "That account already has a password. Ask an admin to reset it and send you the link." }, 409);
    }
    const { hash, salt } = await hashPassword(password);
    // A new session version, so no token issued before a reset works again.
    const account = {
      email, password_hash: hash, password_salt: salt,
      session_version: newSessionVersion(), created_at: new Date().toISOString(),
    };
    await saveAccount(env, email, account);
    if (reset) await env.BOX_KV.put(RESET_USED_PREFIX + reset.nonce, new Date().toISOString(), { expirationTtl: RESET_TTL_SECONDS + 3600 });
    // A new password ends any lockout earned by guessing at the old one.
    await env.BOX_KV.delete(`${LOGIN_FAIL_PREFIX}account:${email}`);

    const token = await issueSession(env, account);
    return json({ ok: true, token, email, ...namesOf(entry) });
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

  // Everything below needs a session.
  const auth = await requireAuth(request, env);

  // ---- GET /api/beta/me -----------------------------------------------------------------
  // Role and the apps this person can use and admin, so pages decide what to show. "apps"
  // includes every app they admin; an overall admin's lists name every known app.
  if (route === "me" && method === "GET") {
    if (!auth) return json({ error: "Not signed in" }, 401);
    return json({ email: auth.email, firstName: auth.firstName, lastName: auth.lastName, name: auth.name,
      role: auth.role, apps: auth.apps, appAdmin: auth.appAdmin });
  }

  // ---- POST /api/beta/sign-out-everywhere ---------------------------------------------
  // { email? } -- ends every session that person has, this one included when it is their own.
  // Anyone signed in may do it to themselves; only an overall admin to someone else.
  if (route === "sign-out-everywhere" && method === "POST") {
    if (!auth) return json({ error: "Not signed in" }, 401);
    const body = await readJsonBody(request);
    if (!body) return json({ error: "Bad request" }, 400);
    const email = body.email ? normalizeEmail(body.email) : normalizeEmail(auth.email);
    const self = email === normalizeEmail(auth.email);
    if (!self && !isOverallAdmin(auth)) return json({ error: ADMINS_ONLY }, 403);
    if (!findAllowlistEntry(await getAllowlist(env), email)) return json({ error: "That email isn't on the list." }, 404);
    const account = await getAccount(env, email);
    // No account record means no password, so there is no session to end.
    if (account) {
      account.session_version = newSessionVersion();
      await saveAccount(env, email, account);
    }
    return json({ ok: true, email, self });
  }

  // ---- POST /api/beta/app-visibility -------------------------------------------------
  // { id, tier } -- tier is one of "public" | "hidden" | "admin-only". Overall admins only.
  if (route === "app-visibility" && method === "POST") {
    if (!auth) return json({ error: "Not signed in" }, 401);
    if (!isOverallAdmin(auth)) return json({ error: ADMINS_ONLY }, 403);
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

  // ---- People: /api/beta/admins* ----------------------------------------------------------
  // The route name predates roles; it manages everyone on the list. Overall admins only.
  if (route === "admins" || route.startsWith("admins/")) {
    if (!auth) return json({ error: "Not signed in" }, 401);
    if (!isOverallAdmin(auth)) return json({ error: ADMINS_ONLY }, 403);

    // ---- GET admins -> { people: [{ email, firstName, lastName, name, role, apps, appAdmin, has_password }] }
    if (route === "admins" && method === "GET") {
      const allowlist = await getAllowlist(env);
      const people = await Promise.all(allowlist.map(async (a) => ({
        ...personView(a), has_password: Boolean(await getAccount(env, a.email)),
      })));
      return json({ people });
    }

    if (method !== "POST") return json({ error: "Not found" }, 404);
    const body = await readJsonBody(request);
    if (!body) return json({ error: "Bad request" }, 400);
    const email = normalizeEmail(body.email);
    const allowlist = await getAllowlist(env);

    // ---- POST admins { email, firstName, lastName, role? } -- adds a person. They choose their own
    // password the first time they use "Set up new account". A new person is a user with no apps
    // unless role "admin" is chosen.
    if (route === "admins" && method === "POST") {
      if (!email || email.indexOf("@") < 0) return json({ error: "Enter a valid email address." }, 400);
      const role = body.role === undefined || body.role === null || body.role === "" ? "user" : String(body.role);
      if (!ROLES.includes(role)) return json({ error: "Role must be admin or user." }, 400);
      const firstName = cleanName(body.firstName), lastName = cleanName(body.lastName);
      if (!firstName || !lastName) return json({ error: "Enter their first and last name." }, 400);
      if (findAllowlistEntry(allowlist, email)) return json({ ok: true, already_present: true });
      allowlist.push({ email, firstName, lastName, role, apps: [], appAdmin: [] });
      await saveAllowlist(env, allowlist);
      return json({ ok: true, person: personView(allowlist[allowlist.length - 1]) });
    }

    const entry = findAllowlistEntry(allowlist, email);
    if (!entry) return json({ error: "That email isn't on the list." }, 404);

    // ---- POST admins/update { email, firstName?, lastName?, role?, apps?, appAdmin? } -- each field given replaces
    // what is stored. apps and appAdmin are lists of app ids from public/apps.js.
    if (route === "admins/update" && method === "POST") {
      const role = body.role === undefined ? roleOf(entry) : String(body.role);
      if (!ROLES.includes(role)) return json({ error: "Role must be admin or user." }, 400);
      const lists = {};
      for (const field of ["apps", "appAdmin"]) {
        if (body[field] === undefined) continue;
        if (!Array.isArray(body[field])) return json({ error: `${field} must be a list of app ids.` }, 400);
        const unknown = body[field].map((v) => String(v)).filter((v) => !KNOWN_APPS.has(v));
        if (unknown.length) return json({ error: `Unknown app: ${unknown[0].slice(0, 60)}` }, 400);
        lists[field] = appList(body[field]);
      }
      if (roleOf(entry) === "admin" && role !== "admin" && adminCount(allowlist) <= 1) {
        return json({ error: LAST_ADMIN }, 409);
      }
      // A name given replaces the stored one; an empty name is refused, so nobody is left nameless by mistake.
      for (const field of ["firstName", "lastName"]) {
        if (body[field] === undefined) continue;
        if (!cleanName(body[field])) return json({ error: "Enter their first and last name." }, 400);
      }
      entry.role = role;
      if (body.firstName !== undefined) entry.firstName = cleanName(body.firstName);
      if (body.lastName !== undefined) entry.lastName = cleanName(body.lastName);
      if (lists.apps) entry.apps = lists.apps;
      if (lists.appAdmin) entry.appAdmin = lists.appAdmin;
      await saveAllowlist(env, allowlist);
      return json({ ok: true, person: personView(entry) });
    }

    // ---- POST admins/remove { email } -- takes them off the list and deletes their account
    // record, which ends their sessions. The last overall admin cannot be removed.
    if (route === "admins/remove" && method === "POST") {
      if (roleOf(entry) === "admin" && adminCount(allowlist) <= 1) return json({ error: LAST_ADMIN }, 409);
      await saveAllowlist(env, allowlist.filter((a) => a !== entry));
      await deleteAccount(env, email);
      return json({ ok: true, email });
    }

    // ---- POST admins/reset { email } -- clears that person's password (deletes their account
    // record, which also ends their sessions; they stay on the list) and returns a single-use
    // link, good for 48 hours, that lets them set a new one. Also gives a not-yet-set-up person
    // a link to set their first password.
    if (route === "admins/reset" && method === "POST") {
      await deleteAccount(env, email);
      const reset = await issueResetToken(env, email);
      return json({ ok: true, email, has_password: false, link: "/admin/login.html?reset=" + encodeURIComponent(reset) });
    }
  }

  return json({ error: "Not found" }, 404);
}
