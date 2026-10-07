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
const { handlePartnerIntelApi, parseCsv, applyRosterCsv } = await mod("partner_intel.js");
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
  assert.ok(meta.cacheShards >= 2, `expected several shards, got ${meta.cacheShards}`);
  const back = await (await pi("relay/state", relay("state", "GET"), env)).json();
  assert.equal(Object.keys(back.cache).length, 700);
  assert.equal(back.cache.k699.rows[0].detail, "x".repeat(4000) + 699);
  await pi("relay/state", relay("state", "POST", { registry, cache: { k0: cache.k0 } }), env);
  assert.equal(await env.BOX_KV.get(`pi:state:cache:${meta.cacheShards - 1}`), meta.cacheShards - 1 === 0 ? null : null,
    "shards beyond the new count are deleted");
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

test("partner_intel: a company's top issues count each meeting once, so one long meeting is not a pattern", async () => {
  const { env, token } = await piEnv([
    ...longMeeting("long", 12, { topic: "quality", urgency: "medium" }),                                   // 12 rows, one meeting
    row({ topic: "talent_pipeline", urgency: "medium", meeting_id: "t1", meeting_label: "t1" }),           // two meetings, one row each
    row({ topic: "talent_pipeline", urgency: "medium", meeting_id: "t2", meeting_label: "t2" }),
  ]);
  const p = await getJson("company?id=c-a", env, token);
  assert.deepEqual(p.topIssues.map((t) => [t.topic, t.count]), [["talent_pipeline", 2], ["quality", 1]],
    "two meetings outrank twelve rows from one");
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

test("partner_intel: the tabs run Home, Programs, Companies, Ask, Explore", () => {
  const html = fs.readFileSync(path.join(path.dirname(SRC), "public", "partner-intel", "index.html"), "utf8");
  const nav = [...html.slice(html.indexOf('id="nav"'), html.indexOf("</nav>")).matchAll(/data-r="(\w+)"/g)].map((m) => m[1]);
  assert.deepEqual(nav, ["home", "programs", "companies", "ask", "explore"]);
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
  assert.deepEqual(p.topIssues.map((t) => t.lead.title), ["Open hiring gap"]);
  assert.deepEqual(p.recentWins.map((w) => w.title), ["Won an award"]);
  assert.deepEqual(p.topSolutions.map((t) => t.lead.title), ["Built an AI inspector"]);
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
  const ask = () => withFetch(handler, () => pi("ask", piReq("ask", "POST", { question: "Who has an AI powered quality inspection system?" }, token), env));
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
  assert.deepEqual([usage.calls, usage.input, usage.output, usage.reused], [2, 20, 10, 2], "the meter counts paid calls and reuses");
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
  assert.deepEqual(await titles("source=CIAIC"), ["both", "ciaic issue"], "derived from the path, and a merged row matches any of its sources");
  assert.deepEqual(await titles("source=ADAPT%7CCIAIC"), ["adapt issue", "both", "ciaic issue"], "several sources at once");
  assert.deepEqual(await titles("source=(root)"), ["loose file"]);
  assert.deepEqual(await titles("source=Board%20Meetings"), ["board issue"], "an explicit source choice includes the internal rows");
  assert.equal((await titles("")).includes("board issue"), false, "and without it they stay out");
  const home = await getJson("home?days=30&source=ADAPT", env, token);
  assert.equal(home.counts.issues, 2, "Home follows the source choice too; the row from two sources counts under each");
  assert.equal((await getJson("home?days=30&source=CIAIC", env, token)).counts.issues, 2);
  const facets = await getJson("facets", env, token);
  assert.deepEqual(facets.sources, [{ value: "(root)", count: 1 }, { value: "ADAPT", count: 2 }, { value: "Board Meetings", count: 1 }, { value: "CIAIC", count: 2 }]);
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
  const ask = (sources) => withFetch(handler, async () => (await pi("ask", piReq("ask", "POST", { question: "Who has quality inspection systems?", sources }, token), env)).json());
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
  // A day later: one new row came in. Ten of the eleven rows are the ones the summary was written from.
  await publishV2(env, [...base, ins({ topic: "quality", company_id: "c-c", meeting_id: "m-new", title: "A newer quality point" })]);
  const again = await sum();
  assert.equal(calls, 1, "ten of eleven rows unchanged: the saved summary is reused");
  assert.equal(again.summaries.quality.bullets.length, 2);
  assert.equal((await getJson("status", env, token)).usage.thisMonth.summaries.reused, 1);
});

test("partner_intel: a summary is written again when the rows have moved on, and reuse never drifts", async () => {
  const base = Array.from({ length: 10 }, (_, k) => ins({ topic: "quality", company_id: ["c-a", "c-b", "c-c"][k % 3], meeting_id: `m-d${k}`, title: `Quality point ${k}` }));
  const { env, token } = await piEnv(base, { partner_intel_claude_api: "k" });
  let calls = 0;
  const handler = (url, init) => { calls++; return summaryOut(topicsIn(init).payload, oneBullet); };
  const sum = () => withFetch(handler, async () => (await pi("summarize", piReq("summarize", "POST", { days: 30, topics: ["quality"] }, token), env)).json());
  await sum();
  // Each step adds one row: 10/11, then 10/12, then 10/13 of the rows it was WRITTEN from.
  // Measured against the last reuse instead, every step would look 90% the same forever.
  const rows = [...base];
  for (let k = 0; k < 3; k++) {
    rows.push(ins({ topic: "quality", company_id: "c-a", meeting_id: `m-step${k}`, title: `Step ${k}` }));
    await publishV2(env, rows);
    await sum();
  }
  assert.equal(calls, 2, "10/11 and 10/12 reuse; 10/13 is under 80% of the original rows, so it is written again");
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
  await withFetch((url, init) => { heads.push(init.headers["anthropic-beta"]); return rankOut([
    { company_id: "c-a", strength: "high", why: "Built it.", evidence_ids: [rows[0].id], caution: "" }]); },
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
