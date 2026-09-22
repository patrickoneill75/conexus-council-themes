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
 * src/stars.js does `import data from "./data/stars-occupations.json"`. Wrangler
 * resolves that bare; Node needs an explicit import attribute. So mirror src/ into a
 * temp directory verbatim, add the attribute to that one line, and import the modules
 * from there -- the code under test is otherwise byte-for-byte what ships.
 */
const MIRROR = fs.mkdtempSync(path.join(os.tmpdir(), "connector-src-"));
fs.cpSync(SRC, MIRROR, { recursive: true });
{
  const starsPath = path.join(MIRROR, "stars.js");
  const before = fs.readFileSync(starsPath, "utf8");
  const after = before.replace(
    'import bundledOccupationData from "./data/stars-occupations.json";',
    'import bundledOccupationData from "./data/stars-occupations.json" with { type: "json" };',
  );
  assert.notEqual(after, before, "the JSON import in src/stars.js moved -- update this shim");
  fs.writeFileSync(starsPath, after);
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
  jobTitle: "CNC Operator",
  categories: [{ key: "job_title", extractedText: "CNC Operator", status: "aligned", statusReasoning: "r" }],
  duties: [{ id: "duty-1", text: "Run the machine", drivers: [], vague: false }],
  driverGuesses: { systems: "", automation: "", decisionAuthority: "", crossTraining: "" },
  systemGaps: [],
  requirements: [{ id: "req-1", text: "HS diploma", suggestedCredential: "" }],
  onetMatch: { code: "51-4011", title: "CNC Tool Operators", reasoning: "r" },
  currentTitleOnetGuess: { code: "51-4011", title: "CNC Tool Operators" },
};

const claudeResponse = (input) => okJson({ content: [{ type: "tool_use", input }] });

test("job_description: .docx entities are decoded once, not twice", async () => {
  // BUG: docxXmlToText() decoded &amp; FIRST, so the document's own literal "&amp;lt;"
  // became "&lt;" and the very next replace turned it into "<" -- silently rewriting
  // the employer's text before Claude ever saw it.
  const env = makeEnv({ job_description_claude_api: "key" });
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
  assert.ok(promptSent.includes("don\u2019t"), "numeric character references are decoded");
});

test("job_description: confirm-pre-read ignores junk from the public client", async () => {
  // BUG: this public route Object.assign-ed the request body straight onto preRead, so
  // any caller could replace duties/requirements/categories with a non-array -- which
  // then threw deep inside computeMatrix()/generate-outputs as a 500 several steps on.
  const env = makeEnv({ job_description_claude_api: "key" });
  const form = new FormData();
  form.append("file", new File([buildDocx("<w:document><w:body><w:p><w:r><w:t>x</w:t></w:r></w:p></w:body></w:document>")], "jd.docx"));
  let session;
  await withFetch(async () => claudeResponse(PRE_READ_RESULT), async () => {
    session = (await (await handleJobDescriptionApi("upload",
      req("/api/job-description/upload", { method: "POST", body: form }), env)).json()).session;
  });

  const res = await handleJobDescriptionApi(`session/${session.id}/confirm-pre-read`,
    jsonReq(`/api/job-description/session/${session.id}/confirm-pre-read`, "POST", {
      edits: {
        duties: "not an array",
        requirements: null,
        jobTitle: "Injected Title",
        categories: [{ key: "job_title", extractedText: "Edited by the employer" }],
      },
    }), env);
  const updated = (await res.json()).session;

  assert.ok(Array.isArray(updated.preRead.duties), "duties must stay an array");
  assert.ok(Array.isArray(updated.preRead.requirements), "requirements must stay an array");
  assert.equal(updated.preRead.jobTitle, "CNC Operator", "only the edited field may change");
  assert.equal(updated.preRead.categories[0].extractedText, "Edited by the employer");
  assert.equal(updated.preRead.confirmed, true);

  // The step that used to blow up on a clobbered preRead.
  const matrix = await handleJobDescriptionApi(`session/${session.id}/step6`,
    req(`/api/job-description/session/${session.id}/step6`), env);
  assert.equal(matrix.status, 200);
  assert.equal((await matrix.json()).matrix.length, 5);
});

test("job_description: re-running generate-outputs still saves to Box", async () => {
  // BUG: boxUploadFile() always created a NEW file, so a second run hit Box's 409 name
  // conflict on all eight outputs -- generated and paid for, but never saved.
  const env = makeEnv({ job_description_claude_api: "key" });
  const session = {
    id: "sess-1", status: "step7", boxSubfolderId: "sub-1",
    sourceFile: { name: "jd.docx" }, preRead: { ...PRE_READ_RESULT, confirmed: true },
    step3: { dutyAnswers: {}, driverAnswers: {} }, step4: { requirementAnswers: {} },
    step5: {}, step6: { matrix: [], score: 1, recommendation: "Update the existing description." },
  };
  await env.BOX_KV.put("jobdesc:session:sess-1", JSON.stringify(session));
  await env.BOX_KV.put("box:tokens", JSON.stringify({
    access_token: "t", refresh_token: "r", obtained_at: Math.floor(Date.now() / 1000), expires_in: 3600,
  }));

  const outputs = {
    revisedDescription: "# Revised", redline: [{ section: "s", before: "b", after: "a", reason: "r" }],
    worksheet: "# Worksheet",
    comms: { screeningRubric: "a", incumbentUpdate: "b", educationProvidersNote: "c",
             careerFairOneSheet: "d", apprenticeshipCheckNote: "e" },
  };
  const existingInBox = new Set();

  const run = () => withFetch(async (url, init) => {
    if (url.includes("api.anthropic.com")) return claudeResponse(outputs);
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
  }, () => handleJobDescriptionApi("session/sess-1/generate-outputs",
      jsonReq("/api/job-description/session/sess-1/generate-outputs", "POST", {}), env));

  const first = (await (await run()).json()).session;
  assert.equal(first.outputs.box.saved, true, "first run should save");
  assert.equal(existingInBox.size, 8, "eight output files");

  const second = (await (await run()).json()).session;
  assert.equal(second.outputs.box.saved, true, "a re-run must upload new VERSIONS, not 409");
});

test("job_description: generate-outputs survives a category key outside the known list", async () => {
  // BUG: formatConfirmedInputs() did PART2_CATEGORIES.find(...).label with no guard, so
  // an unexpected key threw -- turning the final, already-paid-for call into a 500.
  const env = makeEnv({ job_description_claude_api: "key" });
  const session = {
    id: "sess-2", status: "step7",
    preRead: { ...PRE_READ_RESULT, categories: [{ key: "not_a_real_category", extractedText: "text" }] },
    step3: null, step4: null, step5: null,
    step6: { matrix: [], score: 0, recommendation: "Update the existing description." },
  };
  await env.BOX_KV.put("jobdesc:session:sess-2", JSON.stringify(session));

  await withFetch(async () => claudeResponse({
    revisedDescription: "x", redline: [], worksheet: "y",
    comms: { screeningRubric: "a", incumbentUpdate: "b", educationProvidersNote: "c",
             careerFairOneSheet: "d", apprenticeshipCheckNote: "e" },
  }), async () => {
    const res = await handleJobDescriptionApi("session/sess-2/generate-outputs",
      jsonReq("/api/job-description/session/sess-2/generate-outputs", "POST", {}), env);
    assert.equal(res.status, 200, await res.text());
  });
});

test("job_description: generate-outputs refuses to run before Step 6", async () => {
  const env = makeEnv({ job_description_claude_api: "key" });
  await env.BOX_KV.put("jobdesc:session:sess-3", JSON.stringify({
    id: "sess-3", status: "step5", preRead: PRE_READ_RESULT, step6: null,
  }));
  const res = await handleJobDescriptionApi("session/sess-3/generate-outputs",
    jsonReq("/api/job-description/session/sess-3/generate-outputs", "POST", {}), env);
  assert.equal(res.status, 409);
});

test("job_description: only PDF and .docx are accepted", async () => {
  const env = makeEnv({ job_description_claude_api: "key" });
  const form = new FormData();
  form.append("file", new File(["hello"], "jd.txt", { type: "text/plain" }));
  const res = await handleJobDescriptionApi("upload",
    req("/api/job-description/upload", { method: "POST", body: form }), env);
  assert.equal(res.status, 400);
});

test("job_description: the Step 6 matrix scores from the answers actually given", async () => {
  const env = makeEnv();
  await env.BOX_KV.put("jobdesc:session:sess-4", JSON.stringify({
    id: "sess-4",
    preRead: {
      duties: [{ id: "d1" }, { id: "d2" }, { id: "d3" }],
      requirements: [{ id: "r1", suggestedCredential: "NIMS" }],
      onetMatch: { code: "51-4011", title: "A" },
      currentTitleOnetGuess: { code: "51-9999", title: "B" },
      categories: [],
    },
    step3: { dutyAnswers: { d1: { answer: "changed" }, d2: { answer: "no_longer_done" }, d3: { answer: "same" } } },
    step4: { requirementAnswers: { r1: { tier: "must_have" } } },
  }));
  const res = await handleJobDescriptionApi("session/sess-4/step6",
    req("/api/job-description/session/sess-4/step6"), env);
  const body = await res.json();
  const byId = Object.fromEntries(body.matrix.map((m) => [m.id, m.value]));
  assert.equal(byId.duties_changed, true, "2 of 3 duties changed is a majority");
  assert.equal(byId.distinct_competency, true);
  assert.equal(byId.different_onet, true);
  assert.equal(body.score, 3);
  assert.match(body.recommendation, /^Create a new title/);
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
