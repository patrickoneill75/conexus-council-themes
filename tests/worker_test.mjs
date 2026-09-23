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
  assert.equal(me.username, "poneill");
});

test("beta_auth: a wrong password is rejected with 401", async () => {
  const { env } = await signedInEnv();
  const res = await beta("login", jsonReq("/api/beta/login", "POST",
    { identifier: "poneill", password: "wrong" }), env);
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
    { identifier: "poneill", password: "seed-password-123" }), env);
  assert.equal(relogin.status, 401, "the old seed password must stop working after a reset");
});

test("beta_auth: setup-complete rejects a short password and an unlisted email", async () => {
  const env = makeEnv();
  const short = await beta("setup-complete", jsonReq("/api/beta/setup-complete", "POST",
    { email: "a@b.com", username: "a", password: "short" }), env);
  assert.equal(short.status, 400);

  const unlisted = await beta("setup-complete", jsonReq("/api/beta/setup-complete", "POST",
    { email: "nobody@b.com", username: "nobody", password: "longenough1" }), env);
  assert.equal(unlisted.status, 403);
});

test("beta_auth: a new admin is added, claims an account, and cannot be claimed twice", async () => {
  const { env, token } = await signedInEnv();
  assert.equal((await beta("admins", jsonReq("/api/beta/admins", "POST", { email: "New@Example.com" }, token), env)).status, 200);

  const claimed = await (await beta("setup-complete", jsonReq("/api/beta/setup-complete", "POST",
    { email: "new@example.com", username: "newbie", password: "longenough1" }), env)).json();
  assert.ok(claimed.token, "claiming an allowlisted email should return a session");

  const again = await beta("setup-complete", jsonReq("/api/beta/setup-complete", "POST",
    { email: "new@example.com", username: "newbie2", password: "longenough2" }), env);
  assert.equal(again.status, 409, "an account with a password must not be re-claimable");
});

test("beta_auth: every admin route refuses an anonymous caller", async () => {
  const env = makeEnv();
  for (const [route, method] of [["admins", "GET"], ["admins", "POST"],
                                 ["admins/reset", "POST"], ["app-visibility", "POST"]]) {
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
  const env = makeEnv();
  const body = await (await workerModule.default.fetch(req("/api/box/authorize-url"), env, {})).json();
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
  // A two-step programme, so the combined figure is due once both are done.
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

test("apprenticeship: a programme shows a tab for every step, built or not", async () => {
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

/* ------------------------------------------------------------------------- runner */
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
