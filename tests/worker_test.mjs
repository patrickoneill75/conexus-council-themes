/**
 * Regression tests for the Cloudflare Worker modules in src/.
 *
 * These drive the REAL exported route handlers, not reimplementations: an in-memory
 * KV stub stands in for the BOX_KV binding, and globalThis.fetch is stubbed per test
 * so nothing reaches Box, GitHub or the Anthropic API. Every test names the defect it
 * pins down.
 *
 * Run: node tests/worker_test.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/* ------------------------------------------------------------------ tiny test runner */
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/* ------------------------------------------------------------------------- KV stub */
class FakeKV {
  constructor() { this.store = new Map(); }
  async get(key) { return this.store.has(key) ? this.store.get(key) : null; }
  async put(key, value) { this.store.set(key, String(value)); }
  async delete(key) { this.store.delete(key); }
  async list({ prefix = "" } = {}) {
    return { keys: [...this.store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) };
  }
}

function makeEnv(extra = {}) {
  return {
    BOX_KV: new FakeKV(),
    BOX_CLIENT_ID: "cid", BOX_CLIENT_SECRET: "csecret", BOX_RELAY_SECRET: "relay-secret",
    GITHUB_TOKEN: "ghtoken", GITHUB_REPO: "owner/repo",
    ...extra,
  };
}

const req = (url, init = {}) => new Request(`https://example.test${url}`, init);
const jsonReq = (url, method, body, token) => req(url, {
  method,
  headers: {
    "content-type": "application/json",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
});

/** Stub globalThis.fetch for the duration of `fn`. `handler(url, init)` returns a Response. */
async function withFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    return handler(url, init, calls);
  };
  try { return await fn(calls); } finally { globalThis.fetch = original; }
}

const okJson = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { "content-type": "application/json" },
});

/* --------------------------------------------------------- src/ under bare Node ----
 * Worker modules import JSON data bare (`import data from "./data/x.json"`). Wrangler
 * resolves that; Node needs an explicit import attribute. So mirror src/ into a temp
 * directory verbatim, add the attribute to those import lines, and load the modules
 * from there -- the code under test is otherwise byte-for-byte what ships.
 */
const MIRROR = fs.mkdtempSync(path.join(os.tmpdir(), "connector-src-"));
fs.cpSync(SRC, MIRROR, { recursive: true });
{
  const JSON_IMPORT = /(import\s+\w+\s+from\s+"\.[^"]*\.json")(?!\s+with)/g;
  let patched = 0;
  for (const entry of fs.readdirSync(MIRROR)) {
    if (!entry.endsWith(".js")) continue;
    const file = path.join(MIRROR, entry);
    const before = fs.readFileSync(file, "utf8");
    const after = before.replace(JSON_IMPORT, '$1 with { type: "json" }');
    if (after !== before) { fs.writeFileSync(file, after); patched++; }
  }
  assert.ok(patched >= 2, `expected to patch the JSON imports in src/, patched ${patched}`);
}
const mod = (name) => import(pathToFileURL(path.join(MIRROR, name)).href);

/* ------------------------------------------------------------- minimal .docx builder */
// A real ZIP, written with STORED (uncompressed) entries so no deflate is needed. This
// is what src/job_description.js's own dependency-free ZIP reader has to parse.
function buildDocx(documentXml) {
  const enc = new TextEncoder();
  const name = enc.encode("word/document.xml");
  const data = enc.encode(documentXml);
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  let crc = 0xffffffff;
  for (const b of data) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;

  const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const local = [
    ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
    ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0),
    ...name, ...data,
  ];
  const central = [
    ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
    ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length),
    ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(0), ...name,
  ];
  const eocd = [
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(1), ...u16(1),
    ...u32(central.length), ...u32(local.length), ...u16(0),
  ];
  return new Uint8Array([...local, ...central, ...eocd]);
}

/* ======================================================================= beta_auth */
const { handleBetaApi, requireBetaAuth } = await mod("beta_auth.js");
const beta = (route, request, env) => handleBetaApi(route, request, env);

async function signedInEnv() {
  const env = makeEnv({ poneill_password: "seed-password-123" });
  await beta("me", req("/api/beta/me"), env);                  // triggers ensureSeedAdmin
  const res = await beta("login", jsonReq("/api/beta/login", "POST",
    { identifier: "poneill@conexusindiana.com", password: "seed-password-123" }), env);
  const body = await res.json();
  assert.equal(res.status, 200, "seed admin should be able to sign in");
  return { env, token: body.token };
}

test("beta_auth: seed admin can sign in and /me round-trips", async () => {
  const { env, token } = await signedInEnv();
  const me = await (await beta("me", req("/api/beta/me", { headers: { authorization: `Bearer ${token}` } }), env)).json();
  assert.equal(me.email, "poneill@conexusindiana.com");
  assert.equal(me.username, undefined, "no usernames: everyone signs in with their email");
});

test("beta_auth: a wrong password is rejected with 401", async () => {
  const { env } = await signedInEnv();
  const res = await beta("login", jsonReq("/api/beta/login", "POST",
    { email: "poneill@conexusindiana.com", password: "wrong" }), env);
  assert.equal(res.status, 401);
});

test("beta_auth: a tampered session token is rejected", async () => {
  const { env, token } = await signedInEnv();
  const [body] = token.split(".");
  for (const bad of [`${body}.not-the-signature`, "garbage", `${body}.`]) {
    const res = await beta("me", req("/api/beta/me", { headers: { authorization: `Bearer ${bad}` } }), env);
    assert.equal(res.status, 401, `token ${JSON.stringify(bad)} must not authenticate`);
  }
});

test("beta_auth: an expired session token is rejected", async () => {
  const { env, token } = await signedInEnv();
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 9 * 60 * 60 * 1000;    // TTL is 8h
    const res = await beta("me", req("/api/beta/me", { headers: { authorization: `Bearer ${token}` } }), env);
    assert.equal(res.status, 401);
  } finally { Date.now = realNow; }
});

test("beta_auth: resetting the seed admin's password actually sticks", async () => {
  // BUG: ensureSeedAdmin() keyed "have I seeded?" on the account record existing, and
  // admins/reset works by DELETING that record -- so the next /api/beta/* request
  // re-created the seed account from poneill_password. The reset silently did nothing:
  // the old password kept working and "Set up new account" reported a password was set.
  const { env, token } = await signedInEnv();
  const reset = await beta("admins/reset", jsonReq("/api/beta/admins/reset", "POST",
    { email: "poneill@conexusindiana.com" }, token), env);
  assert.equal(reset.status, 200);

  const check = await (await beta("setup-check", jsonReq("/api/beta/setup-check", "POST",
    { email: "poneill@conexusindiana.com" }), env)).json();
  assert.equal(check.allowed, true, "after a reset the account must be claimable again");

  const relogin = await beta("login", jsonReq("/api/beta/login", "POST",
    { email: "poneill@conexusindiana.com", password: "seed-password-123" }), env);
  assert.equal(relogin.status, 401, "the old seed password must stop working after a reset");
});

test("beta_auth: BUG admin Reset looked like it did nothing while KV still served the cleared password", async () => {
  // KV is eventually consistent. Reset deleted the account record, but the next reads (the admin list, then
  // "Forgot password") could still return the old record for a minute or more: Settings kept saying Active
  // and setup said the account already had a password. Reset now hands back a signed, single-use link, and
  // setting a password through it does not depend on that read.
  const { env, token } = await signedInEnv();
  const email = "poneill@conexusindiana.com", key = "beta:admin-account:" + email;
  const before = await env.BOX_KV.get(key);
  const res = await beta("admins/reset", jsonReq("/api/beta/admins/reset", "POST", { email }, token), env);
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.has_password, false, "the reply says the password is cleared, so Settings need not re-read it");
  assert.match(r.link, /^\/admin\/login\.html\?reset=/);
  const link = decodeURIComponent(r.link.split("reset=")[1]);
  await env.BOX_KV.put(key, before); // a read served from a stale cache: the old record is still there
  const check = async (body) => (await (await beta("setup-check", jsonReq("/api/beta/setup-check", "POST", body), env)).json()).allowed;
  assert.equal(await check({ email }), false, "without the link, a stale read still blocks setup");
  assert.equal(await check({ email, reset: link }), true, "with the link, setup goes ahead");
  const set = await beta("setup-complete", jsonReq("/api/beta/setup-complete", "POST", { email, password: "brand-new-pass", reset: link }), env);
  assert.equal(set.status, 200, "the new password is set despite the stale record");
  const login = async (password) => (await beta("login", jsonReq("/api/beta/login", "POST", { email: "poneill@conexusindiana.com", password }), env)).status;
  assert.equal(await login("brand-new-pass"), 200);
  assert.equal(await login("seed-password-123"), 401, "the old password no longer works");
  const again = await beta("setup-complete", jsonReq("/api/beta/setup-complete", "POST", { email, password: "another-pass-9", reset: link }), env);
  assert.equal(again.status, 410, "a reset link works once");
  const used = await (await beta("setup-check", jsonReq("/api/beta/setup-check", "POST", { email, reset: link }), env)).json();
  assert.match(used.reason, /expired or was already used/, "a spent link says so");
  const asSession = await beta("me", req("/api/beta/me", { headers: { authorization: `Bearer ${link}` } }), env);
  assert.equal(asSession.status, 401, "a reset link is never a session");
  // Resetting this admin's own password ended the session that asked for it, so sign in again.
  const oldSession = await beta("me", req("/api/beta/me", { headers: { authorization: `Bearer ${token}` } }), env);
  assert.equal(oldSession.status, 401, "a password reset ends the sessions issued before it");
  const fresh = (await (await beta("login", jsonReq("/api/beta/login", "POST", { email: "poneill@conexusindiana.com", password: "brand-new-pass" }), env)).json()).token;
  await beta("admins", jsonReq("/api/beta/admins", "POST", { email: "other@example.com", firstName: "Test", lastName: "Person" }, fresh), env);
  const other = await (await beta("admins/reset", jsonReq("/api/beta/admins/reset", "POST", { email: "other@example.com" }, fresh), env)).json();
  const wrong = await beta("setup-complete", jsonReq("/api/beta/setup-complete", "POST",
    { email, password: "hijack-pass-1", reset: decodeURIComponent(other.link.split("reset=")[1]) }), env);
  assert.equal(wrong.status, 410, "a link for one admin cannot set another's password");
});

test("beta_auth: setup-complete rejects a short password and an unlisted email", async () => {
  const env = makeEnv();
  const short = await beta("setup-complete", jsonReq("/api/beta/setup-complete", "POST",
    { email: "a@b.com", password: "short" }), env);
  assert.equal(short.status, 400);

  const unlisted = await beta("setup-complete", jsonReq("/api/beta/setup-complete", "POST",
    { email: "nobody@b.com", password: "longenough1" }), env);
  assert.equal(unlisted.status, 403);
});

test("beta_auth: a new admin is added, claims an account, and cannot be claimed twice", async () => {
  const { env, token } = await signedInEnv();
  assert.equal((await beta("admins", jsonReq("/api/beta/admins", "POST", { email: "New@Example.com", firstName: "Test", lastName: "Person" }, token), env)).status, 200);

  const claimed = await (await beta("setup-complete", jsonReq("/api/beta/setup-complete", "POST",
    { email: "new@example.com", password: "longenough1" }), env)).json();
  assert.ok(claimed.token, "claiming an allowlisted email should return a session");

  const again = await beta("setup-complete", jsonReq("/api/beta/setup-complete", "POST",
    { email: "new@example.com", password: "longenough2" }), env);
  assert.equal(again.status, 409, "an account with a password must not be re-claimable");
});

test("beta_auth: every admin route refuses an anonymous caller", async () => {
  const env = makeEnv();
  for (const [route, method] of [["admins", "GET"], ["admins", "POST"], ["admins/reset", "POST"],
                                 ["admins/update", "POST"], ["admins/remove", "POST"],
                                 ["sign-out-everywhere", "POST"], ["app-visibility", "POST"]]) {
    const request = method === "GET" ? req(`/api/beta/${route}`) : jsonReq(`/api/beta/${route}`, "POST", {});
    assert.equal((await beta(route, request, env)).status, 401, `${method} ${route}`);
  }
});

test("beta_auth: app-visibility defaults, validates its tier, and stays public on GET", async () => {
  const { env, token } = await signedInEnv();
  const initial = await (await beta("app-visibility", req("/api/beta/app-visibility"), env)).json();
  assert.equal(initial.visibility["council-data"], "public");
  assert.equal(initial.visibility["consensus"], "admin-only", "unlisted apps default to admin-only");

  const bad = await beta("app-visibility", jsonReq("/api/beta/app-visibility", "POST",
    { id: "consensus", tier: "sort-of-public" }, token), env);
  assert.equal(bad.status, 400);

  await beta("app-visibility", jsonReq("/api/beta/app-visibility", "POST",
    { id: "consensus", tier: "public" }, token), env);
  const after = await (await beta("app-visibility", req("/api/beta/app-visibility"), env)).json();
  assert.equal(after.visibility["consensus"], "public");
});

test("beta_auth: requireBetaAuth is the same gate the mini apps import", async () => {
  const { env, token } = await signedInEnv();
  assert.equal(await requireBetaAuth(req("/x"), env), null);
  const auth = await requireBetaAuth(req("/x", { headers: { authorization: `Bearer ${token}` } }), env);
  assert.equal(auth.email, "poneill@conexusindiana.com");
});

/* ========================================================================== stars */
const { handleStarsApi } = await mod("stars.js");

test("stars: a normal employer search returns ranked rows", async () => {
  const env = makeEnv();
  const titles = await (await handleStarsApi("occupations", req("/api/stars/occupations"), env)).json();
  assert.ok(titles.titles.length > 100, "the bundled dataset should load");

  const res = await handleStarsApi("employer/search",
    jsonReq("/api/stars/employer/search", "POST", { targetTitle: titles.titles[0], resultCount: 5 }), env);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.rows.length, 5);
  assert.match(body.rows[0][1], /^\d+\.\d%$/, "column 2 is a skill-similarity percentage");
});

test("stars: prototype-named titles are treated as unknown, not a crash", async () => {
  // BUG: occByTitle was a plain {} inheriting Object.prototype, so a targetTitle of
  // "constructor"/"toString"/"valueOf"/"__proto__" resolved to a FUNCTION, sailed past
  // every `if (!target)` guard, and then threw on target.vector -- turning an
  // unauthenticated POST on a public route into a 500.
  const env = makeEnv();
  for (const evil of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
    for (const [route, field] of [["employer/search", "targetTitle"], ["worker/search", "currentTitle"]]) {
      const res = await handleStarsApi(route, jsonReq(`/api/stars/${route}`, "POST", { [field]: evil }), env);
      assert.equal(res.status, 200, `${route} ${evil} should answer cleanly`);
      const body = await res.json();
      assert.deepEqual(body.rows, [], `${route} ${evil} should find nothing`);
    }
  }
});

test("stars: skill-gap routes handle an out-of-range row index", async () => {
  const env = makeEnv();
  const res = await handleStarsApi("employer/skill-gap", jsonReq("/api/stars/employer/skill-gap", "POST",
    { resultTitles: ["Welders, Cutters, Solderers, and Brazers"], targetTitle: "Machinists", rowIndex: 99 }), env);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).gapRows, []);
});

test("stars: the page reads the title, wage, warning and gap heading the API actually sends", async () => {
  // The redesigned page shows the job's title and wage as a header and "Moving from X to Y",
  // parsed out of the markdown strings src/stars_logic.js builds. If that wording drifts,
  // the header goes blank without an error, so run the page's own parsers on real output.
  const html = fs.readFileSync(path.join(path.dirname(SRC), "public", "stars", "index.html"), "utf8");
  const src = html.slice(html.indexOf("/* starsParse:start"), html.indexOf("/* starsParse:end"));
  const { parseSummary, parseGapHeading } = new Function(src + "; return { parseSummary, parseGapHeading };")();
  const env = makeEnv();
  const post = async (route, body) =>
    (await handleStarsApi(route, jsonReq(`/api/stars/${route}`, "POST", body), env)).json();

  const emp = await post("employer/search", { targetTitle: "Machinists", lowerWageOnly: true, resultCount: 5 });
  assert.deepEqual(parseSummary(emp.targetSummary), { title: "Machinists", wage: "$57,720", warning: "" });
  assert.deepEqual(parseGapHeading(emp.gapHeading), { from: emp.resultTitles[0], to: "Machinists" });
  const click = await post("employer/skill-gap", { targetTitle: "Machinists", resultTitles: emp.resultTitles, rowIndex: 2 });
  assert.deepEqual(parseGapHeading(click.gapHeading), { from: emp.resultTitles[2], to: "Machinists" });

  const wrk = await post("worker/search", { currentTitle: "Helpers--Carpenters", higherWageOnly: true, resultCount: 5 });
  const ws = parseSummary(wrk.currentSummary);
  assert.equal(ws.title, "Helpers--Carpenters");
  assert.match(ws.wage, /^\$\d{1,3}(,\d{3})*$/);
  assert.deepEqual(parseGapHeading(wrk.gapHeading), { from: "Helpers--Carpenters", to: wrk.resultTitles[0] });

  const noWage = await post("employer/search", { targetTitle: "Timing Device Assemblers and Adjusters", lowerWageOnly: true, resultCount: 5 });
  const nw = parseSummary(noWage.targetSummary);
  assert.equal(nw.wage, "N/A");
  assert.match(nw.warning, /lower-wage filter was ignored/, "the ignored-filter warning reaches the page");
  assert.equal(parseGapHeading("### Skills gap"), null, "no pair, no heading");
});

test("stars: admin routes refuse an anonymous caller", async () => {
  const env = makeEnv();
  for (const [route, method] of [["status", "GET"], ["upload", "POST"], ["refresh", "POST"],
                                 ["box/select-folder", "POST"]]) {
    const request = method === "GET" ? req(`/api/stars/${route}`) : jsonReq(`/api/stars/${route}`, "POST", {});
    assert.equal((await handleStarsApi(route, request, env)).status, 401, `${method} ${route}`);
  }
});

/* =================================================================== council_data */
const { handleCouncilDataApi } = await mod("council_data.js");

test("council_data: POST run allowlists the job, including prototype-named ones", async () => {
  // BUG: the job -> workflow-file map was an object literal, so job "constructor" or
  // "toString" resolved to a function, passed `if (!workflow)`, and was interpolated
  // straight into the GitHub Actions dispatch URL.
  const { env, token } = await signedInEnv();
  await withFetch(() => okJson({}), async (calls) => {
    for (const job of ["constructor", "toString", "valueOf", "__proto__", "nonsense"]) {
      const res = await handleCouncilDataApi("run", jsonReq("/api/council-data/run", "POST", { job }, token), env);
      assert.equal(res.status, 400, `job ${job} must be refused`);
      assert.equal((await res.json()).error, "Unknown job");
    }
    assert.equal(calls.length, 0, "a refused job must never reach the GitHub API");

    const ok = await handleCouncilDataApi("run", jsonReq("/api/council-data/run", "POST",
      { job: "refresh_dashboard" }, token), env);
    assert.equal(ok.status, 200);
    assert.match(calls[0].url, /workflows\/refresh_dashboard\.yml\/dispatches$/);
  });
});

test("council_data: remove_meetings requires survey_ids", async () => {
  const { env, token } = await signedInEnv();
  await withFetch(() => okJson({}), async () => {
    const res = await handleCouncilDataApi("run", jsonReq("/api/council-data/run", "POST",
      { job: "remove_meetings", survey_ids: [] }, token), env);
    assert.equal(res.status, 400);
  });
});

test("council_data: the pipeline relay refuses a wrong shared secret", async () => {
  const env = makeEnv();
  for (const key of ["", "not-the-secret"]) {
    const res = await handleCouncilDataApi("relay/pipeline-token",
      req("/api/council-data/relay/pipeline-token", { headers: { "x-pipeline-key": key } }), env);
    assert.equal(res.status, 401, `key ${JSON.stringify(key)}`);
  }
});

/* ============================================================================ mcm */
const { handleMcmApi } = await mod("mcm.js");

test("mcm: POST run allowlists the job, including prototype-named ones", async () => {
  const { env, token } = await signedInEnv();
  await withFetch(() => okJson({}), async (calls) => {
    for (const job of ["constructor", "toString", "__proto__"]) {
      const res = await handleMcmApi("run", jsonReq("/api/mcm/run", "POST", { job }, token), env);
      assert.equal(res.status, 400, `job ${job} must be refused`);
    }
    assert.equal(calls.length, 0);
    const ok = await handleMcmApi("run", jsonReq("/api/mcm/run", "POST", { job: "publish" }, token), env);
    assert.equal(ok.status, 200);
    assert.match(calls[0].url, /workflows\/mcm_publish\.yml\/dispatches$/);
  });
});

test("mcm: the pipeline relay refuses a wrong shared secret and reports a real lifetime", async () => {
  const env = makeEnv();
  assert.equal((await handleMcmApi("relay/pipeline-token",
    req("/api/mcm/relay/pipeline-token", { headers: { "x-pipeline-key": "nope" } }), env)).status, 401);

  await env.BOX_KV.put("box:tokens", JSON.stringify({
    access_token: "box-token", refresh_token: "r",
    obtained_at: Math.floor(Date.now() / 1000) - 600, expires_in: 3600,
  }));
  await env.BOX_KV.put("mcm:folder", JSON.stringify({ id: "123", name: "MCM" }));
  const res = await handleMcmApi("relay/pipeline-token",
    req("/api/mcm/relay/pipeline-token", { headers: { "x-pipeline-key": "relay-secret" } }), env);
  const body = await res.json();
  assert.equal(body.access_token, "box-token");
  assert.equal(body.folder_id, "123");
  assert.ok(body.expires_in > 2900 && body.expires_in < 3010, `remaining lifetime, got ${body.expires_in}`);
});

/* ====================================================================== artifacts */
const { handleArtifactsApi } = await mod("artifacts.js");

test("artifacts: the public list shows only public entries", async () => {
  const { env, token } = await signedInEnv();
  for (const [title, visibility] of [["Shown", "public"], ["Hidden", "private"]]) {
    const res = await handleArtifactsApi("add", jsonReq("/api/artifacts/add", "POST",
      { title, url: "https://claude.ai/artifact/x", visibility }, token), env);
    assert.equal(res.status, 200, title);
  }
  const listed = await (await handleArtifactsApi("list", req("/api/artifacts/list"), env)).json();
  assert.deepEqual(listed.artifacts.map((a) => a.title), ["Shown"]);
  assert.ok(!("addedBy" in listed.artifacts[0]), "the public view must not leak who added it");

  const full = await (await handleArtifactsApi("catalogue",
    req("/api/artifacts/catalogue", { headers: { authorization: `Bearer ${token}` } }), env)).json();
  assert.equal(full.artifacts.length, 2);
});

test("artifacts: add validates the URL and the visibility tier", async () => {
  const { env, token } = await signedInEnv();
  for (const body of [{ title: "x", url: "javascript:alert(1)", visibility: "public" },
                      { title: "x", url: "not a url", visibility: "public" },
                      { title: "x", url: "https://ok.test", visibility: "semi-public" },
                      { title: "", url: "https://ok.test", visibility: "public" }]) {
    const res = await handleArtifactsApi("add", jsonReq("/api/artifacts/add", "POST", body, token), env);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test("artifacts: slugs stay unique across same-titled entries", async () => {
  const { env, token } = await signedInEnv();
  for (let i = 0; i < 3; i++) {
    await handleArtifactsApi("add", jsonReq("/api/artifacts/add", "POST",
      { title: "Same Name", url: "https://ok.test", visibility: "public" }, token), env);
  }
  const listed = await (await handleArtifactsApi("list", req("/api/artifacts/list"), env)).json();
  const slugs = listed.artifacts.map((a) => a.slug);
  assert.deepEqual(slugs, ["same-name", "same-name-2", "same-name-3"]);
});

/* ====================================================================== consensus */
const { handleConsensusApi } = await mod("consensus.js");

test("consensus: the public survey view hides the admin's private guidance", async () => {
  const { env, token } = await signedInEnv();
  const created = await (await handleConsensusApi("surveys", jsonReq("/api/consensus/surveys", "POST", {
    name: "Test survey", objective: "SECRET OBJECTIVE", audience: "SECRET AUDIENCE",
    generalGuidance: "SECRET GUIDANCE",
    questions: [{ text: "What could be better?", followUps: 2, context: "SECRET CONTEXT" }],
  }, token), env)).json();

  const publicView = await (await handleConsensusApi(`public/${created.survey.id}`,
    req(`/api/consensus/public/${created.survey.id}`), env)).json();
  const serialized = JSON.stringify(publicView);
  for (const secret of ["SECRET OBJECTIVE", "SECRET AUDIENCE", "SECRET GUIDANCE", "SECRET CONTEXT"]) {
    assert.ok(!serialized.includes(secret), `${secret} must not reach a respondent`);
  }
  assert.deepEqual(publicView.questions.map((q) => q.text), ["What could be better?"]);
});

test("consensus: follow-up counts are clamped and forward references are dropped", async () => {
  const { env, token } = await signedInEnv();
  const created = await (await handleConsensusApi("surveys", jsonReq("/api/consensus/surveys", "POST", {
    name: "Clamping",
    questions: [
      // q2 personalizes from a LATER question and from itself -- neither can work at
      // respond time, so both must be stripped rather than trusted from the client.
      { id: "q1", text: "First", followUps: 999 },
      { id: "q2", text: "Second", followUps: -5, personalizeFrom: ["q3", "q2", "q1"] },
      { id: "q3", text: "Third" },
      { text: "   " },                       // blank questions are dropped entirely
    ],
  }, token), env)).json();

  const questions = created.survey.questions;
  assert.deepEqual(questions.map((q) => q.text), ["First", "Second", "Third"]);
  assert.equal(questions[0].followUps, 5, "follow-ups are capped at MAX_FOLLOW_UPS");
  assert.equal(questions[1].followUps, 0, "a negative follow-up count floors at 0");
  assert.deepEqual(questions[1].personalizeFrom, ["q1"], "only strictly-earlier ids survive");
});

test("consensus: a survey needs a name and at least one question", async () => {
  const { env, token } = await signedInEnv();
  for (const body of [{ name: "", questions: [{ text: "q" }] }, { name: "x", questions: [] }]) {
    assert.equal((await handleConsensusApi("surveys",
      jsonReq("/api/consensus/surveys", "POST", body, token), env)).status, 400);
  }
});

test("consensus: respondent answers are CSV-escaped when written to Box", async () => {
  const { env, token } = await signedInEnv();
  const created = await (await handleConsensusApi("surveys", jsonReq("/api/consensus/surveys", "POST",
    { name: "CSV", questions: [{ text: "Q" }] }, token), env)).json();
  const survey = created.survey;
  survey.boxFolderId = "99";
  await env.BOX_KV.put(`consensus:survey:${survey.id}`, JSON.stringify(survey));
  await env.BOX_KV.put("box:tokens", JSON.stringify({
    access_token: "t", refresh_token: "r", obtained_at: Math.floor(Date.now() / 1000), expires_in: 3600,
  }));

  let uploaded = "";
  await withFetch(async (url, init) => {
    if (url.includes("/items?")) return okJson({ entries: [] });
    if (url.includes("upload.box.com")) {
      uploaded = await init.body.get("file").text();
      return okJson({ entries: [{ id: "f1", name: "x.csv" }] });
    }
    return okJson({});
  }, async () => {
    const res = await handleConsensusApi("submit", jsonReq("/api/consensus/submit", "POST", {
      surveyId: survey.id,
      responses: [{ questionId: survey.questions[0].id, questionText: "Q", turns: [
        { turn: 0, prompt: "Q", answer: 'He said "more, please"\nand left' },
      ] }],
    }), env);
    assert.equal(res.status, 200);
  });

  assert.ok(uploaded.startsWith("Response ID,Submitted At,Question ID"), "header must be written first");
  assert.ok(uploaded.includes('"He said ""more, please""\nand left"'),
    `quotes, commas and newlines must be escaped -- got: ${JSON.stringify(uploaded.slice(-80))}`);
  // One logical row despite the embedded newline.
  assert.equal(uploaded.trim().split("\n").length, 3);
});

test("consensus: the relay refuses a wrong shared secret", async () => {
  const env = makeEnv();
  const res = await handleConsensusApi("relay/survey/abc",
    req("/api/consensus/relay/survey/abc", { headers: { "x-pipeline-key": "nope" } }), env);
  assert.equal(res.status, 401);
});

/* ================================================================ job_description */
const { handleJobDescriptionApi } = await mod("job_description.js");

const PRE_READ_RESULT = {
  jobTitle: "CNC Machining Technician",
  categories: [
    { key: "job_title", extractedText: "CNC Machining Technician", status: "aligned", statusReasoning: "Matches." },
    { key: "essential_duties", extractedText: "Runs lathes.", status: "significant_gap", statusReasoning: "Omits inspection." },
    { key: "education", extractedText: "Associate degree required", status: "minor_drift", statusReasoning: "Possibly a proxy." },
  ],
  duties: [
    { id: "duty-1", text: "Set up and operate CNC lathes and mills to print", drivers: [], vague: false },
    { id: "duty-2", text: "Sweep the department", drivers: [], vague: true },
  ],
  driverGuesses: { systems: "MES", automation: "None stated", decisionAuthority: "Unclear", crossTraining: "Unclear" },
  systemGaps: ["CMM"],
  technologySummary: "CNC lathe, CNC mill, micrometers, calipers, CMM, Fanuc controls",
  requirements: [
    { id: "req-1", text: "Associate degree", kind: "education" },
    { id: "req-2", text: "Blueprint and GD&T reading", kind: "skill" },
  ],
  onetMatch: { code: "51-4011", title: "CNC Tool Operators", reasoning: "Duties match." },
  currentTitleOnetGuess: { code: "51-4011", title: "CNC Tool Operators" },
};

const OUTPUTS_RESULT = {
  summary: "The biggest change is that inspection is now part of the job.",
  documentTitle: "CNC Machining Technician",
  document: [
    { type: "title", runs: [{ text: "CNC Machining Technician", change: "none" }] },
    { type: "heading1", runs: [{ text: "Essential Duties", change: "none" }] },
    { type: "bullet", runs: [
      { text: "Set up and operate CNC lathes and mills to print", change: "none" },
      { text: ", and inspect first articles", change: "ins" },
    ] },
    { type: "bullet", runs: [{ text: "Sweep the department", change: "del" }] },
  ],
  oneSheet: [
    { type: "title", runs: [{ text: "CNC Machining Technician" }] },
    { type: "paragraph", runs: [{ text: "You run the machines that make the parts." }] },
  ],
  credentials: [
    { name: "NIMS Machining — Milling I (Level I)", tier: "preferred", whyItFits: "The duties are milling to print." },
  ],
};

const claudeResponse = (input) => okJson({ content: [{ type: "tool_use", input }] });
const docxFormEnv = () => makeEnv({ job_description_claude_api: "key" });

function docxUploadForm(extra = {}) {
  const xml = "<w:document><w:body><w:p><w:r><w:t>Runs lathes.</w:t></w:r></w:p></w:body></w:document>";
  const form = new FormData();
  form.append("file", new File([buildDocx(xml)], "jd.docx"));
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
}

/** Upload a session with a stubbed pre-read, returning { env, session }. */
async function startSession(env, formExtras = {}) {
  let session;
  await withFetch(async () => claudeResponse(PRE_READ_RESULT), async () => {
    const res = await handleJobDescriptionApi("upload",
      req("/api/job-description/upload", { method: "POST", body: docxUploadForm(formExtras) }), env);
    // Read the body ONCE: a Response body is a stream, so calling .text() for the
    // assertion message and then .json() throws "Body has already been read".
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    session = body.session;
  });
  return session;
}

test("job_description: .docx entities are decoded once, not twice", async () => {
  // BUG: docxXmlToText() decoded &amp; FIRST, so the document's own literal "&amp;lt;"
  // became "&lt;" and the very next replace turned it into "<" -- silently rewriting
  // the employer's text before Claude ever saw it.
  const env = docxFormEnv();
  const xml = "<w:document><w:body>"
    + "<w:p><w:r><w:t>Q&amp;A about &amp;lt;tags&amp;gt; and 5 &lt; 6</w:t></w:r></w:p>"
    + "<w:p><w:r><w:t>Line one</w:t></w:r><w:r><w:br w:type=\"textWrapping\"/><w:t>Line two</w:t></w:r></w:p>"
    + "<w:p><w:r><w:t xml:space=\"preserve\">don&#8217;t</w:t><w:tab/><w:t>after tab</w:t></w:r></w:p>"
    + "</w:body></w:document>";
  const form = new FormData();
  form.append("file", new File([buildDocx(xml)], "jd.docx"));

  let promptSent = "";
  await withFetch(async (url, init) => {
    promptSent = JSON.parse(init.body).messages[0].content[0].text;
    return claudeResponse(PRE_READ_RESULT);
  }, async () => {
    const res = await handleJobDescriptionApi("upload",
      req("/api/job-description/upload", { method: "POST", body: form }), env);
    assert.equal(res.status, 200, await res.text());
  });

  assert.ok(promptSent.includes("Q&A about &lt;tags&gt; and 5 < 6"),
    `entities must decode exactly once -- got: ${JSON.stringify(promptSent.slice(-160))}`);
  assert.ok(promptSent.includes("Line one\nLine two"), "an attributed <w:br> is still a line break");
  assert.ok(promptSent.includes("don’t"), "numeric character references are decoded");
});

test("job_description: the upload carries the employer context, so there is no extra screen", async () => {
  const env = docxFormEnv();
  const session = await startSession(env, {
    role: "Plant Supervisor", hardToFill: "true", lastUpdated: "3 years ago",
  });
  assert.deepEqual(session.respondent,
    { role: "Plant Supervisor", hardToFill: true, lastUpdated: "3 years ago" });
  assert.equal(session.status, "pre_read");
});

test("job_description: a credential shortlist is scored on upload, with no extra API call", async () => {
  const env = docxFormEnv();
  let claudeCalls = 0;
  let session;
  await withFetch(async (url) => {
    if (url.includes("api.anthropic.com")) claudeCalls++;
    return claudeResponse(PRE_READ_RESULT);
  }, async () => {
    const res = await handleJobDescriptionApi("upload",
      req("/api/job-description/upload", { method: "POST", body: docxUploadForm() }), env);
    session = (await res.json()).session;
  });

  assert.equal(claudeCalls, 1, "the pre-read is the only call the upload makes");
  assert.ok(session.credentialShortlist.length > 0 && session.credentialShortlist.length <= 8);
  // These duties are machining, so NIMS machining should lead.
  assert.match(session.credentialShortlist[0].name, /NIMS Machining/);
  for (const c of session.credentialShortlist) {
    assert.ok(c.name && c.signals && typeof c.score === "number");
  }
});

test("job_description: confirm-pre-read ignores junk from the public client", async () => {
  // BUG: this public route Object.assign-ed the request body straight onto preRead, so
  // any caller could replace duties/requirements/categories with a non-array -- which
  // then threw deep inside computeMatrix()/generate-outputs as a 500 several steps on.
  const env = docxFormEnv();
  const session = await startSession(env);

  const res = await handleJobDescriptionApi(`session/${session.id}/confirm-pre-read`,
    jsonReq(`/api/job-description/session/${session.id}/confirm-pre-read`, "POST", {
      edits: {
        duties: "not an array",
        requirements: null,
        jobTitle: "Injected Title",
        categories: [{ key: "essential_duties", extractedText: "Edited by the employer" }],
      },
    }), env);
  const updated = (await res.json()).session;

  assert.ok(Array.isArray(updated.preRead.duties), "duties must stay an array");
  assert.ok(Array.isArray(updated.preRead.requirements), "requirements must stay an array");
  assert.equal(updated.preRead.jobTitle, "CNC Machining Technician", "only the edited field may change");
  assert.equal(updated.preRead.categories[1].extractedText, "Edited by the employer");
  assert.equal(updated.preRead.confirmed, true);

  const matrix = await handleJobDescriptionApi(`session/${session.id}/matrix`,
    req(`/api/job-description/session/${session.id}/matrix`), env);
  assert.equal(matrix.status, 200);
  assert.equal((await matrix.json()).matrix.length, 5);
});

test("job_description: the flow runs end to end in two Claude calls", async () => {
  // The whole point of the streamlining: the pre-read and the outputs are the only two
  // model calls; every step in between is the employer confirming what is already there.
  const env = docxFormEnv();
  let claudeCalls = 0;
  const countingFetch = async (u, init) => {
    if (u.includes("api.anthropic.com")) {
      claudeCalls++;
      return claudeResponse(JSON.parse(init.body).tools[0].name === "submit_pre_read"
        ? PRE_READ_RESULT : OUTPUTS_RESULT);
    }
    return okJson({});
  };

  // Everything from the upload onward runs under one stub, so the count covers the
  // WHOLE flow rather than only the part after the session exists.
  await withFetch(countingFetch, async () => {
    const uploaded = await handleJobDescriptionApi("upload",
      req("/api/job-description/upload", { method: "POST", body: docxUploadForm({ role: "HR Manager" }) }), env);
    const uploadedBody = await uploaded.json();
    assert.equal(uploaded.status, 200, JSON.stringify(uploadedBody));
    const session = uploadedBody.session;
    const at = (sub) => `session/${session.id}/${sub}`;
    const url = (sub) => `/api/job-description/${at(sub)}`;

    assert.equal((await handleJobDescriptionApi(at("confirm-pre-read"),
      jsonReq(url("confirm-pre-read"), "POST", {}), env)).status, 200);

    const step3 = await handleJobDescriptionApi(at("step3"), jsonReq(url("step3"), "POST", {
      dutyAnswers: { "duty-1": { answer: "changed", note: "now inspects too" },
                     "duty-2": { answer: "no_longer_done" } },
      driverAnswers: { systems: "MES", automation: "", decisionAuthority: "Can stop the line", crossTraining: "" },
    }), env);
    assert.equal((await step3.json()).session.status, "requirements");

    const step4 = await handleJobDescriptionApi(at("step4"), jsonReq(url("step4"), "POST", {
      requirementAnswers: { "req-1": { tier: "would_train", incumbentMeets: false },
                            "req-2": { tier: "must_have", incumbentMeets: true } },
    }), env);
    assert.equal((await step4.json()).session.status, "finalize");

    const finalized = await handleJobDescriptionApi(at("finalize"), jsonReq(url("finalize"), "POST", {
      payRange: "$22-28/hr", physicalFrequency: "Lifting up to 40 lbs, a few times a shift",
      pathway: "Lead machinist in 3 years", screenDifferently: true, compChanges: false,
    }), env);
    const afterFinalize = (await finalized.json()).session;
    assert.equal(afterFinalize.status, "outputs");
    assert.equal(afterFinalize.step5.payRange, "$22-28/hr");
    assert.equal(afterFinalize.step6.matrix.length, 5);

    const generated = await handleJobDescriptionApi(at("generate-outputs"),
      jsonReq(url("generate-outputs"), "POST", {}), env);
    const generatedBody = await generated.json();
    assert.equal(generated.status, 200, JSON.stringify(generatedBody));
    const done = generatedBody.session;
    assert.equal(done.status, "complete");
    assert.equal(done.outputs.summary, OUTPUTS_RESULT.summary);
    assert.equal(done.outputs.credentials.length, 1);
  });

  assert.equal(claudeCalls, 2, "the whole flow costs exactly two Claude calls");
});

test("job_description: a vague duty rewritten on the duties screen replaces the duty everywhere", async () => {
  const env = docxFormEnv();
  const session = await startSession(env);
  const res = await handleJobDescriptionApi(`session/${session.id}/step3`,
    jsonReq(`/api/job-description/session/${session.id}/step3`, "POST", {
      dutyAnswers: { "duty-2": { answer: "still_accurate" } },
      dutyEdits: {
        "duty-2": "  Clean and 5S the cell at the end of each shift  ",
        "duty-1": "Set up and operate CNC lathes and mills to print", // unchanged
        "duty-404": "an id that isn't in this pre-read",
        "duty-1-again": { not: "a string" },
      },
    }), env);
  const body = await res.json();
  const duties = body.session.preRead.duties;
  const rewritten = duties.find((d) => d.id === "duty-2");
  assert.equal(rewritten.text, "Clean and 5S the cell at the end of each shift", "trimmed and applied");
  assert.equal(rewritten.vague, false, "the placeholder wording is gone, so the flag is too");
  assert.equal(rewritten.originalText, "Sweep the department", "the original is kept for the redline");
  assert.equal(duties.find((d) => d.id === "duty-1").text,
    "Set up and operate CNC lathes and mills to print");
  assert.ok(!duties.find((d) => d.id === "duty-404"), "an unknown duty id must not add a duty");
  assert.equal(duties.length, 2);
});

test("job_description: a non-string duty edit cannot replace a duty's text", async () => {
  // This route is public, so the edits are untrusted: an object here used to be able to
  // land in preRead.duties[].text and blow up much later, inside generate-outputs.
  const env = docxFormEnv();
  const session = await startSession(env);
  const body = await (await handleJobDescriptionApi(`session/${session.id}/step3`,
    jsonReq(`/api/job-description/session/${session.id}/step3`, "POST", {
      dutyAnswers: {}, dutyEdits: { "duty-2": { evil: true } },
    }), env)).json();
  assert.equal(body.session.preRead.duties.find((d) => d.id === "duty-2").text, "Sweep the department");
});

test("job_description: the on-screen summary is a headline plus bullets, flattened for Box", async () => {
  const env = docxFormEnv();
  const session = await startSession(env);
  await env.BOX_KV.put(`jobdesc:session:${session.id}`, JSON.stringify({
    ...session, step6: { matrix: [], score: 1, recommendation: "Update the existing description." },
  }));
  const withBullets = {
    ...OUTPUTS_RESULT,
    summary: undefined,
    summaryHeadline: "Inspection is now part of the job.",
    summaryBullets: ["First-article inspection added to the duties", "Associate degree dropped to preferred"],
  };
  delete withBullets.summary;

  const body = await (await withFetch(async () => claudeResponse(withBullets),
    () => handleJobDescriptionApi(`session/${session.id}/generate-outputs`,
      jsonReq(`/api/job-description/session/${session.id}/generate-outputs`, "POST", {}), env))).json();

  const outputs = body.session.outputs;
  assert.deepEqual(outputs.summaryBullets, withBullets.summaryBullets, "the bullets reach the screen");
  // Box gets one text file, so the structured summary has to flatten to a string rather
  // than writing "undefined" into summary-of-changes.txt.
  assert.equal(outputs.summary,
    "Inspection is now part of the job.\n"
    + "- First-article inspection added to the duties\n"
    + "- Associate degree dropped to preferred");
});

test("job_description: a session generated before bullets existed keeps its prose summary", async () => {
  const env = docxFormEnv();
  const session = await startSession(env);
  await env.BOX_KV.put(`jobdesc:session:${session.id}`, JSON.stringify({
    ...session, step6: { matrix: [], score: 1, recommendation: "Update the existing description." },
  }));
  const body = await (await withFetch(async () => claudeResponse(OUTPUTS_RESULT),
    () => handleJobDescriptionApi(`session/${session.id}/generate-outputs`,
      jsonReq(`/api/job-description/session/${session.id}/generate-outputs`, "POST", {}), env))).json();
  assert.equal(body.session.outputs.summary, OUTPUTS_RESULT.summary,
    "the old single-paragraph shape must survive, not be blanked by the new one");
});

test("job_description: the shortlist is what the outputs prompt offers, and nothing wider", async () => {
  const env = docxFormEnv();
  const session = await startSession(env);
  await env.BOX_KV.put(`jobdesc:session:${session.id}`, JSON.stringify({
    ...session, step6: { matrix: [], score: 1, recommendation: "Update the existing description." },
  }));

  let prompt = "";
  await withFetch(async (url, init) => {
    const body = JSON.parse(init.body);
    if (body.tools[0].name === "submit_outputs") prompt = body.messages[0].content[0].text;
    return claudeResponse(OUTPUTS_RESULT);
  }, () => handleJobDescriptionApi(`session/${session.id}/generate-outputs`,
    jsonReq(`/api/job-description/session/${session.id}/generate-outputs`, "POST", {}), env));

  assert.ok(prompt.includes("Credential shortlist for this role"), "the shortlist reaches the prompt");
  for (const c of session.credentialShortlist) {
    assert.ok(prompt.includes(c.name), `${c.name} should be offered`);
  }
  // 30 credentials exist; the prompt must not be a catalogue of all of them.
  assert.ok(session.credentialShortlist.length <= 8);
  assert.ok(!prompt.includes("OSHA 10-Hour — Construction Industry"),
    "a construction card has no business on a machining role");
});

test("job_description: the three downloads are real Word files and agree with each other", async () => {
  const env = docxFormEnv();
  const session = await startSession(env);
  await env.BOX_KV.put(`jobdesc:session:${session.id}`, JSON.stringify({
    ...session,
    step6: { matrix: [], score: 1, recommendation: "Update the existing description." },
    outputs: { ...OUTPUTS_RESULT, generatedAt: "2026-09-23T10:00:00Z", box: { saved: false } },
    status: "complete",
  }));

  const files = {};
  for (const kind of ["redline", "final", "one-pager"]) {
    const res = await handleJobDescriptionApi(`session/${session.id}/download/${kind}`,
      req(`/api/job-description/session/${session.id}/download/${kind}`), env);
    assert.equal(res.status, 200, kind);
    assert.equal(res.headers.get("content-type"),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document", kind);
    assert.match(res.headers.get("content-disposition"),
      new RegExp(`attachment; filename="cnc-machining-technician-[a-z-]+\\.docx"`), kind);
    files[kind] = new Uint8Array(await res.arrayBuffer());
    // PK\x03\x04 -- a real ZIP, which is what a .docx is.
    assert.deepEqual([...files[kind].slice(0, 4)], [0x50, 0x4b, 0x03, 0x04], kind);
  }

  const text = (bytes) => new TextDecoder().decode(bytes);
  assert.ok(text(files.redline).includes("<w:ins "), "the redline carries tracked insertions");
  assert.ok(text(files.redline).includes("<w:delText"), "the redline carries tracked deletions");
  assert.ok(!text(files.final).includes("<w:ins "), "the final version has no revision marks");
  assert.ok(!text(files.final).includes("Sweep the department"),
    "a deleted duty must not survive into the clean version");
  assert.ok(text(files.final).includes("and inspect first articles"),
    "an inserted phrase must survive into the clean version");
  assert.ok(text(files["one-pager"]).includes("You run the machines"));
});

test("job_description: an unknown download and a session with no outputs are refused", async () => {
  const env = docxFormEnv();
  const session = await startSession(env);
  assert.equal((await handleJobDescriptionApi(`session/${session.id}/download/redline`,
    req(`/api/job-description/session/${session.id}/download/redline`), env)).status, 409);

  await env.BOX_KV.put(`jobdesc:session:${session.id}`, JSON.stringify({
    ...session, outputs: { ...OUTPUTS_RESULT, box: { saved: false } },
  }));
  assert.equal((await handleJobDescriptionApi(`session/${session.id}/download/everything`,
    req(`/api/job-description/session/${session.id}/download/everything`), env)).status, 404);
});

test("job_description: a job title cannot break out of the download filename", async () => {
  const env = docxFormEnv();
  const session = await startSession(env);
  await env.BOX_KV.put(`jobdesc:session:${session.id}`, JSON.stringify({
    ...session,
    outputs: { ...OUTPUTS_RESULT, documentTitle: 'Bad"; rm -rf /\r\nX-Injected: yes', box: { saved: false } },
  }));
  const res = await handleJobDescriptionApi(`session/${session.id}/download/final`,
    req(`/api/job-description/session/${session.id}/download/final`), env);
  const disposition = res.headers.get("content-disposition");
  assert.ok(!/["\r\n]/.test(disposition.slice("attachment; filename=".length + 1, -1)),
    `the filename must carry no quotes or newlines: ${disposition}`);
  assert.match(disposition, /^attachment; filename="[a-z0-9-]+\.docx"$/);
});

test("job_description: re-running generate-outputs still saves to Box", async () => {
  // BUG: boxUploadFile() always created a NEW file, so a second run hit Box's 409 name
  // conflict on every output -- generated and paid for, but never saved.
  const env = docxFormEnv();
  const session = await startSession(env);
  await env.BOX_KV.put(`jobdesc:session:${session.id}`, JSON.stringify({
    ...session, boxSubfolderId: "sub-1",
    step6: { matrix: [], score: 1, recommendation: "Update the existing description." },
  }));
  await env.BOX_KV.put("box:tokens", JSON.stringify({
    access_token: "t", refresh_token: "r", obtained_at: Math.floor(Date.now() / 1000), expires_in: 3600,
  }));

  const existingInBox = new Set();
  const run = () => withFetch(async (url, init) => {
    if (url.includes("api.anthropic.com")) return claudeResponse(OUTPUTS_RESULT);
    if (url.includes("/items?")) {
      return okJson({ entries: [...existingInBox].map((name, i) => ({ id: `f${i}`, type: "file", name })) });
    }
    if (url.includes("upload.box.com")) {
      const attributes = init.body.get("attributes");
      if (attributes) {
        const name = JSON.parse(attributes).name;
        if (existingInBox.has(name)) return new Response("item_name_in_use", { status: 409 });
        existingInBox.add(name);
      }
      return okJson({ entries: [{ id: "f", name: "x" }] });
    }
    return okJson({});
  }, () => handleJobDescriptionApi(`session/${session.id}/generate-outputs`,
      jsonReq(`/api/job-description/session/${session.id}/generate-outputs`, "POST", {}), env));

  const first = (await (await run()).json()).session;
  assert.equal(first.outputs.box.saved, true, "first run should save");
  assert.equal(existingInBox.size, 4, "three Word files plus the summary");
  assert.ok([...existingInBox].some((n) => n.endsWith("-redline.docx")));

  const second = (await (await run()).json()).session;
  assert.equal(second.outputs.box.saved, true, "a re-run must upload new VERSIONS, not 409");
});

test("job_description: generate-outputs survives a category key outside the known list", async () => {
  // BUG: formatConfirmedInputs() did PART2_CATEGORIES.find(...).label with no guard, so
  // an unexpected key threw -- turning the final, already-paid-for call into a 500.
  const env = docxFormEnv();
  const session = await startSession(env);
  await env.BOX_KV.put(`jobdesc:session:${session.id}`, JSON.stringify({
    ...session,
    preRead: { ...PRE_READ_RESULT, categories: [{ key: "not_a_real_category", extractedText: "text" }] },
    step6: { matrix: [], score: 0, recommendation: "Update the existing description." },
  }));
  await withFetch(async () => claudeResponse(OUTPUTS_RESULT), async () => {
    const res = await handleJobDescriptionApi(`session/${session.id}/generate-outputs`,
      jsonReq(`/api/job-description/session/${session.id}/generate-outputs`, "POST", {}), env);
    assert.equal(res.status, 200, await res.text());
  });
});

test("job_description: generate-outputs refuses to run before the final questions", async () => {
  const env = docxFormEnv();
  const session = await startSession(env);
  const res = await handleJobDescriptionApi(`session/${session.id}/generate-outputs`,
    jsonReq(`/api/job-description/session/${session.id}/generate-outputs`, "POST", {}), env);
  assert.equal(res.status, 409);
});

test("job_description: only PDF and .docx are accepted", async () => {
  const env = docxFormEnv();
  const form = new FormData();
  form.append("file", new File(["hello"], "jd.txt", { type: "text/plain" }));
  const res = await handleJobDescriptionApi("upload",
    req("/api/job-description/upload", { method: "POST", body: form }), env);
  assert.equal(res.status, 400);
});

test("job_description: the decision matrix scores from the answers actually given", async () => {
  const env = makeEnv();
  await env.BOX_KV.put("jobdesc:session:sess-matrix", JSON.stringify({
    id: "sess-matrix",
    preRead: {
      duties: [{ id: "d1" }, { id: "d2" }, { id: "d3" }],
      requirements: [{ id: "r1", kind: "certification" }],
      onetMatch: { code: "51-4011", title: "A" },
      currentTitleOnetGuess: { code: "51-9999", title: "B" },
      categories: [],
    },
    step3: { dutyAnswers: { d1: { answer: "changed" }, d2: { answer: "no_longer_done" }, d3: { answer: "same" } } },
    step4: { requirementAnswers: { r1: { tier: "must_have" } } },
    credentialShortlist: [{ name: "NIMS Machining — Milling I (Level I)", family: "NIMS", score: 0.27 }],
  }));
  const body = await (await handleJobDescriptionApi("session/sess-matrix/matrix",
    req("/api/job-description/session/sess-matrix/matrix"), env)).json();
  const byId = Object.fromEntries(body.matrix.map((m) => [m.id, m.value]));
  assert.equal(byId.duties_changed, true, "2 of 3 duties changed is a majority");
  assert.equal(byId.distinct_competency, true, "a kept certification plus a close NIMS match");
  assert.equal(byId.different_onet, true);
  assert.equal(body.score, 3);
  assert.match(body.recommendation, /^Create a new title/);
});

test("job_description: a general pathway alone is not a distinct competency set", async () => {
  // Part 4 asks whether the role needs "a distinct technical competency set". A generic
  // pathway (apprenticeship, CTE completion) is not one -- only a specifically named
  // credential is, so it must not tip the score on its own.
  const env = makeEnv();
  await env.BOX_KV.put("jobdesc:session:sess-pathway", JSON.stringify({
    id: "sess-pathway",
    preRead: {
      duties: [{ id: "d1" }], requirements: [{ id: "r1", kind: "certification" }],
      onetMatch: { code: "51-4011", title: "A" }, currentTitleOnetGuess: { code: "51-4011", title: "A" },
      categories: [],
    },
    step3: { dutyAnswers: {} },
    step4: { requirementAnswers: { r1: { tier: "must_have" } } },
    credentialShortlist: [{ name: "Registered Apprenticeship", family: "Pathway", score: 0.4 }],
  }));
  const body = await (await handleJobDescriptionApi("session/sess-pathway/matrix",
    req("/api/job-description/session/sess-pathway/matrix"), env)).json();
  const byId = Object.fromEntries(body.matrix.map((m) => [m.id, m.value]));
  assert.equal(byId.distinct_competency, false);
});

/* ======================================================================== docx.js */
const docx = await mod("docx.js");

test("docx: output is a ZIP carrying every part Word requires", async () => {
  const bytes = docx.buildDocx({ blocks: [{ type: "paragraph", runs: [{ text: "Hello" }] }] });
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  const text = new TextDecoder().decode(bytes);
  for (const part of ["[Content_Types].xml", "_rels/.rels", "word/_rels/document.xml.rels",
                      "word/document.xml", "word/styles.xml", "word/numbering.xml"]) {
    assert.ok(text.includes(part), `missing part: ${part}`);
  }
  // End of central directory, so the archive is terminated properly.
  assert.ok(text.includes("PK\u0005\u0006"));
});

test("docx: insertions and deletions become Word revision markup", async () => {
  const bytes = docx.buildDocx({
    blocks: [{ type: "paragraph", runs: [
      { text: "Keeps ", change: "none" },
      { text: "old ", change: "del" },
      { text: "new", change: "ins" },
    ] }],
    author: "Tester", date: "2026-09-23T10:00:00Z",
  });
  const xml = new TextDecoder().decode(bytes);
  assert.match(xml, /<w:ins w:id="\d+" w:author="Tester" w:date="2026-09-23T10:00:00Z">/);
  assert.match(xml, /<w:del w:id="\d+" w:author="Tester" w:date="2026-09-23T10:00:00Z">/);
  // A deletion's text must be <w:delText>, not <w:t>, or Word rejects the revision.
  assert.ok(xml.includes("<w:delText xml:space=\"preserve\">old </w:delText>"));
  // Every run keeps its spaces, or inserted text runs into the word before it.
  assert.ok(xml.includes('<w:t xml:space="preserve">Keeps </w:t>'));
});

test("docx: cleanCopy accepts the insertions and drops the deletions", async () => {
  const blocks = [
    { type: "paragraph", runs: [
      { text: "Keeps ", change: "none" }, { text: "old ", change: "del" }, { text: "new", change: "ins" },
    ] },
    { type: "bullet", runs: [{ text: "Entirely removed", change: "del" }] },
  ];
  const clean = docx.cleanCopy(blocks);
  assert.equal(clean.length, 1, "a block whose every run was deleted disappears");
  assert.equal(docx.toPlainText(clean), "Keeps new");
  assert.ok(!clean[0].runs.some((r) => "change" in r), "no revision marks survive into the clean copy");
});

test("docx: XML metacharacters and control characters cannot corrupt the file", async () => {
  const bytes = docx.buildDocx({
    blocks: [{ type: "paragraph", runs: [{ text: 'A & B <tag> "q" \u0007bell' }] }],
  });
  const xml = new TextDecoder().decode(bytes);
  assert.ok(xml.includes("A &amp; B &lt;tag&gt; &quot;q&quot; bell"),
    "metacharacters escape and the control character is dropped");
  // Scoped to the text run, not the whole archive: a ZIP's own length and CRC fields
  // routinely contain bytes that decode as control characters, so searching the whole
  // file would fail on a correct document.
  const run = xml.slice(xml.indexOf("<w:t "), xml.indexOf("</w:t>"));
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(run),
    "a control character inside a run would make Word reject the whole file");
});

test("docx: the same input always produces the same bytes", async () => {
  const blocks = [{ type: "paragraph", runs: [{ text: "Stable" }] }];
  const a = docx.buildDocx({ blocks, date: "2026-09-23T10:00:00Z" });
  const b = docx.buildDocx({ blocks, date: "2026-09-23T10:00:00Z" });
  assert.deepEqual([...a], [...b]);
});

/* ================================================================= credentials.js */
const credentials = await mod("credentials.js");

const ROLES = {
  machinist: {
    title: "CNC Machinist",
    duties: ["Set up and operate CNC lathes and mills to produce parts to print",
             "Read blueprints and interpret GD&T callouts",
             "Inspect first articles using calipers and micrometers"],
    requirements: ["2 years machining experience"],
    technology: "Fanuc controls, CMM",
  },
  maintenance: {
    title: "Industrial Maintenance Technician",
    duties: ["Troubleshoot and repair hydraulic and pneumatic systems",
             "Perform preventive maintenance on conveyors, pumps, gearboxes and motors",
             "Diagnose electrical faults using multimeters and schematics"],
    requirements: ["Associate degree preferred"],
    technology: "CMMS, PLC fault screens",
  },
  welder: {
    title: "Welder",
    duties: ["MIG and TIG weld steel and aluminum assemblies to drawing",
             "Grind and finish welds, inspect for porosity and undercut"],
    requirements: ["Weld test required"],
    technology: "Welding power supplies",
  },
  entry: {
    title: "Production Associate",
    duties: ["Load and unload parts from an automated cell",
             "Follow lockout tagout procedures and wear required personal protective equipment",
             "Record production counts and scrap"],
    requirements: ["High school diploma"],
    technology: "MES terminal",
  },
};

test("credentials: each role's closest credential is the right one", async () => {
  const best = (role) => credentials.shortlistCredentials(ROLES[role])[0].name;
  assert.match(best("machinist"), /NIMS Machining/);
  assert.match(best("maintenance"), /Industrial Technology Maintenance/);
  assert.match(best("welder"), /Welding Technology/);
  assert.match(best("entry"), /MSSC CPT/, "the toolkit calls CPT the entry-level baseline");
});

test("credentials: the shortlist is short, scored and ordered best-first", async () => {
  const list = credentials.shortlistCredentials(ROLES.machinist, 8);
  assert.ok(list.length > 0 && list.length <= 8, `got ${list.length}`);
  assert.ok(list.length < credentials.CREDENTIAL_COUNT,
    `${credentials.CREDENTIAL_COUNT} credentials exist; the shortlist must narrow them`);
  for (let i = 1; i < list.length; i++) {
    assert.ok(list[i - 1].score >= list[i].score, "scores must descend");
  }
});

test("credentials: General Industry OSHA outranks the Construction card on a plant role", async () => {
  // The workbook documents both; the toolkit's reference names General Industry. On raw
  // term overlap the Construction cards scored higher, which would have had the app
  // recommending the wrong OSHA card to a manufacturer.
  const list = credentials.shortlistCredentials(ROLES.entry, 30);
  const gi = list.findIndex((c) => c.name === "OSHA 10-Hour — General Industry");
  const construction = list.findIndex((c) => c.name === "OSHA 10-Hour — Construction Industry");
  assert.ok(gi >= 0, "OSHA General Industry should be a candidate for a role with LOTO and PPE duties");
  assert.ok(construction === -1 || gi < construction,
    "General Industry must rank above Construction for a plant floor role");
});

test("credentials: no single family can monopolise the shortlist", async () => {
  // NIMS publishes fourteen machining cards, so a machinist's raw top eight was eight
  // NIMS cards -- the model never saw MSSC, Ivy Tech or a pathway as an option.
  const list = credentials.shortlistCredentials(ROLES.machinist, 8);
  const families = new Set(list.map((c) => c.family));
  assert.ok(families.size >= 2, `expected a spread of families, got ${[...families]}`);
});

test("credentials: a role with no recognisable vocabulary returns nothing to recommend", async () => {
  assert.deepEqual(credentials.shortlistCredentials({ title: "", duties: [], requirements: [] }), []);
  const nonsense = credentials.shortlistCredentials({
    title: "Zzz", duties: ["Qqqq wwww eeee"], requirements: [],
  });
  assert.equal(nonsense.length, 0, "no overlap means no candidates, not a padded list");
});

test("credentials: the prompt rendering names each candidate and why it matched", async () => {
  const list = credentials.shortlistCredentials(ROLES.maintenance, 4);
  const text = credentials.formatShortlist(list);
  for (const c of list) assert.ok(text.includes(c.name), c.name);
  assert.ok(text.includes("Signals:"), "each candidate carries what it signals");
  assert.ok(text.includes("Matched on:"), "and the terms that put it on the list");
  assert.equal(credentials.formatShortlist([]),
    "(no credential in the reference matrix matched this role's wording)");
});

test("credentials: the tokenizer drops noise and keeps the short terms that discriminate", async () => {
  const tokens = credentials.tokenize("Operate the CNC lathe and perform PPE checks");
  assert.ok(tokens.includes("cnc"), "a three-letter term on the keep list survives");
  assert.ok(tokens.includes("lathe"));
  assert.ok(!tokens.includes("the"), "stopwords are dropped");
  assert.ok(!tokens.includes("perform"), "workbook boilerplate verbs are dropped");
});

/* ======================================================================= worker.js */
const workerModule = await mod("worker.js");

test("worker: an unknown /api route 404s and never reaches the asset layer", async () => {
  let assetCalls = 0;
  const env = makeEnv({ ASSETS: { fetch: async () => { assetCalls++; return new Response("asset"); } } });
  const res = await workerModule.default.fetch(req("/api/nope"), env, {});
  assert.equal(res.status, 404);
  assert.equal(assetCalls, 0);
});

test("worker: config-check reports presence only, never a value", async () => {
  const env = makeEnv();
  const body = await (await workerModule.default.fetch(req("/api/config-check"), env, {})).json();
  assert.equal(body.buttons_configured, true);
  assert.deepEqual(body.present, {
    GITHUB_TOKEN: true, GITHUB_REPO: true,
    BOX_CLIENT_ID: true, BOX_CLIENT_SECRET: true, BOX_RELAY_SECRET: true,
  });
  assert.ok(!JSON.stringify(body).includes("ghtoken"), "no secret value may be echoed");
});

test("worker: the Box OAuth callback rejects an unknown state", async () => {
  const env = makeEnv();
  const res = await workerModule.default.fetch(req("/api/box/callback?code=c&state=never-issued"), env, {});
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /box=error/);
});

test("worker: a Box authorize-url issues a single-use state", async () => {
  const { env, token } = await signedInEnv();
  const body = await (await workerModule.default.fetch(req("/api/box/authorize-url",
    { headers: { authorization: `Bearer ${token}` } }), env, {})).json();
  const state = new URL(body.url).searchParams.get("state");
  assert.ok(state, "a state parameter must be issued");
  assert.equal(await env.BOX_KV.get(`box:state:${state}`), "1");

  await withFetch(async () => okJson({ access_token: "a", refresh_token: "r", expires_in: 3600 }), async () => {
    const first = await workerModule.default.fetch(req(`/api/box/callback?code=c&state=${state}`), env, {});
    assert.match(first.headers.get("location"), /box=connected/);
    const replay = await workerModule.default.fetch(req(`/api/box/callback?code=c&state=${state}`), env, {});
    assert.match(replay.headers.get("location"), /box=error/, "a state must not be replayable");
  });
});

test("worker: non-/api requests fall through to the asset layer", async () => {
  let asked = null;
  const env = makeEnv({ ASSETS: { fetch: async (r) => { asked = r.url; return new Response("page"); } } });
  await workerModule.default.fetch(req("/mcm/index.html"), env, {});
  assert.match(asked, /\/mcm\/index\.html$/);
});

/* ==================================================================== stars_logic */
const logic = await mod("stars_logic.js");

test("stars_logic: similarity is a monotonic re-expression of distance", async () => {
  const identical = logic.distanceAndMatch([3, 3, 3], [3, 3, 3]);
  const far = logic.distanceAndMatch([1, 1, 1], [5, 5, 5]);
  assert.equal(identical.distance, 0);
  assert.equal(identical.similarity, 100);
  assert.equal(far.similarity, 0, "the maximum possible gap scores 0%");
  assert.ok(far.distance > identical.distance);
});

test("stars_logic: only positive, directional gaps are reported", async () => {
  const target = { vector: [4, 2, 5] };
  const source = { vector: [2, 4, 5] };
  const { rows } = logic.buildSkillGapRows(target, source, ["Mathematics", "Writing", "Speaking"]);
  assert.deepEqual(rows.map((r) => r[0]), ["Mathematics"], "a skill the source already exceeds is not a gap");
  assert.equal(rows[0][1], "50%");
  assert.ok(rows[0][2].length > 20, "each gap carries its coaching action");
});

test("stars_logic: escapeHtml covers every character it claims to", async () => {
  assert.equal(logic.escapeHtml(`<a href="x">Sheriff's & Co</a>`),
    "&lt;a href=&quot;x&quot;&gt;Sheriff&#x27;s &amp; Co&lt;/a&gt;");
});

test("stars_logic: currency and percent match Python's banker's rounding", async () => {
  assert.equal(logic.currency(null), "N/A");
  assert.equal(logic.pct(null), "N/A");
  assert.equal(logic.currency(50000), "$50,000");
  assert.equal(logic.pct(12.25), "12.2%", "an exact .5 tie rounds to even, as Python does");
  assert.equal(logic.pct(12.35), "12.3%");
  assert.equal(logic.currency(0.5), "$0", "round-half-to-even at zero digits");
  assert.equal(logic.currency(1.5), "$2");
});


/* ============================================================== apprenticeship */
const { handleApprenticeshipApi } = await mod("apprenticeship.js");

const appr = (route, request, env) => handleApprenticeshipApi(route, request, env);

/** A signed-in env with this app's Claude key present. */
async function apprEnv() {
  const { env, token } = await signedInEnv();
  env.apprenticeship_claude_api = "test-key";
  return { env, token };
}

/**
 * Stub the Anthropic API. `handler(toolName, requestBody)` returns the tool input to
 * hand back, so a test can decide per call what the evaluator "said".
 */
function claudeStub(handler) {
  return (url, init) => {
    assert.ok(url.startsWith("https://api.anthropic.com/"), `unexpected fetch to ${url}`);
    const body = JSON.parse(init.body);
    const tool = body.tools[0];
    return okJson({ content: [{ type: "tool_use", name: tool.name, input: handler(tool.name, body) }] });
  };
}

const evaluation = (over) => ({ responsive: true, score: 5, scoreReason: "fine", redirect: "", ...over });

/** improvements for however many sections the prompt described, in order. */
/**
 * The rewrite call is handed one id per outstanding question and must hand the same ids
 * back. Echoing them is what pins the checklist to the questions rather than to whatever
 * a model felt like writing.
 */
function improvementsFor(body) {
  const ids = [...body.messages[0].content.matchAll(/^\d+\. id: (.+)$/gm)].map((m) => m[1].trim());
  return { items: ids.map((id) => ({ id, text: `Rewritten action for ${id}` })) };
}

async function makeAssessment(env, token, sections, name = "Readiness") {
  const project = await (await appr("projects", jsonReq("/api/apprenticeship/projects", "POST",
    { name: "Project" }, token), env)).json();
  const res = await appr("surveys", jsonReq("/api/apprenticeship/surveys", "POST",
    { projectId: project.project.id, name, intro: "Welcome.", sections }, token), env);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return { projectId: project.project.id, survey: body.survey };
}

const ONE_SECTION = [{
  name: "Organizational Commitment",
  objective: "SECRET OBJECTIVE",
  context: "Some teaching context.",
  questions: [
    { text: "Who owns apprenticeship internally?", context: "Shown context.",
      type: "open", criteria: "SECRET CRITERIA", maxPoints: 5 },
  ],
}];

/** Register a respondent and return their bearer token. */
async function signUp(env, over = {}) {
  const res = await appr("account/signup", jsonReq("/api/apprenticeship/account/signup", "POST", {
    name: "Pat", company: "Acme", email: "pat@acme.test", password: "a-long-enough-pw", ...over,
  }), env);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body.token;
}

/** One respondent per env, created on first use, so each test reads like one person. */
const respondentTokens = new WeakMap();
async function respondent(env) {
  if (!respondentTokens.has(env)) respondentTokens.set(env, await signUp(env));
  return respondentTokens.get(env);
}

async function startResponse(env, surveyId, token) {
  const bearer = token || await respondent(env);
  const res = await appr("public/start",
    jsonReq("/api/apprenticeship/public/start", "POST", { surveyId }, bearer), env);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return body;
}

const answerReq = (surveyId, responseId, answer, token) =>
  jsonReq("/api/apprenticeship/public/answer", "POST", { surveyId, responseId, answer }, token);

/** Send one answer as the env's respondent (or as someone else, with an explicit token). */
async function postAnswer(env, surveyId, responseId, answer, token) {
  return appr("public/answer",
    answerReq(surveyId, responseId, answer, token || await respondent(env)), env);
}

test("apprenticeship: the public view never leaks objectives, criteria or point values", async () => {
  const { env, token } = await apprEnv();
  const { survey } = await makeAssessment(env, token, ONE_SECTION);
  const view = await (await appr(`public/${survey.id}`, req(`/api/apprenticeship/public/${survey.id}`), env)).json();
  const serialized = JSON.stringify(view);
  for (const secret of ["SECRET OBJECTIVE", "SECRET CRITERIA", "maxPoints", "criteria", "objective"]) {
    assert.ok(!serialized.includes(secret), `${secret} must not reach a respondent — it is the answer key`);
  }
});

test("apprenticeship: a question with no scoring criteria is rejected, not saved unscored", async () => {
  const { env, token } = await apprEnv();
  const project = await (await appr("projects", jsonReq("/api/apprenticeship/projects", "POST",
    { name: "Project" }, token), env)).json();
  const res = await appr("surveys", jsonReq("/api/apprenticeship/surveys", "POST", {
    projectId: project.project.id, name: "No criteria",
    sections: [{ name: "S", questions: [{ text: "Q?", type: "open", criteria: "" }] }],
  }, token), env);
  assert.equal(res.status, 400, "criteria is what keeps scoring consistent, so it is mandatory");
});

test("apprenticeship: an honest low score is never flagged and never trips the shut-off", async () => {
  const { env, token } = await apprEnv();
  const { survey } = await makeAssessment(env, token, ONE_SECTION);
  const started = await startResponse(env, survey.id);
  await withFetch(claudeStub((name, body) => name === "record_evaluation"
    ? evaluation({ score: 0, scoreReason: "Nothing in place." })
    : improvementsFor(body)), async () => {
    const res = await postAnswer(env, survey.id, started.responseId, "Honestly, nobody owns it yet.");
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.ok(body.done, "a one-question assessment finishes on the first answer");
    assert.equal(body.results.flaggedCount, 0, "a responsive answer is never flagged");
    assert.equal(body.results.contactPrompt, "", "no flags means no 'talk to Conexus' callout");
    assert.equal(body.results.overall.bandLabel, "Build Readiness First");
  });
  const stored = JSON.parse(await env.BOX_KV.get(`apprenticeship:response:${survey.id}:${started.responseId}`));
  assert.equal(stored.consecutiveNonResponsive, 0, "an honest answer must not advance the shut-off counter");
  assert.equal(stored.issues.length, 0, "an honest answer must not reach the issue log");
});

test("apprenticeship: a non-responsive answer is redirected once, then flagged with the full issue log", async () => {
  const { env, token } = await apprEnv();
  const { survey } = await makeAssessment(env, token, ONE_SECTION);
  const started = await startResponse(env, survey.id);
  await withFetch(claudeStub((name, body) => name === "record_evaluation"
    ? evaluation({ responsive: false, score: 0, scoreReason: "Off topic.",
                   redirect: "To put it another way — who signs off on it?" })
    : improvementsFor(body)), async () => {
    const first = await (await postAnswer(env, survey.id, started.responseId, "what's for lunch")).json();
    assert.ok(first.step.isFollowUp, "the first miss gets one redirect, not a flag");
    assert.equal(first.step.prompt, "To put it another way — who signs off on it?");

    const second = await (await postAnswer(env, survey.id, started.responseId, "still not answering")).json();
    assert.ok(second.done, "the second miss ends the question rather than badgering again");
    assert.equal(second.results.flaggedCount, 1);
    assert.match(second.results.contactPrompt, /Conexus Indiana staff/);
  });
  const stored = JSON.parse(await env.BOX_KV.get(`apprenticeship:response:${survey.id}:${started.responseId}`));
  assert.equal(stored.issues.length, 1);
  assert.deepEqual({
    originalQuestion: stored.issues[0].originalQuestion,
    originalResponse: stored.issues[0].originalResponse,
    followUpQuestion: stored.issues[0].followUpQuestion,
    followUpResponse: stored.issues[0].followUpResponse,
  }, {
    originalQuestion: "Who owns apprenticeship internally?",
    originalResponse: "what's for lunch",
    followUpQuestion: "To put it another way — who signs off on it?",
    followUpResponse: "still not answering",
  }, "the issue log has to carry all four halves or an admin cannot judge the exchange");
});

test("apprenticeship: three non-responsive questions in a row shut the assessment off", async () => {
  const { env, token } = await apprEnv();
  const questions = [1, 2, 3, 4].map((n) => ({
    text: `Q${n}?`, context: "", type: "open", criteria: "Anything concrete.", maxPoints: 5,
  }));
  const { survey } = await makeAssessment(env, token, [{ name: "S", objective: "o", context: "c", questions }]);
  const started = await startResponse(env, survey.id);
  await withFetch(claudeStub((name, body) => name === "record_evaluation"
    ? evaluation({ responsive: false, score: 0, scoreReason: "no", redirect: "Try again?" })
    : improvementsFor(body)), async () => {
    let last = null;
    // Two turns per question: the miss, then the miss on the redirect.
    for (let i = 0; i < 8; i++) {
      last = await (await postAnswer(env, survey.id, started.responseId, "no")).json();
      if (last.halted) break;
    }
    assert.ok(last.halted, "three consecutive non-responsive questions must stop the assessment");
    assert.match(last.message, /Conexus Indiana staff/);
    assert.ok(!last.results, "a halted assessment shows no readiness score");
  });
  const stored = JSON.parse(await env.BOX_KV.get(`apprenticeship:response:${survey.id}:${started.responseId}`));
  assert.equal(stored.status, "halted");
  assert.equal(stored.cursor, 3, "it halts on the third question, not after working through all four");
});

test("apprenticeship: a score above the question's maximum is clamped, not trusted", async () => {
  const { env, token } = await apprEnv();
  const { survey } = await makeAssessment(env, token, ONE_SECTION);
  const started = await startResponse(env, survey.id);
  await withFetch(claudeStub((name, body) => name === "record_evaluation"
    ? evaluation({ score: 99 }) : improvementsFor(body)), async () => {
    const body = await (await postAnswer(env, survey.id, started.responseId, "A real answer.")).json();
    assert.equal(body.results.overall.display, "5/5",
      "a strict schema constrains shape, not range — an out-of-range score would inflate the section");
    assert.equal(body.results.overall.percent, 100);
  });
});

test("apprenticeship: the readiness bands land exactly on 85 and 60", async () => {
  const { env, token } = await apprEnv();
  // Two questions worth 10 each, so a whole-number score can land exactly on a boundary.
  // MAX_POINTS_CEILING caps any single question at 10, so 85% needs two questions.
  const cases = [
    { scores: [10, 7], percent: 85, label: "Strong Readiness" },
    { scores: [10, 6], percent: 80, label: "Moderate Readiness" },
    { scores: [6, 6], percent: 60, label: "Moderate Readiness" },
    { scores: [6, 5], percent: 55, label: "Build Readiness First" },
  ];
  for (const testCase of cases) {
    const { survey } = await makeAssessment(env, token, [{
      name: "S", objective: "o", context: "c",
      questions: [
        { text: "Q1?", context: "", type: "open", criteria: "c", maxPoints: 10 },
        { text: "Q2?", context: "", type: "open", criteria: "c", maxPoints: 10 },
      ],
    }], `Band ${testCase.percent}`);
    const started = await startResponse(env, survey.id);
    const scores = testCase.scores.slice();
    await withFetch(claudeStub((name, body) => name === "record_evaluation"
      ? evaluation({ score: scores.shift() }) : improvementsFor(body)), async () => {
      await postAnswer(env, survey.id, started.responseId, "An answer.");
      const body = await (await postAnswer(env, survey.id, started.responseId, "Another answer.")).json();
      assert.equal(body.results.overall.percent, testCase.percent);
      assert.equal(body.results.overall.bandLabel, testCase.label,
        `${testCase.percent}% should be ${testCase.label}`);
    });
  }
});

test("apprenticeship: a response cannot be replayed against a different assessment", async () => {
  const { env, token } = await apprEnv();
  const a = await makeAssessment(env, token, ONE_SECTION, "A");
  const b = await makeAssessment(env, token, ONE_SECTION, "B");
  const started = await startResponse(env, a.survey.id);
  const res = await postAnswer(env, b.survey.id, started.responseId, "An answer.");
  assert.equal(res.status, 404, "the stored record's own surveyId is re-checked, so B cannot score A's run");
});

test("apprenticeship: a failed rewrite costs the wording, never the checklist", async () => {
  const { env, token } = await apprEnv();
  const { survey } = await makeAssessment(env, token, ONE_SECTION);
  const started = await startResponse(env, survey.id);
  await withFetch((url, init) => {
    const body = JSON.parse(init.body);
    if (body.tools[0].name === "record_items") return new Response("boom", { status: 500 });
    return okJson({ content: [{ type: "tool_use", name: "record_evaluation",
                                input: evaluation({ score: 4 }) }] });
  }, async () => {
    const res = await appr("public/answer",
      answerReq(survey.id, started.responseId, "An answer.", await respondent(env)), env);
    const body = await res.json();
    assert.equal(res.status, 200, "the scores are earned -- a failed rewrite must not lose them");
    assert.equal(body.results.overall.display, "4/5");
    // The checklist is decided in code from the answers, so losing the model only costs
    // the phrasing: the item is still there, as the question it came from.
    const items = body.results.sections[0].improvements;
    assert.equal(items.length, 1);
    assert.equal(items[0].text, "Who owns apprenticeship internally?");
    assert.equal(items[0].points, 1, "worth exactly what that question fell short by");
  });
});

test("apprenticeship: signing up needs name, company, a real email and a real password", async () => {
  const { env } = await apprEnv();
  const base = { name: "Pat", company: "Acme", email: "pat@acme.test", password: "a-long-enough-pw" };
  for (const over of [
    { name: "" }, { company: "" }, { email: "" }, { email: "not-an-email" }, { password: "short" },
  ]) {
    const res = await appr("account/signup",
      jsonReq("/api/apprenticeship/account/signup", "POST", { ...base, ...over }), env);
    assert.equal(res.status, 400, `should have been rejected: ${JSON.stringify(over)}`);
  }
});

test("apprenticeship: an email can only be registered once", async () => {
  const { env } = await apprEnv();
  await signUp(env);
  const res = await appr("account/signup", jsonReq("/api/apprenticeship/account/signup", "POST", {
    name: "Someone Else", company: "Other Co", email: "pat@acme.test", password: "another-long-pw",
  }), env);
  assert.equal(res.status, 409);
});

test("apprenticeship: signing in works, and a wrong password says nothing about the account", async () => {
  const { env } = await apprEnv();
  await signUp(env);
  const good = await appr("account/login", jsonReq("/api/apprenticeship/account/login", "POST",
    { email: "PAT@Acme.Test", password: "a-long-enough-pw" }), env);
  const goodBody = await good.json();
  assert.equal(good.status, 200, "the email is matched case-insensitively");
  assert.ok(goodBody.token);
  assert.ok(!JSON.stringify(goodBody).includes("passwordHash"), "no hash ever leaves the Worker");

  const wrongPassword = await appr("account/login", jsonReq("/api/apprenticeship/account/login",
    "POST", { email: "pat@acme.test", password: "not-the-password" }), env);
  const noSuchAccount = await appr("account/login", jsonReq("/api/apprenticeship/account/login",
    "POST", { email: "nobody@acme.test", password: "a-long-enough-pw" }), env);
  assert.equal(wrongPassword.status, 401);
  assert.equal(noSuchAccount.status, 401);
  // Different messages here would be an account-enumeration oracle: whether an address
  // is registered is exactly what the difference would tell you.
  assert.deepEqual(await wrongPassword.json(), await noSuchAccount.json());
});

test("apprenticeship: a respondent account is not an admin account, in either direction", async () => {
  const { env, token: adminToken } = await apprEnv();
  const respondentToken = await signUp(env);

  // The two systems sign with different secrets, so this fails at the signature check --
  // no payload a self-registering employer could obtain can satisfy an admin route.
  for (const path of ["projects", "surveys", "accounts"]) {
    const res = await appr(path, req(`/api/apprenticeship/${path}`,
      { headers: { authorization: `Bearer ${respondentToken}` } }), env);
    assert.equal(res.status, 401, `a respondent token must not open ${path}`);
  }
  const asAdmin = await appr("account/me",
    req("/api/apprenticeship/account/me", { headers: { authorization: `Bearer ${adminToken}` } }), env);
  assert.equal(asAdmin.status, 401, "and an admin token is not a respondent either");
});

test("apprenticeship: an assessment cannot be started or answered without signing in", async () => {
  const { env, token } = await apprEnv();
  const { survey } = await makeAssessment(env, token, ONE_SECTION);
  const started = await startResponse(env, survey.id);
  assert.equal((await appr("public/start",
    jsonReq("/api/apprenticeship/public/start", "POST", { surveyId: survey.id }), env)).status, 401);
  assert.equal((await appr("public/answer",
    answerReq(survey.id, started.responseId, "An answer."), env)).status, 401);
});

test("apprenticeship: one account cannot answer another account's assessment", async () => {
  const { env, token } = await apprEnv();
  const { survey } = await makeAssessment(env, token, ONE_SECTION);
  const started = await startResponse(env, survey.id);
  const intruder = await signUp(env, { email: "someone@else.test", company: "Else Co" });
  const res = await postAnswer(env, survey.id, started.responseId, "An answer.", intruder);
  assert.equal(res.status, 404,
    "a response id is hard to guess, which is not the same as checked -- without this an "
    + "intruder could change the score on someone else's dashboard");
});

test("apprenticeship: an unfinished assessment resumes instead of starting over", async () => {
  const { env, token } = await apprEnv();
  const { survey } = await makeAssessment(env, token, [{
    name: "S", objective: "o", context: "c",
    questions: [{ text: "Q1?", context: "", type: "open", criteria: "c", maxPoints: 5 },
                { text: "Q2?", context: "", type: "open", criteria: "c", maxPoints: 5 }],
  }]);
  const started = await startResponse(env, survey.id);
  await withFetch(claudeStub((name, body) => name === "record_evaluation"
    ? evaluation({ score: 4 }) : improvementsFor(body)), async () => {
    await postAnswer(env, survey.id, started.responseId, "An answer.");
  });
  const again = await startResponse(env, survey.id);
  assert.equal(again.responseId, started.responseId, "the same run is handed back");
  assert.equal(again.resumed, true);
  assert.equal(again.answered, 1);
  assert.equal(again.step.prompt, "Q2?", "and it picks up at the question they had reached");
});

test("apprenticeship: the dashboard combines a project, and withholds the total until it is finished", async () => {
  const { env, token } = await apprEnv();
  const respondentToken = await respondent(env);
  const first = await makeAssessment(env, token, ONE_SECTION, "One");
  // A two-step program, so the combined figure is due once both are done.
  await appr(`projects/${first.projectId}`,
    jsonReq(`/api/apprenticeship/projects/${first.projectId}`, "PUT",
      { name: "Project", stepCount: 2 }, token), env);
  const second = await (await appr("surveys", jsonReq("/api/apprenticeship/surveys", "POST", {
    projectId: first.projectId, name: "Two", step: 2, sections: ONE_SECTION,
  }, token), env)).json();

  const dash = () => appr("account/dashboard", req("/api/apprenticeship/account/dashboard",
    { headers: { authorization: `Bearer ${respondentToken}` } }), env).then((r) => r.json());

  const runOne = await startResponse(env, first.survey.id);
  await withFetch(claudeStub((name, body) => name === "record_evaluation"
    ? evaluation({ score: 4 }) : improvementsFor(body)), async () => {
    await postAnswer(env, first.survey.id, runOne.responseId, "An answer.");
  });

  const halfway = await dash();
  assert.equal(halfway.projects.length, 1);
  assert.equal(halfway.projects[0].assessments.length, 2, "the rest of the project is listed too");
  assert.equal(halfway.projects[0].completedCount, 1);
  assert.equal(halfway.projects[0].overall, null,
    "a combined readiness built from one assessment of two is not this employer's readiness");
  assert.deepEqual(halfway.projects[0].assessments.map((a) => a.status), ["complete", "not-started"]);

  const runTwo = await startResponse(env, second.survey.id);
  await withFetch(claudeStub((name, body) => name === "record_evaluation"
    ? evaluation({ score: 5 }) : improvementsFor(body)), async () => {
    await postAnswer(env, second.survey.id, runTwo.responseId, "Another answer.");
  });

  const finished = await dash();
  assert.equal(finished.projects[0].complete, true);
  assert.equal(finished.projects[0].overall.display, "9/10", "4 of 5 plus 5 of 5");
  assert.equal(finished.projects[0].overall.bandLabel, "Strong Readiness");
});

test("apprenticeship: an employer can pick a program, and only a real one", async () => {
  const { env, token } = await apprEnv();
  const respondentToken = await respondent(env);
  const ready = await makeAssessment(env, token, ONE_SECTION, "Step One");

  // A project with nothing built, and one an admin has closed. Neither is startable.
  const empty = await (await appr("projects", jsonReq("/api/apprenticeship/projects", "POST",
    { name: "Nothing built yet" }, token), env)).json();
  const closed = await makeAssessment(env, token, ONE_SECTION, "Draft step");
  await appr(`projects/${closed.projectId}`,
    jsonReq(`/api/apprenticeship/projects/${closed.projectId}`, "PUT",
      { name: "Still being written", openToRespondents: false }, token), env);

  const list = () => appr("account/projects", req("/api/apprenticeship/account/projects",
    { headers: { authorization: `Bearer ${respondentToken}` } }), env).then((r) => r.json());

  const offered = await list();
  assert.deepEqual(offered.projects.map((p) => p.id), [ready.projectId],
    "a program with no step built, and one an admin closed, are not on offer");
  assert.equal(offered.projects[0].joined, false);
  assert.equal(offered.projects[0].firstStepName, "Step One");
  assert.equal(offered.projects[0].stepCount, 3);

  // Joining puts it on the dashboard without starting anything.
  const dash = await (await appr(`account/projects/${ready.projectId}/join`,
    jsonReq(`/api/apprenticeship/account/projects/${ready.projectId}/join`, "POST", {},
      respondentToken), env)).json();
  assert.equal(dash.projects.length, 1, "a picked program shows up before any step is touched");
  assert.equal(dash.projects[0].assessments[0].status, "not-started");
  assert.equal((await list()).projects[0].joined, true, "and is no longer offered to join");

  // A closed program cannot be joined by asking for it directly, only hidden from the list.
  assert.equal((await appr(`account/projects/${closed.projectId}/join`,
    jsonReq(`/api/apprenticeship/account/projects/${closed.projectId}/join`, "POST", {},
      respondentToken), env)).status, 404);
  assert.equal((await appr(`account/projects/${empty.project.id}/join`,
    jsonReq(`/api/apprenticeship/account/projects/${empty.project.id}/join`, "POST", {},
      respondentToken), env)).status, 409);
});

test("apprenticeship: joining answers correctly even when KV's list hasn't caught up", async () => {
  const { env, token } = await apprEnv();
  const respondentToken = await respondent(env);
  const ready = await makeAssessment(env, token, ONE_SECTION, "Step One");

  // Workers KV is eventually consistent: a list() straight after a put() routinely does
  // not include the key just written. This stub makes that certain rather than occasional.
  // Joining used to write the membership key and then build the dashboard from a list in
  // the same request, so it came back with no programs at all and the page showed the
  // empty state to somebody who had just pressed Start.
  const realList = env.BOX_KV.list.bind(env.BOX_KV);
  const writtenThisRequest = new Set();
  env.BOX_KV.put = async function (key, value) {
    writtenThisRequest.add(key);
    this.store.set(key, String(value));
  };
  env.BOX_KV.list = async function (opts) {
    const out = await realList(opts);
    return { keys: out.keys.filter((k) => !writtenThisRequest.has(k.name)) };
  };

  const body = await (await appr(`account/projects/${ready.projectId}/join`,
    jsonReq(`/api/apprenticeship/account/projects/${ready.projectId}/join`, "POST", {},
      respondentToken), env)).json();

  assert.equal(body.projects.length, 1,
    "the program has to come back even though the membership key is not listable yet");
  assert.equal(body.projects[0].id, ready.projectId);
  // And the step to walk into is named outright, not dug out of the payload beside it.
  assert.equal(body.firstStep.surveyId, ready.survey.id);
  assert.equal(body.firstStep.kind, "chat");
  assert.equal(body.firstStep.step, 1);
});

test("apprenticeship: joining a program whose first step is a workforce step says so", async () => {
  const { env, token } = await apprEnv();
  const respondentToken = await respondent(env);
  const project = await (await appr("projects", jsonReq("/api/apprenticeship/projects", "POST",
    { name: "Workforce first", stepCount: 1 }, token), env)).json();
  const survey = await (await appr("surveys", jsonReq("/api/apprenticeship/surveys", "POST", {
    projectId: project.project.id, name: "Workforce Needs", kind: "workforce", step: 1,
    sections: [],
  }, token), env)).json();
  const body = await (await appr(`account/projects/${project.project.id}/join`,
    jsonReq(`/api/apprenticeship/account/projects/${project.project.id}/join`, "POST", {},
      respondentToken), env)).json();
  assert.equal(body.firstStep.kind, "workforce",
    "so the page opens the form rather than the chat");
  assert.equal(body.firstStep.surveyId, survey.survey.id);
});

test("apprenticeship: the program list needs an account", async () => {
  const { env, token } = await apprEnv();
  await makeAssessment(env, token, ONE_SECTION, "Step One");
  assert.equal((await appr("account/projects",
    req("/api/apprenticeship/account/projects"), env)).status, 401);
});

test("apprenticeship: a program shows a tab for every step, built or not", async () => {
  const { env, token } = await apprEnv();
  const respondentToken = await respondent(env);
  // Only step 1 exists; the project runs to three.
  const { survey, projectId } = await makeAssessment(env, token, [{
    name: "S", objective: "o", context: "",
    questions: [{ text: "Q1?", context: "", maxPoints: 10 },
                { text: "Q2?", context: "", maxPoints: 10 }],
  }], "Step One");
  const questions = survey.sections[0].questions;
  await appr(`surveys/${survey.id}`, jsonReq(`/api/apprenticeship/surveys/${survey.id}`, "PUT", {
    projectId, name: "Step One", step: 1, unlockThreshold: 85,
    sections: [{ id: survey.sections[0].id, name: "S", objective: "o", context: "",
      questions: questions.map((q) => ({ id: q.id, text: q.text, maxPoints: 10 })) }],
  }, token), env);

  // One yes and one no: 10 of 20, well short of the 85% gate.
  const started = await startResponse(env, survey.id);
  let items = [];
  await withFetch(claudeStub((name, body) => name === "record_evaluation"
    ? evaluation({}) : improvementsFor(body)), async () => {
    await postAnswer(env, survey.id, started.responseId, "yes");
    items = (await (await postAnswer(env, survey.id, started.responseId, "no")).json())
      .results.sections[0].improvements;
  });

  const dash = () => appr("account/dashboard", req("/api/apprenticeship/account/dashboard",
    { headers: { authorization: `Bearer ${respondentToken}` } }), env).then((r) => r.json());

  const before = (await dash()).projects[0];
  assert.equal(before.assessments.length, 3, "three steps, so three tabs");
  assert.deepEqual(before.assessments.map((a) => a.step), [1, 2, 3]);
  assert.deepEqual(before.assessments.map((a) => Boolean(a.placeholder)), [false, true, true]);
  assert.equal(before.assessments[1].locked, true, "50% is short of the 85% gate on step one");
  assert.equal(before.assessments[2].locked, true);
  assert.equal(before.overall, null,
    "a combined score must not appear while two of the three steps do not exist yet");

  // Ticking the outstanding item closes the shortfall, which opens step two -- and only
  // step two, because step three sits behind a step nobody has built.
  for (const item of items) {
    await appr("account/todo", jsonReq("/api/apprenticeship/account/todo", "POST",
      { surveyId: survey.id, itemId: item.id, done: true }, respondentToken), env);
  }
  const after = (await dash()).projects[0];
  assert.equal(after.assessments[1].locked, false, "step two opens");
  assert.equal(after.assessments[2].locked, true,
    "step three stays shut behind a step that does not exist yet");
});

test("apprenticeship: signing up claims the assessments that person finished before accounts existed", async () => {
  const { env, token } = await apprEnv();
  const { survey } = await makeAssessment(env, token, ONE_SECTION);
  // A response exactly as the tool stored one before it had accounts: an email, no owner.
  const orphanId = "legacy-response";
  await env.BOX_KV.put(`apprenticeship:response:${survey.id}:${orphanId}`, JSON.stringify({
    id: orphanId, surveyId: survey.id, projectId: survey.projectId, surveyName: survey.name,
    respondent: { name: "Pat", company: "Acme", email: "pat@acme.test" },
    status: "complete", cursor: 1, pending: null, consecutiveNonResponsive: 0,
    answers: [], issues: [],
    results: { sections: [], overall: { earned: 4, possible: 5, percent: 80, display: "4/5",
                                        band: "moderate", bandLabel: "Moderate Readiness" } },
    startedAt: "2026-01-01T00:00:00.000Z", submittedAt: "2026-01-01T00:10:00.000Z",
  }));

  const respondentToken = await signUp(env);
  const stored = JSON.parse(await env.BOX_KV.get(`apprenticeship:response:${survey.id}:${orphanId}`));
  assert.equal(stored.accountId, JSON.parse(await env.BOX_KV.get(
    `apprenticeship:account:${stored.accountId}`)).id, "the orphan now has an owner");

  const dashboard = await (await appr("account/dashboard",
    req("/api/apprenticeship/account/dashboard",
      { headers: { authorization: `Bearer ${respondentToken}` } }), env)).json();
  assert.equal(dashboard.projects[0].assessments[0].status, "complete",
    "work done before sign-up must not look like a blank slate");
});

test("apprenticeship: pre-question context is optional, and an empty box shows nothing", async () => {
  const { env, token } = await apprEnv();
  const { survey } = await makeAssessment(env, token, [{
    name: "S", objective: "o", context: "Section context.",
    questions: [
      // Left empty on purpose: context in front of "Do you have leadership support?"
      // telegraphs the answer the tool is hoping for, so that question is asked cold.
      { text: "Do you have leadership support?", context: "" },
      { text: "Q2?", context: "SHOWN PRE CONTEXT" },
    ],
  }]);
  const started = await startResponse(env, survey.id);
  assert.deepEqual(started.step.messages, ["Welcome.", "S", "Section context."],
    "the intro and the section's own context still show; the question's is simply absent");
  assert.equal(started.step.answerType, "yes_no", "questions are yes/no unless told otherwise");

  const next = await (await postAnswer(env, survey.id, started.responseId, "yes")).json();
  assert.ok(next.step.messages.includes("SHOWN PRE CONTEXT"));
});

test("apprenticeship: a yes/no question scores itself, with no model call", async () => {
  const { env, token } = await apprEnv();
  const sections = [{
    name: "S", objective: "o", context: "",
    questions: [{ text: "Do you have leadership support?", context: "", maxPoints: 1 }],
  }];

  // Answered yes: nothing is outstanding, so there is nothing to rewrite and the
  // assessment costs no API call at all.
  const yes = await makeAssessment(env, token, sections, "Said yes");
  const yesRun = await startResponse(env, yes.survey.id);
  await withFetch(() => { throw new Error("no API call should be made"); }, async () => {
    const body = await (await postAnswer(env, yes.survey.id, yesRun.responseId, "yes")).json();
    assert.equal(body.results.overall.percent, 100);
    assert.deepEqual(body.results.sections[0].improvements, [],
      "nothing to do, because they answered yes to everything");
  });

  // Answered no: one call, and it is the rewrite -- never a call to score the answer,
  // because the answer is the score.
  const no = await makeAssessment(env, token, sections, "Said no");
  const noRun = await startResponse(env, no.survey.id);
  let calls = 0;
  await withFetch((url, init) => {
    calls++;
    const tool = JSON.parse(init.body).tools[0];
    assert.equal(tool.name, "record_items", "a yes/no answer must not cost a scoring call");
    return okJson({ content: [{ type: "tool_use", name: tool.name,
                                input: improvementsFor(JSON.parse(init.body)) }] });
  }, async () => {
    const body = await (await postAnswer(env, no.survey.id, noRun.responseId, "no")).json();
    assert.equal(body.results.overall.percent, 0);
    assert.equal(body.results.sections[0].improvements.length, 1);
  });
  assert.equal(calls, 1);
});

test("apprenticeship: the checklist is exactly the questions they could not answer yes to", async () => {
  const { env, token } = await apprEnv();
  const { survey } = await makeAssessment(env, token, [{
    name: "S", objective: "o", context: "",
    questions: [1, 2, 3, 4, 5].map((n) => ({ text: `Question ${n}?`, context: "" })),
  }]);
  const started = await startResponse(env, survey.id);
  const answers = ["yes", "no", "yes", "no", "yes"];
  let asked = "";
  await withFetch((url, init) => {
    const body = JSON.parse(init.body);
    asked = body.messages[0].content;
    return okJson({ content: [{ type: "tool_use", name: "record_items", input: improvementsFor(body) }] });
  }, async () => {
    let last = null;
    for (const said of answers) {
      last = await (await postAnswer(env, survey.id, started.responseId, said)).json();
    }
    const items = last.results.sections[0].improvements;
    // Five questions, three answered yes: two to-dos, and they are the other two.
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((i) => i.questionId),
      [survey.sections[0].questions[1].id, survey.sections[0].questions[3].id]);
    assert.equal(last.results.overall.display, "3/5");
  });
  // The model is only handed the questions that fell short -- it never gets the chance to
  // invent an item for one they already answered yes to.
  assert.ok(asked.includes("Question 2?") && asked.includes("Question 4?"));
  for (const answered of ["Question 1?", "Question 3?", "Question 5?"]) {
    assert.ok(!asked.includes(answered), `${answered} was answered yes and must not be sent`);
  }
});

test("apprenticeship: admin wording for a to-do wins, and skips the model entirely", async () => {
  const { env, token } = await apprEnv();
  const { survey } = await makeAssessment(env, token, [{
    name: "S", objective: "o", context: "",
    questions: [{
      text: "Does your organization understand Indiana youth employment rules?",
      context: "",
      todoText: "Gain an understanding of Indiana youth employment rules.",
      resourceName: "Indiana youth employment guide",
      resourceUrl: "https://example.test/youth-rules",
    }],
  }]);
  const started = await startResponse(env, survey.id);
  await withFetch(() => { throw new Error("no API call should be made"); }, async () => {
    const body = await (await postAnswer(env, survey.id, started.responseId, "no")).json();
    const item = body.results.sections[0].improvements[0];
    assert.equal(item.text, "Gain an understanding of Indiana youth employment rules.");
    assert.equal(item.resourceName, "Indiana youth employment guide");
    assert.equal(item.resourceUrl, "https://example.test/youth-rules");
  });
});

test("apprenticeship: a resource link that isn't http is dropped, not rendered", async () => {
  const { env, token } = await apprEnv();
  const saved = await makeAssessment(env, token, [{
    name: "S", objective: "o", context: "",
    questions: [
      { text: "Q1?", context: "", resourceName: "Bad", resourceUrl: "javascript:alert(1)" },
      { text: "Q2?", context: "", resourceName: "Also bad", resourceUrl: "not a url at all" },
      { text: "Q3?", context: "", resourceName: "Fine", resourceUrl: "https://example.test/x" },
    ],
  }]);
  const urls = saved.survey.sections[0].questions.map((q) => q.resourceUrl);
  // This URL ends up in an href on a page an employer opens, so a javascript: link there
  // would run in their session.
  assert.deepEqual(urls, ["", "", "https://example.test/x"]);
});

test("apprenticeship: a yes/no question branches its follow-on context on the answer", async () => {
  const { env, token } = await apprEnv();
  const sections = [{
    name: "S", objective: "o", context: "",
    questions: [
      { text: "Do you have leadership support?", context: "",
        yesContext: "GOOD, HERE IS WHAT TO DO NEXT", noContext: "WHY LEADERSHIP MATTERS" },
      { text: "Q2?", context: "" },
    ],
  }];
  for (const [said, expected] of [["no", "WHY LEADERSHIP MATTERS"], ["yes", "GOOD, HERE IS WHAT TO DO NEXT"]]) {
    const { survey } = await makeAssessment(env, token, sections, `Branch ${said}`);
    const started = await startResponse(env, survey.id);
    const next = await (await postAnswer(env, survey.id, started.responseId, said)).json();
    assert.equal(next.step.messages[0], expected,
      "it leads, so it reads as a reply to what they just said");
  }
});

test("apprenticeship: either branch can be left empty, and that answer just moves on", async () => {
  const { env, token } = await apprEnv();
  const { survey } = await makeAssessment(env, token, [{
    name: "S", objective: "o", context: "",
    questions: [
      { text: "Do you have leadership support?", context: "", noContext: "ONLY ON NO" },
      { text: "Q2?", context: "" },
    ],
  }]);
  const started = await startResponse(env, survey.id);
  const next = await (await postAnswer(env, survey.id, started.responseId, "yes")).json();
  assert.deepEqual(next.step.messages, [], "a yes with no context of its own simply moves on");
  assert.equal(next.step.prompt, "Q2?");
});

test("apprenticeship: a yes/no question takes yes or no and nothing else", async () => {
  const { env, token } = await apprEnv();
  const { survey } = await makeAssessment(env, token, [{
    name: "S", objective: "o", context: "",
    questions: [{ text: "Do you have leadership support?", context: "" },
                { text: "Q2?", context: "" }],
  }]);
  const started = await startResponse(env, survey.id);
  const res = await postAnswer(env, survey.id, started.responseId, "sort of, it depends");
  assert.equal(res.status, 400, "there is nothing to interpret, so there is nothing to accept");
  // Case and spacing are not the respondent's problem.
  const ok = await (await postAnswer(env, survey.id, started.responseId, "  YES ")).json();
  assert.equal(ok.step.prompt, "Q2?");
  const stored = JSON.parse(await env.BOX_KV.get(
    `apprenticeship:response:${survey.id}:${started.responseId}`));
  assert.equal(stored.answers[0].answer, "Yes", "stored normalised, so the CSV reads the same");
});

test("apprenticeship: a yes/no question needs no scoring criteria, an open one still does", async () => {
  const { env, token } = await apprEnv();
  const project = await (await appr("projects", jsonReq("/api/apprenticeship/projects", "POST",
    { name: "Project" }, token), env)).json();
  const saved = await (await appr("surveys", jsonReq("/api/apprenticeship/surveys", "POST", {
    projectId: project.project.id, name: "Mixed",
    sections: [{ name: "S", questions: [
      { text: "Do you have leadership support?" },
      { text: "Tell us about it", type: "open" },
    ] }],
  }, token), env)).json();
  const questions = saved.survey.sections[0].questions;
  assert.equal(questions.length, 1, "the open question had no criteria, so it was dropped");
  assert.equal(questions[0].type, "yes_no");
  assert.equal(questions[0].criteria, "", "and a yes/no question carries none");
});

test("apprenticeship: a weak answer earns the post-answer context, a strong one moves on", async () => {
  const { env, token } = await apprEnv();
  const sections = [{
    name: "S", objective: "o", context: "",
    questions: [
      { text: "Do you have leadership support?", context: "", showPreContext: false,
        postContext: "WHY LEADERSHIP MATTERS", postContextMode: "weak", postContextBelow: 60,
        type: "open", criteria: "c", maxPoints: 5 },
      { text: "Q2?", context: "", type: "open", criteria: "c", maxPoints: 5 },
    ],
  }];

  // Answered no -- 0 of 5 -- so the education is shown, and it leads, reading as a reply
  // to what they just said rather than as preamble to the next question.
  const weak = await makeAssessment(env, token, sections, "Weak");
  const weakRun = await startResponse(env, weak.survey.id);
  await withFetch(claudeStub((name, body) => name === "record_evaluation"
    ? evaluation({ score: 0 }) : improvementsFor(body)), async () => {
    const next = await (await postAnswer(env, weak.survey.id, weakRun.responseId, "No.")).json();
    assert.equal(next.step.messages[0], "WHY LEADERSHIP MATTERS");
  });

  // Answered yes -- 5 of 5 -- so they are not made to sit through it.
  const strong = await makeAssessment(env, token, sections, "Strong");
  const strongRun = await startResponse(env, strong.survey.id);
  await withFetch(claudeStub((name, body) => name === "record_evaluation"
    ? evaluation({ score: 5 }) : improvementsFor(body)), async () => {
    const next = await (await postAnswer(env, strong.survey.id, strongRun.responseId, "Yes, fully.")).json();
    assert.ok(!next.step.messages.includes("WHY LEADERSHIP MATTERS"));
  });
});

test("apprenticeship: post-answer context can be set to always, or parked without deleting it", async () => {
  const { env, token } = await apprEnv();
  for (const [mode, expected] of [["always", true], ["never", false]]) {
    const { survey } = await makeAssessment(env, token, [{
      name: "S", objective: "o", context: "",
      questions: [
        { text: "Q1?", context: "", postContext: "ALWAYS TEXT", postContextMode: mode,
          type: "open", criteria: "c", maxPoints: 5 },
        { text: "Q2?", context: "", type: "open", criteria: "c", maxPoints: 5 },
      ],
    }], `Mode ${mode}`);
    const started = await startResponse(env, survey.id);
    await withFetch(claudeStub((name, body) => name === "record_evaluation"
      ? evaluation({ score: 5 }) : improvementsFor(body)), async () => {
      const next = await (await postAnswer(env, survey.id, started.responseId, "A full answer.")).json();
      assert.equal(next.step.messages.includes("ALWAYS TEXT"), expected,
        `mode ${mode} on a full-marks answer`);
    });
  }
});

test("apprenticeship: the last question's post-answer context rides along with the results", async () => {
  const { env, token } = await apprEnv();
  const { survey } = await makeAssessment(env, token, [{
    name: "S", objective: "o", context: "",
    questions: [{ text: "Q1?", context: "", postContext: "CLOSING LESSON",
                  postContextMode: "weak", postContextBelow: 60, type: "open", criteria: "c", maxPoints: 5 }],
  }]);
  const started = await startResponse(env, survey.id);
  await withFetch(claudeStub((name, body) => name === "record_evaluation"
    ? evaluation({ score: 1 }) : improvementsFor(body)), async () => {
    const body = await (await postAnswer(env, survey.id, started.responseId, "Barely.")).json();
    assert.ok(body.done);
    // There is no next question for it to precede, so it has to travel with the results
    // or be silently dropped on the one question most likely to need it.
    assert.equal(body.results.postContext, "CLOSING LESSON");
  });
});

test("apprenticeship: a pending follow-up does not trigger the post-answer context early", async () => {
  const { env, token } = await apprEnv();
  const { survey } = await makeAssessment(env, token, [{
    name: "S", objective: "o", context: "",
    questions: [{ text: "Q1?", context: "", postContext: "TOO SOON", postContextMode: "always",
                  type: "open", criteria: "c", maxPoints: 5 },
                { text: "Q2?", context: "", type: "open", criteria: "c", maxPoints: 5 }],
  }]);
  const started = await startResponse(env, survey.id);
  await withFetch(claudeStub((name, body) => name === "record_evaluation"
    ? evaluation({ responsive: false, score: 0, redirect: "Say more?" })
    : improvementsFor(body)), async () => {
    const first = await (await postAnswer(env, survey.id, started.responseId, "what?")).json();
    assert.equal(first.step.isFollowUp, true);
    assert.deepEqual(first.step.messages, [],
      "the question isn't finished, so there is no final answer for the context to react to");
  });
});

test("apprenticeship: the results come back as a to-do list with stable ids", async () => {
  const { env, token } = await apprEnv();
  const { survey } = await makeAssessment(env, token, ONE_SECTION);
  const started = await startResponse(env, survey.id);
  await withFetch(claudeStub((name, body) => name === "record_evaluation"
    ? evaluation({ score: 3 }) : improvementsFor(body)), async () => {
    const body = await (await postAnswer(env, survey.id, started.responseId, "An answer.")).json();
    const items = body.results.sections[0].improvements;
    assert.equal(items.length, 1, "one item per question that fell short, and one only");
    // The id is the question's own, so a ticked item still means the same item when they
    // come back to the dashboard days later -- and says which question it came from.
    assert.equal(items[0].id, `todo-${survey.sections[0].questions[0].id}`);
    assert.equal(items[0].questionId, survey.sections[0].questions[0].id);
    assert.equal(items[0].points, 2, "the 2 points that question fell short by, not the section's");
  });
});

test("apprenticeship: ticking a to-do restores exactly what that question lost", async () => {
  const { env, token } = await apprEnv();
  const respondentToken = await respondent(env);
  // Two questions worth 10 each. One answered yes, one no, so one to-do worth 10.
  const { survey } = await makeAssessment(env, token, [{
    name: "S", objective: "o", context: "",
    questions: [{ text: "Q1?", context: "", maxPoints: 10 },
                { text: "Q2?", context: "", maxPoints: 10 }],
  }]);
  const started = await startResponse(env, survey.id);
  let items = [];
  await withFetch(claudeStub((name, body) => name === "record_evaluation"
    ? evaluation({}) : improvementsFor(body)), async () => {
    await postAnswer(env, survey.id, started.responseId, "yes");
    const body = await (await postAnswer(env, survey.id, started.responseId, "no")).json();
    assert.equal(body.results.overall.percent, 50);
    items = body.results.sections[0].improvements;
  });
  assert.equal(items.length, 1);

  const tick = (itemId, done) => appr("account/todo",
    jsonReq("/api/apprenticeship/account/todo", "POST",
      { surveyId: survey.id, itemId, done }, respondentToken), env).then((r) => r.json());

  const after = await tick(items[0].id, true);
  assert.equal(after.projects[0].assessments[0].overall.percent, 100,
    "the one thing they fell short on, closed");
  assert.equal(after.projects[0].assessments[0].baseOverall.percent, 50,
    "what they scored answering is kept, not overwritten");

  const undone = await tick(items[0].id, false);
  assert.equal(undone.projects[0].assessments[0].overall.percent, 50, "unticking gives it back");
});

test("apprenticeship: the unlock gate is a percentage of the step's points, not points", async () => {
  const { env, token } = await apprEnv();
  const respondentToken = await respondent(env);
  // 20 points on offer and a gate of 85. If that were read as points, 17/20 would fail it;
  // as a percentage it is exactly 85% and passes.
  const stepOne = await makeAssessment(env, token, [{
    name: "S", objective: "o", context: "c",
    questions: [{ text: "Q1?", context: "", type: "open", criteria: "c", maxPoints: 10 },
                { text: "Q2?", context: "", type: "open", criteria: "c", maxPoints: 10 }],
  }], "Gate One");
  await appr(`surveys/${stepOne.survey.id}`,
    jsonReq(`/api/apprenticeship/surveys/${stepOne.survey.id}`, "PUT", {
      projectId: stepOne.projectId, name: "Gate One", step: 1, unlockThreshold: 85,
      sections: [{
        id: stepOne.survey.sections[0].id, name: "S", objective: "o", context: "c",
        questions: stepOne.survey.sections[0].questions.map((q) => ({
          id: q.id, text: q.text, type: "open", criteria: "c", maxPoints: 10 })),
      }],
    }, token), env);
  const stepTwo = await (await appr("surveys", jsonReq("/api/apprenticeship/surveys", "POST", {
    projectId: stepOne.projectId, name: "Gate Two", step: 2, sections: ONE_SECTION,
  }, token), env)).json();

  const started = await startResponse(env, stepOne.survey.id);
  const scores = [10, 7];
  await withFetch(claudeStub((name, body) => name === "record_evaluation"
    ? evaluation({ score: scores.shift() }) : improvementsFor(body)), async () => {
    await postAnswer(env, stepOne.survey.id, started.responseId, "An answer.");
    await postAnswer(env, stepOne.survey.id, started.responseId, "Another answer.");
  });

  const dashboard = await (await appr("account/dashboard",
    req("/api/apprenticeship/account/dashboard",
      { headers: { authorization: `Bearer ${respondentToken}` } }), env)).json();
  assert.equal(dashboard.projects[0].assessments[0].overall.percent, 85, "17 of 20");
  assert.equal(dashboard.projects[0].assessments[1].locked, false,
    "85 points would have failed a 17/20 score; 85 per cent passes it exactly");
  assert.equal((await appr("public/start", jsonReq("/api/apprenticeship/public/start", "POST",
    { surveyId: stepTwo.survey.id }, respondentToken), env)).status, 200);
});

test("apprenticeship: a to-do id that is not on this account's list is refused", async () => {
  const { env, token } = await apprEnv();
  const respondentToken = await respondent(env);
  const { survey } = await makeAssessment(env, token, ONE_SECTION);
  const started = await startResponse(env, survey.id);
  await withFetch(claudeStub((name, body) => name === "record_evaluation"
    ? evaluation({ score: 1 }) : improvementsFor(body)), async () => {
    await postAnswer(env, survey.id, started.responseId, "An answer.");
  });
  // Credit is a fraction of ticked items, so an unchecked id written into the map would
  // inflate the score past anything the list allows.
  const res = await appr("account/todo", jsonReq("/api/apprenticeship/account/todo", "POST",
    { surveyId: survey.id, itemId: "made-up-item", done: true }, respondentToken), env);
  assert.equal(res.status, 404);
});

test("apprenticeship: step two stays locked until step one reaches its threshold", async () => {
  const { env, token } = await apprEnv();
  const respondentToken = await respondent(env);
  const stepOne = await makeAssessment(env, token, [{
    name: "S", objective: "o", context: "c",
    questions: [{ text: "Q?", context: "", type: "open", criteria: "c", maxPoints: 10 }],
  }], "Step One");
  await appr(`surveys/${stepOne.survey.id}`,
    jsonReq(`/api/apprenticeship/surveys/${stepOne.survey.id}`, "PUT", {
      projectId: stepOne.projectId, name: "Step One", step: 1, unlockThreshold: 85,
      sections: [{ id: stepOne.survey.sections[0].id, name: "S", objective: "o", context: "c",
        questions: [{ id: stepOne.survey.sections[0].questions[0].id, text: "Q?",
                      type: "open", criteria: "c", maxPoints: 10 }] }],
    }, token), env);
  const stepTwo = await (await appr("surveys", jsonReq("/api/apprenticeship/surveys", "POST", {
    projectId: stepOne.projectId, name: "Step Two", step: 2, sections: ONE_SECTION,
  }, token), env)).json();

  const started = await startResponse(env, stepOne.survey.id);
  let items = [];
  await withFetch(claudeStub((name, body) => name === "record_evaluation"
    ? evaluation({ score: 6 }) : improvementsFor(body)), async () => {
    items = (await (await postAnswer(env, stepOne.survey.id, started.responseId, "An answer.")).json())
      .results.sections[0].improvements;
  });

  const dash = () => appr("account/dashboard", req("/api/apprenticeship/account/dashboard",
    { headers: { authorization: `Bearer ${respondentToken}` } }), env).then((r) => r.json());

  const locked = (await dash()).projects[0].assessments[1];
  assert.equal(locked.locked, true, "60% is short of the 85% gate");
  assert.equal(locked.lockedBy, "Step One");
  assert.equal(locked.lockedUntil, 85);

  // A locked step is refused, not merely greyed out -- the link to it is just a URL.
  const refused = await appr("public/start", jsonReq("/api/apprenticeship/public/start", "POST",
    { surveyId: stepTwo.survey.id }, respondentToken), env);
  assert.equal(refused.status, 409);
  assert.match((await refused.json()).error, /Step One/);

  // Ticking both items closes the 4-point shortfall: 10/10, past the gate.
  for (const item of items) {
    await appr("account/todo", jsonReq("/api/apprenticeship/account/todo", "POST",
      { surveyId: stepOne.survey.id, itemId: item.id, done: true }, respondentToken), env);
  }
  const opened = (await dash()).projects[0].assessments[1];
  assert.equal(opened.locked, false, "the to-do list is a second route to the same threshold");
  assert.equal((await appr("public/start", jsonReq("/api/apprenticeship/public/start", "POST",
    { surveyId: stepTwo.survey.id }, respondentToken), env)).status, 200);
});

test("apprenticeship: a threshold of zero gates nothing", async () => {
  const { env, token } = await apprEnv();
  const respondentToken = await respondent(env);
  const first = await makeAssessment(env, token, ONE_SECTION, "Open One");
  const second = await (await appr("surveys", jsonReq("/api/apprenticeship/surveys", "POST", {
    projectId: first.projectId, name: "Open Two", step: 2, sections: ONE_SECTION,
  }, token), env)).json();
  // Not even started: a threshold of zero means the next step is not gated on this one
  // at all, which is also what keeps every assessment built before thresholds existed open.
  const started = await startResponse(env, first.survey.id);
  assert.equal((await appr("public/start", jsonReq("/api/apprenticeship/public/start", "POST",
    { surveyId: second.survey.id }, respondentToken), env)).status, 200,
    "step one is unfinished, but it gates nothing");
  await withFetch(claudeStub((name, body) => name === "record_evaluation"
    ? evaluation({ score: 0 }) : improvementsFor(body)), async () => {
    await postAnswer(env, first.survey.id, started.responseId, "Nothing in place.");
  });
  assert.equal((await appr("public/start", jsonReq("/api/apprenticeship/public/start", "POST",
    { surveyId: second.survey.id }, respondentToken), env)).status, 200,
    "and 0% scored still gates nothing");
});

test("apprenticeship: the admin account list never carries a password hash or salt", async () => {
  const { env, token } = await apprEnv();
  await signUp(env);
  const body = await (await appr("accounts", req("/api/apprenticeship/accounts",
    { headers: { authorization: `Bearer ${token}` } }), env)).json();
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].email, "pat@acme.test");
  const serialized = JSON.stringify(body);
  for (const secret of ["passwordHash", "passwordSalt"]) {
    assert.ok(!serialized.includes(secret), `${secret} must never leave the Worker`);
  }
});

test("apprenticeship: the issue log and dashboard are admin-only", async () => {
  const { env, token } = await apprEnv();
  const { survey } = await makeAssessment(env, token, ONE_SECTION);
  for (const path of [`surveys/${survey.id}/issues`, `surveys/${survey.id}/dashboard`,
                      `surveys/${survey.id}/responses`, "projects", "surveys"]) {
    const res = await appr(path, req(`/api/apprenticeship/${path}`), env);
    assert.equal(res.status, 401, `${path} must not be readable without signing in`);
  }
});

test("apprenticeship: editing keeps question ids, and a duplicate id is not allowed to collide", async () => {
  const { env, token } = await apprEnv();
  const { projectId, survey } = await makeAssessment(env, token, ONE_SECTION);
  const originalId = survey.sections[0].questions[0].id;

  // An ordinary edit round-trips the ids -- minting new ones here would orphan every
  // answer already collected against the old ones.
  const edited = await (await appr(`surveys/${survey.id}`,
    jsonReq(`/api/apprenticeship/surveys/${survey.id}`, "PUT", {
      projectId, name: "Readiness", sections: [{
        ...ONE_SECTION[0], id: survey.sections[0].id,
        questions: [{ ...ONE_SECTION[0].questions[0], id: originalId, text: "Reworded?" }],
      }],
    }, token), env)).json();
  assert.equal(edited.survey.sections[0].questions[0].id, originalId, "an edit must keep the id");

  // Two questions claiming the same id would share one score slot.
  const collided = await (await appr(`surveys/${survey.id}`,
    jsonReq(`/api/apprenticeship/surveys/${survey.id}`, "PUT", {
      projectId, name: "Readiness", sections: [{
        ...ONE_SECTION[0], id: survey.sections[0].id,
        questions: [
          { text: "A?", type: "open", criteria: "c", maxPoints: 5, id: "same" },
          { text: "B?", type: "open", criteria: "c", maxPoints: 5, id: "same" },
        ],
      }],
    }, token), env)).json();
  const ids = collided.survey.sections[0].questions.map((q) => q.id);
  assert.notEqual(ids[0], ids[1], "a duplicate id must be replaced, not accepted");
});

test("apprenticeship: a project with assessments still in it is not deleted out from under them", async () => {
  const { env, token } = await apprEnv();
  const { projectId } = await makeAssessment(env, token, ONE_SECTION);
  const res = await appr(`projects/${projectId}`,
    req(`/api/apprenticeship/projects/${projectId}`, { method: "DELETE",
      headers: { authorization: `Bearer ${token}` } }), env);
  assert.equal(res.status, 409, "deleting the project would silently take every response with it");
});


/* =============================================== apprenticeship: workforce (step 2) */
const workforce = await mod("apprenticeship_workforce.js");

const WF_ROLES = [
  { name: "CNC Machinist", headcount: 12, avgYearsExperience: 14, vacancies: 2,
    retirementEligible5y: 4, anticipatedNewRoles3y: 1, hiringDifficulty: "high",
    skillsGaps: ["Blueprint reading", "GD&T"], atRiskSkills: ["Setting up the old Mazak"] },
  { name: "Maintenance Tech", headcount: 5, avgYearsExperience: 6, vacancies: 1,
    retirementEligible5y: 1, anticipatedNewRoles3y: 0, hiringDifficulty: "medium",
    skillsGaps: ["blueprint reading", "PLC troubleshooting"], atRiskSkills: ["Line history"] },
];

/** Create a workforce step, unlocked, in its own project. */
async function makeWorkforce(env, token, over = {}) {
  const project = await (await appr("projects", jsonReq("/api/apprenticeship/projects", "POST",
    { name: "Project", stepCount: 1 }, token), env)).json();
  const res = await appr("surveys", jsonReq("/api/apprenticeship/surveys", "POST", {
    projectId: project.project.id, name: "Workforce Needs", kind: "workforce",
    step: 1, sections: [], ...over,
  }, token), env);
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  return { projectId: project.project.id, survey: body.survey };
}

const wfReq = (surveyId, sub, method, body, token) =>
  jsonReq(`/api/apprenticeship/workforce/${surveyId}${sub}`, method, body, token);

test("workforce: a workforce step saves without questions, and keeps none", async () => {
  const { env, token } = await apprEnv();
  const { survey } = await makeWorkforce(env, token);
  assert.equal(survey.kind, "workforce");
  assert.deepEqual(survey.sections, [], "there are no questions to write for this kind");
  // The chat start route must not open it -- it is a form on its own page.
  const res = await appr("public/start", jsonReq("/api/apprenticeship/public/start", "POST",
    { surveyId: survey.id }, await respondent(env)), env);
  assert.equal(res.status, 409);
});

test("workforce: the gap is vacancies now, plus three fifths then all of the retirements", async () => {
  const { env, token } = await apprEnv();
  const respondentToken = await respondent(env);
  const { survey } = await makeWorkforce(env, token);
  const saved = await (await appr(`workforce/${survey.id}/roles`,
    wfReq(survey.id, "/roles", "PUT", { roles: WF_ROLES }, respondentToken), env)).json();
  assert.equal(saved.doc.roles.length, 2);

  const { summary } = await (await appr(`workforce/${survey.id}/summary`,
    req(`/api/apprenticeship/workforce/${survey.id}/summary`,
      { headers: { authorization: `Bearer ${respondentToken}` } }), env)).json();

  assert.equal(summary.workforce.headcount, 17);
  // Weighted by headcount, not a flat average of 14 and 6: (12*14 + 5*6) / 17.
  assert.equal(summary.workforce.avgYearsExperience, 11.6);
  assert.equal(summary.gap.now, 3, "two vacancies plus one");
  // Rounded per role -- 4 * 3/5 = 2.4 -> 2, and 1 * 3/5 = 0.6 -> 1 -- so the by-role table
  // adds up to the headline instead of drifting from it.
  assert.equal(summary.retirement.eligible3y, 3);
  assert.equal(summary.gap.threeYear, 6);
  assert.equal(summary.gap.fiveYear, 8, "three vacancies plus all five retirements");
  // Collected but deliberately not folded into the formula the employer gave.
  assert.equal(summary.gap.anticipatedNewRoles3y, 1);
});

test("workforce: the top skills gaps count roles, not spellings", async () => {
  const { env, token } = await apprEnv();
  const respondentToken = await respondent(env);
  const { survey } = await makeWorkforce(env, token);
  await appr(`workforce/${survey.id}/roles`,
    wfReq(survey.id, "/roles", "PUT", { roles: WF_ROLES }, respondentToken), env);
  const { summary } = await (await appr(`workforce/${survey.id}/summary`,
    req(`/api/apprenticeship/workforce/${survey.id}/summary`,
      { headers: { authorization: `Bearer ${respondentToken}` } }), env)).json();
  // "Blueprint reading" and "blueprint reading" are one gap named by two roles.
  assert.equal(summary.workforce.topSkillsGaps[0].text, "Blueprint reading");
  assert.equal(summary.workforce.topSkillsGaps[0].count, 2);
  assert.equal(summary.workforce.topSkillsGaps.length, 3, "three named gaps in total");
});

test("workforce: an apprentice qualifies in year three, and only qualified ones fill the gap", async () => {
  const roles = [{ id: "r1", name: "CNC", headcount: 10, avgYearsExperience: 10,
    vacancies: 4, retirementEligible5y: 5, anticipatedNewRoles3y: 0,
    hiringDifficulty: "high", skillsGaps: [], atRiskSkills: [] }];
  const summary = workforce.summarise(roles.map((r) => workforce.cleanRole(r)));
  const plan = workforce.cleanPlan({ [summary.roles[0].id]: [2, 1, 0, 0, 0] }, summary.roles);
  const projection = workforce.projectApprentices(summary, plan);

  assert.deepEqual(projection.timeline.map((y) => y.qualified), [0, 0, 2, 3, 3],
    "a year-1 start is on staff in year 3; a year-2 start in year 4");
  assert.deepEqual(projection.timeline.map((y) => y.inTraining), [2, 3, 1, 0, 0]);
  assert.equal(projection.mentorsNeeded, 2, "one mentor per one to two apprentices, at the peak");

  // The five-year gap is 4 vacancies + 5 retirements = 9; three have qualified by year 5.
  assert.equal(projection.coverage.fiveYear.gap, 9);
  assert.equal(projection.coverage.fiveYear.filled, 3);
  assert.equal(projection.coverage.fiveYear.remaining, 6);
  // At year 3 only the year-1 cohort has qualified; the year-2 cohort is still training and
  // must not be counted as filling anything.
  assert.equal(projection.coverage.threeYear.filled, 2);
  assert.equal(projection.coverage.threeYear.inTraining, 1);
});

test("workforce: more apprentices than vacancies is growth, not 140% coverage", async () => {
  const roles = [workforce.cleanRole({ id: "r1", name: "CNC", headcount: 4, vacancies: 2,
    retirementEligible5y: 0 })];
  const summary = workforce.summarise(roles);
  const projection = workforce.projectApprentices(summary,
    workforce.cleanPlan({ [summary.roles[0].id]: [6, 0, 0, 0, 0] }, summary.roles));
  assert.equal(projection.coverage.fiveYear.qualified, 6);
  assert.equal(projection.coverage.fiveYear.filled, 2, "counted only as far as the gap goes");
  assert.equal(projection.coverage.fiveYear.percent, 100);
  assert.equal(projection.coverage.fiveYear.remaining, 0);
});

test("workforce: submitting marks the step complete and satisfies its gate", async () => {
  const { env, token } = await apprEnv();
  const respondentToken = await respondent(env);
  const { survey, projectId } = await makeWorkforce(env, token,
    { name: "Workforce Needs", step: 1, unlockThreshold: 85 });
  // A second step behind it, to prove "finished" reads as "passed" for an unscored step.
  const stepTwo = await (await appr("surveys", jsonReq("/api/apprenticeship/surveys", "POST", {
    projectId, name: "Step Two", step: 2, sections: ONE_SECTION,
  }, token), env)).json();

  await appr(`workforce/${survey.id}/roles`,
    wfReq(survey.id, "/roles", "PUT", { roles: WF_ROLES }, respondentToken), env);
  const dashBefore = await (await appr("account/dashboard",
    req("/api/apprenticeship/account/dashboard",
      { headers: { authorization: `Bearer ${respondentToken}` } }), env)).json();
  assert.equal(dashBefore.projects[0].assessments[1].locked, true, "nothing finished yet");

  const done = await (await appr(`workforce/${survey.id}/submit`,
    wfReq(survey.id, "/submit", "POST", {}, respondentToken), env)).json();
  assert.equal(done.summary.gap.fiveYear, 8);

  const dash = await (await appr("account/dashboard",
    req("/api/apprenticeship/account/dashboard",
      { headers: { authorization: `Bearer ${respondentToken}` } }), env)).json();
  const step = dash.projects[0].assessments[0];
  assert.equal(step.status, "complete");
  assert.equal(step.scored, false, "there is nothing to score, so no percentage is claimed");
  assert.equal(step.overall.display, "Complete");
  assert.equal(step.workforce.summary.gap.fiveYear, 8, "the gap rides along for the tab");
  assert.equal(dash.projects[0].assessments[1].locked, false,
    "finishing an unscored step is what passing its gate means");
});

test("workforce: a locked step is refused, not merely greyed out", async () => {
  const { env, token } = await apprEnv();
  const respondentToken = await respondent(env);
  const first = await makeAssessment(env, token, ONE_SECTION, "Step One");
  await appr(`surveys/${first.survey.id}`,
    jsonReq(`/api/apprenticeship/surveys/${first.survey.id}`, "PUT", {
      projectId: first.projectId, name: "Step One", step: 1, unlockThreshold: 85,
      sections: [{ id: first.survey.sections[0].id, ...ONE_SECTION[0],
        questions: [{ id: first.survey.sections[0].questions[0].id, ...ONE_SECTION[0].questions[0] }] }],
    }, token), env);
  const second = await (await appr("surveys", jsonReq("/api/apprenticeship/surveys", "POST", {
    projectId: first.projectId, name: "Workforce", kind: "workforce", step: 2, sections: [],
  }, token), env)).json();

  const res = await appr(`workforce/${second.survey.id}`,
    req(`/api/apprenticeship/workforce/${second.survey.id}`,
      { headers: { authorization: `Bearer ${respondentToken}` } }), env);
  assert.equal(res.status, 409, "the link to any step is just a URL");
  assert.match((await res.json()).error, /Step One/);
});

test("workforce: one account cannot read another's roles", async () => {
  const { env, token } = await apprEnv();
  const mine = await respondent(env);
  const { survey } = await makeWorkforce(env, token);
  await appr(`workforce/${survey.id}/roles`,
    wfReq(survey.id, "/roles", "PUT", { roles: WF_ROLES }, mine), env);

  const intruder = await signUp(env, { email: "someone@else.test", company: "Else Co" });
  const theirs = await (await appr(`workforce/${survey.id}`,
    req(`/api/apprenticeship/workforce/${survey.id}`,
      { headers: { authorization: `Bearer ${intruder}` } }), env)).json();
  assert.deepEqual(theirs.doc.roles, [],
    "the document is keyed by account, so a second employer starts from a blank sheet");
  assert.equal((await appr(`workforce/${survey.id}`,
    req(`/api/apprenticeship/workforce/${survey.id}`), env)).status, 401,
    "and it is not readable at all without signing in");
});

test("workforce: junk in the role form cannot become junk in the totals", async () => {
  const { env, token } = await apprEnv();
  const respondentToken = await respondent(env);
  const { survey } = await makeWorkforce(env, token);
  const saved = await (await appr(`workforce/${survey.id}/roles`,
    wfReq(survey.id, "/roles", "PUT", {
      roles: [
        { name: "  Spacing  ", headcount: "12.6", avgYearsExperience: -4,
          vacancies: "not a number", retirementEligible5y: 1e9,
          hiringDifficulty: "catastrophic",
          skillsGaps: ["Welding", "welding", "  ", "Welding"] },
        { name: "", headcount: 5 },
      ],
    }, respondentToken), env)).json();
  const role = saved.doc.roles[0];
  assert.equal(saved.doc.roles.length, 1, "a role with no name is not a role");
  assert.equal(role.name, "Spacing");
  assert.equal(role.headcount, 13, "rounded to whole people");
  assert.equal(role.avgYearsExperience, 0, "negative experience is zero, not NaN downstream");
  assert.equal(role.vacancies, 0);
  assert.equal(role.retirementEligible5y, 100000, "capped rather than trusted");
  assert.equal(role.hiringDifficulty, "medium", "an unknown difficulty falls back");
  assert.deepEqual(role.skillsGaps, ["Welding"], "deduplicated case-insensitively");
});

/* ================================================================== partner_intel */
const { handlePartnerIntelApi, parseCsv, applyRosterCsv, runScheduledScan, runSummariesAhead, questionWindow, looksLikeMatch,
  AHEAD_PROGRAMS, SUMMARY_BOX_FILE, councilText, historyFileName } = await mod("partner_intel.js");
const pi = (route, request, env) => handlePartnerIntelApi(route, request, env);
const piReq = (route, method, body, token) => jsonReq(`/api/partner-intel/${route}`, method, body, token);
const piGet = (route, token) => req(`/api/partner-intel/${route}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
const relay = (route, method, body, secret = "relay-secret") => req(`/api/partner-intel/relay/${route}`, {
  method, headers: { "content-type": "application/json", "x-pipeline-key": secret },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const isoAgo = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };

let insightSeq = 0;
function ins(over = {}) {
  insightSeq++;
  return {
    id: `i${insightSeq}`, kind: "problem", company_id: "c-a", company_raw: "Acme", speaker: "", title: `Issue ${insightSeq}`,
    detail: "Some detail.", quote: "A quote from the notes.", topic: "talent_pipeline", tags: [], urgency: "medium",
    urgency_reason: "Active.", status: "open", solves: "", confidence: "high", scope: "partner", date: isoAgo(5),
    date_source: "text", event_type: "Workshop", series: "Workshop", meeting_key: `k${insightSeq}`, review: [],
    sources: [{ id: "f1", name: "notes.docx", path: "Notes" }], ...over,
  };
}
const TOPICS = [
  { id: "talent_pipeline", label: "Talent pipeline and recruiting", keywords: "" },
  { id: "quality", label: "Quality systems and inspection", keywords: "" },
  { id: "ai_adoption", label: "AI adoption and governance", keywords: "" },
  { id: "other", label: "Other", keywords: "" },
];
const PARTNERS = [
  { id: "c-a", name: "Acme Corp", industry: "Plastics Company", status: "Active", program: "", participationId: "P1", contacts: ["Ann A"], aliases: [] },
  { id: "c-b", name: "Beta Works", industry: "Metals", status: "Active", program: "", participationId: "P2", contacts: ["Bob B"], aliases: [] },
  { id: "c-c", name: "Gamma Labs", industry: "Technology/Services", status: "Inactive", program: "", participationId: "P3", contacts: [], aliases: [] },
];

async function piEnv(insights = [], extra = {}) {
  const { env, token } = await signedInEnv();
  Object.assign(env, extra);
  await env.BOX_KV.put("pi:roster", JSON.stringify({ partners: PARTNERS.map((p) => ({ ...p })), aliases: {}, staff: [], updatedAt: "r1" }));
  const res = await pi("relay/publish", relay("publish", "POST", {
    version: `v${insightSeq}`, generated_at: "2026-10-07T00:00:00+00:00", roster_updated_at: "r1",
    topics: TOPICS, events: [], insights, companies: [], unmatched: [], stats: {},
  }), env);
  assert.equal(res.status, 200, "publish should succeed");
  return { env, token };
}
const getJson = async (route, env, token) => (await pi(route.split("?")[0], piGet(route, token), env)).json();

test("partner_intel: the pipeline relay refuses a wrong or missing shared secret", async () => {
  const env = makeEnv();
  for (const route of ["config", "roster", "state"]) {
    assert.equal((await pi(`relay/${route}`, relay(route, "GET", undefined, "wrong"), env)).status, 401, route);
  }
  assert.equal((await pi("relay/publish", relay("publish", "POST", { insights: [] }, ""), env)).status, 401);
});

test("partner_intel: every staff route refuses an anonymous caller, whatever the app-visibility tier", async () => {
  const { env } = await piEnv([ins()]);
  await env.BOX_KV.put("beta:app-visibility", JSON.stringify({ "partner-intel": "public" }));
  const gets = ["status", "settings", "home", "insights", "companies", "company?id=c-a", "roster", "review", "topics",
    "recent-questions", "run-status", "box/folders"];
  for (const route of gets) assert.equal((await pi(route.split("?")[0], piGet(route), env)).status, 401, route);
  const posts = ["ask", "run", "settings", "roster/import", "roster/partner", "roster/partner/delete", "roster/staff",
    "roster/alias", "review/map", "review/add", "topics/override"];
  for (const route of posts) assert.equal((await pi(route, piReq(route, "POST", {}), env)).status, 401, route);
});

test("partner_intel: parseCsv handles quoted commas, doubled quotes, embedded newlines, CRLF and a BOM", () => {
  const rows = parseCsv('﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n\r\n1,2,3');
  assert.deepEqual(rows, [["a", "b", "c"], ["x, y", 'say "hi"', "line1\nline2"], ["1", "2", "3"]]);
});

const SF_HEADER = '"Programs & Councils: Programs & Councils Name","Participation: Participation Name","Organization: Account Name","Organization: Industry","Status","Primary Contact","Secondary Contact"';
const sf = (...rows) => [SF_HEADER, ...rows.map((r) => r.map((c) => `"${c}"`).join(","))].join("\n");

test("partner_intel: a full-list import deactivates departed partners, adds new, reactivates returning, and never deletes", () => {
  const roster = { partners: [
    { id: "c-a", name: "Acme Corp", industry: "Plastics", status: "Active", program: "", participationId: "P1", contacts: [], aliases: [] },
    { id: "c-gone", name: "Leaving Inc", industry: "Metals", status: "Active", program: "", participationId: "P2", contacts: [], aliases: [] },
    { id: "c-back", name: "Returning Co", industry: "Metals", status: "Inactive", program: "", participationId: "P3", contacts: [], aliases: [] },
    { id: "c-vendor", name: "Hand Added Vendor", industry: "", status: "Non-member", program: "", participationId: "", contacts: [], aliases: [] },
  ], aliases: {}, staff: [] };
  const csv = sf(["Council", "P1", "Acme Corp", "Plastics Company", "Active", "Ann A", ""],
    ["Council", "P3", "Returning Co", "Metals", "Active", "Rita R", ""],
    ["Council", "P9", "Brand New LLC", "Furniture", "Active", "Nina N", "Oscar O"]);
  const { partners, summary } = applyRosterCsv(roster, csv, "replace");
  const byName = Object.fromEntries(partners.map((p) => [p.name, p]));
  assert.equal(partners.length, 5, "nobody is deleted");
  assert.equal(byName["Leaving Inc"].status, "Inactive");
  assert.equal(byName["Returning Co"].status, "Active");
  assert.equal(byName["Hand Added Vendor"].status, "Non-member", "hand-added non-members are not touched by a member export");
  assert.equal(byName["Brand New LLC"].id, "c-brand-new-llc");
  assert.deepEqual(byName["Brand New LLC"].contacts, ["Nina N", "Oscar O"]);
  assert.deepEqual(summary.deactivated, ["Leaving Inc"]);
  assert.deepEqual(summary.added, ["Brand New LLC"]);
  assert.deepEqual(summary.reactivated, ["Returning Co"]);
  const merged = applyRosterCsv(roster, csv, "merge");
  assert.equal(merged.partners.find((p) => p.name === "Leaving Inc").status, "Active", "merge never deactivates");
});

test("partner_intel: a renamed partner is matched by participation id and keeps its history", () => {
  const roster = { partners: [{ id: "c-old", name: "Old Name", industry: "", status: "Active", program: "", participationId: "P1", contacts: [], aliases: [] }], aliases: {}, staff: [] };
  const { partners, summary } = applyRosterCsv(roster, sf(["C", "P1", "New Name Inc", "Metals", "Active", "", ""]), "replace");
  assert.equal(partners.length, 1);
  assert.equal(partners[0].id, "c-old", "same id, so every old note still points at it");
  assert.equal(partners[0].name, "New Name Inc");
  assert.deepEqual(summary.updated, ["New Name Inc"]);
});

test("partner_intel: a file with no organization column is refused with a reason", () => {
  assert.match(applyRosterCsv({ partners: [], aliases: {}, staff: [] }, "foo,bar\n1,2", "replace").error, /organi[sz]ation column/i);
});

test("partner_intel: an import preview saves nothing", async () => {
  const { env, token } = await piEnv([ins()]);
  const before = await env.BOX_KV.get("pi:roster");
  const res = await pi("roster/import", piReq("roster/import", "POST",
    { csv: sf(["C", "P9", "Brand New LLC", "Furniture", "Active", "", ""]), mode: "replace", preview: true }, token), env);
  const body = await res.json();
  assert.equal(body.preview, true);
  assert.deepEqual(body.summary.added, ["Brand New LLC"]);
  assert.equal(await env.BOX_KV.get("pi:roster"), before);
});

test("partner_intel: an alias named __proto__ is stored as data, not lost to the prototype", async () => {
  const { env, token } = await piEnv([ins()]);
  const res = await pi("roster/alias", piReq("roster/alias", "POST", { alias: "__proto__", companyId: "c-a" }, token), env);
  assert.equal(res.status, 200);
  const roster = JSON.parse(await env.BOX_KV.get("pi:roster"));
  assert.ok(Object.keys(roster.aliases).includes("__proto__"), "the alias must survive the round trip");
  assert.equal(({}).constructor, Object, "and the global prototype is untouched");
});

test("partner_intel: adding a partner twice, or one with no name, is refused", async () => {
  const { env, token } = await piEnv([ins()]);
  const add = (body) => pi("roster/partner", piReq("roster/partner", "POST", body, token), env);
  assert.equal((await add({ name: "  " })).status, 400);
  assert.equal((await add({ name: "acme corp" })).status, 409, "case-insensitive duplicate");
  assert.equal((await add({ name: "Delta Tools", industry: "Metals", status: "Weird" })).status, 200);
  const roster = JSON.parse(await env.BOX_KV.get("pi:roster"));
  assert.equal(roster.partners.find((p) => p.name === "Delta Tools").status, "Active", "an unknown status falls back");
});

test("partner_intel: pipeline state round-trips across several shards and sheds old shards", async () => {
  const env = makeEnv();
  const registry = {}, cache = {};
  for (let i = 0; i < 700; i++) cache[`k${i}`] = { rows: [{ detail: "x".repeat(4000) + i }] };
  for (let i = 0; i < 5; i++) registry[`f${i}`] = { name: `n${i}`, units: [] };
  assert.equal((await pi("relay/state", relay("state", "POST", { registry, cache }), env)).status, 200);
  const meta = JSON.parse(await env.BOX_KV.get("pi:state:meta"));
  assert.ok(meta.pages.cache >= 2, `expected several pages, got ${meta.pages.cache}`);
  const back = await (await pi("relay/state", relay("state", "GET"), env)).json();
  assert.equal(Object.keys(back.cache).length, 700);
  assert.equal(back.cache.k699.rows[0].detail, "x".repeat(4000) + 699);
  await pi("relay/state", relay("state", "POST", { registry, cache: { k0: cache.k0 } }), env);
  assert.equal(await env.BOX_KV.get(`pi:state:w:${meta.write}:cache:${meta.pages.cache - 1}`), null,
    "the previous state's pages are deleted once the new one is committed");
  assert.equal(Object.keys((await (await pi("relay/state", relay("state", "GET"), env)).json()).cache).length, 1);
});

test("partner_intel: Trending Topics keeps to the window and leaves out Conexus-internal rows", async () => {
  const { env, token } = await piEnv([
    ins({ title: "recent", topic: "quality", date: isoAgo(3) }),
    ins({ title: "inside 30", topic: "quality", date: isoAgo(29) }),
    ins({ title: "inside 90 only", topic: "quality", date: isoAgo(70) }),
    ins({ title: "too old", topic: "quality", date: isoAgo(200) }),
    ins({ title: "board talk", topic: "quality", date: isoAgo(2), scope: "internal" }),
  ]);
  const mentions = async (days) => (await getJson(`home?days=${days}`, env, token)).trending.map((t) => [t.topic, t.mentions]);
  assert.deepEqual(await mentions(30), [["quality", 2]]);
  assert.deepEqual(await mentions(90), [["quality", 3]]);
});

test("partner_intel: Home has no urgent-problems list any more, only a high-urgency count on each topic", async () => {
  const { env, token } = await piEnv([
    ins({ topic: "quality", urgency: "high" }), ins({ topic: "quality", urgency: "medium" }), ins({ topic: "quality", urgency: "low" }),
  ]);
  const home = await getJson("home?days=30", env, token);
  assert.equal("urgent" in home, false, "the urgent list was removed from Home");
  assert.equal("shared" in home, false);
  assert.equal(home.trending[0].highUrgency, 1);
  assert.equal(home.counts.issues, 3);
});

test("partner_intel: trending topics rank by distinct companies, then distinct meetings, and leave out 'other'", async () => {
  const { env, token } = await piEnv([
    ...Array.from({ length: 5 }, () => ins({ topic: "quality", company_id: "c-a" })),   // one company, one meeting, five rows
    ins({ topic: "talent_pipeline", company_id: "c-a" }), ins({ topic: "talent_pipeline", company_id: "c-b" }),
    ins({ topic: "ai_adoption", company_id: "c-a" }), ins({ topic: "ai_adoption", company_id: "" }),
    ins({ topic: "other", company_id: "c-a" }), ins({ topic: "other", company_id: "c-b" }),
  ]);
  const home = await getJson("home?days=30", env, token);
  assert.deepEqual(home.trending.map((g) => [g.topic, g.companyCount, g.meetingCount]),
    [["talent_pipeline", 2, 2], ["ai_adoption", 1, 2], ["quality", 1, 1]],
    "two companies outrank one; of the rest, two meetings outrank five rows from one meeting; 'other' is not ranked");
  assert.equal(home.uncategorized, 2);
});

const row = (over) => ins({ date: isoAgo(5), ...over });
const longMeeting = (id, n, over = {}) => Array.from({ length: n }, (_, k) => row({ meeting_id: id, meeting_label: id, title: `${id} point ${k}`, ...over }));

test("partner_intel: one long meeting with dozens of notes does not outweigh several short ones", async () => {
  // The reported bug: long, detailed meetings (API Alliance, Aegis) produced the most rows, so they drove the ranking.
  const { env, token } = await piEnv([
    ...longMeeting("long-aegis", 40, { topic: "quality", company_id: "c-a" }),                      // 1 company, 1 meeting, 40 rows
    row({ topic: "talent_pipeline", company_id: "c-b", meeting_id: "m1", meeting_label: "m1" }),     // 1 company, 2 meetings, 2 rows
    row({ topic: "talent_pipeline", company_id: "c-b", meeting_id: "m2", meeting_label: "m2", date: isoAgo(9) }),
    row({ topic: "ai_adoption", company_id: "c-b", meeting_id: "m3", meeting_label: "m3" }),         // 2 companies, 2 meetings, 2 rows
    row({ topic: "ai_adoption", company_id: "c-c", meeting_id: "m4", meeting_label: "m4" }),
  ]);
  const home = await getJson("home?days=30", env, token);
  assert.deepEqual(home.trending.map((g) => [g.topic, g.companyCount, g.meetingCount, g.mentions]),
    [["ai_adoption", 2, 2, 2], ["talent_pipeline", 1, 2, 2], ["quality", 1, 1, 40]],
    "the 40-row meeting is last: it is one company in one meeting");
});

test("partner_intel: high urgency counts the meetings that called a topic urgent, not the rows", async () => {
  const { env, token } = await piEnv([
    ...longMeeting("m-long", 10, { topic: "quality", company_id: "c-a", urgency: "high" }),
    row({ topic: "quality", company_id: "c-b", meeting_id: "m-b", urgency: "high" }),
    row({ topic: "quality", company_id: "c-b", meeting_id: "m-c", urgency: "medium", date: isoAgo(8) }),
  ]);
  const quality = (await getJson("home?days=30", env, token)).trending[0];
  assert.deepEqual([quality.highUrgency, quality.meetingCount, quality.mentions], [2, 3, 12], "eleven high rows, but two meetings");
});

test("partner_intel: summaries hear every company and meeting before any one meeting twice", async () => {
  const rows = [
    ...longMeeting("long-api", 30, { topic: "quality", company_id: "c-a", urgency: "high" }),
    row({ topic: "quality", company_id: "c-b", meeting_id: "b1", meeting_label: "b1", title: "from b" }),
    row({ topic: "quality", company_id: "c-c", meeting_id: "c1", meeting_label: "c1", title: "from c" }),
  ];
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  let sent;
  await withFetch((url, init) => { sent = topicsIn(init).payload[0]; return summaryOut([sent], (t) => ({ topic_id: t.topic_id,
    bullets: [{ text: "Point.", evidence_ids: [t.evidence[0].id] }] })); },
  () => pi("summarize", piReq("summarize", "POST", { days: 30, topics: ["quality"] }, token), env));
  const byMeeting = {};
  for (const e of sent.evidence) byMeeting[e.meeting] = (byMeeting[e.meeting] || 0) + 1;
  assert.equal(byMeeting["long-api"], 3, "the 30-row meeting gives three rows at most");
  assert.equal(byMeeting.b1, 1);
  assert.equal(byMeeting.c1, 1, "and the other companies are in the evidence even though they said less");
  assert.equal(sent.evidence.length, 5);
  assert.deepEqual([sent.companies_in_topic, sent.meetings_in_topic], [3, 3], "the model is told the true breadth, not the row count");
  assert.equal("mentions_in_topic" in sent, false);
});

test("partner_intel: the summary prompt tells the model never to judge breadth by rows", async () => {
  const { env, token } = await piEnv(trendingRows(), { partner_intel_claude_api: "k" });
  let system = "";
  await withFetch((url, init) => { const t = topicsIn(init); system = t.body.system; return summaryOut(t.payload, (x) => ({ topic_id: x.topic_id,
    bullets: [{ text: "P.", evidence_ids: [x.evidence[0].id] }] })); },
  () => pi("summarize", piReq("summarize", "POST", { days: 30, topics: ["quality"] }, token), env));
  assert.match(system, /NEVER by the number of rows/);
  assert.match(system, /one voice/);
});

test("partner_intel: Ask scores a company on its best row from each meeting, not on several rows from one", async () => {
  const mk = (company, meeting, n) => Array.from({ length: n }, (_, k) => ins({ kind: "solution", urgency: "none", company_id: company,
    meeting_id: meeting, meeting_label: meeting, title: "Camera quality inspection", detail: "Machine vision quality inspection.",
    topic: "quality", tags: ["inspection"], date: isoAgo(5), id: `${meeting}-${k}` }));
  const { env, token } = await piEnv([...mk("c-a", "long-a", 6), ...mk("c-b", "short-b", 1)]);
  const body = await (await pi("ask", piReq("ask", "POST", { question: "Who has quality inspection with machine vision?" }, token), env)).json();
  const evidence = Object.fromEntries(body.matches.map((m) => [m.company.id, m.evidence.length]));
  assert.deepEqual(Object.keys(evidence).sort(), ["c-a", "c-b"]);
  const { shortlist } = await mod("partner_intel.js");
  const data = JSON.parse(JSON.stringify({ insights: [...mk("c-a", "long-a", 6), ...mk("c-b", "short-b", 1)] }));
  const short = shortlist("Who has quality inspection with machine vision?", data,
    { get: () => null }, {}, new Map([["quality", "Quality"]]), 10, null);
  const scores = Object.fromEntries(short.companies.map((c) => [c.id, c.score]));
  assert.ok(Math.abs(scores["c-a"] - scores["c-b"]) < 1e-9, `six rows from one meeting must score like one row (${scores["c-a"]} vs ${scores["c-b"]})`);
});

test("partner_intel: the Home dashboard counts what the notes hold, and follows the source and member choices but not the window", async () => {
  const { env, token } = await piEnv([
    ins({ kind: "problem", company_id: "c-a", date: isoAgo(3), sources: [{ id: "1", name: "a", path: "Raw Notes/CIAIC" }], meeting_id: "m1", meeting_label: "m1" }),
    ins({ kind: "ask", company_id: "c-a", date: isoAgo(3), sources: [{ id: "1", name: "a", path: "Raw Notes/CIAIC" }], meeting_id: "m1", meeting_label: "m1" }),
    ins({ kind: "solution", company_id: "c-b", date: isoAgo(400), sources: [{ id: "2", name: "b", path: "Raw Notes/ADAPT" }], meeting_id: "m2", meeting_label: "m2" }),
    ins({ kind: "win", company_id: "c-c", date: isoAgo(2), sources: [{ id: "3", name: "c", path: "Raw Notes/ADAPT" }], meeting_id: "m3", meeting_label: "m3" }),
    ins({ kind: "news", company_id: "", date: isoAgo(1), sources: [{ id: "4", name: "d", path: "Raw Notes/CIAIC" }], meeting_id: "m4", meeting_label: "m4" }),
    ins({ kind: "problem", company_id: "c-a", date: isoAgo(1), scope: "internal", sources: [{ id: "5", name: "e", path: "Raw Notes/Board Meetings" }], meeting_id: "m5", meeting_label: "m5" }),
  ]);
  const d = (q = "") => getJson(`home?days=30${q}`, env, token).then((r) => r.dashboard);
  const all = await d();
  assert.deepEqual([all.insights, all.issues, all.solutions, all.wins, all.other], [5, 2, 1, 1, 1], "the 400-day-old row is counted: the bar is the whole dataset; internal rows are not");
  assert.deepEqual([all.partners, all.members, all.meetings, all.programs], [3, 2, 4, 2], "Gamma Labs is a partner but, being Inactive, not a member");
  assert.equal(all.last, isoAgo(1));
  assert.equal((await d("&days=90")).insights, 5, "the window does not change it");
  const ciaic = await d("&source=CIAIC");
  assert.deepEqual([ciaic.insights, ciaic.issues, ciaic.partners], [3, 2, 1]);
  const members = await d("&status=Active");
  assert.deepEqual([members.insights, members.partners, members.members], [3, 2, 2], "Members only drops Gamma Labs' win and the note that names no company");
  assert.equal((await d("&source=Board%20Meetings")).insights, 1, "naming Board Meetings includes its internal row");
});

test("partner_intel: only number 1 cues, by dipping its chevron; no dots and no pulse", () => {
  const dir = path.join(path.dirname(SRC), "public", "partner-intel");
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  const css = fs.readFileSync(path.join(dir, "pi.css"), "utf8");
  assert.match(html, /'<i class="tline' \+ \(n === 1 && !open \? " cue" : ""\) \+ '" aria-hidden="true"><\/i>'/);
  assert.doesNotMatch(html, /<b><\/b><b><\/b><b><\/b>/, "the dotted trail is gone");
  assert.match(css, /\.pi-app \.tline\.cue::after \{ animation:chevron-cue 1s ease-in-out 1\.2s 2; \}/);
  assert.doesNotMatch(css, /\.tline b|circ-cue/);
});

test("partner_intel: the tabs run Home, Companies, Programs, Ask, with no Explore, and the app name goes Home", () => {
  const html = fs.readFileSync(path.join(path.dirname(SRC), "public", "partner-intel", "index.html"), "utf8");
  const nav = [...html.slice(html.indexOf('id="nav"'), html.indexOf("</nav>")).matchAll(/data-r="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(nav, ["home", "companies", "programs", "ask"]);
  assert.doesNotMatch(html, /explore/i, "the Explore page and its route are gone");
  assert.match(html, /<a class="appname" href="#\/home">Partner Intelligence<\/a>/);
  assert.match(html, /<script src="\/partner-intel\/askbox\.js"><\/script>/, "the Ask box loads on the app's pages");
});

test("partner_intel: the staff pages show no urgency and say issue, not open issue or problem", () => {
  const dir = path.join(path.dirname(SRC), "public", "partner-intel");
  for (const file of ["index.html", "pi.js", "askbox.js", "pi.css", "control-panel/index.html"]) {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    // Only text a person reads: drop comments, then look at string literals and markup.
    const shown = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/<!--[\s\S]*?-->/g, "");
    assert.doesNotMatch(shown, /urgen|u-high|u-medium/i, `${file} has no urgency pill, border, filter, sort or note`);
    assert.doesNotMatch(shown, /open (issue|problem)/i, `${file} says "issue", not "open issue"`);
    assert.doesNotMatch(shown, /["'>][^"'<]*\bProblems?\b[^"'<]*["'<]/, `${file} shows "Issue", not "Problem"`);
  }
});

test("partner_intel: BUG a wide table (companies, meetings, control panel) made the whole page scroll sideways on a phone", () => {
  const css = fs.readFileSync(path.join(path.dirname(SRC), "public", "partner-intel", "pi.css"), "utf8");
  const phone = [...css.matchAll(/@media \(max-width:(\d+)px\)\s*\{([^{}]*\{[^}]*\})*\s*\}/g)]
    .filter((m) => Number(m[1]) >= 600).map((m) => m[0]).join("\n");
  assert.match(phone, /table[^{]*\{[^}]*display:block[^}]*overflow-x:auto/, "on a phone a table scrolls inside its own area");
});

test("partner_intel: the Trending topics page opens on the last 90 days", async () => {
  const { env, token } = await piEnv([ins({ date: isoAgo(80) })]);
  const home = await getJson("home", env, token);
  assert.equal(home.days, 90, "no window asked for means 90 days");
  assert.equal(home.trending.length, 1, "a note from 80 days ago is in the default window");
  const html = fs.readFileSync(path.join(path.dirname(SRC), "public", "partner-intel", "index.html"), "utf8");
  assert.match(html, /var state = \{ days: 90,/, "the page asks for 90 days when it loads");
});

test("admin: BUG signing in from a deep link landed on the admin hub, not the page you were going to", () => {
  // Every protected page sent you to /admin/login.html with no record of where you came from, and the login
  // page always went on to /admin/index.html. Pages now pass ?next=, and the login page follows it, but
  // only to a page on this site.
  const pub = path.join(path.dirname(SRC), "public");
  // Sign-in is the home page; /admin/login.html forwards there with its query.
  const html = fs.readFileSync(path.join(pub, "index.html"), "utf8");
  const start = html.indexOf("  function nextPage() {");
  assert.ok(start > 0, "the login page has nextPage()");
  const src = html.slice(start, html.indexOf("\n  }\n", start) + 4);
  const at = (search) => new Function("window", "URL", "URLSearchParams", src + "; return nextPage();")(
    { location: { search, origin: "https://connector.example" } }, URL, URLSearchParams);
  const q = (next) => "?next=" + encodeURIComponent(next);
  assert.equal(at(q("/partner-intel/")), "/partner-intel/", "back to the page you came from");
  assert.equal(at(q("/partner-intel/#/company/c-a/meetings")), "/partner-intel/#/company/c-a/meetings", "with its route");
  assert.equal(at(q("/inm/index.html?map=3")), "/inm/index.html?map=3", "and its query");
  assert.equal(at(""), "/admin/index.html", "no next: the hub, as before");
  for (const bad of ["https://evil.example/", "//evil.example/", "/\t/evil.example/", "/\\evil.example/", "javascript:alert(1)", "/admin/login.html?next=/x", "/", "/?next=/x"]) {
    assert.equal(at(q(bad)), "/admin/index.html", "refused: " + JSON.stringify(bad));
  }
  // Every page that sends you to sign in says where you were.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
  const stubs = new Set([path.join(pub, "index.html"), path.join(pub, "beta", "login.html"), path.join(pub, "admin", "login.html")]);
  let senders = 0;
  for (const f of walk(pub).filter((f) => /\.(html|js)$/.test(f) && !stubs.has(f))) {
    for (const line of fs.readFileSync(f, "utf8").split("\n")) {
      if (!/location\.(href|replace)/.test(line) || !line.includes("/admin/login.html")) continue;
      senders++;
      assert.ok(line.includes("/admin/login.html?next="), path.relative(pub, f) + " sends you to sign in without ?next=: " + line.trim());
    }
  }
  assert.ok(senders >= 20, "the check found the login redirects (" + senders + ")");
});

test("repo: BUG the Cloudflare Worker build failed installing Python packages it never uses", () => {
  // Workers Builds installs Python dependencies whenever it finds a Python project file at the repo root.
  // On Python 3.14 rapidfuzz 3.10.1 has no wheel, its source build failed, and the Worker never deployed.
  // The Worker has no Python, so the pipelines' requirements live off the root.
  const repo = path.dirname(SRC);
  for (const f of ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py"]) {
    assert.ok(!fs.existsSync(path.join(repo, f)), f + " must not sit at the repo root");
  }
  const flows = path.join(repo, ".github", "workflows");
  for (const f of fs.readdirSync(flows)) {
    const yml = fs.readFileSync(path.join(flows, f), "utf8");
    for (const m of yml.matchAll(/pip install -r (\S+)/g)) {
      assert.ok(fs.existsSync(path.join(repo, m[1])), f + " installs " + m[1] + ", which must exist");
    }
    // BUG that followed: actions/setup-python with cache: pip looks for a root requirements.txt unless told
    // where the list is, so moving the file failed every pipeline at its setup step ("No file matched").
    if (/cache: pip/.test(yml)) {
      const dep = /cache-dependency-path: (\S+)/.exec(yml);
      assert.ok(dep, f + " caches pip, so it must name cache-dependency-path");
      assert.ok(fs.existsSync(path.join(repo, dep[1])), f + " cache-dependency-path " + dep[1] + " must exist");
    }
  }
});

test("partner_intel: BUG a stray + left after removing a line broke every page; each inline script must parse", () => {
  // Removing the "Showing the latest meetings" line left "</table>" + : ..., a syntax error that stopped the
  // whole staff app from loading. Parse every inline script in the app, the control panel and pi.js.
  const root = path.join(path.dirname(SRC), "public", "partner-intel");
  const pages = ["index.html", path.join("control-panel", "index.html")];
  for (const page of pages) {
    const html = fs.readFileSync(path.join(root, page), "utf8");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length, page + " has an inline script");
    scripts.forEach((code, n) => assert.doesNotThrow(() => new Function(code), page + " script " + n + " parses"));
  }
  assert.doesNotThrow(() => new Function(fs.readFileSync(path.join(root, "pi.js"), "utf8")), "pi.js parses");
});

test("mcm: BUG narrative points showed raw ** markers and a stray leading period", () => {
  // The function is taken from the page itself, between its marker comments.
  const html = fs.readFileSync(path.join(path.dirname(SRC), "public", "mcm", "index.html"), "utf8");
  const src = html.slice(html.indexOf("/* bulletHtml:start"), html.indexOf("/* bulletHtml:end"));
  const esc = (v) => String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const bulletHtml = new Function("esc", src + "; return bulletHtml;")(esc);
  assert.equal(bulletHtml(". **Tariff relief drove the sharpest improvement**: balance rose 15.5 points"),
    "<b>Tariff relief drove the sharpest improvement</b>: balance rose 15.5 points", "the stored quarter-over-quarter point");
  assert.equal(bulletHtml(". Demand and orders flipped positive"), "Demand and orders flipped positive", "the stored year-over-year point");
  assert.equal(bulletHtml("-0.33 balance, down"), "-0.33 balance, down", "a leading minus sign is kept");
  assert.equal(bulletHtml("Plain point."), "Plain point.");
  assert.equal(bulletHtml("**<img src=x>** risk"), "<b>&lt;img src=x&gt;</b> risk", "text is escaped before the bold is added");
  assert.equal(bulletHtml("unclosed ** marker"), "unclosed  marker", "a lone marker is dropped, not shown");
});

test("partner_intel: a topic merge applies to the ranking, and a merge loop is refused", async () => {
  const { env, token } = await piEnv([
    ins({ topic: "quality", company_id: "c-a" }), ins({ topic: "ai_adoption", company_id: "c-b" }),
  ]);
  const ranked = async () => (await getJson("home?days=30", env, token)).trending.map((g) => [g.topic, g.companyCount]);
  assert.deepEqual(await ranked(), [["ai_adoption", 1], ["quality", 1]]);
  const merge = (id, mergeInto) => pi("topics/override", piReq("topics/override", "POST", { id, mergeInto }, token), env);
  assert.equal((await merge("ai_adoption", "quality")).status, 200);
  assert.deepEqual(await ranked(), [["quality", 2]]);
  assert.equal((await merge("quality", "ai_adoption")).status, 400, "a loop is refused when it is saved");
  assert.deepEqual(await ranked(), [["quality", 2]], "and the earlier merge still holds");
  assert.equal((await merge("talent_pipeline", "ai_adoption")).status, 400, "no chains either: ai_adoption is merged away");
  await env.BOX_KV.put("pi:topics", JSON.stringify({ overrides: { quality: { mergeInto: "ai_adoption" }, ai_adoption: { mergeInto: "quality" } } }));
  assert.equal((await pi("home", piGet("home?days=30", token), env)).status, 200, "a hand-edited loop in KV cannot hang a read");
  assert.equal((await merge("quality", "quality")).status, 400);
  assert.equal((await merge("other", "quality")).status, 400);
});

test("partner_intel: the industry filter follows a roster edit at once, with no re-scan", async () => {
  const { env, token } = await piEnv([ins({ company_id: "c-a", title: "A" }), ins({ company_id: "c-b", title: "B" })]);
  const titles = async (q) => (await getJson(`insights?${q}`, env, token)).items.map((i) => i.title).sort();
  assert.deepEqual(await titles("industry=Metals"), ["B"]);
  await pi("roster/partner", piReq("roster/partner", "POST", { id: "c-a", name: "Acme Corp", industry: "Metals", status: "Active" }, token), env);
  assert.deepEqual(await titles("industry=Metals"), ["A", "B"]);
  assert.deepEqual(await titles("status=Inactive"), [], "member status filter reads the roster too");
});

test("partner_intel: explore filters combine, and a search term must match the same note", async () => {
  const { env, token } = await piEnv([
    ins({ title: "Robot cell", kind: "solution", urgency: "none", topic: "quality", date: isoAgo(10), event_type: "Workshop", tags: ["robotics"] }),
    ins({ title: "Robot hiring", kind: "problem", urgency: "high", topic: "talent_pipeline", date: isoAgo(10), event_type: "Onboarding Call" }),
    ins({ title: "Old robot", kind: "problem", urgency: "high", topic: "talent_pipeline", date: isoAgo(300) }),
  ]);
  const count = async (q) => (await getJson(`insights?${q}`, env, token)).total;
  assert.equal(await count("q=robot"), 3);
  assert.equal(await count("q=robot&kind=problem&days=90"), 1);
  assert.equal(await count("eventType=Onboarding%20Call"), 1);
  assert.equal(await count("q=robot%20quality"), 0, "every term must be in the same note");
  assert.equal(await count("q=robotics"), 1, "tags are searched");
  assert.equal(await count("urgency=high&topic=talent_pipeline&days=30"), 1);
});

test("partner_intel: dates marked estimated can be excluded", async () => {
  const { env, token } = await piEnv([ins({ title: "dated" }), ins({ title: "guessed", date_source: "box_upload" })]);
  assert.equal((await getJson("insights", env, token)).total, 2);
  assert.deepEqual((await getJson("insights?exact=1", env, token)).items.map((i) => i.title), ["dated"]);
  const home = await getJson("home?days=30", env, token);
  assert.equal(home.counts.estimatedDates, 1);
});

test("partner_intel: a company profile ranks live issues and leaves out resolved ones", async () => {
  const { env, token } = await piEnv([
    ins({ title: "Open hiring gap", topic: "talent_pipeline", urgency: "high" }),
    ins({ title: "Fixed quality escape", topic: "quality", urgency: "high", status: "resolved" }),
    ins({ title: "Won an award", kind: "win", urgency: "none", date: isoAgo(2) }),
    ins({ title: "Built an AI inspector", kind: "solution", urgency: "none", topic: "quality" }),
    ins({ title: "Someone else's", company_id: "c-b" }),
    ins({ title: "Internal", scope: "internal" }),
  ]);
  const p = await getJson("company?id=c-a", env, token);
  const o = await getJson("company/topics?id=c-a&list=all", env, token);
  assert.deepEqual(o.byTopic.map((t) => [t.topic, t.issues, t.resolved, t.solutions, t.wins]),
    [["talent_pipeline", 1, 0, 0, 1], ["quality", 0, 1, 1, 0]], "a resolved issue is listed but not counted");
  assert.deepEqual(o.byTopic[1].items.map((i) => i.title), ["Built an AI inspector", "Fixed quality escape"]);
  assert.equal(p.counts.insights, 4, "internal and other companies' rows are not counted");
  assert.deepEqual(p.company.contacts, ["Ann A"]);
  assert.equal((await pi("company", piGet("company?id=nope", token), env)).status, 404);
});

test("partner_intel: asking before any scan says so instead of failing", async () => {
  const { env, token } = await signedInEnv();
  const res = await pi("ask", piReq("ask", "POST", { question: "Who can help with robots?" }, token), env);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).empty, true);
});

const SOLVERS = () => [
  ins({ kind: "solution", urgency: "none", company_id: "c-a", title: "AI visual quality inspection", detail: "Built a camera inspection system using machine learning to catch defects.", topic: "quality", tags: ["ai", "vision", "inspection"], solves: "manual inspection" }),
  ins({ kind: "offer", urgency: "none", company_id: "c-b", title: "Quality system consulting", detail: "Offers help standing up an ISO quality management system.", topic: "quality", tags: ["iso"], solves: "quality system" }),
  ins({ kind: "win", urgency: "none", company_id: "c-c", title: "Hired apprentices", detail: "Placed five apprentices in the machine shop.", topic: "talent_pipeline", tags: ["apprentice"] }),
];
/** Ask makes a small Haiku call for related search terms before ranking; this answers it. */
const termsOut = (terms) => okJson({ content: [{ type: "tool_use", name: "search_terms", input: { terms } }], usage: { input_tokens: 5, output_tokens: 3 } });
const isExpand = (init) => { try { return JSON.parse(init.body).tools[0].name === "search_terms"; } catch { return false; } };
const expanding = (handler, terms = []) => (url, init) => (isExpand(init) ? termsOut(terms) : handler(url, init));
const rankOut = (matches, extra = {}) => okJson({ content: [{ type: "tool_use", name: "rank_matches", input: { summary: "s", matches, gaps: "", ...extra } }], usage: { input_tokens: 10, output_tokens: 5 } });

test("partner_intel: ask without a Claude key returns a labeled keyword ranking and saves nothing", async () => {
  const { env, token } = await piEnv(SOLVERS());
  const res = await pi("ask", piReq("ask", "POST", { question: "Who has an AI powered quality inspection system?" }, token), env);
  const body = await res.json();
  assert.equal(body.ranking, "keyword");
  assert.equal(body.matches[0].company.id, "c-a");
  assert.match(body.summary, /keyword/i);
  assert.equal([...env.BOX_KV.store.keys()].filter((k) => k.startsWith("pi:ask:") && k !== "pi:ask:recent").length, 0);
});

test("partner_intel: ask never shows a company or evidence the model was not given, and caches by what Claude would read", async () => {
  const rows = SOLVERS();
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  let bodies = [];
  const handler = (url, init) => {
    bodies.push(JSON.parse(init.body));
    return rankOut([
      { company_id: "c-ghost", strength: "high", why: "invented", evidence_ids: [rows[0].id], caution: "" },
      { company_id: "c-a", strength: "high", why: "Built an inspection system.", evidence_ids: ["not-shown", rows[0].id], caution: "" },
      { company_id: "c-b", strength: "medium", why: "No evidence cited.", evidence_ids: ["made-up"], caution: "" },
    ]);
  };
  const ask = () => withFetch(expanding(handler), () => pi("ask", piReq("ask", "POST", { question: "Who has an AI powered quality inspection system?" }, token), env));
  const first = await (await ask()).json();
  assert.equal(first.matches.length, 1, "unknown company and match with no valid evidence are dropped");
  assert.equal(first.matches[0].company.id, "c-a");
  assert.deepEqual(first.matches[0].evidence.map((e) => e.id), [rows[0].id]);
  assert.equal(first.cached, false);
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].model, "claude-sonnet-5-5", "Ask decides introductions, so it runs on Sonnet");
  assert.equal(bodies[0].tools[0].strict, true);
  assert.deepEqual(bodies[0].tool_choice, { type: "auto" }, "Sonnet 5.5 rejects a forced tool choice");
  assert.deepEqual(bodies[0].output_config, { effort: "medium" });
  assert.equal(bodies[0].fallbacks, "default", "a declined question falls back server-side");
  assert.match(bodies[0].system, /calling the rank_matches tool/);
  assert.match(bodies[0].messages[0].content, /<question>\nWho has an AI powered quality inspection system\?\n<\/question>/);
  const second = await (await ask()).json();
  assert.equal(second.cached, true);
  assert.equal(bodies.length, 1, "the repeat question made no Claude call");
  // COST: every daily scan publishes a new version. When nothing the question touches changed,
  // the prompt is the same, so the saved answer is reused instead of paid for again.
  await pi("relay/publish", relay("publish", "POST", { version: "new-version", generated_at: "x", roster_updated_at: "r1", topics: TOPICS, events: [], insights: rows, companies: [], unmatched: [], stats: {} }), env);
  assert.equal((await (await ask()).json()).cached, true, "a republish that changed nothing relevant costs nothing");
  assert.equal(bodies.length, 1);
  // A new row that answers the question changes what Claude would read, so it is asked again.
  const more = [...rows, ins({ kind: "solution", urgency: "none", company_id: "c-c", title: "AI inspection cameras on the press line",
    detail: "Installed vision inspection with AI.", topic: "quality", tags: ["ai", "inspection"], solves: "quality inspection" })];
  await pi("relay/publish", relay("publish", "POST", { version: "v3", generated_at: "x", roster_updated_at: "r1", topics: TOPICS, events: [], insights: more, companies: [], unmatched: [], stats: {} }), env);
  assert.equal((await (await ask()).json()).cached, false);
  assert.equal(bodies.length, 2);
  const usage = (await getJson("status", env, token)).usage.thisMonth.ask;
  assert.deepEqual([usage.calls, usage.input, usage.output, usage.reused], [3, 25, 13, 2],
    "the meter counts paid calls (two rankings and one search-term call, saved for the repeats) and reuses");
});

test("partner_intel: a failed Claude call is an error and is not saved as an answer", async () => {
  const { env, token } = await piEnv(SOLVERS(), { partner_intel_claude_api: "k" });
  const ask = (status) => withFetch(() => (status === 200 ? rankOut([]) : new Response("overloaded", { status })),
    () => pi("ask", piReq("ask", "POST", { question: "Who has an AI powered quality inspection system?" }, token), env));
  assert.equal((await ask(529)).status, 502);
  const retry = await ask(200);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).cached, false, "the failure was not cached");
});

test("partner_intel: a question nothing matches costs no Claude call", async () => {
  const { env, token } = await piEnv(SOLVERS(), { partner_intel_claude_api: "k" });
  const body = await withFetch(() => { throw new Error("must not call Claude"); },
    async () => (await pi("ask", piReq("ask", "POST", { question: "Who sells submarine periscopes?" }, token), env)).json());
  assert.deepEqual(body.matches, []);
  assert.equal(body.ranking, "none");
});

test("partner_intel: ask rejects a too-short or too-long question", async () => {
  const { env, token } = await piEnv(SOLVERS());
  const ask = (q) => pi("ask", piReq("ask", "POST", { question: q }, token), env);
  assert.equal((await ask("robots")).status, 400);
  assert.equal((await ask("x".repeat(601))).status, 400);
});

test("partner_intel: only solutions, offers, wins and equipment can answer who can help", async () => {
  const { env, token } = await piEnv([
    ins({ kind: "problem", company_id: "c-a", title: "Needs AI quality inspection", detail: "Struggles with inspection.", topic: "quality" }),
    ins({ kind: "solution", urgency: "none", company_id: "c-b", title: "AI quality inspection cell", detail: "Camera inspection.", topic: "quality" }),
  ]);
  const body = await (await pi("ask", piReq("ask", "POST", { question: "Who has AI quality inspection?" }, token), env)).json();
  assert.deepEqual(body.matches.map((m) => m.company.id), ["c-b"], "a company with the PROBLEM is not a solution haver");
});

test("partner_intel: the daily scan starts once a day at the time set on the control panel, in Eastern time", async () => {
  const { env, token } = await piEnv([ins()]);
  const at = (iso) => new Date(iso);
  const dispatches = [];
  const ok = (url, init) => { dispatches.push(JSON.parse(init.body).inputs); return new Response(null, { status: 204 }); };
  const tick = (iso, handler = ok) => withFetch(handler, () => runScheduledScan(env, at(iso)));
  assert.deepEqual(await getJson("schedule", env, token), { time: "07:00", enabled: true, timeZone: "Eastern", next: (await getJson("schedule", env, token)).next, lastRunAt: "", lastError: "" }, "7:00 Eastern by default");
  assert.equal((await tick("2026-10-15T11:30:00Z")).reason, "no folder", "nothing to scan before a folder is chosen");
  await pi("settings", piReq("settings", "POST", { folderId: "12345", folderName: "Raw Notes" }, token), env);
  // October is daylight time (UTC-4): 7:00 Eastern is 11:00 UTC.
  assert.equal((await tick("2026-10-15T10:58:00Z")).ran, false, "6:58 Eastern: not yet");
  assert.equal((await tick("2026-10-15T11:02:00Z")).ran, true, "7:02 Eastern: starts");
  assert.deepEqual(dispatches, [{ mode: "scan", limit: "0", force: "false" }], "a normal scan");
  assert.equal((await tick("2026-10-15T11:07:00Z")).ran, false, "once a day");
  assert.equal((await tick("2026-10-16T03:30:00Z")).ran, false, "11:30pm Eastern is still the 15th");
  assert.equal((await tick("2026-10-16T11:01:00Z")).ran, true, "the next day, again");
  // January is standard time (UTC-5): 7:00 Eastern is 12:00 UTC.
  assert.equal((await tick("2027-01-15T11:58:00Z")).ran, false, "in winter, 11:58 UTC is 6:58 Eastern");
  assert.equal((await tick("2027-01-15T12:01:00Z")).ran, true, "and 12:01 UTC is 7:01");
  const save = async (time, enabled, nowIso) => {
    const realNow = Date.now;
    Date.now = () => Date.parse(nowIso);
    try {
      // Signed in at that moment too: the clock jump would otherwise outlive the 8-hour session.
      const t = (await (await beta("login", jsonReq("/api/beta/login", "POST", { email: "poneill@conexusindiana.com", password: "seed-password-123" }), env)).json()).token;
      return await pi("schedule", piReq("schedule", "POST", { time, enabled }, t), env);
    } finally { Date.now = realNow; }
  };
  assert.equal((await save("7am", true, "2027-01-20T15:00:00Z")).status, 400, "a time is HH:MM");
  // Saved at 10:00 Eastern on the 20th.
  const past = await (await save("09:00", true, "2027-01-20T15:00:00Z")).json();
  assert.equal(past.next, "tomorrow", "a time already past today starts tomorrow");
  assert.equal((await tick("2027-01-20T15:05:00Z")).ran, false, "rather than the moment it is saved");
  assert.equal((await tick("2027-01-21T14:01:00Z")).ran, true, "and runs at 9:01 the next day");
  const later = await (await save("14:00", true, "2027-01-21T15:00:00Z")).json();
  assert.equal(later.next, "tomorrow", "already ran today, so a later time waits for tomorrow");
  assert.equal((await tick("2027-01-21T19:01:00Z")).ran, false, "never a second scan the same day");
  const off = await (await save("08:00", false, "2027-01-22T10:00:00Z")).json();
  assert.equal(off.enabled, false);
  assert.equal((await tick("2027-01-22T13:01:00Z")).reason, "off", "switched off: no scan");
  await save("08:00", true, "2027-01-23T10:00:00Z");
  const refuse = () => new Response("no", { status: 500 });
  const fails = [];
  for (const m of ["01", "06", "11", "16"]) fails.push(await tick(`2027-01-23T13:${m}:00Z`, refuse));
  assert.deepEqual(fails.map((r) => Boolean(r.error)), [true, true, true, false], "a failed start is tried three times, then left until tomorrow");
  assert.match((await getJson("schedule", env, token)).lastError, /GitHub refused/, "the control panel shows why");
  assert.equal((await tick("2027-01-24T13:01:00Z")).ran, true, "the next day starts fresh");
});

test("partner_intel: run needs a folder, clamps the trial size, and sends the inputs to GitHub", async () => {
  const { env, token } = await piEnv([ins()]);
  const run = (body) => pi("run", piReq("run", "POST", body, token), env);
  assert.equal((await run({ mode: "scan" })).status, 400, "no folder chosen yet");
  await pi("settings", piReq("settings", "POST", { folderId: "12345", folderName: "Raw Notes" }, token), env);
  assert.equal((await pi("settings", piReq("settings", "POST", { folderId: "abc" }, token), env)).status, 400);
  let sent;
  const res = await withFetch((url, init) => { sent = { url, body: JSON.parse(init.body) }; return new Response(null, { status: 204 }); },
    () => run({ mode: "scan", limit: 99999, force: true }));
  assert.equal(res.status, 200);
  assert.match(sent.url, /workflows\/partner_intel_run\.yml\/dispatches$/);
  assert.deepEqual(sent.body.inputs, { mode: "scan", limit: "500", force: "true" });
  const rebuild = await withFetch((url, init) => { sent = { body: JSON.parse(init.body) }; return new Response(null, { status: 204 }); }, () => run({ mode: "rebuild" }));
  assert.equal(rebuild.status, 200);
  assert.equal(sent.body.inputs.mode, "rebuild");
  const weird = await withFetch((url, init) => { sent = { body: JSON.parse(init.body) }; return new Response(null, { status: 204 }); }, () => run({ mode: "rm -rf" }));
  assert.equal(sent.body.inputs.mode, "scan", "an unknown mode never reaches the workflow");
  assert.equal(weird.status, 200);
});

test("partner_intel: a roster change after the data was built asks for a re-link", async () => {
  const { env, token } = await piEnv([ins()]);
  assert.equal((await getJson("status", env, token)).relinkNeeded, false);
  await pi("roster/staff", piReq("roster/staff", "POST", { names: ["Pat Staff"] }, token), env);
  assert.equal((await getJson("status", env, token)).relinkNeeded, true);
  assert.equal((await getJson("roster", env, token)).relinkNeeded, true);
});

test("partner_intel: the review queue maps a name to a partner or adds it as a non-member", async () => {
  const { env, token } = await signedInEnv();
  await env.BOX_KV.put("pi:roster", JSON.stringify({ partners: PARTNERS.map((p) => ({ ...p })), aliases: {}, staff: [], updatedAt: "r1" }));
  await pi("relay/publish", relay("publish", "POST", { version: "v", generated_at: "x", roster_updated_at: "r1", topics: TOPICS, events: [],
    insights: [ins()], companies: [{ id: "n-gpc", name: "GPC" }, { id: "n-hartman", name: "Hartman" }],
    unmatched: [{ raw: "GPC", companyId: "n-gpc", count: 4, candidates: [] }, { raw: "Hartman", companyId: "n-hartman", count: 2, candidates: [] }], stats: {} }), env);
  assert.equal((await getJson("review", env, token)).items.length, 2);
  await pi("review/map", piReq("review/map", "POST", { raw: "GPC", companyId: "c-b" }, token), env);
  assert.equal((await pi("review/map", piReq("review/map", "POST", { raw: "X", companyId: "c-nope" }, token), env)).status, 400);
  await pi("review/add", piReq("review/add", "POST", { raw: "Hartman" }, token), env);
  await pi("review/add", piReq("review/add", "POST", { raw: "Hartman" }, token), env);
  const roster = JSON.parse(await env.BOX_KV.get("pi:roster"));
  assert.equal(roster.aliases.GPC, "c-b");
  assert.equal(roster.partners.filter((p) => p.name === "Hartman").length, 1, "adding twice adds once");
  assert.equal(roster.partners.find((p) => p.name === "Hartman").status, "Non-member");
  const items = (await getJson("review", env, token)).items;
  assert.ok(items.every((i) => i.pending), "both are marked as waiting for a re-link");
});

test("partner_intel: the relay lists every page of a Box folder and streams file bytes", async () => {
  const env = makeEnv();
  await env.BOX_KV.put("box:tokens", JSON.stringify({ access_token: "tok", refresh_token: "r", obtained_at: Math.floor(Date.now() / 1000), expires_in: 3600 }));
  const entries = (from, to) => Array.from({ length: to - from }, (_, i) => ({ type: "file", id: String(from + i), name: `f${from + i}.docx`, size: 10, sha1: "s", created_at: "c", modified_at: "m" }));
  const folder = await withFetch((url) => {
    const offset = Number(new URL(url).searchParams.get("offset"));
    return okJson({ total_count: 1500, entries: offset === 0 ? entries(0, 1000) : entries(1000, 1500) });
  }, async () => (await pi("relay/box/folder", req("/api/partner-intel/relay/box/folder?id=77", { headers: { "x-pipeline-key": "relay-secret" } }), env)).json());
  assert.equal(folder.entries.length, 1500);
  const file = await withFetch((url, init) => {
    assert.equal(init.headers.authorization, "Bearer tok");
    return new Response(new Uint8Array([1, 2, 3, 250]));
  }, async () => (await pi("relay/box/file", req("/api/partner-intel/relay/box/file?id=5", { headers: { "x-pipeline-key": "relay-secret" } }), env)).arrayBuffer());
  assert.deepEqual([...new Uint8Array(file)], [1, 2, 3, 250]);
  const bad = await pi("relay/box/file", req("/api/partner-intel/relay/box/file?id=../x", { headers: { "x-pipeline-key": "relay-secret" } }), env);
  assert.equal(bad.status, 400, "a file id is digits only");
});

/* ---------------------------------------------------- partner_intel: Box folders, member list, sources */
const { xlsxRows } = await mod("partner_intel.js");

function buildZip(entries) {
  const enc = new TextEncoder();
  const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
  const local = [], central = [];
  for (const [name, content] of Object.entries(entries)) {
    const n = enc.encode(name), d = enc.encode(content);
    const offset = local.length;
    local.push(...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(d.length),
      ...u32(d.length), ...u16(n.length), ...u16(0), ...n, ...d);
    central.push(...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0),
      ...u32(d.length), ...u32(d.length), ...u16(n.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...n);
  }
  const count = Object.keys(entries).length;
  return new Uint8Array([...local, ...central, ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(count), ...u16(count),
    ...u32(central.length), ...u32(local.length), ...u16(0)]);
}

const XLSX_SHEET = `<?xml version="1.0"?><worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>Status</t></is></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"/><c r="D2" t="str"><v>Active</v></c></row>
</sheetData></worksheet>`;
const XLSX_STRINGS = `<?xml version="1.0"?><sst><si><t>Organization: Account Name</t></si><si><t>Organization: Industry</t></si>
<si><t>Acci&#243;n &amp; Co</t></si><si><r><t>Plastics </t></r><r><t>Company</t></r></si></sst>`;

test("partner_intel: an .xlsx member list is read, with shared strings, rich text, gaps and entities", async () => {
  const rows = await xlsxRows(buildZip({ "xl/sharedStrings.xml": XLSX_STRINGS, "xl/worksheets/sheet1.xml": XLSX_SHEET }));
  assert.deepEqual(rows, [["Organization: Account Name", "Organization: Industry", "", "Status"],
    ["Acción & Co", "Plastics Company", "", "Active"]]);
  await assert.rejects(() => xlsxRows(new Uint8Array([1, 2, 3, 4])), /valid \.xlsx/);
  await assert.rejects(() => xlsxRows(buildZip({ "readme.txt": "x" })), /No worksheet/);
});

async function adminEnv(extra = {}) {
  const { env, token } = await signedInEnv();
  Object.assign(env, extra);
  await env.BOX_KV.put("box:tokens", JSON.stringify({ access_token: "tok", refresh_token: "r", obtained_at: Math.floor(Date.now() / 1000), expires_in: 3600 }));
  return { env, token };
}
const setFolder = (env, token, which, id, name) => pi("settings", piReq("settings", "POST", { which, folderId: id, folderName: name }, token), env);

test("partner_intel: the three Box folders are chosen separately and never overwrite each other", async () => {
  const { env, token } = await adminEnv();
  assert.equal((await setFolder(env, token, "notes", "11", "Raw Notes")).status, 200);
  assert.equal((await setFolder(env, token, "data", "22", "Database")).status, 200);
  assert.equal((await setFolder(env, token, "roster", "33", "Members")).status, 200);
  const s = JSON.parse(await env.BOX_KV.get("pi:settings"));
  assert.deepEqual([s.folderId, s.dataFolderId, s.rosterFolderId, s.folderName, s.dataFolderName, s.rosterFolderName],
    ["11", "22", "33", "Raw Notes", "Database", "Members"]);
  assert.equal((await setFolder(env, token, "data", "abc", "x")).status, 400);
  assert.equal((await setFolder(env, token, "data", "0", "All Files")).status, 400, "the Box root is not a folder to write to");
  assert.equal((await setFolder(env, token, "toString", "5", "x")).status, 400, "an unknown setting is refused, prototype names included");
  assert.equal((await setFolder(env, token, undefined, "44", "Old Client")).status, 200, "a client that sends no 'which' still sets the notes folder");
  assert.equal(JSON.parse(await env.BOX_KV.get("pi:settings")).folderId, "44");
});

function boxFake(folders, files = {}, uploads = []) {
  return (url, init = {}) => {
    const u = new URL(url);
    const items = u.pathname.match(/\/folders\/(\d+)\/items$/);
    if (items) {
      const list = folders[items[1]] || [];
      return okJson({ total_count: list.length, entries: list });
    }
    const content = u.pathname.match(/\/files\/(\d+)\/content$/);
    if (content && !url.startsWith("https://upload.")) {
      const f = files[content[1]];
      return f === undefined ? new Response("no", { status: 404 }) : new Response(f);
    }
    if (url.startsWith("https://upload.box.com")) {
      uploads.push({ url, form: init.body });
      return okJson({ entries: [{ id: "999" }] });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
}
const fileItem = (id, name, modified, sha1 = "s" + id) => ({ type: "file", id, name, size: 10, sha1, created_at: modified, modified_at: modified });

test("partner_intel: database files go to the chosen Box folder, as a new version when the name already exists", async () => {
  const { env, token } = await adminEnv();
  const save = (name, text = "{}") => pi("relay/box/save", relay("box/save", "POST", { name, text }), env);
  assert.equal((await save("partner_intel_database.json")).status, 409, "no database folder chosen yet");
  await setFolder(env, token, "data", "22", "Database");
  assert.equal((await save("../../evil.json")).status, 400, "only the database files may be written");
  assert.equal((await save("notes.docx")).status, 400);
  const uploads = [];
  const handler = boxFake({ 22: [fileItem("700", "partner_intel_state.json", "2026-01-01T00:00:00Z")] }, {}, uploads);
  const created = await withFetch(handler, async () => (await save("partner_intel_database.json", '{"a":1}')).json());
  assert.equal(created.updated, false);
  assert.match(uploads[0].url, /upload\.box\.com\/api\/2\.0\/files\/content$/);
  assert.equal(JSON.parse(uploads[0].form.get("attributes")).parent.id, "22");
  assert.equal(await uploads[0].form.get("file").text(), '{"a":1}');
  const updated = await withFetch(handler, async () => (await save("partner_intel_state.json", "{}")).json());
  assert.equal(updated.updated, true, "Box answers 409 to a second upload of the same name, so it is a new version");
  assert.match(uploads[1].url, /files\/700\/content$/);
  assert.equal((await pi("relay/box/save", relay("box/save", "POST", { name: "partner_intel_state.json", text: "x" }, "wrong"), env)).status, 401);
  const archived = await withFetch(handler, async () => (await save("partner_intel_results_archive.json", "{}")).json());
  assert.equal(archived.ok, true, "the results archive is a database file too");
  assert.equal((await pi("relay/box/load", relay("box/load", "GET"), env)).status, 400);
});

test("partner_intel: a saved state file can be read back, and a missing one is a plain 404", async () => {
  const { env, token } = await adminEnv();
  await setFolder(env, token, "data", "22", "Database");
  const load = (name) => pi("relay/box/load", req(`/api/partner-intel/relay/box/load?name=${name}`, { headers: { "x-pipeline-key": "relay-secret" } }), env);
  const handler = boxFake({ 22: [fileItem("700", "partner_intel_state.json", "2026-01-01T00:00:00Z")] }, { 700: '{"registry":{}}' });
  const hit = await withFetch(handler, async () => load("partner_intel_state.json"));
  assert.equal(await hit.text(), '{"registry":{}}');
  assert.equal((await withFetch(handler, async () => load("partner_intel_database.json"))).status, 404);
  assert.equal((await withFetch(handler, async () => load("secrets.json"))).status, 400);
});

const MEMBER_CSV = (rows) => [SF_HEADER, ...rows.map((r) => r.map((c) => `"${c}"`).join(","))].join("\n");

test("partner_intel: the member list in Box is read from the newest file, Windows-1252 accents included", async () => {
  const { env, token } = await adminEnv();
  await setFolder(env, token, "roster", "33", "Members");
  const older = MEMBER_CSV([["C", "P1", "Old Only Inc", "Metals", "Active", "", ""]]);
  const newer = MEMBER_CSV([["C", "P1", "Acción Performance", "3PL Company", "Active", "Tiffany H", ""],
    ["C", "P2", "Beta Works", "Metals", "Active", "", ""]]);
  const handler = boxFake({ 33: [fileItem("1", "members-old.csv", "2026-01-01T00:00:00Z"), fileItem("2", "members-new.csv", "2026-06-01T00:00:00Z"),
    fileItem("3", "~$members.csv", "2026-07-01T00:00:00Z"), fileItem("4", "notes.docx", "2026-07-01T00:00:00Z")] },
  { 1: Buffer.from(older, "latin1"), 2: Buffer.from(newer, "latin1") });
  const sync = (body) => withFetch(handler, async () => (await pi("roster/sync", piReq("roster/sync", "POST", body, token), env)).json());
  const preview = await sync({ preview: true });
  assert.equal(preview.file.name, "members-new.csv", "the newest real file wins; lock files and Word files are ignored");
  assert.deepEqual(preview.summary.added, ["Acción Performance", "Beta Works"], "the accent survived a Windows-1252 file");
  assert.equal(JSON.parse((await env.BOX_KV.get("pi:roster")) || '{"partners":[]}').partners.length, 0, "a preview saves nothing");
  const applied = await sync({});
  assert.equal(applied.saved, true);
  assert.equal(JSON.parse(await env.BOX_KV.get("pi:roster")).partners.length, 2);
  const status = await getJson("status", env, token);
  assert.equal(status.rosterSync.name, "members-new.csv");
  assert.equal(status.rosterSync.counts.added, 2);
});

test("partner_intel: the daily refresh skips an unchanged file, and a shrunken file is applied as add-only", async () => {
  const { env, token } = await adminEnv();
  await setFolder(env, token, "roster", "33", "Members");
  const twelve = Array.from({ length: 12 }, (_, i) => ["C", `P${i}`, `Partner ${i}`, "Metals", "Active", "", ""]);
  const full = MEMBER_CSV(twelve);
  let current = { 2: full };
  let sha = "a";
  const handler = (url, init) => boxFake({ 33: [fileItem("2", "members.csv", "2026-06-01T00:00:00Z", sha)] }, current)(url, init);
  const auto = () => withFetch(handler, async () => (await pi("relay/roster-sync", relay("roster-sync", "POST", {}), env)).json());
  assert.equal((await auto()).saved, true);
  assert.equal((await auto()).skipped.startsWith("The member list has not changed"), true, "same file, nothing to do");

  current = { 2: MEMBER_CSV(twelve.slice(0, 5)) };  // a half-exported file
  sha = "b";
  const guarded = await auto();
  assert.equal(guarded.mode, "merge");
  assert.match(guarded.warning, /7 of 12 members/);
  const roster = JSON.parse(await env.BOX_KV.get("pi:roster"));
  assert.equal(roster.partners.filter((p) => p.status === "Active").length, 12, "nobody was marked Former");

  const manual = await withFetch(handler, async () => (await pi("roster/sync", piReq("roster/sync", "POST", { mode: "replace" }, token), env)).json());
  assert.equal(manual.summary.deactivated.length, 7, "a person who chooses it and sees the preview can still apply a full list");
});

test("partner_intel: member-list sync says why it did nothing, and rejects a file it cannot read", async () => {
  const { env, token } = await adminEnv();
  const sync = (handler) => withFetch(handler, async () => (await pi("roster/sync", piReq("roster/sync", "POST", {}, token), env)).json());
  assert.match((await sync(boxFake({}))).skipped, /No member list folder/);
  await setFolder(env, token, "roster", "33", "Members");
  assert.match((await sync(boxFake({ 33: [] }))).skipped, /no \.csv or \.xlsx/i);
  const bad = await withFetch(boxFake({ 33: [fileItem("2", "members.xlsx", "2026-06-01T00:00:00Z")] }, { 2: "not a zip" }),
    () => pi("roster/sync", piReq("roster/sync", "POST", {}, token), env));
  assert.equal(bad.status, 502);
  assert.match((await bad.json()).error, /Could not read members\.xlsx/);
  const noCol = await withFetch(boxFake({ 33: [fileItem("2", "members.csv", "2026-06-01T00:00:00Z")] }, { 2: "foo,bar\n1,2" }),
    () => pi("roster/sync", piReq("roster/sync", "POST", {}, token), env));
  assert.match((await noCol.json()).error, /organi[sz]ation column/i);
});

const publishRaw = (env, insights, companies = []) => pi("relay/publish", relay("publish", "POST", {
  version: `v${++insightSeq}`, generated_at: "2026-10-07T00:00:00+00:00", roster_updated_at: "r1", topics: TOPICS, events: [],
  insights, companies, unmatched: [], stats: {} }), env);

test("partner_intel: a company the notes named shows as a member the moment the list has it, with no re-link", async () => {
  const { env, token } = await signedInEnv();
  await env.BOX_KV.put("pi:roster", JSON.stringify({ partners: [], aliases: {}, staff: [], updatedAt: "r0" }));
  await publishRaw(env, [ins({ company_id: "n-acme-corp", company_raw: "Acme Corp", title: "Hiring" }),
    ins({ company_id: "n-gpc", company_raw: "GPC", title: "Scrap" })],
  [{ id: "n-acme-corp", name: "Acme Corp" }, { id: "n-gpc", name: "GPC" }]);
  let item = (await getJson("insights", env, token)).items.find((i) => i.title === "Hiring");
  assert.deepEqual([item.company.status, item.company.member, item.company.industry], ["Non-member", false, "Unknown"],
    "before the list has it, it is not shown as a member");
  await env.BOX_KV.put("pi:roster", JSON.stringify({ partners: PARTNERS.map((p) => ({ ...p })), aliases: { GPC: "c-b" }, staff: [], updatedAt: "r1" }));
  const after = (await getJson("insights", env, token)).items;
  item = after.find((i) => i.title === "Hiring");
  assert.deepEqual([item.company.id, item.company.status, item.company.member, item.company.industry], ["c-a", "Active", true, "Plastics Company"]);
  assert.equal(after.find((i) => i.title === "Scrap").company.id, "c-b", "an admin alias is applied the same way");
  assert.equal((await getJson("insights?status=Active", env, token)).total, 2, "and the member filter now finds them");
  assert.equal((await pi("company", piGet("company?id=n-acme-corp", token), env)).status, 200, "an old link to the n- id still opens the profile");
  assert.equal((await getJson("companies?withInsights=1", env, token)).items.some((c) => c.id.startsWith("n-")), false, "no duplicate left behind");
});

test("partner_intel: source folders filter every view, and naming Board Meetings shows its rows", async () => {
  const { env, token } = await piEnv([
    ins({ title: "ciaic issue", sources: [{ id: "f1", name: "q4.docx", path: "Raw Notes/CIAIC/2025" }], urgency: "high" }),
    ins({ title: "adapt issue", sources: [{ id: "f2", name: "a.docx", path: "Raw Notes/ADAPT" }], urgency: "high" }),
    ins({ title: "board issue", sources: [{ id: "f3", name: "b.docx", path: "Raw Notes/Board Meetings" }], scope: "internal", urgency: "high" }),
    ins({ title: "loose file", sources: [{ id: "f4", name: "l.docx", path: "Raw Notes" }] }),
    ins({ title: "both", source_folders: ["ADAPT", "CIAIC"], sources: [{ id: "f5", name: "x.docx", path: "Raw Notes/ADAPT" }] }),
  ]);
  const titles = async (q) => (await getJson(`insights?${q}`, env, token)).items.map((i) => i.title).sort();
  // The CIAIC folder is shown as Council; a link still naming CIAIC finds the same rows.
  assert.deepEqual(await titles("source=Council"), ["Council issue", "both"], "derived from the path, and a merged row matches any of its sources");
  assert.deepEqual(await titles("source=CIAIC"), ["Council issue", "both"], "an old link naming CIAIC");
  assert.deepEqual(await titles("source=ADAPT%7CCouncil"), ["Council issue", "adapt issue", "both"], "several sources at once");
  assert.deepEqual(await titles("source=(root)"), ["loose file"]);
  assert.deepEqual(await titles("source=Board%20Meetings"), ["board issue"], "an explicit source choice includes the internal rows");
  assert.equal((await titles("")).includes("board issue"), false, "and without it they stay out");
  const home = await getJson("home?days=30&source=ADAPT", env, token);
  assert.equal(home.counts.issues, 2, "Home follows the source choice too; the row from two sources counts under each");
  assert.equal((await getJson("home?days=30&source=CIAIC", env, token)).counts.issues, 2);
  const facets = await getJson("facets", env, token);
  assert.deepEqual(facets.sources, [{ value: "(root)", count: 1 }, { value: "ADAPT", count: 2 }, { value: "Board Meetings", count: 1 }, { value: "Council", count: 2 }]);
  assert.equal((await pi("facets", piGet("facets"), env)).status, 401);
});

test("partner_intel: Ask can be limited to source folders, and the saved answer is kept per choice", async () => {
  const rows = [
    ins({ kind: "solution", urgency: "none", company_id: "c-a", title: "Quality inspection cell", topic: "quality", sources: [{ id: "f1", name: "a", path: "Raw Notes/CIAIC" }] }),
    ins({ kind: "solution", urgency: "none", company_id: "c-b", title: "Quality inspection camera", topic: "quality", sources: [{ id: "f2", name: "b", path: "Raw Notes/ADAPT" }] }),
  ];
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  let calls = 0;
  const handler = (url, init) => {
    calls++;
    const sent = JSON.parse(init.body).messages[0].content;
    const ids = [...sent.matchAll(/"company_id": "(c-\w)"/g)].map((m) => m[1]);
    return rankOut(ids.map((id) => ({ company_id: id, strength: "high", why: "Has it.", evidence_ids: [rows[id === "c-a" ? 0 : 1].id], caution: "" })));
  };
  const ask = (sources) => withFetch(expanding(handler), async () => (await pi("ask", piReq("ask", "POST", { question: "Who has quality inspection systems?", sources }, token), env)).json());
  assert.deepEqual((await ask([])).matches.map((m) => m.company.id).sort(), ["c-a", "c-b"]);
  assert.deepEqual((await ask(["ADAPT"])).matches.map((m) => m.company.id), ["c-b"], "only the chosen source's companies were offered");
  assert.equal(calls, 2);
  assert.equal((await ask(["ADAPT"])).cached, true, "the same question and sources reuse the saved answer");
  assert.equal(calls, 2);
});

/* ------------------------------------------------ partner_intel: trending summaries, programs, one-time update */
const publishV2 = (env, insights, extra = {}) => pi("relay/publish", relay("publish", "POST", {
  schema: 2, version: `v${++insightSeq}`, generated_at: "2026-10-07T00:00:00+00:00", roster_updated_at: "r1", topics: TOPICS, events: [],
  insights, companies: [], unmatched: [], stats: {}, ...extra }), env);

const summaryOut = (payload, make) => okJson({ content: [{ type: "tool_use", name: "write_summaries", input: { topics: payload.map(make) } }], usage: { input_tokens: 50, output_tokens: 20 } });
const topicsIn = (init) => { const body = JSON.parse(init.body); const sent = body.messages[0].content;
  return { body, payload: JSON.parse(sent.slice(sent.indexOf("<topics>") + 8, sent.indexOf("</topics>"))) }; };

function trendingRows() {
  return [
    ins({ topic: "talent_pipeline", company_id: "c-a", title: "Cannot hire machinists" }),
    ins({ topic: "talent_pipeline", company_id: "c-b", title: "Apprentices leave early" }),
    ins({ topic: "talent_pipeline", company_id: "c-c", title: "Few applicants" }),
    ins({ topic: "quality", company_id: "c-a", title: "Scrap on line 3" }),
    ins({ topic: "quality", company_id: "c-b", title: "Inspection backlog" }),
  ];
}

test("partner_intel: Home answers at once with the examples, then the bullet summaries are written and saved", async () => {
  const rows = trendingRows();
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  let calls = [];
  const handler = (url, init) => {
    const { body, payload } = topicsIn(init);
    calls.push({ body, payload });
    return summaryOut(payload, (t) => ({ topic_id: t.topic_id, bullets: [
      { text: `Companies in ${t.topic} describe a first problem.`, evidence_ids: [t.evidence[0].id, t.evidence[1].id] },
      { text: "A second point.", evidence_ids: [t.evidence[1].id, "not-shown"] },
      { text: "A bullet citing nothing real is dropped.", evidence_ids: ["made-up"] },
    ] }));
  };
  const first = await getJson("home?days=30", env, token);
  assert.deepEqual(first.trending.map((t) => t.topic), ["talent_pipeline", "quality"]);
  assert.equal(first.trending[0].summary, null, "nothing written yet");
  assert.equal(first.trending[0].examples.length, 3, "so the page can still show examples");

  const sum = (topics, extra = {}) => withFetch(handler, async () => (await pi("summarize", piReq("summarize", "POST", { days: 30, topics, ...extra }, token), env)).json());
  const out = await sum(["talent_pipeline", "quality"]);
  assert.equal(calls.length, 1, "both topics were written in ONE Claude call");
  assert.equal(calls[0].payload.length, 2);
  assert.equal(calls[0].body.model, "claude-haiku-5-5", "summaries are short and checked, so they run on Haiku");
  assert.equal(calls[0].body.tools[0].strict, true);
  assert.deepEqual(calls[0].body.tool_choice, { type: "auto" });
  assert.deepEqual(calls[0].body.output_config, { effort: "low" });
  assert.equal(calls[0].body.fallbacks, undefined, "Haiku has no server-side fallback");
  assert.match(calls[0].body.system, /calling the write_summaries tool/);
  assert.ok(calls[0].payload[0].evidence[0].company, "the model is told which company said it");
  const bullets = out.summaries.talent_pipeline.bullets;
  assert.deepEqual(bullets.map((b) => b.text), ["Companies in Talent pipeline and recruiting describe a first problem.", "A second point."],
    "a bullet that cites no row the model was shown is dropped");
  assert.equal(bullets[1].examples.length, 1, "and a made-up evidence id is dropped from a bullet that has a real one");
  assert.ok(bullets[0].examples[0].company.name, "the examples are full insight cards");

  assert.equal((await sum(["talent_pipeline", "quality"])).summaries.quality.bullets.length, 2);
  assert.equal(calls.length, 1, "asked again: saved, no second call");
  const home = await getJson("home?days=30", env, token);
  assert.equal(home.trending[0].summary.bullets.length, 2, "Home now carries the saved summary");
  assert.equal(home.trending[0].examples.length, 0);

  // One topic's evidence changes, so only that topic is written again.
  await publishV2(env, [...rows, ins({ topic: "quality", company_id: "c-c", title: "A new quality issue" })]);
  await sum(["talent_pipeline", "quality"]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].payload.map((t) => t.topic_id), ["quality"], "an unchanged topic is not paid for again");
});

test("partner_intel: a summary that cites nothing real is not saved, and a Claude failure is an error, not a saved blank", async () => {
  const { env, token } = await piEnv(trendingRows(), { partner_intel_claude_api: "k" });
  const sum = (handler) => withFetch(handler, () => pi("summarize", piReq("summarize", "POST", { days: 30, topics: ["quality"] }, token), env));
  const bad = await sum((url, init) => summaryOut(topicsIn(init).payload, (t) => ({ topic_id: t.topic_id,
    bullets: [{ text: "Invented.", evidence_ids: ["nope"] }] })));
  assert.deepEqual((await bad.json()).summaries, {}, "nothing usable came back");
  const failed = await sum(() => new Response("overloaded", { status: 529 }));
  assert.equal(failed.status, 502);
  let calls = 0;
  const good = await (await sum((url, init) => { calls++; return summaryOut(topicsIn(init).payload, (t) => ({ topic_id: t.topic_id,
    bullets: [{ text: "Real.", evidence_ids: [t.evidence[0].id] }] })); })).json();
  assert.equal(calls, 1, "neither the empty answer nor the failure was cached");
  assert.equal(good.summaries.quality.bullets[0].text, "Real.");
});

test("partner_intel: summaries are capped at eight topics per call, ignore unknown topics, and say when Claude is not set up", async () => {
  const topicsMany = Array.from({ length: 12 }, (_, n) => ({ id: `t${n}`, label: `Topic ${n}`, keywords: "" }));
  const { env, token } = await signedInEnv();
  Object.assign(env, { partner_intel_claude_api: "k" });
  await env.BOX_KV.put("pi:roster", JSON.stringify({ partners: PARTNERS.map((p) => ({ ...p })), aliases: {}, staff: [], updatedAt: "r1" }));
  await publishV2(env, topicsMany.map((t) => ins({ topic: t.id, company_id: "c-a" })), { topics: topicsMany });
  let sent;
  const out = await withFetch((url, init) => { sent = topicsIn(init).payload; return summaryOut(sent, (t) => ({ topic_id: t.topic_id,
    bullets: [{ text: "Point.", evidence_ids: [t.evidence[0].id] }] })); },
  async () => (await pi("summarize", piReq("summarize", "POST", { days: 30, topics: [...topicsMany.map((t) => t.id), "ghost"] }, token), env)).json());
  assert.equal(sent.length, 8, "at most eight topics in one call");
  assert.equal(Object.keys(out.summaries).length, 8);
  delete env.partner_intel_claude_api;
  const none = await (await pi("summarize", piReq("summarize", "POST", { days: 30, topics: ["t9"] }, token), env)).json();
  assert.match(none.unavailable, /Claude is not set up/);
});

test("partner_intel: summaries follow the filters they were asked under, so a source folder gets its own", async () => {
  const rows = [
    ins({ topic: "quality", company_id: "c-a", sources: [{ id: "f1", name: "a", path: "Raw Notes/CIAIC" }] }),
    ins({ topic: "quality", company_id: "c-b", sources: [{ id: "f2", name: "b", path: "Raw Notes/ADAPT" }] }),
  ];
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  const seen = [];
  const handler = (url, init) => { const { payload } = topicsIn(init); seen.push(payload[0].evidence.length);
    return summaryOut(payload, (t) => ({ topic_id: t.topic_id, bullets: [{ text: "Point.", evidence_ids: [t.evidence[0].id] }] })); };
  const sum = (body) => withFetch(handler, async () => (await pi("summarize", piReq("summarize", "POST", body, token), env)).json());
  await sum({ days: 30, topics: ["quality"] });
  await sum({ days: 30, topics: ["quality"], source: ["ADAPT"] });
  assert.deepEqual(seen, [2, 1], "the ADAPT summary was written from ADAPT's rows only");
});

const oneBullet = (t) => ({ topic_id: t.topic_id, bullets: [
  { text: "First point.", evidence_ids: [t.evidence[0].id] }, { text: "Second point.", evidence_ids: t.evidence.slice(1).map((e) => e.id).slice(0, 4) }] });

test("partner_intel: COST a summary is reused when the window rolls and only a row changes, not paid for again", async () => {
  const base = Array.from({ length: 10 }, (_, k) => ins({ topic: "quality", company_id: ["c-a", "c-b", "c-c"][k % 3], meeting_id: `m-q${k}`, title: `Quality point ${k}` }));
  const { env, token } = await piEnv(base, { partner_intel_claude_api: "k" });
  let calls = 0;
  const handler = (url, init) => { calls++; return summaryOut(topicsIn(init).payload, oneBullet); };
  const sum = () => withFetch(handler, async () => (await pi("summarize", piReq("summarize", "POST", { days: 30, topics: ["quality"] }, token), env)).json());
  await sum();
  assert.equal(calls, 1);
  // A day later: one new row came in, from a meeting and a company already in the topic, so the bullets'
  // counts still hold. Ten of the eleven rows are the ones the summary was written from.
  await publishV2(env, [...base, ins({ topic: "quality", company_id: "c-c", meeting_id: "m-q2", title: "A newer quality point" })]);
  const again = await sum();
  assert.equal(calls, 1, "ten of eleven rows unchanged: the saved summary is reused");
  assert.equal(again.summaries.quality.bullets.length, 2);
  assert.equal((await getJson("status", env, token)).usage.thisMonth.summaries.reused, 1);
});

test("partner_intel: BUG a reused summary still said one company after a second company raised the topic", async () => {
  // Five of six rows unchanged passed the near-match test, so "One company, Acme Corp, ..." was served
  // while the topic card said two companies. A near match now needs the same companies and counts.
  const base = Array.from({ length: 5 }, (_, k) => ins({ topic: "quality", company_id: "c-a", meeting_id: `m-j${k}` }));
  const { env, token } = await piEnv(base, { partner_intel_claude_api: "k" });
  let calls = 0;
  const handler = (url, init) => { calls++; return summaryOut(topicsIn(init).payload, oneBullet); };
  const sum = () => withFetch(handler, async () => (await pi("summarize", piReq("summarize", "POST", { days: 30, topics: ["quality"] }, token), env)).json());
  await sum();
  await publishV2(env, [...base, ins({ topic: "quality", company_id: "c-b", meeting_id: "m-j9" })]);
  await sum();
  assert.equal(calls, 2);
});

test("partner_intel: BUG a trending summary kept naming the old company after staff moved a statement to another company", async () => {
  const rows = [ins({ id: "mv1", topic: "quality", company_id: "c-a", meeting_id: "m-mv1", review: ["speaker_company_conflict"] }),
    ...Array.from({ length: 4 }, (_, k) => ins({ topic: "quality", company_id: "c-b", meeting_id: `m-mv${k + 2}` }))];
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  const sent = [];
  const handler = (url, init) => { const { payload } = topicsIn(init); sent.push(payload[0].evidence.find((e) => e.id === "mv1").company);
    return summaryOut(payload, oneBullet); };
  const sum = () => withFetch(handler, async () => (await pi("summarize", piReq("summarize", "POST", { days: 30, topics: ["quality"] }, token), env)).json());
  await sum();
  assert.equal((await pi("attribution/decide", piReq("attribution/decide", "POST", { id: "mv1", companyId: "c-c" }, token), env)).status, 200);
  await sum();
  assert.deepEqual(sent, ["Acme Corp", "Gamma Labs"], "written again with the company staff chose, not served naming Acme");
});

test("partner_intel: a summary is not reused when one of its bullets has lost all its rows", async () => {
  const base = Array.from({ length: 10 }, (_, k) => ins({ topic: "quality", company_id: ["c-a", "c-b", "c-c"][k % 3], meeting_id: `m-l${k}`, title: `Quality point ${k}` }));
  const { env, token } = await piEnv(base, { partner_intel_claude_api: "k" });
  let calls = 0, firstEvidence;
  const handler = (url, init) => { calls++; const { payload } = topicsIn(init); firstEvidence = firstEvidence || payload[0].evidence[0].id;
    return summaryOut(payload, oneBullet); };
  const sum = () => withFetch(handler, async () => (await pi("summarize", piReq("summarize", "POST", { days: 30, topics: ["quality"] }, token), env)).json());
  await sum();
  // The row the first bullet stands on leaves; 9 of 10 rows are still the same.
  await publishV2(env, base.filter((r) => r.id !== firstEvidence));
  await sum();
  assert.equal(calls, 2, "the first bullet would have nothing to show, so the summary is written again");
});

test("partner_intel: the scan report adds the pipeline's Claude use to the monthly meter, batch and direct apart", async () => {
  const { env, token } = await piEnv([]);
  await pi("relay/report", relay("report", "POST", { mode: "scan", claude_calls: 5, claude_calls_batch: 4, tokens_in_batch: 4000,
    tokens_out_batch: 800, claude_calls_sync: 1, tokens_in_sync: 900, tokens_out_sync: 300, units_cached: 2, units_from_archive: 3 }), env);
  const u = (await getJson("status", env, token)).usage.thisMonth;
  assert.deepEqual([u.extractionBatch.calls, u.extractionBatch.input, u.extractionBatch.output], [4, 4000, 800]);
  assert.deepEqual([u.extraction.calls, u.extraction.input, u.extraction.output, u.extraction.reused], [1, 900, 300, 5]);
  await pi("relay/report", relay("report", "POST", { mode: "scan" }), env);
  assert.equal((await getJson("status", env, token)).usage.thisMonth.extraction.calls, 1, "a quiet scan adds nothing");
});

test("partner_intel: Ask sends the fallback beta header, summaries do not", async () => {
  const rows = SOLVERS();
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  const heads = [];
  await withFetch(expanding((url, init) => { heads.push(init.headers["anthropic-beta"]); return rankOut([
    { company_id: "c-a", strength: "high", why: "Built it.", evidence_ids: [rows[0].id], caution: "" }]); }),
  () => pi("ask", piReq("ask", "POST", { question: "Who has an AI powered quality inspection system?" }, token), env));
  assert.deepEqual(heads, ["server-side-fallback-2026-07-01"]);
});

test("partner_intel: with no forced tool choice, an answer that skips the tool is asked once more, then is an error", async () => {
  const { env, token } = await piEnv(trendingRows(), { partner_intel_claude_api: "k" });
  let calls = 0;
  const textOnly = () => okJson({ content: [{ type: "text", text: "Here are your summaries." }], stop_reason: "end_turn", usage: {} });
  const sum = (handler) => withFetch(handler, () => pi("summarize", piReq("summarize", "POST", { days: 30, topics: ["quality"] }, token), env));
  const second = await (await sum((url, init) => { calls++;
    return calls === 1 ? textOnly() : summaryOut(topicsIn(init).payload, (t) => ({ topic_id: t.topic_id,
      bullets: [{ text: "Real.", evidence_ids: [t.evidence[0].id] }] })); })).json();
  assert.equal(calls, 2, "asked again after an answer with no tool call");
  assert.equal(second.summaries.quality.bullets[0].text, "Real.");
  const { env: env2, token: token2 } = await piEnv(trendingRows(), { partner_intel_claude_api: "k" });
  let tries = 0;
  const failed = await withFetch(() => { tries++; return textOnly(); },
    () => pi("summarize", piReq("summarize", "POST", { days: 30, topics: ["quality"] }, token2), env2));
  assert.equal(failed.status, 502);
  assert.equal(tries, 2, "two tries, not a loop");
});

test("partner_intel: a declined request is a clear error and is not saved", async () => {
  const rows = SOLVERS();
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  const res = await withFetch(() => okJson({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms" } }),
    () => pi("ask", piReq("ask", "POST", { question: "Who has an AI powered quality inspection system?" }, token), env));
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /declined.*general_harms/);
  assert.equal([...env.BOX_KV.store.keys()].filter((k) => k.startsWith("pi:ask:") && k !== "pi:ask:recent").length, 0);
});

/* ------------------------------------------------ partner_intel: contact list, statements to check, source links */
const cell = (ref, v) => `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;
function contactsXlsx(people) {
  const head = ["First Name", "Last Name", "Title", "Account Name", "Email"];
  const rows = [`<row r="1">${head.map((h, n) => cell(`${"ABCDE"[n]}1`, h)).join("")}</row>`];
  people.forEach((p, k) => {
    const r = k + 2;
    rows.push(`<row r="${r}">${p.map((v, n) => (v === true ? `<c r="${"ABCDE"[n]}${r}" t="b"><v>1</v></c>`
      : typeof v === "number" ? `<c r="${"ABCDE"[n]}${r}"><v>${v}</v></c>` : cell(`${"ABCDE"[n]}${r}`, v))).join("")}</row>`);
  });
  const xml = `<?xml version="1.0"?><worksheet><sheetData>${rows.join("")}</sheetData></worksheet>`;
  return Buffer.from(buildZip({ "xl/worksheets/sheet1.xml": xml })).toString("base64");
}
const CONTACT_ROWS = [
  ["Ben", "Larson", "Site Director", "Acme Corp", "ben.larson@acme.com"],
  ["Sarah", true, "RN", "Beta Works", "sarah.true@beta.com"],          // Excel turned "True" into a TRUE cell
  [3637, "Titzer", "Engineer", "Beta Works", "matt.titzer@beta.com"],  // and a first name into a number
  ["", "", "", "Beta Works", "info@beta.com"],                          // no usable name
  ["Ben", "Larson", "Site Director", "Acme Corp", "ben.larson@acme.com"], // duplicate
  ["Robert", "King", "", "Acme Corp", ""],
  ["Robert", "King", "", "Beta Works", ""],
  ["Ann", "Other", "", "Unlisted Co", ""],
];

test("partner_intel: a contact list uploads as .xlsx, repairs names Excel damaged, and says what it found", async () => {
  const { env, token } = await piEnv([]);
  const data = contactsXlsx(CONTACT_ROWS);
  const preview = await (await pi("contacts/import", piReq("contacts/import", "POST", { fileName: "All_Council_Contacts.xlsx", data, preview: true }, token), env)).json();
  const s = preview.summary;
  assert.deepEqual([s.kept, s.repaired, s.duplicates, s.noName, s.sameNameTwoCompanies], [6, 2, 1, 1, 1]);
  assert.deepEqual([s.companies, s.companiesMatched, s.contactsAtUnlistedCompanies], [3, 2, 1]);
  assert.equal(await env.BOX_KV.get("pi:contacts"), null, "a preview saves nothing");
  const before = JSON.parse(await env.BOX_KV.get("pi:roster")).updatedAt;
  assert.equal((await pi("contacts/import", piReq("contacts/import", "POST", { fileName: "All_Council_Contacts.xlsx", data }, token), env)).status, 200);
  const relayed = await (await pi("relay/roster", relay("roster", "GET"), env)).json();
  const names = relayed.contacts.map((c) => c.name);
  assert.ok(names.includes("Sarah True") && names.includes("Matt Titzer"), "repaired from first.last@ email addresses");
  assert.equal(relayed.contacts.find((c) => c.name === "Ben Larson").account, "Acme Corp");
  assert.notEqual(JSON.parse(await env.BOX_KV.get("pi:roster")).updatedAt, before, "saving asks for a Re-link");
  assert.equal((await getJson("status", env, token)).relinkNeeded, true);
  assert.equal((await getJson("status", env, token)).contacts.summary.kept, 6);
});

test("partner_intel: a company page lists everyone on file there: the uploaded contacts and the roster names, once each", async () => {
  const { env, token } = await piEnv([ins({ company_id: "c-a" })]);
  const before = (await getJson("company?id=c-a", env, token)).company.people;
  assert.deepEqual(before, [{ name: "Ann A", title: "", email: "", source: "roster" }], "with no upload, the roster name alone");
  const data = contactsXlsx([
    ["Ben", "Larson", "Site Director", "Acme Corp", "ben.larson@acme.com"],
    ["Ann", "A", "President", "ACME CORP", "ann@acme.com"],      // on the roster too, company written differently
    ["Robert", "King", "", "Acme Corp", ""],
    ["Bob", "Other", "Buyer", "Beta Works", "bob@beta.com"],    // another partner's contact
  ]);
  assert.equal((await pi("contacts/import", piReq("contacts/import", "POST", { fileName: "contacts.xlsx", data }, token), env)).status, 200);
  const people = (await getJson("company?id=c-a", env, token)).company.people;
  assert.deepEqual(people.map((x) => [x.name, x.title, x.email, x.source]), [
    ["Ann A", "President", "ann@acme.com", "both"],
    ["Ben Larson", "Site Director", "ben.larson@acme.com", "upload"],
    ["Robert King", "", "", "upload"],
  ], "every Acme contact, the roster name merged with its upload, nobody from Beta Works");
  assert.deepEqual((await getJson("company?id=c-c", env, token)).company.people, [], "a partner with no contacts lists nobody");
});

test("partner_intel: a contact list also uploads as CSV, and a file without a company or name column is refused", async () => {
  const { env, token } = await piEnv([]);
  const csv = (t) => Buffer.from(t).toString("base64");
  const ok = await (await pi("contacts/import", piReq("contacts/import", "POST",
    { fileName: "c.csv", data: csv("Name,Company,Email\nBen Larson,Acme Corp,b@a.com\n"), preview: true }, token), env)).json();
  assert.equal(ok.summary.kept, 1);
  const noCompany = await pi("contacts/import", piReq("contacts/import", "POST", { fileName: "c.csv", data: csv("First Name,Last Name\nA,B\n") }, token), env);
  assert.equal(noCompany.status, 400);
  assert.equal((await pi("contacts/import", piReq("contacts/import", "POST", { data: csv("x") }), env)).status, 401);
});

/** Rows as the build leaves them: one credited to Beta Works while Ben Larson of Acme spoke. */
function checkRows() {
  return [
    ins({ title: "Leaders lack AI expertise", company_id: "c-b", speaker: "Ben Larson", review: ["speaker_company_conflict", "company_differs_from_file"],
      company_options: [{ id: "c-a", why: "Ben Larson works at Acme Corp" }], sources: [{ id: "2512011882069", name: "Ben Larson - Acme.txt", path: "Notes/IC" }] }),
    ins({ title: "A settled statement", company_id: "c-a" }),
  ];
}

test("partner_intel: BUG a statement credited to the wrong company could not be corrected; staff now settle it on the control panel", async () => {
  const { env, token } = await piEnv(checkRows());
  const list = await getJson("attribution/review", env, token);
  assert.equal(list.total, 1, "only the statement in doubt is listed");
  const item = list.items[0];
  assert.equal(item.company.name, "Beta Works");
  assert.deepEqual(item.options.map((o) => [o.name, o.why]), [["Acme Corp", "Ben Larson works at Acme Corp"]]);
  assert.equal(item.checkCompany, true);
  assert.equal(item.sources[0].url, "https://app.box.com/file/2512011882069");
  assert.equal((await getJson("status", env, token)).toCheck, 1);

  assert.equal((await pi("attribution/decide", piReq("attribution/decide", "POST", { id: item.id, companyId: "c-a" }, token), env)).status, 200);
  const after = await getJson("insights?days=30", env, token);
  const fixed = after.items.find((i) => i.id === item.id);
  assert.equal(fixed.company.name, "Acme Corp", "the decision applies at once, with no scan");
  assert.equal(fixed.checkCompany, false, "and the Check company marker is gone");
  assert.equal((await getJson("attribution/review", env, token)).total, 0);
  // A later publish of the same statement keeps the decision.
  await publishV2(env, checkRows().map((r, n) => ({ ...r, id: n ? r.id : item.id })));
  assert.equal((await getJson("insights?days=30", env, token)).items.find((i) => i.id === item.id).company.name, "Acme Corp");
});

test("partner_intel: keeping the current company clears the check; bad decisions are refused", async () => {
  const { env, token } = await piEnv(checkRows());
  const id = (await getJson("attribution/review", env, token)).items[0].id;
  const decide = (body, t = token) => pi("attribution/decide", piReq("attribution/decide", "POST", body, t), env);
  assert.equal((await decide({ id: "__proto__", companyId: "c-a" })).status, 404);
  assert.equal((await decide({ id: "ffffffffffff", companyId: "c-a" })).status, 404);
  assert.equal((await decide({ id, companyId: "constructor" })).status, 400, "only a known company");
  assert.equal((await decide({ id, keep: true }, "")).status, 401);
  assert.equal((await decide({ id, keep: true })).status, 200);
  const kept = (await getJson("insights?days=30", env, token)).items.find((i) => i.id === id);
  assert.equal(kept.company.name, "Beta Works");
  assert.equal(kept.checkCompany, false);
  assert.equal(Object.getPrototypeOf(JSON.parse(await env.BOX_KV.get("pi:attribution")).decisions), Object.prototype);
});

test("partner_intel: BUG a quote was sometimes shown without its file; every quote now carries the file name and a Box link", async () => {
  const rows = [ins({ kind: "win", urgency: "none", company_id: "c-a", meeting_id: "m-1", meeting_label: "Acme visit", meeting_kind: "company",
    sources: [{ id: "123", name: "Acme - notes.docx", path: "Raw Notes/Site Visits" }, { id: "local-x", name: "draft.txt", path: "Raw Notes/Site Visits" }] })];
  const { env, token } = await piEnv(rows);
  const win = (await getJson("company/topics?id=c-a&list=wins", env, token)).byTopic[0].items[0];
  assert.deepEqual(win.sources.map((x) => [x.name, x.url]), [["Acme - notes.docx", "https://app.box.com/file/123"], ["draft.txt", ""]],
    "the company page's quotes carry their files; an id that is not a Box id gets no link");
  const program = await getJson("program?name=Site%20Visits", env, token);
  assert.deepEqual(program.meetings[0].files.map((f) => f.url), ["https://app.box.com/file/123", ""]);
});

test("partner_intel: BUG a company page listed its source documents with no file and no link to Box", async () => {
  const visit = (over) => ins({ company_id: "c-a", date: "2026-10-05", meeting_id: "m-v", meeting_label: "Acme Corp", meeting_kind: "company",
    sources: [{ id: "111", name: "Acme - 10.05.26.docx", path: "Raw Notes/Site Visits" }], ...over });
  const rows = [visit({}), visit({ kind: "win", urgency: "none", sources: [{ id: "111", name: "Acme - 10.05.26.docx", path: "Raw Notes/Site Visits" },
    { id: "112", name: "Acme - transcript.txt", path: "Raw Notes/Site Visits" }] }),
  ins({ company_id: "c-a", date: "2026-09-01", meeting_id: "m-c", meeting_label: "Cohort 2", meeting_kind: "cohort",
    sources: [{ id: "222", name: "Cohort 2.docx", path: "Raw Notes/PCN" }] })];
  const { env, token } = await piEnv(rows);
  const p = await getJson("company?id=c-a", env, token);
  assert.deepEqual(p.meetings.map((m) => [m.date, m.label, m.programs, m.files.map((f) => [f.name, f.url])]), [
    ["2026-10-05", "Acme Corp", ["Site Visits"], [["Acme - 10.05.26.docx", "https://app.box.com/file/111"], ["Acme - transcript.txt", "https://app.box.com/file/112"]]],
    ["2026-09-01", "Cohort 2", ["PCN"], [["Cohort 2.docx", "https://app.box.com/file/222"]]],
  ], "one line per meeting, every file behind it once, each linked to Box");
  assert.equal(p.counts.meetings, 2);
});

test("partner_intel: a company page's See all buttons count what their lists hold, problems including asks", async () => {
  const rows = [
    ins({ company_id: "c-a", kind: "problem" }), ins({ company_id: "c-a", kind: "problem", status: "resolved" }),
    ins({ company_id: "c-a", kind: "ask" }), ins({ company_id: "c-a", kind: "win", urgency: "none" }),
    ins({ company_id: "c-a", kind: "solution", urgency: "none" }), ins({ company_id: "c-a", kind: "offer", urgency: "none" }),
    ins({ company_id: "c-a", kind: "equipment", urgency: "none" }), ins({ company_id: "c-a", kind: "news", urgency: "none" }),
    ins({ company_id: "c-b", kind: "problem" }),
  ];
  const { env, token } = await piEnv(rows);
  const p = await getJson("company?id=c-a", env, token);
  assert.deepEqual([p.counts.wins, p.counts.problems, p.counts.solutions], [1, 3, 3]);
  // The list pages ask the insights route for exactly these kinds, for this company only.
  const list = async (kinds) => (await getJson(`insights?company=c-a&kind=${encodeURIComponent(kinds)}&sort=date&limit=50`, env, token)).total;
  assert.deepEqual([await list("win"), await list("problem|ask"), await list("solution|offer|equipment")], [1, 3, 3],
    "each button's count matches the list it opens, resolved problems included");
});

// The topic tabs rank topics by mentions (each row, but not a resolved issue) weighted by recency.
// Each case below fails if one half of that is dropped:
//   talent: 3 issues in one meeting 300 days ago (3 x 0.375 = 1.13): more mentions beat one
//     recent one, and rows count, not meetings;
//   quality: 1 issue 2 days ago (0.99);
//   ai: 2 issues 400 days ago (0.62) and a resolved one yesterday: old and resolved count less.
function issueRows() {
  const p = (over) => ins({ company_id: "c-a", kind: "problem", ...over });
  return [
    p({ title: "t1", topic: "talent_pipeline", date: isoAgo(300), meeting_id: "m-t", meeting_label: "Cohort 1" }),
    p({ title: "t2", topic: "talent_pipeline", date: isoAgo(300), meeting_id: "m-t", meeting_label: "Cohort 1" }),
    p({ title: "t3", topic: "talent_pipeline", date: isoAgo(300), meeting_id: "m-t", meeting_label: "Cohort 1", kind: "ask" }),
    p({ title: "q1", topic: "quality", date: isoAgo(2), meeting_id: "m-q", meeting_label: "Acme Corp" }),
    p({ title: "a1", topic: "ai_adoption", date: isoAgo(400), meeting_id: "m-a1", meeting_label: "Acme Corp" }),
    p({ title: "a2", topic: "ai_adoption", date: isoAgo(401), meeting_id: "m-a2", meeting_label: "Acme Corp" }),
    p({ title: "a3", topic: "ai_adoption", date: isoAgo(1), meeting_id: "m-a3", meeting_label: "Acme Corp", status: "resolved" }),
    // The newest notes: no topic, so "Other", which always goes last.
    p({ title: "o-low", topic: "other", date: isoAgo(0), meeting_id: "m-new", meeting_label: "Acme visit", urgency: "low",
      sources: [{ id: "333", name: "Acme visit.docx", path: "Raw Notes/Site Visits" }] }),
    p({ title: "o-high", topic: "other", date: isoAgo(0), meeting_id: "m-new", meeting_label: "Acme visit", urgency: "high",
      sources: [{ id: "333", name: "Acme visit.docx", path: "Raw Notes/Site Visits" }, { id: "x9", name: "draft.txt", path: "Raw Notes/Site Visits" }] }),
    p({ title: "o-done", topic: "other", date: isoAgo(0), meeting_id: "m-new", meeting_label: "Acme visit", urgency: "high", status: "resolved",
      sources: [{ id: "333", name: "Acme visit.docx", path: "Raw Notes/Site Visits" }] }),
    p({ title: "internal", topic: "quality", date: isoAgo(0), meeting_id: "m-i", meeting_label: "Board", scope: "internal" }),
    ins({ company_id: "c-b", title: "beta", topic: "quality", date: isoAgo(0) }),
    ins({ company_id: "c-a", kind: "win", urgency: "none", topic: "quality", date: isoAgo(0) }),
  ];
}
const topicsOf = (env, token, list, id = "c-a") => getJson(`company/topics?id=${id}&list=${list}`, env, token);

test("partner_intel: the Issues tab groups issues by topic, ranked by mentions and recency", async () => {
  const { env, token } = await piEnv(issueRows());
  const r = await topicsOf(env, token, "issues");
  assert.deepEqual(r.byTopic.map((t) => [t.label, t.issues, t.meetings, t.resolved]), [
    ["Talent pipeline and recruiting", 3, 1, 0],
    ["Quality systems and inspection", 1, 1, 0],
    ["AI adoption and governance", 2, 2, 1],
    ["Other", 2, 1, 1],
  ], "three old mentions beat one new one, one new beats two very old, a resolved issue adds nothing, Other is last");
  assert.ok(r.byTopic[0].priority > r.byTopic[1].priority && r.byTopic[1].priority > r.byTopic[2].priority);
  assert.deepEqual(r.byTopic[2].items.map((i) => i.title), ["a1", "a2", "a3"], "open issues first, newest first, resolved at the end");
  assert.equal(r.byTopic[2].last, isoAgo(400), "the latest date is the latest open issue's");
  assert.deepEqual([r.total, r.mentions], [10, 8], "issues and asks of this company only, internal rows left out");
});

test("partner_intel: the Meetings tab lists every meeting newest first, each with all its notes by topic", async () => {
  const rows = [
    ...issueRows(),
    ins({ company_id: "c-a", kind: "win", urgency: "none", title: "w-new", topic: "talent_pipeline", date: isoAgo(0), meeting_id: "m-new", meeting_label: "Acme visit" }),
    ins({ company_id: "c-a", kind: "news", urgency: "none", title: "n-old", topic: "quality", date: isoAgo(300), meeting_id: "m-t", meeting_label: "Cohort 1" }),
  ];
  // Thirteen more meetings, so the list runs past the 12 the Latest source view keeps.
  for (let k = 0; k < 13; k++) rows.push(ins({ company_id: "c-a", title: "x" + k, date: isoAgo(500 + k), meeting_id: "m-x" + k, meeting_label: "Old " + k }));
  const { env, token } = await piEnv(rows);
  const r = await getJson("company/meetings?id=c-a", env, token);
  assert.equal(r.meetings.length, 20, "every meeting, not only the newest 12");
  assert.ok(r.meetings.every((m, k) => !k || r.meetings[k - 1].date >= m.date), "newest first");
  const visit = r.meetings.find((m) => m.label === "Acme visit");
  assert.deepEqual(visit.topics.map((t) => t.label), ["Talent pipeline and recruiting", "Other"], "its notes grouped by topic, Other last");
  assert.deepEqual(visit.topics[1].items.map((i) => i.title), ["o-high", "o-low", "o-done"], "open notes first, a resolved one last");
  assert.deepEqual(visit.files.map((f) => f.name), ["Acme visit.docx", "draft.txt", "notes.docx"], "every file its notes came from");
  const cohort = r.meetings.find((m) => m.label === "Cohort 1");
  assert.ok(cohort.topics.some((t) => t.items.some((i) => i.title === "n-old")), "notes of every kind, not only issues, solutions and wins");
  assert.ok(!r.meetings.some((m) => m.label === "Board"), "internal rows are left out");
  assert.equal(r.total, rows.filter((i) => i.company_id === "c-a" && i.scope !== "internal").length);
  assert.equal((await pi("company/meetings", piGet("company/meetings?id=nope", token), env)).status, 404);
});

test("partner_intel: the latest source names its meeting and files, and lists its newest notes first", async () => {
  const { env, token } = await piEnv(issueRows());
  const r = await topicsOf(env, token, "issues");
  const s = r.latest[0];
  assert.deepEqual([s.date, s.label, s.programs, s.count], [isoAgo(0), "Acme visit", ["Site Visits"], 3], "the newest meeting comes first");
  assert.deepEqual(s.topics.map((t) => [t.label, t.items.map((i) => i.title)]), [["Other", ["o-high", "o-low", "o-done"]]],
    "grouped by topic; inside a topic the most urgent first, resolved last");
  assert.deepEqual(s.files.map((f) => [f.name, f.url]), [["Acme visit.docx", "https://app.box.com/file/333"], ["draft.txt", ""]],
    "each file once, linked to Box when it has a Box id");
  assert.deepEqual(r.latest.map((x) => x.date), [isoAgo(0), isoAgo(1), isoAgo(2), isoAgo(300), isoAgo(400), isoAgo(401)]);
  assert.equal(r.sourceTotal, 6);
  assert.deepEqual(r.latest[3].topics[0].items.map((i) => i.title).sort(), ["t1", "t2", "t3"], "one source per meeting");
});

test("partner_intel: the latest source ranks its topics by how often they came up in that meeting", async () => {
  const m = (over) => ins({ company_id: "c-a", date: isoAgo(3), meeting_id: "m-1", meeting_label: "Acme visit", ...over });
  const { env, token } = await piEnv([
    m({ topic: "ai_adoption" }), m({ topic: "ai_adoption", status: "resolved" }), m({ topic: "ai_adoption", status: "resolved" }),
    m({ topic: "talent_pipeline" }), m({ topic: "talent_pipeline" }),
    m({ topic: "quality" }), m({ topic: "quality" }), m({ topic: "quality", kind: "ask" }),
    ins({ company_id: "c-a", topic: "ai_adoption", date: isoAgo(30), meeting_id: "m-0", meeting_label: "Older" }),
    ins({ company_id: "c-a", topic: "ai_adoption", date: isoAgo(31), meeting_id: "m-00", meeting_label: "Older" }),
    ins({ company_id: "c-a", topic: "ai_adoption", date: isoAgo(32), meeting_id: "m-000", meeting_label: "Older" }),
  ]);
  const r = await topicsOf(env, token, "issues");
  assert.deepEqual(r.latest[0].topics.map((t) => [t.topic, t.issues, t.resolved]),
    [["quality", 3, 0], ["talent_pipeline", 2, 0], ["ai_adoption", 1, 2]],
    "counted in this meeting only: AI's older meetings and its resolved issues do not lift it");
  assert.equal(r.byTopic[0].topic, "ai_adoption", "across all the notes, AI leads");
});

test("partner_intel: the Solutions and Wins tabs rank their topics the same way", async () => {
  const { env, token } = await piEnv([
    ins({ kind: "solution", urgency: "none", topic: "quality", date: isoAgo(200) }),
    ins({ kind: "offer", urgency: "none", topic: "quality", date: isoAgo(200) }),
    ins({ kind: "equipment", urgency: "none", topic: "quality", date: isoAgo(200) }),
    ins({ kind: "solution", urgency: "none", topic: "ai_adoption", date: isoAgo(1) }),
    ins({ kind: "win", urgency: "none", topic: "talent_pipeline", date: isoAgo(400) }),
    ins({ kind: "win", urgency: "none", topic: "ai_adoption", date: isoAgo(1) }),
    ins({ kind: "problem", topic: "talent_pipeline", date: isoAgo(1) }),
    ins({ kind: "news", urgency: "none", topic: "talent_pipeline", date: isoAgo(1) }),
  ]);
  const sol = await topicsOf(env, token, "solutions");
  assert.deepEqual(sol.byTopic.map((t) => [t.topic, t.solutions]), [["quality", 3], ["ai_adoption", 1]],
    "solutions, offers and equipment count; three from 200 days ago beat one from yesterday");
  assert.equal(sol.total, 4);
  const wins = await topicsOf(env, token, "wins");
  assert.deepEqual(wins.byTopic.map((t) => [t.topic, t.wins]), [["ai_adoption", 1], ["talent_pipeline", 1]], "one recent win beats one old one");
  assert.equal(wins.total, 2, "wins only");
});

test("partner_intel: the Overview ranks topics by issues, solutions and wins together", async () => {
  const { env, token } = await piEnv([
    // Created wins first, so only the category order puts issues first.
    ins({ kind: "win", urgency: "none", topic: "quality", date: isoAgo(10) }),
    ins({ kind: "offer", urgency: "none", topic: "quality", date: isoAgo(10) }),
    ins({ kind: "solution", urgency: "none", topic: "quality", date: isoAgo(10) }),
    ins({ kind: "problem", topic: "quality", date: isoAgo(10) }),
    ins({ kind: "problem", topic: "talent_pipeline", date: isoAgo(10) }),
    ins({ kind: "ask", topic: "talent_pipeline", date: isoAgo(10) }),
    ins({ kind: "problem", topic: "talent_pipeline", date: isoAgo(10) }),
    ins({ kind: "problem", topic: "ai_adoption", date: isoAgo(10) }),
    ins({ kind: "problem", topic: "ai_adoption", date: isoAgo(10), status: "resolved" }),
    ins({ kind: "problem", topic: "ai_adoption", date: isoAgo(10), status: "resolved" }),
    ins({ kind: "problem", topic: "ai_adoption", date: isoAgo(10), status: "resolved" }),
    ins({ kind: "commitment", urgency: "none", topic: "ai_adoption", date: isoAgo(10) }),
    ins({ kind: "news", urgency: "none", topic: "ai_adoption", date: isoAgo(10) }),
  ]);
  const o = await topicsOf(env, token, "all");
  assert.deepEqual(o.byTopic.map((t) => [t.topic, t.issues, t.solutions, t.wins, t.resolved, t.mentions]), [
    ["quality", 1, 2, 1, 0, 4],
    ["talent_pipeline", 3, 0, 0, 0, 3],
    ["ai_adoption", 1, 0, 0, 3, 1],
  ], "one issue, two solutions and a win outrank three issues; resolved issues, news and commitments add nothing");
  assert.deepEqual(o.byTopic[0].items.map((i) => i.kind), ["problem", "offer", "solution", "win"], "issues, then solutions, then wins");
  assert.equal(o.total, 11, "news and commitments are not on the Overview");
  assert.equal(o.latest[0].topics[0].topic, "quality", "the latest source is grouped and ranked the same way");
});

test("partner_intel: the topic view refuses an unknown list or company", async () => {
  const { env, token } = await piEnv(issueRows());
  const status = async (q) => (await pi("company/topics", piGet(`company/topics?${q}`, token), env)).status;
  assert.equal(await status("id=c-a&list=constructor"), 400, "a list name never resolves through Object.prototype");
  assert.equal(await status("id=c-a"), 400);
  assert.equal(await status("id=nope&list=issues"), 404);
  assert.equal(await status("id=constructor&list=all"), 404);
});

test("partner_intel: the companies page is alphabetical by default and sorts by any column", async () => {
  const rows = [
    ins({ company_id: "c-a", kind: "problem", date: isoAgo(40) }), ins({ company_id: "c-a", kind: "ask", date: isoAgo(40) }),
    ins({ company_id: "c-b", kind: "win", urgency: "none", date: isoAgo(2) }), ins({ company_id: "c-b", kind: "win", urgency: "none", date: isoAgo(3) }),
    ins({ company_id: "c-b", kind: "solution", urgency: "none", date: isoAgo(3) }),
    ins({ company_id: "c-c", kind: "problem", date: isoAgo(10) }),
  ];
  const { env, token } = await piEnv(rows);
  const names = async (q = "") => (await getJson(`companies?withInsights=1${q}`, env, token)).items.map((c) => c.name);
  assert.deepEqual(await names(), ["Acme Corp", "Beta Works", "Gamma Labs"], "alphabetical when no sort is chosen");
  assert.deepEqual(await names("&sort=name&dir=desc"), ["Gamma Labs", "Beta Works", "Acme Corp"]);
  assert.deepEqual(await names("&sort=insights"), ["Beta Works", "Acme Corp", "Gamma Labs"], "a number sorts largest first, ties by name");
  assert.deepEqual(await names("&sort=problems"), ["Acme Corp", "Gamma Labs", "Beta Works"], "problems include asks, as on the company page");
  assert.deepEqual(await names("&sort=wins&dir=asc"), ["Acme Corp", "Gamma Labs", "Beta Works"]);
  assert.deepEqual(await names("&sort=last"), ["Beta Works", "Gamma Labs", "Acme Corp"], "newest mention first");
  assert.deepEqual(await names("&sort=status"), ["Acme Corp", "Beta Works", "Gamma Labs"], "members, then former members");
  assert.deepEqual(await names("&sort=constructor"), ["Acme Corp", "Beta Works", "Gamma Labs"], "an unknown column falls back to the name");
  const roster = JSON.parse(await env.BOX_KV.get("pi:roster"));
  roster.partners.push({ id: "c-d", name: "Delta Co", industry: "Metals", status: "Active", program: "", participationId: "", contacts: [], aliases: [] });
  roster.updatedAt = "r2";
  await env.BOX_KV.put("pi:roster", JSON.stringify(roster));
  for (const dir of ["desc", "asc"]) {
    const items = (await getJson(`companies?sort=last&dir=${dir}`, env, token)).items;
    assert.equal(items[items.length - 1].name, "Delta Co", `a company never mentioned sorts last (${dir})`);
  }
});

test("partner_intel: Find solution asks for other partners, never the company that has the problem", async () => {
  const rows = [
    ins({ kind: "solution", urgency: "none", company_id: "c-a", title: "Machine vision quality inspection", detail: "Built AI camera inspection.", tags: ["vision", "inspection"], solves: "manual inspection" }),
    ins({ kind: "offer", urgency: "none", company_id: "c-b", title: "Vision inspection integration", detail: "Offers machine vision inspection setup.", tags: ["vision", "inspection"], solves: "manual inspection" }),
  ];
  const { env, token } = await piEnv(rows);
  const ask = async (body) => (await pi("ask", piReq("ask", "POST", body, token), env)).json();
  const question = "Who can help with this: Manual inspection misses defects. We need machine vision inspection.";
  const open = await ask({ question });
  assert.deepEqual(open.matches.map((m) => m.company.id).sort(), ["c-a", "c-b"]);
  const excluded = await ask({ question, exclude: "c-a" });
  assert.deepEqual(excluded.matches.map((m) => m.company.id), ["c-b"], "the company with the problem is left out");
  assert.deepEqual((await ask({ question, exclude: "constructor" })).matches.map((m) => m.company.id).sort(), ["c-a", "c-b"],
    "an unknown company to exclude is ignored");
});

/** The CMMC question from the field, and the real notes that answer it (from the Box export),
 * among ordinary notes about other things. */
const CMMC_QUESTION = "CMMC work limits what can be put into AI\nCompany is still in the middle of CMMC and unsure what can be put into AI tools.";
function cmmcRows() {
  const sol = (company, title, detail, tags = [], kind = "solution") => ins({ kind, urgency: "none", status: "not_applicable", company_id: company,
    title, detail, tags, solves: "", topic: "ai_adoption", meeting_id: `m-${company}-${title.length}`, meeting_label: company });
  const prob = (company, title, detail, kind = "problem") => ins({ kind, urgency: "medium", status: "open", company_id: company, title, detail,
    tags: [], topic: "ai_adoption", meeting_id: `m-${company}-${title.length}`, meeting_label: company });
  const noise = ["Apprenticeship with Ivy Tech for machinists", "Robotic welding cell cut cycle time", "ERP migration to a cloud system",
    "Lean training for supervisors", "Bar-fed machines allow lights-out production", "Vision inspection on the press line",
    "Wage study used to set technician pay", "New CNC lathe added capacity", "Forklift safety program cut incidents",
    "Shared maintenance technicians across shifts", "Supplier scorecards improved on-time delivery", "Solar array lowered energy cost",
    "Customer portal for order status", "Cross-training plan for assemblers", "Predictive maintenance sensors on compressors",
    "Recruiting through high school tours", "Kaizen events every quarter", "3D printed fixtures for assembly", "AI quoting pilot for sheet metal jobs",
    "AI scheduling tool for the paint line"];
  return [
    ...noise.map((t, n) => sol(`c-n${n}`, t, `${t}. Results were reported in the meeting.`, ["operations"])),
    sol("c-evonik", "Secure AI use via Copilot and sanitized offline development",
      "Evonik is compliant and secure within Microsoft Copilot, builds offline without sensitive data, and moves human-vetted code into a private production environment.", ["copilot", "data security"]),
    sol("c-jasper", "Starting small with AI and focusing on data security",
      "The company starts with reasonable first AI projects and avoids putting sensitive information into public models.", ["ai", "data security"]),
    sol("c-astemo", "Corporate Copilot license rolled out with approved AI tools",
      "Corporate approved AI tools with safeguards, including Copilot with Claude and ChatGPT agents, are available.", ["copilot", "ai tools"]),
    sol("c-flexible", "Claude Teams adopted for prints, quoting and tooling",
      "Engineering uses it to evaluate prints, quote, and figure out tooling, keeping ITAR drawings out.", ["claude", "itar"]),
    sol("c-leaf", "Introduce Connexus to Carmel cybersecurity advisory firm",
      "Chad offered to introduce a Carmel-based cybersecurity advisory company working with larger organizations.", ["cybersecurity"], "offer"),
    prob("c-aegis", "CMMC work limits what can be put into AI", "Company is still in the middle of CMMC and unsure what can be put into AI tools."),
    prob("c-ts", "Pursuing CMMC certification with audit this year", "Thomas & Skinner is pursuing CMMC certification, audit scheduled this year, seen as a sales advantage."),
    prob("c-overton", "Complete CMMC certification by 2026", "Overton plans CMMC certification by 2026 for DoD contracts.", "commitment"),
  ];
}
const CMMC_TERMS = ["cybersecurity", "NIST 800-171", "CUI", "ITAR", "data security", "sensitive data", "AI policy", "AI governance",
  "approved AI tools", "Copilot", "compliance"];

test("partner_intel: BUG Ask found no one for a long question, because a note had to share a third of its words", async () => {
  const { shortlist } = await mod("partner_intel.js");
  const data = { insights: cmmcRows() };
  const ids = (opts) => shortlist(CMMC_QUESTION, data, { get: () => null }, {}, new Map(), 10, null, "c-aegis", opts).companies.map((c) => c.id);
  // Without related terms, only the question's own words: the notes that share "AI" and "tools" still come through.
  assert.ok(ids({}).includes("c-astemo"), `a long question still finds notes sharing two of its words (${ids({})})`);
  // With the related terms Claude supplies, the notes that actually answer it come first.
  const found = ids({ terms: CMMC_TERMS });
  for (const id of ["c-evonik", "c-jasper", "c-astemo", "c-flexible", "c-leaf"]) assert.ok(found.includes(id), `${id} is a candidate (${found})`);
  assert.ok(!found.some((id) => /^c-n\d/.test(id) && !["c-n18", "c-n19"].includes(id)), `unrelated notes stay out (${found})`);
  assert.ok(!found.includes("c-aegis"), "never the company that asked");
});

test("partner_intel: Ask searches with related terms, and lists companies working through the same thing", async () => {
  const rows = cmmcRows();
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  let offered = [];
  const handler = (url, init) => {
    const sent = JSON.parse(init.body).messages[0].content;
    offered = [...new Set([...sent.matchAll(/"company_id": "([\w-]+)"/g)].map((m) => m[1]))];
    const evidence = (id) => rows.find((r) => r.company_id === id).id;
    return rankOut(offered.filter((id) => ["c-evonik", "c-jasper"].includes(id)).map((id) => ({ company_id: id, strength: "medium",
      why: "Has secured its own AI use.", evidence_ids: [evidence(id)], caution: "" })));
  };
  const ask = () => withFetch(expanding(handler, CMMC_TERMS), async () =>
    (await pi("ask", piReq("ask", "POST", { question: CMMC_QUESTION, exclude: "c-aegis" }, token), env)).json());
  const a = await ask();
  assert.ok(["c-evonik", "c-jasper", "c-flexible", "c-leaf"].every((id) => offered.includes(id)), `the right notes reach Claude (${offered})`);
  assert.deepEqual(a.matches.map((m) => m.company.id).sort(), ["c-evonik", "c-jasper"]);
  assert.deepEqual(a.searchTerms, CMMC_TERMS, "the page can say what else was searched");
  assert.deepEqual(a.peers.map((p) => p.company.id).sort(), ["c-overton", "c-ts"],
    "companies working through CMMC are listed as peers, never the one that asked");
  assert.ok(a.peers[0].evidence[0].sources, "with their evidence");
});

const PROGRAM_ROWS = () => [
  // PCN: two files for the same cohort and date are one meeting
  ins({ title: "pcn a", topic: "quality", date: "2026-04-24", series: "Cohort 2", event_type: "President and CEO Network Call", meeting_id: "m-c2", meeting_label: "Cohort 2", meeting_kind: "cohort", sources: [{ id: "1", name: "04.24.26 Cohort 2.docx", path: "Raw Notes/PCN" }] }),
  ins({ title: "pcn b", kind: "solution", urgency: "none", topic: "quality", date: "2026-04-24", company_id: "c-b", series: "Cohort 2", event_type: "President and CEO Network Call", meeting_id: "m-c2", meeting_label: "Cohort 2", meeting_kind: "cohort", sources: [{ id: "2", name: "2026-04-24 Cohort 2.txt", path: "Raw Notes/PCN" }] }),
  ins({ title: "pcn c3", topic: "talent_pipeline", date: "2026-05-22", series: "Cohort 3", meeting_id: "m-c3", meeting_label: "Cohort 3", meeting_kind: "cohort", sources: [{ id: "3", name: "05.22.26 Cohort 3.docx", path: "Raw Notes/PCN" }] }),
  // Site visits: one company, one date
  ins({ title: "visit win", kind: "win", urgency: "none", topic: "quality", date: "2026-10-05", company_id: "c-a", meeting_id: "m-v1", meeting_label: "Acme Corp", meeting_kind: "company", sources: [{ id: "4", name: "Acme - 10.05.26.docx", path: "Raw Notes/Site Visits" }] }),
  ins({ title: "visit issue", topic: "talent_pipeline", date: "2026-10-05", company_id: "c-a", meeting_id: "m-v1", meeting_label: "Acme Corp", meeting_kind: "company", sources: [{ id: "4", name: "Acme - 10.05.26.docx", path: "Raw Notes/Site Visits" }] }),
  // Board: internal, one meeting per file
  ins({ title: "board point", topic: "conexus_programs", date: "2026-03-04", scope: "internal", company_id: "", meeting_id: "m-b1", meeting_label: "Conexus Board Minutes March 4 2026", meeting_kind: "meeting", sources: [{ id: "5", name: "Board.docx", path: "Raw Notes/Board Meetings" }] }),
];

test("partner_intel: programs are the source folders, with their counts, dates and an internal flag", async () => {
  const { env, token } = await signedInEnv();
  await env.BOX_KV.put("pi:roster", JSON.stringify({ partners: PARTNERS.map((p) => ({ ...p })), aliases: {}, staff: [], updatedAt: "r1" }));
  await publishV2(env, PROGRAM_ROWS());
  const r = await getJson("programs", env, token);
  assert.equal(r.needsUpdate, false);
  assert.deepEqual(r.programs.map((p) => [p.name, p.meetings, p.notes, p.last, p.internal]), [
    ["Site Visits", 1, 2, "2026-10-05", false], ["PCN", 2, 3, "2026-05-22", false], ["Board Meetings", 1, 1, "2026-03-04", true]]);
  assert.equal((await pi("programs", piGet("programs"), env)).status, 401);
});

test("partner_intel: a program's recent data groups notes into meetings: a cohort, a company visit, or a file", async () => {
  const { env, token } = await signedInEnv();
  await env.BOX_KV.put("pi:roster", JSON.stringify({ partners: PARTNERS.map((p) => ({ ...p })), aliases: {}, staff: [], updatedAt: "r1" }));
  await publishV2(env, PROGRAM_ROWS());
  const pcn = await getJson("program?name=PCN", env, token);
  assert.deepEqual(pcn.meetings.map((m) => [m.label, m.kind, m.date]), [["Cohort 3", "cohort", "2026-05-22"], ["Cohort 2", "cohort", "2026-04-24"]],
    "newest first; the docx and the txt of Cohort 2 on one date are ONE meeting");
  assert.deepEqual(pcn.meetings[1].counts, { issues: 1, solutions: 1, wins: 0, other: 0 });
  assert.deepEqual(pcn.meetings[1].topics, ["Quality systems and inspection"]);
  assert.equal(pcn.meetings[1].files.length, 2);
  const visits = await getJson("program?name=Site%20Visits", env, token);
  assert.deepEqual(visits.meetings.map((m) => [m.label, m.kind, m.counts.wins, m.counts.issues]), [["Acme Corp", "company", 1, 1]]);
  const board = await getJson("program?name=Board%20Meetings", env, token);
  assert.equal(board.meetings.length, 1, "a program shows its own rows even when they are Conexus-internal");
  assert.equal((await pi("program", piGet("program?name=Nope", token), env)).status, 404);
});

test("partner_intel: clicking into a meeting shows its issues, solutions and wins, and only from that program", async () => {
  const { env, token } = await signedInEnv();
  await env.BOX_KV.put("pi:roster", JSON.stringify({ partners: PARTNERS.map((p) => ({ ...p })), aliases: {}, staff: [], updatedAt: "r1" }));
  await publishV2(env, PROGRAM_ROWS());
  const m = await getJson("meeting?program=PCN&id=m-c2", env, token);
  assert.equal(m.meeting.label, "Cohort 2");
  assert.deepEqual([m.issues.map((i) => i.title), m.solutions.map((i) => i.title), m.wins.length], [["pcn a"], ["pcn b"], 0]);
  const v = await getJson("meeting?program=Site%20Visits&id=m-v1", env, token);
  assert.deepEqual([v.issues.length, v.wins.length], [1, 1]);
  assert.equal((await pi("meeting", piGet("meeting?program=Site%20Visits&id=m-c2", token), env)).status, 404, "a meeting id from another program is not found here");
  assert.equal((await pi("meeting", piGet("meeting?program=PCN&id=zzz", token), env)).status, 404);
});

test("partner_intel: each program has its own trending topics, over its own window", async () => {
  const { env, token } = await signedInEnv();
  await env.BOX_KV.put("pi:roster", JSON.stringify({ partners: PARTNERS.map((p) => ({ ...p })), aliases: {}, staff: [], updatedAt: "r1" }));
  const rows = [
    ins({ topic: "quality", company_id: "c-a", date: isoAgo(10), sources: [{ id: "1", name: "a", path: "Raw Notes/PCN" }] }),
    ins({ topic: "quality", company_id: "c-b", date: isoAgo(300), sources: [{ id: "1", name: "a", path: "Raw Notes/PCN" }] }),
    ins({ topic: "talent_pipeline", company_id: "c-b", date: isoAgo(10), sources: [{ id: "2", name: "b", path: "Raw Notes/ADAPT" }] }),
  ];
  await publishV2(env, rows);
  const all = await getJson("program?name=PCN&days=0", env, token);
  assert.deepEqual(all.trending.map((t) => [t.topic, t.companyCount]), [["quality", 2]], "ADAPT's topic is not in PCN's list");
  const recent = await getJson("program?name=PCN&days=90", env, token);
  assert.deepEqual(recent.trending.map((t) => [t.topic, t.companyCount]), [["quality", 1]]);
  assert.equal(recent.meetings.length, 2, "Recent data lists every meeting, whatever the window");
});

test("partner_intel: a program ranks its own topics by companies, as Home does, with no distinctive ranking", async () => {
  const { env, token } = await signedInEnv();
  await env.BOX_KV.put("pi:roster", JSON.stringify({ partners: PARTNERS.map((p) => ({ ...p })), aliases: {}, staff: [], updatedAt: "r1" }));
  const row = (program, meeting, company, topic) => ins({ topic, company_id: company, date: isoAgo(10), meeting_id: meeting,
    meeting_label: meeting, meeting_kind: "meeting", sources: [{ id: `f-${meeting}`, name: `${meeting}.docx`, path: `Raw Notes/${program}` }] });
  const rows = [];
  // In PCN hiring is raised by three companies and quality by two. ADAPT raises hiring too.
  for (const c of ["c-a", "c-b", "c-c"]) rows.push(row("PCN", "p1", c, "talent_pipeline"));
  for (const c of ["c-a", "c-b"]) rows.push(row("PCN", "p2", c, "quality"));
  for (const c of ["c-a", "c-b", "c-c"]) rows.push(row("ADAPT", "a1", c, "talent_pipeline"));
  await publishV2(env, rows);
  const pcn = await getJson("program?name=PCN&days=0&rank=distinct", env, token);
  assert.deepEqual(pcn.trending.map((t) => [t.topic, t.companyCount]), [["talent_pipeline", 3], ["quality", 2]],
    "most companies first, even though every program raises hiring; a stale rank=distinct link is ignored");
  assert.equal(pcn.rank, undefined);
  assert.equal(pcn.trending[0].programShare, undefined, "no comparison with other programs is sent");
});

test("partner_intel: data published before meetings existed is still grouped, and says an update is needed", async () => {
  const { env, token } = await signedInEnv();
  await env.BOX_KV.put("pi:roster", JSON.stringify({ partners: PARTNERS.map((p) => ({ ...p })), aliases: {}, staff: [], updatedAt: "r1" }));
  await pi("relay/publish", relay("publish", "POST", { version: "old", generated_at: "x", roster_updated_at: "r1", topics: TOPICS, events: [],
    insights: [
      ins({ date: "2026-04-24", series: "Cohort 2", event_type: "President and CEO Network Call", sources: [{ id: "1", name: "c2.docx", path: "Raw Notes/PCN" }] }),
      ins({ date: "2026-04-24", company_id: "c-a", series: "Workshop", event_type: "Workshop", sources: [{ id: "2", name: "w.docx", path: "Raw Notes/PCN" }] }),
    ], companies: [], unmatched: [], stats: {} }), env);
  const r = await getJson("program?name=PCN", env, token);
  assert.equal(r.needsUpdate, true);
  assert.deepEqual(r.meetings.map((m) => [m.label, m.kind]).sort(), [["Acme Corp", "company"], ["Cohort 2", "cohort"]]);
  assert.equal((await getJson("programs", env, token)).needsUpdate, true);
});

const apply = (env, token, id = "programs-v1") => pi("update/apply", piReq("update/apply", "POST", { id }, token), env);

test("partner_intel: the one-time update is offered once, runs a rebuild only, and is gone after one use", async () => {
  const { env, token } = await piEnv([ins()]);            // data from before the update (schema 1)
  const offered = (await getJson("status", env, token)).oneTimeUpdate;
  assert.equal(offered.id, "programs-v1");
  assert.match(offered.body, /no Claude/i);
  let sent = [];
  const handler = (url, init) => { sent.push(JSON.parse(init.body)); return new Response(null, { status: 204 }); };
  const res = await withFetch(handler, () => apply(env, token));
  assert.equal(res.status, 200);
  assert.deepEqual(sent[0].inputs, { mode: "rebuild", limit: "0", force: "false" }, "a rebuild: no Box, no Claude, not a re-scan");
  assert.equal((await getJson("status", env, token)).oneTimeUpdate, null, "the card is gone even though the new data has not published yet");
  const again = await withFetch(handler, () => apply(env, token));
  assert.equal(again.status, 409, "single use");
  assert.equal(sent.length, 1, "and the second click started nothing");
});

test("partner_intel: a one-time update that could not start is not used up, and one the data does not need is never offered", async () => {
  const { env, token } = await piEnv([ins()]);
  const failed = await withFetch(() => new Response("nope", { status: 403 }), () => apply(env, token));
  assert.equal(failed.status, 502);
  assert.equal((await getJson("status", env, token)).oneTimeUpdate.id, "programs-v1", "still offered: nothing ran");
  const ok = await withFetch(() => new Response(null, { status: 204 }), () => apply(env, token));
  assert.equal(ok.status, 200);
  assert.equal((await apply(env, token, "something-else")).status, 409, "an unknown update id is refused");

  const fresh = await signedInEnv();
  await fresh.env.BOX_KV.put("pi:roster", JSON.stringify({ partners: [], aliases: {}, staff: [], updatedAt: "r1" }));
  await publishV2(fresh.env, [ins()]);
  assert.equal((await getJson("status", fresh.env, fresh.token)).oneTimeUpdate, null, "current data needs no update");
  assert.equal((await withFetch(() => new Response(null, { status: 204 }), () => apply(fresh.env, fresh.token))).status, 409);
  const empty = await signedInEnv();
  assert.equal((await getJson("status", empty.env, empty.token)).oneTimeUpdate, null, "nothing to update before the first scan");
  assert.equal((await pi("update/apply", piReq("update/apply", "POST", { id: "programs-v1" }), env)).status, 401);
});

/* ------------------------------------------------------------------------- runner */
/* ------------------------------------------------------------- Ask box and Ask page (assistant) */

const answerOut = (answer, followUps = []) => okJson({ content: [{ type: "tool_use", name: "write_answer", input: { answer, follow_ups: followUps } }],
  usage: { input_tokens: 900, output_tokens: 120 } });
/** A Claude stub for the assistant: search terms, then the answer. Records every request body. */
function assistantClaude(answer, followUps, bodies = []) {
  return (url, init) => {
    if (!url.includes("api.anthropic.com")) throw new Error(`unexpected fetch ${url}`);
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.tools[0].name === "search_terms") return termsOut(["apprenticeship", "skilled trades"]);
    if (body.tools[0].name === "write_answer") return answerOut(answer, followUps);
    if (body.tools[0].name === "rank_matches") {
      const sent = body.messages[0].content;
      const cands = JSON.parse(sent.slice(sent.indexOf("<candidates>") + 12, sent.indexOf("</candidates>")));
      return rankOut(cands.slice(0, 2).map((c) => ({ company_id: c.company_id, strength: "high", why: "Did it.", caution: "",
        evidence_ids: [c.evidence[0].id] })));
    }
    throw new Error(`unexpected tool ${body.tools[0].name}`);
  };
}
const assistantRows = () => [
  ins({ id: "h1", topic: "talent_pipeline", company_id: "c-a", title: "Cannot hire maintenance technicians", detail: "Second shift is empty." }),
  ins({ id: "h2", topic: "talent_pipeline", company_id: "c-b", title: "Apprentices leave after a year", detail: "Wages elsewhere." }),
  ins({ id: "w1", kind: "win", urgency: "none", topic: "talent_pipeline", company_id: "c-c", title: "Apprenticeship filled four roles",
    detail: "Registered apprenticeship with a college.", solves: "Technician hiring" }),
  ins({ id: "q1", topic: "quality", company_id: "c-b", title: "Inspection backlog", detail: "Manual gauging." }),
];
const askBox = (token, body) => piReq("assistant", "POST", body, token);

test("partner_intel: the Ask box answers from the notes, keeps only citations it was shown, and numbers them 1, 2, 3", async () => {
  const { env, token } = await piEnv(assistantRows(), { partner_intel_claude_api: "k" });
  const bodies = [];
  const res = await withFetch(assistantClaude("Hiring leads [n2]. Two companies raised it [n1][n2] — one fixed it [n999]. Range 3–5.",
    ["Who solved hiring?"], bodies), () => pi("assistant", askBox(token, { question: "What are the top issues for the next quarterly meeting?", mode: "answer" }), env));
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.turn.kind, "answer");
  assert.equal(r.turn.answer, "Hiring leads [1]. Two companies raised it [2][1], one fixed it . Range 3 to 5.",
    "renumbered in citation order, an unknown reference dropped, no dashes");
  assert.equal(r.turn.sources.length, 2);
  assert.deepEqual(r.turn.sources.map((x) => x.ref), [1, 2]);
  assert.ok(r.turn.sources.every((x) => x.title && x.company && "files" in x), "each cited note is kept whole enough to show later");
  assert.deepEqual(r.turn.followUps, ["Who solved hiring?"]);
  const answerCall = bodies.find((b) => b.tools[0].name === "write_answer");
  assert.equal(answerCall.model, "claude-sonnet-5-5");
  assert.equal(answerCall.tools[0].strict, true);
  assert.deepEqual(answerCall.tool_choice, { type: "auto" }, "Sonnet 5.5 rejects a forced tool choice");
  assert.equal(answerCall.cache_control, undefined, "no prompt caching on a low-volume flow");
  const prompt = answerCall.messages[0].content;
  for (const part of ["<overview>", "<topic_table>", "<notes>", "<question>", "Cannot hire maintenance technicians"]) assert.ok(prompt.includes(part), part);
  assert.ok(prompt.indexOf("<question>") > prompt.indexOf("<notes>"), "the question comes after the material");
  assert.ok(!prompt.includes("<topics>"), "the topic table is not mistaken for a summaries prompt");
  const usage = JSON.parse(await env.BOX_KV.get(`pi:usage:${new Date().toISOString().slice(0, 7)}`));
  assert.equal(usage.assistant.calls, 2, "the search terms and the answer, two calls");
});

test("partner_intel: a follow-up in the Ask box reads the earlier answer and joins the same conversation", async () => {
  const { env, token } = await piEnv(assistantRows(), { partner_intel_claude_api: "k" });
  const bodies = [];
  const first = await withFetch(assistantClaude("Hiring [n1].", [], bodies), async () =>
    (await pi("assistant", askBox(token, { question: "What are members saying about hiring?", mode: "answer" }), env)).json());
  const second = await withFetch(assistantClaude("Wins too [n1].", [], bodies), async () =>
    (await pi("assistant", askBox(token, { question: "And the wins?", mode: "answer", conversationId: first.conversation.id }), env)).json());
  assert.equal(second.conversation.id, first.conversation.id);
  assert.equal(second.conversation.turns, 2);
  const last = bodies.filter((b) => b.tools[0].name === "write_answer").pop().messages[0].content;
  // BUG: the earlier answer went back with its "[1]", and a model copying it made a chip to this answer's
  // first note, another note. Earlier answers go back without their citation numbers.
  assert.match(last, /<earlier_conversation>\nQ: What are members saying about hiring\?\nA: Hiring\./);
  const missing = await pi("assistant", askBox(token, { question: "More?", mode: "answer", conversationId: "nope" }), env);
  assert.equal(missing.status, 404, "a conversation that is not in the person's history is not continued");
});

test("partner_intel: on the Ask page a who-can-help question ranks partners, and anything else gets an answer", async () => {
  assert.equal(looksLikeMatch("Who can help with hiring and keeping skilled technicians?"), true);
  assert.equal(looksLikeMatch("A partner is looking for help with an AI quality system. Who can we connect them with?"), true);
  assert.equal(looksLikeMatch("Which companies have solved second-shift staffing?"), true);
  assert.equal(looksLikeMatch("What are the top issues to discuss at the next quarterly meeting?"), false);
  assert.equal(looksLikeMatch("Which companies mentioned energy costs this year?"), false);
  const { env, token } = await piEnv(assistantRows(), { partner_intel_claude_api: "k" });
  const bodies = [];
  const r = await withFetch(assistantClaude("unused", [], bodies), async () =>
    (await pi("assistant", askBox(token, { question: "Who can help with apprenticeship hiring for technicians?" }), env)).json());
  assert.equal(r.turn.kind, "matches");
  assert.ok(!bodies.some((b) => b.tools[0].name === "write_answer"), "no written answer as well: two calls, not three");
  assert.ok(r.turn.matches.length >= 1);
  const refs = new Set(r.turn.sources.map((x) => x.ref));
  assert.ok(r.turn.matches.every((m) => m.refs.length && m.refs.every((n) => refs.has(n))), "every match points at numbered notes");
  const forced = await withFetch(assistantClaude("An answer [n1].", [], []), async () =>
    (await pi("assistant", askBox(token, { question: "Who can help with apprenticeship hiring?", mode: "answer" }), env)).json());
  assert.equal(forced.turn.kind, "answer", "the Ask box always answers");
  assert.equal(forced.turn.offerMatch, true, "and offers the partner search for a who-can-help question");
});

test("partner_intel: each person's Ask history is theirs alone, kept in Box under the Database folder, and restored from Box", async () => {
  const { env, token } = await adminEnv({ partner_intel_claude_api: "k" });
  await env.BOX_KV.put("pi:roster", JSON.stringify({ partners: PARTNERS.map((p) => ({ ...p })), aliases: {}, staff: [], updatedAt: "r1" }));
  await pi("relay/publish", relay("publish", "POST", { version: "vh", generated_at: "2026-10-07T00:00:00+00:00", roster_updated_at: "r1",
    topics: TOPICS, events: [], insights: assistantRows(), companies: [], unmatched: [], stats: {} }), env);
  await setFolder(env, token, "data", "22", "Database");
  const folders = { 22: [], 50: [] };
  const files = {};
  const uploads = [];
  const created = [];
  const savedAnswers = [];
  const box = (url, init = {}) => {
    if (url.includes("api.anthropic.com")) return assistantClaude("Hiring [n1].")(url, init);
    const u = new URL(url);
    if (u.pathname === "/2.0/folders" && init.method === "POST") {
      const made = JSON.parse(init.body);
      created.push(made);
      const fid = made.name === "Ask history" ? "50" : "51";
      folders[22].push({ type: "folder", id: fid, name: made.name });
      folders[fid] = folders[fid] || [];
      return okJson({ id: fid });
    }
    const items = u.pathname.match(/\/folders\/(\d+)\/items$/);
    if (items) return okJson({ total_count: (folders[items[1]] || []).length, entries: folders[items[1]] || [] });
    const content = u.pathname.match(/\/files\/(\d+)\/content$/);
    if (content && !url.startsWith("https://upload.")) return new Response(files[content[1]]);
    if (url.startsWith("https://upload.box.com")) {
      const file = init.body.get("file");
      // The history file is 900; saved answers (their own files, in Saved answers) count up from 901.
      const id = content ? content[1] : file.name.startsWith("ask-history-") ? "900" : String(901 + uploads.length);
      const parent = content ? null : JSON.parse(init.body.get("attributes")).parent.id;
      if (!file.name.startsWith("ask-history-")) { savedAnswers.push(file.name); return okJson({ entries: [{ id }] }); }
      uploads.push({ url, id, name: file.name });
      return file.text().then((txt) => {
        files[id] = txt;
        if (!content) folders[parent].push({ type: "file", id, name: file.name });
        return okJson({ entries: [{ id }] });
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const r1 = await withFetch(box, async () => (await pi("assistant", askBox(token, { question: "What are members saying about hiring?", mode: "answer" }), env)).json());
  assert.equal(r1.saved.box, true);
  assert.deepEqual(created.find((c) => c.name === "Ask history"), { name: "Ask history", parent: { id: "22" } }, "the Ask history folder is made inside the Database folder");
  assert.equal(savedAnswers.length, 1, "the answer is also saved to Box as a saved answer, in its own file");
  assert.match(uploads[0].name, /^ask-history-poneill@conexusindiana\.com-[0-9a-f]{8}\.json$/);
  await withFetch(box, () => pi("assistant", askBox(token, { question: "And quality?", mode: "answer", conversationId: r1.conversation.id }), env));
  assert.equal(created.filter((c) => c.name === "Ask history").length, 1, "the folder is found the second time, not made again");
  assert.match(uploads[1].url, /files\/900\/content$/, "the history file is updated as a new version, not uploaded again (Box would 409)");
  assert.equal(JSON.parse(files["900"]).conversations[0].turns.length, 2);

  // Someone else's history never shows, whatever is stored.
  await env.BOX_KV.put("pi:asst:history:someone@else.test", JSON.stringify({ conversations: [{ id: "x", title: "Theirs", turns: [] }] }));
  const mine = await withFetch(box, () => getJson("assistant/history", env, token));
  assert.deepEqual(mine.conversations.map((c) => c.title), ["What are members saying about hiring?"]);
  assert.equal((await pi("assistant/conversation", piGet("assistant/conversation?id=x", token), env)).status, 404);

  // The app's copy lost: the history comes back from Box.
  await env.BOX_KV.delete("pi:asst:history:poneill@conexusindiana.com");
  const back = await withFetch(box, () => getJson("assistant/history", env, token));
  assert.equal(back.conversations.length, 1);
  assert.equal(back.conversations[0].turns, 2);

  const del = await withFetch(box, () => pi("assistant/delete", piReq("assistant/delete", "POST", { id: r1.conversation.id }, token), env));
  assert.equal(del.status, 200);
  assert.deepEqual((await withFetch(box, () => getJson("assistant/history", env, token))).conversations, []);
  assert.deepEqual(JSON.parse(files["900"]).conversations, [], "deleting removes it from the Box copy too");
});

test("partner_intel: the Ask box and history refuse a caller who is not signed in", async () => {
  const { env } = await piEnv(assistantRows());
  assert.equal((await pi("assistant", askBox("", { question: "Top issues?" }), env)).status, 401);
  assert.equal((await pi("assistant/history", piGet("assistant/history"), env)).status, 401);
  assert.equal((await pi("assistant/delete", piReq("assistant/delete", "POST", { id: "x" }), env)).status, 401);
});

test("partner_intel: a question's time window is read from its words", () => {
  const now = new Date("2026-10-22T12:00:00Z");
  assert.equal(questionWindow("What came up in the last 60 days?", now), 60);
  assert.equal(questionWindow("Top issues over the past quarter", now), 91);
  assert.equal(questionWindow("anything new last week", now), 7);
  assert.equal(questionWindow("What did members say this year?", now), 295);
  assert.equal(questionWindow("What are the top issues for the next quarterly meeting?", now), 0, "the next quarter is not a window");
});

test("partner_intel: a company named in the question, or the page it is asked from, puts that company's notes in front of Claude", async () => {
  const rows = [...assistantRows(), ...Array.from({ length: 30 }, (_, k) => ins({ id: `g${k}`, company_id: "c-c", topic: "quality",
    title: `Gamma note ${k}`, date: isoAgo(400 + k) }))];
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  const bodies = [];
  await withFetch(assistantClaude("Gamma [n1].", [], bodies), () => pi("assistant", askBox(token, { question: "What has Gamma Labs said?", mode: "answer" }), env));
  const prompt = bodies.find((b) => b.tools[0].name === "write_answer").messages[0].content;
  assert.ok((prompt.match(/Gamma note/g) || []).length >= 20, "old notes from the named company are included");
  const fromPage = [];
  await withFetch(assistantClaude("It [n1].", [], fromPage), () => pi("assistant", askBox(token, { question: "Summarize what we have heard.", mode: "answer", companyId: "c-c" }), env));
  const pagePrompt = fromPage.find((b) => b.tools[0].name === "write_answer").messages[0].content;
  assert.match(pagePrompt, /<page>The person is on the page for Gamma Labs\./);
  assert.ok((pagePrompt.match(/Gamma note/g) || []).length >= 20);
});

test("partner_intel: BUG the Ask box said it had no PCN notes when asked about the PCN, though there were dozens", async () => {
  // The program a note came from lives only in its Box folder path. The notes' own words rarely say
  // "PCN", and the program's notes were older than the recent spread, so none reached Claude.
  const pcn = Array.from({ length: 20 }, (_, k) => ins({ id: `pcn${k}`, company_id: k % 2 ? "c-a" : "c-b", topic: "talent_pipeline",
    title: `Peer topic ${k}`, detail: "Discussed at the network call.", date: isoAgo(150 + k), meeting_id: `pcn-m${k % 4}`,
    meeting_label: "President and CEO Network Call", sources: [{ id: `p${k}`, name: "pcn.docx", path: `Notes/PCN/pcn${k}.docx` }] }));
  const crowd = Array.from({ length: 200 }, (_, k) => ins({ id: `cr${k}`, company_id: ["c-a", "c-b", "c-c"][k % 3], topic: "quality",
    title: `Workshop item ${k}`, date: isoAgo(k % 60), meeting_id: `cm${k}`, meeting_label: `Workshop ${k}`, sources: [{ id: `c${k}`, name: "w.docx", path: `Notes/CIAIC/w${k}.docx` }] }));
  const { env, token } = await piEnv([...pcn, ...crowd], { partner_intel_claude_api: "k" });
  const bodies = [];
  const r = await withFetch(assistantClaude("They discussed peer topics [n1].", [], bodies),
    async () => (await pi("assistant", askBox(token, { question: "What have they been talking about at the PCN recently?", mode: "answer" }), env)).json());
  assert.equal(r.error, undefined, r.error);
  const prompt = bodies.find((b) => b.tools[0].name === "write_answer").messages[0].content;
  assert.match(prompt, /<program name="PCN">\n20 notes/, "the program the question names is given, with its notes and meetings");
  assert.equal((prompt.match(/program: PCN/g) || []).length, 20, "every PCN note is in front of Claude in full, labelled with its program");
  const fullRefs = prompt.slice(prompt.indexOf("<notes>"), prompt.indexOf("</notes>")).match(/^\[n\d+\]/gm).length;
  const headlines = prompt.slice(prompt.indexOf("<all_notes>"), prompt.indexOf("</all_notes>")).match(/^\[n\d+\]/gm).length;
  assert.equal(fullRefs + headlines, 220, "and every note on file is there, in full or as a headline");
  assert.equal(r.turn.sources[0].id.startsWith("pcn") || r.turn.sources[0].id.startsWith("cr"), true);
});

test("partner_intel: a note listed only as a headline can still be cited", async () => {
  const rows = Array.from({ length: 220 }, (_, k) => ins({ id: `r${k}`, title: `Row ${k}`, date: isoAgo(k), meeting_id: `m${k}`, meeting_label: `Meeting ${k}` }));
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  const r = await withFetch(assistantClaude("The oldest one [n220].", []),
    async () => (await pi("assistant", askBox(token, { question: "What is the oldest thing on file?", mode: "answer" }), env)).json());
  assert.equal(r.turn.sources.length, 1);
  assert.equal(r.turn.answer, "The oldest one [1].");
});

/* ------------------------------------------------------------- saved answers (answer memory) */

const pcnRow = (k, over = {}) => ins({ id: `pm${k}`, company_id: k % 2 ? "c-a" : "c-b", topic: "talent_pipeline", title: `PCN point ${k}`,
  detail: "Said at the network call.", date: isoAgo(10 + k), meeting_id: `pcn-${k % 3}`, meeting_label: "President and CEO Network Call",
  sources: [{ id: `pf${k}`, name: "pcn.docx", path: `Notes/PCN/pcn${k}.docx` }], ...over });
async function republish(env, insights, version) {
  const res = await pi("relay/publish", relay("publish", "POST", { version, generated_at: "2026-10-22T00:00:00+00:00", roster_updated_at: "r1",
    topics: TOPICS, events: [], insights, companies: [], unmatched: [], stats: {} }), env);
  assert.equal(res.status, 200);
}
const ASKED = "What have they been talking about at the PCN recently?";

test("partner_intel: a question asked again, with nothing new in its scope, is answered from the saved answer with no Claude call", async () => {
  const rows = [...Array.from({ length: 6 }, (_, k) => pcnRow(k)), ins({ id: "other1", title: "Elsewhere", sources: [{ id: "o", name: "o.docx", path: "Notes/CIAIC/o.docx" }] })];
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  const first = await withFetch(assistantClaude("Hiring came up [n1][n2].", ["And wins?"]), async () =>
    (await pi("assistant", askBox(token, { question: ASKED, mode: "answer" }), env)).json());
  assert.equal(first.turn.memory, undefined, "the first answer is a full one");
  // A note outside the scope arriving changes nothing for this question.
  await republish(env, [...rows, ins({ id: "other2", title: "Elsewhere too", sources: [{ id: "o2", name: "o2.docx", path: "Notes/CIAIC/o2.docx" }] })], "v-other");
  let calls = 0;
  const again = await withFetch(() => { calls++; throw new Error("no Claude call expected"); }, async () =>
    (await pi("assistant", askBox(token, { question: "What has the PCN been talking about lately?", mode: "answer" }), env)).json());
  assert.equal(calls, 0, "no search terms, no answer: nothing paid for");
  assert.equal(again.turn.memory.mode, "reused");
  assert.equal(again.turn.memory.question, undefined, "saved answers are shared by all staff: another person's question is not shown");
  assert.equal(again.turn.answer, first.turn.answer);
  assert.deepEqual(again.turn.sources.map((x) => x.id), first.turn.sources.map((x) => x.id), "the same notes behind it");
  const usage = JSON.parse(await env.BOX_KV.get(`pi:usage:${new Date().toISOString().slice(0, 7)}`));
  assert.equal(usage.assistant.reused, 1);
});

test("partner_intel: a saved answer is never reused for a question about other things, another program, a follow-up, or when asked fresh", async () => {
  const rows = [...Array.from({ length: 6 }, (_, k) => pcnRow(k)),
    ins({ id: "ci1", title: "CIAIC item", sources: [{ id: "c1", name: "c.docx", path: "Notes/CIAIC/c.docx" }] })];
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  await withFetch(assistantClaude("Issues [n1]."), () => pi("assistant", askBox(token, { question: "What issues has the PCN raised?", mode: "answer" }), env));
  const fresh = async (question, extra = {}) => {
    let answered = 0;
    const r = await withFetch((url, init) => { if (JSON.parse(init.body).tools[0].name === "write_answer") answered++; return assistantClaude("New [n1].")(url, init); },
      async () => (await pi("assistant", askBox(token, { question, mode: "answer", ...extra }), env)).json());
    return { r, answered };
  };
  assert.equal((await fresh("What wins has the PCN had?")).answered, 1, "wins are not issues");
  assert.equal((await fresh("What issues has CIAIC raised?")).answered, 1, "another program");
  assert.equal((await fresh("What issues has the PCN raised?", { fresh: true })).answered, 1, "Answer fresh always asks again");
  const conv = (await fresh("Tell me about workforce at the PCN")).r.conversation.id;
  assert.equal((await fresh("What issues has the PCN raised?", { conversationId: conv })).answered, 1, "a follow-up leans on its conversation");
});

test("partner_intel: new notes in a saved answer's scope update it from only the new notes, not a full answer", async () => {
  const rows = Array.from({ length: 30 }, (_, k) => pcnRow(k));
  const extra = Array.from({ length: 200 }, (_, k) => ins({ id: `x${k}`, title: `Other ${k}`, date: isoAgo(k % 50), meeting_id: `xm${k}`, meeting_label: `M${k}`,
    sources: [{ id: `xs${k}`, name: "x.docx", path: "Notes/CIAIC/x.docx" }] }));
  const { env, token } = await piEnv([...rows, ...extra], { partner_intel_claude_api: "k" });
  const bodies = [];
  const first = await withFetch(assistantClaude("Hiring came up [n1][n2].", [], bodies), async () =>
    (await pi("assistant", askBox(token, { question: ASKED, mode: "answer" }), env)).json());
  const fullPrompt = bodies.find((b) => b.tools[0].name === "write_answer").messages[0].content;
  const added = [pcnRow(90, { title: "Brand new PCN point", date: isoAgo(1) }), pcnRow(91, { title: "Another new PCN point", date: isoAgo(2) })];
  await republish(env, [...rows, ...extra, ...added], "v-new");
  const later = [];
  const r = await withFetch(assistantClaude("Still hiring [n1], and now this [n3].", [], later), async () =>
    (await pi("assistant", askBox(token, { question: ASKED, mode: "answer" }), env)).json());
  assert.equal(r.turn.memory.mode, "updated");
  assert.equal(r.turn.memory.newNotes, 2);
  assert.ok(!later.some((b) => b.tools[0].name === "search_terms"), "no search-terms call on an update");
  const update = later.find((b) => b.tools[0].name === "write_answer");
  const prompt = update.messages[0].content;
  assert.match(update.system, /Update the earlier answer/);
  assert.match(prompt, /<earlier_answer date="[\d-]+">\nQuestion: What have they been talking about at the PCN recently\?\n\nHiring came up \[n1\]\[n2\]\./);
  assert.match(prompt, /<new_notes>\n2 notes added since/);
  assert.ok(prompt.includes("Brand new PCN point") && prompt.includes("Another new PCN point"));
  assert.ok(!prompt.includes("Other 5 "), "nothing else is sent");
  assert.ok(prompt.length < fullPrompt.length / 5, `an update reads a fraction of a full answer (${prompt.length} vs ${fullPrompt.length} characters)`);
  const cited = first.turn.sources.map((x) => x.id);
  assert.deepEqual(r.turn.sources.map((x) => x.id), [cited[0], "pm90"], "n1 is the earlier answer's first note; n3 the newest new note");
});

test("partner_intel: BUG risk: a saved answer is not reused once a note it cited is re-attributed to another company", async () => {
  const rows = Array.from({ length: 6 }, (_, k) => pcnRow(k));
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  const first = await withFetch(assistantClaude("Acme raised it [n1]."), async () =>
    (await pi("assistant", askBox(token, { question: ASKED, mode: "answer" }), env)).json());
  const citedId = first.turn.sources[0].id;
  const other = first.turn.sources[0].company.id === "c-a" ? "c-b" : "c-a";
  assert.equal((await pi("attribution/decide", piReq("attribution/decide", "POST", { id: citedId, companyId: other }, token), env)).status, 200);
  let answered = 0;
  const r = await withFetch((url, init) => { if (JSON.parse(init.body).tools[0].name === "write_answer") answered++; return assistantClaude("Now [n1].")(url, init); },
    async () => (await pi("assistant", askBox(token, { question: ASKED, mode: "answer" }), env)).json());
  assert.equal(answered, 1, "the old answer named the wrong company for that note, so it is answered again");
  assert.equal(r.turn.memory, undefined);
});

test("partner_intel: saved answers are kept in Box, one file each plus an index the cron writes, and read back if the app loses them", async () => {
  const rows = Array.from({ length: 6 }, (_, k) => pcnRow(k));
  const { env, token } = await adminEnv({ partner_intel_claude_api: "k" });
  await env.BOX_KV.put("pi:roster", JSON.stringify({ partners: PARTNERS.map((p) => ({ ...p })), aliases: {}, staff: [], updatedAt: "r1" }));
  await republish(env, rows, "vm");
  await env.BOX_KV.delete("pi:sum:queue");
  await setFolder(env, token, "data", "22", "Database");
  const folders = { 22: [] }, files = {};
  let next = 700;
  const box = (url, init = {}) => {
    if (url.includes("api.anthropic.com")) return assistantClaude("Hiring [n1].")(url, init);
    const u = new URL(url);
    if (u.pathname === "/2.0/folders" && init.method === "POST") {
      const made = JSON.parse(init.body); const id = String(next++);
      folders[made.parent.id].push({ type: "folder", id, name: made.name }); folders[id] = [];
      return okJson({ id });
    }
    const items = u.pathname.match(/\/folders\/(\d+)\/items$/);
    if (items) return okJson({ total_count: (folders[items[1]] || []).length, entries: folders[items[1]] || [] });
    const content = u.pathname.match(/\/files\/(\d+)\/content$/);
    if (content && !url.startsWith("https://upload.")) return files[content[1]] === undefined ? new Response("no", { status: 404 }) : new Response(files[content[1]]);
    if (url.startsWith("https://upload.box.com")) {
      const file = init.body.get("file");
      const id = content ? content[1] : String(next++);
      return file.text().then((txt) => {
        files[id] = txt;
        if (!content) folders[JSON.parse(init.body.get("attributes")).parent.id].push({ type: "file", id, name: file.name });
        return okJson({ entries: [{ id }] });
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const first = await withFetch(box, async () => (await pi("assistant", askBox(token, { question: ASKED, mode: "answer" }), env)).json());
  const savedFolder = folders[22].find((e) => e.name === "Saved answers");
  assert.ok(savedFolder, "a Saved answers folder in the Database folder");
  assert.equal(folders[savedFolder.id].length, 1);
  assert.match(folders[savedFolder.id][0].name, /^answer-[\w-]+\.json$/);
  await withFetch(box, () => runSummariesAhead(env));
  const indexFile = folders[22].find((e) => e.name === "partner_intel_saved_answers.json");
  assert.ok(indexFile, "the cron writes the index to Box");
  assert.equal(JSON.parse(files[indexFile.id]).answers[0].q, ASKED);
  // The app's copy lost: the index and the answer come back from Box, and no Claude call is made.
  for (const k of [...env.BOX_KV.store.keys()]) if (k.startsWith("pi:mem:")) env.BOX_KV.store.delete(k);
  let claude = 0;
  const again = await withFetch((url, init) => { if (url.includes("api.anthropic.com")) claude++; return box(url, init); },
    async () => (await pi("assistant", askBox(token, { question: ASKED, mode: "answer" }), env)).json());
  assert.equal(claude, 0);
  assert.equal(again.turn.memory.mode, "reused");
  assert.equal(again.turn.answer, first.turn.answer);
});

test("partner_intel: BUG asked about Chad Nord, Ask said no one by that name was in the notes, though the contact list puts him at his company", async () => {
  // The notes call him "Chad"; the contact list says Chad Nord, VP of Operations, at the partner. Ask never looked.
  const rows = [
    ins({ id: "ch1", company_id: "c-a", title: "Leadership courses by role", detail: "Chad built a framework of leadership courses.", date: isoAgo(30) }),
    ins({ id: "ch2", company_id: "c-a", title: "Stretch assignments", detail: "Two people moved up through Chad's stretch assignments.", date: isoAgo(40) }),
    ...Array.from({ length: 200 }, (_, k) => ins({ id: `o${k}`, company_id: "c-b", title: `Other ${k}`, date: isoAgo(k % 30), meeting_id: `om${k}`, meeting_label: `M${k}` })),
  ];
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  await env.BOX_KV.put("pi:contacts", JSON.stringify({ fileName: "c.xlsx", updatedAt: "t", summary: {}, contacts: [
    { name: "Chad Nord", title: "Vice President of Operations", account: "Acme Corp", email: "" },
    { name: "Jeff Nordman", title: "", account: "Beta Works", email: "" } ] }));
  const bodies = [];
  const r = await withFetch(assistantClaude("Chad at Acme [n1].", [], bodies), async () =>
    (await pi("assistant", askBox(token, { question: "Tell me what we know about Chad Nord", mode: "answer" }), env)).json());
  const prompt = bodies.find((b) => b.tools[0].name === "write_answer").messages[0].content;
  assert.match(prompt, /<people>\nPeople the question names, from the contact list:\nChad Nord, Vice President of Operations, Acme Corp \(Council Member\)\. Notes often give only a first name: in notes from Acme Corp, "Chad" is probably Chad Nord, the only one there by that first name\./);
  assert.ok(!prompt.includes("Jeff Nordman"), "a whole name, not part of one: Nordman is not Nord");
  const full = prompt.slice(prompt.indexOf("<notes>"), prompt.indexOf("</notes>"));
  assert.ok(full.includes("Leadership courses by role") && full.includes("Stretch assignments"), "his company's notes that mention him are given in full");
  assert.deepEqual(r.turn.considered.people, ["Chad Nord"]);
});

test("partner_intel: BUG the uploaded contact list was never saved to Box; it is now kept in the Contact list folder and read back", async () => {
  const { env, token } = await adminEnv();
  await env.BOX_KV.put("pi:roster", JSON.stringify({ partners: PARTNERS.map((p) => ({ ...p })), aliases: {}, staff: [], updatedAt: "r1" }));
  assert.equal((await setFolder(env, token, "contacts", "66", "Contacts")).status, 200);
  const csv = "First Name,Last Name,Title,Account Name,Email\nChad,Nord,VP Operations,Acme Corp,chad@acme.test\n";
  const uploads = [];
  const res = await withFetch(boxFake({ 66: [] }, {}, uploads), async () => (await pi("contacts/import", piReq("contacts/import", "POST",
    { fileName: "contacts.csv", data: Buffer.from(csv).toString("base64") }, token), env)).json());
  assert.equal(res.box.box, true);
  const names = await Promise.all(uploads.map(async (u) => u.form.get("file").name));
  assert.deepEqual(names.sort(), ["contacts.csv", "partner_intel_contacts.json"], "the file as uploaded, and the list as read");
  const saved = await uploads.find((u) => u.form.get("file").name === "partner_intel_contacts.json").form.get("file").text();
  // The app's copy lost: it is read back from Box.
  await env.BOX_KV.delete("pi:contacts");
  const back = await withFetch(boxFake({ 66: [fileItem("801", "partner_intel_contacts.json", "2026-10-22T00:00:00Z")] }, { 801: saved }),
    () => getJson("contacts", env, token));
  assert.equal(back.fileName, "contacts.csv");
  assert.equal(JSON.parse(await env.BOX_KV.get("pi:contacts")).contacts[0].name, "Chad Nord");
});

test("partner_intel: with a Cache folder chosen, summaries and the scan's caches go there; the Database folder keeps the database", async () => {
  const { env, token } = await adminEnv({ partner_intel_claude_api: "k" });
  await setFolder(env, token, "data", "22", "Database");
  assert.equal((await setFolder(env, token, "cache", "77", "Cache")).status, 200);
  const uploads = [];
  const save = (name) => withFetch(boxFake({ 22: [], 77: [] }, {}, uploads), () => pi("relay/box/save", relay("box/save", "POST", { name, text: "{}" }), env));
  await save("partner_intel_results_archive.json");
  await save("partner_intel_state.json");
  await save("partner_intel_database.json");
  const parents = uploads.map((u) => [u.form.get("file").name, JSON.parse(u.form.get("attributes")).parent.id]);
  assert.deepEqual(parents, [["partner_intel_results_archive.json", "77"], ["partner_intel_state.json", "77"], ["partner_intel_database.json", "22"]]);
  // A cache written to the Database folder before the Cache folder was chosen is still found.
  const loaded = await withFetch(boxFake({ 22: [fileItem("90", "partner_intel_state.json", "2026-01-01T00:00:00Z")], 77: [] }, { 90: "old-state" }),
    async () => (await pi("relay/box/load", relay("box/load?name=partner_intel_state.json", "GET"), env)).text());
  assert.equal(loaded, "old-state");
});

/* ---------------------------------------------------- trending summaries written ahead, kept in Box */

test("partner_intel: new data queues Home and the main programs, and the cron writes their summaries once, then saves them to Box", async () => {
  assert.deepEqual(AHEAD_PROGRAMS, ["Field Demos", "Council", "PCN", "ITA", "Board Meetings"]);
  const rows = [
    ...trendingRows(),
    ins({ topic: "quality", company_id: "c-c", title: "CIAIC scrap", sources: [{ id: "f9", name: "c.docx", path: "Notes/CIAIC/c.docx" }], date: isoAgo(200) }),
    ins({ topic: "quality", company_id: "c-a", title: "CIAIC gauges", sources: [{ id: "f8", name: "d.docx", path: "Notes/CIAIC/d.docx" }], date: isoAgo(210) }),
  ];
  const { env, token } = await adminEnv({ partner_intel_claude_api: "k" });
  await env.BOX_KV.put("pi:roster", JSON.stringify({ partners: PARTNERS.map((p) => ({ ...p })), aliases: {}, staff: [], updatedAt: "r1" }));
  await setFolder(env, token, "data", "22", "Database");
  const publish = () => pi("relay/publish", relay("publish", "POST", { version: "va", generated_at: "2026-10-07T00:00:00+00:00", roster_updated_at: "r1",
    topics: TOPICS, events: [], insights: rows, companies: [], unmatched: [], stats: {} }), env);
  await publish();
  assert.equal(JSON.parse(await env.BOX_KV.get("pi:sum:queue")).views.length, 6, "Home and the five programs");

  let claude = 0;
  const folder = [];
  const files = {};
  const box = (url, init = {}) => {
    if (url.includes("api.anthropic.com")) {
      claude++;
      const t = topicsIn(init);
      return summaryOut(t.payload, (x) => ({ topic_id: x.topic_id, bullets: [{ text: `About ${x.topic}.`, evidence_ids: [x.evidence[0].id] }] }));
    }
    const u = new URL(url);
    if (u.pathname.endsWith("/folders/22/items")) return okJson({ total_count: folder.length, entries: folder });
    const content = u.pathname.match(/\/files\/(\d+)\/content$/);
    if (content && !url.startsWith("https://upload.")) return new Response(files[content[1]]);
    if (url.startsWith("https://upload.box.com")) {
      const file = init.body.get("file");
      const id = content ? content[1] : "777";
      return file.text().then((txt) => { files[id] = txt; if (!content) folder.push({ type: "file", id, name: file.name }); return okJson({ entries: [{ id }] }); });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const run1 = await withFetch(box, () => runSummariesAhead(env));
  assert.equal(run1.left, 0);
  assert.ok(claude >= 1);
  const home = await getJson("home", env, token);
  assert.ok(home.trending.every((g) => g.summary), "Home opens with every summary already written");
  const ciaic = await getJson("program?name=CIAIC", env, token);
  assert.ok(ciaic.trending.length && ciaic.trending.every((g) => g.summary), "and so does CIAIC, which goes back past Home's 90 days");
  const saved = JSON.parse(files["777"]);
  assert.equal(folder[0].name, SUMMARY_BOX_FILE);
  assert.ok(saved.summaries.length >= 2 && saved.summaries.every((e) => /^pi:sum:[0-9a-f]{32}$/.test(e.key) && e.value.bullets.length));
  assert.equal(await env.BOX_KV.get("pi:sum:dirty"), null);

  // The same data again: nothing to write, no Claude call.
  const before = claude;
  await publish();
  await withFetch(box, () => runSummariesAhead(env));
  assert.equal(claude, before, "a summary is only written when the rows behind it change");

  // A new deployment with an empty store: the summaries come back from Box, not from Claude.
  const fresh = await adminEnv({ partner_intel_claude_api: "k" });
  await fresh.env.BOX_KV.put("pi:roster", JSON.stringify({ partners: PARTNERS.map((p) => ({ ...p })), aliases: {}, staff: [], updatedAt: "r1" }));
  await setFolder(fresh.env, fresh.token, "data", "22", "Database");
  await pi("relay/publish", relay("publish", "POST", { version: "va", generated_at: "2026-10-07T00:00:00+00:00", roster_updated_at: "r1",
    topics: TOPICS, events: [], insights: rows, companies: [], unmatched: [], stats: {} }), fresh.env);
  files["777"] = JSON.stringify({ ...saved, summaries: [...saved.summaries, { key: "pi:settings", value: { bullets: [] } }] });
  await withFetch(box, () => runSummariesAhead(fresh.env));
  assert.equal(claude, before, "restored from Box");
  assert.ok((await getJson("home", fresh.env, fresh.token)).trending.every((g) => g.summary));
  assert.equal(JSON.parse(await fresh.env.BOX_KV.get("pi:settings")).dataFolderId, "22", "a key in the Box file that is not a summary key is ignored");
});

test("partner_intel: summaries written when someone opens a page are saved to Box by the next cron tick", async () => {
  const { env, token } = await adminEnv({ partner_intel_claude_api: "k" });
  await env.BOX_KV.put("pi:roster", JSON.stringify({ partners: PARTNERS.map((p) => ({ ...p })), aliases: {}, staff: [], updatedAt: "r1" }));
  await pi("relay/publish", relay("publish", "POST", { version: "vb", generated_at: "2026-10-07T00:00:00+00:00", roster_updated_at: "r1",
    topics: TOPICS, events: [], insights: trendingRows(), companies: [], unmatched: [], stats: {} }), env);
  await env.BOX_KV.delete("pi:sum:queue");
  await setFolder(env, token, "data", "22", "Database");
  const uploads = [];
  await withFetch((url, init) => {
    const t = topicsIn(init);
    return summaryOut(t.payload, (x) => ({ topic_id: x.topic_id, bullets: [{ text: "P.", evidence_ids: [x.evidence[0].id] }] }));
  }, () => pi("summarize", piReq("summarize", "POST", { days: 30, topics: ["quality"] }, token), env));
  assert.equal(await env.BOX_KV.get("pi:sum:dirty"), "1");
  // The same tick also writes the main views ahead (nothing had marked them written), then saves all to Box once.
  const box = boxFake({ 22: [] }, {}, uploads);
  await withFetch((url, init) => (url.includes("api.anthropic.com")
    ? summaryOut(topicsIn(init).payload, (x) => ({ topic_id: x.topic_id, bullets: [{ text: "P.", evidence_ids: [x.evidence[0].id] }] }))
    : box(url, init)), () => runSummariesAhead(env));
  assert.equal(uploads.length, 1);
  assert.equal(await env.BOX_KV.get("pi:sum:dirty"), null);
  assert.deepEqual(await runSummariesAhead(env), { idle: true }, "nothing to do: no Box or Claude call");
});

test("partner_intel: the cron writes the summaries ahead as well as starting the daily scan", () => {
  const src = fs.readFileSync(path.join(SRC, "worker.js"), "utf8");
  assert.match(src, /ctx\.waitUntil\(runSummariesAhead\(env\)\)/);
});

/* ------------------------------------------------------------- QA/QC fixes: Ask, saved answers, roster */

test("partner_intel: BUG a bare [1] copied into an answer became a citation chip to another note", async () => {
  const { env, token } = await piEnv(assistantRows(), { partner_intel_claude_api: "k" });
  const r = await withFetch(assistantClaude("Unlike Acme [1], Beta loses apprentices [n2]."), async () =>
    (await pi("assistant", askBox(token, { question: "What about apprentices?", mode: "answer" }), env)).json());
  assert.equal(r.turn.answer, "Unlike Acme, Beta loses apprentices [1].");
  assert.equal(r.turn.sources.length, 1);
});

test("partner_intel: BUG 'which topics have grown in the last 90 days' saw no earlier mentions, so shrinking topics read as growth", async () => {
  const rows = [ins({ topic: "quality", company_id: "c-a", date: isoAgo(10) }), ins({ topic: "quality", company_id: "c-a", date: isoAgo(120) }),
    ins({ topic: "quality", company_id: "c-b", date: isoAgo(130) }), ins({ topic: "quality", company_id: "c-c", date: isoAgo(140) })];
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  const bodies = [];
  await withFetch(assistantClaude("Quality shrank [n1].", [], bodies), () =>
    pi("assistant", askBox(token, { question: "Which topics have grown in the last 90 days?", mode: "answer" }), env));
  const prompt = bodies.find((b) => b.tools[0].name === "write_answer").messages[0].content;
  assert.match(prompt, /\nQuality systems and inspection \| 1 \| 1 \| 0 \| 1 \| 3 \|/, "one company in the window, three in the 90 days before");
});

const answeredBy = async (env, token, question, extra = {}) => {
  let answered = 0;
  await withFetch((url, init) => { if (JSON.parse(init.body).tools[0].name === "write_answer") answered++; return assistantClaude("A [n1].")(url, init); },
    () => pi("assistant", askBox(token, { question, mode: "answer", ...extra }), env));
  return answered;
};

test("partner_intel: BUG a saved answer was reused word for word for a question about another number, year, person or the opposite", async () => {
  const { env, token } = await piEnv(Array.from({ length: 6 }, (_, k) => pcnRow(k)), { partner_intel_claude_api: "k" });
  for (const [a, b] of [["What were the top 3 issues at the PCN?", "What were the top 8 issues at the PCN?"],
    ["What did the PCN say about hiring in 2025?", "What did the PCN say about hiring in 2024?"],
    ["Which PCN members have raised apprenticeship concerns?", "Which PCN members have not raised apprenticeship concerns?"],
    ["What has Chad Nord said at the PCN?", "What has Chad Smith said at the PCN?"]]) {
    assert.equal(await answeredBy(env, token, a), 1, a);
    assert.equal(await answeredBy(env, token, b), 1, b);
  }
  assert.equal(await answeredBy(env, token, "What were the top 3 issues at the PCN?"), 0, "the same question again is still reused");
});

test("partner_intel: BUG a saved 'last 30 days' answer was served again after its notes had aged out of the window", async () => {
  const rows = Array.from({ length: 4 }, (_, k) => pcnRow(k, { date: isoAgo(20) }));
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  const q = "What came up at the PCN in the last 30 days?";
  assert.equal(await answeredBy(env, token, q), 1);
  await republish(env, rows.map((r) => ({ ...r, date: isoAgo(40) })), "v-aged");
  assert.equal(await answeredBy(env, token, q), 1, "its notes are no longer in the last 30 days");
});

test("partner_intel: BUG 'members other than Acme' was answered from a saved answer that covered only Acme's notes", async () => {
  const rows = Array.from({ length: 6 }, (_, k) => pcnRow(k, { sources: [{ id: `pf${k}`, name: "x.docx", path: "Notes/CIAIC/x.docx" }] }));
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  const q = "Which members other than Acme Corp have raised hiring?";
  assert.equal(await answeredBy(env, token, q), 1);
  await republish(env, [...rows, ins({ id: "gb1", company_id: "c-b", title: "Beta cannot hire" })], "v-other-than");
  assert.equal(await answeredBy(env, token, q), 1, "a question that leaves a company out is never answered from memory");
});

test("partner_intel: BUG the word 'adapt' in a question was read as the ADAPT program", async () => {
  const rows = [ins({ id: "ad1", title: "ADAPT session", sources: [{ id: "a1", name: "a.docx", path: "Notes/ADAPT/a.docx" }] }),
    ins({ id: "ad2", title: "Elsewhere", sources: [{ id: "a2", name: "b.docx", path: "Notes/CIAIC/b.docx" }] })];
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  const prompt = async (question) => { const bodies = [];
    await withFetch(assistantClaude("A [n1].", [], bodies), () => pi("assistant", askBox(token, { question, mode: "answer", fresh: true }), env));
    return bodies.find((b) => b.tools[0].name === "write_answer").messages[0].content; };
  assert.ok(!(await prompt("How are members trying to adapt to tariffs?")).includes('<program name="ADAPT">'));
  assert.ok((await prompt("What has ADAPT covered?")).includes('<program name="ADAPT">'), "the program in capitals is still found");
});

test("partner_intel: BUG a question naming a company by its short name or its own alias (GE) was not tied to the company", async () => {
  const { env, token } = await piEnv([ins({ id: "ge1", company_id: "c-g", title: "Tariffs on castings" }), ...assistantRows()], { partner_intel_claude_api: "k" });
  await env.BOX_KV.put("pi:roster", JSON.stringify({ partners: [...PARTNERS.map((p) => ({ ...p })),
    { id: "c-g", name: "General Electric Aerospace", industry: "Aerospace", status: "Active", program: "", participationId: "P9", contacts: [], aliases: ["GE"] }],
    aliases: {}, staff: [], updatedAt: "r2" }));
  const bodies = [];
  await withFetch(assistantClaude("A [n1].", [], bodies), () => pi("assistant", askBox(token, { question: "What has GE said about tariffs?", mode: "answer" }), env));
  assert.match(bodies.find((b) => b.tools[0].name === "write_answer").messages[0].content, /newest first: the companies named/);
});

test("partner_intel: BUG Ask stated estimated dates as meeting dates and hid an uncertain company in its sources", async () => {
  const rows = [ins({ id: "es1", title: "Undated note", date_source: "filename_month", review: ["speaker_company_conflict"] }), ...assistantRows()];
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  const bodies = [];
  const r = await withFetch(assistantClaude("It came up [n1][n2][n3][n4][n5].", [], bodies), async () =>
    (await pi("assistant", askBox(token, { question: "What came up?", mode: "answer" }), env)).json());
  assert.match(bodies.find((b) => b.tools[0].name === "write_answer").messages[0].content, /\(estimated\)[^\n]*\nUndated note/);
  const src = r.turn.sources.find((x) => x.id === "es1");
  assert.equal(src.estimated, true);
  assert.equal(src.checkCompany, true);
  assert.equal(r.turn.sources.find((x) => x.id === "h1").estimated, false);
});

test("partner_intel: BUG a follow-up asked from another company's page re-scoped the conversation to that company", async () => {
  const { env, token } = await piEnv(assistantRows(), { partner_intel_claude_api: "k" });
  const bodies = [];
  const first = await withFetch(assistantClaude("A [n1].", [], bodies), async () =>
    (await pi("assistant", askBox(token, { question: "Summarize what we have heard from this company.", mode: "answer", companyId: "c-a" }), env)).json());
  assert.equal(first.conversation.companyId, "c-a");
  assert.match(first.conversation.title, /\(Acme Corp\)$/, "history titles say which company");
  await withFetch(assistantClaude("B [n1].", [], bodies), () =>
    pi("assistant", askBox(token, { question: "And the wins?", mode: "answer", conversationId: first.conversation.id, companyId: "c-b" }), env));
  const prompts = bodies.filter((b) => b.tools[0].name === "write_answer").map((b) => b.messages[0].content);
  assert.match(prompts[1], /<page>The person is on the page for Acme Corp\./);
});

test("partner_intel: BUG two questions in flight at once from one person left only one conversation in their history", async () => {
  const { env, token } = await piEnv(assistantRows(), { partner_intel_claude_api: "k" });
  const slow = (url, init) => {
    const reply = assistantClaude("A [n1].")(url, init);
    // The first question's answer takes longer: the second is saved while the first is still being written.
    return init.body.includes("first question") ? new Promise((done) => setTimeout(() => done(reply), 30)) : reply;
  };
  await withFetch(slow, () => Promise.all([
    pi("assistant", askBox(token, { question: "The first question about hiring?", mode: "answer" }), env),
    pi("assistant", askBox(token, { question: "The second question about quality?", mode: "answer" }), env)]));
  assert.equal((await getJson("assistant/history", env, token)).conversations.length, 2);
});

test("partner_intel: BUG one failed Box read of the saved-answer index let the app write an empty index over the Box copy", async () => {
  const { env, token } = await adminEnv({ partner_intel_claude_api: "k" });
  await env.BOX_KV.put("pi:roster", JSON.stringify({ partners: PARTNERS.map((p) => ({ ...p })), aliases: {}, staff: [], updatedAt: "r1" }));
  await republish(env, Array.from({ length: 6 }, (_, k) => pcnRow(k)), "vb");
  await setFolder(env, token, "data", "22", "Database");
  const box = (url, init = {}) => {
    if (url.includes("api.anthropic.com")) return assistantClaude("Hiring [n1].")(url, init);
    const u = new URL(url);
    if (u.pathname === "/2.0/folders" && init.method === "POST") return okJson({ id: "801" });
    if (/\/folders\/22\/items$/.test(u.pathname)) return okJson({ total_count: 1, entries: [{ type: "file", id: "950", name: "partner_intel_saved_answers.json" }] });
    if (/\/folders\/\d+\/items$/.test(u.pathname)) return okJson({ total_count: 0, entries: [] });
    if (u.pathname === "/2.0/files/950/content") return new Response("busy", { status: 503 });
    if (url.startsWith("https://upload.box.com")) return okJson({ entries: [{ id: "960" }] });
    throw new Error(`unexpected fetch ${url}`);
  };
  await withFetch(box, () => pi("assistant", askBox(token, { question: ASKED, mode: "answer" }), env));
  assert.equal(await env.BOX_KV.get("pi:mem:index"), null, "no index is written while the Box copy could not be read");
  assert.equal(await env.BOX_KV.get("pi:mem:restored"), null, "and the restore is tried again");
  assert.equal(await env.BOX_KV.get("pi:mem:dirty"), null, "so the cron has nothing to write over the Box copy");
});

test("partner_intel: BUG 'Keep' on a flagged statement later approved a company nobody had checked", async () => {
  const { env, token } = await piEnv(checkRows());
  const id = (await getJson("attribution/review", env, token)).items[0].id;
  assert.equal((await pi("attribution/decide", piReq("attribution/decide", "POST", { id, keep: true }, token), env)).status, 200);
  assert.equal((await getJson("attribution/review", env, token)).total, 0);
  // A re-link moves the statement to Gamma Labs. Staff kept Beta Works, not Gamma: it is checked again.
  await publishV2(env, checkRows().map((r, n) => (n ? r : { ...r, id, company_id: "c-c" })));
  const review = await getJson("attribution/review", env, token);
  assert.equal(review.total, 1);
  assert.equal(review.items[0].company.name, "Gamma Labs");
});

test("partner_intel: BUG editing a partner on the control panel erased its Salesforce participation id", async () => {
  const { env, token } = await piEnv([ins()]);
  assert.equal((await pi("roster/partner", piReq("roster/partner", "POST",
    { id: "c-a", name: "Acme Corp", industry: "Plastics Company", status: "Active", contacts: [], aliases: ["Acme"] }, token), env)).status, 200);
  const acme = JSON.parse(await env.BOX_KV.get("pi:roster")).partners.find((p) => p.id === "c-a");
  assert.equal(acme.participationId, "P1", "a later Salesforce rename is matched on it");
});

test("partner_intel: BUG the member file's program column, a 'Former Member' status and a company's second row were misread", () => {
  const { partners } = applyRosterCsv({ partners: [], aliases: {}, staff: [] }, sf(
    ["CIAIC", "P1", "Acme Corp", "Plastics", "Active", "Ann A", ""],
    ["PCN", "P7", "Acme Corp", "Plastics", "Inactive", "Al B", ""],
    ["CIAIC", "P2", "Beta Works", "Metals", "Former Member", "", ""]), "replace");
  const acme = partners.find((p) => p.name === "Acme Corp"), beta = partners.find((p) => p.name === "Beta Works");
  assert.equal(partners.length, 2);
  assert.equal(acme.status, "Active", "a member on any of its rows is a member; the last row used to decide");
  assert.deepEqual(acme.contacts, ["Ann A", "Al B"]);
  assert.equal(acme.program, "CIAIC; PCN", "the 'Programs & Councils' column is read");
  assert.equal(beta.status, "Inactive", "a former member is not shown as a Council Member");
});

/* ------------------------------------------------------------- the Council, compact headlines, security, pages */

/** A named function's source from a page or script, braces matched, so a test can run it on its own. */
function sourceOf(file, name) {
  const src = fs.readFileSync(file, "utf8");
  const start = src.search(new RegExp(`function ${name}\\s*\\(`));
  assert.ok(start >= 0, `function ${name} not found in ${path.basename(file)}`);
  let depth = 0, i = src.indexOf("{", start);
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) break; }
  return src.slice(start, i + 1);
}
const PUB_PI = path.join(path.dirname(SRC), "public", "partner-intel");
const escHtml = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const EVIL = "<img src=x onerror=alert(1)>";

test("partner_intel: BUG the program the notes call CIAIC was shown as CIAIC; staff see Council, and quotes and file names stay as written", async () => {
  const rows = [ins({ id: "cc1", title: "CIAIC members short on technicians", detail: "At the CIAIC, members said hiring is slow.",
    quote: "the CIAIC group agreed", meeting_id: "m-cc", meeting_label: "Q2 2025 CIAIC Notes", event_type: "CIAIC Council Meeting",
    series: "CIAIC Council Meeting", sources: [{ id: "77", name: "Q2 2025 CIAIC Notes.docx", path: "Notes/CIAIC/Q2 2025 CIAIC Notes.docx" }] })];
  const { env, token } = await piEnv(rows);
  assert.deepEqual((await getJson("programs", env, token)).programs.map((p) => p.name), ["Council"]);
  const item = (await getJson("insights?days=30", env, token)).items[0];
  assert.equal(item.title, "Council members short on technicians");
  assert.equal(item.detail, "At the Council, members said hiring is slow.");
  assert.equal(item.eventType, "Council Meeting");
  assert.equal(item.quote, "the CIAIC group agreed", "a quote keeps the words of the notes");
  assert.equal(item.sources[0].name, "Q2 2025 CIAIC Notes.docx", "a Box file keeps its name, so it can be found in Box");
  const program = await getJson("program?name=Council", env, token);
  assert.equal(program.meetings[0].label, "Q2 2025 Council Notes");
  assert.equal((await getJson("program?name=CIAIC", env, token)).program.name, "Council", "an old link naming CIAIC still opens it");
  assert.equal(councilText("an CIAIC meeting with the Conexus Indiana Advanced Industries Council"), "a Council meeting with the Conexus Council");
  assert.equal(councilText("Southern CIAIC"), "Southern Council");
});

test("partner_intel: BUG Ask could call the Council 'CIAIC', and a question about 'council members' was taken to be about the Council program", async () => {
  const rows = [ins({ id: "ca1", title: "Hiring at the council meeting", sources: [{ id: "1", name: "c.docx", path: "Notes/CIAIC/c.docx" }] }),
    ins({ id: "ca2", title: "PCN point", sources: [{ id: "2", name: "p.docx", path: "Notes/PCN/p.docx" }] })];
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  const bodies = [];
  const r = await withFetch(assistantClaude("The CIAIC raised hiring [n1].", ["What did CIAIC say about wages?"], bodies), async () =>
    (await pi("assistant", askBox(token, { question: "What has CIAIC raised?", mode: "answer" }), env)).json());
  const sent = bodies.find((b) => b.tools[0].name === "write_answer");
  assert.match(sent.system, /never CIAIC/);
  assert.ok(sent.messages[0].content.includes('<program name="Council">'), "CIAIC in the question is the Council program");
  assert.ok(!sent.messages[0].content.includes("CIAIC"), `nothing Claude reads calls it CIAIC: ${(sent.messages[0].content.match(/.{0,80}CIAIC.{0,40}/g) || []).join(" | ")}`);
  assert.equal(r.turn.answer, "The Council raised hiring [1].", "and an answer that says CIAIC anyway is shown saying Council");
  assert.deepEqual(r.turn.followUps, ["What did Council say about wages?"]);
  const members = [];
  await withFetch(assistantClaude("A [n1].", [], members), () =>
    pi("assistant", askBox(token, { question: "Which council members raised hiring?", mode: "answer" }), env));
  assert.ok(!members.find((b) => b.tools[0].name === "write_answer").messages[0].content.includes('<program name="Council">'),
    "council members means membership, not the Council's meetings");
});

test("partner_intel: BUG a trending summary could call the Council 'CIAIC'", async () => {
  const { env, token } = await piEnv([ins({ topic: "quality", company_id: "c-a" }), ins({ topic: "quality", company_id: "c-b" })], { partner_intel_claude_api: "k" });
  let system = "";
  const out = await withFetch((url, init) => { system = JSON.parse(init.body).system;
    return summaryOut(topicsIn(init).payload, (t) => ({ topic_id: t.topic_id, bullets: [{ text: "The CIAIC raised scrap.", evidence_ids: [t.evidence[0].id] }] })); },
  async () => (await pi("summarize", piReq("summarize", "POST", { days: 30, topics: ["quality"] }, token), env)).json());
  assert.match(system, /never CIAIC/);
  assert.equal(out.summaries.quality.bullets[0].text, "The Council raised scrap.");
});

test("partner_intel: COST Ask headlines sit under their program and topic instead of repeating both on every line, and still cite the right note", async () => {
  const rows = Array.from({ length: 220 }, (_, k) => ins({ id: `hl${k}`, company_id: k % 2 ? "c-a" : "c-b", topic: k % 3 ? "quality" : "talent_pipeline",
    title: `Point ${k}`, date: isoAgo(k % 80), meeting_id: `hm${k}`, meeting_label: `M${k}`,
    sources: [{ id: `s${k}`, name: "x.docx", path: k % 2 ? "Notes/PCN/x.docx" : "Notes/CIAIC/x.docx" }] }));
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  const bodies = [];
  await withFetch(assistantClaude("A [n1].", [], bodies), () => pi("assistant", askBox(token, { question: "What came up?", mode: "answer" }), env));
  const prompt = bodies.find((b) => b.tools[0].name === "write_answer").messages[0].content;
  const block = prompt.slice(prompt.indexOf("<all_notes>"), prompt.indexOf("</all_notes>"));
  const lines = block.split("\n").filter((l) => l.startsWith("[n"));
  assert.ok(lines.length > 0);
  assert.ok(lines.every((l) => /^\[n\d+\] \d{4}-\d{2}-\d{2} · (Acme Corp|Beta Works) · Issue · Point \d+$/.test(l)), lines.slice(0, 3).join("\n"));
  assert.equal(block.split("\n").filter((l) => l === "Program: PCN").length, 1, "each program heading is written once");
  assert.ok(block.split("\n").filter((l) => l.startsWith("Topic: ")).length <= 4, "and each topic once under it");
  // The reference a headline carries cites that note.
  const line = lines[lines.length - 1];
  const ref = line.slice(1, line.indexOf("]"));
  const id = `hl${line.match(/Point (\d+)$/)[1]}`;
  const r = await withFetch(assistantClaude(`About point five [${ref}].`), async () =>
    (await pi("assistant", askBox(token, { question: "What came up?", mode: "answer", fresh: true }), env)).json());
  assert.equal(r.turn.sources[0].id, id);
});

test("partner_intel: BUG numbers in the scan report and usage went into the control panel as HTML, so a crafted report could run script", () => {
  const file = path.join(PUB_PI, "control-panel", "index.html");
  const out = {};
  const el = (id) => (out[id] = out[id] || {});
  const PI = { fmtStamp: (s) => String(s), esc: escHtml };
  const report = new Function("el", "PI", "esc", `${sourceOf(file, "num")}\n${sourceOf(file, "renderReport")}\nreturn renderReport;`)(el, PI, escHtml);
  report({ started_at: "t", mode: "scan", trial_limit: EVIL, files_seen: EVIL, insights: EVIL, tokens_in: EVIL, tokens_out: EVIL,
    claude_calls_batch: EVIL, claude_calls: EVIL, units_from_archive: EVIL, ignored: { docx: EVIL }, errors: [{ file: EVIL, error: EVIL }] });
  assert.ok(!out.report.innerHTML.includes("<img"), out.report.innerHTML);
  const usage = new Function("el", "PI", "esc", "USAGE_ROWS", `${sourceOf(file, "num")}\n${sourceOf(file, "renderUsage")}\nreturn renderUsage;`)(
    el, PI, escHtml, [["summaries", "Trending topic summaries"]]);
  usage({ thisMonth: { month: "2026-10", summaries: { calls: EVIL, input: EVIL, output: EVIL, reused: EVIL } }, lastMonth: { month: "2026-09" } });
  assert.ok(!out.usage.innerHTML.includes("<img"), out.usage.innerHTML);
});

test("partner_intel: BUG an Ask history file read back from Box went onto the page unchecked", async () => {
  const { env, token } = await adminEnv({ partner_intel_claude_api: "k" });
  await env.BOX_KV.put("pi:roster", JSON.stringify({ partners: PARTNERS.map((p) => ({ ...p })), aliases: {}, staff: [], updatedAt: "r1" }));
  await republish(env, assistantRows(), "vh");
  await setFolder(env, token, "data", "22", "Database");
  const me = "poneill@conexusindiana.com";
  const body = { owner: me, conversations: [{ id: "c1", title: "Mine", turns: [
    { id: "t1", q: "Q", kind: "answer", answer: "A [1]", memory: { from: "2026-10-01T00:00:00Z", newNotes: EVIL, mode: "reused" },
      considered: { insights: EVIL, notes: 3 }, sources: [{ ref: EVIL, id: "s1", kind: "problem", title: "T", detail: "D", date: EVIL,
        company: { id: "c-a", name: "Acme" }, files: [{ name: "f.docx", url: "javascript:alert(1)" }] }] },
    { id: "t2", q: "Who?", kind: "matches", answer: "s", matches: [{ strength: EVIL, why: "w", company: { id: "c-a", name: "Acme" }, refs: [EVIL, 1] }], sources: [] }] }] };
  const box = (files) => (url) => {
    const u = new URL(url);
    const folders = { 22: [{ type: "folder", id: "50", name: "Ask history" }], 50: Object.keys(files).map((name, k) => ({ type: "file", id: String(900 + k), name })) };
    const items = u.pathname.match(/\/folders\/(\d+)\/items$/);
    if (items) return okJson({ total_count: (folders[items[1]] || []).length, entries: folders[items[1]] || [] });
    const content = u.pathname.match(/\/files\/(\d+)\/content$/);
    if (content) return new Response(JSON.stringify(Object.values(files)[Number(content[1]) - 900]));
    throw new Error(`unexpected fetch ${url}`);
  };
  const conv = (await withFetch(box({ [historyFileName(me)]: body }), () => getJson("assistant/conversation?id=c1", env, token))).conversation;
  const [t1, t2] = conv.turns;
  assert.equal(t1.memory.newNotes, 0);
  assert.equal(t1.considered.insights, undefined);
  assert.equal(t1.considered.notes, 3);
  assert.equal(t1.sources[0].ref, 0);
  assert.equal(t1.sources[0].date, "");
  assert.equal(t1.sources[0].files[0].url, "", "a link goes only to a Box file");
  assert.equal(t2.matches[0].strength, "low");
  assert.deepEqual(t2.matches[0].refs, [1]);
  // Shown in the page, a stored number cannot become HTML either.
  const cite = new Function("esc", `${sourceOf(path.join(PUB_PI, "askbox.js"), "num")}\n${sourceOf(path.join(PUB_PI, "askbox.js"), "cite")}\nreturn cite;`)(escHtml);
  assert.ok(!cite(`"><img src=x onerror=alert(1)>`, "t").includes("<img"));
});

test("partner_intel: BUG two addresses that differ only in a symbol shared one Ask history file in Box, and either could read the other's", async () => {
  assert.notEqual(historyFileName("a+b@x.test"), historyFileName("a_b@x.test"));
  const { env, token } = await adminEnv({ partner_intel_claude_api: "k" });
  await env.BOX_KV.put("pi:roster", JSON.stringify({ partners: PARTNERS.map((p) => ({ ...p })), aliases: {}, staff: [], updatedAt: "r1" }));
  await republish(env, assistantRows(), "vl");
  await setFolder(env, token, "data", "22", "Database");
  // A file under the old shared name, written for someone else.
  const theirs = JSON.stringify({ owner: "someone@else.test", conversations: [{ id: "c9", title: "Theirs", turns: [] }] });
  const box = (url) => {
    const u = new URL(url);
    if (/\/folders\/22\/items$/.test(u.pathname)) return okJson({ total_count: 1, entries: [{ type: "folder", id: "50", name: "Ask history" }] });
    if (/\/folders\/50\/items$/.test(u.pathname)) return okJson({ total_count: 1, entries: [{ type: "file", id: "901", name: "ask-history-poneill@conexusindiana.com.json" }] });
    if (u.pathname === "/2.0/files/901/content") return new Response(theirs);
    throw new Error(`unexpected fetch ${url}`);
  };
  assert.deepEqual((await withFetch(box, () => getJson("assistant/history", env, token))).conversations, []);
});

test("partner_intel: BUG the usage meter left out a paid attempt that came back without the tool call, or was declined", async () => {
  const { env, token } = await piEnv(assistantRows(), { partner_intel_claude_api: "k" });
  let n = 0;
  await withFetch((url, init) => {
    if (JSON.parse(init.body).tools[0].name === "search_terms") return termsOut(["x"]);
    return ++n === 1 ? okJson({ content: [{ type: "text", text: "Here is my answer." }], stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 50 } })
      : answerOut("A [n1].");
  }, () => pi("assistant", askBox(token, { question: "What about hiring?", mode: "answer" }), env));
  const month = () => JSON.parse(env.BOX_KV.store.get(`pi:usage:${new Date().toISOString().slice(0, 7)}`)).assistant;
  assert.equal(month().calls, 3, "search terms, the attempt with no tool call, and the answer");
  assert.equal(month().input, 5 + 1000 + 900);
  await withFetch((url, init) => (JSON.parse(init.body).tools[0].name === "search_terms" ? termsOut(["y"])
    : okJson({ content: [], stop_reason: "refusal", usage: { input_tokens: 700, output_tokens: 1 } })),
  () => pi("assistant", askBox(token, { question: "What about quality?", mode: "answer" }), env));
  assert.equal(month().input, 5 + 1000 + 900 + 5 + 700, "a declined request is paid for too");
});

test("partner_intel: BUG a follow-up after a partner search could not see which partners it found", async () => {
  const { env, token } = await piEnv(SOLVERS(), { partner_intel_claude_api: "k" });
  const bodies = [];
  const first = await withFetch(assistantClaude("unused", [], bodies), async () =>
    (await pi("assistant", askBox(token, { question: "Who can help with quality inspection?", mode: "match" }), env)).json());
  await withFetch(assistantClaude("The first one [n1].", [], bodies), () =>
    pi("assistant", askBox(token, { question: "What else has the first one said?", mode: "answer", conversationId: first.conversation.id }), env));
  const prompt = bodies.filter((b) => b.tools[0].name === "write_answer").pop().messages[0].content;
  assert.match(prompt.slice(prompt.indexOf("<earlier_conversation>")), /Partners found: 1\. Acme Corp \(high match\): Did it\./);
});

test("partner_intel: BUG a meeting page said nine companies but listed eight, and left out files without saying so", async () => {
  const partners = Array.from({ length: 9 }, (_, k) => ({ id: `c-m${k}`, name: `Maker ${k}`, industry: "Metals", status: "Active", program: "",
    participationId: `PM${k}`, contacts: [], aliases: [] }));
  const rows = partners.map((p, k) => ins({ company_id: p.id, meeting_id: "m-big", meeting_label: "Big meeting", meeting_kind: "meeting", date: "2026-10-01",
    sources: [{ id: String(500 + k), name: `file${k}.docx`, path: "Notes/PCN" }] }));
  const { env, token } = await piEnv(rows);
  await env.BOX_KV.put("pi:roster", JSON.stringify({ partners, aliases: {}, staff: [], updatedAt: "r1" }));
  const m = (await getJson("program?name=PCN", env, token)).meetings[0];
  assert.deepEqual([m.companyCount, m.companies.length, m.fileCount, m.files.length], [9, 8, 9, 5]);
  assert.match(fs.readFileSync(path.join(PUB_PI, "index.html"), "utf8"), /m\.companyCount > m\.companies\.length \? ", and "/);
});

test("partner_intel: BUG pages: an answer landed in whatever conversation was open, a non-member was saved as a former member, an emptied last page showed nothing, Home hid how many dates are estimates", () => {
  const box = fs.readFileSync(path.join(PUB_PI, "askbox.js"), "utf8");
  const page = fs.readFileSync(path.join(PUB_PI, "index.html"), "utf8");
  const panel = fs.readFileSync(path.join(PUB_PI, "control-panel", "index.html"), "utf8");
  // Each answer joins the conversation it was asked in, not whichever one is open when it comes back.
  assert.match(box, /conv\.turns\.push\(r\.turn\);[\s\S]{0,400}var shown = A\.sameConv\(box\.conv, conv\)/);
  assert.match(page, /conv\.turns\.push\(r\.turn\);[\s\S]{0,400}var shown = AU\.sameConv\(askView\.conv, conv\)/);
  assert.match(panel, /<option value="Non-member">/);
  assert.match(panel, /\["Active", "Inactive", "Non-member"\]\.indexOf\(p\.status\) >= 0 \? p\.status/);
  assert.match(panel, /!r\.items\.length && r\.total > 0 && checkOffset > 0/);
  // The estimated-dates line under Home's topics was later removed with the rest of that footer, by the owner's choice.
});

/* ============================================================ roles and app access
 * Every account is an overall admin or a user; users are given whole apps, and can be made admin of
 * particular apps. People are put on the list by writing it directly, the way a list written before
 * roles existed looks in KV, so these tests also run against code that predates roles.
 */
const { handlePcnApi } = await mod("pcn.js");
const ALLOWLIST = "beta:admin-emails";
const bearerReq = (url, token, init = {}) =>
  req(url, { ...init, headers: { ...(init.headers || {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });

/** Put someone on the list with these fields, let them set a password, and return their session. */
async function personSession(env, email, fields = {}) {
  const list = JSON.parse((await env.BOX_KV.get(ALLOWLIST)) || "[]");
  list.push({ email, username: null, ...fields });
  await env.BOX_KV.put(ALLOWLIST, JSON.stringify(list));
  const res = await beta("setup-complete", jsonReq("/api/beta/setup-complete", "POST",
    { email, username: email.split("@")[0], password: "long-enough-1" }), env);
  assert.equal(res.status, 200, `${email} should be able to set a password`);
  return (await res.json()).token;
}
const meOf = async (env, token) => beta("me", bearerReq("/api/beta/me", token), env);

/** The login handler waits a flat 300ms on every attempt. Run the many attempts below without it. */
async function withoutLoginDelay(fn) {
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (cb, ms, ...args) => real(cb, 0, ...args);
  try { return await fn(); } finally { globalThis.setTimeout = real; }
}
const loginAs = async (env, identifier, password, ip) => beta("login", req("/api/beta/login", {
  method: "POST",
  headers: { "content-type": "application/json", ...(ip ? { "cf-connecting-ip": ip } : {}) },
  body: JSON.stringify({ identifier, password }),
}), env);

test("access: an allowlist entry from before roles is an overall admin, so nobody loses access on deploy", async () => {
  const env = makeEnv();
  const key = "beta:admin-account:old@example.com";
  // Set a password through the real flow, then put the list and the account back in the shape the code
  // before roles wrote them: no role, no apps, no session version.
  await env.BOX_KV.put(ALLOWLIST, JSON.stringify([{ email: "old@example.com", username: null }]));
  await beta("setup-complete", jsonReq("/api/beta/setup-complete", "POST",
    { email: "old@example.com", password: "long-enough-1" }), env);
  const { password_hash, password_salt } = JSON.parse(await env.BOX_KV.get(key));
  await env.BOX_KV.put(ALLOWLIST, JSON.stringify([{ email: "old@example.com", username: "old" }]));
  await env.BOX_KV.put(key, JSON.stringify({ email: "old@example.com", password_hash, password_salt,
    created_at: "2026-01-01T00:00:00Z" }));

  const login = await loginAs(env, "old@example.com", "long-enough-1");
  assert.equal(login.status, 200);
  const token = (await login.json()).token;
  const me = await (await meOf(env, token)).json();
  assert.equal(me.role, "admin", "no role on file means an overall admin");
  assert.ok(me.apps.includes("partner-intel") && me.appAdmin.includes("council-data"), "an admin's lists name every app");
  assert.equal((await beta("admins", bearerReq("/api/beta/admins", token), env)).status, 200, "and can manage people");
  assert.equal((await handleMcmApi("box/status", bearerReq("/api/mcm/box/status", token), env)).status, 200);
  assert.notEqual((await pi("status", piGet("status", token), env)).status, 403);
  // Saving the list once writes the admin role down, and the person keeps it.
  await beta("admins", jsonReq("/api/beta/admins", "POST", { email: "new@example.com", firstName: "Test", lastName: "Person" }, token), env);
  assert.deepEqual(JSON.parse(await env.BOX_KV.get(ALLOWLIST)).map((a) => [a.email, a.role]),
    [["old@example.com", "admin"], ["new@example.com", "user"]]);
  assert.equal((await meOf(env, token)).status, 200, "the session from before still works");
});

test("access: a newly added person is a user with no apps, and /me says so", async () => {
  const { env, token } = await signedInEnv();
  const add = await beta("admins", jsonReq("/api/beta/admins", "POST", { email: "new@example.com", firstName: "Test", lastName: "Person" }, token), env);
  assert.equal(add.status, 200);
  assert.deepEqual((await add.json()).person, { email: "new@example.com", firstName: "Test", lastName: "Person", name: "Test Person", role: "user", apps: [], appAdmin: [] });
  const t = (await (await beta("setup-complete", jsonReq("/api/beta/setup-complete", "POST",
    { email: "new@example.com", password: "long-enough-1" }), env)).json()).token;
  assert.deepEqual(await (await meOf(env, t)).json(),
    { email: "new@example.com", firstName: "Test", lastName: "Person", name: "Test Person", role: "user", apps: [], appAdmin: [] });
  const people = (await (await beta("admins", bearerReq("/api/beta/admins", token), env)).json()).people;
  assert.deepEqual(people.map((p) => [p.email, p.role, p.has_password]),
    [["poneill@conexusindiana.com", "admin", true], ["new@example.com", "user", true]]);
});

test("access: BUG any signed-in account could read Partner Intelligence, with no way to give it to some people only", async () => {
  const { env } = await piEnv([ins()]);
  const plain = await personSession(env, "plain@example.com", { role: "user", apps: [] });
  const other = await personSession(env, "mcm-user@example.com", { role: "user", apps: ["mcm"] });
  for (const token of [plain, other]) {
    for (const route of ["home", "insights", "companies", "company?id=c-a", "programs", "facets", "assistant/history", "recent-questions"]) {
      const res = await pi(route.split("?")[0], piGet(route, token), env);
      assert.equal(res.status, 403, `${route} without access`);
      assert.match((await res.json()).error, /don't have access to this app/);
    }
    assert.equal((await pi("ask", piReq("ask", "POST", { question: "x" }, token), env)).status, 403);
    assert.equal((await pi("assistant", piReq("assistant", "POST", { question: "x" }, token), env)).status, 403);
  }
  const user = await personSession(env, "pi-user@example.com", { role: "user", apps: ["partner-intel"] });
  assert.equal((await pi("home", piGet("home", user), env)).status, 200, "given the app, they can read it");
  assert.equal((await pi("companies", piGet("companies", user), env)).status, 200);
});

test("access: BUG a Partner Intelligence user could run its control panel: scans, Box folders, the partner list", async () => {
  const { env } = await piEnv([ins()]);
  const user = await personSession(env, "pi-user@example.com", { role: "user", apps: ["partner-intel"] });
  const gets = ["status", "schedule", "run-status", "roster", "contacts", "attribution/review", "review", "topics", "box/folders"];
  for (const route of gets) {
    const res = await pi(route, piGet(route, user), env);
    assert.equal(res.status, 403, `GET ${route}`);
    assert.match((await res.json()).error, /settings/);
  }
  const posts = ["settings", "schedule", "run", "update/apply", "roster/sync", "roster/import", "roster/partner",
    "roster/partner/delete", "roster/staff", "roster/alias", "contacts/import", "attribution/decide", "review/add",
    "review/map", "topics/override"];
  for (const route of posts) assert.equal((await pi(route, piReq(route, "POST", {}, user), env)).status, 403, `POST ${route}`);
  const settingsBefore = await env.BOX_KV.get("pi:settings");
  await pi("settings", piReq("settings", "POST", { which: "notes", folderId: "999", folderName: "Mine" }, user), env);
  assert.equal(await env.BOX_KV.get("pi:settings"), settingsBefore, "a refused call changes nothing");

  const piAdmin = await personSession(env, "pi-admin@example.com", { role: "user", apps: [], appAdmin: ["partner-intel"] });
  assert.equal((await pi("status", piGet("status", piAdmin), env)).status, 200, "its app admin runs the control panel");
  assert.equal((await pi("home", piGet("home", piAdmin), env)).status, 200, "app admin implies use");
});

test("access: Partner Intelligence's split matches the pages: what the app calls is use, what the control panel calls is admin", async () => {
  // Read the routes each page actually calls, so a new route on either page lands on the right side.
  const page = (p) => fs.readFileSync(path.join(path.dirname(SRC), "public", "partner-intel", p), "utf8");
  const called = (src) => [...src.matchAll(/PI\.(?:api|post)\("([a-z][a-z/-]*)/g)].map((m) => m[1]);
  // companies is built in a variable on the Companies page; insights and ask are older staff routes.
  const staff = [...new Set([...called(page("index.html")), ...called(page("askbox.js")), "companies", "insights", "ask"])];
  const panel = [...new Set(called(page("control-panel/index.html")))];
  assert.ok(staff.includes("home") && staff.includes("assistant/history"), `staff routes found: ${staff}`);
  assert.ok(panel.includes("status") && panel.includes("roster/import"), `control panel routes found: ${panel}`);
  const { env } = await piEnv([ins()]);
  const user = await personSession(env, "pi-user@example.com", { role: "user", apps: ["partner-intel"] });
  await withFetch(() => new Response("{}", { status: 500 }), async () => {
    for (const route of staff) assert.notEqual((await pi(route, piGet(route, user), env)).status, 403, `staff route ${route}`);
    for (const route of panel) assert.equal((await pi(route, piGet(route, user), env)).status, 403, `control panel route ${route}`);
  });
});

test("access: BUG one app's admin could run every app's control panel", async () => {
  const { env } = await signedInEnv();
  const brooke = await personSession(env, "brooke@example.com", { role: "user", apps: [], appAdmin: ["council-data"] });
  const cdUser = await personSession(env, "cd-user@example.com", { role: "user", apps: ["council-data"] });
  const cd = (route, token) => handleCouncilDataApi(route, bearerReq(`/api/council-data/${route}`, token), env);
  assert.equal((await cd("box/status", brooke)).status, 200, "Brooke runs the Council Survey tool's control panel");
  const refused = await cd("box/status", cdUser);
  assert.equal(refused.status, 403, "use access alone never opens a control panel");
  assert.equal((await refused.json()).error, "You don't have access to this app's settings. Ask an admin.");
  const others = [
    ["mcm", () => handleMcmApi("box/status", bearerReq("/api/mcm/box/status", brooke), env)],
    ["stars", () => handleStarsApi("status", bearerReq("/api/stars/status", brooke), env)],
    ["artifacts", () => handleArtifactsApi("catalogue", bearerReq("/api/artifacts/catalogue", brooke), env)],
    ["consensus", () => handleConsensusApi("surveys", bearerReq("/api/consensus/surveys", brooke), env)],
    ["job-description", () => handleJobDescriptionApi("status", bearerReq("/api/job-description/status", brooke), env)],
    ["apprenticeship", () => handleApprenticeshipApi("projects", bearerReq("/api/apprenticeship/projects", brooke), env)],
    ["pcn", () => handlePcnApi("box/status", bearerReq("/api/pcn/box/status", brooke), env)],
    ["partner-intel", () => pi("status", piGet("status", brooke), env)],
  ];
  await withFetch(() => okJson({}), async () => {
    for (const [app, call] of others) assert.equal((await call()).status, 403, `${app} control panel`);
  });
  // Box is shared by every app: disconnecting it is an overall admin's call, not one app admin's.
  await env.BOX_KV.put("box:tokens", JSON.stringify({ access_token: "t", refresh_token: "r", obtained_at: 0, expires_in: 3600 }));
  assert.equal((await handleCouncilDataApi("box/disconnect", jsonReq("/api/council-data/box/disconnect", "POST", {}, brooke), env)).status, 403);
  assert.ok(await env.BOX_KV.get("box:tokens"), "the shared Box connection stays");
});

test("access: Issue Network Mapper's page needs use access, its control panel needs pcn admin", async () => {
  const { env, token } = await signedInEnv();
  const id = (await (await handlePcnApi("projects", bearerReq("/api/pcn/projects", token), env)).json()).projects[0].id;
  const user = await personSession(env, "inm@example.com", { role: "user", apps: ["pcn"] });
  const none = await personSession(env, "none@example.com", { role: "user", apps: [] });
  const get = (route, t) => handlePcnApi(route, bearerReq(`/api/pcn/${route}`, t), env);
  for (const route of ["projects", `projects/${id}`, `projects/${id}/network`, `projects/${id}/timeline`]) {
    assert.notEqual((await get(route, user)).status, 403, `${route} with use access`);
    assert.equal((await get(route, none)).status, 403, `${route} without it`);
  }
  for (const route of ["box/status", `projects/${id}/meetings`, `projects/${id}/run-status`]) {
    assert.equal((await get(route, user)).status, 403, `${route} is the control panel's`);
  }
  assert.equal((await handlePcnApi("projects", jsonReq("/api/pcn/projects", "POST", { name: "Mine" }, user), env)).status, 403);
});

test("access: BUG any signed-in account could manage people and app visibility", async () => {
  const { env } = await signedInEnv();
  const plain = await personSession(env, "plain@example.com", { role: "user", apps: ["partner-intel"] });
  const brooke = await personSession(env, "brooke@example.com", { role: "user", apps: [], appAdmin: ["council-data"] });
  for (const token of [plain, brooke]) {
    assert.equal((await beta("admins", bearerReq("/api/beta/admins", token), env)).status, 403, "list people");
    for (const [route, body] of [["admins", { email: "x@example.com", role: "admin" }],
                                 ["admins/update", { email: "plain@example.com", role: "admin" }],
                                 ["admins/update", { email: "brooke@example.com", appAdmin: ["mcm"] }],
                                 ["admins/remove", { email: "poneill@conexusindiana.com" }],
                                 ["admins/reset", { email: "poneill@conexusindiana.com" }],
                                 ["sign-out-everywhere", { email: "poneill@conexusindiana.com" }],
                                 ["app-visibility", { id: "partner-intel", tier: "public" }]]) {
      const res = await beta(route, jsonReq(`/api/beta/${route}`, "POST", body, token), env);
      assert.equal(res.status, 403, `${route} ${JSON.stringify(body)}`);
    }
  }
  const list = JSON.parse(await env.BOX_KV.get(ALLOWLIST));
  assert.deepEqual(list.map((a) => a.email), ["poneill@conexusindiana.com", "plain@example.com", "brooke@example.com"]);
  assert.equal((await (await meOf(env, plain)).json()).role, "user", "nobody promoted themselves");
  assert.equal(await env.BOX_KV.get("beta:app-visibility"), null, "visibility unchanged");
  assert.ok(await env.BOX_KV.get("beta:admin-account:poneill@conexusindiana.com"), "the admin's password was not reset");
});

test("access: an overall admin sets role, apps and app admin, and the change applies without signing out", async () => {
  const { env, token } = await signedInEnv();
  const user = await personSession(env, "u@example.com", { role: "user", apps: [] });
  assert.equal((await pi("home", piGet("home", user), env)).status, 403);
  const update = (body) => beta("admins/update", jsonReq("/api/beta/admins/update", "POST", { email: "u@example.com", ...body }, token), env);
  assert.equal((await update({ apps: ["partner-intel"] })).status, 200);
  assert.notEqual((await pi("home", piGet("home", user), env)).status, 403, "the same session now reads it");
  assert.equal((await pi("status", piGet("status", user), env)).status, 403);
  const r = await update({ appAdmin: ["partner-intel"] });
  assert.deepEqual((await r.json()).person.appAdmin, ["partner-intel"]);
  assert.notEqual((await pi("status", piGet("status", user), env)).status, 403, "and now runs its control panel");
  assert.equal((await update({ role: "admin" })).status, 200);
  assert.equal((await beta("admins", bearerReq("/api/beta/admins", user), env)).status, 200, "an overall admin manages people");
  assert.equal((await update({ role: "user", apps: [], appAdmin: [] })).status, 200);
  assert.equal((await pi("home", piGet("home", user), env)).status, 403, "and access comes away just as fast");
  for (const body of [{ role: "owner" }, { role: "constructor" }, { apps: ["nope"] }, { apps: ["constructor"] },
                      { appAdmin: ["__proto__"] }, { apps: "partner-intel" }]) {
    assert.equal((await update(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await beta("admins/update", jsonReq("/api/beta/admins/update", "POST", { email: "nobody@example.com", role: "user" }, token), env)).status, 404);
});

test("access: BUG anyone could start replacing the shared Box connection", async () => {
  // GET /api/box/authorize-url had no authentication: anyone could start the Box login, and whoever
  // finished it pointed every app at their own Box account.
  const { env, token } = await signedInEnv();
  const brooke = await personSession(env, "brooke@example.com", { role: "user", apps: [], appAdmin: ["council-data"] });
  const states = async () => [...env.BOX_KV.store.keys()].filter((k) => k.startsWith("box:state:")).length;
  const authorize = (t) => workerModule.default.fetch(bearerReq("/api/box/authorize-url", t), env, {});
  assert.equal((await authorize(null)).status, 401, "anonymous");
  assert.equal((await authorize("forged.token")).status, 401);
  assert.equal((await authorize(brooke)).status, 403, "even the Council Survey tool's own admin");
  assert.equal(await states(), 0, "no login was started");
  const ok = await authorize(token);
  assert.equal(ok.status, 200, "an overall admin can");
  assert.match((await ok.json()).url, /^https:\/\/account\.box\.com\/api\/oauth2\/authorize\?/);
  assert.equal(await states(), 1);
});

test("access: BUG unlimited password guesses: the sixth wrong password is refused with 429, even when right", async () => {
  const { env } = await signedInEnv();
  await withoutLoginDelay(async () => {
    // The same email in any case is the same account, so switching case buys nothing.
    for (const id of ["poneill@conexusindiana.com", "POneill@conexusindiana.com", "poneill@CONEXUSINDIANA.com", "poneill@conexusindiana.com", "poneill@conexusindiana.com"]) {
      assert.equal((await loginAs(env, id, "wrong-guess")).status, 401, id);
    }
    const locked = await loginAs(env, "poneill@conexusindiana.com", "seed-password-123");
    assert.equal(locked.status, 429, "locked, even for the right password");
    assert.match((await locked.json()).error, /Too many wrong passwords\. Wait 15 minutes/);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 16 * 60 * 1000;
      assert.equal((await loginAs(env, "poneill@conexusindiana.com", "seed-password-123")).status, 200, "the lock lifts after 15 minutes");
      // A successful sign-in clears the count: four more misses do not lock.
      for (let i = 0; i < 4; i++) assert.equal((await loginAs(env, "poneill@conexusindiana.com", "wrong-guess")).status, 401);
      assert.equal((await loginAs(env, "poneill@conexusindiana.com", "seed-password-123")).status, 200);
      for (let i = 0; i < 4; i++) assert.equal((await loginAs(env, "poneill@conexusindiana.com", "wrong-guess")).status, 401);
      assert.equal((await loginAs(env, "poneill@conexusindiana.com", "seed-password-123")).status, 200, "the count started again after success");
    } finally { Date.now = realNow; }
  });
});

test("access: one client address is limited across accounts, so it cannot spray every account", async () => {
  const { env } = await signedInEnv();
  await personSession(env, "a@example.com", { role: "user" });
  await withoutLoginDelay(async () => {
    // Four misses each at five accounts: no account reaches its own limit of five.
    for (const id of ["x1@example.com", "x2@example.com", "x3@example.com", "x4@example.com", "a@example.com"]) {
      for (let i = 0; i < 4; i++) assert.equal((await loginAs(env, id, "wrong", "203.0.113.9")).status, 401);
    }
    assert.equal((await loginAs(env, "a@example.com", "long-enough-1", "203.0.113.9")).status, 429, "twenty from one address lock it");
    assert.equal((await loginAs(env, "a@example.com", "long-enough-1", "198.51.100.7")).status, 200, "another address is not affected");
  });
});

test("access: BUG a session outlived Sign out everywhere, removal and a password reset", async () => {
  const { env, token } = await signedInEnv();
  const signIn = async () => (await (await loginAs(env, "u@example.com", "long-enough-1")).json()).token;
  await personSession(env, "u@example.com", { role: "user", apps: ["partner-intel"] });
  const [laptop, phone] = [await signIn(), await signIn()];
  assert.equal((await meOf(env, phone)).status, 200);
  // Anyone may sign themselves out everywhere.
  const self = await beta("sign-out-everywhere", jsonReq("/api/beta/sign-out-everywhere", "POST", {}, laptop), env);
  assert.equal(self.status, 200);
  assert.equal((await meOf(env, laptop)).status, 401, "this session ends");
  assert.equal((await meOf(env, phone)).status, 401, "and every other one");
  const again = await signIn();
  assert.equal((await meOf(env, again)).status, 200, "signing in again works");
  // An overall admin may do it to anyone.
  assert.equal((await beta("sign-out-everywhere", jsonReq("/api/beta/sign-out-everywhere", "POST", { email: "u@example.com" }, token), env)).status, 200);
  assert.equal((await meOf(env, again)).status, 401);
  assert.equal((await meOf(env, token)).status, 200, "the admin's own session is untouched");
  // A password reset ends their sessions too.
  const beforeReset = await signIn();
  await beta("admins/reset", jsonReq("/api/beta/admins/reset", "POST", { email: "u@example.com" }, token), env);
  assert.equal((await meOf(env, beforeReset)).status, 401, "a reset ends the sessions issued before it");
  assert.equal((await pi("home", piGet("home", beforeReset), env)).status, 401, "in every app, not just /me");
  // So does removal.
  await beta("setup-complete", jsonReq("/api/beta/setup-complete", "POST", { email: "u@example.com", password: "long-enough-2" }), env);
  const beforeRemoval = (await (await loginAs(env, "u@example.com", "long-enough-2")).json()).token;
  assert.equal((await meOf(env, beforeRemoval)).status, 200);
  const removed = await beta("admins/remove", jsonReq("/api/beta/admins/remove", "POST", { email: "u@example.com" }, token), env);
  assert.equal(removed.status, 200);
  assert.equal((await meOf(env, beforeRemoval)).status, 401, "removal ends their sessions");
  assert.equal((await loginAs(env, "u@example.com", "long-enough-2")).status, 401, "and they cannot sign in");
  assert.equal((await (await beta("setup-check", jsonReq("/api/beta/setup-check", "POST", { email: "u@example.com" }), env)).json()).allowed,
    false, "or set a new password");
});

test("access: BUG the last overall admin could be removed or demoted", async () => {
  const { env, token } = await signedInEnv();
  const me = "poneill@conexusindiana.com";
  const post = (route, body, t = token) => beta(route, jsonReq(`/api/beta/${route}`, "POST", body, t), env);
  const demote = await post("admins/update", { email: me, role: "user" });
  assert.equal(demote.status, 409);
  assert.match((await demote.json()).error, /at least one admin/);
  assert.equal((await post("admins/remove", { email: me })).status, 409);
  assert.equal((await (await meOf(env, token)).json()).role, "admin", "still an admin");
  // A user on the list does not count: there is still only one admin.
  await post("admins", { email: "u@example.com", firstName: "U", lastName: "Ser" });
  assert.equal((await post("admins/remove", { email: me })).status, 409);
  // With a second admin, either can go.
  await post("admins", { email: "second@example.com", firstName: "Sec", lastName: "Ond", role: "admin" });
  assert.equal((await post("admins/update", { email: me, role: "user" })).status, 200);
  const second = (await (await beta("setup-complete", jsonReq("/api/beta/setup-complete", "POST",
    { email: "second@example.com", password: "long-enough-1" }), env)).json()).token;
  assert.equal((await post("admins/remove", { email: "second@example.com" }, second)).status, 409, "the remaining admin cannot remove themselves");
  assert.equal((await post("admins/remove", { email: "u@example.com" }, second)).status, 200, "a user can be removed");
});

test("access: every control panel page checks that app's admin, and the staff pages check use access", () => {
  // The page-side check shows "You don't have access" instead of a broken panel. The API refuses
  // regardless; this keeps a page from forgetting to ask.
  const root = path.join(path.dirname(SRC), "public");
  const gate = (file) => {
    const html = fs.readFileSync(path.join(root, file), "utf8");
    const m = html.match(/<script src="\/access\.js"(?: data-app="([a-z-]+)")? data-need="([a-z]+)"><\/script>/);
    assert.ok(m, `${file} loads /access.js`);
    assert.ok(html.indexOf(m[0]) < html.indexOf("</head>"), `${file} loads it in <head>, before the page shows`);
    return [m[1] || "", m[2]];
  };
  const panels = {
    "council-data/control-panel/index.html": "council-data", "mcm/control-panel/index.html": "mcm",
    "inm/control-panel/index.html": "pcn", "consensus/control-panel/index.html": "consensus",
    "consensus/control-panel/results.html": "consensus", "stars/control-panel/index.html": "stars",
    "artifacts/control-panel/index.html": "artifacts", "job-description/control-panel/index.html": "job-description",
    "apprenticeship/control-panel/index.html": "apprenticeship", "apprenticeship/control-panel/responses.html": "apprenticeship",
    "partner-intel/control-panel/index.html": "partner-intel",
  };
  for (const [file, app] of Object.entries(panels)) assert.deepEqual(gate(file), [app, "admin"], file);
  assert.deepEqual(gate("partner-intel/index.html"), ["partner-intel", "use"]);
  assert.deepEqual(gate("inm/index.html"), ["pcn", "use"]);
  assert.deepEqual(gate("admin/settings.html"), ["", "overall"]);
  // Every app's control panel is covered: none added to apps.js without one here.
  const apps = fs.readFileSync(path.join(root, "apps.js"), "utf8");
  for (const [, id] of apps.matchAll(/\bid: "([a-z-]+)"/g)) assert.ok(Object.values(panels).includes(id), `${id} has a gated control panel`);
});

/* ---------------------------------------------------- partner_intel: QA round 2, the relay */
const relayGet = (env, route) => pi(`relay/${route.split("?")[0]}`,
  req(`/api/partner-intel/relay/${route}`, { headers: { "x-pipeline-key": "relay-secret" } }), env);
const relayPost = (env, route, body) => pi(`relay/${route}`, relay(route, "POST", body), env);

test("partner_intel: BUG the whole scan state travelled in one request; it is saved in pages and switched to at a commit", async () => {
  // At about 10 KB a section, one body for some 4,500 sections is more than the Worker can parse
  // and re-split in 128 MB, and a write that died half-way left a mix of old and new shards.
  const env = makeEnv();
  const one = "write-one-0001", two = "write-two-0002", three = "write-three-03";
  assert.equal((await relayPost(env, "state/begin", { write: one })).status, 200);
  assert.equal((await relayPost(env, "state/page", { write: one, kind: "registry", index: 0, items: [["f1", { name: "a.docx" }]] })).status, 200);
  assert.equal((await relayPost(env, "state/page", { write: one, kind: "cache", index: 0, items: [["k1", { rows: [1] }]] })).status, 200);
  assert.equal((await relayPost(env, "state/page", { write: one, kind: "cache", index: 1, items: [["k2", { rows: [2] }]] })).status, 200);
  assert.equal((await (await relayGet(env, "state/meta")).json()).write, "", "nothing is saved until the commit");
  const committed = await (await relayPost(env, "state/commit", { write: one, pages: { registry: 1, cache: 2 }, files: 1, units: 2 })).json();
  assert.deepEqual([committed.files, committed.units], [1, 2]);
  const meta = await (await relayGet(env, "state/meta")).json();
  assert.deepEqual([meta.write, meta.pages], [one, { registry: 1, cache: 2 }]);
  assert.deepEqual((await (await relayGet(env, `state/page?kind=cache&index=1&write=${one}`)).json()).items, [["k2", { rows: [2] }]]);

  // A second write that stops part-way changes nothing a reader sees.
  await relayPost(env, "state/begin", { write: two });
  await relayPost(env, "state/page", { write: two, kind: "registry", index: 0, items: [["f9", { name: "z.docx" }]] });
  assert.equal((await (await relayGet(env, "state/meta")).json()).write, one, "half a write is never the saved state");
  assert.deepEqual(Object.keys((await (await relayGet(env, "state")).json()).cache), ["k1", "k2"]);
  const early = await relayPost(env, "state/commit", { write: two, pages: { registry: 1, cache: 1 } });
  assert.equal(early.status, 503, "a commit naming a page that never arrived is refused, retryably");
  assert.equal((await (await relayGet(env, "state/meta")).json()).write, one);

  // The next write clears the abandoned one; its commit retires the previous state's pages.
  await relayPost(env, "state/begin", { write: three });
  assert.equal(await env.BOX_KV.get(`pi:state:w:${two}:registry:0`), null, "the abandoned write's pages are cleared");
  await relayPost(env, "state/page", { write: three, kind: "registry", index: 0, items: [["f3", { name: "c.docx" }]] });
  assert.equal((await relayPost(env, "state/commit", { write: three, pages: { registry: 1, cache: 0 }, files: 2, units: 0 })).status, 409,
    "counts that do not match the pages are refused");
  assert.equal((await relayPost(env, "state/commit", { write: three, pages: { registry: 1, cache: 0 }, files: 1, units: 0 })).status, 200);
  assert.equal(await env.BOX_KV.get(`pi:state:w:${one}:cache:1`), null, "the previous state's pages are deleted");
  assert.equal((await relayPost(env, "state/commit", { write: three, pages: { registry: 1, cache: 0 } })).status, 200, "a replayed commit");
  assert.notEqual(await env.BOX_KV.get(`pi:state:w:${three}:registry:0`), null, "a replayed commit deletes nothing it needs");
  assert.equal((await relayGet(env, `state/page?kind=cache&index=0&write=${one}`)).status, 409, "a read across a commit is refused");

  // Pages are checked.
  assert.equal((await relayPost(env, "state/page", { write: "write-four-04", kind: "constructor", index: 0, items: [] })).status, 400);
  assert.equal((await relayPost(env, "state/page", { write: "write-four-04", kind: "cache", index: 0, items: [["k", "text"]] })).status, 400);
  assert.equal((await relayPost(env, "state/page", { write: "../../x", kind: "cache", index: 0, items: [] })).status, 400);
  assert.equal((await relayPost(env, "state/page", { write: three, kind: "cache", index: 0, items: [] })).status, 409,
    "the saved state is never changed in place");
  assert.equal((await relayGet(env, "state/page?kind=__proto__&index=0")).status, 400);
  assert.equal((await pi("relay/state/meta", relay("state/meta", "GET", undefined, "wrong"), env)).status, 401);
});

test("partner_intel: state saved before pages is still read, and replaced by the next commit", async () => {
  const env = makeEnv();
  await env.BOX_KV.put("pi:state:meta", JSON.stringify({ registryShards: 1, cacheShards: 2, updatedAt: "x" }));
  await env.BOX_KV.put("pi:state:registry:0", JSON.stringify([["f1", { name: "a.docx" }]]));
  await env.BOX_KV.put("pi:state:cache:0", JSON.stringify([["k1", { rows: [] }]]));
  await env.BOX_KV.put("pi:state:cache:1", JSON.stringify([["k2", { rows: [] }]]));
  const meta = await (await relayGet(env, "state/meta")).json();
  assert.deepEqual([meta.layout, meta.write, meta.pages], [1, "", { registry: 1, cache: 2 }]);
  assert.deepEqual((await (await relayGet(env, "state/page?kind=cache&index=1&write=")).json()).items, [["k2", { rows: [] }]]);
  assert.deepEqual(Object.keys((await (await relayGet(env, "state")).json()).cache), ["k1", "k2"]);
  await relayPost(env, "state/begin", { write: "write-new-0001" });
  await relayPost(env, "state/page", { write: "write-new-0001", kind: "cache", index: 0, items: [["k3", { rows: [] }]] });
  await relayPost(env, "state/commit", { write: "write-new-0001", pages: { registry: 0, cache: 1 } });
  assert.equal(await env.BOX_KV.get("pi:state:cache:1"), null, "the old shards are deleted once replaced");
  assert.deepEqual(Object.keys((await (await relayGet(env, "state")).json()).cache), ["k3"]);
});

test("partner_intel: BUG the Box state file could outgrow one upload; its parts may be saved and read", async () => {
  const { env, token } = await adminEnv();
  await setFolder(env, token, "data", "22", "Database");
  const uploads = [];
  const handler = boxFake({ 22: [fileItem("701", "partner_intel_state.a.001.json", "2026-01-01T00:00:00Z")] }, { 701: '{"part":1}' }, uploads);
  const save = (name) => withFetch(handler, () => relayPost(env, "box/save", { name, text: "{}" }));
  assert.equal((await save("partner_intel_state.a.001.json")).status, 200);
  assert.equal((await save("partner_intel_state.b.123.json")).status, 200);
  for (const bad of ["partner_intel_state.c.001.json", "partner_intel_state.a.1.json", "partner_intel_state.a.001.json.exe", "../partner_intel_state.a.001.json"]) {
    assert.equal((await save(bad)).status, 400, bad);
  }
  const load = (name) => withFetch(handler, () => relayGet(env, `box/load?name=${encodeURIComponent(name)}`));
  assert.equal(await (await load("partner_intel_state.a.001.json")).text(), '{"part":1}');
  assert.equal((await load("partner_intel_state.b.002.json")).status, 404);
});

test("partner_intel: BUG undated backfills were dated on upload; the Box listing now carries each file's own times", async () => {
  const env = makeEnv();
  await env.BOX_KV.put("box:tokens", JSON.stringify({ access_token: "tok", refresh_token: "r", obtained_at: Math.floor(Date.now() / 1000), expires_in: 3600 }));
  let asked = "";
  const listing = await withFetch((url) => {
    asked = new URL(url).searchParams.get("fields");
    return okJson({ total_count: 1, entries: [{ type: "file", id: "5", name: "old notes.docx", size: 10, sha1: "s",
      created_at: "2026-10-20T15:00:00-07:00", modified_at: "2026-10-20T15:00:00-07:00",
      content_created_at: "2024-03-01T09:00:00-05:00", content_modified_at: "2024-03-05T09:30:00-05:00" }] });
  }, async () => (await relayGet(env, "box/folder?id=77")).json());
  assert.ok(asked.split(",").includes("content_modified_at") && asked.split(",").includes("content_created_at"),
    "a fields list returns only what it names, so the file's own times are asked for");
  assert.equal(listing.entries[0].content_modified_at, "2024-03-05T09:30:00-05:00");
  assert.equal(listing.entries[0].content_created_at, "2024-03-01T09:00:00-05:00");
});

test("partner_intel: BUG the published dataset travelled in one request too; it goes in pages and is swapped in at a commit", async () => {
  // At about 1.3 KB an insight, a scan of a few thousand sections publishes a body the Worker
  // cannot parse and re-split in 128 MB, sooner than the state does.
  const { env, token } = await piEnv([ins({ title: "Old one" })]);
  const before = await env.BOX_KV.get("pi:data:meta");
  const up = "upload-one-001";
  assert.equal((await relayPost(env, "publish/begin", { upload: up })).status, 200);
  assert.equal((await relayPost(env, "publish/page", { upload: up, index: 0, insights: [ins({ title: "New A" }), ins({ title: "New B" })] })).status, 200);
  assert.equal((await relayPost(env, "publish/page", { upload: up, index: 1, insights: [ins({ title: "New C" })] })).status, 200);
  assert.equal(await env.BOX_KV.get("pi:data:meta"), before, "nothing is published before the commit");
  assert.equal((await relayPost(env, "publish/commit", { upload: up, chunks: 3, insights: 3,
    dataset: { version: "paged-1", generated_at: "2026-10-22T00:00:00+00:00", roster_updated_at: "r1", topics: TOPICS, events: [], companies: [], unmatched: [], stats: {}, schema: 2 } })).status,
  503, "a page that never arrived stops the commit");
  assert.equal((await relayPost(env, "publish/commit", { upload: up, chunks: 2, insights: 5, dataset: { version: "x" } })).status, 409);
  const res = await relayPost(env, "publish/commit", { upload: up, chunks: 2, insights: 3,
    dataset: { version: "paged-1", generated_at: "2026-10-22T00:00:00+00:00", roster_updated_at: "r1", topics: TOPICS, events: [], companies: [], unmatched: [], stats: {}, schema: 2 } });
  assert.equal(res.status, 200);
  const meta = JSON.parse(await env.BOX_KV.get("pi:data:meta"));
  assert.deepEqual([meta.version, meta.chunks, meta.insightCount, meta.schema], ["paged-1", 2, 3, 2]);
  const titles = (await getJson("insights?limit=10", env, token)).items.map((i) => i.title).sort();
  assert.deepEqual(titles, ["New A", "New B", "New C"]);
  assert.equal(await env.BOX_KV.get(`pi:data:stage:${up}:0`), null, "the staged pages are cleared");
  // A publish that stops part-way leaves the published dataset as it was, and the next clears it.
  await relayPost(env, "publish/begin", { upload: "upload-two-002" });
  await relayPost(env, "publish/page", { upload: "upload-two-002", index: 0, insights: [ins({ title: "Never shown" })] });
  assert.deepEqual((await getJson("insights?limit=10", env, token)).items.map((i) => i.title).sort(), ["New A", "New B", "New C"]);
  await relayPost(env, "publish/begin", { upload: "upload-three-3" });
  assert.equal(await env.BOX_KV.get("pi:data:stage:upload-two-002:0"), null);
  assert.equal((await relayPost(env, "publish/page", { upload: "upload-three-3", index: 0, insights: ["text"] })).status, 400);
  assert.equal((await relayPost(env, "publish/page", { upload: "../x", index: 0, insights: [] })).status, 400);
  assert.equal((await pi("relay/publish/begin", relay("publish/begin", "POST", { upload: "upload-four-04" }, "wrong"), env)).status, 401);
});

test("partner_intel: BUG a row whose company was a person's name (the pipeline's company_is_person) showed no Check company and never reached Statements to check", async () => {
  const { env, token } = await piEnv([ins({ id: "cp1", company_id: "c-a", review: ["company_is_person"] }), ins({ id: "cp2", company_id: "c-b" })]);
  assert.equal((await getJson("insights?days=30", env, token)).items.find((i) => i.id === "cp1").checkCompany, true);
  assert.deepEqual((await getJson("attribution/review", env, token)).items.map((i) => i.id), ["cp1"]);
});

test("partner_intel: BUG Home, Field Demos, Council, PCN, ITA and Board Meetings said 'Writing the summary' after an update until the next scan; the cron now notices and writes them", async () => {
  const folders = ["Field Demo Visits", "CIAIC", "PCN", "ITA", "Board Meetings"];
  const rows = [...trendingRows(), ...folders.flatMap((f, n) => ["c-a", "c-b"].map((c, k) => ins({ topic: "quality", company_id: c,
    meeting_id: `am${n}${k}`, meeting_label: `Meeting ${n}${k}`, scope: f === "Board Meetings" ? "internal" : "partner", sources: [{ id: `a${n}${k}`, name: "a.docx", path: `Notes/${f}/a.docx` }] })))];
  const { env, token } = await piEnv(rows, { partner_intel_claude_api: "k" });
  const writer = (url, init) => summaryOut(topicsIn(init).payload, (x) => ({ topic_id: x.topic_id, bullets: [{ text: "P.", evidence_ids: [x.evidence[0].id] }] }));
  const pages = ["home", ...["Field Demo Visits", "Council", "PCN", "ITA", "Board Meetings"].map((p) => `program?name=${encodeURIComponent(p)}`)];
  const unwritten = async () => {
    const out = [];
    for (const p of pages) { const r = await getJson(p, env, token); if (!r.trending || !r.trending.length || r.trending.some((g) => !g.summary)) out.push(`${p}: ${r.error || (r.trending || []).length}`); }
    return out;
  };
  await withFetch(writer, () => runSummariesAhead(env));
  assert.deepEqual(await unwritten(), [], "after a publish, every one opens written, Field Demo Visits included");
  // A new version of the app saves summaries under new keys: every saved one is out of date, and no
  // scan has run to queue them again.
  // A new version of the app: nothing is marked written under it, as on the first tick after a deploy.
  for (const k of [...env.BOX_KV.store.keys()]) if (/^pi:sum:[0-9a-f]{20,}/.test(k)) env.BOX_KV.store.delete(k);
  await env.BOX_KV.delete("pi:sum:ahead-done");
  assert.equal((await unwritten()).length, pages.length);
  await withFetch(writer, () => runSummariesAhead(env));
  assert.deepEqual(await unwritten(), [], "the next cron tick writes them, so nobody waits");
  let calls = 0;
  const quiet = await withFetch(() => { calls++; throw new Error("no call expected"); }, () => runSummariesAhead(env));
  assert.deepEqual([calls, quiet.done || []], [0, []], "nothing changed since: the next tick writes nothing and calls nothing");
  // Staff moving a statement changes the company a summary names: caught as well.
  await pi("attribution/decide", piReq("attribution/decide", "POST", { id: rows[rows.length - 1].id, companyId: "c-c" }, token), env);
  await withFetch(writer, () => runSummariesAhead(env));
  assert.deepEqual(await unwritten(), []);
});

test("partner_intel: the link bar stays at the top while a page scrolls, with a faint shadow once scrolled", () => {
  const pub = path.join(path.dirname(SRC), "public", "partner-intel");
  const css = fs.readFileSync(path.join(pub, "pi.css"), "utf8");
  const js = fs.readFileSync(path.join(pub, "pi.js"), "utf8");
  assert.match(css, /\.appbar \{[^}]*position:sticky; top:0;/);
  assert.match(css, /\.appbar\.raised \{ box-shadow:/);
  assert.match(js, /classList\.toggle\("raised"/);
  assert.match(js, /addEventListener\("scroll", raiseBar/);
});

test("site: the home page is the sign-in page, and the old sign-in address forwards to it with its query", () => {
  const pub = path.join(path.dirname(SRC), "public");
  const home = fs.readFileSync(path.join(pub, "index.html"), "utf8");
  assert.match(home, /id="loginBtn"/);
  assert.match(home, /id="setupCard"/, "set up and forgot password are there too");
  assert.match(home, /--navy:#07214E/, "themed like the admin pages");
  assert.ok(!home.includes("apps.js"), "no public list of apps");
  assert.match(fs.readFileSync(path.join(pub, "admin", "login.html"), "utf8"), /location\.replace\("\/" \+ location\.search \+ location\.hash\)/);
});

test("partner_intel: BUG two answers finishing at the same moment, from two devices, left only one of them in the person's history", async () => {
  const { env, token } = await piEnv(assistantRows(), { partner_intel_claude_api: "k" });
  // A slow store, so the two requests' reads and writes interleave the way two devices' do.
  const kv = env.BOX_KV, get = kv.get.bind(kv), put = kv.put.bind(kv);
  kv.get = async (...a) => { await new Promise((r) => setTimeout(r, 3)); return get(...a); };
  kv.put = async (...a) => { await new Promise((r) => setTimeout(r, 3)); return put(...a); };
  const first = await withFetch(assistantClaude("A [n1]."), async () =>
    (await pi("assistant", askBox(token, { question: "What about hiring?", mode: "answer" }), env)).json());
  await withFetch(assistantClaude("B [n1]."), () => Promise.all([
    pi("assistant", askBox(token, { question: "And on the phone: wages?", mode: "answer", conversationId: first.conversation.id }), env),
    pi("assistant", askBox(token, { question: "And on the laptop: quality?", mode: "answer", conversationId: first.conversation.id }), env)]));
  const conv = (await getJson(`assistant/conversation?id=${first.conversation.id}`, env, token)).conversation;
  assert.deepEqual(conv.turns.map((t) => t.q).sort(), ["And on the laptop: quality?", "And on the phone: wages?", "What about hiring?"]);
});

test("partner_intel: BUG the Ask box and Ask page took one question at a time, and a second device seemed to be answering another question", () => {
  const box = fs.readFileSync(path.join(PUB_PI, "askbox.js"), "utf8");
  const page = fs.readFileSync(path.join(PUB_PI, "index.html"), "utf8");
  assert.ok(!/box\.busy|busyIn/.test(box), "no single busy flag in the Ask box");
  assert.ok(!/\bwaiting\b/.test(page), "nor in the Ask page");
  assert.match(box, /box\.pending\.push\(item\)/);
  assert.match(page, /askView\.pending\.push\(item\)/);
});

test("partner_intel: a follow-up asked before a new conversation's first answer waits for it, so both land in one conversation", async () => {
  const src = fs.readFileSync(path.join(PUB_PI, "askbox.js"), "utf8");
  const block = src.slice(src.indexOf("  A.send = function"), src.indexOf("  /** Is this pending question"));
  const sent = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const PI = { post: (route, body) => { sent.push(body.conversationId);
    return (sent.length === 1 ? gate : Promise.resolve()).then(() => ({ conversation: { id: "c-real", title: "T" }, turn: {} })); } };
  const A = new Function("PI", `var A = {}; ${block}; return A;`)(PI);
  const conv = A.newConv("");
  const one = A.send(conv, { question: "first" });
  const two = A.send(conv, { question: "second" });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(sent, [""], "the follow-up has not gone yet: it waits for the conversation's id");
  release();
  await Promise.all([one, two]);
  assert.deepEqual(sent, ["", "c-real"]);
  assert.equal(conv.id, "c-real");
  assert.equal(conv.temp, false);
});

test("access: accounts are email and password only, and an admin adding a person enters their first and last name", async () => {
  const { env, token } = await signedInEnv();
  const post = (route, body, t = token) => beta(route, jsonReq(`/api/beta/${route}`, "POST", body, t), env);
  const noName = await post("admins", { email: "brooke@example.com" });
  assert.equal(noName.status, 400);
  assert.match((await noName.json()).error, /first and last name/);
  assert.equal((await post("admins", { email: "brooke@example.com", firstName: "  Brooke ", lastName: "Smith" })).status, 200);
  // No username is asked for when they set up: email and a password.
  const set = await (await beta("setup-complete", jsonReq("/api/beta/setup-complete", "POST",
    { email: "brooke@example.com", password: "long-enough-1" }), env)).json();
  assert.equal(set.name, "Brooke Smith");
  assert.equal((await loginAs(env, "brooke@example.com", "long-enough-1")).status, 200);
  // An old username no longer signs anyone in.
  const list = JSON.parse(await env.BOX_KV.get(ALLOWLIST));
  list.find((a) => a.email === "brooke@example.com").username = "brooke";
  await env.BOX_KV.put(ALLOWLIST, JSON.stringify(list));
  assert.equal((await loginAs(env, "brooke", "long-enough-1")).status, 401);
  // An admin can correct the name; an empty one is refused.
  assert.equal((await post("admins/update", { email: "brooke@example.com", firstName: "Brook", lastName: "Smith" })).status, 200);
  assert.equal((await post("admins/update", { email: "brooke@example.com", firstName: " " })).status, 400);
  const people = (await (await beta("admins", bearerReq("/api/beta/admins", token), env)).json()).people;
  assert.equal(people.find((p) => p.email === "brooke@example.com").name, "Brook Smith");
  assert.ok(!("username" in JSON.parse(await env.BOX_KV.get(ALLOWLIST))[0]), "usernames are no longer stored");
  const home = fs.readFileSync(path.join(path.dirname(SRC), "public", "index.html"), "utf8");
  assert.ok(!/username/i.test(home.replace(/autocomplete="[^"]*"/g, "")), "the sign-in page asks for no username");
  const settings = fs.readFileSync(path.join(path.dirname(SRC), "public", "admin", "settings.html"), "utf8");
  assert.match(settings, /id="newFirst"/);
  assert.match(settings, /id="newLast"/);
});

test("partner_intel: BUG on a phone the Ask pill's prompt ran onto a second line the one-line pill cut in half", () => {
  const src = fs.readFileSync(path.join(PUB_PI, "askbox.js"), "utf8");
  const block = src.slice(src.indexOf("  A.fitPlaceholder = function"), src.indexOf("  /* ---- the floating box */"));
  const A = new Function(`var A = {}; ${block}; return A;`)();
  // A stand-in textarea: one line is 26px, and text wider than the box wraps to two.
  const box = (width) => ({ value: "", style: { height: "26px" }, clientHeight: 26, placeholder: "",
    get scrollHeight() { return this.placeholder.length * 8.5 > width ? 51 : 26; } });
  const phone = box(248), wide = box(400);
  A.fitPlaceholder(phone, "Ask anything about the partner notes", "Ask about the notes");
  A.fitPlaceholder(wide, "Ask anything about the partner notes", "Ask about the notes");
  assert.equal(phone.placeholder, "Ask about the notes");
  assert.equal(wide.placeholder, "Ask anything about the partner notes");
  assert.equal(phone.style.height, "26px", "the height is put back");
});

test("access: Settings lists each person as a name link and a role, and the rest is in their popup", () => {
  const page = fs.readFileSync(path.join(path.dirname(SRC), "public", "admin", "settings.html"), "utf8");
  const row = page.slice(page.indexOf("  function render() {"), page.indexOf("  function loadPeople() {"));
  assert.match(row, /class="link pname" data-act="open">' \+ esc\(nameOf\(p\)\)/, "the name is the link, the email when there is no name");
  assert.match(row, /"Admin" : "User"/);
  assert.ok(!/reset|signout|remove|Password set|accessLine/.test(row), "nothing else in the list");
  assert.match(page, /id="personModal"/);
  const popup = page.slice(page.indexOf("  function modalHtml(p) {"), page.indexOf("  function openModal(email) {"));
  for (const part of ["editorHtml(p)", 'data-act="reset"', 'data-act="signout"', 'data-act="remove"', 'role="dialog"']) {
    assert.ok(popup.includes(part), `the popup has ${part}`);
  }
  assert.match(page, /e\.key === "Escape" && openEmail\) closeModal\(\)/);
});

test("partner_intel: every + bullet has a 'See examples' link after it that opens it, and reads 'Hide examples' while open", () => {
  const page = fs.readFileSync(path.join(PUB_PI, "index.html"), "utf8");
  const points = page.slice(page.indexOf("  function pointsHtml(points, label) {"), page.indexOf("  function bulletsHtml(summary) {"));
  assert.match(points, /class="link see" data-pt/, "the link toggles the bullet, like the + button");
  const seeText = new Function(`${sourceOf(path.join(PUB_PI, "index.html"), "seeText")}; return seeText;`)();
  assert.equal(seeText("examples", false), "See examples");
  assert.equal(seeText("examples", true), "Hide examples");
  assert.match(page, /var see = li\.querySelector\("button\.see"\);/, "the link's words follow the bullet, whichever opened it");
});

test("partner_intel: the top bar is solid navy with the current page underlined in yellow, and on a phone its top row rides up as the page scrolls", () => {
  const pub = path.join(path.dirname(SRC), "public", "partner-intel");
  const css = fs.readFileSync(path.join(pub, "pi.css"), "utf8");
  const js = fs.readFileSync(path.join(pub, "pi.js"), "utf8");
  assert.match(css, /\.pi-app \.appbar \{ --lift:0px; --fade:1; background:var\(--navy\);/);
  assert.match(css, /transform:translateY\(calc\(-1 \* var\(--lift\)\)\)/);
  assert.match(css, /\.pi-app \.nav a\.on \{ color:#fff; font-weight:600; border-bottom-color:var\(--hl\); \}/);
  assert.doesNotMatch(css, /\.pi-app \.nav a\.on span::before/, "the highlighter mark behind the current page is gone");
  assert.match(js, /var lift = Math\.min\(row, Math\.max\(0, Math\.round\(y\)\)\);/, "the row moves pixel for pixel with the scroll, up to its own height");
  assert.match(js, /bar\.style\.setProperty\("--lift", lift \+ "px"\);/);
  assert.match(js, /phone\.matches/, "only on a phone");
});

test("partner_intel: opening a topic runs its line down beside the block and stops; it no longer turns along the bottom", () => {
  const pub = path.join(path.dirname(SRC), "public", "partner-intel");
  const html = fs.readFileSync(path.join(pub, "index.html"), "utf8");
  const css = fs.readFileSync(path.join(pub, "pi.css"), "utf8");
  assert.doesNotMatch(html, /svg class="trace"|function retract|function drawLine/);
  assert.doesNotMatch(css, /svg\.trace|\.traced/);
  assert.match(css, /\.pi-app \.tp\.open \.tline::after \{ content:none; \}/, "no dot at the end");
  assert.match(css, /\.pi-app \.tline\.grow \{ animation:tline-grow \.55s ease-out; \}/);
  assert.match(css, /@keyframes tline-grow \{ 0% \{ height:14px; \} 50% \{ height:calc\(\(100% - 91px\) \* 1\.07\); \}/, "a small overshoot before it settles");
  assert.match(sourceOf(path.join(pub, "index.html"), "setTopic"), /animate\(card\.querySelector\("\.tline"\), open \? "grow" : "shrink"\);/);
});

test("partner_intel: the time window is a glass track whose lens slides to the choice before the page updates", () => {
  const pub = path.join(path.dirname(SRC), "public", "partner-intel");
  const html = fs.readFileSync(path.join(pub, "index.html"), "utf8");
  const css = fs.readFileSync(path.join(pub, "pi.css"), "utf8");
  assert.match(html, /'<div class="seg glass" id="' \+ id \+ '" role="group" aria-label="Time window"><span class="lens" aria-hidden="true"><\/span>'/);
  const pick = sourceOf(path.join(pub, "index.html"), "pickWindow");
  assert.match(pick, /lens\.classList\.add\("moving"\);/, "it stretches while it moves");
  assert.match(pick, /setTimeout\(then, 420\);/, "the page updates once the lens lands");
  assert.match(pick, /if \(STILL \|\| !lens\) \{ then\(\); return; \}/, "no wait with reduced motion");
  assert.match(html, /placeLens\(el\("win"\), true\);/);
  assert.match(html, /placeLens\(el\("pwin"\), true\);/);
  assert.match(css, /\.pi-app \.seg \.lens\.moving \{ transform:scaleX\(1\.18\) scaleY\(\.88\); \}/);
});

test("partner_intel: the collapsed Ask box is clear glass, and in Chrome and Edge its rim bends what is under it", () => {
  const pub = path.join(path.dirname(SRC), "public", "partner-intel");
  const css = fs.readFileSync(path.join(pub, "pi.css"), "utf8");
  const js = fs.readFileSync(path.join(pub, "pi.js"), "utf8");
  const ask = fs.readFileSync(path.join(pub, "askbox.js"), "utf8");
  assert.match(css, /\.abx:not\(\.open\) \{ background:rgba\(255,255,255,\.4\);/);
  assert.match(css, /html\.lg-refract \.abx:not\(\.open\) \{ backdrop-filter:url\(#pi-ask-glass\)/);
  assert.match(js, /if \(navigator\.userAgentData\) document\.documentElement\.classList\.add\("lg-refract"\);/, "the bend only where the browser can draw it");
  assert.match(js, /add\(f, "feDisplacementMap"/);
  assert.match(js, /add\(f, "feComposite", \{ in: "warped", in2: "innerSoft", operator: "out", result: "rim" \}\);/, "the bend is kept to the rim");
  assert.match(ask, /PI\.glassFilter\("pi-ask-glass", root\.offsetWidth, root\.offsetHeight, PI\.ASK_GLASS\)/);
});

test("partner_intel: the staff app's accent is navy, so links in running text are underlined", () => {
  const css = fs.readFileSync(path.join(path.dirname(SRC), "public", "partner-intel", "pi.css"), "utf8");
  assert.match(css, /\.pi-app \{ --accent:#07214e;/);
  assert.match(css, /\.pi-app \.wrap a:not\(\[class\]\), \.pi-app \.wrap button\.link \{ text-decoration:underline;/);
  assert.match(css, /\.pi-app \.wrap \.ctabs a \{ text-decoration:none; \}/, "the company tabs are not underlined");
});

test("partner_intel: company tabs are pills in a gray track, and the navy pill slides from the last tab to the new one", () => {
  const pub = path.join(path.dirname(SRC), "public", "partner-intel");
  const css = fs.readFileSync(path.join(pub, "pi.css"), "utf8");
  const html = fs.readFileSync(path.join(pub, "index.html"), "utf8");
  assert.match(html, /'<nav class="ctabs" aria-label="Company sections" style="--n:' \+ COMPANY_TABS\.length \+ ";--at:" \+ from \+ '"><i class="ctlens" aria-hidden="true"><\/i>'/);
  assert.doesNotMatch(html, /ICONS\[t\.id\]/, "the tabs are text only");
  assert.match(html, /var from = lastTab && lastTab\.id === c\.id \? lastTab\.at : at;/, "it slides only between tabs of the same company");
  assert.match(html, /tabs\.style\.setProperty\("--at", at\);/);
  assert.match(css, /\.pi-app \.ctabs \.ctlens \{[^}]*background:var\(--navy\);[^}]*transform:translateX\(calc\(var\(--at, 0\) \* 100%\)\);/);
  assert.match(css, /\.pi-app \.ctabs \.ctlens \{[^}]*transition:transform \.5s cubic-bezier\(\.22,1,\.36,1\); \}/, "it eases in without overshooting");
  assert.match(css, /@media \(prefers-reduced-motion:reduce\) \{ \.pi-app \.ctabs \.ctlens \{ transition:none; \} \}/);
  assert.doesNotMatch(css, /\.pi-app \.tabpanel\.first/, "the panel no longer joins a tab");
});

test("partner_intel: Home ends with its topics, with no Note, Source or Dates footer under them", () => {
  const html = fs.readFileSync(path.join(path.dirname(SRC), "public", "partner-intel", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(path.dirname(SRC), "public", "partner-intel", "pi.css"), "utf8");
  assert.doesNotMatch(html, /topicfoot|Topics rank by how many partner companies|data-exact/);
  assert.doesNotMatch(css, /\.topicfoot/);
  assert.match(html, /renderTrending\(el\("trend"\), d\.trending, \{ days: state\.days, source: \[\], status: \[\] \}, mine, "h2"\);/);
});

test("partner_intel: the time window lens has no drop shadow, and the nav links are lighter (500, current page 600)", () => {
  const css = fs.readFileSync(path.join(path.dirname(SRC), "public", "partner-intel", "pi.css"), "utf8");
  const lens = css.match(/\.pi-app \.seg \.lens \{[^}]*\}/)[0];
  assert.doesNotMatch(lens, /, 0 \d+px \d+px rgba/, "only inset rim lines, no shadow under the lens");
  assert.match(css, /\.pi-app \.nav a \{[^}]*font-size:17px; font-weight:500; \}/);
});

test("partner_intel: the Ask page conversation sits on a solid white panel, so the page background never shows behind an answer", () => {
  const css = fs.readFileSync(path.join(path.dirname(SRC), "public", "partner-intel", "pi.css"), "utf8");
  assert.match(css, /\.asx\.has-out \.asx-out \{ order:1; flex:1 0 auto; margin-top:12px; background:#fff; border-radius:24px; padding:28px 36px; \}/);
  assert.match(css, /\.asx\.has-out \.asx-out \.turn:last-child \{ margin-bottom:0; \}/);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${(error && error.message ? error.message : error).split("\n").join("\n      ")}`);
  }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed, ${tests.length} total`);
process.exit(failed ? 1 : 0);
