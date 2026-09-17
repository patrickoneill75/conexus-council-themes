# Setup

Same architecture as `conexus-mcm`: a Cloudflare Worker serves `public/` and handles
`/api/*`, the control panel logs in with Box and picks a folder, and a GitHub Actions run
does the reading and publishing. Nothing secret ever reaches the browser.

Everything below is done in a browser. There are no terminal steps.

---

## What you end up with

| Piece | Where it lives | What it does |
| --- | --- | --- |
| `public/index.html` | Worker static assets | The public dashboard. Power BI pages plus the Council Themes tab. No login. |
| `public/admin.html` | Worker static assets | The control panel. Helper/Survey upload, Update Dashboard, and the Meetings table (delete a meeting's published data and re-synthesize what's left) on the main page; Box login, the Data Folder picker, and Refresh Dashboard/Themes/All under Developer. |
| `src/worker.js` | Cloudflare Worker | `/api/*`. Holds the password, the GitHub token and the Box credentials. |
| `scripts/update_dashboard.py` | GitHub Actions | Auto-detects every meeting in the Data Folder's Post-Meeting Survey export that isn't in `data/feedback_log.json` yet (resolving Year/Quarter/Region per meeting from the Council Meeting Helper export), extracts and publishes each one's themes with Claude, then rebuilds the quant dashboard. |
| `scripts/setup_analysis.py` | GitHub Actions | Re-synthesizes every quarter already in `data/feedback_log.json`, no new survey involved — the one-time bootstrap (or a full redo). |
| `scripts/remove_meetings.py` | GitHub Actions | Deletes one or more meetings' data from the Feedback Log and both published dashboards, then re-synthesizes every quarter still left. Also strips the matching rows out of the Data Folder's own Helper and Survey exports in Box, best-effort, so the meeting doesn't come back on the next Update Dashboard. Triggered from the Meetings table's "Remove & refresh" button. |
| `public/beta/` | Worker static assets | The Mini App Platform: a grid of every tool built on this Worker, gated by its own admin accounts (separate from `admin.html`'s single password). See **8 · The Mini App Platform** below. |
| `src/beta_auth.js` | Cloudflare Worker | `/api/beta/*`. The platform's multi-user admin accounts -- signup, sign-in, password reset, the admin list. Completely independent of `src/worker.js`'s own `CONTROL_PASSWORD` gate. |
| `public/consensus/` | Worker static assets | Consensus: survey builder + results (`index.html`, `results.html`, beta-account gated) and the public respondent chat (`respond.html`, no login). See **9 · Consensus** below. |
| `src/consensus.js` | Cloudflare Worker | `/api/consensus/*`. Survey CRUD, the live follow-up-question chat, response storage in Box, and triggering the batch analysis -- gates its admin routes with the same beta accounts via `requireBetaAuth`. |
| `scripts/consensus_analyze.py` | GitHub Actions | Synthesizes a survey's collected responses (out of Box) into prioritized themes per question with Claude, and publishes `public/consensus-results/<id>.json`. Triggered from the Consensus admin page's "Analyze" button. |
| `public/pcn/` | Worker static assets | PCN Issue Map: the control panel (`index.html`, beta-account gated). See **10 · PCN Issue Map** below. |
| `src/pcn.js` | Cloudflare Worker | `/api/pcn/*`. Beta-account gated like Consensus, and shares the same Box connection every other tool here uses -- picks its own one data folder the same way Consensus picks a responses folder per survey. |

---

## 1 · The repository

1. Create a repository — say `conexus-council-themes` — and upload every file from this
   project, keeping the folder structure.
2. `Settings → Actions → General → Workflow permissions` → **Read and write permissions**.
   Without this an analysis run cannot commit.
3. Open `wrangler.jsonc` and set `GITHUB_REPO` to your repository in `owner/name` form.

---

## 2 · Cloudflare

1. In the Cloudflare dashboard, **Workers & Pages → Create → Import a repository**, and
   point it at this repo. It reads `wrangler.jsonc` and deploys on every push.
2. **Storage & Databases → KV → Create a namespace**, name it `BOX_KV` to match the
   binding in `wrangler.jsonc`. Copy its ID into `wrangler.jsonc` under `kv_namespaces`,
   replacing `PASTE_YOUR_KV_NAMESPACE_ID_HERE`, and commit.

   This is where the Box connection lives: the token pair (the refresh token rotates on
   every use, so it cannot be a static secret) and the folder you pick in the panel.
3. Note the Worker's address — `https://conexus-council-themes.<subdomain>.workers.dev`.

---

## 3 · The Box app

This project's Box app is **shared with conexus-mcm** — same Client ID/Secret, same
Box Developer Console app. Reuse that app rather than creating a new one:

1. `app.box.com/developers/console` → the shared app → **Configuration**.
2. Authentication method: **User Authentication (OAuth 2.0)**. This is the "Log in with
   Box" flow — the app acts as *you*, so it sees exactly what you see and nothing more.
3. **Application Scopes** should already have **Read and write all files and folders
   stored in Box** checked (conexus-mcm needs write access, so this app already has it —
   this project needs it too, to replace the Data Folder's exports on upload). If it
   only has read checked, add write now and **Save Changes**.
4. **OAuth 2.0 Redirect URI** — this field takes one URI per line. Make sure **both**
   projects' callback URLs are listed:

   ```
   https://<conexus-mcm-worker-address>/api/box/callback
   https://<conexus-council-themes-worker-address>/api/box/callback
   ```

   Box rejects a login whose redirect URI isn't listed here, character for character.
   If council-themes' own line is missing, add it now.
5. Copy the **Client ID** and **Client Secret** — same values as conexus-mcm's.

If your Box connection here was set up before this app had write scope, **Disconnect**
and **Log in with Box** again in the control panel — the stored token was issued under
the old (read-only) consent and needs to be reissued to pick up write access.

---

## 4 · Secrets

Add these under `Settings → Secrets and variables → Actions` in your repository:

| Secret | Where it comes from |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare → My Profile → API Tokens → "Edit Cloudflare Workers" |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare → Workers & Pages → Account details |
| `CONTROL_PASSWORD` | A password you choose for the control panel |
| `PANEL_GITHUB_TOKEN` | A fine-grained GitHub token, this repo only, **Actions: read and write** |
| `BOX_CLIENT_ID` | Box app Configuration tab (the shared app — see step 3) |
| `BOX_CLIENT_SECRET` | Box app Configuration tab (the shared app — see step 3) |
| `BOX_RELAY_SECRET` | A long random string you make up |
| `BOX_RELAY_URL` | `https://<your-worker-address>/api/box/pipeline-token` |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → Settings → API Keys |

`ANTHROPIC_API_KEY` is the one exception to "everything is done in a browser, no
terminal" being about secrets specifically living in *this* repository's GitHub
settings — it's only ever read by the Python scripts running in GitHub Actions, so
unlike the others it does **not** need to go to Cloudflare at all.

Everything else, run **Actions → Set Cloudflare secrets → Run workflow**. That hands the
Worker-side values to Cloudflare for you, which is the step that would otherwise need a
terminal.

`BOX_RELAY_SECRET` is deliberately in both places: the Worker checks it, and an analysis
run sends it. They must be the same value.

Check it worked by opening `https://<your-worker-address>/api/config-check`. You are
looking for `"configured": true`.

---

## 5 · Connect Box and set up the panel

1. Open `https://<your-worker-address>/admin.html` and sign in with `CONTROL_PASSWORD`.
2. **Log in with Box**. Box asks you to authorise the app; it comes back to the panel.
3. **Data Folder** → **Choose folder…** and pick (or create) a Box folder to hold the
   three source files: `Council Meeting Helper.csv`, `Post-Meeting Survey.csv` (both
   kept current from the two upload cards on the main page), and `Content
   Categories.xlsx` (maintained directly in Box). Set this once — there's no need to
   revisit it quarterly.
4. Still under **Developer**, click **Refresh Themes**. This synthesizes current/QoQ/YoY
   themes for every quarter already sitting in `data/feedback_log.json` and publishes
   them, with no new survey involved. Re-run it any time you want every quarter redone
   from scratch (e.g. after a taxonomy change) — or **Refresh All** to also rebuild the
   quant dashboard in the same run.

From here on, each new meeting: upload the latest exports via **Council Meeting Helper
Upload** and **Post-Meeting Survey Upload** (each replaces the previous export
wholesale — both are cumulative, so the new file already contains everything the old
one did), then **Update Dashboard**. It auto-detects which meeting(s) are new by
Survey ID, so it's safe to click any time, even with nothing new uploaded.

---

## 6 · The taxonomy

`data/taxonomy.json` holds the fixed Category → Subcategory vocabulary. Claude is
given this list on every extraction run and told to reuse an existing pair whenever
one reasonably fits, only writing a new Subcategory when nothing listed fits at all —
the taxonomy's value comes from the same label being reused across quarters, so it
resists adding new ones often, but does extend the file in place on its own when it
legitimately needs to. Edit it by hand in the repo if you want to add or rename one
yourself.

---

## 7 · The Power BI pages

The report has three pages — **Benchmarking**, **Attendance**, **Attendance 2026+** — and
each needs its `ReportSection` id filling in once.

1. Open the report in `app.powerbi.com` — the real report, not the Publish-to-web link.
2. Click a page. The address bar reads:

   ```
   .../reports/2bce9c2f-05e5-4ec4-8dce-2414bd9f9e41/ReportSection8f2a1c4d?experience=power-bi
   ```

   Copy the `ReportSection…` piece — everything after the last slash, before the `?`.
3. Edit `public/index.html` in GitHub's web editor and replace `PASTE_PAGE_ID_1`,
   `_2` and `_3` on the matching lines. Until you do, each tab shows a note naming which
   placeholder it is waiting on, so a right id in the wrong slot is easy to spot.
4. Add or remove entries freely — the buttons come from that list.

**Use the `?r=…` Publish-to-web link as `reportUrl`.** The
`reportEmbed?reportId=…&autoAuth=true` link is "Embed for your organization": it makes
every viewer sign in with a Conexus account, so anyone outside Conexus hits a login wall —
which is the problem this wrapper exists to avoid.

---

## 8 · The Mini App Platform

Every tool built the same way as this one (Claude → GitHub → Cloudflare) ends up needing
its own repo, its own Worker, its own round of "paste in the API keys again." `/beta` is a
thin layer on top of *this* Worker that fixes that going forward: one grid of tools
("mini apps" — that's the name to use when asking for a new one), gated by admin accounts
that live in the same KV namespace this project already uses.

**It's a separate thing from everything above.** The Council Survey Dashboard
(`public/index.html`) and its control panel (`public/admin.html`, `CONTROL_PASSWORD`) keep
working exactly as they do today, at the same addresses, for your whole team — `/beta`
doesn't touch either. It's reachable at `https://<your-worker-address>/beta/`.

### Signing in

1. Add `poneill_password` as a repository secret (a password of your choosing), then run
   **Actions → Set Cloudflare secrets → Run workflow** — same mechanism as every other
   secret in this project (step 4 above). This seeds one admin account: email
   `poneill@conexusindiana.com`, username `poneill`, that password. It's read exactly
   once, the first time anyone hits `/beta`; after that the account is stored the same
   way every other admin's is, and the secret is never read again.
2. Open `/beta/login.html` and sign in with that username/email and password.

### Adding another admin

From the grid (`/beta/`), **Manage admins** → enter their email → **Add**. That's it —
they're now allowed to set up their own account, but nothing is created for them yet.

They go to `/beta/login.html` → **Set up new account / Forgot password** → enter their
email → if it's on the list and doesn't have a password yet, they're prompted to pick a
username and password right there. The same button handles "I forgot my password": once
another admin clears it for you (**Manage admins** → **Reset**), your account is back in
that same "allowed, no password yet" state, and you use the same button to set a new one.

**Worth knowing:** there's no email-sending step anywhere in that flow — setting a
password only checks that the email is on the admin list, not that whoever's typing
actually owns that inbox. For a small, trusted team that's a reasonable trade for staying
free and simple, but it does mean anyone who knows an admin's email (and that it doesn't
have a password set yet, e.g. right after a reset) could claim the account first. If that
ever stops being an acceptable trade, the fix is a real "magic link" flow — a one-time
link emailed to the address, using something like Resend or Postmark — which would need
one more secret (an email-provider API key, pushed the same way as everything else) and a
couple more routes in `src/beta_auth.js`, not a different storage model. Ask for it if you
want it; it wasn't built now because it adds a moving part (an email provider) this
project doesn't otherwise need.

### Adding a mini app

1. Build it wherever makes sense in the repo — its own `public/<name>/` pages, its own
   `/api/<name>/*` routes if it needs a backend, its own GitHub Actions workflow if it
   needs one. `src/beta_auth.js` and the rest of the platform don't need to know anything
   about how it works internally.
2. Add one entry to the `MINI_APPS` array at the top of `public/beta/index.html` — name,
   description, and its public/admin URLs (either can be omitted). That's the only step
   that makes it show up in the grid.
3. If it needs its own secrets (an API key, a webhook secret, whatever), they follow the
   same pattern every secret in this project already follows: store it as a GitHub
   repository secret, and either send it to Cloudflare via
   **Actions → Set Cloudflare secrets** (add a step there, same shape as `poneill_password`'s)
   if a Worker route needs to read it, or leave it as a plain repository secret if only a
   GitHub Actions script needs it (like `ANTHROPIC_API_KEY` already does — see step 4).
   No need to rename anything already set up for the Council Survey Dashboard; each mini
   app's secrets are namespaced by whatever name you give them.

---

## 9 · Consensus

The first mini app built on the platform: chatbot-style surveys, where each question can
ask Claude to generate a set number of follow-up questions on the fly, based on context
you give it. Once responses are in, one click synthesizes each question into prioritized
themes plus areas of consensus and areas needing more information.

Reachable from the grid (`/beta/`) → **Consensus**, or directly at
`/consensus/index.html`. Uses the same admin accounts as the rest of `/beta` — nothing
extra to sign in to — and the same Box connection as the Council Survey Dashboard.

### Setup

1. Add `consensus_claude_api` as a repository secret — an Anthropic API key, separate
   from the Council Survey Dashboard's `ANTHROPIC_API_KEY` so the two mini apps' Claude
   spend is easy to tell apart. Run **Actions → Set Cloudflare secrets** afterward — this
   one secret is needed in *two* places and that workflow sends the Worker its copy:
   - The Worker itself needs it, because the live chat's follow-up questions are
     generated while a respondent is sitting there waiting — that can't be deferred to a
     GitHub Actions run the way the batch analysis is.
   - `consensus_analyze.yml` (the batch analysis) reads the same value as a plain
     repository secret, the same way `ANTHROPIC_API_KEY` already does for the Council
     app.
2. That's it — no separate Box setup. Each survey you create picks its own responses
   folder from the same Box connection already set up in step 5.

### Building a survey

From **Consensus** → **New survey**:

- **Survey context** — objective, audience, and general guidance. All three are given to
  Claude alongside every question, so follow-ups (and later, the analysis) stay grounded
  in what the survey is actually for. General guidance is the one that applies across
  every question, including ones with 0 follow-ups of their own — use it for instructions
  like "take the respondent's earlier answer about their industry into account for later
  questions." A question's own context box (below) only ever shapes that one question's
  own follow-ups.
- **Questions** — each one has its own follow-up count (0-5) and its own context box for
  guiding what those follow-ups should probe for. That count is a ceiling, not a target:
  Claude sees the whole survey so far (every earlier question's answers, plus this
  question's own thread) and uses its own judgement on whether another follow-up would
  actually add value, stopping early rather than padding out to the maximum. No
  per-question flag to configure this — it's inferred from context every time.
  - **Claude Analyze** — Yes/No, required on every question, defaults to Yes. For a
    simple field like name or company, set it to No: the batch analysis skips that
    question entirely (no Claude call, no tokens spent on it) and its raw answers show
    up instead as a plain table on the results page — see below.
  - **Personalize this question** — optional, and only offered on the second question
    onward. Check any number of earlier questions, and this question's wording gets
    lightly rewritten using everything the respondent said on all of them (including
    any follow-ups) before it's shown — e.g. "Do you know others leading the way?"
    becomes "...leading the way in reverse logistics?" once an earlier answer
    established that as the challenge. Falls back to the question's own static text if
    none of the checked questions were reached yet, Claude is unavailable, or the
    rewrite call fails — this is wording polish, never something that can block a
    respondent's progress through the survey. Reordering or removing a checked source
    question automatically drops it from the selection if it's no longer valid.
- **Responses folder** — the Box folder responses are saved to, as one CSV per survey.

Saving gives you a respondent link (`/consensus/respond.html?survey=<id>`) — share that
however you'd share any survey link. It's public, no sign-in, by design. Every question
(personalized or not) has a brief, consistent pause before it appears — an instantly
displayed question felt jarring next to a follow-up, which always has some natural delay.
A progress bar above the chat shows "Question X of Y", advancing one step per base
question completed — follow-ups don't move it, since the model decides on the fly how
many (if any) a question gets, so there's no fixed number of sub-steps to show partial
credit for.

Once responses have come in, **Analyze** (back on the survey list) kicks off
`consensus_analyze.yml`, which publishes `public/consensus-results/<id>.json` — open
**Results** next to that survey once it's done. Re-running **Analyze** re-publishes the
same file from whatever's in the responses CSV at that point, so it's safe to run again
after more responses come in. While it runs, the survey row shows a live progress bar
(which question of how many it's currently synthesizing), not just the GitHub Actions
run's start time. That progress count only reflects Claude Analyze: Yes questions --
the No ones aren't part of the run's synthesis work. The bar appears the instant you
click Analyze, animating in an indeterminate "Starting analysis on GitHub Actions…"
state before switching to real per-question progress -- GitHub Actions needs its own
15-30s to spin up a runner (checkout, Python setup, pip install) before the script
even starts, and the bar shouldn't sit hidden and look broken for that whole stretch.

If any questions are set to Claude Analyze: No, the results page opens with a
**Respondent summary** table above the themed sections -- one row per respondent, one
column per such question, exactly as answered. It's cropped to 3 rows with a fade and a
"Show all" button once there's more than that to show.

### Cost

Two different models, deliberately: the live follow-up-question generator uses
**Claude Haiku 4.5** (cheapest current model — writing one short question from a little
context is exactly the high-volume, low-complexity workload it's for), and the batch
analysis uses **Claude Sonnet 5** (real synthesis across many respondents' answers earns
a stronger model, at a fraction of Opus's per-token cost). See the comments above
`FOLLOWUP_MODEL` in `src/consensus.js` and above `MODEL` in `consensus/analyze.py` if you
want to change either.

---

## 10 · PCN Issue Map

Turns PCN meeting notes/transcripts into an accumulating, evidence-traceable map of how
members believe their problems connect (Axelrod-style causal mapping / fuzzy cognitive
maps — see the design doc for the full method and reasoning). **This is an early,
in-progress build.** It'll grow in stages; this section will grow with it.

Its Box access is the **same shared, user-delegated connection** every other tool here
uses — nothing new to set up. If the control panel says "Not connected," log in with
Box from `admin.html`'s Developer section, same as you would for anything else.

Open **PCN Issue Map**'s control panel from the Mini App Platform grid, click
**Choose folder…** to pick this app's one data folder (a data file at its root, plus a
subfolder for raw source documents kept for audit — same idea as the Data Folder the
Council app uses, just its own separate folder), then **Test Box round-trip** — it
writes a small JSON file there and reads it straight back, confirming the connection
works.

**Pipeline** (`pcn/pipeline/`, Python): `pcn/pipeline/ingest` reads a source file
(`.vtt`/`.srt`/`.txt` for transcripts, `.md`/`.txt`/`.docx` for either) into a
`RawDocument`; `pcn/pipeline/normalize` turns that into a `NormalizedDocument` of
`Segment`s — speaker turns for a transcript, heading/bullet units (with inherited
parent heading context) for notes; `pcn/pipeline/extract` calls Claude (Haiku by
default, escalating a specific segment to Sonnet only when two independent extraction
passes disagree on it) to turn those Segments into `Assertion`s appended to the
assertion ledger (`pcn/pipeline/ledger.py`) — see `pcn/CODING_PROTOCOL.md` for the
five coding rules the extraction prompt follows; `pcn/pipeline/match` resolves each
Assertion's raw `from_issue_label`/`to_issue_label` text onto a canonical `Issue` via
a four-stage cascade (exact alias match → rapidfuzz fuzzy match → embedding
nearest-neighbor → residual Haiku adjudication over just the 5 nearest candidates),
recording the result separately in a resolutions file rather than editing the ledger;
`pcn/pipeline/review` orders unreviewed assertions (cross-run disagreement → escalated
→ new-issue-creating → everything else) and lets a human confirm/reject one — the
`--from-definition`/`--to-definition` flags on `review confirm` are how an issue's
one-line definition gets written the first time it's confirmed, which is what the
adjudication stage shows a model for its candidates from then on. Only `extract` and
match's adjudication stage make model calls; everything else is plain Python/rapidfuzz/
local embeddings. All of it reuses this project's own `ANTHROPIC_API_KEY` repository
secret rather than a dedicated key — volume here is cents per meeting.

`pcn/pipeline/derive` recomputes the connection network fresh from the ledger +
resolutions every run (a pure function, via networkx) — non-rejected assertions
sharing a resolved (from, to) issue pair become one edge, carrying a mean signed
weight, a **dispersion** (population stdev of that edge's weights, so a contested
connection — some members say positive, some negative — is visibly different from
an uncontested one, rather than both washing out to the same near-zero mean), a
per-modality breakdown, and its supporting assertion ids for evidence traceability.
Nodes get out-/in-degree, centrality, and a role (`driver`: affects things, nothing
affects it; `outcome`: something cared about, not itself influenceable; `ordinary`: a
candidate program — both). Graph-level: density, a hierarchy index (MacDonald's, as
used by Özesmi & Özesmi 2004 for FCM structural analysis — **not independently
verified against the primary source**, same caveat the design doc's own reference
implementation carried), and feedback loops via `networkx.simple_cycles` (capped at
6 nodes). `input_type_breadth` reports assertion/speaker/meeting/notetaker counts
**separately per transcript vs. notes** rather than pooling them — raw assertion
counts aren't comparable across input types (a transcript yields far more assertions
than notes of identical substance), so nothing here sums them together.

The `derive` stage's `--publish` flag pushes the network to this Worker via
`POST relay/network` (shared-secret `x-pipeline-key: BOX_RELAY_SECRET` auth, same
mechanism as `GET /api/box/pipeline-token` and Consensus's own relay routes — see
`pcn/relay.py`), stored in `BOX_KV` and served back by `GET network` (beta-account
gated) for **PCN Issue Map**'s **View network** page (linked from its control panel)
to render: an interactive force-directed graph (D3, loaded from a CDN — the one
external script this app uses) with node size by centrality, node color by role,
edge color by sign (green positive / red negative / gray contested), and a dashed
edge where dispersion swamps the mean (members disagree). Click a node or connection
for its detail — definition, degree, supporting-assertion counts.

Run the whole pipeline manually against the committed synthetic fixtures
(`pcn/fixtures/`) via the **PCN Issue Map -- fixture pipeline test** GitHub Actions
workflow (Actions tab → Run workflow); it uploads each stage's JSON output, including
the resulting ledger/issues/resolutions/network and the review queue's printed order,
as a downloadable artifact, and publishes the derived network so the network view has
something real (if synthetic) to show. No real PCN meeting data exists in this repo —
the fixtures are made up, matching the design doc's own worked example (a staffing →
overtime → turnover loop). The ledger itself isn't wired up to live in this app's Box
data folder yet — that lands once there's an actual admin-triggered run over uploaded
meeting files, rather than just this fixture smoke test.

---

## Notes for a security review

- **Box access is user-delegated, one shared app**: the app acts as you, so it can reach
  exactly what your own account can reach and nothing else. There is no service account
  with enterprise-wide reach. It has both read and write scope (shared with conexus-mcm,
  which needs write) — this project uses write only to replace the two export files in
  the configured Data Folder, plus (for PCN Issue Map) its own separate data folder;
  neither touches anything else in your Box account.
- **Claude sees survey responses and Feedback Log rows, nothing else.** Each analysis
  run sends a new meeting's free-text answers (organization name and rating numbers
  included, but never the respondent's name — those columns are stripped before the
  request) and the existing Feedback Log's items to the Claude API, and nothing else in
  your Box account. Both calls are logged in the Actions run's own output.
- **Credentials never reach a browser.** The Box client secret, the GitHub token, and the
  Anthropic API key live in Cloudflare Worker / GitHub Actions secrets respectively; the
  Box token pair lives in Workers KV. The control panel only ever holds a short-lived
  session token, and survey uploads are proxied through the Worker so a Box token never
  reaches the browser either.
- **Revocable in one click.** *Disconnect* in the panel deletes the stored token pair, and
  you can revoke the app's access from your own Box account settings at any time.
- **Auditable.** Every analysis run is a logged GitHub Actions run showing when it ran,
  who triggered it, and exactly what it extracted, appended, and published.
- **`/beta`'s admin accounts are a separate, lighter-weight system.** Passwords are hashed
  (PBKDF2-SHA256, a random salt per account) — never stored or logged in plain text — and
  session tokens are HMAC-signed, not cookies, so there's nothing for a CSRF attack to
  ride on. The iteration count is intentionally lower than a typical server-side
  recommendation, because it has to fit inside a Cloudflare Worker's per-request CPU
  budget (not wall-clock time) rather than a normal server's — see the comment above
  `PBKDF2_ITERATIONS` in `src/beta_auth.js` for the actual numbers. What it does *not* do
  is verify email ownership before letting someone set a password (see step 8 above) — a
  deliberate simplicity trade for a small, trusted admin list, not an oversight.
- **Consensus's respondent-facing routes are intentionally public and unauthenticated**
  (`GET /api/consensus/public/*`, `POST /api/consensus/followup`, `POST
  /api/consensus/submit`) — that's the whole point of a survey link. None of them trust
  the client for anything that matters: which follow-up to generate (and how many to
  allow) is read from the stored survey, never from the request, and `submit` only
  writes to the one Box folder that survey's admin already configured. The admin routes
  (create/edit a survey, trigger analysis) require a signed-in `/beta` account, same as
  the rest of the platform.
- **PCN Issue Map's network view is the one page in this repo that loads an external
  script** (D3, from a CDN) — needed for the force-directed graph layout; every other
  page here is hand-rolled with no third-party JS. It's a static, widely-used
  visualization library with no data collection of its own; nothing it renders is
  fetched from anywhere but this Worker's own `GET /api/pcn/network`.

---

## When something looks wrong

| Symptom | Cause |
| --- | --- |
| Login says "not configured" | The Set Cloudflare secrets workflow has not run, or ran against a different Worker. The error message names the Worker serving the page. |
| Box login returns an error | The redirect URI in the Box app does not exactly match `https://<worker>/api/box/callback` — check the shared app has *both* projects' callback URLs listed (step 3). |
| "Login link expired or was already used" | The one-time state value is spent. Click **Log in with Box** again. |
| "Could not start: GitHub refused the trigger (404)" | The workflow file (`update_dashboard.yml` / `setup_analysis.yml`) isn't on the branch the Worker dispatches to (`GITHUB_BRANCH`, default `main`) — check it's merged. |
| An Actions run fails with a 401 from the relay | `BOX_RELAY_SECRET` differs between the repository secret and the Worker secret. |
| An Actions run fails with "Box is not connected" | Nobody has logged in with Box yet. Open the panel. |
| An Actions run fails with "Set up the Data Folder first" | The Data Folder hasn't been chosen yet. Open the panel. |
| Update Dashboard says "No new meetings found" | Every meeting in the current Post-Meeting Survey export is already in `data/feedback_log.json` — this is expected if nothing new was uploaded, not a bug. |
| Run succeeds, page unchanged | Nothing changed, or Cloudflare is still redeploying. Give it a minute. |
| A tab says "isn't wired up yet" | Its `pageId` is still a placeholder. See step 7. |
| `/beta/login.html` says "That email isn't on the admin list" for poneill | `poneill_password` hasn't been set as a repository secret and pushed via **Set Cloudflare secrets** yet, or `BOX_KV` isn't bound. See step 8. |
| "Set up new account" says the account already has a password, but you've never signed in | Someone else already claimed that email (see the "worth knowing" note in step 8) — ask an existing admin to **Reset** it under Manage admins, then try again. |
| Consensus chat says it can't generate a follow-up question | `consensus_claude_api` hasn't been set as a repository secret and pushed to the Worker via **Set Cloudflare secrets** yet. See step 9. |
| Consensus "Analyze" fails with "No responses have been collected yet" | Nobody has completed the respondent chat for that survey yet -- `responseCount` is still 0. |
| Consensus "Analyze" fails with "the responses file doesn't exist in Box" | Same as above, or the survey's responses folder was changed after respondents already answered — check the survey's Box folder still matches where they were saved. |
| PCN Issue Map's Box status says "Not connected" | Nobody has logged in with Box yet on this Worker — same fix as the Council app's own "Box is not connected": open `admin.html`'s Developer section and log in. |
| PCN Issue Map's "Test Box round-trip" fails | No data folder has been chosen yet (**Choose folder…** in its control panel), or the Box connection expired — try logging in with Box again. |
