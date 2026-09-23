/**
 * Respondent accounts for the Apprenticeship Readiness Toolbox.
 *
 * An employer works through several assessments inside one project, and the point of the
 * tool is the readiness dashboard that combines them. That only works if the tool knows
 * the same person came back -- a name typed into a form twice is not an identity, and a
 * result nobody can get back to is not a result. So respondents sign in.
 *
 * THIS IS NOT THE ADMIN ACCOUNT SYSTEM, AND MUST NEVER BECOME IT. src/beta_auth.js signs
 * Conexus staff into every control panel in this repo. The people signing in here are
 * employers from outside the organisation, self-registering with no approval step. The
 * two are kept apart by construction rather than by a flag in a payload:
 *
 *   - Tokens are signed with a DIFFERENT secret (a respondent key, generated and stored
 *     under its own KV entry). A respondent token therefore fails beta_auth's signature
 *     check outright -- not its payload check, its signature check -- so no shape of
 *     payload here can ever satisfy requireBetaAuth, and the same holds in reverse.
 *   - Tokens also carry an explicit audience that is verified, as a second, independent
 *     reason the wrong one is rejected.
 *
 * Storage (Workers KV, BOX_KV, under the same "apprenticeship:" prefix as the rest of
 * the app):
 *   apprenticeship:account:<accountId>          the account record
 *   apprenticeship:account-email:<email>        email -> accountId (uniqueness + login)
 *   apprenticeship:account-open:<accountId>:<surveyId>   an unfinished run, for resuming
 *   apprenticeship:account-done:<accountId>:<surveyId>   the latest finished run
 *
 * The two index keys are what make "my dashboard" cheap: without them, showing one
 * person their results means scanning every response of every assessment in the project.
 *
 * NO EMAIL IS SENT, because this Worker has no email sender wired up. Two consequences,
 * both deliberate and both documented in SETUP.md: an address is never verified (someone
 * can register with an address they don't own -- they would only be assessing themselves
 * under it), and a forgotten password is reset by a Conexus admin from the control panel
 * rather than by a link. Adding a real reset link later means an email-sending secret and
 * two more routes here, not a different storage model.
 *
 * Passwords: PBKDF2-SHA256, 5,000 iterations, 16-byte per-account salt, via the runtime's
 * own Web Crypto. The iteration count matches src/beta_auth.js and is low for the same
 * reason -- Workers meters CPU time per request, and a typical 210,000-iteration
 * recommendation measures at ~95ms, over the budget on its own. See that file's docstring.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ACCOUNT_PREFIX = "apprenticeship:account:";
const EMAIL_INDEX_PREFIX = "apprenticeship:account-email:";
const OPEN_PREFIX = "apprenticeship:account-open:";
const DONE_PREFIX = "apprenticeship:account-done:";
// Distinct from beta_auth's beta:session-secret ON PURPOSE -- see the module docstring.
const SESSION_SECRET_KEY = "apprenticeship:respondent-session-secret";
const TOKEN_AUDIENCE = "apprenticeship-respondent";

// Respondents work through several assessments over days or weeks, so an eight-hour
// admin session would mean signing in on nearly every visit. The token is stateless and
// cannot be revoked before it expires, which is the cost of not keeping a session table;
// it carries nothing but an account id and is only good against this one app's routes.
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const PBKDF2_ITERATIONS = 5000;
const MIN_PASSWORD_LENGTH = 10;

/* ---------- bytes / base64 ----------
 * The same handful of helpers src/beta_auth.js has. They are not exported from there,
 * and this file deliberately does not import from it: the one thing that must stay true
 * of these two systems is that they share no signing path. */

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
const strToBase64url = (str) => bytesToBase64url(encoder.encode(str));
const base64urlToStr = (b64url) => decoder.decode(base64urlToBytes(b64url));

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
  const salt = existingSaltB64 ? base64ToBytes(existingSaltB64)
    : crypto.getRandomValues(new Uint8Array(16));
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

async function respondentSecret(env) {
  let secret = await env.BOX_KV.get(SESSION_SECRET_KEY);
  if (!secret) {
    secret = bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
    await env.BOX_KV.put(SESSION_SECRET_KEY, secret);
  }
  return secret;
}

async function issueToken(env, accountId) {
  const secret = await respondentSecret(env);
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const body = strToBase64url(JSON.stringify({ aud: TOKEN_AUDIENCE, sub: accountId, exp }));
  return `${body}.${await hmac(secret, body)}`;
}

async function verifyRespondentToken(env, token) {
  if (!token || token.indexOf(".") < 0) return null;
  const [body, signature] = token.split(".", 2);
  const secret = await respondentSecret(env);
  if (!timingSafeEqual(signature, await hmac(secret, body))) return null;
  let payload;
  try { payload = JSON.parse(base64urlToStr(body)); } catch (e) { return null; }
  // The signature already makes an admin token impossible here; the audience check is a
  // second, independent reason, so neither is load-bearing on its own.
  if (!payload || payload.aud !== TOKEN_AUDIENCE || !payload.sub) return null;
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

/* ---------- storage ---------- */

const normalizeEmail = (value) => String(value || "").trim().toLowerCase();
const str = (v) => String(v == null ? "" : v).trim();

const accountKey = (id) => `${ACCOUNT_PREFIX}${id}`;
const emailKey = (email) => `${EMAIL_INDEX_PREFIX}${normalizeEmail(email)}`;
export const openRunKey = (accountId, surveyId) => `${OPEN_PREFIX}${accountId}:${surveyId}`;
export const doneRunKey = (accountId, surveyId) => `${DONE_PREFIX}${accountId}:${surveyId}`;

async function readJson(env, key) {
  const raw = await env.BOX_KV.get(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

export async function getAccountById(env, id) {
  return id ? readJson(env, accountKey(id)) : null;
}

async function getAccountByEmail(env, email) {
  const id = await env.BOX_KV.get(emailKey(email));
  return id ? getAccountById(env, id) : null;
}

/** What the browser is allowed to see: never the hash, never the salt. */
export function publicAccount(account) {
  return {
    id: account.id, name: account.name, company: account.company, email: account.email,
    createdAt: account.createdAt, lastLoginAt: account.lastLoginAt,
  };
}

/**
 * The signed-in respondent, or null. Exported so src/apprenticeship.js can gate the
 * assessment routes on it without duplicating any of the verification above.
 */
export async function requireRespondent(request, env) {
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const payload = await verifyRespondentToken(env, token);
  if (!payload) return null;
  return getAccountById(env, payload.sub);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Attach any assessments this person already finished before they had an account.
 *
 * The tool collected name, company and email at the top of every assessment before
 * accounts existed, and those responses are real work by a real employer. Matching on the
 * address they registered with is what stops the first sign-up looking like a blank slate
 * to someone who has already done two of the three. Only responses with no owner are
 * claimed, so this can never take a response away from another account.
 */
async function claimOrphanResponses(env, account) {
  const list = await env.BOX_KV.list({ prefix: "apprenticeship:response:" });
  let claimed = 0;
  for (const entry of list.keys) {
    const response = await readJson(env, entry.name);
    if (!response || response.accountId) continue;
    if (!response.respondent || normalizeEmail(response.respondent.email) !== account.email) continue;
    response.accountId = account.id;
    await env.BOX_KV.put(entry.name, JSON.stringify(response));
    if (response.status === "complete") {
      await env.BOX_KV.put(doneRunKey(account.id, response.surveyId), response.id);
    } else if (response.status === "in-progress") {
      await env.BOX_KV.put(openRunKey(account.id, response.surveyId), response.id);
    }
    claimed++;
  }
  return claimed;
}

/* ---------- respondent-facing routes: /api/apprenticeship/account/* ---------- */

export async function handleAccountApi(parts, request, env) {
  const method = request.method.toUpperCase();

  // POST account/signup { name, company, email, password }
  if (parts[0] === "signup" && parts.length === 1 && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const name = str(body.name).slice(0, 200);
    const company = str(body.company).slice(0, 200);
    const email = normalizeEmail(body.email).slice(0, 200);
    const password = String(body.password == null ? "" : body.password);
    if (!name || !company || !email) {
      return json({ error: "Name, company and email are all needed." }, 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: "That email address doesn't look right." }, 400);
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return json({ error: `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.` }, 400);
    }
    if (await env.BOX_KV.get(emailKey(email))) {
      return json({ error: "There's already an account with that email. Sign in instead." }, 409);
    }
    const { hash, salt } = await hashPassword(password);
    const now = new Date().toISOString();
    const account = {
      id: crypto.randomUUID(),
      name, company, email,
      passwordHash: hash, passwordSalt: salt,
      createdAt: now, lastLoginAt: now,
    };
    await env.BOX_KV.put(accountKey(account.id), JSON.stringify(account));
    await env.BOX_KV.put(emailKey(email), account.id);
    const claimed = await claimOrphanResponses(env, account);
    return json({ ok: true, token: await issueToken(env, account.id), account: publicAccount(account), claimed });
  }

  // POST account/login { email, password }
  if (parts[0] === "login" && parts.length === 1 && method === "POST") {
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const account = await getAccountByEmail(env, body.email);
    const ok = account && await verifyPassword(
      String(body.password == null ? "" : body.password), account.passwordHash, account.passwordSalt);
    // One message for both "no such account" and "wrong password": the difference is
    // exactly what tells someone whether an address is registered here.
    if (!ok) return json({ error: "That email and password don't match an account." }, 401);
    account.lastLoginAt = new Date().toISOString();
    await env.BOX_KV.put(accountKey(account.id), JSON.stringify(account));
    await claimOrphanResponses(env, account);
    return json({ ok: true, token: await issueToken(env, account.id), account: publicAccount(account) });
  }

  // GET account/me
  if (parts[0] === "me" && parts.length === 1 && method === "GET") {
    const account = await requireRespondent(request, env);
    if (!account) return json({ error: "Not signed in" }, 401);
    return json({ account: publicAccount(account) });
  }

  // POST account/change-password { currentPassword, newPassword }
  if (parts[0] === "change-password" && parts.length === 1 && method === "POST") {
    const account = await requireRespondent(request, env);
    if (!account) return json({ error: "Not signed in" }, 401);
    let body = {};
    try { body = await request.json(); } catch (e) { return json({ error: "Bad request" }, 400); }
    const current = String(body.currentPassword == null ? "" : body.currentPassword);
    const next = String(body.newPassword == null ? "" : body.newPassword);
    if (!await verifyPassword(current, account.passwordHash, account.passwordSalt)) {
      return json({ error: "That current password isn't right." }, 401);
    }
    if (next.length < MIN_PASSWORD_LENGTH) {
      return json({ error: `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.` }, 400);
    }
    const { hash, salt } = await hashPassword(next);
    account.passwordHash = hash;
    account.passwordSalt = salt;
    await env.BOX_KV.put(accountKey(account.id), JSON.stringify(account));
    return json({ ok: true });
  }

  return null; // not an account route -- let the caller carry on
}

/* ---------- admin-facing helpers, called from src/apprenticeship.js ---------- */

export async function listAccounts(env) {
  const list = await env.BOX_KV.list({ prefix: ACCOUNT_PREFIX });
  const accounts = await Promise.all(list.keys.map((k) => readJson(env, k.name)));
  return accounts.filter(Boolean).map(publicAccount);
}

/**
 * An admin setting a password for a respondent who has lost theirs. This exists because
 * nothing here can send an email; it is the whole password-reset story for this app.
 */
export async function adminSetPassword(env, accountId, newPassword) {
  const account = await getAccountById(env, accountId);
  if (!account) return { error: "Account not found", status: 404 };
  const password = String(newPassword == null ? "" : newPassword);
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`, status: 400 };
  }
  const { hash, salt } = await hashPassword(password);
  account.passwordHash = hash;
  account.passwordSalt = salt;
  account.passwordSetByAdminAt = new Date().toISOString();
  await env.BOX_KV.put(accountKey(account.id), JSON.stringify(account));
  return { ok: true };
}

export async function deleteAccount(env, accountId) {
  const account = await getAccountById(env, accountId);
  if (!account) return { error: "Account not found", status: 404 };
  await env.BOX_KV.delete(accountKey(account.id));
  await env.BOX_KV.delete(emailKey(account.email));
  // The index entries go; the responses themselves stay, so an assessment an admin has
  // already read doesn't vanish from the cohort numbers because someone was removed.
  for (const prefix of [OPEN_PREFIX, DONE_PREFIX]) {
    const list = await env.BOX_KV.list({ prefix: `${prefix}${account.id}:` });
    for (const entry of list.keys) await env.BOX_KV.delete(entry.name);
  }
  return { ok: true };
}

export const ACCOUNT_KEY_PREFIXES = { ACCOUNT_PREFIX, EMAIL_INDEX_PREFIX, OPEN_PREFIX, DONE_PREFIX };
